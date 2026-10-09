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
import { packageRoot } from './config.js'
import type { CaseRegistry } from './cases/registry.js'
import type { ScenarioKind } from './cases/types.js'
import { resolvePolicy, type PolicyOptions } from './executor/policy.js'
import type { CommandDefinition, CommandResultLike, DriverRegistry, HostFacade } from './kinds/types.js'
import type { PipelineStore } from './pipeline/index.js'
import { writeRunArtifacts } from './report/json.js'
import { runScenarios } from './runtime/runner.js'

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
}

const USAGE = [
  '用法：',
  '  /testkit list                    列出全部场景',
  '  /testkit run                     跑全部 active 场景',
  '  /testkit run TK-0001 TK-0002     跑指定场景',
  '  /testkit run --kind tool         按类型跑',
  '  /testkit run --tag boundary      按标签跑',
  '  /testkit run --allow-model       本次放行 high 档（**真实模型调用**，默认拒绝）',
  '  /testkit run --allow-low-cost    本次放行 low 档（起进程 / 写文件）',
  '  /testkit report [runId]          查看报告',
  '  /testkit export [outDir]         导出为可在 CI 跑的自包含测试文件',
  '  /testkit reload                  重新扫描场景目录',
  '',
  '成本闸门：默认不允许真实模型调用（high 档会被记 skipped 并写明原因）；',
  '放权只有这条路——工具面（模型可调）只能收紧，不能提权。',
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
        'list | run [ids] [--kind k] [--tag t] | report [runId] | export [outDir] | reload | issue <open|show|approve|reject|close>',
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

            const summary = await runScenarios({
              registry: deps.registry,
              drivers: deps.drivers,
              host: deps.host,
              filter: selection.filter,
              signal,
              policy,
            })
            const write = await writeRunArtifacts(summary, deps.runsDir())
            const t = summary.totals
            const lines = [
              `Run ${summary.runId} — 合计 ${t.total}：✅ ${t.passed} · ❌ ${t.failed} · ⏭️ ${t.skipped} · 💥 ${t.errored}`,
              describePolicy(summary),
            ]
            for (const c of summary.cases.filter((x) => x.verdict !== 'passed')) {
              const why = c.error ?? c.skipReason ?? '存在未通过断言'
              const category =
                c.failureCategory === undefined ? '' : `［${FAILURE_CATEGORY_LABEL[c.failureCategory]}］`
              lines.push(`  ${c.verdict === 'skipped' ? '⏭️' : c.verdict === 'failed' ? '❌' : '💥'} ${c.id} ${c.title} — ${why}${category}`)
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

          case 'export': {
            const selected = deps.registry.filter({ status: ['active'] })
            if (selected.length === 0) {
              return { kind: 'error', text: '没有可导出的 active 场景' }
            }
            try {
              const { join } = await import('node:path')
              const { exportScenariosToFile } = await import('./export/write.js')
              const result = await exportScenariosToFile({
                scenarios: selected,
                casesDir: deps.registry.dir,
                outDir: argv[0] ?? deps.exportDir(),
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
  error?: string
}

function parseSelection(argv: string[]): SelectionResult {
  const ids: string[] = []
  const kinds: string[] = []
  const tags: string[] = []
  const overrides: { allowModel?: boolean; allowLowCost?: boolean } = {}

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!
    if (token === '--kind' || token === '-k') {
      const value = argv[i + 1]
      if (!value) return { filter: { status: ['active'] }, error: '--kind 需要一个值' }
      kinds.push(value)
      i += 1
    } else if (token === '--tag' || token === '-t') {
      const value = argv[i + 1]
      if (!value) return { filter: { status: ['active'] }, error: '--tag 需要一个值' }
      tags.push(value)
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

  return {
    filter: {
      ...(ids.length > 0 ? { ids } : {}),
      ...(kinds.length > 0 ? { kinds: kinds as ScenarioKind[] } : {}),
      ...(tags.length > 0 ? { tags } : {}),
      status: ['active'],
    },
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
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
