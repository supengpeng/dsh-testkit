/**
 * 异步残留探针（第 7.3 / 7.4 节）。
 *
 * ## 与同步 `detectLeftovers` 的关系
 *
 * `leaks.ts` 的 `detectLeftovers` 是**同步**的，缺省只真检测 tmpdir：
 * Node 没有同步的"端口是否被占"API，同步 API 里也调不了 `tasklist` / `ps`。
 * 这一份补上那两类，形状刻意保持一致（同一个 `CleanupRecord`、
 * 同一套 `tmpdir:` / `port:` / `proc:` 前缀），但**不替代**它：
 * runner 的每步善后仍然调同步版（快、无 IO），体检与大扫除用这一份。
 *
 * ## 三条诚实纪律
 *
 *   ① **探不到 ≠ 干净**：端口可能因权限 / IPv6 双栈 / 超时而探不出来，
 *      这种情况写 `busy: 'unknown'`，合成进 `leftovers` 时用 `unknown:` 前缀。
 *      谁要把 `unknown` 当 false 用，谁就在制造假阴性。
 *   ② **命令不可用要说出来**：`probeProcesses` 在 `ps` / `tasklist` 缺失时
 *      返回 `available: false` + `detail`，而不是"没找到进程"（那是另一种结论）。
 *   ③ **探测范围写清楚**：端口只探 `127.0.0.1`（IPv4 回环）——被测对象都是本机起的
 *      测试服务；只绑在别的网卡上的占用探不到，这属于已知边界，不是实现了的保证。
 */

import { spawnSync } from 'node:child_process'
import { createServer } from 'node:net'

import type { CleanupRecord } from '../runtime/runlog.js'
import type { IsolationContext } from './context.js'
import { detectLeftovers } from './leaks.js'

/** 单个端口的探测结果。 */
export interface PortProbeResult {
  port: number
  /** `true` = 被占用；`false` = 空闲；`'unknown'` = **探不到**（不等于干净）。 */
  busy: boolean | 'unknown'
  /** 判定的依据（`EADDRINUSE` / 错误码 / 超时），`unknown` 时必给。 */
  detail?: string
}

export interface PortProbeOptions {
  /** 绑定的本地地址；缺省 `127.0.0.1`（见文件头注的探测范围）。 */
  host?: string
  /** 单端口探测超时（毫秒），缺省 2000。 */
  timeoutMs?: number
}

/** 进程探测的结果：名字 + **命令到底能不能用**。 */
export interface ProcessProbeResult {
  /** 命中 patterns 的进程名（去重、排序，最多 50 条）。 */
  names: string[]
  /** 探测命令是否真的执行成功。`false` 时看 `detail`，不要读成"没有孤儿进程"。 */
  available: boolean
  /** 失败 / 未探测的说明（命令缺失、退出码、超时……）。 */
  detail?: string
  /** 实际使用的命令（便于复现）。 */
  command?: string
}

/** `probeProcesses` 解析哪种输出。 */
export type ProcessFormat = 'tasklist' | 'ps-lines'

/** 一次命令执行的结果（注入 `run` 时用它，避免真的起进程）。 */
export interface CommandRunResult {
  status: number | null
  stdout: string
  stderr?: string
  error?: { code?: string; message: string }
}

export type CommandRunner = (command: string, args: readonly string[]) => CommandRunResult

export interface ProcessProbeOptions {
  /** 输出格式；缺省按平台选（Windows → tasklist，其它 → ps）。 */
  format?: ProcessFormat
  /** 覆盖命令名（单测用来造"命令不可用"）。 */
  command?: string
  /** 覆盖命令参数。 */
  args?: readonly string[]
  /** 超时（毫秒），缺省 2000。 */
  timeoutMs?: number
  /** 注入的执行器；缺省用 `spawnSync`。 */
  run?: CommandRunner
}

const DEFAULT_TIMEOUT_MS = 2000
/** 进程名最多回这么多条（`ps -eo comm=` 在繁忙机器上会很长）。 */
const MAX_PROCESS_NAMES = 50

/* ------------------------------------------------------------------ 端口 -- */

/** 探测一批端口；顺序与入参一致。 */
export async function probePorts(
  ports: readonly number[],
  options: PortProbeOptions = {},
): Promise<PortProbeResult[]> {
  const out: PortProbeResult[] = []
  for (const port of ports) out.push(await probePort(port, options))
  return out
}

/**
 * 探测单个端口是否被占用。
 *
 * 判定方式是**自己 listen 一次**：绑得上说明空闲，`EADDRINUSE` 说明被占。
 * 其余错误（`EACCES` 权限、`EADDRNOTAVAIL`、超时）一律 `'unknown'`——
 * 把它们当成"空闲"正是假阴性的来源。
 */
export async function probePort(
  port: number,
  options: PortProbeOptions = {},
): Promise<PortProbeResult> {
  const host = options.host ?? '127.0.0.1'
  const timeoutMs = normalizeTimeout(options.timeoutMs)

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { port, busy: 'unknown', detail: `端口号非法：${String(port)}` }
  }

  return new Promise<PortProbeResult>((resolve) => {
    const server = createServer()
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: PortProbeResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      server.removeAllListeners()
      // 只有真的在 listen 才需要关；否则 close() 会报 ERR_SERVER_NOT_RUNNING
      if (server.listening) {
        try {
          server.close()
        } catch {
          /* 关闭失败不影响探测结论 */
        }
      }
      resolve(result)
    }

    timer = setTimeout(() => {
      finish({ port, busy: 'unknown', detail: `探测超时（> ${timeoutMs}ms）` })
    }, timeoutMs)

    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        finish({ port, busy: true, detail: 'EADDRINUSE（已被占用）' })
        return
      }
      finish({ port, busy: 'unknown', detail: `${error.code ?? error.name}: ${error.message}` })
    })

    try {
      server.listen({ port, host, exclusive: true }, () => {
        finish({ port, busy: false })
      })
    } catch (error) {
      // listen 可能**同步**抛（端口越界等），别让它冒泡成未捕获异常
      finish({
        port,
        busy: 'unknown',
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      })
    }
  })
}

/* ------------------------------------------------------------------ 进程 -- */

/**
 * 按 patterns（不区分大小写的子串）匹配当前机器上的进程名。
 *
 * `available: false` 表示**没探成**（命令缺失 / 退出码非 0），
 * 与"探成了但一个都没匹配"是两回事，调用方必须分开处理。
 */
export async function probeProcesses(
  patterns: readonly string[],
  options: ProcessProbeOptions = {},
): Promise<ProcessProbeResult> {
  const wanted = patterns
    .map((pattern) => String(pattern).trim())
    .filter((pattern) => pattern !== '')

  if (wanted.length === 0) {
    return {
      names: [],
      available: false,
      detail: '未指定 patterns：没有可判定的目标，未执行探测',
    }
  }

  const plan = resolveProcessPlan(options)
  const run = options.run ?? defaultRunner(normalizeTimeout(options.timeoutMs))

  let result: CommandRunResult
  try {
    result = run(plan.command, plan.args)
  } catch (error) {
    return {
      names: [],
      available: false,
      detail: `执行 ${plan.command} 失败：${error instanceof Error ? error.message : String(error)}`,
      command: plan.command,
    }
  }

  if (result.error !== undefined) {
    return {
      names: [],
      available: false,
      detail: `${result.error.code ?? 'spawn 失败'}: ${result.error.message}`,
      command: plan.command,
    }
  }

  if (result.status !== 0) {
    const stderr = (result.stderr ?? '').trim().split('\n')[0] ?? ''
    return {
      names: [],
      available: false,
      detail: `${plan.command} 退出码 ${String(result.status)}${stderr === '' ? '' : `：${stderr}`}`,
      command: plan.command,
    }
  }

  const names = parseProcessNames(result.stdout, plan.format)
    .filter((name) => wanted.some((pattern) => name.toLowerCase().includes(pattern.toLowerCase())))
    .slice(0, MAX_PROCESS_NAMES)

  return { names: [...new Set(names)].sort(), available: true, command: plan.command }
}

interface ProcessPlan {
  command: string
  args: string[]
  format: ProcessFormat
}

function resolveProcessPlan(options: ProcessProbeOptions): ProcessPlan {
  const format = options.format ?? (process.platform === 'win32' ? 'tasklist' : 'ps-lines')
  const fallback: ProcessPlan =
    format === 'tasklist'
      ? { command: 'tasklist', args: ['/FO', 'CSV', '/NH'], format }
      : { command: 'ps', args: ['-eo', 'comm='], format }
  return {
    command: options.command ?? fallback.command,
    args: options.args === undefined ? fallback.args : [...options.args],
    format,
  }
}

/** 从命令输出里抽出进程名（两种格式各一段，规则保持"看得懂就够"）。 */
export function parseProcessNames(stdout: string, format: ProcessFormat): string[] {
  const lines = String(stdout).split(/\r?\n/)
  const names: string[] = []

  for (const line of lines) {
    const text = line.trim()
    if (text === '') continue
    if (format === 'tasklist') {
      // CSV：`"node.exe","1234","Console","1","50,000 K"`；文件头/INFO 行跳过
      const matched = /^"([^"]*)"/.exec(text)
      if (matched === null) continue
      const first = matched[1] ?? ''
      if (first !== '') names.push(first)
      continue
    }
    // ps -eo comm=：一行一个名字（可能带路径，取 basename）
    const base = text.split(/[\\/]/).pop()
    if (base !== undefined && base !== '') names.push(base)
  }

  return names
}

function defaultRunner(timeoutMs: number): CommandRunner {
  return (command, args) => {
    const result = spawnSync(command, [...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
    if (result.error !== undefined && result.error !== null) {
      return {
        status: result.status,
        stdout: '',
        error: {
          ...((result.error as NodeJS.ErrnoException).code === undefined
            ? {}
            : { code: (result.error as NodeJS.ErrnoException).code as string }),
          message: result.error.message,
        },
      }
    }
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  }
}

/* -------------------------------------------------------------- 合成残留 -- */

export interface ResidueOptions {
  /** 要探测的端口；缺省用 `ctx.ports`。 */
  ports?: readonly number[]
  /** 要匹配的进程名子串；缺省不探测进程。 */
  patterns?: readonly string[]
  /** 探针超时（毫秒），缺省 2000。 */
  timeoutMs?: number
  /** 注入进程命令执行器（单测用来造"探针不可用"）；缺省用真实 `spawnSync`。 */
  processRunner?: CommandRunner
}

/**
 * 合成残留检测：**同步 tmpdir**（复用 `detectLeftovers`）+ 异步端口 / 进程。
 *
 * 条目口径与 `detectLeftovers` 一致，另加 `unknown:` 前缀表示"探不到"：
 *   · `tmpdir:<相对路径>`
 *   · `port:<端口>` / `unknown:port:<端口>（原因）`
 *   · `proc:<进程名>` / `unknown:proc:<原因>`
 *
 * `released` 恒为空：本函数只看不拆，释放清单由 runner 合并。
 */
export async function detectResidue(
  ctx: IsolationContext,
  options: ResidueOptions = {},
): Promise<CleanupRecord> {
  const base = detectLeftovers(ctx)
  const leftovers: string[] = [...base.leftovers]
  const timeoutMs = normalizeTimeout(options.timeoutMs)

  const ports = options.ports ?? ctx.ports
  if (ports.length > 0) {
    for (const result of await probePorts(ports, { timeoutMs })) {
      if (result.busy === true) {
        leftovers.push(`port:${result.port}`)
      } else if (result.busy === 'unknown') {
        leftovers.push(
          `unknown:port:${result.port}${result.detail === undefined ? '' : `（${result.detail}）`}`,
        )
      }
    }
  }

  const patterns = options.patterns ?? []
  if (patterns.length > 0) {
    const processes = await probeProcesses(patterns, {
      timeoutMs,
      ...(options.processRunner === undefined ? {} : { run: options.processRunner }),
    })
    if (!processes.available) {
      leftovers.push(`unknown:proc:${processes.detail ?? '进程探针不可用'}`)
    }
    for (const name of processes.names) leftovers.push(`proc:${name}`)
  }

  return { released: [], leftovers: [...new Set(leftovers)] }
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS
  return Math.floor(value)
}
