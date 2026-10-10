/**
 * HostFacade 的 DSH 适配实现。
 *
 * **本文件是全项目唯一把 DSH 具体 API 翻译成窄接口 `HostFacade` 的地方。**
 * 这样 DSH 升级时改动收敛在这里，driver 与引擎层可以脱离宿主单测。
 *
 * 对 `@deepseek-ai/dsh-*` 这个包级别的依赖进一步下沉到了 `src/adapters/dsh/`：
 * 本文件只从 `./adapters/dsh/tools.js` 取 `defineTool`，不直接 import DSH 内部包。
 * 这条边界由 `scripts/check-adapter-boundary.mjs` 机器守卫（注释里提到包名不算违反）。
 *
 * 已按实测契约对齐：
 *   - 工具：`defineTool()`（经适配层 `src/adapters/dsh/tools.ts`）+ `ctx.tools.register(def) → disposer`
 *   - 命令：`ctx.commands.register({ name, description, input?, recordInput?, handler(invocation) })`
 *   - 服务获取：`ctx.get("<key>")`（可选，需 undefined 检查），缺失即视为不具备该能力
 */

import type { Context } from '@deepseek-ai/cordis'

import { defineTool } from './adapters/dsh/tools.js'
import type { HostCapability } from './cases/types.js'
import type {
  CommandDefinition,
  CommandResultLike,
  HostFacade,
  ToolDefinition,
} from './kinds/types.js'

/** 能力名 → DSH 侧服务 key。 */
const CAPABILITY_SERVICE: Record<HostCapability, string> = {
  tools: 'tools',
  llm: 'llm',
  commands: 'commands',
  systemPrompt: 'systemPrompt',
  approval: 'approval',
  userQuestions: 'userQuestions',
  // 会话能力的宿主侧入口是 agents（活跃 agent 注册表）
  session: 'agents',
  fs: 'fs',
  subprocess: 'subprocess',
  web: 'web',
  webServer: 'webServer',
  agentLoop: 'agentLoop',
  subagents: 'subagents',
  // Agent Teams 协作面（实验包）；缺失即 team 通道不可用
  agentTeams: 'agentTeams',
  // 会话存储与目标服务（session driver 的 flush / goal 面）
  sessions: 'sessions',
  goals: 'goals',
  compaction: 'compaction',
  storage: 'storage',
  timer: 'timer',
  // client 半的注册表
  client: 'clientModules',
}

export interface FacadeOptions {
  ctx: Context
  dshVersion: string
  log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void
  /** 覆盖 env 的其余字段（headless 宿主用；缺省取当前进程）。 */
  env?: { platform?: string; nodeVersion?: string }
}

/**
 * 从 cordis Context 取服务 —— **只用 `ctx.get()`，绝不回退属性访问**。
 *
 * 为什么（由集成测试抓到的真实故障）：
 * cordis 4 里 `ctx.someService` 只有在插件 `inject` 了该服务时才可读，
 * 否则抛 `cannot get property "X" without inject`。
 * 本插件按设计只硬依赖 `tools`、其余靠探测——若用属性访问做探测，
 * `apply` 会在第一个未注入的服务上直接抛错，插件彻底不激活
 * （表现为工具凭空消失，最难定位的失效形态）。
 *
 * `ctx.get(name)` 正是 DSH 服务契约给出的可选访问方式（缺失返回 undefined）。
 */
function getService(ctx: Context, name: string): unknown {
  const maybeGet = (ctx as unknown as { get?: (key: string) => unknown }).get
  if (typeof maybeGet !== 'function') return undefined
  try {
    const value = maybeGet.call(ctx, name)
    return value === undefined || value === null ? undefined : value
  } catch {
    /* 未提供或不可访问，一律按「不具备」处理 */
    return undefined
  }
}

/**
 * **惰性**能力集合。
 *
 * ## 为什么不能是快照（真实踩过的坑）
 *
 * cordis 的插件激活是**异步**的：`apply()` 执行时，排在后面的插件
 * （例如 `subagents`、`userQuestions`）可能**还没注册**。
 * 如果在这里拍一张快照，就会把"宿主有这个能力"误判成"没有"，
 * 进而让本该跑的场景被**错误跳过**。
 *
 * 实测证据：在真实 headless profile 里，`--dump-config` 明确列出
 * `subagent-spawn-in-process` / `user-questions` 条目，
 * 但快照式探测报"宿主缺少能力"，两条 question 场景与 agent 场景被跳过。
 *
 * 惰性求值把这个时序问题消掉：`has()` 每次现查，
 * 首次用到时那些服务早已注册完毕。
 */
class CapabilitySet implements ReadonlySet<HostCapability> {
  private readonly probe: (serviceName: string) => unknown

  constructor(probe: (serviceName: string) => unknown) {
    this.probe = probe
  }

  private present(): HostCapability[] {
    return (Object.keys(CAPABILITY_SERVICE) as HostCapability[]).filter((capability) =>
      this.has(capability),
    )
  }

  has(capability: HostCapability): boolean {
    const service = CAPABILITY_SERVICE[capability]
    if (service === undefined) return false
    return this.probe(service) !== undefined
  }

  get size(): number {
    return this.present().length
  }

  [Symbol.iterator](): SetIterator<HostCapability> {
    return this.present()[Symbol.iterator]() as SetIterator<HostCapability>
  }

  keys(): SetIterator<HostCapability> {
    return this[Symbol.iterator]()
  }

  values(): SetIterator<HostCapability> {
    return this[Symbol.iterator]()
  }

  entries(): SetIterator<[HostCapability, HostCapability]> {
    const pairs = this.present().map(
      (capability) => [capability, capability] as [HostCapability, HostCapability],
    )
    return pairs[Symbol.iterator]() as SetIterator<[HostCapability, HostCapability]>
  }

  forEach(
    callback: (value: HostCapability, value2: HostCapability, set: ReadonlySet<HostCapability>) => void,
    thisArg?: unknown,
  ): void {
    for (const capability of this.present()) {
      callback.call(thisArg, capability, capability, this)
    }
  }
}

export function createHostFacade(options: FacadeOptions): HostFacade {
  const { ctx, dshVersion, log } = options

  const capabilities = new CapabilitySet((serviceName) => getService(ctx, serviceName))

  return {
    capabilities,

    service: (name) => getService(ctx, name),

    on(event, listener, opts) {
      const target = ctx as unknown as {
        on?: (e: string, l: unknown, o?: unknown) => unknown
      }
      if (typeof target.on !== 'function') return () => undefined
      try {
        const disposer = target.on.call(ctx, event, listener, opts)
        return typeof disposer === 'function' ? (disposer as () => void) : () => undefined
      } catch (error) {
        log('warn', `监听事件失败 ${event}：${String(error)}`)
        return () => undefined
      }
    },

    waterfall<T>(name: string, args: readonly unknown[], next: () => T): T {
      const target = ctx as unknown as {
        waterfall?: (...a: unknown[]) => unknown
      }
      if (typeof target.waterfall !== 'function') {
        throw new Error('宿主不支持 waterfall（不是 cordis Context？）')
      }
      // 与 DSH 自己的调用形式一致：ctx.waterfall(scope, name, ...args, next)
      return target.waterfall.call(ctx, ctx, name, ...args, next) as T
    },

    registerTool(definition: ToolDefinition) {
      const tools = getService(ctx, 'tools') as
        | { register: (def: unknown) => () => void }
        | undefined
      if (!tools || typeof tools.register !== 'function') {
        throw new Error('宿主不具备 tools 能力，无法注册工具')
      }

      const dshDefinition = defineTool({
        name: definition.name,
        description: definition.description,
        parameters: jsonSchemaToParameters(definition.parameters) as never,
        output: {
          schema: { type: 'json' } as never,
          render(_args: unknown, value: unknown) {
            return [{ type: 'text', text: stringifyToolValue(value) }] as never
          },
        },
        timeoutMs: 120_000,
        // 测试类工具会改动宿主状态，一律按写操作串行处理
        isConcurrencySafe: () => false,
        async execute(args: Record<string, unknown>, exec: { signal: AbortSignal }) {
          return definition.execute(args, exec)
        },
      } as never)

      return tools.register(dshDefinition)
    },

    registerCommand(definition: CommandDefinition) {
      const commands = getService(ctx, 'commands') as
        | { register: (def: unknown) => () => void }
        | undefined
      if (!commands || typeof commands.register !== 'function') {
        throw new Error('宿主不具备 commands 能力，无法注册命令')
      }

      return commands.register({
        name: definition.name,
        description: definition.description,
        ...(definition.inputHint === undefined ? {} : { input: { hint: definition.inputHint } }),
        ...(definition.recordInput === undefined ? {} : { recordInput: definition.recordInput }),
        handler: async (invocation: { rawInput: string; signal: AbortSignal }): Promise<CommandResultLike> => {
          try {
            const result = await definition.execute(invocation.rawInput, invocation.signal)
            return result
          } catch (error) {
            return {
              kind: 'error',
              text: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            }
          }
        },
      })
    },

    log,

    env: {
      dshVersion,
      platform: options.env?.platform ?? process.platform,
      nodeVersion: options.env?.nodeVersion ?? process.version,
    },
  }
}

function stringifyToolValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 标准 JSON Schema → DSH 的 `ParameterSchemaSpec`（属性表形态）。
 *
 * 转换规则对照 `@deepseek-ai/dsh-tools` 的 ValueSchemaSpec：
 *   - `string/number/integer/boolean/null/array/object` 原样映射，其余落 `json`；
 *   - 标量节点的 `enum` 按 DSH **支持的类型集合**保留（见 `toValueSpec` 头注）。
 *
 * ## 根级 `additionalProperties` 是**显式丢弃**（不是漏写）
 *
 * DSH 的 author 侧参数表 `ParameterSchemaSpec` 是一个
 * 「**隐式开放的对象根**」：它本身就是一张属性表，没有 openness 字段
 * （发行体 `@deepseek-ai/dsh-tools/lib/types/schema.d.ts:77-84`）；
 * 编译产物 `parameterSchemaSpecToJsonSchema` 也固定只产出
 * `{ type: 'object', properties[, required] }`
 * （同包 `lib/types/schema.js:238-247`）。
 *
 * 所以根级 `additionalProperties: false` **在 author 侧不可表达**，无法映射。
 * 为什么不能顺手拷进属性表：那会变成一条**名为 `additionalProperties` 的参数**
 * （真实参数）而不是约束，比丢弃更糟——本函数因此选择丢弃并在此写明理由。
 * 嵌套 object 的 openness 是 `ObjectValueSchemaSpec` 的**必填**字段，必须保留
 * （见 `toValueSpec` 的 `'object'` 分支）。
 *
 * 副作用提醒：本仓 `src/tools.ts` 的 `NO_ARGS` 等在根级写了
 * `additionalProperties: false`，转换后根**仍是开放的**——这是 DSH 的既有语义，
 * 不是本函数能修的（见 `tests/contracts/dsh-tools.contract.mjs` 的用例）。
 */
export function jsonSchemaToParameters(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== 'object') return {}
  const properties = schema['properties']
  if (!properties || typeof properties !== 'object') return {}

  // 刻意不读 schema['additionalProperties']：根级 openness 在 author 侧不可表达（见头注）。
  const required = new Set(
    Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
  )

  const spec: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    const value = toValueSpec(raw) as Record<string, unknown>
    spec[key] = required.has(key) ? { ...value, required: true } : value
  }
  return spec
}

/**
 * 单个属性节点 → DSH 的 `ValueSchemaSpec`。
 *
 * ## enum / const 的保真范围（按 DSH 的支持集合，不是按印象）
 *
 * DSH 只在**标量节点**上接受 `enum` 与 `const`：`string` / `number` / `integer` / `boolean` / `null`
 *   · 各自 spec 上的 `enum?` / `const?` 字段：发行体 `lib/types/schema.d.ts:20-48`
 *   · 允许表：`lib/types/json-schema.js:251-263` 的 `allowedFor`
 *   · 强制校验：`lib/types/json-schema.js:295-313`
 *     - `enum` 必须非空且每个值类型正确；
 *     - `const` 的值类型必须与声明类型一致；
 *     - 同时声明两者时 `const` 必须取 `enum` 里的某一个值。
 *   · 非法时 `defineTool` 直接抛 `JsonSchemaError`
 * `array` / `object` / `json` / 未知类型都**不接受** enum / const（带上会被 DSH 拒）。
 *
 * 回归记录：原实现只在 `type: 'string'` 时保留 enum，number/integer/boolean/null
 * 的 enum 被**静默丢弃**；`const` 则被**全类型**静默丢弃。两者都会让约束无声消失
 * （校验变松）。现在按上面的支持集合保留。
 *
 * ## 取舍：非法 schema 会**更早炸**（这是刻意的）
 *
 * 忠实翻译意味着**不替调用方 sanitize**：类型不匹配的 enum/const 原样进入 spec，
 * 由 `defineTool` 在**注册期**抛 `JsonSchemaError`——而不是被我们悄悄丢掉。
 * 代价是"升级前能激活、升级后激活失败"，所以恢复路径必须写清楚（作者该改什么）：
 *   ① 让 enum/const 的值与声明的 `type` 一致（`integer` 只能整数、`boolean` 只能
 *      true/false、`null` 只能 null）；
 *   ② 同时声明 enum + const 时，`const` 必须取 enum 中的一个值；
 *   ③ `enum` 必须是非空数组；
 *   ④ 约束若落在 array/object 上，请把它移到 `items` / `properties.<key>` 的标量节点上。
 *
 * 已知未映射：无（enum 与 const 均已按支持集合处理）。
 */
function toValueSpec(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null) return { type: 'json' }
  const node = raw as Record<string, unknown>
  const annotations: Record<string, unknown> = {}
  if (typeof node['description'] === 'string') annotations['description'] = node['description']
  const enumValues = Array.isArray(node['enum']) ? (node['enum'] as unknown[]) : undefined
  // 用 `Object.hasOwn` 判存在，**不能用真值/!== undefined**：`const: false` 与
  // `const: null` 都是合法取值（boolean / null 类型），真值判断会把它们静默丢掉——
  // 那正是本函数要消灭的"无声放松"。
  const hasConst = Object.hasOwn(node, 'const')

  /** 标量节点：保留 annotations，并按支持集合带上 enum / const。 */
  const scalarSpec = (type: string): Record<string, unknown> => ({
    type,
    ...annotations,
    ...(enumValues ? { enum: enumValues } : {}),
    ...(hasConst ? { const: node['const'] } : {}),
  })

  const type = node['type']
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return scalarSpec(type)
    case 'array': {
      const spec: Record<string, unknown> = { type: 'array', ...annotations }
      if (node['items'] !== undefined) spec['items'] = toValueSpec(node['items'])
      return spec
    }
    case 'object': {
      return {
        type: 'object',
        properties: jsonSchemaToParameters(node),
        additionalProperties: node['additionalProperties'] === false ? false : true,
        ...annotations,
      }
    }
    default:
      return { type: 'json', ...annotations }
  }
}
