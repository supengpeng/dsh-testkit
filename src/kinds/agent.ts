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
 * `parent` 从 `ctx.agents.currentInitiator()` 取——它沿同一条异步驱动链传递，
 * 所以在本插件被模型调用的工具里能拿到发起者。
 *
 * ## 为什么不强绑 provider 名
 *
 * provider 名由宿主注册（headless profile 里是 `subagent-spawn-in-process` 之类），
 * 不同组合下可能不同。所以本 driver 默认取 `subagents.list()` 的第一个，
 * 也允许场景显式指定；名不对时**跳过并列出可用名**，而不是猜。
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

export interface AgentSetup {
  /** subagent provider 名；缺省取注册表里的第一个。 */
  provider?: string
  /** 子 agent 标签（进 catalog，便于确认它是这次运行产生的）。 */
  label?: string
  /** 模型覆盖（只影响子 agent）。 */
  model?: string
  /** 工具过滤：限制子 agent 能用哪些工具。 */
  toolFilter?: { allow?: string[]; deny?: string[] }
  /** 人格前缀。 */
  persona?: string
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

/** agent 场景的配置按 Fixture 隔离存放（与 session driver 同一手法）。 */
const agentConfigs = new WeakMap<object, AgentSetup>()

export const agentDriver: Driver = {
  kind: 'agent',
  description: '派生真实子 agent 跑任务并断言轨迹（**会真的调模型、花 token**）',
  requires: ['subagents'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { agent?: AgentSetup }).agent
    if (!setup) return

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

    agentConfigs.set(ctx.fixture, setup)
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('agent' in action)) {
      throw new Error(
        `agent driver 只支持 \`agent\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

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
    const spec = agentConfigs.get(ctx.fixture) ?? {}
    const provider = spec.provider ?? names[0]
    if (provider === undefined) {
      throw new SkipCase(`没有可用的 subagent provider（已注册：${names.join(', ') || '无'}）`)
    }

    const request = {
      label: spec.label ?? 'dsh-testkit-child',
      prompt: [{ type: 'text', text: action.agent.prompt }],
      parent,
      signal: ctx.signal,
      ...(spec.model === undefined ? {} : { agentOptions: { model: spec.model } }),
      ...(spec.toolFilter === undefined ? {} : { toolFilter: spec.toolFilter }),
      ...(spec.persona === undefined ? {} : { persona: spec.persona }),
    }

    ctx.fixture.note('agentProvider', provider)
    ctx.fixture.note('agentPrompt', action.agent.prompt)

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
  },
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string' ? `${error.name}[${code}]: ${error.message}` : `${error.name}: ${error.message}`
  }
  return String(error)
}
