/**
 * prompt driver 的单元测试。
 *
 * 这个 driver 的特殊之处：它的"验证"不依赖模型跑一轮，
 * 因为 `systemPrompt.assemble()` 是公开可调的。测试据此分两层：
 * 纯函数（组装结果摘要、变量名规则）+ driver 契约（注册与取证）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { promptDriver, summarizeAssembly, VARIABLE_NAME_RE } from '../lib/kinds/prompt.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('summarizeAssembly：抽出 section / context 的名字与文本', () => {
  const summary = summarizeAssembly({
    sections: [
      { name: 'a', text: 'AAA' },
      { name: 'b', text: 'BBB' },
    ],
    contexts: [{ name: 'c', text: 'CCC' }],
  })
  assert.deepEqual(summary.sectionNames, ['a', 'b'])
  assert.equal(summary.sectionText, 'AAA\nBBB')
  assert.deepEqual(summary.contextNames, ['c'])
  assert.equal(summary.contextText, 'CCC')
})

test('summarizeAssembly：畸形输入不炸', () => {
  assert.deepEqual(summarizeAssembly(undefined).sectionNames, [])
  assert.deepEqual(summarizeAssembly({}).sectionText, '')
  assert.deepEqual(summarizeAssembly({ sections: 'nope' }).sectionNames, [])
  assert.deepEqual(summarizeAssembly({ sections: [{}] }).sectionNames, [''])
})

test('VARIABLE_NAME_RE：符合 DSH 的 [a-z][a-z0-9_]* 约束', () => {
  assert.ok(VARIABLE_NAME_RE.test('testkit_var'))
  assert.ok(VARIABLE_NAME_RE.test('a'))
  assert.ok(VARIABLE_NAME_RE.test('a1_b2'))
  assert.ok(!VARIABLE_NAME_RE.test('testkitVar'), '大写不合法')
  assert.ok(!VARIABLE_NAME_RE.test('_leading'))
  assert.ok(!VARIABLE_NAME_RE.test('1digit'))
  assert.ok(!VARIABLE_NAME_RE.test('has-dash'))
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeSystemPrompt({ hasAssemble = true, assembleThrows = false, hasSection = true } = {}) {
  const sections = []
  const contexts = []
  const variables = new Map()
  const calls = { section: 0, context: 0, variable: 0, assemble: 0 }

  const service = {
    sections,
    contexts,
    variables,
    calls,
    section(spec) {
      calls.section += 1
      sections.push(spec)
      return () => {
        const index = sections.indexOf(spec)
        if (index >= 0) sections.splice(index, 1)
      }
    },
    context(spec) {
      calls.context += 1
      contexts.push(spec)
      return () => {
        const index = contexts.indexOf(spec)
        if (index >= 0) contexts.splice(index, 1)
      }
    },
    variable(name, provider) {
      calls.variable += 1
      variables.set(name, provider)
      return () => variables.delete(name)
    },
  }

  if (!hasSection) delete service.section

  if (hasAssemble) {
    service.assemble = async () => {
      calls.assemble += 1
      if (assembleThrows) throw new Error('组装炸了')
      return {
        sections: [...sections]
          .sort((a, b) => a.order - b.order)
          .map((s) => ({ name: s.name, text: typeof s.text === 'function' ? s.text({}) : s.text })),
        contexts: [...contexts]
          .sort((a, b) => a.order - b.order)
          .map((c) => ({ name: c.name, text: typeof c.text === 'function' ? c.text({}) : c.text })),
        tools: [],
        variables: Object.fromEntries([...variables].map(([k, v]) => [k, v({})])),
      }
    }
  }

  return service
}

function makeCtx(host) {
  return {
    host,
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
}

function hostWith(service) {
  return {
    capabilities: new Set(['systemPrompt']),
    env: { dshVersion: 't', platform: 't', nodeVersion: 't' },
    log: () => undefined,
    registerTool: () => () => undefined,
    service: (name) => (name === 'systemPrompt' ? service : undefined),
  }
}

test('setup：注册 section 与 variable 并主动组装取证', async () => {
  const service = makeSystemPrompt()
  const ctx = makeCtx(hostWith(service))
  const scenario = {
    setup: {
      prompt: {
        section: { name: 'testkit-marker', order: 1200, text: 'MARKER' },
        variable: { name: 'testkit_var', value: 'VALUE' },
      },
    },
  }

  await promptDriver.setup(ctx, scenario)

  assert.equal(service.calls.section, 1)
  assert.equal(service.calls.variable, 1)
  assert.equal(service.calls.assemble, 1, '应主动组装一次')

  assert.deepEqual(ctx.fixture.getNote('sectionNames'), ['testkit-marker'])
  assert.equal(ctx.fixture.getNote('sectionText'), 'MARKER')
  assert.equal(ctx.fixture.getNote('variableValue'), 'VALUE')
  assert.equal(ctx.fixture.getNote('assembleError'), undefined)

  // 释放应摘掉注册
  const report = await ctx.fixture.release()
  assert.equal(report.failures.length, 0)
  assert.equal(service.sections.length, 0)
  assert.equal(service.variables.size, 0)
})

test('setup：context 也能注册', async () => {
  const service = makeSystemPrompt()
  const ctx = makeCtx(hostWith(service))
  const scenario = {
    setup: { prompt: { context: { name: 'testkit-ctx', order: 900, text: 'CTX' } } },
  }

  await promptDriver.setup(ctx, scenario)

  assert.equal(service.calls.context, 1)
  assert.deepEqual(ctx.fixture.getNote('contextNames'), ['testkit-ctx'])
  assert.equal(ctx.fixture.getNote('contextText'), 'CTX')
})

test('setup：非法 variable 名在注册前就被拦下，并给出可读原因', async () => {
  const service = makeSystemPrompt()
  const ctx = makeCtx(hostWith(service))
  const scenario = { setup: { prompt: { variable: { name: 'testkitVar', value: 'v' } } } }

  await assert.rejects(
    () => promptDriver.setup(ctx, scenario),
    /不合法：「testkitVar」/,
  )
  assert.equal(service.calls.variable, 0, '不该把非法名字交给宿主')
})

test('setup：组装失败被记账而非抛出（让 case 自己表达期望）', async () => {
  const service = makeSystemPrompt({ assembleThrows: true })
  const ctx = makeCtx(hostWith(service))
  const scenario = { setup: { prompt: { section: { name: 's', order: 1, text: 't' } } } }

  await promptDriver.setup(ctx, scenario)

  assert.match(String(ctx.fixture.getNote('assembleError')), /组装炸了/)
  assert.equal(ctx.fixture.getNote('assembled'), undefined)
})

test('setup：宿主不提供 assemble 时记账说明，不崩', async () => {
  const service = makeSystemPrompt({ hasAssemble: false })
  const ctx = makeCtx(hostWith(service))
  const scenario = { setup: { prompt: { section: { name: 's', order: 1, text: 't' } } } }

  await promptDriver.setup(ctx, scenario)

  assert.match(String(ctx.fixture.getNote('assembleError')), /不提供 assemble/)
})

test('setup：宿主没有 systemPrompt 服务时抛 SkipCase', async () => {
  const ctx = makeCtx(hostWith(undefined))
  const scenario = { setup: { prompt: { section: { name: 's', order: 1, text: 't' } } } }

  await assert.rejects(() => promptDriver.setup(ctx, scenario), SkipCase)
})

test('setup：服务缺 section() 时抛 SkipCase 而不是 TypeError', async () => {
  const service = makeSystemPrompt({ hasSection: false })
  const ctx = makeCtx(hostWith(service))
  const scenario = { setup: { prompt: { section: { name: 's', order: 1, text: 't' } } } }

  await assert.rejects(() => promptDriver.setup(ctx, scenario), SkipCase)
})

test('setup：setup.prompt 缺失时是空操作', async () => {
  const service = makeSystemPrompt()
  const ctx = makeCtx(hostWith(service))
  await promptDriver.setup(ctx, { setup: {} })
  assert.equal(service.calls.assemble, 0)
})

test('act：prompt 类场景不该有动作，被调用即报错', () => {
  const ctx = makeCtx(hostWith(makeSystemPrompt()))
  assert.throws(() => promptDriver.act(ctx, { tool: 'x' }), /不支持动作/)
})

test('driver 元信息：kind / requires 正确', () => {
  assert.equal(promptDriver.kind, 'prompt')
  assert.deepEqual(promptDriver.requires, ['systemPrompt'])
})
