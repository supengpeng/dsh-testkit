/**
 * touchstone 三阶段适配器的回归网。
 *
 * 三个阶段**各自独立验收**（见 docs/TOUCHSTONE.md）：
 *
 *   阶段一（输出）：`run.json` → `bug_report/<CASE-ID>/…` 结构完整可解析；
 *                  severity 规则表逐格钉住；**没导出谁、为什么**必须写在索引里。
 *   阶段二（输入）：`case.md` → 草稿 YAML 过 `validateScenario`、`status: draft`、
 *                  `id: TK-0000`；映射不了的内容原样成注释；**500 行停止线守卫真的会拦**；
 *                  且草稿只能变成 `proposals/` 里的提案——`cases/` 一个字节都不动。
 *   阶段三（回环）：真起服务 → 本地假调用方发请求 → 收到复跑结果 → **worktree 已清理**、
 *                  **主仓 `git status --porcelain` 为零新增**。
 *
 * ## 阶段三为什么用「临时克隆」当被测主仓
 *
 *   · 隔离判据的强度取决于基线干不干净。共享的 dsh-testkit 主仓在多人并行开发中有大量
 *     未提交改动（实测十余个 M 与 `??`），"before == after" 只能证明"零新增"，
 *     证不出"为空"。所以端到端用例 `git clone` 一个**干净检出**当被测主仓，
 *     判据升级为 `git status --porcelain` **真的为空**。
 *   · 克隆里没有 `lib/`（gitignore），所以复跑显式传 `libDir = 主仓/lib`：
 *     被测的是 **worktree 里的场景数据 + 主仓的 runner 产物**（见 docs/TOUCHSTONE.md「已知限界」）。
 *   · 对共享主仓本身只断言"本任务写域与临时目录零新增"——并行队友随时在改别的文件，
 *     拿整仓快照做相等断言会把别人的动作误判成我们的污染。
 *
 * ## 临时目录
 *
 * 优先 `os.tmpdir()`；宿主沙箱若拦住 workspace 外写入（Access denied），
 * 退回 workspace 内的 `.tmp-touchstone-tests/`（用完即删，不留痕）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { buildMinimalRepro } from '../lib/analysis/repro.js'
import { validateScenario } from '../lib/cases/schema.js'
import { PipelineStore } from '../lib/pipeline/store.js'
import {
  decideSeverity,
  exportBugReports,
  loadRunSummary,
  planBugReports,
} from '../lib/touchstone/export.js'
import {
  CONVERTER_STOP_LINE,
  assertConverterWithinStopLine,
  converterLineCount,
  parseCaseMd,
  proposeCase,
} from '../lib/touchstone/import.js'
import {
  RERUN_SCRIPT_MARKER,
  TOUCHSTONE_ROUTE,
  generateRerunScript,
  parseRerunPayload,
  selectAffectedScenarios,
  startWebhook,
} from '../lib/touchstone/webhook.js'

const WORKSPACE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_FALLBACK_TMP = join(WORKSPACE, '.tmp-touchstone-tests')
const ISSUE = 'https://github.com/FuRongJun-1999/dsh-memory/issues/57'

/** 建临时目录：优先 `os.tmpdir()`，被沙箱拦时退回 workspace 内（用完即删）。 */
function makeTempDir(prefix) {
  const errors = []
  for (const root of [tmpdir(), WORKSPACE_FALLBACK_TMP]) {
    try {
      mkdirSync(root, { recursive: true })
      return mkdtempSync(join(root, prefix))
    } catch (error) {
      errors.push(`${root}: ${error?.message ?? error}`)
    }
  }
  throw new Error(`无法创建临时目录：${errors.join(' | ')}`)
}

/** 清掉可能被 fallback 创建的 workspace 内临时根（否则会留在 git status 里）。 */
function cleanupWorkspaceTmp() {
  rmSync(WORKSPACE_FALLBACK_TMP, { recursive: true, force: true })
}

const norm = (path) => String(path ?? '').replace(/\\/g, '/')

function porcelain(repo) {
  const result = spawnSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git status 失败：${result.stderr}`)
  return (result.stdout ?? '').replace(/\r\n/g, '\n').trimEnd()
}

function porcelainLines(repo) {
  return porcelain(repo) === '' ? [] : porcelain(repo).split('\n')
}

function listWorktrees(repo) {
  const result = spawnSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git worktree list 失败：${result.stderr}`)
  return (result.stdout ?? '')
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => norm(line.slice('worktree '.length)))
    .sort()
}

/** 建 junction（Windows 不需要管理员权限）；失败返回 false，由调用方决定是否硬判。 */
function linkJunction(target, linkPath) {
  if (existsSync(linkPath)) return true
  if (!existsSync(target)) return false
  if (process.platform !== 'win32') {
    try {
      symlinkSync(target, linkPath, 'dir')
      return true
    } catch {
      return false
    }
  }
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, target], { encoding: 'utf8' })
  return result.status === 0 && existsSync(linkPath)
}

/** 干净检出当被测主仓（隔离判据才能是"真的为空"）。 */
function makeScratchRepo(scratch) {
  const repo = join(scratch, 'repo')
  const clone = spawnSync('git', ['clone', '--quiet', '--no-hardlinks', WORKSPACE, repo], {
    encoding: 'utf8',
  })
  assert.equal(clone.status, 0, `git clone 失败：${clone.stderr}`)
  const linked = linkJunction(join(WORKSPACE, 'node_modules'), join(repo, 'node_modules'))
  assert.equal(porcelain(repo), '', '克隆出来就该是干净的')
  return { repo, linked }
}

/* ============================================================ 阶段一：export */

function makeCase(overrides = {}) {
  return {
    id: 'TK-0100',
    title: '示例失败场景',
    kind: 'shell',
    verdict: 'failed',
    durationMs: 12,
    steps: [
      {
        name: '跑一条命令',
        action: { kind: 'shell', ok: true, detail: 'exit 1' },
        durationMs: 10,
        assertions: [
          {
            assertion: { ref: 'fx.exitCode', is: 0 },
            ok: false,
            actual: 1,
            message: '期望 0，实际 1',
            soft: false,
          },
        ],
      },
    ],
    notes: { stdout: 'boom' },
    releaseFailures: [],
    sourceIssue: ISSUE,
    owner: '@alice',
    // 现实里 failed 绝大多数都带归因；这里当默认值，个别用例再显式覆盖
    failureCategory: 'product_bug',
    ...overrides,
  }
}

function makeSummary(cases, overrides = {}) {
  const totals = { total: cases.length, passed: 0, failed: 0, skipped: 0, errored: 0 }
  for (const item of cases) totals[item.verdict] += 1
  return {
    runId: 'RUN-TEST-0001',
    startedAt: '2026-10-10T00:00:00.000Z',
    finishedAt: '2026-10-10T00:00:03.000Z',
    casesDir: '/fake/cases',
    dshVersion: 'test-0.0.0',
    platform: 'test',
    totals,
    cases,
    ...overrides,
  }
}

test('阶段一：severity 规则表逐格钉住（含"不产出修复任务"的三类）', () => {
  assert.equal(decideSeverity('product_bug', 'high').severity, 'high')
  assert.equal(decideSeverity('product_bug', 'medium').severity, 'medium')
  assert.equal(decideSeverity('product_bug', 'low').severity, 'low')
  assert.equal(decideSeverity('product_bug', undefined).severity, 'medium')
  assert.equal(decideSeverity('flaky', 'high').severity, 'low')

  for (const category of ['case_bug', 'driver_bug', 'env']) {
    const decision = decideSeverity(category, 'high')
    assert.equal(decision.severity, 'none', `${category} 不该产出修复任务`)
    assert.equal(decision.actionable, false)
    assert.ok(decision.reason.length > 0, `${category} 必须说明为什么不产出`)
  }

  // 无归因（老 run.json）保守导出：没有归因 ≠ 没有缺陷
  assert.equal(decideSeverity(undefined, 'high').severity, 'high')
  assert.equal(decideSeverity(undefined, undefined).severity, 'medium')
})

test('阶段一：只导出 failed/errored，未导出的一律写清原因', () => {
  const cases = [
    makeCase({ id: 'TK-0100', failureCategory: 'product_bug' }),
    makeCase({ id: 'TK-0101', failureCategory: 'flaky' }),
    makeCase({ id: 'TK-0102', verdict: 'errored', error: 'driver 尚未实现', failureCategory: 'driver_bug' }),
    makeCase({ id: 'TK-0103', verdict: 'passed', failureCategory: undefined }),
    makeCase({ id: 'TK-0104', verdict: 'skipped', skipReason: '宿主缺少能力：subprocess' }),
    makeCase({ id: 'TK-0105', failureCategory: 'case_bug' }),
  ]
  const plan = planBugReports(makeSummary(cases), {
    scenarioSeverity: (id) => (id === 'TK-0100' ? 'high' : id === 'TK-0101' ? 'medium' : undefined),
    now: '2026-10-10T01:00:00.000Z',
  })

  assert.deepEqual(
    plan.exported.map((r) => r.caseId),
    ['TK-0100', 'TK-0101'],
  )
  assert.equal(plan.exported[0].severity, 'high')
  assert.equal(plan.exported[1].severity, 'low')

  const skipped = new Map(plan.skipped.map((s) => [s.caseId, s]))
  assert.deepEqual([...skipped.keys()].sort(), ['TK-0102', 'TK-0103', 'TK-0104', 'TK-0105'])
  for (const item of skipped.values()) assert.equal(item.severity, 'none')
  assert.match(skipped.get('TK-0103').reason, /不是 bug/)
  assert.match(skipped.get('TK-0104').reason, /没跑过/)
  assert.match(skipped.get('TK-0104').reason, /subprocess/)
  assert.match(skipped.get('TK-0105').reason, /用例写错/)
  assert.match(skipped.get('TK-0102').reason, /引擎|驱动/)

  // 索引里必须逐条写出"没导出谁、为什么"——静默丢弃是被禁止的
  assert.match(plan.indexMarkdown, /未导出/)
  for (const id of ['TK-0102', 'TK-0103', 'TK-0104', 'TK-0105']) {
    assert.ok(plan.indexMarkdown.includes(id), `索引里缺 ${id} 的未导出说明`)
  }
})

test('阶段一：产物结构完整、可被解析，且复现命令复用 repro.ts 口径', async () => {
  const root = makeTempDir('tk-export-')
  const outDir = join(root, 'bug_report')
  try {
    const failing = makeCase()
    const summary = makeSummary([failing, makeCase({ id: 'TK-0103', verdict: 'passed' })])
    const result = await exportBugReports({
      source: summary,
      outDir,
      scenarioSeverity: () => 'high',
      now: '2026-10-10T01:00:00.000Z',
    })

    assert.equal(result.exported.length, 1)
    const dir = join(outDir, 'TK-0100')
    assert.deepEqual(result.exported[0].files, [
      'TK-0100/evidence/logs.txt',
      'TK-0100/evidence/trace.json',
      'TK-0100/report.md',
      'TK-0100/repro.yaml',
      'TK-0100/severity.txt',
    ])
    for (const rel of result.exported[0].files) {
      assert.ok(existsSync(join(outDir, rel)), `缺产物 ${rel}`)
    }

    // severity.txt 必须是单行 low|medium|high
    assert.equal(readFileSync(join(dir, 'severity.txt'), 'utf8'), 'high\n')

    // repro.yaml：命令原样来自 src/analysis/repro.ts，绝不另发明一套
    const repro = parseYaml(readFileSync(join(dir, 'repro.yaml'), 'utf8'))
    assert.equal(repro.caseId, 'TK-0100')
    assert.equal(repro.severity, 'high')
    assert.equal(repro.failingStep.index, 0)
    assert.equal(repro.failingStep.name, '跑一条命令')
    assert.equal(
      repro.commands,
      buildMinimalRepro({ caseId: 'TK-0100', failingStepIndex: 0, failingStepName: '跑一条命令' }),
    )

    // trace.json：原始 CaseOutcome 取证
    const trace = JSON.parse(readFileSync(join(dir, 'evidence/trace.json'), 'utf8'))
    assert.equal(trace.caseId, 'TK-0100')
    assert.equal(trace.case.id, 'TK-0100')
    assert.equal(trace.case.failureCategory, 'product_bug')
    assert.equal(trace.case.steps[0].assertions[0].actual, 1)

    // logs.txt：人可以直接读的平铺日志
    const logs = readFileSync(join(dir, 'evidence/logs.txt'), 'utf8')
    assert.match(logs, /FAIL/)
    assert.match(logs, /fx\.exitCode/)
    assert.match(logs, /跑一条命令/)

    // report.md：现象 / 期望 / 实际 / 最小复现
    const report = readFileSync(join(dir, 'report.md'), 'utf8')
    assert.match(report, /现象/)
    assert.match(report, /fx\.exitCode/)
    assert.match(report, /testkit_run/)
    assert.match(report, /severity\.txt = high/)

    // 未导出的 passed 不落目录，但有说明
    assert.equal(existsSync(join(outDir, 'TK-0103')), false)
    const index = readFileSync(result.indexFile, 'utf8')
    assert.match(index, /TK-0103/)
    assert.match(index, /不是 bug/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    cleanupWorkspaceTmp()
  }
})

test('阶段一：run.json 路径入口 + 坏输入给明确错误', () => {
  const root = makeTempDir('tk-export-run-')
  try {
    const path = join(root, 'run.json')
    writeFileSync(path, JSON.stringify(makeSummary([makeCase()])), 'utf8')
    assert.equal(loadRunSummary(path).runId, 'RUN-TEST-0001')

    const broken = join(root, 'broken.json')
    writeFileSync(broken, '{ not json', 'utf8')
    assert.throws(() => loadRunSummary(broken), /无法读取\/解析/)

    const noShape = join(root, 'noshape.json')
    writeFileSync(noShape, JSON.stringify({ hello: 1 }), 'utf8')
    assert.throws(() => loadRunSummary(noShape), /缺少 runId \/ cases/)

    // 逐条体检：形状不对要给"哪一条、缺什么"，而不是让渲染阶段抛 TypeError
    const badCase = join(root, 'badcase.json')
    writeFileSync(badCase, JSON.stringify({ runId: 'R', cases: [{ id: 'TK-0001' }] }), 'utf8')
    assert.throws(() => loadRunSummary(badCase), /TK-0001.*缺少 steps/)
  } finally {
    rmSync(root, { recursive: true, force: true })
    cleanupWorkspaceTmp()
  }
})

/* ============================================================ 阶段二：import */

const CASE_MD = `---
title: 保留设备名守卫必须末端直判
kind: shell
severity: high
tags: [windows, device-name]
owner: "@alice"
---

# 保留设备名守卫

## 症状
\`os.path.abspath\` 在 Windows 上会把末段是保留设备名的路径归一进设备命名空间，旧守卫随之失效。

## 期望
守卫判据必须直接判末段，而不是依赖归一化结果。

## 实际
归一后回落成 \`\\.\\aux\`，被静默接受。

## 复现步骤
1. git clone https://github.com/FuRongJun-1999/dsh-memory.git
2. python -X utf8 -m md_cg.test_datapath_device_name

\`\`\`bash
python -X utf8 -m md_cg.test_datapath_device_name
\`\`\`

## 来源
${ISSUE}

## 讨论
这一段没有任何字段可放：它必须原样保留成 YAML 注释。
`

test('阶段二：case.md → 草稿 YAML，过 validateScenario、status=draft、id=占位值', () => {
  const draft = parseCaseMd(CASE_MD)
  assert.equal(draft.validation.ok, true, `草稿未通过校验：${JSON.stringify(draft.validation.issues)}`)

  // 独立再校验一遍（不信任转换器自己报的结论）
  const parsed = parseYaml(draft.yaml)
  const checked = validateScenario(parsed, 'TK-0000.yaml', { allowIdMismatch: true })
  assert.equal(checked.ok, true, JSON.stringify(checked.issues))

  assert.equal(parsed.schema, 1)
  assert.equal(parsed.id, 'TK-0000')
  assert.equal(parsed.status, 'draft')
  assert.equal(parsed.kind, 'shell')
  assert.equal(parsed.severity, 'high')
  assert.deepEqual(parsed.tags, ['windows', 'device-name'])
  assert.equal(parsed.owner, '@alice')
  assert.equal(parsed.source.issue, ISSUE)
  assert.ok(parsed.title.length <= 60)
  assert.match(parsed.source.summary, /症状/)
  assert.match(parsed.source.summary, /期望/)
  assert.match(parsed.source.summary, /实际/)
  assert.match(parsed.source.summary, /复现步骤/)

  // 判据不猜：只有占位步骤 + TODO(人工)，因此**必须**过不了闸门那一关
  assert.equal(parsed.steps.length, 1)
  assert.match(parsed.steps[0].act.shell.argv.join(' '), /TODO\(人工\)/)
  assert.equal(parsed.steps[0].expect, undefined)

  // 映射不了的内容原样保留成注释（不丢信息）
  assert.match(draft.yaml, /^# ## 讨论$/m)
  assert.match(draft.yaml, /^# 这一段没有任何字段可放/m)
  assert.equal(draft.unmapped.length, 1)
  assert.ok(draft.facts.reproSteps.length >= 2)
})

test('阶段二：front matter 已给结构化 steps → 原样透传（不做语义推断）', () => {
  const md = `---
title: 结构透传样例
kind: file
source: ${ISSUE}
steps:
  - name: 读文件
    act: { file: { read: package.json } }
    expect:
      - { ref: fx.fileExists, is: true }
---
## 症状
透传即可，转换器不改判据。
`
  const draft = parseCaseMd(md)
  const parsed = parseYaml(draft.yaml)
  assert.equal(draft.validation.ok, true)
  assert.equal(parsed.kind, 'file')
  assert.equal(parsed.steps.length, 1)
  assert.deepEqual(parsed.steps[0].expect, [{ ref: 'fx.fileExists', is: true }])
  assert.match(draft.notes.join('\n'), /原样结构透传/)
})

test('阶段二：转换器 500 行停止线守卫有效（超限必须报错）', () => {
  const lines = assertConverterWithinStopLine()
  assert.equal(lines, converterLineCount())
  assert.ok(lines <= CONVERTER_STOP_LINE, `转换器 ${lines} 行已超停止线 ${CONVERTER_STOP_LINE}`)

  assert.throws(
    () => assertConverterWithinStopLine(1),
    /转换器已超停止线[\s\S]*停止自动转换，改人工转换/,
  )
})

test('阶段二：草稿只能变成 proposals/ 里的提案，cases/ 一个字节都不动', () => {
  const root = makeTempDir('tk-import-')
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })
    const proposalsDir = join(pipelineDir, 'proposals')

    const draft = parseCaseMd(CASE_MD)

    // ① 没有 open 批次：连提案都不落盘（要不要提炼由人决定）
    const refused = proposeCase({ yamlText: draft.yaml, pipelineDir, casesDir, notes: 'T8 阶段二' })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /未开启/)
    assert.equal(existsSync(proposalsDir), false)
    assert.deepEqual(readdirSync(casesDir), [])

    // ② 人来开批次（模拟 /testkit issue open）
    assert.equal(store.open('touchstone 导入的一条').ok, true)

    // ③ 判据没写死的草稿：闸门必须拦下（TODO + 无断言），仍然不落盘
    const blocked = proposeCase({ yamlText: draft.yaml, pipelineDir, casesDir })
    assert.equal(blocked.ok, false)
    assert.match(blocked.error, /质量预检/)
    assert.ok(
      (blocked.findings ?? []).some((f) => f.level === 'block'),
      '必须给出阻断理由',
    )
    assert.equal(existsSync(proposalsDir) ? readdirSync(proposalsDir).length : 0, 0)

    // ④ 人把判据写死（这里用「解析 → 改 steps → 重新序列化」模拟人工补完）
    const scenario = parseYaml(draft.yaml)
    scenario.steps = [
      {
        name: '跑一条命令',
        act: { shell: { argv: ['echo', 'hi'] } },
        expect: [{ ref: 'fx.exitCode', is: 0 }],
      },
    ]
    const completed = stringifyYaml(scenario, { lineWidth: 0 })

    const accepted = proposeCase({ yamlText: completed, pipelineDir, casesDir, notes: '人工补完判据' })
    assert.equal(accepted.ok, true, JSON.stringify(accepted.findings ?? accepted.error))
    assert.equal(accepted.proposalId, 'P-0001')
    assert.equal(accepted.status, 'draft')

    // 关键纪律：落地物只在 proposals/，cases/ 仍然空
    const batchDir = join(proposalsDir, accepted.batchId)
    assert.equal(readdirSync(batchDir).length, 1)
    assert.match(readdirSync(batchDir)[0], /^P-0001-/)
    assert.deepEqual(readdirSync(casesDir), [])

    // 提案正文里 id 仍是占位值（正式 TK 号只能由 approve 分配）
    const proposalText = readFileSync(join(pipelineDir, accepted.relPath), 'utf8')
    assert.match(proposalText, /^id: TK-0000$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
    cleanupWorkspaceTmp()
  }
})

/* ============================================================ 阶段三：webhook */

test('阶段三：复跑脚本与结果解析（纯函数）', () => {
  const script = generateRerunScript({
    libDir: join(WORKSPACE, 'lib'),
    casesDir: join(WORKSPACE, 'cases'),
    caseIds: ['TK-0020'],
    outDir: join(WORKSPACE, 'export'),
    generatedAt: '2026-10-10T00:00:00.000Z',
    worktree: 'C:/tmp/wt',
  })
  assert.match(script, /createHeadlessHost/)
  assert.match(script, /resolvePolicy\(\{\}\)/) // 不烧钱是结构保证
  assert.ok(script.includes(RERUN_SCRIPT_MARKER))
  assert.match(script, /TK-0020/)

  const payload = parseRerunPayload(
    `chatter\n${RERUN_SCRIPT_MARKER}{"ok":true,"runId":"R1","totals":{"total":1}}\n`,
  )
  assert.deepEqual(payload, { ok: true, runId: 'R1', totals: { total: 1 } })
  assert.equal(parseRerunPayload('没有标记'), undefined)

  // 跨盘符（相对说明符会算成 `./C:\...`）必须明确报错，而不是生成一个跑不起来的脚本
  assert.throws(
    () =>
      generateRerunScript({
        libDir: 'Z:\\elsewhere\\lib',
        casesDir: join(WORKSPACE, 'cases'),
        caseIds: ['TK-0020'],
        outDir: join(WORKSPACE, 'export'),
      }),
    /同一盘符/,
  )
})

test('阶段三：增量选择未就绪时软失败——明确错误 + 退回全量，不崩', async () => {
  const selection = await selectAffectedScenarios({
    changedFiles: ['src/runtime/runner.ts'],
    repoDir: WORKSPACE,
    casesDir: join(WORKSPACE, 'cases'),
    specifier: '../selection/definitely-not-there.js',
  })
  assert.equal(selection.mode, 'all')
  assert.ok(selection.caseIds.length > 0)
  assert.match(selection.degraded, /import 失败/)
  assert.match(selection.detail, /退回全量/)
})

test('阶段三：增量选择接口形状可用（T4 就绪时走真实选择，未就绪则退让并自证）', async () => {
  const casesDir = join(WORKSPACE, 'cases')
  // 内核路径：要么命中一批，要么退让成全量——两种都必须"可用"
  const universe = await selectAffectedScenarios({
    changedFiles: ['src/runtime/runner.ts'],
    repoDir: WORKSPACE,
    casesDir,
  })
  assert.ok(Array.isArray(universe.caseIds))
  assert.ok(universe.caseIds.length > 0, `内核路径至少该命中一批：${JSON.stringify(universe)}`)
  assert.ok(universe.detail.length > 0)

  // 纯文档改动：选中集合必须是全集的子集，且（精确选择时）一条都不该命中
  const docsOnly = await selectAffectedScenarios({
    changedFiles: ['docs/TOUCHSTONE.md'],
    repoDir: WORKSPACE,
    casesDir,
  })
  assert.ok(['affected', 'all'].includes(docsOnly.mode), `意外模式：${docsOnly.mode}`)
  assert.ok(
    docsOnly.caseIds.every((id) => universe.caseIds.includes(id)),
    `选出的场景必须都在全集里：${JSON.stringify(docsOnly.caseIds)}`,
  )
  if (docsOnly.mode === 'all') {
    assert.ok(docsOnly.degraded, '退回全量必须给出降级说明')
  } else {
    assert.match(docsOnly.detail, /选中/)
    assert.equal(docsOnly.caseIds.length, 0, '纯文档改动不该触发复跑')
  }
})

test('阶段三端到端：起服务 → 假调用方 → worktree 隔离复跑 → 回传 → 主仓为空且 worktree 已清理', async () => {
  const scratch = makeTempDir('tk-e2e-')
  const mainStatusBefore = porcelain(WORKSPACE)
  const hits = []
  const events = []
  const handle_ = { value: null }
  const callback = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      hits.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })

  try {
    const { repo, linked } = makeScratchRepo(scratch)

    await new Promise((done) => callback.listen(0, '127.0.0.1', done))
    const callbackUrl = `http://127.0.0.1:${callback.address().port}/hook`

    const handle = await startWebhook({
      port: 0,
      repoDir: repo,
      libDir: join(WORKSPACE, 'lib'),
      onFixComplete: (event) => {
        events.push(event)
      },
    })
    handle_.value = handle
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}${TOUCHSTONE_ROUTE}`)

    const response = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        changedFiles: ['src/runtime/runner.ts'],
        caseIds: ['TK-0020'],
        ref: 'HEAD',
        callbackUrl,
      }),
    })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    const value = body.value

    // 未给 token：必须说明这是本机通道
    assert.equal(value.auth.mode, 'none')
    assert.match(value.auth.warning, /127\.0\.0\.1/)
    assert.match(value.auth.warning, /不做鉴权/)

    // 显式点名优先于增量选择
    assert.equal(value.selection.mode, 'explicit')
    assert.deepEqual(value.selection.caseIds, ['TK-0020'])

    // 真的在 worktree 里跑出了结果（结果必须"有结论"，不许静默不跑）
    assert.equal(value.rerun.totals.total, 1)
    assert.equal(value.rerun.cases.length, 1)
    const outcome = value.rerun.cases[0]
    assert.equal(outcome.id, 'TK-0020')
    assert.ok(['passed', 'failed', 'skipped', 'errored'].includes(outcome.verdict))
    assert.ok(outcome.durationMs >= 0)
    if (outcome.verdict !== 'passed') {
      assert.ok(
        outcome.error !== undefined || outcome.skipReason !== undefined,
        `非 passed 必须给原因：${JSON.stringify(outcome)}`,
      )
    }
    assert.ok(
      value.rerun.notes.some((note) => note.includes('worktree')),
      `notes 应记录 worktree：${JSON.stringify(value.rerun.notes)}`,
    )

    // node_modules 是 junction 接进去的（测试若没能建 junction，则不硬判）
    assert.ok(['junction', 'none', 'failed'].includes(value.rerun.nodeModules))
    if (linked) assert.equal(value.rerun.nodeModules, 'junction')

    // 隔离硬约束：worktree 已清理 + 被测主仓为空
    assert.equal(value.rerun.worktreeRemoved, true)
    assert.ok(value.rerun.worktree, '必须记录临时 worktree 路径')
    assert.equal(existsSync(value.rerun.worktree), false)
    assert.equal(value.rerun.repoStatusAfter, '')
    assert.equal(porcelain(repo), '', '复跑后被测主仓必须仍然为空（git status --porcelain）')
    assert.deepEqual(listWorktrees(repo), [norm(repo)], 'git worktree list 里不该残留临时 worktree')

    // 结果回传到本地假调用方
    assert.equal(value.callback.sent, true)
    assert.equal(value.callback.status, 200)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].ok, true)
    assert.equal(hits[0].runId, value.rerun.runId)
    assert.equal(hits[0].worktreeRemoved, true)
    assert.equal(hits[0].cases[0].id, 'TK-0020')

    // 宿主的 onFixComplete 也被叫到
    assert.equal(events.length, 1)
    assert.equal(events[0].result.runId, value.rerun.runId)
    assert.equal(events[0].error, undefined)

    // 共享主仓只断言"本任务写域 + 临时目录零新增"（并行队友随时在改别的文件）
    const added = porcelainLines(WORKSPACE).filter((line) => !mainStatusBefore.includes(line))
    assert.deepEqual(
      added.filter((line) => /touchstone|\.tmp-touchstone|\.touchstone-worktrees|tk-e2e/.test(line)),
      [],
      `复跑不得往共享主仓里新增相关条目：${JSON.stringify(added)}`,
    )
    assert.equal(existsSync(join(WORKSPACE, '.touchstone-worktrees')), false)
  } finally {
    if (handle_.value) await handle_.value.close()
    await new Promise((done) => callback.close(done))
    rmSync(scratch, { recursive: true, force: true })
    cleanupWorkspaceTmp()
  }
})

test('阶段三：失败可重入——坏 ref 报错后，下一次请求仍能复跑且 worktree 被清理', async () => {
  const scratch = makeTempDir('tk-reentry-')
  try {
    const { repo } = makeScratchRepo(scratch)
    const handle = await startWebhook({ port: 0, repoDir: repo, libDir: join(WORKSPACE, 'lib') })
    try {
      // ① 坏 ref：必须明确失败（而不是"跑了 0 条就算通过"）
      const bad = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseIds: ['TK-0020'], ref: 'refs/heads/definitely-missing-ref' }),
      })
      assert.equal(bad.status, 500)
      const badBody = await bad.json()
      assert.equal(badBody.ok, false)
      assert.equal(badBody.code, 'rerun-failed')
      assert.match(badBody.message, /worktree add 失败/)
      assert.equal(porcelain(repo), '', '失败也不能污染被测主仓')
      assert.deepEqual(listWorktrees(repo), [norm(repo)], '失败路径同样必须清掉 worktree')

      // ② 重入：同一服务、下一次请求必须正常
      const good = await fetch(handle.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caseIds: ['TK-0020'], ref: 'HEAD' }),
      })
      assert.equal(good.status, 200)
      const goodBody = await good.json()
      assert.equal(goodBody.value.rerun.totals.total, 1)
      assert.equal(goodBody.value.rerun.worktreeRemoved, true)
      assert.equal(existsSync(goodBody.value.rerun.worktree), false)
      assert.equal(porcelain(repo), '')
      assert.deepEqual(listWorktrees(repo), [norm(repo)])
    } finally {
      await handle.close()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
    cleanupWorkspaceTmp()
  }
})

test('阶段三：token 鉴权、空选择不建 worktree、路由与方法必须严格', async () => {
  const seen = []
  const stubRerun = async (input) => ({
    runId: 'STUB-1',
    worktree: null,
    worktreeRemoved: true,
    ref: input.ref ?? 'HEAD',
    nodeModules: 'none',
    repoStatusBefore: '',
    repoStatusAfter: '',
    totals: { total: 0, passed: 0, failed: 0, skipped: 0, errored: 0 },
    cases: [],
    notes: ['stub'],
    durationMs: 1,
  })

  const handle = await startWebhook({
    port: 0,
    repoDir: WORKSPACE,
    token: 's3cret',
    rerun: stubRerun,
    selectAffected: () => ({ mode: 'affected', caseIds: [], detail: 'stub：没有受影响场景' }),
    onFixComplete: (event) => {
      seen.push(event)
    },
  })
  try {
    const noToken = await fetch(handle.url, { method: 'POST', body: '{}' })
    assert.equal(noToken.status, 401)
    assert.equal((await noToken.json()).code, 'unauthorized')

    const wrongToken = await fetch(handle.url, {
      method: 'POST',
      headers: { 'x-touchstone-token': 'nope' },
      body: '{}',
    })
    assert.equal(wrongToken.status, 401)

    const notFound = await fetch(`http://127.0.0.1:${handle.port}/other`, { method: 'POST', body: '{}' })
    assert.equal(notFound.status, 404)

    const wrongMethod = await fetch(handle.url, { method: 'GET' })
    assert.equal(wrongMethod.status, 405)

    // 空选择：不建 worktree、不算通过（notes 里要写明），但请求本身是成功的
    const empty = await fetch(handle.url, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret' },
      body: JSON.stringify({ changedFiles: ['docs/README.md'] }),
    })
    assert.equal(empty.status, 200)
    const emptyBody = await empty.json()
    assert.equal(emptyBody.value.selection.caseIds.length, 0)
    assert.equal(emptyBody.value.rerun.totals.total, 0)
    assert.equal(emptyBody.value.auth.mode, 'token')
    assert.equal(seen.length, 1)

    const badJson = await fetch(handle.url, {
      method: 'POST',
      headers: { authorization: 'Bearer s3cret' },
      body: '{ oops',
    })
    assert.equal(badJson.status, 400)
    assert.equal((await badJson.json()).code, 'bad-json')
  } finally {
    await handle.close()
  }
})
