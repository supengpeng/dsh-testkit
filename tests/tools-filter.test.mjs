/**
 * 工具面的**选择器语义**回归网。
 *
 * 守的是一条容易写错、错了又很隐蔽的规则：
 *   · 省略选择器 → 只跑 `active`（draft 绝不能混进默认回归集）
 *   · **显式给 `ids`** → 不再限制 status（按 id 单跑 draft 是刻意支持的用法）
 *
 * 为什么值得单独测：`status: ['active']` 曾被无条件写死，于是「按 id 单跑 draft」
 * 静默地选中 0 条场景——报告显示「合计 0」而不是报错，最难查。
 * team 通道的场景（`TK-0027`）正是靠这条规则才跑得起来。
 *
 * 测试用 stub 注册表记录**实际传给 `filter()` 的选择器**，
 * 因此不需要真跑任何 driver，也不花 token。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createDriverRegistry } from '../lib/kinds/index.js'
import { defineTestkitTools } from '../lib/tools.js'

function makeHarness() {
  const seen = []
  const registry = {
    dir: 'cases',
    all: [],
    invalidCases: [],
    problems: [],
    get: () => undefined,
    filter(query) {
      seen.push(query)
      return []
    },
  }
  const dir = mkdtempSync(join(tmpdir(), 'testkit-tools-'))

  const tools = defineTestkitTools({
    registry,
    drivers: createDriverRegistry(),
    host: {
      capabilities: new Set(),
      service: () => undefined,
      on: () => () => undefined,
      waterfall: (_name, _args, next) => next(),
      registerTool: () => () => undefined,
      registerCommand: () => () => undefined,
      log: () => undefined,
      env: { dshVersion: 'test', platform: 'test', nodeVersion: 'test' },
    },
    runsDir: () => dir,
    exportDir: () => dir,
    defaultTimeoutMs: () => 1000,
    maxInvalidReported: () => 5,
  })

  const run = tools.find((t) => t.name === 'testkit_run')
  assert.ok(run, 'testkit_run 工具必须存在')

  return {
    seen,
    run,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function callRun(harness, args) {
  return harness.run.execute(args, { signal: new AbortController().signal })
}

test('testkit_run：省略选择器 → 只跑 active', async () => {
  const h = makeHarness()
  try {
    await callRun(h, {})
    assert.deepEqual(h.seen[0], { status: ['active'] })
  } finally {
    h.dispose()
  }
})

test('testkit_run：显式给 ids → 不再限制 status（draft 可按 id 单跑）', async () => {
  const h = makeHarness()
  try {
    await callRun(h, { ids: ['TK-0027'] })
    assert.deepEqual(h.seen[0], { ids: ['TK-0027'] })
    assert.equal('status' in h.seen[0], false, '显式点名时不能附加 status 过滤')
  } finally {
    h.dispose()
  }
})

test('testkit_run：只给 kinds / tags → 仍然只跑 active', async () => {
  const h = makeHarness()
  try {
    await callRun(h, { kinds: ['agent'] })
    assert.deepEqual(h.seen[0], { kinds: ['agent'], status: ['active'] })

    await callRun(h, { tags: ['manual'] })
    assert.deepEqual(h.seen[1], { tags: ['manual'], status: ['active'] })
  } finally {
    h.dispose()
  }
})

test('testkit_run：ids 与其它选择器同给时也保留 ids', async () => {
  const h = makeHarness()
  try {
    await callRun(h, { ids: ['TK-0027'], kinds: ['agent'], tags: ['manual'] })
    assert.deepEqual(h.seen[0], { ids: ['TK-0027'], kinds: ['agent'], tags: ['manual'] })
  } finally {
    h.dispose()
  }
})
