/**
 * touchstone 融合 · 阶段三（回环通道）
 * `POST /on_fix_complete` → 增量选择受影响场景 → **在 `git worktree` 临时目录里复跑** → 回传结果。
 *
 * ## 隔离是硬约束（不做这个，阶段三不能上线）
 *
 * 复跑**绝不能**污染场景库（主仓）：版本库里的修复可能带着 agent 中途写坏的临时文件，
 * 直接在主仓跑就会把现场改掉，于是"这条到底修没修好"再也没有可信答案。
 * 所以每次复跑：
 *
 *   ① `git worktree add --detach <scratch>/wt <ref>`（默认 `HEAD`）——干净检出
 *   ② 把主仓的 `node_modules` 以 **junction** 接进 worktree
 *      （Windows 用 `cmd /c mklink /J`；非 Windows 用 `symlinkSync`；失败就跳过并说明）
 *      —— 不在临时目录里重新装依赖（那要几分钟并且会引入版本漂移）
 *   ③ 用本仓的 **headless 宿主 + runner**（`lib/`）跑指定场景，`cwd` 指向 worktree，
 *      场景数据取 worktree 里的 `cases/`
 *   ④ **无论成败**都 `git worktree remove --force` + 清掉临时目录（`finally`）
 *
 * 主仓是否被污染由 `RerunResult.repoStatusBefore/After` 取证（`git status --porcelain`），
 * `tests/touchstone.test.mjs` 的阶段三端到端用例钉住"前后零新增"与"worktree 已清理"。
 *
 * ## 通道纪律
 *
 *   · **只监听 `127.0.0.1`**：这是本机通道，不对外
 *   · 未配置 `token` 时不鉴权——**但必须在响应里说明**（`auth.mode = 'none'` + 警告文案），
 *     免得有人以为它是安全的公网 webhook
 *   · 同步语义：请求会等到复跑结束才返回（本机单通道足够；调用方自己给超时）
 *   · **停止线**：webhook 调试超过 **1 周** → 回退手动触发（见 `docs/TOUCHSTONE.md`）
 *
 * ## 增量选择的软失败
 *
 * 受影响场景由 `src/selection/**` 算（T4 并行开发）。该模块**还没就绪**不是错误，
 * 而是退让条件：动态 import 失败 → **明确写出错误信息 + 退回全量**（绝不让服务崩）。
 * 显式点名（`caseIds`）永远优先于增量选择。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { CaseRegistry } from '../cases/registry.js'
import { toLibSpecifier } from '../export/node-test.js'
import type { RunTotals } from '../runtime/runlog.js'

/** 本仓唯一的路由名。 */
export const TOUCHSTONE_ROUTE = '/on_fix_complete'
/** 复跑脚本往 stdout 打的标记行前缀（结构化结果的唯一出口）。 */
export const RERUN_SCRIPT_MARKER = '__TOUCHSTONE_RERUN__'
const RERUN_SCRIPT_NAME = 'touchstone-rerun.mjs'
const MAX_BODY_BYTES = 1024 * 1024

/** touchstone 侧发来的请求体；`caseIds` 是本仓扩展（人工点名复跑）。 */
export interface FixCompletePayload {
  /** 本次修复改了哪些文件（增量选择的输入）。 */
  changedFiles?: string[]
  /** 要检出的 ref（分支 / tag / commit）；缺省 `HEAD`。 */
  ref?: string
  /** 结果回传地址；缺省不回传（结果仍在 HTTP 响应里）。 */
  callbackUrl?: string
  /** 本仓扩展：显式点名要复跑的场景（优先于增量选择）。 */
  caseIds?: string[]
}

export interface AffectedSelection {
  mode: 'explicit' | 'affected' | 'all'
  caseIds: string[]
  detail: string
  /** 非空即表示"这不是精确选择"的退让说明（例如增量选择模块不可用）。 */
  degraded?: string
}

export interface RerunCaseResult {
  id: string
  title: string
  kind: string
  verdict: string
  durationMs: number
  failureCategory?: string
  error?: string
  skipReason?: string
}

export interface RerunResult {
  runId: string
  /** worktree 临时目录（正斜杠无关，原样）；未创建时为 null。 */
  worktree: string | null
  /** 复跑结束后 worktree 是否已被清理（隔离硬约束的取证）。 */
  worktreeRemoved: boolean
  ref: string
  /** worktree 的 node_modules 接入方式。 */
  nodeModules: 'junction' | 'none' | 'failed'
  repoStatusBefore: string
  repoStatusAfter: string
  totals: RunTotals
  cases: RerunCaseResult[]
  notes: string[]
  durationMs: number
}

export interface RerunInput {
  repoDir: string
  casesDir?: string
  libDir?: string
  ref?: string
  caseIds: string[]
  /** 复跑总超时（毫秒）。 */
  timeoutMs?: number
  /** 场景级超时（毫秒）。 */
  perCaseTimeoutMs?: number
  /** 临时根目录；缺省 `os.tmpdir()`，被沙箱拦时退回 `<repoDir>/.touchstone-worktrees`。 */
  tempRoot?: string
  /** 是否把主仓 `node_modules` 接进 worktree（缺省 true）。 */
  linkNodeModules?: boolean
}

/* ----------------------------------------------------------- 增量选择 -- */

export interface SelectionInput {
  changedFiles: string[]
  repoDir: string
  casesDir: string
  /** 选择模块的说明符；缺省 `../selection/index.js`（相对本模块的编译产物）。 */
  specifier?: string
}

/**
 * 算受影响场景。
 *
 * 认 **两种** 形状（都不符合就**不猜**：写出原因并退回全量）：
 *
 *   ① 本仓约定：`selectAffected(input)`（或 `selectScenarios` / `selectByChangedFiles` / default），
 *      入参 `{ changedFiles, repoDir, casesDir }`，返回 `string[]` 或 `{ caseIds | ids | matched }`
 *   ② T4 已落地的形状：`affectedScenarios(files, { scenarios, registryDir, fixturesDir })`
 *      → `{ matched, reason }`（`src/selection/mapping.ts`）
 *
 * 选择模块**还没就绪不是错误**，而是退让条件：import 失败 → 明确写出错误信息 + 退回全量，
 * 绝不让服务崩（回环通道挂了比"选得不准"更糟）。
 */
export async function selectAffectedScenarios(input: SelectionInput): Promise<AffectedSelection> {
  const registry = new CaseRegistry(input.casesDir)
  registry.reload()
  const active = registry.filter({ status: ['active'] })
  const all = active.map((s) => s.id)
  const specifier = input.specifier ?? ['..', 'selection', 'index.js'].join('/')

  const fallback = (degraded: string): AffectedSelection => ({
    mode: 'all',
    caseIds: all,
    detail: `增量选择不可用 → 退回全量 ${all.length} 条`,
    degraded,
  })

  let mod: unknown
  try {
    mod = await import(/* @vite-ignore */ specifier)
  } catch (error) {
    return fallback(`增量选择模块 import 失败（${specifier}）：${messageOf(error)}`)
  }
  const table = mod as Record<string, unknown>

  // ① 本仓约定的直接入口
  const directNames = ['selectAffected', 'selectScenarios', 'selectByChangedFiles', 'default']
  const direct = directNames
    .map((n) => table[n])
    .find((v): v is (arg: unknown) => unknown => typeof v === 'function')
  if (direct !== undefined) {
    try {
      const raw = await direct({
        changedFiles: input.changedFiles,
        repoDir: input.repoDir,
        casesDir: input.casesDir,
      })
      return selectionFromRaw(raw, all, `按 changedFiles（${input.changedFiles.length} 个）`)
    } catch (error) {
      return fallback(`增量选择调用抛错（${specifier}）：${messageOf(error)}`)
    }
  }

  // ② T4 的 affectedScenarios(files, { scenarios, ... })
  const byFiles = table['affectedScenarios']
  if (typeof byFiles === 'function') {
    try {
      const raw = await (byFiles as (files: readonly string[], arg: unknown) => unknown)(
        input.changedFiles,
        {
          scenarios: active,
          registryDir: join(input.repoDir, 'registry'),
          fixturesDir: join(input.repoDir, '.fixtures'),
        },
      )
      return selectionFromRaw(raw, all, `按 changedFiles（${input.changedFiles.length} 个）`)
    } catch (error) {
      return fallback(`affectedScenarios 调用抛错（${specifier}）：${messageOf(error)}`)
    }
  }

  return fallback(
    `增量选择模块没有可调用的导出（找过 ${[...directNames, 'affectedScenarios'].join(' / ')}）：${specifier}`,
  )
}

function selectionFromRaw(raw: unknown, all: string[], prefix: string): AffectedSelection {
  const ids = coerceCaseIds(raw)
  if (ids === undefined) {
    return {
      mode: 'all',
      caseIds: all,
      detail: `增量选择结果形状无法识别 → 退回全量 ${all.length} 条`,
      degraded: `增量选择返回的形状无法识别（既不是 string[] 也不是 { caseIds|ids|matched }）：${preview(raw)}`,
    }
  }
  const reason = isRecord(raw) && typeof raw['reason'] === 'string' ? raw['reason'] : undefined
  const known = new Set(all)
  const filtered = ids.filter((id) => known.has(id))
  return {
    mode: 'affected',
    caseIds: filtered,
    detail: `${prefix}选中 ${filtered.length} 条${reason === undefined ? '' : `：${reason}`}`,
    ...(filtered.length === ids.length
      ? {}
      : { degraded: `选择模块给出 ${ids.length} 条，其中 ${ids.length - filtered.length} 条不在 active 场景里，已剔除` }),
  }
}

function coerceCaseIds(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) {
    const ids = raw
      .map((v) => (typeof v === 'string' ? v : isRecord(v) && typeof v['id'] === 'string' ? v['id'] : undefined))
      .filter((v): v is string => v !== undefined)
    return ids.length === raw.length ? ids : undefined
  }
  if (isRecord(raw)) {
    for (const key of ['caseIds', 'ids', 'matched']) {
      const value = raw[key]
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[]
    }
  }
  return undefined
}

/* ------------------------------------------------- 复跑脚本（纯函数） -- */

export interface RerunScriptOptions {
  libDir: string
  casesDir: string
  caseIds: string[]
  /** 生成文件所在目录（用于算 lib 的相对说明符）。 */
  outDir: string
  perCaseTimeoutMs?: number
  generatedAt?: string
  /** worktree 路径（写进脚本注释与响应里，便于事后定位现场）。 */
  worktree?: string
}

/**
 * 生成复跑脚本（纯函数）。
 *
 * 为什么不用 `node --test` 的 TAP 输出：那是给人看的、格式随 Node 版本漂移。
 * 这里用同一份 headless 宿主 + runner，直接打一行 JSON——
 * 解析只有一处，且升级 Node 不会让回环通道偷偷失效。
 */
export function generateRerunScript(options: RerunScriptOptions): string {
  const lib = toLibSpecifier(options.outDir, options.libDir)
  if (lib.includes(':')) {
    throw new Error(
      `复跑需要 worktree 与主仓 lib/ 在同一盘符下（相对 import 说明符算成了 ${lib}）。` +
        `请把 tempRoot 指到同一盘符，或改用包内临时目录。`,
    )
  }
  const perCase = options.perCaseTimeoutMs ?? 30_000
  const generatedAt = options.generatedAt ?? new Date().toISOString()

  return `/**
 * 由 dsh-testkit 的 touchstone 回环通道自动生成 —— 请勿手改。
 *
 * 生成时间：${generatedAt}
 * worktree：${options.worktree ?? '(未记录)'}
 * 场景目录：${options.casesDir}
 * 指定场景：${options.caseIds.join(', ') || '(空)'}
 *
 * 这条路**不烧钱**：显式带默认闸门 resolvePolicy({})（allowModel=false）。
 */

import { writeSync } from 'node:fs'
import { CaseRegistry } from ${JSON.stringify(`${lib}cases/registry.js`)}
import { resolvePolicy } from ${JSON.stringify(`${lib}executor/policy.js`)}
import { createHeadlessHost } from ${JSON.stringify(`${lib}headless/index.js`)}
import { createDriverRegistry } from ${JSON.stringify(`${lib}kinds/index.js`)}
import { runScenarios } from ${JSON.stringify(`${lib}runtime/runner.js`)}

const MARKER = ${JSON.stringify(RERUN_SCRIPT_MARKER)}
const CASES_DIR = ${JSON.stringify(options.casesDir)}
const IDS = ${JSON.stringify(options.caseIds)}

async function main() {
  const registry = new CaseRegistry(CASES_DIR)
  registry.reload()
  const drivers = createDriverRegistry()
  const headless = await createHeadlessHost()
  try {
    const summary = await runScenarios({
      registry,
      drivers,
      host: headless.host,
      filter: { ids: IDS },
      defaultTimeoutMs: ${perCase},
      policy: resolvePolicy({}),
    })
    return {
      ok: true,
      runId: summary.runId,
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      totals: summary.totals,
      cases: summary.cases.map((c) => ({
        id: c.id,
        title: c.title,
        kind: c.kind,
        verdict: c.verdict,
        durationMs: c.durationMs,
        ...(c.failureCategory === undefined ? {} : { failureCategory: c.failureCategory }),
        ...(c.error === undefined ? {} : { error: c.error }),
        ...(c.skipReason === undefined ? {} : { skipReason: c.skipReason }),
      })),
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    await headless.dispose()
  }
}

const payload = await main()
writeSync(1, '\\n' + MARKER + JSON.stringify(payload) + '\\n')
if (payload.ok !== true) process.exitCode = 1
`
}

/** 从复跑脚本的 stdout 里取结构化结果；取不到返回 undefined。 */
export function parseRerunPayload(stdout: string): unknown {
  const index = stdout.lastIndexOf(RERUN_SCRIPT_MARKER)
  if (index < 0) return undefined
  const text = stdout.slice(index + RERUN_SCRIPT_MARKER.length).trim()
  const firstLine = text.split('\n')[0] ?? ''
  try {
    return JSON.parse(firstLine)
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------- worktree 复跑 -- */

/** 在 `git worktree` 隔离目录里复跑指定场景（真实实现；可被注入替身覆盖）。 */
export async function runInWorktree(input: RerunInput): Promise<RerunResult> {
  const started = Date.now()
  const repoDir = resolve(input.repoDir)
  const casesDir = resolve(input.casesDir ?? join(repoDir, 'cases'))
  const libDir = resolve(input.libDir ?? join(repoDir, 'lib'))
  const ref = input.ref ?? 'HEAD'
  const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000
  const notes: string[] = []
  const ownRoots: string[] = []
  const statusBefore = await gitStatusPorcelain(repoDir)

  let worktree: string | null = null
  let worktreeRemoved = true
  let nodeModules: RerunResult['nodeModules'] = 'none'
  let payload: RerunPayload | undefined

  if (input.caseIds.length === 0) {
    notes.push('没有受影响场景：**未创建 worktree**（空跑不算通过，见 notes）')
    return {
      runId: `rerun-${Date.now()}`,
      worktree: null,
      worktreeRemoved: true,
      ref,
      nodeModules: 'none',
      repoStatusBefore: statusBefore,
      repoStatusAfter: await gitStatusPorcelain(repoDir),
      totals: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
      cases: [],
      notes,
      durationMs: Date.now() - started,
    }
  }

  try {
    const scratch = makeScratchDir(repoDir, input.tempRoot, notes, ownRoots)
    worktree = join(scratch, 'wt')

    const add = await runCommand('git', ['-C', repoDir, 'worktree', 'add', '--detach', worktree, ref], {
      timeoutMs: 120_000,
    })
    if (add.code !== 0) {
      throw new Error(
        `git worktree add 失败（ref=${ref}）：${(add.stderr || add.stdout).trim() || `退出码 ${add.code}`}`,
      )
    }
    notes.push(`已在隔离 worktree 检出 ${ref}：${worktree}`)

    if (input.linkNodeModules !== false) {
      const linked = await linkNodeModules(repoDir, worktree, notes)
      nodeModules = linked
    } else {
      notes.push('按调用方要求未接入 node_modules（依赖解析仍会走主仓 lib/ 上游）')
    }

    const scriptDir = join(scratch, 'rerun')
    mkdirSync(scriptDir, { recursive: true })
    const scriptPath = join(scriptDir, RERUN_SCRIPT_NAME)
    writeFileSync(
      scriptPath,
      generateRerunScript({
        libDir,
        casesDir: join(worktree, 'cases'),
        caseIds: input.caseIds,
        outDir: scriptDir,
        ...(input.perCaseTimeoutMs === undefined ? {} : { perCaseTimeoutMs: input.perCaseTimeoutMs }),
        worktree,
      }),
      'utf8',
    )

    const run = await runCommand(process.execPath, [scriptPath], { cwd: worktree, timeoutMs })
    const parsed = parseRerunPayload(run.stdout)
    if (parsed === undefined) {
      const tail = `${run.stdout}\n${run.stderr}`.trim().slice(-1500)
      throw new Error(`复跑脚本没有产出结构化结果（退出码 ${run.code}）：\n${tail}`)
    }
    payload = parsed as RerunPayload
    if (payload.ok !== true) throw new Error(`复跑脚本内部失败：${payload.error ?? '(未给出原因)'}`)
    notes.push(`复跑完成：${payload.totals?.total ?? 0} 条（cwd=${worktree}）`)
  } finally {
    // 无论成败都要拆干净——这是隔离硬约束的落点。
    if (worktree !== null) {
      const remove = await runCommand('git', ['-C', repoDir, 'worktree', 'remove', '--force', worktree], {
        timeoutMs: 120_000,
      })
      if (remove.code !== 0) {
        notes.push(`git worktree remove 失败（退出码 ${remove.code}）：${(remove.stderr || remove.stdout).trim()}`)
        await runCommand('git', ['-C', repoDir, 'worktree', 'prune'], { timeoutMs: 60_000 })
      }
    }
    for (const path of [...ownRoots].reverse()) {
      try {
        rmSync(path, { recursive: true, force: true })
      } catch (error) {
        notes.push(`临时目录清理失败 ${path}：${messageOf(error)}`)
      }
    }
    worktreeRemoved = worktree === null || !existsSync(worktree)
    if (!worktreeRemoved) notes.push(`⚠️ worktree 仍残留：${worktree}`)
  }

  const totals = payload?.totals ?? { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 }
  return {
    runId: payload?.runId ?? `rerun-${Date.now()}`,
    worktree,
    worktreeRemoved,
    ref,
    nodeModules,
    repoStatusBefore: statusBefore,
    repoStatusAfter: await gitStatusPorcelain(repoDir),
    totals,
    cases: payload?.cases ?? [],
    notes,
    durationMs: Date.now() - started,
  }
}

interface RerunPayload {
  ok?: boolean
  error?: string
  runId?: string
  totals?: RunTotals
  cases?: RerunCaseResult[]
}

/**
 * 复跑用的临时 scratch 目录（它的子目录 `wt` 才是 worktree）。
 *
 * 优先 `os.tmpdir()`；宿主沙箱拦 workspace 外写入（Access denied）时**退回包内**目录。
 * 退回目录会被清掉（`ownRoots`），所以它不会留在 `git status` 里——
 * 这正是不直接往主仓写临时文件的原因。
 */
function makeScratchDir(
  repoDir: string,
  preferred: string | undefined,
  notes: string[],
  ownRoots: string[],
): string {
  const fallback = join(repoDir, '.touchstone-worktrees')
  const roots = preferred !== undefined ? [preferred] : [tmpdir(), fallback]
  const errors: string[] = []
  for (const root of roots) {
    try {
      const created = root === fallback && !existsSync(root)
      mkdirSync(root, { recursive: true })
      const scratch = mkdtempSync(join(root, 'tk-'))
      if (created) ownRoots.push(root)
      if (root === fallback) notes.push(`os.tmpdir() 不可写（${errors.join('；')}），已退回包内临时目录 ${root}`)
      ownRoots.push(scratch)
      return scratch
    } catch (error) {
      errors.push(`${root}: ${messageOf(error)}`)
    }
  }
  throw new Error(`无法创建复跑临时目录：${errors.join(' | ')}`)
}

async function linkNodeModules(
  repoDir: string,
  worktree: string,
  notes: string[],
): Promise<RerunResult['nodeModules']> {
  const source = join(repoDir, 'node_modules')
  if (!existsSync(source)) {
    notes.push('主仓没有 node_modules：跳过接入（依赖解析走主仓 lib/ 上游）')
    return 'none'
  }
  const target = join(worktree, 'node_modules')
  try {
    if (process.platform === 'win32') {
      // junction 不需要管理员权限（symlink 才需要），所以 Windows 上优先它。
      const result = await runCommand('cmd', ['/c', 'mklink', '/J', target, source], { timeoutMs: 60_000 })
      if (result.code === 0 && existsSync(target)) return 'junction'
      notes.push(
        `node_modules junction 失败（mklink /J 退出码 ${result.code}）：` +
          `${(result.stderr || result.stdout).trim()} → 跳过接入（不影响主仓）`,
      )
      return 'failed'
    }
    symlinkSync(source, target, 'dir')
    return 'junction'
  } catch (error) {
    notes.push(`node_modules 接入失败：${messageOf(error)} → 跳过接入（不影响主仓）`)
    return 'failed'
  }
}

export async function gitStatusPorcelain(repoDir: string): Promise<string> {
  const result = await runCommand('git', ['-C', repoDir, 'status', '--porcelain'], { timeoutMs: 60_000 })
  if (result.code !== 0) return `(git status 失败，退出码 ${result.code})`
  return result.stdout.replace(/\r\n/g, '\n').trimEnd()
}

/* ------------------------------------------------------------- HTTP -- */

export interface FixCompleteEvent {
  payload: FixCompletePayload
  selection: AffectedSelection | null
  result: RerunResult | null
  error?: string
}

export interface OnFixComplete {
  (event: FixCompleteEvent): void | Promise<void>
}

export interface WebhookOptions {
  /** 监听端口；`0` 表示由系统分配（测试用）。 */
  port: number
  /** 共享 token；不给则**不鉴权**（响应里会写明这是本机通道）。 */
  token?: string
  /** 复跑结束（或失败）后的回调，便于宿主记日志 / 决定重入。 */
  onFixComplete?: OnFixComplete
  /** 主仓根；缺省 `process.cwd()`。 */
  repoDir?: string
  /** 场景目录；缺省 `<repoDir>/cases`。 */
  casesDir?: string
  /** 本包 `lib/` 目录；缺省 `<repoDir>/lib`。 */
  libDir?: string
  /** 复跑总超时（毫秒）。 */
  rerunTimeoutMs?: number
  /** 结果回传超时（毫秒）。 */
  callbackTimeoutMs?: number
  /** 注入选择器（缺省走 {@link selectAffectedScenarios}）。 */
  selectAffected?: (payload: FixCompletePayload) => AffectedSelection | Promise<AffectedSelection>
  /** 注入复跑实现（缺省 {@link runInWorktree}）。 */
  rerun?: (input: RerunInput) => Promise<RerunResult>
}

export interface WebhookHandle {
  url: string
  port: number
  close(): Promise<void>
}

/** 起一个只监听 `127.0.0.1` 的回环通道。 */
export async function startWebhook(options: WebhookOptions): Promise<WebhookHandle> {
  const repoDir = resolve(options.repoDir ?? process.cwd())
  const casesDir = resolve(options.casesDir ?? join(repoDir, 'cases'))
  const libDir = resolve(options.libDir ?? join(repoDir, 'lib'))
  const callbackTimeoutMs = options.callbackTimeoutMs ?? 30_000
  const token = options.token

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((error) => {
      sendJson(res, 500, { ok: false, code: 'handler-failed', message: messageOf(error) })
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once('error', onError)
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolveListen()
    })
  })

  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : options.port

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0] ?? ''
    if (path !== TOUCHSTONE_ROUTE) {
      sendJson(res, 404, { ok: false, code: 'not-found', message: `只有 ${TOUCHSTONE_ROUTE}` })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'use POST' })
      return
    }
    if (token !== undefined && !isAuthorized(req, token)) {
      sendJson(res, 401, {
        ok: false,
        code: 'unauthorized',
        message: '缺少或错误的 token（Authorization: Bearer <token> 或 x-touchstone-token）',
      })
      return
    }

    let payload: FixCompletePayload
    try {
      payload = normalizePayload(await readBody(req))
    } catch (error) {
      sendJson(res, 400, { ok: false, code: 'bad-json', message: messageOf(error) })
      return
    }

    const auth: WebhookAuthInfo =
      token === undefined
        ? {
            mode: 'none',
            warning:
              '未配置 token：本通道不做鉴权。它只监听 127.0.0.1（本机），不要把这个端口暴露到公网。',
          }
        : { mode: 'token' }

    let selection: AffectedSelection | null = null
    let result: RerunResult | null = null
    let failure: string | undefined
    try {
      selection = await resolveSelection(payload)
      const rerun = options.rerun ?? runInWorktree
      result = await rerun({
        repoDir,
        casesDir,
        libDir,
        ...(payload.ref === undefined ? {} : { ref: payload.ref }),
        caseIds: selection.caseIds,
        ...(options.rerunTimeoutMs === undefined ? {} : { timeoutMs: options.rerunTimeoutMs }),
      })
    } catch (error) {
      failure = messageOf(error)
    }

    const callback: CallbackOutcome = { sent: false }
    if (typeof payload.callbackUrl === 'string' && payload.callbackUrl.trim() !== '') {
      const posted = await postJson(
        payload.callbackUrl,
        {
          ok: failure === undefined,
          selection,
          error: failure ?? null,
          runId: result?.runId ?? null,
          totals: result?.totals ?? null,
          cases: result?.cases ?? [],
          repoStatusBefore: result?.repoStatusBefore ?? null,
          repoStatusAfter: result?.repoStatusAfter ?? null,
          worktreeRemoved: result?.worktreeRemoved ?? null,
        },
        callbackTimeoutMs,
      )
      callback.sent = posted.ok
      if (posted.status !== undefined) callback.status = posted.status
      if (posted.error !== undefined) callback.error = posted.error
    }

    await options.onFixComplete?.({ payload, selection, result, ...(failure === undefined ? {} : { error: failure }) })

    if (failure !== undefined) {
      sendJson(res, 500, { ok: false, code: 'rerun-failed', message: failure })
      return
    }
    sendJson(res, 200, {
      ok: true,
      value: { accepted: true, auth, selection, rerun: result, callback },
    })
  }

  async function resolveSelection(payload: FixCompletePayload): Promise<AffectedSelection> {
    const explicit = payload.caseIds?.filter((id) => typeof id === 'string' && id.trim() !== '')
    if (explicit !== undefined && explicit.length > 0) {
      return { mode: 'explicit', caseIds: explicit, detail: `显式点名 ${explicit.length} 条（跳过增量选择）` }
    }
    if (options.selectAffected !== undefined) return options.selectAffected(payload)
    return selectAffectedScenarios({
      changedFiles: payload.changedFiles ?? [],
      repoDir,
      casesDir,
    })
  }

  return {
    url: `http://127.0.0.1:${port}${TOUCHSTONE_ROUTE}`,
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.close(() => resolveClose())
      }),
  }
}

interface WebhookAuthInfo {
  mode: 'token' | 'none'
  warning?: string
}

interface CallbackOutcome {
  sent: boolean
  status?: number
  error?: string
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.byteLength
    if (total > MAX_BODY_BYTES) throw new Error(`请求体过大（> ${MAX_BODY_BYTES} 字节）`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function normalizePayload(raw: string): FixCompletePayload {
  if (raw.trim() === '') return {}
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('请求体必须是一个 JSON 对象')
  }
  const record = parsed as Record<string, unknown>
  const out: FixCompletePayload = {}
  if (Array.isArray(record['changedFiles'])) {
    out.changedFiles = record['changedFiles'].filter((v): v is string => typeof v === 'string')
  }
  if (typeof record['ref'] === 'string') out.ref = record['ref']
  if (typeof record['callbackUrl'] === 'string') out.callbackUrl = record['callbackUrl']
  if (Array.isArray(record['caseIds'])) {
    out.caseIds = record['caseIds'].filter((v): v is string => typeof v === 'string')
  }
  return out
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization']
  const value = Array.isArray(header) ? header[0] : header
  const bearer = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7).trim() : undefined
  const alt = req.headers['x-touchstone-token']
  const provided = bearer ?? (typeof alt === 'string' ? alt.trim() : undefined)
  return provided !== undefined && provided === token
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(body)
}

interface PostResult {
  ok: boolean
  status?: number
  error?: string
}

/** 把结果 POST 回 `callbackUrl`（只用 `node:http` / `node:https`）。 */
async function postJson(url: string, body: unknown, timeoutMs: number): Promise<PostResult> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { ok: false, error: `callbackUrl 不是合法 URL：${url}` }
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, error: `callbackUrl 只支持 http/https：${target.protocol}` }
  }
  const mod = target.protocol === 'https:' ? await import('node:https') : await import('node:http')
  const payload = Buffer.from(JSON.stringify(body), 'utf8')

  return new Promise<PostResult>((resolvePost) => {
    let settled = false
    const done = (value: PostResult): void => {
      if (settled) return
      settled = true
      resolvePost(value)
    }
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port === '' ? undefined : Number(target.port),
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.byteLength },
      },
      (res) => {
        res.resume()
        const status = res.statusCode ?? 0
        done({ ok: status >= 200 && status < 300, status, ...(status >= 300 ? { error: `callback 返回 ${status}` } : {}) })
      },
    )
    req.on('error', (error) => done({ ok: false, error: messageOf(error) }))
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`callback 超时（${timeoutMs}ms）`))
    })
    req.write(payload)
    req.end()
  })
}

/* ------------------------------------------------------------ 小工具 -- */

interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolveRun) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      windowsHide: true,
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true
            child.kill()
          }, options.timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer)
      resolveRun({ code: -1, stdout, stderr: `${stderr}${messageOf(error)}` })
    })
    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer)
      resolveRun({
        code: code ?? -1,
        stdout,
        stderr: timedOut ? `${stderr}\n（超时 ${options.timeoutMs}ms，已终止）` : stderr,
      })
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function preview(value: unknown): string {
  try {
    return JSON.stringify(value)?.slice(0, 200) ?? String(value)
  } catch {
    return String(value)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
