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

import type { CostClass, ScenarioKind } from '../cases/types.js'
import { DriverRegistry, type Driver } from './types.js'
import { agentDriver } from './agent.js'
import { compactionDriver } from './compaction.js'
import { fileDriver } from './file.js'
import { fsDriver } from './fs.js'
import { interactionDriver } from './interaction.js'
import { llmDriver } from './llm.js'
import { promptDriver } from './prompt.js'
import { resourceDriver } from './resource.js'
import { sessionDriver } from './session.js'
import { shellDriver } from './shell.js'
import { toolDriver } from './tool.js'
import { uiDriver } from './ui.js'

/**
 * 各 kind 的成本档位表 —— 成本闸门的**唯一真源**。
 *
 * 为什么集中一处（而不是让 12 个 driver 文件各自写 `cost()`）：
 *   · 12 个文件各写一遍，改一处忘一处是迟早的事；漂移的表现是"某类场景
 *     悄悄被放行去调模型"，属于最难察觉的一类缺陷；
 *   · 评审/读者需要一个**一眼扫完**的档位表——回答"这一跑会不会花钱"时，
 *     不应该去翻 12 个文件再自己拼。
 *
 * 档位口径：
 *   · `none` —— 纯离线。`llm` 也在这里：它接管 `llm/stream` 由声明产出分片，
 *     **零上游请求**（`tests/llm-driver.test.mjs` 用 `realAdapterCalls === 0` 守着）。
 *   · `low`  —— 有本地副作用（起进程 / 写文件），但没有模型成本。
 *   · `high` —— **真实模型调用**。`agent` 会派生真实子 agent；`compaction` 的
 *     `region` / `ifNeeded` 可能调模型生成摘要。
 *
 * 逃生舱：`high` 档里其实不调模型的动作（例如 `compaction` 的 `inspect` / `dump`）
 * 由**场景**显式写 `cost: none` 降档——这正是 `Scenario.cost` 字段的既定用途
 * （见 `src/cases/types.ts`）。
 */
export const DRIVER_COST: Readonly<Record<ScenarioKind, CostClass>> = {
  llm: 'none',
  tool: 'none',
  prompt: 'none',
  interaction: 'none',
  session: 'none',
  resource: 'none',
  ui: 'none',
  file: 'none',
  shell: 'low',
  fs: 'low',
  compaction: 'high',
  agent: 'high',
}

/**
 * 给 driver 注入成本档位；对 `high` 档再包一层**下界记账**。
 *
 * 记账语义（三句话，务必照此理解）：
 *   ① 是**下界**：`真实调用次数 ≥ 记账值`。所以 `maxModelCalls` 是保守闸门——
 *      不会漏掉狂奔的用量，但不能当账单用；
 *   ② **token 不猜**：driver 不主动上报就记 0，`maxTokens` 只在有上报时才真正强制；
 *   ③ **每个 act 只记一次**（不是每 step 一次，也不重复计），且是"先记账再执行"——
 *      宁可多记一次，也不漏记。精确记账点在各 driver 内部（通过
 *      `DriverContext.usage` 上报），本次不改 `agent.ts` / `compaction.ts`，避免双计。
 */
function withDriverCost(driver: Driver): Driver {
  const declared = DRIVER_COST[driver.kind]
  const cost = driver.cost ?? ((): CostClass => declared)
  const act = driver.act
  if (declared !== 'high' || act === undefined) return { ...driver, cost }

  return {
    ...driver,
    cost,
    async act(ctx, action) {
      // 场景显式 `cost: none` = 声明"这个动作不调模型"（如 compaction 的只读 inspect），
      // 此时不记账；否则按 high 档记一次。
      if ((ctx.scenario.cost ?? declared) === 'high') ctx.usage?.recordModelCall()
      await act(ctx, action)
    },
  }
}

/** 创建一个注册中心并挂上全部已实现的 driver（成本档位在注册处统一注入）。 */
export function createDriverRegistry(): DriverRegistry {
  const registry = new DriverRegistry()

  registry.register(withDriverCost(toolDriver))
  registry.register(withDriverCost(promptDriver))
  registry.register(withDriverCost(llmDriver))
  registry.register(withDriverCost(interactionDriver))
  registry.register(withDriverCost(sessionDriver))
  registry.register(withDriverCost(resourceDriver))
  registry.register(withDriverCost(agentDriver))
  registry.register(withDriverCost(uiDriver))
  registry.register(withDriverCost(shellDriver))
  registry.register(withDriverCost(fileDriver))
  registry.register(withDriverCost(fsDriver))
  registry.register(withDriverCost(compactionDriver))

  return registry
}

export { DriverRegistry, SkipCase } from './types.js'
export type { Driver, DriverContext, HostFacade, ToolDefinition } from './types.js'
export {
  toolDriver,
  buildPreDecision,
  buildPostDecision,
  pickByCallIndex,
  summarizeDecision,
} from './tool.js'
export type {
  ToolRegisterSpec,
  ToolInterceptSpec,
  ToolSetup,
  ToolPreExecuteSpec,
  ToolPostExecuteSpec,
  PreToolDecisionKind,
  PostToolDecisionKind,
} from './tool.js'
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
export {
  sessionDriver,
  buildCommandDefinition,
  extractGoalCode,
  isMonotonicSeq,
  TESTKIT_COMMAND_ERROR,
} from './session.js'
export type {
  SessionSetup,
  SessionCommandSpec,
  SessionFlushObserverSpec,
} from './session.js'
export {
  resourceDriver,
  buildSearchProvider,
  buildFetchProvider,
  DEFAULT_SEARCH_PROVIDER_ID,
  DEFAULT_FETCH_PROVIDER_ID,
} from './resource.js'
export type { ResourceSetup, WebSearchSpec, WebFetchSpec } from './resource.js'
export {
  agentDriver,
  listProviders,
  resolveInitiator,
  makeTeammateName,
  assertTeammateName,
  resolveTeamRole,
  findMember,
  summarizeMembers,
  waitForTeammateIdle,
  DEFAULT_TEAMMATE_WAIT_MS,
} from './agent.js'
export type { AgentSetup, AgentMode, TeammateWaitResult } from './agent.js'
export { shellDriver, readAll, expandArgvTokens, expandTokens } from './shell.js'
export type { ShellSetup } from './shell.js'
export { fileDriver, matchGlob, expandPathTokens } from './file.js'
export type { FileSetup } from './file.js'
export { fsDriver, extractFsCode, describeEntries, summarizeVersion } from './fs.js'
export type { FsSetup } from './fs.js'
export {
  compactionDriver,
  extractCompactionCode,
  summarizeEventTypes,
} from './compaction.js'
export type { CompactionSetup } from './compaction.js'
