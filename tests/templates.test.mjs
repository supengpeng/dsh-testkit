/**
 * 参数化模板（`templates/*.yaml` → draft 场景）的测试。
 *
 * 覆盖：矩阵笛卡尔积、ID 分配与撞号跳过、状态一律 draft、
 * 未知占位符 / 非法 id_pattern / 控制流关键字的报错，
 * 以及"模板产出的场景仍能经 expandScenario 展平且不残留 use/with"。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { expandTemplates, loadRegistry, loadTemplates } from '../lib/registry/index.js'
import { expandScenario } from '../lib/registry/index.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const TEMPLATES_DIR = join(root, 'templates')
const CASES_DIR = join(root, 'cases')
const DRAFT_DIR = join(root, 'cases-draft')

function existingIds() {
  // `cases-draft/` 是 .gitignore 的暂存区，fresh clone 里可能不存在——必须容忍缺失
  const collect = (dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => /^TK-\d{4}\.yaml$/.test(name))
      .map((name) => name.slice(0, -5))
  }
  return [...collect(CASES_DIR), ...collect(DRAFT_DIR)]
}

function tempTemplates(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tk-templates-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, 'utf8')
  return dir
}

test('templates：仓库里的模板可加载、无问题，且字段齐全', () => {
  const loaded = loadTemplates({ templatesDir: TEMPLATES_DIR, existingIds: existingIds() })
  assert.deepEqual(loaded.problems, [])
  assert.ok(loaded.templates.length >= 2, `至少 2 份模板，实际 ${loaded.templates.length}`)

  const names = loaded.templates.map((t) => t.template).sort()
  assert.deepEqual(names, ['llm-output', 'tool-failure'])
  for (const template of loaded.templates) {
    assert.equal(template.idPattern, 'TK-01xx')
    assert.ok(Object.keys(template.matrix).length >= 1, `${template.template} 应有 matrix`)
    assert.ok(template.steps.length >= 1)
  }
})

test('templates：展开成 draft 场景，ID 不撞既有 TK 号且矩阵数量正确', () => {
  const known = existingIds()
  const expanded = expandTemplates({ templatesDir: TEMPLATES_DIR, existingIds: known })
  assert.deepEqual(expanded.problems, [])

  // tool-failure: 2 × 1 × 1 = 2；llm-output: 2 × 2 = 4
  assert.equal(expanded.scenarios.length, 6)

  const ids = expanded.scenarios.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length, `ID 必须唯一：${ids.join(', ')}`)
  for (const id of ids) {
    assert.match(id, /^TK-\d{4}$/)
    assert.ok(!known.includes(id), `${id} 撞了既有场景号`)
  }

  for (const scenario of expanded.scenarios) {
    assert.equal(scenario.status, 'draft', `${scenario.id} 必须是 draft`)
    assert.ok(
      scenario.tags.some((tag) => tag.startsWith('template:')),
      `${scenario.id} 应带 template:<名字> 标签`,
    )
    assert.ok(scenario.tags.includes('registry:v1'), `${scenario.id} 应带版本锁`)
  }

  const byKind = (kind) => expanded.scenarios.filter((s) => s.kind === kind).length
  assert.equal(byKind('tool'), 2)
  assert.equal(byKind('llm'), 4)
})

test('templates：展开结果仍带 use:，经 expandScenario 后不残留 use/with', () => {
  const registry = loadRegistry({ registryDir: join(root, 'registry') })
  const expanded = expandTemplates({ templatesDir: TEMPLATES_DIR, existingIds: existingIds() })
  assert.deepEqual(expanded.problems, [])
  assert.equal(expanded.scenarios.length, 6)

  for (const scenario of expanded.scenarios) {
    const composed = scenario.steps.filter((step) => step.use !== undefined)
    assert.ok(composed.length >= 1, `${scenario.id} 应含 use: 步骤`)

    const result = expandScenario(scenario, { registry })
    assert.equal(result.ok, true, result.ok ? '' : `${scenario.id}: ${result.problems.join('\n')}`)
    for (const step of result.flat) {
      assert.ok(!('use' in step), `${scenario.id} 展开后残留 use`)
      assert.ok(!('with' in step), `${scenario.id} 展开后残留 with`)
    }
  }
})

test('templates：ID 分配会跳过已占用的号', () => {
  const occupied = ['TK-0100', 'TK-0101']
  const expanded = expandTemplates({
    templatesDir: TEMPLATES_DIR,
    existingIds: [...existingIds(), ...occupied],
  })
  assert.deepEqual(expanded.problems, [])
  const ids = expanded.scenarios.map((s) => s.id)
  assert.ok(!ids.includes('TK-0100'))
  assert.ok(!ids.includes('TK-0101'))
  assert.ok(ids.includes('TK-0102'), `应顺延到 TK-0102 起：${ids.join(', ')}`)
})

test('templates：矩阵笛卡尔积 = 各维长度相乘，ID 顺序分配', () => {
  const dir = tempTemplates({
    'grid.yaml': `
template: grid
id_pattern: TK-05xx
title: "网格 {a}-{b}"
kind: tool
tags: [template]
matrix:
  a: [1, 2]
  b: [x, y, z]
steps:
  - name: "步骤 {a}{b}"
    expect:
      - { ref: fx.callCount, exists: true }
`,
  })
  try {
    const expanded = expandTemplates({ templatesDir: dir, existingIds: [] })
    assert.deepEqual(expanded.problems, [])
    assert.equal(expanded.scenarios.length, 6)
    assert.deepEqual(
      expanded.scenarios.map((s) => s.id),
      ['TK-0500', 'TK-0501', 'TK-0502', 'TK-0503', 'TK-0504', 'TK-0505'],
    )
    assert.deepEqual(
      expanded.scenarios.map((s) => s.title),
      ['网格 1-x', '网格 1-y', '网格 1-z', '网格 2-x', '网格 2-y', '网格 2-z'],
    )
    assert.deepEqual(
      expanded.scenarios.map((s) => s.steps[0].name),
      ['步骤 1x', '步骤 1y', '步骤 1z', '步骤 2x', '步骤 2y', '步骤 2z'],
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('templates：非法 id_pattern / 未声明占位符 / 控制流 / 空 steps 都要报错', () => {
  const dir = tempTemplates({
    'bad-id.yaml': `
template: bad-id
id_pattern: XX-01
title: t
kind: tool
steps:
  - { name: n, expect: [{ ref: fx.callCount, exists: true }] }
`,
    'bad-placeholder.yaml': `
template: bad-placeholder
id_pattern: TK-06xx
title: t
kind: tool
matrix:
  a: [1]
steps:
  - { use: invoke/tool, with: { tool: "{b}" } }
`,
    'bad-control.yaml': `
template: bad-control
id_pattern: TK-07xx
title: t
kind: tool
if: true
steps:
  - { name: n, expect: [{ ref: fx.callCount, exists: true }] }
`,
    'bad-steps.yaml': `
template: bad-steps
id_pattern: TK-08xx
title: t
kind: tool
steps: []
`,
  })
  try {
    const loaded = loadTemplates({ templatesDir: dir, existingIds: [] })
    const joined = loaded.problems.join('\n')
    assert.ok(joined.includes('id_pattern 必须形如'), joined)
    assert.ok(joined.includes('占位符 {b}'), joined)
    assert.ok(joined.includes('禁止 YAML 控制流'), joined)
    assert.ok(joined.includes('steps 必须是非空对象数组'), joined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('templates：模板目录缺失时报 problem（不是抛异常）', () => {
  const loaded = loadTemplates({ templatesDir: join(root, 'no-such-templates'), existingIds: [] })
  assert.equal(loaded.templates.length, 0)
  assert.ok(loaded.problems.some((p) => p.includes('不存在')), loaded.problems.join('\n'))
})
