/**
 * 宿主体检（`src/doctor/**`）。
 *
 * ## 断言口径
 *
 *   · **不硬编码能力矩阵**：测试自己从 `createDriverRegistry()` 的 `requires`
 *     与 `HEADLESS_CAPABILITIES` 重算一遍 `missing` / `willSkip`，再与报告逐行比对。
 *     硬编码的期望值会在加 driver 那天变成"测试过期"而不是"代码错了"。
 *   · **39 条 / 12 kind**：对真实 `cases/` 的规模断言（这条是 Lead 点名要的），
 *     同时断言 active+draft+retired+blocked 自洽。
 *   · **未探测 ≠ 干净**：不传 `residue` 时报告必须写"未探测"，绝不能渲染成"没有残留"。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CaseRegistry } from '../lib/cases/registry.js'
import { collectHostResidue, renderDoctor, runDoctor, scanRuns } from '../lib/doctor/index.js'
import { HEADLESS_CAPABILITIES, createHeadlessHost } from '../lib/headless/index.js'
import { createDriverRegistry } from '../lib/kinds/index.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGE_SCRIPTS = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).scripts

/** 全部 HostCapability（能力齐备的宿主用它做"谁都不该跳过"的对照）。 */
const ALL_CAPABILITIES = [
  'tools',
  'llm',
  'commands',
  'systemPrompt',
  'approval',
  'userQuestions',
  'session',
  'fs',
  'subprocess',
  'web',
  'webServer',
  'agentLoop',
  'subagents',
  'agentTeams',
  'sessions',
  'goals',
  'compaction',
  'storage',
  'timer',
  'client',
]

function loadRealRegistry() {
  const registry = new CaseRegistry(join(REPO_ROOT, 'cases'))
  registry.reload()
  return registry
}

/** 默认用**真实 headless 宿主**的能力集（与 CI 轨一致）。 */
function baseInput(overrides = {}) {
  return {
    registry: loadRealRegistry(),
    host: {
      capabilities: HEADLESS_CAPABILITIES,
      env: { dshVersion: 'headless', platform: process.platform, nodeVersion: process.version },
    },
    scripts: PACKAGE_SCRIPTS,
    runsDir: join(REPO_ROOT, 'runs'),
    casesDir: join(REPO_ROOT, 'cases'),
    ...overrides,
  }
}

function listenOnce() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/* ------------------------------------------------------------ 真实场景集 -- */

test('doctor：真实 registry 报告 39 条 / 12 kind，且分段计数自洽', async () => {
  const report = await runDoctor(baseInput())

  assert.equal(report.cases.scenarios, 39)
  assert.equal(report.cases.kinds, 12)
  assert.equal(report.cases.invalid, 0, '真实场景集不应有校验失败的文件')
  assert.equal(
    report.cases.active + report.cases.draft + report.cases.retired + report.cases.blocked,
    report.cases.scenarios,
    '四种状态的计数必须与总数自洽',
  )
  assert.equal(report.coverage.kinds, 12, '覆盖矩阵行数 = 已注册 kind 数')
  assert.equal(report.drivers.length, createDriverRegistry().list().length)
  assert.ok(report.guards.length > 0, 'package.json 里应有 verify:* / test:* 守卫')
  assert.equal(typeof report.runs.exists, 'boolean')
})

/* ------------------------------------------------------- skip 预测（推导） -- */

test('doctor：skip 预测按 requires × capabilities 推导，与 headless 能力集一致', async () => {
  const capabilities = new Set(HEADLESS_CAPABILITIES)
  const drivers = createDriverRegistry().list()
  const report = await runDoctor(baseInput())

  for (const row of report.drivers) {
    const driver = drivers.find((candidate) => candidate.kind === row.kind)
    assert.ok(driver, `报告里的 kind=${row.kind} 必须来自真实 driver 注册表`)

    const requires = [...new Set(driver.requires ?? [])]
    assert.deepEqual(row.requires, requires, `${row.kind} 的 requires 应逐项照抄 driver 声明`)
    assert.deepEqual(
      row.missing,
      requires.filter((capability) => !capabilities.has(capability)),
      `${row.kind} 的 missing 应由 requires - capabilities 推导`,
    )
    assert.equal(row.willSkip, row.missing.length > 0)
    if (row.willSkip) {
      assert.equal(row.reason, `宿主缺少能力：${row.missing.join(', ')}`, '原因应与 runner 同口径')
    } else {
      assert.equal(row.reason, undefined)
    }
  }

  // 具体几条：证明推导不是"全都不会跳过"的空转
  const byKind = Object.fromEntries(report.drivers.map((row) => [row.kind, row]))
  assert.equal(byKind.tool.willSkip, false)
  assert.equal(byKind.prompt.willSkip, false)
  assert.equal(byKind.llm.willSkip, false)
  assert.equal(byKind.shell.willSkip, true, 'shell 需要 subprocess，headless 里必然缺')
  assert.equal(byKind.agent.willSkip, true, 'agent 需要 subagents，headless 里必然缺')
  assert.equal(byKind.fs.willSkip, true)
  assert.equal(byKind.compaction.willSkip, true)

  // 宿主能力面：缺的必须是"被 driver 需要但没有的"
  assert.ok(report.capabilities.missing.includes('subprocess'))
  assert.ok(!report.capabilities.missing.includes('tools'))
  assert.ok(report.capabilities.missing.every((cap) => !capabilities.has(cap)))

  // 会跳过的 kind 必须真的在报告里产生 warn（否则报告的发现项漏了最该说的那件事）
  assert.ok(
    report.findings.some((finding) => finding.code === 'capability-skip' && finding.level === 'warn'),
  )
})

test('doctor：能力齐备时没有任何 driver 会被判跳过', async () => {
  const report = await runDoctor(
    baseInput({
      host: {
        capabilities: ALL_CAPABILITIES,
        env: { dshVersion: 'full', platform: process.platform, nodeVersion: process.version },
      },
    }),
  )

  assert.deepEqual(report.capabilities.missing, [])
  assert.ok(report.drivers.every((row) => !row.willSkip))
  assert.ok(!report.findings.some((finding) => finding.code === 'capability-skip'))
})

/* ------------------------------------------------------------------ 守卫 -- */

test('doctor：守卫清单从 package.json 的 verify:* / test:* 读出（不是硬编码）', async () => {
  const report = await runDoctor(baseInput())

  const names = report.guards.map((guard) => guard.name)
  assert.deepEqual(names, [...names].sort(), '守卫清单应稳定排序')
  assert.ok(report.guards.every((guard) => guard.group === 'verify' || guard.group === 'test'))
  assert.ok(names.includes('verify:cases'))
  assert.ok(names.includes('test:contracts'))
  assert.ok(!names.includes('gate'), 'gate 不是 verify:*/test:*，不该混进守卫清单')
  assert.ok(!names.includes('build'))
  assert.equal(
    report.guards.length,
    Object.keys(PACKAGE_SCRIPTS).filter((key) => key.startsWith('verify:') || key.startsWith('test:'))
      .length,
  )

  // 守卫缺失要能被发现（而不是静默的"清单为空"）
  const empty = await runDoctor(baseInput({ scripts: {} }))
  assert.equal(empty.guards.length, 0)
  assert.ok(empty.findings.some((finding) => finding.code === 'no-verify-guards'))
  assert.ok(empty.findings.some((finding) => finding.code === 'no-test-guards'))
})

/* ------------------------------------------------------------- 运行产物 -- */

test('doctor：runs 扫描取最近一次可读的 run.json，坏件跳过并写说明', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'dsh-testkit-doctor-runs-'))
  try {
    const older = join(runsDir, '2026-01-01T00-00-00_aaaa')
    const newer = join(runsDir, '2026-01-02T00-00-00_bbbb')
    mkdirSync(older)
    mkdirSync(newer)
    writeFileSync(
      join(older, 'run.json'),
      JSON.stringify({
        runId: '2026-01-01T00-00-00_aaaa',
        startedAt: '2026-01-01T00:00:00.000Z',
        totals: { total: 3, passed: 2, failed: 1, skipped: 0, errored: 0 },
      }),
      'utf8',
    )
    // 更新的那一份坏掉：应从它前面的历史里取到"最近一次可读的"
    writeFileSync(join(newer, 'run.json'), '{ not json', 'utf8')

    const scan = scanRuns(runsDir)
    assert.equal(scan.exists, true)
    assert.equal(scan.runCount, 2)
    assert.equal(scan.latest.runId, '2026-01-01T00-00-00_aaaa')
    assert.deepEqual(scan.latest.totals, { total: 3, passed: 2, failed: 1, skipped: 0, errored: 0 })
    assert.ok(scan.notes.some((note) => note.includes('读不出来')))

    const report = scanRuns(join(runsDir, 'does-not-exist'))
    assert.equal(report.exists, false)
    assert.equal(report.latest, undefined)
    assert.ok(report.notes.some((note) => note.includes('不存在')))
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

test('doctor：最近一次运行的 totals 进报告', async () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'dsh-testkit-doctor-report-'))
  try {
    const dir = join(runsDir, '2026-03-04T05-06-07_zzzz')
    mkdirSync(dir)
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({
        runId: '2026-03-04T05-06-07_zzzz',
        totals: { total: 5, passed: 4, failed: 1, skipped: 0, errored: 0 },
      }),
      'utf8',
    )

    const report = await runDoctor(baseInput({ runsDir }))
    assert.equal(report.runs.latest.runId, '2026-03-04T05-06-07_zzzz')
    assert.equal(report.runs.latest.totals.failed, 1)
    assert.match(renderDoctor(report), /failed 1/)
  } finally {
    rmSync(runsDir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------- 残留探测 -- */

test('doctor：注入残留 → 进报告与发现项；未探测 → 明说"未探测"', async () => {
  const residue = {
    targets: ['os.tmpdir() 下 dsh-testkit-* 目录', '端口 39999'],
    record: {
      released: [],
      leftovers: ['tmpdir:dsh-testkit-stale', 'port:39999', 'unknown:port:70000（端口号非法）'],
    },
    notes: ['探针说明'],
  }

  const report = await runDoctor(baseInput({ residue }))
  assert.deepEqual(report.residue.record.leftovers, residue.record.leftovers)
  assert.ok(
    report.findings.some(
      (finding) => finding.code === 'residue-found' && finding.message.includes('2 项残留'),
    ),
    '"unknown:" 不能被算成已确认的残留',
  )
  assert.ok(report.findings.some((finding) => finding.code === 'residue-unknown'))

  const markdown = renderDoctor(report)
  assert.match(markdown, /残留：2 项/)
  assert.match(markdown, /探不到：1 项/)

  // 未提供 residue：不能写成"干净"
  const unprobed = await runDoctor(baseInput())
  assert.deepEqual(unprobed.residue.record.leftovers, [])
  assert.equal(unprobed.residue.targets.length, 0)
  assert.ok(unprobed.findings.some((finding) => finding.code === 'residue-not-probed'))
  const unprobedMarkdown = renderDoctor(unprobed)
  assert.match(unprobedMarkdown, /未探测/)
  assert.match(unprobedMarkdown, /未探测 ≠ 干净/)
})

test('collectHostResidue：陈旧临时目录与被占端口都能抓到', async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), 'dsh-testkit-doctor-residue-'))
  const held = await listenOnce()
  try {
    mkdirSync(join(tmpRoot, 'dsh-testkit-stale-abc'))
    mkdirSync(join(tmpRoot, 'unrelated-dir'))

    const residue = await collectHostResidue({
      tmpRoot,
      ports: [held.port],
      patterns: [], // 显式空 = 不跑进程探针（不进 tasklist/ps）
    })

    assert.ok(residue.record.leftovers.includes('tmpdir:dsh-testkit-stale-abc'))
    assert.ok(
      !residue.record.leftovers.some((item) => item.includes('unrelated-dir')),
      '只报本工具的目录，别把无关目录算成残留',
    )
    assert.ok(residue.record.leftovers.includes(`port:${held.port}`))
    assert.equal(residue.ports.length, 1)
    assert.equal(residue.processes, undefined, '显式空 patterns 时不该起进程探针')
    assert.ok(residue.targets.length >= 2)
    assert.ok(residue.notes.some((note) => note.includes('进程')))

    // 传进 doctor 后，残留会变成 warn 级发现
    const report = await runDoctor(baseInput({ residue }))
    assert.ok(report.findings.some((finding) => finding.code === 'residue-found'))
  } finally {
    await held.close()
    rmSync(tmpRoot, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------- 结论与渲染 -- */

test('doctor：ok 只由 error 级发现决定；casesDir 不存在时置 false', async () => {
  const healthy = await runDoctor(baseInput())
  assert.equal(healthy.ok, true, JSON.stringify(healthy.findings))
  assert.ok(healthy.findings.every((finding) => finding.level !== 'error'))

  const broken = await runDoctor(baseInput({ casesDir: join(REPO_ROOT, 'cases-does-not-exist-xyz') }))
  assert.equal(broken.ok, false)
  assert.ok(
    broken.findings.some(
      (finding) => finding.code === 'cases-dir-missing' && finding.level === 'error',
    ),
  )
})

test('doctor：校验失败的文件算 error（坏件不该只是静默消失）', async () => {
  const real = loadRealRegistry()
  const stub = {
    dir: real.dir,
    all: real.all,
    invalidCases: [{}, {}],
    problems: [],
  }

  const report = await runDoctor(baseInput({ registry: stub }))
  assert.equal(report.cases.invalid, 2)
  assert.equal(report.ok, false)
  assert.ok(report.findings.some((finding) => finding.code === 'invalid-cases'))
})

test('doctor：renderDoctor 含全部小节，且结论可 grep', async () => {
  const report = await runDoctor(baseInput())
  const markdown = renderDoctor(report)

  for (const heading of [
    '# dsh-testkit 宿主体检',
    '## 宿主能力',
    '## 驱动 × 能力矩阵',
    '## 守卫清单（package.json scripts）',
    '## 场景集',
    '## 残留探测',
    '## 最近一次运行',
    '## 覆盖缺口',
    '## 体检发现',
  ]) {
    assert.ok(markdown.includes(heading), `缺少小节：${heading}`)
  }

  assert.match(markdown, /结论：/)
  assert.match(markdown, /39 条 \/ 12 个 kind/)
  assert.match(markdown, /shell/)
  assert.match(markdown, /verify:cases/)
  assert.ok(markdown.length > 500)
})

test('doctor：headless 宿主的真实装配也能被体检（能力集来自活宿主）', async () => {
  const headless = await createHeadlessHost()
  try {
    const report = await runDoctor(
      baseInput({
        host: {
          capabilities: [...headless.host.capabilities],
          env: headless.host.env,
        },
      }),
    )
    assert.equal(report.ok, true)
    assert.equal(report.host.dshVersion, 'headless')
    // 活宿主上报的能力应与 HEADLESS_CAPABILITIES 一致（不一致说明装配漏了 provide）
    assert.deepEqual(report.capabilities.present, [...HEADLESS_CAPABILITIES].sort())
  } finally {
    await headless.dispose()
  }
})
