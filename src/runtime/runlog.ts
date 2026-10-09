/**
 * 运行记录的数据结构。
 *
 * 纯数据，无 DSH 依赖；报告层（report/*）只读这些结构。
 */

import type { Assertion } from '../cases/types.js'

export type CaseVerdict = 'passed' | 'failed' | 'skipped' | 'errored'

export interface AssertionOutcome {
  assertion: Assertion
  ok: boolean
  actual: unknown
  message: string
  soft: boolean
}

export interface StepOutcome {
  name: string
  /** act 的执行结果描述；无 act 则为 undefined。 */
  action?: { kind: string; ok: boolean; detail?: string }
  assertions: AssertionOutcome[]
  durationMs: number
  /**
   * 该步**新产生或发生变化**的取证（相对上一步的增量）。
   *
   * 为什么需要：case 层的 `notes` 只保留最终值，多步场景里同名 note
   * （例如每步都写 `stdout`）会互相覆盖——早期步骤的现场就没了。
   * 这个字段让"某一步到底输出了什么"在报告里可追溯。
   *
   * 用**增量**而不是整份快照：否则 run.json 会随步骤数线性膨胀。
   */
  notes?: Record<string, unknown>
}

export interface CaseOutcome {
  id: string
  title: string
  kind: string
  verdict: CaseVerdict
  durationMs: number
  /** verdict = skipped 时的原因。 */
  skipReason?: string
  /** verdict = errored 时的错误描述。 */
  error?: string
  steps: StepOutcome[]
  /** Fixture 收集到的证据快照。 */
  notes: Record<string, unknown>
  /** 释放夹具时的失败项（非空说明有泄漏风险）。 */
  releaseFailures: Array<{ label: string; error: string }>
  /** 该 case 的来源 issue，便于报告里溯源。 */
  sourceIssue: string | null
}

export interface RunTotals {
  total: number
  passed: number
  failed: number
  skipped: number
  errored: number
}

export interface RunSummary {
  runId: string
  startedAt: string
  finishedAt: string
  casesDir: string
  dshVersion: string
  platform: string
  totals: RunTotals
  cases: CaseOutcome[]
}

export function emptyTotals(): RunTotals {
  return { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 }
}

export function tallyTotals(cases: readonly CaseOutcome[]): RunTotals {
  const totals = emptyTotals()
  totals.total = cases.length
  for (const item of cases) totals[item.verdict] += 1
  return totals
}
