/**
 * tool driver 的单元测试。
 *
 * 分两层：
 *   ① 纯函数（行为解析、值生成、内容转文本）—— 不碰宿主
 *   ② driver 契约（setup 注册 / act 取证 / 拦截安装）—— 用假 host
 *
 * 真实的工具管道行为（guard 是否真的拦得住）需要在活宿主验证，
 * 那部分由 cases/TK-0001..0003 覆盖；这里保证**驱动器自己**是对的。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  contentToText,
  generateValue,
  runToolBehavior,
  toolDriver,
} from '../lib/kinds/tool.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('generateValue：repeat-string 按声明生成长度', () => {
  assert.equal(generateValue({ kind: 'repeat-string', char: 'A', times: 5 }), 'AAAAA')
  assert.equal(generateValue({ kind: 'repeat-string', times: 3 }).length, 3, 'char 缺省为 A')
  assert.equal(generateValue({ kind: 'repeat-string', times: 200000 }).length, 200000)
  assert.equal(generateValue({ kind: 'repeat-string', times: -5 }), '', '负数应归零')
})

test('generateValue：未知 kind 抛错', () => {
  assert.throws(() => generateValue({ kind: 'nope', times: 1 }), /未知的 generate\.kind/)
})

test('runToolBehavior：throws 优先于 returns', async () => {
  const signal = new AbortController().signal
  await assert.rejects(
    () => runToolBehavior({ name: 'x', throws: '炸了', returns: 'ok' }, signal),
    /炸了/,
  )
})

test('runToolBehavior：returns 原样返回，缺省为 null', async () => {
  const signal = new AbortController().signal
  assert.deepEqual(await runToolBehavior({ name: 'x', returns: { a: 1 } }, signal), { a: 1 })
  assert.equal(await runToolBehavior({ name: 'x' }, signal), null)
})

test('runToolBehavior：generate 优先于 returns', async () => {
  const signal = new AbortController().signal
  const value = await runToolBehavior(
    { name: 'x', returns: 'ignored', generate: { kind: 'repeat-string', char: 'B', times: 4 } },
    signal,
  )
  assert.equal(value, 'BBBB')
})

test('runToolBehavior：delayMs 真的延迟', async () => {
  const signal = new AbortController().signal
  const t0 = Date.now()
  await runToolBehavior({ name: 'x', delayMs: 40, returns: 'v' }, signal)
  assert.ok(Date.now() - t0 >= 30, '应至少等待约 40ms')
})

test('runToolBehavior：已取消的 signal 立即拒绝', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => runToolBehavior({ name: 'x', delayMs: 1000 }, controller.signal),
    /aborted/,
  )
})

test('contentToText：拼接 text 块，忽略非文本块', () => {
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'image' }]), 'a')
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentToText([]), '')
  assert.equal(contentToText(undefined), '')
  assert.equal(contentToText('not-an-array'), '')
})

/* -------------------------------------------------------- driver 契约层 -- */

/** 造一个可观察的假宿主。 */
function makeHost({ executeResult, hasGuard = true, hasExecute = true } = {}) {
  const registered = []
  const guards = []
  const host = {
    capabilities: new Set(['tools']),
    env: { dshVersion: 'test', platform: 'test', nodeVersion: 'test' },
    log: () => undefined,
    registerTool(definition) {
      registered.push(definition)
      return () => undefined
    },
    service(name) {
      if (name !== 'tools') return undefined
      return {
        ...(hasExecute
          ? {
              execute: async (input) =>
                executeResult ?? {
                  isError: false,
                  value: { ok: true, name: input.name },
                  content: [{ type: 'text', text: 'done' }],
                },
            }
          : {}),
        ...(hasGuard
          ? {
              guard(fn) {
                guards.push(fn)
                return () => undefined
              },
            }
          : {}),
      }
    },
  }
  return { host, registered, guards }
}

function makeCtx(host, scenario) {
  return {
    host,
    fixture: new Fixture(),
    scenario,
    signal: new AbortController().signal,
  }
}

test('setup：按声明注册临时工具，且注册经 Fixture 登记', async () => {
  const { host, registered } = makeHost()
  const scenario = {
    setup: { tool: { register: { name: 'testkit_x', description: 'd', returns: 42 } } },
  }
  const ctx = makeCtx(host, scenario)

  await toolDriver.setup(ctx, scenario)

  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'testkit_x')
  assert.equal(registered[0].description, 'd')
  assert.equal(typeof registered[0].execute, 'function')
  assert.deepEqual(ctx.fixture.getNote('registeredTools'), ['testkit_x'])

  // 释放应调用注册返回的 disposer（这里只验证不抛错且幂等）
  const report = await ctx.fixture.release()
  assert.equal(report.failures.length, 0)
  assert.equal(report.released.length, 1)
})

test('setup：注册的工具执行时走声明的行为', async () => {
  const { host, registered } = makeHost()
  const scenario = { setup: { tool: { register: { name: 't', returns: 'hello' } } } }
  const ctx = makeCtx(host, scenario)

  await toolDriver.setup(ctx, scenario)

  const value = await registered[0].execute({}, { signal: ctx.signal })
  assert.equal(value, 'hello')
})

test('setup：intercept.deny 安装 guard，且只拦目标工具', async () => {
  const { host, guards } = makeHost()
  const scenario = {
    setup: { tool: { intercept: { name: 'bash', decision: 'deny', reason: '不让跑' } } },
  }
  const ctx = makeCtx(host, scenario)

  await toolDriver.setup(ctx, scenario)

  assert.equal(guards.length, 1, '应安装 1 个 guard')
  assert.equal(guards[0]({ name: 'bash' }), '不让跑', '目标工具应被拦下')
  assert.equal(guards[0]({ name: 'read' }), undefined, '其它工具不应受影响')
})

test('setup：intercept.allow 不安装干预', async () => {
  const { host, guards } = makeHost()
  const scenario = { setup: { tool: { intercept: { name: 'bash', decision: 'allow' } } } }
  const ctx = makeCtx(host, scenario)

  await toolDriver.setup(ctx, scenario)
  assert.equal(guards.length, 0, 'allow 是默认行为，不该安装 guard')
})

test('setup：ask / cancel 抛 SkipCase（明确属 Phase 2）', async () => {
  const { host } = makeHost()
  for (const decision of ['ask', 'cancel']) {
    const scenario = { setup: { tool: { intercept: { name: 'bash', decision } } } }
    const ctx = makeCtx(host, scenario)
    await assert.rejects(() => toolDriver.setup(ctx, scenario), SkipCase)
  }
})

test('setup：宿主不提供 guard 时抛 SkipCase 而不是崩', async () => {
  const { host } = makeHost({ hasGuard: false })
  const scenario = { setup: { tool: { intercept: { name: 'bash', decision: 'deny' } } } }
  const ctx = makeCtx(host, scenario)

  await assert.rejects(() => toolDriver.setup(ctx, scenario), SkipCase)
})

test('act：成功调用写入完整取证', async () => {
  const { host } = makeHost()
  const scenario = { setup: { tool: {} } }
  const ctx = makeCtx(host, scenario)

  await toolDriver.act(ctx, { tool: 'testkit_x', args: { a: 1 } })

  assert.equal(ctx.fixture.getNote('callCount'), 1)
  assert.equal(ctx.fixture.getNote('callError'), undefined, '成功时 callError 应为 undefined')
  assert.equal(ctx.fixture.getNote('resultText'), 'done')
  assert.equal(ctx.fixture.getNote('resultLength'), 4)
  assert.deepEqual(ctx.fixture.getNote('resultValue'), { ok: true, name: 'testkit_x' })
  assert.deepEqual(ctx.fixture.getNote('calls'), [
    { index: 1, name: 'testkit_x', args: { a: 1 } },
  ])
})

test('act：失败调用把错误写进 callError', async () => {
  const { host } = makeHost({
    executeResult: {
      isError: true,
      error: { message: '工具炸了' },
      content: [{ type: 'text', text: '工具炸了' }],
    },
  })
  const ctx = makeCtx(host, { setup: { tool: {} } })

  await toolDriver.act(ctx, { tool: 'bad', args: {} })

  assert.equal(ctx.fixture.getNote('callError'), '工具炸了')
  // 断言层用 `fx.resultText notContains X` 来证明"工具本体没跑过"
  assert.equal(ctx.fixture.getNote('resultText'), '工具炸了')
})

test('act：多次调用累积 callCount 与 calls', async () => {
  const { host } = makeHost()
  const ctx = makeCtx(host, { setup: { tool: {} } })

  await toolDriver.act(ctx, { tool: 'a', args: {} })
  await toolDriver.act(ctx, { tool: 'b', args: {} })

  assert.equal(ctx.fixture.getNote('callCount'), 2)
  assert.equal(ctx.fixture.getNote('calls').length, 2)
  assert.equal(ctx.fixture.getNote('calls')[1].name, 'b')
})

test('act：非 tool 动作直接报错（不静默跳过）', async () => {
  const { host } = makeHost()
  const ctx = makeCtx(host, { setup: { tool: {} } })

  await assert.rejects(() => toolDriver.act(ctx, { prompt: 'hi' }), /只支持 `tool` 动作/)
})

test('act：宿主不提供 execute 时报错', async () => {
  const { host } = makeHost({ hasExecute: false })
  const ctx = makeCtx(host, { setup: { tool: {} } })

  await assert.rejects(() => toolDriver.act(ctx, { tool: 'x', args: {} }), /不提供 execute/)
})

test('driver 元信息：kind / requires 正确', () => {
  assert.equal(toolDriver.kind, 'tool')
  assert.deepEqual(toolDriver.requires, ['tools'])
  assert.equal(typeof toolDriver.description, 'string')
})
