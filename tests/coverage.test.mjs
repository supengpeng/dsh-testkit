/**
 * 覆盖矩阵与缺口的单测。
 *
 * 两条主线：
 *   ① **真实 cases/**：矩阵读数必须与 registry 自洽（每条 kind 的计数和 = 总数），
 *      且已注册的 kind 一个都不能漏（0 条的 kind 也必须出现在表里——那才是缺口）；
 *   ② **人造场景**：把缺口规则逐条钉住（无 active / 无 owner / 无 tag / 无 smoke /
 *      无 fixture / 空 kind），并确认每条缺口都带了"怎么补"。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { CaseRegistry } from '../lib/cases/registry.js'
import { SCENARIO_KINDS } from '../lib/cases/types.js'
import { buildCoverage, renderCoverage } from '../lib/insight/coverage.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function scenario(id, extra = {}) {
  return {
    schema: 1,
    id,
    title: `${id} 标题`,
    kind: 'tool',
    source: { issue: null },
    setup: {},
    steps: [{ name: '一步', expect: [] }],
    ...extra,
  }
}

function realScenarios() {
  const registry = new CaseRegistry(join(REPO_ROOT, 'cases'))
  registry.reload()
  return registry.all
}

/* ---------------------------------------------------------- 真实 cases/ -- */

test('覆盖矩阵（真实 cases/）：读数与 registry 自洽，且不漏任何已注册 kind', () => {
  const scenarios = realScenarios()
  const report = buildCoverage(scenarios)

  // 当前读数是 39 条 / 12 kind。这里用 >= 而不是 ===：协作者加场景不该让别人的门变红，
  // 真正的不变量是"矩阵与 registry 完全一致"（下面几条），那比一个会过期的数字更硬。
  assert.ok(
    report.totals.scenarios >= 39,
    `场景数应不少于 39（当前 ${report.totals.scenarios}）——场景集不该缩水`,
  )
  assert.equal(report.totals.scenarios, scenarios.length, '矩阵总数必须等于传入的场景数')

  const presentKinds = new Set(scenarios.map((s) => s.kind))
  assert.ok(presentKinds.size >= 12, `当前应有 12 个 kind 有场景，实际 ${presentKinds.size}`)

  const rowsInOrder = report.rows.map((row) => row.kind)
  assert.deepEqual(rowsInOrder, [...SCENARIO_KINDS], '行序必须固定为 SCENARIO_KINDS（可复现）')

  const rowSum = report.rows.reduce((sum, row) => sum + row.total, 0)
  assert.equal(rowSum, scenarios.length, '每行 total 之和 = 场景总数')

  for (const row of report.rows) {
    const mine = scenarios.filter((s) => s.kind === row.kind)
    assert.equal(row.total, mine.length, `${row.kind} 的 total 应与 registry 一致`)
    assert.equal(row.active, mine.filter((s) => (s.status ?? 'active') === 'active').length)
    assert.equal(row.draft, mine.filter((s) => s.status === 'draft').length)
    assert.equal(row.withOwner, mine.filter((s) => typeof s.owner === 'string' && s.owner !== '').length)
    assert.equal(row.tagged, mine.filter((s) => (s.tags ?? []).length > 0).length)
    assert.equal(row.smoke, mine.filter((s) => (s.tags ?? []).includes('smoke')).length)
    const costSum = Object.values(row.costs).reduce((sum, count) => sum + count, 0)
    assert.equal(costSum, row.total, `${row.kind} 的成本档分布之和应等于 total`)
  }

  // 缺口必须"可行动"：message / action 都不能为空
  for (const gap of report.gaps) {
    assert.ok(gap.message.length > 0, `${gap.code} 缺 message`)
    assert.ok(gap.action.length > 0, `${gap.code} 缺 action`)
    assert.ok(['high', 'medium', 'low'].includes(gap.severity))
    if (gap.code !== 'empty-kind' && gap.code !== 'no-fixture') {
      assert.ok(gap.ids.length > 0, `${gap.code} 应列出涉及哪些场景`)
    }
  }
  // 严重度排序：high 必须排在 medium 前面
  const rank = { high: 0, medium: 1, low: 2 }
  for (let i = 1; i < report.gaps.length; i += 1) {
    assert.ok(
      rank[report.gaps[i - 1].severity] <= rank[report.gaps[i].severity],
      '缺口必须按严重度排序',
    )
  }
})

/* ------------------------------------------------------------ 多例缺口 -- */

test('覆盖矩阵：人造小集合里，档位/成本/标签逐项正确', () => {
  const scenarios = [
    scenario('TK-9001', { kind: 'tool', tags: ['smoke'], owner: '@alice' }),
    scenario('TK-9002', { kind: 'tool', status: 'draft' }),
    scenario('TK-9003', { kind: 'llm', cost: 'high' }),
    scenario('TK-9004', { kind: 'shell', runtime: { timeoutMs: 2000 } }),
  ]
  const report = buildCoverage(scenarios, { smokeMs: 5000 })

  assert.equal(report.rows.length, SCENARIO_KINDS.length)
  const tool = report.rows.find((row) => row.kind === 'tool')
  assert.deepEqual(
    { total: tool.total, active: tool.active, draft: tool.draft, withOwner: tool.withOwner, tagged: tool.tagged, smoke: tool.smoke },
    { total: 2, active: 1, draft: 1, withOwner: 1, tagged: 1, smoke: 1 },
  )

  const llm = report.rows.find((row) => row.kind === 'llm')
  assert.equal(llm.costs.high, 1, '显式 cost 优先')

  const shell = report.rows.find((row) => row.kind === 'shell')
  assert.equal(shell.light, 1, 'timeoutMs ≤ smokeMs 记为轻量候选')
  assert.equal(report.totals.scenarios, 4)
  assert.equal(report.totals.kindsWithoutScenarios, SCENARIO_KINDS.length - 3)
})

test('覆盖矩阵：draft-only 的 kind 出 no-active（high），并给出涉及场景', () => {
  const scenarios = [
    scenario('TK-9101', { kind: 'fs', status: 'draft' }),
    scenario('TK-9102', { kind: 'fs', status: 'draft' }),
    scenario('TK-9103', { kind: 'tool' }),
  ]
  const report = buildCoverage(scenarios)
  const gap = report.gaps.find((item) => item.code === 'no-active' && item.scope === 'fs')
  assert.ok(gap, JSON.stringify(report.gaps.map((g) => [g.code, g.scope])))
  assert.equal(gap.severity, 'high')
  assert.deepEqual(gap.ids.sort(), ['TK-9101', 'TK-9102'])
  assert.match(gap.action, /active/)
})

test('覆盖矩阵：全局无 owner/tag/smoke 时出 1 条 ALL 缺口，而不是 12 条重复', () => {
  const scenarios = [scenario('TK-9201', { kind: 'tool' }), scenario('TK-9202', { kind: 'llm' })]
  const report = buildCoverage(scenarios)

  const ownerGaps = report.gaps.filter((gap) => gap.code === 'no-owner')
  assert.equal(ownerGaps.length, 1, JSON.stringify(ownerGaps.map((g) => g.scope)))
  assert.equal(ownerGaps[0].scope, 'ALL')
  assert.deepEqual(ownerGaps[0].ids.sort(), ['TK-9201', 'TK-9202'])

  assert.equal(report.gaps.filter((gap) => gap.code === 'no-tag').length, 1)
  const smokeGap = report.gaps.find((gap) => gap.code === 'no-smoke')
  assert.equal(smokeGap.scope, 'ALL')
  assert.equal(smokeGap.severity, 'high')
  assert.match(smokeGap.action, /smoke/)
})

test('覆盖矩阵：部分 kind 有 owner/tag 时，缺口精确落到缺的那些 kind 上', () => {
  const scenarios = [
    scenario('TK-9301', { kind: 'tool', owner: '@alice', tags: ['smoke'] }),
    scenario('TK-9302', { kind: 'llm' }),
  ]
  const report = buildCoverage(scenarios)
  const ownerGaps = report.gaps.filter((gap) => gap.code === 'no-owner')
  assert.deepEqual(ownerGaps.map((gap) => gap.scope), ['llm'])
  assert.deepEqual(ownerGaps[0].ids, ['TK-9302'])

  const smokeGaps = report.gaps.filter((gap) => gap.code === 'no-smoke' && gap.scope !== 'ALL')
  assert.deepEqual(smokeGaps.map((gap) => gap.scope), ['llm'])
})

test('覆盖矩阵：空集合 → 每个已注册 kind 都是 empty-kind（high）', () => {
  const report = buildCoverage([])
  assert.equal(report.totals.scenarios, 0)
  assert.equal(report.rows.length, SCENARIO_KINDS.length)
  for (const row of report.rows) assert.equal(row.total, 0)
  const emptyKinds = report.gaps.filter((gap) => gap.code === 'empty-kind')
  assert.equal(emptyKinds.length, SCENARIO_KINDS.length)
  assert.ok(emptyKinds.every((gap) => gap.severity === 'high' && gap.action.length > 0))
})

test('覆盖矩阵：smokeMs 会改变"轻量候选"的判定，并写进渲染与建议', () => {
  const scenarios = [
    scenario('TK-9401', { kind: 'tool', runtime: { timeoutMs: 3000 } }),
    // 让"仓库里已有 smoke"成立，这样 no-smoke 会落到缺的那一个 kind 上（而不是全局缺口）
    scenario('TK-9402', { kind: 'llm', tags: ['smoke'] }),
  ]

  const wide = buildCoverage(scenarios, { smokeMs: 5000 })
  assert.equal(wide.rows.find((row) => row.kind === 'tool').light, 1)
  assert.equal(wide.smokeMs, 5000)
  const wideGap = wide.gaps.find((item) => item.code === 'no-smoke' && item.scope === 'tool')
  assert.ok(wideGap, JSON.stringify(wide.gaps.map((g) => [g.code, g.scope])))
  assert.match(wideGap.message, /1 条 .*≤ 5000ms.* 的轻量候选/)
  assert.match(wideGap.action, /标上 `smoke` 标签/)

  const tight = buildCoverage(scenarios, { smokeMs: 100 })
  assert.equal(tight.rows.find((row) => row.kind === 'tool').light, 0)
  const tightGap = tight.gaps.find((item) => item.code === 'no-smoke' && item.scope === 'tool')
  assert.ok(tightGap)
  assert.match(tightGap.action, /≤ 100ms/)

  // 没声明 timeoutMs 的场景不算轻量候选（不猜默认超时）
  const unknown = buildCoverage([scenario('TK-9403', { kind: 'tool' })], { smokeMs: 999_999 })
  assert.equal(unknown.rows.find((row) => row.kind === 'tool').light, 0)
})

test('renderCoverage：出表 + 缺口（含"缺什么/怎么补"）', () => {
  const report = buildCoverage([
    scenario('TK-9501', { kind: 'fs', status: 'draft' }),
    scenario('TK-9502', { kind: 'tool', tags: ['smoke'], owner: '@bob' }),
  ])
  const text = renderCoverage(report)
  assert.match(text, /## 覆盖矩阵/)
  assert.match(text, /\| kind \| 场景数 \| active \| draft \|/)
  assert.match(text, /\| tool \|/)
  assert.match(text, /## 覆盖缺口/)
  assert.match(text, /缺什么：/)
  assert.match(text, /怎么补：/)
  assert.match(text, /\[高\] fs/)

  const emptyText = renderCoverage(buildCoverage([]))
  assert.match(emptyText, /empty-kind/)
})
