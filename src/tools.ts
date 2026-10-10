/**
 * 模型可见的工具面。
 *
 * 工具只做"读场景 / 跑场景 / 看报告"三件事，保持窄面：
 * 越窄越不容易与宿主既有工具冲突，也越好向模型解释。
 */

import { join } from 'node:path'

import { FAILURE_CATEGORY_LABEL } from './analysis/classify.js'
import { probableCauses, renderCauses } from './analysis/causes.js'
import { packageRoot } from './config.js'
import type { CaseFilter, CaseRegistry } from './cases/registry.js'
import type { ScenarioKind } from './cases/types.js'
import { applyDxFilter, suggestSmokeSet, type DxFilterOptions } from './dx/select.js'
import { resolvePolicy, tightenLimit, type ExecutionPolicy, type PolicyOptions, type SandboxPolicy } from './executor/policy.js'
import { buildCoverage, renderCoverage } from './insight/coverage.js'
import { renderSearchResult, searchScenarios } from './insight/search.js'
import { buildTrend, collectRuns, renderTrend } from './insight/trend.js'
import type { DriverRegistry, HostFacade, ToolDefinition } from './kinds/types.js'
import type { PipelineStore } from './pipeline/index.js'
import { loadRegistry, expandScenario } from './registry/index.js'
import { runScenarios, type RunProgress } from './runtime/runner.js'
import type { RunSummary } from './runtime/runlog.js'
import { writeRunArtifacts } from './report/json.js'
import { renderMarkdown } from './report/markdown.js'
import { resolveSelectionFromRaw } from './surface/selection-args.js'
import { latestRunJson } from './surface/runs.js'
import {
  renderChromeTrace,
  renderOtelSpans,
  renderTimeline,
  renderTraceJson,
} from './trace/index.js'
import { exportBugReports } from './touchstone/index.js'

export interface ToolDeps {
  registry: CaseRegistry
  drivers: DriverRegistry
  host: HostFacade
  runsDir: () => string
  /** CI 用例导出目录。 */
  exportDir: () => string
  defaultTimeoutMs: () => number
  maxInvalidReported: () => number
  /** 夹具根（`scenario.fixtures` 按它解析）；省略 = 包内 `fixtures/`。 */
  fixturesDir?: () => string
  /** step 片段注册表根（`testkit_expand` 用）；省略 = 包内 `registry/`。 */
  registryDir?: () => string
  /** 并发度上限；`1` = 串行（默认）。 */
  parallelLimit?: () => number
  /** 是否对报告脱敏（`--redact`）；省略 = false。 */
  redact?: () => boolean
  /**
   * 提炼闸门。
   *
   * 工具面在这里**只用到提案侧**（`propose` / `statusText`）——
   * 批准落地的能力只挂在命令面，模型够不到。这是闸门成立的前提。
   */
  pipeline: PipelineStore
  /**
   * 成本闸门的**默认值**（来自插件配置；见 `src/config.ts` 的 `policyDefaultsFromConfig`）。
   *
   * 省略 = `DEFAULT_POLICY`（仍是 `allowModel: false`）。工具面**总是**构造策略并传入，
   * 因此这里缺省也不会回到"随便调模型"的旧行为。
   */
  policyDefaults?: () => PolicyOptions
}

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false } as const
void NO_ARGS // Phase 4 的 export 工具会用

export function defineTestkitTools(deps: ToolDeps): ToolDefinition[] {
  const { registry, drivers, host } = deps

  // 三条路径缺省都指向包内默认目录：调用方（含既有测试）不传也能工作，
  // 但插件面一定会显式传配置解析出来的绝对路径（否则相对路径会随 cwd 漂）。
  const fixturesDir = (): string => deps.fixturesDir?.() ?? join(packageRoot, 'fixtures')
  const registryDir = (): string => deps.registryDir?.() ?? join(packageRoot, 'registry')
  const parallelLimit = (): number => deps.parallelLimit?.() ?? 1
  const redact = (): boolean => deps.redact?.() ?? false

  return [
    {
      name: 'testkit_list',
      description:
        '列出 dsh-testkit 已登记的测试场景。可按 kind / tag / status 过滤。同时回显无法解析的场景文件。',
      parameters: {
        type: 'object',
        properties: {
          kinds: { type: 'array', items: { type: 'string' }, description: '按场景类型过滤' },
          tags: { type: 'array', items: { type: 'string' }, description: '按标签过滤（任一命中）' },
          status: { type: 'array', items: { type: 'string' }, description: 'active | draft | retired | blocked' },
          includeInvalid: { type: 'boolean', description: '是否回显校验失败的场景文件（默认 true）' },
        },
        additionalProperties: false,
      },
      execute: (args) => {
        const kinds = asStringArray(args.kinds) as ScenarioKind[] | undefined
        const tags = asStringArray(args.tags)
        const status = asStringArray(args.status)
        const includeInvalid = args.includeInvalid !== false

        const matched = registry.filter({
          ...(kinds ? { kinds } : {}),
          ...(tags ? { tags } : {}),
          ...(status ? { status } : {}),
        })

        const lines: string[] = []
        lines.push(`场景目录：${registry.dir}`)
        lines.push(`命中 ${matched.length} 条 / 共 ${registry.all.length} 条`)
        const counts = registry.countsByKind()
        const kindSummary = Object.entries(counts)
          .map(([k, n]) => `${k}=${n}`)
          .join(' ')
        if (kindSummary) lines.push(`类型分布：${kindSummary}`)
        lines.push('')

        for (const s of matched) {
          const statusTag = (s.status ?? 'active') === 'active' ? '' : ` [${s.status}]`
          lines.push(`- ${s.id} (${s.kind})${statusTag} ${s.title}`)
        }

        const invalid = registry.invalidCases
        if (includeInvalid && invalid.length > 0) {
          const limit = deps.maxInvalidReported()
          lines.push('')
          lines.push(`⚠️ ${invalid.length} 个场景文件无法解析：`)
          for (const item of invalid.slice(0, limit)) {
            const detail = item.error ?? item.issues.map((i) => `${i.path}: ${i.message}`).join('; ')
            lines.push(`- ${item.name}：${detail}`)
          }
          if (invalid.length > limit) lines.push(`- …另有 ${invalid.length - limit} 条省略`)
        }

        const problems = registry.problems
        if (problems.length > 0) {
          lines.push('')
          lines.push('索引问题：')
          for (const p of problems) lines.push(`- ${p.path || 'index.yaml'}：${p.message}`)
        }

        return lines.join('\n')
      },
    },

    {
      name: 'testkit_run',
      description:
        '运行指定的测试场景（省略选择器则跑全部 active 场景；显式给 ids 时不受 status 限制，可按 id 单跑 draft），返回结果摘要并写出报告。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: '指定 case id，如 TK-0001' },
          only: { type: 'array', items: { type: 'string' }, description: '同 ids（显式点名；与其它 DX 过滤可叠加）' },
          kinds: { type: 'array', items: { type: 'string' }, description: '按场景类型选择' },
          tags: { type: 'array', items: { type: 'string' }, description: '按标签选择' },
          timeoutMs: { type: 'number', description: '覆盖默认超时' },
          allowModel: {
            type: 'boolean',
            description:
              '是否允许真实模型调用（high 档）。只能**收紧**：配置未放权时传 true 无效；' +
              '放权由人执行 /testkit run --allow-model。默认 false。',
          },
          allowLowCost: {
            type: 'boolean',
            description: '是否允许 low 档（起进程 / 写文件）。只能收紧，默认取配置值。',
          },
          maxModelCalls: {
            type: 'number',
            description: '本次运行的模型调用次数上限（0 = 不限）。只能比配置更严。',
          },
          allowFileWrite: {
            type: 'boolean',
            description: '是否允许写文件（fs 的 write / edit）。只能收紧，默认取配置值。',
          },
          changed: {
            type: 'boolean',
            description:
              '只跑受**工作区改动**影响的场景（git diff HEAD）。git 不可用时**退回全量**并说明，绝不静默跑 0 条。',
          },
          since: {
            type: 'string',
            description: '只跑受某个 git ref 之后改动影响的场景，如 HEAD~1、main。',
          },
          affectedBy: {
            type: 'array',
            items: { type: 'string' },
            description: '只跑受这些文件影响的场景（按 kind / step 片段 / fixture 依赖推导）。',
          },
          dshVersion: {
            type: 'string',
            description: '按宿主 DSH 版本过滤：fixture 的 dsh_version 与它不匹配的场景会被排除。',
          },
          parallelLimit: {
            type: 'number',
            description: '并发度上限；只有声明 parallel: safe 的场景会并发，exclusive 永远独占。1 = 串行。',
          },
          redact: {
            type: 'boolean',
            description: '写报告前脱敏（过滤 token / 私钥 / 邮箱 / 家目录路径），并在报告里写明脱敏了几处。',
          },
          owner: { type: 'string', description: '按负责人过滤（忽略大小写与 @ 前缀）。' },
          cost: { type: 'string', description: '按成本档过滤：none | low | high（取"最高允许档"语义）。' },
          smoke: {
            type: 'boolean',
            description: '只跑冒烟集（tags 含 smoke，再按成本档与静态耗时估算补足到预算内）。',
          },
          smokeBudgetMs: { type: 'number', description: '冒烟集的静态估算预算（毫秒），默认 5000。' },
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        let ids = asStringArray(args.ids)
        // `--only` 语义：显式点名（与 ids 同义，但更贴近 CLI/DX 说法）
        const only = asStringArray(args.only)
        if (only !== undefined) ids = [...new Set([...(ids ?? []), ...only])]
        let filter: CaseFilter = {
          ...(ids ? { ids } : {}),
          ...(asStringArray(args.kinds) ? { kinds: asStringArray(args.kinds) as ScenarioKind[] } : {}),
          ...(asStringArray(args.tags) ? { tags: asStringArray(args.tags)! } : {}),
          // 显式点名就不受 status 限制：按 id 单跑 draft 是刻意支持的用法
          // （team 通道的场景只能这样跑，见 docs/SCENARIO-SPEC.md §3.7）。
          // 没有选择器时仍只跑 active——draft 绝不能混进默认回归集。
          ...(ids ? {} : { status: ['active'] }),
        }

        // 增量选择：不给参数就完全不影响既有行为（filter 原样）。
        const selection = resolveSelectionFromRaw(args, {
          registry,
          fixturesDir: fixturesDir(),
          registryDir: registryDir(),
        })
        if (selection.filter !== undefined) filter = selection.filter

        // DX 过滤（owner / cost / smoke）：与增量选择并列的第二类"选哪些"，
        // 优先级更高（人是显式点了 SMOKE 还是改了文件，人自己清楚）。
        const dxArgs: DxFilterOptions = {
          ...(ids === undefined ? {} : { only: ids }),
          ...(typeof args.owner === 'string' && args.owner.trim() !== '' ? { owner: args.owner } : {}),
          ...(typeof args.cost === 'string' && args.cost.trim() !== ''
            ? { cost: args.cost.trim() as never }
            : {}),
          ...(args.smoke === true ? { smoke: true } : {}),
          ...(typeof args.smokeBudgetMs === 'number' ? { smokeBudgetMs: args.smokeBudgetMs } : {}),
        }
        const dxUsed =
          dxArgs.owner !== undefined || dxArgs.cost !== undefined || dxArgs.smoke === true
        const dx = dxUsed ? applyDxFilter(registry.all, dxArgs) : undefined
        if (dx !== undefined) {
          filter = { ids: dx.matched.map((s) => s.id), status: ['active'] }
        }

        // 闸门**总是**构造（默认 allowModel=false）；见 buildPolicy 的两条纪律。
        const policy = buildPolicy(deps, args)

        const progress: string[] = []
        const summary = await runScenarios({
          registry,
          drivers,
          host,
          filter,
          policy,
          fixtures: { fixturesDir: fixturesDir(), dshVersion: deps.host.env.dshVersion },
          ...(selection.selection === undefined ? {} : { selection: selection.selection }),
          ...(typeof args.parallelLimit === 'number'
            ? { parallelLimit: args.parallelLimit }
            : { parallelLimit: parallelLimit() }),
          ...(exec.signal ? { signal: exec.signal } : {}),
          ...(typeof args.timeoutMs === 'number' ? { defaultTimeoutMs: args.timeoutMs } : {}),
          onProgress: (event: RunProgress) => {
            if (event.phase === 'case-end') {
              const mark =
                event.verdict === 'passed' ? '✅' : event.verdict === 'skipped' ? '⏭️' : event.verdict === 'failed' ? '❌' : '💥'
              progress.push(`${mark} ${event.caseId}`)
            }
          },
        })

        const write = await writeRunArtifacts(summary, deps.runsDir(), {
          redact: args.redact === true || redact(),
        })
        const t = summary.totals

        const lines: string[] = []
        lines.push(`Run ${summary.runId}`)
        // 回显选择器：否则「合计 0」只能靠猜（真踩过——draft 场景按 id 单跑时
        // 曾因为写死 status=active 而静默选中 0 条）
        lines.push(`选择器：${describeFilter(filter)}`)
        for (const warning of selection.warnings) lines.push(`⚠️ ${warning}`)
        if (summary.selection !== undefined) {
          lines.push(`增量判定（${summary.selection.mode}）：${summary.selection.detail}`)
        }
        if (dx !== undefined) {
          lines.push(`DX 过滤：${dx.reason}（命中 ${dx.matched.length} 条）`)
        }
        lines.push(`合计 ${t.total} — ✅ ${t.passed} · ❌ ${t.failed} · ⏭️ ${t.skipped} · 💥 ${t.errored}`)
        lines.push(describePolicy(summary))
        if (summary.execution !== undefined && summary.execution.parallel !== 'off') {
          lines.push(
            `并发：上限 ${summary.execution.limit}（safe ${summary.execution.safe} 条 / exclusive ${summary.execution.exclusive} 条）`,
          )
        }
        if (write.redaction !== undefined) {
          lines.push(`已脱敏 ${write.redaction.count} 处（findings 只记位置与类型，不含原文）`)
        }
        if (t.total === 0) {
          lines.push('没有选中任何场景：省略选择器只跑 active；draft 场景需显式按 id 点名。')
        }
        if (progress.length > 0) lines.push('')
        lines.push(...progress)

        const attention = summary.cases.filter((c) => c.verdict !== 'passed')
        if (attention.length > 0) {
          lines.push('')
          lines.push('需要关注：')
          for (const c of attention) {
            const why = c.error ?? c.skipReason ?? '存在未通过断言'
            // 归因是**分流建议**（谁该来看），不是判决：原始证据仍要一并给出
            const category =
              c.failureCategory === undefined ? '' : `［${FAILURE_CATEGORY_LABEL[c.failureCategory]}］`
            lines.push(`- ${c.id} ${c.title} → ${c.verdict}${category}：${why}`)
            if (c.usage !== undefined && c.usage.modelCalls > 0) {
              lines.push(`  用量：模型调用 ${c.usage.modelCalls} 次 · token ${c.usage.tokens}`)
            }
            if (c.minimalRepro !== undefined) {
              for (const line of c.minimalRepro.split('\n')) lines.push(`  ${line}`)
            }
            // 错误消息质量（文档 §6.3）：给"可能原因 + 依据 + 下一步"，
            // 但**没有依据就什么都不说**——宁可沉默，也不要给一堆"可能原因"当噪声。
            if (c.verdict === 'failed' || c.verdict === 'errored') {
              const causes = probableCauses(c)
              if (causes.length > 0) {
                for (const line of renderCauses(causes).split('\n')) lines.push(`  ${line}`)
              }
            }
          }
        }

        if (write.artifacts) lines.push('', `报告：${write.artifacts.markdownPath}`)
        else if (write.error) lines.push('', `⚠️ 报告写入失败：${write.error}`)

        return lines.join('\n')
      },
    },

    {
      name: 'testkit_report',
      description: '读取最近一次（或指定 Run ID）的测试报告。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '省略则返回最近一次运行' },
          full: { type: 'boolean', description: '是否返回完整报告（默认截断）' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const { readdir, readFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const runsDir = deps.runsDir()

        try {
          let runId = typeof args.runId === 'string' ? args.runId : undefined
          if (!runId) {
            const entries = (await readdir(runsDir, { withFileTypes: true }))
              .filter((e) => e.isDirectory())
              .map((e) => e.name)
              .sort()
            runId = entries[entries.length - 1]
            if (!runId) return `尚未有任何运行记录（目录：${runsDir}）`
          }

          const markdown = await readFile(join(runsDir, runId, 'report.md'), 'utf8')
          const full = args.full === true
          return full || markdown.length <= 8000 ? markdown : `${markdown.slice(0, 8000)}\n\n…（已截断，用 full: true 取全文）`
        } catch (error) {
          return `读取报告失败：${error instanceof Error ? error.message : String(error)}`
        }
      },
    },

    {
      name: 'testkit_export',
      description:
        '导出测试产物：`node-test`（可脱离活宿主运行的 CI 用例）或 `touchstone`（把失败项导成 bug_report/ 交给 touchstone）。',
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            enum: ['node-test', 'touchstone'],
            description: '导出目标：node-test（CI 用例）/ touchstone（bug_report 目录）',
          },
          ids: { type: 'array', items: { type: 'string' }, description: '指定 case id' },
          outDir: { type: 'string', description: '输出目录（node-test 默认包内 export/，touchstone 默认包内 bug_report/）' },
          runId: { type: 'string', description: 'touchstone 目标：指定 Run ID（省略取最近一次运行）' },
        },
        additionalProperties: false,
        required: ['target'],
      },
      execute: async (args) => {
        const target = typeof args.target === 'string' ? args.target : 'node-test'
        if (target === 'touchstone') {
          const { join } = await import('node:path')
          const runId = typeof args.runId === 'string' && args.runId.trim() !== '' ? args.runId.trim() : undefined
          const outDir =
            typeof args.outDir === 'string' && args.outDir.trim() !== ''
              ? args.outDir
              : join(packageRoot, 'bug_report')
          const located = latestRunJson(deps.runsDir(), runId)
          if (!located.ok || located.path === undefined) {
            return `无法定位运行记录：${located.reason ?? '未知原因'}`
          }
          try {
            const result = await exportBugReports({
              source: located.path,
              outDir,
              scenarioSeverity: (caseId) =>
                registry.all.find((s) => s.id === caseId)?.severity,
            })
            const lines = [
              `已导出 ${result.exported.length} 条失败场景 → ${result.outDir}`,
              ...result.exported.map((item) => `- ${item.caseId}（severity=${item.severity}）→ ${item.dir}`),
            ]
            if (result.skipped.length > 0) {
              lines.push('', `未导出 ${result.skipped.length} 条（不是 bug 或无法归因）：`)
              for (const item of result.skipped) lines.push(`- ${item.caseId}：${item.reason}`)
            }
            return lines.join('\n')
          } catch (error) {
            return `导出失败：${error instanceof Error ? error.message : String(error)}`
          }
        }
        if (target !== 'node-test') {
          return `不支持的导出目标：${target}（支持 node-test / touchstone）`
        }

        const ids = asStringArray(args.ids)
        const selected = registry.filter({
          ...(ids ? { ids } : {}),
          status: ['active'],
        })
        if (selected.length === 0) {
          return '没有可导出的场景（检查 ids 选择器与 status=active）'
        }

        const { join } = await import('node:path')
        const { exportScenariosToFile } = await import('./export/write.js')

        const outDir =
          typeof args.outDir === 'string' && args.outDir.trim() !== ''
            ? args.outDir
            : deps.exportDir()

        try {
          const result = await exportScenariosToFile({
            scenarios: selected,
            casesDir: registry.dir,
            fixturesDir: fixturesDir(),
            outDir,
            libDir: join(packageRoot, 'lib'),
            timeoutMs: deps.defaultTimeoutMs(),
          })

          return [
            `已导出 ${result.count} 条场景 → ${result.file}`,
            '',
            `运行：node --test ${result.file}`,
            '',
            '注意：导出文件自带 headless 宿主，验证的是「场景数据 + driver 逻辑」；',
            '它**不替代**活宿主验证——作用域 / 生命周期类问题只能在真实 DSH 上暴露。',
          ].join('\n')
        } catch (error) {
          return `导出失败：${error instanceof Error ? error.message : String(error)}`
        }
      },
    },

    {
      name: 'testkit_expand',
      description:
        '把一条场景的 `use:` 步骤展开成 flat 步骤（组合系统的自证：展开结果必须能一眼读懂，且不残留 use/with）。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '场景 ID，如 TK-0100' },
        },
        additionalProperties: false,
        required: ['id'],
      },
      execute: (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : ''
        if (id === '') return '缺少 id：请传入场景 ID'
        const scenario = registry.all.find((s) => s.id === id)
        if (scenario === undefined) return `找不到场景 ${id}（用 testkit_list 看可用 ID）`

        const loaded = loadRegistry({ registryDir: registryDir() })
        const result = expandScenario(scenario, { registry: loaded })
        if (!result.ok) {
          return [`展开失败（${result.problems.length} 个问题）：`, ...result.problems.map((p) => `- ${p}`)].join('\n')
        }

        const lines = [
          `场景 ${id}：${result.flat.length} 步（已展开为 flat，无 use/with 残留）`,
          `registry 版本：${loaded.version}`,
          '',
        ]
        result.flat.forEach((step, i) => {
          lines.push(`${i + 1}. ${step.name ?? '(未命名)'}`)
          if (step.act !== undefined) lines.push(`   act: ${JSON.stringify(step.act)}`)
          for (const assertion of step.expect ?? []) {
            lines.push(`   expect: ${JSON.stringify(assertion)}`)
          }
        })
        return lines.join('\n')
      },
    },

    {
      name: 'testkit_trace',
      description:
        '查看某次运行的步骤级 trace：timeline（人看）/ json（本仓规范）/ chrome（可直接喂 chrome://tracing、Perfetto）/ otel（OTLP spans）。省略 runId 取最近一次运行。',
      parameters: {
        type: 'object',
        properties: {
          runId: { type: 'string', description: '省略 = 最近一次运行' },
          format: { type: 'string', enum: ['timeline', 'json', 'chrome', 'otel'], description: '缺省 timeline' },
          top: { type: 'number', description: 'timeline 里最慢 top N（缺省 5）' },
          full: { type: 'boolean', description: '是否返回完整内容（默认截断）' },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const runId = typeof args.runId === 'string' && args.runId.trim() !== '' ? args.runId.trim() : undefined
        const located = latestRunJson(deps.runsDir(), runId)
        if (!located.ok || located.path === undefined) {
          return `无法定位运行记录：${located.reason ?? '未知原因'}`
        }
        const { readFile } = await import('node:fs/promises')
        let summary: RunSummary
        try {
          summary = JSON.parse(await readFile(located.path, 'utf8')) as RunSummary
        } catch (error) {
          return `读取 ${located.path} 失败：${error instanceof Error ? error.message : String(error)}`
        }

        const format = typeof args.format === 'string' ? args.format : 'timeline'
        if (format === 'json') return renderTraceJson(summary)
        if (format === 'chrome') return renderChromeTrace(summary)
        if (format === 'otel') return renderOtelSpans(summary)
        if (format !== 'timeline') {
          return `不支持的格式：${format}（timeline | json | chrome | otel）`
        }
        const text =
          typeof args.top === 'number'
            ? renderTimeline(summary, { top: args.top })
            : renderTimeline(summary)
        return args.full === true || text.length <= 8000
          ? text
          : `${text.slice(0, 8000)}\n\n…（已截断，用 full: true 取全文）`
      },
    },

    {
      name: 'testkit_trend',
      description:
        '按维度聚合历史运行（kind / tag / owner / dshVersion）：通过率、flaky 率、耗时、模型用量。数据不足时会明说"别据此下结论"，样本缺失时说"未知"而不是 0。',
      parameters: {
        type: 'object',
        properties: {
          dimension: { type: 'string', enum: ['kind', 'tag', 'owner', 'dshVersion'], description: '缺省 kind' },
          limit: { type: 'number', description: '只看最近 N 次运行' },
        },
        additionalProperties: false,
      },
      execute: (args) => {
        const dimension = typeof args.dimension === 'string' ? args.dimension : 'kind'
        const collected = collectRuns(
          deps.runsDir(),
          typeof args.limit === 'number' ? { limit: args.limit } : {},
        )
        if (collected.runs.length === 0) {
          const lines = [`还没有可用的历史运行（${deps.runsDir()}）`]
          for (const item of collected.skipped.slice(0, 5)) {
            lines.push(`  跳过 ${item.dir}：${item.reason}`)
          }
          return lines.join('\n')
        }
        const trend = buildTrend(collected.runs, {
          dimension: dimension as never,
          scenarioTags: (id) => registry.all.find((s) => s.id === id)?.tags ?? [],
        })
        const lines = [renderTrend(trend)]
        if (collected.skipped.length > 0) {
          lines.push('', `⚠️ 跳过 ${collected.skipped.length} 个坏产物（不是"没问题"，是读不出来）：`)
          for (const item of collected.skipped.slice(0, 5)) lines.push(`  ${item.dir}：${item.reason}`)
        }
        return lines.join('\n')
      },
    },

    {
      name: 'testkit_coverage',
      description:
        '覆盖矩阵 + 缺口报告：每个 kind 有多少场景、active/draft 分布、有没有 owner / tag / 夹具，并给出可行动的缺口清单（缺什么、怎么补）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => renderCoverage(buildCoverage(registry.all)),
    },

    {
      name: 'testkit_search',
      description:
        '全文搜索场景（id / 标题 / 标签 / owner / 来源 / 步骤文本），可按 kind / tag / owner / cost / status 过滤；0 条时回显每个条件单独命中的数量，说明"为什么是空的"。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '全文关键词（忽略大小写）' },
          kinds: { type: 'array', items: { type: 'string' } },
          tags: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string', description: '忽略大小写与 @ 前缀' },
          cost: { type: 'string', description: 'none | low | high' },
          status: { type: 'array', items: { type: 'string' } },
        },
        additionalProperties: false,
      },
      execute: (args) => {
        const kinds = asStringArray(args.kinds)
        const tags = asStringArray(args.tags)
        const status = asStringArray(args.status)
        return renderSearchResult(
          searchScenarios(registry.all, {
            ...(typeof args.text === 'string' && args.text.trim() !== '' ? { text: args.text } : {}),
            ...(kinds === undefined ? {} : { kinds }),
            ...(tags === undefined ? {} : { tags }),
            ...(typeof args.owner === 'string' && args.owner.trim() !== '' ? { owner: args.owner } : {}),
            ...(typeof args.cost === 'string' && args.cost.trim() !== '' ? { cost: args.cost } : {}),
            ...(status === undefined ? {} : { status }),
          }),
        )
      },
    },

    {
      name: 'testkit_propose',
      description:
        '提交一条「issue → 场景」的提炼提案：只写进 pipeline/proposals/，**永远不碰 cases/**。' +
        '落地必须由人执行 /testkit issue approve。没有 open 批次时会被拒绝——' +
        '要不要提炼由人决定，先让用户跑 /testkit issue open <范围说明>。',
      parameters: {
        type: 'object',
        properties: {
          yaml: {
            type: 'string',
            description:
              '完整场景正文（YAML）。id 必须写成占位值 TK-0000（正式 TK 号由 approve 分配）；' +
              'source.issue 必填；args 里不能留 TODO 标记；至少一条 expect 断言。',
          },
          notes: { type: 'string', description: '提炼要点（给人裁决时看）' },
        },
        required: ['yaml'],
        additionalProperties: false,
      },
      execute: (args) => {
        const yamlText = typeof args.yaml === 'string' ? args.yaml : ''
        if (yamlText.trim() === '') return '缺少 yaml：请传入完整的场景正文'

        try {
          const result = deps.pipeline.propose({
            yamlText,
            ...(typeof args.notes === 'string' ? { notes: args.notes } : {}),
          })

          if (!result.ok) {
            const lines = [result.error]
            for (const finding of result.findings ?? []) {
              lines.push(`  [${finding.level === 'block' ? '阻断' : '提醒'}] ${finding.message}`)
            }
            return lines.join('\n')
          }

          const lines = [
            `已登记提案 ${result.proposalId}（批次 ${result.batchId}）`,
            `文件：pipeline/${result.relPath}`,
            `场景：${result.title}（${result.kind} / ${result.status}）`,
          ]
          for (const finding of result.quality.findings) {
            lines.push(`  提醒：${finding.message}`)
          }
          lines.push('', `落地与否由人决定：/testkit issue approve ${result.proposalId}`)
          return lines.join('\n')
        } catch (error) {
          return `提案提交失败：${error instanceof Error ? error.message : String(error)}`
        }
      },
    },

    {
      name: 'testkit_pipeline',
      description:
        '查看提炼闸门台账：当前是否有 open 批次、提案的裁决状态与质量预检结论、历史批次。只读，不做任何写操作。',
      parameters: {
        type: 'object',
        properties: {
          proposalId: { type: 'string', description: '可选：查看某条提案的正文与预检明细，如 P-0001' },
        },
        additionalProperties: false,
      },
      execute: (args) => {
        try {
          const proposalId = typeof args.proposalId === 'string' ? args.proposalId.trim() : ''
          if (proposalId !== '') {
            const shown = deps.pipeline.show(proposalId)
            return shown.ok ? shown.text : shown.error
          }
          return deps.pipeline.statusText()
        } catch (error) {
          return `读取提炼台账失败：${error instanceof Error ? error.message : String(error)}`
        }
      },
    },
  ]
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

/**
 * 构造本次运行的策略。两条纪律（写在这里是因为工具面是**模型可调**的）：
 *
 *   ① **总是**构造并传入：省略 `policy` 等于"不启用闸门"，工具面绝不能因为
 *      忘了传而回到"随便调模型"的旧行为；
 *   ② 工具参数只能**收紧**，不能提权：`allowModel: true` 只有在配置本身已允许时
 *      才有效果；`false` 一律生效。放权是人的事，交给命令面
 *      `/testkit run --allow-model`。这样"模型自己给自己开模型权限"这条路是堵死的。
 */
function buildPolicy(deps: ToolDeps, args: Record<string, unknown>): ExecutionPolicy {
  const base: PolicyOptions = deps.policyDefaults?.() ?? {}
  const cost: NonNullable<PolicyOptions['cost']> = { ...base.cost }
  const sandbox: Partial<SandboxPolicy> = { ...base.sandbox }

  if (args.allowModel === false) cost.allowModel = false
  if (args.allowLowCost === false) cost.allowLowCost = false
  if (typeof args.maxModelCalls === 'number') {
    // 0 = 不限；给定值只能比配置更严（`tightenLimit` 是唯一实现处，避免两处口径漂移）
    cost.maxModelCalls = tightenLimit(cost.maxModelCalls ?? 0, args.maxModelCalls)
  }
  if (args.allowFileWrite === false) sandbox.allowFileWrite = false

  return resolvePolicy({
    cost,
    sandbox,
    ...(base.approval === undefined ? {} : { approval: base.approval }),
  })
}

/** 把本次生效的闸门渲染成一行，让"为什么被跳过"在工具输出里自证。 */
function describePolicy(summary: { policySnapshot?: { allowModel: boolean; allowLowCost: boolean; sandbox: Record<string, unknown> } }): string {
  const snapshot = summary.policySnapshot
  if (snapshot === undefined) return '成本闸门：未启用'
  const sandbox = snapshot.sandbox as { allowShell?: unknown; allowFileWrite?: unknown }
  return (
    `成本闸门：allowModel=${snapshot.allowModel} · allowLowCost=${snapshot.allowLowCost}` +
    ` · shell=${String(sandbox.allowShell)} · fileWrite=${String(sandbox.allowFileWrite)}`
  )
}

/** 把选择器渲染成一行，让报告与工具回显都能解释「为什么是 0 条」。 */
function describeFilter(filter: object): string {
  const parts = Object.entries(filter as Record<string, unknown>).map(([key, value]) =>
    Array.isArray(value) ? `${key}=[${value.join(', ')}]` : `${key}=${String(value)}`,
  )
  return parts.length > 0 ? parts.join(' ') : '（无）'
}
