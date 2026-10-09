/**
 * kind: fs —— 驱动 DSH 的**文件服务**（`ctx.fs`）：沙箱策略、写意图、版本冲突。
 *
 * ## 与 kind: file 的分工（别混）
 *
 * | | `kind: file` | `kind: fs` |
 * |---|---|---|
 * | 用什么 | `node:fs`（进程自己的文件系统） | `ctx.fs`（宿主的文件服务） |
 * | 依赖能力 | 无（纯离线，CI 轨也跑） | `fs` |
 * | 能测什么 | 内容 / 清单 / 结构性判据 | **沙箱拒绝**、**陈旧版本保护**、写意图 |
 *
 * 后两类是 `node:fs` **永远测不到**的：沙箱边界由宿主 policy 层决定，
 * 陈旧版本保护只在传入 `expected` 守卫时才生效。
 *
 * ## 契约（实测自活宿主：`cordis_inspect_query Service: fs`）
 *
 * ```ts
 * resolve(path, { cwd?, signal? }) → FsTarget { targetKey, displayPath }
 * stat(target) → FsInfo { version, type, size? } | undefined      // 不存在 = undefined
 * readText(target) → string
 * listDir(target) → FsDirEntry[] { name, type, target, version?, size? }
 * writeText(target, content, expected?, signal?, sandboxPolicy?) → FsWriteOutcome
 *   expected:      { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion', version }
 *   sandboxPolicy: { mode: 'read-only' | 'workspace-write' | 'danger-full-access', workspaceRoot, sessionId? }
 * editText(target, { oldString, newString, replaceAll }, expected?: { version }, signal?, sandboxPolicy?)
 *   // 契约原文：版本守卫在匹配之前检查，陈旧内容报 FS_STALE_VERSION
 * ```
 *
 * ## 工作根
 *
 * 缺省在系统临时目录下建一个 `testkit-fs-*` 目录，并在场景结束时删掉——
 * 这样本 kind 不依赖调用方准备目录，也不会留下垃圾。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'

import type { Scenario, StepAction } from '../cases/types.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

/* ------------------------------------------------------------ 服务最小面 -- */

type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
type VersionPick = 'first' | 'last'

interface FsTargetLike {
  targetKey?: unknown
  displayPath?: unknown
}

interface FsInfoLike {
  version?: unknown
  type?: unknown
  size?: unknown
}

interface FsDirEntryLike {
  name?: unknown
  type?: unknown
  version?: unknown
  size?: unknown
}

interface FsWriteOutcomeLike {
  operation?: unknown
  version?: unknown
  before?: unknown
  after?: unknown
}

interface FsEditOutcomeLike {
  version?: unknown
  before?: unknown
  after?: unknown
}

interface FsServiceLike {
  resolve?: (path: string, opts?: { cwd?: string; signal?: AbortSignal }) => Promise<FsTargetLike>
  stat?: (target: FsTargetLike, signal?: AbortSignal) => Promise<FsInfoLike | undefined>
  readText?: (target: FsTargetLike, signal?: AbortSignal) => Promise<string>
  listDir?: (target: FsTargetLike, signal?: AbortSignal) => Promise<FsDirEntryLike[]>
  writeText?: (
    target: FsTargetLike,
    content: string,
    expected?: unknown,
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ) => Promise<FsWriteOutcomeLike>
  editText?: (
    target: FsTargetLike,
    edit: { oldString: string; newString: string; replaceAll: boolean },
    expected?: { version: string },
    signal?: AbortSignal,
    sandboxPolicy?: unknown,
  ) => Promise<FsEditOutcomeLike>
}

/** `setup.fs` 的声明形状。 */
export interface FsSetup {
  /** 工作根：相对路径的基准，也是沙箱的默认 workspaceRoot。缺省自动建临时目录。 */
  root?: string
  /** `workspace-write` 的根（相对 root 解析）；缺省就是 root 自己。 */
  workspace?: string
  /** 缺省沙箱模式；省略即不传 sandboxPolicy（用后端的默认）。 */
  mode?: SandboxMode
  /**
   * 先探测这个宿主**是否真的实施沙箱策略**。
   *
   * 为什么需要：契约原文写着 "a sandboxing backend fences the write by it,
   * **the bare backend ignores it**"。也就是说同一个 `read-only` 策略，
   * 在装了沙箱层的 profile 里会被拒绝，在 bare 后端上会被**照常写入**。
   * 不探测就断言"必然被拒"，会让这条场景在另一种 profile 上假红。
   *
   * 探测方式：拿一个一次性文件按 `read-only` 写一次——
   * 被拒 ⇒ 沙箱存在；写成功 ⇒ `SkipCase`（明说宿主不实施），而不是失败。
   */
  probeSandbox?: boolean
}

interface FsState {
  root: string
  workspace: string
  mode?: SandboxMode
  firstVersion?: string
  lastVersion?: string
}

/** 每个 Fixture 一份状态（与 session / agent driver 同一手法）。 */
const states = new WeakMap<object, FsState>()

/* ------------------------------------------------------------ 纯函数层 -- */

/**
 * 从错误里尽力提取稳定错误码（`FS_STALE_VERSION` 一类）。
 *
 * 为什么是"尽力"：DSH 的错误可能把码放在 `code`、`info.code`，或只写在 message 里。
 * driver 三种都看，并把原文另记进 `fx.fsError`——**不猜形状，但也不丢信息**。
 *
 * 导出以便单测直接覆盖。
 */
export function extractFsCode(error: unknown): string | undefined {
  if (typeof error === 'string') return matchCode(error)
  if (error === null || typeof error !== 'object') return undefined
  const record = error as Record<string, unknown>
  for (const key of ['code', 'errorCode'] as const) {
    if (typeof record[key] === 'string' && record[key] !== '') return record[key] as string
  }
  const info = record['info']
  if (info !== null && typeof info === 'object') {
    const code = (info as Record<string, unknown>)['code']
    if (typeof code === 'string' && code !== '') return code
  }
  const message = record['message']
  return typeof message === 'string' ? matchCode(message) : undefined
}

function matchCode(text: string): string | undefined {
  const matched = /\b(FS_[A-Z_]+)\b/.exec(text)
  return matched === null ? undefined : matched[1]
}

/** 把目录项投影成报告友好的行。 */
export function describeEntries(entries: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(entries)) return []
  return entries.map((raw) => {
    const entry = (raw ?? {}) as FsDirEntryLike
    return {
      name: typeof entry.name === 'string' ? entry.name : undefined,
      type: typeof entry.type === 'string' ? entry.type : undefined,
      size: typeof entry.size === 'number' ? entry.size : undefined,
    }
  })
}

/** 版本摘要：只报前后各 8 个字符，避免报告里出现无意义的长串。 */
export function summarizeVersion(version: unknown): string | undefined {
  if (typeof version !== 'string' || version === '') return undefined
  if (version.length <= 20) return version
  return `${version.slice(0, 8)}…${version.slice(-4)}`
}

/* ---------------------------------------------------------------- driver -- */

export const fsDriver: Driver = {
  kind: 'fs',
  description: '驱动宿主文件服务：沙箱策略 / 写意图 / 陈旧版本保护（需要 fs 能力）',
  requires: ['fs'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { fs?: FsSetup }).fs ?? {}

    if (!ctx.host.capabilities.has('fs')) {
      throw new SkipCase('宿主不具备 fs 能力，无法驱动文件服务语义')
    }

    const ownsRoot = setup.root === undefined
    const root = ownsRoot
      ? mkdtempSync(join(tmpdir(), 'testkit-fs-'))
      : resolvePath(setup.root as string)
    const workspace = setup.workspace === undefined ? root : resolvePath(root, setup.workspace)

    if (ownsRoot) {
      ctx.fixture.add('fs:temp-root', () => {
        rmSync(root, { recursive: true, force: true })
      })
    }

    states.set(ctx.fixture, {
      root,
      workspace,
      ...(setup.mode === undefined ? {} : { mode: setup.mode }),
    })

    ctx.fixture.note('fsRoot', root)
    ctx.fixture.note('fsWorkspace', workspace)
    ctx.fixture.note('fsSetupMode', setup.mode)

    if (setup.probeSandbox === true) {
      const service = ctx.host.service('fs') as FsServiceLike | undefined
      if (typeof service?.resolve !== 'function' || typeof service.writeText !== 'function') {
        throw new SkipCase('宿主的 fs 服务形状不完整，无法探测沙箱')
      }
      const probePath = join(root, '.testkit-sandbox-probe')
      try {
        const target = await service.resolve(probePath, { signal: ctx.signal })
        await service.writeText(
          target,
          'probe',
          undefined,
          ctx.signal,
          { mode: 'read-only', workspaceRoot: workspace },
        )
        throw new SkipCase(
          '宿主 fs 后端不实施 sandboxPolicy（bare backend 会忽略它），沙箱语义无法在此 profile 验证',
        )
      } catch (error) {
        if (error instanceof SkipCase) throw error
        ctx.fixture.note('fsSandboxProbe', 'denied')
        ctx.fixture.note('fsSandboxProbeCode', extractFsCode(error))
      } finally {
        try {
          rmSync(probePath, { force: true })
        } catch {
          /* 探测残留清理失败不影响判定 */
        }
      }
    }
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('fs' in action)) {
      throw new Error(
        `fs driver 只支持 \`fs\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const service = ctx.host.service('fs') as FsServiceLike | undefined
    if (typeof service?.resolve !== 'function' || typeof service.writeText !== 'function') {
      throw new SkipCase('宿主的 fs 服务不提供 resolve() / writeText()，无法驱动')
    }

    const state = states.get(ctx.fixture)
    if (!state) {
      throw new Error('setup.fs 未执行：fs 动作需要先有工作根')
    }

    const spec = action.fs
    const kind = Object.keys(spec as object)[0] ?? 'unknown'
    ctx.fixture.note('fsAction', kind)
    ctx.fixture.note('fsError', undefined)
    ctx.fixture.note('fsErrorCode', undefined)

    try {
      if ('resolve' in spec) {
        await doResolve(ctx, service, state, spec.resolve)
      } else if ('stat' in spec) {
        await doStat(ctx, service, state, spec.stat.path)
      } else if ('read' in spec) {
        await doRead(ctx, service, state, spec.read.path)
      } else if ('list' in spec) {
        await doList(ctx, service, state, spec.list.path)
      } else if ('write' in spec) {
        await doWrite(ctx, service, state, spec.write)
      } else if ('edit' in spec) {
        await doEdit(ctx, service, state, spec.edit)
      } else {
        throw new Error(`未知的 fs 动作：${kind}`)
      }
    } catch (error) {
      ctx.fixture.note('fsError', error instanceof Error ? error.message : String(error))
      ctx.fixture.note('fsErrorCode', extractFsCode(error))
    }
  },
}

/* ------------------------------------------------------------- 操作实现 -- */

function absolute(state: FsState, path: string): string {
  return isAbsolute(path) ? path : resolvePath(state.root, path)
}

function remember(state: FsState, version: unknown): void {
  if (typeof version !== 'string' || version === '') return
  state.firstVersion ??= version
  state.lastVersion = version
}

function pickVersion(state: FsState, which: VersionPick | undefined): string | undefined {
  if (which === 'first') return state.firstVersion
  if (which === 'last') return state.lastVersion
  return undefined
}

/** 构造 sandboxPolicy：动作级覆盖 setup 级；都没有则 `undefined`（后端默认）。 */
function sandboxPolicy(
  ctx: DriverContext,
  state: FsState,
  override: { mode: SandboxMode; workspace?: string } | undefined,
): unknown {
  const mode = override?.mode ?? state.mode
  if (mode === undefined) return undefined
  const workspaceRoot =
    override?.workspace === undefined ? state.workspace : resolvePath(state.root, override.workspace)
  const policy = { mode, workspaceRoot }
  ctx.fixture.note('fsSandboxMode', mode)
  ctx.fixture.note('fsSandboxWorkspace', workspaceRoot)
  return policy
}

async function targetOf(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  path: string,
  cwd?: string,
): Promise<FsTargetLike> {
  const target = (await service.resolve!(absolute(state, path), {
    ...(cwd === undefined ? {} : { cwd }),
    signal: ctx.signal,
  })) as FsTargetLike
  ctx.fixture.note('fsTargetPath', typeof target?.displayPath === 'string' ? target.displayPath : undefined)
  ctx.fixture.note('fsTargetKeyPresent', typeof target?.targetKey === 'string')
  return target
}

async function doResolve(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  spec: { path: string; cwd?: string },
): Promise<void> {
  const target = await targetOf(ctx, service, state, spec.path, spec.cwd)
  const info = typeof service.stat === 'function' ? await service.stat(target, ctx.signal) : undefined
  ctx.fixture.note('fsExists', info !== undefined)
  ctx.fixture.note('fsType', info === undefined ? undefined : asText(info.type))
  ctx.fixture.note('fsVersion', summarizeVersion(info?.version))
  remember(state, info?.version)
}

async function doStat(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  path: string,
): Promise<void> {
  if (typeof service.stat !== 'function') throw new SkipCase('fs 服务不提供 stat()')
  const target = await targetOf(ctx, service, state, path)
  const info = await service.stat(target, ctx.signal)
  ctx.fixture.note('fsExists', info !== undefined)
  ctx.fixture.note('fsType', info === undefined ? undefined : asText(info.type))
  ctx.fixture.note('fsSize', info === undefined ? undefined : info.size)
  ctx.fixture.note('fsVersion', summarizeVersion(info?.version))
  remember(state, info?.version)
}

async function doRead(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  path: string,
): Promise<void> {
  if (typeof service.readText !== 'function') throw new SkipCase('fs 服务不提供 readText()')
  const target = await targetOf(ctx, service, state, path)
  const text = await service.readText(target, ctx.signal)
  ctx.fixture.note('fsText', text)
  ctx.fixture.note('fsTextLength', typeof text === 'string' ? text.length : undefined)
}

async function doList(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  path: string,
): Promise<void> {
  if (typeof service.listDir !== 'function') throw new SkipCase('fs 服务不提供 listDir()')
  const target = await targetOf(ctx, service, state, path)
  const entries = await service.listDir(target, ctx.signal)
  ctx.fixture.note('fsEntries', describeEntries(entries))
  ctx.fixture.note('fsEntryCount', Array.isArray(entries) ? entries.length : undefined)
}

async function doWrite(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  spec: {
    path: string
    text: string
    intent?: 'unconditional' | 'createIfAbsent' | 'replaceIfVersion'
    expectedVersion?: VersionPick
    sandbox?: { mode: SandboxMode; workspace?: string }
  },
): Promise<void> {
  const target = await targetOf(ctx, service, state, spec.path)

  let expected: unknown
  if (spec.intent === 'createIfAbsent') {
    expected = { kind: 'createIfAbsent' }
  } else if (spec.intent === 'replaceIfVersion') {
    const version = pickVersion(state, spec.expectedVersion ?? 'last')
    if (version === undefined) {
      throw new Error('replaceIfVersion 需要先观测到一个版本（先 write 或 stat 一次）')
    }
    expected = { kind: 'replaceIfVersion', version }
    ctx.fixture.note('fsExpectedVersion', summarizeVersion(version))
  }
  ctx.fixture.note('fsWriteIntent', spec.intent ?? 'unconditional')

  const outcome = (await service.writeText!(
    target,
    spec.text,
    expected,
    ctx.signal,
    sandboxPolicy(ctx, state, spec.sandbox),
  )) as FsWriteOutcomeLike

  ctx.fixture.note('fsOperation', asText(outcome?.operation))
  ctx.fixture.note('fsBefore', outcome?.before)
  ctx.fixture.note('fsAfter', outcome?.after)
  ctx.fixture.note('fsVersion', summarizeVersion(outcome?.version))
  remember(state, outcome?.version)
}

async function doEdit(
  ctx: DriverContext,
  service: FsServiceLike,
  state: FsState,
  spec: {
    path: string
    oldString: string
    newString: string
    replaceAll?: boolean
    expectedVersion?: VersionPick
  },
): Promise<void> {
  if (typeof service.editText !== 'function') throw new SkipCase('fs 服务不提供 editText()')
  const target = await targetOf(ctx, service, state, spec.path)

  let guard: { version: string } | undefined
  if (spec.expectedVersion !== undefined) {
    const version = pickVersion(state, spec.expectedVersion)
    if (version === undefined) {
      throw new Error('edit 的 expectedVersion 需要先观测到一个版本（先 write 或 stat 一次）')
    }
    guard = { version }
    ctx.fixture.note('fsExpectedVersion', summarizeVersion(version))
  }

  const outcome = await service.editText(
    target,
    {
      oldString: spec.oldString,
      newString: spec.newString,
      replaceAll: spec.replaceAll === true,
    },
    guard,
    ctx.signal,
    sandboxPolicy(ctx, state, undefined),
  )

  ctx.fixture.note('fsBefore', outcome?.before)
  ctx.fixture.note('fsAfter', outcome?.after)
  ctx.fixture.note('fsVersion', summarizeVersion(outcome?.version))
  remember(state, outcome?.version)
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
