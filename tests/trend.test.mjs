/**
 * 结果趋势的单测：**用 mkdtemp 造人造 run.json 目录**，不依赖仓库里真实的历史产物
 * （那会随每次运行漂移）。
 *
 * 重点覆盖：
 *   · 正常聚合（按 kind 的通过/失败/跳过/错误与耗时）
 *   · 坏 JSON / 结构不对 / 目录不存在 → **跳过并计数**，不静默
 *   · flaky 率来自 `rounds` 里"有真有假"，且没有 rounds 时**不假装是 0**
 *   · dimension 切换（kind / owner / dshVersion / tag）
 *   · 样本不足时明确说"别据此下结论"
 *   · 只读：跑完之后产物目录一个字节都没变
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  buildTrend,
  collectRuns,
  isFlaky,
  percentile,
  renderTrend,
} from '../lib/insight/trend.js'

/* ------------------------------------------------------------ 造人造产物 -- */

function makeCase(id, extra = {}) {
  return {
    id,
    title: `${id} 标题`,
    kind: 'tool',
    verdict: 'passed',
    durationMs: 100,
    steps: [],
    notes: {},
    releaseFailures: [],
    sourceIssue: null,
    ...extra,
  }
}

function writeRun(root, name, { startedAt, dshVersion = '0.2.0-rc.2', cases }) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const totals = { total: cases.length, passed: 0, failed: 0, skipped: 0, errored: 0 }
  for (const item of cases) totals[item.verdict] += 1
  const summary = {
    runId: name,
    startedAt,
    finishedAt: startedAt,
    casesDir: 'C:/pkg/cases',
    dshVersion,
    platform: 'win32',
    totals,
    cases,
  }
  writeFileSync(join(dir, 'run.json'), JSON.stringify(summary, null, 2), 'utf8')
  return dir
}

function makeRunsDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-testkit-trend-'))
}

/* ------------------------------------------------------------- collectRuns -- */

test('collectRuns：读全部运行，坏 JSON 跳过并计数，按时间倒序', () => {
  const root = makeRunsDir()
  try {
    writeRun(root, '2026-10-01T00-00-00_aaaa', {
      startedAt: '2026-10-01T00:00:00.000Z',
      cases: [makeCase('TK-0001')],
    })
    writeRun(root, '2026-10-02T00-00-00_bbbb', {
      startedAt: '2026-10-02T00:00:00.000Z',
      cases: [makeCase('TK-0001'), makeCase('TK-0002', { verdict: 'failed' })],
    })
    writeRun(root, '2026-10-03T00-00-00_cccc', {
      startedAt: '2026-10-03T00:00:00.000Z',
      cases: [makeCase('TK-0003', { verdict: 'skipped' })],
    })
    // 坏件：非法 JSON
    mkdirSync(join(root, '2026-10-04T00-00-00_bad'), { recursive: true })
    writeFileSync(join(root, '2026-10-04T00-00-00_bad', 'run.json'), '{ 这不是 JSON', 'utf8')
    // 坏件：结构不对（缺 runId）
    mkdirSync(join(root, '2026-10-05T00-00-00_noid'), { recursive: true })
    writeFileSync(join(root, '2026-10-05T00-00-00_noid', 'run.json'), JSON.stringify({ cases: [] }), 'utf8')
    // 干扰项：没有 run.json 的目录 / 普通文件
    mkdirSync(join(root, 'empty-dir'), { recursive: true })
    writeFileSync(join(root, 'note.txt'), 'ignore me', 'utf8')

    const result = collectRuns(root)
    assert.equal(result.runs.length, 3)
    assert.deepEqual(
      result.runs.map((run) => run.summary.runId),
      ['2026-10-03T00-00-00_cccc', '2026-10-02T00-00-00_bbbb', '2026-10-01T00-00-00_aaaa'],
      '应按 startedAt 倒序',
    )
    assert.equal(result.skipped.length, 2)
    assert.ok(result.skipped.some((item) => /JSON 解析失败/.test(item.reason)))
    assert.ok(result.skipped.some((item) => /缺 runId/.test(item.reason)))
    for (const item of result.skipped) assert.ok(item.dir.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectRuns：limit 只取最新 N 次；目录不存在要如实报，而不是静默空', () => {
  const root = makeRunsDir()
  try {
    for (const day of ['01', '02', '03']) {
      writeRun(root, `2026-10-${day}T00-00-00_x`, {
        startedAt: `2026-10-${day}T00:00:00.000Z`,
        cases: [makeCase('TK-0001')],
      })
    }
    const limited = collectRuns(root, { limit: 2 })
    assert.equal(limited.runs.length, 2)
    assert.equal(limited.runs[0].summary.startedAt, '2026-10-03T00:00:00.000Z')

    const missing = collectRuns(join(root, 'no-such-dir'))
    assert.deepEqual(missing.runs, [])
    assert.equal(missing.skipped.length, 1)
    assert.match(missing.skipped[0].reason, /不存在/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectRuns 只读：跑完之后产物目录一个字节都没变', () => {
  const root = makeRunsDir()
  try {
    const dir = writeRun(root, '2026-10-01T00-00-00_aaaa', {
      startedAt: '2026-10-01T00:00:00.000Z',
      cases: [makeCase('TK-0001')],
    })
    const before = readFileSync(join(dir, 'run.json'), 'utf8')
    const listingBefore = readdirSync(root).sort()

    collectRuns(root)
    buildTrend(collectRuns(root).runs, { dimension: 'kind' })
    renderTrend(buildTrend(collectRuns(root).runs, { dimension: 'kind' }))

    assert.equal(readFileSync(join(dir, 'run.json'), 'utf8'), before)
    assert.deepEqual(readdirSync(root).sort(), listingBefore, '不应新建/删除任何产物')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------- buildTrend -- */

test('buildTrend：按 kind 聚合通过/失败/跳过/错误、通过率、耗时与用量', () => {
  const root = makeRunsDir()
  try {
    writeRun(root, '2026-10-01T00-00-00_a', {
      startedAt: '2026-10-01T00:00:00.000Z',
      cases: [
        makeCase('TK-0001', { kind: 'tool', verdict: 'passed', durationMs: 100 }),
        makeCase('TK-0005', { kind: 'llm', verdict: 'failed', durationMs: 200, usage: { modelCalls: 2, tokens: 100 } }),
        makeCase('TK-0006', { kind: 'llm', verdict: 'skipped', durationMs: 0 }),
      ],
    })
    writeRun(root, '2026-10-02T00-00-00_b', {
      startedAt: '2026-10-02T00:00:00.000Z',
      cases: [
        makeCase('TK-0001', { kind: 'tool', verdict: 'passed', durationMs: 120 }),
        makeCase('TK-0005', { kind: 'llm', verdict: 'passed', durationMs: 300, usage: { modelCalls: 1, tokens: 50 } }),
        makeCase('TK-0006', { kind: 'llm', verdict: 'errored', durationMs: 400 }),
      ],
    })

    const runs = collectRuns(root).runs
    const trend = buildTrend(runs, { dimension: 'kind' })
    assert.equal(trend.dimension, 'kind')
    assert.equal(trend.runs, 2)
    assert.equal(trend.cases, 6)

    const tool = trend.groups.find((group) => group.key === 'tool')
    assert.ok(tool, '应有 tool 分组')
    assert.equal(tool.cases, 2)
    assert.equal(tool.runs, 2, '两次运行都贡献了 tool')
    assert.equal(tool.passed, 2)
    assert.equal(tool.passRate, 100)
    assert.equal(tool.avgMs, 110)
    assert.equal(tool.modelCalls, 0)
    assert.equal(tool.usageSamples, 0)

    const llm = trend.groups.find((group) => group.key === 'llm')
    assert.ok(llm)
    assert.equal(llm.cases, 4)
    assert.equal(llm.passed, 1)
    assert.equal(llm.failed, 1)
    assert.equal(llm.errored, 1)
    assert.equal(llm.skipped, 1)
    // 通过率分母 = 4 - 1 跳过 = 3 → 1/3
    assert.equal(llm.passRate, 33.3)
    assert.equal(llm.modelCalls, 3)
    assert.equal(llm.tokens, 150)
    assert.equal(llm.usageSamples, 2)
    assert.equal(llm.p95Ms, 400)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildTrend：flaky 率只认 rounds 里"有真有假"，没有 rounds 就不假装是 0', () => {
  const root = makeRunsDir()
  try {
    writeRun(root, '2026-10-01T00-00-00_a', {
      startedAt: '2026-10-01T00:00:00.000Z',
      cases: [
        makeCase('TK-0001', { kind: 'tool', rounds: [true, false] }),
        makeCase('TK-0002', { kind: 'tool', rounds: [true, true] }),
        makeCase('TK-0003', { kind: 'tool' }),
      ],
    })
    const trend = buildTrend(collectRuns(root).runs, { dimension: 'kind' })
    const tool = trend.groups.find((group) => group.key === 'tool')
    assert.equal(tool.roundsSamples, 2, '只有带 rounds 的两条算样本')
    assert.equal(tool.flakyRate, 50, '1/2 抖动')
    assert.equal(isFlaky([true, false]), true)
    assert.equal(isFlaky([true, true]), false)
    assert.equal(isFlaky([false, false]), false)
    assert.equal(isFlaky([true]), false, '单轮不算抖动')
    assert.equal(isFlaky(undefined), false)

    const rendered = renderTrend(trend)
    assert.match(rendered, /flaky 率/)
    assert.match(rendered, /2 样本/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildTrend：dimension 可切换（owner / dshVersion / tag）', () => {
  const root = makeRunsDir()
  try {
    writeRun(root, '2026-10-01T00-00-00_a', {
      startedAt: '2026-10-01T00:00:00.000Z',
      dshVersion: '0.2.0-rc.2',
      cases: [
        makeCase('TK-0001', { kind: 'tool', owner: '@alice' }),
        makeCase('TK-0002', { kind: 'llm' }),
      ],
    })
    writeRun(root, '2026-10-02T00-00-00_b', {
      startedAt: '2026-10-02T00:00:00.000Z',
      dshVersion: 'unknown',
      cases: [makeCase('TK-0001', { kind: 'tool', owner: '@alice' })],
    })
    const runs = collectRuns(root).runs

    const byOwner = buildTrend(runs, { dimension: 'owner' })
    assert.deepEqual(
      byOwner.groups.map((group) => group.key).sort(),
      ['(无 owner)', '@alice'],
    )

    const byDsh = buildTrend(runs, { dimension: 'dshVersion' })
    assert.deepEqual(
      byDsh.groups.map((group) => group.key).sort(),
      ['0.2.0-rc.2', 'unknown'],
    )

    const tags = new Map([
      ['TK-0001', ['tool', 'smoke']],
      ['TK-0002', ['llm']],
    ])
    const byTag = buildTrend(runs, { dimension: 'tag', scenarioTags: (id) => tags.get(id) ?? [] })
    assert.deepEqual(
      byTag.groups.map((group) => group.key).sort(),
      ['llm', 'smoke', 'tool'],
    )
    const smoke = byTag.groups.find((group) => group.key === 'smoke')
    assert.equal(smoke.cases, 2, '同一 case 的多个 tag 各算一次（按 tag 看的时候本来就该重复计）')

    // 不注入标签映射时如实说明，而不是悄悄给出"全部无 tag"
    const noMapper = buildTrend(runs, { dimension: 'tag' })
    assert.deepEqual(noMapper.groups.map((group) => group.key), ['(无 tag)'])
    assert.ok(noMapper.notes.some((note) => /scenarioTags/.test(note)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('buildTrend/renderTrend：样本不足时明说"别据此下结论"', () => {
  const root = makeRunsDir()
  try {
    writeRun(root, '2026-10-01T00-00-00_a', {
      startedAt: '2026-10-01T00:00:00.000Z',
      cases: [makeCase('TK-0001', { kind: 'tool' })],
    })
    const trend = buildTrend(collectRuns(root).runs, { dimension: 'kind' })
    assert.equal(trend.sufficient, false)
    assert.ok(trend.notes.some((note) => /样本不足/.test(note)), JSON.stringify(trend.notes))
    assert.ok(trend.notes.some((note) => /别据此下结论/.test(note)))

    const rendered = renderTrend(trend)
    assert.match(rendered, /样本不足，别据此下结论/)
    assert.match(rendered, /\| 分组 \|/)
    assert.match(rendered, /通过率 = 通过/)

    // 两次运行、样本够时不再说"样本不足"
    writeRun(root, '2026-10-02T00-00-00_b', {
      startedAt: '2026-10-02T00:00:00.000Z',
      cases: [makeCase('TK-0001', { kind: 'tool' })],
    })
    const enough = buildTrend(collectRuns(root).runs, { dimension: 'kind' })
    assert.equal(enough.sufficient, true)
    assert.ok(!enough.notes.some((note) => /样本不足/.test(note)))
    assert.match(renderTrend(enough), /可用于比较/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('percentile：最近秩法（空集 / 单点 / 边界）', () => {
  assert.equal(percentile([], 95), 0)
  assert.equal(percentile([42], 95), 42)
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5)
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(percentile([5, 1, 4, 2, 3], 100), 5)
})
