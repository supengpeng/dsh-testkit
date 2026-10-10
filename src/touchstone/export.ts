/**
 * touchstone 融合 · 阶段一（输出通道）
 * `runs/<RUN-ID>/run.json` → `bug_report/<CASE-ID>/`（文件产物，单向）。
 *
 * ## 适配器模式，不是合并模式
 *
 *   · 本仓（TS）与 touchstone（Python）**各自独立**，本文件只产文件产物：
 *     不 import 对方、不写对方代码、不改对方任何文件
 *   · 不共享数据库（我们是文件，它是 SQLite）
 *   · 不嵌入对方运行时
 *   · 不对本产物的结构做 **API 稳定承诺**（见 `docs/TOUCHSTONE.md`「不做什么」）
 *
 * ## 产物结构（`outDir` 即 `bug_report/` 根）
 *
 * ```
 * bug_report/<CASE-ID>/report.md          人读：现象 / 期望 / 实际 / 复现
 *                    /repro.yaml           可复跑片段（命令口径见下）
 *                    /severity.txt         单行 low|medium|high
 *                    /evidence/trace.json  该 case 的 CaseOutcome 原始取证
 *                    /evidence/logs.txt    步骤 / 动作 / 断言 / 释放失败的平铺日志
 * bug_report/_export-<RUN-ID>.md          本次导出了谁、**没导出谁、为什么**
 * ```
 *
 * `repro.yaml` 里的复现命令**不是**本文件新造的：一律取
 * `src/analysis/repro.ts`（`CaseOutcome.minimalRepro` 或 `buildMinimalRepro()`）
 * 的原文。一个仓只能有一套复现口径，否则报告里写的那条命令迟早跑不起来。
 *
 * ## 只导出 failed / errored
 *
 *   · `passed`  —— 不是 bug，导出无意义
 *   · `skipped` —— **没跑过**，不是 bug（当成 bug 会制造假修复任务）
 *   · `failed` / `errored` —— 导出；但 severity 规则可能判它 `none`（见下表）
 *
 * ## severity 规则表（`failureCategory` × 场景 `severity`）
 *
 * | failureCategory | 场景 severity | 产出修复任务 | severity.txt | 依据 |
 * |---|---|---|---|---|
 * | `product_bug` | high | ✅ | `high` | 被测对象缺陷 × 高严重度 |
 * | `product_bug` | medium | ✅ | `medium` | 同上 |
 * | `product_bug` | low | ✅ | `low` | 同上 |
 * | `product_bug` | 未标注 | ✅ | `medium` | 未知按 medium：既不升级也不忽略 |
 * | `flaky` | 任意 | ✅ | `low` | 抖动不是确定性缺陷；证据在 `rounds` 里 |
 * | `env` | 任意 | ❌ `none` | — | 改运行条件（预算 / 能力 / 网络）不是代码修复任务 |
 * | `case_bug` | 任意 | ❌ `none` | — | 是**本仓用例**写错了，动被测代码修不好 |
 * | `driver_bug` | 任意 | ❌ `none` | — | 是**本仓引擎**缺陷，同上 |
 * | 无归因（failed/errored） | high | ✅ | `high` | 保守：没有归因 ≠ 没有缺陷 |
 * | 无归因（failed/errored） | medium/low/未标注 | ✅ | 场景 severity 或 `medium` | 同上 |
 *
 * `none` 的 case **不落目录**（touchstone 拿不到任务就不会去"修"），
 * 但必定出现在 `_export-<RUN-ID>.md` 的「未导出」表里并写明原因——
 * 静默丢弃是被禁止的：看不见的跳过等于假绿。
 */

import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { buildMinimalRepro } from '../analysis/repro.js'
import type { Severity } from '../cases/types.js'
import type { CaseOutcome, CaseVerdict, FailureCategory, RunSummary } from '../runtime/runlog.js'

/** `severity.txt` 的取值；`none` 表示**不产出**给 touchstone 的修复任务。 */
export type TouchstoneSeverity = Severity | 'none'

export interface SeverityDecision {
  severity: TouchstoneSeverity
  /** 是否产出给 touchstone 的修复任务。 */
  actionable: boolean
  /** 判定依据（进 report.md 与导出索引，便于事后复核）。 */
  reason: string
}

/** severity 规则表（上表）的唯一实现，纯函数。 */
export function decideSeverity(
  category: FailureCategory | undefined,
  scenarioSeverity: Severity | undefined,
): SeverityDecision {
  switch (category) {
    case 'product_bug':
      return {
        severity: scenarioSeverity ?? 'medium',
        actionable: true,
        reason:
          scenarioSeverity === undefined
            ? 'product_bug × 场景 severity 未标注 → medium（未知按 medium：既不升级也不忽略）'
            : `product_bug × 场景 ${scenarioSeverity} → ${scenarioSeverity}`,
      }
    case 'flaky':
      return {
        severity: 'low',
        actionable: true,
        reason: 'flaky → low（多轮结果不一致，不是确定性缺陷；先给低档并附 rounds 证据）',
      }
    case 'env':
      return {
        severity: 'none',
        actionable: false,
        reason: 'env → none（换运行条件就能得出真结论，不是代码修复任务）',
      }
    case 'case_bug':
      return {
        severity: 'none',
        actionable: false,
        reason: 'case_bug → none（本仓用例写错，动被测代码修不好；改的是本仓的 case）',
      }
    case 'driver_bug':
      return {
        severity: 'none',
        actionable: false,
        reason: 'driver_bug → none（本仓引擎/驱动缺陷，与被测对象无关）',
      }
    default:
      return {
        severity: scenarioSeverity ?? 'medium',
        actionable: true,
        reason:
          '无 failureCategory（老 run.json / 手写记录）→ 保守导出：没有归因不等于没有缺陷，' +
          `severity 取场景 ${scenarioSeverity ?? '未标注 → medium'}`,
      }
  }
}

/** 一条已生成的 bug report（内存态；`contents` 的键是相对 `outDir` 的正斜杠路径）。 */
export interface BugReport {
  caseId: string
  title: string
  verdict: CaseVerdict
  failureCategory: FailureCategory | null
  scenarioSeverity: Severity | null
  severity: Severity
  severityReason: string
  /** 相对 `outDir` 的产物路径（正斜杠），排序稳定。 */
  files: string[]
  /** 相对路径 → 文件内容。 */
  contents: Record<string, string>
}

/** 一条**没有**导出给 touchstone 的 failed/errored（以及被规则判 `none` 的）。 */
export interface SkippedBugReport {
  caseId: string
  verdict: CaseVerdict
  /** 规则表判出的结论；永远不是 low/medium/high。 */
  severity: 'none'
  reason: string
}

export interface BugReportPlanOptions {
  /**
   * 场景 severity 查询。
   *
   * `run.json` 不含场景 severity（它属于 case 定义，不属于一次运行），
   * 所以由调用方补；查不到就当"未标注"，按上表兜底，**不猜**。
   */
  scenarioSeverity?: (caseId: string) => Severity | undefined
  /** 注入时钟（产物稳定性 / 测试用）。 */
  now?: string
}

export interface BugReportPlan {
  runId: string
  exported: BugReport[]
  skipped: SkippedBugReport[]
  /** 导出索引（`_export-<RUN-ID>.md`）的正文。 */
  indexMarkdown: string
}

/** 纯函数：算出"导出谁、不导出谁、为什么"，不碰文件系统。 */
export function planBugReports(
  summary: RunSummary,
  options: BugReportPlanOptions = {},
): BugReportPlan {
  const now = options.now ?? new Date().toISOString()
  const exported: BugReport[] = []
  const skipped: SkippedBugReport[] = []

  for (const item of summary.cases) {
    if (item.verdict === 'passed') {
      skipped.push({
        caseId: item.id,
        verdict: item.verdict,
        severity: 'none',
        reason: 'passed：不是 bug（导出等于制造假任务）',
      })
      continue
    }
    if (item.verdict === 'skipped') {
      skipped.push({
        caseId: item.id,
        verdict: item.verdict,
        severity: 'none',
        reason: `skipped：**没跑过**，不是 bug（原因：${item.skipReason ?? '未记录'}）`,
      })
      continue
    }

    const scenarioSeverity = options.scenarioSeverity?.(item.id)
    const decision = decideSeverity(item.failureCategory, scenarioSeverity)
    if (!decision.actionable || decision.severity === 'none') {
      skipped.push({
        caseId: item.id,
        verdict: item.verdict,
        severity: 'none',
        reason: decision.reason,
      })
      continue
    }

    // 上面排掉了 `none`，这里 `decision.severity` 已被收窄成 Severity
    const severity: Severity = decision.severity
    const files = buildFiles(item, summary, severity, decision.reason, scenarioSeverity, now)
    exported.push({
      caseId: item.id,
      title: item.title,
      verdict: item.verdict,
      failureCategory: item.failureCategory ?? null,
      scenarioSeverity: scenarioSeverity ?? null,
      severity,
      severityReason: decision.reason,
      files: Object.keys(files).sort(),
      contents: files,
    })
  }

  return {
    runId: summary.runId,
    exported,
    skipped,
    indexMarkdown: renderIndex(summary, exported, skipped, now),
  }
}

export interface ExportBugReportsRequest extends BugReportPlanOptions {
  /** `RunSummary` 或 `runs/<id>/run.json` 的路径。 */
  source: RunSummary | string
  /** `bug_report/` 根目录。 */
  outDir: string
}

export interface ExportedBugReportSummary {
  caseId: string
  severity: Severity
  dir: string
  files: string[]
}

export interface ExportBugReportsResult {
  runId: string
  outDir: string
  exported: ExportedBugReportSummary[]
  skipped: SkippedBugReport[]
  indexFile: string
}

/** 读一份 `run.json`（同步；只做形状体检，不做 schema 全量校验）。 */
export function loadRunSummary(path: string): RunSummary {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`run.json 无法读取/解析：${path}（${messageOf(error)}）`)
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`run.json 顶层必须是对象：${path}`)
  }
  const record = raw as Partial<RunSummary>
  if (typeof record.runId !== 'string' || !Array.isArray(record.cases)) {
    throw new Error(`run.json 缺少 runId / cases：${path}`)
  }
  // 逐条体检：形状不对时给"哪一条、缺什么"，而不是让渲染阶段抛 TypeError
  record.cases.forEach((item, index) => {
    const at = `${path} 的 cases[${index}]`
    if (item === null || typeof item !== 'object') throw new Error(`${at} 不是对象`)
    const outcome = item as Partial<CaseOutcome>
    if (typeof outcome.id !== 'string' || outcome.id === '') throw new Error(`${at} 缺少 id`)
    if (!Array.isArray(outcome.steps)) throw new Error(`${at}（${outcome.id}）缺少 steps 数组`)
  })
  return record as RunSummary
}

/** 把一次运行的 failed/errored 落成 `bug_report/`（唯一有副作用的入口）。 */
export async function exportBugReports(
  request: ExportBugReportsRequest,
): Promise<ExportBugReportsResult> {
  const summary =
    typeof request.source === 'string' ? loadRunSummary(request.source) : request.source

  const plan = planBugReports(summary, {
    ...(request.scenarioSeverity === undefined
      ? {}
      : { scenarioSeverity: request.scenarioSeverity }),
    ...(request.now === undefined ? {} : { now: request.now }),
  })

  for (const report of plan.exported) {
    for (const rel of report.files) {
      const abs = join(request.outDir, rel)
      await mkdir(dirOf(abs), { recursive: true })
      await writeFile(abs, report.contents[rel] ?? '', 'utf8')
    }
  }

  const indexFile = join(request.outDir, `_export-${plan.runId}.md`)
  await mkdir(request.outDir, { recursive: true })
  await writeFile(indexFile, plan.indexMarkdown, 'utf8')

  return {
    runId: plan.runId,
    outDir: request.outDir,
    exported: plan.exported.map((r) => ({
      caseId: r.caseId,
      severity: r.severity,
      dir: join(request.outDir, r.caseId),
      files: r.files,
    })),
    skipped: plan.skipped,
    indexFile,
  }
}

/* ------------------------------------------------------------ 内部：产物 -- */

function buildFiles(
  item: CaseOutcome,
  summary: RunSummary,
  severity: Severity,
  severityReason: string,
  scenarioSeverity: Severity | undefined,
  now: string,
): Record<string, string> {
  const base = item.id
  const failing = firstFailingStep(item)
  const reproText = item.minimalRepro ?? buildMinimalRepro({ caseId: item.id, ...failing })
  const meta = {
    caseId: item.id,
    title: item.title,
    kind: item.kind,
    verdict: item.verdict,
    failureCategory: item.failureCategory ?? null,
    scenarioSeverity: scenarioSeverity ?? null,
    severity,
    severityReason,
    exportedAt: now,
    runId: summary.runId,
  }

  return {
    [`${base}/report.md`]: renderReport(item, summary, meta, reproText),
    [`${base}/repro.yaml`]: renderReproYaml(item, meta, reproText, failing),
    [`${base}/severity.txt`]: `${severity}\n`,
    [`${base}/evidence/trace.json`]: `${JSON.stringify(
      { schema: 1, ...meta, case: item },
      null,
      2,
    )}\n`,
    [`${base}/evidence/logs.txt`]: renderLogs(item, meta),
  }
}

/** 第一条**硬**失败的步骤（软断言失败不算），供复现指引点名"看哪一步"。 */
function firstFailingStep(item: CaseOutcome): { failingStepIndex?: number; failingStepName?: string } {
  const index = item.steps.findIndex((step) =>
    step.assertions.some((a) => !a.ok && !a.soft),
  )
  if (index < 0) return {}
  const name = item.steps[index]?.name
  return { failingStepIndex: index, ...(name === undefined ? {} : { failingStepName: name }) }
}

function renderReport(
  item: CaseOutcome,
  summary: RunSummary,
  meta: Record<string, unknown>,
  reproText: string,
): string {
  const lines: string[] = []
  lines.push(`# ${item.id} ${item.title}`)
  lines.push('')
  lines.push(`- 结果：\`${item.verdict}\`（${item.durationMs}ms）`)
  lines.push(`- kind：\`${item.kind}\``)
  lines.push(`- failureCategory：\`${item.failureCategory ?? '(无)'}\``)
  lines.push(
    `- 场景 severity：\`${meta['scenarioSeverity'] ?? '未标注'}\` → **severity.txt = ${meta['severity']}**`,
  )
  lines.push(`- 判定依据：${meta['severityReason']}`)
  if (item.owner) lines.push(`- owner：${item.owner}`)
  if (item.sourceIssue !== null) lines.push(`- 来源 issue：${item.sourceIssue}`)
  lines.push(`- 运行：\`${summary.runId}\`（${summary.startedAt} → ${summary.finishedAt}）`)
  lines.push(`- 环境：${summary.dshVersion} · ${summary.platform} · casesDir=\`${summary.casesDir}\``)
  if (item.error) lines.push(`- error：\`${item.error}\``)
  if (item.cleanup && item.cleanup.leftovers.length > 0) {
    lines.push(`- ⚠️ 残留：${item.cleanup.leftovers.join('、')}`)
  }
  if (item.releaseFailures.length > 0) {
    lines.push(`- ⚠️ 夹具释放失败 ${item.releaseFailures.length} 项（有泄漏风险）`)
  }
  lines.push('')

  lines.push('## 现象（失败断言）')
  lines.push('')
  const failing = item.steps.flatMap((step, i) =>
    step.assertions
      .filter((a) => !a.ok)
      .map((a) => ({ stepIndex: i, stepName: step.name, assertion: a })),
  )
  if (failing.length === 0) {
    lines.push('（没有失败断言——errored / 引擎或环境问题，见 `evidence/logs.txt`）')
  } else {
    lines.push('| 步骤 | 断言 | 期望 | 实际 | 判定 |')
    lines.push('|---|---|---|---|---|')
    for (const row of failing) {
      const a = row.assertion
      lines.push(
        `| ${row.stepIndex + 1}. ${cell(row.stepName)} | \`${a.assertion.ref}\` | ${cell(
          expectedOf(a.assertion as unknown as Record<string, unknown>),
        )} | ${cell(stringify(a.actual))} | ${a.soft ? '⚠️ soft' : '❌ 硬失败'} |`,
      )
    }
    for (const row of failing) {
      lines.push('')
      lines.push(`### 第 ${row.stepIndex + 1} 步「${row.stepName}」`)
      lines.push('')
      lines.push(`- 断言：\`${row.assertion.assertion.ref}\``)
      lines.push(`- 说明：${row.assertion.message}`)
    }
  }
  lines.push('')

  lines.push('## 最小复现')
  lines.push('')
  lines.push('```bash')
  lines.push(reproText)
  lines.push('```')
  lines.push('')
  lines.push('^ 这段文字与 `repro.yaml` 的 `commands` 块同源，均出自 `src/analysis/repro.ts`。')
  lines.push('')

  lines.push('## 取证')
  lines.push('')
  lines.push('- `evidence/trace.json`：本 case 的原始 `CaseOutcome`（含逐步增量 note）')
  lines.push('- `evidence/logs.txt`：步骤 / 动作 / 断言 / 释放失败的平铺日志')
  lines.push('- `repro.yaml`：可复跑片段（机器读）')
  lines.push('')
  return `${lines.join('\n')}\n`
}

function renderReproYaml(
  item: CaseOutcome,
  meta: Record<string, unknown>,
  reproText: string,
  failing: { failingStepIndex?: number; failingStepName?: string },
): string {
  const lines: string[] = []
  lines.push('# 由 src/touchstone/export.ts 生成 —— 命令口径唯一来源是 src/analysis/repro.ts')
  lines.push('schema: 1')
  lines.push(`caseId: ${item.id}`)
  lines.push(`kind: ${item.kind}`)
  lines.push(`verdict: ${item.verdict}`)
  lines.push(`failureCategory: ${item.failureCategory ?? 'null'}`)
  lines.push(`scenarioSeverity: ${meta['scenarioSeverity'] ?? 'null'}`)
  lines.push(`severity: ${meta['severity']}`)
  lines.push(`runId: ${meta['runId']}`)
  if (failing.failingStepIndex === undefined) {
    lines.push('failingStep: null')
  } else {
    lines.push('failingStep:')
    lines.push(`  index: ${failing.failingStepIndex}`)
    lines.push(`  name: ${quote(failing.failingStepName ?? '')}`)
  }
  lines.push('# 以下 commands 是 buildMinimalRepro() 的原文，本文件不硬编码任何命令字面量。')
  // 用 `|-`（strip）而不是 `|`：否则 YAML 解析回来会多一个尾换行，逐字节比对就不再等价。
  lines.push('commands: |-')
  for (const line of reproText.replace(/\n+$/, '').split('\n')) lines.push(`  ${line}`)
  lines.push('')
  return lines.join('\n')
}

function renderLogs(item: CaseOutcome, meta: Record<string, unknown>): string {
  const lines: string[] = []
  lines.push(`# ${item.id} ${item.title}`)
  lines.push(`# run=${meta['runId']} verdict=${item.verdict} category=${item.failureCategory ?? '(无)'} severity=${meta['severity']}`)
  lines.push(`# durationMs=${item.durationMs} kind=${item.kind} owner=${item.owner ?? '(无)'}`)
  if (item.error) lines.push(`error: ${item.error}`)
  if (item.skipReason) lines.push(`skipReason: ${item.skipReason}`)
  for (const failure of item.releaseFailures) {
    lines.push(`releaseFailure: ${failure.label} → ${failure.error}`)
  }
  if (item.rounds && item.rounds.length > 0) {
    lines.push(`rounds: ${item.rounds.map((ok) => (ok ? 'pass' : 'fail')).join(', ')}`)
  }
  if (item.policy) {
    lines.push(`policy: allowed=${item.policy.allowed} cost=${item.policy.cost} reason=${item.policy.reason}`)
  }
  if (item.usage) lines.push(`usage: modelCalls=${item.usage.modelCalls} tokens=${item.usage.tokens}`)
  lines.push('')

  item.steps.forEach((step, i) => {
    lines.push(`--- step ${i + 1}: ${step.name} (${step.durationMs}ms)`)
    if (step.action) {
      lines.push(
        `act ${step.action.kind} → ${step.action.ok ? 'ok' : 'err'}${step.action.detail ? `: ${step.action.detail}` : ''}`,
      )
    }
    for (const a of step.assertions) {
      const mark = a.ok ? 'ok  ' : a.soft ? 'soft' : 'FAIL'
      lines.push(
        `${mark} ${a.assertion.ref} ${describeAssertion(a.assertion as unknown as Record<string, unknown>)}` +
          ` | actual=${stringify(a.actual)}${a.message ? ` | ${a.message}` : ''}`,
      )
    }
    if (step.notes && Object.keys(step.notes).length > 0) {
      lines.push(`notes: ${stringify(step.notes)}`)
    }
    lines.push('')
  })
  return `${lines.join('\n')}\n`
}

function renderIndex(
  summary: RunSummary,
  exported: BugReport[],
  skipped: SkippedBugReport[],
  now: string,
): string {
  const lines: string[] = []
  lines.push(`# bug_report 导出 · ${summary.runId}`)
  lines.push('')
  lines.push(`- 导出时间：${now}`)
  lines.push(`- 输入：\`${summary.casesDir}\` · ${summary.dshVersion} · ${summary.platform}`)
  lines.push(
    `- 合计 ${summary.totals.total} 条：✅ ${summary.totals.passed} · ❌ ${summary.totals.failed} · ⏭️ ${summary.totals.skipped} · 💥 ${summary.totals.errored}`,
  )
  lines.push(`- **导出 ${exported.length} 条 / 未导出 ${skipped.length} 条**`)
  lines.push('')
  lines.push('## 已导出（touchstone 的输入）')
  lines.push('')
  if (exported.length === 0) {
    lines.push('（无）')
  } else {
    lines.push('| Case | 结果 | failureCategory | 场景 severity | severity.txt | 产物 |')
    lines.push('|---|---|---|---|---|---|')
    for (const r of exported) {
      lines.push(
        `| \`${r.caseId}\` | ${r.verdict} | \`${r.failureCategory ?? '(无)'}\` | ${r.scenarioSeverity ?? '未标注'} | **${r.severity}** | ${r.files.length} 个文件 |`,
      )
    }
  }
  lines.push('')
  lines.push('## 未导出（写明原因——静默丢弃是被禁止的）')
  lines.push('')
  lines.push('| Case | 结果 | 原因 |')
  lines.push('|---|---|---|')
  for (const s of skipped) {
    lines.push(`| \`${s.caseId}\` | ${s.verdict} | ${cell(s.reason)} |`)
  }
  lines.push('')
  lines.push('规则表见 `src/touchstone/export.ts` 文件头与 `docs/TOUCHSTONE.md`。')
  lines.push('')
  return `${lines.join('\n')}\n`
}

/* ------------------------------------------------------------ 小工具 -- */

/** 取断言里的判定词与期望值（渲染用；判定词本身不是这里的职责）。 */
function expectedOf(assertion: Record<string, unknown>): string {
  const words = [
    'is',
    'isNot',
    'notIs',
    'exists',
    'notExists',
    'contains',
    'notContains',
    'matches',
    'atLeast',
    'atMost',
    'length',
    'lengthAtLeast',
    'lengthAtMost',
    'throws',
  ]
  const word = words.find((w) => assertion[w] !== undefined)
  if (word === undefined) return '(无判定词)'
  return `${word} ${stringify(assertion[word])}`
}

function describeAssertion(assertion: Record<string, unknown>): string {
  return expectedOf(assertion)
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Markdown 表格单元格不能有裸 `|` 与换行。 */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

/** YAML 标量：统一走 JSON 双引号，避免空格 / 冒号带来的歧义。 */
function quote(text: string): string {
  return JSON.stringify(text)
}

function dirOf(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index < 0 ? '.' : file.slice(0, index)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
