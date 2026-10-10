/**
 * 人类可读的 trace 时间线（终端 / Markdown 报告用）。
 *
 * 回答两个问题：
 *   ① 每条 case 的时间花在哪个阶段、哪一步（步骤耗时表）
 *   ② 整次运行最慢的步骤是谁（top N）
 *
 * 与三种机器可读导出同源：都走 `resolveTrace`，所以"重建"的近似性
 * 会同样出现在时间线里（表头明确写出数据来源）。
 */

import type { RunSummary } from '../runtime/runlog.js'
import {
  DEFAULT_SLOWEST_TOP,
  resolveTrace,
  summarizeTrace,
  type TraceSource,
} from './spans.js'

const VERDICT_BADGE: Record<string, string> = {
  passed: '✅ passed',
  failed: '❌ failed',
  skipped: '⏭️ skipped',
  errored: '💥 errored',
}

export interface TimelineOptions {
  /** 最慢榜取前几条（默认 5）。 */
  top?: number
}

/** 渲染 Markdown 时间线。 */
export function renderTimeline(summary: RunSummary, options: TimelineOptions = {}): string {
  const resolved = resolveTrace(summary)
  const stats = summarizeTrace(summary, options)
  const lines: string[] = []

  lines.push('# dsh-testkit trace 时间线')
  lines.push('')
  lines.push(`- **Run**：\`${summary.runId}\``)
  lines.push(`- **数据来源**：${describeSource(resolved.generatedFrom)}`)
  lines.push(
    `- **合计**：${resolved.cases.length} 条 case · ${stats.spans} 个 span · 总耗时 ${formatMs(stats.totalMs)}`,
  )
  lines.push('')

  if (resolved.cases.length === 0) {
    // 空运行就说空，不摆一张空表装作有数据。
    lines.push('（本次运行没有任何 case，无 trace 可展示。）')
    return lines.join('\n')
  }

  for (const item of resolved.cases) {
    lines.push(`## \`${item.id}\` ${item.title}`)
    lines.push('')
    lines.push(
      `- 结果：${VERDICT_BADGE[item.verdict] ?? item.verdict} · 耗时 ${formatMs(item.durationMs)}` +
        ` · ${item.spans.length} 个 span · 来源 ${item.generatedFrom}`,
    )
    lines.push('')

    if (item.spans.length === 0) {
      lines.push('（该 case 没有记录到 span。）')
      lines.push('')
      continue
    }

    lines.push('| 阶段 | 名称 | 开始 | 耗时 | 结果 |')
    lines.push('|---|---|---|---|---|')
    for (const span of item.spans) {
      lines.push(
        `| ${span.phase} | ${escapeCell(span.name)} | +${formatNum(span.startMs)}ms |` +
          ` ${formatNum(span.durationMs)}ms | ${renderOk(span.ok)} |`,
      )
    }
    lines.push('')
  }

  const topCount = options.top ?? DEFAULT_SLOWEST_TOP
  lines.push(`## 最慢 top ${Math.min(Math.max(0, Math.trunc(topCount)), stats.slowest.length)}`)
  lines.push('')
  if (stats.slowest.length === 0) {
    lines.push('（没有可排名的步骤 span。）')
    lines.push('')
    return lines.join('\n')
  }
  lines.push('（不含 `case` 总跨度——它只是容器，会把真正的慢步骤挤掉。）')
  lines.push('')
  lines.push('| # | Case | 阶段 | 名称 | 耗时 |')
  lines.push('|---|---|---|---|---|')
  stats.slowest.forEach((span, index) => {
    lines.push(
      `| ${index + 1} | \`${span.caseId}\` | ${span.phase} | ${escapeCell(span.name)} | ${formatNum(span.durationMs)}ms |`,
    )
  })
  lines.push('')
  return lines.join('\n')
}

function describeSource(source: TraceSource): string {
  return source === 'live'
    ? 'live（runner 真实记录：偏移 / 间隙 / act-assert 分界都是真的）'
    : 'reconstructed（由 `steps[].durationMs` 重建的**近似**：只有累计时长，无真实间隙与 act/assert 分界）'
}

function renderOk(ok: boolean | undefined): string {
  if (ok === undefined) return '—'
  return ok ? '✅' : '❌'
}

/** 表格单元格里不能出现裸 `|`。 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

/** 毫秒数保留两位小数（去掉浮点尾巴）。 */
function formatNum(ms: number): string {
  return String(Math.round(ms * 100) / 100)
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${formatNum(ms)}ms`
}
