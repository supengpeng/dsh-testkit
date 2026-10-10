/**
 * 执行引擎。
 *
 * 职责：选场景 → 逐个建夹具 → 交给 driver 造条件 → 逐步断言 → **一定**释放夹具 → 汇总。
 *
 * 设计约束（见 docs/ARCHITECTURE.md §5.5）：
 *   - 默认串行：活宿主状态共享，串行结果最可预测
 *   - 每个 case 独立超时；超时记 failed（区别于 errored）
 *   - 夹具释放必须在 finally 里，无论成败
 *   - **成本闸门**：`RunRequest.policy` 省略 = 不启用闸门（库语义不变）；
 *     传入时按 cost 档位判定，拒绝一律记 `skipped`（"没跑" ≠ "跑挂了"）
 */

import { classifyCase } from '../analysis/classify.js'
import { buildMinimalReproForScenario } from '../analysis/repro.js'
import { applyScenarioFixtures } from '../fixtures/apply.js'
// 逐模块导入（不用 index 桶文件）：桶文件会让"这个符号到底住哪"变成一道谜题，
// 而 runner 是唯一消费者，直接点名更省事。
import { releaseStepNotes } from '../isolation/cleanup.js'
import {
  createIsolationContext,
  disposeIsolationContext,
  type IsolationContext,
} from '../isolation/context.js'
import { detectLeftovers } from '../isolation/leaks.js'
import { groupScenarios, isSafeScenario } from '../isolation/pool.js'
import type { CaseFilter, CaseRegistry } from '../cases/registry.js'
import {
  SCENARIO_KINDS,
  type CostClass,
  type HostCapability,
  type Scenario,
  type ScenarioKind,
  type StepAction,
} from '../cases/types.js'
import {
  BudgetExceeded,
  checkBudget,
  checkSandboxAction,
  evaluateScenario,
  maxCost,
  policySnapshot,
  UsageMeter,
  type ExecutionPolicy,
  type SandboxPolicy,
} from '../executor/policy.js'
import {
  DriverRegistry,
  SkipCase,
  type Driver,
  type DriverContext,
  type HostFacade,
} from '../kinds/types.js'
import { evaluateAssertion } from './assert.js'
import { Fixture } from './fixture.js'
import { resolveRef, type RefEnvironment } from './refs.js'
import {
  emptyTotals,
  tallyTotals,
  type AssertionOutcome,
  type CaseOutcome,
  type CaseVerdict,
  type CleanupRecord,
  type ExecutionRecord,
  type FixtureRef,
  type PolicyDecision,
  type RunSummary,
  type SelectionRecord,
  type StepOutcome,
  type TraceSpan,
} from './runlog.js'

export interface RunRequest {
  registry: CaseRegistry
  drivers: DriverRegistry
  host: HostFacade
  /** 选哪些场景；省略 = 全部 active。 */
  filter?: CaseFilter
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 进度回调（UI 与流式输出用）。 */
  onProgress?: (event: RunProgress) => void
  /** 默认超时（毫秒），可被 case 的 runtime.timeoutMs 覆盖。 */
  defaultTimeoutMs?: number
  /**
   * 成本闸门。
   *
   * **省略 = 不启用闸门**——这是刻意的库语义：既有嵌入方与 386 条既有测试
   * 不该因为引入闸门而改变行为。插件面（`testkit_run`、client bridge、`/testkit run`）
   * 一律显式构造并传入，默认 `allowModel: false`（见 `src/executor/policy.ts`）。
   */
  policy?: ExecutionPolicy
  /**
   * 夹具应用（`scenario.fixtures`）。
   *
   * **省略 = 不应用夹具**：没声明 `fixtures` 的场景本来就与夹具无关；
   * 声明了但调用方没给这个选项时，夹具会被无视——所以插件面的三条入口一律显式传。
   */
  fixtures?: { fixturesDir: string; dshVersion?: string }
  /**
   * 并发度上限；`<= 1` = 串行（默认）。
   *
   * 只有显式声明 `parallel: safe` 的场景会被并发；`exclusive`（含缺省）永远独占。
   */
  parallelLimit?: number
  /** 选择器取证：增量模式下由入口算好后传入，runner 只负责落进报告。 */
  selection?: SelectionRecord
}

export type RunProgress =
  | { phase: 'run-start'; total: number }
  | { phase: 'case-start'; caseId: string; index: number; total: number }
  | { phase: 'case-end'; caseId: string; verdict: CaseVerdict; index: number; total: number }
  | { phase: 'run-end'; totals: RunSummary['totals'] }

const DEFAULT_TIMEOUT_MS = 30_000

/** 生成运行 ID：`2026-10-09T23-36-22_ab12`。 */
export function makeRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d+Z$/, '').replace(/:/g, '-')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}_${rand}`
}

/** 执行一批场景。 */
export async function runScenarios(request: RunRequest): Promise<RunSummary> {
  const { registry, drivers, host, filter, signal, onProgress, policy, fixtures, selection } = request
  const defaultTimeout = request.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const parallelLimit = Math.max(1, Math.floor(request.parallelLimit ?? 1))

  const selected = registry
    .filter(filter ?? { status: ['active'] })
    .filter((s) => (s.status ?? 'active') !== 'retired')

  const startedAt = new Date()
  const outcomes: CaseOutcome[] = []
  onProgress?.({ phase: 'run-start', total: selected.length })

  // 进度事件要带**在选中序列里的位置**：并发时"第几个跑完"与"第几个"不是一回事，
  // 用递增计数器会让 case-start/case-end 的下标对不上。
  const positionOf = new Map(selected.map((scenario, i) => [scenario.id, i + 1]))

  const runWithProgress = async (scenario: Scenario): Promise<CaseOutcome> => {
    const index = positionOf.get(scenario.id) ?? 0
    onProgress?.({ phase: 'case-start', caseId: scenario.id, index, total: selected.length })
    const outcome = await runOne(scenario, {
      drivers,
      host,
      signal,
      timeoutMs: scenario.runtime?.timeoutMs ?? defaultTimeout,
      ...(policy === undefined ? {} : { policy }),
      ...(fixtures === undefined ? {} : { fixtures }),
    })
    onProgress?.({
      phase: 'case-end',
      caseId: scenario.id,
      verdict: outcome.verdict,
      index,
      total: selected.length,
    })
    return outcome
  }

  // 分组：`exclusive` 永远独占，只有连续的 `safe` 段按上限切块。
  const groups =
    parallelLimit > 1
      ? groupScenarios(selected, { limit: parallelLimit })
      : [{ kind: 'serial' as const, items: selected }]

  for (const group of groups) {
    if (signal?.aborted) break
    if (group.kind === 'parallel') {
      // 组内并发但**保序**（Promise.all 保序），所以报告与串行跑逐条对齐。
      outcomes.push(...(await Promise.all(group.items.map((scenario) => runWithProgress(scenario)))))
    } else {
      for (const scenario of group.items) {
        if (signal?.aborted) break
        outcomes.push(await runWithProgress(scenario))
      }
    }
  }

  const safeCount = selected.filter((scenario) => isSafeScenario(scenario)).length
  const execution: ExecutionRecord = {
    parallel: parallelLimit > 1 && safeCount > 0 ? 'limited' : 'off',
    limit: parallelLimit,
    safe: safeCount,
    exclusive: selected.length - safeCount,
  }

  const summary: RunSummary = {
    runId: makeRunId(startedAt),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    casesDir: registry.dir,
    dshVersion: host.env.dshVersion,
    platform: host.env.platform,
    totals: outcomes.length > 0 ? tallyTotals(outcomes) : emptyTotals(),
    cases: outcomes,
    // 快照进报告：复现"当时为什么这么判"（策略对象运行期可变，快照不会）
    ...(policy === undefined ? {} : { policySnapshot: policySnapshot(policy) }),
    // 增量模式必须自证"为什么只跑了这些"：判定依据原样落盘，不靠读者猜。
    ...(selection === undefined ? {} : { selection }),
    // 并发取证：报告要能说明这次是串行还是并发，以及为什么某些场景独占。
    ...(parallelLimit > 1 ? { execution } : {}),
  }

  onProgress?.({ phase: 'run-end', totals: summary.totals })
  return summary
}

interface RunOneDeps {
  drivers: DriverRegistry
  host: HostFacade
  signal?: AbortSignal
  timeoutMs: number
  /** 省略 = 不启用闸门（见 `RunRequest.policy`）。 */
  policy?: ExecutionPolicy
  /** 省略 = 不应用夹具（见 `RunRequest.fixtures`）。 */
  fixtures?: { fixturesDir: string; dshVersion?: string }
}

/** 跑单条场景。任何路径都必须走到夹具释放。 */
async function runOne(scenarioInput: Scenario, deps: RunOneDeps): Promise<CaseOutcome> {
  const t0 = Date.now()
  const fixture = new Fixture()
  const policy = deps.policy

  /** 提前收尾（未进入执行阶段）时的 outcome 构造器。 */
  const finishing = (
    verdict: CaseVerdict,
    extra: Partial<CaseOutcome> = {},
  ): CaseOutcome => ({
    id: scenarioInput.id,
    title: scenarioInput.title,
    kind: scenarioInput.kind,
    verdict,
    durationMs: Date.now() - t0,
    steps: [],
    notes: fixture.snapshot(),
    releaseFailures: [],
    sourceIssue: scenarioInput.source.issue,
    ...(scenarioInput.owner === undefined ? {} : { owner: scenarioInput.owner }),
    ...extra,
  })

  // ---- 夹具应用（`fixtures:`）----
  //
  // 放在**所有判定之前**：夹具决定这条场景到底在什么条件下跑，
  // 拿未合并的 setup 去做能力/成本判定，会出现"按 A 判定、按 B 执行"。
  // 夹具缺失或版本不匹配 → skipped 并说明原因（绝不用错夹具硬跑）。
  let scenario = scenarioInput
  let fixtureRefs: FixtureRef[] | undefined
  if (deps.fixtures !== undefined && (scenarioInput.fixtures?.length ?? 0) > 0) {
    const applied = await applyScenarioFixtures(scenarioInput, {
      fixturesDir: deps.fixtures.fixturesDir,
      dshVersion: deps.fixtures.dshVersion ?? deps.host.env.dshVersion,
    })
    scenario = applied.scenario
    fixtureRefs = applied.refs
    if (applied.skipReason !== undefined) {
      return finishing('skipped', {
        skipReason: applied.skipReason,
        fixtures: applied.refs,
      })
    }
  }

  const repeat = Math.max(1, scenario.runtime?.repeat ?? 1)

  const env: RefEnvironment = {
    dshVersion: deps.host.env.dshVersion,
    platform: deps.host.env.platform,
    nodeVersion: deps.host.env.nodeVersion,
  }

  if (!deps.drivers.get(scenario.kind)) {
    return finishing('errored', {
      error: `kind=${scenario.kind} 的 driver 尚未实现（见 docs/ROADMAP.md Phase 1）`,
    })
  }

  // 参与本场景 setup 的 driver：主 kind ＋ `setup` 里出现的 kind 键。
  //
  // 为什么要多个：有些场景需要「先造条件，再用另一种动作驱动」——
  // 例如「注册一个假答者，然后派真实子 agent 去问用户」。
  // 只取 scenario.kind 会让这类**组合场景**无法表达。
  const setupKinds = setupKindsOf(scenario)
  const setupDrivers: Driver[] = []
  for (const kind of setupKinds) {
    const found = deps.drivers.get(kind)
    if (!found) {
      return finishing('errored', { error: `setup 里出现了 kind=${kind}，但没有对应 driver` })
    }
    setupDrivers.push(found)
  }

  // ---- 成本闸门 ----
  //
  // 顺序刻意放在能力判定**之前**：能力缺失时的 skipped 只是"这台宿主跑不了"，
  // 而成本拒绝是"这次运行没被授权"，后者是更根本的原因，报告里应当先说它。
  let decision: PolicyDecision | undefined
  let limits = { maxModelCalls: 0, maxTokens: 0 }

  if (policy !== undefined) {
    const involved = involvedDriverCosts(scenario, deps.drivers)
    const evaluated = evaluateScenario({
      ...(scenario.cost === undefined ? {} : { scenarioCost: scenario.cost }),
      driverCost: involved.cost,
      ...(scenario.budget === undefined ? {} : { budget: scenario.budget }),
      policy,
    })
    decision = evaluated.decision
    limits = evaluated.limits

    // 参与 driver 没声明 cost()：按保守默认档（high）处理，并如实把来源记成 default。
    if (!involved.declared) decision.source = 'default'

    if (!decision.allowed) {
      // 「没跑」和「跑挂了」必须是两回事：拒绝一律 skipped + 原因 + 判定依据。
      return finishing('skipped', { skipReason: decision.reason, policy: decision })
    }

    // 沙箱开关（显式收紧时才生效；默认值不改变既有行为）。
    // 预检而不是跑到一半才拒：拒绝要让整条 case 的结论可复现。
    const violation = sandboxViolation(scenario, policy.sandbox)
    if (violation !== undefined) {
      return finishing('skipped', { skipReason: violation, policy: decision })
    }
  }

  // 能力判定：所有参与 driver 的 requires ∪ case.runtime.requires
  const required = new Set<HostCapability>([...(scenario.runtime?.requires ?? [])])
  for (const d of setupDrivers) {
    for (const capability of d.requires ?? []) required.add(capability)
  }
  const missing = [...required].filter((cap) => !deps.host.capabilities.has(cap))
  if (missing.length > 0) {
    return finishing('skipped', {
      skipReason: `宿主缺少能力：${missing.join(', ')}`,
      ...(decision === undefined ? {} : { policy: decision }),
    })
  }

  // ---- 隔离上下文 ----
  //
  // 每个场景一个独占的 namespace / tmpdir：并发跑时这是"不互相污染"的前提，
  // 串行跑时它是"残留可检出"的锚点。端口只**声明**不分配（Node 没有可靠的同步
  // 端口检查，不猜就不写假条目——见 `detectLeftovers` 的探针说明）。
  let isolation: IsolationContext | undefined
  try {
    isolation = createIsolationContext(scenario)
    fixture.note('isolationNamespace', isolation.namespace)
    fixture.note('isolationTmpdir', isolation.tmpdir)
  } catch (error) {
    // 隔离目录建不出来不该改变判定（它既不是被授权问题，也不是产品问题）。
    // 但必须留痕：否则"没有残留"会被误解成"检查过了没问题"。
    fixture.note(
      'isolationError',
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    )
  }

  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = (): void => controller.abort()
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, deps.timeoutMs)

  // 闸门启用才记账；未启用时 driver 拿到的 usage 是 undefined（不许悄悄记账）
  const usage = policy === undefined ? undefined : new UsageMeter()
  const ctx: DriverContext = {
    host: deps.host,
    fixture,
    scenario,
    signal: controller.signal,
    ...(usage === undefined ? {} : { usage }),
  }

  let steps: StepOutcome[] = []
  let releaseFailures: Array<{ label: string; error: string }> = []
  let verdict: CaseVerdict = 'passed'
  let error: string | undefined
  let skipReason: string | undefined
  /** 每轮是否"干净"（无硬失败断言、未超时）；repeat > 1 时进 outcome.rounds。 */
  const rounds: boolean[] = []
  /** 步骤级 cleanup 实际释放掉的取证键（进 `CaseOutcome.cleanup.released`）。 */
  const releasedNotes: string[] = []
  /** 场景跑完后检测到的残留（临时目录 / 端口 / 进程；探针没给就不猜）。 */
  let leftovers: string[] | undefined
  /**
   * 步骤级 trace（文档 §6.1）。
   *
   * 记**真实偏移**（相对 case 起点），不是"把各步耗时加起来"——后者会把
   * setup / teardown / 断言之间的空档全部抹掉，而那些空档恰恰是排查
   * "为什么这条场景突然慢了 300ms"的唯一线索。
   */
  const spans: TraceSpan[] = []
  const mark = (phase: TraceSpan['phase'], name: string, from: number, ok?: boolean): void => {
    spans.push({
      phase,
      name,
      startMs: Math.max(0, from - t0),
      durationMs: Math.max(0, Date.now() - from),
      ...(ok === undefined ? {} : { ok }),
    })
  }
  let budgetError: BudgetExceeded | undefined

  try {
    for (let round = 1; round <= repeat; round += 1) {
      // 按 SCENARIO_KINDS 的固定顺序 setup，保证可复现（不依赖对象键顺序）
      for (const d of setupDrivers) {
        const tSetup = Date.now()
        await d.setup(ctx, scenario)
        mark('setup', `setup:${d.kind}`, tSetup)
        if (controller.signal.aborted) throw new Error('aborted')
      }

      const roundResult = await runSteps(
        ctx,
        deps.drivers,
        env,
        deps.host,
        usage === undefined ? undefined : { usage, limits },
        releasedNotes,
        { caseStart: t0, spans },
      )
      const roundSteps = roundResult.steps

      // 这一轮的结论必须单独记：多轮断言被合并进同一份 steps 之后，
      // 「三轮里失败一轮」和「三轮全失败」在报告里长得一模一样，
      // 而 flaky 判定（src/analysis/classify.ts）只能靠这个数组。
      rounds.push(!timedOut && !hasHardFailure(roundSteps))
      steps = round === 1 ? roundSteps : mergeSteps(steps, roundSteps)

      // 动作阶段的 SkipCase：整条场景跳过。这一轮**不记进 rounds**——
      // "跳过"不是"这一轮没通过"，混进去会让 flaky 判定把环境缺失当成抖动。
      if (roundResult.skip !== undefined) {
        rounds.pop()
        verdict = 'skipped'
        skipReason = roundResult.skip
        break
      }

      // 每轮结束即拆夹具，保证下一轮环境干净
      const roundRelease = await fixture.release()
      if (roundRelease.failures.length > 0) releaseFailures = releaseFailures.concat(roundRelease.failures)

      // 预算超限就立刻停：继续跑只是把账单做大
      if (roundResult.budgetError !== undefined) {
        budgetError = roundResult.budgetError
        break
      }
    }

    if (verdict === 'skipped') {
      // 已经因 SkipCase 判定跳过：**不要**再被"这一步失败"的取证覆盖成 failed。
      // （跳过的场景里，触发跳过的那一步 action.ok 必然是 false，这是取证而非结论。）
    } else if (budgetError !== undefined) {
      verdict = 'failed'
      error = `${budgetError.name}: ${budgetError.message}`
    } else if (timedOut) {
      verdict = 'failed'
      error = `超时（> ${deps.timeoutMs}ms）`
    } else if (hasHardFailure(steps)) {
      verdict = 'failed'
    }
  } catch (err) {
    if (err instanceof SkipCase) {
      verdict = 'skipped'
      skipReason = err.message
    } else if (err instanceof BudgetExceeded) {
      verdict = 'failed'
      error = `${err.name}: ${err.message}`
    } else if (timedOut) {
      verdict = 'failed'
      error = `超时（> ${deps.timeoutMs}ms）`
    } else {
      verdict = 'errored'
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    }

    // 没跑完的轮次如实补 false：否则"第 2 轮炸了"会在 rounds 里凭空消失，
    // 抖动判定就少了一轮证据。只在已经跑过至少一轮、且不是主动跳过时补。
    if (verdict !== 'skipped' && rounds.length > 0) {
      while (rounds.length < repeat) rounds.push(false)
    }
  } finally {
    clearTimeout(timer)
    deps.signal?.removeEventListener('abort', onExternalAbort)

    const tCleanup = Date.now()

    // 兜底释放（setup 中途失败时尚未释放；release 幂等）
    const tail = await fixture.release()
    if (tail.failures.length > 0) releaseFailures = releaseFailures.concat(tail.failures)

    // teardown 逆序调用（与 setup 相反）；单个失败不覆盖既有判定
    for (const d of [...setupDrivers].reverse()) {
      try {
        await d.teardown?.(ctx)
      } catch {
        /* 忽略 */
      }
    }

    // 残留检测放在 **dispose 之前**：口径是「这条场景自己清干净了吗」
    // （文档 §7.4 要检测的正是临时文件/进程/端口残留）。
    // dispose 是**兜底删除**，不是检测手段——先删再查会把残留一起删掉，
    // 于是永远"没有残留"，这个检查就变成了装饰。
    if (isolation !== undefined) {
      leftovers = detectLeftovers(isolation).leftovers
      await disposeIsolationContext(isolation)
    }

    mark('cleanup', 'release+teardown', tCleanup, (leftovers?.length ?? 0) === 0)
  }

  // case 总跨度兜底收尾：trace 里始终有一条 `phase: 'case'` 的整条跨度，
  // 时间线才能拿它当坐标轴（各阶段跨度都相对它定位）。
  spans.push({
    phase: 'case',
    name: scenario.id,
    startMs: 0,
    durationMs: Math.max(0, Date.now() - t0),
    ...(verdict === 'skipped' ? {} : { ok: verdict === 'passed' }),
  })

  const outcome: CaseOutcome = {
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    verdict,
    durationMs: Date.now() - t0,
    ...(error === undefined ? {} : { error }),
    ...(skipReason === undefined ? {} : { skipReason }),
    steps,
    notes: fixture.snapshot(),
    releaseFailures,
    sourceIssue: scenario.source.issue,
    ...(scenario.owner === undefined ? {} : { owner: scenario.owner }),
    ...(fixtureRefs === undefined ? {} : { fixtures: fixtureRefs }),
    ...(rounds.length > 1 ? { rounds } : {}),
    ...(spans.length === 0 ? {} : { trace: spans }),
    ...(decision === undefined ? {} : { policy: decision }),
    ...(usage === undefined ? {} : { usage: usage.snapshot() }),
    // 清理取证：只在"确实做了点什么"时写，避免每份报告都被空记录淹没。
    ...(releasedNotes.length === 0 && (leftovers?.length ?? 0) === 0
      ? {}
      : {
          cleanup: {
            released: [...new Set(releasedNotes)],
            leftovers: leftovers ?? [],
          } satisfies CleanupRecord,
        }),
  }

  // 归因必须落在**最终对象**上：classifyCase 要读 rounds / policy / releaseFailures，
  // 所以顺序不能提前（提前构造等于喂给它半成品）。
  const category = classifyCase(outcome)
  if (category !== undefined) outcome.failureCategory = category

  // 最小复现只写给"跑挂了"的：通过的没必要；跳过的原因已经在 skipReason 里说清了。
  if (outcome.verdict === 'failed' || outcome.verdict === 'errored') {
    const failing = firstFailingStep(steps)
    outcome.minimalRepro = buildMinimalReproForScenario(scenario, failing)
  }

  return outcome
}

/** 是否存在"硬失败"断言（软断言不算）。 */
function hasHardFailure(steps: readonly StepOutcome[]): boolean {
  return steps.some((s) => s.assertions.some((a) => !a.ok && !a.soft))
}

/** 第一条硬失败步骤的下标；没有则 undefined（最小复现用它点出"看哪一步"）。 */
function firstFailingStep(steps: readonly StepOutcome[]): number | undefined {
  const index = steps.findIndex((s) => s.assertions.some((a) => !a.ok && !a.soft))
  return index === -1 ? undefined : index
}

/**
 * 参与本场景的 driver 的最高成本档位。
 *
 * 参与 = 主 kind ＋ `setup` 键 ＋ **每步 act 的归属 kind**。最后一项不能漏：
 * `scenario.kind: tool` 而某步 act 了 `{ shell: … }` 的组合场景确实存在，
 * 只看 kind 会把 shell 的 `low` 漏看成本场景的 `none`。
 *
 * 没声明 `cost()` 的 driver 按 **`high`（保守）** 处理，并把 `declared` 置 false：
 * 闸门的原则是"不认识的东西不默认放行"。缺 driver 的 kind 直接跳过——
 * 那种情况会在运行时报 engine 错，不该被伪装成"成本问题"。
 */
function involvedDriverCosts(
  scenario: Scenario,
  drivers: DriverRegistry,
): { cost: CostClass; declared: boolean } {
  const kinds = new Set<ScenarioKind>(setupKindsOf(scenario))
  for (const step of scenario.steps ?? []) {
    if (!step.act) continue
    const owner = actionOwnerKind(step.act)
    if (owner !== undefined) kinds.add(owner)
  }

  let cost: CostClass = 'none'
  let declared = true
  for (const kind of kinds) {
    const driver = drivers.get(kind)
    if (driver === undefined) continue
    const declaredCost = driver.cost?.()
    if (declaredCost === undefined) {
      declared = false
      cost = maxCost(cost, 'high')
      continue
    }
    cost = maxCost(cost, declaredCost)
  }
  return { cost, declared }
}

/**
 * 沙箱预检：任一步的动作命中沙箱拒绝规则，整条 case 记 skipped。
 *
 * 为什么预检而不是执行到那一步才拒：拒的是**整条 case 的授权**，
 * 跑了一半再拒会留下"部分副作用 + 半份证据"，既不可复现也不好读。
 */
function sandboxViolation(scenario: Scenario, sandbox: SandboxPolicy): string | undefined {
  const steps = scenario.steps ?? []
  // 场景自己注册了假 provider（`setup.resource`）时网络已被接管：
  // resource 动作不需要真网，所以「禁止任意网络请求」这条对它不成立。
  const networkIntercepted = scenario.setup !== undefined && 'resource' in scenario.setup
  for (const [i, step] of steps.entries()) {
    if (!step.act) continue
    const reason = checkSandboxAction(step.act, sandbox, { networkIntercepted })
    if (reason !== undefined) {
      const name = step.name === undefined ? '' : `「${step.name}」`
      return `${reason}（第 ${i + 1} 步${name}）`
    }
  }
  return undefined
}

/** 每步之后要过的预算关（闸门未启用时整块不传）。 */
interface BudgetGuard {
  usage: UsageMeter
  limits: { maxModelCalls: number; maxTokens: number }
}

interface RoundSteps {
  steps: StepOutcome[]
  /** 超限时带出：已经跑过的步骤原样保留，不因为对账失败就丢掉证据。 */
  budgetError?: BudgetExceeded
  /**
   * 某一步的动作抛了 `SkipCase`：这一轮**不是失败，是没法评估**。
   *
   * 为什么必须区分：`SkipCase` 的语义是"前置条件不满足"，与"断言没通过"完全不同。
   * 早先只有 **setup** 阶段的 `SkipCase` 被当成跳过，动作阶段抛出的会被记成
   * "这一步失败"→ 整条场景判 failed：于是"外部 fixture 没下载"在本地（有 fixture）
   * 绿、在全新检出（没有 fixture）红 —— 这不是被测对象坏了，是环境没准备好。
   * 现在两个阶段同口径：都是 skipped + 一条说清"缺什么、怎么补"的理由。
   */
  skip?: string
}

async function runSteps(
  ctx: DriverContext,
  drivers: DriverRegistry,
  env: RefEnvironment,
  host: HostFacade,
  budget?: BudgetGuard,
  cleanupSink?: string[],
  trace?: { caseStart: number; spans: TraceSpan[] },
): Promise<RoundSteps> {
  const out: StepOutcome[] = []
  const markSpan = (phase: TraceSpan['phase'], name: string, from: number, ok?: boolean): void => {
    if (trace === undefined) return
    trace.spans.push({
      phase,
      name,
      startMs: Math.max(0, from - trace.caseStart),
      durationMs: Math.max(0, Date.now() - from),
      ...(ok === undefined ? {} : { ok }),
    })
  }

  for (const [i, step] of ctx.scenario.steps.entries()) {
    const t0 = Date.now()
    const outcome: StepOutcome = {
      name: step.name ?? `step ${i + 1}`,
      assertions: [],
      durationMs: 0,
    }

    // 步骤开始前的取证快照——用来算"这一步改了什么"
    const notesBefore = { ...ctx.fixture.snapshot() }

    // **先入列再执行**：这个对象之后被就地改写（断言、notes、耗时），所以提前入列
    // 不影响最终内容；但一旦中途 `SkipCase` 跳出，已经跑过的证据不会丢。
    out.push(outcome)

    if (step.act) {
      const tAct = Date.now()
      try {
        await performAction(step.act, drivers, ctx, host)
        outcome.action = { kind: actionKind(step.act), ok: true }
      } catch (err) {
        outcome.action = {
          kind: actionKind(step.act),
          ok: false,
          detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }
        markSpan('act', actionKind(step.act), tAct, false)
        if (err instanceof SkipCase) {
          // 动作阶段发现前置条件不满足 → 记下动作失败取证（上面已写），
          // 然后把**整条场景**标成跳过：这不是"这一步没通过"。
          outcome.durationMs = Date.now() - t0
          return { steps: out, skip: err.message }
        }
      }
      if (outcome.action.ok) markSpan('act', actionKind(step.act), tAct, true)
    }

    const tAssert = Date.now()
    for (const assertion of step.expect ?? []) {
      const resolved = resolveRef(assertion.ref, {
        fixture: ctx.fixture,
        scenario: ctx.scenario,
        env,
      })
      const evaluated = evaluateAssertion(assertion, resolved.value)
      const entry: AssertionOutcome = {
        assertion,
        ok: evaluated.ok && resolved.found,
        actual: resolved.value,
        message: resolved.found ? evaluated.message : (resolved.reason ?? '取值失败'),
        soft: assertion.soft === true,
      }
      outcome.assertions.push(entry)
    }
    if ((step.expect ?? []).length > 0) {
      // 断言阶段只有"有断言可判"时才记跨度：空 expect 的步骤记一条 0ms 的
      // 假跨度，会让时间线上出现一堆无意义的碎片。
      markSpan(
        'assert',
        `assert:${outcome.name}`,
        tAssert,
        !outcome.assertions.some((a) => !a.ok && !a.soft),
      )
    }

    // 该步的取证**增量**：只记新出现或值变化的 key。
    // case 层的 notes 只保留最终值，多步场景里同名 note（例如每步的 stdout）
    // 会互相覆盖——这个增量让每一步的现场都可追溯。
    const notesAfter = ctx.fixture.snapshot()
    const delta: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(notesAfter)) {
      if (!(key in notesBefore) || !Object.is(notesBefore[key], value)) delta[key] = value
    }
    if (Object.keys(delta).length > 0) outcome.notes = delta

    outcome.durationMs = Date.now() - t0

    // ---- 步骤级 cleanup ----
    //
    // 位置在断言与取证之后：本步的取证已经采集完，再释放资源就不会"证据跟着资源一起没了"。
    // `releaseStepNotes` 是**幂等且不抛穿**的（键不存在/已释放/disposer 抛错都只记账），
    // 所以这里不需要 try：一次清理失败不该把整条场景判成 errored。
    const notes = step.cleanup?.releaseNotes ?? []
    if (notes.length > 0) {
      const released = await releaseStepNotes(ctx.fixture, notes)
      if (cleanupSink !== undefined) cleanupSink.push(...released)
    }

    // 每步之后对账：超限立刻停（而不是"跑完再看账单"），
    // 并把已经产生的 steps 原样带出去——对账失败不该吞掉现场证据。
    if (budget !== undefined) {
      try {
        checkBudget(budget.usage.snapshot(), budget.limits)
      } catch (err) {
        if (err instanceof BudgetExceeded) return { steps: out, budgetError: err }
        throw err
      }
    }
  }

  return { steps: out }
}

/**
 * 按**动作的形状**把 act 分派给对应的 driver。
 *
 * 注意这**不是**用 `scenario.kind` 的 driver——组合场景里
 * setup 的 kind 与 act 的 kind 可以不同（见 `setupKindsOf`）。
 */
async function performAction(
  action: StepAction,
  drivers: DriverRegistry,
  ctx: DriverContext,
  host: HostFacade,
): Promise<void> {
  if ('wait' in action) {
    await sleep(action.wait.ms, ctx.signal)
    return
  }

  const owner = actionOwnerKind(action)
  const d = owner === undefined ? undefined : drivers.get(owner)

  if ('emit' in action) {
    if (d?.act) {
      await d.act(ctx, action)
      return
    }
    // 无 driver 支持时仅记录：事件注入是 Phase 2 的能力
    host.log('debug', `emit ${action.emit.event}（driver 未声明 act，仅记录）`)
    return
  }

  if (owner === undefined) {
    throw new Error(`无法判断动作属于哪个 kind：${actionKind(action)}`)
  }
  if (!d) {
    throw new Error(`动作 ${actionKind(action)} 需要 kind=${owner} 的 driver，但它尚未实现`)
  }
  if (!d.act) {
    throw new Error(`kind=${owner} 的 driver 未实现 act，无法执行 ${actionKind(action)}`)
  }
  await d.act(ctx, action)
}

/**
 * 本场景需要在 setup 阶段跑哪些 driver。
 *
 * 规则：主 kind（`scenario.kind`）＋ `setup` 对象里出现的每个 kind 键。
 *
 * 这解锁了**组合场景**——例如「注册一个假答者（`interaction`），
 * 然后派真实子 agent 去问用户（`agent`）」，用来端到端验证
 * `Scoped<Agent>` 事件的作用域行为。
 *
 * 顺序固定为 `SCENARIO_KINDS` 的顺序，保证可复现（不依赖对象键顺序）。
 */
function setupKindsOf(scenario: Scenario): ScenarioKind[] {
  const wanted = new Set<ScenarioKind>([scenario.kind])
  for (const key of Object.keys(scenario.setup ?? {})) {
    if ((SCENARIO_KINDS as readonly string[]).includes(key)) wanted.add(key as ScenarioKind)
  }
  return SCENARIO_KINDS.filter((kind) => wanted.has(kind))
}

/**
 * 动作归属于哪个 kind（用于把 act 分派给正确的 driver）。
 *
 * 与 `actionKind` 的区别：后者是**给人看的标签**（`tool:bash`），
 * 这里是**给注册表用的键**（`tool`）。
 */
function actionOwnerKind(action: StepAction): ScenarioKind | undefined {
  if ('tool' in action) return 'tool'
  if ('prompt' in action) return 'prompt'
  if ('llm' in action) return 'llm'
  if ('interaction' in action) return 'interaction'
  if ('session' in action) return 'session'
  if ('resource' in action) return 'resource'
  if ('agent' in action) return 'agent'
  if ('ui' in action) return 'ui'
  if ('shell' in action) return 'shell'
  if ('file' in action) return 'file'
  if ('fs' in action) return 'fs'
  if ('compaction' in action) return 'compaction'
  return undefined
}

function actionKind(action: StepAction): string {
  if ('tool' in action) return `tool:${action.tool}`
  if ('prompt' in action) return 'prompt'
  if ('llm' in action) return 'llm'
  if ('interaction' in action) return 'interaction'
  if ('session' in action) return 'session'
  if ('resource' in action) return 'resource'
  if ('agent' in action) return 'agent'
  if ('ui' in action) return 'ui'
  if ('shell' in action) return `shell:${action.shell.argv[0] ?? ''}`
  if ('file' in action) {
    // 注意在 `action.file` 里找，不是在顶层——写成 `'read' in action` 会永远为 false，
    // 于是报告里显示 `file:glob:undefined`（真踩过）。
    const spec = action.file
    if ('read' in spec && spec.read !== undefined) return `file:read:${spec.read}`
    if ('glob' in spec && spec.glob !== undefined) return `file:glob:${spec.glob}`
    return `file:search:${('search' in spec ? spec.search?.pattern : undefined) ?? ''}`
  }
  if ('fs' in action) return `fs:${Object.keys(action.fs as object)[0] ?? 'unknown'}`
  if ('compaction' in action)
    return `compaction:${Object.keys(action.compaction as object)[0] ?? 'unknown'}`
  if ('wait' in action) return `wait:${action.wait.ms}ms`
  return `emit:${action.emit.event}`
}

/** repeat 时同名步骤合并断言，保留全部轮次判定以便暴露抖动。 */
function mergeSteps(acc: StepOutcome[], next: StepOutcome[]): StepOutcome[] {
  const merged = [...acc]
  next.forEach((step, i) => {
    const target = merged[i]
    if (target) {
      target.assertions.push(...step.assertions)
      target.durationMs += step.durationMs
    } else {
      merged.push(step)
    }
  })
  return merged
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
