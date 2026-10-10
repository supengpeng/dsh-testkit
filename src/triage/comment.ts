/**
 * PR 评论生成（文档 §8.2）。
 *
 * ## 为什么"全绿也要有内容"
 *
 * 群里/PR 上最危险的不是红，而是**沉默**：评论没出现时，读者无法区分
 * "跑过了且全绿""没跑""跑挂了但没贴上来"。所以绿灯也贴一条**简短证明**：
 * 结论行 + 计数 + 用时 + 通过清单（折叠）+ 证据链接。证明"确实跑过、确实全过"，
 * 但不把评论刷成一屏。
 *
 * ## 一行结论先说人话
 *
 * 第一行永远是结论：通过率 + 有没有失败。失败明细、最慢、归因都往后排——
 * 读者只想知道"能不能合"。
 *
 * 本模块**只生成文本**：不发请求、不编辑评论。发布动作在 CI / CLI。
 * 正文纪律（不含取证原文、长度上限、省略标记）见 `./artifacts.js` 文件头。
 */

import type { CaseOutcome, RunSummary } from '../runtime/runlog.js'
import {
  LIST_LIMIT,
  REPRO_LIMIT,
  evidenceLines,
  escapeCell,
  failureFacts,
  failingCases,
  safeSnippet,
} from './artifacts.js'

export interface PrCommentOptions {
  runUrl?: string
  reportPath?: string
  junitPath?: string
}

/** 失败明细里最多给几条最小复现（再多就没人看了）。 */
const REPRO_SHOWN = 3
/** 绿灯清单最多列几条通过 case。 */
const PASSED_SHOWN = 30

/**
 * 渲染 PR 评论（Markdown）。任何输入都有内容——包括全绿与空运行。
 */
export function buildPrComment(summary: RunSummary, options: PrCommentOptions = {}): string {
  const failures = failingCases(summary).map(failureFacts)
  const { totals } = summary
  const lines: string[] = []

  // 隐藏标记：CI 可以据此找到上一条评论并**原地更新**，而不是每次重贴一条。
  lines.push('<!-- dsh-testkit-report -->')
  lines.push(renderHeadline(summary, failures.length))
  lines.push('')
  lines.push(renderCountsLine(summary))
  lines.push('')

  if (totals.total === 0) {
    lines.push('本次运行没有 case：无结论可下（检查选择器 / casesDir）。')
    lines.push('')
    lines.push(...renderEvidence(summary, options))
    return lines.join('\n')
  }

  if (failures.length > 0) {
    lines.push('### 失败明细')
    lines.push('')
    lines.push('| Case | Kind | 归因 | 症状 | Owner |')
    lines.push('|---|---|---|---|---|')
    for (const item of failures.slice(0, LIST_LIMIT)) {
      lines.push(
        `| \`${item.outcome.id}\` | ${item.outcome.kind} | ${escapeCell(item.categoryLabel)} |` +
          ` ${escapeCell(item.symptom)} | ${item.ownerLabel} |`,
      )
    }
    lines.push('')
    if (failures.length > LIST_LIMIT) {
      lines.push(`_另有 ${failures.length - LIST_LIMIT} 条失败见 \`runs/${summary.runId}/run.json\`。_`)
      lines.push('')
    }

    const repros = failures.filter(
      (item) => item.outcome.minimalRepro !== undefined && item.outcome.minimalRepro.trim() !== '',
    )
    if (repros.length > 0) {
      lines.push('### 最小复现')
      lines.push('')
      for (const item of repros.slice(0, REPRO_SHOWN)) {
        lines.push(`<details><summary><code>${item.outcome.id}</code> 最小复现</summary>`)
        lines.push('')
        lines.push('```bash')
        lines.push(safeSnippet(item.outcome.minimalRepro, REPRO_LIMIT))
        lines.push('```')
        lines.push('')
        lines.push('</details>')
        lines.push('')
      }
      if (repros.length > REPRO_SHOWN) {
        lines.push(`_其余 ${repros.length - REPRO_SHOWN} 条的复现见运行产物。_`)
        lines.push('')
      }
    }

    lines.push(...renderEvidence(summary, options))
    lines.push(renderFooter())
    return lines.join('\n')
  }

  // ---- 全绿：给"简短证明"，不是空白 ----
  lines.push('本次没有失败用例。通过清单（折叠）：')
  lines.push('')
  const passed = summary.cases.filter((item) => item.verdict === 'passed')
  lines.push(`<details><summary>通过的 case（${passed.length}）</summary>`)
  lines.push('')
  for (const item of passed.slice(0, PASSED_SHOWN)) lines.push(`- \`${item.id}\` ${item.title}`)
  if (passed.length > PASSED_SHOWN) lines.push(`- …另有 ${passed.length - PASSED_SHOWN} 条`)
  lines.push('')
  lines.push('</details>')
  lines.push('')
  lines.push(...renderEvidence(summary, options))
  lines.push(renderFooter())
  return lines.join('\n')
}

/** 第一行结论：通过率 + 有没有失败。 */
function renderHeadline(summary: RunSummary, failureCount: number): string {
  const { totals } = summary
  if (totals.total === 0) return '## dsh-testkit：⚠️ 本次运行没有 case'
  const rate = Math.round((totals.passed / totals.total) * 100)
  if (failureCount === 0) {
    return `## dsh-testkit：✅ 全部通过（${totals.passed}/${totals.total}，${rate}%）`
  }
  return `## dsh-testkit：❌ ${failureCount} 条失败（${totals.total} 条中 ${rate}% 通过）`
}

/** 计数 / 用时 / 归因分布（一行）。 */
function renderCountsLine(summary: RunSummary): string {
  const { totals } = summary
  const parts = [
    `✅ ${totals.passed}`,
    `❌ ${totals.failed}`,
    `💥 ${totals.errored}`,
    `⏭️ ${totals.skipped}`,
    `用时 ${formatMs(totalDurationMs(summary))}`,
  ]

  const distribution = categoryDistribution(failingCases(summary))
  if (distribution !== '') parts.push(`归因：${distribution}`)

  return parts.join(' · ')
}

/** `被测对象缺陷 ×2 · 环境问题 ×1`。 */
function categoryDistribution(failures: readonly CaseOutcome[]): string {
  const counts = new Map<string, number>()
  for (const item of failures) {
    const label = failureFacts(item).categoryLabel
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([label, count]) => `${label} ×${count}`)
    .join(' · ')
}

function renderEvidence(summary: RunSummary, options: PrCommentOptions): string[] {
  const lines = ['### 证据', '']
  for (const line of evidenceLines(summary, options)) lines.push(line)
  lines.push('')
  return lines
}

function renderFooter(): string {
  return '<sub>由 dsh-testkit 自动生成；只含摘要与截断片段（**不含取证原文**）。发布动作由 CI 执行。</sub>'
}

function totalDurationMs(summary: RunSummary): number {
  return summary.cases.reduce((sum, item) => sum + item.durationMs, 0)
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`
  return `${Math.round(ms * 100) / 100}ms`
}

function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
