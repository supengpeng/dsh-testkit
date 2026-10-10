/**
 * 把场景声明的 fixture 合并进 `scenario.setup`。
 *
 * ## 冻结 API（runner 侧直接调用，名字与签名不要改）
 *
 * ```ts
 * applyScenarioFixtures(scenario, { fixturesDir, dshVersion })
 *   → Promise<{ scenario, refs: FixtureRef[], skipReason? }>
 * ```
 *
 * ## 规则（与 runner 注释保持一致）
 *
 * 1. `fixtures:` 里的名字形如 `<kind>/<name>`，对应文件 `<fixturesDir>/<kind>/<name>.yaml`。
 * 2. `data` 的键是 **kind 名**；合并为
 *    `setup[kind] = deepMerge(fixture.data[kind], scenario.setup[kind])`
 *    —— **场景显式字段优先**；多份夹具按 `fixtures:` 数组顺序依次合并（后者覆盖前者）。
 * 3. 深度合并只递归**普通对象**；**数组整体替换**，不做元素级合并
 *    （元素级合并会把「夹具 3 个分片 + 场景 2 个分片」变成 5 个，语义无法预测）。
 * 4. 夹具缺失 / 解析失败 / 校验不通过 / `dsh_version` 不可解析 / 版本不匹配 →
 *    返回 `skipReason`（调用方据此把该场景记为 skipped），并在 `refs` 里给对应项带 `reason`。
 *
 * ## 三条硬约束（都是踩过的坑）
 *
 * · **只读**：绝不修改传入的 `scenario`（registry 把解析后的场景常驻内存，
 *   原地改会把夹具内容泄漏到同进程的下一次运行——"跑两遍结果不一样"这种 bug 极难归因），
 *   返回的是新对象；合并结果也不与夹具缓存共享可变子对象。
 * · **不抛**：任何失败都变成 `skipReason`。整链路抛错会让「夹具写坏了」
 *   表现成「被测对象 errored」，归因完全错误。
 * · **按包根解析路径**：`fixturesDir` 为空走 `<包根>/fixtures`，相对路径按包根解析，
 *   绝不按 `process.cwd()`（CI 轨可能在任意目录下运行）。
 *
 * ## 宿主版本无法解析时的取向（有意为之）
 *
 * 判定只对**夹具侧**的 `dsh_version` 失败时跳过。若宿主版本本身解析不出来
 * （本插件的默认状态就是 `unknown`：包被符号链接装在 profile 下，解析不到宿主版本），
 * 则**采用**夹具且不做版本校验，而不是静默跳过整批场景——
 * 「没声明 ≠ 不兼容」，把默认配置下的夹具场景全判 skipped 是更大的行为损失。
 * 需要严格版本校验时，给宿主传一个可解析的版本（配置项 `dshVersion`）。
 */

import type { Scenario } from '../cases/types.js'
import type { FixtureRef } from '../runtime/runlog.js'
import { checkDshVersion, parseVersion } from './compat.js'
import { loadFixtureFile, resolveFixturePath, resolveFixturesDir } from './load.js'
import type { FixtureSpec } from './schema.js'

export interface ApplyFixturesOptions {
  /** 夹具根；空值 = `<包根>/fixtures`（相对路径按包根解析）。 */
  fixturesDir: string
  /** 宿主 DSH 版本；解析不出来时不做版本校验（见文件头注）。 */
  dshVersion: string
}

export interface ApplyFixturesResult {
  scenario: Scenario
  refs: FixtureRef[]
  /** 非空表示调用方应把该场景记为 skipped，并把它作为 skipReason。 */
  skipReason?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深拷贝普通对象/数组（切断与夹具缓存的共享）。 */
function cloneDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneDeep(item))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneDeep(item)
    return out
  }
  return value
}

/**
 * 深度合并：`override`（场景显式写法）优先。
 *
 * 数组**整体替换**（复制一份，避免共享引用）；`override === undefined` 时保留 `base`。
 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (override === undefined) return cloneDeep(base)
  if (isPlainObject(override)) {
    if (!isPlainObject(base)) return cloneDeep(override)
    const out = cloneDeep(base) as Record<string, unknown>
    for (const [key, item] of Object.entries(override)) {
      out[key] = deepMerge(base[key], item)
    }
    return out
  }
  return cloneDeep(override)
}

/** 按声明顺序去重（同名夹具只处理一次，避免重复合并）。 */
function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of names) {
    const name = String(raw).trim()
    if (name === '' || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

/** 装配夹具。任何失败都通过 `skipReason` / `refs[].reason` 表达，不抛异常。 */
export async function applyScenarioFixtures(
  scenario: Scenario,
  opts: ApplyFixturesOptions,
): Promise<ApplyFixturesResult> {
  const names = dedupe(scenario.fixtures ?? [])
  if (names.length === 0) return { scenario, refs: [] }

  try {
    const dir = resolveFixturesDir(opts?.fixturesDir)
    const hostVersion = String(opts?.dshVersion ?? '').trim()
    const hostParsed = parseVersion(hostVersion)

    const refs: FixtureRef[] = []
    const problems: string[] = []
    const fromFixtures: Record<string, Record<string, unknown>> = {}

    for (const name of names) {
      const file = resolveFixturePath(dir, name)
      if (file === undefined) {
        const reason = `夹具不存在：${name}（在 ${dir} 下找不到 ${name}.yaml）`
        refs.push({ name, source: 'unknown', reason })
        problems.push(reason)
        continue
      }

      const loaded = loadFixtureFile(dir, file)
      if (!loaded.ok || !loaded.spec) {
        const detail =
          loaded.error ??
          loaded.issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('; ')
        const reason = `夹具不合法：${name}（${detail}）`
        refs.push({ name, source: 'unknown', reason })
        problems.push(reason)
        continue
      }

      const spec = loaded.spec
      if (hostParsed) {
        const check = checkDshVersion(hostVersion, spec.dshVersion)
        if (!check.ok) {
          const reason = `夹具 dsh_version 无法判定：${name}（${check.reason}）`
          refs.push({ name, source: spec.source, dshVersion: spec.dshVersion, reason })
          problems.push(reason)
          continue
        }
        if (!check.satisfied) {
          const reason = `夹具版本不匹配：${name} 需要 ${spec.dshVersion}，当前 DSH ${hostVersion}`
          refs.push({ name, source: spec.source, dshVersion: spec.dshVersion, reason })
          problems.push(reason)
          continue
        }
      }

      mergeFixtureData(fromFixtures, spec)
      refs.push({ name, source: spec.source, dshVersion: spec.dshVersion })
    }

    const setup: Record<string, unknown> = { ...(scenario.setup ?? {}) }
    for (const [kind, block] of Object.entries(fromFixtures)) {
      setup[kind] = deepMerge(block, (scenario.setup ?? {})[kind])
    }

    const result: ApplyFixturesResult = { scenario: { ...scenario, setup }, refs }
    if (problems.length > 0) result.skipReason = problems.join('；')
    return result
  } catch (error) {
    // 兜底：夹具链路的任何意外都不能变成被测对象的 errored
    return {
      scenario,
      refs: [],
      skipReason: `夹具装配内部错误：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/** 按 kind 累积多份夹具的片段（后者覆盖前者）。 */
function mergeFixtureData(
  target: Record<string, Record<string, unknown>>,
  spec: FixtureSpec,
): void {
  for (const [kind, block] of Object.entries(spec.data)) {
    target[kind] = deepMerge(target[kind], block) as Record<string, unknown>
  }
}
