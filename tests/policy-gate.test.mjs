/**
 * 成本闸门（ExecutionPolicy）的回归网。
 *
 * ## 它守住的是什么
 *
 * 「成本不可控」是 P0：在本模块之前，"跑全部 active 场景"会把真实模型调用
 * 塞进 CI 与日常回归，且没人能事先声明"这一跑最多花多少"。这里守四件事：
 *
 *   ① 判定表逐条可复现（none 永远放行 / low 看 allowLowCost / high 看 allowModel）；
 *   ② **拒绝 ≠ 失败**：被闸门拒的 case 必须记 `skipped` + 原因 + 判定依据，
 *      绝不能算成 failed（否则报告会把"没跑"说成"跑挂了"）；
 *   ③ 预算是硬闸门：超限立刻 failed，且消息能直接进报告；
 *   ④ `repeat` 的抖动必须可判定（`rounds` 是 flaky 归因的唯一依据）。
 *
 * ## 为什么自建最小 driver + headless 宿主
 *
 * 本文件要验的是**闸门与 runner 的接线**，不是某个 kind 的语义。依赖真实 kind
 * 会把"闸门错了"和"某个 driver 在 headless 里跑不起来"混在一起。
 * 所以这里用假 driver（自己声明 cost / 自己记账）+ 产品里的 `createHeadlessHost()`。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

import { SCENARIO_KINDS } from '../lib/cases/types.js'
import {
  BudgetExceeded,
  DEFAULT_POLICY,
  UsageMeter,
  checkBudget,
  checkSandboxAction,
  commandName,
  evaluateScenario,
  policySnapshot,
  resolvePolicy,
  tightenLimit,
} from '../lib/executor/policy.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { DRIVER_COST, createDriverRegistry } from '../lib/kinds/index.js'
import { DriverRegistry } from '../lib/kinds/types.js'
import { PipelineStore } from '../lib/pipeline/store.js'
import { Fixture } from '../lib/runtime/fixture.js'
import { runScenarios } from '../lib/runtime/runner.js'
import { defineTestkitTools } from '../lib/tools.js'

/* ---------------------------------------------------------------- 脚手架 -- */

/** 假场景：只带 runner 真正读的字段。 */
function scenario(overrides = {}) {
  return {
    schema: 1,
    id: 'TK-9001',
    title: '闸门用假场景',
    kind: 'tool',
    source: { issue: null },
    setup: {},
    steps: [{ name: 'step 1', act: { tool: 'noop' }, expect: [] }],
    ...overrides,
  }
}

/** 注册表的窄替身：只实现 runner 用到的 `dir` 与 `filter()`。 */
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

function fakeDriver({ kind, cost, act, requires }) {
  return {
    kind,
    description: `fake ${kind}`,
    ...(requires === undefined ? {} : { requires }),
    ...(cost === undefined ? {} : { cost: () => cost }),
    setup: () => undefined,
    ...(act === undefined ? {} : { act }),
  }
}

/** 跑一批假场景；`policy` 省略 = 不启用闸门（库语义）。 */
async function runWith({ scenarios, drivers, policy, defaultTimeoutMs = 10_000 }) {
  const headless = await createHeadlessHost()
  try {
    return await runScenarios({
      registry: stubRegistry(scenarios),
      drivers,
      host: headless.host,
      defaultTimeoutMs,
      ...(policy === undefined ? {} : { policy }),
    })
  } finally {
    await headless.dispose()
  }
}

/* ------------------------------------------------------------ 判定表 -- */

test('判定表：none 永远放行，high 默认拒，low 看 allowLowCost', () => {
  const strict = resolvePolicy({ cost: { allowModel: false, allowLowCost: false } })
  const permissive = resolvePolicy({ cost: { allowModel: true, allowLowCost: true } })

  const none = evaluateScenario({ driverCost: 'none', policy: strict })
  assert.equal(none.decision.allowed, true, 'none 档在**任何**配置下都放行')
  assert.equal(none.decision.cost, 'none')
  assert.equal(none.decision.source, 'driver')
  assert.match(none.decision.reason, /放行/)

  const high = evaluateScenario({ driverCost: 'high', policy: strict })
  assert.equal(high.decision.allowed, false, 'high 默认拒——这是 P0 的落点')
  assert.equal(high.decision.cost, 'high')
  assert.match(high.decision.reason, /cost\.allowModel=false/)
  assert.match(high.decision.reason, /--allow-model/, '拒绝原因必须给出放权方式')

  const highOk = evaluateScenario({ driverCost: 'high', policy: permissive })
  assert.equal(highOk.decision.allowed, true)
  assert.match(highOk.decision.reason, /cost\.allowModel=true/)

  const lowOk = evaluateScenario({ driverCost: 'low', policy: resolvePolicy() })
  assert.equal(
    lowOk.decision.allowed,
    true,
    '默认 allowLowCost=true：low 档默认放行，否则既有 shell/fs 场景会平白跳过',
  )

  const lowDenied = evaluateScenario({ driverCost: 'low', policy: strict })
  assert.equal(lowDenied.decision.allowed, false)
  assert.match(lowDenied.decision.reason, /cost\.allowLowCost=false/)
})

test('判定表：场景显式 cost 覆盖 driver 默认，source 如实标注', () => {
  const strict = resolvePolicy({ cost: { allowModel: false } })

  // 降档：compaction 的只读动作（driver 默认 high）由场景声明成 none
  const lowered = evaluateScenario({ scenarioCost: 'none', driverCost: 'high', policy: strict })
  assert.equal(lowered.decision.allowed, true, '场景声明 none = 承诺不调模型，应当放行')
  assert.equal(lowered.decision.cost, 'none')
  assert.equal(lowered.decision.source, 'scenario')

  // 升档：driver 默认 none，但场景声明 high —— 仍然要 allowModel
  const raised = evaluateScenario({ scenarioCost: 'high', driverCost: 'none', policy: strict })
  assert.equal(raised.decision.allowed, false)
  assert.equal(raised.decision.cost, 'high')
  assert.equal(raised.decision.source, 'scenario')

  const raisedOk = evaluateScenario({
    scenarioCost: 'high',
    driverCost: 'none',
    policy: resolvePolicy({ cost: { allowModel: true } }),
  })
  assert.equal(raisedOk.decision.allowed, true)
  assert.equal(raisedOk.decision.source, 'scenario')
})

test('默认策略：默认不真调模型；shell 默认只读；禁止任意网络', () => {
  assert.equal(DEFAULT_POLICY.cost.allowModel, false, '默认不真调模型（文档 P0）')
  assert.equal(DEFAULT_POLICY.cost.allowLowCost, true, 'low 档默认放行（既有基线不因闸门变红）')
  assert.equal(DEFAULT_POLICY.sandbox.allowShell, true, 'shell 仍然可用——被限制的是**写命令**，不是 shell 本身')
  assert.equal(DEFAULT_POLICY.sandbox.allowFileWrite, true, 'fs driver 的职责就是驱动宿主沙箱语义，闸门层不替它决定')

  // 「shell 默认只读」= 默认拒绝清单非空（文档 §3.2.4 / §7.1）。
  // 只读的尺子是**命令名**：本仓 shell 动作是 argv 数组，没有重定向/管道。
  const denied = DEFAULT_POLICY.sandbox.denyWriteCommands
  assert.ok(denied.length > 0, '默认必须是一份只读清单，而不是空清单')
  for (const command of ['rm', 'mv', 'chmod', 'sh', 'powershell']) {
    assert.ok(denied.includes(command), `${command} 应在默认拒绝清单里`)
  }
  // 只读命令不受影响（既有 shell 场景跑的是 git / node / python）
  for (const benign of ['git', 'node', 'python', 'pytest']) {
    assert.equal(
      checkSandboxAction({ shell: { argv: [benign, '--version'] } }, DEFAULT_POLICY.sandbox, {}),
      undefined,
      `${benign} 不该被默认只读拦下`,
    )
  }
  // 禁止任意网络（文档 §7.1）：没有假 provider 就不放行 resource
  assert.equal(DEFAULT_POLICY.sandbox.allowNetwork, false)
  assert.match(
    checkSandboxAction({ resource: { fetch: { url: 'https://x.invalid' } } }, DEFAULT_POLICY.sandbox, {}) ?? '',
    /allowNetwork=false/,
  )
  // 例外：场景自带假 provider 时网络已被接管，不需要真网
  assert.equal(
    checkSandboxAction({ resource: { fetch: { url: 'https://x.invalid' } } }, DEFAULT_POLICY.sandbox, {
      networkIntercepted: true,
    }),
    undefined,
  )

  // 覆盖项逐个生效；0 是合法值（= 不限），不能被当成"没给"
  const custom = resolvePolicy({ cost: { allowModel: true, maxModelCalls: 3 }, sandbox: { allowShell: false } })
  assert.equal(custom.cost.allowModel, true)
  assert.equal(custom.cost.maxModelCalls, 3)
  assert.equal(custom.cost.allowLowCost, true, '没给的项取默认')
  assert.equal(custom.sandbox.allowShell, false)

  // 快照必须与策略对象解耦（否则历史报告会被后续改动污染）
  const snapshot = policySnapshot(custom)
  assert.equal(snapshot.allowModel, true)
  assert.equal(snapshot.sandbox.allowShell, false)
  custom.sandbox.allowedCommands.push('echo')
  assert.deepEqual(snapshot.sandbox.allowedCommands, [], '快照是拷贝，不是引用')
})

/* ------------------------------------------------------------ 预算与用量 -- */

test('预算上限：场景 budget 只能比策略更紧，0 = 不限', () => {
  const policy = resolvePolicy({ cost: { maxModelCalls: 5 } })

  const tighter = evaluateScenario({ driverCost: 'none', budget: { maxModelCalls: 2 }, policy })
  assert.equal(tighter.limits.maxModelCalls, 2, '场景自带上限更紧时按场景的算')

  const looser = evaluateScenario({ driverCost: 'none', budget: { maxModelCalls: 99 }, policy })
  assert.equal(looser.limits.maxModelCalls, 5, '场景不能放宽本次运行的上限（否则闸门可被数据绕过）')

  const policyCapped = evaluateScenario({ driverCost: 'none', policy })
  assert.equal(policyCapped.limits.maxModelCalls, 5, '场景没写 budget 时按策略上限')

  const unlimited = evaluateScenario({ driverCost: 'none', policy: resolvePolicy() })
  assert.equal(unlimited.limits.maxModelCalls, 0, '策略与场景都没给上限 → 0 = 不限')

  assert.equal(tightenLimit(0, 7), 7)
  assert.equal(tightenLimit(3, 0), 3)
  assert.equal(tightenLimit(3, 7), 3)
})

test('checkBudget：0 = 不限；超限抛 BudgetExceeded，消息带"上限 N，已用 M"', () => {
  const meter = new UsageMeter()
  assert.doesNotThrow(() => checkBudget(meter.snapshot(), { maxModelCalls: 0, maxTokens: 0 }))

  meter.recordModelCall()
  meter.recordTokens(120)
  assert.deepEqual(meter.snapshot(), { modelCalls: 1, tokens: 120 })
  assert.doesNotThrow(
    () => checkBudget(meter.snapshot(), { maxModelCalls: 1, maxTokens: 120 }),
    '恰好等于上限不算超限',
  )

  // 非法值不许污染账本
  meter.recordModelCall(0)
  meter.recordModelCall(-3)
  meter.recordTokens(Number.NaN)
  assert.deepEqual(meter.snapshot(), { modelCalls: 1, tokens: 120 })

  let calls
  try {
    checkBudget({ modelCalls: 2, tokens: 0 }, { maxModelCalls: 1, maxTokens: 0 })
  } catch (error) {
    calls = error
  }
  assert.ok(calls instanceof BudgetExceeded, '超限必须抛 BudgetExceeded')
  assert.equal(calls.name, 'BudgetExceeded')
  assert.equal(calls.message, '预算超限：模型调用次数上限 1 次，已用 2 次')

  let tokens
  try {
    checkBudget({ modelCalls: 0, tokens: 11 }, { maxModelCalls: 0, maxTokens: 10 })
  } catch (error) {
    tokens = error
  }
  assert.ok(tokens instanceof BudgetExceeded)
  assert.equal(tokens.message, '预算超限：token 上限 10，已用 11')
})

/* --------------------------------------------------------- runner 接线 -- */

test('runScenarios：high 档被拒 → skipped + skipReason + policy，且不是 failed', async () => {
  const drivers = new DriverRegistry()
  drivers.register(fakeDriver({ kind: 'agent', cost: 'high', act: () => undefined }))

  const run = await runWith({
    scenarios: [
      scenario({
        id: 'TK-9101',
        kind: 'agent',
        steps: [{ name: '派生', act: { agent: { prompt: 'x' } }, expect: [] }],
      }),
    ],
    drivers,
    policy: resolvePolicy(),
  })

  const c = run.cases[0]
  assert.equal(c.verdict, 'skipped', '「没跑」与「跑挂了」必须是两回事')
  assert.match(c.skipReason, /成本闸门拒绝/)
  assert.equal(c.policy.allowed, false)
  assert.equal(c.policy.cost, 'high')
  assert.equal(c.policy.source, 'driver')
  assert.equal(c.policy.reason, c.skipReason, 'policy.reason 就是跳过原因，不许两处各写一份')
  assert.equal(c.failureCategory, undefined, '跳过不写失败归因')
  assert.equal(c.steps.length, 0, '被拒的 case 一步都不该执行')
  assert.equal(run.totals.failed, 0)
  assert.equal(run.totals.skipped, 1)
  assert.deepEqual(run.policySnapshot, policySnapshot(resolvePolicy()), '闸门快照必须进 summary')
})

test('runScenarios：放行写 policy.allowed=true 与 usage；不传 policy 则完全不启用闸门', async () => {
  const drivers = new DriverRegistry()
  let acts = 0
  drivers.register(
    fakeDriver({
      kind: 'tool',
      cost: 'high',
      act: () => {
        acts += 1
      },
    }),
  )

  // driver 默认 high，但场景显式声明 none（只读动作）→ 无需放权就能跑
  const scenarios = [scenario({ id: 'TK-9102', cost: 'none' })]
  const withPolicy = await runWith({ scenarios, drivers, policy: resolvePolicy() })
  const c = withPolicy.cases[0]
  assert.equal(c.verdict, 'passed')
  assert.equal(c.policy.allowed, true)
  assert.equal(c.policy.cost, 'none')
  assert.equal(c.policy.source, 'scenario')
  assert.deepEqual(c.usage, { modelCalls: 0, tokens: 0 }, '放行时也要留用量证据（0 也是证据）')
  assert.deepEqual(withPolicy.policySnapshot, policySnapshot(resolvePolicy()))

  // 省略 policy = 库语义：闸门不参与，跑法与结论与改动前一致
  const noPolicy = await runWith({ scenarios, drivers })
  assert.equal(noPolicy.cases[0].verdict, 'passed')
  assert.equal(noPolicy.cases[0].policy, undefined)
  assert.equal(noPolicy.cases[0].usage, undefined, '未启用闸门就不记账')
  assert.equal(noPolicy.policySnapshot, undefined)
  assert.equal(acts, 2)
})

test('runScenarios：预算超限 → failed，error 带 BudgetExceeded 信息并保留已跑步骤', async () => {
  const drivers = new DriverRegistry()
  drivers.register(
    fakeDriver({
      kind: 'agent',
      cost: 'high',
      act: (ctx) => {
        ctx.usage?.recordModelCall()
      },
    }),
  )

  const run = await runWith({
    scenarios: [
      scenario({
        id: 'TK-9103',
        kind: 'agent',
        budget: { maxModelCalls: 1 },
        steps: [
          { name: '第一次调用', act: { agent: { prompt: 'a' } }, expect: [] },
          { name: '第二次调用', act: { agent: { prompt: 'b' } }, expect: [] },
        ],
      }),
    ],
    drivers,
    policy: resolvePolicy({ cost: { allowModel: true } }),
  })

  const c = run.cases[0]
  assert.equal(c.verdict, 'failed', '预算超限是**跑挂了**，不是没跑')
  assert.match(c.error, /BudgetExceeded/)
  assert.match(c.error, /预算超限：模型调用次数上限 1 次，已用 2 次/, '消息要能直接进报告')
  assert.deepEqual(c.usage, { modelCalls: 2, tokens: 0 })
  assert.equal(c.steps.length, 2, '对账失败不该吞掉现场：超限当步的步骤必须保留')
  assert.equal(c.policy.allowed, true, '档位是放行的，挂的是预算')
  assert.equal(run.totals.failed, 1)
  assert.equal(run.totals.skipped, 0)
})

test('runScenarios：repeat 抖动 → rounds=[true,false] 且 failureCategory=flaky', async () => {
  const drivers = new DriverRegistry()
  let rounds = 0
  drivers.register(
    fakeDriver({
      kind: 'tool',
      cost: 'none',
      act: (ctx) => {
        rounds += 1
        ctx.fixture.note('roundSeen', rounds)
      },
    }),
  )

  const run = await runWith({
    scenarios: [
      scenario({
        id: 'TK-9104',
        runtime: { repeat: 2 },
        steps: [
          {
            name: '每轮断言同一件事',
            act: { tool: 'noop' },
            expect: [{ ref: 'fx.roundSeen', is: 1 }],
          },
        ],
      }),
    ],
    drivers,
  })

  const c = run.cases[0]
  assert.equal(c.verdict, 'failed')
  assert.deepEqual(c.rounds, [true, false], '「一轮过一轮挂」必须与「两轮都挂」可区分')
  assert.equal(c.failureCategory, 'flaky')
  assert.equal(run.totals.failed, 1)
})

/* --------------------------------------------------------------- 沙箱 -- */

test('沙箱：allowShell / denyWriteCommands / allowFileWrite 是显式开关，命中即整条 skipped', async () => {
  // ---- 纯函数层 ----
  assert.match(
    checkSandboxAction({ shell: { argv: ['echo', 'hi'] } }, resolvePolicy({ sandbox: { allowShell: false } }).sandbox),
    /allowShell=false/,
  )
  assert.match(
    checkSandboxAction(
      { shell: { argv: ['/usr/bin/rm', '-rf', 'x'] } },
      resolvePolicy({ sandbox: { denyWriteCommands: ['rm'] } }).sandbox,
    ),
    /denyWriteCommands/,
  )
  assert.match(
    checkSandboxAction(
      { shell: { argv: ['curl', 'http://x'] } },
      resolvePolicy({ sandbox: { allowedCommands: ['echo'] } }).sandbox,
    ),
    /allowedCommands/,
  )
  assert.equal(commandName('C:\\Windows\\System32\\RM.exe'), 'rm', '路径与 .exe 后缀不能绕过拒绝清单')
  assert.equal(commandName('/usr/bin/rm'), 'rm')

  const readOnly = resolvePolicy({ sandbox: { allowFileWrite: false } })
  assert.match(checkSandboxAction({ fs: { write: { path: 'a.txt', text: 'x' } } }, readOnly.sandbox), /allowFileWrite=false/)
  assert.equal(checkSandboxAction({ fs: { read: { path: 'a.txt' } } }, readOnly.sandbox), undefined, '只读动作不受写权限限制')
  // 用 `resolve()` 生成**本平台**的绝对路径：早先这里硬写 `D:\secret\x.txt`，
  // 在 Linux/macOS 上它不是绝对路径，`allowedPaths` 根本不适用 → 断言拿到 undefined。
  const outsidePath = resolve('/secret/x.txt')
  const allowedRoot = resolve('/work')
  assert.match(
    checkSandboxAction({ file: { read: outsidePath } }, resolvePolicy({ sandbox: { allowedPaths: [allowedRoot] } }).sandbox),
    /allowedPaths/,
  )

  // ---- runner 层：预检命中 → 整条 skipped，且与"成本被拒"能分开看 ----
  const drivers = new DriverRegistry()
  drivers.register(fakeDriver({ kind: 'fs', cost: 'low', act: () => undefined }))
  const run = await runWith({
    scenarios: [
      scenario({
        id: 'TK-9105',
        kind: 'fs',
        steps: [{ name: '写文件', act: { fs: { write: { path: 'D:\\work\\a.txt', text: 'x' } } }, expect: [] }],
      }),
    ],
    drivers,
    policy: resolvePolicy({ sandbox: { allowFileWrite: false } }),
  })

  const c = run.cases[0]
  assert.equal(c.verdict, 'skipped')
  assert.match(c.skipReason, /沙箱策略拒绝/)
  assert.equal(c.policy.allowed, true, '成本档位是放行的；拒绝来自沙箱——两者必须能分开看')
  assert.equal(c.steps.length, 0)
})

/* ------------------------------------------------- 档位表与注册处记账 -- */

test('DRIVER_COST：覆盖全部 SCENARIO_KINDS，并由注册处注入到每个 driver', () => {
  assert.deepEqual(
    Object.keys(DRIVER_COST).sort(),
    [...SCENARIO_KINDS].sort(),
    '档位表漏一个 kind，那个 kind 就会走保守默认（静默变严）',
  )

  const drivers = createDriverRegistry()
  for (const kind of SCENARIO_KINDS) {
    const driver = drivers.get(kind)
    assert.ok(driver, `kind=${kind} 应有已注册的 driver`)
    assert.equal(driver.cost?.(), DRIVER_COST[kind], `kind=${kind} 的档位应由注册处注入`)
  }

  // 口径抽查：三类各一
  assert.equal(DRIVER_COST.llm, 'none', 'llm driver 接管 llm/stream，零上游请求')
  assert.equal(DRIVER_COST.shell, 'low')
  assert.equal(DRIVER_COST.fs, 'low')
  assert.equal(DRIVER_COST.agent, 'high', '真的会派生 subagent')
  assert.equal(DRIVER_COST.compaction, 'high', 'region 压缩可能生成摘要')
})

test('注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记', async () => {
  const headless = await createHeadlessHost()
  try {
    const agent = createDriverRegistry().get('agent')
    assert.ok(agent)

    const meter = new UsageMeter()
    const ctx = {
      host: headless.host,
      fixture: new Fixture(),
      scenario: scenario({ kind: 'agent', steps: [] }),
      signal: new AbortController().signal,
      usage: meter,
    }
    // headless 没有 subagents 服务：act 会抛错，但这正好验证"先记账再执行"
    await assert.rejects(async () => {
      await agent.act(ctx, { agent: { prompt: 'x' } })
    })
    assert.equal(meter.modelCalls, 1, '每个 act 只记一次（不是每 step 一次）')
    assert.equal(meter.tokens, 0, 'token 不猜：driver 没上报就记 0')

    const lowered = new UsageMeter()
    const loweredCtx = {
      ...ctx,
      fixture: new Fixture(),
      scenario: scenario({ kind: 'agent', cost: 'none', steps: [] }),
      usage: lowered,
    }
    await assert.rejects(async () => {
      await agent.act(loweredCtx, { agent: { prompt: 'x' } })
    })
    assert.equal(lowered.modelCalls, 0, '场景 cost:none 是显式降档（如 compaction 的只读 inspect），不计模型调用')
  } finally {
    await headless.dispose()
  }
})

/* ------------------------------------------------------------- 工具面 -- */

test('工具面：testkit_run 总是带闸门，且工具参数只能收紧（模型不能给自己开模型权限）', async () => {
  const headless = await createHeadlessHost()
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-policy-'))
  try {
    const scenarios = [
      scenario({
        id: 'TK-9106',
        kind: 'agent',
        steps: [{ name: '派生', act: { agent: { prompt: 'x' } }, expect: [] }],
      }),
    ]

    const tools = defineTestkitTools({
      registry: stubRegistry(scenarios),
      drivers: createDriverRegistry(),
      host: headless.host,
      runsDir: () => dir,
      exportDir: () => dir,
      defaultTimeoutMs: () => 10_000,
      maxInvalidReported: () => 5,
      pipeline: new PipelineStore({ pipelineDir: join(dir, 'pipeline'), casesDir: dir }),
      policyDefaults: () => resolvePolicy({ cost: { allowModel: false } }),
    })

    const run = tools.find((t) => t.name === 'testkit_run')
    assert.ok(run, 'testkit_run 工具必须存在')

    // 模型可以在参数里写 allowModel: true，但工具面只能收紧 → 仍按配置拒绝。
    // 若工具面忘了传 policy，这条 case 会因"宿主缺少能力"跳过（另一条路径），
    // 所以这里断言原因必须是**成本闸门**——那才证明闸门真的接上了。
    const text = await run.execute(
      { ids: ['TK-9106'], allowModel: true },
      { signal: new AbortController().signal },
    )
    assert.match(text, /成本闸门：allowModel=false/, '放权不是模型能自己做的事')
    assert.match(text, /成本闸门拒绝/)
    assert.match(text, /TK-9106/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    await headless.dispose()
  }
})
