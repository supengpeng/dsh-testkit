/**
 * resource driver 的单元测试。
 *
 * **统一使用产品里的 headless 宿主**（`src/headless/`），而不是本地再造一份
 * `web` 服务替身——两份实现必然漂移，而漂移的替身会让 CI 轨在不同地方
 * 给出不同结论。单一真相源优先。
 *
 * 关键验证点：**接管 providerId 并在释放时恢复**。
 * 只注册不接管 → 真实 profile 配了别的 provider 时场景静默失效；
 * 接管了不恢复 → 污染宿主配置。两头都必须测。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createHeadlessHost } from '../lib/headless/index.js'
import {
  buildFetchProvider,
  buildSearchProvider,
  DEFAULT_FETCH_PROVIDER_ID,
  DEFAULT_SEARCH_PROVIDER_ID,
  resourceDriver,
} from '../lib/kinds/resource.js'
import { SkipCase } from '../lib/kinds/types.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('buildSearchProvider：返回声明的条目与 content', async () => {
  const provider = buildSearchProvider({
    results: [{ url: 'u1', title: 't1' }],
    content: '正文',
  })
  assert.equal(provider.id, DEFAULT_SEARCH_PROVIDER_ID)
  assert.equal(provider.available(), true)

  const result = await provider.search({ query: 'q' })
  assert.equal(result.content, '正文')
  assert.deepEqual(result.sources, [{ url: 'u1', title: 't1' }])
  assert.equal(result.truncated, false)
})

test('buildSearchProvider：available=false 时如实报告不可用', () => {
  assert.equal(buildSearchProvider({ available: false }).available(), false)
})

test('buildSearchProvider：throws 让 search 抛错', async () => {
  const provider = buildSearchProvider({ throws: '网络炸了' })
  await assert.rejects(() => provider.search({ query: 'q' }), /网络炸了/)
})

test('buildSearchProvider：provider 自身也按 maxResults 裁（与 seam 职责重叠但语义一致）', async () => {
  const provider = buildSearchProvider({
    results: [{ url: 'a' }, { url: 'b' }, { url: 'c' }],
  })
  const result = await provider.search({ query: 'q', maxResults: 2 })
  assert.equal(result.sources.length, 2)
  assert.equal(result.truncated, true)
})

test('buildFetchProvider：默认 200 + html 体', async () => {
  const provider = buildFetchProvider({})
  assert.equal(provider.id, DEFAULT_FETCH_PROVIDER_ID)
  const result = await provider.fetch({ url: 'https://x.invalid/' })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(result.body, { kind: 'html', content: '<html>testkit</html>' })
  assert.equal(result.url, 'https://x.invalid/')
})

test('buildFetchProvider：可声明非 2xx 与 text 体（非 2xx 是结果、不是抛出）', async () => {
  const provider = buildFetchProvider({ statusCode: 404, kind: 'text', body: '没找到' })
  const result = await provider.fetch({ url: 'https://x.invalid/missing' })
  assert.equal(result.statusCode, 404)
  assert.deepEqual(result.body, { kind: 'text', content: '没找到' })
})

/* -------------------------------------------------------- driver 契约层 -- */

/** 造 harness：用产品里的 headless 宿主。 */
async function makeHarness({ withWeb = true } = {}) {
  const headless = await createHeadlessHost({ capabilities: withWeb ? ['web'] : ['tools'] })
  return {
    headless,
    web: headless.services.web,
    driverCtx: {
      host: headless.host,
      fixture: new Fixture(),
      scenario: { setup: {} },
      signal: new AbortController().signal,
    },
  }
}

test('setup：注册 provider 并接管 searchProviderId', async (t) => {
  const { headless, web, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  web.searchProviderId = 'someone-else'
  await resourceDriver.setup(driverCtx, {
    setup: { resource: { webSearch: { results: [{ url: 'u' }] } } },
  })

  assert.equal(web.searchProviderId, DEFAULT_SEARCH_PROVIDER_ID, '应接管 providerId')
  assert.equal(driverCtx.fixture.getNote('previousSearchProviderId'), 'someone-else')

  await driverCtx.fixture.release()
})

test('release：恢复原先的 searchProviderId（不污染宿主配置）', async (t) => {
  const { headless, web, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  web.searchProviderId = 'someone-else'
  await resourceDriver.setup(driverCtx, { setup: { resource: { webSearch: {} } } })
  await driverCtx.fixture.release()

  assert.equal(web.searchProviderId, 'someone-else', '释放后必须还原，否则污染别的场景')
})

test('release：原先没有 providerId 时恢复成 undefined', async (t) => {
  const { headless, web, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  await resourceDriver.setup(driverCtx, { setup: { resource: { webSearch: {} } } })
  assert.equal(web.searchProviderId, DEFAULT_SEARCH_PROVIDER_ID)
  await driverCtx.fixture.release()

  assert.equal(web.searchProviderId, undefined)
})

test('act：搜索返回声明结果，且 seam 会按 maxResults 截断', async (t) => {
  const { headless, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  await resourceDriver.setup(driverCtx, {
    setup: {
      resource: {
        webSearch: { results: [{ url: 'a' }, { url: 'b' }, { url: 'c' }], content: '摘要' },
      },
    },
  })

  await resourceDriver.act(driverCtx, { resource: { search: { query: 'q' } } })
  assert.equal(driverCtx.fixture.getNote('searchSourceCount'), 3)
  assert.equal(driverCtx.fixture.getNote('searchError'), undefined)

  // 第二次带 maxResults：证明截断发生在 seam
  await resourceDriver.act(driverCtx, { resource: { search: { query: 'q', maxResults: 2 } } })
  assert.equal(driverCtx.fixture.getNote('searchSourceCount'), 2)
  assert.equal(driverCtx.fixture.getNote('searchTruncated'), true)

  await driverCtx.fixture.release()
})

test('act：provider 不可用时以点名错误收尾（不静默返回空结果）', async (t) => {
  const { headless, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  await resourceDriver.setup(driverCtx, {
    setup: { resource: { webSearch: { available: false, results: [{ url: 'x' }] } } },
  })

  await resourceDriver.act(driverCtx, { resource: { search: { query: 'q' } } })

  const error = String(driverCtx.fixture.getNote('searchError'))
  assert.match(error, /WEB_PROVIDER_CONFIGURED_UNAVAILABLE/)
  assert.equal(driverCtx.fixture.getNote('searchResult'), undefined)
  assert.equal(driverCtx.fixture.getNote('searchSources'), undefined)

  await driverCtx.fixture.release()
})

test('act：fetch 返回声明的状态码与响应体', async (t) => {
  const { headless, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  await resourceDriver.setup(driverCtx, {
    setup: { resource: { webFetch: { statusCode: 200, body: '<html>页面</html>' } } },
  })

  await resourceDriver.act(driverCtx, {
    resource: { fetch: { url: 'https://x.invalid/p' } },
  })

  assert.equal(driverCtx.fixture.getNote('fetchStatusCode'), 200)
  assert.equal(driverCtx.fixture.getNote('fetchBody'), '<html>页面</html>')
  assert.equal(driverCtx.fixture.getNote('fetchError'), undefined)

  await driverCtx.fixture.release()
})

test('setup：宿主没有 web 服务时抛 SkipCase', async (t) => {
  const { headless, driverCtx } = await makeHarness({ withWeb: false })
  t.after(() => headless.dispose())

  await assert.rejects(
    () => resourceDriver.setup(driverCtx, { setup: { resource: { webSearch: {} } } }),
    SkipCase,
  )
})

test('act：非 resource 动作直接报错', async (t) => {
  const { headless, driverCtx } = await makeHarness()
  t.after(() => headless.dispose())

  await assert.rejects(
    () => resourceDriver.act(driverCtx, { tool: 'x' }),
    /只支持 `resource` 动作/,
  )
})

test('driver 元信息：kind 正确，且不静态声明 requires', () => {
  assert.equal(resourceDriver.kind, 'resource')
  assert.deepEqual(resourceDriver.requires, [], '应与实际用到的分支绑定，而非静态声明')
})
