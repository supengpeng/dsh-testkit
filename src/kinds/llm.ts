/**
 * kind: llm —— 接管 `llm/stream`，让模型输出由声明决定。
 *
 * ## 契约（从 DSH 发行体里读出来的，不是猜的）
 *
 * 触发点（`@deepseek-ai/dsh-llm/lib/index.js`）：
 * ```js
 * streamWithRegistration(options, prepared) {
 *   return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
 * }
 * ```
 *
 * 于是 listener 的形态是 **cordis 标准 waterfall**：
 * ```ts
 * ctx.on('llm/stream', (options, next) => AsyncIterable<StreamChunk>)
 * ```
 *
 * ⚠️ 两个易错点：
 *   1. `next()` **直接返回 `AsyncIterable`**（不是 `Promise`）。这与
 *      `tools/pre-execute` 那类 `next: () => Promise<...>` 的 waterfall 不同，
 *      照抄会得到 `undefined` 从而静默产出空流。
 *   2. **不调用 `next()` 就完全旁路真实模型**——本 driver 正是靠这一点做到
 *      "零上游请求"。真实范例见 `@deepseek-ai/dsh-llm/lib/invariant.js`：
 *      `ctx.on("llm/stream", (_options, next) => validateStream(next(), fail))`。
 *
 * ## StreamChunk（`dsh-llm` 的联合类型）
 *
 * ```ts
 * { type: 'block-start'; index: number; blockType: ContentBlockType }
 * { type: 'text-delta'; index: number; text: string }
 * { type: 'reasoning-delta'; index: number; text: string }
 * { type: 'tool-call-delta'; index: number; id: ToolCallId; name?: string; argumentsDelta: string }
 * { type: 'block-end'; index: number; block: ContentBlock }
 * { type: 'usage'; usage: TokenUsage }
 * { type: 'finish'; reason: FinishReason }
 * ```
 * `FinishReason` 的 kind 取值：`stop` | `tool-calls` | `max-tokens` | `aborted` | `error`
 * （后两者带 `failure: LlmFailure { message, code }`）。
 *
 * ## 取证为什么可信
 *
 * `fx.mockText` 不是"我们打算产出的文本"，而是**下游实际消费到的流**里累积出来的。
 * 也就是说，它同时证明了"拦截生效"和"chunk 结构被正确识别"。
 */

import type { Scenario, StepAction } from '../cases/types.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

/** 我们能产出的 StreamChunk 子集。 */
export type StreamChunkLike =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: Record<string, unknown> }
  | { type: 'finish'; reason: { kind: string; failure?: { message: string; code: string } } }

interface LlmServiceLike {
  stream?: (options: Record<string, unknown>) => AsyncIterable<StreamChunkLike>
}

export type LlmFailMode = 'none' | 'error' | 'mid-stream-error' | 'timeout' | 'malformed'

export interface LlmRespondSpec {
  /** 文本分块；依次作为 `text-delta` 产出。 */
  chunks?: string[]
  /** finish 的 kind。缺省 `stop`。 */
  finishReason?: 'stop' | 'tool-calls' | 'max-tokens'
  /** 伪造的 token 用量。 */
  usage?: { input: number; output: number }
  /** 每个 chunk 之间的延迟（毫秒）。 */
  delayMs?: number
}

export interface LlmSetup {
  respond?: LlmRespondSpec
  /** 失败注入模式，详见 `buildChunkPlan`。 */
  failMode?: LlmFailMode
  /** `mid-stream-error` 在产出几个 chunk 之后失败（缺省 1）。 */
  failAfterChunks?: number
}

/** 本 driver 注入失败时使用的错误码，便于断言时精确匹配。 */
export const TESTKIT_LLM_ERROR_CODE = 'TESTKIT_LLM_ERROR'

function failure(message: string): { message: string; code: string } {
  return { message, code: TESTKIT_LLM_ERROR_CODE }
}

/**
 * 把声明变成**要产出的 chunk 计划**。
 *
 * 纯函数——不碰宿主、不读时钟，因此可以离线穷举验证。
 * `timeout` 模式返回「只有开头、之后永不产出」的计划，由 `emitChunks` 负责挂住。
 */
export function buildChunkPlan(setup: LlmSetup): StreamChunkLike[] {
  const mode = setup.failMode ?? 'none'
  const chunks = Array.isArray(setup.respond?.chunks) ? setup.respond.chunks : []
  const plan: StreamChunkLike[] = []

  if (mode === 'timeout') {
    // 只产出开头，之后由 emitChunks 挂住——模拟"上游迟迟不响应"。
    // 绝不能走正常路径：那样会先吐出完整内容再挂，语义就错了。
    return [{ type: 'block-start', index: 0, blockType: 'text' }]
  }

  if (mode === 'error') {
    plan.push({ type: 'finish', reason: { kind: 'error', failure: failure('testkit 注入的模型错误') } })
    return plan
  }

  if (mode === 'malformed') {
    // 故意破坏结构：text-delta 缺 text、finish 缺 reason。
    // 用来测下游对畸形 chunk 的健壮性——它**不该**被当成正常输出。
    plan.push({ type: 'block-start', index: 0, blockType: 'text' })
    plan.push({ type: 'text-delta', index: 0 } as unknown as StreamChunkLike)
    plan.push({ type: 'finish' } as unknown as StreamChunkLike)
    return plan
  }

  plan.push({ type: 'block-start', index: 0, blockType: 'text' })

  const limit = mode === 'mid-stream-error' ? Math.max(0, setup.failAfterChunks ?? 1) : chunks.length
  for (let i = 0; i < chunks.length && i < limit; i += 1) {
    plan.push({ type: 'text-delta', index: 0, text: chunks[i]! })
  }

  if (mode === 'mid-stream-error') {
    plan.push({
      type: 'finish',
      reason: { kind: 'error', failure: failure('testkit 注入的流中途错误') },
    })
    return plan
  }

  plan.push({ type: 'block-end', index: 0, block: { type: 'text', text: chunks.join('') } })

  if (setup.respond?.usage) {
    const { input, output } = setup.respond.usage
    plan.push({
      type: 'usage',
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
    })
  }

  plan.push({ type: 'finish', reason: { kind: setup.respond?.finishReason ?? 'stop' } })
  return plan
}

/** 按计划产流；`timeout` 模式在开头之后挂住直到取消。 */
export async function* emitChunks(
  plan: readonly StreamChunkLike[],
  options: { delayMs?: number; timeoutMode?: boolean; signal: AbortSignal },
): AsyncIterable<StreamChunkLike> {
  for (const chunk of plan) {
    if (options.signal.aborted) return
    if (options.delayMs && options.delayMs > 0) await delay(options.delayMs, options.signal)
    yield chunk
  }
  if (options.timeoutMode) {
    // 故意不产出 finish：消费方会一直等，直到超时或取消
    await sleepUntilAborted(options.signal)
  }
}

export const llmDriver: Driver = {
  kind: 'llm',
  description: '接管 llm/stream：模型输出、失败注入、用量伪造全部由声明决定（零上游请求）',
  requires: ['llm'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { llm?: LlmSetup }).llm
    if (!setup) return

    const plan = buildChunkPlan(setup)
    const timeoutMode = (setup.failMode ?? 'none') === 'timeout'
    let callCount = 0

    const unsubscribe = ctx.host.on('llm/stream', (..._args: any[]) => {
      callCount += 1
      ctx.fixture.note('llmCallCount', callCount)
      ctx.fixture.noteAppend('llmCalls', { index: callCount })
      // 关键：**不调用 next()** —— 真实适配器完全不会被触达
      return emitChunks(plan, {
        delayMs: setup.respond?.delayMs,
        timeoutMode,
        signal: ctx.signal,
      })
    })

    ctx.fixture.add('llm:stream', unsubscribe)
    ctx.fixture.note('plannedChunks', plan.map((c) => c.type))
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('llm' in action)) {
      throw new Error(
        `llm driver 只支持 \`llm\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const service = ctx.host.service('llm') as LlmServiceLike | undefined
    if (typeof service?.stream !== 'function') {
      throw new Error('宿主的 llm 服务不提供 stream()，无法触发模型流')
    }

    // provider / model 只是占位：listener 不调 next()，不会真的路由到任何适配器
    const options = {
      provider: 'testkit-mock',
      model: 'testkit-mock',
      messages: [{ role: 'user', content: action.llm.prompt }],
      signal: ctx.signal,
    }

    let text = ''
    const chunkTypes: string[] = []
    let finishReason: string | undefined
    let streamError: string | undefined
    let chunkCount = 0

    try {
      for await (const chunk of service.stream(options)) {
        chunkCount += 1
        const type = (chunk as { type?: unknown })?.type
        chunkTypes.push(typeof type === 'string' ? type : 'unknown')
        if (type === 'text-delta') {
          const piece = (chunk as { text?: unknown }).text
          if (typeof piece === 'string') text += piece
        }
        if (type === 'finish') {
          const reason = (chunk as { reason?: { kind?: unknown } }).reason
          if (typeof reason?.kind === 'string') finishReason = reason.kind
        }
      }
    } catch (error) {
      streamError = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    }

    ctx.fixture.note('mockText', text)
    ctx.fixture.note('chunkTypes', chunkTypes)
    ctx.fixture.note('chunkCount', chunkCount)
    ctx.fixture.note('finishReason', finishReason)
    ctx.fixture.note('streamError', streamError)
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

/** 挂住直到取消（`timeout` 模式用）。取消是正常出口，不抛错。 */
function sleepUntilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

/** 供 act 的调用方（与测试）复用的最小 options 构造。 */
export function minimalLlmOptions(prompt: string, signal: AbortSignal): Record<string, unknown> {
  return {
    provider: 'testkit-mock',
    model: 'testkit-mock',
    messages: [{ role: 'user', content: prompt }],
    signal,
  }
}
