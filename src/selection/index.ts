/**
 * 增量测试选择 + 夹具治理的对外入口。
 *
 * 冻结 API（runner / 工具面按这些名字接线）：
 *   · `changedFilesSince(ref, { cwd })`            —— 取变更文件；失败必须显式 ok:false
 *   · `affectedScenarios(files, { scenarios, ... })` —— 变更文件 → 受影响场景
 *   · `selectByDshVersion(version, scenarios)`     —— 按宿主 DSH 版本过滤
 *
 * `src/fixtures/apply.ts` 另有冻结 API `applyScenarioFixtures`，
 * 由 runner 在 setup 之前调用；这里不重复导出，避免出现两个"看起来都能用"的入口。
 */

export {
  changedFilesSince,
  type ChangedFilesOptions,
  type ChangedFilesResult,
} from './git.js'
export {
  affectedScenarios,
  isIgnoredPath,
  normalizePath,
  scenarioKinds,
  scenarioStepUses,
  IGNORED_PREFIXES,
  KERNEL_PREFIXES,
  type AffectedScenariosInput,
  type AffectedScenariosResult,
} from './mapping.js'
export {
  selectByDshVersion,
  type SelectByDshVersionOptions,
  type SelectByDshVersionResult,
} from './by-version.js'
export { benchmarkSelection, type BenchRun, type SelectionBenchOptions, type SelectionBenchResult } from './bench.js'

import type { SelectionRecord } from '../runtime/runlog.js'

/**
 * 构造进报告的 `SelectionRecord`。
 *
 * 为什么要一个构造器：选择器有三条入口（工具面 / 命令面 / bridge），
 * 各拼一遍 `{ mode, detail, matched }` 迟早会漂移；而"这次为什么只跑了这些"
 * 恰恰是增量模式最需要自证的地方。
 */
export function makeSelectionRecord(
  mode: SelectionRecord['mode'],
  detail: string,
  matched: readonly string[],
): SelectionRecord {
  return { mode, detail, matched: [...matched] }
}
