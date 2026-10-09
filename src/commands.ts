/**
 * 人类命令面：`/testkit <子命令>`。
 *
 * 与工具面的区别：命令走 UI、不经过模型，适合"我自己要看一眼"的场景。
 */

import { packageRoot } from './config.js'
import type { CaseRegistry } from './cases/registry.js'
import type { ScenarioKind } from './cases/types.js'
import type { CommandDefinition, DriverRegistry, HostFacade } from './kinds/types.js'
import { writeRunArtifacts } from './report/json.js'
import { runScenarios } from './runtime/runner.js'

export interface CommandDeps {
  registry: CaseRegistry
  drivers: DriverRegistry
  host: HostFacade
  runsDir: () => string
  exportDir: () => string
  defaultTimeoutMs: () => number
  /** 重新扫描 scenes 目录，返回一行人类可读的结论。 */
  reload: () => string
}

const USAGE = [
  '用法：',
  '  /testkit list                    列出全部场景',
  '  /testkit run                     跑全部 active 场景',
  '  /testkit run TK-0001 TK-0002     跑指定场景',
  '  /testkit run --kind tool         按类型跑',
  '  /testkit run --tag boundary      按标签跑',
  '  /testkit report [runId]          查看报告',
  '  /testkit export [outDir]         导出为可在 CI 跑的自包含测试文件',
  '  /testkit reload                  重新扫描场景目录',
].join('\n')

export function defineTestkitCommands(deps: CommandDeps): CommandDefinition[] {
  return [
    {
      name: 'testkit',
      description: 'dsh-testkit：列出 / 运行 / 报告 / 重载测试场景',
      inputHint: 'list | run [ids] [--kind k] [--tag t] | report [runId] | export [outDir] | reload',
      execute: async (rawInput, signal) => {
        const argv = tokenize(rawInput)
        const sub = argv.shift() ?? 'list'

        switch (sub) {
          case 'list':
            return { kind: 'success', text: renderList(deps) }

          case 'run': {
            const selection = parseSelection(argv)
            if (selection.error) return { kind: 'error', text: selection.error }

            const summary = await runScenarios({
              registry: deps.registry,
              drivers: deps.drivers,
              host: deps.host,
              filter: selection.filter,
              signal,
            })
            const write = await writeRunArtifacts(summary, deps.runsDir())
            const t = summary.totals
            const lines = [
              `Run ${summary.runId} — 合计 ${t.total}：✅ ${t.passed} · ❌ ${t.failed} · ⏭️ ${t.skipped} · 💥 ${t.errored}`,
            ]
            for (const c of summary.cases.filter((x) => x.verdict !== 'passed')) {
              const why = c.error ?? c.skipReason ?? '存在未通过断言'
              lines.push(`  ${c.verdict === 'skipped' ? '⏭️' : c.verdict === 'failed' ? '❌' : '💥'} ${c.id} ${c.title} — ${why}`)
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

          case 'help':
          default:
            return { kind: 'success', text: USAGE }
        }
      },
    },
  ]
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
  error?: string
}

function parseSelection(argv: string[]): SelectionResult {
  const ids: string[] = []
  const kinds: string[] = []
  const tags: string[] = []

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
  }
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
