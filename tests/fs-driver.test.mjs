/**
 * `fs` driver 单元测试——驱动的是**宿主的文件服务语义**，不是 node:fs。
 *
 * 三层：
 *   ① 纯函数：错误码提取、版本摘要、目录项投影
 *   ② setup：工作根（临时根 + 清理）、能力判定
 *   ③ act：写意图 / 陈旧版本 / 沙箱拒绝三条**只有 `ctx.fs` 才有的**语义
 *
 * 这里用内存假服务：不碰真实文件系统，也不依赖宿主。
 * 真实沙箱与版本行为由 `cases/TK-0030` 在活宿主回答。
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  describeEntries,
  extractFsCode,
  fsDriver,
  summarizeVersion,
} from '../lib/kinds/fs.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('extractFsCode：code / info.code / message 里的 FS_* 三种形状都认', () => {
  assert.equal(extractFsCode({ code: 'FS_STALE_VERSION' }), 'FS_STALE_VERSION')
  assert.equal(extractFsCode({ info: { code: 'FS_SANDBOX_DENIED' } }), 'FS_SANDBOX_DENIED')
  assert.equal(
    extractFsCode(new Error('write rejected: FS_STALE_VERSION (stale target)')),
    'FS_STALE_VERSION',
  )
  assert.equal(extractFsCode('FS_TOO_LARGE'), 'FS_TOO_LARGE')
  assert.equal(extractFsCode(new Error('普通错误')), undefined)
  assert.equal(extractFsCode(null), undefined)
  assert.equal(extractFsCode(42), undefined)
})

test('summarizeVersion：短版本原样，长版本折叠', () => {
  assert.equal(summarizeVersion('v1'), 'v1')
  assert.equal(summarizeVersion(''), undefined)
  assert.equal(summarizeVersion(undefined), undefined)
  const long = 'a'.repeat(40)
  assert.match(String(summarizeVersion(long)), /^a{8}…a{4}$/)
})

test('describeEntries：畸形输入不炸', () => {
  assert.deepEqual(describeEntries(undefined), [])
  assert.deepEqual(describeEntries([{ name: 'a', type: 'file', size: 3 }]), [
    { name: 'a', type: 'file', size: 3 },
  ])
  assert.deepEqual(describeEntries([null]), [
    { name: undefined, type: undefined, size: undefined },
  ])
})

/* -------------------------------------------------------- 假 fs 服务层 -- */

function makeFsFake({ ignoresSandbox = false } = {}) {
  const files = new Map()
  const calls = []
  let counter = 0

  const service = {
    resolve: async (path) => ({ targetKey: `key:${path}`, displayPath: path }),
    stat: async (target) => {
      const entry = files.get(target.displayPath)
      return entry === undefined
        ? undefined
        : { version: entry.version, type: 'file', size: entry.text.length }
    },
    readText: async (target) => {
      const entry = files.get(target.displayPath)
      if (entry === undefined) {
        throw Object.assign(new Error(`ENOENT: ${target.displayPath}`), { code: 'FS_NOT_FOUND' })
      }
      return entry.text
    },
    listDir: async (target) =>
      [...files.entries()]
        .filter(([path]) => path.startsWith(target.displayPath))
        .map(([path, entry]) => ({ name: path, type: 'file', version: entry.version })),
    writeText: async (target, text, expected, _signal, policy) => {
      calls.push({ kind: 'write', path: target.displayPath, text, expected, policy })
      if (!ignoresSandbox && policy?.mode === 'read-only') {
        throw Object.assign(new Error('read-only sandbox denied the write'), {
          code: 'FS_SANDBOX_DENIED',
        })
      }
      const entry = files.get(target.displayPath)
      // 与真实契约对齐（活宿主实测）：createIfAbsent 撞上已存在时，
      // DSH 报的是 FS_NOT_OBSERVED（"没先读过就不许覆盖"），
      // 而不是本测试最初自造的 FS_ALREADY_EXISTS。
      if (expected?.kind === 'createIfAbsent' && entry !== undefined) {
        throw Object.assign(new Error('cannot overwrite existing file without reading it first'), {
          code: 'FS_NOT_OBSERVED',
        })
      }
      if (expected?.kind === 'replaceIfVersion' && entry?.version !== expected.version) {
        throw Object.assign(new Error('stale target: FS_STALE_VERSION'), {
          code: 'FS_STALE_VERSION',
        })
      }
      const version = `v${++counter}`
      files.set(target.displayPath, { text, version })
      return {
        operation: entry === undefined ? 'create' : 'update',
        version,
        before: entry?.text ?? null,
        after: text,
      }
    },
    editText: async (target, edit, guard) => {
      const entry = files.get(target.displayPath)
      if (guard !== undefined && entry?.version !== guard.version) {
        throw Object.assign(new Error('stale target: FS_STALE_VERSION'), {
          code: 'FS_STALE_VERSION',
        })
      }
      const before = entry?.text ?? ''
      const after = before.split(edit.oldString).join(edit.newString)
      const version = `v${++counter}`
      files.set(target.displayPath, { text: after, version })
      return { version, before, after }
    },
  }

  return { service, calls, files }
}

function makeHarness({ hasFs = true, fake = makeFsFake() } = {}) {
  const ctx = new Context()
  if (hasFs) ctx.provide('fs', fake.service)
  const fixture = new Fixture()
  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture,
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return { ctx, driverCtx, fake }
}

/* -------------------------------------------------------- driver 契约层 -- */

test('setup：宿主没有 fs 能力时跳过', async () => {
  const { driverCtx } = makeHarness({ hasFs: false })
  await assert.rejects(() => fsDriver.setup(driverCtx, { setup: { fs: {} } }), SkipCase)
})

test('setup：缺省自建临时工作根，并在释放夹具时删掉', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  const root = String(driverCtx.fixture.getNote('fsRoot'))
  assert.ok(root.length > 0)
  assert.ok(existsSync(root), '临时根必须真的建出来')
  assert.equal(driverCtx.fixture.getNote('fsWorkspace'), root, 'workspace 缺省就是 root')

  await driverCtx.fixture.release()
  assert.equal(existsSync(root), false, '场景结束后临时根必须被清掉')
})

test('setup：显式 root 不会被删除（那是调用方的目录）', async () => {
  const { driverCtx } = makeHarness()
  const explicit = process.cwd()
  await fsDriver.setup(driverCtx, { setup: { fs: { root: explicit, workspace: 'lib' } } })

  assert.equal(driverCtx.fixture.getNote('fsRoot'), explicit)
  await driverCtx.fixture.release()
  assert.ok(existsSync(explicit), '显式给定的 root 绝不能删')
})

test('act：write → stat → read 的取证与版本跟踪', async () => {
  const { driverCtx, fake } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await fsDriver.act(driverCtx, { fs: { write: { path: 'a.txt', text: 'hello' } } })
  assert.equal(driverCtx.fixture.getNote('fsOperation'), 'create')
  assert.equal(driverCtx.fixture.getNote('fsBefore'), null)
  assert.equal(driverCtx.fixture.getNote('fsAfter'), 'hello')
  assert.equal(driverCtx.fixture.getNote('fsVersion'), 'v1')
  assert.equal(driverCtx.fixture.getNote('fsWriteIntent'), 'unconditional')
  assert.equal(driverCtx.fixture.getNote('fsError'), undefined)

  await fsDriver.act(driverCtx, { fs: { stat: { path: 'a.txt' } } })
  assert.equal(driverCtx.fixture.getNote('fsExists'), true)
  assert.equal(driverCtx.fixture.getNote('fsType'), 'file')
  assert.equal(driverCtx.fixture.getNote('fsVersion'), 'v1')

  await fsDriver.act(driverCtx, { fs: { read: { path: 'a.txt' } } })
  assert.equal(driverCtx.fixture.getNote('fsText'), 'hello')
  assert.equal(driverCtx.fixture.getNote('fsTextLength'), 5)

  await fsDriver.act(driverCtx, { fs: { list: { path: '' } } })
  assert.equal(driverCtx.fixture.getNote('fsEntryCount'), 1)

  assert.equal(fake.calls.length, 1)
})

test('act：createIfAbsent 撞上已存在 → 记错误码（不抛）', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await fsDriver.act(driverCtx, { fs: { write: { path: 'a.txt', text: 'first' } } })
  await fsDriver.act(driverCtx, {
    fs: { write: { path: 'a.txt', text: 'second', intent: 'createIfAbsent' } },
  })

  assert.match(String(driverCtx.fixture.getNote('fsError')), /without reading it first/)
  assert.equal(driverCtx.fixture.getNote('fsErrorCode'), 'FS_NOT_OBSERVED')
})

test('act：陈旧版本写入 → FS_STALE_VERSION（并发写的核心保护）', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await fsDriver.act(driverCtx, { fs: { write: { path: 'a.txt', text: 'v1' } } })
  // 用 first（=v1）再写一次：成功后 state 必须记住新版本
  await fsDriver.act(driverCtx, {
    fs: { write: { path: 'a.txt', text: 'v2', intent: 'replaceIfVersion', expectedVersion: 'first' } },
  })
  assert.equal(driverCtx.fixture.getNote('fsVersion'), 'v2')
  // 继续用"最老的版本"写 → 必然陈旧
  await fsDriver.act(driverCtx, {
    fs: { write: { path: 'a.txt', text: 'v3', intent: 'replaceIfVersion', expectedVersion: 'first' } },
  })

  assert.equal(driverCtx.fixture.getNote('fsErrorCode'), 'FS_STALE_VERSION')
  assert.equal(driverCtx.fixture.getNote('fsExpectedVersion'), 'v1')
})

test('act：read-only 沙箱拒绝写入，并记下用的模式与根', async () => {
  const { driverCtx, fake } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await fsDriver.act(driverCtx, {
    fs: { write: { path: 'a.txt', text: 'x', sandbox: { mode: 'read-only' } } },
  })

  assert.equal(driverCtx.fixture.getNote('fsErrorCode'), 'FS_SANDBOX_DENIED')
  assert.equal(driverCtx.fixture.getNote('fsSandboxMode'), 'read-only')
  assert.equal(fake.calls[0].policy.mode, 'read-only')
})

test('act：setup 的 mode 会作用到每一次写（动作级可覆盖）', async () => {
  const { driverCtx, fake } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: { mode: 'workspace-write' } } })

  await fsDriver.act(driverCtx, { fs: { write: { path: 'a.txt', text: 'x' } } })
  assert.equal(fake.calls[0].policy.mode, 'workspace-write')
  assert.equal(fake.calls[0].policy.workspaceRoot, driverCtx.fixture.getNote('fsWorkspace'))

  await fsDriver.act(driverCtx, {
    fs: { write: { path: 'b.txt', text: 'y', sandbox: { mode: 'danger-full-access' } } },
  })
  assert.equal(fake.calls[1].policy.mode, 'danger-full-access')
})

test('act：edit 的版本守卫也走同一条陈旧检查', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await fsDriver.act(driverCtx, { fs: { write: { path: 'a.txt', text: 'hello world' } } })
  await fsDriver.act(driverCtx, {
    fs: { edit: { path: 'a.txt', oldString: 'world', newString: 'there', expectedVersion: 'last' } },
  })
  assert.equal(driverCtx.fixture.getNote('fsAfter'), 'hello there')
  assert.equal(driverCtx.fixture.getNote('fsVersion'), 'v2')

  await fsDriver.act(driverCtx, {
    fs: { edit: { path: 'a.txt', oldString: 'there', newString: 'x', expectedVersion: 'first' } },
  })
  assert.equal(driverCtx.fixture.getNote('fsErrorCode'), 'FS_STALE_VERSION')
})

test('act：replaceIfVersion 但从未观测过版本 → 明确报错（而不是瞎猜）', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await fsDriver.act(driverCtx, {
    fs: { write: { path: 'a.txt', text: 'x', intent: 'replaceIfVersion' } },
  })
  assert.match(String(driverCtx.fixture.getNote('fsError')), /需要先观测到一个版本/)
})

test('act：非 fs 动作直接报错；未知 fs 动作记进 fsError', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: {} } })

  await assert.rejects(() => fsDriver.act(driverCtx, { tool: 'x' }), /只支持 `fs` 动作/)
  await fsDriver.act(driverCtx, { fs: { 未知动作: { path: 'a' } } })
  assert.match(String(driverCtx.fixture.getNote('fsError')), /未知的 fs 动作/)
})

test('act：缺 setup.fs 时明确报错（而不是用错工作根）', async () => {
  const { driverCtx } = makeHarness()
  await assert.rejects(
    () => fsDriver.act(driverCtx, { fs: { stat: { path: 'a.txt' } } }),
    /setup\.fs 未执行/,
  )
})

test('setup：probeSandbox 被拒时继续，并留下探测证据', async () => {
  const { driverCtx } = makeHarness()
  await fsDriver.setup(driverCtx, { setup: { fs: { probeSandbox: true } } })

  assert.equal(driverCtx.fixture.getNote('fsSandboxProbe'), 'denied')
  assert.equal(driverCtx.fixture.getNote('fsSandboxProbeCode'), 'FS_SANDBOX_DENIED')
})

test('setup：宿主后端忽略沙箱策略时跳过（而不是假红）', async () => {
  const { driverCtx } = makeHarness({ fake: makeFsFake({ ignoresSandbox: true }) })
  await assert.rejects(
    () => fsDriver.setup(driverCtx, { setup: { fs: { probeSandbox: true } } }),
    (error) => {
      assert.ok(error instanceof SkipCase)
      assert.match(error.message, /不实施 sandboxPolicy/)
      return true
    },
  )
})
