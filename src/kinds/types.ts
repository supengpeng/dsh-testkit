/**
 * Driver 契约与宿主门面。
 *
 * 设计要点：driver **不直接依赖 cordis 的 Context**，而是依赖这里定义的
 * `HostFacade`。好处：
 *   1. 核心逻辑可脱离 DSH 单测
 *   2. DSH 版本升级时，适配改动收敛在 src/index.ts 一处
 *   3. driver 作者面对的是窄接口，不容易写出跨场景污染
 */

import type { HostCapability, Scenario, ScenarioKind, StepAction } from '../cases/types.js'
import type { Fixture } from '../runtime/fixture.js'

/** 工具的注册定义。
 *
 * `execute` 的第二个参数与 DSH 的 `@deepseek-ai/dsh-tools` 保持一致（`exec.signal`），
 * 由 HostFacade 适配层转成 `defineTool({...})` 后交给 `ctx.tools.register`。
 */
export interface ToolDefinition {
  name: string
  description: string
  /** 标准 JSON Schema（object 根）；适配层转成 DSH 的 ParameterSchemaSpec。 */
  parameters?: Record<string, unknown>
  execute: (args: Record<string, unknown>, exec: { signal: AbortSignal }) => Promise<unknown> | unknown
}

/** 命令执行结果，对应 DSH 的 `CommandResult`。 */
export type CommandResultLike =
  | { kind: 'success'; text?: string }
  | { kind: 'error'; text: string }

/** 人类命令的注册定义。
 *
 * 对应 DSH 的 `CommandDefinition`：适配层负责把 `execute` 包进 `handler(invocation)`。
 */
export interface CommandDefinition {
  name: string
  description: string
  /** 输入提示，对应 DSH `input.hint`。 */
  inputHint?: string
  recordInput?: boolean
  execute: (rawInput: string, signal: AbortSignal) => Promise<CommandResultLike> | CommandResultLike
}

/** host 半提供给 driver 的能力面。 */
export interface HostFacade {
  /** 当前宿主实际具备的能力集合（用于 requires 判定）。 */
  readonly capabilities: ReadonlySet<HostCapability>

  /**
   * 原始服务访问（保底出口）。
   *
   * driver 需要做深度操作（如直接改 tools 服务的内部状态）时用它。
   * 返回值形状由 DSH 决定，调用方自行收窄。
   */
  service(name: string): unknown | undefined

  /**
   * 监听事件。返回 disposer。
   *
   * 参数用 `any[]`：这里是类型擦除的适配边界，listener 的实参形状由各事件
   * 自己的契约决定（例如 `llm/stream` 是 `(options, next)`），宽签名让 driver
   * 能按目标事件契约显式标注自己的参数类型。
   */
  on(event: string, listener: (...args: any[]) => unknown, options?: { prepend?: boolean }): () => void

  /**
   * 触发一次 waterfall —— 相当于「替宿主发起这次请求」。
   *
   * 为什么需要它：有些 waterfall 从服务方法进去会撞上前置条件。
   * 例如 `approval.request()` 要求**有开启的 turn**（审计对必须被会话日志的
   * commit/replay 边界包住），在自检场景里没有 turn，直接调会抛错。
   * 直接触发 waterfall 则不受此限，同时仍然走完整的 listener 链。
   *
   * @param name - 事件名，如 `approval/request`
   * @param args - 事件参数（不含 `next`）
   * @param next - 没有 listener 时执行的兜底实现（即"真实实现"的位置）
   */
  waterfall<T>(name: string, args: readonly unknown[], next: () => T): T

  /** 注册工具。返回 disposer。 */
  registerTool(definition: ToolDefinition): () => void

  /** 注册人类命令。返回 disposer；宿主无 commands 能力时应抛错或由调用方先判定 capabilities。 */
  registerCommand(definition: CommandDefinition): () => void

  /** 写入日志（带插件前缀）。 */
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void

  /** 宿主环境事实（进报告）。 */
  readonly env: { dshVersion: string; platform: string; nodeVersion: string }
}

/** driver 每次执行的上下文。 */
export interface DriverContext {
  readonly host: HostFacade
  readonly fixture: Fixture
  readonly scenario: Scenario
  readonly signal: AbortSignal
}

/** driver 契约。 */
export interface Driver<S extends Scenario = Scenario> {
  readonly kind: ScenarioKind
  /** 一句话描述该 driver 覆盖什么。 */
  readonly description: string
  /** 声明该 driver 需要宿主具备哪些能力（与 case 的 requires 取并集）。 */
  readonly requires?: readonly HostCapability[]

  /** 安装干预。所有注册必须经 `fx.add()` 登记。 */
  setup(ctx: DriverContext, scenario: S): Promise<void> | void

  /** 执行 case 里的一个动作（可选）。 */
  act?(ctx: DriverContext, action: StepAction): Promise<void> | void

  /** 夹具之外的额外清理（可选）。 */
  teardown?(ctx: DriverContext): Promise<void> | void
}

/** 任何 driver 都可以抛这个来把 case 标成 skipped 而不是 failed。 */
export class SkipCase extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'SkipCase'
  }
}

/** driver 注册中心。 */
export class DriverRegistry {
  private readonly drivers = new Map<ScenarioKind, Driver>()

  register(driver: Driver): void {
    this.drivers.set(driver.kind, driver)
  }

  get(kind: ScenarioKind): Driver | undefined {
    return this.drivers.get(kind)
  }

  list(): Driver[] {
    return [...this.drivers.values()]
  }

  kinds(): ScenarioKind[] {
    return [...this.drivers.keys()]
  }
}
