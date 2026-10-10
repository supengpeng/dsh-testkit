/**
 * 按 DSH 版本选择场景（增量选择的 `dsh-version` 模式）。
 *
 * ## 语义
 *
 * 每条场景可能声明若干 fixture；夹具自带 `dsh_version` 版本范围。
 * 给定宿主 DSH 版本时：
 *   · **没有任何夹具声明** → 无版本约束 → 纳入；
 *   · 声明的夹具全部满足版本范围 → 纳入；
 *   · 有夹具明确不满足 → **排除**（并在 reason 里点名是哪个夹具、需要什么范围）；
 *   · 夹具缺失/不合法、范围不可解析、或宿主版本本身不可解析 → **无法判定 → 纳入**
 *     （与 `affectedScenarios` 同一取向：不默认跳过；跳过是比多跑更危险的行为损失）。
 *
 * `fixturesDir` 缺省 = `<包根>/fixtures`（**按包根解析**，绝不按 `process.cwd()`）。
 */

import type { Scenario } from '../cases/types.js'
import { checkDshVersion, parseVersion } from '../fixtures/compat.js'
import { loadFixtureFile, resolveFixturePath, resolveFixturesDir } from '../fixtures/load.js'

export interface SelectByDshVersionOptions {
  /** 夹具根；缺省 `<包根>/fixtures`。 */
  fixturesDir?: string
}

export interface SelectByDshVersionResult {
  /** 可以在这个 DSH 版本上跑的场景 ID（保持传入顺序）。 */
  matched: string[]
  reason: string
}

/** 判定一组场景在给定 DSH 版本下是否可跑。 */
export function selectByDshVersion(
  version: string,
  scenarios: readonly Scenario[],
  opts: SelectByDshVersionOptions = {},
): SelectByDshVersionResult {
  const hostVersion = String(version ?? '').trim()
  const hostParsed = parseVersion(hostVersion)
  const dir = resolveFixturesDir(opts.fixturesDir)

  const matched: string[] = []
  const excluded: string[] = []
  const undecided: string[] = []
  let unconstrained = 0

  for (const scenario of scenarios) {
    const names = (scenario.fixtures ?? [])
      .map((name) => String(name).trim())
      .filter((name) => name !== '')

    if (names.length === 0) {
      unconstrained += 1
      matched.push(scenario.id)
      continue
    }

    if (!hostParsed) {
      undecided.push(`${scenario.id}（宿主版本 ${JSON.stringify(hostVersion)} 无法解析）`)
      matched.push(scenario.id)
      continue
    }

    let blocked: string | undefined
    let unknown: string | undefined
    for (const name of names) {
      const file = resolveFixturePath(dir, name)
      if (file === undefined) {
        unknown = `${scenario.id}（夹具 ${name} 不存在）`
        continue
      }
      const loaded = loadFixtureFile(dir, file)
      if (!loaded.ok || !loaded.spec) {
        unknown = `${scenario.id}（夹具 ${name} 不合法）`
        continue
      }
      const check = checkDshVersion(hostVersion, loaded.spec.dshVersion)
      if (!check.ok) {
        unknown = `${scenario.id}（夹具 ${name} 的 dsh_version 无法解析）`
        continue
      }
      if (!check.satisfied) {
        blocked = `${scenario.id}（夹具 ${name} 需要 ${loaded.spec.dshVersion}）`
        break
      }
    }

    if (blocked !== undefined) {
      excluded.push(blocked)
      continue
    }
    if (unknown !== undefined) undecided.push(unknown)
    matched.push(scenario.id)
  }

  const parts = [`DSH ${hostVersion || '(空)'}：无版本约束 ${unconstrained} 条直接纳入`]
  parts.push(`夹具约束下有 ${excluded.length} 条被排除`)
  if (excluded.length > 0) parts.push(`排除：${excluded.join('、')}`)
  if (undecided.length > 0) parts.push(`无法判定 ${undecided.length} 条（保守纳入）：${undecided.join('、')}`)
  parts.push(`最终 ${matched.length}/${scenarios.length} 条`)

  return { matched, reason: parts.join('；') }
}
