/**
 * agent driver 的单元测试。
 *
 * 这个 driver 的特殊性：它**真的会调模型**。所以这里的测试用假 subagents 服务，
 * 只验证「驱动器接线是否正确」——真实模型行为由 `cases/TK-0014` 在活宿主上回答。
 *
 * 重点守住两件事：
 *   ① provider 名不确定时必须**跳过并列出可用名**，而不是猜
 *   ② `run.dispose()` 必须被调用（子 agent 的 Activation 否则会滞留）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import { agentDriver, listProviders, resolveInitiator } from '../lib/kinds/agent.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('listProviders：只收字符串，畸形输入不炸', () => {
  assert.deepEqual(listProviders({ list: () => ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(listProviders({ list: () => ['a', 1, null, 'b'] }), ['a', 'b'])
  assert.deepEqual(listProviders({ list: () => 'nope' }), [])
  assert.deepEqual(listProviders({}), [])
  assert.deepEqual(listProviders(undefined), [])
})

test('resolveInitiator：优先 currentInitiator，抛错时落回 requireInitiator', () => {
  const agent = { id: 'a' }
  assert.equal(resolveInitiator({ currentInitiator: () => agent }), agent)
  assert.equal(
    resolveInitiator({
      currentInitiator: () => {
        throw new Error('boom')
      },
      requireInitiator: () => agent,
    }),
    agent,
  )
  assert.equal(resolveInitiator({ requireInitiator: () => agent }), agent)
  assert.equal(resolveInitiator({ requireInitiator: () => undefined }), undefined)
  assert.equal(resolveInitiator({}), undefined)
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness({
  providers = ['spawn-in-process'],
  initiator = { id: 'parent-agent' },
  result,
  hasSubagents = true,
  rejectStart,
} = {}) {
  const started = []
  const disposed = []
  const ctx = new Context()

  if (hasSubagents) {
    ctx.provide('subagents', {
      list: () => providers,
      start: async (name, request) => {
        if (rejectStart) throw rejectStart
        started.push({ name, request })
        return {
          id: 'child-1',
          localAgent: { id: 'child-1' },
          result: Promise.resolve(
            result ?? {
              output: [{ type: 'text', text: 'TESTKIT_OK' }],
              stopReason: 'completed',
            },
          ),
          dispose: async () => {
            disposed.push('child-1')
          },
        }
      },
    })
  }
  ctx.provide('agents', { currentInitiator: () => initiator })

  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return { ctx, driverCtx, started, disposed }
}

test('setup：记录可用的 provider 名单', async () => {
  const { driverCtx } = makeHarness({ providers: ['a', 'b'] })
  await agentDriver.setup(driverCtx, { setup: { agent: { label: 'x' } } })
  assert.deepEqual(driverCtx.fixture.getNote('availableSubagentProviders'), ['a', 'b'])
})

test('setup：provider 名不存在时跳过并列出可用名（不猜）', async () => {
  const { driverCtx } = makeHarness({ providers: ['real-name'] })
  await assert.rejects(
    () => agentDriver.setup(driverCtx, { setup: { agent: { provider: 'typo-name' } } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /typo-name/)
      assert.match(error.message, /real-name/, '应把可用名列出来')
      return true
    },
  )
})

test('setup：宿主没有注册任何 provider 时跳过', async () => {
  const { driverCtx } = makeHarness({ providers: [] })
  await assert.rejects(
    () => agentDriver.setup(driverCtx, { setup: { agent: {} } }),
    SkipCase,
  )
})

test('setup：宿主没有 subagents 服务时跳过', async () => {
  const { driverCtx } = makeHarness({ hasSubagents: false })
  await assert.rejects(
    () => agentDriver.setup(driverCtx, { setup: { agent: {} } }),
    SkipCase,
  )
})

test('act：派生成功、写全取证、并释放 run', async () => {
  const { driverCtx, started, disposed } = makeHarness()
  await agentDriver.setup(driverCtx, { setup: { agent: { label: 'smoke' } } })

  await agentDriver.act(driverCtx, { agent: { prompt: '只回复 TESTKIT_OK' } })

  assert.equal(started.length, 1)
  assert.equal(started[0].name, 'spawn-in-process', '缺省用第一个 provider')
  assert.equal(started[0].request.label, 'smoke')
  assert.deepEqual(started[0].request.prompt, [{ type: 'text', text: '只回复 TESTKIT_OK' }])
  assert.ok(started[0].request.parent, '必须带上 parent（currentInitiator）')

  assert.equal(driverCtx.fixture.getNote('agentProvider'), 'spawn-in-process')
  assert.equal(driverCtx.fixture.getNote('agentRunId'), 'child-1')
  assert.equal(driverCtx.fixture.getNote('agentStopReason'), 'completed')
  assert.equal(driverCtx.fixture.getNote('agentOutput'), 'TESTKIT_OK')
  assert.equal(driverCtx.fixture.getNote('agentError'), undefined)

  assert.deepEqual(disposed, ['child-1'], 'run 必须被释放')
})

test('act：结果失败（stopReason 异常）也会被如实记录', async () => {
  const { driverCtx } = makeHarness({
    result: { output: [], stopReason: 'error', diagnostic: '模型炸了' },
  })
  await agentDriver.setup(driverCtx, { setup: { agent: {} } })

  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })

  // 注意：这是"跑完了但结果是失败"，不是异常——所以 agentError 应为 undefined
  assert.equal(driverCtx.fixture.getNote('agentError'), undefined)
  assert.equal(driverCtx.fixture.getNote('agentStopReason'), 'error')
  assert.equal(driverCtx.fixture.getNote('agentDiagnostic'), '模型炸了')
})

test('act：start 抛错被记账，且 dispose 仍会被尝试', async () => {
  const { driverCtx } = makeHarness({ rejectStart: new Error('provider 拒绝了') })
  await agentDriver.setup(driverCtx, { setup: { agent: {} } })

  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })

  assert.match(String(driverCtx.fixture.getNote('agentError')), /provider 拒绝了/)
})

test('act：拿不到当前 agent 时跳过（而不是崩）', async () => {
  // 注意用 null 而不是 undefined：解构默认值 `initiator = {...}` 在传入 undefined 时
  // 会**回退到默认值**，那样 currentInitiator 反而返回了有值的 agent（JS 的经典陷阱）。
  const { driverCtx } = makeHarness({ initiator: null })
  await agentDriver.setup(driverCtx, { setup: { agent: {} } })

  await assert.rejects(
    () => agentDriver.act(driverCtx, { agent: { prompt: 'x' } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /currentInitiator/)
      return true
    },
  )
})

test('act：工具过滤与人格会透传', async () => {
  const { driverCtx, started } = makeHarness()
  await agentDriver.setup(driverCtx, {
    setup: {
      agent: { toolFilter: { deny: ['bash'] }, persona: '你是测试助手', model: 'deepseek-flash' },
    },
  })

  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })

  assert.deepEqual(started[0].request.toolFilter, { deny: ['bash'] })
  assert.equal(started[0].request.persona, '你是测试助手')
  assert.deepEqual(started[0].request.agentOptions, { model: 'deepseek-flash' })
})

test('act：非 agent 动作直接报错', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(
    () => agentDriver.act(driverCtx, { tool: 'x' }),
    /只支持 `agent` 动作/,
  )
})

test('driver 元信息：kind / requires 正确', () => {
  assert.equal(agentDriver.kind, 'agent')
  assert.deepEqual(agentDriver.requires, ['subagents'])
})
