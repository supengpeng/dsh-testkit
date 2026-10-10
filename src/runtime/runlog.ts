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

/** fixture 的加载取证（进报告：用了哪一份、来自哪里、为什么没用上）。 */
export interface FixtureRef {
  /** 名字，形如 `llm/timeout`。 */
  name: string
  /** 来源：`hand-written` | `record` | `generate`（取自 fixture 文件自身）。 */
  source: string
  /** fixture 声明的 DSH 版本范围。 */
  dshVersion?: string
  /** 没被采用时的原因（解析失败 / 版本不匹配）——采用时不写。 */
  reason?: string
}

/** 清理取证：释放了什么、有没有残留（幂等 / 可重入的判据）。 */
export interface CleanupRecord {
  /** 已释放的取证键。 */
  released: string[]
  /** 场景结束后仍存在的残留（临时文件 / 进程 / 端口 / 会话）。 */
  leftovers: string[]
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
  /** 负责人（来源 `scenario.owner`）；覆盖矩阵与 triage 按它路由。 */
  owner?: string
  /** 本场景引用的 fixture 及其采用情况。 */
  fixtures?: FixtureRef[]
  /** 清理与残留取证（见 `src/isolation/`）。 */
  cleanup?: CleanupRecord
  /** 步骤级 trace（见 `src/trace/`）；每步一条 `act` + 一条 `assert`，外加 case 总跨度。 */
  trace?: TraceSpan[]
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

/**
 * 选择器取证（增量测试选择用）：说清"这次为什么只跑了这些"。
 *
 * 报告里必须能回答"我改了一行，为什么它一条都没跑"——所以把判定依据原样落盘。
 */
export interface SelectionRecord {
  /** 选择模式：`all` | `changed` | `since` | `affected-by` | `dsh-version` | `explicit`。 */
  mode: string
  /** 人类可读的依据（例如 `git diff HEAD~1 → 3 个文件`）。 */
  detail: string
  /** 命中的场景 ID（增量模式下用于自证）。 */
  matched: string[]
}

/** 执行方式取证（并发隔离用）：这次是串行还是并发、并发度多少。 */
export interface ExecutionRecord {
  parallel: 'off' | 'limited'
  limit: number
  /** 参与并发的场景数（显式声明 `parallel: safe` 的）。 */
  safe: number
  /** 强制独占的场景数。 */
  exclusive: number
}

/**
 * 一次 trace 跨度（可观测性，文档 §6.1）。
 *
 * 为什么记**相对偏移**而不是绝对时间戳：报告要能跨运行对比（"这一步一直是 45ms
 * 还是忽然变成 900ms"），绝对时间戳一对比就全是噪声。
 * 偏移基准是**本条 case 开始**（`startMs = 0` 即 case 起点）。
 */
export interface TraceSpan {
  phase: 'case' | 'setup' | 'act' | 'assert' | 'cleanup'
  /** 人类可读的名字（步骤名 / 动作标签 / 阶段名）。 */
  name: string
  /** 相对 case 起点的偏移（毫秒）。 */
  startMs: number
  durationMs: number
  /** 有判定含义的阶段才有：`act` 是否成功、`assert` 是否通过。 */
  ok?: boolean
}

/**
 * 脱敏取证（`--redact`）。
 *
 * **只记位置与类型，绝不记原文**——findings 里出现被脱敏的内容，
 * 报告本身就又变成了泄露源。
 */
export interface RedactionRecord {
  count: number
  findings: Array<{ path: string; kind: string }>
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
  /** 选择器取证（只在非 all 模式时写）。 */
  selection?: SelectionRecord
  /** 执行方式取证。 */
  execution?: ExecutionRecord
  /** 脱敏取证；未开启 `--redact` 或没命中时不写。 */
  redaction?: RedactionRecord
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
