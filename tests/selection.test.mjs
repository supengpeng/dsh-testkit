/**
 * 增量测试选择的单测。
 *
 * 重点不在"能不能跑"，而在**判定规则的三档取向**：
 *   ① 认得出来的 → 精确命中；
 *   ② 明确无关的 → 一条都不命中（反例必须成立，否则"改个 README 全量重跑"）；
 *   ③ 内核与认不出来的 → 保守命中全部（宁可多跑，不可漏跑）。
 *
 * git 相关用例在**临时仓库**里跑：不依赖本仓的提交历史（那会随协作者的提交而漂移）。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  affectedScenarios,
  benchmarkSelection,
  changedFilesSince,
  makeSelectionRecord,
  selectByDshVersion,
} from '../lib/selection/index.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/* --------------------------------------------------------------- 样例数据 -- */

function scenario(id, extra = {}) {
  return {
    schema: 1,
    id,
    title: `${id} 示例`,
    kind: 'tool',
    source: { issue: null },
    setup: {},
    steps: [{ name: '一步', expect: [] }],
    ...extra,
  }
}

const LLM_ONLY = scenario('TK-1001', { kind: 'llm', setup: { llm: { respond: {} } } })
const TOOL_ONLY = scenario('TK-1002')
const COMBO = scenario('TK-1003', { setup: { llm: { respond: {} } } })
const USES_STEP = scenario('TK-1004', {
  kind: 'session',
  steps: [{ name: '复用片段', use: 'invoke/tool', with: {} }],
})
const DECLARES_FIXTURE = scenario('TK-1005', { kind: 'prompt', fixtures: ['llm/timeout'] })

const SCENARIOS = [LLM_ONLY, TOOL_ONLY, COMBO, USES_STEP, DECLARES_FIXTURE]

function ids(files, input = {}) {
  return affectedScenarios(files, { scenarios: SCENARIOS, ...input }).matched
}

function allIds() {
  return SCENARIOS.map((s) => s.id)
}

/* ------------------------------------------------------- affectedScenarios -- */

test('affectedScenarios：kind 实现变化只命中用到该 kind 的场景（含组合场景）', () => {
  assert.deepEqual(ids(['src/kinds/llm.ts']), ['TK-1001', 'TK-1003'])
  assert.deepEqual(ids(['src/kinds/tool.ts']), ['TK-1002', 'TK-1003'])
  assert.deepEqual(ids(['src/kinds/session.ts']), ['TK-1004'])
  assert.deepEqual(ids(['src/kinds/prompt.ts']), ['TK-1005'])
  // 没有场景用到的 kind：认得出，但不影响任何场景
  assert.deepEqual(ids(['src/kinds/compaction.ts']), [])
})

test('affectedScenarios：内核路径一律命中全部场景', () => {
  for (const file of [
    'src/adapters/dsh/tools.ts',
    'src/runtime/runner.ts',
    'src/cases/types.ts',
    'src/executor/policy.ts',
  ]) {
    assert.deepEqual(ids([file]), allIds(), `${file} 应命中全部`)
    assert.match(affectedScenarios([file], { scenarios: SCENARIOS }).reason, /内核/)
  }
  // kind 注册表 / 类型真源不是"某一个 kind"，同样全选
  assert.deepEqual(ids(['src/kinds/index.ts']), allIds())
  assert.deepEqual(ids(['src/kinds/types.ts']), allIds())
})

test('affectedScenarios：反例——tests/ docs/ *.md README LICENSE .github/ 不影响任何场景', () => {
  const cases = [
    ['tests/selection.test.mjs'],
    ['tests/contracts/x.test.mjs'],
    ['docs/SCENARIO-SPEC.md'],
    ['README.md'],
    ['CHANGELOG.md'],
    ['LICENSE'],
    ['README'],
    ['.github/workflows/ci.yml'],
    ['cases/README.md'],
    ['fixtures/llm/README.md'],
  ]
  for (const files of cases) {
    assert.deepEqual(ids(files), [], `${files[0]} 不应影响任何场景`)
  }
  const result = affectedScenarios(['docs/A.md', 'README.md'], { scenarios: SCENARIOS })
  assert.match(result.reason, /不影响场景/)
})

test('affectedScenarios：registry/steps 与 fixtures 变化命中"用到了它"的场景', () => {
  assert.deepEqual(ids(['registry/steps/invoke/tool.yaml']), ['TK-1004'])
  assert.deepEqual(ids(['registry/steps/other/fragment.yml']), [])
  assert.deepEqual(ids(['fixtures/llm/timeout.yaml']), ['TK-1005'])
  assert.deepEqual(ids(['fixtures/llm/error-mid-stream.yaml']), [])

  // 相对换算也能用：registryDir / fixturesDir 传绝对路径时优先按它换算
  assert.deepEqual(ids(['C:/pkg/registry/steps/invoke/tool.yaml'], { registryDir: 'C:/pkg/registry' }), [
    'TK-1004',
  ])
  assert.deepEqual(ids(['C:/pkg/fixtures/llm/timeout.yaml'], { fixturesDir: 'C:/pkg/fixtures' }), [
    'TK-1005',
  ])
})

test('affectedScenarios：默认拒绝——认不出来的路径保守命中全部，并在 reason 里说清', () => {
  for (const file of ['package.json', 'scripts/build-lock.mjs', '.gitignore', 'schemas/run-report.schema.json']) {
    assert.deepEqual(ids([file]), allIds(), `${file} 应保守命中全部`)
  }
  const result = affectedScenarios(['scripts/build-lock.mjs'], { scenarios: SCENARIOS })
  assert.match(result.reason, /未识别/)
  assert.match(result.reason, /保守全选/)
})

test('affectedScenarios：单条 case 文件命中该条；指向不存在的场景则保守全选', () => {
  assert.deepEqual(ids(['cases/TK-1002.yaml']), ['TK-1002'])
  assert.deepEqual(ids(['cases/TK-9999.yaml']), allIds())
  assert.deepEqual(ids(['cases/index.yaml']), allIds())
})

test('affectedScenarios：空输入与 Windows 分隔符', () => {
  assert.deepEqual(ids([]), [])
  assert.match(affectedScenarios([], { scenarios: SCENARIOS }).reason, /变更文件为空/)
  assert.deepEqual(ids(['src\\kinds\\llm.ts']), ['TK-1001', 'TK-1003'])
  assert.deepEqual(ids(['src/kinds/llm.ts', 'docs/x.md', 'src/kinds/llm.ts']), ['TK-1001', 'TK-1003'])
})

/* ------------------------------------------------------ selectByDshVersion -- */

test('selectByDshVersion：无夹具声明的场景直接纳入', () => {
  const result = selectByDshVersion('0.2.0-rc.2', [TOOL_ONLY], { fixturesDir: join(REPO_ROOT, 'fixtures') })
  assert.deepEqual(result.matched, ['TK-1002'])
  assert.match(result.reason, /无版本约束 1 条/)
})

test('selectByDshVersion：夹具满足范围则纳入，不满足则排除并说明原因', () => {
  const fixturesDir = join(REPO_ROOT, 'fixtures')
  const ok = selectByDshVersion('0.2.0-rc.2', [DECLARES_FIXTURE], { fixturesDir })
  assert.deepEqual(ok.matched, ['TK-1005'])

  const older = selectByDshVersion('0.1.9', [DECLARES_FIXTURE], { fixturesDir })
  assert.deepEqual(older.matched, [])
  assert.match(older.reason, /llm\/timeout/)
  assert.match(older.reason, />=0\.2\.0-rc\.2/)
})

test('selectByDshVersion：宿主版本无法解析 / 夹具缺失 / 夹具目录为空 → 保守纳入', () => {
  const fixturesDir = join(REPO_ROOT, 'fixtures')
  const unknownHost = selectByDshVersion('unknown', [DECLARES_FIXTURE], { fixturesDir })
  assert.deepEqual(unknownHost.matched, ['TK-1005'])
  assert.match(unknownHost.reason, /无法判定/)

  const missing = selectByDshVersion('0.2.0-rc.2', [scenario('TK-1006', { fixtures: ['llm/nope'] })], {
    fixturesDir,
  })
  assert.deepEqual(missing.matched, ['TK-1006'])
  assert.match(missing.reason, /不存在/)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-empty-fixtures-'))
  try {
    const empty = selectByDshVersion('0.2.0-rc.2', [DECLARES_FIXTURE], { fixturesDir: dir })
    assert.deepEqual(empty.matched, ['TK-1005'])
    assert.match(empty.reason, /不存在/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('makeSelectionRecord：原样带上 mode / detail / matched（进报告自证用）', () => {
  const record = makeSelectionRecord('changed', 'git diff HEAD~2 → 2 个文件', ['TK-1001'])
  assert.deepEqual(record, { mode: 'changed', detail: 'git diff HEAD~2 → 2 个文件', matched: ['TK-1001'] })
})

/* ------------------------------------------------------- changedFilesSince -- */

function gitWorks() {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

const GIT = gitWorks()

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-git-'))
  runGit(dir, ['init', '-q'])
  runGit(dir, ['config', 'user.email', 'testkit@example.com'])
  runGit(dir, ['config', 'user.name', 'testkit'])
  mkdirSync(join(dir, 'src', 'kinds'), { recursive: true })
  writeFileSync(join(dir, 'src', 'kinds', 'llm.ts'), 'export const a = 1\n', 'utf8')
  runGit(dir, ['add', '-A'])
  runGit(dir, ['commit', '-q', '-m', 'init'])
  return dir
}

test('changedFilesSince：临时仓库里取到改动与未跟踪文件，路径相对 cwd', { skip: !GIT }, () => {
  const dir = makeTempRepo()
  try {
    writeFileSync(join(dir, 'src', 'kinds', 'llm.ts'), 'export const a = 2\n', 'utf8')
    mkdirSync(join(dir, 'src', 'selection'), { recursive: true })
    // 未跟踪的新文件也必须出现：否则"新增一个 kind 实现"会得到"没有任何变更"
    writeFileSync(join(dir, 'src', 'selection', 'new.ts'), 'export const b = 1\n', 'utf8')

    const result = changedFilesSince('HEAD', { cwd: dir })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.ok(result.files.includes('src/kinds/llm.ts'), JSON.stringify(result.files))
    assert.ok(result.files.includes('src/selection/new.ts'), JSON.stringify(result.files))
    for (const file of result.files) assert.ok(!file.includes('\\'), `${file} 应使用 / 分隔`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('changedFilesSince：ref 不存在 / ref 非法 / 非 git 仓库 → ok:false（调用方退回全量）', { skip: !GIT }, () => {
  const dir = makeTempRepo()
  const junk = mkdtempSync(join(tmpdir(), 'dsh-testkit-not-git-'))
  try {
    const badRef = changedFilesSince('no-such-ref-xyz', { cwd: dir })
    assert.equal(badRef.ok, false)
    assert.ok(badRef.reason.length > 0)

    const option = changedFilesSince('--output=x', { cwd: dir })
    assert.equal(option.ok, false)
    assert.match(option.reason, /不能以 - 开头/)

    const empty = changedFilesSince('   ', { cwd: dir })
    assert.equal(empty.ok, false)

    const notRepo = changedFilesSince('HEAD', { cwd: junk })
    assert.equal(notRepo.ok, false)
    assert.ok(notRepo.reason.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(junk, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------ 实测加速比 -- */

/** 造一个最小场景目录：两条场景（llm / tool），各只有一个纯断言步骤。 */
function makeTempCases() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-bench-cases-'))
  const body = (id, kind) => `schema: 1
id: ${id}
title: ${id} 基准场景
kind: ${kind}
status: active
source: { issue: null }
setup: {}
steps:
  - name: 纯断言
    expect:
      - ref: fx.never
        exists: false
`
  writeFileSync(join(dir, 'TK-2001.yaml'), body('TK-2001', 'llm'), 'utf8')
  writeFileSync(join(dir, 'TK-2002.yaml'), body('TK-2002', 'tool'), 'utf8')
  return dir
}

test('benchmarkSelection：全量与增量都跑真实批跑，并按 hit 集合收敛', async () => {
  const casesDir = makeTempCases()
  try {
    const result = await benchmarkSelection({
      casesDir,
      files: ['src/kinds/llm.ts'],
      defaultTimeoutMs: 10_000,
    })
    assert.deepEqual(result.selection.matched, ['TK-2001'])
    assert.equal(result.full.count, 2)
    assert.equal(result.incremental.count, 1)
    assert.equal(result.full.failed, 0)
    assert.equal(result.incremental.failed, 0)
    assert.ok(result.full.ms > 0)
    assert.ok(result.incremental.ms > 0)

    // 没有命中任何场景时不应把"全部场景"当增量集跑掉（CaseFilter 的空数组语义坑）
    const none = await benchmarkSelection({ casesDir, files: ['docs/x.md'], defaultTimeoutMs: 10_000 })
    assert.deepEqual(none.selection.matched, [])
    assert.equal(none.incremental.count, 0)
    assert.equal(none.full.count, 2)
  } finally {
    rmSync(casesDir, { recursive: true, force: true })
  }
})
