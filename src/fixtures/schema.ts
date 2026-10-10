/**
 * fixture 文件的校验。
 *
 * 字段（见 docs/SCENARIO-SPEC.md 与 `src/config.ts` 的 fixturesDir 注释）：
 *
 * ```yaml
 * $schema: 1                 # 夹具规范版本；当前只接受 1（与场景的 `schema: 1` 对齐）
 * name: llm/timeout          # `<kind>/<name>`，必须与相对路径一致
 * dsh_version: ">=0.2.0-rc.2"# 版本范围；语法必须合法（见 compat.ts）
 * source: hand-written       # hand-written | record | generate
 * data:                      # 键是 **kind 名**，值是合并进 setup[kind] 的片段
 *   llm:
 *     respond: { chunks: [] }
 * ```
 *
 * ## 为什么 `data` 的键是 kind 名而不是 `data.setup.<kind>`
 *
 * 合并规则（由 runner 侧接线，见 `src/fixtures/apply.ts` 的头注）是
 * `setup[kind] = deepMerge(fixture.data[kind], scenario.setup[kind])`。
 * 让 `data` 直接以 kind 为键，少一层 `setup` 包装，夹具文件与场景 `setup`
 * 的对应关系一眼可见；也避免「夹具里写了 `data.setup` 却漏了内层 kind」这类
 * 两层结构才有的错法。
 *
 * 校验刻意**严格**：夹具是共享资产，写坏了会污染所有引用它的场景。
 * 一条不合法的夹具在 `applyScenarioFixtures` 里表现为该场景跳过并写明原因，
 * 绝不会被静默忽略。
 */

import { SCENARIO_KINDS } from '../cases/types.js'
import { isValidRange } from './compat.js'

/** 夹具规范版本。 */
export const FIXTURE_SCHEMA_VERSION = 1

/** 夹具来源：手工写 / 录制 / 生成。 */
export type FixtureSource = 'hand-written' | 'record' | 'generate'

export const FIXTURE_SOURCES: readonly FixtureSource[] = ['hand-written', 'record', 'generate'] as const

/** 命名规则：`<kind>/<name>`，两段都由小写字母/数字/连字符组成。 */
export const FIXTURE_NAME_RE = /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/

/** 已校验的夹具。 */
export interface FixtureSpec {
  schema: number
  /** 形如 `llm/timeout`。 */
  name: string
  /** 声明支持的 DSH 版本范围原文。 */
  dshVersion: string
  source: FixtureSource
  /** 键 = kind 名；值 = 要合并进 `scenario.setup[kind]` 的片段。 */
  data: Record<string, Record<string, unknown>>
}

export interface FixtureIssue {
  path: string
  message: string
}

export interface FixtureValidationResult {
  ok: boolean
  spec?: FixtureSpec
  issues: FixtureIssue[]
}

export interface ValidateFixtureOptions {
  /** 文件相对 fixtures 根的路径（`llm/timeout.yaml`），用于核对 name。 */
  relativePath?: string
  /** 允许 name 与路径不一致（只给「校验单份文件内容」的场景用；默认 false）。 */
  allowNameMismatch?: boolean
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 由文件名（含或不含扩展名）得到 `<kind>/<name>`；去不掉合法名字时返回 undefined。 */
export function fixtureNameFromPath(relativePath: string): string | undefined {
  const normalized = String(relativePath).replace(/\\/g, '/').replace(/^\.\//, '')
  const stripped = normalized.replace(/\.ya?ml$/i, '')
  return FIXTURE_NAME_RE.test(stripped) ? stripped : undefined
}

/** 校验一份已解析的 fixture YAML 对象。 */
export function validateFixture(
  raw: unknown,
  options: ValidateFixtureOptions = {},
): FixtureValidationResult {
  const issues: FixtureIssue[] = []
  const push = (path: string, message: string): void => {
    issues.push({ path, message })
  }

  if (!isPlainObject(raw)) {
    return { ok: false, issues: [{ path: '', message: '顶层必须是一个对象' }] }
  }

  // ---- $schema ----
  const schema = raw.$schema
  if (schema !== FIXTURE_SCHEMA_VERSION && String(schema) !== String(FIXTURE_SCHEMA_VERSION)) {
    push('$schema', `$schema 必须为 ${FIXTURE_SCHEMA_VERSION}，实际 ${JSON.stringify(schema)}`)
  }

  // ---- name ↔ 路径一致性 ----
  const name = raw.name
  let nameOk = false
  if (typeof name !== 'string' || !FIXTURE_NAME_RE.test(name)) {
    push('name', `name 必须形如 <kind>/<name>（小写字母/数字/连字符），实际 ${JSON.stringify(name)}`)
  } else {
    nameOk = true
    const [kind] = name.split('/')
    if (kind !== undefined && !(SCENARIO_KINDS as readonly string[]).includes(kind)) {
      push('name', `name 的第一段必须是已注册的 kind：${kind}（见 src/cases/types.ts 的 SCENARIO_KINDS）`)
      nameOk = false
    }
  }
  if (options.relativePath !== undefined && !options.allowNameMismatch) {
    const expected = fixtureNameFromPath(options.relativePath)
    if (expected === undefined) {
      push('name', `文件路径 ${options.relativePath} 不符合 <kind>/<name>.yaml 约定`)
    } else if (name !== expected) {
      push('name', `name (${JSON.stringify(name)}) 与文件路径 (${expected}) 不一致`)
    }
  }

  // ---- dsh_version ----
  const dshVersion = raw.dsh_version
  if (typeof dshVersion !== 'string' || dshVersion.trim() === '') {
    push('dsh_version', 'dsh_version 必填（版本范围，例如 ">=0.2.0-rc.2"）')
  } else if (!isValidRange(dshVersion)) {
    push('dsh_version', `dsh_version 不是可解析的版本范围：${JSON.stringify(dshVersion)}`)
  }

  // ---- source ----
  const source = raw.source
  if (typeof source !== 'string' || !(FIXTURE_SOURCES as readonly string[]).includes(source)) {
    push('source', `source 只能是 ${FIXTURE_SOURCES.join(' | ')}，实际 ${JSON.stringify(source)}`)
  }

  // ---- data ----
  const data: Record<string, Record<string, unknown>> = {}
  if (!isPlainObject(raw.data)) {
    push('data', 'data 必填，且键必须是 kind 名（例如 llm / tool）')
  } else {
    const keys = Object.keys(raw.data)
    if (keys.length === 0) push('data', 'data 至少要有一个 kind 片段')
    for (const key of keys) {
      if (!(SCENARIO_KINDS as readonly string[]).includes(key)) {
        push(
          `data.${key}`,
          `data 的键必须是 kind 名（${SCENARIO_KINDS.join(' | ')}）；` +
            `注意不是 \`setup\`——夹具片段直接挂在 kind 名下`,
        )
        continue
      }
      const block = raw.data[key]
      if (!isPlainObject(block)) {
        push(`data.${key}`, `${key} 片段必须是对象`)
        continue
      }
      data[key] = block
    }
    if (nameOk && typeof name === 'string') {
      const [kind] = name.split('/')
      if (kind !== undefined && !(kind in data)) {
        push('data', `夹具 ${name} 的 data 里必须有 \`${kind}\` 片段`)
      }
    }
  }

  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    issues: [],
    spec: {
      schema: FIXTURE_SCHEMA_VERSION,
      name: name as string,
      dshVersion: (dshVersion as string).trim(),
      source: source as FixtureSource,
      data,
    },
  }
}
