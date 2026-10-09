/**
 * 失败归因：把 `failed` / `errored` 拆成**可行动**的类别。
 *
 * 判定表（自上而下，命中即返回）：
 *
 * | 序 | 条件 | 结论 |
 * |---|---|---|
 * | 1 | 通过 / 跳过 | 无归因（不记 `failureCategory`） |
 * | 2 | `repeat > 1` 且各轮结果不一致 | `flaky` |
 * | 3 | 错误 / 动作 detail 命中**预算超限**特征（`预算超限`、`BudgetExceeded`） | `env` |
 * | 4 | `errored` 且错误文本命中 driver 特征 | `driver_bug` |
 * | 5 | `errored` 且错误文本命中环境特征 | `env` |
 * | 6 | `errored`（其余） | `driver_bug` |
 * | 7 | `failed` 且夹具释放有失败项 | `driver_bug` |
 * | 8 | `failed` 且错误 / 动作 detail 命中环境特征（含预算超限） | `env` |
 * | 9 | `failed` 且失败断言全部是**取值失败** | `case_bug` |
 * | 10 | `failed` 且没有任何失败断言 | `driver_bug` |
 * | 11 | `failed`（其余） | `product_bug` |
 *
 * ## 为什么预算超限归 `env`（而不是新增第 6 个类别）
 *
 * 预算超限（`BudgetExceeded`，message 固定以「预算超限：」开头，例如
 * 「预算超限：模型调用次数上限 1 次，已用 2 次」）是**本次运行的条件不足**：
 * 既不是被测对象给出的判定结论（不是 `product_bug`），也不是断言写错
 * （不是 `case_bug`）。若按"落在失败分支且没有失败断言"的默认路径走，
 * 它会掉进第 10 条被归成 `driver_bug`——语义不对，会误导读者去查引擎。
 * 它和环境特征（超时 / ECONNREFUSED / 宿主缺能力）是同一类东西：
 * 换更好的运行条件（加预算 / `--allow-model`）就能得出真结论。
 * 判定表刻意把它并进 `env` 而不是扩成第 6 个类别——分类契约是文档定死的
 * 5 类（product_bug / case_bug / driver_bug / env / flaky），不为一个
 * 运行条件单开一档。
 *
 * ## 边界（刻意保守）
 *
 * 「断言写错了但能取到值」与「被测对象真的错了」在运行期**不可区分**——
 * 两者都表现为"期望值 ≠ 实际值"。所以 `case_bug` 只认**结构性**信号
 * （ref 前缀非法 / 取值失败），其余归 `product_bug`。这条边界写在这里，
 * 免得读者以为这个函数能替代人读现场。
 *
 * 报告里始终并列展示 `failureCategory` 与原始证据（期望 / 实际 / 最小复现），
 * 归因是**分流建议**，不是判决。
 */

import type { CaseOutcome, FailureCategory } from '../runtime/runlog.js'

/** 环境特征：不是产品语义错了，而是"这台机器 / 这次运行"的条件不对。 */
const ENV_PATTERNS: readonly RegExp[] = [
  /超时（>/,
  /\bETIMEDOUT\b/,
  /\bENOENT\b/,
  /\bEACCES\b/,
  /\bEPERM\b/,
  /\bECONNREFUSED\b/,
  /\bEADDRINUSE\b/,
  /\bENOSPC\b/,
  /\bEBUSY\b/,
  /宿主缺少能力/,
  /\baborted\b/,
  /沙箱/,
  /node_modules/,
  // 预算超限=本次运行的条件不足，换更好的条件就能得出真结论（详见文件头）。
  /预算超限/,
  /BudgetExceeded/,
]

/** driver 特征：报错文本自己承认"这是引擎侧的问题"。 */
const DRIVER_PATTERNS: readonly RegExp[] = [
  /driver 尚未实现/,
  /driver 未实现/,
  /没有对应 driver/,
  /无法判断动作属于哪个 kind/,
  /setup 里出现了 kind/,
  /夹具/,
]

/** 取值失败特征：断言引用的路径根本不存在 → 多半是用例写错了。 */
const REF_PATTERNS: readonly RegExp[] = [
  /取值失败/,
  /未知 ref 前缀/,
  /ref 缺少前缀/,
]

/** 把错误文本与动作 detail 拼成一份待匹配的文本。 */
function collectText(outcome: CaseOutcome): string {
  const parts: string[] = []
  if (outcome.error) parts.push(outcome.error)
  if (outcome.skipReason) parts.push(outcome.skipReason)
  for (const step of outcome.steps) {
    if (step.action?.detail) parts.push(step.action.detail)
  }
  for (const failure of outcome.releaseFailures) parts.push(failure.error)
  return parts.join('\n')
}

/**
 * 判定一条 case 的失败归因。
 *
 * @returns 归因；通过 / 跳过时返回 `undefined`（不写 `failureCategory`）。
 */
export function classifyCase(outcome: CaseOutcome): FailureCategory | undefined {
  if (outcome.verdict === 'passed' || outcome.verdict === 'skipped') return undefined

  // 2. flaky：多轮之间结果不一致（这才是 repeat 想抓的东西）
  const rounds = outcome.rounds
  if (rounds && rounds.length > 1 && rounds.some(Boolean) && rounds.some((ok) => !ok)) {
    return 'flaky'
  }

  const text = collectText(outcome)

  if (outcome.verdict === 'errored') {
    if (DRIVER_PATTERNS.some((re) => re.test(text))) return 'driver_bug'
    if (ENV_PATTERNS.some((re) => re.test(text))) return 'env'
    return 'driver_bug'
  }

  // verdict === 'failed'
  if (outcome.releaseFailures.length > 0) return 'driver_bug'
  if (ENV_PATTERNS.some((re) => re.test(text))) return 'env'

  const failing = outcome.steps.flatMap((step) =>
    step.assertions.filter((a) => !a.ok && !a.soft),
  )
  if (failing.length === 0) return 'driver_bug'
  if (failing.every((a) => REF_PATTERNS.some((re) => re.test(a.message)))) return 'case_bug'
  return 'product_bug'
}

/** 归因的中文标签（报告与工具输出共用，避免两处漂移）。 */
export const FAILURE_CATEGORY_LABEL: Record<FailureCategory, string> = {
  product_bug: '被测对象缺陷',
  case_bug: '用例缺陷',
  driver_bug: '引擎/驱动缺陷',
  env: '环境问题',
  flaky: '不稳定（抖动）',
}
