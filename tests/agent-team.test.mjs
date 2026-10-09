/**
 * `agent` driver 的 **teammate 通道**（复用 Agent Teams）单元测试。
 *
 * 和 one-shot 一样，这里不碰真模型：用假的 `agentTeams` 服务验证
 * 「驱动器接线是否正确」。真实团队行为由 `cases/TK-0027` 在活宿主上回答。
 *
 * 重点守住四件事：
 *   ① 名字必须唯一且合法（团队名**永不复用**，撞名会直接让场景失败）
 *   ② 只有 Lead 能派 teammate（团队成员会话里必须**跳过**而不是崩）
 *   ③ 状态回落 inactive 才算跑完（团队通道没有同步 result）
 *   ④ 团队不支持的一次性参数（model / toolFilter / persona）必须**如实记账**，
 *      不能静默忽略
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  agentDriver,
  assertTeammateName,
  findMember,
  makeTeammateName,
  resolveTeamRole,
  summarizeMembers,
  waitForTeammateIdle,
} from '../lib/kinds/agent.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('makeTeammateName：lower-kebab、唯一、且能过服务端校验', () => {
  const name = makeTeammateName('TK-0027', 'ab12')
  assert.equal(name, 'tk-0027-ab12')
  assertTeammateName(name)

  // 不给 suffix 时必须自带随机性（否则第二次跑同一条场景会撞名）
  const names = new Set(Array.from({ length: 50 }, () => makeTeammateName('TK-0027')))
  assert.ok(names.size > 40, `随机性不足：50 次只产生 ${names.size} 个不同名字`)
  for (const candidate of names) assertTeammateName(candidate)
})

test('makeTeammateName：畸形 caseId 也要产出合法名', () => {
  for (const caseId of ['', '???', 'TK_0027', 'tk-', 'A B C']) {
    assertTeammateName(makeTeammateName(caseId, 'xy'))
  }
})

test('assertTeammateName：非法名抛错（这是场景数据错误，不是跳过）', () => {
  assert.throws(() => assertTeammateName('Bad_Name'), /lower-kebab-case/)
  assert.throws(() => assertTeammateName('lead'), /lower-kebab-case/)
  assert.throws(() => assertTeammateName('a'.repeat(65)), /lower-kebab-case/)
  assert.throws(() => assertTeammateName('-x'), /lower-kebab-case/)
})

test('resolveTeamRole：优先 tryMembership，落回 membership，非成员为 undefined', () => {
  assert.equal(resolveTeamRole({ tryMembership: () => ({ role: 'lead' }) }, {}), 'lead')
  assert.equal(
    resolveTeamRole(
      {
        tryMembership: () => {
          throw new Error('boom')
        },
        membership: () => ({ role: 'teammate' }),
      },
      {},
    ),
    'teammate',
  )
  assert.equal(
    resolveTeamRole(
      {
        membership: () => {
          throw new Error('TEAM_NOT_MEMBER')
        },
      },
      {},
    ),
    undefined,
  )
  assert.equal(resolveTeamRole({}, {}), undefined)
  assert.equal(resolveTeamRole(undefined, {}), undefined)
})

test('summarizeMembers / findMember：畸形输入不炸', () => {
  assert.deepEqual(summarizeMembers(undefined), [])
  assert.deepEqual(summarizeMembers('nope'), [])
  assert.deepEqual(summarizeMembers([{ name: 'a', role: 'teammate', status: 'running' }, null]), [
    { name: 'a', role: 'teammate', status: 'running' },
    { name: undefined, role: undefined, status: undefined },
  ])
  assert.equal(findMember([{ name: 'a' }], 'a')?.name, 'a')
  assert.equal(findMember([{ name: 'a' }], 'b'), undefined)
  assert.equal(findMember(undefined, 'a'), undefined)
})

/* -------------------------------------------------- waitForTeammateIdle -- */

function fakeTeams({ sequence = ['inactive'], waitDelayMs = 0, rejectChange = false } = {}) {
  let index = 0
  const reads = []
  return {
    reads,
    service: {
      listMembers: () => {
        const status = sequence[Math.min(index, sequence.length - 1)]
        index += 1
        reads.push(status)
        return [
          { name: 'lead', role: 'lead', status: 'inactive' },
          { name: 'tk-0027-ab12', role: 'teammate', status, id: 'child-1' },
        ]
      },
      waitForChange: () =>
        rejectChange
          ? Promise.reject(new Error('no activity'))
          : new Promise((resolve) => setTimeout(resolve, waitDelayMs)),
    },
  }
}

test('waitForTeammateIdle：running 之后回落 inactive 才算跑完', async () => {
  const { service } = fakeTeams({ sequence: ['running', 'running', 'inactive'], waitDelayMs: 1 })
  const wait = await waitForTeammateIdle(service, {}, 'tk-0027-ab12', {
    timeoutMs: 5_000,
    pollMs: 2,
    signal: new AbortController().signal,
  })
  assert.equal(wait.status, 'inactive')
  assert.equal(wait.timedOut, false)
  assert.equal(wait.members.length, 2)
})

test('waitForTeammateIdle：waitForChange 抛错时靠轮询兜底', async () => {
  const { service } = fakeTeams({
    sequence: ['running', 'inactive'],
    rejectChange: true,
  })
  const wait = await waitForTeammateIdle(service, {}, 'tk-0027-ab12', {
    timeoutMs: 5_000,
    pollMs: 1,
    signal: new AbortController().signal,
  })
  assert.equal(wait.status, 'inactive')
  assert.equal(wait.wakeReason, 'poll')
})

test('waitForTeammateIdle：一直 running 时按上限超时（不无限等）', async () => {
  const { service } = fakeTeams({ sequence: ['running'], rejectChange: true })
  const wait = await waitForTeammateIdle(service, {}, 'tk-0027-ab12', {
    timeoutMs: 30,
    pollMs: 1,
    signal: new AbortController().signal,
  })
  assert.equal(wait.status, 'running')
  assert.equal(wait.timedOut, true)
  // 同上一条的容差理由：`Date.now()` 取整 + 定时器精度会让实测少 1–2ms。
  // 判据仍然是"确实等到了上限附近"——不等待时这个值是 0–2ms。
  const TIMER_TOLERANCE_MS = 5
  assert.ok(wait.waitedMs >= 30 - TIMER_TOLERANCE_MS, `实际等待 ${wait.waitedMs}ms`)
})

test('waitForTeammateIdle：failed 也算跑完（不能让场景一直等到超时）', async () => {
  const { service } = fakeTeams({ sequence: ['failed'] })
  const wait = await waitForTeammateIdle(service, {}, 'tk-0027-ab12', {
    timeoutMs: 5_000,
    pollMs: 1,
    signal: new AbortController().signal,
  })
  assert.equal(wait.status, 'failed')
  assert.equal(wait.timedOut, false)
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness({
  role = 'lead',
  teams = true,
  sequence = ['inactive'],
  spawnError,
  initiator = { id: 'lead-session' },
  emitAssistant = true,
  services = true,
} = {}) {
  const ctx = new Context()
  const spawnCalls = []
  const interrupts = []
  let memberName = ''

  if (services) {
    ctx.provide('subagents', { list: () => ['spawn', 'fork'] })
  }

  if (teams) {
    ctx.provide('agentTeams', {
      tryMembership: () =>
        role === undefined ? undefined : { role, root: { id: 'lead-session' }, id: 'lead-session', name: 'lead' },
      listMembers: (() => {
        let index = 0
        return () => {
          const status = sequence[Math.min(index, sequence.length - 1)]
          index += 1
          return [
            { name: 'lead', role: 'lead', status: 'inactive' },
            { name: memberName, role: 'teammate', status, id: 'child-1' },
          ]
        }
      })(),
      spawnTeammate: async (_caller, request) => {
        if (spawnError) throw spawnError
        spawnCalls.push(request)
        memberName = String(request.name)
        if (emitAssistant) {
          // 在 spawn **返回之后**、且在等待循环里触发：此时 driver 才知道 childId。
          // 用宏任务保证 ordering——这正是真实宿主的顺序（消息晚于创建）。
          setTimeout(() => {
            ctx.emit(
              'session/event',
              { id: 'child-1' },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'TESTKIT_OK' }] } } },
            )
          }, 0)
        }
        return { member: { id: 'child-1', name: request.name, role: 'teammate', status: 'running' } }
      },
      waitForChange: () => new Promise((resolve) => setTimeout(resolve, 4)),
      interrupt: (_caller, name) => {
        interrupts.push(name)
        return { previousStatus: 'running' }
      },
    })
  }

  if (initiator !== null) {
    ctx.provide('agents', { currentInitiator: () => initiator })
  } else {
    ctx.provide('agents', { currentInitiator: () => null })
  }

  const fixture = new Fixture()
  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture,
    scenario: { id: 'TK-0027', setup: {} },
    signal: new AbortController().signal,
  }
  return { ctx, driverCtx, spawnCalls, interrupts }
}

test('setup：teammate 模式缺 agentTeams 能力时跳过（并说明原因）', async () => {
  const { driverCtx } = makeHarness({ teams: false })
  await assert.rejects(
    () => agentDriver.setup(driverCtx, { setup: { agent: { mode: 'teammate' } } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /agentTeams/)
      return true
    },
  )
})

test('setup：one-shot 模式不受 agentTeams 缺失影响（原行为不变）', async () => {
  const { driverCtx } = makeHarness({ teams: false })
  await agentDriver.setup(driverCtx, { setup: { agent: { label: 'x' } } })
  assert.deepEqual(driverCtx.fixture.getNote('availableSubagentProviders'), ['spawn', 'fork'])
})

test('act：非 Lead（团队成员会话）跳过而不是崩', async () => {
  const { driverCtx } = makeHarness({ role: 'teammate' })
  await agentDriver.setup(driverCtx, { setup: { agent: { mode: 'teammate' } } })
  await assert.rejects(
    () => agentDriver.act(driverCtx, { agent: { prompt: 'x' } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /只有 Team Lead/)
      return true
    },
  )
})

test('act：走团队通道 —— spawn 参数正确、roster 状态与产出全被取证', async () => {
  const { driverCtx, spawnCalls } = makeHarness({ sequence: ['running', 'inactive'] })
  await agentDriver.setup(driverCtx, {
    setup: { agent: { mode: 'teammate', name: 'tk-0027-ab12', description: '自检队友' } },
  })
  await agentDriver.act(driverCtx, { agent: { prompt: '只回复 TESTKIT_OK' } })

  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].name, 'tk-0027-ab12')
  assert.equal(spawnCalls[0].description, '自检队友')
  assert.equal(spawnCalls[0].context, 'fresh')
  assert.equal(spawnCalls[0].provider, 'spawn', 'fresh 缺省用 spawn provider')
  assert.deepEqual(spawnCalls[0].prompt, [{ type: 'text', text: '只回复 TESTKIT_OK' }])
  assert.ok(spawnCalls[0].signal, '必须带 signal：roster.spawn 会 AbortSignal.any([request.signal, …])')

  const fixture = driverCtx.fixture
  assert.equal(fixture.getNote('teammateName'), 'tk-0027-ab12')
  assert.equal(fixture.getNote('teammateRole'), 'teammate')
  assert.equal(fixture.getNote('teammateId'), 'child-1')
  assert.equal(fixture.getNote('agentRunId'), 'child-1')
  assert.equal(fixture.getNote('teammateStatus'), 'running')
  assert.equal(fixture.getNote('teammateFinalStatus'), 'inactive')
  assert.equal(fixture.getNote('teammateWaitTimedOut'), false)
  assert.equal(fixture.getNote('teammateRetained'), true)
  assert.equal(fixture.getNote('teammateOutput'), 'TESTKIT_OK')
  assert.deepEqual(fixture.getNote('teammateOutputs'), ['TESTKIT_OK'])
  assert.equal(fixture.getNote('agentError'), undefined)
  assert.equal((fixture.getNote('teammateMembers')).length, 2)
  assert.equal(fixture.getNote('availableSubagentProviders').length, 2)
})

test('act：fork 上下文缺省走 fork provider', async () => {
  const { driverCtx, spawnCalls } = makeHarness()
  await agentDriver.setup(driverCtx, { setup: { agent: { mode: 'teammate', context: 'fork' } } })
  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })
  assert.equal(spawnCalls[0].provider, 'fork')
  assert.equal(spawnCalls[0].context, 'fork')
})

test('act：缺省自动生成唯一名（团队名永不复用）', async () => {
  const { driverCtx, spawnCalls } = makeHarness()
  await agentDriver.setup(driverCtx, { setup: { agent: { mode: 'teammate' } } })
  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })
  assert.match(String(spawnCalls[0].name), /^tk-0027-[a-z0-9]+$/)
  assertTeammateName(String(spawnCalls[0].name))
})

test('act：团队不支持的参数被如实记账（而不是静默忽略）', async () => {
  const { driverCtx } = makeHarness()
  await agentDriver.setup(driverCtx, {
    setup: {
      agent: {
        mode: 'teammate',
        label: 'x',
        model: 'deepseek-flash',
        toolFilter: { deny: ['bash'] },
        persona: '你是队友',
      },
    },
  })
  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })
  assert.deepEqual(driverCtx.fixture.getNote('teammateIgnoredSetup'), [
    'label',
    'model',
    'toolFilter',
    'persona',
  ])
})

test('act：动作级 mode 覆盖 setup（同一场景可混用两条通道）', async () => {
  const { driverCtx, spawnCalls } = makeHarness()
  // setup 没写 mode（= one-shot），act 显式要 teammate
  await agentDriver.setup(driverCtx, { setup: { agent: {} } })
  await agentDriver.act(driverCtx, { agent: { prompt: 'x', mode: 'teammate' } })
  assert.equal(spawnCalls.length, 1)
  assert.equal(driverCtx.fixture.getNote('teammateFinalStatus'), 'inactive')
})

test('act：spawn 抛错被记账（成员创建失败不该伪装成通过）', async () => {
  const { driverCtx } = makeHarness({ spawnError: new Error('TEAM_MEMBER_LIMIT') })
  await agentDriver.setup(driverCtx, { setup: { agent: { mode: 'teammate' } } })
  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })
  assert.match(String(driverCtx.fixture.getNote('agentError')), /TEAM_MEMBER_LIMIT/)
})

test('teardown：跑飞的 teammate 会被中断（只停当前轮次）', async () => {
  const { driverCtx, interrupts } = makeHarness()
  await agentDriver.setup(driverCtx, {
    setup: { agent: { mode: 'teammate', name: 'tk-0027-ab12' } },
  })
  await agentDriver.act(driverCtx, { agent: { prompt: 'x' } })
  await agentDriver.teardown?.(driverCtx)
  assert.deepEqual(interrupts, ['tk-0027-ab12'])
})

test('teardown：不调 interrupt 时静默（缺服务不炸）', async () => {
  const { driverCtx } = makeHarness({ teams: false })
  await agentDriver.setup(driverCtx, { setup: { agent: {} } })
  await agentDriver.teardown?.(driverCtx)
  assert.equal(driverCtx.fixture.getNote('teammateName'), undefined)
})

test('driver 元信息：仍只硬依赖 subagents（agentTeams 走能力探测）', () => {
  assert.deepEqual(agentDriver.requires, ['subagents'])
})
