/**
 * triage 的共用原语与两条纪律（文档 §7.5 自动 triage + §8.2 PR 注释）。
 *
 * ## 纪律 1：只生成文本，不发任何请求
 *
 * 本目录全部是**纯函数**：给定 `RunSummary` → 返回 issue 草稿 / PR 评论 / owner 分组。
 * 开 issue、贴评论、发 webhook 由 CI / CLI 做——库里既不联网，也不该偷偷发请求
 * （本机无网，而且"生成"与"发布"必须是两步，否则一次误跑就是刷屏）。
 *
 * ## 纪律 2：正文不得包含完整取证原文
 *
 * issue 与 PR 评论都是**公开面**。把被测对象的 stdout / 文件内容整段贴上去就是泄露
 * ——token、家目录、私有仓库名都可能在取证里。所以：
 *
 *   · `notes`（夹具取证快照）**一律不进正文**，任何位置都不进；
 *   · 进入正文的片段（症状、期望 / 实际、消息、最小复现）必须过 `safeSnippet`：
 *     ① 折成单行（表格与标题不能被换行撕开）
 *     ② 走 `src/report/redact.ts` 的 `redactText` 脱敏（**先脱敏再截断**：
 *        截断会把 `ghp_xxx` 切一半，正则就再也认不出来了）
 *     ③ 截断到上限并带省略标记
 *
 * 长度上限是硬的：一份 200KB 的 stdout 不能把 issue 撑爆，也不能把
 * 一句话症状变成三段。
 *
 * ## 措辞不另造
 *
 * 归因标签直接取 `src/analysis/classify.ts` 的 `FAILURE_CATEGORY_LABEL`；
 * 失败断言与期望值取 `src/report/present.ts`（与 md / junit 报告同一套事实）。
 * 三处各写一套措辞，迟早出现"报告说 A、issue 说 B"。
 */

import { FAILURE_CATEGORY_LABEL } from '../analysis/classify.js'
import { redactText } from '../report/redact.js'
import { assertionExpected, assertionWord, failingAssertions } from '../report/present.js'
import type { CaseOutcome, FailureCategory, RunSummary } from '../runtime/runlog.js'

/** 无 owner 的分组名（覆盖矩阵 `no-owner` 缺口在 triage 侧的落点）。 */
export const NO_OWNER = '(未指派)'

/** 无 owner 分组的原因提示——与 `src/insight/coverage.ts` 的 no-owner 缺口同措辞。 */
export const NO_OWNER_REASON =
  '这些 case 没有 owner：失败后无法自动路由到人。该补 `owner: "@<人名>"`' +
  '（SCENARIO-SPEC 的 owner 是机器可读字段，不是署名）。'

/** 一句话症状上限。 */
export const SNIPPET_LIMIT = 160
/** 期望 / 实际 / 消息的片段上限。 */
export const DETAIL_LIMIT = 400
/** 最小复现正文上限。 */
export const REPRO_LIMIT = 1200
/** issue 标题上限。 */
export const TITLE_LIMIT = 120
/** 表格 / 清单里最多列几条，超出折叠成"+N 条"。 */
export const LIST_LIMIT = 20
/** 省略标记：读者必须能一眼看出"这里被截了"。 */
export const ELLIPSIS = '…（已截断）'

/** 归因 → 标签。`product_bug` / `env` / `flaky` 是公开语义，其余是内部标签。 */
export const LABELS_BY_CATEGORY: Record<FailureCategory, readonly string[]> = {
  product_bug: ['bug'],
  env: ['environment'],
  flaky: ['flaky'],
  // 内部：用例自己写错 / 引擎与宿主契约不符，都不该当产品 bug 对外报。
  case_bug: ['testkit:case'],
  driver_bug: ['testkit:driver'],
}

/** 没有归因时用的标签：明确告诉人"这条还得你自己看"。 */
export const LABEL_NEEDS_TRIAGE = 'needs-triage'

/** 该 case 是否算"要 triage 的失败"。 */
export function isFailing(outcome: CaseOutcome): boolean {
  return outcome.verdict === 'failed' || outcome.verdict === 'errored'
}

/** 取出所有 `failed` / `errored`（顺序与输入一致——报告顺序即优先级）。 */
export function failingCases(summary: RunSummary): CaseOutcome[] {
  return summary.cases.filter(isFailing)
}

/** 归因的中文标签；没有归因时给 `未归因`（不猜类别）。 */
export function categoryLabel(outcome: CaseOutcome): string {
  return outcome.failureCategory ? FAILURE_CATEGORY_LABEL[outcome.failureCategory] : '未归因'
}

/** 从归因推导 GitHub 标签；没有归因时给 `needs-triage`。 */
export function labelsFor(outcome: CaseOutcome): string[] {
  if (outcome.failureCategory === undefined) return [LABEL_NEEDS_TRIAGE]
  return [...LABELS_BY_CATEGORY[outcome.failureCategory]]
}

/**
 * 规范化 owner：去 `@` 前缀与空白；空串视为"没写"。
 *
 * 显示时保留原大小写（`@Alice` → `Alice`）；分组比较时再忽略大小写
 * （与 `src/insight/search.ts` 的 normalizeOwner 同语义：同一个人只该有一个组）。
 */
export function ownerOf(outcome: CaseOutcome): string | undefined {
  const raw = (outcome.owner ?? '').trim().replace(/^@+/, '').trim()
  return raw === '' ? undefined : raw
}

/** owner 的展示形态：`@x` 或 `(未指派)`。 */
export function ownerLabel(outcome: CaseOutcome): string {
  const owner = ownerOf(outcome)
  return owner === undefined ? NO_OWNER : `@${owner}`
}

/** 折成单行（表格 / 标题里不能有换行）。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 截断并带省略标记；`max` 应显著大于 `ELLIPSIS` 长度。 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}${ELLIPSIS}`
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 把任意取证值变成**可安全放进公开正文**的短片段。
 *
 * 顺序不可换：折行 → 脱敏 → 截断。先截断的话，被切一半的 token
 * 不再匹配任何模式，脱敏就漏了。
 */
export function safeSnippet(value: unknown, max = SNIPPET_LIMIT): string {
  const single = collapseWhitespace(safeStringify(value))
  const { text } = redactText(single)
  return truncate(text, max)
}

/** 一句话症状：优先错误文本，其次第一条硬失败断言的消息。 */
export function symptom(outcome: CaseOutcome): string {
  if (outcome.error !== undefined && outcome.error.trim() !== '') {
    return safeSnippet(outcome.error, SNIPPET_LIMIT)
  }
  const first = failingAssertions(outcome)[0]
  if (first !== undefined && first.outcome.message.trim() !== '') {
    return safeSnippet(first.outcome.message, SNIPPET_LIMIT)
  }
  return `${outcome.verdict}（没有可读的失败断言）`
}

/** 第一条硬失败断言的摘要（期望 / 实际 / 消息都已脱敏截断）。 */
export interface AssertionDetail {
  ref: string
  word: string
  expected: string
  actual: string
  message: string
}

export function assertionDetail(outcome: CaseOutcome): AssertionDetail | undefined {
  const first = failingAssertions(outcome)[0]
  if (first === undefined) return undefined
  const a = first.outcome
  return {
    ref: a.assertion.ref,
    word: assertionWord(a) ?? '?',
    expected: safeSnippet(assertionExpected(a), DETAIL_LIMIT),
    actual: safeSnippet(a.actual, DETAIL_LIMIT),
    message: safeSnippet(a.message, DETAIL_LIMIT),
  }
}

/** 一条失败 case 的 triage 事实（issue / 评论 / 路由共用，避免三处各算一遍）。 */
export interface FailureFacts {
  outcome: CaseOutcome
  symptom: string
  category: FailureCategory | undefined
  categoryLabel: string
  labels: string[]
  owner: string | undefined
  ownerLabel: string
  detail: AssertionDetail | undefined
}

export function failureFacts(outcome: CaseOutcome): FailureFacts {
  return {
    outcome,
    symptom: symptom(outcome),
    category: outcome.failureCategory,
    categoryLabel: categoryLabel(outcome),
    labels: labelsFor(outcome),
    owner: ownerOf(outcome),
    ownerLabel: ownerLabel(outcome),
    detail: assertionDetail(outcome),
  }
}

/** 表格单元格里不能出现裸 `|`。 */
export function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 把 id 列表折成 `a、b、c（+N 条）`。 */
export function summarizeIds(ids: readonly string[], limit = LIST_LIMIT): string {
  const shown = ids.slice(0, limit)
  const rest = ids.length - shown.length
  const text = shown.map((id) => `\`${id}\``).join('、')
  return rest > 0 ? `${text}（+${rest} 条）` : text
}

/** 证据区可用的链接（issue 与 PR 评论共用同一份措辞）。 */
export interface EvidenceOptions {
  /** `owner/name`，仅作正文指引，不联网。 */
  repo?: string
  /** CI 运行页链接。 */
  runUrl?: string
  /** 报告路径（CI 侧给的相对/绝对路径，原样展示）。 */
  reportPath?: string
  /** JUnit 产物路径。 */
  junitPath?: string
}

/**
 * 证据区（Markdown 列表）。
 *
 * **永远至少有一行**（本地产物按 `runs/<RUN-ID>/` 约定给路径），
 * 否则"证据"小节会在没传链接时变成空标题——那比没有更糟。
 */
export function evidenceLines(summary: RunSummary, options: EvidenceOptions): string[] {
  const lines: string[] = []
  if (options.reportPath !== undefined) lines.push(`- 报告：\`${options.reportPath}\``)
  if (options.junitPath !== undefined) lines.push(`- JUnit：\`${options.junitPath}\``)
  lines.push(`- 本地产物：\`runs/${summary.runId}/\`（run.json · report.md · junit.xml）`)
  if (options.runUrl !== undefined) lines.push(`- 运行记录：<${options.runUrl}>`)
  if (options.repo !== undefined) lines.push(`- 仓库：\`${options.repo}\``)
  return lines
}

