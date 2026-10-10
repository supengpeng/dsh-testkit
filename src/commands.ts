/**
 * 人类命令面：`/testkit <子命令>`。
 *
 * 与工具面的区别：命令走 UI、不经过模型，适合"我自己要看一眼"的场景。
 *
 * **提炼闸门的落地权只在这里。** 工具面（模型可调）只能提交提案；
 * `issue open`（决定要不要提炼）与 `issue approve|reject`（决定要不要落地）
 * 都是人类命令——模型够不到，闸门才成立。
 */

import { FAILURE_CATEGORY_LABEL } from './analysis/classify.js'
import { probableCauses, renderCauses } from './analysis/causes.js'
import { packageRoot } from './config.js'
import type { CaseRegistry } from './cases/registry.js'
import type { ScenarioKind } from './cases/types.js'
import { applyDxFilter, type DxFilterOptions } from './dx/select.js'
import { resolvePolicy, type PolicyOptions } from './executor/policy.js'
import { buildCoverage, renderCoverage } from './insight/coverage.js'
import { renderSearchResult, searchScenarios } from './insight/search.js'
import { buildTrend, collectRuns, renderTrend } from './insight/trend.js'
import type { CommandDefinition, CommandResultLike, DriverRegistry, HostFacade } from './kinds/types.js'
import type { PipelineStore } from './pipeline/index.js'
import { expandScenario, loadRegistry } from './registry/index.js'
import { writeRunArtifacts } from './report/json.js'
import { runScenarios } from './runtime/runner.js'
import type { RunSummary } from './runtime/runlog.js'
import { resolveSelection, type SelectionArgs } from './surface/selection-args.js'
import { latestRunJson } from './surface/runs.js'
import {
  renderChromeTrace,
  renderOtelSpans,
  renderTimeline,
  renderTraceJson,
} from './trace/index.js'
import { exportBugReports, parseCaseMd } from './touchstone/index.js'
import { join } from 'node:path'

export interface CommandDeps {
  registry: CaseRegistry
  drivers: DriverRegistry
  host: HostFacade
  runsDir: () => string
  exportDir: () => string
  defaultTimeoutMs: () => number
  /** 提炼闸门（批次台账 + 提案 + 批准落地）。 */
  pipeline: PipelineStore
  /** 重新扫描 scenes 目录，返回一行人类可读的结论。 */
  reload: () => string
  /** 成本闸门的默认值（来自插件配置）；省略 = `DEFAULT_POLICY`。 */
  policyDefaults?: () => PolicyOptions
  /** 夹具根；省略 = 包内 `fixtures/`。 */
  fixturesDir?: () => string
  /** step 片段注册表根；省略 = 包内 `registry/`。 */
  registryDir?: () => string
  /** 参数化模板根；省略 = 包内 `templates/`。 */
  templatesDir?: () => string
  /** 并发度上限；省略 = 1（串行）。 */
  parallelLimit?: () => number
  /** 是否对报告脱敏；省略 = false。 */
  redact?: () => boolean
}

const USAGE = [
  '用法：',
  '  /testkit list                    列出全部场景',
  '  /testkit run                     跑全部 active 场景',
  '  /testkit run TK-0001 TK-0002     跑指定场景',
  '  /testkit run --kind tool         按类型跑',
  '  /testkit run --tag boundary      按标签跑',
  '  /testkit run --changed           只跑受工作区改动影响的场景（git 不可用则退回全量）',
  '  /testkit run --since HEAD~1      只跑受某 ref 之后改动影响的场景',
  '  /testkit run --affected-by <file> 只跑受该文件影响的场景',
  '  /testkit run --dsh-version <v>   按宿主版本过滤（读 fixture 的 dsh_version 绑定）',
  '  /testkit run --parallel 4        并发度上限（只有 parallel: safe 的场景会并发）',
  '  /testkit run --redact            写报告前脱敏（token / 私钥 / 邮箱 / 家目录路径）',
  '  /testkit run --owner @you        只跑某人的场景',
  '  /testkit run --cost none         只跑某成本档（none | low | high）',
  '  /testkit run --smoke             只跑冒烟集（5 秒静态估算预算，可 --smoke-budget 调）',
  '  /testkit trace [runId]           看步骤级 trace（--format timeline|json|chrome|otel）',
  '  /testkit trend [dimension]       按 kind / tag / owner / dshVersion 聚合历史运行',
  '  /testkit coverage                覆盖矩阵 + 缺口报告',
  '  /testkit search <关键词>          全文搜索场景（0 条时解释为什么是空的）',
  '  /testkit run --allow-model       本次放行 high 档（**真实模型调用**，默认拒绝）',
  '  /testkit run --allow-low-cost    本次放行 low 档（起进程 / 写文件）',
  '  /testkit expand TK-0100          把 use: 步骤展开成 flat 步骤',
  '  /testkit registry                列出 step 片段注册表',
  '  /testkit fixtures                列出夹具与其 DSH 版本绑定',
  '  /testkit export [outDir]         导出为可在 CI 跑的自包含测试文件',
  '  /testkit export --format touchstone [outDir]  把失败项导成 bug_report/ 交给 touchstone',
  '  /testkit import <case.md>        把 touchstone 的 case 转成场景**草稿**（走提案闸门）',
  '  /testkit report [runId]          查看报告',
  '  /testkit reload                  重新扫描场景目录',
  '',
  '成本闸门：默认不允许真实模型调用（high 档会被记 skipped 并写明原因）；',
  '放权只有这条路——工具面（模型可调）只能收紧，不能提权。',
  '',
  '沙箱：shell 默认只读（写命令与解释器默认拒绝），禁止任意网络请求。',
  '',
  '提炼闸门（要不要提炼、要不要落地，都由你决定）：',
  '  /testkit issue                   查看台账与当前批次',
  '  /testkit issue open <范围说明>    开启本轮提炼（开启后模型才能提交提案）',
  '  /testkit issue show <P-xxxx>     看提案正文与质量预检明细',
  '  /testkit issue approve <P-xxxx|--all>      批准落地进 cases/（自动分配 TK 号 + 重建索引）',
  '  /testkit issue reject <P-xxxx|--all> [理由] 拒绝（文件留在 proposals/ 留痕）',
  '  /testkit issue close [理由]      作废本轮（不裁决）',
].join('\n')

const ISSUE_USAGE = [
  '用法：',
  '  /testkit issue                              查看台账',
  '  /testkit issue open <范围说明>               开启本轮提炼',
  '  /testkit issue show <P-xxxx>                看提案正文',
  '  /testkit issue approve <P-xxxx …|--all>      批准落地',
  '  /testkit issue reject <P-xxxx …|--all> [理由] 拒绝',
  '  /testkit issue close [理由]                  作废本轮',
].join('\n')

export function defineTestkitCommands(deps: CommandDeps): CommandDefinition[] {
  return [
    {
      name: 'testkit',
      description: 'dsh-testkit：列出 / 运行 / 报告 / 重载测试场景，以及 issue 提炼闸门',
      inputHint:
        'list | run [ids] [--kind k] [--tag t] [--smoke] [--owner o] | report [runId] | trace [runId] | trend | coverage | search <词> | export [outDir] | reload | issue <open|show|approve|reject|close>',
      execute: async (rawInput, signal) => {
        const argv = tokenize(rawInput)
        const sub = argv.shift() ?? 'list'

        switch (sub) {
          case 'list':
            return { kind: 'success', text: renderList(deps) }

          case 'run': {
            const selection = parseSelection(argv)
            if (selection.error) return { kind: 'error', text: selection.error }

            // 命令面由**人**发起：`--allow-model` / `--allow-low-cost` 可以显式放权
            // （这是唯一的放权入口；工具面只能收紧，见 src/tools.ts 的 buildPolicy）。
            const policy = resolvePolicy(
              withCommandOverrides(deps.policyDefaults?.() ?? {}, selection.overrides),
            )

            const fixturesDir = deps.fixturesDir?.() ?? join(packageRoot, 'fixtures')
            const registryDir = deps.registryDir?.() ?? join(packageRoot, 'registry')

            // 增量选择：`--changed` / `--since` / `--affected-by` / `--dsh-version`。
            // 判定依据会随报告落盘（SelectionRecord），"为什么只跑了这些"不用靠回忆。
            const incremental =
              selection.incremental === undefined
                ? { warnings: [] as string[] }
                : resolveSelection(selection.incremental, {
                    scenarios: deps.registry.all,
                    fixturesDir,
                    registryDir,
                  })

            const dx =
              selection.dx === undefined ? undefined : applyDxFilter(deps.registry.all, selection.dx)

            const summary = await runScenarios({
              registry: deps.registry,
              drivers: deps.drivers,
              host: deps.host,
              filter:
                dx === undefined
                  ? (incremental.filter ?? selection.filter)
                  : { ids: dx.matched.map((s) => s.id), status: ['active'] },
              signal,
              policy,
              fixtures: { fixturesDir, dshVersion: deps.host.env.dshVersion },
              parallelLimit: selection.parallelLimit ?? deps.parallelLimit?.() ?? 1,
              ...(incremental.selection === undefined ? {} : { selection: incremental.selection }),
            })
            const write = await writeRunArtifacts(summary, deps.runsDir(), {
              redact: selection.redact === true || deps.redact?.() === true,
            })
            const t = summary.totals
            const lines = [
              `Run ${summary.runId} — 合计 ${t.total}：✅ ${t.passed} · ❌ ${t.failed} · ⏭️ ${t.skipped} · 💥 ${t.errored}`,
              describePolicy(summary),
            ]
            for (const warning of 'warnings' in incremental ? incremental.warnings : []) {
              lines.push(`⚠️ ${warning}`)
            }
            if (summary.selection !== undefined) {
              lines.push(`增量判定（${summary.selection.mode}）：${summary.selection.detail}`)
            }
            if (dx !== undefined) {
              lines.push(`DX 过滤：${dx.reason}（命中 ${dx.matched.length} 条）`)
            }
            if (summary.execution !== undefined && summary.execution.parallel !== 'off') {
              lines.push(
                `并发：上限 ${summary.execution.limit}（safe ${summary.execution.safe} / exclusive ${summary.execution.exclusive}）`,
              )
            }
            if (write.redaction !== undefined) {
              lines.push(`已脱敏 ${write.redaction.count} 处（findings 只记位置与类型，不含原文）`)
            }
            for (const c of summary.cases.filter((x) => x.verdict !== 'passed')) {
              const why = c.error ?? c.skipReason ?? '存在未通过断言'
              const category =
                c.failureCategory === undefined ? '' : `［${FAILURE_CATEGORY_LABEL[c.failureCategory]}］`
              lines.push(`  ${c.verdict === 'skipped' ? '⏭️' : c.verdict === 'failed' ? '❌' : '💥'} ${c.id} ${c.title} — ${why}${category}`)
              // 错误消息质量（文档 §6.3）：只有**有依据**时才给"可能原因"。
              if (c.verdict === 'failed' || c.verdict === 'errored') {
                const causes = probableCauses(c)
                if (causes.length > 0) {
                  for (const line of renderCauses(causes).split('\n')) lines.push(`    ${line}`)
                }
              }
            }
            lines.push(write.artifacts ? `报告：${write.artifacts.markdownPath}` : `⚠️ 报告写入失败：${write.error}`)
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'report': {
            const { readdir, readFile } = await import('node:fs/promises')
            const { join } = await import('node:path')
            const runsDir = deps.runsDir()
            try {
              let runId = argv[0]
              if (!runId) {
                const entries = (await readdir(runsDir, { withFileTypes: true }))
                  .filter((e) => e.isDirectory())
                  .map((e) => e.name)
                  .sort()
                runId = entries[entries.length - 1]
                if (!runId) return { kind: 'success', text: `尚无运行记录（${runsDir}）` }
              }
              const text = await readFile(join(runsDir, runId, 'report.md'), 'utf8')
              return { kind: 'success', text: text.length > 6000 ? `${text.slice(0, 6000)}\n…（截断）` : text }
            } catch (error) {
              return { kind: 'error', text: `读取报告失败：${String(error)}` }
            }
          }

          case 'expand': {
            const id = argv[0]
            if (id === undefined) return { kind: 'error', text: '用法：/testkit expand <场景 ID>' }
            const scenario = deps.registry.all.find((s) => s.id === id)
            if (scenario === undefined) return { kind: 'error', text: `找不到场景 ${id}` }
            const loaded = loadRegistry({ registryDir: deps.registryDir?.() ?? join(packageRoot, 'registry') })
            const result = expandScenario(scenario, { registry: loaded })
            if (!result.ok) {
              return {
                kind: 'error',
                text: [`展开失败（${result.problems.length} 个问题）：`, ...result.problems.map((p) => `  - ${p}`)].join('\n'),
              }
            }
            const lines = [`场景 ${id}：${result.flat.length} 步（已展开为 flat，无 use/with 残留）`]
            result.flat.forEach((step, i) => {
              lines.push(`  ${i + 1}. ${step.name ?? '(未命名)'}`)
              if (step.act !== undefined) lines.push(`     act: ${JSON.stringify(step.act)}`)
              for (const assertion of step.expect ?? []) lines.push(`     expect: ${JSON.stringify(assertion)}`)
            })
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'registry': {
            const loaded = loadRegistry({ registryDir: deps.registryDir?.() ?? join(packageRoot, 'registry') })
            const lines = [`step 片段注册表：${loaded.steps.size} 份（版本 ${loaded.version}）`]
            for (const fragment of [...loaded.steps.values()].sort((a, b) => a.name.localeCompare(b.name))) {
              lines.push(
                `  ${fragment.name}@${fragment.version}（cost=${fragment.cost ?? '—'}）${fragment.description}`,
              )
            }
            if (loaded.problems.length > 0) {
              lines.push('', `⚠️ ${loaded.problems.length} 个问题：`)
              for (const p of loaded.problems) lines.push(`  - ${p}`)
            }
            return { kind: loaded.problems.length > 0 ? 'error' : 'success', text: lines.join('\n') }
          }

          case 'fixtures': {
            const { loadFixtures } = await import('./fixtures/load.js')
            const loaded = loadFixtures(deps.fixturesDir?.() ?? join(packageRoot, 'fixtures'))
            const lines = [`夹具目录：${loaded.dir}`, `共 ${loaded.fixtures.length} 份，无效 ${loaded.invalid.length} 份`, '']
            for (const item of loaded.fixtures) {
              const version = item.spec?.dshVersion ?? '—'
              const source = item.spec?.source ?? '—'
              lines.push(`  ${item.name}（source=${source} dsh_version=${version}）`)
            }
            for (const bad of loaded.invalid) {
              lines.push(`  ✗ ${bad.name}：${bad.error ?? bad.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`)
            }
            return { kind: loaded.invalid.length > 0 ? 'error' : 'success', text: lines.join('\n') }
          }

          case 'import': {
            const file = argv[0]
            if (file === undefined) {
              return { kind: 'error', text: '用法：/testkit import <touchstone case.md 路径>' }
            }
            const { readFile } = await import('node:fs/promises')
            let text: string
            try {
              text = await readFile(file, 'utf8')
            } catch (error) {
              return { kind: 'error', text: `读取失败：${error instanceof Error ? error.message : String(error)}` }
            }
            const draft = parseCaseMd(text)
            if (!draft.validation.ok) {
              return {
                kind: 'error',
                text: [
                  '转换出的草稿没通过场景校验（**没有**提交提案）：',
                  ...draft.validation.issues.map((i) => `  - ${i.path}: ${i.message}`),
                ].join('\n'),
              }
            }
            // 走闸门的**提案**通道：不 open 批次（那是人的动作）、不写 cases/。
            const proposed = deps.pipeline.propose({
              yamlText: draft.yaml,
              notes: draft.notes.length > 0 ? draft.notes.join('；') : '来自 touchstone case.md 的草稿',
            })
            if (!proposed.ok) {
              return {
                kind: 'error',
                text: [
                  proposed.error,
                  ...(proposed.findings ?? []).map((f) => `  [${f.level === 'block' ? '阻断' : '提醒'}] ${f.message}`),
                ].join('\n'),
              }
            }
            return {
              kind: 'success',
              text: [
                `已登记提案 ${proposed.proposalId}（批次 ${proposed.batchId}）`,
                `场景：${proposed.title}（${proposed.kind} / ${proposed.status}）`,
                ...(draft.unmapped.length > 0
                  ? ['', `未映射的内容（已保留为 YAML 注释）：${draft.unmapped.length} 处`]
                  : []),
                '',
                '落地与否由人决定：/testkit issue approve ' + proposed.proposalId,
              ].join('\n'),
            }
          }

          case 'export': {
            const formatIndex = argv.findIndex((a) => a === '--format')
            const format = formatIndex >= 0 ? argv[formatIndex + 1] : undefined
            const positional = argv.filter((a, i) => !a.startsWith('-') && i !== formatIndex + 1)
            const outDir = positional[0]

            if (format === 'touchstone') {
              const located = latestRunJson(deps.runsDir())
              if (!located.ok || located.path === undefined) {
                return { kind: 'error', text: `无法定位运行记录：${located.reason ?? '未知原因'}` }
              }
              try {
                const result = await exportBugReports({
                  source: located.path,
                  outDir: outDir ?? join(packageRoot, 'bug_report'),
                  scenarioSeverity: (caseId) => deps.registry.all.find((s) => s.id === caseId)?.severity,
                })
                const lines = [
                  `已导出 ${result.exported.length} 条失败场景 → ${result.outDir}`,
                  ...result.exported.map((item) => `  ${item.caseId}（severity=${item.severity}）→ ${item.dir}`),
                ]
                if (result.skipped.length > 0) {
                  lines.push('', `未导出 ${result.skipped.length} 条（不是 bug 或无法归因）：`)
                  for (const item of result.skipped) lines.push(`  ${item.caseId}：${item.reason}`)
                }
                return { kind: 'success', text: lines.join('\n') }
              } catch (error) {
                return {
                  kind: 'error',
                  text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
                }
              }
            }

            const selected = deps.registry.filter({ status: ['active'] })
            if (selected.length === 0) {
              return { kind: 'error', text: '没有可导出的 active 场景' }
            }
            try {
              const { exportScenariosToFile } = await import('./export/write.js')
              const result = await exportScenariosToFile({
                scenarios: selected,
                casesDir: deps.registry.dir,
                fixturesDir: deps.fixturesDir?.() ?? join(packageRoot, 'fixtures'),
                outDir: outDir ?? deps.exportDir(),
                libDir: join(packageRoot, 'lib'),
                timeoutMs: deps.defaultTimeoutMs(),
              })
              return {
                kind: 'success',
                text: [
                  `已导出 ${result.count} 条场景 → ${result.file}`,
                  `运行：node --test ${result.file}`,
                ].join('\n'),
              }
            } catch (error) {
              return {
                kind: 'error',
                text: `导出失败：${error instanceof Error ? error.message : String(error)}`,
              }
            }
          }

          case 'trace': {
            const formatIndex = argv.findIndex((a) => a === '--format')
            const format = formatIndex >= 0 ? argv[formatIndex + 1] : 'timeline'
            const runId = argv.find((a, i) => !a.startsWith('-') && i !== formatIndex + 1)
            const located = latestRunJson(deps.runsDir(), runId)
            if (!located.ok || located.path === undefined) {
              return { kind: 'error', text: `无法定位运行记录：${located.reason ?? '未知原因'}` }
            }
            const { readFile } = await import('node:fs/promises')
            let summary: RunSummary
            try {
              summary = JSON.parse(await readFile(located.path, 'utf8')) as RunSummary
            } catch (error) {
              return { kind: 'error', text: `读取失败：${error instanceof Error ? error.message : String(error)}` }
            }
            if (format === 'json') return { kind: 'success', text: renderTraceJson(summary) }
            if (format === 'chrome') return { kind: 'success', text: renderChromeTrace(summary) }
            if (format === 'otel') return { kind: 'success', text: renderOtelSpans(summary) }
            if (format !== 'timeline') {
              return { kind: 'error', text: `不支持的格式：${format}（timeline | json | chrome | otel）` }
            }
            const text = renderTimeline(summary)
            return {
              kind: 'success',
              text: text.length > 6000 ? `${text.slice(0, 6000)}\n…（截断；用 /testkit trace --format json 取全量）` : text,
            }
          }

          case 'trend': {
            const dimension = argv.find((a) => !a.startsWith('-')) ?? 'kind'
            const collected = collectRuns(deps.runsDir())
            if (collected.runs.length === 0) {
              return { kind: 'success', text: `还没有可用的历史运行（${deps.runsDir()}）` }
            }
            const trend = buildTrend(collected.runs, {
              dimension: dimension as never,
              scenarioTags: (id) => deps.registry.all.find((s) => s.id === id)?.tags ?? [],
            })
            const lines = [renderTrend(trend)]
            if (collected.skipped.length > 0) {
              lines.push('', `⚠️ 跳过 ${collected.skipped.length} 个坏产物（不是"没问题"，是读不出来）`)
            }
            return { kind: 'success', text: lines.join('\n') }
          }

          case 'coverage':
            return { kind: 'success', text: renderCoverage(buildCoverage(deps.registry.all)) }

          case 'search': {
            const text = argv.filter((a) => !a.startsWith('-')).join(' ').trim()
            return {
              kind: 'success',
              text: renderSearchResult(
                searchScenarios(deps.registry.all, text === '' ? {} : { text }),
              ),
            }
          }

          case 'reload':
            return { kind: 'success', text: deps.reload() }

          case 'issue':
            return handleIssue(deps, argv)

          case 'help':
          default:
            return { kind: 'success', text: USAGE }
        }
      },
    },
  ]
}

/* ------------------------------------------------------------ 提炼闸门 -- */

function handleIssue(deps: CommandDeps, argv: string[]): CommandResultLike {
  const action = argv.shift() ?? 'status'

  try {
    switch (action) {
      case 'status':
      case 'list':
        return { kind: 'success', text: deps.pipeline.statusText() }

      case 'open': {
        const scope = argv.join(' ').trim()
        if (scope === '') {
          return { kind: 'error', text: '开启提炼必须写明范围。用法：/testkit issue open <范围说明>' }
        }
        const result = deps.pipeline.open(scope)
        if (!result.ok) return { kind: 'error', text: result.error }
        return {
          kind: 'success',
          text: [
            `已开启提炼批次 ${result.batch.id}`,
            `范围：${result.batch.scope}`,
            '',
            '下一步：模型调 testkit_propose 提交提案（质量预检不过不会落盘）；',
            '提案收集完再裁决：/testkit issue approve <P-xxxx|--all> 或 reject。',
            '本批结案之前，不允许开启下一批。',
          ].join('\n'),
        }
      }

      case 'show': {
        const proposalId = argv[0]
        if (!proposalId) return { kind: 'error', text: '用法：/testkit issue show <P-xxxx>' }
        const shown = deps.pipeline.show(proposalId)
        return shown.ok ? { kind: 'success', text: shown.text } : { kind: 'error', text: shown.error }
      }

      case 'approve': {
        const targets = parseTargets(argv, false)
        if (!targets) {
          return { kind: 'error', text: '用法：/testkit issue approve <P-xxxx …|--all>' }
        }
        const result = deps.pipeline.approve(targets)
        if (!result.ok) {
          const lines = [result.error]
          for (const problem of result.problems ?? []) lines.push(`  - ${problem}`)
          return { kind: 'error', text: lines.join('\n') }
        }
        const lines = [`批次 ${result.batchId} → ${result.batchStatus}`]
        for (const item of result.promoted) {
          lines.push(`  ✅ ${item.proposalId} → ${item.relPath}（status=${item.status}）`)
        }
        lines.push(`索引已重建（${result.indexCount} 条场景）；未决提案 ${result.remaining} 条`)
        if (result.promoted.length > 0) {
          const ids = result.promoted.map((p) => p.caseId).join(' ')
          lines.push('', `建议立刻验证：/testkit run ${ids}`)
        }
        if (result.batchStatus !== 'open') {
          lines.push('', '本批已结案。开启下一批需重新 /testkit issue open <范围说明>。')
        }
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'reject': {
        const parsed = parseTargets(argv, true)
        if (!parsed || typeof parsed === 'string') {
          return {
            kind: 'error',
            text: '用法：/testkit issue reject <P-xxxx …|--all> [理由]',
          }
        }
        const result = deps.pipeline.reject(parsed.targets, parsed.reason)
        if (!result.ok) return { kind: 'error', text: result.error }
        const lines = [
          `已拒绝：${result.rejected.join(', ')}`,
          `批次 ${result.batchId} → ${result.batchStatus}；未决提案 ${result.remaining} 条`,
        ]
        // 回显理由：人刚写的裁决依据应当在返回里看得到（台账里也存了）
        if (parsed.reason !== undefined) lines.push(`理由：${parsed.reason}`)
        lines.push('（提案文件保留在 pipeline/proposals/ 里留痕）')
        return { kind: 'success', text: lines.join('\n') }
      }

      case 'close': {
        const reason = argv.join(' ').trim()
        const result = deps.pipeline.close(reason === '' ? undefined : reason)
        if (!result.ok) return { kind: 'error', text: result.error }
        return {
          kind: 'success',
          text: `已作废批次 ${result.batch.id}${reason === '' ? '' : `（${reason}）`}；未决提案未裁决，全部保留`,
        }
      }

      default:
        return { kind: 'error', text: ISSUE_USAGE }
    }
  } catch (error) {
    return {
      kind: 'error',
      text: `提炼闸门操作失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

/**
 * 解析提案选择器。
 *
 * @param allowReason - reject 允许把非提案号 token 当作理由
 * @returns `'all'` / 提案号数组 / reject 时带理由的对象；解析不出来返回 undefined
 */
function parseTargets(
  argv: string[],
  allowReason: false,
): 'all' | string[] | undefined
function parseTargets(
  argv: string[],
  allowReason: true,
): { targets: 'all' | string[]; reason?: string } | undefined
function parseTargets(
  argv: string[],
  allowReason: boolean,
): 'all' | string[] | { targets: 'all' | string[]; reason?: string } | undefined {
  if (argv.length === 0) return undefined
  const all = argv.includes('--all')
  const ids = argv.filter((a) => /^P-\d+$/i.test(a))
  if (!all && ids.length === 0) return undefined

  const targets: 'all' | string[] = all ? 'all' : ids
  if (!allowReason) return targets

  const reason = argv
    .filter((a) => a !== '--all' && !/^P-\d+$/i.test(a))
    .join(' ')
    .trim()
  return { targets, ...(reason === '' ? {} : { reason }) }
}

function renderList(deps: CommandDeps): string {
  const scenarios = deps.registry.all
  const lines = [`场景目录：${deps.registry.dir}`, `共 ${scenarios.length} 条`]

  const counts = deps.registry.countsByKind()
  const summary = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ')
  if (summary) lines.push(`类型分布：${summary}`)
  lines.push('')

  for (const s of scenarios) {
    const status = (s.status ?? 'active') === 'active' ? '' : ` [${s.status}]`
    lines.push(`  ${s.id} (${s.kind})${status} ${s.title}`)
  }

  const invalid = deps.registry.invalidCases
  if (invalid.length > 0) {
    lines.push('', `⚠️ ${invalid.length} 个文件无法解析：`)
    for (const item of invalid.slice(0, 10)) {
      lines.push(`  ${item.name}：${item.error ?? item.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`)
    }
  }

  const problems = deps.registry.problems
  if (problems.length > 0) {
    lines.push('', '索引问题：')
    for (const p of problems) lines.push(`  ${p.path || 'index.yaml'}：${p.message}`)
  }

  return lines.join('\n')
}

interface SelectionResult {
  filter: { ids?: string[]; kinds?: ScenarioKind[]; tags?: string[]; status: string[] }
  /** 命令面显式放权（人类发起，可以**提权**；工具面不行）。 */
  overrides?: { allowModel?: boolean; allowLowCost?: boolean }
  /** 增量选择参数（`--changed` / `--since` / `--affected-by` / `--dsh-version`）。 */
  incremental?: SelectionArgs
  /** `--redact`：写报告前脱敏。 */
  redact?: boolean
  /** `--parallel <n>`：并发度上限。 */
  parallelLimit?: number
  /** DX 过滤（`--owner` / `--cost` / `--smoke`）。 */
  dx?: DxFilterOptions
  error?: string
}

function parseSelection(argv: string[]): SelectionResult {
  const ids: string[] = []
  const kinds: string[] = []
  const tags: string[] = []
  const affectedBy: string[] = []
  const overrides: { allowModel?: boolean; allowLowCost?: boolean } = {}
  const incremental: SelectionArgs = {}
  const dx: DxFilterOptions = {}
  let redact: boolean | undefined
  let parallelLimit: number | undefined

  const needValue = (option: string, value: string | undefined): string | undefined => {
    if (value === undefined || value.startsWith('-')) return undefined
    return value
  }

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--kind' || token === '-k') {
      const value = needValue('--kind', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--kind 需要一个值' }
      kinds.push(value)
      i += 1
    } else if (token === '--tag' || token === '-t') {
      const value = needValue('--tag', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--tag 需要一个值' }
      tags.push(value)
      i += 1
    } else if (token === '--changed') {
      incremental.changed = true
    } else if (token === '--since') {
      const value = needValue('--since', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--since 需要一个 git ref，如 HEAD~1' }
      incremental.since = value
      i += 1
    } else if (token === '--affected-by') {
      const value = needValue('--affected-by', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--affected-by 需要一个文件路径' }
      affectedBy.push(value)
      i += 1
    } else if (token === '--dsh-version') {
      const value = needValue('--dsh-version', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--dsh-version 需要一个版本号' }
      incremental.dshVersion = value
      i += 1
    } else if (token === '--parallel') {
      const value = needValue('--parallel', argv[i + 1])
      const parsed = value === undefined ? Number.NaN : Number(value)
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { filter: { status: ['active'] }, error: '--parallel 需要一个 >= 1 的整数' }
      }
      parallelLimit = parsed
      i += 1
    } else if (token === '--redact') {
      redact = true
    } else if (token === '--owner') {
      const value = needValue('--owner', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--owner 需要一个值' }
      dx.owner = value
      i += 1
    } else if (token === '--cost') {
      const value = needValue('--cost', argv[i + 1])
      if (!value) return { filter: { status: ['active'] }, error: '--cost 需要一个档位：none | low | high' }
      dx.cost = value as never
      i += 1
    } else if (token === '--smoke') {
      dx.smoke = true
    } else if (token === '--smoke-budget') {
      const value = needValue('--smoke-budget', argv[i + 1])
      const parsed = value === undefined ? Number.NaN : Number(value)
      if (!Number.isInteger(parsed) || parsed <= 0) {
        return { filter: { status: ['active'] }, error: '--smoke-budget 需要一个正整数（毫秒）' }
      }
      dx.smokeBudgetMs = parsed
      i += 1
    } else if (token === '--allow-model') {
      overrides.allowModel = true
    } else if (token === '--allow-low-cost') {
      overrides.allowLowCost = true
    } else if (token.startsWith('-')) {
      return { filter: { status: ['active'] }, error: `未知选项：${token}` }
    } else {
      ids.push(token)
    }
  }

  if (affectedBy.length > 0) incremental.affectedBy = affectedBy
  const hasIncremental =
    incremental.changed === true ||
    incremental.since !== undefined ||
    incremental.affectedBy !== undefined ||
    incremental.dshVersion !== undefined

  const hasDx = dx.owner !== undefined || dx.cost !== undefined || dx.smoke === true

  return {
    filter: {
      ...(ids.length > 0 ? { ids } : {}),
      ...(kinds.length > 0 ? { kinds: kinds as ScenarioKind[] } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      status: ['active'],
    },
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    ...(hasIncremental ? { incremental } : {}),
    ...(hasDx ? { dx } : {}),
    ...(redact === undefined ? {} : { redact }),
    ...(parallelLimit === undefined ? {} : { parallelLimit }),
  }
}

/**
 * 把命令行的放权开关合进配置默认值。
 *
 * 只处理 `true`（放权）：收紧走工具面/配置，命令面的这两个开关语义就是"我这次要它跑"。
 */
function withCommandOverrides(
  base: PolicyOptions,
  overrides?: { allowModel?: boolean; allowLowCost?: boolean },
): PolicyOptions {
  if (overrides === undefined) return base
  const cost = { ...base.cost }
  if (overrides.allowModel === true) cost.allowModel = true
  if (overrides.allowLowCost === true) cost.allowLowCost = true
  return { ...base, cost }
}

/** 一行闸门摘要（人类命令面看的就是这一行）。 */
function describePolicy(summary: {
  policySnapshot?: { allowModel: boolean; allowLowCost: boolean }
}): string {
  const snapshot = summary.policySnapshot
  if (snapshot === undefined) return '成本闸门：未启用'
  return `成本闸门：allowModel=${snapshot.allowModel} · allowLowCost=${snapshot.allowLowCost}`
}

/** 按空格切分，支持单/双引号包裹。 */
function tokenize(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    out.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return out
}
