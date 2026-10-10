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
  /** 宿主的文件服务语义（沙箱 / 写意图 / 版本冲突），区别于纯离线的 `file`。 */
  | 'fs'
  /** 会话历史压缩边界（`ctx.compaction`），只在**隔离会话**上动手。 */
  | 'compaction'

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
  /** Agent Teams 协作面（实验包 `dsh-experimental-agent-team`）。 */
  | 'agentTeams'
  /** 会话存储（`ctx.sessions`）：`flush` 检查点、隔离会话创建。 */
  | 'sessions'
  /** 目标服务（`ctx.goals`）。 */
  | 'goals'
  /** 会话历史压缩（`ctx.compaction`）。 */
  | 'compaction'
  | 'storage'
  | 'timer'
  | 'client'

export type Severity = 'low' | 'medium' | 'high'
export type CaseStatus = 'active' | 'draft' | 'retired' | 'blocked'

/**
 * 并发模式：
 *   · `safe`      —— 与其它 safe 场景可并发（各自隔离命名空间 / tmpdir / 端口）
 *   · `exclusive` —— 必须独占执行（会碰共享状态，例如真实会话、全局注册表）
 *
 * 缺省值由 runner 决定：**默认 `exclusive`**（不认识的东西不并发），
 * 想并发必须由场景显式声明 `parallel: safe`。
 */
export type ParallelMode = 'safe' | 'exclusive'

/**
 * 成本分级（见 `src/executor/policy.ts`）。
 *
 *   · `none` —— 纯离线：不调模型、不起外部进程
 *   · `low`  —— 本地副作用：起进程 / 写文件，但没有模型成本
 *   · `high` —— **真实模型调用**（CI 默认不允许，必须显式 `--allow-model`）
 */
export type CostClass = 'none' | 'low' | 'high'

/** 预算上限；超限直接判失败（而不是"继续跑完再看账单"）。 */
export interface BudgetSpec {
  /** 真实模型调用次数上限。 */
  maxModelCalls?: number
  /** token 上限；driver 上报 token 时才可强制。 */
  maxTokens?: number
}

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

/** `goal` 子动作：操作当前 agent 的目标（`ctx.goals`）。 */
export type GoalAction =
  | { op: 'get' }
  | { op: 'create'; objective: string; maxGoalRounds?: number; disarmAfter?: boolean }
  | { op: 'edit'; objective?: string; maxGoalRounds?: number }
  | { op: 'pause' | 'resume' | 'complete' | 'clear' | 'disarm' }
  | { op: 'block'; code: string; message: string }

/**
 * `session` 动作：会话与目标面（四个分支，来源各不同）。
 *
 *   · `command` —— 人类命令（Phase 2 起）
 *   · `flush`   —— `ctx.sessions.flush()`：会话日志的持久化检查点
 *   · `goal`    —— `ctx.goals`：会话自带的目标状态机
 *   · `events`  —— **只读**观察 `session/event`（post-commit 追加流）
 *
 * `events` 刻意只读：DSH 的纪律是「不要用新的 type 追加会话事件」
 * （`Session.append()` 无法设置 `ignorable`，那样写过的会话会**拒绝重开**）。
 */
export type SessionAction =
  | { command: { name: string; input?: string } }
  | { flush: { note?: string } }
  | { goal: GoalAction }
  | { events: { waitMs?: number; limit?: number } }

/** `resource` 动作：触发一次外部资源访问。 */
export type ResourceAction =
  | { search: { query: string; maxResults?: number } }
  | { fetch: { url: string } }

/**
 * `agent` 动作：派生一个子 agent 并跑一个真实任务。
 *
 * `mode` 覆盖 `setup.agent.mode`（同一场景里两条通道可混用）；
 * `name` 只对 `mode: teammate` 有意义（团队成员名）。
 */
export type AgentAction = {
  prompt: string
  mode?: 'one-shot' | 'teammate'
  name?: string
}

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

/**
 * `fs` 动作：驱动 **DSH 的 `ctx.fs` 文件服务**（不是 Node 原生 fs）。
 *
 * 与 `file` 的分工：
 *   · `file` = 纯离线读文件（`node:fs`），零依赖，任何宿主都能跑
 *   · `fs`   = 宿主的文件服务语义：沙箱策略、写意图、版本冲突
 *
 * 真正的价值在后两类——`node:fs` **测不到** DSH 的沙箱边界与陈旧版本保护。
 */
export type FsAction =
  | { resolve: { path: string; cwd?: string } }
  | { stat: { path: string } }
  | { read: { path: string } }
  | { list: { path: string } }
  | {
      write: {
        path: string
        text: string
        /** 缺省 = 无条件覆盖。 */
        intent?: 'unconditional' | 'createIfAbsent' | 'replaceIfVersion'
        /** `replaceIfVersion` 用哪个版本：`last`（最近一次观测）或 `first`（首次观测）。 */
        expectedVersion?: 'first' | 'last'
        /** 覆盖 setup 的沙箱策略（用它可以测"越界被拒"）。 */
        sandbox?: {
          mode: 'read-only' | 'workspace-write' | 'danger-full-access'
          /** `workspace-write` 的根；缺省取 setup.fs.workspace。 */
          workspace?: string
        }
      }
    }
  | {
      edit: {
        path: string
        oldString: string
        newString: string
        replaceAll?: boolean
        /** 版本守卫的来源；省略即无守卫（无条件编辑）。 */
        expectedVersion?: 'first' | 'last'
      }
    }

/**
 * `compaction` 动作：驱动会话历史压缩（`ctx.compaction`）。
 *
 * **安全约定**：driver 只在自己创建的**隔离会话**上动手（`sessions.create()`，
 * 不绑定 agent 就不落盘）。`region` / `now` 会真的改写会话历史，
 * 所以它们绝不能作用在用户正在用的会话上。
 */
export type CompactionAction =
  | {
      /** 让宿主的压力策略决定"要不要压"——理论上无副作用。 */
      ifNeeded: { trigger?: 'pressure' | 'context-overflow' }
    }
  | {
      /** 强制压缩一段 surface 范围（**会改写会话历史**，且可能调模型生成摘要）。 */
      region: { start: number; end: number }
    }
  | {
      /** 手动压缩：需要 `runMaintenance`（真实 agent 上下文），隔离会话下不可用。 */
      now: Record<string, never>
    }
  | {
      /** 只读：报目标会话的序号、surface 节点数与事件分布。 */
      inspect: Record<string, never>
    }
  | {
      /**
       * 只读：把目标会话的事件样本（含原始 `data`）与 surface 序号记进取证。
       *
       * 用途是**确认真实形状**——合成 seed 事件、挑选压缩范围之前，
       * 先让宿主自己把结构说出来，而不是照着文档猜。
       */
      dump: { limit?: number }
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
  /** 驱动宿主文件服务：沙箱策略、写意图、版本冲突（需要 `fs` 能力）。 */
  | { fs: FsAction }
  /** 驱动会话历史压缩（需要 `compaction` 能力；只作用于隔离会话）。 */
  | { compaction: CompactionAction }
  | { wait: { ms: number } }
  | { emit: { event: string; payload?: unknown } }

export interface Step {
  /** 可选的步骤 ID（`use` 展开与跨步取值 `from` 用它引用）。 */
  id?: string
  name?: string
  act?: StepAction
  /**
   * 复用注册表里的一个 step 片段（见 `registry/steps/**`）。
   *
   * 与 `act` **互斥**：写 `use` 就只有展开后的动作，写 `act` 就是字面动作。
   * 这是「步骤级组合」的唯一入口——**禁止**场景级 include/extends。
   */
  use?: string
  /** `use` 的参数（对应片段的 params schema）；展开是纯文本替换，不做语义推断。 */
  with?: Record<string, unknown>
  expect?: Assertion[]
  /**
   * 步骤级清理声明（可选）。
   *
   * `releaseNotes` 里的取证键对应的 disposer 会在**本步结束后**释放（而不是等整条场景）；
   * `note` 是给人看的说明。整条场景结束时的兜底释放不受它影响。
   */
  cleanup?: { releaseNotes?: string[]; note?: string }
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
  /**
   * 负责人（例如 `@supengpeng`）。
   *
   * 用途不是"礼貌署名"：覆盖矩阵与自动 triage 都要按 owner 路由
   * （失败归谁、缺口补谁），所以它是**机器可读字段**。
   */
  owner?: string
  /** 并发模式；缺省 `exclusive`（见 `ParallelMode`）。 */
  parallel?: ParallelMode
  /**
   * 引用的 fixture 名（见 `fixtures/**`）。
   *
   * 名字是 `<kind>/<name>`（例如 `llm/timeout`）。解析失败或 DSH 版本不匹配时
   * 场景会**跳过并说明原因**，而不是拿一份错的夹具硬跑。
   */
  fixtures?: string[]
  /**
   * 成本分级；缺省 = 按参与 driver 的 `cost()` 取**最高**的一档。
   *
   * 显式写它有两个用途：给高成本场景兜底，或把只做只读动作的场景降到 `none`
   * （例如 `compaction` 的 `inspect` / `dump` 不调模型）。
   */
  cost?: CostClass
  /** 预算上限；只在 `cost: low | high` 时有意义。 */
  budget?: BudgetSpec
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
  'fs',
  'compaction',
] as const

/** 当前规范版本。 */
export const SCHEMA_VERSION = 1
