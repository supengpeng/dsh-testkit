/**
 * session driver 的单元测试。
 *
 * 覆盖命令失败的两条路径——**返回 error 结果**与**抛异常**——
 * 它们在 DSH 里最终都会被表达成 `kind: 'error'`，但过程不同，
 * 混在一起测会掩盖"到底是哪条路径生效了"。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import {
  buildCommandDefinition,
  sessionDriver,
  TESTKIT_COMMAND_ERROR,
} from '../lib/kinds/session.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

/** 便捷构造一个未取消的 signal（.mjs 里不能写类型标注）。 */
const signal = () => new AbortController().signal

test('buildCommandDefinition：缺省回显输入（并填好元信息）', async () => {
  const def = buildCommandDefinition({ name: 'echo', inputHint: '<x>' })
  assert.equal(def.name, 'echo')
  assert.equal(def.description, 'dsh-testkit 临时命令 echo')
  assert.equal(def.inputHint, '<x>')

  const result = await def.execute('hello', signal())
  assert.deepEqual(result, { kind: 'success', text: 'echo:hello' })
})

test('buildCommandDefinition：returns 覆盖回显', async () => {
  const def = buildCommandDefinition({ name: 'c', returns: '固定输出' })
  assert.deepEqual(await def.execute('ignored', signal()), {
    kind: 'success',
    text: '固定输出',
  })
})

test('buildCommandDefinition：error=true 返回 error 结果（不抛）', async () => {
  const def = buildCommandDefinition({ name: 'c', error: true })
  const result = await def.execute('', signal())
  assert.equal(result.kind, 'error')
  assert.equal(result.text, TESTKIT_COMMAND_ERROR)
})

test('buildCommandDefinition：throws 走异常路径（与 error 不同）', async () => {
  const def = buildCommandDefinition({ name: 'c', throws: '炸了' })
  await assert.rejects(() => def.execute('', signal()), /炸了/)
})

test('buildCommandDefinition：throws 优先于 error', async () => {
  const def = buildCommandDefinition({ name: 'c', throws: '炸了', error: true })
  await assert.rejects(() => def.execute('', signal()), /炸了/)
})

test('buildCommandDefinition：已取消的 signal 立即拒绝', async () => {
  const controller = new AbortController()
  controller.abort()
  const def = buildCommandDefinition({ name: 'c', delayMs: 1000 })
  await assert.rejects(() => def.execute('', controller.signal), /aborted/)
})

test('buildCommandDefinition：执行是可重复的（无隐藏状态）', async () => {
  const def = buildCommandDefinition({ name: 'c', returns: 'X' })
  const a = await def.execute('1', signal())
  const b = await def.execute('2', signal())
  assert.deepEqual(a, b)
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness({ services = ['commands'] } = {}) {
  const ctx = new Context()
  const registered = []

  if (services.includes('commands')) {
    ctx.provide('commands', {
      register(definition) {
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    })
  }

  return { ctx, registered }
}

function makeDriverCtx(ctx) {
  return {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
}

test('setup：把命令注册进宿主，并走 facade 的 DSH 形状', async () => {
  const { ctx, registered } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)

  await sessionDriver.setup(driverCtx, {
    setup: { session: { command: { name: 'testkit-echo', returns: 'ok' } } },
  })

  assert.equal(registered.length, 1)
  // facade 交出的是 DSH 的 CommandDefinition 形状
  assert.equal(registered[0].name, 'testkit-echo')
  assert.equal(typeof registered[0].handler, 'function')
  assert.deepEqual(driverCtx.fixture.getNote('registeredCommands'), ['testkit-echo'])

  const report = await driverCtx.fixture.release()
  assert.equal(report.failures.length, 0)
  assert.equal(registered.length, 0, '释放后宿主的注册应被撤销')
})

test('setup：宿主没有 commands 能力时抛 SkipCase', async () => {
  const { ctx } = makeHarness({ services: [] })
  const driverCtx = makeDriverCtx(ctx)

  await assert.rejects(
    () =>
      sessionDriver.setup(driverCtx, {
        setup: { session: { command: { name: 'c' } } },
      }),
    SkipCase,
  )
})

test('act：驱动命令成功并写全取证', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await sessionDriver.setup(driverCtx, {
    setup: { session: { command: { name: 'testkit-echo', returns: '命令输出' } } },
  })

  await sessionDriver.act(driverCtx, {
    session: { command: { name: 'testkit-echo', input: 'hello' } },
  })

  assert.equal(driverCtx.fixture.getNote('commandCount'), 1)
  assert.equal(driverCtx.fixture.getNote('commandKind'), 'success')
  assert.equal(driverCtx.fixture.getNote('commandText'), '命令输出')
  assert.equal(driverCtx.fixture.getNote('commandError'), undefined)
  assert.deepEqual(driverCtx.fixture.getNote('commandInvocations'), [
    { index: 1, name: 'testkit-echo', rawInput: 'hello' },
  ])

  await driverCtx.fixture.release()
})

test('act：error 结果路径不抛异常，但 kind 为 error', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await sessionDriver.setup(driverCtx, {
    setup: { session: { command: { name: 'c', error: true, returns: '注定失败' } } },
  })

  await sessionDriver.act(driverCtx, { session: { command: { name: 'c' } } })

  assert.equal(driverCtx.fixture.getNote('commandError'), undefined, '不该抛异常')
  assert.equal(driverCtx.fixture.getNote('commandKind'), 'error')
  assert.equal(driverCtx.fixture.getNote('commandText'), '注定失败')

  await driverCtx.fixture.release()
})

test('act：异常路径被记账进 commandError', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await sessionDriver.setup(driverCtx, {
    setup: { session: { command: { name: 'c', throws: '炸了' } } },
  })

  await sessionDriver.act(driverCtx, { session: { command: { name: 'c' } } })

  assert.match(String(driverCtx.fixture.getNote('commandError')), /炸了/)
  assert.equal(driverCtx.fixture.getNote('commandKind'), undefined, '异常时没有结果对象')

  await driverCtx.fixture.release()
})

test('act：驱动未注册的命令时明确报错（而不是静默什么都不做）', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)

  await assert.rejects(
    () => sessionDriver.act(driverCtx, { session: { command: { name: '不存在' } } }),
    /未注册/,
  )
})

test('act：release 之后命令索引失效（证明状态确实挂在 Fixture 上）', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await sessionDriver.setup(driverCtx, { setup: { session: { command: { name: 'c' } } } })
  await driverCtx.fixture.release()

  // 新 Fixture 没有登记过任何命令——用同一个 driverCtx 但清掉索引不可行，
  // 这里验证的是"索引是按 Fixture 隔离的"：换一个 fixture 就找不到
  const freshCtx = makeDriverCtx(ctx)
  await assert.rejects(
    () => sessionDriver.act(freshCtx, { session: { command: { name: 'c' } } }),
    /未注册/,
  )
})

test('act：非 session 动作直接报错', async () => {
  const { ctx } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await assert.rejects(
    () => sessionDriver.act(driverCtx, { tool: 'x' }),
    /只支持 `session` 动作/,
  )
})

test('setup：没有 command 声明时是空操作', async () => {
  const { ctx, registered } = makeHarness()
  const driverCtx = makeDriverCtx(ctx)
  await sessionDriver.setup(driverCtx, { setup: {} })
  assert.equal(registered.length, 0)
})

test('driver 元信息：kind / requires 正确', () => {
  assert.equal(sessionDriver.kind, 'session')
  assert.deepEqual(sessionDriver.requires, ['commands'])
})
