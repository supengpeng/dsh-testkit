/**
 * 场景校验与加载的单元测试。
 *
 * 覆盖两类最容易出问题的路径：id 与文件名错配、setup 与 kind 不匹配。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { validateScenario } from '../lib/cases/schema.js'

/** 一个合法的最小场景。 */
function validScenario(overrides = {}) {
  return {
    schema: 1,
    id: 'TK-0001',
    title: '示例场景',
    kind: 'tool',
    source: { issue: null },
    setup: { tool: {} },
    steps: [{ name: '一步', expect: [{ ref: 'fx.a', exists: true }] }],
    ...overrides,
  }
}

test('合法场景通过', () => {
  const result = validateScenario(validScenario(), 'TK-0001.yaml')
  assert.equal(result.ok, true, JSON.stringify(result.issues))
  assert.equal(result.scenario.id, 'TK-0001')
})

test('id 与文件名不一致被拒', () => {
  const result = validateScenario(validScenario(), 'TK-0002.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'id' && /不一致/.test(i.message)))
})

test('id 格式非法被拒', () => {
  const result = validateScenario(validScenario({ id: 'CASE-1' }), 'TK-0001.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'id'))
})

test('未注册的 kind 被拒', () => {
  const result = validateScenario(validScenario({ kind: 'nope' }), 'TK-0001.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'kind'))
})

test('setup 下出现非 kind 的键被拒（挡拼写错误）', () => {
  const result = validateScenario(validScenario({ setup: { tolls: {} } }), 'TK-0001.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'setup.tolls'))
})

test('setup 允许与主 kind 不同的 kind 键（组合场景）', () => {
  // 这是**刻意支持**的：runner 会把 setup 分派给每个出现过的 kind 的 driver，
  // 于是"先造条件、再用另一种动作驱动"成为可能（例如注册假答者 + 派真子 agent）。
  const result = validateScenario(
    validScenario({ kind: 'llm', setup: { tool: {}, resource: {} } }),
    'TK-0001.yaml',
  )
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('setup 允许主 kind 不出现（有些 driver 不需要配置，例如 ui）', () => {
  const result = validateScenario(
    validScenario({ kind: 'ui', setup: { tool: {} } }),
    'TK-0001.yaml',
  )
  assert.equal(result.ok, true, JSON.stringify(result.issues))
})

test('steps 为空被拒', () => {
  const result = validateScenario(validScenario({ steps: [] }), 'TK-0001.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'steps'))
})

test('断言缺少判定词被拒', () => {
  const result = validateScenario(
    validScenario({ steps: [{ expect: [{ ref: 'fx.a' }] }] }),
    'TK-0001.yaml',
  )
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => /缺少判定词/.test(i.message)))
})

test('一行多个判定词被拒', () => {
  const result = validateScenario(
    validScenario({ steps: [{ expect: [{ ref: 'fx.a', is: 1, atMost: 2 }] }] }),
    'TK-0001.yaml',
  )
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => /只允许一个判定词/.test(i.message)))
})

test('ref 前缀非法被拒', () => {
  const result = validateScenario(
    validScenario({ steps: [{ expect: [{ ref: 'notes.a', exists: true }] }] }),
    'TK-0001.yaml',
  )
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path.endsWith('.ref')))
})

test('source 段缺失被拒', () => {
  const scenario = validScenario()
  delete scenario.source
  const result = validateScenario(scenario, 'TK-0001.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'source'))
})

test('severity / status 取值受限', () => {
  const bad = validateScenario(validScenario({ severity: 'urgent' }), 'TK-0001.yaml')
  assert.equal(bad.ok, false)
  const ok = validateScenario(validScenario({ severity: 'high', status: 'draft' }), 'TK-0001.yaml')
  assert.equal(ok.ok, true)
})

test('schema 版本必须匹配', () => {
  const result = validateScenario(validScenario({ schema: 2 }), 'TK-0001.yaml')
  assert.equal(result.ok, false)
  assert.ok(result.issues.some((i) => i.path === 'schema'))
})

test('顶层非对象被拒', () => {
  assert.equal(validateScenario(null, 'TK-0001.yaml').ok, false)
  assert.equal(validateScenario([], 'TK-0001.yaml').ok, false)
  assert.equal(validateScenario('x', 'TK-0001.yaml').ok, false)
})
