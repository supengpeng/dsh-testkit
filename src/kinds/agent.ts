/**
 * kind: agent —— 端到端：派生一个**真实子 agent** 跑任务并断言轨迹。
 *
 * ## ⚠️ 与其它 driver 的本质区别
 *
 * 前六个 driver 都是「造条件」——注册监听、造假 provider、注入提示词，**不花 token**。
 * 这一个不是：它会**真的派生一个子 agent、真的调模型、真的产出结果**。
 *
 * 所以 agent 类场景要克制使用：
 *   - 它是**黑盒**用例，适合"端到端结果不对"这类说不清归类的 issue
 *   - 结论清楚后应**下沉**到精确 kind（`tool` / `llm` / `prompt` …），黑盒那条保留当回归网
 *
 * ## 两条通道（`setup.agent.mode`）
 *
 * | mode | 入口 | 语义 | 代价 |
 * |---|---|---|---|
 * | `one-shot`（默认） | `ctx.subagents.start()` | 一次性运行，父级只收最终输出 | 跑完即 `dispose`，不留痕 |
 * | `teammate` | `ctx.agentTeams.spawnTeammate()` | **复用 Agent Teams**：durable 可续接 child | **成员永久留痕**，占 `maxMembers`，名字不可复用 |
 *
 * 两条通道共用同一个 subagent provider（实测注册名 `spawn` / `fork`），
 * 差别在**上层**：`teammate` 会向 Lead 会话日志追加 `team/member` 记录，
 * 进入 roster / mailbox / 任务板；`one-shot` 只留一条 `subagent/catalog` 事实。
 *
 * ## 契约（`ctx.subagents`）
 *
 * ```ts
 * subagents.list(): string[]                                  // 已注册的 provider 名
 * subagents.start(name, request): Promise<SubagentRun>
 * request    = { label?, prompt: ContentBlock[], parent: Agent, signal, agentOptions?, toolFilter?, persona? }
 * run.result : Promise<SubagentResult>   // { output, structured?, diagnostic?, stopReason }
 * run.dispose(): Promise<void>
 * ```
 *
 * ## 契约（`ctx.agentTeams`）
 *
 * ```ts
 * agentTeams.tryMembership(agent): { root, id, role: 'lead' | 'teammate', name } | undefined
 * agentTeams.listMembers(caller): TeamMemberView[]      // 首行是 Lead 伪行
 * agentTeams.spawnTeammate(caller, request): Promise<{ member: TeamMemberView }>
 *   request = { name, description, prompt: ContentBlock[], context: 'fresh' | 'fork', provider, signal }
 * agentTeams.waitForChange(caller, timeoutMs, signal): Promise<TeamWaitResult>   // 等下一次团队变化
 * agentTeams.interrupt(caller, targetName): { previousStatus }                    // 只停当前轮次
 * ```
 *
 * `parent` 从 `ctx.agents.currentInitiator()` 取——它沿同一条异步驱动链传递，
 * 所以在本插件被模型调用的工具里能拿到发起者。**只有 Lead 能创建 teammate**，
 * 所以团队成员会话里跑 team 动作会**跳过**（而不是失败）。
 *
 * ## 为什么不强绑 provider 名
 *
 * provider 名由宿主注册（headless profile 里是 `subagent-spawn-in-process` 之类），
 * 不同组合下可能不同。所以本 driver 默认取 `subagents.list()` 的第一个，
 * 也允许场景显式指定；名不对时**跳过并列出可用名**，而不是猜。
 *
 * ## teammate 的结果怎么取
 *
 * 团队通道**没有** `run.result`——它是异步协作原语，不是同步委派。
 * 所以输出走 `session/event`：driver 在 spawn 前挂监听，只收**那个 child 会话**的
 * `assistant/message` 事件，等成员转为 `inactive` 后把文本记为 `fx.teammateOutput`。
 */

import type { Scenario, StepAction } from '../cases/types.js'
import { contentToText } from './tool.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

interface SubagentRunLike {
  id?: unknown
  localAgent?: unknown
  result: Promise<SubagentResultLike>
  dispose?: () => Promise<void>
}

interface SubagentResultLike {
  output?: unknown
  structured?: unknown
  diagnostic?: string
  stopReason?: unknown
}

interface SubagentsServiceLike {
  list?: () => string[]
  start?: (name: string, request: Record<string, unknown>) => Promise<SubagentRunLike>
}

interface AgentsServiceLike {
  currentInitiator?: () => unknown
  requireInitiator?: () => unknown
}

/* ------------------------------------------------------------- Agent Teams -- */

/** `agentTeams.tryMembership()` 的最小面。 */
interface TeamMembershipLike {
  role?: unknown
  root?: unknown
  id?: unknown
  name?: unknown
}

/** roster 里的一行（`TeamMemberView`）。 */
interface TeamMemberLike {
  id?: unknown
  name?: unknown
  role?: unknown
  status?: unknown
  description?: unknown
  provider?: unknown
  context?: unknown
  model?: unknown
  diagnostics?: unknown
}

interface AgentTeamsServiceLike {
  tryMembership?: (agent: unknown) => TeamMembershipLike | undefined
  membership?: (agent: unknown) => TeamMembershipLike
  listMembers?: (agent: unknown) => TeamMemberLike[]
  spawnTeammate?: (
    caller: unknown,
    request: Record<string, unknown>,
  ) => Promise<{ member?: TeamMemberLike } | undefined>
  waitForChange?: (caller: unknown, timeoutMs: number, signal: AbortSignal) => Promise<unknown>
  interrupt?: (caller: unknown, targetName: string) => unknown
}

/** 团队成员的终态：只有不再是这两个状态，才算"这一轮跑完了"。 */
const TEAMMATE_BUSY_STATUSES = new Set(['running', 'provisioning'])

/** teammate 名规则与服务端一致（`TeamRoster.memberName`）。 */
const TEAMMATE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** 缺省等 teammate 跑完的上限。 */
export const DEFAULT_TEAMMATE_WAIT_MS = 60_000

/** 轮询 roster 的间隔（`waitForChange` 是事件驱动的优化，不是唯一手段）。 */
const TEAMMATE_POLL_MS = 500

/** `waitForChange` 的时间下限（服务端从 10 秒起，低于它会拒绝）。 */
const TEAM_CHANGE_MIN_MS = 10_000

/** `waitForChange` 的时间上限（服务端上限一小时）。 */
const TEAM_CHANGE_MAX_MS = 3_600_000

export type AgentMode = 'one-shot' | 'teammate'

export interface AgentSetup {
  /** subagent provider 名；缺省取注册表里的第一个（`one-shot`）。 */
  provider?: string
  /** 子 agent 标签（进 catalog）。 */
  label?: string
  /** 模型覆盖（只影响子 agent；`teammate` 通道不支持）。 */
  model?: string
  /** 工具过滤：限制子 agent 能用哪些工具（`teammate` 通道不支持）。 */
  toolFilter?: { allow?: string[]; deny?: string[] }
  /** 人格前缀（`teammate` 通道不支持）。 */
  persona?: string
  /** 通道选择；缺省 `one-shot`（保持既有行为）。 */
  mode?: AgentMode
  /** teammate 名（lower-kebab-case、≤64 字符）；缺省自动生成唯一名。 */
  name?: string
  /** teammate 职责描述；缺省用场景 id 生成。 */
  description?: string
  /** teammate 上下文：`fresh`（缺省，不带 Lead 历史）或 `fork`（带 Lead 已完成轮次）。 */
  context?: 'fresh' | 'fork'
  /** 等 teammate 跑完的上限（毫秒），缺省 `DEFAULT_TEAMMATE_WAIT_MS`。 */
  waitMs?: number
}

/** 已注册的 subagent provider 名（宿主提供）。 */
export function listProviders(service: unknown): string[] {
  const names = (service as SubagentsServiceLike | undefined)?.list?.()
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
}

/** 从 `agents` 服务取当前发起者。 */
export function resolveInitiator(service: unknown): unknown {
  const agents = service as AgentsServiceLike | undefined
  if (typeof agents?.currentInitiator === 'function') {
    try {
      return agents.currentInitiator()
    } catch {
      /* 落回 requireInitiator */
    }
  }
  if (typeof agents?.requireInitiator === 'function') {
    try {
      return agents.requireInitiator()
    } catch {
      return undefined
    }
  }
  return undefined
}

/* ------------------------------------------------------- teammate 纯函数层 -- */

/**
 * 生成一个**唯一**的 lower-kebab teammate 名。
 *
 * 为什么必须唯一：团队名**永不复用**（用过的名字连失败的都保留），
 * 所以第二次跑同一个场景不能撞名。`TK-0027` → `tk-0027-a3f9`。
 *
 * 导出以便单测直接覆盖（不需要真团队）。
 */
export function makeTeammateName(caseId: string, suffix?: string): string {
  const slug =
    caseId
      .toLowerCase()
      .replace(/^tk-/, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'case'
  const tail =
    (suffix ?? Math.random().toString(36).slice(2, 6)).replace(/[^a-z0-9]/g, '').slice(0, 8) || 'x'
  return `tk-${slug}-${tail}`.slice(0, 64)
}

/** 校验 teammate 名；非法时抛错（这是**场景数据错误**，不是宿主缺能力）。 */
export function assertTeammateName(name: string): void {
  if (!TEAMMATE_NAME_RE.test(name) || name.length > 64 || name === 'lead') {
    throw new Error(
      `teammate 名必须是 lower-kebab-case、≤64 字符且不能是 "lead"，实际：${JSON.stringify(name)}`,
    )
  }
}

/** 从 roster 里按名字取一行。 */
export function findMember(members: unknown, name: string): TeamMemberLike | undefined {
  if (!Array.isArray(members)) return undefined
  return members.find((raw): raw is TeamMemberLike => (raw as TeamMemberLike)?.name === name)
}

/** 把 roster 投影成报告友好的精简行（避免把大对象塞进报告）。 */
export function summarizeMembers(members: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(members)) return []
  return members.map((raw) => {
    const member = (raw ?? {}) as TeamMemberLike
    return {
      name: typeof member.name === 'string' ? member.name : undefined,
      role: typeof member.role === 'string' ? member.role : undefined,
      status: typeof member.status === 'string' ? member.status : undefined,
    }
  })
}

/** 读 `agentTeams` 里 caller 的角色（缺服务或非成员时 `undefined`）。 */
export function resolveTeamRole(service: unknown, caller: unknown): string | undefined {
  const teams = service as AgentTeamsServiceLike | undefined
  const membership = readMembership(teams, caller)
  return typeof membership?.role === 'string' ? membership.role : undefined
}

function readMembership(
  teams: AgentTeamsServiceLike | undefined,
  caller: unknown,
): TeamMembershipLike | undefined {
  if (typeof teams?.tryMembership === 'function') {
    try {
      return teams.tryMembership(caller) ?? undefined
    } catch {
      /* 落回 membership（它会抛 TEAM_NOT_MEMBER，由调用方当"非成员"处理） */
    }
  }
  if (typeof teams?.membership === 'function') {
    try {
      return teams.membership(caller)
    } catch {
      return undefined
    }
  }
  return undefined
}

function readMembers(teams: AgentTeamsServiceLike | undefined, caller: unknown): unknown {
  if (typeof teams?.listMembers !== 'function') return []
  try {
    return teams.listMembers(caller) ?? []
  } catch {
    /* roster 读失败按"读不到"处理；等待循环会因此超时而不是崩 */
    return []
  }
}

/**
 * `waitForChange` 缺席或抛错时退化为"只靠轮询"（返回一个永不 settle 的分支）。
 *
 * `onResolve` 只在 wait **正常返回**时触发——被拒绝（例如服务不可用、取消）
 * 不算"团队发生了变化"，否则报告的 `teammateWakeReason` 会把失败说成成功。
 */
function waitForChange(
  teams: AgentTeamsServiceLike | undefined,
  caller: unknown,
  timeoutMs: number,
  signal: AbortSignal,
  onResolve: () => void,
): Promise<unknown> {
  if (typeof teams?.waitForChange !== 'function') return new Promise<never>(() => {})
  try {
    return Promise.resolve(teams.waitForChange(caller, timeoutMs, signal)).then(
      () => {
        onResolve()
      },
      () => undefined,
    )
  } catch {
    return new Promise<never>(() => {})
  }
}

export interface TeammateWaitResult {
  /** 观测到的成员状态（读不到时为 `undefined`）。 */
  status: string | undefined
  waitedMs: number
  /** 这次循环是被团队变化唤醒的，还是轮询到点的。 */
  wakeReason: 'change' | 'poll'
  timedOut: boolean
  /** 结束时的 roster 精简快照。 */
  members: Array<Record<string, unknown>>
}

/**
 * 等一个 teammate 不再是 `running` / `provisioning`。
 *
 * 团队通道没有同步结果，所以"跑完了"的证据就是 roster 状态回落。
 * 两条腿走路：`waitForChange` 会被下一次团队变化唤醒，同时保留轮询兜底
 * （团队成员状态变化不保证每次都发 activity 边）。
 *
 * 导出以便单测直接覆盖（不需要真团队）。
 */
export async function waitForTeammateIdle(
  teams: AgentTeamsServiceLike | undefined,
  caller: unknown,
  name: string,
  options: { timeoutMs: number; pollMs?: number; signal: AbortSignal },
): Promise<TeammateWaitResult> {
  const pollMs = options.pollMs ?? TEAMMATE_POLL_MS
  const startedAt = Date.now()
  let wakeReason: 'change' | 'poll' = 'poll'
  let members = readMembers(teams, caller)

  for (;;) {
    const status = readStatus(members, name)
    if (status !== undefined && !TEAMMATE_BUSY_STATUSES.has(status)) {
      return { status, waitedMs: Date.now() - startedAt, wakeReason, timedOut: false, members: summarizeMembers(members) }
    }

    const elapsed = Date.now() - startedAt
    if (elapsed >= options.timeoutMs) {
      return {
        status,
        waitedMs: elapsed,
        wakeReason,
        timedOut: true,
        members: summarizeMembers(members),
      }
    }

    const remaining = options.timeoutMs - elapsed
    const changeWindow = Math.min(Math.max(remaining, TEAM_CHANGE_MIN_MS), TEAM_CHANGE_MAX_MS)
    await Promise.race([
      sleep(Math.min(pollMs, remaining), options.signal),
      waitForChange(teams, caller, changeWindow, options.signal, () => {
        wakeReason = 'change'
      }),
    ])
    members = readMembers(teams, caller)
  }
}

function readStatus(members: unknown, name: string): string | undefined {
  const status = findMember(members, name)?.status
  return typeof status === 'string' ? status : undefined
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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

/* ---------------------------------------------------------------- driver -- */

/** agent 场景的配置按 Fixture 隔离存放（与 session driver 同一手法）。 */
const agentConfigs = new WeakMap<object, AgentSetup>()

/** teammate 模式的收尾索引：teardown 需要知道该中断谁。 */
const teammateIndex = new WeakMap<object, { name: string; caller: unknown }>()

export const agentDriver: Driver = {
  kind: 'agent',
  description:
    '派生真实子 agent 跑任务并断言轨迹（`one-shot` 走 subagents，`teammate` 复用 Agent Teams；**会真的调模型、花 token**）',
  requires: ['subagents'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { agent?: AgentSetup }).agent
    if (!setup) return

    agentConfigs.set(ctx.fixture, setup)

    if ((setup.mode ?? 'one-shot') === 'teammate') {
      // 团队通道的能力面是 agentTeams，不是 subagents——两者分开探测，
      // 这样"宿主有 subagents 但没装 Agent Teams"能给出准确原因。
      if (!ctx.host.capabilities.has('agentTeams')) {
        throw new SkipCase(
          '宿主不具备 agentTeams 能力（需要挂载 dsh-experimental-agent-team），team 通道不可用',
        )
      }
      return
    }

    const service = ctx.host.service('subagents')
    if (!service) throw new SkipCase('宿主没有 subagents 服务')

    const names = listProviders(service)
    ctx.fixture.note('availableSubagentProviders', names)

    if (names.length === 0) {
      throw new SkipCase('宿主没有注册任何 subagent provider，无法派生')
    }
    if (setup.provider !== undefined && !names.includes(setup.provider)) {
      throw new SkipCase(
        `宿主没有名为「${setup.provider}」的 subagent provider（已注册：${names.join(', ')}）`,
      )
    }
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('agent' in action)) {
      throw new Error(
        `agent driver 只支持 \`agent\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const spec = agentConfigs.get(ctx.fixture) ?? {}
    const mode = action.agent.mode ?? spec.mode ?? 'one-shot'

    if (mode === 'teammate') {
      await runTeammate(ctx, spec, action.agent)
      return
    }

    await runOneShot(ctx, spec, action.agent)
  },

  async teardown(ctx: DriverContext): Promise<void> {
    // teammate 的成员身份**删不掉**（roster 不可变），但跑飞的那一轮必须停掉，
    // 否则它会继续烧 token。只停当前轮次，不动 inbox、不动任务归属。
    const entry = teammateIndex.get(ctx.fixture)
    if (!entry) return
    const teams = ctx.host.service('agentTeams') as AgentTeamsServiceLike | undefined
    if (typeof teams?.interrupt !== 'function') return
    try {
      teams.interrupt(entry.caller, entry.name)
    } catch {
      /* 停止失败不改判定：成员已经留痕，这一点在文档里写明了 */
    }
  },
}

/* --------------------------------------------------------------- one-shot -- */

async function runOneShot(
  ctx: DriverContext,
  spec: AgentSetup,
  action: { prompt: string },
): Promise<void> {
  const subagents = ctx.host.service('subagents') as SubagentsServiceLike | undefined
  if (typeof subagents?.start !== 'function') {
    throw new Error('宿主的 subagents 服务不提供 start()')
  }

  const parent = resolveInitiator(ctx.host.service('agents'))
  if (parent === undefined || parent === null) {
    throw new SkipCase(
      '拿不到当前 agent（agents.currentInitiator 为空）——agent 动作必须在 agent 调用的工具里执行',
    )
  }

  const names = listProviders(subagents)
  const provider = spec.provider ?? names[0]
  if (provider === undefined) {
    throw new SkipCase(`没有可用的 subagent provider（已注册：${names.join(', ') || '无'}）`)
  }

  const request = {
    label: spec.label ?? 'dsh-testkit-child',
    prompt: [{ type: 'text', text: action.prompt }],
    parent,
    signal: ctx.signal,
    ...(spec.model === undefined ? {} : { agentOptions: { model: spec.model } }),
    ...(spec.toolFilter === undefined ? {} : { toolFilter: spec.toolFilter }),
    ...(spec.persona === undefined ? {} : { persona: spec.persona }),
  }

  ctx.fixture.note('agentProvider', provider)
  ctx.fixture.note('agentPrompt', action.prompt)

  const startedAt = Date.now()
  let run: SubagentRunLike | undefined

  try {
    run = await subagents.start(provider, request)
    ctx.fixture.note('agentRunId', String(run?.id ?? ''))
    ctx.fixture.note('agentHasLocalAgent', run?.localAgent !== undefined)

    const result = await run.result
    ctx.fixture.note('agentDurationMs', Date.now() - startedAt)
    ctx.fixture.note(
      'agentStopReason',
      typeof result?.stopReason === 'string' ? result.stopReason : undefined,
    )
    ctx.fixture.note('agentOutput', contentToText(result?.output))
    ctx.fixture.note('agentDiagnostic', result?.diagnostic)
    ctx.fixture.note('agentStructured', result?.structured)
    ctx.fixture.note('agentError', undefined)
  } catch (error) {
    ctx.fixture.note('agentDurationMs', Date.now() - startedAt)
    ctx.fixture.note('agentError', describe(error))
  } finally {
    // run 是 holder-owned：用完必须释放，否则子 agent 的 Activation 会滞留
    try {
      await run?.dispose?.()
    } catch {
      /* 释放失败不覆盖既有取证 */
    }
  }
}

/* --------------------------------------------------------------- teammate -- */

async function runTeammate(
  ctx: DriverContext,
  spec: AgentSetup,
  action: { prompt: string; name?: string },
): Promise<void> {
  const teams = ctx.host.service('agentTeams') as AgentTeamsServiceLike | undefined
  if (!teams || typeof teams.spawnTeammate !== 'function') {
    throw new SkipCase(
      '宿主没有 agentTeams 服务（需要挂载 dsh-experimental-agent-team），无法复用团队通道',
    )
  }
  if (typeof teams.listMembers !== 'function') {
    throw new SkipCase('agentTeams 服务不提供 listMembers()，无法观测 roster')
  }

  const caller = resolveInitiator(ctx.host.service('agents'))
  if (caller === undefined || caller === null) {
    throw new SkipCase(
      '拿不到当前 agent（agents.currentInitiator 为空）——team 动作必须在 agent 调用的工具里执行',
    )
  }

  const role = resolveTeamRole(teams, caller)
  if (role !== 'lead') {
    throw new SkipCase(
      `只有 Team Lead 能创建 teammate（当前角色：${role ?? '非团队成员'}）——团队是扁平的，不支持嵌套`,
    )
  }

  const name = action.name ?? spec.name ?? makeTeammateName(ctx.scenario.id)
  assertTeammateName(name)

  const context = spec.context ?? 'fresh'
  const provider = spec.provider ?? (context === 'fork' ? 'fork' : 'spawn')
  const description = spec.description ?? `dsh-testkit ${ctx.scenario.id} teammate`

  // 团队通道只接受 name/description/prompt/context/provider，其余一次性参数写了也不会生效。
  // 「写了没生效」是最难查的一类失望，所以如实记账而不是静默忽略。
  const ignored = (
    [
      spec.label === undefined ? undefined : 'label',
      spec.model === undefined ? undefined : 'model',
      spec.toolFilter === undefined ? undefined : 'toolFilter',
      spec.persona === undefined ? undefined : 'persona',
    ] as Array<string | undefined>
  ).filter((key): key is string => key !== undefined)
  if (ignored.length > 0) ctx.fixture.note('teammateIgnoredSetup', ignored)

  ctx.fixture.note('agentProvider', provider)
  ctx.fixture.note('agentPrompt', action.prompt)
  ctx.fixture.note('teammateName', name)
  ctx.fixture.note('teammateContext', context)
  ctx.fixture.note('teammateDescription', description)
  ctx.fixture.note('availableSubagentProviders', listProviders(ctx.host.service('subagents')))

  const outputs: string[] = []
  const startedAt = Date.now()
  let childId: string | undefined

  // 必须在 spawn **之前**挂监听：child 的 assistant 消息可能早于我们的下一次读。
  // 只收那个 child 会话的消息——Lead 自己的消息不混淆进来。
  const off = ctx.host.on('session/event', (session: unknown, event: unknown) => {
    if (childId === undefined) return
    const sessionId = (session as { id?: unknown } | undefined)?.id
    if (sessionId !== childId) return
    const typed = event as { type?: unknown; data?: { message?: { content?: unknown } } } | undefined
    if (typed?.type !== 'assistant/message') return
    const text = contentToText(typed.data?.message?.content)
    if (text.trim() !== '') outputs.push(text)
  })

  try {
    const spawned = await teams.spawnTeammate(caller, {
      name,
      description,
      prompt: [{ type: 'text', text: action.prompt }],
      context,
      provider,
      signal: ctx.signal,
    })

    const member = spawned?.member
    childId = typeof member?.id === 'string' ? member.id : undefined
    teammateIndex.set(ctx.fixture, { name, caller })

    ctx.fixture.note('agentRunId', childId ?? '')
    ctx.fixture.note('teammateId', childId)
    ctx.fixture.note(
      'teammateStatus',
      typeof member?.status === 'string' ? member.status : undefined,
    )
    ctx.fixture.note('teammateRole', typeof member?.role === 'string' ? member.role : undefined)

    const wait = await waitForTeammateIdle(teams, caller, name, {
      timeoutMs: spec.waitMs ?? DEFAULT_TEAMMATE_WAIT_MS,
      signal: ctx.signal,
    })

    ctx.fixture.note('teammateFinalStatus', wait.status)
    ctx.fixture.note('teammateWaitMs', wait.waitedMs)
    ctx.fixture.note('teammateWakeReason', wait.wakeReason)
    ctx.fixture.note('teammateWaitTimedOut', wait.timedOut)
    ctx.fixture.note('teammateMembers', wait.members)
    ctx.fixture.note('teammateOutputs', outputList(outputs))
    ctx.fixture.note('teammateOutput', outputText(outputs))
    // 成员留在 roster 是**设计如此**（团队没有删除成员的能力），如实标注
    ctx.fixture.note('teammateRetained', true)
    ctx.fixture.note('agentDurationMs', Date.now() - startedAt)
    ctx.fixture.note('agentError', undefined)
  } catch (error) {
    ctx.fixture.note('agentDurationMs', Date.now() - startedAt)
    ctx.fixture.note('teammateOutputs', outputList(outputs))
    ctx.fixture.note('teammateOutput', outputText(outputs))
    ctx.fixture.note('agentError', describe(error))
  } finally {
    off()
  }
}

/** 只保留非空行，避免报告里出现空串噪声。 */
function outputList(outputs: readonly string[]): string[] {
  return [...outputs]
}

/** 最后一条非空 assistant 文本——teammate 的"产出"。 */
function outputText(outputs: readonly string[]): string | undefined {
  const last = outputs[outputs.length - 1]
  return last === undefined ? undefined : last
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string' ? `${error.name}[${code}]: ${error.message}` : `${error.name}: ${error.message}`
  }
  return String(error)
}
