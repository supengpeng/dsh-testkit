/**
 * 增量选择在**入口层**的共用实现（工具面 / 命令面共用一份）。
 *
 * 为什么单独放一层：`testkit_run` 与 `/testkit run` 都要把
 * `--changed` / `--since` / `--affected-by` / `--dsh-version` 翻译成
 * "跑哪些 + 为什么是这些"，各写一份必然漂移；而"这次为什么只跑了这些"
 * 恰恰是增量模式最需要自证的地方（`RunSummary.selection` 就是它的落盘形态）。
 *
 * 两条纪律（写在最前面，避免后来者改坏）：
 *   ① **选不出来就退回全量**，绝不静默退化成"一条都不跑"；
 *   ② 判定依据（mode / detail / matched）必须能被报告原样复现。
 */

import type { CaseFilter, CaseRegistry } from '../cases/registry.js'
import type { Scenario } from '../cases/types.js'
import type { SelectionRecord } from '../runtime/runlog.js'
import {
  affectedScenarios,
  changedFilesSince,
  makeSelectionRecord,
  selectByDshVersion,
} from '../selection/index.js'

export interface SelectionArgs {
  /** `--changed`：工作区相对 HEAD 的改动。 */
  changed?: boolean | undefined
  /** `--since <ref>`：相对某个 git ref 的改动。 */
  since?: string | undefined
  /** `--affected-by <file>`：按单个文件推受影响场景（可多次）。 */
  affectedBy?: string[] | undefined
  /** `--dsh-version <v>`：按宿主版本过滤（读 fixture 的 dsh_version 绑定）。 */
  dshVersion?: string | undefined
}

export interface SelectionResolution {
  /** 交给 runner 的选择器；未启用增量时为 undefined（走调用方既有选择器）。 */
  filter?: CaseFilter
  /** 进报告的取证；未启用增量时为 undefined。 */
  selection?: SelectionRecord
  /** 人类可读的告警（例如 git 不可用已退回全量）；调用方应回显给用户。 */
  warnings: string[]
}

/**
 * 解析增量选择参数。
 *
 * @param args - 入口层解析出来的参数
 * @param input - 场景来源与路径（`scenarios` 用**全部**场景，而不是 active 子集：
 *                受影响集合先算全量，再由 filter 的 `status` 收敛）
 */
export function resolveSelection(
  args: SelectionArgs,
  input: {
    scenarios: readonly Scenario[]
    fixturesDir: string
    registryDir: string
    cwd?: string
  },
): SelectionResolution {
  const warnings: string[] = []
  const modes: string[] = []
  const details: string[] = []
  let matched: Set<string> | undefined

  const intersect = (ids: readonly string[], label: string): void => {
    details.push(`${label} → ${ids.length} 条`)
    if (matched === undefined) {
      matched = new Set(ids)
      return
    }
    const next = new Set<string>()
    for (const id of matched) if (ids.includes(id)) next.add(id)
    matched = next
  }

  const collectByFiles = (files: readonly string[], label: string): void => {
    const result = affectedScenarios([...files], {
      scenarios: input.scenarios,
      fixturesDir: input.fixturesDir,
      registryDir: input.registryDir,
    })
    modes.push(label)
    intersect(result.matched, `${label}（${files.length} 个文件）`)
    details.push(result.reason)
  }

  const changedRef = args.changed === true ? 'HEAD' : args.since?.trim()
  if (args.changed === true || (changedRef !== undefined && changedRef !== '')) {
    const ref = changedRef ?? 'HEAD'
    const diff = changedFilesSince(ref, { ...(input.cwd === undefined ? {} : { cwd: input.cwd }) })
    if (diff.ok) {
      const label = args.changed === true ? 'changed' : `since:${ref}`
      collectByFiles(diff.files, label)
    } else {
      // 纪律①：git 不可用不能让增量模式变成"跑 0 条"。
      warnings.push(`增量选择不可用（git diff ${ref} 失败：${diff.reason}），已退回全量`)
      details.push(`git diff ${ref} 失败：${diff.reason}（退回全量）`)
      modes.push(`${args.changed === true ? 'changed' : `since:${ref}`}(fallback:all)`)
    }
  }

  const files = (args.affectedBy ?? []).map((f) => f.trim()).filter((f) => f !== '')
  if (files.length > 0) collectByFiles(files, 'affected-by')

  if (args.dshVersion !== undefined && args.dshVersion.trim() !== '') {
    const version = args.dshVersion.trim()
    const result = selectByDshVersion(version, input.scenarios, { fixturesDir: input.fixturesDir })
    modes.push(`dsh-version:${version}`)
    intersect(result.matched, `dsh-version:${version}`)
    details.push(result.reason)
  }

  if (matched === undefined) return { warnings }

  const ids = input.scenarios.map((s) => s.id).filter((id) => matched!.has(id))
  const mode = modes.length === 0 ? 'all' : modes.join('+')
  const selection = makeSelectionRecord(
    mode,
    details.filter((d) => d !== '').join('；') || '（无判定依据）',
    ids,
  )

  // 增量模式只跑 active：draft 混进增量回归集比"少跑几条"危险得多。
  return {
    filter: { ids, status: ['active'] },
    selection,
    warnings,
  }
}

/** 从工具/命令参数里挑出增量选择相关的字段（容忍缺省与类型不对）。 */
export function selectionArgsFrom(raw: Record<string, unknown>): SelectionArgs {
  const since = typeof raw.since === 'string' ? raw.since : undefined
  const dshVersion = typeof raw.dshVersion === 'string' ? raw.dshVersion : undefined
  const changed = raw.changed === true ? true : undefined
  const affectedBy = Array.isArray(raw.affectedBy)
    ? raw.affectedBy.filter((f): f is string => typeof f === 'string')
    : undefined
  return {
    ...(changed === undefined ? {} : { changed }),
    ...(since === undefined || since.trim() === '' ? {} : { since }),
    ...(affectedBy === undefined || affectedBy.length === 0 ? {} : { affectedBy }),
    ...(dshVersion === undefined || dshVersion.trim() === '' ? {} : { dshVersion }),
  }
}

/** 是否启用了任一增量选择参数。 */
export function hasSelectionArgs(args: SelectionArgs): boolean {
  return (
    args.changed === true ||
    (args.since !== undefined && args.since !== '') ||
    (args.affectedBy !== undefined && args.affectedBy.length > 0) ||
    (args.dshVersion !== undefined && args.dshVersion !== '')
  )
}

/** 把增量选择解析成"选择器 + 取证 + 告警"的便捷封装（工具面与命令面共用）。 */
export function resolveSelectionFromRaw(
  raw: Record<string, unknown>,
  input: {
    registry: CaseRegistry
    fixturesDir: string
    registryDir: string
    cwd?: string
  },
): SelectionResolution {
  const args = selectionArgsFrom(raw)
  if (!hasSelectionArgs(args)) return { warnings: [] }
  return resolveSelection(args, {
    scenarios: input.registry.all,
    fixturesDir: input.fixturesDir,
    registryDir: input.registryDir,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
  })
}
