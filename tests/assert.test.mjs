/**
 * 断言求值的单元测试。
 *
 * 这些逻辑不依赖 DSH，因此可以在宿主之外直接验证 —— 这也是把
 * assert/fixture/schema 做成纯逻辑层的目的：核心可信度不依赖活宿主。
 *
 * 运行：npm test（需先 npm run build）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { deepEqual, evaluateAssertion, parseRegexLiteral, resolvePath } from '../lib/runtime/assert.js'

test('is 走深比较', () => {
  assert.equal(evaluateAssertion({ ref: 'fx.a', is: { x: [1, 2] } }, { x: [1, 2] }).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.a', is: { x: [1, 2] } }, { x: [2, 1] }).ok, false)
  assert.equal(evaluateAssertion({ ref: 'fx.a', is: 1 }, 1).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.a', is: 1 }, '1').ok, false)
})

test('exists / notExists 区分 undefined 与 null', () => {
  assert.equal(evaluateAssertion({ ref: 'fx.a', exists: true }, undefined).ok, false)
  assert.equal(evaluateAssertion({ ref: 'fx.a', exists: true }, null).ok, false)
  assert.equal(evaluateAssertion({ ref: 'fx.a', exists: true }, 0).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.a', notExists: true }, undefined).ok, true)
})

test('数值与长度判定', () => {
  assert.equal(evaluateAssertion({ ref: 'fx.n', atMost: 10 }, 10).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.n', atMost: 10 }, 11).ok, false)
  assert.equal(evaluateAssertion({ ref: 'fx.n', atLeast: 3 }, 3).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.s', length: 3 }, 'abc').ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.s', lengthAtMost: 2 }, 'abc').ok, false)
})

test('contains 支持字符串与数组', () => {
  assert.equal(evaluateAssertion({ ref: 'fx.s', contains: 'abc' }, 'xxabcxx').ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.a', contains: 2 }, [1, 2, 3]).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.a', notContains: 9 }, [1, 2, 3]).ok, true)
})

test('matches 支持 /pattern/flags 字面量', () => {
  assert.equal(evaluateAssertion({ ref: 'fx.s', matches: '/^错误：/' }, '错误：炸了').ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.s', matches: '/^错误：/' }, '没事').ok, false)
  assert.equal(evaluateAssertion({ ref: 'fx.s', matches: '/ABC/i' }, 'xxabc').ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.n', matches: '/x/' }, 123).ok, false)
})

test('多个判定词必须同时成立（AND）', () => {
  assert.equal(evaluateAssertion({ ref: 'fx.n', atLeast: 1, atMost: 5 }, 3).ok, true)
  assert.equal(evaluateAssertion({ ref: 'fx.n', atLeast: 1, atMost: 5 }, 9).ok, false)
})

test('缺少判定词视为失败', () => {
  const result = evaluateAssertion({ ref: 'fx.a' }, 1)
  assert.equal(result.ok, false)
  assert.match(result.message, /缺少判定词/)
})

test('resolvePath 支持点路径与下标', () => {
  const root = { a: { b: [{ c: 7 }] }, list: [10, 20] }
  assert.equal(resolvePath(root, 'a.b[0].c'), 7)
  assert.equal(resolvePath(root, 'list[1]'), 20)
  assert.equal(resolvePath(root, 'a.missing'), undefined)
  assert.equal(resolvePath(root, ''), root)
})

test('deepEqual 与 parseRegexLiteral 的边界', () => {
  assert.equal(deepEqual([1, { a: 2 }], [1, { a: 2 }]), true)
  assert.equal(deepEqual([1], [1, 2]), false)
  assert.equal(deepEqual(null, null), true)
  assert.equal(parseRegexLiteral('abc').test('xabcx'), true)
})
