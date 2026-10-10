/**
 * ui driver 的单元测试。
 *
 * 这个 driver 的特别之处：它在 Node 里验证**浏览器产物**。
 * 所以测试分两层：
 *   ① `inspectClientBundle` 直接用**手写的 bundle 字符串**测（可控、可穷举）
 *   ② driver 契约用假 fixture 测
 *
 * 真实的 `lib/client.js` 由 `cases/TK-0015` 在端到端里验证——那才是"产物对不对"的答案。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Fixture } from '../lib/runtime/fixture.js'
import { inspectClientBundle, uiDriver } from '../lib/kinds/ui.js'

/** 造一个最小可用的 client bundle 源码（形态与 esbuild 产物一致）。 */
function makeBundle(
  { id = 'dsh-testkit', name = 'dsh-testkit', inject = ['slots', 'locale'], body } = {},
) {
  const applyBody =
    body ??
    `
    ctx.effect(() => ctx.locale.register('dsh-testkit', { zh: {}, en: {} }), 'dict')
    ctx.effect(
      () =>
        ctx.slots.inject('conversation.view', () =>
          ctx.slots.register({ name: 'conversation.view', id: 'testkit', order: 30 }, () => null),
        ),
      'tab',
    )
  `
  return `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var React = require("react");
exports.name = ${JSON.stringify(name)};
exports.inject = ${JSON.stringify(inject)};
exports.apply = function apply(ctx) {${applyBody}};
return module.exports;
}});`
}

/* --------------------------------------------------- ① bundle 检查器 -- */

test('inspectClientBundle：抓取模块 id / name / inject / apply', () => {
  const o = inspectClientBundle(makeBundle(), '/fake/client.js')
  assert.equal(o.moduleId, 'dsh-testkit')
  assert.equal(o.name, 'dsh-testkit')
  assert.deepEqual(o.inject, ['slots', 'locale'])
  assert.equal(o.hasApply, true)
  assert.equal(o.loadCalls, 1)
})

test('inspectClientBundle：记录 locale 注册与 slot 注册', () => {
  const o = inspectClientBundle(makeBundle(), '/fake/client.js')
  assert.deepEqual(
    o.localeCalls.map((c) => c.namespace),
    ['dsh-testkit'],
  )
  assert.deepEqual(o.injectedSlots, ['conversation.view'])
  assert.deepEqual(o.registeredSlots, [{ name: 'conversation.view', id: 'testkit', order: 30 }])
  assert.equal(o.rendererProvided, true)
  assert.deepEqual(o.effectLabels, ['dict', 'tab'])
  assert.equal(o.applyError, undefined)
})

test('inspectClientBundle：apply 抛错被如实记录（不炸掉检查器）', () => {
  const o = inspectClientBundle(
    makeBundle({ body: 'throw new Error("注册失败")' }),
    '/fake/client.js',
  )
  assert.match(String(o.applyError), /注册失败/)
})

test('inspectClientBundle：没有 apply 时不执行，也不报错', () => {
  const source = `window.__ModuleLoader__.load({ id: 'x', factory: (require) => ({ name: 'x' }) });`
  const o = inspectClientBundle(source, '/fake/client.js')
  assert.equal(o.hasApply, false)
  assert.equal(o.applyError, undefined)
  assert.deepEqual(o.registeredSlots, [])
})

test('inspectClientBundle：产物没有 load 调用时返回空观察（不抛）', () => {
  const o = inspectClientBundle('var x = 1;', '/fake/client.js')
  assert.equal(o.loadCalls, 0)
  assert.equal(o.moduleId, undefined)
  assert.equal(o.hasApply, false)
})

test('inspectClientBundle：bundle 请求未提供的模块时给出点名错误', () => {
  // external 之外的依赖不该出现；报错要能说清是哪个
  const o = inspectClientBundle(
    makeBundle({ body: 'require("some-unknown-lib");' }),
    '/fake/client.js',
  )
  assert.match(String(o.applyError), /some-unknown-lib/)
})

test('inspectClientBundle：React 替身可用（createElement 能造元素）', () => {
  const o = inspectClientBundle(
    makeBundle({ body: 'globalThis.__probe = React.createElement("div", null);' }),
    '/fake/client.js',
  )
  assert.equal(o.applyError, undefined)
})

/* -------------------------------------------------------- driver 契约 -- */

function makeDriverCtx() {
  return {
    host: {},
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
}

test('act：bundle 不存在时记 uiBundleExists=false 而不是抛错', async () => {
  const ctx = makeDriverCtx()
  await uiDriver.setup(ctx, { setup: { ui: { bundle: '/definitely/not/here.js' } } })

  await uiDriver.act(ctx, { ui: { load: true } })

  assert.equal(ctx.fixture.getNote('uiBundleExists'), false)
  assert.equal(ctx.fixture.getNote('uiBundleBytes'), 0)
  assert.match(String(ctx.fixture.getNote('uiError')), /读不到 bundle/)
})

test('act：load=false 时只验存在性，不执行 apply', async () => {
  const ctx = makeDriverCtx()
  await uiDriver.act(ctx, { ui: { load: false } })

  assert.equal(ctx.fixture.getNote('uiBundleExists'), true)
  assert.ok(Number(ctx.fixture.getNote('uiBundleBytes')) > 0)
  assert.equal(ctx.fixture.getNote('uiRegisteredSlotNames'), undefined, '不该执行 apply')
})

test('act：真实产物被加载并注册了 conversation.view', async () => {
  const ctx = makeDriverCtx()
  await uiDriver.setup(ctx, { setup: { ui: { expectSlots: ['conversation.view'] } } })

  await uiDriver.act(ctx, { ui: { load: true } })

  assert.equal(ctx.fixture.getNote('uiBundleExists'), true)
  // 模块 id = npm 包名（现在已改 scoped）；插件身份（uiName）仍是产品名 dsh-testkit。
  // 两者的区别与理由写在 cases/TK-0015.yaml 与 scripts/build-client.mjs 的注释里。
  assert.equal(ctx.fixture.getNote('uiModuleId'), '@supengpeng/dsh-testkit')
  assert.equal(ctx.fixture.getNote('uiName'), 'dsh-testkit')
  assert.equal(ctx.fixture.getNote('uiHasApply'), true)
  assert.equal(ctx.fixture.getNote('uiError'), undefined)
  assert.ok(
    ctx.fixture.getNote('uiRegisteredSlotNames').includes('conversation.view'),
    '真实产物必须注册会话视图标签',
  )
  assert.ok(ctx.fixture.getNote('uiLocaleNamespaces').includes('dsh-testkit'))
})

test('act：声明了期望但产物没注册时立即失败（附实际注册项）', async () => {
  const ctx = makeDriverCtx()
  await uiDriver.setup(ctx, { setup: { ui: { expectSlots: ['some.missing.slot'] } } })

  await assert.rejects(
    () => uiDriver.act(ctx, { ui: { load: true } }),
    (error) => {
      assert.match(error.message, /some\.missing\.slot/)
      assert.match(error.message, /conversation\.view/, '应把实际注册的列出来')
      return true
    },
  )
})

test('act：声明了期望词典命名空间但没注册时立即失败', async () => {
  const ctx = makeDriverCtx()
  await uiDriver.setup(ctx, { setup: { ui: { expectLocaleNamespaces: ['nope'] } } })

  await assert.rejects(
    () => uiDriver.act(ctx, { ui: { load: true } }),
    /没有注册期望的词典命名空间/,
  )
})

test('act：非 ui 动作直接报错', async () => {
  const ctx = makeDriverCtx()
  await assert.rejects(() => uiDriver.act(ctx, { tool: 'x' }), /只支持 `ui` 动作/)
})

test('driver 元信息：kind=ui 且不静态声明 requires（纯离线）', () => {
  assert.equal(uiDriver.kind, 'ui')
  assert.deepEqual(uiDriver.requires, [], 'ui 验证不需要宿主服务，CI 轨也能跑')
})
