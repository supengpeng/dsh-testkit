/**
 * kind: compaction —— 会话历史压缩边界（`ctx.compaction`）。
 *
 * ## 安全约定（这是它存在的首要理由）
 *
 * `compactRegion` / `compactNow` 会**改写会话历史**：把选中的 surface 范围替换成
 * 一个摘要节点。在用户正在用的会话上做这件事是破坏性的。
 *
 * 所以本 driver **默认只在自己创建的隔离会话上动手**：
 * `sessions.create()` 出来的会话若不绑定 agent 生命周期，契约明确写着
 * "a session published outside that lifecycle **persists nothing**"
 * ——纯内存、不落盘、不进任何人的对话。
 *
 * ## 契约（实测自活宿主：`cordis_inspect_query Service: compaction`）
 *
 * ```ts
 * compactIfNeeded(agent: { session, options }, trigger: 'pressure' | 'context-overflow', signal)
 *   → Promise<CompactionResult | null>              // null = 没有可压的安全范围
 * compactRegion(start: SessionSeq, end: SessionSeq, agent: { session, options }, signal?)
 *   → Promise<CompactionResult>                     // 强制压缩；**范围必须 balanced**
 * compactNow(agent: { session, options, runMaintenance }, signal, sourceCommandId?)
 *   → Promise<CompactionResult | null>              // 需要 runMaintenance（真实 agent 上下文）
 *
 * CompactionResult {
 *   compactionId, startSeq, summarySeq, endSeq, summary: ContentBlock[],
 *   shadowedRange: { start, end }, shadowedSeqs: SessionSeq[], shadowedTokenCount,
 * }
 * ```
 *
 * 契约原文还有两条对本 driver 很重要的约束：
 *   · `compactIfNeeded`："Return `null` when no safe range can be compacted."
 *     → 所以"空会话返回 null"是**正确行为**，不是失败。
 *   · `compactRegion`："Both edges must be balanced so assistant tool calls remain
 *     paired with their results… rejects active, missing, reversed, or unbalanced ranges."
 *     → 范围选错会抛，driver 如实记录错误码。
 *
 * ## 一条实测出来的事实：新建会话**不是零事件**
 *
 * `sessions.create()` 出来的会话自带 3 条 bootstrap 事件——
 * `permission/preset`、`sandbox/mode`、`approval/policy`（都是非 surface 事件）。
 * 所以"空会话"的可压范围确实是 0（`surface.nodes` 为空），但**事件计数不是 0**。
 * 断言写成 `compactionEventCount is 0` 会直接假红——这条已经写进 `TK-0034` 的注释。
 */

import type { CompactionAction, Scenario, StepAction } from '../cases/types.js'
import { contentToText } from './tool.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

/* ------------------------------------------------------------ 服务最小面 -- */

interface SessionLike {
  id?: unknown
  seq?: unknown
  surface?: { nodes?: readonly unknown[] }
  snapshotEvents?: (from?: unknown, toExclusive?: unknown) => readonly unknown[]
}

interface SessionsServiceLike {
  get?: (id: string) => SessionLike | undefined
  create?: (id?: unknown, options?: Record<string, unknown>) => SessionLike
}

interface CompactionResultLike {
  compactionId?: unknown
  startSeq?: unknown
  summarySeq?: unknown
  endSeq?: unknown
  summary?: unknown
  shadowedRange?: { start?: unknown; end?: unknown }
  shadowedSeqs?: readonly unknown[]
  shadowedTokenCount?: unknown
}

interface CompactionServiceLike {
  compactIfNeeded?: (
    agent: Record<string, unknown>,
    trigger: string,
    signal: AbortSignal,
  ) => Promise<CompactionResultLike | null>
  compactRegion?: (
    start: unknown,
    end: unknown,
    agent: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<CompactionResultLike>
  compactNow?: (
    agent: Record<string, unknown>,
    signal: AbortSignal,
    sourceCommandId?: unknown,
  ) => Promise<CompactionResultLike | null>
}

/** `setup.compaction` 的声明形状。 */
export interface CompactionSetup {
  /**
   * 目标会话来源。
   *
   *   · `isolated`（缺省）——driver 自建一个隔离会话，**不落盘、不影响任何对话**
   *   · `current`——用当前会话（**只读用途**，如 `inspect`；拿它去压缩是破坏性的）
   */
  target?: 'isolated' | 'current'
  /** 隔离会话的 seed：`empty`（缺省）或 `current`（复制当前会话已提交的事件）。 */
  seed?: 'empty' | 'current'
  /** summarization 的路由；缺省不传（用宿主默认）。 */
  provider?: string
  model?: string
}

interface CompactionState {
  session: SessionLike
  isolated: boolean
  sessions: SessionsServiceLike
}

const states = new WeakMap<object, CompactionState>()

/* ------------------------------------------------------------ 纯函数层 -- */

/** 从错误里尽力提取稳定错误码（`COMPACTION_*` 一类）。三处都看，但不猜形状。 */
export function extractCompactionCode(error: unknown): string | undefined {
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
  const matched = /\b(?:COMPACTION|MANUAL_COMPACT)_[A-Z_]+\b/.exec(text)
  return matched === null ? undefined : matched[0]
}

/** 事件类型分布（只读取证用）。 */
export function summarizeEventTypes(events: unknown): string[] {
  if (!Array.isArray(events)) return []
  const types = new Set<string>()
  for (const event of events) {
    const type = (event as { type?: unknown } | null | undefined)?.type
    if (typeof type === 'string') types.add(type)
  }
  return [...types]
}

/* ---------------------------------------------------------------- driver -- */

export const compactionDriver: Driver = {
  kind: 'compaction',
  description:
    '驱动会话历史压缩：压力策略 / 强制压缩一段范围 / 只读探测（**只作用于隔离会话**）',
  requires: ['compaction'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { compaction?: CompactionSetup }).compaction ?? {}

    if (!ctx.host.capabilities.has('compaction')) {
      throw new SkipCase('宿主不具备 compaction 能力，无法驱动压缩边界')
    }

    const service = ctx.host.service('compaction') as CompactionServiceLike | undefined
    if (typeof service?.compactIfNeeded !== 'function') {
      throw new SkipCase('宿主的 compaction 服务不提供 compactIfNeeded()，无法驱动')
    }

    const sessions = ctx.host.service('sessions') as SessionsServiceLike | undefined
    if (typeof sessions?.get !== 'function' || typeof sessions.create !== 'function') {
      throw new SkipCase(
        '宿主的 sessions 服务不提供 get() / create()——压缩需要一个明确的会话目标',
      )
    }

    if (setup.target === 'current') {
      const currentId = currentSessionId(ctx)
      if (currentId === undefined) {
        throw new SkipCase('拿不到当前会话 id（agents.currentInitiator 为空）')
      }
      const session = sessions.get(currentId)
      if (session === undefined) {
        throw new SkipCase(`sessions 里没有 id=${currentId} 的活会话`)
      }
      states.set(ctx.fixture, { session, isolated: false, sessions })
      ctx.fixture.note('compactionSessionId', currentId)
      ctx.fixture.note('compactionIsolated', false)
      ctx.fixture.note('compactionTarget', 'current')
      return
    }

    // 缺省：自建隔离会话（不绑定 agent 生命周期 ⇒ 契约保证 persists nothing）
    let seed: readonly unknown[] | undefined
    if (setup.seed === 'current') {
      const currentId = currentSessionId(ctx)
      const current =
        currentId === undefined ? undefined : (sessions.get(currentId) as SessionLike | undefined)
      seed =
        typeof current?.snapshotEvents === 'function' ? current.snapshotEvents() : undefined
    }

    const session = sessions.create(
      undefined,
      seed === undefined ? undefined : { seed: [...seed] },
    )

    states.set(ctx.fixture, { session, isolated: true, sessions })
    ctx.fixture.note('compactionIsolated', true)
    ctx.fixture.note('compactionTarget', 'isolated')
    ctx.fixture.note(
      'compactionSessionId',
      typeof session?.id === 'string' ? session.id : undefined,
    )
    ctx.fixture.note('compactionSeededEvents', seed === undefined ? 0 : seed.length)
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('compaction' in action)) {
      throw new Error(
        `compaction driver 只支持 \`compaction\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const service = ctx.host.service('compaction') as CompactionServiceLike | undefined
    if (typeof service?.compactIfNeeded !== 'function') {
      throw new SkipCase('宿主的 compaction 服务不提供 compactIfNeeded()')
    }

    const state = states.get(ctx.fixture)
    if (!state) throw new Error('setup.compaction 未执行：压缩动作需要先有目标会话')

    const spec = action.compaction as CompactionAction
    const kind = Object.keys(spec as object)[0] ?? 'unknown'
    ctx.fixture.note('compactionAction', kind)
    ctx.fixture.note('compactionError', undefined)
    ctx.fixture.note('compactionErrorCode', undefined)
    // 清空上一轮的结果字段。否则"抛错的这一步"会继承上一步的取值，
    // 断时就成了在检查**上一步**——实测踩过：region 抛错后
    // `compactionResultNull` 仍是前一步 ifNeeded 留下的 true。
    ctx.fixture.note('compactionResultNull', undefined)
    ctx.fixture.note('compactionCompactionId', undefined)
    ctx.fixture.note('compactionSummaryText', undefined)

    try {
      if ('ifNeeded' in spec) return await runIfNeeded(ctx, service, state, spec.ifNeeded)
      if ('region' in spec) return await runRegion(ctx, service, state, spec.region)
      if ('now' in spec) return await runNow(ctx, service, state)
      if ('inspect' in spec) return inspect(ctx, state)
    } catch (error) {
      ctx.fixture.note('compactionError', error instanceof Error ? error.message : String(error))
      ctx.fixture.note('compactionErrorCode', extractCompactionCode(error))
      return
    }

    throw new Error(`未知的 compaction 动作：${kind}`)
  },
}

/* ------------------------------------------------------------- 操作实现 -- */

function currentSessionId(ctx: DriverContext): string | undefined {
  const agents = ctx.host.service('agents') as
    | { currentInitiator?: () => unknown; requireInitiator?: () => unknown }
    | undefined
  let initiator: unknown
  try {
    initiator = agents?.currentInitiator?.()
  } catch {
    initiator = undefined
  }
  const id = (initiator as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

/** 组装 `CompactionAgentContext`：契约要求 `{ session, options }`。 */
function agentContext(state: CompactionState, setup: CompactionSetup = {}): Record<string, unknown> {
  const options: Record<string, unknown> = {
    ...(setup.provider === undefined ? {} : { provider: setup.provider }),
    ...(setup.model === undefined ? {} : { model: setup.model }),
  }
  return { session: state.session, options }
}

async function runIfNeeded(
  ctx: DriverContext,
  service: CompactionServiceLike,
  state: CompactionState,
  spec: { trigger?: 'pressure' | 'context-overflow' },
): Promise<void> {
  const trigger = spec.trigger ?? 'pressure'
  ctx.fixture.note('compactionTrigger', trigger)

  const result = await service.compactIfNeeded!(agentContext(state), trigger, ctx.signal)
  noteResult(ctx, result)
}

async function runRegion(
  ctx: DriverContext,
  service: CompactionServiceLike,
  state: CompactionState,
  spec: { start: number; end: number },
): Promise<void> {
  if (typeof service.compactRegion !== 'function') {
    throw new SkipCase('宿主的 compaction 服务不提供 compactRegion()，无法强制压缩')
  }
  ctx.fixture.note('compactionRegionStart', spec.start)
  ctx.fixture.note('compactionRegionEnd', spec.end)

  const result = await service.compactRegion(spec.start, spec.end, agentContext(state), ctx.signal)
  noteResult(ctx, result)
}

async function runNow(
  ctx: DriverContext,
  service: CompactionServiceLike,
  state: CompactionState,
): Promise<void> {
  // 契约：compactNow 的上下文是 ManualCompactAgentContext = CompactionAgentContext + runMaintenance。
  // 隔离会话没有归属 agent，自然也没有 runMaintenance——如实记为"不可用"，
  // 而不是伪造一个假的 maintenance 回调（那只会把失败推后到更难查的地方）。
  if (typeof service.compactNow !== 'function') {
    throw new SkipCase('宿主的 compaction 服务不提供 compactNow()')
  }
  const hasMaintenance =
    typeof (state.session as { runMaintenance?: unknown }).runMaintenance === 'function'
  ctx.fixture.note('compactionHasRunMaintenance', hasMaintenance)
  if (!hasMaintenance) {
    ctx.fixture.note(
      'compactionUnsupported',
      'compactNow 需要 ManualCompactAgentContext.runMaintenance（真实 agent 上下文）；隔离会话没有',
    )
    return
  }
  noteResult(ctx, await service.compactNow(agentContext(state), ctx.signal))
}

function inspect(ctx: DriverContext, state: CompactionState): void {
  const session = state.session
  const events =
    typeof session.snapshotEvents === 'function' ? (session.snapshotEvents() ?? []) : []

  ctx.fixture.note('compactionSeq', typeof session.seq === 'number' ? session.seq : undefined)
  ctx.fixture.note(
    'compactionSurfaceNodes',
    Array.isArray(session.surface?.nodes) ? session.surface.nodes.length : undefined,
  )
  ctx.fixture.note('compactionEventCount', Array.isArray(events) ? events.length : undefined)
  ctx.fixture.note('compactionEventTypes', summarizeEventTypes(events))
}

/** 把一次压缩结果（或 null）写进取证。 */
function noteResult(ctx: DriverContext, result: unknown): void {
  if (result === null || result === undefined) {
    ctx.fixture.note('compactionResultNull', true)
    ctx.fixture.note('compactionCompactionId', undefined)
    ctx.fixture.note('compactionSummaryText', undefined)
    return
  }
  ctx.fixture.note('compactionResultNull', false)
  const record = result as CompactionResultLike
  ctx.fixture.note(
    'compactionCompactionId',
    typeof record.compactionId === 'string' ? record.compactionId : undefined,
  )
  ctx.fixture.note('compactionStartSeq', asNumber(record.startSeq))
  ctx.fixture.note('compactionSummarySeq', asNumber(record.summarySeq))
  ctx.fixture.note('compactionEndSeq', asNumber(record.endSeq))
  ctx.fixture.note('compactionShadowedTokenCount', asNumber(record.shadowedTokenCount))
  ctx.fixture.note(
    'compactionShadowedCount',
    Array.isArray(record.shadowedSeqs) ? record.shadowedSeqs.length : undefined,
  )
  ctx.fixture.note('compactionSummaryText', contentToText(record.summary))
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
