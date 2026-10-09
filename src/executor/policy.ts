/**
 * 成本闸门：把「这次运行允不允许花钱」变成**可声明、可判定、可复现**的判定。
 *
 * ## 为什么需要它（要解决的具体问题）
 *
 * 本仓的场景里混着三类东西：纯离线的（tool / llm 接管 / file）、有本地副作用的
 * （shell 起进程、fs 写文件）、以及**会真实调模型**的（agent 派生、compaction 压缩）。
 * 在引入闸门之前，"跑全部 active 场景" 会把真实模型调用塞进 CI 与日常回归——
 * 成本不可控，且没人能事先声明"这一跑最多花多少"。
 *
 * ## 三档成本
 *
 *   · `none` —— 纯离线：不调模型、不起外部进程、不写文件
 *   · `low`  —— 本地副作用：起进程 / 写文件，但**没有模型成本**
 *   · `high` —— **真实模型调用**（默认拒绝，必须显式放权）
 *
 * 判定规则（见 `evaluateScenario`）：
 *   · `none`  → 永远放行（任何配置下）
 *   · `low`   → 需要 `cost.allowLowCost`
 *   · `high`  → 需要 `cost.allowModel`
 *   · 场景显式 `cost` 优先于 driver 默认档位（`source` 如实记为 `scenario` / `driver`）
 *
 * ## 本模块刻意不做的事
 *
 * 它**只做判定与记账**，不执行任何动作、不碰 DSH。runner 拿判定结果决定
 * "跑 / 跳过"，driver 通过 `DriverContext.usage` 上报用量。
 */

import { isAbsolute, resolve as resolvePath, sep } from 'node:path'

import type { BudgetSpec, CostClass, StepAction } from '../cases/types.js'
import type { PolicyDecision, PolicySnapshot, UsageRecord } from '../runtime/runlog.js'

/* ------------------------------------------------------------ 策略形状 -- */

/**
 * 沙箱策略：把"默认只读"做成**显式开关**，而不是默认行为。
 *
 * 本次改动的取舍（必须写清楚，否则下一位读者会以为漏做了）：
 * 本仓现有场景里有若干 shell / fs 类会写目录，若把 shell/file 默认收成只读，
 * 既有基线会**平白出现 skipped**（那不是被测对象的问题，是我们自己改了默认值）。
 * 所以本次只把**模型成本**做成默认拒绝（`allowModel: false`），
 * 沙箱收紧留作显式开关：配置项（`Config.sandbox*`）或工具参数（`allowFileWrite`）。
 */
export interface SandboxPolicy {
  allowShell: boolean
  allowFileWrite: boolean
  /** 非空时：只允许这些命令名（白名单）。空 = 不限制。 */
  allowedCommands: string[]
  /** 非空时：只允许访问这些路径根（对**绝对路径**生效，见 `checkSandboxAction`）。空 = 不限制。 */
  allowedPaths: string[]
  /** 单次动作超时（预留；当前 runner 的超时仍以 `runtime.timeoutMs` 为准）。 */
  timeoutMs: number
  /** 非空时：命中这些命令名的 shell 动作被拒（"默认只读"的实现手段之一）。 */
  denyWriteCommands: string[]
}

/** 一次运行的完整策略：成本闸门 + 沙箱 + 审批。 */
export interface ExecutionPolicy {
  cost: {
    /** 是否允许 `high` 档位（真实模型调用）。 */
    allowModel: boolean
    /** 是否允许 `low` 档位（起进程 / 写文件）。 */
    allowLowCost: boolean
    /** 模型调用次数上限；`0` = 不限。 */
    maxModelCalls: number
    /** token 上限；`0` = 不限。只有 driver 主动上报 token 时才真正强制。 */
    maxTokens: number
    /** 是否优先走录制回放（预留位：当前 runner 不消费，只进配置与快照）。 */
    recordReplay: boolean
  }
  sandbox: SandboxPolicy
  /** 审批面（预留位：是否/由谁批准放权，当前由命令面的人工开关承担）。 */
  approval: { requireHumanApproval: boolean; approvers: string[] }
}

/** `resolvePolicy` 的可选覆盖：给出哪一项就覆盖哪一项，其余取默认。 */
export interface PolicyOptions {
  cost?: Partial<ExecutionPolicy['cost']>
  sandbox?: Partial<SandboxPolicy>
  approval?: Partial<ExecutionPolicy['approval']>
}

/**
 * 默认策略。
 *
 * ## 默认值取舍（有据的取舍，不是遗漏）
 *
 *   · `allowModel: false` —— **默认不允许真实模型调用**。这是 P0「成本不可控」
 *     的落点：文档要求"默认不真调模型"，CI 与日常回归绝不能悄悄花钱。
 *   · `allowLowCost: true` —— 本地副作用默认放行。本仓约 26 条既有场景里有
 *     shell / fs 类要写目录，默认收紧会让既有基线平白多出一片 skipped，
 *     那是**自己制造的假红**，会让真正的失败淹没在噪音里。
 *   · `allowShell / allowFileWrite: true`、`denyWriteCommands: []` —— 同上：
 *     「默认只读」做成**显式开关**（配置项 / 工具参数），不改变既有默认行为。
 *
 * 结论：本次只把**花钱**默认关掉；"只读模式"要收紧时显式打开，并在报告里
 * 以 `skipped + reason` 说明为什么没跑。
 */
export const DEFAULT_POLICY: ExecutionPolicy = {
  cost: {
    allowModel: false,
    allowLowCost: true,
    maxModelCalls: 0,
    maxTokens: 0,
    recordReplay: true,
  },
  sandbox: {
    allowShell: true,
    allowFileWrite: true,
    allowedCommands: [],
    allowedPaths: [],
    timeoutMs: 30_000,
    denyWriteCommands: [],
  },
  approval: { requireHumanApproval: false, approvers: [] },
}

/**
 * 合并覆盖项得到一份**全新的**策略对象（每次都拷贝数组，避免调用方共享可变态）。
 *
 * 数值用 `??` 而不是 `||`：`0` 是合法值（= 不限），不能被当成"没给"。
 */
export function resolvePolicy(options: PolicyOptions = {}): ExecutionPolicy {
  const cost = options.cost ?? {}
  const sandbox = options.sandbox ?? {}
  const approval = options.approval ?? {}

  return {
    cost: {
      allowModel: cost.allowModel ?? DEFAULT_POLICY.cost.allowModel,
      allowLowCost: cost.allowLowCost ?? DEFAULT_POLICY.cost.allowLowCost,
      maxModelCalls: cost.maxModelCalls ?? DEFAULT_POLICY.cost.maxModelCalls,
      maxTokens: cost.maxTokens ?? DEFAULT_POLICY.cost.maxTokens,
      recordReplay: cost.recordReplay ?? DEFAULT_POLICY.cost.recordReplay,
    },
    sandbox: {
      allowShell: sandbox.allowShell ?? DEFAULT_POLICY.sandbox.allowShell,
      allowFileWrite: sandbox.allowFileWrite ?? DEFAULT_POLICY.sandbox.allowFileWrite,
      allowedCommands: [...(sandbox.allowedCommands ?? DEFAULT_POLICY.sandbox.allowedCommands)],
      allowedPaths: [...(sandbox.allowedPaths ?? DEFAULT_POLICY.sandbox.allowedPaths)],
      timeoutMs: sandbox.timeoutMs ?? DEFAULT_POLICY.sandbox.timeoutMs,
      denyWriteCommands: [
        ...(sandbox.denyWriteCommands ?? DEFAULT_POLICY.sandbox.denyWriteCommands),
      ],
    },
    approval: {
      requireHumanApproval:
        approval.requireHumanApproval ?? DEFAULT_POLICY.approval.requireHumanApproval,
      approvers: [...(approval.approvers ?? DEFAULT_POLICY.approval.approvers)],
    },
  }
}

/**
 * 生成进报告的闸门快照。
 *
 * 为什么要快照而不是直接引用策略对象：报告要回答的是"**当时**为什么这么判"，
 * 而策略对象在运行期可能被后续代码改动；引用会让历史报告被污染。
 */
export function policySnapshot(policy: ExecutionPolicy): PolicySnapshot {
  return {
    allowModel: policy.cost.allowModel,
    allowLowCost: policy.cost.allowLowCost,
    sandbox: {
      ...policy.sandbox,
      allowedCommands: [...policy.sandbox.allowedCommands],
      allowedPaths: [...policy.sandbox.allowedPaths],
      denyWriteCommands: [...policy.sandbox.denyWriteCommands],
    },
  }
}

/* ------------------------------------------------------------ 判定 -- */

const COST_LABEL: Record<CostClass, string> = {
  none: 'none（纯离线）',
  low: 'low（本地副作用）',
  high: 'high（真实模型调用）',
}

/** 档位的严格程度，用于取"参与 driver 里最高的那一档"。 */
const COST_RANK: Record<CostClass, number> = { none: 0, low: 1, high: 2 }

/** 取两档里更贵的一档。 */
export function maxCost(a: CostClass, b: CostClass): CostClass {
  return COST_RANK[a] >= COST_RANK[b] ? a : b
}

/**
 * 收紧上限：`0` = 不限，其余取更小的一边。
 *
 * 语义要点：**场景自带的 `budget` 只能比策略更紧，不能放宽**——
 * 否则场景数据自己就能绕开本次运行的预算上限。工具参数同理（见 `src/tools.ts`）。
 */
export function tightenLimit(upper: number, requested: number): number {
  if (upper <= 0) return requested
  if (requested <= 0) return upper
  return Math.min(upper, requested)
}

/**
 * 判定一条场景在给定策略下能不能跑。
 *
 * @param input.scenarioCost - 场景显式声明的档位；未声明传 undefined
 * @param input.driverCost - 参与 driver 的最高档位（由 runner 算好传入）
 * @param input.budget - 场景自带的预算上限；只能收紧策略上限
 * @returns `decision`（含人类可读的 reason，进报告与 skipReason）
 *          与 `limits`（本次实际生效的上限，`0` = 不限）
 *
 * `source` 的取值：`scenario`（场景显式声明）／`driver`（driver 默认档位）。
 * `default` 由 runner 在"参与 driver 没有声明 `cost()`、按保守默认档处理"时补记，
 * 因此这个纯函数本身不会返回值 `default`。
 */
export function evaluateScenario(input: {
  scenarioCost?: CostClass
  driverCost: CostClass
  budget?: BudgetSpec
  policy: ExecutionPolicy
}): { decision: PolicyDecision; limits: { maxModelCalls: number; maxTokens: number } } {
  const { scenarioCost, driverCost, budget, policy } = input

  const cost: CostClass = scenarioCost ?? driverCost
  const source: PolicyDecision['source'] = scenarioCost === undefined ? 'driver' : 'scenario'
  const from = source === 'scenario' ? '场景显式声明' : 'driver 默认档位'
  const label = COST_LABEL[cost]

  const limits = {
    maxModelCalls: tightenLimit(policy.cost.maxModelCalls, budget?.maxModelCalls ?? 0),
    maxTokens: tightenLimit(policy.cost.maxTokens, budget?.maxTokens ?? 0),
  }

  if (cost === 'none') {
    return {
      decision: {
        allowed: true,
        reason: `成本闸门放行：档位 ${label}（${from}）——纯离线，任何配置下都允许`,
        cost,
        source,
      },
      limits,
    }
  }

  if (cost === 'low') {
    if (policy.cost.allowLowCost) {
      return {
        decision: {
          allowed: true,
          reason: `成本闸门放行：档位 ${label}（${from}）——本地副作用已允许（cost.allowLowCost=true）`,
          cost,
          source,
        },
        limits,
      }
    }
    return {
      decision: {
        allowed: false,
        reason:
          `成本闸门拒绝：档位 ${label}（${from}）需要本地副作用权限，但 cost.allowLowCost=false；` +
          `显式开启 /testkit run --allow-low-cost（或工具参数 allowLowCost）后才跑`,
        cost,
        source,
      },
      limits,
    }
  }

  // cost === 'high'
  if (policy.cost.allowModel) {
    return {
      decision: {
        allowed: true,
        reason: `成本闸门放行：档位 ${label}（${from}）——真实模型调用已显式允许（cost.allowModel=true）`,
        cost,
        source,
      },
      limits,
    }
  }

  return {
    decision: {
      allowed: false,
      reason:
        `成本闸门拒绝：档位 ${label}（${from}）需要真实模型调用权限，但 cost.allowModel=false（默认）；` +
        `显式开启 /testkit run --allow-model（或工具参数 allowModel）后才跑——这不是失败，是没跑`,
      cost,
      source,
    },
    limits,
  }
}

/* ------------------------------------------------------------ 用量与预算 -- */

/**
 * 模型用量记账。
 *
 * 精确度声明（**这是验收的一部分**）：
 *   · 语义是**下界**：`真实调用次数 ≥ 记账值`。所以 `maxModelCalls` 是**保守闸门**——
 *     它不会漏掉狂奔的用量（超了必拦），但也不能当作账单；
 *   · **token 不猜**：driver 不主动上报就记 0，`maxTokens` 因此只在有上报时才真正强制
 *     （宁可如实说"没上报"，也不编一个看起来精确的数字）；
 *   · driver 通过 `DriverContext.usage` 拿到它，**每个 act 记一次**，不要每 step 记一次。
 */
export class UsageMeter {
  modelCalls = 0
  tokens = 0

  /** 记一次（或 n 次）真实模型调用；非法值忽略（不静默污染账本）。 */
  recordModelCall(n = 1): void {
    if (!Number.isFinite(n) || n <= 0) return
    this.modelCalls += n
  }

  /** 记 token 用量；driver 拿不到 token 数时**不要调用**（调用即声明"我知道数量"）。 */
  recordTokens(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return
    this.tokens += n
  }

  /** 取一份快照（进 `CaseOutcome.usage`）。 */
  snapshot(): UsageRecord {
    return { modelCalls: this.modelCalls, tokens: this.tokens }
  }
}

/** 预算超限。`message` 以固定前缀「预算超限：」开头，便于报告与归因识别。 */
export class BudgetExceeded extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BudgetExceeded'
  }
}

/**
 * 检查用量是否越过上限；越限抛 `BudgetExceeded`。
 *
 * `0` = 不限。消息写清"上限 N，已用 M"——它会**原样进报告**，
 * 所以要能独立读懂，不能只说一句"超预算了"。
 */
export function checkBudget(
  usage: UsageRecord,
  limits: { maxModelCalls: number; maxTokens: number },
): void {
  if (limits.maxModelCalls > 0 && usage.modelCalls > limits.maxModelCalls) {
    throw new BudgetExceeded(
      `预算超限：模型调用次数上限 ${limits.maxModelCalls} 次，已用 ${usage.modelCalls} 次`,
    )
  }
  if (limits.maxTokens > 0 && usage.tokens > limits.maxTokens) {
    throw new BudgetExceeded(`预算超限：token 上限 ${limits.maxTokens}，已用 ${usage.tokens}`)
  }
}

/* ------------------------------------------------------------ 沙箱判定 -- */

/**
 * 判断单个动作是否被沙箱策略拒绝（纯函数，便于单测）。
 *
 * 规则（自上而下）：
 *   · `shell`：`allowShell=false` → 拒；命令名命中 `denyWriteCommands` → 拒；
 *     `allowedCommands` 非空且不在白名单 → 拒；`cwd` 是绝对路径且不在 `allowedPaths` 下 → 拒
 *   · `fs`：`write` / `edit` 且 `allowFileWrite=false` → 拒；绝对 `path` 不在 `allowedPaths` 下 → 拒
 *   · `file`：绝对 `read` 路径不在 `allowedPaths` 下 → 拒（纯离线读，同样受路径白名单约束）
 *   · 其余动作：不限制
 *
 * 路径白名单只对**绝对路径**生效：相对路径的根由宿主的 workspace 决定，
 * 闸门不替宿主猜（猜错会拒掉合法的相对访问）。相对路径的边界交给宿主自己的沙箱
 * （例如 `fs` 动作里的 `sandbox.mode`）。
 *
 * @returns 拒绝原因；允许时返回 undefined
 */
export function checkSandboxAction(action: StepAction, sandbox: SandboxPolicy): string | undefined {
  if ('shell' in action) {
    if (!sandbox.allowShell) {
      return '沙箱策略拒绝：本次运行不允许 shell 动作（sandbox.allowShell=false）'
    }
    const raw = action.shell.argv[0] ?? ''
    const name = commandName(raw)
    if (name === '') {
      return '沙箱策略拒绝：shell 动作没有给出可识别的命令名（argv[0] 为空）'
    }
    const denied = sandbox.denyWriteCommands.map((c) => commandName(c))
    if (denied.includes(name)) {
      return `沙箱策略拒绝：命令 ${name} 命中 denyWriteCommands（默认只读模式的拒绝清单）`
    }
    const allowed = sandbox.allowedCommands.map((c) => commandName(c)).filter((c) => c !== '')
    if (allowed.length > 0 && !allowed.includes(name)) {
      return `沙箱策略拒绝：命令 ${name} 不在 allowedCommands 白名单里（${allowed.join(', ')}）`
    }
    const cwd = action.shell.cwd
    if (cwd !== undefined && isAbsolute(cwd) && !isUnderAny(cwd, sandbox.allowedPaths)) {
      return `沙箱策略拒绝：shell 的 cwd=${cwd} 不在 allowedPaths 允许的路径根下`
    }
    return undefined
  }

  if ('fs' in action) {
    const spec = action.fs
    const kind = Object.keys(spec as object)[0] ?? 'unknown'
    if ((kind === 'write' || kind === 'edit') && !sandbox.allowFileWrite) {
      return `沙箱策略拒绝：fs.${kind} 需要写文件权限，但 sandbox.allowFileWrite=false`
    }
    const path = readPathOf(spec)
    if (path !== undefined && isAbsolute(path) && !isUnderAny(path, sandbox.allowedPaths)) {
      return `沙箱策略拒绝：路径 ${path} 不在 allowedPaths 允许的路径根下`
    }
    return undefined
  }

  if ('file' in action) {
    const spec = action.file
    const path = 'read' in spec && typeof spec.read === 'string' ? spec.read : undefined
    if (path !== undefined && isAbsolute(path) && !isUnderAny(path, sandbox.allowedPaths)) {
      return `沙箱策略拒绝：读取 ${path} 不在 allowedPaths 允许的路径根下`
    }
    return undefined
  }

  return undefined
}

/** 从 fs 动作里取出声明的路径（各分支的字段名统一叫 `path`）。 */
function readPathOf(spec: unknown): string | undefined {
  const path = (spec as { path?: unknown }).path
  return typeof path === 'string' && path !== '' ? path : undefined
}

/**
 * 把命令名归一化：取 basename、去掉 Windows 可执行后缀、转小写。
 *
 * `C:\Windows\System32\rm.exe` / `/usr/bin/rm` / `rm` 都归一成 `rm`，
 * 否则拒绝清单会被路径写法绕过。
 */
export function commandName(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return ''
  const base = trimmed.split(/[\\/]/).pop() ?? trimmed
  return base.replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase()
}

/** `paths` 为空 = 不限制；否则 `path` 必须落在其中某个根之下。 */
function isUnderAny(path: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return true
  return paths.some((root) => isUnder(path, root))
}

/** 路径归属判断：Windows 上大小写不敏感，比较前统一归一。 */
function isUnder(path: string, root: string): boolean {
  const target = normalizeKey(resolvePath(path))
  const base = normalizeKey(resolvePath(root))
  if (target === base) return true
  const prefix = base.endsWith(sep) ? base : `${base}${sep}`
  return target.startsWith(prefix)
}

function normalizeKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}
