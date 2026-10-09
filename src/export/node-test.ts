/**
 * CI 轨：把场景导出为**自包含**的 `node:test` 文件。
 *
 * ## 为什么叫"自包含"
 *
 * 导出的文件不依赖活宿主：它自带 `createHeadlessHost()`（见 `src/headless/`），
 * 所以在没有 DSH、没有 GUI 的 CI 机器上也能跑。
 *
 * ## 它证明了什么、没证明什么
 *
 * | 证明了 | 没证明 |
 * |---|---|
 * | 场景数据合法、driver 逻辑正确、断言可判定 | 与**真实 DSH** 的交互一致（作用域 / 生命周期 / 真实配置） |
 *
 * 所以 CI 轨是**回归网**，不是活宿主验证的替代品。两者都要有。
 *
 * ## 成本闸门：为什么生成物里要显式写 `policy`
 *
 * 生成的每次运行都显式带上默认闸门（`policy: resolvePolicy({})`，allowModel=false）。
 * 不写就只是"眼下恰好没烧钱"——headless 宿主缺 subagents / compaction 能力，
 * 所以高成本场景碰巧跑不起来；一旦哪天它们在 headless 里可行，CI 就会开始真调模型。
 * 显式带上之后，"CI 轨不烧钱"才是**结构保证**。
 * 代价是这些场景在 CI 里以 `skipped`（成本理由）出现——这是预期，不许静默排除。
 *
 * ## 生成器为什么是纯函数
 *
 * `generateNodeTestFile(scenarios, options) => string`：不碰文件系统、不读时钟。
 * 这样"导出结果长什么样"可以被单测穷举，而不必真的写盘再读回来。
 */

import { relative } from 'node:path'

import type { Scenario } from '../cases/types.js'

export interface ExportOptions {
  /** 场景目录（写进生成文件的绝对路径，保证与文件位置无关）。 */
  casesDir: string
  /** 从生成文件 import 本包 lib 的说明符；缺省 `'../lib/'`（导出文件位于包内 `export/`）。 */
  libSpecifier?: string
  /** 单条场景的超时（毫秒）。 */
  timeoutMs?: number
  /** 生成时间；缺省当前时间（可注入以便测试稳定）。 */
  generatedAt?: string
}

/** 导出文件里 import 的入口（生成器与测试共用同一份事实）。 */
export const EXPORT_IMPORTS = [
  'cases/registry.js',
  'executor/policy.js',
  'headless/index.js',
  'kinds/index.js',
  'runtime/runner.js',
] as const

/** 生成一个自包含的 `node:test` 文件。 */
export function generateNodeTestFile(
  scenarios: readonly Scenario[],
  options: ExportOptions,
): string {
  const lib = options.libSpecifier ?? '../lib/'
  const timeoutMs = options.timeoutMs ?? 30_000
  const generatedAt = options.generatedAt ?? new Date().toISOString()

  const imports = EXPORT_IMPORTS.map((path) => {
    const symbol = IMPORT_SYMBOLS[path]
    return `import { ${symbol} } from ${JSON.stringify(`${lib}${path}`)}`
  })

  const body = scenarios.map((s) => renderCase(s)).join('\n\n')

  return `/**
 * 由 dsh-testkit 自动生成 —— 请勿手改。
 *
 * 运行：node --test <本文件>
 * 生成时间：${generatedAt}
 * 场景数：${scenarios.length}
 * 场景目录：${options.casesDir}
 *
 * 本文件自带 headless 宿主，因此不依赖 DSH 运行时。
 * 它验证的是「场景数据 + driver 逻辑」，**不**替代活宿主验证
 * （作用域 / 生命周期 / 真实配置只能在活宿主上暴露）。
 *
 * ## 成本闸门（CI 轨结构上不可能烧钱）
 *
 * 本文件**显式**给每次运行带上默认闸门：\`policy: resolvePolicy({})\`
 * （即 allowModel=false、allowLowCost=true）。省略 policy 等于"不启用闸门"，
 * 那就只是"眼下恰好没烧钱"（headless 缺 subagents / compaction 能力），
 * 而不是结构上的保证——显式写下来才是后者。
 *
 * 于是 high 档场景（agent 派生真实子 agent、compaction 真压缩）在这里会以
 * **skipped + 成本理由**收场。这是**预期结果，不是漏跑**，更不要为了"看起来全绿"
 * 把它们从生成物里静默删掉：跳过本身就是要被看见的信息。
 * 要看这些场景，去活宿主跑 \`/testkit run <id> --allow-model\`。
 *
 * 另外：本文件**不**替使用者做成本决策。它只沿用默认闸门；
 * 想在 CI 里真的跑 high 档，得由人显式给出放权策略。
 */

import assert from 'node:assert/strict'
import { after, test } from 'node:test'

${imports.join('\n')}

const CASES_DIR = ${JSON.stringify(options.casesDir)}

const registry = new CaseRegistry(CASES_DIR)
registry.reload()

const drivers = createDriverRegistry()
const headless = await createHeadlessHost()

after(async () => {
  await headless.dispose()
})

async function runScenario(id) {
  const summary = await runScenarios({
    registry,
    drivers,
    host: headless.host,
    filter: { ids: [id] },
    defaultTimeoutMs: ${timeoutMs},
    // 成本闸门：CI 轨也**显式**带默认策略（allowModel=false）。省略 policy = 不启用闸门，
    // 那是"眼下恰好没烧钱"；显式带上是"结构上不可能烧钱"。
    policy: resolvePolicy({}),
  })
  return { outcome: summary.cases[0], runId: summary.runId }
}

${body}
`
}

/** 每条场景生成一个 test()。 */
function renderCase(scenario: Scenario): string {
  const id = JSON.stringify(scenario.id)
  const name = JSON.stringify(`${scenario.id} ${scenario.title}`)
  const requires = scenario.runtime?.requires ?? []

  return `test(${name}, async (t) => {
  const { outcome } = await runScenario(${id})
  assert.ok(outcome, '场景 ${scenario.id} 未被选中（检查 id 与 status）')

  // 宿主缺少所需能力时记为 skipped —— 与内置 runner 的语义一致。
  // 用 t.skip() 而不是让断言失败：否则"这台机器上没这个能力"会被误报成"用例坏了"。
  if (outcome.verdict === 'skipped') {
    t.skip(outcome.skipReason ?? '宿主缺少所需能力')
    return
  }

  assert.equal(
    outcome.verdict,
    'passed',
    [
      \`场景 ${scenario.id} 未通过（kind=${scenario.kind}${
        requires.length > 0 ? `，requires=${requires.join(',')}` : ''
      }）\`,
      outcome.error ? \`错误：\${outcome.error}\` : '',
      outcome.skipReason ? \`跳过原因：\${outcome.skipReason}\` : '',
      ...outcome.steps.map((step) =>
        [
          \`  步骤：\${step.name}\`,
          ...step.assertions
            .filter((a) => !a.ok)
            .map((a) => \`    ✗ \${a.assertion.ref} → \${a.message}\`),
        ].join('\\n'),
      ),
    ]
      .filter(Boolean)
      .join('\\n'),
  )
})`
}

/** 每个 lib 入口需要导入的符号。 */
const IMPORT_SYMBOLS: Record<string, string> = {
  'cases/registry.js': 'CaseRegistry',
  'executor/policy.js': 'resolvePolicy',
  'headless/index.js': 'createHeadlessHost',
  'kinds/index.js': 'createDriverRegistry',
  'runtime/runner.js': 'runScenarios',
}

/**
 * 由「导出目录」与「lib 目录」推导可用的 import 说明符。
 *
 * 生成的文件可能被放到包内、包外的 CI 目录、甚至别的仓库里，
 * 所以不能写死 `../lib/`——必须相对导出位置算。
 */
export function toLibSpecifier(exportDir: string, libDir: string): string {
  const rel = relative(exportDir, libDir).replace(/\\/g, '/')
  if (rel === '') return './'
  return rel.startsWith('.') ? `${rel}/` : `./${rel}/`
}
