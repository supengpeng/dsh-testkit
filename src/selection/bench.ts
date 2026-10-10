/**
 * 增量选择的**实测**基准：全量跑 vs 只跑命中场景。
 *
 * ## 为什么要把它做成产品代码而不是一次性脚本
 *
 * 「增量选择真的省时间吗」是这套机制唯一的卖点，而它随场景数、宿主能力、
 * 场景耗时分布变化。用一个可复现的函数量它，比在报告里写一个手工测出来的数字
 * 可信得多——别人可以随时重跑并对照。
 *
 * ## 口径
 *
 * · 两条轨都在**同一个批跑语义**下计时：headless 宿主 + CI 轨的成本闸门
 *   （`resolvePolicy({})`，`allowModel: false`），与 `export/scenarios.test.mjs` 一致；
 * · 宿主创建/销毁在计时之外，两条轨都承担同样的固定开销，比值才有意义；
 * · 默认对齐 CI 轨集合（active 且不带 `fixture` 标签）。
 */

import { CaseRegistry } from '../cases/registry.js'
import { resolvePolicy } from '../executor/policy.js'
import { createHeadlessHost } from '../headless/index.js'
import { createDriverRegistry } from '../kinds/index.js'
import { runScenarios } from '../runtime/runner.js'
import { changedFilesSince } from './git.js'
import { affectedScenarios } from './mapping.js'

export interface SelectionBenchOptions {
  casesDir: string
  /** 变更文件（通常来自 git）；与 `ref` 至少给一个。 */
  files?: readonly string[]
  /** 直接给 ref，内部调 `changedFilesSince`。 */
  ref?: string
  cwd?: string
  registryDir?: string
  fixturesDir?: string
  /** 对齐 CI 轨（active 且非 `fixture` 标签）；默认 true。 */
  ciTrack?: boolean
  defaultTimeoutMs?: number
}

export interface BenchRun {
  count: number
  ms: number
  passed: number
  skipped: number
  failed: number
  errored: number
}

export interface SelectionBenchResult {
  files: string[]
  filesSource: string
  selection: { matched: string[]; reason: string }
  full: BenchRun
  incremental: BenchRun
  /** `full.ms / incremental.ms`；incremental 未执行时为 Infinity。 */
  speedup: number
}

function round(ms: number): number {
  return Math.round(ms * 10) / 10
}

async function runBatch(
  registry: CaseRegistry,
  ids: readonly string[],
  defaultTimeoutMs: number,
): Promise<BenchRun> {
  if (ids.length === 0) {
    return { count: 0, ms: 0, passed: 0, skipped: 0, failed: 0, errored: 0 }
  }
  const headless = await createHeadlessHost()
  try {
    const t0 = performance.now()
    const summary = await runScenarios({
      registry,
      drivers: createDriverRegistry(),
      host: headless.host,
      filter: { ids: [...ids] },
      defaultTimeoutMs,
      policy: resolvePolicy({}),
    })
    const ms = performance.now() - t0
    return {
      count: summary.totals.total,
      ms: round(ms),
      passed: summary.totals.passed,
      skipped: summary.totals.skipped,
      failed: summary.totals.failed,
      errored: summary.totals.errored,
    }
  } finally {
    await headless.dispose()
  }
}

/** 量一次「全量 vs 增量」的耗时。 */
export async function benchmarkSelection(options: SelectionBenchOptions): Promise<SelectionBenchResult> {
  let files: string[]
  let filesSource: string
  if (options.files !== undefined) {
    files = options.files.map((f) => String(f))
    filesSource = '调用方给的变更文件列表'
  } else if (options.ref !== undefined) {
    const changed = changedFilesSince(options.ref, { cwd: options.cwd ?? process.cwd() })
    if (!changed.ok) throw new Error(`取变更文件失败：${changed.reason}`)
    files = changed.files
    filesSource = `git diff ${options.ref}`
  } else {
    throw new Error('benchmarkSelection 需要 files 或 ref 之一')
  }

  const registry = new CaseRegistry(options.casesDir)
  registry.reload()

  const ciTrack = options.ciTrack ?? true
  const base = registry.all.filter(
    (s) => (s.status ?? 'active') === 'active' && (!ciTrack || !(s.tags ?? []).includes('fixture')),
  )

  const selection = affectedScenarios(files, {
    scenarios: base,
    ...(options.registryDir === undefined ? {} : { registryDir: options.registryDir }),
    ...(options.fixturesDir === undefined ? {} : { fixturesDir: options.fixturesDir }),
  })
  const wanted = new Set(selection.matched)
  const incrementalIds = base.filter((s) => wanted.has(s.id)).map((s) => s.id)
  const fullIds = base.map((s) => s.id)

  const timeout = options.defaultTimeoutMs ?? 20_000
  const full = await runBatch(registry, fullIds, timeout)
  const incremental = await runBatch(registry, incrementalIds, timeout)

  return {
    files,
    filesSource,
    selection,
    full,
    incremental,
    speedup: incremental.ms > 0 ? Math.round((full.ms / incremental.ms) * 100) / 100 : Number.POSITIVE_INFINITY,
  }
}
