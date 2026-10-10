/**
 * 只读类子命令：`list` / `report` / `expand` / `registry` / `fixtures` / `version` / `help`。
 *
 * 这些命令**不创建宿主**（不需要跑场景），因此也几乎不会以"基础设施错误"退出：
 * 它们读的是场景数据、注册表、夹具与历史产物。
 *
 * 退出码约定（与 `src/cli/exit.ts` 的冻结表一致，这里只写本文件的用法）：
 *   · `list` / `report` / `registry` / `fixtures` / `version` / `help`：成功即 `0`；
 *   · 目录 / 运行记录不存在 → `2`（"没有可展示的东西"是**用法层面**的事实，不是崩溃）；
 *   · 数据本身有问题（场景展开失败、注册表有问题、夹具无效）→ `1`
 *     —— 这些是"资产坏了"，属于失败而不是基础设施。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { CaseRegistry } from '../../cases/registry.js'
import { SCENARIO_KINDS, type CostClass, type ScenarioKind } from '../../cases/types.js'
import { applyDxFilter } from '../../dx/index.js'
import { loadFixtures } from '../../fixtures/load.js'
import { expandScenario, loadRegistry } from '../../registry/index.js'
import { all, has, oneTrimmed, type OptionSpec, type ParsedOptions } from '../args.js'
import { packageName, packageVersion, type CliContext } from '../context.js'
import { EXIT, type ExitCode } from '../exit.js'
import { emitError, emitJson, line } from '../io.js'
import { isDirectory } from './run.js'

/** `report` 的缺省截断长度（`--full` 关闭）。 */
const REPORT_PREVIEW_CHARS = 12_000

export const LIST_OPTIONS: readonly OptionSpec[] = [
  { name: 'kind', alias: 'k', kind: 'repeat', placeholder: '<k>', help: '按 kind 过滤（可多次）' },
  { name: 'tag', alias: 't', kind: 'repeat', placeholder: '<t>', help: '按标签过滤（可多次，任一命中）' },
  { name: 'owner', kind: 'value', placeholder: '<o>', help: '按 owner 过滤' },
  { name: 'cost', kind: 'value', placeholder: '<class>', help: '允许的**最高**成本档（含）none / low / high（不是"只看这一档"）' },
  { name: 'status', kind: 'value', placeholder: '<s>', help: '按状态过滤（active / draft / retired）' },
  { name: 'cases', kind: 'value', placeholder: '<dir>', help: '场景目录（缺省 = 包内 cases/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const REPORT_OPTIONS: readonly OptionSpec[] = [
  { name: 'full', kind: 'boolean', help: '输出全文（缺省截断到 12000 字符）' },
  { name: 'out', alias: 'o', kind: 'value', placeholder: '<dir>', help: '运行产物根目录（runs/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出（含 markdown 原文）' },
]

export const EXPAND_OPTIONS: readonly OptionSpec[] = [
  { name: 'cases', kind: 'value', placeholder: '<dir>', help: '场景目录（缺省 = 包内 cases/）' },
  { name: 'registry', kind: 'value', placeholder: '<dir>', help: 'step 片段注册表根（缺省 = 包内 registry/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const REGISTRY_OPTIONS: readonly OptionSpec[] = [
  { name: 'registry', kind: 'value', placeholder: '<dir>', help: 'step 片段注册表根（缺省 = 包内 registry/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const FIXTURES_OPTIONS: readonly OptionSpec[] = [
  { name: 'fixtures', kind: 'value', placeholder: '<dir>', help: '夹具根（缺省 = 包内 fixtures/）' },
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

export const VERSION_OPTIONS: readonly OptionSpec[] = [
  { name: 'json', kind: 'boolean', help: '以 JSON 输出' },
]

/** 供 `expand` 的 JSON 输出用：把步骤整理成可序列化的形状。 */
function stepPayload(step: object, index: number): Record<string, unknown> {
  const record = step as {
    name?: unknown
    act?: unknown
    expect?: unknown
    cleanup?: unknown
  }
  return {
    index: index + 1,
    name: typeof record.name === 'string' ? record.name : `step ${index + 1}`,
    ...(record.act === undefined ? {} : { act: record.act }),
    ...(record.expect === undefined ? {} : { expect: record.expect }),
    ...(record.cleanup === undefined ? {} : { cleanup: record.cleanup }),
  }
}

/* ------------------------------------------------------------------ list -- */

export async function listCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  if (!isDirectory(ctx.dirs.casesDir)) {
    const message = `场景目录不存在：${ctx.dirs.casesDir}（用 --cases <dir> 或 DSH_TESTKIT_CASES_DIR 指定）`
    if (ctx.json) emitJson(ctx.io, { command: 'list', ok: false, exitCode: EXIT.USAGE, error: message })
    emitError(ctx.io, message)
    return EXIT.USAGE
  }

  const registry = new CaseRegistry(ctx.dirs.casesDir)
  registry.reload()

  const kinds = all(parsed, 'kind')
  const tags = all(parsed, 'tag')
  const owner = oneTrimmed(parsed, 'owner')
  const cost = oneTrimmed(parsed, 'cost')
  const status = oneTrimmed(parsed, 'status')

  // 未知 kind / cost 一律报错（退出码 2）：静默返回 0 条会让人以为"这个类型没有场景"。
  const badKinds = kinds.filter((kind) => !(SCENARIO_KINDS as readonly string[]).includes(kind))
  if (badKinds.length > 0) {
    return usage(
      ctx,
      'list',
      `未知 kind：${badKinds.join(', ')}（可选：${SCENARIO_KINDS.join(', ')}）`,
    )
  }
  if (cost !== undefined && !(COST_VALUES as readonly string[]).includes(cost)) {
    return usage(ctx, 'list', `--cost 只接受 ${COST_VALUES.join(' / ')}（上限含），收到 ${cost}`)
  }

  // 筛选语义与 run 同源（`src/dx` 的 applyDxFilter）：`--cost` 是**上限（含）**。
  // `list` 的默认 status 是**全部**（列清单就该看全，包括 draft）——与 run 不同。
  const filtered = applyDxFilter(registry.all, {
    ...(kinds.length === 0 ? {} : { kinds: kinds as ScenarioKind[] }),
    ...(tags.length === 0 ? {} : { tags }),
    ...(owner === undefined ? {} : { owner }),
    ...(cost === undefined ? {} : { cost: cost as CostClass }),
    status: status === undefined ? [] : [status],
  })
  const scenarios = [...filtered.matched]

  const counts = scenarios.reduce<Record<string, number>>((acc, scenario) => {
    acc[scenario.kind] = (acc[scenario.kind] ?? 0) + 1
    return acc
  }, {})

  if (ctx.json) {
    emitJson(ctx.io, {
      command: 'list',
      ok: true,
      exitCode: EXIT.OK,
      casesDir: registry.dir,
      total: scenarios.length,
      totalAll: registry.all.length,
      countsByKind: counts,
      filterReason: filtered.reason,
      scenarios: scenarios.map((scenario) => ({
        id: scenario.id,
        kind: scenario.kind,
        status: scenario.status ?? 'active',
        title: scenario.title,
        severity: scenario.severity ?? 'medium',
        ...(scenario.tags === undefined ? {} : { tags: scenario.tags }),
        ...(scenario.owner === undefined ? {} : { owner: scenario.owner }),
        ...(scenario.cost === undefined ? {} : { cost: scenario.cost }),
        issue: scenario.source.issue ?? null,
      })),
      invalid: registry.invalidCases.map((item) => ({
        name: item.name,
        error: item.error ?? item.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      })),
      problems: registry.problems,
    })
    return EXIT.OK
  }

  ctx.io.out(line(`场景目录：${registry.dir}`))
  ctx.io.out(line(`共 ${scenarios.length} 条（全部 ${registry.all.length} 条）`))
  const summary = Object.entries(counts)
    .map(([kind, count]) => `${kind}=${count}`)
    .join(' ')
  if (summary !== '') ctx.io.out(line(`类型分布：${summary}`))
  ctx.io.out(line(''))
  for (const scenario of scenarios) {
    const statusMark = (scenario.status ?? 'active') === 'active' ? '' : ` [${scenario.status}]`
    const ownerMark = scenario.owner === undefined ? '' : ` @${scenario.owner}`
    ctx.io.out(line(`  ${scenario.id} (${scenario.kind})${statusMark}${ownerMark} ${scenario.title}`))
  }
  if (registry.invalidCases.length > 0) {
    ctx.io.out(line(''))
    ctx.io.out(line(`⚠️ ${registry.invalidCases.length} 个文件无法解析：`))
    for (const item of registry.invalidCases.slice(0, 10)) {
      ctx.io.out(
        line(`  ${item.name}：${item.error ?? item.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`),
      )
    }
  }
  if (registry.problems.length > 0) {
    ctx.io.out(line(''))
    ctx.io.out(line('索引问题：'))
    for (const problem of registry.problems) {
      ctx.io.out(line(`  ${problem.path || 'index.yaml'}：${problem.message}`))
    }
  }
  return EXIT.OK
}

/* ---------------------------------------------------------------- report -- */

export async function reportCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const runsDir = ctx.dirs.runsDir
  const explicit = parsed.positionals[0]

  let runId = explicit
  if (runId === undefined || runId.trim() === '') {
    try {
      const entries = (await readdir(runsDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      runId = entries[entries.length - 1]
    } catch {
      runId = undefined
    }
    if (runId === undefined) {
      const message = `还没有任何运行记录（目录：${runsDir}）。先跑一次：dsh-testkit run --out <dir>`
      if (ctx.json) emitJson(ctx.io, { command: 'report', ok: false, exitCode: EXIT.USAGE, error: message })
      emitError(ctx.io, message)
      return EXIT.USAGE
    }
  }

  const path = join(runsDir, runId, 'report.md')
  let markdown: string
  try {
    markdown = await readFile(path, 'utf8')
  } catch (error) {
    const message = `读不到运行记录 ${runId}：${error instanceof Error ? error.message : String(error)}`
    if (ctx.json) {
      emitJson(ctx.io, { command: 'report', ok: false, exitCode: EXIT.USAGE, runId, path, error: message })
    }
    emitError(ctx.io, message)
    return EXIT.USAGE
  }

  const full = has(parsed, 'full')
  const truncated = !full && markdown.length > REPORT_PREVIEW_CHARS
  const body = truncated ? `${markdown.slice(0, REPORT_PREVIEW_CHARS)}\n…（已截断，用 --full 取全文）\n` : markdown

  if (ctx.json) {
    emitJson(ctx.io, {
      command: 'report',
      ok: true,
      exitCode: EXIT.OK,
      runId,
      path,
      truncated,
      chars: markdown.length,
      markdown: body,
    })
    return EXIT.OK
  }

  ctx.io.out(line(`运行记录：${runId}`))
  ctx.io.out(line(`报告路径：${path}`))
  ctx.io.out(line(''))
  ctx.io.out(body)
  return EXIT.OK
}

/* ---------------------------------------------------------------- expand -- */

export async function expandCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const id = parsed.positionals[0]
  if (id === undefined || id.trim() === '') {
    return usage(ctx, 'expand', '用法：dsh-testkit expand <场景 ID>')
  }
  if (!isDirectory(ctx.dirs.casesDir)) {
    return infra(ctx, 'expand', `场景目录不存在：${ctx.dirs.casesDir}`)
  }

  const registry = new CaseRegistry(ctx.dirs.casesDir)
  registry.reload()
  const scenario = registry.get(id)
  if (scenario === undefined) {
    return usage(ctx, 'expand', `找不到场景 ${id}（用 dsh-testkit list 看有哪些）`)
  }

  const loaded = loadRegistry({ registryDir: ctx.dirs.registryDir })
  const result = expandScenario(scenario, { registry: loaded })

  if (!result.ok) {
    const problems = result.problems
    if (ctx.json) {
      emitJson(ctx.io, { command: 'expand', ok: false, exitCode: EXIT.FAILED, id, problems })
    }
    emitError(ctx.io, `展开失败（${problems.length} 个问题）：`)
    for (const problem of problems) emitError(ctx.io, `  - ${problem}`)
    return EXIT.FAILED
  }

  if (ctx.json) {
    emitJson(ctx.io, {
      command: 'expand',
      ok: true,
      exitCode: EXIT.OK,
      id,
      stepCount: result.flat.length,
      steps: result.flat.map((step, index) => stepPayload(step as object, index)),
    })
    return EXIT.OK
  }

  ctx.io.out(line(`场景 ${id}：${result.flat.length} 步（已展开为 flat，无 use/with 残留）`))
  result.flat.forEach((step, index) => {
    const payload = stepPayload(step as object, index)
    ctx.io.out(line(`  ${String(payload['index'])}. ${String(payload['name'])}`))
    if (payload['act'] !== undefined) ctx.io.out(line(`     act: ${JSON.stringify(payload['act'])}`))
    for (const assertion of (payload['expect'] as readonly unknown[] | undefined) ?? []) {
      ctx.io.out(line(`     expect: ${JSON.stringify(assertion)}`))
    }
  })
  return EXIT.OK
}

/* -------------------------------------------------------------- registry -- */

export async function registryCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  // 目录都不存在时不该报"0 份片段、一切正常"：用户要的是注册表，缺的是**基础设施**。
  if (!isDirectory(ctx.dirs.registryDir)) {
    return infra(
      ctx,
      'registry',
      `step 片段注册表目录不存在：${ctx.dirs.registryDir}（用 --registry <dir> 或 DSH_TESTKIT_REGISTRY_DIR 指定）`,
    )
  }

  const loaded = loadRegistry({ registryDir: ctx.dirs.registryDir })
  const fragments = [...loaded.steps.values()].sort((a, b) => a.name.localeCompare(b.name))
  const code: ExitCode = loaded.problems.length > 0 ? EXIT.FAILED : EXIT.OK

  if (ctx.json) {
    emitJson(ctx.io, {
      command: 'registry',
      ok: code === EXIT.OK,
      exitCode: code,
      registryDir: ctx.dirs.registryDir,
      version: loaded.version,
      count: fragments.length,
      steps: fragments.map((fragment) => ({
        name: fragment.name,
        version: fragment.version,
        cost: fragment.cost ?? null,
        description: fragment.description,
        dependencies: fragment.dependencies,
      })),
      problems: loaded.problems,
    })
    return code
  }

  ctx.io.out(line(`step 片段注册表：${fragments.length} 份（版本 ${loaded.version}）`))
  for (const fragment of fragments) {
    ctx.io.out(line(`  ${fragment.name}@${fragment.version}（cost=${fragment.cost ?? '—'}）${fragment.description}`))
  }
  if (loaded.problems.length > 0) {
    ctx.io.out(line(''))
    ctx.io.out(line(`⚠️ ${loaded.problems.length} 个问题：`))
    for (const problem of loaded.problems) ctx.io.out(line(`  - ${problem}`))
  }
  return code
}

/* -------------------------------------------------------------- fixtures -- */

export async function fixturesCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const loaded = loadFixtures(ctx.dirs.fixturesDir)
  const code: ExitCode = loaded.invalid.length > 0 ? EXIT.FAILED : EXIT.OK

  if (ctx.json) {
    emitJson(ctx.io, {
      command: 'fixtures',
      ok: code === EXIT.OK,
      exitCode: code,
      dir: loaded.dir,
      total: loaded.fixtures.length + loaded.invalid.length,
      valid: loaded.fixtures.length,
      invalid: loaded.invalid.map((item) => ({
        name: item.name,
        error: item.error ?? item.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
      })),
      fixtures: loaded.fixtures.map((item) => ({
        name: item.name,
        source: item.spec?.source ?? null,
        dshVersion: item.spec?.dshVersion ?? null,
        file: item.file,
      })),
    })
    return code
  }

  ctx.io.out(line(`夹具目录：${loaded.dir}`))
  ctx.io.out(line(`共 ${loaded.fixtures.length + loaded.invalid.length} 份，无效 ${loaded.invalid.length} 份`))
  ctx.io.out(line(''))
  for (const item of loaded.fixtures) {
    ctx.io.out(
      line(`  ${item.name}（source=${item.spec?.source ?? '—'} dsh_version=${item.spec?.dshVersion ?? '—'}）`),
    )
  }
  for (const bad of loaded.invalid) {
    const why =
      bad.error ?? bad.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    ctx.io.out(line(`  ✗ ${bad.name}：${why}`))
  }
  return code
}

/* --------------------------------------------------------------- version -- */

export async function versionCommand(ctx: CliContext, parsed: ParsedOptions): Promise<ExitCode> {
  const name = packageName()
  const version = packageVersion()
  if (ctx.json || has(parsed, 'json')) {
    emitJson(ctx.io, {
      command: 'version',
      ok: true,
      exitCode: EXIT.OK,
      name,
      version,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      track: 'headless',
      // 诚实标注：这个 CLI 不连接真实 DSH。
      note: 'run 自带 headless 最小宿主；需要 subprocess / fs / sessions 等能力的场景会如实记为 skipped。',
      scenarioKinds: SCENARIO_KINDS,
    })
    return EXIT.OK
  }
  ctx.io.out(line(`${name} ${version}`))
  ctx.io.out(line(`node ${process.version} · ${process.platform}/${process.arch}`))
  ctx.io.out(line('宿主轨：headless（run 自带最小宿主，不连接真实 DSH）'))
  return EXIT.OK
}

/* ------------------------------------------------------------------ 工具 -- */

function usage(ctx: CliContext, command: string, message: string): ExitCode {
  if (ctx.json) emitJson(ctx.io, { command, ok: false, exitCode: EXIT.USAGE, error: message })
  emitError(ctx.io, message)
  return EXIT.USAGE
}

function infra(ctx: CliContext, command: string, message: string): ExitCode {
  if (ctx.json) emitJson(ctx.io, { command, ok: false, exitCode: EXIT.INFRA, error: message })
  emitError(ctx.io, message)
  return EXIT.INFRA
}

export { usage as usageExit, infra as infraExit }

/** 成本档位的合法值（`list` 的 `--cost` 校验用；导出给测试与 help）。 */
export const COST_VALUES: readonly CostClass[] = ['none', 'low', 'high']
