/**
 * headless 宿主的单元测试。
 *
 * 它是**产品代码**（CI 轨依赖它），所以必须自己被测。
 * 重点不在"能不能装配"，而在**替身语义是否与真实契约一致**——
 * 替身不一致比没有替身更危险。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHeadlessHost, HEADLESS_CAPABILITIES } from '../lib/headless/index.js'

/* ------------------------------------------------------------- 装配与门面 -- */

test('默认提供全部已实现的能力', async () => {
  const headless = await createHeadlessHost()
  try {
    for (const capability of HEADLESS_CAPABILITIES) {
      assert.ok(headless.host.capabilities.has(capability), `应提供 ${capability}`)
    }
    // 没有最小实现的能力不该被谎报
    for (const absent of ['fs', 'subprocess', 'agentLoop', 'storage', 'timer', 'client', 'session']) {
      assert.ok(!headless.host.capabilities.has(absent), `不该声称提供 ${absent}`)
    }
  } finally {
    await headless.dispose()
  }
})

test('capabilities 选项可限定提供的服务', async () => {
  const headless = await createHeadlessHost({ capabilities: ['tools'] })
  try {
    assert.ok(headless.host.capabilities.has('tools'))
    assert.ok(!headless.host.capabilities.has('llm'))
    assert.ok(!headless.host.capabilities.has('web'))
  } finally {
    await headless.dispose()
  }
})

test('env 可注入（进报告溯源）', async () => {
  const headless = await createHeadlessHost({
    capabilities: ['tools'],
    env: { dshVersion: '9.9.9', platform: 'plan9' },
  })
  try {
    assert.equal(headless.host.env.dshVersion, '9.9.9')
    assert.equal(headless.host.env.platform, 'plan9')
  } finally {
    await headless.dispose()
  }
})

test('dispose 可重复调用且不抛错', async () => {
  const headless = await createHeadlessHost()
  await headless.dispose()
  await headless.dispose()
})

/* ------------------------------------------------------------------ tools -- */

test('tools：注册 → execute → 返回值与内容都被渲染', async () => {
  const headless = await createHeadlessHost({ capabilities: ['tools'] })
  try {
    headless.host.registerTool({
      name: 'probe',
      description: 'd',
      execute: () => 'hello',
    })

    assert.deepEqual(headless.services.tools.registeredNames(), ['probe'])
    const result = await headless.services.tools.execute({ name: 'probe', arguments: {} })
    assert.equal(result.isError, false)
    assert.equal(result.value, 'hello')
    // defineTool 的 output.render 是 stringifyToolValue → 字符串原样
    assert.equal(result.content[0].text, 'hello')
  } finally {
    await headless.dispose()
  }
})

test('tools：guard 先于 dispatch，且拦下的调用也计入 executions', async () => {
  const headless = await createHeadlessHost({ capabilities: ['tools'] })
  try {
    let bodyRan = false
    headless.host.registerTool({
      name: 'guarded',
      description: 'd',
      execute: () => {
        bodyRan = true
        return 'BODY'
      },
    })
    headless.services.tools.guard((exec) => (exec.name === 'guarded' ? '不许跑' : undefined))

    const result = await headless.services.tools.execute({ name: 'guarded', arguments: {} })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /不许跑/)
    assert.equal(bodyRan, false, '被 guard 拦下时工具本体不该执行')
    assert.equal(headless.services.tools.executions, 1)
  } finally {
    await headless.dispose()
  }
})

test('tools：未知工具报 UNKNOWN_TOOL 而不是抛错', async () => {
  const headless = await createHeadlessHost({ capabilities: ['tools'] })
  try {
    const result = await headless.services.tools.execute({ name: 'nope', arguments: {} })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /UNKNOWN_TOOL/)
  } finally {
    await headless.dispose()
  }
})

test('tools：工具抛错被物化成 error 结果', async () => {
  const headless = await createHeadlessHost({ capabilities: ['tools'] })
  try {
    headless.host.registerTool({
      name: 'boom',
      description: 'd',
      execute: () => {
        throw new Error('炸了')
      },
    })
    const result = await headless.services.tools.execute({ name: 'boom', arguments: {} })
    assert.equal(result.isError, true)
    assert.match(result.error.message, /炸了/)
  } finally {
    await headless.dispose()
  }
})

test('tools：arguments 非对象被拒（如实反映 defineTool 的校验）', async () => {
  const headless = await createHeadlessHost({ capabilities: ['tools'] })
  try {
    headless.host.registerTool({ name: 'probe', description: 'd', execute: () => 'ok' })

    // 不传 arguments —— 真实 defineTool 会拒绝，替身也必须拒绝，
    // 否则会掩盖"调用方忘了传参数对象"这类 bug
    const missing = await headless.services.tools.execute({ name: 'probe' })
    assert.equal(missing.isError, true)
    assert.match(missing.error.message, /invalid arguments/)

    const notObject = await headless.services.tools.execute({ name: 'probe', arguments: 'str' })
    assert.equal(notObject.isError, true)
    assert.match(notObject.error.message, /invalid arguments/)
  } finally {
    await headless.dispose()
  }
})

/* ----------------------------------------------------------- systemPrompt -- */

test('systemPrompt：section 按 order 排序，variable 可取值', async () => {
  const headless = await createHeadlessHost({ capabilities: ['systemPrompt'] })
  try {
    const sp = headless.services.systemPrompt
    sp.section({ name: 'later', order: 20, text: 'B' })
    sp.section({ name: 'earlier', order: 10, text: 'A' })
    sp.variable('k', () => 'v')

    const assembly = await sp.assemble()
    assert.deepEqual(assembly.sections.map((s) => s.name), ['earlier', 'later'], '应按 order 排序')
    assert.equal(assembly.variables.k, 'v')
  } finally {
    await headless.dispose()
  }
})

test('systemPrompt：section 的 text 可以是函数（每次组装求值）', async () => {
  const headless = await createHeadlessHost({ capabilities: ['systemPrompt'] })
  try {
    let counter = 0
    headless.services.systemPrompt.section({
      name: 'dynamic',
      order: 1,
      text: () => `n=${(counter += 1)}`,
    })
    assert.equal((await headless.services.systemPrompt.assemble()).sections[0].text, 'n=1')
    assert.equal((await headless.services.systemPrompt.assemble()).sections[0].text, 'n=2')
  } finally {
    await headless.dispose()
  }
})

/* -------------------------------------------------------------------- web -- */

test('web：未配 id 且只有一个可用 provider 时选中它', async () => {
  const headless = await createHeadlessHost({ capabilities: ['web'] })
  try {
    headless.services.web.registerSearchProvider({
      id: 'only',
      available: () => true,
      search: async () => ({ sources: [{ url: 'u' }], truncated: false }),
    })
    const result = await headless.services.web.search({ query: 'q' })
    assert.equal(result.sources.length, 1)
  } finally {
    await headless.dispose()
  }
})

test('web：未配 id 且有多个可用 provider 时报 AMBIGUOUS（契约语义）', async () => {
  const headless = await createHeadlessHost({ capabilities: ['web'] })
  try {
    const make = (id) => ({ id, available: () => true, search: async () => ({ sources: [], truncated: false }) })
    headless.services.web.registerSearchProvider(make('a'))
    headless.services.web.registerSearchProvider(make('b'))

    await assert.rejects(
      () => headless.services.web.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_AMBIGUOUS',
    )
  } finally {
    await headless.dispose()
  }
})

test('web：配置了未注册的 id 时报 CONFIGURED_MISSING', async () => {
  const headless = await createHeadlessHost({ capabilities: ['web'] })
  try {
    headless.services.web.searchProviderId = 'ghost'
    await assert.rejects(
      () => headless.services.web.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
    )
  } finally {
    await headless.dispose()
  }
})

test('web：配置的 provider 不可用时报 CONFIGURED_UNAVAILABLE', async () => {
  const headless = await createHeadlessHost({ capabilities: ['web'] })
  try {
    headless.services.web.registerSearchProvider({
      id: 'sick',
      available: () => false,
      search: async () => ({ sources: [], truncated: false }),
    })
    headless.services.web.searchProviderId = 'sick'
    await assert.rejects(
      () => headless.services.web.search({ query: 'q' }),
      (error) => error.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    )
  } finally {
    await headless.dispose()
  }
})

test('web：seam 负责按 maxResults 截断并置 truncated', async () => {
  const headless = await createHeadlessHost({ capabilities: ['web'] })
  try {
    headless.services.web.registerSearchProvider({
      id: 'many',
      available: () => true,
      // provider 故意多返回
      search: async () => ({ sources: [{ url: '1' }, { url: '2' }, { url: '3' }], truncated: false }),
    })
    const result = await headless.services.web.search({ query: 'q', maxResults: 2 })
    assert.equal(result.sources.length, 2)
    assert.equal(result.truncated, true)
  } finally {
    await headless.dispose()
  }
})

/* -------------------------------------------------- llm / interaction 服务 -- */

test('llm：stream 走 llm/stream waterfall，无 listener 时才落到真实适配器位', async () => {
  const headless = await createHeadlessHost({ capabilities: ['llm'] })
  try {
    const chunks = []
    for await (const chunk of headless.services.llm.stream({ provider: 'p', model: 'm', messages: [] })) {
      chunks.push(chunk.type)
    }
    assert.deepEqual(chunks, ['finish'], '无 listener 时应走到兜底实现')
    assert.equal(headless.services.llm.realAdapterCalls, 1)
  } finally {
    await headless.dispose()
  }
})

test('interaction：userQuestions / approval 都走 waterfall，兜底值符合 DSH 语义', async () => {
  const headless = await createHeadlessHost({ capabilities: ['userQuestions', 'approval'] })
  try {
    // 无答者：提问走 next 得到空答案；审批 fail closed 成 unavailable
    assert.deepEqual(await headless.services.userQuestions.ask({ questions: [] }), { answers: [] })
    assert.equal(await headless.services.approval.request({ agent: { id: 'a' }, toolName: 'bash' }), 'unavailable')
  } finally {
    await headless.dispose()
  }
})

/* ---------------------------------------------------------- 与插件协作 -- */

test('headless 宿主可承载插件装配（工具面 /路由 都能注册上）', async () => {
  const headless = await createHeadlessHost()
  try {
    // 直接经 facade 注册，验证 headless 与真实宿主在 facades 层同构
    const disposeTool = headless.host.registerTool({
      name: 'from-headless',
      description: 'd',
      execute: () => 1,
    })
    assert.ok(headless.services.tools.registeredNames().includes('from-headless'))

    const disposeRoute = headless.services.webServer.register({ kind: 'exact', path: '/x' })
    assert.equal(headless.services.webServer.routes().length, 1)

    disposeRoute()
    disposeTool()
    assert.equal(headless.services.webServer.routes().length, 0)
    assert.ok(!headless.services.tools.registeredNames().includes('from-headless'))
  } finally {
    await headless.dispose()
  }
})
