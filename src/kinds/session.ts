/**
 * kind: session —— 人类命令面。
 *
 * ## 为什么 act 直接调我们注册的 handler，而不是 `commands.execute(...)`
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
 * ## 契约（`ctx.commands.register`）
 *
 * ```ts
 * register({ name, description, input?: { hint, attachments? }, recordInput?, handler })
 * handler(invocation: { commandId, agent, rawInput, attachments, signal })
 *   => { kind: 'success'; text? } | { kind: 'error'; text }
 * ```
 *
 * 注意 `CommandResult` 的 **error 是返回值、不是抛出**：
 * `{ kind: 'error', text }` 是正常的失败表达；抛异常是另一条路径
 * （DSH 把它 settle 成 `kind: 'error'`）。两种都能测，本 driver 都支持。
 */

import type { Scenario, StepAction } from '../cases/types.js'
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

export interface SessionSetup {
  command?: SessionCommandSpec
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

/**
 * 已注册命令的旁路索引。
 *
 * 为什么用 WeakMap 而不是塞进 Fixture.notes：notes 会被序列化进报告，
 * 函数字段会在 JSON 化时丢失——存进去反而制造"看起来有、实际取不到"的假象。
 */
const commandIndex = new WeakMap<object, Map<string, CommandDefinition>>()

export const sessionDriver: Driver = {
  kind: 'session',
  description: '注册临时人类命令并驱动它（测命令行为，不含 DSH 的分发逻辑）',
  // 命令需要 commands 能力；具体在 setup 里检查，方便跳过时给出原因
  requires: ['commands'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { session?: SessionSetup }).session
    if (!setup?.command) return

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
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('session' in action)) {
      throw new Error(
        `session driver 只支持 \`session\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const spec = action.session
    if (!('command' in spec)) {
      throw new Error('session 动作必须包含 command')
    }

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
  },
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
