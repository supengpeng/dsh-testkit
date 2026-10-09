/**
 * headless 宿主的最小服务集。
 *
 * ## 为什么这些代码在产品里而不是测试里
 *
 * 它们原先散落在 `tests/*.test.mjs` 里当测试替身。但"双轨执行"里的 **CI 轨**
 * 需要在没有 DSH 的机器上跑同一批场景——那时没有人替我们提供 `tools` /
 * `llm` / `systemPrompt` 等服务。所以这些最小实现必须是**产品的一部分**，
 * 导出的用例才能自洽运行。
 *
 * ## 一个纪律：替身必须与真实契约一致
 *
 * 每个服务都按其**真实契约**实现关键语义，而不是"够用就行"：
 *   - `web`：完整的 provider 选择规则表（含 `WEB_PROVIDER_AMBIGUOUS`）与 seam 截断
 *   - `llm`：用 `ctx.waterfall` 触发 `llm/stream`，与 `dsh-llm` 同形
 *   - `tools`：`guard` 先于 `execute`，且 guard 是单调的
 *   - `approval`：无答者时 fail closed 成 `unavailable`
 *
 * 替身与真实契约不一致，比没有测试更危险——它给出绿色的假象。
 */

/* ------------------------------------------------------------------ tools -- */

interface ToolDefinitionLike {
  name?: string
  execute?: (args: unknown, exec: { signal: AbortSignal }) => Promise<unknown> | unknown
  output?: { render?: (args: unknown, value: unknown) => unknown }
}

export interface MinimalToolsService {
  register(definition: ToolDefinitionLike): () => void
  guard(fn: (execution: { name?: string; arguments?: unknown }) => string | undefined): () => void
  execute(input: {
    name?: string
    arguments?: unknown
    signal?: AbortSignal
  }): Promise<unknown>
  /** 观测用：真实执行次数（含被 guard 拦下的）。 */
  readonly executions: number
  /** 观测用：当前已注册的工具名。 */
  registeredNames(): string[]
}

export function createToolsService(): MinimalToolsService {
  const registry = new Map<string, ToolDefinitionLike>()
  const guards: Array<(execution: { name?: string; arguments?: unknown }) => string | undefined> = []
  let executions = 0

  return {
    get executions() {
      return executions
    },
    registeredNames() {
      return [...registry.keys()]
    },
    register(definition) {
      const name = String(definition?.name ?? '')
      registry.set(name, definition)
      return () => registry.delete(name)
    },
    guard(fn) {
      guards.push(fn)
      return () => {
        const index = guards.indexOf(fn)
        if (index >= 0) guards.splice(index, 1)
      }
    },
    async execute({ name, arguments: args, signal }) {
      executions += 1

      // 如实反映真实契约：defineTool 会校验 arguments 必须是对象。
      // 替身若在这里"宽容处理"，就会掩盖调用方传错参数的 bug。
      if (args === undefined || args === null || typeof args !== 'object' || Array.isArray(args)) {
        const message = 'invalid arguments: "arguments" must be an object'
        return { isError: true, error: { message }, content: [{ type: 'text', text: message }] }
      }

      // guard 先于 dispatch，且单调（任一 guard 返回字符串即拒绝）
      for (const guard of guards) {
        const reason = guard({ name, arguments: args })
        if (typeof reason === 'string' && reason !== '') {
          return {
            isError: true,
            error: { message: reason },
            content: [{ type: 'text', text: reason }],
          }
        }
      }

      const definition = name === undefined ? undefined : registry.get(name)
      if (!definition || typeof definition.execute !== 'function') {
        const message = `UNKNOWN_TOOL: ${String(name)}`
        return { isError: true, error: { message }, content: [{ type: 'text', text: message }] }
      }

      const effectiveSignal = signal ?? new AbortController().signal
      try {
        const value = await definition.execute(args, { signal: effectiveSignal })
        const content =
          typeof definition.output?.render === 'function'
            ? definition.output.render(args, value)
            : [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
        return { isError: false, value, content }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { isError: true, error: { message }, content: [{ type: 'text', text: message }] }
      }
    },
  }
}

/* ----------------------------------------------------------- systemPrompt -- */

interface PromptSectionLike {
  name: string
  order: number
  text: string | ((context: unknown) => string)
}

interface PromptContextLike {
  name: string
  order: number
  text: string | ((context: unknown) => string)
}

export interface MinimalSystemPromptService {
  section(section: PromptSectionLike): () => void
  context(context: PromptContextLike): () => void
  variable(name: string, provider: (context: unknown) => string | undefined): () => void
  assemble(): Promise<{
    sections: Array<{ name: string; text: string }>
    contexts: Array<{ name: string; text: string }>
    tools: unknown[]
    variables: Record<string, string | undefined>
  }>
}

export function createSystemPromptService(): MinimalSystemPromptService {
  const sections: PromptSectionLike[] = []
  const contexts: PromptContextLike[] = []
  const variables = new Map<string, (context: unknown) => string | undefined>()
  const render = (text: string | ((c: unknown) => string)): string =>
    typeof text === 'function' ? text({}) : text

  return {
    section(spec) {
      sections.push(spec)
      return () => {
        const index = sections.indexOf(spec)
        if (index >= 0) sections.splice(index, 1)
      }
    },
    context(spec) {
      contexts.push(spec)
      return () => {
        const index = contexts.indexOf(spec)
        if (index >= 0) contexts.splice(index, 1)
      }
    },
    variable(name, provider) {
      variables.set(name, provider)
      return () => variables.delete(name)
    },
    async assemble() {
      return {
        sections: [...sections]
          .sort((a, b) => a.order - b.order)
          .map((s) => ({ name: s.name, text: render(s.text) })),
        contexts: [...contexts]
          .sort((a, b) => a.order - b.order)
          .map((c) => ({ name: c.name, text: render(c.text) })),
        tools: [],
        variables: Object.fromEntries([...variables].map(([k, v]) => [k, v({})])),
      }
    },
  }
}

/* -------------------------------------------------------------------- llm -- */

/** 复刻 `dsh-llm` 的触发形式：`ctx.waterfall(scope, 'llm/stream', options, next)`。 */
export function createLlmService(ctx: {
  waterfall: (...args: unknown[]) => unknown
}): {
  stream(options: unknown): unknown
  readonly realAdapterCalls: number
} {
  let realAdapterCalls = 0

  return {
    get realAdapterCalls() {
      return realAdapterCalls
    },
    stream(options) {
      return ctx.waterfall(ctx, 'llm/stream', options, () => {
        realAdapterCalls += 1
        return (async function* () {
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      })
    },
  }
}

/* ------------------------------------------------------------ interaction -- */

export function createUserQuestionsService(ctx: {
  waterfall: (...args: unknown[]) => unknown
}): { ask(request: unknown): unknown } {
  return {
    ask(request) {
      return ctx.waterfall(ctx, 'user-questions/request', request, () => ({ answers: [] }))
    },
  }
}

export function createApprovalService(ctx: {
  waterfall: (...args: unknown[]) => unknown
}): { request(req: unknown): unknown } {
  return {
    request(req) {
      // 无答者时 fail closed 成 unavailable —— 与 DSH 的语义一致
      return ctx.waterfall(ctx, 'approval/request', req, () => 'unavailable')
    },
  }
}

/* ---------------------------------------------------------------- commands -- */

export interface MinimalCommandsService {
  register(definition: unknown): () => void
  registeredNames(): string[]
}

export function createCommandsService(): MinimalCommandsService {
  const registry = new Map<string, unknown>()
  return {
    registeredNames() {
      return [...registry.keys()]
    },
    register(definition) {
      const name = String((definition as { name?: unknown })?.name ?? '')
      registry.set(name, definition)
      return () => registry.delete(name)
    },
  }
}

/* --------------------------------------------------------------------- web -- */

interface SearchProviderLike {
  id: string
  available(): boolean
  search(request: unknown, signal?: AbortSignal): Promise<unknown>
}
interface FetchProviderLike {
  id: string
  available(): boolean
  fetch(request: unknown, signal?: AbortSignal): Promise<unknown>
}

export interface MinimalWebService {
  searchProviderId?: string
  fetchProviderId?: string
  registerSearchProvider(provider: SearchProviderLike): () => void
  registerFetchProvider(provider: FetchProviderLike): () => void
  search(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  fetch(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

function webError(code: string, message: string): Error {
  const error = new Error(message)
  error.name = 'WebError'
  ;(error as Error & { code?: string }).code = code
  return error
}

/** 复刻 `web` 服务契约里的 provider 选择规则表。 */
function pickProvider<T extends { available(): boolean }>(
  providers: Map<string, T>,
  configuredId: string | undefined,
): T {
  if (typeof configuredId === 'string' && configuredId !== '') {
    const provider = providers.get(configuredId)
    if (!provider) {
      throw webError(
        'WEB_PROVIDER_CONFIGURED_MISSING',
        `configured provider "${configuredId}" is not registered`,
      )
    }
    if (!provider.available()) {
      throw webError(
        'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
        `configured provider "${configuredId}" is unavailable`,
      )
    }
    return provider
  }

  const usable = [...providers.values()].filter((p) => p.available())
  if (usable.length === 0) throw webError('WEB_PROVIDER_UNAVAILABLE', 'no usable provider')
  if (usable.length > 1) {
    throw webError('WEB_PROVIDER_AMBIGUOUS', `${usable.length} usable providers`)
  }
  return usable[0]!
}

export function createWebService(): MinimalWebService {
  const searchProviders = new Map<string, SearchProviderLike>()
  const fetchProviders = new Map<string, FetchProviderLike>()
  let searchProviderId: string | undefined
  let fetchProviderId: string | undefined

  return {
    get searchProviderId() {
      return searchProviderId
    },
    set searchProviderId(value) {
      searchProviderId = value
    },
    get fetchProviderId() {
      return fetchProviderId
    },
    set fetchProviderId(value) {
      fetchProviderId = value
    },
    registerSearchProvider(provider) {
      searchProviders.set(provider.id, provider)
      return () => searchProviders.delete(provider.id)
    },
    registerFetchProvider(provider) {
      fetchProviders.set(provider.id, provider)
      return () => fetchProviders.delete(provider.id)
    },
    async search(request, signal) {
      const provider = pickProvider(searchProviders, searchProviderId)
      const result = (await provider.search(request, signal)) as {
        sources?: unknown[]
        truncated?: boolean
      }
      // seam 的截断职责
      const max = request?.['maxResults']
      if (
        typeof max === 'number' &&
        Array.isArray(result?.sources) &&
        result.sources.length > max
      ) {
        return { ...result, sources: result.sources.slice(0, max), truncated: true }
      }
      return result
    },
    async fetch(request, signal) {
      const provider = pickProvider(fetchProviders, fetchProviderId)
      return provider.fetch(request, signal)
    },
  }
}

/* -------------------------------------------------------------- webServer -- */

export interface MinimalWebServerService {
  register(route: unknown): () => void
  routes(): unknown[]
}

export function createWebServerService(): MinimalWebServerService {
  const registered: unknown[] = []
  return {
    routes() {
      return [...registered]
    },
    register(route) {
      registered.push(route)
      return () => {
        const index = registered.indexOf(route)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  }
}
