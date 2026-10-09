/**
 * kind: resource —— 外部资源面（当前实现：假 web provider）。
 *
 * ## 为什么必须「接管 providerId」而不只是注册 provider
 *
 * `web.search()` 的 provider 是**按配置 id 在调用时解析**的，语义如下
 * （摘自 `web` 服务契约）：
 *
 * | 情形 | 结果 |
 * |---|---|
 * | 配置的 id 已注册且 `available()` | 用它 |
 * | 配置的 id 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
 * | 配置的 id 已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
 * | 未配 id，恰好一个可用 | 用它 |
 * | 未配 id，多个可用 | **`WEB_PROVIDER_AMBIGUOUS`** |
 * | 未配 id，没有可用 | `WEB_PROVIDER_UNAVAILABLE` |
 *
 * 也就是说：**注册 ≠ 会被选中**。真实 profile 里通常已经配了
 * `deepseek-official` 或 `bing`，光注册一个假 provider 是拿不到它的。
 *
 * 所以本 driver 显式写 `ctx.web.searchProviderId`（该属性可写，
 * `dsh-free-search` 就是这么运行时接管的），并在 Fixture 释放时**恢复原值**。
 * 这样场景行为确定，且不污染宿主配置。
 *
 * ## 边界
 *
 * - 已实现：假 search / fetch provider（含不可用与抛错两条降级路径）
 * - **未实现**：`ctx.fs`（沙箱拒绝、并发写）、`ctx.subprocess`（非零退出码）。
 *   它们需要真实文件系统 / 进程，且沙箱策略依赖宿主配置，
 *   属"需要活宿主才能定语义"的一类——与 R9 同理，先不做。
 */

import type { Scenario, StepAction } from '../cases/types.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

interface WebServiceLike {
  searchProviderId?: string
  fetchProviderId?: string
  search?: (request: unknown, signal?: AbortSignal) => Promise<unknown>
  fetch?: (request: unknown, signal?: AbortSignal) => Promise<unknown>
  registerSearchProvider?: (provider: unknown) => () => void
  registerFetchProvider?: (provider: unknown) => () => void
}

export interface WebSearchSpec {
  /** provider id，缺省 `testkit-fake-search`。 */
  providerId?: string
  /** `available()` 的返回；`false` 用来测"已配置但不可用"的降级路径。 */
  available?: boolean
  /** 声明式结果条目。 */
  results?: Array<{ url: string; title?: string; snippet?: string; publishedAt?: string }>
  /** 结果里的汇总文本。 */
  content?: string
  /** 让 provider 抛错（测"能力运行失败"路径）。 */
  throws?: string
}

export interface WebFetchSpec {
  providerId?: string
  available?: boolean
  statusCode?: number
  /** 响应体内容；缺省 `<html>testkit</html>`。 */
  body?: string
  /** 响应体类型：`html` | `text`，缺省 `html`。 */
  kind?: 'html' | 'text'
  /** 让 provider 抛错。 */
  throws?: string
}

export interface ResourceSetup {
  webSearch?: WebSearchSpec
  webFetch?: WebFetchSpec
}

export const DEFAULT_SEARCH_PROVIDER_ID = 'testkit-fake-search'
export const DEFAULT_FETCH_PROVIDER_ID = 'testkit-fake-fetch'

/**
 * 按声明构造一个假 search provider。纯函数，可单测。
 *
 * `onSearch` 让**每一次**被调用都留下痕迹——包括不是我们主动发起的那些，
 * 例如被派生的子 agent 在自己的会话里调 `web_search`。
 * 没有它，组合场景就无法证明"宿主级替身真的穿透到了子 agent"。
 */
export function buildSearchProvider(
  spec: WebSearchSpec,
  onSearch?: (info: { query: string; sourceCount: number }) => void,
): {
  id: string
  available: () => boolean
  search: (request: { query?: string; maxResults?: number }, signal?: AbortSignal) => Promise<unknown>
} {
  const id = spec.providerId ?? DEFAULT_SEARCH_PROVIDER_ID
  const sources = Array.isArray(spec.results) ? spec.results : []

  return {
    id,
    available: () => spec.available !== false,
    search: async (request) => {
      if (spec.throws !== undefined) throw new Error(spec.throws)
      // 模拟 DSH 的截断语义：seam 会按 maxResults 截断并置 truncated。
      // 这里让 provider 故意**多返回**，好让上层的截断行为可被观察到。
      const max = typeof request?.maxResults === 'number' ? request.maxResults : sources.length
      const truncated = sources.length > max
      const effective = truncated ? sources.slice(0, max) : sources
      onSearch?.({
        query: typeof request?.query === 'string' ? request.query : '',
        sourceCount: effective.length,
      })
      return {
        ...(spec.content === undefined ? {} : { content: spec.content }),
        sources: effective,
        truncated,
      }
    },
  }
}

/** 按声明构造一个假 fetch provider。纯函数，可单测。 */
export function buildFetchProvider(spec: WebFetchSpec): {
  id: string
  available: () => boolean
  fetch: (request: { url?: string }, signal?: AbortSignal) => Promise<unknown>
} {
  const id = spec.providerId ?? DEFAULT_FETCH_PROVIDER_ID

  return {
    id,
    available: () => spec.available !== false,
    fetch: async (request) => {
      if (spec.throws !== undefined) throw new Error(spec.throws)
      return {
        url: String(request?.url ?? ''),
        statusCode: typeof spec.statusCode === 'number' ? spec.statusCode : 200,
        body: { kind: spec.kind ?? 'html', content: spec.body ?? '<html>testkit</html>' },
        truncated: false,
      }
    },
  }
}

export const resourceDriver: Driver = {
  kind: 'resource',
  description: '外部资源面：假 web provider（含不可用 / 抛错两条降级路径）',
  // 不静态声明 requires —— 与实际用到的分支绑定在 setup 里检查，
  // 避免"只测 fetch"的场景被 web 能力判定误伤（与 interaction 同一考虑）
  requires: [],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { resource?: ResourceSetup }).resource
    if (!setup) return

    const web = ctx.host.service('web') as WebServiceLike | undefined
    if (!web) throw new SkipCase('宿主没有 web 服务')

    if (setup.webSearch) {
      if (typeof web.registerSearchProvider !== 'function') {
        throw new SkipCase('web 服务不提供 registerSearchProvider()')
      }
      // 每次被调用都记账——包括**不是我们主动发起**的那些
      // （例如被派生的子 agent 在自己会话里调 web_search）。
      // 这让"宿主级替身穿透到了子 agent"成为可断言的取证。
      const queries: string[] = []
      const provider = buildSearchProvider(setup.webSearch, (info) => {
        queries.push(info.query)
        ctx.fixture.note('providerSearchCalls', queries.length)
        ctx.fixture.note('providerSearchQueries', [...queries])
        ctx.fixture.note('providerSearchLastQuery', info.query)
        ctx.fixture.note('providerSearchLastSourceCount', info.sourceCount)
      })
      ctx.fixture.add('resource:search-provider', web.registerSearchProvider(provider))

      // 接管 providerId（注册 ≠ 会被选中，见文件头注），并登记恢复动作
      const previous = web.searchProviderId
      web.searchProviderId = provider.id
      ctx.fixture.add('resource:search-provider-id', () => {
        web.searchProviderId = previous
      })
      ctx.fixture.note('searchProviderId', provider.id)
      ctx.fixture.note('previousSearchProviderId', previous)
    }

    if (setup.webFetch) {
      if (typeof web.registerFetchProvider !== 'function') {
        throw new SkipCase('web 服务不提供 registerFetchProvider()')
      }
      const provider = buildFetchProvider(setup.webFetch)
      ctx.fixture.add('resource:fetch-provider', web.registerFetchProvider(provider))

      const previous = web.fetchProviderId
      web.fetchProviderId = provider.id
      ctx.fixture.add('resource:fetch-provider-id', () => {
        web.fetchProviderId = previous
      })
      ctx.fixture.note('fetchProviderId', provider.id)
      ctx.fixture.note('previousFetchProviderId', previous)
    }
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('resource' in action)) {
      throw new Error(
        `resource driver 只支持 \`resource\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const web = ctx.host.service('web') as WebServiceLike | undefined
    if (!web) throw new SkipCase('宿主没有 web 服务')

    const spec = action.resource

    if ('search' in spec) {
      if (typeof web.search !== 'function') throw new Error('web 服务不提供 search()')
      let result: unknown
      let error: string | undefined
      try {
        result = await web.search(
          {
            query: spec.search.query,
            ...(spec.search.maxResults === undefined ? {} : { maxResults: spec.search.maxResults }),
          },
          ctx.signal,
        )
      } catch (caught) {
        error = describe(caught)
      }
      ctx.fixture.note('searchResult', result)
      ctx.fixture.note('searchError', error)
      const sources = (result as { sources?: unknown[] } | undefined)?.sources
      ctx.fixture.note('searchSourceCount', Array.isArray(sources) ? sources.length : undefined)
      ctx.fixture.note('searchSources', sources)
      ctx.fixture.note('searchTruncated', (result as { truncated?: unknown } | undefined)?.truncated)
      return
    }

    if ('fetch' in spec) {
      if (typeof web.fetch !== 'function') throw new Error('web 服务不提供 fetch()')
      let result: unknown
      let error: string | undefined
      try {
        result = await web.fetch({ url: spec.fetch.url }, ctx.signal)
      } catch (caught) {
        error = describe(caught)
      }
      ctx.fixture.note('fetchResult', result)
      ctx.fixture.note('fetchError', error)
      ctx.fixture.note('fetchStatusCode', (result as { statusCode?: unknown } | undefined)?.statusCode)
      const body = (result as { body?: { content?: unknown } } | undefined)?.body
      ctx.fixture.note('fetchBody', typeof body?.content === 'string' ? body.content : undefined)
      return
    }

    throw new Error('resource 动作必须包含 search 或 fetch')
  },
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string' ? `${error.name}[${code}]: ${error.message}` : `${error.name}: ${error.message}`
  }
  return String(error)
}
