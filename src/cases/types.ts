/**
 * 场景数据的类型定义。
 *
 * 这里只描述**数据形状**，不含任何 DSH 依赖，便于被单元测试直接引用。
 * 字段语义见 docs/SCENARIO-SPEC.md。
 */

/** 场景类型（= 干预点分类）。新增 kind 时同步扩这里与 kinds/index.ts。 */
export type ScenarioKind =
  | 'llm'
  | 'tool'
  | 'prompt'
  | 'interaction'
  | 'session'
  | 'resource'
  | 'agent'
  | 'ui'
  | 'shell'
  | 'file'

/** 宿主能力名，对应 DSH 侧的服务/扩展点。 */
export type HostCapability =
  | 'tools'
  | 'llm'
  | 'commands'
  | 'systemPrompt'
  | 'approval'
  | 'userQuestions'
  | 'session'
  | 'fs'
  | 'subprocess'
  | 'web'
  | 'webServer'
  | 'agentLoop'
  | 'subagents'
  | 'storage'
  | 'timer'
  | 'client'

export type Severity = 'low' | 'medium' | 'high'
export type CaseStatus = 'active' | 'draft' | 'retired' | 'blocked'

/** case 的溯源信息。 */
export interface ScenarioSource {
  /** 来源 issue；无 URL 时写文本标识，确实是手工构造的写 null。 */
  issue: string | null
  /** 症状首次被报告的日期（YYYY-MM-DD）。 */
  reported?: string
  /** 原始症状的一句话还原。 */
  summary?: string
}

/** 运行参数。 */
export interface RuntimeSpec {
  /** 本 case 超时（毫秒）。 */
  timeoutMs?: number
  /** 依赖的宿主能力；缺失时 SKIP 而非 FAIL。 */
  requires?: HostCapability[]
  /** fresh = 新会话隔离（默认）；reuse = 复用当前会话。 */
  session?: 'fresh' | 'reuse'
  /** 重复次数，用于验证稳定性。 */
  repeat?: number
  /** 干预是否隔离在本次运行内（默认 true）。 */
  isolate?: boolean
}

/** 断言词集合。一行只允许出现一个断言词（`soft` 除外）。 */
export interface Assertion {
  /** 取值路径：`fx.*` / `case.*` / `env.*`。 */
  ref: string

  is?: unknown
  isNot?: unknown
  notIs?: unknown
  exists?: boolean
  notExists?: boolean
  contains?: string | readonly unknown[]
  notContains?: string | readonly unknown[]
  matches?: string
  atLeast?: number
  atMost?: number
  length?: number
  lengthAtLeast?: number
  lengthAtMost?: number
  throws?: boolean

  /** 软断言：失败不中断本 case 后续步骤。 */
  soft?: boolean
}

/** `interaction` 动作：模拟宿主发起一次人机交互请求。 */
export type InteractionAction =
  | {
      question: {
        question: string
        header?: string
        detail?: string
        options?: Array<{ label: string; description?: string }>
        multiSelect?: boolean
      }
    }
  | { approval: { toolName: string; reason?: string; callId?: string } }

/** `session` 动作：触发一次人类命令。 */
export type SessionAction = { command: { name: string; input?: string } }

/** `resource` 动作：触发一次外部资源访问。 */
export type ResourceAction =
  | { search: { query: string; maxResults?: number } }
  | { fetch: { url: string } }

/** `agent` 动作：派生一个子 agent 并跑一个真实任务。 */
export type AgentAction = { prompt: string }

/** `ui` 动作：在隔离环境里加载 client 半产物并驱动它。 */
export type UiAction = { load?: boolean }

/** `file` 动作：读一个文件、按 glob 列文件、或在文件里搜内容（纯离线）。 */
export type FileAction =
  | { read: string; glob?: never; search?: never }
  | { glob: string; read?: never; search?: never }
  | {
      read?: never
      glob?: never
      /** 在文件内容里搜的正则（对应 grep）。 */
      search: {
        pattern: string
        /** 限定搜索范围（glob 模式）；省略即搜全部。 */
        glob?: string
        /** 正则标志，例如 `i`。 */
        flags?: string
        /** 命中上限，缺省 500。 */
        maxResults?: number
      }
    }

/**
 * `shell` 动作：跑一条外部命令并取证它的输出与退出码。
 *
 * `argv` 是**数组**（与 DSH `subprocess.spawn` 一致），不经过 shell 解析——
 * 所以没有引号/重定向/管道，也就没有注入面。需要 shell 特性时显式调 `sh -c`。
 */
export type ShellAction = {
  argv: string[]
  /** 喂给 stdin 的内容；省略即关闭 stdin。 */
  stdin?: string
  /** 覆盖 setup 里的 cwd。 */
  cwd?: string
  /** 覆盖 setup 里的 env。 */
  env?: Record<string, string>
}

/** 步骤可执行的动作。 */
export type StepAction =
  | { tool: string; args?: Record<string, unknown> }
  | { prompt: string }
  /** 触发一次模型流（由 llm driver 接管，不会真的请求上游）。 */
  | { llm: { prompt: string } }
  /** 触发一次提问 / 审批请求（由 interaction driver 应答）。 */
  | { interaction: InteractionAction }
  /** 触发一次人类命令（由 session driver 执行）。 */
  | { session: SessionAction }
  /** 触发一次外部资源访问（由 resource driver 经假 provider 应答）。 */
  | { resource: ResourceAction }
  /** 派生一个子 agent 并跑一个真实任务（**会产生真实模型调用**）。 */
  | { agent: AgentAction }
  /** 在隔离环境里加载 client 半产物并驱动它（纯离线，任何宿主都能跑）。 */
  | { ui: UiAction }
  /** 跑一条外部命令并取证输出与退出码。 */
  | { shell: ShellAction }
  /** 读文件 / 列目录并取证内容（纯离线，任何宿主都能跑）。 */
  | { file: FileAction }
  | { wait: { ms: number } }
  | { emit: { event: string; payload?: unknown } }

export interface Step {
  name?: string
  act?: StepAction
  expect?: Assertion[]
}

/** 一条完整的场景。 */
export interface Scenario {
  schema: number
  id: string
  title: string
  kind: ScenarioKind
  severity?: Severity
  status?: CaseStatus
  tags?: string[]
  source: ScenarioSource
  runtime?: RuntimeSpec
  /** 条件段；字段集由 kind 决定。 */
  setup: Record<string, unknown>
  steps: Step[]
}

/** 已注册的 kind 列表（运行时真源在 registry，这里是类型层常量）。 */
export const SCENARIO_KINDS: readonly ScenarioKind[] = [
  'llm',
  'tool',
  'prompt',
  'interaction',
  'session',
  'resource',
  'agent',
  'ui',
  'shell',
  'file',
] as const

/** 当前规范版本。 */
export const SCHEMA_VERSION = 1
