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
  type PolicyDecision,
  type RunSummary,
  type StepOutcome,
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
  const { registry, drivers, host, filter, signal, onProgress, policy } = request
  const defaultTimeout = request.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS

  const selected = registry
    .filter(filter ?? { status: ['active'] })
    .filter((s) => (s.status ?? 'active') !== 'retired')

  const startedAt = new Date()
  const outcomes: CaseOutcome[] = []
  onProgress?.({ phase: 'run-start', total: selected.length })

  let index = 0
  for (const scenario of selected) {
    index += 1
    onProgress?.({ phase: 'case-start', caseId: scenario.id, index, total: selected.length })

    outcomes.push(
      await runOne(scenario, {
        drivers,
        host,
        signal,
        timeoutMs: scenario.runtime?.timeoutMs ?? defaultTimeout,
        ...(policy === undefined ? {} : { policy }),
      }),
    )

    const last = outcomes[outcomes.length - 1]!
    onProgress?.({
      phase: 'case-end',
      caseId: scenario.id,
      verdict: last.verdict,
      index,
      total: selected.length,
    })

    if (signal?.aborted) break
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
}

/** 跑单条场景。任何路径都必须走到夹具释放。 */
async function runOne(scenario: Scenario, deps: RunOneDeps): Promise<CaseOutcome> {
  const t0 = Date.now()
  const fixture = new Fixture()
  const repeat = Math.max(1, scenario.runtime?.repeat ?? 1)
  const policy = deps.policy

  const env: RefEnvironment = {
    dshVersion: deps.host.env.dshVersion,
    platform: deps.host.env.platform,
    nodeVersion: deps.host.env.nodeVersion,
  }

  /** 提前收尾（未进入执行阶段）时的 outcome 构造器。 */
  const finishing = (verdict: CaseVerdict, extra: Partial<CaseOutcome> = {}): CaseOutcome => ({
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    verdict,
    durationMs: Date.now() - t0,
    steps: [],
    notes: fixture.snapshot(),
    releaseFailures: [],
    sourceIssue: scenario.source.issue,
    ...extra,
  })

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
  let budgetError: BudgetExceeded | undefined

  try {
    for (let round = 1; round <= repeat; round += 1) {
      // 按 SCENARIO_KINDS 的固定顺序 setup，保证可复现（不依赖对象键顺序）
      for (const d of setupDrivers) {
        await d.setup(ctx, scenario)
        if (controller.signal.aborted) throw new Error('aborted')
      }

      const roundResult = await runSteps(
        ctx,
        deps.drivers,
        env,
        deps.host,
        usage === undefined ? undefined : { usage, limits },
      )
      const roundSteps = roundResult.steps

      // 这一轮的结论必须单独记：多轮断言被合并进同一份 steps 之后，
      // 「三轮里失败一轮」和「三轮全失败」在报告里长得一模一样，
      // 而 flaky 判定（src/analysis/classify.ts）只能靠这个数组。
      rounds.push(!timedOut && !hasHardFailure(roundSteps))
      steps = round === 1 ? roundSteps : mergeSteps(steps, roundSteps)

      // 每轮结束即拆夹具，保证下一轮环境干净
      const roundRelease = await fixture.release()
      if (roundRelease.failures.length > 0) releaseFailures = releaseFailures.concat(roundRelease.failures)

      // 预算超限就立刻停：继续跑只是把账单做大
      if (roundResult.budgetError !== undefined) {
        budgetError = roundResult.budgetError
        break
      }
    }

    if (budgetError !== undefined) {
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
  }

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
    ...(rounds.length > 1 ? { rounds } : {}),
    ...(decision === undefined ? {} : { policy: decision }),
    ...(usage === undefined ? {} : { usage: usage.snapshot() }),
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
  for (const [i, step] of steps.entries()) {
    if (!step.act) continue
    const reason = checkSandboxAction(step.act, sandbox)
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
}

async function runSteps(
  ctx: DriverContext,
  drivers: DriverRegistry,
  env: RefEnvironment,
  host: HostFacade,
  budget?: BudgetGuard,
): Promise<RoundSteps> {
  const out: StepOutcome[] = []

  for (const [i, step] of ctx.scenario.steps.entries()) {
    const t0 = Date.now()
    const outcome: StepOutcome = {
      name: step.name ?? `step ${i + 1}`,
      assertions: [],
      durationMs: 0,
    }

    // 步骤开始前的取证快照——用来算"这一步改了什么"
    const notesBefore = { ...ctx.fixture.snapshot() }

    if (step.act) {
      try {
        await performAction(step.act, drivers, ctx, host)
        outcome.action = { kind: actionKind(step.act), ok: true }
      } catch (err) {
        outcome.action = {
          kind: actionKind(step.act),
          ok: false,
          detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        }
      }
    }

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
    out.push(outcome)

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
