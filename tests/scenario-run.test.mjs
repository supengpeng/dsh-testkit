/**
 * 端到端（headless）：装配插件 → 打 bridge 端点 → 真实跑完 cases/ 下的场景。
 *
 * ## 为什么用产品里的 headless 宿主
 *
 * 本文件**不再自造替身**，而是用 `src/headless/` 里那套产品代码。
 * 理由很实际：替身有两份实现就会漂移，而漂移的替身会让 CI 轨
 * （`export/scenarios.test.mjs`）在不同地方给出不同结论。
 * 单一真相源比"测试更独立"更重要。
 *
 * 本文件同时还验证了 headless 宿主**能被真实插件装配**，而不只是能单独跑。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, test } from 'node:test'

import { createHeadlessHost } from '../lib/headless/index.js'
import * as plugin from '../lib/index.js'

/**
 * 本文件建的临时目录统一登记，跑完一次性删掉。
 *
 * 为什么必须做：`boot()` 每个用例调一次，漏清理会在 `%TEMP%` 里堆出成百上千个
 * `dsh-testkit-runs-*`——实测堆了 **1427 个**（`dsh-testkit doctor` 的残留探测
 * 就是这么发现的）。测试自己制造的环境垃圾，测试自己收。
 */
const TEMP_DIRS = []
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

function makeReq(method, body = '') {
  return Object.assign(Readable.from([Buffer.from(body, 'utf8')]), { method })
}

function makeRes() {
  const state = { status: 0, chunks: [] }
  return {
    writeHead(status) {
      state.status = status
    },
    end(body) {
      if (body !== undefined) state.chunks.push(Buffer.from(body))
    },
    read() {
      return { status: state.status, body: Buffer.concat(state.chunks).toString('utf8') }
    },
  }
}

/** 装配插件并返回观察面。 */
async function boot() {
  const headless = await createHeadlessHost()
  const runsDir = mkdtempSync(join(tmpdir(), 'dsh-testkit-runs-'))
  TEMP_DIRS.push(runsDir)

  await headless.ctx.plugin(plugin, {
    casesDir: 'cases',
    runsDir,
    exportDir: 'export',
    autoload: true,
    watch: false,
    exposeTools: true,
    exposeCommands: true,
    defaultTimeoutMs: 10_000,
    maxInvalidReported: 20,
  })

  return {
    headless,
    routes: headless.services.webServer.routes(),
    tools: headless.services.tools,
    llm: headless.services.llm,
    runsDir,
  }
}

async function post(routes, name, payload = {}) {
  const route = routes.find((r) => r.path.endsWith(`/${name}`))
  assert.ok(route, `应存在路由 /${name}`)
  const res = makeRes()
  await route.handler(makeReq('POST', JSON.stringify(payload)), res)
  const out = res.read()
  return { status: out.status, payload: JSON.parse(out.body) }
}

test('端到端：cases/ 下的全部场景在 headless 宿主里按要求通过或跳过', async () => {
  const { routes, tools } = await boot()

  const { status, payload } = await post(routes, 'run', {})
  assert.equal(status, 200)
  assert.equal(payload.ok, true, `run 端点应成功：${JSON.stringify(payload)}`)

  const value = payload.value

  // 不断言"总共有几条"——那会让每加一条场景都要改测试。
  // 断言的是**结构性质**：无失败、跳过集合恰好是预期的那些、且总数自洽。
  assert.equal(value.totals.failed, 0)
  assert.equal(value.totals.errored, 0)
  assert.equal(
    value.totals.total,
    value.totals.passed + value.totals.skipped,
    '总数应等于通过 + 跳过（无错误、无失败）',
  )

  // headless 宿主缺 subprocess / subagents / webServer，所以这几条会被跳过。
  // 新增"依赖这些能力"的场景时，把 ID 加进这个集合。
  const skippedIds = value.cases
    .filter((c) => c.verdict === 'skipped')
    .map((c) => c.id)
    .sort()
  assert.deepEqual(skippedIds, [
    'TK-0014',
    'TK-0016',
    'TK-0018',
    'TK-0019',
    'TK-0022',
    'TK-0024',
    'TK-0025',
    'TK-0026',
    // fs 类：headless 最小宿主不提供 fs 能力（沙箱与版本语义只能在活宿主验证）
    'TK-0030',
    'TK-0031',
    // session/flush 面：headless 最小宿主不提供 sessions 能力
    'TK-0032',
    // compaction 面：headless 最小宿主不提供 sessions / compaction 能力
    'TK-0034',
    // 外部被测对象的 shell 场景（fixture）：headless 最小宿主不提供 subprocess 能力
    'TK-0036',
    // 注意：TK-0033（goals）是 draft，默认全量集里本来就不会出现
  ])
  for (const c of value.cases.filter((c) => c.verdict === 'skipped')) {
    assert.ok(String(c.skipReason).length > 0, '跳过必须给出原因')
  }

  const uiCase = value.cases.find((c) => c.id === 'TK-0015')
  assert.equal(uiCase.verdict, 'passed', 'ui 类场景纯离线，headless 里必须能跑')

  const toolCase = value.cases.find((c) => c.id === 'TK-0017')
  assert.equal(toolCase.verdict, 'passed', 'tool 类只用 tools 能力，headless 里必须能跑')

  // 报告必须真的落盘
  assert.ok(value.reportPath !== null, '应写出报告文件')
  assert.equal(value.writeError, null)

  // 工具执行次数：TK-0001 / TK-0002 各一次、TK-0003 与 TK-0017 各一次；
  // TK-0028 三次（deny / cancel / ask，都被 pre-execute 拦下）、TK-0029 两次。
  // （**被 guard 或 waterfall 拦下也算一次 execute**——这正是我们要观测的。）
  // 注意：每新增一条会调用工具的 tool 类场景，都要同步这个数字。
  assert.equal(tools.executions, 9)
})

test('端到端：TK-0003 的 guard 真的拦下了执行（工具本体未运行）', async () => {
  const { routes } = await boot()

  const { payload } = await post(routes, 'run', { ids: ['TK-0003'] })
  assert.equal(payload.value.totals.total, 1)
  assert.equal(payload.value.totals.passed, 1, JSON.stringify(payload.value.cases, null, 2))

  const detail = payload.value.cases[0]
  assert.equal(detail.verdict, 'passed')
  assert.equal(detail.id, 'TK-0003')
})

test('端到端：llm 场景被接管，真实适配器零调用', async () => {
  const { routes, llm } = await boot()

  const { payload } = await post(routes, 'run', { ids: ['TK-0005', 'TK-0006'] })
  assert.equal(payload.value.totals.total, 2)
  assert.equal(payload.value.totals.passed, 2, JSON.stringify(payload.value.cases, null, 2))
  // "零上游请求"不是口号：驱动器的 listener 不调 next()，
  // headless 宿主里"真实适配器位置"（next 的闭包）一次都没被执行。
  assert.equal(llm.realAdapterCalls, 0)
})

test('端到端：场景互不污染（逐条跑与批量跑结果一致）', async () => {
  const batch = await boot()
  const batchRun = await post(batch.routes, 'run', {})

  const single = await boot()
  const singleRuns = []
  for (const id of [
    'TK-0001',
    'TK-0002',
    'TK-0003',
    'TK-0004',
    'TK-0005',
    'TK-0006',
    'TK-0007',
    'TK-0008',
    'TK-0009',
    'TK-0010',
    'TK-0011',
    'TK-0012',
    'TK-0013',
    'TK-0014',
    'TK-0015',
    'TK-0016',
    'TK-0017',
    'TK-0018',
    'TK-0019',
    'TK-0020',
    'TK-0021',
    'TK-0022',
    'TK-0023',
    'TK-0024',
    'TK-0025',
    'TK-0026',
    // TK-0027 是 draft（team 通道会真的建一个队友并永久留痕），绝不能被批量遍历选中
    'TK-0028',
    'TK-0029',
    'TK-0030',
    'TK-0031',
    'TK-0032',
    'TK-0034',
    // TK-0033 是 draft（会往会话日志写目标事件），绝不能被批量遍历选中
  ]) {
    const one = await post(single.routes, 'run', { ids: [id] })
    singleRuns.push(one.payload.value.totals)
  }

  // 逐条跑与批量跑都不得出现失败/错误（总数不再写死）
  assert.equal(batchRun.payload.value.totals.failed, 0)
  assert.equal(batchRun.payload.value.totals.errored, 0)
  assert.ok(
    singleRuns.every((t) => t.passed + t.skipped === 1 && t.failed === 0 && t.errored === 0),
    `逐条跑每条都应「通过或跳过」且无失败，实际：${JSON.stringify(singleRuns)}`,
  )
})

test('端到端：按 kind 选择器也能选中对应场景', async () => {
  const { routes } = await boot()

  const tool = await post(routes, 'run', { kinds: ['tool'] })
  assert.equal(tool.payload.value.totals.total, 6)
  assert.equal(tool.payload.value.totals.passed, 6)

  const prompt = await post(routes, 'run', { kinds: ['prompt'] })
  assert.equal(prompt.payload.value.totals.total, 1)

  const llm = await post(routes, 'run', { kinds: ['llm'] })
  assert.equal(llm.payload.value.totals.total, 2)

  const interaction = await post(routes, 'run', { kinds: ['interaction'] })
  assert.equal(interaction.payload.value.totals.total, 3)

  const session = await post(routes, 'run', { kinds: ['session'] })
  // TK-0010 / TK-0011（命令）+ TK-0032（flush）；TK-0033（goals）是 draft，不计入
  assert.equal(session.payload.value.totals.total, 3)

  const resource = await post(routes, 'run', { kinds: ['resource'] })
  assert.equal(resource.payload.value.totals.total, 2)

  // agent 类场景在 headless 宿主里应被跳过（没有 subagents 能力）
  // TK-0014 主 kind 是 agent，TK-0016 也是（组合场景）
  const agent = await post(routes, 'run', { kinds: ['agent'] })
  assert.equal(agent.payload.value.totals.total, 2)
  assert.equal(agent.payload.value.totals.skipped, 2)
  assert.equal(agent.payload.value.totals.passed, 0)

  // ui 类反过来：纯离线，headless 里必须通过
  const ui = await post(routes, 'run', { kinds: ['ui'] })
  assert.equal(ui.payload.value.totals.total, 1)
  assert.equal(ui.payload.value.totals.passed, 1)
  assert.equal(ui.payload.value.totals.skipped, 0)

  // shell 类需要 subprocess，headless 没有 → 跳过（目前两条：TK-0018 / TK-0019）
  const shell = await post(routes, 'run', { kinds: ['shell'] })
  assert.equal(shell.payload.value.totals.skipped, shell.payload.value.totals.total)
  assert.equal(shell.payload.value.totals.passed, 0)
  assert.ok(shell.payload.value.totals.total >= 1)
})

test('端到端：报告文件可在 /report 端点读回', async () => {
  const { routes } = await boot()
  const run = await post(routes, 'run', {})
  const runId = run.payload.value.runId

  const report = await post(routes, 'report', { runId })
  assert.equal(report.status, 200)
  assert.equal(report.payload.ok, true)
  assert.equal(report.payload.value.runId, runId)
  assert.match(report.payload.value.markdown, /dsh-testkit 运行报告/)
  assert.match(report.payload.value.markdown, /TK-0001/)
  assert.match(report.payload.value.markdown, /已通过/)
})

test('端到端：bridge 的 /run 返回精简 case（不含 steps，避免响应过大）', async () => {
  const { routes } = await boot()
  const { payload } = await post(routes, 'run', { ids: ['TK-0020'] })
  const c = payload.value.cases[0]

  // 精简是**有意的**：steps 里含每步断言与取证，塞进 HTTP 响应会很大。
  // 需要步骤级细节时读 run.json（见 tests/step-notes.test.mjs 与 /report 端点）。
  assert.equal(c.id, 'TK-0020')
  assert.equal(c.verdict, 'passed')
  assert.equal(c.steps, undefined)
  assert.ok(payload.value.reportPath !== null, '完整细节应落在报告文件里')
})

test('端到端：bridge 的 /list 能列出全部场景与能力分布', async () => {
  const { routes } = await boot()

  const { payload } = await post(routes, 'list', {})
  // 只断言"每个 kind 至少有一条"与"总数自洽"，不写死具体条数
  assert.ok(payload.value.scenarios.length >= 19)
  for (const kind of ['tool', 'prompt', 'llm', 'interaction', 'session', 'resource', 'agent', 'ui', 'shell']) {
    assert.ok(payload.value.counts[kind] >= 1, `kind=${kind} 应至少有一条场景`)
  }
  const counted = Object.values(payload.value.counts).reduce((a, b) => a + b, 0)
  assert.equal(counted, payload.value.scenarios.length)
  assert.equal(payload.value.invalid.length, 0)
})
