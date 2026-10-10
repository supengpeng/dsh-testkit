/**
 * host-facade 适配面的契约（P0 §5.4）。
 *
 * ## 契约出处（不凭印象）
 *
 *   · 被测面：本仓 `src/host-facade.ts` —— **全项目唯一**把 DSH API 翻译成
 *     窄接口 `HostFacade` 的地方（`src/kinds/types.ts` 定义接口）。
 *   · `on` / `waterfall` / `effect` 的真实语义来自 `@deepseek-ai/cordis@4.0.4`
 *     发行体 `lib/index.js`：
 *       - `Context.on(name, listener, options)` 返回 disposer（`register` → `fiber.effect`）
 *       - `Context.waterfall(scope, name, ...args, next)`：listener 由外到内包裹 `next`，
 *         不调 `next` 即否决链尾
 *   · `registerTool` 的产物形状来自 `@deepseek-ai/dsh-tools` 发行体
 *     `lib/types/schema.js` 的 `defineTool`（返回 `parameters` 为 object 根 JSON Schema，
 *     并产出 `execute` / `output.render` / `isConcurrencySafe` / `timeoutMs`）。
 *
 * ## 这里只约束形状与语义
 *
 * 「谁返回 disposer」「注册能不能解绑」「宿主缺能力时是抛还是拒」「env 从哪来」——
 * 不碰内部实现。用例都只走 `HostFacade` 的公开 8 个成员。
 *
 * 用法：`makeHostFacadeContract()` 打真实实现；传入替换工厂即可把同一套契约
 * 打到**形状被破坏的替身**上（`tests/contracts/runner.test.mjs` 的反安慰剂用例）。
 */

import assert from 'node:assert/strict'

import { createHostFacade } from '../../lib/host-facade.js'

export const HOST_FACADE_CONTRACT_VERSION = '1.0.0'

/**
 * 造一个最小假 ctx（**不是**真 cordis Context）。
 *
 * 为什么不直接 `new Context()`：契约要能独立验证"宿主缺能力/没有 on/没有 waterfall"
 * 这些分支，而真 Context 永远有这些成员。假 ctx 只实现被探测的那几个面，
 * 与本仓 `src/host-facade.ts` 的 `ctx.get()` 探测纪律一致。
 */
export function makeFakeCtx({ services = {}, on = 'ok', waterfall = 'ok' } = {}) {
  const listeners = new Map()
  const onCalls = []
  const waterfallCalls = []
  const ctx = {
    get(name) {
      return services[name]
    },
  }
  if (on === 'ok') {
    ctx.on = (event, listener, options) => {
      onCalls.push({ event, options })
      const list = listeners.get(event) ?? []
      if (options?.prepend) list.unshift(listener)
      else list.push(listener)
      listeners.set(event, list)
      return () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      }
    }
  } else if (on === 'throw') {
    ctx.on = () => {
      throw new Error('宿主 on 不可用')
    }
  }
  if (waterfall === 'ok') {
    ctx.waterfall = function (...args) {
      const scope = args.shift()
      const name = args.shift()
      const next = args.pop()
      waterfallCalls.push({ scope, name, args: [...args] })
      return next(...args)
    }
  }
  const emit = (event, ...args) => {
    for (const listener of [...(listeners.get(event) ?? [])]) listener(...args)
  }
  return { ctx, emit, onCalls, waterfallCalls }
}

export function makeHostFacadeContract(createFacade = createHostFacade) {
  const build = (ctx, extra = {}) =>
    createFacade({ ctx, dshVersion: 'contract-1.0.0', log: () => {}, ...extra })

  return {
    version: HOST_FACADE_CONTRACT_VERSION,
    adapter: 'host-facade',
    tests: [
      {
        name: 'capabilities 是只读集合：has/size/迭代/forEach 可用，且没有 add/delete',
        run() {
          const { ctx } = makeFakeCtx({ services: { tools: {}, llm: {} } })
          const capabilities = build(ctx).capabilities

          assert.equal(capabilities.has('tools'), true)
          assert.equal(capabilities.has('llm'), true)
          assert.equal(capabilities.has('commands'), false)
          assert.equal(capabilities.size, 2)
          assert.equal(typeof capabilities.add, 'undefined', '只读集合不得暴露 add')
          assert.equal(typeof capabilities.delete, 'undefined', '只读集合不得暴露 delete')
          assert.deepEqual([...capabilities].sort(), ['llm', 'tools'])
          assert.deepEqual([...capabilities.keys()].sort(), ['llm', 'tools'])
          assert.deepEqual([...capabilities.values()].sort(), ['llm', 'tools'])

          const collected = []
          capabilities.forEach((capability) => collected.push(capability))
          assert.deepEqual(collected.sort(), ['llm', 'tools'])
          assert.deepEqual(
            [...capabilities.entries()].map(([key, value]) => key === value),
            [true, true],
          )
        },
      },
      {
        name: 'capabilities 惰性求值：注册晚于 apply 的服务也要被看见（不能拍快照）',
        run() {
          const services = {}
          const { ctx } = makeFakeCtx({ services })
          const capabilities = build(ctx).capabilities

          assert.equal(capabilities.has('llm'), false, '未注册时应报"不具备"')
          services.llm = { stream() {} }
          assert.equal(
            capabilities.has('llm'),
            true,
            'capabilities 必须每次现查；快照会把"晚注册"误判成"没有"，导致场景被错误跳过',
          )
        },
      },
      {
        name: 'on：返回 disposer，调用之后监听确实解绑',
        run() {
          const { ctx, emit } = makeFakeCtx()
          const facade = build(ctx)
          let calls = 0
          const dispose = facade.on('demo/event', () => {
            calls += 1
          })

          assert.equal(typeof dispose, 'function', 'on 必须返回 disposer')
          emit('demo/event')
          assert.equal(calls, 1)
          dispose()
          emit('demo/event')
          assert.equal(calls, 1, 'disposer 调用后不该再收到事件')
        },
      },
      {
        name: 'on：options 原样透传（prepend 的落位语义由宿主决定）',
        run() {
          const { ctx, onCalls } = makeFakeCtx()
          const options = { prepend: true }
          build(ctx).on('demo/event', () => {}, options)

          assert.equal(onCalls.length, 1)
          assert.equal(onCalls[0].event, 'demo/event')
          assert.equal(onCalls[0].options, options, 'options 必须在同一引用上透传，不能重组')
        },
      },
      {
        name: 'on：宿主没有 on 时返回 no-op disposer（缺能力不抛错）',
        run() {
          const { ctx } = makeFakeCtx({ on: 'absent' })
          const dispose = build(ctx).on('demo/event', () => {})

          assert.equal(typeof dispose, 'function', '缺能力也应给调用方一个可调用的 disposer')
          assert.equal(dispose(), undefined, 'no-op disposer 调用不得抛错')
        },
      },
      {
        name: 'on：宿主 on 抛错时降级为 no-op disposer，并把原因写进 log',
        run() {
          const logs = []
          const { ctx } = makeFakeCtx({ on: 'throw' })
          const facade = build(ctx, { log: (level, message) => logs.push([level, message]) })
          const dispose = facade.on('demo/event', () => {})

          assert.equal(typeof dispose, 'function')
          dispose()
          assert.ok(
            logs.some(([level, message]) => level === 'warn' && message.includes('demo/event')),
            '监听失败必须留痕（warn 且带事件名），不能静默吞掉',
          )
        },
      },
      {
        name: 'waterfall：按 ctx.waterfall(scope, name, ...args, next) 调用，scope 就是 ctx，返回值透传',
        run() {
          const { ctx, waterfallCalls } = makeFakeCtx()
          const facade = build(ctx)
          const result = facade.waterfall('demo/waterfall', ['a', 1], () => 'NEXT')

          assert.equal(result, 'NEXT')
          assert.equal(waterfallCalls.length, 1)
          assert.equal(waterfallCalls[0].scope, ctx, '第一个参数必须是 ctx（与 DSH 的调用形式一致）')
          assert.equal(waterfallCalls[0].name, 'demo/waterfall')
          assert.deepEqual(waterfallCalls[0].args, ['a', 1])
          assert.equal(facade.waterfall('demo/waterfall', [], () => 42), 42)
        },
      },
      {
        name: 'waterfall：宿主不支持时抛错（点名 waterfall，不能静默返回 undefined）',
        run() {
          const { ctx } = makeFakeCtx({ waterfall: 'absent' })
          assert.throws(
            () => build(ctx).waterfall('demo/waterfall', [], () => 'NEXT'),
            /waterfall/,
          )
        },
      },
      {
        name: 'registerTool：定义经 defineTool 转换（parameters 是 object 根 JSON Schema，写操作串行）',
        run() {
          const registered = new Map()
          const { ctx } = makeFakeCtx({
            services: {
              tools: {
                register(definition) {
                  registered.set(definition.name, definition)
                  return () => registered.delete(definition.name)
                },
              },
            },
          })
          const facade = build(ctx)
          facade.registerTool({
            name: 'probe',
            description: '契约探针',
            parameters: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string' },
                limit: { type: 'integer', enum: [10, 20] },
                mode: { type: 'string', const: 'fast' },
              },
            },
            execute: () => 'OK',
          })

          const definition = registered.get('probe')
          assert.ok(definition, '必须真的交给 tools.register')
          assert.equal(typeof definition.execute, 'function')
          assert.equal(typeof definition.output?.render, 'function', '必须带 output.render')
          assert.equal(definition.timeoutMs, 120_000)
          assert.equal(
            typeof definition.isConcurrencySafe === 'function' && definition.isConcurrencySafe(),
            false,
            '测试类工具会改宿主状态，必须声明为不可并发',
          )
          assert.equal(definition.parameters.type, 'object')
          assert.equal(definition.parameters.properties.query.type, 'string')
          assert.deepEqual(definition.parameters.required, ['query'])
          // 非 string 的 enum 必须活着走到编译后的参数 schema（回归：曾只在 string 上保留）
          assert.deepEqual(definition.parameters.properties.limit.enum, [10, 20])
          // const 必须活着走到编译后的参数 schema（回归：曾被全类型静默丢弃）
          assert.equal(definition.parameters.properties.mode.const, 'fast')
        },
      },
      {
        name: 'registerTool：返回 tools.register 的 disposer，调用后解绑',
        run() {
          const registered = new Map()
          const marker = () => registered.clear()
          const { ctx } = makeFakeCtx({
            services: {
              tools: {
                register(definition) {
                  registered.set(definition.name, definition)
                  return marker
                },
              },
            },
          })
          const dispose = build(ctx).registerTool({
            name: 'probe',
            description: 'd',
            execute: () => 1,
          })

          assert.equal(typeof dispose, 'function', 'registerTool 必须返回 disposer')
          assert.equal(dispose, marker, '必须原样返回宿主给的 disposer，不得重新包一层')
          dispose()
          assert.equal(registered.size, 0)
        },
      },
      {
        name: 'registerTool：宿主不具备 tools 能力时抛错（拒绝而不是假装注册）',
        run() {
          const { ctx } = makeFakeCtx()
          assert.throws(
            () =>
              build(ctx).registerTool({ name: 'probe', description: 'd', execute: () => 1 }),
            /tools/,
          )
        },
      },
      {
        name: 'registerTool：execute 收到的 arguments 与 exec.signal 原样转交用户实现',
        run() {
          const registered = new Map()
          const { ctx } = makeFakeCtx({
            services: {
              tools: {
                register(definition) {
                  registered.set(definition.name, definition)
                  return () => {}
                },
              },
            },
          })
          const seen = {}
          build(ctx).registerTool({
            name: 'probe',
            description: 'd',
            execute: (args, exec) => {
              seen.args = args
              seen.signal = exec.signal
              return 'OK'
            },
          })

          const signal = new AbortController().signal
          const args = { query: 'q' }
          return registered
            .get('probe')
            .execute(args, { signal })
            .then((value) => {
              assert.equal(value, 'OK')
              assert.equal(seen.args, args, 'arguments 不得被克隆或改写')
              assert.equal(seen.signal, signal, 'exec.signal 必须同一引用透传')
            })
        },
      },
      {
        name: 'registerCommand：形状（input.hint / recordInput / handler）与 handler 包住 execute',
        run() {
          const registered = new Map()
          const { ctx } = makeFakeCtx({
            services: {
              commands: {
                register(definition) {
                  registered.set(definition.name, definition)
                  return () => registered.delete(definition.name)
                },
              },
            },
          })
          const dispose = build(ctx).registerCommand({
            name: 'demo',
            description: '契约命令',
            inputHint: '<args>',
            recordInput: true,
            execute: (rawInput) => ({ kind: 'success', text: `echo:${rawInput}` }),
          })

          const definition = registered.get('demo')
          assert.ok(definition, '必须真的交给 commands.register')
          assert.equal(definition.description, '契约命令')
          assert.equal(definition.input.hint, '<args>', 'inputHint 必须映射到 input.hint')
          assert.equal(definition.recordInput, true)
          assert.equal(typeof definition.handler, 'function')
          assert.equal(typeof dispose, 'function')
          return definition.handler({ rawInput: 'x', signal: undefined }).then((result) => {
            assert.deepEqual(result, { kind: 'success', text: 'echo:x' })
          })
        },
      },
      {
        name: 'registerCommand：execute 抛错被物化成 { kind: "error" }（不让异常穿出宿主）',
        run() {
          const registered = new Map()
          const { ctx } = makeFakeCtx({
            services: {
              commands: {
                register(definition) {
                  registered.set(definition.name, definition)
                  return () => {}
                },
              },
            },
          })
          build(ctx).registerCommand({
            name: 'demo',
            description: 'd',
            execute: () => {
              throw new Error('炸了')
            },
          })

          return registered
            .get('demo')
            .handler({ rawInput: '', signal: undefined })
            .then((result) => {
              assert.equal(result.kind, 'error')
              assert.match(result.text, /炸了/)
            })
        },
      },
      {
        name: 'registerCommand：disposer 解绑；宿主不具备 commands 能力时抛错',
        run() {
          const registered = new Map()
          const { ctx } = makeFakeCtx({
            services: {
              commands: {
                register(definition) {
                  registered.set(definition.name, definition)
                  return () => registered.delete(definition.name)
                },
              },
            },
          })
          const dispose = build(ctx).registerCommand({
            name: 'demo',
            description: 'd',
            execute: () => ({ kind: 'success' }),
          })
          assert.equal(typeof dispose, 'function')
          dispose()
          assert.equal(registered.size, 0)

          const bare = makeFakeCtx().ctx
          assert.throws(
            () => build(bare).registerCommand({ name: 'demo', description: 'd', execute: () => ({}) }),
            /commands/,
          )
        },
      },
      {
        name: 'log 与 env：log 原样转发；env 取注入值，缺省回落进程事实',
        run() {
          const logs = []
          const log = (level, message) => logs.push([level, message])
          const { ctx } = makeFakeCtx()
          const facade = build(ctx, { log })

          assert.equal(facade.log, log, 'facade.log 必须是调用方注入的同一个函数')
          facade.log('info', 'hello')
          assert.deepEqual(logs, [['info', 'hello']])

          const injected = build(ctx, {
            log,
            env: { platform: 'plan9', nodeVersion: 'v0.0.1' },
          })
          assert.equal(injected.env.dshVersion, 'contract-1.0.0')
          assert.equal(injected.env.platform, 'plan9')
          assert.equal(injected.env.nodeVersion, 'v0.0.1')

          const fallback = build(ctx, { log })
          assert.equal(fallback.env.platform, process.platform)
          assert.equal(fallback.env.nodeVersion, process.version)
        },
      },
    ],
  }
}

export default makeHostFacadeContract()
