/**
 * 报告三面（`report.md` 人看 / `run.json` 机器看 / `junit.xml` CI 看）共用的
 * **呈现原语**。
 *
 * 为什么单独抽一层：三种格式的"外壳"必然不同（Markdown 有表格、XML 有标签），
 * 但它们**看到的事实必须来自同一份 `RunSummary` 的同一批字段**。
 * 如果把「哪条断言算失败」「失败断言长什么样」这类判断各写一遍，
 * 迟早出现"md 说 2 条失败、junit 说 3 条"的漂移——那种 bug 极难归因。
 *
 * 这里只做**数据提取与纯文本化**，不做任何格式专属的装饰：
 * Markdown 自己加 emoji / 行内代码，JUnit 自己加 XML 转义。
 */

import type {
  AssertionOutcome,
  CaseOutcome,
  PolicyDecision,
  PolicySnapshot,
  UsageRecord,
} from '../runtime/runlog.js'

/** 断言对象里除 `ref` / `soft` 外的那一个断言词（Schema 保证一行只有一个）。 */
export function assertionWord(outcome: AssertionOutcome): string | undefined {
  const assertion = outcome.assertion as unknown as Record<string, unknown>
  return Object.keys(assertion).find(
    (key) => key !== 'ref' && key !== 'soft' && assertion[key] !== undefined,
  )
}

/** 断言的期望值文本（无法识别断言词时给 `?`）。 */
export function assertionExpected(outcome: AssertionOutcome): string {
  const word = assertionWord(outcome)
  if (word === undefined) return '?'
  const assertion = outcome.assertion as unknown as Record<string, unknown>
  return safeStringify(assertion[word])
}

/** 一条失败断言：连带它所属的步骤名，报告里需要点出"是哪一步挂的"。 */
export interface FailureLine {
  stepName: string
  outcome: AssertionOutcome
}

/**
 * 提取所有**硬失败**断言（`soft` 失败不算——它不改变 verdict）。
 *
 * 这是"哪条断言算失败"的唯一实现：md 与 junit 都从这里取。
 */
export function failingAssertions(outcome: CaseOutcome): FailureLine[] {
  const lines: FailureLine[] = []
  for (const step of outcome.steps) {
    for (const assertion of step.assertions) {
      if (!assertion.ok && !assertion.soft) lines.push({ stepName: step.name, outcome: assertion })
    }
  }
  return lines
}

/** 失败断言的**纯文本**单行形态（JUnit `<failure>` 正文用；Markdown 用同样的字段自己加样式）。 */
export function renderFailureLine(line: FailureLine): string {
  const a = line.outcome
  const word = assertionWord(a) ?? '?'
  return `[${line.stepName}] ${a.assertion.ref} ${word} ${assertionExpected(a)} — 实际 ${truncate(safeStringify(a.actual), 300)} · ${a.message}`
}

/** repeat 轮次的呈现：`2/3 轮通过`。 */
export function formatRounds(rounds: readonly boolean[]): string {
  const passed = rounds.filter(Boolean).length
  return `${passed}/${rounds.length} 轮通过`
}

/** 成本闸门判定：跑 / 未跑 + 理由 + 成本档 + 判定来源。 */
export function formatPolicy(policy: PolicyDecision): string {
  const word = policy.allowed ? '跑' : '未跑'
  return `${word} —— ${policy.reason}（成本档 ${policy.cost}，来源 ${policy.source}）`
}

/** 模型用量。 */
export function formatUsage(usage: UsageRecord): string {
  return `模型调用 ${usage.modelCalls} 次 · ${usage.tokens} tokens`
}

/** 运行级闸门快照（报告头部一行）。 */
export function formatPolicySnapshot(snapshot: PolicySnapshot): string {
  const model = snapshot.allowModel ? '允许' : '禁止'
  const lowCost = snapshot.allowLowCost ? '允许' : '禁止'
  return `模型调用${model} · 低成本${lowCost} · 沙箱 ${safeStringify(snapshot.sandbox)}`
}

/** 取首行并去掉首尾空白（`message` 属性只能是单行）。 */
export function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

/** 宽容的 JSON 序列化：循环引用 / BigInt 也不该把整份报告炸掉。 */
export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** 超长文本截断（保留总长度提示，便于判断"是不是被截了"）。 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length})`
}
