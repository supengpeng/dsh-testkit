/**
 * 本地 DX 的对外入口（工具面 / 命令面 / CLI 按这些名字接线）。
 *
 * 为什么不直接让人 import `./select.js` / `./watch.js`：
 * 入口集中一处，接线方不需要知道文件划分；以后拆/并模块也不会打断调用方。
 *
 * 两件事在这里分开：
 *   · **筛选**（`applyDxFilter` / `suggestSmokeSet`）——纯函数，决定"跑哪几条"；
 *   · **监听**（`watchCases`）——有副作用，把目录变化合并后交给调用方决定做什么。
 */

export {
  applyDxFilter,
  effectiveCost,
  estimateCaseMs,
  suggestSmokeSet,
  COST_EXTRA_MS,
  COST_ORDER,
  DEFAULT_SMOKE_BUDGET_MS,
  FALLBACK_KIND_MS,
  KIND_ESTIMATE_MS,
  SMOKE_TAG,
  type DxFilterOptions,
  type DxFilterResult,
  type SmokeSetOptions,
  type SmokeSetResult,
} from './select.js'

export {
  watchCases,
  DEFAULT_DEBOUNCE_MS,
  type CasesChange,
  type CasesChangeHandler,
  type CasesWatcher,
  type WatchCasesOptions,
} from './watch.js'
