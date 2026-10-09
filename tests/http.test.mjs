/**
 * HTTP bridge 的单元测试。
 *
 * 这是本插件双半通信的**唯一通道**（见 docs/ARCHITECTURE.md §6.3），
 * 所以它的信封约定、方法校验、错误处理必须有测试兜住，而不是只靠"装上去看看"。
 */

import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { BRIDGE_PREFIX, makeBridgeRoutes } from '../lib/http.js'

/** 造一个够用的假注册表。 */
function makeRegistry() {
  const scenarios = [
    { id: 'TK-0001', kind: 'tool', title: '示例场景', status: 'draft', tags: ['a'], source: { issue: null } },
  ]
  return {
    dir: 'C:\\fake\\cases',
    all: scenarios,
    invalidCases: [{ name: 'TK-9999.yaml', error: 'YAML 解析失败', issues: [] }],
    problems: [{ path: 'index.yaml', message: '索引里的 TK-0002 没有对应文件' }],
    snapshot: { loadedAt: '2026-10-09T00:00:00.000Z' },
    countsByKind: () => ({ tool: 1 }),
    // runner 会先调 filter() 选场景；假注册表必须提供，否则 run 端点会 500
    filter: () => scenarios,
    reload: () => ({ scenarios, invalid: [] }),
  }
}

function makeDeps(overrides = {}) {
  return {
    registry: makeRegistry(),
    drivers: { get: () => undefined },
    host: { env: { dshVersion: 'test', platform: 'test', nodeVersion: 'test' } },
    runsDir: () => 'C:\\fake\\runs',
    defaultTimeoutMs: () => 5000,
    ...overrides,
  }
}

/** 造一个假的 IncomingMessage。 */
function makeReq(method, body = '') {
  return Object.assign(Readable.from([Buffer.from(body, 'utf8')]), { method })
}

/** 造一个收集型的假 ServerResponse。 */
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

function routeOf(routes, name) {
  const found = routes.find((r) => r.path === `${BRIDGE_PREFIX}/${name}`)
  assert.ok(found, `缺少路由 ${name}`)
  return found
}

test('路由表形态：四条 exact 路由，路径带统一前缀', () => {
  const routes = makeBridgeRoutes(makeDeps())
  const paths = routes.map((r) => r.path).sort()
  assert.deepEqual(paths, [
    `${BRIDGE_PREFIX}/list`,
    `${BRIDGE_PREFIX}/reload`,
    `${BRIDGE_PREFIX}/report`,
    `${BRIDGE_PREFIX}/run`,
  ])
  assert.ok(routes.every((r) => r.kind === 'exact'), '全部应为 exact')
  assert.ok(routes.every((r) => typeof r.handler === 'function'), '每条都要有 handler')
})

test('list 端点：返回 ok 信封与场景清单', async () => {
  const routes = makeBridgeRoutes(makeDeps())
  const req = makeReq('POST', '{}')
  const res = makeRes()
  await routeOf(routes, 'list').handler(req, res)

  const out = res.read()
  assert.equal(out.status, 200)
  assert.match(out.headers['content-type'], /application\/json/)

  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.scenarios.length, 1)
  assert.equal(payload.value.scenarios[0].id, 'TK-0001')
  assert.equal(payload.value.dir, 'C:\\fake\\cases')
  // 无效项与索引问题必须一并透出，否则 UI 无从提示
  assert.equal(payload.value.invalid.length, 1)
  assert.equal(payload.value.problems.length, 1)
})

test('reload 端点：可被调用并返回计数', async () => {
  const routes = makeBridgeRoutes(makeDeps())
  const res = makeRes()
  await routeOf(routes, 'reload').handler(makeReq('POST', '{}'), res)

  const payload = JSON.parse(res.read().body)
  assert.equal(payload.ok, true)
  assert.equal(typeof payload.value.scenarios, 'number')
  assert.equal(typeof payload.value.invalid, 'number')
})

test('非 POST 一律 405', async () => {
  const routes = makeBridgeRoutes(makeDeps())
  const res = makeRes()
  await routeOf(routes, 'list').handler(makeReq('GET'), res)

  const out = res.read()
  assert.equal(out.status, 405)
  assert.equal(JSON.parse(out.body).code, 'method-not-allowed')
})

test('坏 JSON 返回 400，而不是 500', async () => {
  const routes = makeBridgeRoutes(makeDeps())
  const res = makeRes()
  await routeOf(routes, 'list').handler(makeReq('POST', '{ 不是 json'), res)

  const out = res.read()
  assert.equal(out.status, 400)
  assert.equal(JSON.parse(out.body).code, 'bad-json')
})

test('handler 抛错时返回 500 且带 code', async () => {
  const deps = makeDeps({
    registry: {
      ...makeRegistry(),
      get all() {
        throw new Error('故意炸')
      },
    },
  })
  const routes = makeBridgeRoutes(deps)
  const res = makeRes()
  await routeOf(routes, 'list').handler(makeReq('POST', '{}'), res)

  const out = res.read()
  assert.equal(out.status, 500)
  const payload = JSON.parse(out.body)
  assert.equal(payload.ok, false)
  assert.equal(payload.code, 'handler-failed')
  assert.match(payload.message, /故意炸/)
})

test('空请求体等价于空参数对象', async () => {
  const routes = makeBridgeRoutes(makeDeps())
  const res = makeRes()
  await routeOf(routes, 'list').handler(makeReq('POST', ''), res)
  assert.equal(JSON.parse(res.read().body).ok, true)
})

test('run 端点：无可用 driver 时场景记为 errored 而不是崩掉', async () => {
  const routes = makeBridgeRoutes(makeDeps())
  const res = makeRes()
  await routeOf(routes, 'run').handler(makeReq('POST', '{"ids":["TK-0001"]}'), res)

  const payload = JSON.parse(res.read().body)
  assert.equal(payload.ok, true)
  assert.equal(payload.value.totals.total, 1)
  assert.equal(payload.value.totals.errored, 1)
  assert.match(payload.value.cases[0].error, /driver 尚未实现/)
})
