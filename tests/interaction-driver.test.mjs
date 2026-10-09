/**
 * interaction driver 的单元测试。
 *
 * 这层重点验证「答者真的接上了」——因为这两个 waterfall 的兜底值
 * （`unavailable` / 抛错）是**宽松**的：如果 driver 没接上，
 * 断言写松一点就会静默通过。所以测试刻意断言到具体值。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  APPROVAL_OUTCOMES,
  buildAnswer,
  interactionDriver,
  normalizeDecision,
  TESTKIT_QUESTION_TIMEOUT,
} from '../lib/kinds/interaction.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('buildAnswer：answer 简写放进 selected', () => {
  const out = buildAnswer({ questions: [{ id: 'a' }] }, { answer: 'X' })
  assert.deepEqual(out.answers, [{ id: 'a', selected: ['X'] }])
})

test('buildAnswer：select 显式数组优先', () => {
  const out = buildAnswer({ questions: [{ id: 'a' }] }, { select: ['X', 'Y'] })
  assert.deepEqual(out.answers, [{ id: 'a', selected: ['X', 'Y'] }])
})

test('buildAnswer：显式 answers 原样透传', () => {
  const explicit = [{ id: 'a', selected: ['Z'], custom: '手写' }]
  const out = buildAnswer({ questions: [{ id: 'a' }] }, { answers: explicit })
  assert.equal(out.answers, explicit)
})

test('buildAnswer：问题缺 id 时回退到 q1/q2', () => {
  const out = buildAnswer({ questions: [{}, { id: '' }] }, { answer: 'X' })
  assert.deepEqual(
    out.answers.map((a) => a.id),
    ['q1', 'q2'],
  )
})

test('buildAnswer：没有 questions 时产出空数组（不崩）', () => {
  assert.deepEqual(buildAnswer(undefined, { answer: 'X' }).answers, [])
  assert.deepEqual(buildAnswer({}, { answer: 'X' }).answers, [])
})

test('buildAnswer：custom 会被带上', () => {
  const out = buildAnswer({ questions: [{ id: 'a' }] }, { custom: '我自己写' })
  assert.equal(out.answers[0].custom, '我自己写')
  assert.deepEqual(out.answers[0].selected, [], '只给 custom 时 selected 为空')
})

test('normalizeDecision：合法词汇通过，缺省 rejected', () => {
  assert.equal(normalizeDecision({}), 'rejected')
  for (const outcome of APPROVAL_OUTCOMES) {
    assert.equal(normalizeDecision({ decision: outcome }), outcome)
  }
})

test('normalizeDecision：非法词汇给出带词汇表的错误', () => {
  assert.throws(
    () => normalizeDecision({ decision: 'yes' }),
    /不合法：「yes」.*allowed-once/s,
  )
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness({ services = ['userQuestions', 'approval'] } = {}) {
  const ctx = new Context()

  if (services.includes('userQuestions')) {
    ctx.provide('userQuestions', {
      ask(request) {
        return ctx.waterfall(ctx, 'user-questions/request', request, () => ({ answers: [] }))
      },
    })
  }
  if (services.includes('approval')) {
    ctx.provide('approval', {
      request(req) {
        return ctx.waterfall(ctx, 'approval/request', req, () => 'unavailable')
      },
    })
  }

  return ctx
}

function makeDriverCtx(ctx) {
  return {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
}

test('setup：question 分支要求 userQuestions 能力', async () => {
  const ctx = makeHarness({ services: ['approval'] })
  const driverCtx = makeDriverCtx(ctx)
  const scenario = { setup: { interaction: { question: { answer: 'X' } } } }

  await assert.rejects(() => interactionDriver.setup(driverCtx, scenario), SkipCase)
})

test('setup：approval-only 场景不因缺 userQuestions 而跳过', async () => {
  const ctx = makeHarness({ services: ['approval'] })
  const driverCtx = makeDriverCtx(ctx)
  const scenario = { setup: { interaction: { approval: { decision: 'allowed-once' } } } }

  await interactionDriver.setup(driverCtx, scenario)
  assert.equal(driverCtx.fixture.getNote('plannedDecision'), 'allowed-once')

  const report = await driverCtx.fixture.release()
  assert.equal(report.failures.length, 0)
})

test('setup：非法 decision 在注册前就被拦下', async () => {
  const ctx = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  const scenario = { setup: { interaction: { approval: { decision: 'yes' } } } }

  await assert.rejects(() => interactionDriver.setup(driverCtx, scenario), /不合法/)
})

test('act：提问被应答，且拿到的是声明值（不是兜底）', async () => {
  const ctx = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await interactionDriver.setup(driverCtx, {
    setup: { interaction: { question: { select: ['选项 A'] } } },
  })

  await interactionDriver.act(driverCtx, {
    interaction: { question: { question: '选一个', options: [{ label: '选项 A' }] } },
  })

  assert.equal(driverCtx.fixture.getNote('questionCount'), 1)
  assert.equal(driverCtx.fixture.getNote('questionError'), undefined)

  const answer = driverCtx.fixture.getNote('answer')
  assert.deepEqual(answer.answers, [{ id: 'testkit-q1', selected: ['选项 A'] }])

  await driverCtx.fixture.release()
})

test('act：故意不答时以超时错误收尾并记账', async () => {
  const ctx = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await interactionDriver.setup(driverCtx, { setup: { interaction: { question: { timeout: true } } } })

  await interactionDriver.act(driverCtx, { interaction: { question: { question: '没人答' } } })

  assert.match(String(driverCtx.fixture.getNote('questionError')), new RegExp(TESTKIT_QUESTION_TIMEOUT))
  assert.equal(driverCtx.fixture.getNote('answer'), undefined, '不应产生答案')

  await driverCtx.fixture.release()
})

test('act：审批返回声明的决策，而不是兜底的 unavailable', async () => {
  const ctx = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await interactionDriver.setup(driverCtx, { setup: { interaction: { approval: { decision: 'rejected' } } } })

  await interactionDriver.act(driverCtx, {
    interaction: { approval: { toolName: 'bash', reason: '测试' } },
  })

  assert.equal(driverCtx.fixture.getNote('approvalCount'), 1)
  assert.equal(driverCtx.fixture.getNote('approvalOutcome'), 'rejected')
  assert.equal(driverCtx.fixture.getNote('approvalError'), undefined)

  await driverCtx.fixture.release()
})

test('act：没有 driver 时兜底值是 unavailable（对照组）', async () => {
  const ctx = makeHarness()
  // 不调 setup：模拟"没装答者"
  const outcome = await Promise.resolve(
    ctx.waterfall(ctx, 'approval/request', { agent: { id: 'a' }, toolName: 'bash' }, () => 'unavailable'),
  )
  assert.equal(outcome, 'unavailable', '对照组证明兜底值确实是 unavailable')
})

test('act：非 interaction 动作直接报错', async () => {
  const ctx = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await assert.rejects(
    () => interactionDriver.act(driverCtx, { tool: 'x' }),
    /只支持 `interaction` 动作/,
  )
})

test('act：release 后答者被摘掉，兜底值重新生效', async () => {
  const ctx = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await interactionDriver.setup(driverCtx, { setup: { interaction: { approval: { decision: 'allowed-once' } } } })
  await driverCtx.fixture.release()

  const outcome = await Promise.resolve(
    ctx.waterfall(ctx, 'approval/request', { agent: { id: 'a' }, toolName: 'bash' }, () => 'unavailable'),
  )
  assert.equal(outcome, 'unavailable', '摘掉答者后应回到兜底，证明注册是可回滚的')
})

test('driver 元信息：kind 正确，且不静态声明 requires', () => {
  assert.equal(interactionDriver.kind, 'interaction')
  assert.equal(interactionDriver.requires, undefined, '不该静态声明（会让 approval-only 场景被误跳过）')
})
