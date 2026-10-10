/**
 * headless 宿主（CI 轨的测试替身）契约（P0 §5.4）。
 *
 * ## 为什么替身也要有契约
 *
 * `export/scenarios.test.mjs`（CI 轨）跑的就是这套替身。替身与真实契约一旦漂移，
 * CI 会**绿着骗人**——所以这里逐条钉住"替身必须与真实 DSH 同语义"的关键点：
 *   · `tools.execute` 对 `arguments` 的校验（真实 `defineTool` 会抛 `ToolArgsError`）
 *   · `web` 的 provider 选择规则表（含 `WEB_PROVIDER_AMBIGUOUS`）
 *   · `llm` 的 `realAdapterCalls` 计数语义（只在落到兜底实现时 +1）
 *   · `dispose` 必须**真卸载**（跑掉 effect cleanup、服务随之不可探测）——
 *     cordis 4 的卸载入口是 `ctx.fiber.dispose()`，Context 上没有 `dispose`
 *   · 各类注册器返回 disposer
 *
 * ## 契约出处（不凭印象）
 *
 *   · 替身实现：本仓 `src/headless/services.ts`（文件头注写明"替身必须与真实契约一致"）、
 *     `src/headless/index.ts`
 *   · 真实语义来源：
 *     - 工具：`@deepseek-ai/dsh-tools` 发行体 `lib/types/schema.js` 的 `defineTool`
 *       与 `lib/types/json-schema.js` 的 `validateJsonSchemaValue`
 *       （非对象实参 → `invalid arguments: "arguments" must be an object`）
 *     - 服务注册：`@deepseek-ai/cordis` 发行体 `lib/index.js` 的 `Context.provide`
 *       （返回 disposer）
 *
 * ## 用法
 *
 * `makeHeadlessContract()` 打真替身；传入替换工厂即可把同一套契约打到
 * **形状被破坏的替身**上（`tests/contracts/runner.test.mjs` 的反安慰剂用例）。
 */

import assert from 'node:assert/strict'

import { createHeadlessHost, HEADLESS_CAPABILITIES } from '../../lib/headless/index.js'

export const HEADLESS_CONTRACT_VERSION = '1.0.0'

/** 只注册与"能力如实声明"相关的用例，便于替换工厂时复用。 */
export function makeHeadlessContract(createHost = createHeadlessHost) {
  const provider = (id, available = true, calls = { count: 0 }) => ({
    id,
    available: () => available,
    search: async () => {
      calls.count += 1
      return { sources: [{ url: `${id}-1` }], truncated: false }
    },
    calls,
  })

  return {
    version: HEADLESS_CONTRACT_VERSION,
    adapter: 'headless',
    tests: [
      {
        name: '能力不谎报：HEADLESS_CAPABILITIES 全部真实提供，未实现的能力不声称',
        async run() {
          const headless = await createHost()
          try {
            for (const capability of HEADLESS_CAPABILITIES) {
              assert.ok(
                headless.host.capabilities.has(capability),
                `声明提供 ${capability}，探测却报"不具备"`,
              )
            }
            for (const absent of ['fs', 'subprocess', 'agentLoop', 'storage', 'timer', 'client', 'session']) {
              assert.ok(
                !headless.host.capabilities.has(absent),
                `没实现 ${absent} 却声称具备，会让场景跑出假绿`,
              )
            }
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'dispose：真卸载（effect 被清理、能力探测随之变空、重复调用幂等）',
        async run() {
          const headless = await createHost()
          let cleaned = 0
          // 工具 / 命令 / 路由 / bridge 都经 `ctx.effect` 登记，
          // 所以"effect 有没有被跑掉"就是"宿主管不管得住自己的注册"。
          headless.ctx.effect(() => () => {
            cleaned += 1
          })
          assert.equal(headless.host.capabilities.has('tools'), true)

          await headless.dispose()
          assert.equal(
            cleaned,
            1,
            'dispose 必须真的跑 effect cleanup（回归：曾判 ctx.dispose，而 cordis 4 的卸载入口是 ctx.fiber.dispose）',
          )
          assert.equal(
            headless.host.capabilities.has('tools'),
            false,
            '卸载后服务不该还能被探测到',
          )

          await headless.dispose()
          assert.equal(cleaned, 1, 'dispose 必须幂等，不得重复清理')
        },
      },
      {
        name: 'tools：registerTool 返回 disposer，调用后工具真的解绑',
        async run() {
          const headless = await createHost({ capabilities: ['tools'] })
          try {
            const dispose = headless.host.registerTool({
              name: 'probe',
              description: 'd',
              execute: () => 'OK',
            })
            assert.deepEqual(headless.services.tools.registeredNames(), ['probe'])
            assert.equal(typeof dispose, 'function', '注册必须返回 disposer')
            dispose()
            assert.deepEqual(headless.services.tools.registeredNames(), [])
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'tools：arguments 必须是对象（undefined/null/字符串/数字/数组都被拒）',
        async run() {
          const headless = await createHost({ capabilities: ['tools'] })
          try {
            headless.host.registerTool({ name: 'probe', description: 'd', execute: () => 'OK' })
            for (const value of [undefined, null, 'str', 42, [1, 2]]) {
              const result = await headless.services.tools.execute({
                name: 'probe',
                arguments: value,
              })
              assert.equal(
                result.isError,
                true,
                `arguments=${JSON.stringify(value)} 必须被拒（真实 defineTool 会抛 ToolArgsError）`,
              )
              assert.match(result.error.message, /invalid arguments/)
              assert.match(result.error.message, /must be an object/)
            }
            const allowed = await headless.services.tools.execute({ name: 'probe', arguments: {} })
            assert.equal(allowed.isError, false, '对象参数必须放行')
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'tools：guard 先于 execute、可叠加且被拦的调用也计入 executions',
        async run() {
          const headless = await createHost({ capabilities: ['tools'] })
          try {
            let body = 0
            headless.host.registerTool({
              name: 'guarded',
              description: 'd',
              execute: () => {
                body += 1
                return 'BODY'
              },
            })
            headless.services.tools.guard(() => undefined) // 放行者在前，不该短路后面的拒绝
            headless.services.tools.guard((exec) =>
              exec.name === 'guarded' ? '不许跑' : undefined,
            )

            const result = await headless.services.tools.execute({ name: 'guarded', arguments: {} })
            assert.equal(result.isError, true)
            assert.match(result.error.message, /不许跑/)
            assert.equal(body, 0, '被 guard 拦下时工具本体不得执行')
            assert.equal(headless.services.tools.executions, 1, '被拦的调用也要计数')
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'web：provider 选择规则表（无可用 / 唯一 / 歧义 / 配置缺失 / 配置不可用）',
        async run() {
          const headless = await createHost({ capabilities: ['web'] })
          try {
            const web = headless.services.web
            await assert.rejects(
              () => web.search({ query: 'q' }),
              (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE',
            )

            const first = provider('a')
            web.registerSearchProvider(first)
            await web.search({ query: 'q' })
            assert.equal(first.calls.count, 1, '唯一可用 provider 必须被选中')

            const second = provider('b')
            web.registerSearchProvider(second)
            await assert.rejects(
              () => web.search({ query: 'q' }),
              (error) => error.code === 'WEB_PROVIDER_AMBIGUOUS',
              '多个可用 provider 且未配置时必须是 AMBIGUOUS，不能随机挑一个',
            )

            web.searchProviderId = 'ghost'
            await assert.rejects(
              () => web.search({ query: 'q' }),
              (error) => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
            )

            web.registerSearchProvider(provider('sick', false))
            web.searchProviderId = 'sick'
            await assert.rejects(
              () => web.search({ query: 'q' }),
              (error) => error.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
            )

            web.searchProviderId = 'a'
            await web.search({ query: 'q' })
            assert.equal(first.calls.count, 2, '配置命中时必须走配置的 provider')
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'web：seam 按 maxResults 截断并置 truncated（provider 不该自己截）',
        async run() {
          const headless = await createHost({ capabilities: ['web'] })
          try {
            headless.services.web.registerSearchProvider({
              id: 'many',
              available: () => true,
              search: async () => ({
                sources: [{ url: '1' }, { url: '2' }, { url: '3' }],
                truncated: false,
              }),
            })
            const result = await headless.services.web.search({ query: 'q', maxResults: 2 })
            assert.equal(result.sources.length, 2)
            assert.equal(result.truncated, true)
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'llm：无 listener 时落到兜底实现，realAdapterCalls 恰好 +1',
        async run() {
          const headless = await createHost({ capabilities: ['llm'] })
          try {
            assert.equal(headless.services.llm.realAdapterCalls, 0)
            const chunks = []
            for await (const chunk of headless.services.llm.stream({
              provider: 'p',
              model: 'm',
              messages: [],
            })) {
              chunks.push(chunk.type)
            }
            assert.deepEqual(chunks, ['finish'])
            assert.equal(headless.services.llm.realAdapterCalls, 1)
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: 'llm：有 listener 接管 llm/stream 时不落兜底，realAdapterCalls 保持 0',
        async run() {
          const headless = await createHost({ capabilities: ['llm'] })
          try {
            headless.ctx.on(
              'llm/stream',
              () =>
                (async function* () {
                  yield { type: 'finish', reason: { kind: 'injected' } }
                })(),
            )
            const chunks = []
            for await (const chunk of headless.services.llm.stream({
              provider: 'p',
              model: 'm',
              messages: [],
            })) {
              chunks.push(chunk.reason.kind)
            }
            assert.deepEqual(chunks, ['injected'], 'listener 的返回必须原样透出')
            assert.equal(
              headless.services.llm.realAdapterCalls,
              0,
              'realAdapterCalls 记的是"真实适配器被调用"，listener 接管时不该记',
            )
          } finally {
            await headless.dispose()
          }
        },
      },
      {
        name: '注册面 disposer：webServer.register / web.registerSearchProvider / commands.register',
        async run() {
          const headless = await createHost({ capabilities: ['web', 'webServer', 'commands'] })
          try {
            const disposeRoute = headless.services.webServer.register({ kind: 'exact', path: '/x' })
            assert.equal(headless.services.webServer.routes().length, 1)
            assert.equal(typeof disposeRoute, 'function')
            disposeRoute()
            assert.equal(headless.services.webServer.routes().length, 0)

            const disposeProvider = headless.services.web.registerSearchProvider({
              id: 'a',
              available: () => true,
              search: async () => ({ sources: [] }),
            })
            assert.equal(typeof disposeProvider, 'function')
            disposeProvider()
            await assert.rejects(
              () => headless.services.web.search({ query: 'q' }),
              (error) => error.code === 'WEB_PROVIDER_UNAVAILABLE',
              'provider 解绑后不该还能被选中',
            )

            const disposeCommand = headless.services.commands.register({ name: 'demo' })
            assert.deepEqual(headless.services.commands.registeredNames(), ['demo'])
            disposeCommand()
            assert.deepEqual(headless.services.commands.registeredNames(), [])
          } finally {
            await headless.dispose()
          }
        },
      },
    ],
  }
}

export default makeHeadlessContract()
