/**
 * kind: session —— 会话与目标面（四个分支）。
 *
 * | 分支 | 干预点 | 需要能力 |
 * |---|---|---|
 * | `command` | `ctx.commands.register` | `commands` |
 * | `flush`   | `ctx.sessions.flush()` | `sessions` |
 * | `goal`    | `ctx.goals` | `goals`（且需要确切的活 agent） |
 * | `events`  | `session/event`（**只读**） | 无（能拿到会话即可） |
 *
 * ## 为什么 `command` 直接调我们注册的 handler，而不是 `commands.execute(...)`
 *
 * `ctx.commands.execute(agent, line, attachments, signal)` **需要一个 `agent`**
 * （它是 Remote 方法，参数里第一个就是接收者 agent）。自检场景没有真实 agent，
 * 硬凑一个假 agent 只会让"测命令逻辑"变成"测假 agent 能不能过校验"。
 *
 * 所以 act 直接调用本 driver 注册时保存的 `definition.execute(...)`——
 * 被测对象明确，且不引入无关前置条件。DSH 侧的**分发**（解析斜杠、找命令、
 * 归属 agent、记录 `command/run` 审计事件）属于 `commands` 服务自己的行为，
 * 不在本 driver 的断言范围内。
 *
 * ## `events` 分支为什么**只读**
 *
 * DSH 的纪律原文（`practices.md`）：不要用新的 `type` 追加会话事件——
 * 读取方只接受带 `ignorable: true` 的未知事件，而 `Session.append()` 设不了这个标记，
 * 于是**那个会话会拒绝重开**。所以本 driver 只监听 `session/event`、
 * 记录类型与序号，绝不写入。
 *
 * ## `goal` 分支的两个安全阀
 *
 * 1. `create` 会 **arm 自动续轮**（`goal-round-driver` 会一直唤醒模型）。
 *    driver 默认在 create 之后**立刻 `disarm`**（只清进程内授权，不改持久 phase），
 *    并把 armed / disarmed 两个状态都写进取证。要观察 armed 就断言 `goalCreatedActivation`。
 * 2. teardown 会对本场景创建过的目标尝试 `clear`（墓碑），减少残留。
 *
 * ## 契约（实测自活宿主）
 *
 * ```ts
 * sessions.get(id) → Session | undefined
 * sessions.flush(session) → Promise<boolean>   // 唯一入口，返回"有没有 listener 参与"
 * Session: { id, header, seq, snapshotEvents(), append() }
 *
 * goals.get(agent) → GoalView | undefined
 * goals.create(agent, { objective, maxGoalRounds? }) → GoalView   // ← 会 arm
 * goals.edit/pause/resume/complete/clear(agent, ref) / block(agent, ref, {code,message})
 * goals.disarm(agent) → GoalView | undefined                       // 只清授权
 * GoalView: { id, revision, objective, phase: active|paused|blocked|complete,
 *             activation: armed|disarmed, maxGoalRounds, roundsStarted, ... }
 * ```
 */

import type { GoalAction, Scenario, SessionAction, StepAction } from '../cases/types.js'
import { resolveInitiator } from './agent.js'
import { SkipCase, type CommandDefinition, type Driver, type DriverContext } from './types.js'

export interface SessionCommandSpec {
  name: string
  description?: string
  /** 命令输入提示（对应 DSH `input.hint`）。 */
  inputHint?: string
  /** 成功时返回的文本；缺省回显输入。 */
  returns?: string
  /** 返回 `{ kind: 'error' }` 而不是成功（**返回值形态**的失败）。 */
  error?: boolean
  /** 抛异常（**异常形态**的失败，与 `error` 是两条不同路径）。 */
  throws?: string
  delayMs?: number
}

/** `setup.session.flushObserver`：注册一个 `session/flush` 观察者。 */
export interface SessionFlushObserverSpec {
  /**
   * 让观察者慢一点。
   *
   * 这不是"制造延迟"，而是**验证 flush 真的 await 了 listener**：
   * 契约原文是 "after every listener has settled successfully"，
   * 若宿主只是 fire-and-forget，`fx.sessionFlushDurationMs` 就不会 ≥ 这个值。
   */
  slowMs?: number
}

export interface SessionSetup {
  command?: SessionCommandSpec
  /** 注册 `session/flush` 观察者（`flush` 分支用它取证"真的派发了"）。 */
  flushObserver?: SessionFlushObserverSpec
  /** 注册 `session/event` 观察者（`events` 分支用它取证事件流）。 */
  eventObserver?: boolean
}

/** 本 driver 在 `error: true` 时使用的默认错误文本。 */
export const TESTKIT_COMMAND_ERROR = 'TESTKIT_COMMAND_ERROR'

/**
 * 按场景声明构造一个命令定义。
 *
 * 导出以便单测直接覆盖（不需要真的过一遍宿主的注册）。
 */
export function buildCommandDefinition(spec: SessionCommandSpec): CommandDefinition {
  return {
    name: spec.name,
    description: spec.description ?? `dsh-testkit 临时命令 ${spec.name}`,
    ...(spec.inputHint === undefined ? {} : { inputHint: spec.inputHint }),
    execute: async (rawInput, signal) => {
      if (typeof spec.delayMs === 'number' && spec.delayMs > 0) {
        await delay(spec.delayMs, signal)
      }
      if (spec.throws !== undefined) throw new Error(spec.throws)
      if (spec.error === true) {
        return { kind: 'error', text: spec.returns ?? TESTKIT_COMMAND_ERROR }
      }
      return { kind: 'success', text: spec.returns ?? `echo:${rawInput}` }
    },
  }
}

/* ------------------------------------------------------------ 服务最小面 -- */

interface SessionLike {
  id?: unknown
  seq?: unknown
}

interface SessionsServiceLike {
  get?: (id: string) => SessionLike | undefined
  flush?: (session: SessionLike) => Promise<boolean>
}

interface GoalRefLike {
  id?: unknown
  revision?: unknown
}

interface GoalViewLike extends GoalRefLike {
  objective?: unknown
  phase?: unknown
  activation?: unknown
  maxGoalRounds?: unknown
  roundsStarted?: unknown
}

interface GoalsServiceLike {
  get?: (agent: unknown) => GoalViewLike | undefined
  disarm?: (agent: unknown) => GoalViewLike | undefined
  create?: (agent: unknown, request: Record<string, unknown>) => GoalViewLike
  edit?: (agent: unknown, ref: GoalRefLike, request: Record<string, unknown>) => GoalViewLike
  pause?: (agent: unknown, ref: GoalRefLike) => GoalViewLike
  resume?: (agent: unknown, ref: GoalRefLike) => GoalViewLike
  complete?: (agent: unknown, ref: GoalRefLike) => GoalViewLike
  clear?: (agent: unknown, ref: GoalRefLike) => GoalRefLike
  block?: (agent: unknown, ref: GoalRefLike, reason: Record<string, unknown>) => GoalViewLike
}

/* ------------------------------------------------------------ 纯函数层 -- */

/**
 * 从错误里尽力提取稳定错误码（`GOAL_*` 一类）。
 *
 * 与 fs driver 的 `extractFsCode` 同一手法：`code` / `info.code` / message 三处都看，
 * 但**不猜形状**——原文另记进 `fx.goalError`。
 */
export function extractGoalCode(error: unknown): string | undefined {
  if (typeof error === 'string') return matchGoalCode(error)
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
  return typeof message === 'string' ? matchGoalCode(message) : undefined
}

function matchGoalCode(text: string): string | undefined {
  const matched = /\b((?:GOAL|TEAM)_[A-Z_]+)\b/.exec(text)
  return matched === null ? undefined : matched[1]
}

/** 事件序号是否严格单调递增（`session/event` 是 post-commit 追加流）。 */
export function isMonotonicSeq(seqs: readonly number[]): boolean {
  for (let i = 1; i < seqs.length; i += 1) {
    const prev = seqs[i - 1] as number
    const next = seqs[i] as number
    if (!(next > prev)) return false
  }
  return true
}

/* ------------------------------------------------------------------ 状态 -- */

interface SessionState {
  flushCalls: number
  events: Array<{ type: string; seq: number }>
  targetSessionId?: string
  goalRef?: { id: string; revision: number }
  goalCreated: boolean
}

/** 可变运行态放 WeakMap：notes 会被序列化进报告，函数与活对象不该进去。 */
const states = new WeakMap<object, SessionState>()

/**
 * 已注册命令的旁路索引。
 *
 * 为什么用 WeakMap 而不是塞进 Fixture.notes：notes 会被序列化进报告，
 * 函数字段会在 JSON 化时丢失——存进去反而制造"看起来有、实际取不到"的假象。
 */
const commandIndex = new WeakMap<object, Map<string, CommandDefinition>>()

/** 取当前发起者的会话 id（沿驱动链传递；拿不到就不过滤事件）。 */
function currentSessionId(ctx: DriverContext): string | undefined {
  const initiator = resolveInitiator(ctx.host.service('agents'))
  const id = (initiator as { id?: unknown } | undefined)?.id
  return typeof id === 'string' ? id : undefined
}

export const sessionDriver: Driver = {
  kind: 'session',
  description:
    '会话与目标面：临时命令 / `session/flush` 检查点 / `ctx.goals` 状态机 / 只读观察 `session/event`',
  // 命令需要 commands 能力；flush / goal 的能力在各自分支里检查，方便跳过时给出原因
  requires: ['commands'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { session?: SessionSetup }).session

    const state: SessionState = { flushCalls: 0, events: [], goalCreated: false }
    state.targetSessionId = currentSessionId(ctx)
    states.set(ctx.fixture, state)
    ctx.fixture.note('sessionTargetId', state.targetSessionId)

    if (setup?.command) {
      if (!ctx.host.capabilities.has('commands')) {
        throw new SkipCase('宿主不具备 commands 能力，无法注册命令')
      }

      const definition = buildCommandDefinition(setup.command)
      ctx.fixture.add(`session:command:${definition.name}`, ctx.host.registerCommand(definition))

      const registry = commandIndex.get(ctx.fixture) ?? new Map<string, CommandDefinition>()
      registry.set(definition.name, definition)
      commandIndex.set(ctx.fixture, registry)

      ctx.fixture.note('registeredCommands', [
        ...((ctx.fixture.getNote('registeredCommands') as string[] | undefined) ?? []),
        definition.name,
      ])
    }

    if (setup?.flushObserver) {
      if (!ctx.host.capabilities.has('sessions')) {
        throw new SkipCase('宿主不具备 sessions 能力，无法观察 session/flush')
      }
      const slowMs = setup.flushObserver.slowMs ?? 0
      const dispose = ctx.host.on('session/flush', async (session: unknown) => {
        state.flushCalls += 1
        ctx.fixture.note('sessionFlushObserverCalls', state.flushCalls)
        const id = (session as { id?: unknown } | undefined)?.id
        if (state.targetSessionId !== undefined && id !== state.targetSessionId) return
        if (slowMs > 0) await delay(slowMs, ctx.signal)
      })
      ctx.fixture.add('session:flush-observer', dispose)
      ctx.fixture.note('sessionFlushObserverDelayMs', slowMs)
    }

    if (setup?.eventObserver) {
      const dispose = ctx.host.on('session/event', (session: unknown, event: unknown) => {
        const id = (session as { id?: unknown } | undefined)?.id
        if (state.targetSessionId !== undefined && id !== state.targetSessionId) return
        const type = (event as { type?: unknown } | undefined)?.type
        if (typeof type !== 'string') return
        const seq = (event as { seq?: unknown } | undefined)?.seq
        state.events.push({ type, seq: typeof seq === 'number' ? seq : 0 })
      })
      ctx.fixture.add('session:event-observer', dispose)
    }
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('session' in action)) {
      throw new Error(
        `session driver 只支持 \`session\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const spec = action.session as SessionAction
    ctx.fixture.note('sessionAction', Object.keys(spec as object)[0] ?? 'unknown')

    if ('command' in spec) return runCommand(ctx, spec)
    if ('flush' in spec) return runFlush(ctx, spec)
    if ('goal' in spec) return runGoal(ctx, spec.goal)
    if ('events' in spec) return runEvents(ctx, spec)

    throw new Error(`未知的 session 动作：${Object.keys(spec as object).join('/')}`)
  },

  async teardown(ctx: DriverContext): Promise<void> {
    // 本场景若创建过 target，尽量留下墓碑而不是"活着的目标"（减少对宿主会话的影响）
    const state = states.get(ctx.fixture)
    if (!state?.goalCreated) return
    const goals = ctx.host.service('goals') as GoalsServiceLike | undefined
    const agent = resolveInitiator(ctx.host.service('agents'))
    if (typeof goals?.clear !== 'function' || agent === undefined || agent === null) return
    const ref = state.goalRef ?? currentRef(goals, agent)
    if (ref === undefined) return
    try {
      goals.clear(agent, ref)
      ctx.fixture.note('goalTeardownCleared', true)
    } catch (error) {
      ctx.fixture.note('goalTeardownCleared', false)
      ctx.fixture.note('goalTeardownError', error instanceof Error ? error.message : String(error))
    }
  },
}

/* --------------------------------------------------------------- command -- */

async function runCommand(
  ctx: DriverContext,
  spec: Extract<SessionAction, { command: unknown }>,
): Promise<void> {
  const registry = commandIndex.get(ctx.fixture)
  const definition = registry?.get(spec.command.name)
  if (!definition) {
    throw new Error(
      `命令 ${spec.command.name} 未注册。` +
        `session driver 只能驱动本场景 setup.session.command 声明的命令。`,
    )
  }

  const rawInput = spec.command.input ?? ''
  const count = ((ctx.fixture.getNote('commandCount') as number | undefined) ?? 0) + 1
  ctx.fixture.note('commandCount', count)
  ctx.fixture.noteAppend('commandInvocations', { index: count, name: spec.command.name, rawInput })

  let result: unknown
  let error: string | undefined
  try {
    result = await definition.execute(rawInput, ctx.signal)
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
  }

  ctx.fixture.note('commandResult', result)
  ctx.fixture.note('commandError', error)
  // 便于断言常见字段而不用写长路径
  const kind = (result as { kind?: unknown } | undefined)?.kind
  ctx.fixture.note('commandKind', typeof kind === 'string' ? kind : undefined)
  const text = (result as { text?: unknown } | undefined)?.text
  ctx.fixture.note('commandText', typeof text === 'string' ? text : undefined)
}

/* ----------------------------------------------------------------- flush -- */

async function runFlush(
  ctx: DriverContext,
  spec: Extract<SessionAction, { flush: unknown }>,
): Promise<void> {
  const sessions = ctx.host.service('sessions') as SessionsServiceLike | undefined
  if (typeof sessions?.flush !== 'function' || typeof sessions.get !== 'function') {
    throw new SkipCase('宿主的 sessions 服务不提供 flush() / get()，无法触发持久化检查点')
  }

  const state = states.get(ctx.fixture)
  const sessionId = state?.targetSessionId
  if (sessionId === undefined) {
    throw new SkipCase('拿不到当前会话 id（agents.currentInitiator 为空）——flush 需要一个确切会话')
  }

  const session = sessions.get(sessionId)
  if (session === undefined) {
    throw new SkipCase(`sessions 里没有 id=${sessionId} 的活会话，无法 flush`)
  }

  ctx.fixture.note('sessionFlushSessionId', sessionId)
  ctx.fixture.note('sessionFlushNote', spec.flush.note)
  ctx.fixture.note('sessionFlushSeqBefore', session.seq)

  const startedAt = Date.now()
  let participated: unknown
  let error: string | undefined
  try {
    participated = await sessions.flush(session)
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)
  }

  ctx.fixture.note('sessionFlushDurationMs', Date.now() - startedAt)
  ctx.fixture.note(
    'sessionFlushParticipated',
    typeof participated === 'boolean' ? participated : undefined,
  )
  ctx.fixture.note('sessionFlushError', error)
  ctx.fixture.note('sessionFlushSeqAfter', session.seq)
}

/* ----------------------------------------------------------------- events -- */

async function runEvents(
  ctx: DriverContext,
  spec: Extract<SessionAction, { events: unknown }>,
): Promise<void> {
  const waitMs = spec.events.waitMs ?? 0
  if (waitMs > 0) await delay(waitMs, ctx.signal)

  const state = states.get(ctx.fixture)
  const all = state?.events ?? []
  const limit = spec.events.limit ?? 20
  const recent = all.slice(-limit)

  ctx.fixture.note('sessionEventCount', all.length)
  ctx.fixture.note('sessionEvents', recent)
  ctx.fixture.note('sessionEventTypes', [...new Set(all.map((event) => event.type))])
  ctx.fixture.note('sessionEventSeqMonotonic', isMonotonicSeq(all.map((event) => event.seq)))
}

/* ------------------------------------------------------------------- goal -- */

async function runGoal(ctx: DriverContext, spec: GoalAction): Promise<void> {
  const goals = ctx.host.service('goals') as GoalsServiceLike | undefined
  if (typeof goals?.get !== 'function' || typeof goals.create !== 'function') {
    throw new SkipCase('宿主的 goals 服务形状不完整（缺 get / create），无法驱动目标状态机')
  }
  const agent = resolveInitiator(ctx.host.service('agents'))
  if (agent === undefined || agent === null) {
    throw new SkipCase('拿不到当前 agent——目标服务需要**确切的活 agent** 作为授权凭据')
  }

  const state = states.get(ctx.fixture)
  ctx.fixture.note('goalOp', spec.op)
  ctx.fixture.note('goalError', undefined)
  ctx.fixture.note('goalErrorCode', undefined)

  try {
    switch (spec.op) {
      case 'get':
        break

      case 'create': {
        const view = goals.create(agent, {
          objective: spec.objective,
          ...(spec.maxGoalRounds === undefined ? {} : { maxGoalRounds: spec.maxGoalRounds }),
        })
        noteGoal(ctx, state, view)
        ctx.fixture.note('goalCreatedPhase', asStringOf(view, 'phase'))
        ctx.fixture.note('goalCreatedActivation', asStringOf(view, 'activation'))
        if (state) state.goalCreated = true

        // 安全阀：create 会 arm 自动续轮，默认立刻收回授权（不动持久 phase）
        if (spec.disarmAfter !== false && typeof goals.disarm === 'function') {
          const disarmed = goals.disarm(agent)
          ctx.fixture.note('goalAfterDisarmActivation', asStringOf(disarmed, 'activation'))
          noteGoal(ctx, state, disarmed)
        }
        break
      }

      case 'disarm': {
        const view = goals.disarm?.(agent)
        ctx.fixture.note('goalAfterDisarmActivation', asStringOf(view, 'activation'))
        noteGoal(ctx, state, view)
        break
      }

      case 'edit': {
        const ref = requireRef(ctx, goals, agent, state)
        noteGoal(
          ctx,
          state,
          goals.edit?.(agent, ref, {
            ...(spec.objective === undefined ? {} : { objective: spec.objective }),
            ...(spec.maxGoalRounds === undefined ? {} : { maxGoalRounds: spec.maxGoalRounds }),
          }),
        )
        break
      }

      case 'block': {
        const ref = requireRef(ctx, goals, agent, state)
        noteGoal(ctx, state, goals.block?.(agent, ref, { code: spec.code, message: spec.message }))
        break
      }

      case 'pause':
      case 'resume':
      case 'complete':
      case 'clear': {
        const ref = requireRef(ctx, goals, agent, state)
        const fn = goals[spec.op]
        if (typeof fn !== 'function') throw new Error(`goals 服务不提供 ${spec.op}()`)
        const view = (fn as (a: unknown, r: GoalRefLike) => GoalViewLike | GoalRefLike)(
          agent,
          ref,
        )
        if (spec.op === 'clear') {
          // clear 返回的是**墓碑 ref**（不是 view）
          const cleared = view as GoalRefLike
          ctx.fixture.note('goalClearedRevision', asNumber(cleared?.revision))
          if (state) state.goalRef = undefined
        } else {
          noteGoal(ctx, state, view as GoalViewLike)
        }
        break
      }

      default:
        throw new Error(`未知的目标操作：${String((spec as { op?: unknown }).op)}`)
    }

    const final = goals.get(agent)
    ctx.fixture.note('goalExists', final !== undefined)
    if (final !== undefined) noteGoal(ctx, state, final)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.fixture.note('goalError', message)
    ctx.fixture.note('goalErrorCode', extractGoalCode(error))
    // `edit` / `pause` / `resume` / `complete` / `clear` 在 DSH 里是 **@Remote 方法**：
    // 直接本地调用会崩在内部属性访问上（不是 GoalError）。把这种崩溃翻译成
    // 可执行的结论，而不是让人去读堆栈——实测见 SCENARIO-SPEC §3.5。
    ctx.fixture.note('goalRemoteOpRequired', REMOTE_OP_MISUSE.test(message) ? true : undefined)
  }
}

/** `@Remote` 方法被本地直调时的崩溃形态（活宿主实测）。 */
const REMOTE_OP_MISUSE =
  /Cannot read properties of undefined \(reading '(?:transition|prepareMutation|mutate|commit|journal)'\)/

function requireRef(
  ctx: DriverContext,
  goals: GoalsServiceLike,
  agent: unknown,
  state: SessionState | undefined,
): GoalRefLike {
  const ref = state?.goalRef ?? currentRef(goals, agent)
  if (ref === undefined) {
    throw new Error('需要先有一个当前目标（先 create，或宿主里已经存在一个）才能执行这个操作')
  }
  return ref
}

function currentRef(goals: GoalsServiceLike, agent: unknown): GoalRefLike | undefined {
  const view = goals.get?.(agent)
  if (view === undefined) return undefined
  const id = view.id
  const revision = view.revision
  if (typeof id !== 'string' || typeof revision !== 'number') return undefined
  return { id, revision }
}

/** 把一次目标视图写进取证，并记住它的 ref（后续操作用）。 */
function noteGoal(ctx: DriverContext, state: SessionState | undefined, view: unknown): void {
  if (view === null || typeof view !== 'object') return
  const record = view as GoalViewLike
  ctx.fixture.note('goalId', typeof record.id === 'string' ? record.id : undefined)
  ctx.fixture.note('goalRevision', typeof record.revision === 'number' ? record.revision : undefined)
  ctx.fixture.note('goalPhase', typeof record.phase === 'string' ? record.phase : undefined)
  ctx.fixture.note(
    'goalActivation',
    typeof record.activation === 'string' ? record.activation : undefined,
  )
  ctx.fixture.note(
    'goalObjective',
    typeof record.objective === 'string' ? record.objective : undefined,
  )
  ctx.fixture.note(
    'goalRoundsStarted',
    typeof record.roundsStarted === 'number' ? record.roundsStarted : undefined,
  )
  if (state && typeof record.id === 'string' && typeof record.revision === 'number') {
    state.goalRef = { id: record.id, revision: record.revision }
  }
}

function asStringOf(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const field = (value as Record<string, unknown>)[key]
  return typeof field === 'string' ? field : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
