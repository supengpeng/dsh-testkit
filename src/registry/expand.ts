/**
 * 把 `use:` 步骤展开成 **flat 步骤**。
 *
 * ## 展开语义（唯一约定，别发明别的）
 *
 * ```yaml
 * steps:
 *   - use: invoke/tool
 *     with: { tool: read_file, args: { path: a.txt } }
 * ```
 *
 * 取片段 `invoke/tool` 的 `act` / `expect`，把字符串里的 `{tool}` / `{args}` 占位
 * 替换成 `with` 的值（`{a.b}` 这类嵌套取值也支持，用点路径）：
 *
 *   · **整串占位**（字符串恰好是 `{x}`）→ 原样替换成该值，**保留类型**
 *     （数组/对象/数字/布尔不会被字符串化）。
 *   · **嵌入占位**（`"前缀-{x}"`）→ 要求值是标量，替换为它的字符串形式；
 *     值不是标量时报 problem（片段要拿对象就整串占位，别拼字符串）。
 *
 * 然后：
 *
 *   · **只做替换，不做语义推断**：`with` 里给了片段没声明的参数 → problem；
 *     片段声明了必填参数而 `with` 没给（且无默认值）→ problem；类型不符 → problem。
 *   · 场景步骤自己还可以写额外的 `expect`，它们**追加**在片段 expect 之后。
 *   · 展开结果**不残留** `use` / `with`：flat 步骤只允许 `id` / `name` / `act` /
 *     `expect` / `cleanup`。
 *   · 展开结果可一键展平成 flat 步骤：`result.flat` 就是 `result.scenario.steps`。
 *
 * ## 硬约束
 *
 *   · **无环**：片段不得 use 片段（loader/checkRegistry 已挡）；这里只查场景 → 片段这一层。
 *   · **无隐式状态**：展开不注入任何变量，跨步数据必须由场景显式写 `fx.` 引用。
 *   · **禁止 YAML 控制流**：这里没有任何条件/循环分支——只有"逐步骤替换"。
 *   · **场景锁 registry 版本**：只要场景里有 `use:`，就必须带 `registry:v<version>`
 *     标签，且与注册表清单版本一致；否则报 problem。
 */

import type { Assertion, Scenario, Step, StepAction } from '../cases/types.js'

import {
  declaredParamNames,
  paramDefaults,
  requiredParamNames,
  type LoadedRegistry,
  type StepFragment,
} from './loader.js'

/** 展开结果：成功给出 flat 步骤，失败逐条点名。 */
export type ExpandResult =
  | { ok: true; scenario: Scenario; flat: Step[] }
  | { ok: false; problems: string[] }

const WHOLE_PLACEHOLDER_RE = /^\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}$/
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 每次新建正则，避免 `/g` 的 `lastIndex` 在多次调用间串味。 */
function scanPlaceholders(text: string): Array<{ raw: string; path: string }> {
  const re = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/g
  const out: Array<{ raw: string; path: string }> = []
  for (const match of text.matchAll(re)) {
    out.push({ raw: match[0], path: match[1] ?? '' })
  }
  return out
}

/** 深拷贝 YAML 数据（片段模板从注册表里来，绝不能被展开过程就地改写）。 */
function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as unknown as T
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) out[key] = cloneValue(child)
    return out as unknown as T
  }
  return value
}

/** 点路径取值；`undefined` 视为"没取到"。 */
function resolveBinding(
  path: string,
  bindings: Map<string, unknown>,
): { found: boolean; value?: unknown } {
  const segments = path.split('.')
  const root = segments[0]
  if (root === undefined || !bindings.has(root)) return { found: false }
  let cursor: unknown = bindings.get(root)
  for (const segment of segments.slice(1)) {
    if (Array.isArray(cursor)) {
      const index = Number(segment)
      if (!Number.isInteger(index)) return { found: false }
      cursor = cursor[index]
    } else if (isPlainObject(cursor)) {
      cursor = cursor[segment]
    } else {
      return { found: false }
    }
    if (cursor === undefined) return { found: false }
  }
  if (cursor === undefined) return { found: false }
  return { found: true, value: cursor }
}

/** 替换一个字符串里的全部占位符。 */
function substituteString(
  text: string,
  bindings: Map<string, unknown>,
  at: string,
  problems: string[],
): unknown {
  const whole = WHOLE_PLACEHOLDER_RE.exec(text)
  if (whole !== null) {
    const path = whole[1] ?? ''
    const resolved = resolveBinding(path, bindings)
    if (!resolved.found) {
      problems.push(`${at}: 占位符 {${path}} 没有对应的 with 参数（且无默认值）`)
      return text
    }
    return cloneValue(resolved.value)
  }

  let out = ''
  let cursor = 0
  for (const { raw, path } of scanPlaceholders(text)) {
    const index = text.indexOf(raw, cursor)
    if (index < 0) continue
    out += text.slice(cursor, index)
    const resolved = resolveBinding(path, bindings)
    if (!resolved.found) {
      problems.push(`${at}: 占位符 {${path}} 没有对应的 with 参数（且无默认值）`)
      out += raw
    } else if (
      typeof resolved.value === 'string' ||
      typeof resolved.value === 'number' ||
      typeof resolved.value === 'boolean'
    ) {
      out += String(resolved.value)
    } else {
      problems.push(
        `${at}: 占位符 {${path}} 嵌在字符串里，但它的值不是标量；` +
          `要传对象/数组请把整个字符串写成 "{${path}}"（整串占位保留类型）`,
      )
      out += raw
    }
    cursor = index + raw.length
  }
  out += text.slice(cursor)
  return out
}

/** 递归替换对象/数组里的字符串占位符。 */
function substitute(
  value: unknown,
  bindings: Map<string, unknown>,
  at: string,
  problems: string[],
): unknown {
  if (typeof value === 'string') return substituteString(value, bindings, at, problems)
  if (Array.isArray(value)) return value.map((item) => substitute(item, bindings, at, problems))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = substitute(child, bindings, at, problems)
    }
    return out
  }
  return value
}

/** 取片段参数的类型/枚举声明，做基础类型校验（仍然不做语义推断）。 */
function paramSpec(fragment: StepFragment, key: string): Record<string, unknown> | undefined {
  const properties = fragment.params?.['properties']
  if (!isPlainObject(properties)) return undefined
  const spec = properties[key]
  return isPlainObject(spec) ? spec : undefined
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return isPlainObject(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

/** 校验 `with` 与片段 params 的一致性；返回可用的绑定表。 */
function buildBindings(
  fragment: StepFragment,
  withValues: Record<string, unknown>,
  at: string,
  problems: string[],
): Map<string, unknown> {
  const declared = new Set(declaredParamNames(fragment))
  const defaults = paramDefaults(fragment)
  const bindings = new Map<string, unknown>(defaults)

  for (const [key, value] of Object.entries(withValues)) {
    if (!declared.has(key)) {
      problems.push(
        `${at}: with 里的 ${key} 不是片段 ${fragment.name} 声明的参数` +
          `（已声明：${declared.size === 0 ? '无' : [...declared].join(', ')}）`,
      )
      continue
    }
    const spec = paramSpec(fragment, key)
    if (spec !== undefined) {
      const type = spec['type']
      if (typeof type === 'string' && PARAM_TYPES.has(type) && !typeMatches(type, value)) {
        problems.push(`${at}: with.${key} 期望 ${type}，实际 ${Array.isArray(value) ? 'array' : typeof value}`)
      }
      const enumValues = spec['enum']
      if (Array.isArray(enumValues) && !enumValues.some((item) => item === value)) {
        problems.push(`${at}: with.${key} 只能是 ${enumValues.map((v) => JSON.stringify(v)).join(' | ')}`)
      }
    }
    bindings.set(key, value)
  }

  for (const key of requiredParamNames(fragment)) {
    if (!(key in withValues) && !defaults.has(key)) {
      problems.push(`${at}: 片段 ${fragment.name} 的必填参数 ${key} 没给（可用 with: { ${key}: … }）`)
    }
  }

  return bindings
}

/** 版本锁：用了 use: 的场景必须声明它依赖的注册表版本。 */
function checkVersionLock(scenario: Scenario, registry: LoadedRegistry, problems: string[]): void {
  const expected = `registry:v${registry.version}`
  const locks = (scenario.tags ?? []).filter((tag) => tag.startsWith('registry:v'))
  if (locks.length === 0) {
    problems.push(`场景 ${scenario.id}: 用了 use: 组合步骤，必须带版本锁标签 ${expected}`)
    return
  }
  if (!locks.includes(expected)) {
    problems.push(
      `场景 ${scenario.id}: 版本锁 ${locks.join(', ')} 与注册表版本 ${registry.version} 不一致（应为 ${expected}）`,
    )
  }
}

/** 字面步骤 → flat 步骤：只保留允许的键（显式丢掉 use/with）。 */
function literalToFlat(step: Step): Step {
  const out: Step = {}
  if (step.id !== undefined) out.id = step.id
  if (step.name !== undefined) out.name = step.name
  if (step.act !== undefined) out.act = step.act
  if (step.expect !== undefined) out.expect = step.expect
  if (step.cleanup !== undefined) out.cleanup = step.cleanup
  return out
}

/**
 * 展开一条场景。
 *
 * @param scenario - 可能含 `use:` 步骤的场景
 * @param opts.registry - `loadRegistry()` 的结果
 */
export function expandScenario(
  scenario: Scenario,
  opts: { registry: LoadedRegistry },
): ExpandResult {
  const problems: string[] = []
  const steps = scenario.steps ?? []

  if (steps.some((step) => step.use !== undefined)) {
    checkVersionLock(scenario, opts.registry, problems)
  }

  const flat: Step[] = []

  steps.forEach((step, index) => {
    const at = `steps[${index}]`
    if (step.use === undefined) {
      flat.push(literalToFlat(step))
      return
    }

    const fragment = opts.registry.steps.get(step.use)
    if (fragment === undefined) {
      problems.push(`${at}: 找不到片段 ${step.use}（检查 registry/steps 下的 name）`)
      return
    }

    const withValues = step.with ?? {}
    if (!isPlainObject(withValues)) {
      problems.push(`${at}: with 必须是对象`)
      return
    }

    const bindings = buildBindings(fragment, withValues, at, problems)

    const act =
      fragment.act === undefined ? undefined : (substitute(fragment.act, bindings, at, problems) as StepAction)
    const fragmentExpect =
      fragment.expect === undefined
        ? undefined
        : (substitute(fragment.expect, bindings, at, problems) as Assertion[])
    const extraExpect = step.expect ?? []
    const expect =
      fragmentExpect === undefined && extraExpect.length === 0
        ? undefined
        : [...(fragmentExpect ?? []), ...extraExpect]

    const out: Step = {}
    if (step.id !== undefined) out.id = step.id
    out.name = step.name ?? fragment.name
    if (act !== undefined) out.act = act
    if (expect !== undefined) out.expect = expect
    if (step.cleanup !== undefined) out.cleanup = step.cleanup

    if ('use' in out || 'with' in out) {
      problems.push(`${at}: 展开后仍残留 use/with（这是展开器的 bug，请报 issue）`)
    }
    flat.push(out)
  })

  // 兜底：flat 里绝不允许残留 use/with（"可一键展平"的硬约束）
  flat.forEach((step, index) => {
    if ('use' in step || 'with' in step) {
      problems.push(`steps[${index}]: flat 步骤里不允许出现 use/with`)
    }
  })

  if (problems.length > 0) return { ok: false, problems }

  return { ok: true, scenario: { ...scenario, steps: flat }, flat }
}
