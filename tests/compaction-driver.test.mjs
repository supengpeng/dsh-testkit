/**
 * `compaction` driver 单元测试。
 *
 * 这个 driver 的首要设计约束不是"能不能压"，而是**绝不能压错对象**：
 * `compactRegion` / `compactNow` 会改写会话历史，所以在用户会话上做是破坏性的。
 * 因此这里重点守三件事：
 *   ① 缺省一定自建**隔离会话**（不落盘、不进任何对话）
 *   ② "没有可压的安全范围"（返回 `null`）是**正确行为**，不是失败
 *   ③ `compactNow` 需要 `runMaintenance`，隔离会话下必须如实记为不可用，
 *      而不是伪造一个假的 maintenance 回调把失败推后
 *
 * 用内存假服务；真实压缩行为由 `cases/TK-0034` 在活宿主回答。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  compactionDriver,
  extractCompactionCode,
  summarizeEventTypes,
} from '../lib/kinds/compaction.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('extractCompactionCode：code / info.code / message 三种形状都认', () => {
  assert.equal(extractCompactionCode({ code: 'COMPACTION_ACTIVE' }), 'COMPACTION_ACTIVE')
  assert.equal(extractCompactionCode({ info: { code: 'COMPACTION_RANGE_INVALID' } }), 'COMPACTION_RANGE_INVALID')
  assert.equal(
    extractCompactionCode(new Error('rejected: COMPACTION_UNBALANCED_RANGE')),
    'COMPACTION_UNBALANCED_RANGE',
  )
  assert.equal(extractCompactionCode(new Error('普通错误')), undefined)
  assert.equal(extractCompactionCode(undefined), undefined)
})

test('summarizeEventTypes：去重且保持首次出现顺序', () => {
  assert.deepEqual(summarizeEventTypes(undefined), [])
  assert.deepEqual(
    summarizeEventTypes([
      { type: 'turn/start' },
      { type: 'user/message' },
      { type: 'turn/start' },
      null,
      { type: 42 },
    ]),
    ['turn/start', 'user/message'],
  )
})

/* ------------------------------------------------------------ 假服务层 -- */

const CURRENT_ID = 'sess-current'

function makeHarness({
  withCompaction = true,
  withSessions = true,
  currentEvents = [{ type: 'turn/start', seq: 1 }, { type: 'user/message', seq: 2 }],
  ifNeededResult = null,
  regionResult,
  regionThrows,
  hasMaintenance = false,
  created = [],
} = {}) {
  const ctx = new Context()

  const currentSession = {
    id: CURRENT_ID,
    seq: currentEvents.length,
    snapshotEvents: () => currentEvents,
    surface: { nodes: [] },
  }

  const sessions = {
    get: (id) => (id === CURRENT_ID ? currentSession : undefined),
    create: (id, options) => {
      // 与真实契约一致（活宿主实测）：新会话自带 3 条 bootstrap 事件
      const bootstrap = [
        { type: 'permission/preset', seq: 1 },
        { type: 'sandbox/mode', seq: 2 },
        { type: 'approval/policy', seq: 3 },
      ]
      const session = {
        id: id ?? `session-${created.length + 1}`,
        seq: bootstrap.length,
        surface: { nodes: [] },
        snapshotEvents: () => [...bootstrap, ...(options?.seed ?? [])],
        ...(hasMaintenance ? { runMaintenance: async (task) => task(new AbortController().signal) } : {}),
      }
      created.push({ id: session.id, options })
      return session
    },
  }

  const calls = []
  const compaction = {
    compactIfNeeded: async (_agent, trigger) => {
      calls.push({ op: 'ifNeeded', trigger })
      return ifNeededResult
    },
    compactRegion: async (start, end, agent) => {
      calls.push({ op: 'region', start, end, agent })
      if (regionThrows !== undefined) throw regionThrows
      return regionResult ?? { compactionId: 'c-1', startSeq: start, summarySeq: 9, endSeq: end, shadowedSeqs: [start, end], shadowedTokenCount: 7, summary: [{ type: 'text', text: '摘要' }] }
    },
    compactNow: async () => {
      calls.push({ op: 'now' })
      return { compactionId: 'c-now', summary: [] }
    },
  }

  if (withCompaction) ctx.provide('compaction', compaction)
  if (withSessions) ctx.provide('sessions', sessions)
  ctx.provide('agents', { currentInitiator: () => ({ id: CURRENT_ID }) })

  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return { ctx, driverCtx, calls, created, currentSession }
}

/* -------------------------------------------------------------- setup 面 -- */

test('setup：没有 compaction 能力时跳过', async () => {
  const { driverCtx } = makeHarness({ withCompaction: false })
  await assert.rejects(
    () => compactionDriver.setup(driverCtx, { setup: { compaction: {} } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /compaction/)
      return true
    },
  )
})

test('setup：没有 sessions 能力时跳过（压缩必须有明确的会话目标）', async () => {
  const { driverCtx } = makeHarness({ withSessions: false })
  await assert.rejects(
    () => compactionDriver.setup(driverCtx, { setup: { compaction: {} } }),
    SkipCase,
  )
})

test('setup：缺省自建隔离会话（不落盘、不碰当前会话）', async () => {
  const { driverCtx, created } = makeHarness()
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })

  assert.equal(created.length, 1, '必须自建一个会话')
  assert.equal(created[0].id !== CURRENT_ID, true, '不能复用当前会话 id')
  assert.equal(driverCtx.fixture.getNote('compactionIsolated'), true)
  assert.equal(driverCtx.fixture.getNote('compactionTarget'), 'isolated')
  assert.equal(driverCtx.fixture.getNote('compactionSeededEvents'), 0)
  assert.equal(driverCtx.fixture.getNote('compactionSessionId'), 'session-1')
})

test('setup：seed=current 时把当前会话已提交事件复制进隔离会话', async () => {
  const { driverCtx, created } = makeHarness()
  await compactionDriver.setup(driverCtx, { setup: { compaction: { seed: 'current' } } })

  assert.equal(driverCtx.fixture.getNote('compactionSeededEvents'), 2)
  assert.equal(created[0].options.seed.length, 2)
})

test('setup：target=current 时用当前会话，并明确标记非隔离', async () => {
  const { driverCtx, created } = makeHarness()
  await compactionDriver.setup(driverCtx, { setup: { compaction: { target: 'current' } } })

  assert.equal(created.length, 0, 'target=current 不该再建会话')
  assert.equal(driverCtx.fixture.getNote('compactionIsolated'), false)
  assert.equal(driverCtx.fixture.getNote('compactionSessionId'), CURRENT_ID)
})

/* ---------------------------------------------------------- ifNeeded 面 -- */

test('act：没有可压范围时返回 null —— 这是正确行为，不是失败', async () => {
  const { driverCtx, calls } = makeHarness({ ifNeededResult: null })
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })
  await compactionDriver.act(driverCtx, { compaction: { ifNeeded: {} } })

  assert.equal(driverCtx.fixture.getNote('compactionResultNull'), true)
  assert.equal(driverCtx.fixture.getNote('compactionTrigger'), 'pressure')
  assert.equal(driverCtx.fixture.getNote('compactionError'), undefined)
  assert.deepEqual(calls, [{ op: 'ifNeeded', trigger: 'pressure' }])
})

test('act：触发方式可指定（context-overflow）', async () => {
  const { driverCtx, calls } = makeHarness()
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })
  await compactionDriver.act(driverCtx, {
    compaction: { ifNeeded: { trigger: 'context-overflow' } },
  })

  assert.equal(calls[0].trigger, 'context-overflow')
  assert.equal(driverCtx.fixture.getNote('compactionTrigger'), 'context-overflow')
})

test('act：真压缩时把结果形状完整记进取证', async () => {
  const { driverCtx } = makeHarness({
    ifNeededResult: {
      compactionId: 'c-9',
      startSeq: 3,
      summarySeq: 12,
      endSeq: 8,
      shadowedRange: { start: 3, end: 8 },
      shadowedSeqs: [3, 4, 5, 6, 7, 8],
      shadowedTokenCount: 123,
      summary: [{ type: 'text', text: '这是摘要' }],
    },
  })
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })
  await compactionDriver.act(driverCtx, { compaction: { ifNeeded: {} } })

  assert.equal(driverCtx.fixture.getNote('compactionResultNull'), false)
  assert.equal(driverCtx.fixture.getNote('compactionCompactionId'), 'c-9')
  assert.equal(driverCtx.fixture.getNote('compactionSummarySeq'), 12)
  assert.equal(driverCtx.fixture.getNote('compactionShadowedTokenCount'), 123)
  assert.equal(driverCtx.fixture.getNote('compactionShadowedCount'), 6)
  assert.equal(driverCtx.fixture.getNote('compactionSummaryText'), '这是摘要')
})

/* ------------------------------------------------------------ region 面 -- */

test('act：region 强制压缩指定范围，并把边界记进取证', async () => {
  const { driverCtx, calls } = makeHarness()
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })
  await compactionDriver.act(driverCtx, { compaction: { region: { start: 1, end: 4 } } })

  assert.equal(driverCtx.fixture.getNote('compactionRegionStart'), 1)
  assert.equal(driverCtx.fixture.getNote('compactionRegionEnd'), 4)
  assert.equal(calls[0].op, 'region')
  assert.equal(calls[0].start, 1)
  assert.equal(calls[0].end, 4)
  // 压缩对象必须是隔离会话，而不是当前会话
  assert.equal(calls[0].agent.session.id !== CURRENT_ID, true)
})

test('act：范围不合法时如实记录错误码（不吞、不猜）', async () => {
  const { driverCtx } = makeHarness({
    regionThrows: Object.assign(new Error('range must be balanced'), {
      code: 'COMPACTION_UNBALANCED_RANGE',
    }),
  })
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })
  await compactionDriver.act(driverCtx, { compaction: { region: { start: 5, end: 2 } } })

  assert.match(String(driverCtx.fixture.getNote('compactionError')), /balanced/)
  assert.equal(driverCtx.fixture.getNote('compactionErrorCode'), 'COMPACTION_UNBALANCED_RANGE')
})

/* --------------------------------------------------------------- now 面 -- */

test('act：compactNow 缺 runMaintenance 时如实记为不可用（不伪造回调）', async () => {
  const { driverCtx, calls } = makeHarness({ hasMaintenance: false })
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })
  await compactionDriver.act(driverCtx, { compaction: { now: {} } })

  assert.equal(driverCtx.fixture.getNote('compactionHasRunMaintenance'), false)
  assert.match(String(driverCtx.fixture.getNote('compactionUnsupported')), /runMaintenance/)
  assert.equal(calls.length, 0, '不可用时根本不该调用 compactNow')
})

/* ----------------------------------------------------------- inspect 面 -- */

test('act：inspect 只读取证序号 / surface 节点 / 事件分布', async () => {
  const { driverCtx } = makeHarness({ currentEvents: [{ type: 'a', seq: 1 }, { type: 'b', seq: 2 }, { type: 'a', seq: 3 }] })
  await compactionDriver.setup(driverCtx, { setup: { compaction: { seed: 'current' } } })
  await compactionDriver.act(driverCtx, { compaction: { inspect: {} } })

  // 3 条 bootstrap（与真实一致）+ 3 条 seed
  assert.equal(driverCtx.fixture.getNote('compactionEventCount'), 6)
  assert.deepEqual(driverCtx.fixture.getNote('compactionEventTypes'), [
    'permission/preset',
    'sandbox/mode',
    'approval/policy',
    'a',
    'b',
  ])
  assert.equal(driverCtx.fixture.getNote('compactionSeq'), 3)
  assert.equal(driverCtx.fixture.getNote('compactionSurfaceNodes'), 0)
})

/* -------------------------------------------------------------- 契约面 -- */

test('act：非 compaction 动作直接报错；未知动作也报错', async () => {
  const { driverCtx } = makeHarness()
  await compactionDriver.setup(driverCtx, { setup: { compaction: {} } })

  await assert.rejects(
    () => compactionDriver.act(driverCtx, { tool: 'x' }),
    /只支持 `compaction` 动作/,
  )
  await assert.rejects(
    () => compactionDriver.act(driverCtx, { compaction: { 未知: {} } }),
    /未知的 compaction 动作/,
  )
})

test('act：没有 setup 时明确报错（而不是随手挑一个会话）', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(
    () => compactionDriver.act(driverCtx, { compaction: { inspect: {} } }),
    /setup\.compaction 未执行/,
  )
})
