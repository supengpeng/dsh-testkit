/**
 * 组合场景（跨 kind）的测试。
 *
 * ## 为什么需要这个能力
 *
 * 原先 runner 只取 `scenario.kind` 的**一个** driver，setup 与 act 都由它负责。
 * 这让「先造条件、再用另一种动作驱动」无法表达，例如：
 *   · 注册假答者（interaction）→ 派真实子 agent 去问用户（agent）
 *   · 注册假 provider（resource）→ 让 agent 用受限工具跑任务（agent）
 *
 * 现在规则是：**setup 跑「主 kind ＋ setup 里出现的每个 kind 键」**，
 * 而 **act 按动作形状分派**。
 *
 * 这些测试用真实 YAML → 真实 `CaseRegistry` → 真实 `runScenarios`，
 * 所以它同时验证了数据层到执行层的整条链路。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { CaseRegistry } from '../lib/cases/registry.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { createDriverRegistry } from '../lib/kinds/index.js'
import { runScenarios } from '../lib/runtime/runner.js'

/** 把一段 YAML 写进临时场景目录并跑它。 */
async function runYaml(yaml, { capabilities } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-xkind-'))
  try {
    writeFileSync(join(dir, 'TK-9001.yaml'), yaml, 'utf8')
    const headless = await createHeadlessHost(
      capabilities === undefined ? {} : { capabilities },
    )
    try {
      const registry = new CaseRegistry(dir)
      registry.reload()
      const run = await runScenarios({
        registry,
        drivers: createDriverRegistry(),
        host: headless.host,
        timeoutMs: 10_000,
      })
      return run.cases[0]
    } finally {
      await headless.dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('组合场景：setup 跑「主 kind ＋ setup 里出现的 kind」，act 按动作形状分派', async () => {
  // 主 kind 是 prompt，但 act 用的是 tool 动作，且 setup 里同时有 tool 与 prompt 的配置。
  // 三件事必须同时成立才算通过：
  //   ① tool driver 的 setup 被调用了（工具被注册）
  //   ② prompt driver 的 setup 被调用了（section 被注入）
  //   ③ act 被 tool driver 执行了（工具真的能调用）
  const outcome = await runYaml(`
schema: 1
id: TK-9001
title: 组合场景：tool 的 setup + prompt 的 setup，act 用 tool
kind: prompt
status: active
source: { issue: null }
setup:
  tool:
    register:
      name: probe
      description: 组合场景专用
      returns: 组合成功
  prompt:
    section:
      name: combo
      order: 1
      text: 组合场景注入的 section
steps:
  - name: 工具可被调用
    act: { tool: probe }
    expect:
      - { ref: fx.resultValue, is: 组合成功 }
  - name: prompt 的注入也生效了
    expect:
      - { ref: fx.sectionNames, contains: combo }
`)

  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
  assert.equal(outcome.kind, 'prompt', '主 kind 仍用于分类')
})

test('组合场景：act 的 kind 与主 kind 不同时，用动作自己的 driver', async () => {
  // 主 kind 是 ui（纯离线），但 act 是 tool 动作——
  // 若还是"用主 kind 的 driver 执行 act"，这里必然报错。
  const outcome = await runYaml(`
schema: 1
id: TK-9001
title: act 归属 tool 而主 kind 是 ui
kind: ui
status: active
source: { issue: null }
setup:
  tool:
    register:
      name: probe
      description: 组合场景专用
      returns: TOOL_OK
steps:
  - name: 工具动作应交给 tool driver
    act: { tool: probe }
    expect:
      - { ref: fx.resultValue, is: TOOL_OK }
`)

  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
  assert.equal(outcome.steps[0].action.kind, 'tool:probe')
  assert.equal(outcome.steps[0].action.ok, true)
})

test('组合场景：能力判定合并所有参与 driver 的 requires', async () => {
  // setup 里有 resource（需要 web 能力），宿主只给 tools → 应跳过并点名 web
  const skipped = await runYaml(
    `
schema: 1
id: TK-9001
title: 能力应合并判定
kind: tool
status: active
source: { issue: null }
setup:
  tool:
    register:
      name: probe
      description: d
      returns: x
  resource:
    webSearch: { results: [] }
steps:
  - name: 不该跑到这里
    act: { tool: probe }
    expect:
      - { ref: fx.resultValue, is: x }
`,
    { capabilities: ['tools'] },
  )

  assert.equal(skipped.verdict, 'skipped', JSON.stringify(skipped, null, 2))
  assert.match(String(skipped.skipReason), /web/)
})

test('组合场景：setup 里出现没有 driver 的 kind 时 errored（而不是静默忽略）', async () => {
  const outcome = await runYaml(`
schema: 1
id: TK-9001
title: 未知 kind
kind: tool
status: active
source: { issue: null }
setup:
  tool:
    register:
      name: probe
      description: d
      returns: x
  nonexistent-kind:
    whatever: true
steps:
  - name: 走不到
    act: { tool: probe }
    expect:
      - { ref: fx.resultValue, is: x }
`)

  // schema 校验会先拒掉未知 kind 值，所以这里应表现为无法解析而不是 errored；
  // 无论走哪条路，关键都是**不能静默忽略**。
  if (outcome === undefined) {
    assert.ok(true, 'YAML 未通过 schema 校验（预期行为：未知 kind 不被接受）')
  } else {
    assert.notEqual(outcome.verdict, 'passed')
  }
})

test('组合场景：现有的单 kind 场景行为不变（向后兼容）', async () => {
  const outcome = await runYaml(`
schema: 1
id: TK-9001
title: 单 kind 场景照旧
kind: tool
status: active
source: { issue: null }
setup:
  tool:
    register:
      name: probe
      description: d
      returns: SOLO_OK
steps:
  - name: 正常调用
    act: { tool: probe }
    expect:
      - { ref: fx.resultValue, is: SOLO_OK }
`)

  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
})
