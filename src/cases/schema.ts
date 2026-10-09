/**
 * 场景数据的运行时校验。
 *
 * 故意**不引** zod / ajv：宿主的依赖树越简单越好，且这里的规则不复杂。
 * 规则见 docs/SCENARIO-SPEC.md。
 */

import {
  SCENARIO_KINDS,
  SCHEMA_VERSION,
  type Scenario,
  type ScenarioKind,
} from './types.js'

export interface ValidationIssue {
  /** 出问题的字段路径，如 `steps[0].expect[1].ref`。 */
  path: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  scenario?: Scenario
  issues: ValidationIssue[]
}

const CASE_ID_RE = /^TK-\d{4}$/
const KINDS = new Set<string>(SCENARIO_KINDS)
const SEVERITIES = new Set(['low', 'medium', 'high'])
const STATUSES = new Set(['active', 'draft', 'retired', 'blocked'])

// 注：`setup` 的子键与 kind 同名（`setup.tool` / `setup.llm` / …），
// 这样 runner 能按 key 把 setup 分派给对应 driver。
// 组合场景可以同时写多个（见 runner 的 `setupKindsOf`）。

const ASSERTION_WORDS = [
  'is',
  'isNot',
  'notIs',
  'exists',
  'notExists',
  'contains',
  'notContains',
  'matches',
  'atLeast',
  'atMost',
  'length',
  'lengthAtLeast',
  'lengthAtMost',
  'throws',
] as const

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 校验一份已解析的 YAML 对象。
 *
 * @param raw - YAML.parse 的结果
 * @param fileName - 文件名（不含路径），用于核对 id 与文件名的对应关系
 */
export function validateScenario(raw: unknown, fileName: string): ValidationResult {
  const issues: ValidationIssue[] = []
  const push = (path: string, message: string): void => {
    issues.push({ path, message })
  }

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '', message: '顶层必须是一个对象' }] }
  }

  // ---- schema ----
  if (raw.schema !== SCHEMA_VERSION) {
    push('schema', `schema 必须为 ${SCHEMA_VERSION}，实际 ${JSON.stringify(raw.schema)}`)
  }

  // ---- id ----
  const id = raw.id
  if (typeof id !== 'string' || !CASE_ID_RE.test(id)) {
    push('id', `id 必须形如 TK-0001，实际 ${JSON.stringify(id)}`)
  } else {
    const expected = `${id}.yaml`
    if (fileName !== expected) {
      push('id', `id (${id}) 与文件名 (${fileName}) 不一致，应为 ${expected}`)
    }
  }

  // ---- title ----
  if (typeof raw.title !== 'string' || raw.title.trim() === '') {
    push('title', 'title 必须是非空字符串')
  } else if (raw.title.length > 60) {
    push('title', `title 过长（${raw.title.length} > 60 字）`)
  }

  // ---- kind ----
  const kind = raw.kind
  if (typeof kind !== 'string' || !KINDS.has(kind)) {
    push('kind', `kind 必须是已注册类型之一：${[...KINDS].join(' | ')}`)
  }

  // ---- severity / status / tags ----
  if (raw.severity !== undefined && !SEVERITIES.has(String(raw.severity))) {
    push('severity', `severity 只能是 low | medium | high`)
  }
  if (raw.status !== undefined && !STATUSES.has(String(raw.status))) {
    push('status', `status 只能是 active | draft | retired | blocked`)
  }
  if (raw.tags !== undefined && (!Array.isArray(raw.tags) || raw.tags.some((t) => typeof t !== 'string'))) {
    push('tags', 'tags 必须是字符串数组')
  }

  // ---- source ----
  if (!isPlainObject(raw.source)) {
    push('source', 'source 段必填')
  } else if (!('issue' in raw.source)) {
    push('source.issue', 'source.issue 必填（可以是 null，表示手工构造）')
  }

  // ---- runtime ----
  if (raw.runtime !== undefined) {
    if (!isPlainObject(raw.runtime)) {
      push('runtime', 'runtime 必须是对象')
    } else if (raw.runtime.repeat !== undefined) {
      const repeat = Number(raw.runtime.repeat)
      if (!Number.isInteger(repeat) || repeat < 1) push('runtime.repeat', 'repeat 必须是 >= 1 的整数')
    }
  }

  // ---- setup ----
  //
  // 规则（支持**组合场景**，见 runner 的 setupKindsOf）：
  //   · setup 下的每个键都必须是合法 kind —— 这样才能分派给对应 driver，
  //     也顺带挡住 `setup.tolls` 这类拼写错误
  //   · **不要求** setup 必填：有些场景完全不造条件（例如 shell 自检），
  //     也不要求出现主 kind 的键 —— 有些 driver 不需要 setup 配置（例如 ui）
  if (raw.setup !== undefined) {
    if (!isPlainObject(raw.setup)) {
      push('setup', 'setup 段必须是对象')
    } else {
      for (const key of Object.keys(raw.setup)) {
        if (!KINDS.has(key)) {
          push(
            `setup.${key}`,
            `setup 下的键必须是 kind 之一（${[...KINDS].join(' | ')}），以便分派给对应 driver`,
          )
        }
      }
    }
  }

  // ---- steps ----
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    push('steps', 'steps 必须是非空数组')
  } else {
    raw.steps.forEach((step, i) => {
      const at = `steps[${i}]`
      if (!isPlainObject(step)) {
        push(at, '每个 step 必须是对象')
        return
      }
      if (step.name !== undefined && typeof step.name !== 'string') {
        push(`${at}.name`, 'name 必须是字符串')
      }
      if (!Array.isArray(step.expect)) {
        push(`${at}.expect`, 'expect 必须是数组（可为空数组）')
      } else {
        step.expect.forEach((assertion, j) => validateAssertion(assertion, `${at}.expect[${j}]`, push))
      }
    })
  }

  if (issues.length > 0) return { ok: false, issues }

  // `setup` 允许省略（有些场景不造条件），但下游按对象用——所以这里补成 `{}`
  const record = raw as unknown as Scenario & { setup?: Record<string, unknown> }
  return {
    ok: true,
    scenario: { ...record, setup: record.setup ?? {} },
    issues: [],
  }
}

function validateAssertion(
  assertion: unknown,
  at: string,
  push: (path: string, message: string) => void,
): void {
  if (!isPlainObject(assertion)) {
    push(at, '断言必须是对象')
    return
  }
  if (typeof assertion.ref !== 'string' || assertion.ref.trim() === '') {
    push(`${at}.ref`, 'ref 必须是非空字符串')
  } else if (!/^(fx|case|env)\./.test(assertion.ref)) {
    push(`${at}.ref`, `ref 必须以 fx. / case. / env. 开头，实际 ${assertion.ref}`)
  }

  const words = ASSERTION_WORDS.filter((w) => assertion[w] !== undefined)
  if (words.length === 0) {
    push(at, `缺少判定词（${ASSERTION_WORDS.join(' | ')}）`)
  } else if (words.length > 1) {
    push(at, `一行只允许一个判定词，发现 ${words.join(' + ')}`)
  }

  if (assertion.soft !== undefined && typeof assertion.soft !== 'boolean') {
    push(`${at}.soft`, 'soft 必须是布尔值')
  }
}
