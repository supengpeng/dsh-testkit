/**
 * kind: tool —— 工具注册、行为制造与经真实管道的调用取证。
 *
 * ## 干预手段的选择（有依据，别随手换）
 *
 * DSH 的 `tools` 服务提供三种拦截方式，成本与语义各不相同：
 *
 * | 手段 | 语义 | 用途 |
 * |---|---|---|
 * | `tools.guard(fn)` | **同步**检查，返回字符串即拒绝 | 同步拒绝（`decision: deny`） |
 * | `tools/pre-execute` waterfall | 可 allow / deny / cancel / ask（可 await） | 需要**异步判断**或 `ask`/`cancel` 的决策 |
 * | `tools/post-execute` waterfall | 可 accept / replace / block | 改写或阻塞**已产生的结果** |
 *
 * 为什么 `deny` 默认仍走 guard：guard 是**同步**的，代价最低，且**与注册顺序无关**
 * （DSH 自己的开发指引：要让拒绝不受顺序影响就用 guard）。
 * 而 `ask` 只有 waterfall 能表达——它要 await 审批。
 *
 * ## waterfall listener 的形态（实测契约，别猜）
 *
 * ```js
 * ctx.on('tools/pre-execute',  async (exec, next) => { … })          // 不拥有决策 → return next()
 * ctx.on('tools/post-execute', async (exec, result, next) => { … })  // 同上
 * ```
 *
 * 证据（两处）：`@deepseek-ai/dsh-experimental-auto-review` 的 `tools/pre-execute`
 * 监听器与 `@deepseek-ai/dsh-hooks-codex` 的两条监听器，都是
 * 「不匹配就 `return next()`、拥有决策才返回 decision 对象」，并支持 `{ prepend: true }`。
 *
 * ## 上下文约定
 *
 * `dsh.engines` 必须为 `>=0.2.0-rc.2`（`tools.execute` / `tools.guard` 的契约版本）。
 */

import type { Scenario, StepAction } from '../cases/types.js'
import { SkipCase, type Driver, type DriverContext, type ToolDefinition } from './types.js'

/** `tools` 服务的最小面（不 import DSH 类型，保持本文件可独立编译）。 */
interface ToolsServiceLike {
  execute?: (input: {
    callId: string
    name: string
    arguments: unknown
    signal: AbortSignal
  }) => Promise<ToolExecutionResultLike> | ToolExecutionResultLike
  guard?: (guard: (execution: { name?: string }) => string | undefined) => () => void
}

interface ToolExecutionResultLike {
  isError?: boolean
  value?: unknown
  content?: unknown
  error?: { message?: string }
}

/** `setup.tool.register` 的声明形状。 */
export interface ToolRegisterSpec {
  name: string
  description?: string
  parameters?: Record<string, unknown>
  /** 直接返回该值。 */
  returns?: unknown
  /** 让工具抛错（优先于 returns）。 */
  throws?: string
  /** 延迟返回（毫秒），可与 returns 组合。 */
  delayMs?: number
  /** 生成大值（与 returns 互斥，优先于 returns）。 */
  generate?: {
    kind: 'repeat-string'
    char?: string
    times: number
  }
}

/** 单个 guard 的声明。 */
export interface ToolGuardSpec {
  /** 拒绝理由。留空 = 放行——用于**观察是否被询问到**（配合 `record`）。 */
  reason?: string
  /** 记账标签：这个 guard 只要被询问过，就会记进 `fx.guardCalls`。 */
  record?: string
  /** 让这个 guard 抛错（测异常路径）。 */
  throws?: string
}

/** `tools/pre-execute` 能给出的四种决策（对应 `PreToolDecision`）。 */
export type PreToolDecisionKind = 'allow' | 'deny' | 'ask' | 'cancel'

/** `tools/post-execute` 能给出的三种动作（对应 `PostToolDecision`）。 */
export type PostToolDecisionKind = 'accept' | 'replace' | 'block'

/**
 * `setup.tool.preExecute` 的声明形状：dispatch **之前**的决策。
 *
 * `allow` 与 `accept` 都表示「不拥有决策」——按 DSH 的约定 `return next()`，
 * 把决定权交回链上的其它 listener。
 */
export interface ToolPreExecuteSpec {
  /** 只对该工具名的调用生效；缺省继承 `setup.tool.register.name`。 */
  name?: string
  /** 单次决策。与 `decisions` 二选一（给了 `decisions` 以它为准）。 */
  decision?: PreToolDecisionKind
  /** 按第 N 次匹配调用取不同决策（用来在一条场景里覆盖多种决策）。 */
  decisions?: readonly PreToolDecisionKind[]
  /** `deny` / `ask` 的理由。 */
  reason?: string
  /** `deny` 时附带的稳定错误码（写进 `info.code`）。 */
  code?: string
  /** `deny` 时附带的错误名（写进 `info.name`，缺省 `ToolError`）。 */
  errorName?: string
  /** `ask` 时的多语言展示理由（对应 `displayReason`）。 */
  displayReason?: { en: string; [locale: string]: string }
  /** 让监听器抛错（测异常路径）。 */
  throws?: string
  /**
   * 决策前先 `await next()` 读**下游**决策，再决定是否覆盖。
   *
   * 这是真实插件常用的组合语义：下游已经拒绝时不该被本层改成放行。
   */
  awaitDownstream?: boolean
  /** 排到 listener 链最前（对应 `ctx.on` 的 `{ prepend: true }`）。 */
  prepend?: boolean
}

/** `setup.tool.postExecute` 的声明形状：改写或阻塞**已产生**的结果。 */
export interface ToolPostExecuteSpec {
  /** 只对该工具名的调用生效；缺省继承 `setup.tool.register.name`。 */
  name?: string
  /** 单次动作。与 `actions` 二选一（给了 `actions` 以它为准）。 */
  action?: PostToolDecisionKind
  /** 按第 N 次匹配调用取不同动作。 */
  actions?: readonly PostToolDecisionKind[]
  /** `replace` 时替换成的文本（优先于 `value`）。 */
  text?: string
  /** `replace` 时替换成的值（与实现里的 `{ kind:'accept', value }` 对应）。 */
  value?: unknown
  /** `block` 时的反馈文本。 */
  feedback?: string
  /** 让监听器抛错（测异常路径）。 */
  throws?: string
  /** 排到 listener 链最前。 */
  prepend?: boolean
}

/** `setup.tool.intercept` 的声明形状。 */
export interface ToolInterceptSpec {
  /**
   * 要拦截的工具名。
   *
   * 可以省略——缺省继承 `setup.tool.register.name`（拦截自己刚注册的工具是最常见的情形）。
   * 若两者都没有，driver 会明确报错而不是静默放行。
   */
  name?: string
  decision?: 'allow' | 'deny' | 'ask' | 'cancel'
  reason?: string
  /**
   * 装**多个** guard。
   *
   * 这是为了测**短路语义**：若第一个 guard 拒绝后不再询问后续 guard，
   * 那后面的 `record` 就不会出现在 `fx.guardCalls` 里。
   * 单 guard 形式看不出这个区别——而它决定了"多个拦截器叠加时的代价与行为"。
   *
   * 与 `decision` 二选一；同时给出时以本字段为准。
   */
  guards?: ToolGuardSpec[]
}

export interface ToolSetup {
  register?: ToolRegisterSpec
  intercept?: ToolInterceptSpec
  /** dispatch **之前**的决策（真实 `tools/pre-execute` waterfall）。 */
  preExecute?: ToolPreExecuteSpec
  /** 对**已产生**结果的动作（真实 `tools/post-execute` waterfall）。 */
  postExecute?: ToolPostExecuteSpec
}

/** 把 `generate` 声明变成实际值。 */
export function generateValue(spec: NonNullable<ToolRegisterSpec['generate']>): unknown {
  switch (spec.kind) {
    case 'repeat-string': {
      const char = spec.char ?? 'A'
      const times = Math.max(0, Math.floor(Number(spec.times) || 0))
      return char.repeat(times)
    }
    default:
      throw new Error(`未知的 generate.kind：${String((spec as { kind: string }).kind)}`)
  }
}

/** 按声明决定这次工具执行该产生什么。导出以便单测直接覆盖。 */
export async function runToolBehavior(
  spec: ToolRegisterSpec,
  signal: AbortSignal,
): Promise<unknown> {
  if (spec.throws !== undefined) throw new Error(spec.throws)
  if (typeof spec.delayMs === 'number' && spec.delayMs > 0) {
    await delay(spec.delayMs, signal)
  }
  if (spec.generate !== undefined) return generateValue(spec.generate)
  return spec.returns ?? null
}

/** 从内容块数组里抽出纯文本（用于 `fx.resultText` 断言）。 */
export function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 按调用序号从「单值 / 列表」里取一项。
 *
 * 为什么需要它：一条场景的 `setup` 只有一份声明，但多步 `act` 会多次经过同一个
 * listener。`decisions: [deny, ask, cancel]` 让一条场景覆盖三种决策，
 * 而不必为每种决策各写一条 case。
 */
export function pickByCallIndex<T>(
  single: T | undefined,
  list: readonly T[] | undefined,
  callIndex: number,
): T | undefined {
  if (list !== undefined && list.length > 0) {
    const at = Math.max(0, callIndex - 1)
    return list[Math.min(at, list.length - 1)]
  }
  return single
}

/**
 * 构造 `PreToolDecision`。
 *
 * 返回 `undefined` 表示**不拥有决策**（调用方据此 `return next()`）——
 * 这条约定是 DSH 稳定性指引明确要求的，写错会让别人的 listener 失效。
 *
 * 导出以便单测直接覆盖。
 */
export function buildPreDecision(
  spec: ToolPreExecuteSpec,
  callIndex: number,
): Record<string, unknown> | undefined {
  const decision = pickByCallIndex(spec.decision, spec.decisions, callIndex)
  switch (decision) {
    case undefined:
      throw new Error('setup.tool.preExecute 需要 decision 或 decisions')
    case 'allow':
      return undefined
    case 'deny': {
      const info: Record<string, unknown> = {
        name: spec.errorName ?? 'ToolError',
        ...(spec.code === undefined ? {} : { code: spec.code }),
        ...(spec.reason === undefined ? {} : { reason: spec.reason }),
      }
      return {
        kind: 'deny',
        reason: spec.reason ?? `dsh-testkit 拒绝了 ${spec.name ?? '这次调用'}`,
        ...(spec.code === undefined && spec.errorName === undefined ? {} : { info }),
      }
    }
    case 'cancel':
      return { kind: 'cancel' }
    case 'ask':
      return {
        kind: 'ask',
        ...(spec.reason === undefined ? {} : { reason: spec.reason }),
        ...(spec.displayReason === undefined ? {} : { displayReason: spec.displayReason }),
      }
    default:
      throw new Error(`未知的 preExecute 决策：${String(decision)}`)
  }
}

/**
 * 构造 `PostToolDecision`。
 *
 * 返回 `undefined` 表示**不拥有决策**（调用方 `return next()`，即原样接受）。
 *
 * 导出以便单测直接覆盖。
 */
export function buildPostDecision(
  spec: ToolPostExecuteSpec,
  callIndex: number,
): Record<string, unknown> | undefined {
  const action = pickByCallIndex(spec.action, spec.actions, callIndex)
  switch (action) {
    case undefined:
      throw new Error('setup.tool.postExecute 需要 action 或 actions')
    case 'accept':
      return undefined
    case 'replace':
      return spec.text === undefined
        ? { kind: 'accept', value: spec.value ?? null }
        : { kind: 'accept', content: [{ type: 'text', text: spec.text }] }
    case 'block':
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: spec.feedback ?? 'dsh-testkit 阻塞了这次结果' }],
      }
    default:
      throw new Error(`未知的 postExecute 动作：${String(action)}`)
  }
}

/** 把决策对象压成报告友好的摘要（避免把整棵对象塞进报告）。 */
export function summarizeDecision(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  return {
    kind: typeof record['kind'] === 'string' ? record['kind'] : undefined,
    reason: typeof record['reason'] === 'string' ? record['reason'] : undefined,
    code:
      record['info'] !== null && typeof record['info'] === 'object'
        ? (record['info'] as Record<string, unknown>)['code']
        : undefined,
  }
}

export const toolDriver: Driver = {
  kind: 'tool',
  description: '注册临时工具 / 按声明制造返回行为 / 经真实工具管道调用并取证',
  requires: ['tools'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { tool?: ToolSetup }).tool
    if (!setup) return

    if (setup.register) {
      const spec = setup.register
      const definition: ToolDefinition = {
        name: spec.name,
        description: spec.description ?? `dsh-testkit 临时工具 ${spec.name}`,
        parameters:
          spec.parameters ?? { type: 'object', properties: {}, additionalProperties: false },
        execute: (_args, exec) => runToolBehavior(spec, exec.signal),
      }
      // 注册必须经 Fixture 登记，场景结束逆序释放
      ctx.fixture.add(`tool:register:${spec.name}`, ctx.host.registerTool(definition))
      ctx.fixture.note('registeredTools', [
        ...((ctx.fixture.getNote('registeredTools') as string[] | undefined) ?? []),
        spec.name,
      ])
    }

    // 由 intercept 合成的 pre-execute 声明：intercept 的 ask / cancel 只有 waterfall 能表达，
    // 所以它们不再是"Phase 2 跳过"，而是转到这里实现。
    let synthesizedPreExecute: ToolPreExecuteSpec | undefined

    if (setup.intercept) {
      const spec = setup.intercept

      // 拦截目标：显式给的优先，否则继承刚注册的那个工具。
      // 两者都没有就明确报错——早先这里是直接放行，导致"场景看起来通过但什么都没拦"。
      const target = spec.name ?? setup.register?.name
      if (target === undefined) {
        throw new Error(
          'setup.tool.intercept 需要 name，或在 setup.tool.register 里给出 name 供其继承',
        )
      }

      if (spec.decision === 'ask' || spec.decision === 'cancel') {
        synthesizedPreExecute = {
          name: target,
          decision: spec.decision,
          ...(spec.reason === undefined ? {} : { reason: spec.reason }),
        }
        ctx.fixture.note('interceptVia', 'tools/pre-execute')
      } else {
        const tools = ctx.host.service('tools') as ToolsServiceLike | undefined
        if (typeof tools?.guard !== 'function') {
          throw new SkipCase('宿主的 tools 服务不提供 guard()，无法实施拦截')
        }

        // 多 guard 形式优先；否则由 decision 推导出单个
        const guardSpecs: ToolGuardSpec[] =
          spec.guards !== undefined && spec.guards.length > 0
            ? spec.guards
            : spec.decision === 'allow'
              ? []
              : [
                  {
                    reason: spec.reason ?? `dsh-testkit 拦截了 ${target}`,
                    record: spec.decision ?? 'deny',
                  },
                ]

        if (guardSpecs.length === 0) {
          // 默认即为放行，无需安装任何干预——显式声明只是让意图可读
          ctx.fixture.note('interceptNote', `allow 是默认行为，未安装干预`)
        }

        const labels = guardSpecs.map((g, i) => g.record ?? `guard-${i + 1}`)
        const asked: string[] = []

        for (const [index, guardSpec] of guardSpecs.entries()) {
          const label = labels[index] ?? `guard-${index + 1}`
          const dispose = tools.guard((execution) => {
            // 每次被**询问**都记账——不管最后是否拒绝。
            // 这正是"短路与否"的证据：被拒绝后若还继续问，后续标签就会出现。
            asked.push(label)
            ctx.fixture.note('guardCalls', [...asked])

            if (execution?.name !== target) return undefined
            if (guardSpec.throws !== undefined) throw new Error(guardSpec.throws)
            return guardSpec.reason
          })
          ctx.fixture.add(`tool:guard:${target}:${label}`, dispose)
        }

        if (guardSpecs.length > 0) {
          ctx.fixture.note('guardLabels', labels)
        }
      }
    }

    const preExecute = setup.preExecute ?? synthesizedPreExecute
    if (preExecute) {
      const target = preExecute.name ?? setup.register?.name
      if (target === undefined) {
        throw new Error(
          'setup.tool.preExecute 需要 name，或在 setup.tool.register 里给出 name 供其继承',
        )
      }
      installPreExecute(ctx, preExecute, target)
    }

    if (setup.postExecute) {
      const target = setup.postExecute.name ?? setup.register?.name
      if (target === undefined) {
        throw new Error(
          'setup.tool.postExecute 需要 name，或在 setup.tool.register 里给出 name 供其继承',
        )
      }
      installPostExecute(ctx, setup.postExecute, target)
    }
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('tool' in action)) {
      throw new Error(
        `tool driver 只支持 \`tool\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const tools = ctx.host.service('tools') as ToolsServiceLike | undefined
    if (typeof tools?.execute !== 'function') {
      throw new Error('宿主的 tools 服务不提供 execute()，无法调用工具')
    }

    const callIndex = ((ctx.fixture.getNote('callCount') as number | undefined) ?? 0) + 1
    ctx.fixture.note('callCount', callIndex)
    ctx.fixture.noteAppend('calls', {
      index: callIndex,
      name: action.tool,
      args: action.args ?? {},
    })

    const startedAt = Date.now()
    const result = await tools.execute({
      callId: `testkit-${callIndex}`,
      name: action.tool,
      arguments: action.args ?? {},
      signal: ctx.signal,
    })
    const durationMs = Date.now() - startedAt

    const text = contentToText(result?.content)
    ctx.fixture.note('lastResult', {
      name: action.tool,
      isError: result?.isError === true,
      durationMs,
    })
    ctx.fixture.note('resultText', text)
    ctx.fixture.note('resultLength', text.length)
    ctx.fixture.note('resultValue', result?.value)
    // 字符串返回值的精确长度（非字符串为 undefined）——用于断言"有没有被中途截断"
    ctx.fixture.note(
      'resultValueLength',
      typeof result?.value === 'string' ? result.value.length : undefined,
    )
    // 成功时显式记 undefined，让 `exists: false` 能表达"没有出错"
    ctx.fixture.note(
      'callError',
      result?.isError === true ? (result.error?.message ?? '工具执行失败') : undefined,
    )
  },
}

/* ------------------------------------------------------- pre-execute 安装 -- */

interface ToolExecLike {
  name?: unknown
  arguments?: unknown
}

/** 把 waterfall listener 的实参拆成 payload 与 next（next 缺席时退化为"纯返回值"）。 */
function splitListenerArgs(args: readonly unknown[]): {
  exec: ToolExecLike
  result: unknown
  hasResult: boolean
  proceed: (() => Promise<unknown>) | undefined
} {
  const exec = (args[0] ?? {}) as ToolExecLike
  const tail = args[args.length - 1]
  const proceed = typeof tail === 'function' ? (tail as () => Promise<unknown>) : undefined
  // post-execute 的实参是 (exec, result, next)；pre-execute 是 (exec, next)。
  // 用「第二个参数不是函数」来兜住 next 缺席的框架实现，避免把 result 误判成 next。
  const hasResult = args.length >= 3 || (args.length === 2 && typeof args[1] !== 'function')
  return { exec, result: hasResult ? args[1] : undefined, hasResult, proceed }
}

/** 安装 `tools/pre-execute` 监听器（经 Fixture 登记）。 */
function installPreExecute(ctx: DriverContext, spec: ToolPreExecuteSpec, target: string): void {
  let count = 0
  const label = `tool:pre-execute:${target}`

  const dispose = ctx.host.on(
    'tools/pre-execute',
    async (...args: unknown[]) => {
      const { exec, proceed } = splitListenerArgs(args)
      // 不匹配的调用必须 `return next()`：直接返回 undefined 会让别人的决策失效
      if (exec.name !== target) return proceed ? await proceed() : undefined

      count += 1
      ctx.fixture.note('preExecuteCount', count)
      ctx.fixture.noteAppend('preExecuteCalls', {
        index: count,
        name: exec.name,
        args: exec.arguments,
      })

      if (spec.throws !== undefined) throw new Error(spec.throws)

      if (spec.awaitDownstream === true) {
        const downstream = proceed ? await proceed() : undefined
        ctx.fixture.note('preExecuteDownstream', summarizeDecision(downstream))
        const downstreamKind =
          downstream !== null && typeof downstream === 'object'
            ? (downstream as { kind?: unknown }).kind
            : undefined
        // 下游已拒绝：不覆盖更严格的决定（真实插件的组合语义）
        if (downstreamKind === 'deny' || downstreamKind === 'cancel') {
          ctx.fixture.note('preExecuteDecision', summarizeDecision(downstream))
          return downstream
        }
      }

      const decision = buildPreDecision(spec, count)
      ctx.fixture.note('preExecuteDecision', summarizeDecision(decision ?? { kind: 'allow' }))
      if (decision === undefined) return proceed ? await proceed() : undefined
      return decision
    },
    spec.prepend === true ? { prepend: true } : undefined,
  )

  ctx.fixture.add(label, dispose)
}

/* ------------------------------------------------------ post-execute 安装 -- */

/** 安装 `tools/post-execute` 监听器（经 Fixture 登记）。 */
function installPostExecute(ctx: DriverContext, spec: ToolPostExecuteSpec, target: string): void {
  let count = 0
  const label = `tool:post-execute:${target}`

  const dispose = ctx.host.on(
    'tools/post-execute',
    async (...args: unknown[]) => {
      const { exec, result, hasResult, proceed } = splitListenerArgs(args)
      if (exec.name !== target) return proceed ? await proceed() : undefined

      count += 1
      const resultText = contentToText(
        hasResult && result !== null && typeof result === 'object'
          ? (result as { content?: unknown }).content
          : undefined,
      )
      ctx.fixture.note('postExecuteCount', count)
      ctx.fixture.noteAppend('postExecuteCalls', {
        index: count,
        name: exec.name,
        isError:
          hasResult && result !== null && typeof result === 'object'
            ? (result as { isError?: unknown }).isError === true
            : undefined,
        resultText,
      })
      ctx.fixture.note('postExecuteOriginal', resultText)

      if (spec.throws !== undefined) throw new Error(spec.throws)

      const decision = buildPostDecision(spec, count)
      ctx.fixture.note(
        'postExecuteDecision',
        decision === undefined ? { kind: 'accept' } : summarizeDecision(decision),
      )
      if (decision === undefined) return proceed ? await proceed() : undefined
      return decision
    },
    spec.prepend === true ? { prepend: true } : undefined,
  )

  ctx.fixture.add(label, dispose)
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
