/**
 * 运行记录的数据结构。
 *
 * 纯数据，无 DSH 依赖；报告层（report/*）只读这些结构。
 */

import type { Assertion, CostClass } from '../cases/types.js'

export type CaseVerdict = 'passed' | 'failed' | 'skipped' | 'errored'

/**
 * 失败归因（见 `src/analysis/classify.ts` 的判定表）。
 *
 * 为什么要有它：只有 `failed` 一个词的话，"被测对象有 bug"和"用例自己写错了"
 * 在报告里长得一模一样，读者无法据此决定下一步是谁的活。
 */
export type FailureCategory = 'product_bug' | 'case_bug' | 'driver_bug' | 'env' | 'flaky'

/** 成本闸门的判定结果（为什么跑 / 为什么不跑）。 */
export interface PolicyDecision {
  allowed: boolean
  /** 人类可读的判定依据；`allowed: false` 时就是跳过原因。 */
  reason: string
  /** 该场景最终采用的成本档位。 */
  cost: CostClass
  /** 判定依据来自哪里：场景显式声明，还是 driver 默认档位。 */
  source: 'scenario' | 'driver' | 'default'
}

/** 一次运行的模型用量记账（driver 上报；无法上报时不猜）。 */
export interface UsageRecord {
  modelCalls: number
  tokens: number
}

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
  /**
   * 每一轮 repeat 的通过情况（`repeat > 1` 时才记）。
   *
   * 为什么需要：`repeat` 的现有语义是把多轮断言**合并**进同一份 steps，
   * 于是"三轮里失败一轮"和"三轮全失败"在报告里不可区分。
   * 这个字段让 flaky 判定（`src/analysis/classify.ts`）有据可依。
   */
  rounds?: boolean[]
  /** 失败归因；通过 / 跳过时为 undefined。 */
  failureCategory?: FailureCategory
  /** 成本闸门判定（无论允许还是拒绝都记）。 */
  policy?: PolicyDecision
  /** 该 case 的模型用量记账。 */
  usage?: UsageRecord
  /** 最小复现指引（见 `src/analysis/repro.ts`）。 */
  minimalRepro?: string
}

export interface RunTotals {
  total: number
  passed: number
  failed: number
  skipped: number
  errored: number
}

/** 本次运行采用的闸门快照（进报告，便于复现"当时为什么这么判"）。 */
export interface PolicySnapshot {
  allowModel: boolean
  allowLowCost: boolean
  /** 沙箱策略快照（键值直接来自 ExecutionPolicy.sandbox）。 */
  sandbox: Record<string, unknown>
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
  /** 本次运行的闸门快照；未启用闸门（纯库调用）时为 undefined。 */
  policySnapshot?: PolicySnapshot
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
