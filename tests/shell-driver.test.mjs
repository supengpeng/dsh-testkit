/**
 * shell driver 的单元测试。
 *
 * 用**假 subprocess 服务**测接线（真跑进程由 `cases/TK-0018` 在活宿主回答）。
 *
 * 重点守三件事：
 *   ① 非零退出码**不是失败**——命令跑完了就是结果，判由断言决定
 *   ② spawn / resolveExecutable 抛错要如实记账，不能崩
 *   ③ 输出按偏移读干净（契约说读取是非消费式的）
 */

import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import { readAll, shellDriver, findPython } from '../lib/kinds/shell.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

/** 造一个按偏移吐字的假 reader。 */
function makeReader(chunks) {
  let served = 0
  return {
    readFrom(fromByte) {
      // 契约：按偏移、非消费式。这里简单地：offset 0 时给第一段，之后逐段递进
      const index = served
      if (index >= chunks.length) return { text: '', nextOffset: fromByte, lossy: false }
      served += 1
      const text = chunks[index]
      return { text, nextOffset: fromByte + text.length, lossy: false }
    },
  }
}

test('readAll：按偏移读干净并拼接', () => {
  const r = readAll(makeReader(['第一段', '第二段']))
  assert.equal(r.text, '第一段第二段')
  assert.equal(r.lossy, false)
})

test('readAll：reader 缺失时返回空而不是抛错', () => {
  assert.deepEqual(readAll(undefined), { text: '', lossy: false, rounds: 0 })
  assert.deepEqual(readAll({}), { text: '', lossy: false, rounds: 0 })
})

test('readAll：lossy 会被如实带出（截断可被发现）', () => {
  const r = readAll({
    readFrom(offset) {
      if (offset === 0) return { text: 'x'.repeat(10), nextOffset: 10, lossy: true }
      return { text: '', nextOffset: offset, lossy: true }
    },
  })
  assert.equal(r.lossy, true)
})

test('readAll：offset 不前进时立即停止（防实现有 bug 时死循环）', () => {
  let calls = 0
  const r = readAll({
    readFrom(offset) {
      calls += 1
      return { text: '', nextOffset: offset, lossy: false }
    },
  })
  assert.equal(calls, 1)
  assert.equal(r.text, '')
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness({ hasSubprocess = true, outcome, spawnThrow, resolveThrow, stdout, stderr } = {}) {
  const spawned = []
  const ctx = new Context()

  if (hasSubprocess) {
    ctx.provide('subprocess', {
      async resolveExecutable(command) {
        if (resolveThrow) throw resolveThrow
        return `/resolved/${command}`
      },
      spawn(spec) {
        if (spawnThrow) throw spawnThrow
        spawned.push(spec)
        return {
          collected: {
            stdout: makeReader(stdout ?? []),
            stderr: makeReader(stderr ?? []),
          },
          done: Promise.resolve(outcome ?? { exitCode: 0, signal: null }),
        }
      },
    })
  }

  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return { driverCtx, spawned }
}

test('act：成功路径把退出码与输出写进取证', async () => {
  const { driverCtx, spawned } = makeHarness({
    outcome: { exitCode: 3, signal: null },
    stdout: ['SMOKE_OK\n'],
    stderr: ['warning: x\n'],
  })

  await shellDriver.act(driverCtx, { shell: { argv: ['git', '--version'] } })

  assert.equal(driverCtx.fixture.getNote('exitCode'), 3)
  assert.equal(driverCtx.fixture.getNote('stdout'), 'SMOKE_OK\n')
  assert.equal(driverCtx.fixture.getNote('stderr'), 'warning: x\n')
  assert.equal(driverCtx.fixture.getNote('shellResolvedArgv0'), '/resolved/git')
  assert.equal(driverCtx.fixture.getNote('spawnError'), undefined)

  // 非零退出码**不是错误**——driver 不该把它当成失败
  assert.equal(driverCtx.fixture.getNote('runError'), undefined)

  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].argv[0], '/resolved/git')
  assert.deepEqual(spawned[0].argv.slice(1), ['--version'])
})

test('act：spawn 抛错如实记账（不崩）', async () => {
  const { driverCtx } = makeHarness({ spawnThrow: new Error('沙箱拒绝执行') })
  await shellDriver.act(driverCtx, { shell: { argv: ['rm', '-rf', '/'] } })
  assert.match(String(driverCtx.fixture.getNote('spawnError')), /沙箱拒绝执行/)
  assert.equal(driverCtx.fixture.getNote('exitCode'), undefined)
})

test('act：resolveExecutable 失败也记账（这是常见真实故障）', async () => {
  const { driverCtx } = makeHarness({ resolveThrow: new Error('ENOENT: python3') })
  await shellDriver.act(driverCtx, { shell: { argv: ['python3', '-V'] } })
  assert.match(String(driverCtx.fixture.getNote('spawnError')), /python3/)
  assert.equal(driverCtx.fixture.getNote('exitCode'), undefined)
})

test('act：done reject 时记账但不崩', async () => {
  const ctx = new Context()
  ctx.provide('subprocess', {
    resolveExecutable: async (c) => `/r/${c}`,
    spawn: () => ({
      collected: {},
      done: Promise.reject(new Error('provider 故障')),
    }),
  })
  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }

  await shellDriver.act(driverCtx, { shell: { argv: ['x'] } })
  assert.match(String(driverCtx.fixture.getNote('runError')), /provider 故障/)
})

test('act：宿主没有 subprocess 时跳过', async () => {
  const { driverCtx } = makeHarness({ hasSubprocess: false })
  await assert.rejects(
    () => shellDriver.act(driverCtx, { shell: { argv: ['git', '--version'] } }),
    SkipCase,
  )
})

test('act：setup 的 cwd/env 会被带入 spawn 规格', async () => {
  const { driverCtx, spawned } = makeHarness()
  // cwd 必须**真实存在**——driver 在显式 cwd 不存在时会 SkipCase（那是有意的：
  // 依赖未准备的 fixture 时应当明确跳过，而不是在莫名其妙的路径上失败）。
  const cwd = process.cwd()
  await shellDriver.setup(driverCtx, { setup: { shell: { cwd, env: { LANG: 'C' } } } })
  await shellDriver.act(driverCtx, { shell: { argv: ['ls'] } })

  assert.equal(spawned[0].cwd, cwd)
  assert.equal(spawned[0].env.LANG, 'C')
  assert.equal(driverCtx.fixture.getNote('shellCwd'), cwd)
})

test('act：动作里的 cwd/env 覆盖 setup', async () => {
  const { driverCtx, spawned } = makeHarness()
  const base = process.cwd()
  await shellDriver.setup(driverCtx, { setup: { shell: { cwd: base, env: { K: 'setup' } } } })
  await shellDriver.act(driverCtx, {
    shell: { argv: ['ls'], cwd: base, env: { K: 'action' } },
  })

  assert.equal(spawned[0].cwd, base)
  assert.equal(spawned[0].env.K, 'action')
})

test('act：显式 cwd 不存在时跳过并说明（依赖未准备的 fixture）', async () => {
  const { driverCtx } = makeHarness()
  await shellDriver.setup(driverCtx, {
    setup: { shell: { cwd: join(tmpdir(), 'definitely-not-here-dsh-testkit') } },
  })
  await assert.rejects(
    () => shellDriver.act(driverCtx, { shell: { argv: ['ls'] } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /cwd 不存在/)
      assert.match(error.message, /fetch-fixtures/, '应指向准备脚本')
      return true
    },
  )
})

test('act：stdin 省略时是 ignore，给了就喂数据', async () => {
  const { driverCtx, spawned } = makeHarness()
  await shellDriver.act(driverCtx, { shell: { argv: ['cat'] } })
  assert.equal(spawned[0].stdio.stdin, 'ignore')

  await shellDriver.act(driverCtx, { shell: { argv: ['cat'], stdin: 'hello' } })
  assert.deepEqual(spawned[1].stdio.stdin, { data: 'hello' })
})

test('act：argv 为空时报错（不静默）', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(() => shellDriver.act(driverCtx, { shell: { argv: [] } }), /非空数组/)
})

test('act：非 shell 动作直接报错', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(() => shellDriver.act(driverCtx, { tool: 'x' }), /只支持 `shell` 动作/)
})

test('findPython：显式环境变量优先（且必须是真实存在的文件）', () => {
  const original = process.env.DSH_TESTKIT_PYTHON
  try {
    process.env.DSH_TESTKIT_PYTHON = process.execPath
    assert.equal(findPython(), process.execPath)

    process.env.DSH_TESTKIT_PYTHON = join(tmpdir(), 'definitely-not-a-python.exe')
    assert.notEqual(findPython(), process.env.DSH_TESTKIT_PYTHON, '不存在的路径要被跳过')
  } finally {
    if (original === undefined) delete process.env.DSH_TESTKIT_PYTHON
    else process.env.DSH_TESTKIT_PYTHON = original
  }
})

test('findPython：推不出自带 Python 时回退成裸名（交给 resolveExecutable）', () => {
  const original = process.env.DSH_TESTKIT_PYTHON
  try {
    delete process.env.DSH_TESTKIT_PYTHON
    delete process.env.DSH_PYTHON
    // 在非 DSH 进程里（process.execPath 是 node），推不出自带 Python；
    // 真实 DSH 里会命中"<安装目录>/resources/runtime/*/dependencies/python"那一档。
    const found = findPython()
    assert.ok(typeof found === 'string' && found.length > 0)
  } finally {
    if (original !== undefined) process.env.DSH_TESTKIT_PYTHON = original
  }
})

test('driver 元信息：kind=shell 且 requires 声明 subprocess', () => {
  assert.equal(shellDriver.kind, 'shell')
  assert.deepEqual(shellDriver.requires, ['subprocess'])
})
