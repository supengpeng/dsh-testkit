/**
 * 运行产物目录的扫描：报告目录里有多少次运行、最近一次的 totals 是多少。
 *
 * 纯读、不抛：体检不该因为一个坏掉的历史 run.json 就整份失败——
 * 读不出来的如实写进 `notes`，让读者自己判断。
 *
 * runId 形如 `2026-10-09T16-20-58_06mp`（ISO 派生 + 随机后缀），
 * 所以**按目录名字典序**排序就等于按时间排序；同一秒的两次运行靠后缀定序，
 * 这对"最近一次"的用途足够（不追求跨机器时钟一致）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { RunTotals } from '../runtime/runlog.js'
import type { DoctorLatestRun, DoctorRunsSection } from './types.js'

/** 最多回溯读多少个历史 run.json（坏件不该让体检扫描无上限）。 */
const MAX_SCAN = 50

export function scanRuns(runsDir: string): DoctorRunsSection {
  const notes: string[] = []

  if (!existsSync(runsDir)) {
    return { dir: runsDir, exists: false, runCount: 0, notes: [`报告目录不存在：${runsDir}`] }
  }

  let dirNames: string[]
  try {
    dirNames = readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch (error) {
    return {
      dir: runsDir,
      exists: true,
      runCount: 0,
      notes: [`报告目录读不了：${describeError(error)}`],
    }
  }

  // 从最新往回扫：最近一次要在**前几个**坏件之后仍然能找到
  const candidates = dirNames.slice(-MAX_SCAN).reverse()
  let runCount = 0
  let latest: DoctorLatestRun | undefined

  for (const name of candidates) {
    const file = join(runsDir, name, 'run.json')
    if (!existsSync(file)) continue
    runCount += 1
    if (latest !== undefined) continue

    const parsed = readRunJson(file)
    if (parsed === undefined) {
      notes.push(`最近一次运行 ${name} 的 run.json 读不出来（跳过，继续往前找）`)
      continue
    }
    latest = {
      runId: typeof parsed.runId === 'string' && parsed.runId !== '' ? parsed.runId : name,
      ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt } : {}),
      ...(typeof parsed.finishedAt === 'string' ? { finishedAt: parsed.finishedAt } : {}),
      totals: parsed.totals,
      reportPath: file,
    }
  }

  if (latest === undefined && runCount === 0) notes.push('报告目录里没有任何 run.json')

  return {
    dir: runsDir,
    exists: true,
    runCount,
    ...(latest === undefined ? {} : { latest }),
    notes,
  }
}

interface ParsedRun {
  runId?: unknown
  startedAt?: unknown
  finishedAt?: unknown
  totals: RunTotals
}

function readRunJson(file: string): ParsedRun | undefined {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const totals = normalizeTotals(raw?.totals)
    if (totals === undefined) return undefined
    return {
      runId: raw?.runId,
      startedAt: raw?.startedAt,
      finishedAt: raw?.finishedAt,
      totals,
    }
  } catch {
    return undefined
  }
}

/** 只认五个必填计数都是数字的 totals；缺字段宁可当"读不出来"。 */
function normalizeTotals(raw: unknown): RunTotals | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const keys = ['total', 'passed', 'failed', 'skipped', 'errored'] as const
  if (!keys.every((key) => typeof record[key] === 'number')) return undefined
  return {
    total: record.total as number,
    passed: record.passed as number,
    failed: record.failed as number,
    skipped: record.skipped as number,
    errored: record.errored as number,
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** 目录是否存在（渲染时用来区分"空"与"没有"）。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
