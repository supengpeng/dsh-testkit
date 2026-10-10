/**
 * 洞察类子命令：`trace` / `trend` / `coverage` / `search`。
 *
 * ## 为什么这四个要先**探测模块存在性**
 *
 * 它们背后分别是并行任务 T11（`src/trace/**`）与 T12（`src/insight/**`）的产物。
 * CLI 落地时那些模块可能还没进仓库——这时候正确的行为是
 * **明确报"该能力还没做"（退出码 3）**，而不是：
 *   · 抛一个 `Cannot find module` 的裸栈（用户以为 CLI 坏了）；
 *   · 或者更糟：输出一张空表（用户以为"真的没有数据"）。
 *
 * 探测用**变量说明符**的动态 `import()`：字面量会被 `tsc` 当成静态依赖，
 * 模块不存在时**编译期**就红——而那正是我们要避免的"因为别人还没做完，我就编不过"。
 */

import { CaseRegistry } from '../../cases/registry.js'
import { SCENARIO_KINDS, type CostClass, type Scenario } from '../../cases/types.js'
import type { RunSummary } from '../../runtime/runlog.js'
import { latestRunJson } from '../../surface/runs.js'
import { loadRunSummary } from '../../touchstone/index.js'
import { all, oneTrimmed, parseIntOption, type OptionSpec, type ParsedOptions } from '../args.js'
import {
  notReadyMessage,
  probeOptional,
  type CliContext,
  type OptionalCandidate,
  type OptionalProbe,
} from '../context.js'
import { EXIT, type ExitCode } from '../exit.js'
import { emitError, emitJson, line } from '../io.js'
import { isDirectory } from './run.js'

/** 动态调用探测到的模块函数（显式 `any`：适配边界，形状由对方模块定义）。 */
type LooseFn = (...args: any[]) => any

function looseFn(module: Record<string, unknown>, name: string): LooseFn {
  return module[name] as LooseFn
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

export const TRACE_OPTIONS: readonly OptionSpec[] = [
  { name: 'format', kind: 'value', placeholder: '<json|chrome|otel|timeline>', help: '输出格式（缺省 json）' },
  { name: 'run-id', kind: 'value', placeholder: '<id>', help: '指定运行记录（缺省取最近一次）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 信封输出（含 payload）' },
]

export const TREND_OPTIONS: readonly OptionSpec[] = [
  { name: 'dimension', kind: 'value', placeholder: '<kind|tag|owner|dshVersion>', help: '聚合维度（缺省 kind）' },
  { name: 'limit', kind: 'value', placeholder: '<n>', help: '最多读入多少次历史运行' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const COVERAGE_OPTIONS: readonly OptionSpec[] = [
  { name: 'cases', kind: 'value', placeholder: '<dir>', help: '场景目录（缺省 = 包内 cases/）' },
  { name: 'smoke-budget', kind: 'value', placeholder: '<ms>', help: 'smoke 集估算预算（毫秒）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const SEARCH_OPTIONS: readonly OptionSpec[] = [
  { name: 'kind', alias: 'k', kind: 'repeat', placeholder: '<k>', help: '限定 kind（可多次）' },
  { name: 'tag', alias: 't', kind: 'repeat', placeholder: '<t>', help: '限定标签（可多次）' },
  { name: 'owner', kind: 'value', placeholder: '<o>', help: '限定 owner' },
  { name: 'cost', kind: 'value', placeholder: '<class>', help: '限定成本档位（none / low / high）' },
  { name: 'status', kind: 'value', placeholder: '<s>', help: '限定状态（active / draft / retired）' },
  { name: 'cases', kind: 'value', placeholder: '<dir>', help: '场景目录（缺省 = 包内 cases/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

const TRACE_FORMATS = ['json', 'chrome', 'otel', 'timeline'] as const
type TraceFormat = (typeof TRACE_FORMATS)[number]

const TRACE_RENDERERS: Record<TraceFormat, string> = {
  json: 'renderTraceJson',
  chrome: 'renderChromeTrace',
  otel: 'renderOtelSpans',
  timeline: 'renderTimeline',
}

const TREND_DIMENSIONS = ['kind', 'tag', 'owner', 'dshVersion'] as const
const COST_CLASSES: readonly CostClass[] = ['none', 'low', 'high']

/** trace 模块的候选路径（T11）。 */
function traceCandidates(renderer: string): readonly OptionalCandidate[] {
  return [
    { specifier: '../trace/index.js', requires: [renderer], provider: 'T11（可观测性：trace 与三种导出）' },
    { specifier: '../trace/render.js', requires: [renderer], provider: 'T11（可观测性：trace 与三种导出）' },
    { specifier: '../trace/format.js', requires: [renderer], provider: 'T11（可观测性：trace 与三种导出）' },
  ]
}

/** insight 模块的候选路径（T12）。**没有 barrel**，所以按文件名优先。 */
function insightCandidates(file: string, requires: readonly string[]): readonly OptionalCandidate[] {
  return [
    { specifier: `../insight/${file}.js`, requires, provider: 'T12（趋势 / 覆盖矩阵 / 场景搜索）' },
    { specifier: '../insight/index.js', requires, provider: 'T12（趋势 / 覆盖矩阵 / 场景搜索）' },
  ]
}

/** 探测失败时的统一输出：既报"能力没做"，也报"模块坏了"的具体原因。 */
function reportProbeFailure(
  ctx: CliContext,
  command: string,
  candidates: readonly OptionalCandidate[],
  probe: OptionalProbe,
): ExitCode {
  const lines = [notReadyMessage(command, candidates)]
  if (probe.broken) {
    lines.push('', '探测详情（说明模块存在但形状不符，属于**真的坏了**）：')
    for (const problem of probe.problems) lines.push(`  · ${problem}`)
  }
  const message = lines.join('\n')
  if (ctx.json) {
    emitJson(ctx.io, {
      command,
      ok: false,
      exitCode: EXIT.INFRA,
      absent: probe.absent,
      broken: probe.broken,
      problems: probe.problems,
      error: message,
    })
  }
  emitError(ctx.io, message)
  return EXIT.INFRA
}

function usage(ctx: CliContext, command: string, message: string): ExitCode {
  if (ctx.json) emitJson(ctx.io, { command, ok: false, exitCode: EXIT.USAGE, error: message })
  emitError(ctx.io, message)
  return EXIT.USAGE
}

function infra(ctx: CliContext, command: string, message: string): ExitCode {
  if (ctx.json) emitJson(ctx.io, { command, ok: false, exitCode: EXIT.INFRA, error: message })
  emitError(ctx.io, message)
  return EXIT.INFRA
}

/** 载入要分析的运行记录（trace / trend 用）。 */
function loadSummary(
  ctx: CliContext,
  runId: string | undefined,
): { ok: true; summary: RunSummary; runId: string } | { ok: false; message: string } {
  const located = latestRunJson(ctx.dirs.runsDir, runId)
  if (!located.ok || located.path === undefined) {
    return {
      ok: false,
      message: `无法定位运行记录：${located.reason ?? '未知原因'}（目录：${ctx.dirs.runsDir}）`,
    }
  }
  try {
    return { ok: true, summary: loadRunSummary(located.path), runId: located.runId ?? runId ?? 'latest' }
  } catch (error) {
    return { ok: false, message: `读取运行记录失败：${describeError(error)}` }
  }
}

/** 载入场景（coverage / search 用；**不需要宿主**）。 */
function loadScenarios(ctx: CliContext): { ok: true; scenarios: readonly Scenario[] } | { ok: false; message: string } {
  if (!isDirectory(ctx.dirs.casesDir)) {
    return { ok: false, message: `场景目录不存在：${ctx.dirs.casesDir}（用 --cases <dir> 指定）` }
  }
  const registry = new CaseRegistry(ctx.dirs.casesDir)
  registry.reload()
  return { ok: true, scenarios: registry.all }
}

/* ----------------------------------------------------------------- trace -- */

export async function traceCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const formatRaw = oneTrimmed(parsed, 'format') ?? 'json'
  if (!(TRACE_FORMATS as readonly string[]).includes(formatRaw)) {
    return usage(ctx, 'trace', `--format 只接受 ${TRACE_FORMATS.join(' / ')}，收到 ${formatRaw}`)
  }
  const format = formatRaw as TraceFormat
  const renderer = TRACE_RENDERERS[format]
  const candidates = traceCandidates(renderer)

  const probe = await probeOptional(candidates)
  if (!probe.ok || probe.module === undefined) {
    return reportProbeFailure(ctx, 'trace', candidates, probe)
  }

  const loaded = loadSummary(ctx, oneTrimmed(parsed, 'run-id'))
  if (!loaded.ok) return usage(ctx, 'trace', loaded.message)

  try {
    const text = String(looseFn(probe.module, renderer)(loaded.summary))
    if (ctx.json) {
      // `--json` 的载荷优先解析成对象（chrome / otel / json 本来就是 JSON）；
      // 解析不了（例如 timeline 是纯文本）就原样给出。
      let payload: unknown = text
      try {
        payload = JSON.parse(text)
      } catch {
        /* 不是 JSON，保持文本 */
      }
      emitJson(ctx.io, {
        command: 'trace',
        ok: true,
        exitCode: EXIT.OK,
        runId: loaded.runId,
        format,
        module: probe.specifier,
        payload,
      })
      return EXIT.OK
    }
    ctx.io.out(line(text))
    return EXIT.OK
  } catch (error) {
    return infra(
      ctx,
      'trace',
      `调用 ${probe.specifier ?? 'trace 模块'} 的 ${renderer} 失败：${describeError(error)}` +
        '（该模块可能尚未定型；不是你的用法问题）',
    )
  }
}

/* ----------------------------------------------------------------- trend -- */

export async function trendCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const dimension = oneTrimmed(parsed, 'dimension') ?? 'kind'
  if (!(TREND_DIMENSIONS as readonly string[]).includes(dimension)) {
    return usage(ctx, 'trend', `--dimension 只接受 ${TREND_DIMENSIONS.join(' / ')}，收到 ${dimension}`)
  }
  const limitRaw = oneTrimmed(parsed, 'limit')
  let limit: number | undefined
  if (limitRaw !== undefined) {
    limit = parseIntOption(parsed, 'limit')
    if (limit === undefined || limit <= 0) {
      return usage(ctx, 'trend', `--limit 需要一个 > 0 的整数，收到 ${limitRaw}`)
    }
  }

  const candidates = insightCandidates('trend', ['collectRuns', 'buildTrend', 'renderTrend'])
  const probe = await probeOptional(candidates)
  if (!probe.ok || probe.module === undefined) {
    return reportProbeFailure(ctx, 'trend', candidates, probe)
  }

  try {
    const collected = looseFn(probe.module, 'collectRuns')(ctx.dirs.runsDir, {
      ...(limit === undefined ? {} : { limit }),
    })
    // `collectRuns` 可能返回数组，也可能返回 `{ runs, skipped }`——两种都认，
    // 但不猜它的字段名之外的东西。
    const runs: unknown = Array.isArray(collected)
      ? collected
      : ((collected as { runs?: unknown } | null)?.runs ?? [])
    const built = looseFn(probe.module, 'buildTrend')(runs, { dimension })
    const text = String(looseFn(probe.module, 'renderTrend')(built))
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'trend',
        ok: true,
        exitCode: EXIT.OK,
        dimension,
        runsDir: ctx.dirs.runsDir,
        module: probe.specifier,
        trend: built,
        text,
      })
      return EXIT.OK
    }
    ctx.io.out(line(text))
    return EXIT.OK
  } catch (error) {
    return infra(
      ctx,
      'trend',
      `调用 ${probe.specifier ?? 'insight 模块'} 失败：${describeError(error)}（该模块可能尚未定型）`,
    )
  }
}

/* -------------------------------------------------------------- coverage -- */

export async function coverageCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const smokeRaw = oneTrimmed(parsed, 'smoke-budget')
  let smokeMs: number | undefined
  if (smokeRaw !== undefined) {
    smokeMs = parseIntOption(parsed, 'smoke-budget')
    if (smokeMs === undefined || smokeMs <= 0) {
      return usage(ctx, 'coverage', `--smoke-budget 需要一个 > 0 的整数（毫秒），收到 ${smokeRaw}`)
    }
  }

  const candidates = insightCandidates('coverage', ['buildCoverage', 'renderCoverage'])
  const probe = await probeOptional(candidates)
  if (!probe.ok || probe.module === undefined) {
    return reportProbeFailure(ctx, 'coverage', candidates, probe)
  }

  const loaded = loadScenarios(ctx)
  if (!loaded.ok) return usage(ctx, 'coverage', loaded.message)

  try {
    const built = looseFn(probe.module, 'buildCoverage')(loaded.scenarios, {
      ...(smokeMs === undefined ? {} : { smokeMs }),
    })
    const text = String(looseFn(probe.module, 'renderCoverage')(built))
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'coverage',
        ok: true,
        exitCode: EXIT.OK,
        casesDir: ctx.dirs.casesDir,
        module: probe.specifier,
        coverage: built,
        text,
      })
      return EXIT.OK
    }
    ctx.io.out(line(text))
    return EXIT.OK
  } catch (error) {
    return infra(
      ctx,
      'coverage',
      `调用 ${probe.specifier ?? 'insight 模块'} 失败：${describeError(error)}（该模块可能尚未定型）`,
    )
  }
}

/* ---------------------------------------------------------------- search -- */

export async function searchCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const text = parsed.positionals.join(' ').trim()
  if (text === '') {
    return usage(ctx, 'search', '用法：dsh-testkit search <关键词> [--kind k] [--tag t] [--owner o] [--cost c]')
  }

  const kinds = all(parsed, 'kind')
  const badKinds = kinds.filter((kind) => !(SCENARIO_KINDS as readonly string[]).includes(kind))
  if (badKinds.length > 0) {
    return usage(ctx, 'search', `未知 kind：${badKinds.join(', ')}（可选：${SCENARIO_KINDS.join(', ')}）`)
  }
  const cost = oneTrimmed(parsed, 'cost')
  if (cost !== undefined && !(COST_CLASSES as readonly string[]).includes(cost)) {
    return usage(ctx, 'search', `--cost 只接受 ${COST_CLASSES.join(' / ')}，收到 ${cost}`)
  }

  const candidates = insightCandidates('search', ['searchScenarios', 'renderSearchResult'])
  const probe = await probeOptional(candidates)
  if (!probe.ok || probe.module === undefined) {
    return reportProbeFailure(ctx, 'search', candidates, probe)
  }

  const loaded = loadScenarios(ctx)
  if (!loaded.ok) return usage(ctx, 'search', loaded.message)

  const tags = all(parsed, 'tag')
  const owner = oneTrimmed(parsed, 'owner')
  const status = oneTrimmed(parsed, 'status')

  try {
    const built = looseFn(probe.module, 'searchScenarios')(loaded.scenarios, {
      text,
      ...(kinds.length === 0 ? {} : { kinds }),
      ...(tags.length === 0 ? {} : { tags }),
      ...(owner === undefined ? {} : { owner }),
      ...(cost === undefined ? {} : { cost }),
      ...(status === undefined ? {} : { status }),
    })
    const rendered = String(looseFn(probe.module, 'renderSearchResult')(built))
    const matched = (built as { matched?: unknown } | null)?.matched
    const count = Array.isArray(matched) ? matched.length : undefined
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'search',
        ok: true,
        exitCode: EXIT.OK,
        text,
        casesDir: ctx.dirs.casesDir,
        module: probe.specifier,
        count: count ?? null,
        result: built,
        rendered,
      })
      return EXIT.OK
    }
    ctx.io.out(line(rendered))
    return EXIT.OK
  } catch (error) {
    return infra(
      ctx,
      'search',
      `调用 ${probe.specifier ?? 'insight 模块'} 失败：${describeError(error)}（该模块可能尚未定型）`,
    )
  }
}

/** 供测试引用：某个洞察能力**当前**是否可用（探测一次，不抛错、不写输出）。 */
export async function insightAvailability(): Promise<Record<string, boolean>> {
  const [trace, trend, coverage, search] = await Promise.all([
    probeOptional(traceCandidates('renderTraceJson')),
    probeOptional(insightCandidates('trend', ['collectRuns', 'buildTrend', 'renderTrend'])),
    probeOptional(insightCandidates('coverage', ['buildCoverage', 'renderCoverage'])),
    probeOptional(insightCandidates('search', ['searchScenarios', 'renderSearchResult'])),
  ])
  return { trace: trace.ok, trend: trend.ok, coverage: coverage.ok, search: search.ok }
}
