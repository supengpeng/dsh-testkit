/**
 * 「跳过 vs 失败」的语义回归（真踩过一次，且是 CI 抓到的）。
 *
 * ## 背景
 *
 * 有 7 条场景依赖**下载来的外部 fixture**（`$FIXTURES/dsh-memory-0.8.1`，git 忽略）。
 * 它们的注释与 `src/config.ts` 都写着"缺失时**跳过并说明**"。但第一版实现里，
 * `file` driver 只在 **act** 阶段校验 root 是否存在，而 runner 当时只把
 * **setup** 阶段抛出的 `SkipCase` 当作跳过——
 * 动作阶段抛出的会被记成"这一步失败"，于是整条场景判 `failed`：
 *
 *   · 本地（`.fixtures` 已下载）→ 绿
 *   · 全新检出（CI 的 6 个矩阵任务）→ **全红**
 *
 * 这不是被测对象坏了，是**环境没准备好被判成了失败**。
 *
 * ## 本文件钉住三件事
 *
 * ① setup 阶段的前置条件缺失 → `skipped`（且理由说清"缺什么、怎么补"）
 * ② act 阶段的 `SkipCase` → 同样是 `skipped`，但**已经跑过的取证不丢**
 * ③ 负向对照：act 抛出的**普通异常**仍然判 `failed`（别把修复做成"什么都跳过"）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createDriverRegistry, SkipCase } from '../lib/kinds/index.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { runScenarios } from '../lib/runtime/runner.js'

/** 假场景：只带 runner 真正读的字段。 */
function scenario(overrides = {}) {
  return {
    schema: 1,
    id: 'TK-9201',
    title: '跳过语义用假场景',
    kind: 'file',
    source: { issue: null },
    setup: {},
    steps: [{ name: 'step 1', act: { file: { read: 'package.json' } }, expect: [] }],
    ...overrides,
  }
}

function stubRegistry(scenarios) {
  return {
    dir: 'cases',
    all: scenarios,
    invalidCases: [],
    problems: [],
    snapshot: { loadedAt: '2026-01-01T00:00:00.000Z' },
    countsByKind: () => ({}),
    filter: (query = {}) => scenarios.filter((s) => (query.ids ? query.ids.includes(s.id) : true)),
  }
}

/** 用一个 driver 覆盖注册表里的某个 kind（`register` 是 Map.set，后者胜）。 */
function withDriver(kind, driver) {
  const registry = createDriverRegistry()
  registry.register({ kind, description: `测试用 ${kind}`, setup: () => undefined, ...driver })
  return registry
}

test('setup 阶段缺前置条件 → skipped（外部 fixture 没下载不是失败）', async () => {
  const headless = await createHeadlessHost()
  try {
    // 刻意指向一个**不可能存在**的夹具名：断言不依赖本机是否下载过 .fixtures
    const summary = await runScenarios({
      registry: stubRegistry([
        scenario({
          id: 'TK-9201',
          setup: { file: { root: '$FIXTURES/definitely-not-downloaded-0000' } },
        }),
      ]),
      drivers: createDriverRegistry(),
      host: headless.host,
      filter: { ids: ['TK-9201'] },
      defaultTimeoutMs: 10_000,
    })

    const c = summary.cases[0]
    assert.equal(c.verdict, 'skipped', `缺 fixture 应判 skipped，实际：${c.verdict}`)
    assert.match(String(c.skipReason), /file\.root 不存在/)
    assert.match(String(c.skipReason), /fetch-fixtures/, '理由里必须给出"怎么补"')
    assert.equal(c.failureCategory, undefined, '跳过不是失败，不该带归因')
  } finally {
    await headless.dispose()
  }
})

test('act 阶段的 SkipCase → 同样 skipped，且已跑过的取证保留', async () => {
  const headless = await createHeadlessHost()
  try {
    const summary = await runScenarios({
      registry: stubRegistry([
        scenario({ id: 'TK-9202', steps: [{ name: '缺前置的一步', act: { file: { read: 'x' } }, expect: [] }] }),
      ]),
      drivers: withDriver('file', {
        act: () => {
          throw new SkipCase('环境缺 X：请先准备（这是个夹具）')
        },
      }),
      host: headless.host,
      filter: { ids: ['TK-9202'] },
      defaultTimeoutMs: 10_000,
    })

    const c = summary.cases[0]
    assert.equal(c.verdict, 'skipped', `act 阶段 SkipCase 应判 skipped，实际：${c.verdict}`)
    assert.match(String(c.skipReason), /环境缺 X/)
    // 取证不丢：那一步仍然在报告里，且写明动作失败的原因
    assert.equal(c.steps.length, 1, '触发跳过的这一步不该从报告里消失')
    assert.equal(c.steps[0].action.ok, false)
    assert.match(String(c.steps[0].action.detail), /SkipCase/)
    // 跳过的轮次不进 rounds：否则 flaky 判定会把"环境缺失"当成抖动
    assert.equal(c.rounds, undefined)
  } finally {
    await headless.dispose()
  }
})

test('负向对照：act 抛普通异常仍然是 failed（修复不是"什么都跳过"）', async () => {
  const headless = await createHeadlessHost()
  try {
    const summary = await runScenarios({
      registry: stubRegistry([
        scenario({
          id: 'TK-9203',
          steps: [
            { name: '会抛普通异常的一步', act: { file: { read: 'x' } }, expect: [{ ref: 'fx.fileExists', is: true }] },
          ],
        }),
      ]),
      drivers: withDriver('file', {
        act: () => {
          throw new Error('这是个真故障，不是环境缺失')
        },
      }),
      host: headless.host,
      filter: { ids: ['TK-9203'] },
      defaultTimeoutMs: 10_000,
    })

    const c = summary.cases[0]
    assert.equal(c.verdict, 'failed', '普通异常必须仍是 failed')
    assert.equal(c.skipReason, undefined)
    assert.equal(c.steps[0].action.ok, false)
  } finally {
    await headless.dispose()
  }
})
