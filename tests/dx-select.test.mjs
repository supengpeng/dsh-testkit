/**
 * 本地 DX（`src/dx/`）的回归网：筛选、smoke 集、watch。
 *
 * ## 守的是什么
 *
 *   · **筛选每一步都要能自证**：`reason` 必须写清哪一条过滤把多少条收窄成了多少条——
 *     本地最常见的困惑是"我加了筛选，跑了 0 条，不知道为什么"；
 *   · **smoke 集不超预算**：估算可以粗糙，但不变式是硬的（`estimateMs <= budgetMs`），
 *     且所有对外文本都必须写明"静态估算，不是实测"；
 *   · **watch 要真的合并**：用真实临时目录 + 连续写入验证防抖，
 *     并保证目录不存在时**明确报错**而不是静默不干活。
 *
 * ## 超时保护
 *
 * watch 的测试全程走 `waitFor(..., 超时)`，绝不会因为平台不派发事件而挂住整个测试进程。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  DEFAULT_DEBOUNCE_MS,
  applyDxFilter,
  effectiveCost,
  estimateCaseMs,
  suggestSmokeSet,
  watchCases,
} from '../lib/dx/index.js'

/* ---------------------------------------------------------------- 脚手架 -- */

/** 造一条场景（只填 DX 会读的字段）。 */
function sc(id, { kind = 'tool', tags = [], owner, cost, status } = {}) {
  return {
    schema: 1,
    id,
    title: `${id} 的标题`,
    kind,
    ...(status === undefined ? {} : { status }),
    tags,
    ...(owner === undefined ? {} : { owner }),
    ...(cost === undefined ? {} : { cost }),
    source: { issue: null },
    setup: {},
    steps: [],
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 轮询等待，超时抛错（防止 watch 测试挂住）。 */
async function waitFor(get, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = get()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${message}`)
    await sleep(10)
  }
}

/* ------------------------------------------------------------- 基础筛选 -- */

test('applyDxFilter：默认只跑 active（draft/retired 不混进本地回归），reason 说清收窄过程', () => {
  const all = [sc('TK-0001'), sc('TK-0002', { status: 'draft' }), sc('TK-0003', { status: 'retired' })]
  const result = applyDxFilter(all)

  assert.deepEqual(result.ids, ['TK-0001'])
  assert.equal(result.matched[0].id, 'TK-0001')
  assert.match(result.reason, /筛选：起点 3 条/)
  assert.match(result.reason, /status ∈ \[active\]（默认/)
  assert.match(result.reason, /3 → 1/)
  assert.match(result.reason, /→ 命中 1\/3 条/)
})

test('applyDxFilter：only / kinds / tags / owner 组合（"与"关系）', () => {
  const all = [
    sc('TK-0001', { kind: 'tool', tags: ['smoke'], owner: '@a' }),
    sc('TK-0002', { kind: 'agent', tags: ['smoke'], owner: '@a' }),
    sc('TK-0003', { kind: 'tool', tags: ['boundary'], owner: '@b' }),
  ]

  assert.deepEqual(applyDxFilter(all, { kinds: ['tool'], tags: ['smoke'], owner: '@a' }).ids, [
    'TK-0001',
  ])
  assert.deepEqual(applyDxFilter(all, { only: ['TK-0003'] }).ids, ['TK-0003'])
  // tags 与 registry.filter 同语义：任一命中
  assert.deepEqual(applyDxFilter(all, { tags: ['smoke', 'boundary'] }).ids, [
    'TK-0001',
    'TK-0002',
    'TK-0003',
  ])
  assert.deepEqual(applyDxFilter(all, { kinds: ['tool'] }).ids, ['TK-0001', 'TK-0003'])
  // 全部条件叠加后为空：reason 必须给出"放宽哪一条"
  const none = applyDxFilter(all, { kinds: ['agent'], owner: '@b' })
  assert.deepEqual(none.ids, [])
  assert.match(none.reason, /→ 命中 0\/3 条/)
  assert.match(none.reason, /最严的一条是「owner = @b」/)
})

test('applyDxFilter：cost 是"最高允许档（含）"，不是"只看这一档"', () => {
  const all = [
    sc('TK-0001', { kind: 'tool' }), // none
    sc('TK-0002', { kind: 'shell' }), // low
    sc('TK-0003', { kind: 'agent' }), // high
    sc('TK-0004', { kind: 'agent', cost: 'none' }), // 场景显式降档
  ]

  assert.deepEqual(applyDxFilter(all, { cost: 'none' }).ids, ['TK-0001', 'TK-0004'])
  assert.deepEqual(applyDxFilter(all, { cost: 'low' }).ids, ['TK-0001', 'TK-0002', 'TK-0004'])
  assert.deepEqual(applyDxFilter(all, { cost: 'high' }).ids, [
    'TK-0001',
    'TK-0002',
    'TK-0003',
    'TK-0004',
  ])
  assert.match(applyDxFilter(all, { cost: 'none' }).reason, /成本档 ≤ none/)
})

test('applyDxFilter：空输入也要给可读提示，而不是一句"0 条"', () => {
  const result = applyDxFilter([])
  assert.deepEqual(result.ids, [])
  assert.match(result.reason, /输入的场景集合是空的/)
})

/* ------------------------------------------------------------ 静态估算 -- */

test('effectiveCost / estimateCaseMs：档位与量级由 kind + 成本档共同决定', () => {
  assert.equal(effectiveCost(sc('x', { kind: 'tool' })), 'none')
  assert.equal(effectiveCost(sc('x', { kind: 'shell' })), 'low')
  assert.equal(effectiveCost(sc('x', { kind: 'agent' })), 'high')
  assert.equal(effectiveCost(sc('x', { kind: 'agent', cost: 'none' })), 'none', '显式降档优先')

  assert.equal(estimateCaseMs(sc('x', { kind: 'tool' })), 60)
  assert.equal(estimateCaseMs(sc('x', { kind: 'shell' })), 360)
  assert.equal(estimateCaseMs(sc('x', { kind: 'agent' })), 4500)

  // 组合场景：参与 kind 里最贵的一档说了算（tool 60 + llm 40 + agent 3000 → 3000+1500）
  const combo = {
    ...sc('x', { kind: 'tool' }),
    setup: { llm: {} },
    steps: [{ act: { agent: { prompt: 'x' } } }],
  }
  assert.equal(effectiveCost(combo), 'high')
  assert.equal(estimateCaseMs(combo), 4500)
})

/* ------------------------------------------------------------- smoke 集 -- */

test('suggestSmokeSet：优先 tags 含 smoke；放不下的不纳入；reason 写明是静态估算', () => {
  const all = [
    sc('TK-0001', { kind: 'file', tags: ['smoke'] }), // 30
    sc('TK-0002', { kind: 'shell', tags: ['smoke'] }), // 300 + 60
    sc('TK-0003', { kind: 'ui' }), // 没 smoke 标签：不该被"顺便"选进来
  ]
  const result = suggestSmokeSet(all, { budgetMs: 100 })

  assert.deepEqual(result.ids, ['TK-0001'])
  assert.equal(result.estimateMs, 30)
  assert.ok(result.estimateMs <= 100, '不变式：估算不得超过预算')
  assert.match(result.reason, /静态估算（不是实测）/)
  assert.match(result.reason, /tags 含 smoke 的 2 条/)
  assert.match(result.reason, /未纳入 1 条/)
  assert.match(result.reason, /下一条 TK-0002/)
})

test('suggestSmokeSet：没有 smoke 标签时退回成本档 none，并按估算升序累加', () => {
  const all = [
    sc('TK-0001', { kind: 'tool' }), // none，60
    sc('TK-0002', { kind: 'shell' }), // low：不进候选池
    sc('TK-0003', { kind: 'ui' }), // none，20
  ]
  const result = suggestSmokeSet(all, { budgetMs: 100 })

  assert.deepEqual(result.ids, ['TK-0003', 'TK-0001'], '便宜的排前面')
  assert.equal(result.estimateMs, 80)
  assert.match(result.reason, /没有 tags 含 smoke 的场景，退回成本档 none 的 2 条/)
  assert.match(result.reason, /选中 2 条 ≈ 80ms/)
})

test('suggestSmokeSet：预算连最便宜的一条都放不下 → 空集 + 说清原因（不偷偷塞一条超预算的）', () => {
  const result = suggestSmokeSet([sc('TK-0001', { kind: 'tool', tags: ['smoke'] })], {
    budgetMs: 10,
  })

  assert.deepEqual(result.ids, [])
  assert.equal(result.estimateMs, 0)
  assert.ok(result.estimateMs <= 10)
  assert.match(result.reason, /单条就 ≈ 60ms，已超预算/)
  assert.match(result.reason, /提高预算/)
})

test('suggestSmokeSet：没有候选时返回空集并说明，不抛错', () => {
  const result = suggestSmokeSet([sc('TK-0001', { kind: 'shell' })], { budgetMs: 5_000 })
  assert.deepEqual(result.ids, [])
  assert.equal(result.estimateMs, 0)
  assert.match(result.reason, /可纳入 smoke 集的场景为空/)
})

test('suggestSmokeSet：同一输入产出同一结果（可复现，无隐藏时间依赖）', () => {
  const all = [
    sc('TK-0003', { kind: 'file', tags: ['smoke'] }),
    sc('TK-0001', { kind: 'tool', tags: ['smoke'] }),
    sc('TK-0002', { kind: 'ui', tags: ['smoke'] }),
  ]
  const a = suggestSmokeSet(all, { budgetMs: 200 })
  const b = suggestSmokeSet(all, { budgetMs: 200 })

  assert.deepEqual(a, b)
  assert.deepEqual(a.ids, ['TK-0002', 'TK-0003', 'TK-0001'], '同估算时按 id 升序兜底')
})

test('applyDxFilter：smoke 与前面的条件叠加，且保留输入顺序', () => {
  const all = [
    sc('TK-0001', { kind: 'tool', tags: ['smoke'] }), // 60
    sc('TK-0002', { kind: 'ui', tags: ['smoke'] }), // 20
    sc('TK-0003', { kind: 'agent', tags: ['smoke'] }), // 4500
    sc('TK-0004', { kind: 'ui', tags: ['other'] }), // 非 smoke 标签：不进池
  ]
  const result = applyDxFilter(all, { smoke: true, smokeBudgetMs: 100 })

  assert.deepEqual([...result.ids].sort(), ['TK-0001', 'TK-0002'])
  assert.match(result.reason, /smoke 集（静态估算 ≈ 80ms）/)
  assert.match(result.reason, /smoke 依据（静态估算，不是实测）：/)
  // 前面已有一层 status 过滤，smoke 是最后一层
  assert.match(result.reason, /→ 命中 2\/4 条/)
})

/* ----------------------------------------------------------------- watch -- */

test('watchCases：目录不存在 / 不是目录 → 明确报错，不静默', () => {
  assert.equal(DEFAULT_DEBOUNCE_MS, 250, '默认防抖窗口与 src/index.ts 的内联 watcher 一致')
  assert.throws(
    () => watchCases(join(tmpdir(), 'dsh-testkit-no-such-dir-4f2a'), () => undefined),
    /不存在/,
  )

  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-watch-'))
  try {
    const file = join(dir, 'a.txt')
    writeFileSync(file, 'x')
    assert.throws(() => watchCases(file, () => undefined), /不是目录/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('watchCases：连续写入被防抖合并成一次回调；close() 之后不再回调', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-watch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const changes = []
  // 防抖窗口取得比写入间隔大一个数量级：这样"三个事件落在同一个窗口"是确定的，
  // 而不是靠抢时序（不同平台的目录事件派发延迟差得很远）
  const watcher = watchCases(dir, (change) => changes.push(change), { debounceMs: 200 })
  t.after(() => watcher.close())

  assert.equal(watcher.active, true)
  assert.equal(watcher.dir, dir)

  for (let i = 1; i <= 3; i += 1) {
    writeFileSync(join(dir, `TK-000${i}.yaml`), 'schema: 1\n')
    await sleep(20)
  }

  // watcher 自身的 error 事件若有，单独看待（不参与"合并"断言）
  const first = await waitFor(
    () => changes.find((change) => change.type !== 'error'),
    4_000,
    '连续写入应触发一次变更回调',
  )
  assert.ok(
    first.events >= 2 || first.files.length >= 2,
    `三次写入应被合并（events=${first.events}，files=${first.files.join(',')}）`,
  )
  assert.ok(['change', 'rename'].includes(first.type), `事件类型应如实：${first.type}`)
  for (const name of first.files) {
    // 这条断言在 macOS 上真的红过：FSEvents 会把**被监听目录自身**也报上来，
    // 于是 files 里出现 `dsh-testkit-watch-xxxx`（目录名），调用方会去解析一个目录。
    assert.match(
      name,
      /^TK-000\d\.yaml$/,
      `文件名应来自本次写入（目录自身的事件不该进 files）：${name}`,
    )
  }

  // 再等一个完整窗口：合并后不该出现"一波接一波"（回调次数必须少于写入次数）
  await sleep(300)
  const callbacks = changes.filter((change) => change.type !== 'error')
  assert.ok(
    callbacks.length < 3,
    `三次写入应合并成更少的回调，实际 ${callbacks.length} 次：${JSON.stringify(callbacks)}`,
  )

  // close 之后：幂等、且不再派发
  watcher.close()
  assert.equal(watcher.active, false)
  assert.doesNotThrow(() => watcher.close(), 'close 必须幂等')

  const before = changes.length
  writeFileSync(join(dir, 'TK-0009.yaml'), 'schema: 1\n')
  await sleep(300)
  assert.equal(changes.length, before, 'close() 之后不应再有回调')
})
