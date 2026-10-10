/**
 * 结果趋势 —— 从历史运行产物（`runs/<runId>/run.json`）聚合出可比较的指标。
 *
 * ## 两条纪律（这是本模块存在的理由）
 *
 * ① **只读**：趋势只读历史产物，绝不写回、绝不"顺手修一下"。历史是证据，
 *    被工具改过的证据就不再是证据了。
 * ② **样本不足要明说**：一次运行画不出趋势。数据不够时本模块在结论里写清
 *    "样本不足，别据此下结论"，而不是给一个看起来很确定的数字。
 *    （早期版本最危险的行为就是"1 次运行 → 通过率 100% → 结论：稳定"。）
 *
 * ## 为什么趋势要按维度分组
 *
 * 只报一个总通过率会把几件不同的事混成一件：`shell` 类在缺 subprocess 的宿主上
 * 全跳过、`agent` 类被成本闸门拦下，都会把总通过率拉低，而这与被测对象的质量无关。
 * 所以按 `kind` / `tag` / `owner` / `dshVersion` 分组，让"哪一类在退化"看得见。
 *
 * `CaseOutcome` 里**没有 tags**（见 src/runtime/runlog.ts 的字段说明），
 * 所以按 tag 聚合需要调用方注入 `scenarioTags(id) => string[]`——
 * 本模块不去改 runlog，也不去猜。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { CaseOutcome, RunSummary } from '../runtime/runlog.js'

/** 已加载的一次运行：产物目录 + 解析出的摘要。 */
export interface LoadedRun {
  /** 运行产物目录（`runs/<runId>`）。 */
  dir: string
  /** `run.json` 的绝对路径。 */
  file: string
  summary: RunSummary
}

/** 跳过的坏产物。 */
export interface SkippedRun {
  dir: string
  reason: string
}

export interface CollectRunsResult {
  runs: LoadedRun[]
  /** 坏文件（解析失败 / 结构不对 / 目录不存在）——跳过并计数，绝不静默。 */
  skipped: SkippedRun[]
}

export interface CollectRunsOptions {
  /** 只要最新的 N 次运行（按 startedAt 倒序）。省略 = 全部。 */
  limit?: number
}

export type TrendDimension = 'kind' | 'tag' | 'owner' | 'dshVersion'

export interface TrendOptions {
  dimension: TrendDimension
  /**
   * 场景 ID → 标签。只有 `dimension: 'tag'` 需要（`CaseOutcome` 不带 tags）。
   * 省略时所有 case 归入 `(无 tag)`，并在 notes 里说明。
   */
  scenarioTags?: (id: string) => string[]
}

export interface TrendGroup {
  key: string
  /** contributing 的运行次数（去重）。 */
  runs: number
  cases: number
  passed: number
  failed: number
  skipped: number
  errored: number
  /**
   * 通过率 = passed / (cases - skipped)。
   *
   * **跳过不计入分母**：跳过是"宿主没这个能力 / 成本闸门拦下"，不是质量信号，
   * 把它算进分母会让同一套场景在不同宿主上给出不同的通过率。
   * 全部跳过时记 0，并由 notes 提示"无有效执行样本"。
   */
  passRate: number
  /** 抖动率 = 有 rounds 且"有真有假"的 case / 有 rounds 的 case。 */
  flakyRate: number
  /** 平均耗时（毫秒，含跳过）。 */
  avgMs: number
  /** 耗时 P95（最近秩法，毫秒）。 */
  p95Ms: number
  modelCalls: number
  tokens: number
  /** —— 以下为额外的"样本量"字段，用来判断上面两个率的可信度 —— */
  /** 带 `rounds` 的 case 数（`repeat = 1` 时没有 rounds，抖动率就没有样本）。 */
  roundsSamples: number
  /** 带 `usage` 的 case 数（driver 不上报用量时为 0，tokens 不可信）。 */
  usageSamples: number
}

export interface TrendResult {
  dimension: TrendDimension
  /** 参与聚合的运行次数。 */
  runs: number
  /** 参与聚合的 case 条数。 */
  cases: number
  groups: TrendGroup[]
  /** 数据充分性提示（人读的结论前置说明）。 */
  notes: string[]
  /** 样本是否足以谈"趋势"（≥2 次运行且有 ≥1 个分组）。 */
  sufficient: boolean
}

const TREND_MIN_RUNS = 2
const GROUP_MIN_CASES = 5

/* --------------------------------------------------------------- 收集 -- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tryLoadRun(dir: string): { run?: LoadedRun; reason?: string } {
  const file = join(dir, 'run.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { reason: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { reason: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(raw)) return { reason: '顶层不是对象' }
  if (typeof raw.runId !== 'string' || raw.runId.trim() === '') return { reason: '缺 runId' }
  if (!Array.isArray(raw.cases)) return { reason: '缺 cases 数组' }

  const summary = {
    ...(raw as unknown as RunSummary),
    // 老产物可能缺这些字段：补成稳定默认值，避免聚合里到处判 undefined
    dshVersion: typeof raw.dshVersion === 'string' && raw.dshVersion !== '' ? raw.dshVersion : 'unknown',
    platform: typeof raw.platform === 'string' ? raw.platform : 'unknown',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    cases: raw.cases as CaseOutcome[],
  } satisfies RunSummary
  return { run: { dir, file, summary } }
}

/**
 * 收集 `<runsDir>/<runId>/run.json`。
 *
 * 坏产物进 `skipped`（带原因），不影响其余运行；`runsDir` 不存在时也走 `skipped`，
 * 而不是静默返回空——"目录写错"和"真的没有历史"必须能区分。
 */
export function collectRuns(runsDir: string, options: CollectRunsOptions = {}): CollectRunsResult {
  const out: CollectRunsResult = { runs: [], skipped: [] }
  const dir = String(runsDir ?? '')
  if (dir === '' || !existsSync(dir) || !statSync(dir).isDirectory()) {
    out.skipped.push({ dir, reason: '运行目录不存在或不是目录' })
    return out
  }

  const entries = readdirSync(dir)
    .filter((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() && existsSync(join(full, 'run.json'))
    })
    .sort()

  for (const name of entries) {
    const full = join(dir, name)
    const { run, reason } = tryLoadRun(full)
    if (run) out.runs.push(run)
    else out.skipped.push({ dir: full, reason: reason ?? '未知原因' })
  }

  out.runs.sort((a, b) => {
    const at = a.summary.startedAt === '' ? a.dir : a.summary.startedAt
    const bt = b.summary.startedAt === '' ? b.dir : b.summary.startedAt
    return at < bt ? 1 : at > bt ? -1 : 0
  })

  const limit = options.limit
  if (typeof limit === 'number' && Number.isFinite(limit) && limit >= 0) {
    out.runs = out.runs.slice(0, Math.floor(limit))
  }
  return out
}

/* --------------------------------------------------------------- 聚合 -- */

/** 最近秩法的 P95；空集返回 0。 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index]!
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** 百分比（1 位小数）；分母为 0 时返回 0 并由调用方在 notes 里说明"无样本"。 */
function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.round((numerator / denominator) * 1000) / 10
}

/** rounds = [true,false,...] 时"有真有假"才算抖动。 */
export function isFlaky(rounds: readonly boolean[] | undefined): boolean {
  if (!Array.isArray(rounds) || rounds.length <= 1) return false
  return rounds.some(Boolean) && rounds.some((item) => !item)
}

interface Bucket {
  key: string
  runs: Set<string>
  durations: number[]
  cases: CaseOutcome[]
  flaky: number
  roundsSamples: number
  usageSamples: number
  modelCalls: number
  tokens: number
}

function keysFor(
  run: LoadedRun,
  outcome: CaseOutcome,
  options: TrendOptions,
  tagStats: { provided: boolean; untagged: number },
): string[] {
  switch (options.dimension) {
    case 'kind':
      return [outcome.kind]
    case 'owner':
      return [outcome.owner === undefined || outcome.owner === '' ? '(无 owner)' : outcome.owner]
    case 'dshVersion':
      return [run.summary.dshVersion]
    case 'tag': {
      const tags = options.scenarioTags?.(outcome.id) ?? []
      const clean = tags.map((tag) => String(tag).trim()).filter((tag) => tag !== '')
      if (clean.length === 0) {
        tagStats.untagged += 1
        return ['(无 tag)']
      }
      return [...new Set(clean)]
    }
  }
}

function emptyBucket(key: string): Bucket {
  return {
    key,
    runs: new Set(),
    durations: [],
    cases: [],
    flaky: 0,
    roundsSamples: 0,
    usageSamples: 0,
    modelCalls: 0,
    tokens: 0,
  }
}

/** 按维度聚合趋势。 */
export function buildTrend(runs: readonly LoadedRun[], options: TrendOptions): TrendResult {
  const buckets = new Map<string, Bucket>()
  const tagStats = { provided: options.scenarioTags !== undefined, untagged: 0 }

  for (const run of runs) {
    for (const outcome of run.summary.cases ?? []) {
      for (const key of keysFor(run, outcome, options, tagStats)) {
        let bucket = buckets.get(key)
        if (!bucket) {
          bucket = emptyBucket(key)
          buckets.set(key, bucket)
        }
        bucket.runs.add(run.dir)
        bucket.cases.push(outcome)
        bucket.durations.push(typeof outcome.durationMs === 'number' ? outcome.durationMs : 0)
        if (Array.isArray(outcome.rounds)) {
          bucket.roundsSamples += 1
          if (isFlaky(outcome.rounds)) bucket.flaky += 1
        }
        if (outcome.usage) {
          bucket.usageSamples += 1
          bucket.modelCalls += Number(outcome.usage.modelCalls ?? 0)
          bucket.tokens += Number(outcome.usage.tokens ?? 0)
        }
      }
    }
  }

  const groups: TrendGroup[] = [...buckets.values()].map((bucket) => {
    const counts = { passed: 0, failed: 0, skipped: 0, errored: 0 }
    for (const outcome of bucket.cases) {
      if (outcome.verdict in counts) counts[outcome.verdict as keyof typeof counts] += 1
    }
    const executed = bucket.cases.length - counts.skipped
    const avg = bucket.durations.reduce((sum, value) => sum + value, 0) / (bucket.durations.length || 1)
    return {
      key: bucket.key,
      runs: bucket.runs.size,
      cases: bucket.cases.length,
      ...counts,
      passRate: percent(counts.passed, executed),
      flakyRate: percent(bucket.flaky, bucket.roundsSamples),
      avgMs: round1(avg),
      p95Ms: round1(percentile(bucket.durations, 95)),
      modelCalls: bucket.modelCalls,
      tokens: bucket.tokens,
      roundsSamples: bucket.roundsSamples,
      usageSamples: bucket.usageSamples,
    }
  })

  // 排序：样本多的在前（更有代表性），同数量按 key 升序保证可复现
  groups.sort((a, b) => (b.cases - a.cases) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))

  const notes: string[] = []
  if (options.dimension === 'tag') {
    if (!tagStats.provided) {
      notes.push('未提供 `scenarioTags`，全部 case 归入 `(无 tag)`——按 tag 看趋势需要调用方注入标签映射。')
    } else if (tagStats.untagged > 0) {
      notes.push(`${tagStats.untagged} 个 case 没有 tag，归入 \`(无 tag)\`（按 tag 选择器选不中它们）。`)
    }
  }
  const totalCases = groups.reduce((sum, group) => sum + group.cases, 0)
  if (runs.length < TREND_MIN_RUNS) {
    notes.push(
      `只有 ${runs.length} 次运行记录：**样本不足**，一次运行画不出趋势，别据此下结论。` +
        `至少需要 ${TREND_MIN_RUNS} 次可比运行。`,
    )
  }
  const thin = groups.filter((group) => group.cases < GROUP_MIN_CASES)
  if (thin.length > 0) {
    notes.push(
      `${thin.length} 个分组的场景数 < ${GROUP_MIN_CASES}（${thin.map((g) => `${g.key}:${g.cases}`).join('、')}）：` +
        `这类分组的比率波动大，别据此下结论。`,
    )
  }
  const noRounds = groups.filter((group) => group.roundsSamples === 0)
  if (noRounds.length > 0) {
    notes.push(
      `${noRounds.map((g) => g.key).join('、')} 的 case 全部没有 \`rounds\`（场景未声明 \`runtime.repeat > 1\`）：` +
        `flaky 率没有样本，显示 0 不代表"不抖动"。`,
    )
  }
  const noUsage = groups.filter((group) => group.modelCalls === 0 && group.usageSamples === 0)
  if (noUsage.length > 0) {
    notes.push(
      `${noUsage.map((g) => g.key).join('、')} 没有任何 driver 上报 \`usage\`：模型调用数与 tokens 不可信（不是 0，而是未知）。`,
    )
  }

  return {
    dimension: options.dimension,
    runs: runs.length,
    cases: totalCases,
    groups,
    notes,
    sufficient: runs.length >= TREND_MIN_RUNS && groups.length > 0,
  }
}

/* --------------------------------------------------------------- 渲染 -- */

/** 渲染成 Markdown 表 + 样本充分性说明。 */
export function renderTrend(trend: TrendResult): string {
  const lines: string[] = []
  lines.push(`## 趋势（按 ${trend.dimension} 分组）`)
  lines.push('')
  lines.push(`- 运行次数：${trend.runs} · case 样本：${trend.cases} · 分组：${trend.groups.length}`)
  lines.push(
    trend.sufficient
      ? '- 样本充分性：**可用于比较**（≥2 次运行，且每个分组都有样本量提示逐条列在下方）'
      : '- 样本充分性：**样本不足，别据此下结论**（见下方说明）',
  )

  if (trend.groups.length === 0) {
    lines.push('')
    lines.push('没有可聚合的 case（历史产物为空或全部被跳过）。')
  } else {
    lines.push('')
    lines.push('| 分组 | 运行数 | 场景数 | 通过 | 失败 | 跳过 | 错误 | 通过率 | flaky 率 | 平均耗时 | P95 | 模型调用 | tokens |')
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
    for (const group of trend.groups) {
      const flaky = group.roundsSamples > 0 ? `${group.flakyRate}%（${group.roundsSamples} 样本）` : '无样本'
      const usage = group.usageSamples > 0 ? String(group.tokens) : '未知'
      lines.push(
        `| ${group.key} | ${group.runs} | ${group.cases} | ${group.passed} | ${group.failed} | ` +
          `${group.skipped} | ${group.errored} | ${group.passRate}% | ${flaky} | ${group.avgMs}ms | ` +
          `${group.p95Ms}ms | ${group.usageSamples > 0 ? group.modelCalls : '未知'} | ${usage} |`,
      )
    }
    lines.push('')
    lines.push('> 通过率 = 通过 /（场景数 − 跳过）：跳过是宿主能力/成本闸门，不算质量信号。')
  }

  if (trend.notes.length > 0) {
    lines.push('')
    lines.push('### 样本与口径说明')
    for (const note of trend.notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}
