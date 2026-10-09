/**
 * kind: shell —— 跑一条外部命令，取证它的输出与退出码。
 *
 * ## 这个 driver 是被**真实数据**驱动出来的
 *
 * `dsh-memory` / `lingshu` 的 issue 里，绝大多数「可回归候选」的判据都是
 * 同一个形态：**跑一条命令，看它的输出或退出码**。例如
 *
 *   cd <包目录> && python -m md_cg.mcp_server   → 期望 ModuleNotFoundError（装机缺件）
 *   git apply --check                            → 期望退出 0（补丁可应用）
 *   pytest tests/test_brain_store.py             → 期望 10/10 PASS（无回归）
 *
 * 没有这个 kind 时，这类 issue 只能"人工跑一遍看看"，无法进回归集。
 *
 * ## 契约（`ctx.subprocess`）
 *
 * ```ts
 * subprocess.resolveExecutable(command, env?, signal?): Promise<string>
 * subprocess.spawn(spec): SubprocessHandle
 * spec   = { argv: string[], cwd, stdio, graceMs, signal?, env? }
 * stdio  = { stdin: 'ignore'|'pipe'|{data}, stdout: 'pipe'|'inherit'|{maxBytes}, stderr: ..., control? }
 * handle = { collected: { stdout?, stderr? }, done: Promise<{exitCode, signal}>, terminate(), waitForExit() }
 * reader.readFrom(offset) → { text, nextOffset, lossy, spillPath? }   // 非消费式、按偏移
 * ```
 *
 * ## 两个刻意的设计
 *
 * 1. **`argv` 是数组**，与 DSH 的 `subprocess.spawn` 一致——不经 shell 解析，
 *    所以没有引号/管道/重定向，也就没有注入面。要 shell 特性就显式调 `sh -c`。
 * 2. **非零退出码不是失败**：命令"跑完了"本身就是结果，判由场景的断言决定。
 *    很多被测行为恰恰是"应该报错"。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Scenario, StepAction } from '../cases/types.js'
import { expandPathTokens } from './file.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

interface OutputReadLike {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

interface OutputReaderLike {
  readFrom(fromByte: number): OutputReadLike
}

interface HandleLike {
  collected?: { stdout?: OutputReaderLike; stderr?: OutputReaderLike }
  done: Promise<{ exitCode?: number | null; signal?: string | null }>
  terminate?: () => void
}

interface SubprocessServiceLike {
  resolveExecutable?: (
    command: string,
    env?: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<string>
  spawn?: (spec: Record<string, unknown>) => HandleLike
}

export interface ShellSetup {
  /** 工作目录；缺省 `process.cwd()`。 */
  cwd?: string
  /** 额外环境变量（与进程环境合并）。 */
  env?: Record<string, string>
  /** 输出采集上限（字节），缺省 256 KiB。 */
  maxBytes?: number
  /** 终止宽限期（毫秒），缺省 5000。 */
  graceMs?: number
}

/** shell 场景的配置按 Fixture 隔离存放。 */
const shellConfigs = new WeakMap<object, ShellSetup>()

/**
 * 找 Python 解释器。
 *
 * 为什么需要专门的逻辑：**DSH 桌面端自带 Python，但它不在 PATH 上、
 * 也没有约定的启动器**（`runtime/bin` 只有 node；`versions.json` 只记录 node/pnpm）。
 * 唯一稳定的线索是目录结构：
 *
 * ```
 * <DSH 安装目录>/resources/runtime/<runtime>/dependencies/python/python.exe
 * ```
 *
 * 而 DSH 安装目录可从 `process.execPath` 推出（DSH 自己就是这个进程）。
 * `<runtime>` 名（本机是 `primary-runtime`）不写死——遍历一层。
 *
 * 回退顺序：显式环境变量 → DSH 自带 → PATH 上的 python3/python。
 * 全都没有时返回 undefined，调用方据此 **SkipCase 并说明**。
 */
export function findPython(): string | undefined {
  // ① 显式指定（给非 DSH 环境或特殊布局留的逃生口）
  for (const key of ['DSH_TESTKIT_PYTHON', 'DSH_PYTHON']) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '' && existsSync(value)) return value
  }

  // ② DSH 自带的（从进程路径推安装目录，再遍历 runtime 名）
  try {
    const dshRoot = dirname(process.execPath)
    const runtimeDir = join(dshRoot, 'resources', 'runtime')
    if (existsSync(runtimeDir)) {
      for (const runtime of readdirSync(runtimeDir)) {
        for (const exe of ['python.exe', 'python3', 'bin/python3']) {
          const candidate = join(runtimeDir, runtime, 'dependencies', 'python', exe)
          if (existsSync(candidate)) return candidate
        }
      }
    }
  } catch {
    /* 落到下一档 */
  }

  // ③ PATH 上的（用 existsSync 判断不了裸名，交给 resolveExecutable 去解析）
  return 'python3'
}

/**
 * `argv` 与 `cwd` 的令牌替换。
 *
 * | 令牌 | 替换成 | 为什么需要 |
 * |---|---|---|
 * | `$NODE` | `process.execPath` | 本机 `node` **不在 PATH 上**（见 DEVELOPMENT §1），写 `['node', ...]` 会 spawn 失败；而 DSH 自己就是 node 进程 |
 * | `$PYTHON` | 探测到的 Python 解释器 | DSH 桌面端自带 Python，但不在 PATH、无约定启动器 |
 * | `$PKG` | 本插件包根 | 场景不该硬编码绝对路径，但"跑包内脚本"需要知道包在哪 |
 * | `$FIXTURES` | 外部 fixture 根 | 被测对象（下载来的包）放在这里 |
 *
 * 只替换**整段**等于令牌的实参（不做子串替换），避免误伤正常路径；
 * 但 `$PKG/...` / `$FIXTURES/...` 这类前缀形式会被拼接。
 */
export function expandTokens(value: string): string {
  if (value === '$NODE') return process.execPath
  if (value === '$PYTHON') return findPython() ?? '$PYTHON'
  return expandPathTokens(value)
}

export function expandArgvTokens(argv: readonly string[]): string[] {
  return argv.map((arg) => expandTokens(arg))
}

/**
 * 按偏移把 reader 读干净。
 *
 * 契约说读取是**非消费式**的（独立 reader 不互相吞输出），所以按
 * `nextOffset` 前进直到不再有新增；同时设一个循环上限防止实现有 bug 时死循环。
 */
export function readAll(reader: OutputReaderLike | undefined): {
  text: string
  lossy: boolean
  rounds: number
} {
  if (!reader || typeof reader.readFrom !== 'function') {
    return { text: '', lossy: false, rounds: 0 }
  }
  let offset = 0
  let text = ''
  let lossy = false
  let rounds = 0

  for (let i = 0; i < 200; i += 1) {
    const chunk = reader.readFrom(offset)
    rounds += 1
    if (chunk === undefined || chunk === null) break
    if (typeof chunk.text === 'string' && chunk.text !== '') text += chunk.text
    if (chunk.lossy === true) lossy = true
    const next = typeof chunk.nextOffset === 'number' ? chunk.nextOffset : offset
    if (next === offset) break
    offset = next
  }

  return { text, lossy, rounds }
}

export const shellDriver: Driver = {
  kind: 'shell',
  description: '跑一条外部命令（argv 数组，无 shell 解析）并取证输出与退出码',
  requires: ['subprocess'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { shell?: ShellSetup }).shell
    if (!setup) return
    shellConfigs.set(ctx.fixture, setup)
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('shell' in action)) {
      throw new Error(
        `shell driver 只支持 \`shell\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const service = ctx.host.service('subprocess') as SubprocessServiceLike | undefined
    if (typeof service?.spawn !== 'function') {
      throw new SkipCase('宿主没有 subprocess 服务（或形状不符：拿不到 spawn）')
    }

    const spec = action.shell
    const setup = shellConfigs.get(ctx.fixture) ?? {}

    if (!Array.isArray(spec.argv) || spec.argv.length === 0) {
      throw new Error('shell.argv 必须是非空数组')
    }

    const cwd = expandTokens(spec.cwd ?? setup.cwd ?? process.cwd())

    // 显式给了 cwd 却不存在 → 跳过并说明（常见：依赖尚未准备的 fixture）
    const explicitCwd = spec.cwd !== undefined || setup.cwd !== undefined
    if (explicitCwd && !existsSync(cwd)) {
      throw new SkipCase(
        `shell.cwd 不存在：${cwd}（若是外部 fixture，见 scripts/fetch-fixtures.mjs）`,
      )
    }
    const env = { ...(setup.env ?? {}), ...(spec.env ?? {}) }
    const maxBytes = setup.maxBytes ?? 256 * 1024
    const graceMs = setup.graceMs ?? 5000

    const argv = expandArgvTokens(spec.argv)

    ctx.fixture.note('shellCwd', cwd)
    ctx.fixture.note('shellArgv', argv)

    // 裸名走宿主的 PATH 解析；解析失败就如实记账（这也是被测行为之一）
    if (typeof service.resolveExecutable === 'function') {
      try {
        argv[0] = await service.resolveExecutable(argv[0] ?? '', env, ctx.signal)
      } catch (error) {
        ctx.fixture.note('spawnError', `解析可执行文件失败：${describe(error)}`)
        ctx.fixture.note('exitCode', undefined)
        return
      }
    }
    ctx.fixture.note('shellResolvedArgv0', argv[0])

    const stdio = {
      stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
      stdout: { maxBytes },
      stderr: { maxBytes },
    }

    const startedAt = Date.now()
    let handle: HandleLike
    try {
      handle = service.spawn({
        argv,
        cwd,
        stdio,
        graceMs,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        ...(Object.keys(env).length === 0 ? {} : { env }),
      })
    } catch (error) {
      ctx.fixture.note('spawnError', describe(error))
      ctx.fixture.note('durationMs', Date.now() - startedAt)
      return
    }

    ctx.fixture.note('spawnError', undefined)

    try {
      const outcome = await handle.done
      ctx.fixture.note('exitCode', outcome?.exitCode ?? undefined)
      ctx.fixture.note('signal', outcome?.signal ?? undefined)
    } catch (error) {
      // done 可能因 spawn 失败或 provider 故障而 reject —— 如实记录，不当崩溃
      ctx.fixture.note('runError', describe(error))
    } finally {
      ctx.fixture.note('durationMs', Date.now() - startedAt)
    }

    const stdout = readAll(handle.collected?.stdout)
    const stderr = readAll(handle.collected?.stderr)
    ctx.fixture.note('stdout', stdout.text)
    ctx.fixture.note('stderr', stderr.text)
    ctx.fixture.note('stdoutLength', stdout.text.length)
    ctx.fixture.note('stderrLength', stderr.text.length)
    ctx.fixture.note('stdoutTruncated', stdout.lossy)
    ctx.fixture.note('stderrTruncated', stderr.lossy)
  },
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string'
      ? `${error.name}[${code}]: ${error.message}`
      : `${error.name}: ${error.message}`
  }
  return String(error)
}
