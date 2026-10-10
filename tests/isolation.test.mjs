/**
 * 并发隔离 + 幂等 / 清理残留检测。
 *
 * ## 覆盖什么
 *
 *   ① **并发 vs 串行结果一致**：用产品里的 headless 宿主 + 真实 driver 注册表，
 *      跑一组显式 `parallel: safe` 的场景。串行跑一遍、按 `groupScenarios`
 *      的执行计划并发跑一遍，**逐条**比对 verdict 与每一步断言的 ok 集合。
 *      只比总数是不够的（两条场景互换结论、总数照样相等）。
 *   ② 泄漏检测能抓到人为造的残留（临时文件 / 被占端口 / 假孤儿进程），干净时为空。
 *   ③ `disposeIsolationContext` 幂等（重复调用、目录已不存在、删除失败都不抛）。
 *   ④ `groupScenarios`：`exclusive`（含缺省）永不被并发、`limit <= 1` 全串行、保序。
 *   ⑤ 清理：两个 disposer 释放其一，另一个仍由夹具兜底释放；重复调用不抛；
 *      disposer 抛错不抛穿，而是进 `Fixture.release()` 的 failures。
 *
 * ## 为什么"并发"是这么造的
 *
 * `runScenarios` 目前是串行引擎（runner 的并发接线是 Lead 的活）。所以这里
 * 用**已经交付的公共 API**拼出并发执行：`groupScenarios` 给出执行计划，
 * `parallel` 组内对每一条各调一次 `runScenarios`（同一个宿主、同一个注册表）
 * 并用 `Promise.all` 同时跑。这正是 runner 将来要做的调度，
 * 差别只在"谁持有那个循环"。
 *
 * 并发确实是真发生的，有硬证据：探针 driver 记录 `maxActive`——
 * 串行跑恒为 1，并发跑必须 > 1（场景里 `delayMs: 80` 保证重叠）。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CaseRegistry } from '../lib/cases/registry.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { registerStepDisposer, releaseStepNotes } from '../lib/isolation/cleanup.js'
import { createIsolationContext, disposeIsolationContext } from '../lib/isolation/context.js'
import { detectLeftovers } from '../lib/isolation/leaks.js'
import { groupScenarios } from '../lib/isolation/pool.js'
import { createDriverRegistry, DriverRegistry } from '../lib/kinds/index.js'
import { Fixture } from '../lib/runtime/fixture.js'
import { runScenarios } from '../lib/runtime/runner.js'

/* ------------------------------------------------------------- 测试小工具 -- */

/** 造一个只够 groupScenarios / createIsolationContext 用的最小场景对象。 */
function fakeScenario(id, parallel) {
  return {
    schema: 1,
    id,
    title: id,
    kind: 'tool',
    source: { issue: null },
    setup: {},
    steps: [{ act: { wait: { ms: 0 } } }],
    ...(parallel === undefined ? {} : { parallel }),
  }
}

/** 造一个一次性临时根目录。 */
function makeRoot(tag) {
  return mkdtempSync(join(tmpdir(), `dsh-testkit-${tag}-`))
}

/** 临时目录/文件的安全删除（测试自己的清理，不参与被测逻辑）。 */
function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/* ---------------------------------------------------------------- pool -- */

test('groupScenarios：limit=1 全串行，且严格保序', () => {
  const scenarios = ['TK-9001', 'TK-9002', 'TK-9003'].map((id) => fakeScenario(id, 'safe'))
  const groups = groupScenarios(scenarios, { limit: 1 })

  assert.deepEqual(
    groups.map((g) => g.kind),
    ['serial', 'serial', 'serial'],
  )
  assert.deepEqual(
    groups.map((g) => g.items.map((s) => s.id)),
    [['TK-9001'], ['TK-9002'], ['TK-9003']],
  )
})

test('groupScenarios：exclusive（含缺省）永远串行', () => {
  const scenarios = [
    fakeScenario('TK-9001', 'exclusive'),
    fakeScenario('TK-9002'), // 缺省语义 = exclusive
    fakeScenario('TK-9003', 'safe'),
    fakeScenario('TK-9004', 'safe'),
    fakeScenario('TK-9005', 'exclusive'),
  ]
  const groups = groupScenarios(scenarios, { limit: 8 })

  assert.deepEqual(
    groups.map((g) => [g.kind, g.items.map((s) => s.id)]),
    [
      ['serial', ['TK-9001']],
      ['serial', ['TK-9002']],
      ['parallel', ['TK-9003', 'TK-9004']],
      ['serial', ['TK-9005']],
    ],
  )
})

test('groupScenarios：连续 safe 按 limit 切组，但绝不跨越 exclusive', () => {
  const scenarios = [
    fakeScenario('TK-9001', 'safe'),
    fakeScenario('TK-9002', 'safe'),
    fakeScenario('TK-9003', 'safe'),
    fakeScenario('TK-9004', 'exclusive'),
    fakeScenario('TK-9005', 'safe'),
    fakeScenario('TK-9006', 'safe'),
    fakeScenario('TK-9007', 'safe'),
    fakeScenario('TK-9008', 'safe'),
    fakeScenario('TK-9009', 'safe'),
  ]
  const groups = groupScenarios(scenarios, { limit: 3 })

  assert.deepEqual(
    groups.map((g) => [g.kind, g.items.map((s) => s.id)]),
    [
      ['parallel', ['TK-9001', 'TK-9002', 'TK-9003']],
      ['serial', ['TK-9004']],
      ['parallel', ['TK-9005', 'TK-9006', 'TK-9007']],
      ['parallel', ['TK-9008', 'TK-9009']],
    ],
  )
  // 组内并发度不得超过 limit
  for (const group of groups) assert.ok(group.items.length <= 3)
})

test('groupScenarios：拼接后与输入逐元素同序（报告可复盘的前提）', () => {
  const scenarios = [
    fakeScenario('TK-9001', 'safe'),
    fakeScenario('TK-9002'),
    fakeScenario('TK-9003', 'safe'),
    fakeScenario('TK-9004', 'safe'),
    fakeScenario('TK-9005', 'exclusive'),
    fakeScenario('TK-9006', 'safe'),
  ]
  const flat = groupScenarios(scenarios, { limit: 2 }).flatMap((g) => g.items)

  assert.equal(flat.length, scenarios.length)
  scenarios.forEach((s, i) => assert.equal(flat[i], s, `第 ${i} 个元素必须原位`))
})

test('groupScenarios：非法 limit 退化成串行，绝不"猜"一个更大的并发度', () => {
  const scenarios = ['TK-9001', 'TK-9002'].map((id) => fakeScenario(id, 'safe'))
  for (const limit of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
    const groups = groupScenarios(scenarios, { limit })
    assert.deepEqual(
      groups.map((g) => g.kind),
      ['serial', 'serial'],
      `limit=${String(limit)} 应退化成串行`,
    )
  }
  // 非整数 limit 向下取整（2.9 → 2，不得悄悄变成 3）
  const fractional = groupScenarios(
    ['TK-9001', 'TK-9002', 'TK-9003'].map((id) => fakeScenario(id, 'safe')),
    { limit: 2.9 },
  )
  assert.deepEqual(
    fractional.map((g) => g.items.length),
    [2, 1],
  )
})

/* ------------------------------------------------------------- context -- */

test('createIsolationContext：命名空间 / tmpdir / 端口 / 会话各不相同', async () => {
  const root = makeRoot('iso-root')
  try {
    const scenario = fakeScenario('TK-9001', 'safe')
    const first = createIsolationContext(scenario, { root, ports: [31001, 31002] })
    const second = createIsolationContext(scenario, { root })

    assert.ok(existsSync(first.tmpdir), 'tmpdir 必须真的建出来')
    assert.ok(first.tmpdir.startsWith(root), 'tmpdir 必须落在指定 root 下')
    assert.equal(first.session, `dsh-testkit-${first.namespace}`)
    assert.deepEqual(first.ports, [31001, 31002])
    assert.deepEqual(second.ports, [], '未声明端口时为空数组（只声明不分配）')
    assert.notEqual(first.tmpdir, second.tmpdir, '同一场景两次创建也必须互不覆盖')
    assert.notEqual(first.namespace, second.namespace)

    // 调用方复用同一个数组也不该改到已建好的上下文
    const ports = [1]
    const third = createIsolationContext(scenario, { root, ports })
    ports.push(2)
    assert.deepEqual(third.ports, [1])

    await disposeIsolationContext(first)
    await disposeIsolationContext(second)
    await disposeIsolationContext(third)
  } finally {
    removeDir(root)
  }
})

test('disposeIsolationContext：删干净、可重复调、失败不抛', async () => {
  const root = makeRoot('iso-dispose')
  try {
    const scenario = fakeScenario('TK-9002', 'safe')
    const ctx = createIsolationContext(scenario, { root })
    writeFileSync(join(ctx.tmpdir, 'left.txt'), 'x')

    await disposeIsolationContext(ctx)
    assert.equal(existsSync(ctx.tmpdir), false, 'tmpdir 及其内容都应删除')

    // ② 同一对象重复调
    await disposeIsolationContext(ctx)
    // ③ 换一个对象、目录已经不存在
    await disposeIsolationContext({ ...ctx })
    // ④ 从来没建过的目录
    await disposeIsolationContext({
      namespace: 'ghost',
      tmpdir: join(root, 'never-existed'),
      ports: [],
      session: 'dsh-testkit-ghost',
    })
    // ⑤ 删除会真的失败（父路径是文件而不是目录）——必须吞掉而不是抛穿
    writeFileSync(join(root, 'a-file'), 'not a dir')
    await disposeIsolationContext({
      namespace: 'bad',
      tmpdir: join(root, 'a-file', 'child'),
      ports: [],
      session: 'dsh-testkit-bad',
    })
  } finally {
    removeDir(root)
  }
})

/* --------------------------------------------------------------- leaks -- */

test('detectLeftovers：干净的隔离上下文没有任何残留', async () => {
  const root = makeRoot('iso-leak-clean')
  try {
    const ctx = createIsolationContext(fakeScenario('TK-9003', 'safe'), { root, ports: [31003] })
    const record = detectLeftovers(ctx, { portProbe: () => false, procProbe: () => [] })

    assert.deepEqual(record, { released: [], leftovers: [] })
    await disposeIsolationContext(ctx)
  } finally {
    removeDir(root)
  }
})

test('detectLeftovers：缺省探针真的检查 tmpdir（文件与子目录都算残留）', async () => {
  const root = makeRoot('iso-leak-fs')
  try {
    const ctx = createIsolationContext(fakeScenario('TK-9004', 'safe'), { root })
    writeFileSync(join(ctx.tmpdir, 'left.txt'), 'x')
    mkdirSync(join(ctx.tmpdir, 'sub'))
    writeFileSync(join(ctx.tmpdir, 'sub', 'deep.txt'), 'y')

    const record = detectLeftovers(ctx)
    assert.deepEqual(record.released, [])
    assert.ok(record.leftovers.includes('tmpdir:left.txt'), record.leftovers.join(', '))
    assert.ok(record.leftovers.includes('tmpdir:sub'), record.leftovers.join(', '))
    assert.ok(record.leftovers.includes('tmpdir:sub/deep.txt'), record.leftovers.join(', '))

    await disposeIsolationContext(ctx)
    // 释放之后目录整体消失 → 不再是残留
    assert.deepEqual(detectLeftovers(ctx, { procProbe: () => [] }).leftovers, [])
  } finally {
    removeDir(root)
  }
})

test('detectLeftovers：三类残留都能被注入的探针抓到（顺序稳定、去重）', async () => {
  const root = makeRoot('iso-leak-probes')
  try {
    const ctx = createIsolationContext(fakeScenario('TK-9005', 'safe'), {
      root,
      ports: [31005, 31006],
    })

    const record = detectLeftovers(ctx, {
      fsProbe: () => ['orphan.bin'],
      portProbe: (port) => port === 31005,
      // 重复项、空名字都要被规整掉：报告里不该出现两条一样的孤儿进程
      procProbe: () => ['ghost-worker', 'ghost-worker', ''],
    })

    assert.deepEqual(record.leftovers, [
      'tmpdir:orphan.bin',
      'port:31005',
      'proc:ghost-worker',
    ])

    // 探针自己炸了也不能把运行带崩：如实记成 probe-error
    const broken = detectLeftovers(ctx, {
      fsProbe: () => {
        throw new Error('fs 炸了')
      },
      portProbe: () => {
        throw new Error('port 炸了')
      },
      procProbe: () => {
        throw new Error('proc 炸了')
      },
    })
    assert.deepEqual(broken.leftovers, [
      'probe-error:fs:Error: fs 炸了',
      'probe-error:port:Error: port 炸了',
      'probe-error:proc:Error: proc 炸了',
    ])

    await disposeIsolationContext(ctx)
  } finally {
    removeDir(root)
  }
})

/* ------------------------------------------------------------- cleanup -- */

test('releaseStepNotes：释放其一，另一个仍由夹具兜底释放（且不重复释放）', async () => {
  const fixture = new Fixture()
  const calls = []
  registerStepDisposer(fixture, 'note-a', () => calls.push('a'))
  registerStepDisposer(fixture, 'note-b', () => calls.push('b'))

  assert.deepEqual(await releaseStepNotes(fixture, ['note-a']), ['note-a'])
  assert.deepEqual(calls, ['a'], '本步只该释放被点名的那个')

  // 幂等：重复调用不再释放，也不抛
  assert.deepEqual(await releaseStepNotes(fixture, ['note-a']), [])
  assert.deepEqual(calls, ['a'])

  // 不存在的键 / 不是资源的取证值：跳过而不是抛
  fixture.note('plain-evidence', 'just a string')
  assert.deepEqual(await releaseStepNotes(fixture, ['nope', 'plain-evidence']), [])

  // 其余流程（夹具整份兜底释放）仍然释放 note-b；note-a 不会被二次释放
  const report = await fixture.release()
  assert.deepEqual(calls, ['a', 'b'])
  assert.deepEqual(report.failures, [])
  assert.deepEqual(report.released, ['note-b', 'note-a'], '夹具逆序释放')

  // 释放之后再调一次：同样不抛、不重复释放
  assert.deepEqual(await releaseStepNotes(fixture, ['note-b']), [])
  assert.deepEqual(calls, ['a', 'b'])
})

test('releaseStepNotes：disposer 抛错不抛穿，失败进 Fixture.release() 的 failures', async () => {
  const fixture = new Fixture()
  registerStepDisposer(fixture, 'boom', () => {
    throw new Error('炸了')
  })
  registerStepDisposer(fixture, 'ok', () => undefined)

  // 不抛穿；失败的那条不计入"实际释放了哪些键"
  assert.deepEqual(await releaseStepNotes(fixture, ['boom']), [])

  const report = await fixture.release()
  assert.equal(report.failures.length, 1, JSON.stringify(report))
  assert.equal(report.failures[0].label, 'boom')
  assert.match(report.failures[0].error, /炸了/)
  assert.ok(report.released.includes('ok'))

  // 重复调用仍然幂等（失败也不会被重复上报）
  assert.deepEqual(await releaseStepNotes(fixture, ['boom']), [])
  const again = await fixture.release()
  assert.deepEqual(again.failures, [])
})

test('releaseStepNotes：异步 disposer 会被 await（不会退回"步骤结束没拆掉"）', async () => {
  const fixture = new Fixture()
  let done = false
  fixture.note('async-note', async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    done = true
  })

  assert.deepEqual(await releaseStepNotes(fixture, ['async-note']), ['async-note'])
  assert.equal(done, true, 'await 之后副作用必须已经落地')
  assert.deepEqual(await releaseStepNotes(fixture, ['async-note']), [])

  const report = await fixture.release()
  assert.deepEqual(report.failures, [])
})

test('releaseStepNotes：裸函数句柄同样幂等，未点名的仍由夹具释放', async () => {
  const fixture = new Fixture()
  const calls = []
  fixture.note('bare', () => calls.push('bare'))
  fixture.add('manual', () => calls.push('manual'))

  assert.deepEqual(await releaseStepNotes(fixture, ['bare']), ['bare'])
  assert.deepEqual(calls, ['bare'])
  assert.deepEqual(await releaseStepNotes(fixture, ['bare']), [])

  await fixture.release()
  assert.deepEqual(calls, ['bare', 'manual'])
})

/* ------------------------------------------- 并发 vs 串行（端到端一致性） -- */

/** 合成一条 tool 场景的 YAML：`delayMs` 制造真实重叠，两个断言让比对口径不止"通过与否"。 */
function scenarioYaml(spec) {
  const lines = [
    'schema: 1',
    `id: ${spec.id}`,
    `title: 并发隔离合成场景 ${spec.id}`,
    'kind: tool',
    'status: active',
    `parallel: ${spec.parallel}`,
    'source:',
    '  issue: null',
    '  summary: 并发一致性测试用合成场景（离线 tool 动作 + 延迟以制造重叠）',
    'setup:',
    '  tool:',
    '    register:',
    `      name: ${spec.tool}`,
  ]
  if (spec.delayMs !== undefined) lines.push(`      delayMs: ${spec.delayMs}`)
  lines.push(
    `      returns: ${spec.returns}`,
    'steps:',
    '  - name: 调用工具',
    '    act:',
    `      tool: ${spec.tool}`,
    '      args: {}',
    '    expect:',
    '      - ref: fx.resultText',
    `        contains: ${spec.returns}`,
    '      - ref: fx.callCount',
    '        is: 1',
    '',
  )
  return lines.join('\n')
}

/** 造一个临时 cases 目录并写入若干合成场景（文件名必须与 id 一致）。 */
function makeSyntheticCasesDir(specs) {
  const dir = makeRoot('iso-cases')
  for (const spec of specs) {
    writeFileSync(join(dir, `${spec.id}.yaml`), scenarioYaml(spec), 'utf8')
  }
  return dir
}

/** 4 条连续 safe 场景（都带 80ms 延迟，用来制造真实重叠）。 */
const SAFE_SPECS = [1, 2, 3, 4].map((index) => ({
  id: `TK-91${String(index).padStart(2, '0')}`,
  tool: `iso-probe-${index}`,
  parallel: 'safe',
  delayMs: 80,
  returns: `iso-ok-${index}`,
}))

/**
 * 用 createDriverRegistry() 的**真实 driver**，只在 tool 的 act 上包一层探针，
 * 记录"同时在飞的场景数"——这是"并发真的发生了"的硬证据（不靠墙钟）。
 */
function makeProbeDrivers() {
  const base = createDriverRegistry()
  const registry = new DriverRegistry()
  const state = { active: 0, maxActive: 0, starts: [] }

  for (const driver of base.list()) {
    if (driver.kind !== 'tool' || typeof driver.act !== 'function') {
      registry.register(driver)
      continue
    }
    registry.register({
      ...driver,
      async act(ctx, action) {
        state.active += 1
        state.maxActive = Math.max(state.maxActive, state.active)
        state.starts.push(ctx.scenario.id)
        try {
          await driver.act(ctx, action)
        } finally {
          state.active -= 1
        }
      },
    })
  }
  return { registry, state }
}

/** 比对口径：每条 case 的 verdict + **每一步断言的 (ref, ok) 有序集合**。 */
function digest(cases) {
  return [...cases]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((item) => ({
      id: item.id,
      verdict: item.verdict,
      assertions: item.steps.map((step) =>
        step.assertions.map((a) => `${a.assertion.ref}:${a.ok ? 'ok' : 'fail'}`),
      ),
      failed: item.steps.flatMap((s) => s.assertions).filter((a) => !a.ok).length,
    }))
}

test('并发 vs 串行：safe 场景逐条 verdict 与断言 ok 完全一致（真实 driver）', async () => {
  const casesDir = makeSyntheticCasesDir(SAFE_SPECS)
  // 整个用例体都在 try 里：断言提前失败也不该把临时目录留在磁盘上
  let serialHost
  let concurrentHost
  try {
    const registry = new CaseRegistry(casesDir)
    registry.reload()
    assert.deepEqual(registry.invalidCases, [], '合成场景必须通过 schema 校验（含 parallel: safe）')

    const ids = SAFE_SPECS.map((spec) => spec.id)
    const scenarios = registry.filter({ ids })
    assert.equal(scenarios.length, 4)

    // 先确认执行计划：4 条连续 safe + limit=4 ⇒ 一个并发组，组内并发度就是 4
    const plan = groupScenarios(scenarios, { limit: 4 })
    assert.deepEqual(
      plan.map((g) => [g.kind, g.items.length]),
      [['parallel', 4]],
    )

    serialHost = await createHeadlessHost()
    concurrentHost = await createHeadlessHost()

    // ---- 串行：一次 runScenarios，runner 内部逐条跑 ----
    const serialDrivers = makeProbeDrivers()
    const serial = await runScenarios({
      registry,
      drivers: serialDrivers.registry,
      host: serialHost.host,
      filter: { ids },
      defaultTimeoutMs: 20_000,
    })

    // ---- 并发：同一个宿主 / 同一个注册表，按执行计划并发跑 ----
    const concurrentDrivers = makeProbeDrivers()
    const concurrentCases = []
    for (const group of plan) {
      if (group.kind === 'serial') {
        const run = await runScenarios({
          registry,
          drivers: concurrentDrivers.registry,
          host: concurrentHost.host,
          filter: { ids: group.items.map((s) => s.id) },
          defaultTimeoutMs: 20_000,
        })
        concurrentCases.push(...run.cases)
      } else {
        const runs = await Promise.all(
          group.items.map((scenario) =>
            runScenarios({
              registry,
              drivers: concurrentDrivers.registry,
              host: concurrentHost.host,
              filter: { ids: [scenario.id] },
              defaultTimeoutMs: 20_000,
            }),
          ),
        )
        for (const run of runs) concurrentCases.push(...run.cases)
      }
    }

    const serialDigest = digest(serial.cases)
    const concurrentDigest = digest(concurrentCases)

    // 先证明比对不是空谈：两边都必须真的跑通过（否则"一致"可能只是都挂了）
    assert.deepEqual(
      serialDigest.map((c) => c.verdict),
      ['passed', 'passed', 'passed', 'passed'],
      JSON.stringify(serial.cases.map((c) => [c.id, c.verdict, c.error, c.skipReason])),
    )
    assert.deepEqual(concurrentDigest, serialDigest, '并发跑的逐条结论必须与串行完全一致')

    // 硬证据：串行从不重叠；并发确实同时在飞（场景里有 80ms 延迟保证重叠）
    assert.equal(serialDrivers.state.maxActive, 1, '串行引擎不应有重叠')
    assert.equal(serialDrivers.state.starts.length, 4)
    assert.ok(
      concurrentDrivers.state.maxActive > 1,
      `并发组应真的重叠执行，实际 maxActive=${concurrentDrivers.state.maxActive}`,
    )
    assert.equal(concurrentDrivers.state.starts.length, 4)
  } finally {
    if (serialHost) await serialHost.dispose()
    if (concurrentHost) await concurrentHost.dispose()
    removeDir(casesDir)
  }
})

test('并发 vs 串行：exclusive 场景被夹在并发组之间时，顺序与结论都不变', async () => {
  // registry 会按 id 排序，所以「夹在中间」要靠 id 本身落在中间来构造：
  // 9201 / 9202 是 safe，9203 是 exclusive，9204 / 9205 又是 safe。
  const specs = [
    { id: 'TK-9201', tool: 'iso-probe-a', parallel: 'safe', returns: 'iso-ok-a' },
    { id: 'TK-9202', tool: 'iso-probe-b', parallel: 'safe', returns: 'iso-ok-b' },
    { id: 'TK-9203', tool: 'iso-probe-c', parallel: 'exclusive', returns: 'iso-ok-c' },
    { id: 'TK-9204', tool: 'iso-probe-d', parallel: 'safe', returns: 'iso-ok-d' },
    { id: 'TK-9205', tool: 'iso-probe-e', parallel: 'safe', returns: 'iso-ok-e' },
  ]
  const casesDir = makeSyntheticCasesDir(specs)

  let host
  try {
    const registry = new CaseRegistry(casesDir)
    registry.reload()
    const ids = specs.map((spec) => spec.id)
    const scenarios = registry.filter({ ids })
    assert.equal(scenarios.length, 5)

    const plan = groupScenarios(scenarios, { limit: 2 })
    assert.deepEqual(
      plan.map((g) => [g.kind, g.items.map((s) => s.id)]),
      [
        ['parallel', ['TK-9201', 'TK-9202']],
        ['serial', ['TK-9203']],
        ['parallel', ['TK-9204', 'TK-9205']],
      ],
      '独占场景必须把前后两个并发段切开，且自己单独成组',
    )
    // 执行计划整体保序
    assert.deepEqual(
      plan.flatMap((g) => g.items.map((s) => s.id)),
      ids,
    )

    host = await createHeadlessHost()
    const drivers = makeProbeDrivers()
    const cases = []
    for (const group of plan) {
      const runs = await Promise.all(
        group.items.map((scenario) =>
          runScenarios({
            registry,
            drivers: drivers.registry,
            host: host.host,
            filter: { ids: [scenario.id] },
            defaultTimeoutMs: 20_000,
          }),
        ),
      )
      for (const run of runs) cases.push(...run.cases)
    }

    assert.deepEqual(
      digest(cases).map((c) => c.verdict),
      ['passed', 'passed', 'passed', 'passed', 'passed'],
      JSON.stringify(cases.map((c) => [c.id, c.verdict, c.error])),
    )
  } finally {
    if (host) await host.dispose()
    removeDir(casesDir)
  }
})
