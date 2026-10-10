/**
 * 运行报告的 Markdown 渲染（人看的那一份）。
 *
 * 只读 runlog 的数据结构，不做任何 DSH 调用。
 *
 * 失败归因（`failureCategory`）与最小复现都直接来自 `RunSummary`；
 * 与 `junit.xml` 共用 `./present.js` 的呈现原语（"哪条断言算失败"只有一份实现）。
 */

import { FAILURE_CATEGORY_LABEL } from '../analysis/classify.js'
import type { AssertionOutcome, CaseOutcome, RunSummary, StepOutcome } from '../runtime/runlog.js'
import {
  assertionExpected,
  assertionWord,
  formatPolicy,
  formatPolicySnapshot,
  formatRounds,
  formatUsage,
  safeStringify,
  truncate,
} from './present.js'

const VERDICT_BADGE: Record<CaseOutcome['verdict'], string> = {
  passed: '✅ passed',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
  errored: '💥 errored',
}

export function renderMarkdown(summary: RunSummary): string {
  const lines: string[] = []
  const { totals } = summary

  lines.push(`# dsh-testkit 运行报告`)
  lines.push('')
  lines.push(`- **Run ID**：\`${summary.runId}\``)
  lines.push(`- **开始**：${summary.startedAt}`)
  lines.push(`- **结束**：${summary.finishedAt}`)
  lines.push(`- **DSH**：${summary.dshVersion} · ${summary.platform}`)
  lines.push(`- **casesDir**：\`${summary.casesDir}\``)
  // 闸门快照是"当时为什么这么判"的现场：没有它，事后无法复现准入结论。
  if (summary.policySnapshot) {
    lines.push(`- **闸门快照**：${formatPolicySnapshot(summary.policySnapshot)}`)
  }
  // 脱敏必须**写在报告里**：否则读者以为看到的是原文，而取证已经被改写。
  if (summary.redaction) {
    const kinds = [...new Set(summary.redaction.findings.map((f) => f.kind))].join('、')
    lines.push(
      `- **已脱敏**：过滤 ${summary.redaction.count} 处敏感数据（\`--redact\`；类型：${kinds || '—'}）。findings 只记位置与类型，不含原文。`,
    )
  }
  lines.push('')
  lines.push(
    `**合计**：${totals.total} 条 — ✅ ${totals.passed} · ❌ ${totals.failed} · ⏭️ ${totals.skipped} · 💥 ${totals.errored}`,
  )
  lines.push('')

  // ---- 概览表 ----
  lines.push('## 概览')
  lines.push('')
  lines.push('| Case | Kind | 结果 | 归因 | 耗时 | 标题 | 来源 |')
  lines.push('|---|---|---|---|---|---|---|')
  for (const c of summary.cases) {
    const ms = `${c.durationMs}ms`
    const issue = c.sourceIssue === null ? '—' : shorten(c.sourceIssue, 40)
    const attribution = c.failureCategory ? FAILURE_CATEGORY_LABEL[c.failureCategory] : '—'
    lines.push(
      `| \`${c.id}\` | ${c.kind} | ${VERDICT_BADGE[c.verdict]} | ${escapeCell(attribution)} | ${ms} | ${escapeCell(c.title)} | ${issue} |`,
    )
  }
  lines.push('')

  // ---- 逐条详情（只展开非 passed） ----
  const attention = summary.cases.filter((c) => c.verdict !== 'passed')
  if (attention.length > 0) {
    lines.push('## 需要关注')
    lines.push('')
    for (const c of attention) {
      lines.push(renderCase(c))
    }
  }

  // ---- 已通过（折叠为清单，不膨胀） ----
  const passed = summary.cases.filter((c) => c.verdict === 'passed')
  if (passed.length > 0) {
    lines.push('## 已通过')
    lines.push('')
    for (const c of passed) {
      lines.push(`- \`${c.id}\` ${c.title}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function renderCase(c: CaseOutcome): string {
  const lines: string[] = []
  lines.push(`### \`${c.id}\` ${c.title}`)
  lines.push('')
  lines.push(`- 结果：${VERDICT_BADGE[c.verdict]}（${c.durationMs}ms）`)
  lines.push(`- kind：\`${c.kind}\``)
  if (c.sourceIssue !== null) lines.push(`- 来源：${c.sourceIssue}`)
  // 归因是分流建议，不是判决：标签后面保留原始枚举值，便于按类别 grep。
  if (c.failureCategory) {
    lines.push(`- 归因：${FAILURE_CATEGORY_LABEL[c.failureCategory]}（\`${c.failureCategory}\`）`)
  }
  if (c.rounds && c.rounds.length > 0) lines.push(`- repeat：${formatRounds(c.rounds)}`)
  if (c.policy) lines.push(`- 成本闸门：${formatPolicy(c.policy)}`)
  if (c.usage) lines.push(`- 用量：${formatUsage(c.usage)}`)
  if (c.skipReason) lines.push(`- 跳过原因：${c.skipReason}`)
  if (c.error) lines.push(`- 错误：\`${c.error}\``)
  if (c.releaseFailures.length > 0) {
    lines.push(`- ⚠️ 夹具释放失败 ${c.releaseFailures.length} 项（有泄漏风险）：`)
    for (const f of c.releaseFailures) lines.push(`  - \`${f.label}\`：${f.error}`)
  }
  lines.push('')

  if (c.minimalRepro) {
    lines.push('**最小复现**')
    lines.push('')
    lines.push('```bash')
    lines.push(c.minimalRepro)
    lines.push('```')
    lines.push('')
  }

  for (const step of c.steps) {
    lines.push(renderStep(step))
  }

  return lines.join('\n')
}

function renderStep(step: StepOutcome): string {
  const lines: string[] = []
  const failed = step.assertions.filter((a) => !a.ok && !a.soft)
  const head = failed.length > 0 ? '❌' : '✅'

  lines.push(`#### ${head} ${step.name}`)
  if (step.action) {
    const mark = step.action.ok ? 'ok' : 'err'
    lines.push(`- act \`${step.action.kind}\` → ${mark}${step.action.detail ? `：${step.action.detail}` : ''}`)
  }
  for (const a of step.assertions) {
    lines.push(`- ${renderAssertion(a)}`)
  }
  lines.push('')
  return lines.join('\n')
}

function renderAssertion(a: AssertionOutcome): string {
  const word = assertionWord(a)
  const expected = assertionExpected(a)
  const mark = a.ok ? '✅' : a.soft ? '⚠️(soft)' : '❌'
  const actual = safeStringify(a.actual)
  return `${mark} \`${a.assertion.ref}\` ${word ?? '?'} ${expected} — 实际 \`${truncate(actual, 160)}\`${a.ok ? '' : ` · ${a.message}`}`
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 表格单元格里不能出现裸 `|`。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}
