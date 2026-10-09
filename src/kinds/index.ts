/**
 * Driver 注册中心的本体。
 *
 * 已实现的 kind：
 *   - `tool`   —— 工具注册 / 行为制造 / 真实管道调用取证（Phase 1）
 *   - `prompt` —— 系统提示的 section / context / variable 注入（Phase 1）
 *   - `llm`    —— 接管 `llm/stream`，模型输出由声明决定（Phase 1，零上游请求）
 *
 * 待实现（见 docs/ROADMAP.md）：
 *   - Phase 2：`interaction`、`session`、`resource`
 *   - Phase 5：`agent`（端到端）
 *
 * 新增 kind 的完整步骤见 docs/ARCHITECTURE.md §10。
 */

import { agentDriver } from './agent.js'
import { fileDriver } from './file.js'
import { interactionDriver } from './interaction.js'
import { llmDriver } from './llm.js'
import { promptDriver } from './prompt.js'
import { resourceDriver } from './resource.js'
import { sessionDriver } from './session.js'
import { shellDriver } from './shell.js'
import { toolDriver } from './tool.js'
import { uiDriver } from './ui.js'
import { DriverRegistry } from './types.js'

/** 创建一个注册中心并挂上全部已实现的 driver。 */
export function createDriverRegistry(): DriverRegistry {
  const registry = new DriverRegistry()

  registry.register(toolDriver)
  registry.register(promptDriver)
  registry.register(llmDriver)
  registry.register(interactionDriver)
  registry.register(sessionDriver)
  registry.register(resourceDriver)
  registry.register(agentDriver)
  registry.register(uiDriver)
  registry.register(shellDriver)
  registry.register(fileDriver)

  return registry
}

export { DriverRegistry, SkipCase } from './types.js'
export type { Driver, DriverContext, HostFacade, ToolDefinition } from './types.js'
export { toolDriver } from './tool.js'
export type { ToolRegisterSpec, ToolInterceptSpec, ToolSetup } from './tool.js'
export { promptDriver, VARIABLE_NAME_RE, summarizeAssembly } from './prompt.js'
export type { PromptSetup } from './prompt.js'
export { llmDriver, buildChunkPlan, emitChunks, minimalLlmOptions, TESTKIT_LLM_ERROR_CODE } from './llm.js'
export type { LlmSetup, LlmRespondSpec, LlmFailMode, StreamChunkLike } from './llm.js'
export {
  interactionDriver,
  buildAnswer,
  normalizeDecision,
  APPROVAL_OUTCOMES,
  TESTKIT_QUESTION_TIMEOUT,
} from './interaction.js'
export type {
  InteractionSetup,
  InteractionQuestionSpec,
  InteractionApprovalSpec,
  ApprovalOutcomeLike,
} from './interaction.js'
export { sessionDriver, buildCommandDefinition, TESTKIT_COMMAND_ERROR } from './session.js'
export type { SessionSetup, SessionCommandSpec } from './session.js'
export {
  resourceDriver,
  buildSearchProvider,
  buildFetchProvider,
  DEFAULT_SEARCH_PROVIDER_ID,
  DEFAULT_FETCH_PROVIDER_ID,
} from './resource.js'
export type { ResourceSetup, WebSearchSpec, WebFetchSpec } from './resource.js'
export { agentDriver, listProviders, resolveInitiator } from './agent.js'
export type { AgentSetup } from './agent.js'
export { shellDriver, readAll, expandArgvTokens, expandTokens } from './shell.js'
export type { ShellSetup } from './shell.js'
export { fileDriver, matchGlob, expandPathTokens } from './file.js'
export type { FileSetup } from './file.js'
