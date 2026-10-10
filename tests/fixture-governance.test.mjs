/**
 * fixture 治理的单测：schema / 版本兼容 / 敏感数据 / 装配语义 / 与基线的等价性。
 *
 * ## 这里最重要的一条
 *
 * `cases/TK-0006.yaml` 声明了夹具 `llm/error-mid-stream`。夹具一旦被 runner 接线采用，
 * 场景行为必须与基线**完全一致**。本文件用两重证据钉住它：
 *   ① 只靠夹具展开（把场景的 setup 清空）得到的 setup，与场景现写的 setup **逐字段 deepEqual**；
 *   ② 两条场景都真的跑一遍 headless 宿主，verdict / 每步断言 / 取证（mockText、finishReason）
 *      完全相同，且真实适配器零调用。
 *
 * 没有 ① + ②，"改场景用夹具"就只是文本搬运，谁也不知道搬丢没搬丢。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { CaseRegistry } from '../lib/cases/registry.js'
import { resolvePolicy } from '../lib/executor/policy.js'
import { applyScenarioFixtures, deepMerge } from '../lib/fixtures/apply.js'
import { checkDshVersion, compareVersions, isValidRange, parseRange, parseVersion, satisfies } from '../lib/fixtures/compat.js'
import { defaultFixturesDir, loadFixtureFile, loadFixtures, resolveFixturePath } from '../lib/fixtures/load.js'
import { fixtureNameFromPath, validateFixture, FIXTURE_SCHEMA_VERSION } from '../lib/fixtures/schema.js'
import { describeFinding, isSensitiveFree, scanSensitive } from '../lib/fixtures/sensitive.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { createDriverRegistry } from '../lib/kinds/index.js'
import { runScenarios } from '../lib/runtime/runner.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CASES_DIR = join(REPO_ROOT, 'cases')
const FIXTURES_DIR = defaultFixturesDir()
const NEW_DSH = '0.2.0-rc.2'

/* ------------------------------------------------------------------ schema -- */

function validFixture(extra = {}) {
  return {
    $schema: FIXTURE_SCHEMA_VERSION,
    name: 'llm/timeout',
    dsh_version: '>=0.2.0-rc.2',
    source: 'hand-written',
    data: { llm: { respond: { chunks: [] } } },
    ...extra,
  }
}

test('validateFixture：合法夹具通过，并归一出 spec', () => {
  const result = validateFixture(validFixture(), { relativePath: 'llm/timeout.yaml' })
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.deepEqual(result.spec?.name, 'llm/timeout')
  assert.deepEqual(result.spec?.source, 'hand-written')
  assert.deepEqual(result.spec?.data, { llm: { respond: { chunks: [] } } })
})

test('validateFixture：字段不合规逐项报错（不静默放过）', () => {
  const bad = [
    [validFixture({ $schema: 2 }), '$schema'],
    [validFixture({ name: 'LLM/Timeout' }), 'name'],
    [validFixture({ name: 'foo/bar' }), 'name'],
    [validFixture({ dsh_version: undefined }), 'dsh_version'],
    [validFixture({ dsh_version: '>=abc' }), 'dsh_version'],
    [validFixture({ source: 'copy-paste' }), 'source'],
    [validFixture({ data: { setup: { llm: {} } } }), 'data.setup'],
    [validFixture({ data: { llm: 'not-an-object' } }), 'data.llm'],
    [validFixture({ data: { tool: {} } }), 'data'],
    [validFixture({ data: {} }), 'data'],
  ]
  for (const [raw, path] of bad) {
    const result = validateFixture(raw, { relativePath: 'llm/timeout.yaml' })
    assert.equal(result.ok, false, `${path} 应报错：${JSON.stringify(raw)}`)
    assert.ok(
      result.issues.some((i) => i.path === path),
      `${path} 应出现在 issues 里：${JSON.stringify(result.issues)}`,
    )
  }
})

test('validateFixture：name 必须与文件路径一致', () => {
  const mismatch = validateFixture(validFixture({ name: 'llm/other' }), {
    relativePath: 'llm/timeout.yaml',
  })
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.issues.some((i) => i.path === 'name' && /不一致/.test(i.message)))

  assert.equal(fixtureNameFromPath('llm/timeout.yaml'), 'llm/timeout')
  assert.equal(fixtureNameFromPath('tool\\read-file-enoent.yml'), 'tool/read-file-enoent')
  assert.equal(fixtureNameFromPath('index.yaml'), undefined)
})

/* ------------------------------------------------------------------ compat -- */

test('compat：预发布与正式版的序关系（本仓夹具是给 RC 用的）', () => {
  assert.equal(satisfies('0.2.0-rc.2', '>=0.2.0-rc.2'), true)
  assert.equal(satisfies('0.2.0-rc.1', '>=0.2.0-rc.2'), false)
  assert.equal(satisfies('0.2.0', '>=0.2.0-rc.2'), true)
  assert.equal(satisfies('0.1.9', '>=0.2.0-rc.2'), false)
  assert.ok(compareVersions(parseVersion('0.2.0'), parseVersion('0.2.0-rc.2')) > 0)
})

test('compat：^ ~ 通配 区间 与多段 AND/OR', () => {
  assert.equal(satisfies('0.2.5', '^0.2.0'), true)
  assert.equal(satisfies('0.3.0', '^0.2.0'), false)
  assert.equal(satisfies('1.2.9', '~1.2.3'), true)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
  assert.equal(satisfies('1.4.0', '1.x'), true)
  assert.equal(satisfies('2.0.0', '1.x'), false)
  assert.equal(satisfies('9.9.9', '*'), true)
  assert.equal(satisfies('0.2.5', '>=0.1.0 <0.3.0'), true)
  assert.equal(satisfies('0.3.0', '>=0.1.0 <0.3.0'), false)
  assert.equal(satisfies('1.9.0', '1.2.3 - 2.0.0'), true)
  assert.equal(satisfies('2.0.1', '1.2.3 - 2.0.0'), false)
  assert.equal(satisfies('0.1.5', '0.1.x || >=0.3.0'), true)
  assert.equal(satisfies('0.2.0', '0.1.x || >=0.3.0'), false)
})

test('compat：看不懂就承认看不懂，不把未知当满足', () => {
  assert.equal(isValidRange('>=0.2.0-rc.2'), true)
  assert.equal(isValidRange('>=abc'), false)
  assert.equal(isValidRange(''), false)
  assert.equal(isValidRange('nonsense'), false)
  assert.equal(parseRange('>=abc').ok, false)
  assert.equal(satisfies('0.2.0', '>=abc'), false)
  assert.equal(satisfies('nonsense', '*'), false)
  assert.equal(checkDshVersion('0.2.0', '>=abc').ok, false)
  assert.equal(checkDshVersion('unknown', '*').ok, false)
})

/* --------------------------------------------------------------- sensitive -- */

test('sensitive：token / 私钥 / 邮箱 / 家目录路径都能扫出来', () => {
  const cases = [
    ['sk-' + 'A'.repeat(24), 'token'],
    ['ghp_' + 'B'.repeat(30), 'token'],
    ['xoxb-1234567890-abcdefghij', 'token'],
    // 以下都是**故意构造的反例样本**，用来验证扫描器抓得到；不是真凭据。
    // scripts/check-secrets.mjs 会按规则命中，故逐行标注 secrets-ok（见该脚本的误报处理约定）。
    ['AKIAIOSFODNN7EXAMPLE', 'token'], // secrets-ok：AWS 官方文档里的示例 key
    ['api_key = "abcdefghijklmnopqrstuvwxyz1234"', 'token'], // secrets-ok：反例样本
    ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'token'], // secrets-ok：jwt.io 文档示例
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----', 'private-key'], // secrets-ok：反例样本
    ['请联系 alice@corp.example.io 处理', 'email'], // secrets-ok：反例样本
    ['路径是 /Users/alice/project 下', 'home-path'], // secrets-ok：反例样本
    [String.raw`C:\Users\bob\project`, 'home-path'], // secrets-ok：反例样本
    ['读 ~/.ssh/id_rsa 就行', 'home-path'], // secrets-ok：反例样本
  ]
  for (const [text, kind] of cases) {
    const findings = scanSensitive(text)
    assert.ok(findings.length > 0, `${text} 应命中`)
    assert.ok(
      findings.some((f) => f.kind === kind),
      `${text} 应命中 ${kind}，实际 ${JSON.stringify(findings)}`,
    )
    assert.ok(describeFinding(findings[0]).length > 0)
  }
})

test('sensitive：干净的夹具文本不误报；占位域名不算泄漏', () => {
  assert.equal(isSensitiveFree('failMode: mid-stream-error\nfailAfterChunks: 1\n'), true)
  assert.equal(isSensitiveFree('contact: user@example.com\n'), true)
  assert.equal(isSensitiveFree('open \'missing-input.txt\''), true)
  // 遮蔽：命中原文不能整段回显（扫描结果常被打进 CI 日志）
  const token = 'sk-' + 'C'.repeat(24)
  const [finding] = scanSensitive(token)
  assert.ok(!finding.sample.includes(token))
  assert.match(finding.sample, /长度/)
})

/* ------------------------------------------------------------------ 装载 -- */

test('loadFixtures：包内三份夹具合法、名字与路径一致', () => {
  const result = loadFixtures(FIXTURES_DIR)
  assert.equal(result.invalid.length, 0, JSON.stringify(result.invalid.map((i) => i.issues)))
  const names = result.fixtures.map((f) => f.name).sort()
  for (const expected of ['llm/error-mid-stream', 'llm/timeout', 'tool/read-file-enoent']) {
    assert.ok(names.includes(expected), `缺夹具 ${expected}：${names.join(', ')}`)
  }
  for (const fixture of result.fixtures) {
    assert.ok(fixture.spec, `${fixture.name} 应有 spec`)
    assert.equal(fixture.spec.name, fixture.name)
    assert.ok(isValidRange(fixture.spec.dshVersion), `${fixture.name} 的 dsh_version 应可解析`)
    const [kind] = fixture.spec.name.split('/')
    assert.ok(kind in fixture.spec.data, `${fixture.name} 的 data 应包含 ${kind} 片段`)
  }
})

test('场景声明的夹具必须存在且合法（verify-fixtures 的反向核对同口径）', () => {
  const registry = new CaseRegistry(CASES_DIR)
  registry.reload()
  const declared = new Set()
  for (const scenario of registry.all) {
    for (const name of scenario.fixtures ?? []) declared.add(name)
  }
  assert.ok(declared.size > 0, '当前 cases/ 里应至少有一条场景声明了夹具')
  for (const name of declared) {
    const path = resolveFixturePath(FIXTURES_DIR, name)
    assert.ok(path, `${name} 应有对应文件`)
    assert.equal(loadFixtureFile(FIXTURES_DIR, path).ok, true, `${name} 应合法`)
  }
})

/* ------------------------------------------------------------- 装配语义 -- */

test('applyScenarioFixtures：无声明时原样返回，不动 setup', async () => {
  const scenario = { schema: 1, id: 'TK-X', title: 't', kind: 'tool', source: { issue: null }, setup: {}, steps: [] }
  const result = await applyScenarioFixtures(scenario, { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH })
  assert.deepEqual(result.refs, [])
  assert.equal(result.skipReason, undefined)
  assert.equal(result.scenario, scenario)
})

test('applyScenarioFixtures：只读——不修改入参，且不与夹具缓存共享可变对象', async () => {
  const scenario = {
    schema: 1,
    id: 'TK-X',
    title: 't',
    kind: 'llm',
    source: { issue: null },
    fixtures: ['llm/error-mid-stream'],
    setup: { llm: { failAfterChunks: 3 } },
    steps: [],
  }
  const snapshot = JSON.stringify(scenario)

  const first = await applyScenarioFixtures(scenario, { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH })
  assert.equal(JSON.stringify(scenario), snapshot, '入参不得被修改')
  assert.notEqual(first.scenario.setup, scenario.setup)
  assert.notEqual(first.scenario, scenario)

  // 合并结果与夹具缓存不共享子对象：就地改它，第二次装配必须不受影响
  first.scenario.setup.llm.failMode = 'none'
  const second = await applyScenarioFixtures(scenario, { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH })
  assert.equal(second.scenario.setup.llm.failMode, 'mid-stream-error')
  assert.equal(JSON.stringify(scenario), snapshot)
})

test('applyScenarioFixtures：场景显式字段优先；数组合并是整体替换', async () => {
  const scenario = {
    schema: 1,
    id: 'TK-X',
    title: 't',
    kind: 'llm',
    source: { issue: null },
    fixtures: ['llm/error-mid-stream'],
    setup: { llm: { respond: { chunks: ['只有这段'] }, failAfterChunks: 3 } },
    steps: [],
  }
  const result = await applyScenarioFixtures(scenario, { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH })
  assert.equal(result.skipReason, undefined)
  const llm = result.scenario.setup.llm
  assert.equal(llm.failAfterChunks, 3, '场景显式字段优先')
  assert.equal(llm.failMode, 'mid-stream-error', '夹具字段补上')
  assert.deepEqual(llm.respond.chunks, ['只有这段'], '数组整体替换，不做元素级合并')
  assert.equal(result.refs.length, 1)
  assert.equal(result.refs[0].source, 'hand-written')
  assert.equal(result.refs[0].dshVersion, '>=0.2.0-rc.2')
  assert.equal(result.refs[0].reason, undefined, '被采用时不写 reason')
})

test('applyScenarioFixtures：多份夹具按数组顺序合并（后者覆盖前者）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-multi-fixture-'))
  try {
    mkdirSync(join(dir, 'llm'), { recursive: true })
    writeFileSync(
      join(dir, 'llm', 'first.yaml'),
      '$schema: 1\nname: llm/first\ndsh_version: "*"\nsource: hand-written\ndata:\n  llm:\n    respond:\n      chunks: [A]\n    failMode: none\n',
      'utf8',
    )
    writeFileSync(
      join(dir, 'llm', 'second.yaml'),
      '$schema: 1\nname: llm/second\ndsh_version: "*"\nsource: record\ndata:\n  llm:\n    respond:\n      chunks: [B]\n',
      'utf8',
    )
    const scenario = {
      schema: 1,
      id: 'TK-X',
      title: 't',
      kind: 'llm',
      source: { issue: null },
      fixtures: ['llm/first', 'llm/second'],
      setup: {},
      steps: [],
    }
    const result = await applyScenarioFixtures(scenario, { fixturesDir: dir, dshVersion: NEW_DSH })
    assert.deepEqual(result.scenario.setup.llm, { respond: { chunks: ['B'] }, failMode: 'none' })
    assert.deepEqual(result.refs.map((r) => r.source), ['hand-written', 'record'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('applyScenarioFixtures：版本不匹配 / 夹具缺失 / 写坏 / 目录不存在 → 只返回 skipReason，绝不抛', async () => {
  const base = {
    schema: 1,
    id: 'TK-X',
    title: 't',
    kind: 'llm',
    source: { issue: null },
    setup: {},
    steps: [],
  }

  const mismatch = await applyScenarioFixtures(
    { ...base, fixtures: ['llm/error-mid-stream'] },
    { fixturesDir: FIXTURES_DIR, dshVersion: '0.1.0' },
  )
  assert.match(mismatch.skipReason ?? '', /版本不匹配/)
  assert.match(mismatch.refs[0].reason ?? '', />=0\.2\.0-rc\.2/)

  const missing = await applyScenarioFixtures(
    { ...base, fixtures: ['llm/nope'] },
    { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH },
  )
  assert.match(missing.skipReason ?? '', /不存在/)
  assert.equal(missing.refs[0].source, 'unknown')

  const gone = await applyScenarioFixtures(
    { ...base, fixtures: ['llm/timeout'] },
    { fixturesDir: join(tmpdir(), 'dsh-testkit-no-such-dir-xyz'), dshVersion: NEW_DSH },
  )
  assert.match(gone.skipReason ?? '', /不存在/)

  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-broken-fixture-'))
  try {
    mkdirSync(join(dir, 'llm'), { recursive: true })
    writeFileSync(join(dir, 'llm', 'bad.yaml'), '$schema: 1\nname: llm/bad\nsource: hand-written\ndata: {}\n', 'utf8')
    writeFileSync(join(dir, 'llm', 'broken.yaml'), 'name: [unclosed\n', 'utf8')
    for (const name of ['llm/bad', 'llm/broken']) {
      const result = await applyScenarioFixtures(
        { ...base, fixtures: [name] },
        { fixturesDir: dir, dshVersion: NEW_DSH },
      )
      assert.match(result.skipReason ?? '', /不合法/, `${name} 应报"不合法"`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // 宿主版本解析不出来时**采用**夹具（见 apply.ts 头注：本插件默认就是 unknown）
  const unknownHost = await applyScenarioFixtures(
    { ...base, fixtures: ['llm/error-mid-stream'] },
    { fixturesDir: FIXTURES_DIR, dshVersion: 'unknown' },
  )
  assert.equal(unknownHost.skipReason, undefined)
  assert.equal(unknownHost.refs[0].reason, undefined)
})

test('deepMerge：嵌套对象递归、数组整体替换、undefined 不覆盖', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } })
  assert.deepEqual(deepMerge({ a: [1, 2, 3] }, { a: [9] }), { a: [9] })
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 })
  assert.deepEqual(deepMerge({ a: 1 }, { b: 2 }), { a: 1, b: 2 })
  assert.deepEqual(deepMerge(undefined, { a: { b: 1 } }), { a: { b: 1 } })
})

/* ------------------------------------------- 与基线的等价性（交付物④的证据） -- */

/** 用 headless 宿主跑一条场景（不经过 registry，直接注入）。 */
async function runIsolated(scenario) {
  const headless = await createHeadlessHost()
  try {
    const summary = await runScenarios({
      registry: { dir: CASES_DIR, filter: () => [scenario] },
      drivers: createDriverRegistry(),
      host: headless.host,
      filter: { ids: [scenario.id] },
      defaultTimeoutMs: 15_000,
      policy: resolvePolicy({}),
    })
    return { outcome: summary.cases[0], realAdapterCalls: headless.services.llm.realAdapterCalls }
  } finally {
    await headless.dispose()
  }
}

function assertionFingerprint(outcome) {
  return (outcome.steps ?? []).map((step) => ({
    name: step.name,
    assertions: (step.assertions ?? []).map((a) => ({ ok: a.ok, message: a.message })),
  }))
}

/** 取证的比较要剔掉每次运行都不同的隔离标识（namespace / tmpdir）。 */
function stableNotes(outcome) {
  return Object.fromEntries(
    Object.entries(outcome.notes ?? {}).filter(([key]) => !key.startsWith('isolation')),
  )
}

/**
 * TK-0006 期望的条件。
 *
 * 它**曾经写在场景 YAML 里**；接线落地后已删掉，条件完全由夹具提供
 * （这是"夹具是等价的条件来源"的最终形态，不是把断言变松）。
 * 基准锚点因此从"读 YAML"挪到这里：它同时充当**夹具该提供什么**的规格。
 */
const TK0006_EXPECTED_SETUP = {
  llm: {
    respond: { chunks: ['前半段', '后半段', '永远到不了'] },
    failMode: 'mid-stream-error',
    failAfterChunks: 1,
  },
}

test('TK-0006：夹具单独就能提供全部条件，且与期望规格逐字段一致', async () => {
  const registry = new CaseRegistry(CASES_DIR)
  registry.reload()
  const scenario = registry.get('TK-0006')
  assert.ok(scenario, 'cases/ 里应有 TK-0006')
  assert.deepEqual(scenario.fixtures, ['llm/error-mid-stream'])
  // 场景自己**不再**写条件：这条场景测的就是"条件来自夹具"这条路。
  assert.deepEqual(scenario.setup, {}, 'TK-0006 已切为纯夹具版：setup 应为空')

  const derived = await applyScenarioFixtures(
    { ...scenario, setup: {} },
    { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH },
  )
  assert.equal(derived.skipReason, undefined)
  assert.deepEqual(derived.scenario.setup, TK0006_EXPECTED_SETUP, '夹具展开出的 setup 必须与期望规格一致')
})

test('TK-0006：夹具版与"把条件写回场景"版实跑结果完全相同（verdict / 断言 / 取证 / 零上游）', async () => {
  const registry = new CaseRegistry(CASES_DIR)
  registry.reload()
  const scenario = registry.get('TK-0006')
  assert.ok(scenario)

  const derived = await applyScenarioFixtures(
    { ...scenario, setup: {} },
    { fixturesDir: FIXTURES_DIR, dshVersion: NEW_DSH },
  )
  assert.equal(derived.skipReason, undefined)

  // 基线 = 把期望条件写回场景（等价性对照，不依赖 YAML 里是否写了它）
  const baselineRun = await runIsolated({ ...scenario, setup: TK0006_EXPECTED_SETUP })
  const fixtureRun = await runIsolated(derived.scenario)

  assert.equal(baselineRun.outcome.verdict, 'passed', JSON.stringify(baselineRun.outcome, null, 2))
  assert.equal(fixtureRun.outcome.verdict, baselineRun.outcome.verdict)
  assert.deepEqual(assertionFingerprint(fixtureRun.outcome), assertionFingerprint(baselineRun.outcome))

  // 条件确实来自夹具：清空 setup 后仍产出与基线相同的取证
  assert.equal(fixtureRun.outcome.notes.mockText, '前半段')
  assert.equal(fixtureRun.outcome.notes.finishReason, 'error')
  assert.deepEqual(stableNotes(fixtureRun.outcome), stableNotes(baselineRun.outcome))

  // 零上游请求：两条路径都没有触达真实适配器
  assert.equal(baselineRun.realAdapterCalls, 0)
  assert.equal(fixtureRun.realAdapterCalls, 0)
})
