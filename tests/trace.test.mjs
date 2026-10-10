/**
 * 可观测性：trace 的三种导出 + 时间线 + 汇总（文档 §6.1）。
 *
 * ## 为什么手写 RunSummary
 *
 * `runs/` 是 gitignore 的运行产物，内容随"上一次谁跑了什么"漂移。
 * 这里手写两份**同构**的 RunSummary：
 *   · `LIVE`  —— case 带真实 `trace`（runner 记录的形态）
 *   · `RECON` —— 同一条 case **去掉 trace**，走 `steps[].durationMs` 重建
 * 两条路径都必须被覆盖：漏掉任一条，历史 run.json 或实时运行就会有一边没人守。
 *
 * ## 空运行也必须有用例
 *
 * "没有 trace" 时最容易出的错不是崩，而是**假装有数据**
 * （摆一张空表、给出 0 却被读成"很快"）。所以空 summary 单独一组断言。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { tallyTotals } from '../lib/runtime/runlog.js'
import {
  reconstructSpans,
  renderChromeTrace,
  renderOtelSpans,
  renderTimeline,
  renderTraceJson,
  resolveTrace,
  summarizeTrace,
} from '../lib/trace/index.js'

/* --------------------------------------------------------------- 夹具 -- */

function assertionOutcome({ ok = true, soft = false, message = '' } = {}) {
  return { assertion: { ref: 'fx.value', is: 1 }, ok, actual: 1, message, soft }
}

function step(name, { action, assertions = [], durationMs = 0 } = {}) {
  return { name, ...(action === undefined ? {} : { action }), assertions, durationMs }
}

function caseOutcome(overrides = {}) {
  return {
    id: 'TK-0000',
    title: '示例',
    kind: 'tool',
    verdict: 'passed',
    durationMs: 100,
    steps: [],
    notes: {},
    releaseFailures: [],
    sourceIssue: null,
    ...overrides,
  }
}

function runSummary(cases, runId) {
  return {
    runId,
    startedAt: '2026-10-10T08:00:00.000Z',
    finishedAt: '2026-10-10T08:00:01.000Z',
    casesDir: 'cases',
    dshVersion: '0.2.0-rc.2',
    platform: 'win32',
    totals: tallyTotals(cases),
    cases,
  }
}

const LIVE_CASE_A = caseOutcome({
  id: 'TK-1001',
  title: '工具返回正常',
  kind: 'tool',
  verdict: 'passed',
  durationMs: 100,
  steps: [
    step('调用工具', {
      action: { kind: 'tool', ok: true },
      assertions: [assertionOutcome()],
      durationMs: 30,
    }),
    step('检查输出', {
      assertions: [assertionOutcome(), assertionOutcome({ soft: true })],
      durationMs: 20,
    }),
  ],
  trace: [
    { phase: 'case', name: 'TK-1001', startMs: 0, durationMs: 100, ok: true },
    { phase: 'act', name: '调用工具', startMs: 10, durationMs: 30, ok: true },
    { phase: 'assert', name: '检查输出', startMs: 45, durationMs: 20, ok: true },
  ],
})

const LIVE_CASE_B = caseOutcome({
  id: 'TK-1002',
  title: '退出码应为 0',
  kind: 'shell',
  verdict: 'failed',
  durationMs: 200,
  steps: [
    step('跑命令', {
      action: { kind: 'shell', ok: false, detail: 'exit 1' },
      assertions: [assertionOutcome({ ok: false, message: '期望 0，实际 1' })],
      durationMs: 50,
    }),
  ],
  trace: [
    { phase: 'case', name: 'TK-1002', startMs: 0, durationMs: 200, ok: false },
    { phase: 'act', name: '跑命令', startMs: 20, durationMs: 50, ok: false },
  ],
  failureCategory: 'product_bug',
})

/** 去掉 trace 字段，模拟"历史 run.json 没有 trace"。 */
function stripTrace(outcome) {
  const { trace, ...rest } = outcome
  return rest
}

const LIVE = runSummary([LIVE_CASE_A, LIVE_CASE_B], 'RUN-LIVE')
const RECON = runSummary(
  [stripTrace(LIVE_CASE_A), stripTrace(LIVE_CASE_B)],
  'RUN-RECON',
)
const EMPTY = runSummary([], 'RUN-EMPTY')

/** LIVE / RECON 的共同期望：2 条 case、5 个 span、总耗时 300ms。 */
const EXPECTED_TOTALS = { cases: 2, spans: 5, totalMs: 300 }

/* ----------------------------------------------------- 规范 trace JSON -- */

test('renderTraceJson：live —— 形态与冻结契合一字不差', () => {
  const doc = JSON.parse(renderTraceJson(LIVE))

  assert.equal(doc.schema, 1)
  assert.equal(doc.runId, 'RUN-LIVE')
  assert.equal(doc.generatedFrom, 'live')
  assert.deepEqual(doc.totals, EXPECTED_TOTALS)
  assert.equal(doc.cases.length, 2)

  // case 字段集必须精确等于契约（不多不少，避免下游 schema 收不进去）。
  assert.deepEqual(Object.keys(doc.cases[0]).sort(), [
    'durationMs',
    'id',
    'kind',
    'spans',
    'title',
    'verdict',
  ])
  // live 用**原样**的 trace，不做任何加工。
  assert.deepEqual(doc.cases[0].spans, LIVE.cases[0].trace)
  assert.deepEqual(
    resolveTrace(LIVE).cases.map((item) => item.generatedFrom),
    ['live', 'live'],
  )
})

test('renderTraceJson：reconstructed —— 由 steps[].durationMs 重建且可复现', () => {
  const doc = JSON.parse(renderTraceJson(RECON))

  assert.equal(doc.generatedFrom, 'reconstructed')
  assert.deepEqual(doc.totals, EXPECTED_TOTALS)
  assert.equal(doc.cases[0].spans[0].phase, 'case')
  assert.deepEqual(
    doc.cases[0].spans.map((span) => span.phase),
    ['case', 'act', 'assert'],
  )
  // 首尾相接：第一步从 0 起，第二步紧接第一步之后。
  assert.deepEqual(
    doc.cases[0].spans.slice(1).map((span) => [span.startMs, span.durationMs]),
    [
      [0, 30],
      [30, 20],
    ],
  )
  assert.equal(doc.cases[0].spans[0].durationMs, 100)
  // 失败 case 的 act ok=false 被带出来。
  assert.equal(doc.cases[1].spans[1].ok, false)

  // 重建是纯函数：同输入必须逐字节相同（否则报告 diff 全是噪声）。
  assert.equal(renderTraceJson(RECON), renderTraceJson(RECON))
  assert.deepEqual(JSON.parse(renderTraceJson(RECON)), doc)
})

test('renderTraceJson：混合来源时运行级保守标 reconstructed，逐条保留真实来源', () => {
  const mixed = runSummary(
    [
      { ...stripTrace(LIVE_CASE_A), trace: LIVE_CASE_A.trace },
      stripTrace(LIVE_CASE_B),
    ],
    'RUN-MIXED',
  )
  const doc = JSON.parse(renderTraceJson(mixed))
  assert.equal(doc.generatedFrom, 'reconstructed')
  assert.deepEqual(
    resolveTrace(mixed).cases.map((item) => item.generatedFrom),
    ['live', 'reconstructed'],
  )
})

/* ------------------------------------------------------ Chrome Trace -- */

test('renderChromeTrace：每条事件 ph=X、dur>=0，pid/tid 定位正确', () => {
  const events = JSON.parse(renderChromeTrace(LIVE))
  assert.equal(events.length, EXPECTED_TOTALS.spans)

  for (const event of events) {
    assert.equal(event.ph, 'X')
    assert.ok(event.dur >= 0, `dur 不能为负：${JSON.stringify(event)}`)
    assert.ok(event.ts >= 0, `ts 不能为负：${JSON.stringify(event)}`)
    assert.equal(typeof event.name, 'string')
    assert.equal(typeof event.cat, 'string')
    assert.equal(Number.isInteger(event.pid), true)
    assert.equal(Number.isInteger(event.tid), true)
    // 事件字段集精确等于契约。
    assert.deepEqual(Object.keys(event).sort(), ['cat', 'dur', 'name', 'ph', 'pid', 'tid', 'ts'])
  }

  // pid = case 序号（从 1 起），每个 case 一条泳道。
  assert.deepEqual([...new Set(events.map((event) => event.pid))], [1, 2])
  // tid = 阶段序号：case 0 / act 2 / assert 3。
  assert.equal(events.find((event) => event.cat === 'case').tid, 0)
  assert.equal(events.find((event) => event.cat === 'act').tid, 2)
  assert.equal(events.find((event) => event.cat === 'assert').tid, 3)

  // ts 是运行级绝对偏移：第二个 case 从第一个 case 的耗时（100ms）之后开始。
  const secondCaseSpan = events.find((event) => event.pid === 2 && event.cat === 'case')
  assert.equal(secondCaseSpan.ts, 100)
  const secondCaseAct = events.find((event) => event.pid === 2 && event.cat === 'act')
  assert.equal(secondCaseAct.ts, 120)
  assert.equal(secondCaseAct.dur, 50)
})

test('renderChromeTrace：重建路径产出同一批 span（同源；偏移只能近似）', () => {
  const live = JSON.parse(renderChromeTrace(LIVE))
  const recon = JSON.parse(renderChromeTrace(RECON))
  assert.equal(recon.length, live.length)
  // 同一批 span：case / 阶段 / 名称 / 时长必须对上。
  assert.deepEqual(
    recon.map((event) => [event.pid, event.cat, event.name, event.dur]),
    live.map((event) => [event.pid, event.cat, event.name, event.dur]),
  )
  // 偏移**允许不同**：重建只有累计时长，第一步之前的真实间隙恢复不了。
  assert.ok(recon.every((event) => event.ts >= 0))
})

/* ---------------------------------------------------------- OTLP -- */

const OTEL_NOW = Date.UTC(2026, 0, 1, 0, 0, 0)

test('renderOtelSpans：OTLP 形状 + 纳秒差 = durationMs * 1e6', () => {
  const doc = JSON.parse(renderOtelSpans(LIVE, { now: OTEL_NOW }))
  assert.equal(doc.resourceSpans.length, 1)

  const resource = doc.resourceSpans[0].resource
  assert.ok(
    resource.attributes.some(
      (attribute) => attribute.key === 'service.name' && attribute.value.stringValue === 'dsh-testkit',
    ),
  )
  assert.ok(
    resource.attributes.some(
      (attribute) =>
        attribute.key === 'dsh.testkit.generated_from' &&
        attribute.value.stringValue === 'live',
    ),
  )

  const spans = doc.resourceSpans[0].scopeSpans[0].spans
  assert.equal(spans.length, EXPECTED_TOTALS.spans)

  // 与规范 trace 逐条对齐，纳秒差必须精确等于 durationMs × 1e6。
  const expected = resolveTrace(LIVE).cases.flatMap((item) => item.spans)
  spans.forEach((span, index) => {
    assert.equal(span.name, expected[index].name)
    assert.equal(typeof span.startTimeUnixNano, 'string')
    assert.equal(typeof span.endTimeUnixNano, 'string')
    assert.equal(
      BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano),
      BigInt(Math.round(expected[index].durationMs * 1_000_000)),
    )
    assert.ok(span.attributes.some((attribute) => attribute.key === 'dsh.trace.phase'))
  })

  // 合成基准只在"落在哪一秒"上生效：第一个 span 起点 = now。
  assert.equal(spans[0].startTimeUnixNano, (BigInt(OTEL_NOW) * 1_000_000n).toString())
  const caseSpans = spans.filter((span) =>
    span.attributes.some(
      (attribute) => attribute.key === 'dsh.trace.phase' && attribute.value.stringValue === 'case',
    ),
  )
  assert.equal(caseSpans.length, 2)
  assert.equal(
    caseSpans[1].startTimeUnixNano,
    (BigInt(OTEL_NOW + 100) * 1_000_000n).toString(),
  )
})

test('renderOtelSpans：ID 确定性、一个 case 一条 trace、子 span 挂到 case 总跨度下', () => {
  const doc = JSON.parse(renderOtelSpans(LIVE, { now: OTEL_NOW }))
  const spans = doc.resourceSpans[0].scopeSpans[0].spans

  for (const span of spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/)
    assert.match(span.spanId, /^[0-9a-f]{16}$/)
  }

  // 一个 case = 一条 trace：同 case 的 span 共享 traceId，不同 case 不同。
  const resolvedCases = resolveTrace(LIVE).cases
  let offset = 0
  const traceIds = []
  for (const item of resolvedCases) {
    const slice = spans.slice(offset, offset + item.spans.length)
    offset += item.spans.length
    const distinct = new Set(slice.map((span) => span.traceId))
    assert.equal(distinct.size, 1, `${item.id} 的 span 应当共享同一个 traceId`)
    traceIds.push(slice[0].traceId)
  }
  assert.equal(new Set(traceIds).size, resolvedCases.length)

  // 步骤 span 的父节点是该 case 的 case 总跨度。
  assert.equal(spans[1].parentSpanId, spans[0].spanId)
  // case 总跨度自己没有 parent（是这条 trace 的根）。
  assert.equal(spans[0].parentSpanId, undefined)

  // 不可复现的时间戳之外，一切都要可复现。
  assert.equal(renderOtelSpans(LIVE, { now: OTEL_NOW }), renderOtelSpans(LIVE, { now: OTEL_NOW }))
})

test('renderOtelSpans：重建路径如实标 generated_from', () => {
  const doc = JSON.parse(renderOtelSpans(RECON, { now: 0 }))
  const attributes = doc.resourceSpans[0].resource.attributes
  assert.ok(
    attributes.some(
      (attribute) =>
        attribute.key === 'dsh.testkit.generated_from' &&
        attribute.value.stringValue === 'reconstructed',
    ),
  )
  assert.equal(doc.resourceSpans[0].scopeSpans[0].spans.length, EXPECTED_TOTALS.spans)
  assert.equal(
    doc.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano,
    '0',
  )
})

/* -------------------------------------------------------- 时间线 -- */

test('renderTimeline：live —— 每条 case 的步骤表 + 最慢榜', () => {
  const timeline = renderTimeline(LIVE)

  assert.ok(timeline.includes('# dsh-testkit trace 时间线'))
  assert.ok(timeline.includes('`TK-1001` 工具返回正常'))
  assert.ok(timeline.includes('`TK-1002` 退出码应为 0'))
  assert.ok(timeline.includes('| 阶段 | 名称 | 开始 | 耗时 | 结果 |'))
  assert.ok(timeline.includes('| act | 调用工具 | +10ms | 30ms | ✅ |'))
  assert.ok(timeline.includes('最慢 top'))
  assert.ok(timeline.includes('live（runner 真实记录'))
  // 最慢榜第一是最慢的 act（50ms），而不是 case 总跨度。
  assert.ok(timeline.includes('| 1 | `TK-1002` | act | 跑命令 | 50ms |'))
})

test('renderTimeline：reconstructed —— 近似来源必须写明', () => {
  const timeline = renderTimeline(RECON)
  assert.ok(timeline.includes('reconstructed（由 `steps[].durationMs` 重建'))
  assert.ok(timeline.includes('| assert | 检查输出 | +30ms | 20ms | ✅ |'))
})

test('renderTimeline：top 可调，空运行不摆空表', () => {
  assert.ok(renderTimeline(LIVE, { top: 1 }).includes('最慢 top 1'))

  const empty = renderTimeline(EMPTY)
  assert.ok(empty.includes('没有任何 case'))
  assert.ok(!empty.includes('| 阶段 |'))
  assert.ok(!empty.includes('最慢'))
})

/* -------------------------------------------------------- 汇总 -- */

test('summarizeTrace：spans / totalMs / 最慢榜（排除 case 容器跨度）', () => {
  const stats = summarizeTrace(LIVE)
  assert.equal(stats.spans, EXPECTED_TOTALS.spans)
  assert.equal(stats.totalMs, EXPECTED_TOTALS.totalMs)
  // 非 case 的 span 共 3 条：act30 / assert20 / act50。
  assert.equal(stats.slowest.length, 3)
  assert.ok(!stats.slowest.some((span) => span.phase === 'case'))
  assert.deepEqual(stats.slowest[0], {
    caseId: 'TK-1002',
    name: '跑命令',
    durationMs: 50,
    phase: 'act',
  })
  assert.deepEqual(
    stats.slowest.map((span) => span.durationMs),
    [50, 30, 20],
  )
  assert.deepEqual(Object.keys(stats.slowest[0]).sort(), [
    'caseId',
    'durationMs',
    'name',
    'phase',
  ])

  assert.equal(summarizeTrace(LIVE, { top: 1 }).slowest.length, 1)
  assert.equal(summarizeTrace(LIVE, { top: 0 }).slowest.length, 0)
  assert.deepEqual(summarizeTrace(RECON), {
    spans: EXPECTED_TOTALS.spans,
    totalMs: EXPECTED_TOTALS.totalMs,
    slowest: stats.slowest,
  })
})

/* -------------------------------------------------- 重建语义 -- */

test('重建：phase 按该步做了什么选，ok 合并 act 与断言', () => {
  const withAction = reconstructSpans(
    caseOutcome({
      durationMs: 10,
      steps: [
        step('带 act 的步', {
          action: { kind: 'tool', ok: true },
          assertions: [assertionOutcome({ ok: false })],
          durationMs: 10,
        }),
      ],
    }),
  )
  // act 成功但断言失败 ⇒ 合并后 ok=false；一步只出一段，phase=act。
  assert.deepEqual(
    withAction.map((span) => span.phase),
    ['case', 'act'],
  )
  assert.equal(withAction[1].ok, false)
  assert.equal(withAction[1].durationMs, 10)

  const assertOnly = reconstructSpans(
    caseOutcome({
      durationMs: 5,
      steps: [
        step('只断言的步', {
          assertions: [assertionOutcome(), assertionOutcome({ ok: false, soft: true })],
          durationMs: 5,
        }),
      ],
    }),
  )
  assert.deepEqual(
    assertOnly.map((span) => span.phase),
    ['case', 'assert'],
  )
  // soft 失败不改变 ok。
  assert.equal(assertOnly[1].ok, true)

  // 各步首尾相接，顺序与 steps 一致。
  const multi = reconstructSpans(
    caseOutcome({
      durationMs: 100,
      steps: [
        step('a', { durationMs: 10 }),
        step('b', { durationMs: 20 }),
        step('c', { durationMs: 5 }),
      ],
    }),
  )
  assert.deepEqual(
    multi.slice(1).map((span) => span.startMs),
    [0, 10, 30],
  )
})

/* -------------------------------------------------- 三面同源 + 空运行 -- */

test('三种机器可读导出同源：span 数与活跃来源一致', () => {
  for (const [label, summary] of [
    ['live', LIVE],
    ['reconstructed', RECON],
  ]) {
    const trace = JSON.parse(renderTraceJson(summary))
    const chrome = JSON.parse(renderChromeTrace(summary))
    const otel = JSON.parse(renderOtelSpans(summary, { now: 0 }))
    const otelSpans = otel.resourceSpans[0].scopeSpans[0].spans

    assert.equal(trace.cases.length, summary.cases.length, `${label}: cases`)
    assert.equal(chrome.length, trace.totals.spans, `${label}: chrome span 数`)
    assert.equal(otelSpans.length, trace.totals.spans, `${label}: otel span 数`)
    assert.equal(trace.generatedFrom, label === 'live' ? 'live' : 'reconstructed')
  }
})

test('空运行：不崩、不假装有数据', () => {
  const doc = JSON.parse(renderTraceJson(EMPTY))
  assert.equal(doc.schema, 1)
  // 没有任何 case ⇒ 没有真实记录可谈，保守标 reconstructed。
  assert.equal(doc.generatedFrom, 'reconstructed')
  assert.deepEqual(doc.totals, { cases: 0, spans: 0, totalMs: 0 })
  assert.deepEqual(doc.cases, [])

  assert.deepEqual(JSON.parse(renderChromeTrace(EMPTY)), [])

  const otel = JSON.parse(renderOtelSpans(EMPTY, { now: 0 }))
  assert.deepEqual(otel.resourceSpans[0].scopeSpans[0].spans, [])

  assert.deepEqual(summarizeTrace(EMPTY), { spans: 0, totalMs: 0, slowest: [] })
  assert.deepEqual(resolveTrace(EMPTY), { generatedFrom: 'reconstructed', cases: [] })
})
