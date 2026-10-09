/**
 * `tool` driver 的**两条 waterfall**（`tools/pre-execute` / `tools/post-execute`）单元测试。
 *
 * 守的核心约定只有一条，但写错会**殃及所有插件**：
 * **不拥有决策的 listener 必须 `return next()`**（DSH 稳定性指引原文）。
 * 若在"不是我的调用"时直接 `return undefined`，链就断在这里，
 * 别人的 pre/post 决策全部失效——而这在单场景里看不出来。
 *
 * 第二条是**形状**：`deny` 要带 `info.{name,code}`、`ask` 要带 `displayReason`、
 * `block` 要带 `feedback: ContentBlock[]`。形状写错的后果是"断言看着过了、
 * 真实链路上没人认"。
 *
 * 这里不碰真实模型，也不跑真实工具管道：只驱动 driver 注册的 listener。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  buildPostDecision,
  buildPreDecision,
  pickByCallIndex,
  summarizeDecision,
  toolDriver,
} from '../lib/kinds/tool.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('pickByCallIndex：单值 / 列表 / 越界取最后一个', () => {
  assert.equal(pickByCallIndex('a', undefined, 1), 'a')
  assert.equal(pickByCallIndex('a', undefined, 9), 'a')
  assert.equal(pickByCallIndex(undefined, ['x', 'y'], 1), 'x')
  assert.equal(pickByCallIndex(undefined, ['x', 'y'], 2), 'y')
  assert.equal(pickByCallIndex(undefined, ['x', 'y'], 99), 'y', '越界取最后一个而不是 undefined')
  assert.equal(pickByCallIndex(undefined, [], 1), undefined)
})

test('buildPreDecision：allow 表示「不拥有决策」（返回 undefined）', () => {
  assert.equal(buildPreDecision({ decision: 'allow' }, 1), undefined)
})

test('buildPreDecision：deny 带上 info.{name,code,reason}', () => {
  assert.deepEqual(buildPreDecision({ decision: 'deny', reason: '不许', code: 'NOPE' }, 1), {
    kind: 'deny',
    reason: '不许',
    info: { name: 'ToolError', code: 'NOPE', reason: '不许' },
  })
  // 不给 code/errorName 时不产生空的 info
  assert.deepEqual(buildPreDecision({ decision: 'deny', reason: '不许' }, 1), {
    kind: 'deny',
    reason: '不许',
  })
})

test('buildPreDecision：cancel 与 ask（含 displayReason）', () => {
  assert.deepEqual(buildPreDecision({ decision: 'cancel' }, 1), { kind: 'cancel' })
  assert.deepEqual(
    buildPreDecision({ decision: 'ask', reason: 'r', displayReason: { en: 'en', zh: '中' } }, 1),
    { kind: 'ask', reason: 'r', displayReason: { en: 'en', zh: '中' } },
  )
})

test('buildPreDecision：decisions 列表按下标取，缺声明则报错', () => {
  const spec = { decisions: ['deny', 'cancel', 'allow'] }
  assert.equal(buildPreDecision(spec, 1).kind, 'deny')
  assert.equal(buildPreDecision(spec, 2).kind, 'cancel')
  assert.equal(buildPreDecision(spec, 3), undefined, '第 3 次是 allow = 委托')
  assert.equal(buildPreDecision(spec, 4), undefined, '越界沿用最后一个')
  assert.throws(() => buildPreDecision({}, 1), /需要 decision 或 decisions/)
})

test('buildPostDecision：accept 委托；replace 走 content 或 value；block 带 feedback', () => {
  assert.equal(buildPostDecision({ action: 'accept' }, 1), undefined)
  assert.deepEqual(buildPostDecision({ action: 'replace', text: '改写后' }, 1), {
    kind: 'accept',
    content: [{ type: 'text', text: '改写后' }],
  })
  assert.deepEqual(buildPostDecision({ action: 'replace', value: { ok: true } }, 1), {
    kind: 'accept',
    value: { ok: true },
  })
  assert.deepEqual(buildPostDecision({ action: 'block', feedback: '不行' }, 1), {
    kind: 'block',
    feedback: [{ type: 'text', text: '不行' }],
  })
  assert.throws(() => buildPostDecision({}, 1), /需要 action 或 actions/)
})

test('summarizeDecision：压成报告友好的摘要', () => {
  assert.equal(summarizeDecision(undefined), undefined)
  assert.equal(summarizeDecision('x'), 'x')
  assert.deepEqual(summarizeDecision({ kind: 'deny', reason: 'r', info: { code: 'C' } }), {
    kind: 'deny',
    reason: 'r',
    code: 'C',
  })
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness() {
  const ctx = new Context()
  ctx.provide('tools', {
    execute: async () => ({ isError: false, value: 'ok', content: [{ type: 'text', text: 'ok' }] }),
    guard: () => () => undefined,
    // register 是 driver 注册临时工具时要用的最小面
    register: () => () => undefined,
  })
  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return { ctx, driverCtx }
}

/** 触发一次真实 waterfall（链尾 next 即「没人拥有决策」时的兜底）。 */
function fire(driverCtx, name, args, tail = { kind: 'fallback' }) {
  return driverCtx.host.waterfall(name, args, async () => tail)
}

test('preExecute：匹配调用返回 deny，并记账形状', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: {
      tool: {
        register: { name: 'demo' },
        preExecute: { decision: 'deny', reason: '不许', code: 'NOPE' },
      },
    },
  })

  const decision = await fire(driverCtx, 'tools/pre-execute', [{ name: 'demo', arguments: { a: 1 } }])

  assert.equal(decision.kind, 'deny')
  assert.equal(decision.reason, '不许')
  assert.deepEqual(decision.info, { name: 'ToolError', code: 'NOPE', reason: '不许' })
  assert.equal(driverCtx.fixture.getNote('preExecuteCount'), 1)
  assert.deepEqual(driverCtx.fixture.getNote('preExecuteCalls'), [
    { index: 1, name: 'demo', args: { a: 1 } },
  ])
  assert.deepEqual(driverCtx.fixture.getNote('preExecuteDecision'), {
    kind: 'deny',
    reason: '不许',
    code: 'NOPE',
  })
})

test('preExecute：不是我的调用必须委托（链不能断在这里）', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: { tool: { register: { name: 'demo' }, preExecute: { decision: 'deny' } } },
  })

  const decision = await fire(driverCtx, 'tools/pre-execute', [{ name: 'other' }])

  assert.deepEqual(decision, { kind: 'fallback' }, 'next() 的结果必须被透传')
  assert.equal(driverCtx.fixture.getNote('preExecuteCount'), undefined, '不匹配就不该记账')
})

test('preExecute：decisions 列表让一条场景覆盖多种决策', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: {
      tool: {
        register: { name: 'demo' },
        preExecute: { decisions: ['deny', 'cancel', 'ask'], reason: 'r' },
      },
    },
  })

  const first = await fire(driverCtx, 'tools/pre-execute', [{ name: 'demo' }])
  const second = await fire(driverCtx, 'tools/pre-execute', [{ name: 'demo' }])
  const third = await fire(driverCtx, 'tools/pre-execute', [{ name: 'demo' }])

  assert.equal(first.kind, 'deny')
  assert.equal(second.kind, 'cancel')
  assert.equal(third.kind, 'ask')
  assert.equal(driverCtx.fixture.getNote('preExecuteCount'), 3)
})

test('preExecute：awaitDownstream 时下游的拒绝不被覆盖', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: {
      tool: {
        register: { name: 'demo' },
        preExecute: { decision: 'ask', reason: 'r', awaitDownstream: true },
      },
    },
  })

  const decision = await fire(
    driverCtx,
    'tools/pre-execute',
    [{ name: 'demo' }],
    { kind: 'deny', reason: '下游拒绝', info: { name: 'Down', code: 'D' } },
  )

  assert.equal(decision.kind, 'deny', '最严格者获胜：本层不该把下游的拒绝改成 ask')
  assert.deepEqual(driverCtx.fixture.getNote('preExecuteDownstream'), {
    kind: 'deny',
    reason: '下游拒绝',
    code: 'D',
  })
})

test('intercept：ask / cancel 现在走 waterfall（不再是 Phase 2 跳过）', async () => {
  for (const decision of ['ask', 'cancel']) {
    const { driverCtx } = makeHarness()
    await toolDriver.setup(driverCtx, {
      setup: { tool: { register: { name: 'demo' }, intercept: { name: 'demo', decision } } },
    })

    const out = await fire(driverCtx, 'tools/pre-execute', [{ name: 'demo' }])
    assert.equal(out.kind, decision)
    assert.equal(driverCtx.fixture.getNote('interceptVia'), 'tools/pre-execute')
  }
})

test('postExecute：block 带 feedback，且记账原始结果', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: {
      tool: { register: { name: 'demo' }, postExecute: { action: 'block', feedback: '不行' } },
    },
  })

  const decision = await fire(
    driverCtx,
    'tools/post-execute',
    [{ name: 'demo' }, { isError: false, content: [{ type: 'text', text: '原始结果' }] }],
    { kind: 'accept' },
  )

  assert.deepEqual(decision, { kind: 'block', feedback: [{ type: 'text', text: '不行' }] })
  assert.equal(driverCtx.fixture.getNote('postExecuteOriginal'), '原始结果')
  assert.deepEqual(driverCtx.fixture.getNote('postExecuteCalls'), [
    { index: 1, name: 'demo', isError: false, resultText: '原始结果' },
  ])
})

test('postExecute：replace 改写结果内容', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: {
      tool: { register: { name: 'demo' }, postExecute: { action: 'replace', text: '被改写' } },
    },
  })

  const decision = await fire(
    driverCtx,
    'tools/post-execute',
    [{ name: 'demo' }, { isError: false, content: [] }],
    { kind: 'accept' },
  )

  assert.deepEqual(decision, { kind: 'accept', content: [{ type: 'text', text: '被改写' }] })
})

test('postExecute：accept 委托下游；其他工具不记账', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: { tool: { register: { name: 'demo' }, postExecute: { action: 'accept' } } },
  })

  const mine = await fire(
    driverCtx,
    'tools/post-execute',
    [{ name: 'demo' }, { isError: false, content: [] }],
    { kind: 'accept', value: '下游' },
  )
  const others = await fire(
    driverCtx,
    'tools/post-execute',
    [{ name: 'other' }, { isError: false, content: [] }],
    { kind: 'accept' },
  )

  assert.deepEqual(mine, { kind: 'accept', value: '下游' })
  assert.deepEqual(others, { kind: 'accept' })
  assert.equal(driverCtx.fixture.getNote('postExecuteCount'), 1)
})

test('setup：缺 name 且没有 register.name 时明确报错（而不是静默放行）', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(
    () => toolDriver.setup(driverCtx, { setup: { tool: { preExecute: { decision: 'deny' } } } }),
    /preExecute 需要 name/,
  )
  await assert.rejects(
    () => toolDriver.setup(driverCtx, { setup: { tool: { postExecute: { action: 'block' } } } }),
    /postExecute 需要 name/,
  )
})

test('setup：listener 注册经 Fixture 登记（场景结束会被释放）', async () => {
  const { driverCtx } = makeHarness()
  await toolDriver.setup(driverCtx, {
    setup: {
      tool: {
        register: { name: 'demo' },
        preExecute: { decision: 'deny' },
        postExecute: { action: 'block' },
      },
    },
  })

  const report = await driverCtx.fixture.release()
  assert.deepEqual(report.released.sort(), [
    'tool:post-execute:demo',
    'tool:pre-execute:demo',
    'tool:register:demo',
  ])
  assert.equal(report.failures.length, 0)
})
