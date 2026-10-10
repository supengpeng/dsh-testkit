/**
 * issue 草稿生成（文档 §7.5）。
 *
 * 只对 `failed` / `errored` 生成：**绿灯不开单**（否则就是刷屏，issue 流的信噪比
 * 会立刻归零）。全绿 / 只有跳过时返回空草稿（`title === ''`），调用方据此跳过。
 *
 * 一次运行可能有不止一条失败，但**一个 issue 只讲一条**（primary = 第一条失败）：
 * 标题里只放得下一个场景 id 与一句话症状。其余失败在正文里列表列出，
 * 保证"没被这条 issue 提到"这件事不会悄悄发生。
 *
 * 本模块**只生成文本**：不打标签、不建 issue、不通知任何人。动作在 CI / CLI。
 */

import type { RunSummary } from '../runtime/runlog.js'
import {
  DETAIL_LIMIT,
  LIST_LIMIT,
  REPRO_LIMIT,
  SNIPPET_LIMIT,
  TITLE_LIMIT,
  evidenceLines,
  escapeCell,
  failureFacts,
  failingCases,
  safeSnippet,
  truncate,
  type FailureFacts,
} from './artifacts.js'

export interface IssueDraftOptions {
  /** `owner/name`；只写进正文做指引，不做校验（本模块不联网）。 */
  repo?: string
  /** CI 运行页链接。 */
  runUrl?: string
}

export interface IssueDraft {
  title: string
  body: string
  labels: string[]
  assignees: string[]
}

/**
 * 生成 issue 草稿。
 *
 * `title === ''` 表示**这一轮没有可开的 issue**（无 `failed` / `errored`），
 * 此时其余字段也是空——不要拿空草稿去建 issue。
 */
export function buildIssueDraft(summary: RunSummary, options: IssueDraftOptions = {}): IssueDraft {
  const failures = failingCases(summary).map(failureFacts)
  const primary = failures[0]
  if (primary === undefined) {
    return { title: '', body: '', labels: [], assignees: [] }
  }

  return {
    title: truncate(`[dsh-testkit] ${primary.outcome.id}：${primary.symptom}`, TITLE_LIMIT),
    body: renderBody(summary, primary, failures, options),
    labels: [...primary.labels],
    // 只指派 primary 的 owner：把一批失败里所有人的名字都挂上一条 issue 是噪音。
    // 其余失败的 owner 在正文表里可见，由人决定要不要拆单。
    assignees: primary.owner === undefined ? [] : [primary.owner],
  }
}

function renderBody(
  summary: RunSummary,
  primary: FailureFacts,
  failures: readonly FailureFacts[],
  options: IssueDraftOptions,
): string {
  const lines: string[] = []

  lines.push('## 失败摘要')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('|---|---|')
  lines.push(`| 场景 | \`${primary.outcome.id}\` ${escapeCell(primary.outcome.title)} |`)
  lines.push(`| kind | \`${primary.outcome.kind}\` |`)
  lines.push(
    `| 结果 | ${verdictBadge(primary.outcome.verdict)}（${primary.outcome.durationMs}ms） |`,
  )
  lines.push(
    `| 归因 | ${primary.categoryLabel}${primary.category === undefined ? '' : `（\`${primary.category}\`）`} |`,
  )
  lines.push(`| owner | ${primary.ownerLabel} |`)
  lines.push(`| 运行 | \`${summary.runId}\` |`)
  lines.push('')

  if (primary.detail !== undefined) {
    lines.push('## 期望 / 实际')
    lines.push('')
    lines.push(`- 断言：\`${primary.detail.ref} ${primary.detail.word}\``)
    lines.push(`- 期望：\`${primary.detail.expected}\``)
    lines.push(`- 实际：\`${primary.detail.actual}\``)
    if (primary.detail.message !== '') lines.push(`- 消息：${primary.detail.message}`)
    lines.push('')
  } else if (primary.outcome.error !== undefined && primary.outcome.error.trim() !== '') {
    lines.push('## 错误')
    lines.push('')
    lines.push(`> ${safeSnippet(primary.outcome.error, DETAIL_LIMIT)}`)
    lines.push('')
  }

  if (primary.outcome.minimalRepro !== undefined && primary.outcome.minimalRepro.trim() !== '') {
    lines.push('## 最小复现')
    lines.push('')
    lines.push('```bash')
    lines.push(safeSnippet(primary.outcome.minimalRepro, REPRO_LIMIT))
    lines.push('```')
    lines.push('')
  }

  lines.push('## 证据')
  lines.push('')
  for (const line of evidenceLines(summary, options)) lines.push(line)
  lines.push('')

  const others = failures.slice(1)
  if (others.length > 0) {
    lines.push(`## 同批其他失败（${others.length} 条）`)
    lines.push('')
    lines.push('| Case | Kind | 归因 | 症状 | Owner |')
    lines.push('|---|---|---|---|---|')
    for (const item of others.slice(0, LIST_LIMIT)) {
      lines.push(
        `| \`${item.outcome.id}\` | ${item.outcome.kind} | ${escapeCell(item.categoryLabel)} |` +
          ` ${escapeCell(item.symptom)} | ${item.ownerLabel} |`,
      )
    }
    lines.push('')
    if (others.length > LIST_LIMIT) {
      lines.push(`_其余 ${others.length - LIST_LIMIT} 条见 \`runs/${summary.runId}/run.json\`。_`)
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('')
  lines.push(
    `<sub>本 issue 由 dsh-testkit 自动生成：正文只含摘要与截断片段` +
      `（症状 ≤${SNIPPET_LIMIT} 字符、期望/实际 ≤${DETAIL_LIMIT} 字符、最小复现 ≤${REPRO_LIMIT} 字符），` +
      `**不含取证原文**（\`notes\` 不参与生成）。发帖动作由 CI 执行。</sub>`,
  )

  return lines.join('\n')
}

function verdictBadge(verdict: string): string {
  if (verdict === 'failed') return '❌ failed'
  if (verdict === 'errored') return '💥 errored'
  if (verdict === 'skipped') return '⏭️ skipped'
  return '✅ passed'
}
