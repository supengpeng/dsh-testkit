/**
 * kind: tool —— 工具注册、行为制造与经真实管道的调用取证。
 *
 * ## 干预手段的选择（有依据，别随手换）
 *
 * DSH 的 `tools` 服务提供三种拦截方式，成本与语义各不相同：
 *
 * | 手段 | 语义 | 用途 |
 * |---|---|---|
 * | `tools.guard(fn)` | **同步**检查，返回字符串即拒绝 | 本 driver 的 `decision: deny` |
 * | `tools/pre-execute` waterfall | 可 allow / deny / cancel / ask | Phase 2（需要活宿主验证 waterfall 语义） |
 * | `tools/post-execute` waterfall | 可改写结果 | Phase 2（`rewriteResult` 走这条） |
 *
 * Phase 1 只用 `guard` + `execute`：两者语义明确、可用 headless 宿主验证，
 * 而 waterfall 的参数形状（`next()` 链）必须先拿活宿主确认，不猜。
 *
 * ## 上下文约定
 *
 * `dsh.engines` 必须为 `>=0.2.0-rc.2`（`tools.execute` 与 `tools.guard` 的契约版本）。
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
        // ask / cancel 需要 pre-execute waterfall，必须在活宿主确认其 next() 语义
        throw new SkipCase(
          `intercept.decision=${spec.decision} 需要 tools/pre-execute waterfall，属 Phase 2`,
        )
      }

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
