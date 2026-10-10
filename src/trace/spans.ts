/**
 * trace 的解析、重建与汇总（可观测性，文档 §6.1）。
 *
 * ## 两种数据来源
 *
 *   · `live`          —— `CaseOutcome.trace` 由 runner 在真实执行时记录，
 *                        偏移、间隙、act/assert 分界都是真的。
 *   · `reconstructed` —— 历史 `run.json` **没有 `trace` 字段**，只能用
 *                        `steps[].durationMs` 按顺序拼出**近似**时间线。
 *
 * ## 重建只是近似：别把它当真实 trace 读
 *
 *   1. 只有**累计时长**。每步的 `durationMs` 是这一步的总耗时；act 与 assert
 *      的真实分界、步骤之间的间隙、等待 / 并发，都无法从 `run.json` 恢复。
 *      所以重建时**一步只出一段 span**：`phase` 按该步实际做了什么选
 *      （有 act 记 `act`，否则记 `assert`），`ok` 取 act 与断言结果的合并。
 *   2. 各步严格按 `steps` 顺序首尾相接，不存在重叠、也没有间隙。
 *   3. `case` 总跨度用 `CaseOutcome.durationMs`——这个值是**真实记录**的，
 *      可能大于各步之和（夹具 setup / cleanup 不进 `steps`）。
 *
 * 因此所有导出都必须如实带上 `generatedFrom`：读者有权知道自己在看
 * "真实记录"还是"按累计时长拼出来的近似图"。
 */

import type { CaseOutcome, RunSummary, TraceSpan } from '../runtime/runlog.js'

/** 本次 trace 的数据来源。 */
export type TraceSource = 'live' | 'reconstructed'

/** 默认取最慢的条数（`summarizeTrace` / `renderTimeline` 共用）。 */
export const DEFAULT_SLOWEST_TOP = 5

/** 一条 case 的已解析 trace。 */
export interface ResolvedCaseTrace {
  id: string
  title: string
  kind: string
  verdict: CaseOutcome['verdict']
  /** 该 case 的耗时（真实记录值）。 */
  durationMs: number
  /** 该 case 在整次运行里的起始偏移：前面所有 case 的 `durationMs` 之和。 */
  startMs: number
  generatedFrom: TraceSource
  spans: TraceSpan[]
}

export interface ResolvedTrace {
  /**
   * 运行级来源标注。
   *
   * **只要有任意一条 case 是重建的，就整体标 `reconstructed`**（保守）——
   * 宁可让读者把 live 数据当近似读，也不能让近似数据被当成真实记录。
   * 逐条的真实来源在 `ResolvedCaseTrace.generatedFrom` 里。
   * 没有任何 case 时也标 `reconstructed`：本次没有真实记录可谈。
   */
  generatedFrom: TraceSource
  cases: ResolvedCaseTrace[]
}

/** 最慢 span 的一条记录（`case` 阶段是被排除的容器，见 `summarizeTrace`）。 */
export interface SlowSpan {
  caseId: string
  name: string
  durationMs: number
  phase: TraceSpan['phase']
}

export interface TraceSummary {
  /** span 总数（含 `case` 总跨度）。 */
  spans: number
  /** 各 case `durationMs` 之和；**不是** span 时长之和（`case` 跨度与步骤重叠，会重复计数）。 */
  totalMs: number
  /** 最慢的步骤 span（降序，不含 `case` 总跨度）。 */
  slowest: SlowSpan[]
}

/**
 * 从 `steps[].durationMs` 重建一条 case 的近似 trace。
 *
 * 产出永远是 `case` 总跨度在前，随后每步一段（顺序与 `steps` 一致）。
 * 语义边界见文件头——这里不做任何"猜分界"的加工。
 */
export function reconstructSpans(outcome: CaseOutcome): TraceSpan[] {
  const spans: TraceSpan[] = [
    {
      phase: 'case',
      name: outcome.id,
      startMs: 0,
      durationMs: outcome.durationMs,
      ok: outcome.verdict === 'passed',
    },
  ]

  let cursor = 0
  for (const step of outcome.steps) {
    const assertionsOk = step.assertions.every((a) => a.ok || a.soft)
    const ok = step.action ? step.action.ok && assertionsOk : assertionsOk
    spans.push({
      phase: step.action ? 'act' : 'assert',
      name: step.name,
      startMs: cursor,
      durationMs: step.durationMs,
      ok,
    })
    cursor += step.durationMs
  }
  return spans
}

/**
 * 解析一次运行的全部 trace：有 `trace` 就用真的，没有就重建。
 *
 * 不修改入参（返回新数组 / 新对象），调用方可以放心多次渲染。
 */
export function resolveTrace(summary: RunSummary): ResolvedTrace {
  const cases: ResolvedCaseTrace[] = []
  let cursor = 0
  // 空运行不算 live：没有记录可谈。
  let allLive = summary.cases.length > 0

  for (const outcome of summary.cases) {
    const live = Array.isArray(outcome.trace)
    if (!live) allLive = false
    const spans = live ? [...(outcome.trace ?? [])] : reconstructSpans(outcome)
    cases.push({
      id: outcome.id,
      title: outcome.title,
      kind: outcome.kind,
      verdict: outcome.verdict,
      durationMs: outcome.durationMs,
      startMs: cursor,
      generatedFrom: live ? 'live' : 'reconstructed',
      spans,
    })
    cursor += outcome.durationMs
  }

  return { generatedFrom: allLive ? 'live' : 'reconstructed', cases }
}

/** 各 case 耗时之和（运行级 wall time 的下界；不含夹具与调度开销）。 */
export function totalDurationMs(summary: RunSummary): number {
  return summary.cases.reduce((sum, outcome) => sum + outcome.durationMs, 0)
}

/**
 * 汇总：span 数 / 总耗时 / 最慢方案。
 *
 * `slowest` **排除 `phase: 'case'`**：case 总跨度只是容器，它会稳稳占据
 * 榜首、把真正该看的慢步骤全挤出去。要 case 级排名，用 `cases[].durationMs`。
 */
export function summarizeTrace(
  summary: RunSummary,
  options: { top?: number } = {},
): TraceSummary {
  const top = options.top ?? DEFAULT_SLOWEST_TOP
  const resolved = resolveTrace(summary)

  let spans = 0
  const all: SlowSpan[] = []
  for (const item of resolved.cases) {
    spans += item.spans.length
    for (const span of item.spans) {
      if (span.phase === 'case') continue
      all.push({
        caseId: item.id,
        name: span.name,
        durationMs: span.durationMs,
        phase: span.phase,
      })
    }
  }

  // 排序必须**稳定可复现**：耗时相同的按 caseId → name → phase 兜底，
  // 否则两条同耗时 span 的顺序会随实现细节漂移，报告 diff 就全是噪声。
  all.sort(
    (a, b) =>
      b.durationMs - a.durationMs ||
      compareText(a.caseId, b.caseId) ||
      compareText(a.name, b.name) ||
      compareText(a.phase, b.phase),
  )

  return {
    spans,
    totalMs: totalDurationMs(summary),
    slowest: all.slice(0, Math.max(0, Math.trunc(top))),
  }
}

/** 与 `localeCompare` 不同：不受运行环境 locale 影响，输出可复现。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
