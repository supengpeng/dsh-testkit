/**
 * 运行报告的 Markdown 渲染。
 *
 * 只读 runlog 的数据结构，不做任何 DSH 调用。
 */

import type { AssertionOutcome, CaseOutcome, RunSummary, StepOutcome } from '../runtime/runlog.js'

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
  lines.push('')
  lines.push(
    `**合计**：${totals.total} 条 — ✅ ${totals.passed} · ❌ ${totals.failed} · ⏭️ ${totals.skipped} · 💥 ${totals.errored}`,
  )
  lines.push('')

  // ---- 概览表 ----
  lines.push('## 概览')
  lines.push('')
  lines.push('| Case | Kind | 结果 | 耗时 | 标题 | 来源 |')
  lines.push('|---|---|---|---|---|---|')
  for (const c of summary.cases) {
    const ms = `${c.durationMs}ms`
    const issue = c.sourceIssue === null ? '—' : shorten(c.sourceIssue, 40)
    lines.push(`| \`${c.id}\` | ${c.kind} | ${VERDICT_BADGE[c.verdict]} | ${ms} | ${escapeCell(c.title)} | ${issue} |`)
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

  // ---- 已通过（折叠为清单） ----
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
  if (c.skipReason) lines.push(`- 跳过原因：${c.skipReason}`)
  if (c.error) lines.push(`- 错误：\`${c.error}\``)
  if (c.releaseFailures.length > 0) {
    lines.push(`- ⚠️ 夹具释放失败 ${c.releaseFailures.length} 项（有泄漏风险）：`)
    for (const f of c.releaseFailures) lines.push(`  - \`${f.label}\`：${f.error}`)
  }
  lines.push('')

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
  const word = Object.keys(a.assertion).find((k) => k !== 'ref' && k !== 'soft' && a.assertion[k as never] !== undefined)
  const expected = word ? JSON.stringify(a.assertion[word as never]) : '?'
  const mark = a.ok ? '✅' : a.soft ? '⚠️(soft)' : '❌'
  const actual = safeStringify(a.actual)
  return `${mark} \`${a.assertion.ref}\` ${word} ${expected} — 实际 \`${truncate(actual, 160)}\`${a.ok ? '' : ` · ${a.message}`}`
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…(${text.length})`
}

function shorten(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/** 表格单元格里不能出现裸 `|`。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}
