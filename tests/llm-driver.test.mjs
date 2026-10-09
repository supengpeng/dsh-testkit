/**
 * llm driver 的单元测试。
 *
 * 分三层：
 *   ① 纯函数 —— chunk 计划构造、产流、最小 options（不碰宿主）
 *   ② driver 契约 —— setup 注册 / act 取证
 *   ③ **拦截真实性** —— 用真实 cordis 的 waterfall 复刻 dsh-llm 的调用形式，
 *      证明"真实适配器位置"从未被触达（零上游请求不是口号）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  buildChunkPlan,
  emitChunks,
  llmDriver,
  minimalLlmOptions,
  TESTKIT_LLM_ERROR_CODE,
} from '../lib/kinds/llm.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('buildChunkPlan：正常路径产出完整序列', () => {
  const plan = buildChunkPlan({
    respond: { chunks: ['a', 'b'], finishReason: 'stop', usage: { input: 1, output: 2 } },
  })
  assert.deepEqual(
    plan.map((c) => c.type),
    ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'],
  )
  const finish = plan[plan.length - 1]
  assert.equal(finish.reason.kind, 'stop')
  // usage 应换算成 DSH 的字段名与 total
  const usage = plan.find((c) => c.type === 'usage')
  assert.deepEqual(usage.usage, { inputTokens: 1, outputTokens: 2, totalTokens: 3 })
})

test('buildChunkPlan：无 usage 声明时不产出 usage chunk', () => {
  const plan = buildChunkPlan({ respond: { chunks: ['a'] } })
  assert.ok(!plan.some((c) => c.type === 'usage'))
  assert.equal(plan[plan.length - 1].reason.kind, 'stop', 'finishReason 缺省 stop')
})

test('buildChunkPlan：error 模式只产出 error finish', () => {
  const plan = buildChunkPlan({ failMode: 'error' })
  assert.equal(plan.length, 1)
  assert.equal(plan[0].type, 'finish')
  assert.equal(plan[0].reason.kind, 'error')
  assert.equal(plan[0].reason.failure.code, TESTKIT_LLM_ERROR_CODE)
})

test('buildChunkPlan：mid-stream-error 截断内容并补 error finish', () => {
  const plan = buildChunkPlan({
    respond: { chunks: ['a', 'b', 'c'] },
    failMode: 'mid-stream-error',
    failAfterChunks: 2,
  })
  const deltas = plan.filter((c) => c.type === 'text-delta')
  assert.equal(deltas.length, 2, '只应产出失败前的分块')
  assert.equal(plan[plan.length - 1].type, 'finish')
  assert.equal(plan[plan.length - 1].reason.kind, 'error')
  assert.ok(!plan.some((c) => c.type === 'block-end'), '失败时不产出 block-end')
})

test('buildChunkPlan：timeout 模式只产出开头（不误走正常路径）', () => {
  const plan = buildChunkPlan({ failMode: 'timeout', respond: { chunks: ['a', 'b'] } })
  assert.deepEqual(plan.map((c) => c.type), ['block-start'])
})

test('buildChunkPlan：malformed 模式产出结构畸形的 chunk', () => {
  const plan = buildChunkPlan({ failMode: 'malformed' })
  assert.deepEqual(plan.map((c) => c.type), ['block-start', 'text-delta', 'finish'])
  assert.equal(plan[1].text, undefined, 'text-delta 应缺 text')
  assert.equal(plan[2].reason, undefined, 'finish 应缺 reason')
})

test('emitChunks：按计划顺序产出', async () => {
  const signal = new AbortController().signal
  const plan = buildChunkPlan({ respond: { chunks: ['x', 'y'] } })
  const seen = []
  for await (const chunk of emitChunks(plan, { signal })) seen.push(chunk.type)
  assert.deepEqual(seen, ['block-start', 'text-delta', 'text-delta', 'block-end', 'finish'])
})

test('emitChunks：已取消的 signal 立即停止', async () => {
  const controller = new AbortController()
  controller.abort()
  const plan = buildChunkPlan({ respond: { chunks: ['x'] } })
  const seen = []
  for await (const chunk of emitChunks(plan, { signal: controller.signal })) seen.push(chunk.type)
  assert.deepEqual(seen, [], '取消后不应产出任何 chunk')
})

test('emitChunks：timeout 模式在开头之后挂住，取消才结束', async () => {
  const controller = new AbortController()
  const plan = buildChunkPlan({ failMode: 'timeout' })
  const seen = []

  const task = (async () => {
    for await (const chunk of emitChunks(plan, { timeoutMode: true, signal: controller.signal })) {
      seen.push(chunk.type)
    }
  })()

  // 给足时间：如果它自己结束了，说明"挂住"没实现
  await new Promise((r) => setTimeout(r, 30))
  assert.deepEqual(seen, ['block-start'], '应停在开头，尚未结束')

  controller.abort()
  await task
  assert.deepEqual(seen, ['block-start'], '取消后收尾，不产出 finish')
})

test('minimalLlmOptions：带齐 DSH 要求的必填字段', () => {
  const signal = new AbortController().signal
  const options = minimalLlmOptions('hi', signal)
  assert.equal(typeof options.provider, 'string')
  assert.equal(typeof options.model, 'string')
  assert.ok(Array.isArray(options.messages))
  assert.equal(options.signal, signal)
})

/* -------------------------------------------------------- driver 契约层 -- */

/**
 * 用真实 cordis 复刻 dsh-llm 的触发形式。
 * `realAdapterCalls` 记录"真实适配器位置"被执行了几次——正常应恒为 0。
 */
function makeHarness() {
  const ctx = new Context()
  const realAdapterCalls = []

  ctx.provide('llm', {
    stream(options) {
      // 与 dsh-llm 的 streamWithRegistration 同形
      return ctx.waterfall(ctx, 'llm/stream', options, () => {
        realAdapterCalls.push(options)
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      })
    },
  })

  return { ctx, realAdapterCalls }
}

function makeDriverCtx(ctx) {
  const host = createHostFacade({
    ctx,
    dshVersion: 'test',
    log: () => undefined,
  })
  return {
    host,
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
}

test('setup：注册 llm/stream listener，且能力探测识别到 llm', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)

  assert.ok(driverCtx.host.capabilities.has('llm'), 'capabilities 应包含 llm')

  const scenario = { setup: { llm: { respond: { chunks: ['a'] } } } }
  await llmDriver.setup(driverCtx, scenario)

  assert.deepEqual(driverCtx.fixture.getNote('plannedChunks'), [
    'block-start',
    'text-delta',
    'block-end',
    'finish',
  ])

  const report = await driverCtx.fixture.release()
  assert.equal(report.failures.length, 0)
})

test('拦截真实性：act 消费到 mock 流，且真实适配器从未被触达', async () => {
  const { ctx, realAdapterCalls } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  const scenario = {
    setup: { llm: { respond: { chunks: ['你好，', '世界'], finishReason: 'stop' } } },
  }

  await llmDriver.setup(driverCtx, scenario)
  await llmDriver.act(driverCtx, { llm: { prompt: 'hi' } })

  assert.equal(driverCtx.fixture.getNote('mockText'), '你好，世界')
  assert.equal(driverCtx.fixture.getNote('finishReason'), 'stop')
  assert.equal(driverCtx.fixture.getNote('llmCallCount'), 1)
  assert.equal(driverCtx.fixture.getNote('streamError'), undefined)
  assert.deepEqual(realAdapterCalls, [], '真实适配器位置一次都不该被执行（零上游请求）')

  await driverCtx.fixture.release()
})

test('拦截真实性：没有 driver 时，真实适配器会被触达（对照组）', async () => {
  const { ctx, realAdapterCalls } = makeHarness()

  // 不调 setup = 没装拦截器。注意用 ctx.get()：
  // cordis 4 里 ctx.llm 属性访问需要 inject，否则抛错（本项目踩过的坑）。
  const llm = ctx.get('llm')
  for await (const _chunk of llm.stream({ provider: 'p', model: 'm', messages: [] })) {
    void _chunk
  }

  assert.equal(realAdapterCalls.length, 1, '对照组应证明这个探针本身是有效的')
})

test('act：mid-stream-error 时保留已产出内容并报 error finish', async () => {
  const { ctx, realAdapterCalls } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  const scenario = {
    setup: {
      llm: {
        respond: { chunks: ['前半', '后半'] },
        failMode: 'mid-stream-error',
        failAfterChunks: 1,
      },
    },
  }

  await llmDriver.setup(driverCtx, scenario)
  await llmDriver.act(driverCtx, { llm: { prompt: 'x' } })

  assert.equal(driverCtx.fixture.getNote('mockText'), '前半')
  assert.equal(driverCtx.fixture.getNote('finishReason'), 'error')
  assert.deepEqual(realAdapterCalls, [])

  await driverCtx.fixture.release()
})

test('act：非 llm 动作直接报错', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await assert.rejects(() => llmDriver.act(driverCtx, { tool: 'x' }), /只支持 `llm` 动作/)
})

test('act：宿主不提供 llm.stream 时报错', async () => {
  const ctx = new Context()
  ctx.provide('llm', {})
  const driverCtx = makeDriverCtx(ctx)
  await assert.rejects(
    () => llmDriver.act(driverCtx, { llm: { prompt: 'x' } }),
    /不提供 stream/,
  )
})

test('driver 元信息：kind / requires 正确', () => {
  assert.equal(llmDriver.kind, 'llm')
  assert.deepEqual(llmDriver.requires, ['llm'])
})
