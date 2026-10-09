/**
 * JUnit XML 渲染（CI 消费面）。
 *
 * 为什么必须有：CI（GitHub Actions / Jenkins / GitLab / `dorny/test-reporter`）
 * 只认 JUnit XML。没有它，一条失败用例在 CI 上只能表现为"某个 step 退出码非 0"，
 * 读者还得回去翻日志才知道挂在哪一条。
 *
 * ## 三面同源
 *
 * `report.md`（人看）、`run.json`（机器看）、`junit.xml`（CI 看）都**只读同一份
 * `RunSummary`**：本文件不重跑任何东西，也不从别的报告里抠字符串。
 * 失败断言的提取与纯文本化统一走 `./present.js`，避免"md 说 N 条、junit 说 M 条"。
 *
 * ## XML 的两个坑（任一个都会让整份报告在 CI 上解析失败）
 *
 * 1. **转义顺序**：`&` 必须最先换，否则会把后面换出来的 `&` 再转一次
 *    （`&` → `&amp;` → `&amp;amp;`）。
 * 2. **XML 1.0 非法控制字符**：`\u0000-\u0008`、`\u000B`、`\u000C`、
 *    `\u000E-\u001F` 一律剔除。夹具把命令输出原样取证时很容易带进一个，
 *    而只要有一个裸控制字符，CI 的 XML 解析器就整份拒绝。
 *    `\t` `\n` `\r` 是合法字符，保留。
 */

import type { CaseOutcome, RunSummary } from '../runtime/runlog.js'
import { failingAssertions, firstLine, renderFailureLine } from './present.js'

/** XML 1.0 不允许出现的控制字符（`\t \n \r` 合法，故不含）。 */
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

/** 转义 XML 文本节点。 */
export function escapeXmlText(text: string): string {
  return stripIllegalXml(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 转义 XML 属性值：除文本转义外还要处理引号，并把换行 / 制表折成空格。
 *
 * 折成空格不是洁癖：XML 解析器本来就会对属性值做空白规范化，
 * 显式折平可以让"报告里换行没了"不必再当谜案查。
 */
export function escapeXmlAttr(text: string): string {
  return stripIllegalXml(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\t\n\r]+/g, ' ')
}

function stripIllegalXml(text: string): string {
  return text.replace(XML_ILLEGAL, '')
}

/**
 * 渲染整份 JUnit XML。
 *
 * 根节点的计数与耗时**由 `cases` 现算**，而不是抄 `totals`：
 * JUnit 消费方会交叉核对"属性声明的数量 vs 子节点实际数量"，
 * 两者不一致时报告会被判为损坏。同一份 `RunSummary` 下两者本就相等
 * （`tallyTotals`），现算只是让这条不变量在结构上不可能被破坏。
 */
export function renderJUnit(summary: RunSummary): string {
  const groups = groupByKind(summary.cases)
  const failures = countVerdict(summary.cases, 'failed')
  const errors = countVerdict(summary.cases, 'errored')
  const skipped = countVerdict(summary.cases, 'skipped')

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<testsuites name="dsh-testkit" tests="${summary.cases.length}" failures="${failures}"` +
      ` errors="${errors}" skipped="${skipped}" time="${seconds(totalDuration(summary.cases))}">`,
  )
  for (const [kind, cases] of groups) {
    lines.push(
      `  <testsuite name="${escapeXmlAttr(kind)}" tests="${cases.length}"` +
        ` failures="${countVerdict(cases, 'failed')}" errors="${countVerdict(cases, 'errored')}"` +
        ` skipped="${countVerdict(cases, 'skipped')}" time="${seconds(totalDuration(cases))}">`,
    )
    for (const item of cases) lines.push(renderTestCase(item))
    lines.push('  </testsuite>')
  }
  lines.push('</testsuites>')
  return `${lines.join('\n')}\n`
}

/** 按 kind 分组，保持 kind 首次出现的顺序（报告顺序稳定，便于 diff）。 */
function groupByKind(cases: readonly CaseOutcome[]): Array<[string, CaseOutcome[]]> {
  const groups = new Map<string, CaseOutcome[]>()
  for (const item of cases) {
    const bucket = groups.get(item.kind)
    if (bucket) bucket.push(item)
    else groups.set(item.kind, [item])
  }
  return [...groups.entries()]
}

function countVerdict(cases: readonly CaseOutcome[], verdict: CaseOutcome['verdict']): number {
  return cases.filter((item) => item.verdict === verdict).length
}

function totalDuration(cases: readonly CaseOutcome[]): number {
  return cases.reduce((sum, item) => sum + item.durationMs, 0)
}

/** 毫秒 → JUnit 的秒（固定三位小数，时间恒为十进制而非科学计数法）。 */
function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

function renderTestCase(item: CaseOutcome): string {
  const classname = escapeXmlAttr(`dsh-testkit.${item.kind}`)
  const name = escapeXmlAttr(`${item.id} ${item.title}`)
  const head = `    <testcase classname="${classname}" name="${name}" time="${seconds(item.durationMs)}"`

  if (item.verdict === 'passed') return `${head}/>`

  if (item.verdict === 'skipped') {
    const reason = item.skipReason ? ` message="${escapeXmlAttr(item.skipReason)}"` : ''
    return `${head}>\n      <skipped${reason}/>\n    </testcase>`
  }

  const tag = item.verdict === 'failed' ? 'failure' : 'error'
  const type = escapeXmlAttr(item.failureCategory ?? item.verdict)
  const message = escapeXmlAttr(diagnosisSummary(item))
  const body = escapeXmlText(renderDiagnosis(item))
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n')
  return `${head}>\n      <${tag} message="${message}" type="${type}">\n${body}\n      </${tag}>\n    </testcase>`
}

/** `<failure message="...">` / `<error message="...">` 里那句"一句话说清"。 */
function diagnosisSummary(item: CaseOutcome): string {
  if (item.error) return firstLine(item.error)
  const lines = failingAssertions(item)
  const first = lines[0]
  if (first) {
    const text = firstLine(first.outcome.message)
    if (text !== '') return text
  }
  if (lines.length > 0) return `${lines.length} 条断言失败`
  return item.verdict
}

/**
 * 失败正文（给人看的原文）：错误 / 逐条失败断言 / 夹具释放失败 / 最小复现。
 *
 * 纯文本、不转义——转义由调用方统一做，避免"转两次"。
 */
function renderDiagnosis(item: CaseOutcome): string {
  const lines: string[] = []
  if (item.error) lines.push(`错误：${item.error}`)

  const failures = failingAssertions(item)
  if (failures.length > 0) {
    lines.push('失败断言：')
    for (const line of failures) lines.push(`- ${renderFailureLine(line)}`)
  }

  if (item.releaseFailures.length > 0) {
    lines.push(`夹具释放失败 ${item.releaseFailures.length} 项（有泄漏风险）：`)
    for (const failure of item.releaseFailures) {
      lines.push(`- ${failure.label}：${failure.error}`)
    }
  }

  if (item.minimalRepro) {
    lines.push('最小复现：')
    lines.push(item.minimalRepro)
  }

  if (lines.length === 0) lines.push(`${item.id} ${item.verdict}（无更多现场）`)
  return lines.join('\n')
}
