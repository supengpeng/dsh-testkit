/**
 * `dsh-testkit` 独立 CLI 的入口。
 *
 * ## 形态翻转（本仓的一个决定被改掉了）
 *
 * 在加这个 CLI 之前，本包**刻意没有 `bin`**：命令行能力由 `/testkit` 人类命令、
 * `testkit_*` 工具与导出轨承担，理由是"先证明导出轨能在真实 CI 跑通，再决定 CLI 形状"。
 * 那条前置条件已满足（导出轨进 gate、CI 轨跑 26 条），于是本轮把它做出来。
 * `tests/self-bootstrap.test.mjs` 里"无 bin"的断言由 Lead 同步翻转——
 * **文档与断言跟着实现走，而不是反过来**。
 *
 * ## 契约
 *
 * `main(argv, io?)` **返回退出码，绝不自己 `process.exit`**。
 * 于是：进程内可以直接断言"这条命令会怎么退出"，而不用去解析子进程；
 * 真正退出交给 `bin/dsh-testkit.mjs`（薄入口，它才知道自己是进程）。
 *
 * ## 与前两个入口的关系
 *
 * | 入口 | 谁在用 | 宿主 | 能否放权 |
 * |---|---|---|---|
 * | `testkit_*` 工具 | 模型 | 真实 DSH | **否**（只能收紧） |
 * | `/testkit` 命令 | 人（在 DSH 里） | 真实 DSH | 能 |
 * | **本 CLI** | 人 / CI | **headless 最小宿主** | 能 |
 *
 * 三者共用同一批模块（registry / runner / policy / report / selection / fixtures /
 * registry / touchstone），**没有第二套引擎**——CLI 只是第三个"入口装配"。
 */

import { all, has, parseOptions, type OptionSpec, type ParsedOptions } from './args.js'
import {
  coverageCommand,
  COVERAGE_OPTIONS,
  SEARCH_OPTIONS,
  searchCommand,
  traceCommand,
  TRACE_OPTIONS,
  trendCommand,
  TREND_OPTIONS,
} from './commands/insight.js'
import {
  EXPAND_OPTIONS,
  expandCommand,
  FIXTURES_OPTIONS,
  fixturesCommand,
  LIST_OPTIONS,
  listCommand,
  REGISTRY_OPTIONS,
  registryCommand,
  REPORT_OPTIONS,
  reportCommand,
  VERSION_OPTIONS,
  versionCommand,
} from './commands/inspect.js'
import { runCommand, RUN_OPTIONS } from './commands/run.js'
import { EXPORT_OPTIONS, exportCommand, IMPORT_OPTIONS, importCommand } from './commands/transfer.js'
import { resolveCliDirs, type CliContext, type DirOverrides } from './context.js'
import { EXIT, EXIT_DOC, type ExitCode } from './exit.js'
import { createDefaultIo, emitError, emitJson, line, type CliIo } from './io.js'

const BINARY = 'dsh-testkit'

interface CommandSpec {
  name: string
  summary: string
  /** 位置参数形态（help 用；空串 = 无）。 */
  args?: string
  options: readonly OptionSpec[]
  /** 相对 `lib/cli/` 的模块代号（错误信息用）。 */
  available: boolean
}

/** `help` 自己的选项（`--json` 让它也能被脚本消费）。 */
const HELP_OPTIONS: readonly OptionSpec[] = [
  { name: 'json', kind: 'boolean', help: '以 JSON 输出命令与退出码表' },
]

const COMMANDS: readonly CommandSpec[] = [
  { name: 'run', summary: '跑场景（自带 headless 最小宿主，不连接真实 DSH）', args: '[ids...]', options: RUN_OPTIONS, available: true },
  { name: 'list', summary: '列出场景（可按 kind / tag / owner / cost / status 过滤）', options: LIST_OPTIONS, available: true },
  { name: 'report', summary: '查看某次运行的 report.md（缺省取最近一次）', args: '[runId]', options: REPORT_OPTIONS, available: true },
  { name: 'expand', summary: '把 `use:` 步骤展开成 flat 步骤', args: '<场景 ID>', options: EXPAND_OPTIONS, available: true },
  { name: 'export', summary: '导出 CI 用例（node-test）或 bug_report（touchstone）', options: EXPORT_OPTIONS, available: true },
  { name: 'import', summary: '把 touchstone case.md 转成场景草稿并登记提案（不直接进 cases/）', args: '<case.md>', options: IMPORT_OPTIONS, available: true },
  { name: 'trace', summary: '步骤级 trace（json / chrome / otel / timeline）', args: '[runId]', options: TRACE_OPTIONS, available: false },
  { name: 'trend', summary: '历史趋势（按 kind / tag / owner / dshVersion 维度）', options: TREND_OPTIONS, available: false },
  { name: 'coverage', summary: '覆盖矩阵与缺口报告', options: COVERAGE_OPTIONS, available: false },
  { name: 'search', summary: '场景全文搜索（id / 标题 / 标签 / 步骤文本）', args: '<关键词>', options: SEARCH_OPTIONS, available: false },
  { name: 'registry', summary: '列出 step 片段注册表', options: REGISTRY_OPTIONS, available: true },
  { name: 'fixtures', summary: '列出夹具与其 DSH 版本绑定', options: FIXTURES_OPTIONS, available: true },
  { name: 'version', summary: '版本与环境（含"这是 headless 轨"的声明）', options: VERSION_OPTIONS, available: true },
  { name: 'help', summary: '这份说明（`help <子命令>` 看单个命令的选项）', args: '[子命令]', options: HELP_OPTIONS, available: true },
]

const COMMAND_BY_NAME = new Map(COMMANDS.map((spec) => [spec.name, spec]))

/** 渲染单个命令的用法。 */
function renderCommandHelp(spec: CommandSpec): string[] {
  const head = `  ${BINARY} ${spec.name}${spec.args === undefined ? '' : ` ${spec.args}`}`
  const lines = [`${head}`, `      ${spec.summary}`]
  if (spec.options.length === 0) return lines
  const width = Math.max(
    ...spec.options.map((option) => `--${option.name}${option.placeholder === undefined ? '' : ` ${option.placeholder}`}`.length),
  )
  for (const option of spec.options) {
    const flag = `--${option.name}${option.placeholder === undefined ? '' : ` ${option.placeholder}`}`
    const alias = option.alias === undefined ? '' : ` (-${option.alias})`
    lines.push(`      ${flag.padEnd(width)}${alias}  ${option.help ?? ''}`.trimEnd())
  }
  return lines
}

/** 总帮助。 */
export function renderHelp(command?: string): string {
  if (command !== undefined && command.trim() !== '') {
    const spec = COMMAND_BY_NAME.get(command.trim())
    if (spec === undefined) {
      return `未知子命令：${command}\n\n${renderHelp()}`
    }
    return [`用法：`, ...renderCommandHelp(spec)].join('\n')
  }

  const lines: string[] = []
  lines.push(`${BINARY} —— DSH 测试场景的命令行入口（headless 轨）`)
  lines.push('')
  lines.push(`用法：${BINARY} <子命令> [选项]`)
  lines.push('')
  lines.push('子命令：')
  for (const spec of COMMANDS) {
    const tail = spec.available ? '' : '（能力未就绪时明确报错，不伪造输出）'
    lines.push(`  ${spec.name.padEnd(9)}${spec.summary}${tail}`)
  }
  lines.push('')
  lines.push('退出码（**冻结**，改动等于改对外契约）：')
  for (const item of EXIT_DOC) lines.push(`  ${String(item.code).padEnd(3)}${item.meaning}`)
  lines.push('')
  lines.push('宿主（**必须知道的边界**）：')
  lines.push(`  ${BINARY} run 用的是 createHeadlessHost()——一个自带的最小宿主，**不连接真实 DSH**。`)
  lines.push('  缺 subprocess / fs / sessions / goals / compaction 等能力的场景会被**如实记为 skipped**')
  lines.push('  （原因写进 skipReason），不是失败。每次 run 的头部都会打印"具备什么 / 缺什么、影响哪些 kind"。')
  lines.push('  想要真实宿主：用 DSH 里的 `/testkit run`——那条路连接真实 profile。')
  lines.push('')
  lines.push('放权：')
  lines.push('  --allow-model / --allow-low-cost 会**真的放行** high / low 档。CLI 与 /testkit run 同属')
  lines.push('  「人的入口」；工具面（模型可调）只能收紧、不能提权，所以模型无法自己开闸。')
  lines.push('')
  lines.push('目录：--cases <dir> / --out <dir>；环境变量 DSH_TESTKIT_CASES_DIR / DSH_TESTKIT_RUNS_DIR。')
  lines.push(`单个命令的选项：${BINARY} help <子命令>`)
  return lines.join('\n')
}

function optionsFor(command: string): readonly OptionSpec[] {
  return COMMAND_BY_NAME.get(command)?.options ?? []
}

/**
 * 目录覆盖：**按子命令语义**取 `--out`，不能一刀切。
 *
 * `run` / `report` 的 `--out` 是"运行产物根"；但 `export --out` 是"导出目标目录"
 * ——若把它也映射成 runsDir，`export --format touchstone --out bug_reports`
 * 就会去 `bug_reports/` 里找运行记录（真踩过的坑，测试里钉住了这条）。
 */
function dirOverridesFor(command: string, parsed: ParsedOptions): DirOverrides {
  const casesDir = all(parsed, 'cases')[0]
  const out = all(parsed, 'out')[0]
  const registryDir = all(parsed, 'registry')[0]
  const fixturesDir = all(parsed, 'fixtures')[0]
  const usesOutAsRunsDir = command === 'run' || command === 'report'
  return {
    ...(casesDir === undefined ? {} : { casesDir }),
    ...(usesOutAsRunsDir && out !== undefined ? { runsDir: out } : {}),
    ...(registryDir === undefined ? {} : { registryDir }),
    ...(fixturesDir === undefined ? {} : { fixturesDir }),
  }
}

/** 组装上下文（`--json` 一旦出现在任一位置都算）。 */
function makeContext(io: CliIo, json: boolean, command: string, parsed: ParsedOptions): CliContext {
  const cwd = io.cwd ?? process.cwd()
  return {
    io,
    cwd,
    dirs: resolveCliDirs(cwd, dirOverridesFor(command, parsed)),
    json,
    env: process.env,
  }
}

/**
 * CLI 主入口。
 *
 * @returns 退出码（`0/1/2/3`，见 `src/cli/exit.ts` 的冻结表）。
 */
export async function main(argv: readonly string[], io?: CliIo): Promise<number> {
  const effectiveIo = io ?? createDefaultIo()
  const args = [...argv]

  // ---- 先摘出全局开关与子命令名 ----
  let index = 0
  let json = false
  while (index < args.length) {
    const token = args[index]
    if (token === '--json') {
      json = true
      index += 1
      continue
    }
    break
  }

  const command = args[index]
  const rest = args.slice(index + 1)

  if (command === undefined) {
    effectiveIo.out(line(renderHelp()))
    return EXIT.OK
  }
  if (command === '--help' || command === '-h') {
    effectiveIo.out(line(renderHelp(rest[0])))
    return EXIT.OK
  }
  if (command === '--version' || command === '-V') {
    const parsed = parseOptions(rest, VERSION_OPTIONS)
    const ctx = makeContext(effectiveIo, json, 'version', parsed)
    return await versionCommand(ctx, parsed)
  }
  if (command.startsWith('-')) {
    emitError(effectiveIo, `未知选项：${command}（子命令要放在最前面，如 \`${BINARY} list --json\`）`)
    return EXIT.USAGE
  }
  if (!COMMAND_BY_NAME.has(command)) {
    emitError(
      effectiveIo,
      `未知子命令：${command}（可选：${COMMANDS.map((spec) => spec.name).join(' / ')}）`,
    )
    return EXIT.USAGE
  }

  const parsed = parseOptions(rest, optionsFor(command))
  if (has(parsed, 'json')) json = true

  // 用法错误（未知选项 / 缺值）在**任何**子命令之前拦下：静默忽略拼错的选项
  // 是 CLI 最危险的失败形态（人以为开关生效了）。
  if (parsed.errors.length > 0) {
    if (json) {
      emitJson(effectiveIo, {
        command,
        ok: false,
        exitCode: EXIT.USAGE,
        errors: parsed.errors,
      })
    }
    for (const error of parsed.errors) emitError(effectiveIo, error)
    emitError(effectiveIo, `用法：${BINARY} help ${command}`)
    return EXIT.USAGE
  }

  const ctx = makeContext(effectiveIo, json, command, parsed)

  try {
    return await dispatch(ctx, command, parsed)
  } catch (error) {
    // **绝不把裸栈甩给用户**：未预期异常一律归到"基础设施错误"，并带上原文。
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    if (json) {
      emitJson(effectiveIo, { command, ok: false, exitCode: EXIT.INFRA, error: message })
    }
    emitError(effectiveIo, `未预期的错误（已按基础设施错误处理，退出码 3）：${message}`)
    return EXIT.INFRA
  }
}

async function dispatch(ctx: CliContext, command: string, parsed: ParsedOptions): Promise<ExitCode> {
  switch (command) {
    case 'run':
      return await runCommand(ctx, parsed)
    case 'list':
      return await listCommand(ctx, parsed)
    case 'report':
      return await reportCommand(ctx, parsed)
    case 'expand':
      return await expandCommand(ctx, parsed)
    case 'export':
      return await exportCommand(ctx, parsed)
    case 'import':
      return await importCommand(ctx, parsed)
    case 'registry':
      return await registryCommand(ctx, parsed)
    case 'fixtures':
      return await fixturesCommand(ctx, parsed)
    case 'version':
      return await versionCommand(ctx, parsed)
    case 'trace':
      return await traceCommand(ctx, parsed)
    case 'trend':
      return await trendCommand(ctx, parsed)
    case 'coverage':
      return await coverageCommand(ctx, parsed)
    case 'search':
      return await searchCommand(ctx, parsed)
    case 'help': {
      const target = parsed.positionals[0]
      const text = renderHelp(target)
      if (ctx.json) {
        emitJson(ctx.io, {
          command: 'help',
          ok: true,
          exitCode: EXIT.OK,
          commands: COMMANDS.map((spec) => ({
            name: spec.name,
            summary: spec.summary,
            args: spec.args ?? null,
            available: spec.available,
          })),
          exitCodes: EXIT_DOC,
          text,
        })
        return EXIT.OK
      }
      ctx.io.out(line(text))
      return EXIT.OK
    }
    default:
      emitError(ctx.io, `未知子命令：${command}`)
      return EXIT.USAGE
  }
}

export { EXIT, EXIT_DOC } from './exit.js'
export type { CliIo } from './io.js'
export { renderHelp as helpText }
