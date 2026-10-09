/**
 * Fixture 的单元测试 —— 这是"活宿主测试不污染"承诺的守门测试。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Fixture } from '../lib/runtime/fixture.js'

test('逆序释放', async () => {
  const fx = new Fixture()
  const order = []
  fx.add('a', () => order.push('a'))
  fx.add('b', () => order.push('b'))
  fx.add('c', () => order.push('c'))

  const report = await fx.release()
  assert.deepEqual(order, ['c', 'b', 'a'])
  assert.equal(report.failures.length, 0)
  assert.equal(report.released.length, 3)
})

test('单个释放失败不阻断其余释放', async () => {
  const fx = new Fixture()
  const order = []
  fx.add('a', () => order.push('a'))
  fx.add('boom', () => {
    throw new Error('故意失败')
  })
  fx.add('c', () => order.push('c'))

  const report = await fx.release()
  assert.deepEqual(order, ['c', 'a'])
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0].label, 'boom')
  assert.match(report.failures[0].error, /故意失败/)
})

test('release 幂等', async () => {
  const fx = new Fixture()
  let count = 0
  fx.add('a', () => {
    count += 1
  })

  await fx.release()
  await fx.release()
  assert.equal(count, 1)
})

test('异步 disposer 也会被 await', async () => {
  const fx = new Fixture()
  const order = []
  fx.add('slow', async () => {
    await new Promise((r) => setTimeout(r, 10))
    order.push('slow')
  })
  fx.add('fast', () => order.push('fast'))

  await fx.release()
  assert.deepEqual(order, ['fast', 'slow'])
})

test('note / noteAppend / snapshot', () => {
  const fx = new Fixture()
  fx.note('a', 1)
  fx.noteAppend('list', 'x')
  fx.noteAppend('list', 'y')

  assert.equal(fx.getNote('a'), 1)
  assert.deepEqual(fx.getNote('list'), ['x', 'y'])
  assert.deepEqual(fx.snapshot(), { a: 1, list: ['x', 'y'] })
})

test('释放后再登记会立即执行 dispose（防泄漏）', async () => {
  const fx = new Fixture()
  await fx.release()

  let ran = false
  fx.add('late', () => {
    ran = true
  })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(ran, true)
})
