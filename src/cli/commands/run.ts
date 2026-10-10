/**
 * `dsh-testkit run` —— CLI 的主命令。
 *
 * ## 它跑在什么宿主上（**必须如实说明**）
 *
 * 用的是 `createHeadlessHost()`：一个自带的最小宿主，**不连接真实 DSH**。
 * 于是缺能力的场景会被 runner **如实记为 skipped**（`skipReason` 写清缺什么），
 * 而不是伪装成通过或失败。CLI 在每次 `run` 的头部都会把"具备什么 / 缺什么、
 * 会影响哪些 kind"打印出来——**不说清宿主是什么，报告就没有意义**：
 * 同一个 `run` 在 headless 与真实宿主上的结论本来就不同。
 *
 * ## 放权：CLI 是**人的**入口，所以可以提权
 *
 * 权限模型（`src/tools.ts` 的注释里写着同一条）：工具面只能收紧、不能提权，
 * 唯一放权入口是**人**发起的命令面。CLI 与 `/testkit run` 同属命令面——
 * 它由人（或 CI 配置）在终端敲出来，所以 `--allow-model` / `--allow-low-cost`
 * 可以真的放行 high / low 档。**模型够不到这条路径**：它没有执行进程的能力。
 *
 * ## 筛选语义只有一个来源
 *
 * `--only/--kind/--tag/--owner/--cost/--smoke` 全部交给 `src/dx` 的 `applyDxFilter`：
 * 工具面 / 命令面 / CLI 三个入口共用同一份筛选口径（尤其 `--cost` 是**上限（含）**
 * 而不是"只看这一档"这种容易各写各的语义）。CLI 只负责把参数翻成它的选项，
 * 不重新实现一遍筛选。
 */

import { statSync } from 'node:fs'

import { FAILURE_CATEGORY_LABEL } from '../../analysis/classify.js'
import { CaseRegistry, type CaseFilter } from '../../cases/registry.js'
import { SCENARIO_KINDS, type CostClass, type Scenario, type ScenarioKind } from '../../cases/types.js'
import { applyDxFilter, DEFAULT_SMOKE_BUDGET_MS, watchCases } from '../../dx/index.js'
import { createDriverRegistry } from '../../kinds/index.js'
import { createHeadlessHost } from '../../headless/index.js'
import { resolvePolicy, type PolicyOptions } from '../../executor/policy.js'
import { writeRunArtifacts, type RunArtifacts } from '../../report/json.js'
import { runScenarios, type RunProgress } from '../../runtime/runner.js'
import type { RunSummary } from '../../runtime/runlog.js'
import { resolveSelectionFromRaw } from '../../surface/selection-args.js'
import { all, has, oneTrimmed, parseIntOption, type OptionSpec, type ParsedOptions } from '../args.js'
import { describeHostGap, type CliContext, type HostGap } from '../context.js'
import { EXIT, exitCodeForTotals, type ExitCode } from '../exit.js'
import { emitError, emitJson, line } from '../io.js'

/** `run` 的选项表（同时供 help 渲染——help 与解析器同源，不会漂移）。 */
export const RUN_OPTIONS: readonly OptionSpec[] = [
  { name: 'allow-model', kind: 'boolean', help: '放行 high 档（真实模型调用；默认拒绝）' },
  { name: 'allow-low-cost', kind: 'boolean', help: '放行 low 档（起进程 / 写文件）' },
  { name: 'changed', kind: 'boolean', help: '只跑受工作区改动影响的场景（git 不可用则退回全量）' },
  { name: 'since', kind: 'value', placeholder: '<ref>', help: '只跑某 ref 之后改动影响的场景' },
  { name: 'affected-by', kind: 'repeat', placeholder: '<file>', help: '只跑受该文件影响的场景（可多次）' },
  { name: 'dsh-version', kind: 'value', placeholder: '<v>', help: '按宿主版本过滤，并让本次运行模拟该版本' },
  { name: 'parallel', kind: 'value', placeholder: '<n>', help: '并发度上限（只有 parallel: safe 的场景会并发）' },
  { name: 'redact', kind: 'boolean', help: '写报告前脱敏（token / 私钥 / 邮箱 / 家目录路径）' },
  { name: 'kind', alias: 'k', kind: 'repeat', placeholder: '<k>', help: '按 kind 过滤（可多次）' },
  { name: 'tag', alias: 't', kind: 'repeat', placeholder: '<t>', help: '按标签过滤（可多次，任一命中）' },
  { name: 'owner', kind: 'value', placeholder: '<o>', help: '按 owner 过滤' },
  {
    name: 'cost',
    kind: 'value',
    placeholder: '<none|low|high>',
    help: '允许的**最高**成本档（含）：none=只跑纯离线；low=再加本地副作用；high=全放（不是"只看这一档"）',
  },
  { name: 'only', kind: 'repeat', placeholder: '<id>', help: '只跑指定场景 id（可多次；位置参数等价）' },
  { name: 'smoke', kind: 'boolean', help: '只跑 smoke 集（预算内静态估算，见 src/dx）' },
  { name: 'smoke-budget', kind: 'value', placeholder: '<ms>', help: `smoke 集的估算预算（毫秒，缺省 ${DEFAULT_SMOKE_BUDGET_MS}）` },
  { name: 'watch', kind: 'boolean', help: '跑完不退出：监听场景目录变化并重跑（Ctrl-C 退出）' },
  { name: 'out', alias: 'o', kind: 'value', placeholder: '<dir>', help: '运行产物根目录（runs/）' },
  { name: 'cases', kind: 'value', placeholder: '<dir>', help: '场景目录（缺省 = 包内 cases/）' },
  { name: 'json', kind: 'boolean', help: 'stdout 只输出机器可读 JSON（进度改走 stderr）' },
]

const COST_CLASSES: readonly CostClass[] = ['none', 'low', 'high']

interface RunOptions {
  ids: string[]
  kinds: ScenarioKind[]
  tags: string[]
  owner?: string
  cost?: CostClass
  smoke: boolean
  smokeBudgetMs: number
  changed: boolean
  since?: string
  affectedBy: string[]
  dshVersion?: string
  parallel?: number
  redact: boolean
  watch: boolean
  /** `--allow-model`：放行 high 档（真实模型调用）。**只有人的入口能给**。 */
  allowModel: boolean
  /** `--allow-low-cost`：放行 low 档（起进程 / 写文件）。 */
  allowLowCost: boolean
  out?: string
  casesDir?: string
}

type Built = { ok: true; options: RunOptions } | { ok: false; error: string }

/** 解析并**校验** run 的选项（校验失败一律退出码 2，消息写清可选值）。 */
export function runOptionsFrom(parsed: ParsedOptions): Built {
  const kinds = all(parsed, 'kind')
  const badKinds = kinds.filter((kind) => !(SCENARIO_KINDS as readonly string[]).includes(kind))
  if (badKinds.length > 0) {
    return { ok: false, error: `未知 kind：${badKinds.join(', ')}（可选：${SCENARIO_KINDS.join(', ')}）` }
  }

  const cost = oneTrimmed(parsed, 'cost')
  if (cost !== undefined && !(COST_CLASSES as readonly string[]).includes(cost)) {
    return { ok: false, error: `--cost 只接受 ${COST_CLASSES.join(' / ')}（上限含），收到 ${cost}` }
  }

  const parallelRaw = oneTrimmed(parsed, 'parallel')
  let parallel: number | undefined
  if (parallelRaw !== undefined) {
    parallel = parseIntOption(parsed, 'parallel')
    if (parallel === undefined || parallel < 1) {
      return { ok: false, error: `--parallel 需要一个 >= 1 的整数，收到 ${parallelRaw}` }
    }
  }

  const smokeBudgetRaw = oneTrimmed(parsed, 'smoke-budget')
  let smokeBudgetMs = DEFAULT_SMOKE_BUDGET_MS
  if (smokeBudgetRaw !== undefined) {
    const value = parseIntOption(parsed, 'smoke-budget')
    if (value === undefined || value <= 0) {
      return { ok: false, error: `--smoke-budget 需要一个 > 0 的整数（毫秒），收到 ${smokeBudgetRaw}` }
    }
    smokeBudgetMs = value
  }

  // 位置参数与 `--only` 等价：`run TK-0001` 与 `run --only TK-0001` 都支持。
  const ids = [...parsed.positionals, ...all(parsed, 'only')].map((id) => id.trim()).filter((id) => id !== '')
  const tags = all(parsed, 'tag').map((tag) => tag.trim()).filter((tag) => tag !== '')
  const affectedBy = all(parsed, 'affected-by').map((file) => file.trim()).filter((file) => file !== '')
  const owner = oneTrimmed(parsed, 'owner')
  const since = oneTrimmed(parsed, 'since')
  const dshVersion = oneTrimmed(parsed, 'dsh-version')
  const out = oneTrimmed(parsed, 'out')
  const casesDir = oneTrimmed(parsed, 'cases')

  return {
    ok: true,
    options: {
      ids,
      kinds: kinds as ScenarioKind[],
      tags,
      ...(owner === undefined ? {} : { owner }),
      ...(cost === undefined ? {} : { cost: cost as CostClass }),
      smoke: has(parsed, 'smoke'),
      smokeBudgetMs,
      changed: has(parsed, 'changed'),
      ...(since === undefined ? {} : { since }),
      affectedBy,
      ...(dshVersion === undefined ? {} : { dshVersion }),
      ...(parallel === undefined ? {} : { parallel }),
      redact: has(parsed, 'redact'),
      watch: has(parsed, 'watch'),
      allowModel: has(parsed, 'allow-model'),
      allowLowCost: has(parsed, 'allow-low-cost'),
      ...(out === undefined ? {} : { out }),
      ...(casesDir === undefined ? {} : { casesDir }),
    },
  }
}

/** 载入案例目录（不存在 / 不是目录由调用方判定为基础设施错误）。 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把 CLI 选项翻成 `src/dx` 的筛选选项。
 *
 * **`status` 的例外**：显式点名（`--only` / 位置参数）时**不受 status 限制**——
 * 按 id 单跑 draft 是刻意支持的用法（团队通道场景只能这样跑）。
 * 没有显式点名时只跑 active：draft 绝不能混进默认回归集。
 */
function dxOptionsFor(options: RunOptions): Parameters<typeof applyDxFilter>[1] {
  const explicit = options.ids.length > 0
  return {
    ...(explicit ? { only: options.ids } : {}),
    ...(options.kinds.length === 0 ? {} : { kinds: options.kinds }),
    ...(options.tags.length === 0 ? {} : { tags: options.tags }),
    ...(options.owner === undefined ? {} : { owner: options.owner }),
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    status: explicit ? [] : ['active'],
    ...(options.smoke ? { smoke: true } : {}),
    ...(options.smoke ? { smokeBudgetMs: options.smokeBudgetMs } : {}),
  }
}

/** 一行选择器摘要（"为什么是这些"必须能自证）。 */
export function describeSelector(options: RunOptions): string {
  const parts: string[] = []
  if (options.ids.length > 0) parts.push(`ids=[${options.ids.join(', ')}]`)
  if (options.kinds.length > 0) parts.push(`kinds=[${options.kinds.join(', ')}]`)
  if (options.tags.length > 0) parts.push(`tags=[${options.tags.join(', ')}]`)
  if (options.owner !== undefined) parts.push(`owner=${options.owner}`)
  if (options.cost !== undefined) parts.push(`cost≤${options.cost}`)
  if (options.smoke) parts.push(`smoke=on（预算 ${options.smokeBudgetMs}ms）`)
  if (options.changed) parts.push('changed=on')
  if (options.since !== undefined) parts.push(`since=${options.since}`)
  if (options.affectedBy.length > 0) parts.push(`affected-by=[${options.affectedBy.join(', ')}]`)
  if (options.dshVersion !== undefined) parts.push(`dsh-version=${options.dshVersion}`)
  return parts.length === 0 ? '（无——全部 active）' : parts.join(' ')
}

/**
 * 把 CLI 开关翻成策略覆盖。
 *
 * **这是全项目唯一能把闸门打开的地方之一**（另一个是 `/testkit run`）——
 * 两者都是**人**的入口。工具面（模型可调）永远只能收紧，
 * 所以"模型自己给自己开模型权限"这条路是堵死的（见 `src/tools.ts` 的同名注释）。
 */
function policyFrom(options: RunOptions): PolicyOptions {
  const cost: NonNullable<PolicyOptions['cost']> = {}
  if (options.allowModel) cost.allowModel = true
  if (options.allowLowCost) cost.allowLowCost = true
  return { cost }
}

function progressLine(event: RunProgress): string | undefined {
  if (event.phase !== 'case-end') return undefined
  const mark =
    event.verdict === 'passed' ? '✅' : event.verdict === 'skipped' ? '⏭️' : event.verdict === 'failed' ? '❌' : '💥'
  return `${mark} ${event.caseId}`
}

/** `run` 的 JSON 载荷：**摘要**，完整记录在 `artifacts.jsonPath` 指向的 `run.json`。 */
function runJsonPayload(input: {
  summary: RunSummary
  code: ExitCode
  gap: HostGap
  selector: string
  selectorReason: string
  warnings: readonly string[]
  write: Awaited<ReturnType<typeof writeRunArtifacts>>
}): Record<string, unknown> {
  const { summary, code, gap, selector, selectorReason, warnings, write } = input
  const artifacts: RunArtifacts | undefined = write.artifacts
  return {
    command: 'run',
    ok: code === EXIT.OK,
    exitCode: code,
    track: 'headless',
    note: '本命令自带 headless 最小宿主，**不连接真实 DSH**；缺能力的场景如实记为 skipped。完整记录见 artifacts.jsonPath。',
    runId: summary.runId,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    dshVersion: summary.dshVersion,
    platform: summary.platform,
    host: { track: 'headless', provided: gap.provided, missing: gap.missing },
    selector,
    selectorReason,
    selection: summary.selection ?? null,
    policy: summary.policySnapshot ?? null,
    execution: summary.execution ?? null,
    totals: summary.totals,
    cases: summary.cases.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      verdict: item.verdict,
      durationMs: item.durationMs,
      ...(item.error === undefined ? {} : { error: item.error }),
      ...(item.skipReason === undefined ? {} : { skipReason: item.skipReason }),
      ...(item.failureCategory === undefined ? {} : { failureCategory: item.failureCategory }),
      ...(item.usage === undefined ? {} : { usage: item.usage }),
      ...(item.rounds === undefined ? {} : { rounds: item.rounds }),
    })),
    attention: summary.cases
      .filter((item) => item.verdict !== 'passed')
      .map((item) => ({
        id: item.id,
        verdict: item.verdict,
        reason: item.error ?? item.skipReason ?? '存在未通过断言',
      })),
    artifacts: artifacts === undefined ? null : artifacts,
    artifactsError: write.error ?? null,
    junitError: write.junitError ?? null,
    redaction: write.redaction === undefined ? null : { count: write.redaction.count },
    warnings: [...warnings],
  }
}

/**
 * 跑一次（`--watch` 会重复调用它）。
 *
 * 拆出来是因为 watch 模式需要"同一套选择与闸门语义"反复执行——
 * 复制一份"简化版"必然漂移。
 */
async function runOnce(ctx: CliContext, options: RunOptions): Promise<ExitCode> {
  const { dirs } = ctx
  const registry = new CaseRegistry(dirs.casesDir)
  registry.reload()
  const drivers = createDriverRegistry()

  // ---- 增量选择（`--changed` / `--since` / `--affected-by` / `--dsh-version`）----
  const selection = resolveSelectionFromRaw(
    {
      ...(options.changed ? { changed: true } : {}),
      ...(options.since === undefined ? {} : { since: options.since }),
      ...(options.affectedBy.length === 0 ? {} : { affectedBy: options.affectedBy }),
      ...(options.dshVersion === undefined ? {} : { dshVersion: options.dshVersion }),
    },
    {
      registry,
      fixturesDir: dirs.fixturesDir,
      registryDir: dirs.registryDir,
      cwd: ctx.cwd,
    },
  )
  const warnings = [...selection.warnings]

  // ---- 筛选（唯一来源：src/dx）----
  const dx = applyDxFilter(registry.all, dxOptionsFor(options))

  // 增量选择与 DX 筛选**取交集**（`--changed --smoke` = 改动里那些 smoke，不是"smoke"）。
  const incrementalIds = selection.filter?.ids
  const matched: Scenario[] =
    incrementalIds === undefined
      ? [...dx.matched]
      : dx.matched.filter((scenario) => incrementalIds.includes(scenario.id))

  if (matched.length === 0) {
    const reason = [
      `没有选中任何场景（选择器：${describeSelector(options)}）。`,
      `筛选依据：${dx.reason}`,
      ...(selection.selection === undefined ? [] : [`增量判定（${selection.selection.mode}）：${selection.selection.detail}`]),
      '省略选择器只跑 active；draft 场景需显式按 id 点名（--only TK-00xx）。',
      registry.invalidCases.length > 0
        ? `另有 ${registry.invalidCases.length} 个文件无法解析（见 dsh-testkit list）。`
        : '',
    ]
      .filter((text) => text !== '')
      .join('\n')
    if (ctx.json) {
      emitJson(ctx.io, {
        command: 'run',
        ok: false,
        exitCode: EXIT.USAGE,
        track: 'headless',
        selector: describeSelector(options),
        selectorReason: dx.reason,
        selected: 0,
        reason,
        warnings,
      })
    }
    emitError(ctx.io, reason)
    return EXIT.USAGE
  }

  const filter: CaseFilter = { ids: matched.map((scenario) => scenario.id) }

  // ---- 宿主 ----
  const dshVersion = options.dshVersion ?? ctx.env['DSH_VERSION'] ?? 'headless'
  let headless: Awaited<ReturnType<typeof createHeadlessHost>>
  try {
    headless = await createHeadlessHost({
      env: { dshVersion },
      log: (level, message) => {
        if (level === 'warn' || level === 'error') ctx.io.err(`[host:${level}] ${message}\n`)
      },
    })
  } catch (error) {
    return infraError(ctx, `headless 宿主建不起来：${error instanceof Error ? error.message : String(error)}`)
  }

  const gap = describeHostGap(headless.host, drivers)
  const policy = resolvePolicy(policyFrom(options))

  try {
    if (!ctx.json) {
      ctx.io.out(line('dsh-testkit run（headless 轨）'))
      ctx.io.out(line(`  宿主能力：${gap.provided.length === 0 ? '（无）' : gap.provided.join(', ')}`))
      if (gap.missing.length > 0) {
        ctx.io.out(line('  缺口（相关场景会如实记为 skipped，不是失败）：'))
        for (const item of gap.missing) {
          ctx.io.out(line(`    · ${item.capability} ← ${item.kinds.join(' / ')}`))
        }
      }
      ctx.io.out(line(`  选择器：${describeSelector(options)}（命中 ${matched.length} 条）`))
      ctx.io.out(line(`  ${dx.reason}`))
      for (const warning of warnings) ctx.io.out(line(`  ⚠️ ${warning}`))
      if (selection.selection !== undefined) {
        ctx.io.out(line(`  增量判定（${selection.selection.mode}）：${selection.selection.detail}`))
      }
      ctx.io.out(line(''))
    } else {
      // JSON 模式下进度走 stderr：stdout 必须是纯 JSON。
      for (const warning of warnings) ctx.io.err(`⚠️ ${warning}\n`)
      ctx.io.err(`${dx.reason}\n`)
    }

    const progressIo = ctx.json ? ctx.io.err : ctx.io.out
    const summary = await runScenarios({
      registry,
      drivers,
      host: headless.host,
      filter,
      policy,
      fixtures: { fixturesDir: dirs.fixturesDir, dshVersion },
      ...(options.parallel === undefined ? {} : { parallelLimit: options.parallel }),
      ...(selection.selection === undefined ? {} : { selection: selection.selection }),
      onProgress: (event) => {
        const text = progressLine(event)
        if (text !== undefined) progressIo(`${text}\n`)
      },
    })

    const write = await writeRunArtifacts(summary, dirs.runsDir, { redact: options.redact })
    const code = exitCodeForTotals(summary.totals)

    if (ctx.json) {
      emitJson(
        ctx.io,
        runJsonPayload({
          summary,
          code,
          gap,
          selector: describeSelector(options),
          selectorReason: dx.reason,
          warnings,
          write,
        }),
      )
    } else {
      const totals = summary.totals
      ctx.io.out(line(''))
      ctx.io.out(
        line(
          `Run ${summary.runId} — 合计 ${totals.total}：✅ ${totals.passed} · ❌ ${totals.failed} · ⏭️ ${totals.skipped} · 💥 ${totals.errored}`,
        ),
      )
      if (summary.execution !== undefined && summary.execution.parallel !== 'off') {
        ctx.io.out(
          line(
            `  并发：上限 ${summary.execution.limit}（safe ${summary.execution.safe} / exclusive ${summary.execution.exclusive}）`,
          ),
        )
      }
      if (write.redaction !== undefined) {
        ctx.io.out(line(`  已脱敏 ${write.redaction.count} 处（findings 只记位置与类型，不含原文）`))
      }
      const attention = summary.cases.filter((item) => item.verdict !== 'passed')
      if (attention.length > 0) {
        ctx.io.out(line('  需要关注：'))
        for (const item of attention) {
          const why = item.error ?? item.skipReason ?? '存在未通过断言'
          const category =
            item.failureCategory === undefined ? '' : `［${FAILURE_CATEGORY_LABEL[item.failureCategory]}］`
          const mark = item.verdict === 'skipped' ? '⏭️' : item.verdict === 'failed' ? '❌' : '💥'
          ctx.io.out(line(`    ${mark} ${item.id} ${item.title} — ${why}${category}`))
        }
      }
      if (write.artifacts !== undefined) {
        ctx.io.out(line(`  报告：${write.artifacts.markdownPath}`))
        if (write.artifacts.junitPath !== undefined) ctx.io.out(line(`  JUnit：${write.artifacts.junitPath}`))
      } else {
        ctx.io.out(line(`  ⚠️ 报告写入失败：${write.error ?? '未知原因'}`))
      }
      if (write.junitError !== undefined) ctx.io.out(line(`  ⚠️ junit.xml 写入失败：${write.junitError}`))
    }

    // 报告写不出去 = 这件事的**产物缺失**，属于基础设施错误（退出码 3）。
    // 注意它不吞掉用例失败：两条信息都会打印，只是退出码取更"根本"的那个。
    if (write.error !== undefined) {
      emitError(ctx.io, `报告未能落盘：${write.error}`)
      return EXIT.INFRA
    }
    return code
  } finally {
    try {
      await headless.dispose()
    } catch (error) {
      ctx.io.err(`[host] dispose 失败：${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

/** `--watch`：首次跑完之后监听场景目录，变化即重跑；Ctrl-C 后返回**最后一次**的退出码。 */
async function runWatch(ctx: CliContext, options: RunOptions): Promise<ExitCode> {
  let last = await runOnce(ctx, options)
  const onChange = async (): Promise<void> => {
    ctx.io.out('\n— 检测到场景变化，重新运行 —\n')
    try {
      last = await runOnce(ctx, options)
    } catch (error) {
      emitError(ctx.io, `重跑失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // 监听实现来自 `src/dx`（与工具面 / 命令面同一份防抖语义），不在这里再写一套。
  const watcher = watchCases(ctx.dirs.casesDir, () => void onChange(), { debounceMs: 200 })
  ctx.io.out(`监听中：${ctx.dirs.casesDir}（Ctrl-C 退出；退出码取最后一次运行）\n`)
  return await new Promise<ExitCode>((resolve) => {
    process.once('SIGINT', () => {
      watcher.close()
      resolve(last)
    })
  })
}

function infraError(ctx: CliContext, message: string): ExitCode {
  if (ctx.json) {
    emitJson(ctx.io, { command: 'run', ok: false, exitCode: EXIT.INFRA, error: message })
  }
  emitError(ctx.io, message)
  return EXIT.INFRA
}

/** 入口：`dsh-testkit run ...`。 */
export async function runCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const built = runOptionsFrom(parsed)
  if (!built.ok) {
    if (ctx.json) {
      emitJson(ctx.io, { command: 'run', ok: false, exitCode: EXIT.USAGE, error: built.error })
    }
    emitError(ctx.io, built.error)
    return EXIT.USAGE
  }

  const options = built.options
  if (!isDirectory(ctx.dirs.casesDir)) {
    return infraError(
      ctx,
      `场景目录不存在：${ctx.dirs.casesDir}（用 --cases <dir> 或 DSH_TESTKIT_CASES_DIR 指定）`,
    )
  }

  return options.watch ? await runWatch(ctx, options) : await runOnce(ctx, options)
}
