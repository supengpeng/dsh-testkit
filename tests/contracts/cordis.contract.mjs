/**
 * cordis 交互面的契约（P0 §5.4）。
 *
 * 本包**不实现** cordis，只消费它的四条公开语义；契约把消费方式钉住：
 *   · `provide`：注册服务，返回的 disposer 解绑（异步，可 await）
 *   · `inject`：依赖就绪**之后**才执行回调（这是 `apply()` 里 webServer 时序问题的正解）
 *   · `effect`：回调同步执行，返回的 cleanup 在 disposer / fiber 卸载时执行
 *   · `waterfall`：`ctx.waterfall(scope, name, ...args, next)`，listener 由外到内包 `next`，
 *     不调 `next` 即否决链尾
 *
 * ## 契约出处（不凭印象）
 *
 *   · `@deepseek-ai/cordis@4.0.4` 发行体 `lib/index.js`：
 *     `Context.provide` / `Context.inject`（→ `plugin({ inject, apply })`）/
 *     `Context.effect` / `Context.waterfall` / `Context.on`
 *   · 本仓消费点：`src/index.ts` 的 `installEffect`（缺 `ctx.effect` 时的回退路径）
 *     与 webServer 注册处的 `ctx.inject(['webServer'], cb)`
 *
 * ## 这里只约束形状与语义
 *
 * 不测 cordis 内部实现，只测"本包依赖的那几条行为"是否仍然成立——
 * cordis 升级把这些语义改掉时，这些用例必须变红。
 */

import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../../lib/index.js'

export const CORDIS_CONTRACT_VERSION = '1.0.0'

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

/** 回退路径专用的最小假宿主：**故意没有 `effect`**（也不是真 cordis Context）。 */
function makeEffectlessCtx(tools) {
  const logs = []
  const record = (level) => (message) => logs.push([level, message])
  return {
    ctx: {
      get(name) {
        return name === 'tools' ? tools : undefined
      },
      logger: {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
      },
    },
    logs,
  }
}

/** 回退路径用的完整配置（绕开 `ctx.plugin` 的 schema 填充，故显式带默认值）。 */
const FALLBACK_CONFIG = {
  casesDir: 'definitely-missing-dir-xyz',
  runsDir: '',
  exportDir: '',
  pipelineDir: '',
  fixturesDir: '',
  registryDir: '',
  templatesDir: '',
  parallelLimit: 1,
  redact: false,
  webhookPort: 0,
  autoload: false,
  watch: false,
  exposeTools: true,
  exposeCommands: false,
  defaultTimeoutMs: 5000,
  maxInvalidReported: 20,
  dshVersion: '',
  allowModel: false,
  allowLowCost: true,
  sandboxAllowShell: true,
  sandboxAllowFileWrite: true,
  sandboxAllowNetwork: false,
  sandboxDenyWriteCommands: [],
  maxModelCalls: 0,
  maxTokens: 0,
}

export function makeCordisContract() {
  return {
    version: CORDIS_CONTRACT_VERSION,
    adapter: 'cordis',
    tests: [
      {
        name: 'provide：返回 disposer，await 之后服务从 ctx.get 消失',
        async run() {
          const ctx = new Context()
          const dispose = ctx.provide('contractSvc', 'VALUE')

          assert.equal(typeof dispose, 'function', 'provide 必须返回 disposer')
          assert.equal(ctx.get('contractSvc'), 'VALUE')
          await dispose()
          assert.equal(ctx.get('contractSvc'), undefined, 'dispose 之后不该还能取到服务')
          await dispose() // 幂等：重复 dispose 不得抛错
          await ctx.fiber.dispose()
        },
      },
      {
        name: 'effect：回调同步执行；disposer 触发 cleanup；重复调用幂等',
        async run() {
          const ctx = new Context()
          let ran = 0
          let cleaned = 0
          const dispose = ctx.effect(() => {
            ran += 1
            return () => {
              cleaned += 1
            }
          })

          assert.equal(ran, 1, 'effect 回调必须同步执行（不能等下一个 tick）')
          assert.equal(typeof dispose, 'function')
          await dispose()
          assert.equal(cleaned, 1)
          await dispose()
          assert.equal(cleaned, 1, 'disposer 必须幂等')
          await ctx.fiber.dispose()
        },
      },
      {
        name: 'effect：未显式 dispose 时，随所属 fiber 卸载自动清理',
        async run() {
          const ctx = new Context()
          let cleaned = 0
          const fiber = await ctx.plugin({
            name: 'contract-effect-owner',
            apply(scope) {
              scope.effect(() => () => {
                cleaned += 1
              })
            },
          })

          assert.equal(cleaned, 0)
          assert.equal(typeof fiber.dispose, 'function', 'plugin fiber 必须可 dispose')
          await fiber.dispose()
          assert.equal(cleaned, 1, 'fiber 卸载必须带走它的 effect')
        },
      },
      {
        name: 'inject：依赖就绪前不执行回调，provide 之后执行且 scope.get 拿得到服务',
        async run() {
          const ctx = new Context()
          const seen = []
          const fiber = ctx.inject(['contractSvc'], (scope) => {
            seen.push(scope.get('contractSvc'))
          })

          await tick()
          assert.deepEqual(seen, [], '依赖缺失时回调不得执行（这正是 webServer 404 的成因）')

          ctx.provide('contractSvc', 'READY')
          await tick()
          await tick()
          assert.deepEqual(seen, ['READY'], 'provide 之后回调必须执行且能拿到服务')

          if (typeof fiber.dispose === 'function') await fiber.dispose()
          await ctx.fiber.dispose()
        },
      },
      {
        name: 'waterfall：listener 包 next；不调 next 即否决；on 的 disposer 解绑后不再参与',
        async run() {
          const ctx = new Context()
          ctx.on('contract/evt', (value, next) => next(value) + 1)
          assert.equal(
            ctx.waterfall(ctx, 'contract/evt', 1, () => 10),
            11,
            'waterfall 必须是 ctx.waterfall(scope, name, ...args, next) 形式',
          )

          const veto = new Context()
          veto.on('contract/evt', () => 'VETO')
          assert.equal(veto.waterfall(veto, 'contract/evt', 1, () => 10), 'VETO')

          let calls = 0
          const off = ctx.on('contract/off', () => {
            calls += 1
          })
          assert.equal(typeof off, 'function', 'on 必须返回 disposer')
          ctx.waterfall(ctx, 'contract/off', 0, () => {})
          off()
          ctx.waterfall(ctx, 'contract/off', 0, () => {})
          assert.equal(calls, 1, 'disposer 调用后 listener 不该再被调用')

          await veto.fiber.dispose()
          await ctx.fiber.dispose()
        },
      },
      {
        name: 'installEffect 回退：宿主 ctx 没有 effect 时直接安装（工具确实注册上了）',
        async run() {
          const registered = new Map()
          const tools = {
            register(definition) {
              registered.set(definition.name, definition)
              return () => registered.delete(definition.name)
            },
          }
          const { ctx, logs } = makeEffectlessCtx(tools)
          assert.equal(typeof ctx.effect, 'undefined', '前提：本用例必须走"没有 effect"的回退路径')

          plugin.apply(ctx, FALLBACK_CONFIG)

          assert.ok(registered.has('testkit_list'), '回退路径必须照常注册工具，不能因缺 effect 就放弃')
          assert.ok(
            logs.some(([, message]) => /已注册 \d+ 个工具/.test(message)),
            '回退路径也应留下"已注册 N 个工具"的日志',
          )
        },
      },
      {
        name: 'installEffect 回退：install 抛错不冒泡，而是 log(error) 点名 label 与原始错误',
        async run() {
          const tools = {
            register() {
              throw new Error('registry boom')
            },
          }
          const { ctx, logs } = makeEffectlessCtx(tools)

          plugin.apply(ctx, FALLBACK_CONFIG) // 不得抛

          assert.ok(
            logs.some(
              ([level, message]) =>
                level === 'error' && message.includes('安装失败') && message.includes('registry boom'),
            ),
            '安装失败必须被 log(error) 点名（label + 原始错误），否则插件表现为"静默不激活"',
          )
        },
      },
    ],
  }
}

export default makeCordisContract()
