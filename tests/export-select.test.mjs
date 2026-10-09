/**
 * `selectExportable` 的单元测试。
 *
 * 它决定**哪些场景进 CI 轨、哪些不进**——是质量门的关键机制，必须被测。
 *
 * 背景（真实需求）：加了 TK-0026 之后，那条场景会**如实失败**（被测对象
 * `dsh-memory` 0.8.1 有个真实的 import 笔误 bug）。如果它进 gate，
 * 本插件的质量门就会被**被测对象的缺陷**染红——这是错的。
 * 所以引入 `fixture` 标签：默认排除，显式 `--include-fixture` 才纳入。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { selectExportable } from '../scripts/export-scenarios.mjs'

const s = (id, { status = 'active', tags = [] } = {}) => ({ id, status, tags })

test('默认排除 fixture 标签的场景', () => {
  const all = [s('TK-0001', { tags: ['smoke'] }), s('TK-0026', { tags: ['fixture'] })]
  const { selected, excluded } = selectExportable(all)

  assert.deepEqual(
    selected.map((x) => x.id),
    ['TK-0001'],
  )
  assert.equal(excluded, 1)
})

test('--include-fixture 时全部纳入', () => {
  const all = [s('TK-0001'), s('TK-0026', { tags: ['fixture'] })]
  const { selected, excluded } = selectExportable(all, { includeFixture: true })

  assert.deepEqual(
    selected.map((x) => x.id),
    ['TK-0001', 'TK-0026'],
  )
  assert.equal(excluded, 0)
})

test('非 active 的场景一律不进（draft / retired / blocked）', () => {
  const all = [
    s('TK-0001'),
    s('DRAFT-1', { status: 'draft' }),
    s('TK-9001', { status: 'retired' }),
    s('TK-9002', { status: 'blocked' }),
  ]
  const { selected, active } = selectExportable(all)
  assert.deepEqual(
    selected.map((x) => x.id),
    ['TK-0001'],
  )
  assert.equal(active.length, 1)
})

test('status 缺省视为 active', () => {
  const { selected } = selectExportable([{ id: 'TK-0001', tags: [] }])
  assert.deepEqual(
    selected.map((x) => x.id),
    ['TK-0001'],
  )
})

test('tags 缺省时不炸（也不被误判成 fixture）', () => {
  const { selected } = selectExportable([{ id: 'TK-0001' }])
  assert.equal(selected.length, 1)
})

test('fixture 与其他标签共存时仍被排除', () => {
  const all = [s('TK-0026', { tags: ['shell', 'python', 'dsh-memory', 'fixture'] })]
  assert.equal(selectExportable(all).selected.length, 0)
})

test('非 fixture 的 tags 不影响选择', () => {
  const all = [s('TK-0001', { tags: ['smoke', 'tool'] }), s('TK-0002', { tags: ['boundary'] })]
  assert.equal(selectExportable(all).selected.length, 2)
})
