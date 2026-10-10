/**
 * 错误消息质量（`src/analysis/causes.ts`）的判定表回归网。
 *
 * ## 守的是什么
 *
 * 目标是"读完就知道去哪儿"，所以本文件逐条钉住两件事：
 *   ① **有据可依**：每条原因都必须指回 outcome 上的具体证据
 *      （error / action.detail / 失败断言的 ref 与实际值 / rounds / releaseFailures / usage）；
 *   ② **不编**：没有认得出来的证据时，必须返回**空数组**——给一堆"可能原因"
 *      只会把真正的线索淹掉。
 *
 * ## 为什么手工造 outcome 而不跑 runner
 *
 * 这些规则读的是 outcome 的**字段形状**。把 shape 直接写出来，能精确构造
 * 每一种判定路径（超时 / 预算 / 抖动 / 动作未跑通 / 取值失败 …），
 * 而不必真的制造出这些失败——后者又慢又不可靠。
 * 「真实 outcome 的形状确实长这样」由 runner 侧的既有测试保证。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LIKELIHOOD_LABEL, probableCauses, renderCauses } from '../lib/analysis/causes.js'

/* ---------------------------------------------------------------- 脚手架 -- */

/** 造一条 CaseOutcome（只填本模块会读的字段）。 */
function outcome(overrides = {}) {
  return {
    id: 'TK-9001',
    title: '假场景',
    kind: 'tool',
    verdict: 'failed',
    durationMs: 100,
    steps: [],
    notes: {},
    releaseFailures: [],
    sourceIssue: null,
    ...overrides,
  }
}

/** 造一步。`action` 省略 = 该步没有动作（纯断言步）。 */
function step(name, { action, assertions = [] } = {}) {
  return {
    name,
    ...(action === undefined ? {} : { action }),
    assertions,
    durationMs: 10,
  }
}

/** 造一条**失败**断言。 */
function failed({ ref, message, actual, is, soft = false }) {
  return {
    assertion: { ref, ...(is === undefined ? {} : { is }) },
    ok: false,
    actual,
    message,
    soft,
  }
}

/** 造一条**通过**断言（用于验证"只读失败断言"）。 */
function passed({ ref = 'fx.ok' } = {}) {
  return { assertion: { ref, exists: true }, ok: true, actual: 1, message: 'ok', soft: false }
}

/* ------------------------------------------------------------ 判定表逐条 -- */

test('causes：case_bug —— 断言引用的取证路径取不到值', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'case_bug',
      steps: [
        step('看输出', {
          assertions: [failed({ ref: 'fx.neverWritten', message: '取值失败：fx.neverWritten', actual: undefined })],
        }),
      ],
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].rank, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /ref|引用|用例/)
  assert.match(causes[0].evidence, /fx\.neverWritten/)
  assert.match(causes[0].nextStep, /fx \/ case \/ env/)
  assert.ok(causes[0].nextStep.length > 0)
})

test('causes：ref 前缀非法（结构性信号）也能识别，不依赖 failureCategory', () => {
  const causes = probableCauses(
    outcome({
      steps: [
        step('看输出', {
          assertions: [failed({ ref: 'foo.bar', message: '期望 "x"，实际 undefined', actual: undefined, is: 'x' })],
        }),
      ],
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].evidence, /foo\.bar/)
})

test('causes：env + 超时 —— 阈值偏紧 / 宿主慢 / 真的卡住', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'env',
      error: '超时（> 20000ms）',
      durationMs: 20_015,
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /时间上限/)
  assert.match(causes[0].evidence, /超时（> 20000ms）/)
  assert.match(causes[0].evidence, /20015ms/, '耗时必须进依据，否则无法判断"紧不紧"')
  assert.match(causes[0].nextStep, /重跑/)
})

test('causes：env + 预算超限 —— 本次运行的条件不足，不是结论', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'env',
      error: 'BudgetExceeded: 预算超限：模型调用次数上限 1 次，已用 2 次',
      usage: { modelCalls: 2, tokens: 0 },
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /预算/)
  assert.match(causes[0].evidence, /上限 1 次，已用 2 次/)
  assert.match(causes[0].evidence, /模型调用 2 次/, '用量要进依据：读者据此判断该加多少预算')
  assert.match(causes[0].nextStep, /budget|预算/)
})

test('causes：driver_bug + action.ok=false —— 动作没跑通（driver 与宿主契约不符）', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'driver_bug',
      steps: [
        step('注册工具', {
          action: {
            kind: 'tool:noop',
            ok: false,
            detail: 'Error: 宿主的 tools 服务不提供 register()',
          },
        }),
      ],
    }),
  )

  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /动作执行阶段/)
  assert.match(causes[0].cause, /契约/)
  assert.match(causes[0].evidence, /tool:noop/)
  assert.match(causes[0].evidence, /不提供 register/)
  assert.match(causes[0].evidence, /注册工具/, '要说清是哪一步')
})

test('causes：夹具释放失败 —— 有泄漏风险，后续结论不可信', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'driver_bug',
      releaseFailures: [{ label: 'llm:listener', error: 'dispose 失败：已经释放过了' }],
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /夹具|泄漏/)
  assert.match(causes[0].evidence, /llm:listener/)
  assert.match(causes[0].nextStep, /fx\.add/)
})

test('causes：errored + 没有对应 driver —— 装配问题', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'errored',
      error: 'kind=compaction 的 driver 尚未实现（见 docs/ROADMAP.md Phase 1）',
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /driver/)
  assert.match(causes[0].evidence, /尚未实现/)
})

test('causes：宿主条件不满足（能力 / 沙箱）', () => {
  const causes = probableCauses(
    outcome({ verdict: 'errored', error: 'EACCES: 沙箱拒绝写文件' }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /运行条件/)
  assert.match(causes[0].evidence, /沙箱/)
  assert.match(causes[0].nextStep, /sandbox/)
})

test('causes：product_bug + 期望/实际都在 —— medium（不冒充结论）', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'product_bug',
      steps: [
        step('看 stdout', {
          assertions: [failed({ ref: 'fx.stdout', message: '期望 "ok"，实际 "boom"', actual: 'boom', is: 'ok' })],
        }),
      ],
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'medium', '「断言写错但取到值」与「语义变了」不可区分，不能标 high')
  assert.match(causes[0].cause, /语义|期望/)
  assert.match(causes[0].evidence, /fx\.stdout/)
  assert.match(causes[0].evidence, /"ok"/)
  assert.match(causes[0].evidence, /"boom"/)
  assert.match(causes[0].nextStep, /单跑|最小复现/)
})

test('causes：product_bug 但实际值是 undefined —— low（两个方向都说得通）', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'product_bug',
      steps: [
        step('看输出', {
          assertions: [failed({ ref: 'fx.key', message: '期望 "a"，实际 undefined', actual: undefined, is: 'a' })],
        }),
      ],
    }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'low')
  assert.match(causes[0].cause, /undefined/)
  assert.match(causes[0].nextStep, /notes/)
})

test('causes：flaky（多轮不一致）—— 先怀疑时序 / 隔离', () => {
  const causes = probableCauses(
    outcome({ verdict: 'failed', failureCategory: 'flaky', rounds: [true, false, true] }),
  )

  assert.equal(causes.length, 1)
  assert.equal(causes[0].likelihood, 'high')
  assert.match(causes[0].cause, /不一致|抖动/)
  assert.match(causes[0].evidence, /通过 \/ 失败 \/ 通过/)
  assert.match(causes[0].nextStep, /连跑|repeat/)
})

/* --------------------------------------------------- 排序 / 封顶 / 空集 -- */

test('causes：按可能性排序、最多 3 条、rank 连续', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'env',
      error: '超时（> 20000ms）',
      rounds: [true, false],
      releaseFailures: [{ label: 'job:1', error: '释放失败' }],
      steps: [
        step('跑命令', {
          action: { kind: 'shell:rm', ok: false, detail: 'EACCES: permission denied' },
          assertions: [failed({ ref: 'fx.x', message: '取值失败：fx.x', actual: undefined })],
        }),
      ],
    }),
  )

  assert.equal(causes.length, 3, '封顶 3 条：并列太多猜测就等于没有结论')
  assert.deepEqual(
    causes.map((c) => c.rank),
    [1, 2, 3],
  )
  // 同为 high 时保持规则顺序（依据强弱）：抖动 → 超时 → 动作未跑通
  assert.match(causes[0].cause, /不一致|抖动/)
  assert.match(causes[1].cause, /时间上限/)
  assert.match(causes[2].cause, /动作执行阶段/)
})

test('causes：medium 排在 high 之后', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'product_bug',
      error: '超时（> 1000ms）',
      steps: [
        step('看输出', {
          assertions: [failed({ ref: 'fx.v', message: '期望 1，实际 2', actual: 2, is: 1 })],
        }),
      ],
    }),
  )

  assert.deepEqual(
    causes.map((c) => c.likelihood),
    ['high', 'medium'],
  )
  assert.deepEqual(
    causes.map((c) => c.rank),
    [1, 2],
  )
})

test('causes：不编 —— 没有依据时返回空数组', () => {
  // 通过：没有"原因"可谈
  assert.deepEqual(probableCauses(outcome({ verdict: 'passed' })), [])
  // 跳过：原因已经写在 skipReason 里，重复只是噪声
  assert.deepEqual(
    probableCauses(outcome({ verdict: 'skipped', skipReason: '宿主缺少能力：subprocess' })),
    [],
  )
  // 失败的引擎侧异常，但证据里没有任何本模块认得的信号
  assert.deepEqual(probableCauses(outcome({ verdict: 'failed', failureCategory: 'driver_bug' })), [])
  // 未识别的错误文本同样不猜
  assert.deepEqual(probableCauses(outcome({ verdict: 'errored', error: '莫名其妙的错误' })), [])
})

test('causes：case_bug 但找不到取值失败明细时如实说明，不编明细', () => {
  const causes = probableCauses(outcome({ verdict: 'failed', failureCategory: 'case_bug' }))

  assert.equal(causes.length, 1)
  assert.match(causes[0].evidence, /没有取值失败明细/)
  assert.match(causes[0].evidence, /（无错误文本）/)
})

test('causes：软断言失败不算证据（与 runner 的硬失败判定一致）', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'product_bug',
      steps: [
        step('软断言', {
          assertions: [
            { assertion: { ref: 'fx.v', is: 1 }, ok: false, actual: 2, message: '期望 1，实际 2', soft: true },
            passed(),
          ],
        }),
      ],
    }),
  )

  assert.deepEqual(causes, [])
})

test('causes：证据超长要截断（报告里一条原因不该占满一屏）', () => {
  const longError = `超时（> 20000ms）${'x'.repeat(600)}`
  const causes = probableCauses(outcome({ verdict: 'failed', failureCategory: 'env', error: longError }))

  assert.equal(causes.length, 1)
  const evidence = causes[0].evidence
  assert.ok(evidence.includes('…'), '长文本要带省略号')
  assert.ok(evidence.length < 400, `截断后不该太长：${evidence.length}`)
})

/* ------------------------------------------------------------- 渲染格式 -- */

test('renderCauses：固定格式含"可能性/依据/下一步"', () => {
  const causes = probableCauses(
    outcome({
      verdict: 'failed',
      failureCategory: 'case_bug',
      steps: [
        step('断言', { assertions: [failed({ ref: 'fx.nope', message: '取值失败：fx.nope', actual: undefined })] }),
      ],
    }),
  )
  const text = renderCauses(causes)

  assert.match(text, /^可能原因（按可能性排序）：/)
  assert.match(text, /1\. 原因：/)
  assert.match(text, /可能性：高/)
  assert.match(text, /依据：/)
  assert.match(text, /下一步：/)
  assert.equal(LIKELIHOOD_LABEL.high, '高')
  assert.equal(LIKELIHOOD_LABEL.medium, '中')
  assert.equal(LIKELIHOOD_LABEL.low, '低')
})

test('renderCauses：空集要如实说"不做推断"，不装样子', () => {
  const text = renderCauses([])
  assert.match(text, /无（证据不足，不做推断/)
  assert.ok(!text.includes('\n'), '空集就是一行，不该有列表骨架')
})
