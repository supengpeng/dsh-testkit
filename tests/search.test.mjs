/**
 * 场景搜索的单测。
 *
 * 重点：
 *   · 全文匹配的字段面（id/title/kind/tags/owner/issue/summary/setup/步骤的 name/use/act/expect）
 *     且**命中理由回显字段名**——不然用户只能一条条点开对照；
 *   · 结构化过滤（kinds/tags/owner/cost/status）与多条件 AND；
 *   · 0 条必须解释清楚：是"某个条件本身没东西"，还是"单看都有、交集为空"。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { CaseRegistry } from '../lib/cases/registry.js'
import { renderSearchResult, searchScenarios } from '../lib/insight/search.js'

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

const SAMPLE = [
  scenario('TK-0001', {
    title: '注册的临时工具可被调用并返回指定值',
    tags: ['tool', 'smoke'],
    owner: '@alice',
    steps: [{ name: '调用临时工具', act: { tool: { name: 'testkit_echo', args: { text: 'hi' } } }, expect: [] }],
  }),
  scenario('TK-0006', {
    kind: 'llm',
    title: '流中途注入错误时应以 error finish 收尾',
    tags: ['llm', 'failure-injection'],
    owner: '@bob',
    source: { issue: 'https://example.com/issues/57', summary: 'mid-stream error boundary' },
    setup: { llm: { failMode: 'mid-stream-error' } },
    steps: [
      { name: '触发模型流', act: { llm: { prompt: 'x' } }, expect: [{ ref: 'fx.finishReason', is: 'error' }] },
    ],
  }),
  scenario('TK-0036', {
    kind: 'shell',
    title: '保留设备名的路径守卫',
    tags: ['shell', 'regression', 'dsh-memory'],
    status: 'draft',
    runtime: { timeoutMs: 8000 },
    steps: [{ name: '跑一条命令', act: { shell: { argv: ['node', '-e', 'process.exit(0)'] } }, expect: [] }],
  }),
]

/* ------------------------------------------------------------ 文本匹配 -- */

test('searchScenarios：不给条件 = 全部，并说清这是"未过滤"', () => {
  const result = searchScenarios(SAMPLE)
  assert.equal(result.total, 3)
  assert.equal(result.scanned, 3)
  assert.deepEqual(result.filterCounts, [])
  assert.match(result.reason, /未给过滤条件/)
})

test('searchScenarios：全文忽略大小写，且逐条回显命中字段', () => {
  const upper = searchScenarios(SAMPLE, { text: 'TIMEOUT' })
  const lower = searchScenarios(SAMPLE, { text: 'timeout' })
  assert.deepEqual(upper.hits.map((h) => h.id), lower.hits.map((h) => h.id))

  const byTitle = searchScenarios(SAMPLE, { text: '设备名' })
  assert.deepEqual(byTitle.hits.map((h) => h.id), ['TK-0036'])
  assert.ok(byTitle.hits[0].reasons.some((r) => r.startsWith('title 命中')))

  const byTag = searchScenarios(SAMPLE, { text: 'smoke' })
  assert.deepEqual(byTag.hits.map((h) => h.id), ['TK-0001'])
  assert.ok(byTag.hits[0].reasons.some((r) => r.startsWith('tags 命中')))

  const byStepName = searchScenarios(SAMPLE, { text: '触发模型流' })
  assert.deepEqual(byStepName.hits.map((h) => h.id), ['TK-0006'])
  assert.ok(byStepName.hits[0].reasons.some((r) => r.includes('步骤1.name')))

  // 步骤的 act / expect 也要能搜到（这是"全文"的实际含义）
  const byAct = searchScenarios(SAMPLE, { text: 'testkit_echo' })
  assert.deepEqual(byAct.hits.map((h) => h.id), ['TK-0001'])
  assert.ok(byAct.hits[0].reasons.some((r) => r.includes('.act')))

  const byExpect = searchScenarios(SAMPLE, { text: 'fx.finishReason' })
  assert.deepEqual(byExpect.hits.map((h) => h.id), ['TK-0006'])
  assert.ok(byExpect.hits[0].reasons.some((r) => r.includes('.expect')))

  const byIssue = searchScenarios(SAMPLE, { text: 'issues/57' })
  assert.deepEqual(byIssue.hits.map((h) => h.id), ['TK-0006'])
  assert.ok(byIssue.hits[0].reasons.some((r) => r.startsWith('issue 命中')))

  const bySummary = searchScenarios(SAMPLE, { text: 'mid-stream error' })
  assert.deepEqual(bySummary.hits.map((h) => h.id), ['TK-0006'])

  const bySetup = searchScenarios(SAMPLE, { text: 'failMode' })
  assert.deepEqual(bySetup.hits.map((h) => h.id), ['TK-0006'])

  const byId = searchScenarios(SAMPLE, { text: 'tk-0001' })
  assert.deepEqual(byId.hits.map((h) => h.id), ['TK-0001'])
  assert.ok(byId.hits[0].reasons.some((r) => r.startsWith('id 命中')))

  // 多条命中时按"命中字段数"排序（更相关的在前）
  const many = searchScenarios(SAMPLE, { text: 'llm' })
  assert.deepEqual(many.hits.map((h) => h.id), ['TK-0006'])
  assert.ok(many.hits[0].score >= 2, 'kind + tags + setup 都该命中')
})

/* -------------------------------------------------------- 结构化过滤 -- */

test('searchScenarios：kinds / tags / owner / cost / status 过滤', () => {
  assert.deepEqual(searchScenarios(SAMPLE, { kinds: ['llm'] }).hits.map((h) => h.id), ['TK-0006'])
  assert.deepEqual(searchScenarios(SAMPLE, { tags: ['SHELL'] }).hits.map((h) => h.id), ['TK-0036'])
  assert.deepEqual(searchScenarios(SAMPLE, { tags: ['smoke', 'regression'] }).hits.map((h) => h.id), [
    'TK-0001',
    'TK-0036',
  ])

  // owner 忽略大小写与 @ 前缀
  assert.deepEqual(searchScenarios(SAMPLE, { owner: 'alice' }).hits.map((h) => h.id), ['TK-0001'])
  assert.deepEqual(searchScenarios(SAMPLE, { owner: '@ALICE' }).hits.map((h) => h.id), ['TK-0001'])

  // cost：未声明时取 driver 默认档（tool/llm = none、shell = low）；显式声明优先
  assert.deepEqual(searchScenarios(SAMPLE, { cost: 'none' }).hits.map((h) => h.id), ['TK-0001', 'TK-0006'])
  assert.deepEqual(searchScenarios(SAMPLE, { cost: 'low' }).hits.map((h) => h.id), ['TK-0036'])
  const explicit = [
    scenario('TK-0100', { kind: 'compaction' }),
    scenario('TK-0101', { kind: 'compaction', cost: 'none' }),
  ]
  assert.deepEqual(searchScenarios(explicit, { cost: 'high' }).hits.map((h) => h.id), ['TK-0100'])
  assert.deepEqual(searchScenarios(explicit, { cost: 'none' }).hits.map((h) => h.id), ['TK-0101'])

  // status：默认不限制（draft 也能搜到），显式给才过滤
  assert.ok(searchScenarios(SAMPLE, { text: '设备名' }).hits.some((h) => h.status === 'draft'))
  assert.equal(searchScenarios(SAMPLE, { kinds: ['shell'], status: 'active' }).total, 0)
  assert.deepEqual(searchScenarios(SAMPLE, { kinds: ['shell'], status: 'draft' }).hits.map((h) => h.id), [
    'TK-0036',
  ])
})

test('searchScenarios：多条件是 AND，且命中理由保留文本证据', () => {
  const result = searchScenarios(SAMPLE, { text: 'error', kinds: ['llm'], tags: ['failure-injection'] })
  assert.deepEqual(result.hits.map((h) => h.id), ['TK-0006'])
  assert.ok(result.hits[0].reasons.length > 0)
  assert.match(result.reason, /命中 1\/3/)

  assert.equal(searchScenarios(SAMPLE, { text: 'error', kinds: ['shell'] }).total, 0)
})

/* ---------------------------------------------------------- 0 条的解释 -- */

test('searchScenarios：0 条时区分"条件本身没有"与"交集为空"', () => {
  // ① 各条件单独都有命中，但交集为空
  const intersect = searchScenarios(SAMPLE, { kinds: ['llm'], tags: ['smoke'] })
  assert.equal(intersect.total, 0)
  assert.match(intersect.reason, /同时/)
  assert.deepEqual(
    intersect.filterCounts.map((item) => item.matched),
    [1, 1],
    '单独看 kinds=llm 命中 1 条、tags=smoke 命中 1 条',
  )

  // ② 某个条件本身就没有命中
  const missing = searchScenarios(SAMPLE, { text: '这个关键词不存在-zzz', kinds: ['llm'] })
  assert.equal(missing.total, 0)
  assert.match(missing.reason, /条件本身就没有命中/)
  assert.equal(missing.filterCounts.find((item) => item.filter.startsWith('text'))?.matched, 0)
  assert.equal(missing.filterCounts.find((item) => item.filter.startsWith('kinds'))?.matched, 1)
})

/* --------------------------------------------------------------- 渲染 -- */

test('renderSearchResult：命中出表并带理由；0 条回显各条件单独命中数', () => {
  const hitText = renderSearchResult(searchScenarios(SAMPLE, { text: 'llm' }))
  assert.match(hitText, /## 场景搜索/)
  assert.match(hitText, /\| ID \| kind \| status \| owner \| cost \| tags \| 命中理由 \|/)
  assert.match(hitText, /TK-0006/)
  assert.match(hitText, /命中/)

  const emptyText = renderSearchResult(searchScenarios(SAMPLE, { kinds: ['llm'], tags: ['smoke'] }))
  assert.match(emptyText, /命中：0\/3/)
  assert.match(emptyText, /\| 条件 \| 单独命中 \|/)
  assert.match(emptyText, /kinds=llm \| 1/)
})

/* --------------------------------------------------------- 真实 cases/ -- */

test('searchScenarios：在真实 cases/ 上可用（smoke 集 / kind / 无 owner 的解释）', () => {
  const registry = new CaseRegistry(join(REPO_ROOT, 'cases'))
  registry.reload()
  const scenarios = registry.all

  const smoke = searchScenarios(scenarios, { tags: ['smoke'] })
  assert.ok(smoke.total >= 1, '当前 cases/ 应有 smoke 场景')
  for (const hit of smoke.hits) assert.ok(hit.tags.some((tag) => tag.toLowerCase() === 'smoke'))

  const fs = searchScenarios(scenarios, { kinds: ['fs'] })
  assert.ok(fs.total >= 1)
  for (const hit of fs.hits) assert.equal(hit.kind, 'fs')

  // 真实数据里目前没有 owner：0 条必须说清"条件本身就没有命中"，而不是含糊的"没找到"
  const ownerResult = searchScenarios(scenarios, { owner: '@nobody-here' })
  if (ownerResult.total === 0) {
    assert.match(ownerResult.reason, /条件本身就没有命中|同时/)
    const ownerCount = scenarios.filter((s) => s.owner !== undefined && s.owner !== '').length
    if (ownerCount === 0) assert.equal(ownerResult.filterCounts[0].matched, 0)
  }

  // 场景总数与搜索扫描总数一致
  assert.equal(searchScenarios(scenarios, {}).scanned, scenarios.length)
})
