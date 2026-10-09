/**
 * headless 宿主 —— 一个不依赖 DSH 运行时、但服务契约一致的最小 DSH。
 *
 * 用途：
 *   ① 测试（把原先散在测试文件里的替身集中到一处）
 *   ② **CI 轨**：导出的场景用例自带宿主，可在没有 DSH 的机器上跑
 *
 * ## 边界（重要）
 *
 * 它**不是** DSH。它只实现场景用到的那些服务面。因此：
 *   - 「driver 逻辑是否正确」→ 这里能验证
 *   - 「与真实 DSH 的交互是否一致」→ **不能**，必须在活宿主上验证
 *
 * 这句话不是免责声明，而是使用说明：本宿主为绿、活宿主为红，说明问题出在
 * 宿主交互层（作用域、生命周期、真实配置），而不在驱动逻辑。
 */

import type { HostCapability } from '../cases/types.js'
import { createHostFacade } from '../host-facade.js'
import type { HostFacade } from '../kinds/types.js'
import {
  createApprovalService,
  createCommandsService,
  createLlmService,
  createSystemPromptService,
  createToolsService,
  createUserQuestionsService,
  createWebServerService,
  createWebService,
  type MinimalCommandsService,
  type MinimalSystemPromptService,
  type MinimalToolsService,
  type MinimalWebServerService,
  type MinimalWebService,
} from './services.js'

/** 本宿主**具备**最小实现的能力集合。 */
export const HEADLESS_CAPABILITIES: readonly HostCapability[] = [
  'tools',
  'commands',
  'systemPrompt',
  'web',
  'webServer',
  'llm',
  'userQuestions',
  'approval',
] as const

export interface HeadlessHostOptions {
  /** 只提供这些能力；缺省 = 全部 `HEADLESS_CAPABILITIES`。 */
  capabilities?: readonly HostCapability[]
  env?: {
    dshVersion?: string
    platform?: string
    nodeVersion?: string
  }
  /** 日志出口；缺省静默。 */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
}

export interface HeadlessHost {
  host: HostFacade
  /**
   * 底层 cordis Context —— 供**高级用法**（如测试里装配真实插件）。
   *
   * 标成 `unknown` 是刻意的：正常路径应该走 `host`（窄接口），
   * 直接操作 ctx 属于例外，需要调用方自己确认形状。
   */
  ctx: unknown
  /** 各最小服务实例，便于测试直接观测（如 `web.searchProviderId`）。 */
  services: {
    tools: MinimalToolsService
    commands: MinimalCommandsService
    systemPrompt: MinimalSystemPromptService
    web: MinimalWebService
    webServer: MinimalWebServerService
    llm: { stream(options: unknown): unknown; readonly realAdapterCalls: number }
    userQuestions: { ask(request: unknown): unknown }
    approval: { request(req: unknown): unknown }
  }
  /** 释放宿主（卸载 cordis context）。 */
  dispose(): Promise<void>
}

/** 需要 cordis 的最小面（避免静态 import，保持插件主路径不依赖它）。 */
interface CordisContextLike {
  provide(name: string, value: unknown): void
  waterfall(...args: unknown[]): unknown
  dispose?(): unknown
}

/**
 * 组装一个 headless 宿主。
 *
 * `@deepseek-ai/cordis` 是**动态 import** 的：插件在真实 DSH 里运行时
 * 已经身处 cordis 容器中，不需要（也不应该）再引一份；只有本函数被调用时
 * 才需要它存在。
 */
export async function createHeadlessHost(
  options: HeadlessHostOptions = {},
): Promise<HeadlessHost> {
  let Context: new () => CordisContextLike
  try {
    const mod = (await import('@deepseek-ai/cordis')) as { Context: new () => CordisContextLike }
    Context = mod.Context
  } catch (error) {
    throw new Error(
      `headless 宿主需要 @deepseek-ai/cordis 可用（它是 peerDependency）。` +
        `安装它后再试。原始错误：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const ctx = new Context()
  const tools = createToolsService()
  const commands = createCommandsService()
  const systemPrompt = createSystemPromptService()
  const web = createWebService()
  const webServer = createWebServerService()
  const llm = createLlmService(ctx)
  const userQuestions = createUserQuestionsService(ctx)
  const approval = createApprovalService(ctx)

  const wanted = new Set<HostCapability>(options.capabilities ?? HEADLESS_CAPABILITIES)
  const catalogue: Array<[HostCapability, unknown]> = [
    ['tools', tools],
    ['commands', commands],
    ['systemPrompt', systemPrompt],
    ['web', web],
    ['webServer', webServer],
    ['llm', llm],
    ['userQuestions', userQuestions],
    ['approval', approval],
  ]
  for (const [capability, service] of catalogue) {
    if (wanted.has(capability)) ctx.provide(capability, service)
  }

  const host = createHostFacade({
    // createHostFacade 只要 cordis Context 的那几个面；这里复用同一形状
    ctx: ctx as never,
    dshVersion: options.env?.dshVersion ?? 'headless',
    log: options.log ?? ((): void => undefined),
    env: {
      ...(options.env?.platform === undefined ? {} : { platform: options.env.platform }),
      ...(options.env?.nodeVersion === undefined ? {} : { nodeVersion: options.env.nodeVersion }),
    },
  })

  return {
    host,
    ctx,
    services: { tools, commands, systemPrompt, web, webServer, llm, userQuestions, approval },
    async dispose() {
      if (typeof ctx.dispose === 'function') await Promise.resolve(ctx.dispose())
    },
  }
}
