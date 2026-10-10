/**
 * CI 轨（导出为 `node:test`）的闸门接线回归网。
 *
 * ## 为什么单独一个文件
 *
 * `tests/export.test.mjs` 管的是"生成物长什么样"（结构），
 * gate 里的 `node scripts/export-scenarios.mjs && node --test export/scenarios.test.mjs`
 * 管的是"生成物真的能跑"。本文件补的是两者之间的那条缝：
 *
 *   **CI 轨的每一次运行都必须显式带成本闸门**，否则"不烧钱"只是巧合——
 *   headless 宿主恰好缺 subagents / compaction 能力，所以高成本场景眼下跑不起来。
 *   哪天它们在 headless 里可行了，没有闸门的 CI 轨就会真的开始调模型。
 *
 * 断言分三层：
 *   ① 生成物里确实有 policy 接线（结构，不是靠肉眼）；
 *   ② 生成物把"为什么跳过"写清了，且**不静默排除**高成本场景；
 *   ③ 拿真实 `cases/` 按 CI 轨的调用方式跑一遍仍是 0 failed，且 high 档场景
 *      的跳过原因确实来自成本闸门（不是碰巧的其它原因）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CaseRegistry } from '../lib/cases/registry.js'
import { resolvePolicy } from '../lib/executor/policy.js'
import { EXPORT_IMPORTS, generateNodeTestFile } from '../lib/export/node-test.js'
import { exportScenariosToFile } from '../lib/export/write.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { DRIVER_COST, createDriverRegistry } from '../lib/kinds/index.js'
import { runScenarios } from '../lib/runtime/runner.js'
import { selectExportable } from '../scripts/export-scenarios.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function scenario(id, extra = {}) {
  return {
    schema: 1,
    id,
    title: '示例标题',
    kind: 'tool',
    source: { issue: null },
    setup: {},
    steps: [{ name: '一步', expect: [] }],
    ...extra,
  }
}

const BASE = {
  casesDir: join('C:', 'pkg', 'cases'),
  libSpecifier: '../lib/',
  generatedAt: '2026-10-10T00:00:00.000Z',
}

/** 把生成物里的 `async function runScenario(id)` 函数体抠出来。 */
function runScenarioBody(text) {
  const start = text.indexOf('async function runScenario(id)')
  assert.ok(start >= 0, '生成物应包含 runScenario')
  const end = text.indexOf('\n}', start)
  assert.ok(end > start, '生成物的 runScenario 应有收尾')
  return text.slice(start, end)
}

test('生成物显式带默认闸门：resolvePolicy 被 import，且 runScenarios 调用里传了 policy', () => {
  const out = generateNodeTestFile([scenario('TK-0001')], BASE)

  // ① 闸门入口在 export 的 import 清单里（清单是生成器与测试共用的事实源）
  assert.ok(
    EXPORT_IMPORTS.includes('executor/policy.js'),
    'EXPORT_IMPORTS 必须包含 executor/policy.js，否则生成物根本拿不到 resolvePolicy',
  )
  assert.match(out, /import \{ resolvePolicy \} from "\.\.\/lib\/executor\/policy\.js"/)

  // ② 不是"import 了但没用"：同一个 runScenarios 调用里必须真的带 policy
  const body = runScenarioBody(out)
  assert.match(body, /runScenarios\(\{/, 'runScenario 里应有 runScenarios 调用')
  assert.match(body, /policy: resolvePolicy\(\{\}\)/, 'runScenarios 必须显式带默认闸门')
  assert.ok(
    body.indexOf('policy: resolvePolicy({})') > body.indexOf('filter:'),
    'policy 与 filter 在同一次调用里（避免"改到另一个调用上"这种假接线）',
  )

  // ③ 允许"跑"的默认闸门只能是 allowModel=false 的那一份（不许悄悄放权）
  const policy = resolvePolicy({})
  assert.equal(policy.cost.allowModel, false, 'CI 轨不得默认允许真实模型调用')
  assert.equal(policy.cost.allowLowCost, true)
})

test('生成物的文件头写清了"结构上不可能烧钱"以及跳过的性质', () => {
  const out = generateNodeTestFile([scenario('TK-0001')], BASE)

  assert.match(out, /allowModel=false/)
  assert.match(out, /成本闸门/)
  assert.match(out, /skipped/, '要说清高成本场景在这里以 skipped 出现')
  assert.match(out, /预期结果，不是漏跑/)
  // 头部仍要保留原有的边界声明（不越界声称验证过真实 DSH）
  assert.match(out, /不依赖 DSH 运行时/)
  assert.match(out, /替代活宿主验证/)
})

test('高成本场景不被静默排除：仍生成 test()，跳过时走既有 t.skip 路径', () => {
  const out = generateNodeTestFile(
    [scenario('TK-0001'), scenario('TK-0014', { kind: 'agent', cost: 'high' })],
    BASE,
  )

  assert.equal((out.match(/^test\(/gm) ?? []).length, 2, '高成本场景也必须出现在生成物里')
  assert.match(out, /test\("TK-0014 示例标题"/)
  // 跳过路径：skipped → t.skip(原因)，而不是被删掉或改写成断言失败
  assert.match(out, /if \(outcome\.verdict === 'skipped'\) \{\s*\n\s*t\.skip\(outcome\.skipReason/)
})

test('落盘链路（testkit_export 共用）：写出的文件同样带闸门', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-testkit-export-track-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))

  const result = await exportScenariosToFile({
    scenarios: [scenario('TK-0001')],
    casesDir: join(REPO_ROOT, 'cases'),
    outDir,
    libDir: join(REPO_ROOT, 'lib'),
    generatedAt: '2026-10-10T00:00:00.000Z',
  })

  const content = readFileSync(result.file, 'utf8')
  assert.match(content, /policy: resolvePolicy\(\{\}\)/)
  assert.match(content, /executor\/policy\.js/)
  // 夹具链也必须写进生成物：否则「条件来自 fixtures:」的场景在 CI 轨会裸跑
  // （插件里绿、CI 里红）。这条断言让"同一条夹具链"变成结构约束。
  assert.match(content, /fixtures: \{ fixturesDir: FIXTURES_DIR, dshVersion: DSH_VERSION \}/)
  assert.match(content, /const FIXTURES_DIR = /)
})

test('CI 轨语义跑真实 cases/：0 failed，且 high 档场景的跳过原因来自成本闸门', async () => {
  const registry = new CaseRegistry(join(REPO_ROOT, 'cases'))
  registry.reload()

  // 与 scripts/export-scenarios.mjs 同一套选择语义（active + 非 fixture）
  const { selected } = selectExportable(registry.all)
  assert.ok(selected.length >= 19, `可导出场景太少，选择语义可能坏了：${selected.length}`)

  const headless = await createHeadlessHost()
  try {
    // 生成物对每条场景单独调一次 runScenarios；这里批量跑一次即可——
    // 「逐条与批量结论一致」由 tests/scenario-run.test.mjs 守。
    const summary = await runScenarios({
      registry,
      drivers: createDriverRegistry(),
      host: headless.host,
      filter: { ids: selected.map((s) => s.id) },
      defaultTimeoutMs: 20_000,
      policy: resolvePolicy({}),
      // 与生成物**逐字同构**：夹具链、宿主版本口径都要一致，
      // 否则这条用例证的是"另一个运行路径"，而不是 CI 轨。
      fixtures: { fixturesDir: join(REPO_ROOT, 'fixtures'), dshVersion: process.env.DSH_VERSION ?? 'headless' },
    })

    // ① 闸门不会把 CI 轨染红：不能有 failed / errored
    assert.equal(summary.totals.failed, 0, `CI 轨出现失败：${JSON.stringify(summary.cases.filter((c) => c.verdict === 'failed').map((c) => [c.id, c.error]))}`)
    assert.equal(summary.totals.errored, 0)
    assert.equal(summary.totals.total, selected.length, '导出的每条场景都必须被选中')
    for (const c of summary.cases.filter((x) => x.verdict === 'skipped')) {
      assert.ok(String(c.skipReason).length > 0, `${c.id} 跳过必须给原因`)
    }

    // ② 闸门确实是"每次运行都带"：summary 里有快照
    assert.equal(summary.policySnapshot?.allowModel, false)

    // ③ high 档（且场景没显式降档）的场景，跳过原因必须来自**成本闸门**。
    //    这条直接证明"CI 轨结构上不可能烧钱"，而不是"碰巧因为缺能力没跑"。
    const highCost = selected.filter(
      (s) => (s.cost ?? DRIVER_COST[s.kind]) === 'high',
    )
    assert.ok(highCost.length > 0, '当前 cases/ 里应至少有一条 high 档场景（否则这条断言失去意义）')
    for (const s of highCost) {
      const c = summary.cases.find((x) => x.id === s.id)
      assert.ok(c, `${s.id} 应出现在结果里`)
      assert.equal(c.verdict, 'skipped', `${s.id}（high 档）在没有 --allow-model 时不得执行`)
      assert.equal(c.policy?.allowed, false, `${s.id} 的 policy 判定应记为拒绝`)
      assert.match(c.skipReason ?? '', /成本闸门拒绝/, `${s.id} 的跳过原因应来自成本闸门`)
    }

    // ④ 显式降档的只读场景不受闸门牵连（TK-0034 就是这条路径）
    for (const s of selected.filter((x) => x.cost === 'none')) {
      const c = summary.cases.find((x) => x.id === s.id)
      assert.equal(c?.policy?.allowed, true, `${s.id} 显式 cost: none，闸门应当放行`)
      assert.equal(c?.policy?.source, 'scenario', `${s.id} 的档位来源应如实记为 scenario`)
    }
  } finally {
    await headless.dispose()
  }
})
