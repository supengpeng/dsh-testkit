/**
 * `session` driver 的**会话与目标面**单元测试。
 *
 * 覆盖四个分支里新增的三个（`flush` / `goal` / `events`）：
 *   · `flush` —— 唯一入口是 `sessions.flush()`；契约承诺"等每个 listener 结算完"
 *   · `goal`  —— `create` 会 **arm 自动续轮**，driver 必须默认收回这个授权
 *   · `events`—— **只读**观察；本 driver 绝不 `Session.append()`
 *
 * 用假 sessions / goals 服务：不碰真会话日志（往里写东西是不可逆的），
 * 真实语义由 `cases/TK-0032`（flush/events）与 `TK-0033`（goals）在活宿主回答。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import { extractGoalCode, isMonotonicSeq, sessionDriver } from '../lib/kinds/session.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

const SESSION_ID = 'sess-1'

/* ------------------------------------------------------------ 纯函数层 -- */

test('extractGoalCode：code / info.code / message 三种形状都认', () => {
  assert.equal(extractGoalCode({ code: 'GOAL_NOT_FOUND' }), 'GOAL_NOT_FOUND')
  assert.equal(extractGoalCode({ info: { code: 'TEAM_TASK_STALE' } }), 'TEAM_TASK_STALE')
  assert.equal(extractGoalCode(new Error('rejected: GOAL_STALE_REVISION')), 'GOAL_STALE_REVISION')
  assert.equal(extractGoalCode(new Error('普通错误')), undefined)
  assert.equal(extractGoalCode(undefined), undefined)
})

test('isMonotonicSeq：严格递增才算单调', () => {
  assert.equal(isMonotonicSeq([]), true)
  assert.equal(isMonotonicSeq([1]), true)
  assert.equal(isMonotonicSeq([1, 2, 3]), true)
  assert.equal(isMonotonicSeq([1, 1]), false)
  assert.equal(isMonotonicSeq([2, 1]), false)
})

/* ------------------------------------------------------------ 假服务层 -- */

function makeGoalsFake({ remoteCrash = false } = {}) {
  const calls = []
  let view
  let revision = 0

  const bump = (patch) => {
    revision += 1
    view = { ...view, ...patch, revision }
    return view
  }

  return {
    calls,
    goals: {
      get: () => view,
      create: (_agent, request) => {
        calls.push({ op: 'create', request })
        revision += 1
        view = {
          id: 'goal-1',
          revision,
          objective: request.objective,
          phase: 'active',
          activation: 'armed',
          maxGoalRounds: request.maxGoalRounds ?? 12,
          roundsStarted: 0,
        }
        return view
      },
      disarm: () => {
        calls.push({ op: 'disarm' })
        return view === undefined ? undefined : bump({ activation: 'disarmed' })
      },
      edit: (_agent, ref, request) => {
        calls.push({ op: 'edit', ref, request })
        return bump({ objective: request.objective ?? view.objective })
      },
      pause: (_agent, ref) => {
        calls.push({ op: 'pause', ref })
        if (remoteCrash) {
          // DSH 里 pause 是 @Remote 方法：本地直调会崩在内部属性访问上
          throw new TypeError("Cannot read properties of undefined (reading 'transition')")
        }
        return bump({ phase: 'paused' })
      },
      resume: (_agent, ref) => {
        calls.push({ op: 'resume', ref })
        return bump({ phase: 'active' })
      },
      complete: (_agent, ref) => {
        calls.push({ op: 'complete', ref })
        return bump({ phase: 'complete' })
      },
      block: (_agent, ref, reason) => {
        calls.push({ op: 'block', ref, reason })
        return bump({ phase: 'blocked' })
      },
      clear: (_agent, ref) => {
        calls.push({ op: 'clear', ref })
        revision += 1
        const tombstone = { id: view.id, revision }
        view = undefined
        return tombstone
      },
    },
  }
}

function makeSessionsFake(ctx, { participated = true } = {}) {
  const session = { id: SESSION_ID, seq: 42 }
  const state = { flushCalls: 0 }
  return {
    session,
    state,
    sessions: {
      get: (id) => (id === SESSION_ID ? session : undefined),
      flush: async (target) => {
        state.flushCalls += 1
        // `session/flush` 是 **parallel** 事件（不是 waterfall）：parallel 语义下没有返回值，
        // 全部 listener 并发跑、调用方 await 它们全部结算。
        await ctx.parallel('session/flush', target)
        return participated
      },
    },
  }
}

function makeHarness({
  withSessions = true,
  withGoals = true,
  initiator = { id: SESSION_ID },
  participated = true,
  remoteCrash = false,
} = {}) {
  const ctx = new Context()
  const goalsFake = makeGoalsFake({ remoteCrash })
  const sessionsFake = makeSessionsFake(ctx, { participated })

  if (withSessions) ctx.provide('sessions', sessionsFake.sessions)
  if (withGoals) ctx.provide('goals', goalsFake.goals)
  ctx.provide('agents', { currentInitiator: () => initiator })
  ctx.provide('commands', { register: () => () => undefined })

  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return { ctx, driverCtx, goalsFake, sessionsFake }
}

/* ------------------------------------------------------------- flush 面 -- */

test('flush：宿主没有 sessions 能力时跳过', async () => {
  const { driverCtx } = makeHarness({ withSessions: false })
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })
  await assert.rejects(
    () => sessionDriver.act(driverCtx, { session: { flush: {} } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /sessions/)
      return true
    },
  )
})

test('flush：经唯一入口触发，并取证"有没有 listener 参与"', async () => {
  const { driverCtx, sessionsFake } = makeHarness({ participated: true })
  await sessionDriver.setup(driverCtx, {
    setup: { session: { flushObserver: { slowMs: 0 } } },
  })

  await sessionDriver.act(driverCtx, { session: { flush: { note: 'checkpoint' } } })

  assert.equal(sessionsFake.state.flushCalls, 1)
  assert.equal(driverCtx.fixture.getNote('sessionFlushSessionId'), SESSION_ID)
  assert.equal(driverCtx.fixture.getNote('sessionFlushParticipated'), true)
  assert.equal(driverCtx.fixture.getNote('sessionFlushNote'), 'checkpoint')
  assert.equal(driverCtx.fixture.getNote('sessionFlushObserverCalls'), 1)
  assert.equal(driverCtx.fixture.getNote('sessionFlushError'), undefined)
})

test('flush：慢观察者会拖长 flush —— 证明宿主真的 await 了 listener', async () => {
  const { driverCtx } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: { flushObserver: { slowMs: 40 } } } })

  await sessionDriver.act(driverCtx, { session: { flush: {} } })

  const duration = Number(driverCtx.fixture.getNote('sessionFlushDurationMs'))
  // 容差是必须的，不是放宽判据：`Date.now()` 起止各取整一次，`setTimeout(40)`
  // 也可能略早于名义值触发，所以实测**可能**是 39ms（CI 上真的红过一次）。
  // 这条用例要证的是"宿主真的 await 了 listener"，而不等待时这个值是 0–2ms——
  // 与 40 差一个量级，5ms 容差不会让任何"没等待"的实现蒙混过关。
  const TIMER_TOLERANCE_MS = 5
  assert.ok(
    duration >= 40 - TIMER_TOLERANCE_MS,
    `flush 必须等 listener 结算完，实际耗时 ${duration}ms`,
  )
  assert.equal(driverCtx.fixture.getNote('sessionFlushObserverDelayMs'), 40)
})

test('flush：宿主报告"没有 listener 参与"时如实记录', async () => {
  const { driverCtx } = makeHarness({ participated: false })
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, { session: { flush: {} } })

  assert.equal(driverCtx.fixture.getNote('sessionFlushParticipated'), false)
})

/* ------------------------------------------------------------ events 面 -- */

test('events：观察者只记本会话的事件，并给出单调性结论', async () => {
  const { ctx, driverCtx } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: { eventObserver: true } } })

  ctx.emit('session/event', { id: SESSION_ID }, { type: 'turn/start', seq: 1 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'step/start', seq: 2 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'assistant/message', seq: 3 })
  // 别的会话不该混进来
  ctx.emit('session/event', { id: 'other-session' }, { type: 'user/message', seq: 99 })

  await sessionDriver.act(driverCtx, { session: { events: { limit: 10 } } })

  assert.equal(driverCtx.fixture.getNote('sessionEventCount'), 3)
  assert.deepEqual(driverCtx.fixture.getNote('sessionEventTypes'), [
    'turn/start',
    'step/start',
    'assistant/message',
  ])
  assert.equal(driverCtx.fixture.getNote('sessionEventSeqMonotonic'), true)
  assert.deepEqual(driverCtx.fixture.getNote('sessionEvents'), [
    { type: 'turn/start', seq: 1 },
    { type: 'step/start', seq: 2 },
    { type: 'assistant/message', seq: 3 },
  ])
})

test('events：序号倒退时单调性判否（这就是它要抓的"日志乱序"）', async () => {
  const { ctx, driverCtx } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: { eventObserver: true } } })

  ctx.emit('session/event', { id: SESSION_ID }, { type: 'a', seq: 5 })
  ctx.emit('session/event', { id: SESSION_ID }, { type: 'b', seq: 3 })

  await sessionDriver.act(driverCtx, { session: { events: {} } })
  assert.equal(driverCtx.fixture.getNote('sessionEventSeqMonotonic'), false)
})

/* -------------------------------------------------------------- goals 面 -- */

test('goal：没有 goals 服务时跳过', async () => {
  const { driverCtx } = makeHarness({ withGoals: false })
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })
  await assert.rejects(
    () => sessionDriver.act(driverCtx, { session: { goal: { op: 'get' } } }),
    SkipCase,
  )
})

test('goal：拿不到当前 agent 时跳过（目标服务要确切活 agent 作凭据）', async () => {
  const { driverCtx } = makeHarness({ initiator: null })
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })
  await assert.rejects(
    () => sessionDriver.act(driverCtx, { session: { goal: { op: 'get' } } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /确切的活 agent/)
      return true
    },
  )
})

test('goal：create 记录 armed，并**默认立刻收回授权**（不留下自动续轮）', async () => {
  const { driverCtx, goalsFake } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, {
    session: { goal: { op: 'create', objective: '把四件事做完', maxGoalRounds: 7 } },
  })

  assert.equal(driverCtx.fixture.getNote('goalOp'), 'create')
  assert.equal(driverCtx.fixture.getNote('goalCreatedPhase'), 'active')
  assert.equal(driverCtx.fixture.getNote('goalCreatedActivation'), 'armed')
  assert.equal(driverCtx.fixture.getNote('goalAfterDisarmActivation'), 'disarmed')
  // 最后一帧视图是 disarm 之后的：phase 仍是 active（disarm 不动持久 phase）
  assert.equal(driverCtx.fixture.getNote('goalPhase'), 'active')
  assert.equal(driverCtx.fixture.getNote('goalActivation'), 'disarmed')
  assert.deepEqual(
    goalsFake.calls.map((c) => c.op),
    ['create', 'disarm'],
  )
})

test('goal：disarmAfter=false 时保留 armed（显式要求才这么做）', async () => {
  const { driverCtx, goalsFake } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, {
    session: { goal: { op: 'create', objective: 'x', disarmAfter: false } },
  })

  assert.equal(driverCtx.fixture.getNote('goalActivation'), 'armed')
  assert.equal(driverCtx.fixture.getNote('goalAfterDisarmActivation'), undefined)
  assert.deepEqual(
    goalsFake.calls.map((c) => c.op),
    ['create'],
  )
})

test('goal：pause / resume / complete 全链都带 revision 守卫', async () => {
  const { driverCtx, goalsFake } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, { session: { goal: { op: 'create', objective: 'x' } } })
  await sessionDriver.act(driverCtx, { session: { goal: { op: 'pause' } } })
  assert.equal(driverCtx.fixture.getNote('goalPhase'), 'paused')

  await sessionDriver.act(driverCtx, { session: { goal: { op: 'resume' } } })
  assert.equal(driverCtx.fixture.getNote('goalPhase'), 'active')

  await sessionDriver.act(driverCtx, { session: { goal: { op: 'complete' } } })
  assert.equal(driverCtx.fixture.getNote('goalPhase'), 'complete')

  // 每次操作都必须带上"上一次视图的 revision"作为 compare-and-set 守卫
  const guarded = goalsFake.calls.filter((c) => c.ref !== undefined)
  assert.ok(guarded.length >= 3)
  for (const call of guarded) {
    assert.equal(typeof call.ref.revision, 'number')
  }
})

test('goal：clear 返回墓碑 ref，且之后的 get 应为空', async () => {
  const { driverCtx } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, { session: { goal: { op: 'create', objective: 'x' } } })
  await sessionDriver.act(driverCtx, { session: { goal: { op: 'clear' } } })

  assert.equal(typeof driverCtx.fixture.getNote('goalClearedRevision'), 'number')
  assert.equal(driverCtx.fixture.getNote('goalExists'), false)
})

test('goal：没有当前目标时做 pause → 记 goalError（不抛）', async () => {
  const { driverCtx } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, { session: { goal: { op: 'pause' } } })
  assert.match(String(driverCtx.fixture.getNote('goalError')), /需要先有一个当前目标/)
})

test('goal：block 带稳定错误码写入', async () => {
  const { driverCtx, goalsFake } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.act(driverCtx, { session: { goal: { op: 'create', objective: 'x' } } })
  await sessionDriver.act(driverCtx, {
    session: { goal: { op: 'block', code: 'GOAL_BLOCKED_BY_TESTKIT', message: '测试阻塞' } },
  })

  assert.equal(driverCtx.fixture.getNote('goalPhase'), 'blocked')
  const block = goalsFake.calls.find((c) => c.op === 'block')
  assert.deepEqual(block.reason, { code: 'GOAL_BLOCKED_BY_TESTKIT', message: '测试阻塞' })
})

test('teardown：本场景创建过目标时留下墓碑（减少对宿主会话的影响）', async () => {
  const { driverCtx, goalsFake } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })
  await sessionDriver.act(driverCtx, { session: { goal: { op: 'create', objective: 'x' } } })

  await sessionDriver.teardown?.(driverCtx)

  assert.equal(driverCtx.fixture.getNote('goalTeardownCleared'), true)
  assert.ok(goalsFake.calls.some((c) => c.op === 'clear'))
})

test('teardown：没创建过目标时什么都不做', async () => {
  const { driverCtx, goalsFake } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })

  await sessionDriver.teardown?.(driverCtx)
  assert.equal(driverCtx.fixture.getNote('goalTeardownCleared'), undefined)
  assert.equal(goalsFake.calls.length, 0)
})

test('act：未知的 session 动作明确报错', async () => {
  const { driverCtx } = makeHarness()
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })
  await assert.rejects(
    () => sessionDriver.act(driverCtx, { session: { 未知: {} } }),
    /未知的 session 动作/,
  )
})

test('act：非 session 动作直接报错', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(() => sessionDriver.act(driverCtx, { tool: 'x' }), /只支持 `session` 动作/)
})

test('goal：@Remote 方法本地直调会崩 —— driver 把它翻译成明确诊断', async () => {
  const { driverCtx } = makeHarness({ remoteCrash: true })
  await sessionDriver.setup(driverCtx, { setup: { session: {} } })
  await sessionDriver.act(driverCtx, { session: { goal: { op: 'create', objective: 'x' } } })
  await sessionDriver.act(driverCtx, { session: { goal: { op: 'pause' } } })

  assert.match(String(driverCtx.fixture.getNote('goalError')), /reading 'transition'/)
  assert.equal(
    driverCtx.fixture.getNote('goalRemoteOpRequired'),
    true,
    '必须标记为「该操作需要经远程通道」，而不是让人读堆栈',
  )
})
