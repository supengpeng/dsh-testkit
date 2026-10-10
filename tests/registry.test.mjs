/**
 * step registry + 展开器（`src/registry/loader.ts` / `expand.ts`）的测试。
 *
 * 覆盖三件事：
 *   ① 加载/校验的硬约束：无环（片段不得 use 片段）、重名、参数 schema、
 *      未知占位符、依赖存在性 / 成环、禁止 YAML 控制流。
 *   ② 展开语义：整串占位保留类型、嵌入占位、with 多给/少给、类型不符、
 *      版本锁、flat 不残留 use/with。
 *   ③ **等价性证明**：用 `use:` 组合出的场景与"手写 flat 等价场景"，
 *      既在 `expandScenario` 输出上逐步逐字段相等，又在 `createHeadlessHost()`
 *      上跑出**完全一致的 verdict 与断言 ok 集合**。
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCaseFile } from '../lib/cases/loader.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { createDriverRegistry } from '../lib/kinds/index.js'
import { checkRegistry, expandScenario, loadRegistry } from '../lib/registry/index.js'
import { runScenarios } from '../lib/runtime/runner.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const REGISTRY_DIR = join(root, 'registry')
const CASES_DIR = join(root, 'cases')

const REQUIRED_FRAGMENTS = [
  'setup/no-session',
  'setup/with-session',
  'setup/permission-denied',
  'invoke/tool',
  'invoke/llm',
  'invoke/shell',
  'assert/error',
  'assert/output-contains',
  'assert/tool-called',
]

/** 每个片段的样例参数（用于"每个片段都能展开"的覆盖测试）。 */
const SAMPLE_WITH = {
  'setup/no-session': {},
  'setup/with-session': { command: 'probe-cmd' },
  'setup/permission-denied': { tool: 'probe' },
  'invoke/tool': { tool: 'probe' },
  'invoke/llm': { prompt: '自检' },
  'invoke/shell': { argv: ['git', '--version'] },
  'assert/error': { ref: 'fx.callError' },
  'assert/output-contains': { ref: 'fx.resultText', value: 'BODY' },
  'assert/tool-called': { tool: 'probe' },
}

let cachedRegistry
function registry() {
  cachedRegistry ??= loadRegistry({ registryDir: REGISTRY_DIR })
  return cachedRegistry
}

function baseScenario(overrides = {}) {
  return {
    schema: 1,
    id: 'TK-9001',
    title: '内联场景',
    kind: 'tool',
    status: 'active',
    tags: ['registry:v1'],
    source: { issue: null },
    setup: {},
    steps: [],
    ...overrides,
  }
}

/** 建一个临时 registry 目录（清单 + steps/*.yaml），返回句柄。 */
function tempRegistry(files, manifest = 'version: "1"\n') {
  const dir = mkdtempSync(join(tmpdir(), 'tk-registry-'))
  writeFileSync(join(dir, 'registry.yaml'), manifest, 'utf8')
  for (const [rel, text] of Object.entries(files)) {
    const full = join(dir, 'steps', rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text, 'utf8')
  }
  return dir
}

/** 在 headless 宿主上跑一条内存里的场景（不落盘）。 */
async function runInline(scenario, capabilities) {
  const headless = await createHeadlessHost(capabilities === undefined ? {} : { capabilities })
  try {
    const run = await runScenarios({
      // runner 只用到 registry.filter() 与 registry.dir；这里直接用内存场景，
      // 省掉"写 YAML → 落盘 → 读回"的噪声，测的仍是真实 runner + 真实 driver。
      registry: { filter: () => [scenario], dir: 'inline' },
      drivers: createDriverRegistry(),
      host: headless.host,
      timeoutMs: 10_000,
    })
    return run.cases[0]
  } finally {
    await headless.dispose()
  }
}

/** 断言集合的比对口径：每步的每个断言的 ok。 */
const assertionOkMatrix = (outcome) => outcome.steps.map((step) => step.assertions.map((a) => a.ok))

/* ------------------------------------------------------------ ① 加载校验 -- */

test('registry：9 份必需片段齐全，checkRegistry 干净', () => {
  const reg = registry()
  const check = checkRegistry(reg)
  assert.equal(check.ok, true, check.problems.join('\n'))
  assert.equal(reg.version, '1')
  assert.equal(reg.steps.size, REQUIRED_FRAGMENTS.length)
  for (const name of REQUIRED_FRAGMENTS) {
    assert.ok(reg.steps.has(name), `缺少片段 ${name}`)
  }
  for (const fragment of reg.steps.values()) {
    assert.ok(fragment.description.length > 0, `${fragment.name} 缺 description`)
    assert.equal(fragment.version, '1')
    assert.ok(Array.isArray(fragment.dependencies), `${fragment.name} 的 dependencies 必须是数组`)
    assert.ok(
      fragment.act !== undefined || (fragment.expect?.length ?? 0) > 0,
      `${fragment.name} 既没有 act 也没有 expect`,
    )
    assert.ok(fragment.cost !== undefined, `${fragment.name} 应声明 cost`)
    assert.ok(fragment.sandbox !== undefined, `${fragment.name} 应声明 sandbox`)
  }
})

test('registry：片段里出现 use 必须报错（片段不能 use 片段）', () => {
  const dir = tempRegistry({
    'a/x.yaml': `
name: a/x
version: "1"
description: 违规片段
dependencies: []
act: { tool: a }
expect:
  - { ref: fx.callCount, exists: true }
use: invoke/tool
`,
  })
  try {
    const check = checkRegistry(loadRegistry({ registryDir: dir }))
    assert.equal(check.ok, false)
    assert.ok(
      check.problems.some((p) => p.includes('不得出现 use')),
      check.problems.join('\n'),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registry：重名片段必须报错', () => {
  const body = (desc) => `
name: demo/dup
version: "1"
description: ${desc}
dependencies: []
act: { wait: { ms: 1 } }
`
  const dir = tempRegistry({ 'a.yaml': body('第一个'), 'b.yaml': body('第二个') })
  try {
    const check = checkRegistry(loadRegistry({ registryDir: dir }))
    assert.equal(check.ok, false)
    assert.ok(check.problems.some((p) => p.includes('片段名重复')), check.problems.join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registry：未知占位符、参数 schema、控制流关键字都要报错', () => {
  const dir = tempRegistry({
    'unknown-placeholder.yaml': `
name: demo/bad-placeholder
version: "1"
description: 占位符没声明
dependencies: []
params:
  type: object
  properties:
    a: { type: string }
  required: []
act: { tool: "{b}" }
`,
    'bad-schema.yaml': `
name: demo/bad-schema
version: "1"
description: 参数 schema 有问题
dependencies: []
params:
  type: array
  properties:
    a: { type: strng }
  required: [missing]
act: { tool: a }
`,
    'control-flow.yaml': `
name: demo/control-flow
version: "1"
description: 带控制流
dependencies: []
if: true
act: { tool: a }
`,
  })
  try {
    const check = checkRegistry(loadRegistry({ registryDir: dir }))
    assert.equal(check.ok, false)
    const joined = check.problems.join('\n')
    assert.ok(joined.includes('占位符 {b}'), joined)
    assert.ok(joined.includes('params.type 只能是 object'), joined)
    assert.ok(joined.includes('params.properties.a.type'), joined)
    assert.ok(joined.includes('params.required 里的 missing'), joined)
    assert.ok(joined.includes('禁止 YAML 控制流'), joined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('registry：依赖缺失 / 成环 / 自依赖必须报错', () => {
  const dir = tempRegistry({
    'a.yaml': `
name: demo/a
version: "1"
description: a
dependencies: [demo/b]
act: { tool: a }
`,
    'b.yaml': `
name: demo/b
version: "1"
description: b
dependencies: [demo/a]
act: { tool: b }
`,
    'missing.yaml': `
name: demo/missing
version: "1"
description: 依赖不存在
dependencies: [demo/nope]
act: { tool: c }
`,
    'self.yaml': `
name: demo/self
version: "1"
description: 自依赖
dependencies: [demo/self]
act: { tool: d }
`,
  })
  try {
    const check = checkRegistry(loadRegistry({ registryDir: dir }))
    assert.equal(check.ok, false)
    const joined = check.problems.join('\n')
    assert.ok(joined.includes('demo/nope 不存在'), joined)
    assert.ok(joined.includes('依赖成环'), joined)
    assert.ok(joined.includes('不能依赖自己'), joined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------------- ② 展开 -- */

test('expand：draft 组合场景展平成 flat，act/expect 替换到位且不残留 use/with', () => {
  const loaded = loadCaseFile(join(CASES_DIR, 'TK-0037.yaml'))
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues))

  const result = expandScenario(loaded.scenario, { registry: registry() })
  assert.equal(result.ok, true, result.ok ? '' : result.problems.join('\n'))

  const flat = result.flat
  assert.equal(flat.length, 3)
  assert.deepEqual(flat[0].act, { session: { events: { waitMs: 0, limit: 1 } } })
  assert.deepEqual(flat[0].expect, [{ ref: 'fx.sessionTargetId', notExists: true }])
  assert.deepEqual(flat[1].act, { tool: 'probe_missing', args: {} })
  assert.deepEqual(flat[1].expect, [{ ref: 'fx.lastResult.name', is: 'probe_missing' }])
  assert.deepEqual(flat[2].expect, [
    { ref: 'fx.callError', exists: true },
    { ref: 'fx.callError', matches: 'ENOENT' },
  ])

  const allowed = new Set(['id', 'name', 'act', 'expect', 'cleanup'])
  flat.forEach((step, index) => {
    assert.ok(!('use' in step), `steps[${index}] 残留 use`)
    assert.ok(!('with' in step), `steps[${index}] 残留 with`)
    for (const key of Object.keys(step)) {
      assert.ok(allowed.has(key), `steps[${index}] 出现非白名单键 ${key}`)
    }
  })

  // 一键展平的契约：scenario.steps 就是 flat
  assert.equal(result.scenario.steps.length, flat.length)
  assert.deepEqual(result.scenario.steps, flat)
})

test('expand：with 多给参数 / 少给必填 / 类型不符 / 未知片段都要逐个点名', () => {
  const reg = registry()
  const cases = [
    {
      name: 'with 多给参数',
      steps: [{ use: 'invoke/tool', with: { tool: 'probe', toool: 'typo' } }],
      expect: 'toool',
    },
    { name: '少给必填', steps: [{ use: 'invoke/tool', with: {} }], expect: '必填参数 tool' },
    {
      name: '类型不符',
      steps: [{ use: 'invoke/tool', with: { tool: 123 } }],
      expect: '期望 string',
    },
    { name: '未知片段', steps: [{ use: 'invoke/nope', with: {} }], expect: '找不到片段 invoke/nope' },
    {
      name: '枚举越界',
      steps: [{ use: 'setup/with-session', with: { command: 'c', kind: 'nope' } }],
      expect: '只能是',
    },
  ]

  for (const item of cases) {
    const result = expandScenario(baseScenario({ steps: item.steps }), { registry: reg })
    assert.equal(result.ok, false, `${item.name} 应当失败`)
    const joined = result.problems.join('\n')
    assert.ok(joined.includes(item.expect), `${item.name} 的问题里应包含「${item.expect}」：\n${joined}`)
  }
})

test('expand：场景必须锁 registry 版本', () => {
  const reg = registry()
  const steps = [{ use: 'invoke/tool', with: { tool: 'probe' } }]

  const noTag = expandScenario(baseScenario({ tags: ['composed'], steps }), { registry: reg })
  assert.equal(noTag.ok, false)
  assert.ok(noTag.problems.join('\n').includes('版本锁'), noTag.problems.join('\n'))

  const wrongTag = expandScenario(baseScenario({ tags: ['registry:v9'], steps }), { registry: reg })
  assert.equal(wrongTag.ok, false)
  assert.ok(wrongTag.problems.join('\n').includes('不一致'), wrongTag.problems.join('\n'))
})

test('expand：嵌入占位不能传对象；整串占位保留原类型', () => {
  const dir = tempRegistry({
    'embed.yaml': `
name: demo/embed
version: "1"
description: 嵌入占位
dependencies: []
params:
  type: object
  properties:
    obj: { type: object }
  required: [obj]
act: { tool: "prefix-{obj}" }
`,
    'whole.yaml': `
name: demo/whole
version: "1"
description: 整串占位
dependencies: []
params:
  type: object
  properties:
    obj: { type: object }
  required: [obj]
act: { tool: "{obj}" }
`,
  })
  try {
    const reg = loadRegistry({ registryDir: dir })

    // 嵌入在字符串里：值必须是标量，对象要报 problem
    const embedded = expandScenario(
      baseScenario({ steps: [{ use: 'demo/embed', with: { obj: { a: 1 } } }] }),
      { registry: reg },
    )
    assert.equal(embedded.ok, false)
    assert.ok(embedded.problems.join('\n').includes('不是标量'), embedded.problems.join('\n'))

    // 整串占位：对象原样替换（保留类型，不做字符串化）
    const whole = expandScenario(
      baseScenario({ steps: [{ use: 'demo/whole', with: { obj: { a: 1 } } }] }),
      { registry: reg },
    )
    assert.equal(whole.ok, true, whole.ok ? '' : whole.problems.join('\n'))
    assert.deepEqual(whole.flat[0].act, { tool: { a: 1 } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('expand：每个片段都能被展开（覆盖矩阵）', () => {
  const reg = registry()
  for (const name of REQUIRED_FRAGMENTS) {
    const result = expandScenario(
      baseScenario({
        // shell / llm / session 片段要求场景 kind 与动作归属匹配（见片段头注）
        kind: name.startsWith('invoke/shell') ? 'shell' : name.startsWith('invoke/llm') ? 'llm' : 'tool',
        steps: [{ use: name, with: SAMPLE_WITH[name] }],
      }),
      { registry: reg },
    )
    assert.equal(result.ok, true, `${name} 展开失败：${result.ok ? '' : result.problems.join('\n')}`)
    assert.equal(result.flat.length, 1)
  }
})

/* --------------------------------------------------- ③ headless 端到端 -- */

test('cases：3 条组合场景都是 draft（不进默认回归集）且带版本锁', () => {
  for (const id of ['TK-0037', 'TK-0038', 'TK-0039']) {
    const loaded = loadCaseFile(join(CASES_DIR, `${id}.yaml`))
    assert.equal(loaded.ok, true, `${id}: ${JSON.stringify(loaded.issues)}`)
    assert.equal(loaded.scenario.status, 'draft', `${id} 必须是 draft（否则会进默认回归集）`)
    assert.ok(loaded.scenario.tags.includes('registry:v1'), `${id} 应带版本锁`)
    assert.ok(
      loaded.scenario.steps.some((step) => step.use !== undefined),
      `${id} 应当用 use: 写成`,
    )
  }
})

test('等价性证明：use: 组合场景与手写 flat 场景，展开结果逐字段相等且跑出的 verdict/断言一致', async () => {
  const loaded = loadCaseFile(join(CASES_DIR, 'TK-0037.yaml'))
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues))

  const composed = { ...loaded.scenario, id: 'TK-9001' }
  const expanded = expandScenario(composed, { registry: registry() })
  assert.equal(expanded.ok, true, expanded.ok ? '' : expanded.problems.join('\n'))

  // ---- 手写 flat 等价场景：不经过任何片段，逐字面写出来 ----
  const literalSteps = [
    {
      id: 'arrange',
      name: '前置：本次运行不应绑定会话',
      act: { session: { events: { waitMs: 0, limit: 1 } } },
      expect: [{ ref: 'fx.sessionTargetId', notExists: true }],
    },
    {
      id: 'call',
      name: 'invoke/tool',
      act: { tool: 'probe_missing', args: {} },
      expect: [{ ref: 'fx.lastResult.name', is: 'probe_missing' }],
    },
    {
      id: 'check',
      name: 'assert/error',
      expect: [
        { ref: 'fx.callError', exists: true },
        { ref: 'fx.callError', matches: 'ENOENT' },
      ],
    },
  ]

  // 口径 ①：展开器输出 === 手写 flat（逐步骤逐字段）
  assert.deepEqual(expanded.flat, literalSteps, '展开结果必须与手写 flat 完全一致')

  const literal = { ...composed, id: 'TK-9002', steps: literalSteps }

  // 口径 ②：两条场景在同一 headless 宿主上跑出的结论一致
  const composedOutcome = await runInline(expanded.scenario)
  const literalOutcome = await runInline(literal)

  assert.equal(composedOutcome.verdict, 'passed', JSON.stringify(composedOutcome, null, 2))
  assert.equal(literalOutcome.verdict, 'passed', JSON.stringify(literalOutcome, null, 2))
  assert.equal(composedOutcome.verdict, literalOutcome.verdict)
  assert.deepEqual(
    assertionOkMatrix(composedOutcome),
    assertionOkMatrix(literalOutcome),
    '每步的断言 ok 集合必须完全一致',
  )
  // 断言集合的具体形状也钉住：3 步 → 1 / 1 / 2 条断言，全 true
  assert.deepEqual(assertionOkMatrix(composedOutcome), [[true], [true], [true, true]])
})

test('headless：setup/with-session 片段驱动的会话命令通过', async () => {
  const scenario = baseScenario({
    kind: 'session',
    id: 'TK-9003',
    runtime: { requires: ['commands'] },
    setup: { session: { command: { name: 'probe-cmd', returns: 'OK' } } },
    steps: [{ use: 'setup/with-session', with: { command: 'probe-cmd', kind: 'success' } }],
  })
  const expanded = expandScenario(scenario, { registry: registry() })
  assert.equal(expanded.ok, true, expanded.ok ? '' : expanded.problems.join('\n'))

  const outcome = await runInline(expanded.scenario)
  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
  assert.deepEqual(assertionOkMatrix(outcome), [[true, true]])
})

test('headless：setup/permission-denied 片段驱动的审批拒绝通过', async () => {
  const scenario = baseScenario({
    kind: 'interaction',
    id: 'TK-9004',
    setup: { interaction: { approval: { decision: 'rejected' } } },
    steps: [{ use: 'setup/permission-denied', with: { tool: 'probe' } }],
  })
  const expanded = expandScenario(scenario, { registry: registry() })
  assert.equal(expanded.ok, true, expanded.ok ? '' : expanded.problems.join('\n'))

  const outcome = await runInline(expanded.scenario)
  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
  assert.deepEqual(assertionOkMatrix(outcome), [[true, true]])
})

test('headless：invoke/tool + assert/tool-called + assert/output-contains 组合通过', async () => {
  const loaded = loadCaseFile(join(CASES_DIR, 'TK-0038.yaml'))
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues))
  const expanded = expandScenario(loaded.scenario, { registry: registry() })
  assert.equal(expanded.ok, true, expanded.ok ? '' : expanded.problems.join('\n'))

  const outcome = await runInline(expanded.scenario)
  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
  assert.deepEqual(assertionOkMatrix(outcome), [[true], [true, true], [true, true]])
})

test('headless：invoke/llm + assert/output-contains 组合通过（零上游请求）', async () => {
  const loaded = loadCaseFile(join(CASES_DIR, 'TK-0039.yaml'))
  assert.equal(loaded.ok, true, JSON.stringify(loaded.issues))
  const expanded = expandScenario(loaded.scenario, { registry: registry() })
  assert.equal(expanded.ok, true, expanded.ok ? '' : expanded.problems.join('\n'))

  const outcome = await runInline(expanded.scenario)
  assert.equal(outcome.verdict, 'passed', JSON.stringify(outcome, null, 2))
  assert.deepEqual(assertionOkMatrix(outcome), [[true], [true, true], [true, true]])
})

test('headless：invoke/shell 片段在无 subprocess 的宿主上 skipped（而不是 errored）', async () => {
  const scenario = baseScenario({
    kind: 'shell',
    id: 'TK-9005',
    runtime: { requires: ['subprocess'] },
    steps: [{ use: 'invoke/shell', with: { argv: ['git', '--version'] } }],
  })
  const expanded = expandScenario(scenario, { registry: registry() })
  assert.equal(expanded.ok, true, expanded.ok ? '' : expanded.problems.join('\n'))

  const outcome = await runInline(expanded.scenario)
  assert.equal(outcome.verdict, 'skipped', JSON.stringify(outcome, null, 2))
  assert.match(String(outcome.skipReason), /subprocess/)
})
