/**
 * 模型可见的工具面。
 *
 * 工具只做"读场景 / 跑场景 / 看报告"三件事，保持窄面：
 * 越窄越不容易与宿主既有工具冲突，也越好向模型解释。
 */

import { FAILURE_CATEGORY_LABEL } from './analysis/classify.js'
import { packageRoot } from './config.js'
import type { CaseRegistry } from './cases/registry.js'
import type { ScenarioKind } from './cases/types.js'
import { resolvePolicy, tightenLimit, type ExecutionPolicy, type PolicyOptions, type SandboxPolicy } from './executor/policy.js'
import type { DriverRegistry, HostFacade, ToolDefinition } from './kinds/types.js'
import type { PipelineStore } from './pipeline/index.js'
import { runScenarios, type RunProgress } from './runtime/runner.js'
import { writeRunArtifacts } from './report/json.js'
import { renderMarkdown } from './report/markdown.js'

export interface ToolDeps {
  registry: CaseRegistry
  drivers: DriverRegistry
  host: HostFacade
  runsDir: () => string
  /** CI 用例导出目录。 */
  exportDir: () => string
  defaultTimeoutMs: () => number
  maxInvalidReported: () => number
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
        },
        additionalProperties: false,
      },
      execute: async (args, exec) => {
        const ids = asStringArray(args.ids)
        const filter = {
          ...(ids ? { ids } : {}),
          ...(asStringArray(args.kinds) ? { kinds: asStringArray(args.kinds) as ScenarioKind[] } : {}),
          ...(asStringArray(args.tags) ? { tags: asStringArray(args.tags)! } : {}),
          // 显式点名就不受 status 限制：按 id 单跑 draft 是刻意支持的用法
          // （team 通道的场景只能这样跑，见 docs/SCENARIO-SPEC.md §3.7）。
          // 没有选择器时仍只跑 active——draft 绝不能混进默认回归集。
          ...(ids ? {} : { status: ['active'] }),
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

        const write = await writeRunArtifacts(summary, deps.runsDir())
        const t = summary.totals

        const lines: string[] = []
        lines.push(`Run ${summary.runId}`)
        // 回显选择器：否则「合计 0」只能靠猜（真踩过——draft 场景按 id 单跑时
        // 曾因为写死 status=active 而静默选中 0 条）
        lines.push(`选择器：${describeFilter(filter)}`)
        lines.push(`合计 ${t.total} — ✅ ${t.passed} · ❌ ${t.failed} · ⏭️ ${t.skipped} · 💥 ${t.errored}`)
        lines.push(describePolicy(summary))
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
      description: '把场景导出为可脱离活宿主运行的 CI 用例（node:test）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', enum: ['node-test'], description: '导出目标' },
          ids: { type: 'array', items: { type: 'string' }, description: '指定 case id' },
          outDir: { type: 'string', description: '输出目录（默认包内 export/）' },
        },
        additionalProperties: false,
        required: ['target'],
      },
      execute: async (args) => {
        const target = typeof args.target === 'string' ? args.target : 'node-test'
        if (target !== 'node-test') {
          return `不支持的导出目标：${target}（当前只支持 node-test）`
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
