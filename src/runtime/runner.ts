/**
 * 执行引擎。
 *
 * 职责：选场景 → 逐个建夹具 → 交给 driver 造条件 → 逐步断言 → **一定**释放夹具 → 汇总。
 *
 * 设计约束（见 docs/ARCHITECTURE.md §5.5）：
 *   - 默认串行：活宿主状态共享，串行结果最可预测
 *   - 每个 case 独立超时；超时记 failed（区别于 errored）
 *   - 夹具释放必须在 finally 里，无论成败
 */

import type { CaseFilter, CaseRegistry } from '../cases/registry.js'
import { SCENARIO_KINDS, type HostCapability, type Scenario, type ScenarioKind, type StepAction } from '../cases/types.js'
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
  const { registry, drivers, host, filter, signal, onProgress } = request
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
  }

  onProgress?.({ phase: 'run-end', totals: summary.totals })
  return summary
}

interface RunOneDeps {
  drivers: DriverRegistry
  host: HostFacade
  signal?: AbortSignal
  timeoutMs: number
}

/** 跑单条场景。任何路径都必须走到夹具释放。 */
async function runOne(scenario: Scenario, deps: RunOneDeps): Promise<CaseOutcome> {
  const t0 = Date.now()
  const fixture = new Fixture()
  const repeat = Math.max(1, scenario.runtime?.repeat ?? 1)

  const env: RefEnvironment = {
    dshVersion: deps.host.env.dshVersion,
    platform: deps.host.env.platform,
    nodeVersion: deps.host.env.nodeVersion,
  }

  const finishing = (verdict: CaseVerdict, error?: string, skipReason?: string): CaseOutcome => ({
    id: scenario.id,
    title: scenario.title,
    kind: scenario.kind,
    verdict,
    durationMs: Date.now() - t0,
    ...(error === undefined ? {} : { error }),
    ...(skipReason === undefined ? {} : { skipReason }),
    steps: [],
    notes: fixture.snapshot(),
    releaseFailures: [],
    sourceIssue: scenario.source.issue,
  })

  if (!deps.drivers.get(scenario.kind)) {
    return finishing('errored', `kind=${scenario.kind} 的 driver 尚未实现（见 docs/ROADMAP.md Phase 1）`)
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
      return finishing('errored', `setup 里出现了 kind=${kind}，但没有对应 driver`)
    }
    setupDrivers.push(found)
  }

  // 能力判定：所有参与 driver 的 requires ∪ case.runtime.requires
  const required = new Set<HostCapability>([...(scenario.runtime?.requires ?? [])])
  for (const d of setupDrivers) {
    for (const capability of d.requires ?? []) required.add(capability)
  }
  const missing = [...required].filter((cap) => !deps.host.capabilities.has(cap))
  if (missing.length > 0) {
    return finishing('skipped', undefined, `宿主缺少能力：${missing.join(', ')}`)
  }

  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = (): void => controller.abort()
  deps.signal?.addEventListener('abort', onExternalAbort, { once: true })

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, deps.timeoutMs)

  const ctx: DriverContext = { host: deps.host, fixture, scenario, signal: controller.signal }

  let steps: StepOutcome[] = []
  let releaseFailures: Array<{ label: string; error: string }> = []
  let verdict: CaseVerdict = 'passed'
  let error: string | undefined
  let skipReason: string | undefined

  try {
    for (let round = 1; round <= repeat; round += 1) {
      // 按 SCENARIO_KINDS 的固定顺序 setup，保证可复现（不依赖对象键顺序）
      for (const d of setupDrivers) {
        await d.setup(ctx, scenario)
        if (controller.signal.aborted) throw new Error('aborted')
      }

      const roundSteps = await runSteps(ctx, deps.drivers, env, deps.host)
      steps = round === 1 ? roundSteps : mergeSteps(steps, roundSteps)

      // 每轮结束即拆夹具，保证下一轮环境干净
      const roundRelease = await fixture.release()
      if (roundRelease.failures.length > 0) releaseFailures = releaseFailures.concat(roundRelease.failures)
    }

    if (timedOut) {
      verdict = 'failed'
      error = `超时（> ${deps.timeoutMs}ms）`
    } else if (steps.some((s) => s.assertions.some((a) => !a.ok && !a.soft))) {
      verdict = 'failed'
    }
  } catch (err) {
    if (err instanceof SkipCase) {
      verdict = 'skipped'
      skipReason = err.message
    } else if (timedOut) {
      verdict = 'failed'
      error = `超时（> ${deps.timeoutMs}ms）`
    } else {
      verdict = 'errored'
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
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

  return {
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
  }
}

async function runSteps(
  ctx: DriverContext,
  drivers: DriverRegistry,
  env: RefEnvironment,
  host: HostFacade,
): Promise<StepOutcome[]> {
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
  }

  return out
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
