/**
 * host 半的集成测试 —— 在**真实 cordis 容器**里装配整个插件。
 *
 * 为什么值得单独写一层：单元测试只能证明「函数算得对」，
 * 而这一层证明「插件能被宿主正确装载」——包括 `inject` 门控、
 * `ctx.get()` 能力探测、`defineTool` 转换、`ctx.effect` 注册链。
 *
 * 本文件也是 **R8（能否起 headless 宿主）** 的答案：
 * 可以。`new Context()` + `ctx.provide(...)` 就能组装一个最小宿主，
 * 不需要跑完整 DSH，也不需要碰用户的 profile。
 */

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import * as plugin from '../lib/index.js'

/** 装配一个最小宿主；`services` 决定宿主"具备"哪些能力。 */
function makeHarness({ services = ['tools', 'commands', 'webServer'] } = {}) {
  const reg = { tools: [], commands: [], routes: [] }
  const ctx = new Context()

  if (services.includes('tools')) {
    ctx.provide('tools', {
      register(definition) {
        reg.tools.push(definition)
        return () => undefined
      },
    })
  }
  if (services.includes('commands')) {
    ctx.provide('commands', {
      register(definition) {
        reg.commands.push(definition)
        return () => undefined
      },
    })
  }
  if (services.includes('webServer')) {
    ctx.provide('webServer', {
      register(route) {
        reg.routes.push(route)
        return () => undefined
      },
    })
  }

  return { ctx, reg }
}

const BASE_CONFIG = {
  casesDir: 'cases',
  runsDir: 'runs',
  autoload: true,
  watch: false,
  exposeTools: true,
  exposeCommands: true,
  defaultTimeoutMs: 5000,
  maxInvalidReported: 20,
}

function makeReq(method, body = '') {
  return Object.assign(Readable.from([Buffer.from(body, 'utf8')]), { method })
}

function makeRes() {
  const state = { status: 0, headers: null, chunks: [] }
  return {
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(body) {
      if (body !== undefined) state.chunks.push(Buffer.from(body))
    },
    read() {
      return {
        status: state.status,
        headers: state.headers,
        body: Buffer.concat(state.chunks).toString('utf8'),
      }
    },
  }
}

test('在真实 cordis 容器里装配：注册面完整', async () => {
  const { ctx, reg } = makeHarness()
  await ctx.plugin(plugin, { ...BASE_CONFIG })

  assert.deepEqual(
    reg.tools.map((t) => t.name),
    [
      'testkit_list',
      'testkit_run',
      'testkit_report',
      'testkit_export',
      'testkit_propose',
      'testkit_pipeline',
    ],
    '应注册 6 个工具',
  )
  assert.deepEqual(reg.commands.map((c) => c.name), ['testkit'], '应注册 1 个命令')
  assert.deepEqual(
    reg.routes.map((r) => r.path),
    [
      '/api/dsh-testkit/list',
      '/api/dsh-testkit/run',
      '/api/dsh-testkit/report',
      '/api/dsh-testkit/reload',
    ],
    '应注册 4 条 bridge 路由',
  )
})

test('注册出来的工具是 defineTool 的产物，不是裸对象', async () => {
  const { ctx, reg } = makeHarness()
  await ctx.plugin(plugin, { ...BASE_CONFIG })

  const def = reg.tools[0]
  assert.equal(typeof def.execute, 'function', 'defineTool 应产出 execute')
  assert.equal(typeof def.isConcurrencySafe, 'function', 'defineTool 应产出 isConcurrencySafe')
  assert.equal(typeof def.timeoutMs, 'number')
  assert.ok('parameters' in def, '应带参数 schema（JSON Schema 已转 ParameterSchemaSpec）')
  assert.ok('output' in def, '应带 output 渲染约定')
  // 测试类工具会改动宿主状态，一律按写操作串行
  assert.equal(def.isConcurrencySafe(), false)
})

test('能力探测：宿主只有 tools 时，命令与路由都不注册（且 apply 不抛错）', async () => {
  const { ctx, reg } = makeHarness({ services: ['tools'] })
  await ctx.plugin(plugin, { ...BASE_CONFIG })

  assert.equal(reg.tools.length, 6, '工具应照常注册')
  assert.equal(reg.commands.length, 0, '没有 commands 能力就不该注册命令')
  assert.equal(reg.routes.length, 0, '没有 webServer 能力就不该注册路由')
})

test('能力探测不会因未注入的服务而抛错（回归：cordis 4 的属性访问陷阱）', async () => {
  // 只提供 tools —— 其余 13 项能力探测全部落空。
  // 曾经这里会抛 `cannot get property "systemPrompt" without inject`，
  // 因为 getService() 在 ctx.get() 之后回退到属性访问。此测试守住该回归。
  const { ctx, reg } = makeHarness({ services: ['tools'] })
  await ctx.plugin(plugin, { ...BASE_CONFIG })
  assert.equal(reg.tools.length, 6)
})

test('开关生效：exposeTools / exposeCommands 为 false 时不注册对应面', async () => {
  const { ctx, reg } = makeHarness()
  await ctx.plugin(plugin, {
    ...BASE_CONFIG,
    exposeTools: false,
    exposeCommands: false,
  })

  assert.equal(reg.tools.length, 0)
  assert.equal(reg.commands.length, 0)
  assert.equal(reg.routes.length, 4, 'client 通道不受这两个开关影响')
})

test('端到端（headless）：装配 → 打 bridge 端点 → 拿到真实场景数据', async () => {
  const { ctx, reg } = makeHarness()
  await ctx.plugin(plugin, { ...BASE_CONFIG })

  const listRoute = reg.routes.find((r) => r.path.endsWith('/list'))
  assert.ok(listRoute, '应注册 /list 路由')
  assert.equal(listRoute.kind, 'exact')

  const res = makeRes()
  await listRoute.handler(makeReq('POST', '{}'), res)

  const out = res.read()
  assert.equal(out.status, 200)

  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, true)
  // cases/ 里至少有 TK-0001 这条示例场景
  assert.ok(payload.value.scenarios.length >= 1, '应至少加载到 1 条场景')
  assert.ok(
    payload.value.scenarios.some((s) => s.id === 'TK-0001'),
    '应能找到样板场景 TK-0001',
  )
  assert.ok(payload.value.scenarios.every((s) => typeof s.kind === 'string'))
})

test('autoload 关闭时不加载场景，但注册面照常', async () => {
  const { ctx, reg } = makeHarness()
  await ctx.plugin(plugin, { ...BASE_CONFIG, autoload: false })

  assert.equal(reg.tools.length, 6)

  const listRoute = reg.routes.find((r) => r.path.endsWith('/list'))
  const res = makeRes()
  await listRoute.handler(makeReq('POST', '{}'), res)
  const payload = JSON.parse(res.read().body)
  assert.equal(payload.value.scenarios.length, 0, 'autoload=false 时注册表应为空')
})

test('casesDir 不存在时不崩，只是场景为空', async () => {
  const { ctx, reg } = makeHarness()
  await ctx.plugin(plugin, { ...BASE_CONFIG, casesDir: 'definitely-missing-dir-xyz' })

  assert.equal(reg.tools.length, 6)

  const listRoute = reg.routes.find((r) => r.path.endsWith('/list'))
  const res = makeRes()
  await listRoute.handler(makeReq('POST', '{}'), res)
  const payload = JSON.parse(res.read().body)
  assert.equal(payload.value.scenarios.length, 0)
  // 目录问题要以"索引问题"的形式透出，而不是静默
  assert.ok(payload.value.problems.length >= 1, '应报告 casesDir 问题')
})
