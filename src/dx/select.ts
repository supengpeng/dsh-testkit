/**
 * 本地 DX：**场景筛选**与 **smoke 集**。
 *
 * ## 为什么需要它
 *
 * 本地开发要回答的问题不是"全量跑得怎么样"，而是：
 *   · 我只想跑跟这块改动有关的几条（`only` / `kinds` / `tags` / `owner` / `cost`）；
 *   · 我只有 3 分钟，先跑哪些最有代表性（smoke 集）；
 *   · **为什么一条都没跑**（`reason` 必须能自证，否则本地会陷入"改了没反应"的怀疑）。
 *
 * ## 与既有模块的分工（别重复造）
 *
 * · `src/cases/registry.ts` 的 `CaseFilter` 是**给 runner 用的选择器**（ids/kinds/tags/status/issue）；
 *   本模块是**给人用的筛选面**：多了 owner / cost / smoke，并且**必须给出可读依据**。
 * · `src/selection/` 的增量选择回答"改了哪些文件该跑哪些场景"；本模块回答
 *   "我现在只想跑这一类"。两者可以叠加（先增量，再筛品类）。
 *
 * ## 静态估算的纪律（重要）
 *
 * smoke 集的耗时是**静态估算**，不是实测：`KIND_ESTIMATE_MS` 是按 kind 的量级表，
 * `COST_EXTRA_MS` 是本地副作用与模型调用的量级附加值。它**只用来排序与裁预算**，
 * 不能当性能结论用。要精确的"全量 vs 增量"耗时，请用 `src/selection/bench.ts`
 * 的实测基准。所有对外文本里都必须出现"静态估算"字样——免得读者把它当成实测。
 */

import type { CostClass, Scenario, ScenarioKind } from '../cases/types.js'
import { maxCost } from '../executor/policy.js'
import { DRIVER_COST } from '../kinds/index.js'
import { scenarioKinds } from '../selection/mapping.js'

/* ------------------------------------------------------------ 静态估算表 -- */

/**
 * 成本档的排序权重（none < low < high）。
 *
 * 与 `src/executor/policy.ts` 的档位语义一致；那里只导出判定函数、不导出序关系，
 * 而本模块需要**排序**（smoke 集挑便宜的），所以在这里显式写一张序表。
 */
export const COST_ORDER: Readonly<Record<CostClass, number>> = { none: 0, low: 1, high: 2 }

/**
 * **静态** per-kind 耗时量级（毫秒）。
 *
 * 来源：本机历史运行的量级（headless 与活宿主混测），取整到便于阅读的档位。
 * 它**不是实测保证**：机器、宿主能力、场景步数都会改变真实耗时。
 * 用途仅限"排序"与"裁 smoke 预算"；要精确数字请跑 `benchmarkSelection`。
 */
export const KIND_ESTIMATE_MS: Readonly<Record<ScenarioKind, number>> = {
  ui: 20,
  file: 30,
  interaction: 30,
  prompt: 40,
  llm: 40,
  tool: 60,
  resource: 80,
  fs: 80,
  session: 120,
  shell: 300,
  compaction: 400,
  agent: 3_000,
}

/** 成本档带来的额外量级：本地副作用要起进程/写盘，真实模型调用要等上游。 */
export const COST_EXTRA_MS: Readonly<Record<CostClass, number>> = { none: 0, low: 60, high: 1_500 }

/** 认不出 kind（数据异常）时的兜底量级：宁可估贵，也不要让 smoke 集悄悄超预算。 */
export const FALLBACK_KIND_MS = 150

/** smoke 标签名（场景数据里的约定值）。 */
export const SMOKE_TAG = 'smoke'

/** smoke 集的默认时间预算。 */
export const DEFAULT_SMOKE_BUDGET_MS = 5_000

/**
 * 一条场景的**静态估算**耗时（毫秒）。
 *
 * 口径：取"参与 kind 里最贵的那一档"的基准量级，再叠加成本档的额外量级。
 * 为什么取最贵而不是求和：静态估算不该假装精确到步；取最贵是保守方向
 * （宁可把预算估紧，也不要让它悄悄超）。
 */
export function estimateCaseMs(scenario: Scenario): number {
  const kinds = scenarioKinds(scenario)
  let base = 0
  for (const kind of kinds) {
    base = Math.max(base, KIND_ESTIMATE_MS[kind as ScenarioKind] ?? FALLBACK_KIND_MS)
  }
  if (kinds.length === 0) base = FALLBACK_KIND_MS
  return Math.round(base + COST_EXTRA_MS[effectiveCost(scenario)])
}

/**
 * 一条场景**实际**会被闸门按哪个成本档判定。
 *
 * 场景显式声明的 `cost` 优先；否则取参与 driver 的 `DRIVER_COST` 最高档。
 * 认不出任何 kind 时按 `high` 保守处理（与 runner 的默认档一致）。
 */
export function effectiveCost(scenario: Scenario): CostClass {
  if (scenario.cost !== undefined) return scenario.cost
  const kinds = scenarioKinds(scenario)
  if (kinds.length === 0) return 'high'
  let cost: CostClass = 'none'
  for (const kind of kinds) {
    cost = maxCost(cost, DRIVER_COST[kind as ScenarioKind] ?? 'high')
  }
  return cost
}

/* ---------------------------------------------------------------- 筛选 -- */

/** `applyDxFilter` 的选项。全部是"与"关系；给了哪几项就按哪几项收窄。 */
export interface DxFilterOptions {
  /** 只跑这些 case id（精确匹配）。 */
  only?: readonly string[]
  /** 只看这些 kind（任一命中）。 */
  kinds?: readonly ScenarioKind[]
  /** 只看带这些 tag 的场景（任一命中，与 `CaseFilter.tags` 同语义）。 */
  tags?: readonly string[]
  /** 只看这位负责人的场景（精确匹配 `scenario.owner`）。 */
  owner?: string
  /**
   * 允许的**最高**成本档（含）。
   *
   * `'none'` = 只跑纯离线（不起进程、不写文件、不调模型）；`'low'` = 再放开本地副作用；
   * `'high'` = 全放（等价于不筛）。它**不是**"只看这一档"。
   */
  cost?: CostClass
  /** 只看这些状态；缺省 `['active']`（draft / retired 不该混进本地回归）。 */
  status?: readonly string[]
  /** 只取 smoke 集（规则见 `suggestSmokeSet`）。 */
  smoke?: boolean
  /** smoke 集的静态时间预算（毫秒）；只在 `smoke: true` 时有意义。 */
  smokeBudgetMs?: number
}

export interface DxFilterResult {
  /** 命中的场景（原对象，未拷贝）。 */
  matched: readonly Scenario[]
  /**
   * 与 `matched` 同序的 ID 列表（直接喂 runner 的 `filter.ids`）。
   *
   * 顺序是**输入顺序**（通常是注册表顺序），不按 smoke 估算重排——
   * 让"同样的输入产出同样的顺序"，报告与日志才好对比。
   */
  ids: string[]
  /** 人类可读的筛选依据：每一步收窄了多少条、为什么一条都没命中。 */
  reason: string
}

/**
 * 按 DX 选项筛选场景，并**说清每一步收窄了多少**。
 *
 * 返回 `reason` 是硬要求，不是装饰：本地最常见的困惑是"我加了筛选，结果跑了 0 条，
 * 不知道为什么"——报告里必须能直接读出是哪一条筛掉的。
 */
export function applyDxFilter(
  scenarios: readonly Scenario[],
  options: DxFilterOptions = {},
): DxFilterResult {
  const all = [...scenarios]
  let current = all
  const steps: Array<{ label: string; before: number; after: number }> = []

  const narrow = (label: string, keep: (scenario: Scenario) => boolean): void => {
    const before = current.length
    current = current.filter(keep)
    steps.push({ label, before, after: current.length })
  }

  const status = options.status ?? ['active']
  if (status.length > 0) {
    const wanted = new Set(status)
    const suffix = options.status === undefined ? '（默认，draft/retired 不混进本地回归）' : ''
    narrow(`status ∈ [${status.join(', ')}]${suffix}`, (s) => wanted.has(s.status ?? 'active'))
  }

  if (options.only !== undefined && options.only.length > 0) {
    const wanted = new Set(options.only)
    narrow(`id ∈ [${options.only.join(', ')}]`, (s) => wanted.has(s.id))
  }

  if (options.kinds !== undefined && options.kinds.length > 0) {
    const wanted = new Set<string>(options.kinds)
    narrow(`kind ∈ [${options.kinds.join(', ')}]`, (s) => wanted.has(s.kind))
  }

  if (options.tags !== undefined && options.tags.length > 0) {
    const wanted = options.tags
    narrow(`tag 命中 [${wanted.join(', ')}]`, (s) => {
      const own = new Set(s.tags ?? [])
      return wanted.some((tag) => own.has(tag))
    })
  }

  const owner = options.owner?.trim() ?? ''
  if (owner !== '') {
    narrow(`owner = ${owner}`, (s) => (s.owner ?? '') === owner)
  }

  if (options.cost !== undefined) {
    const limit = COST_ORDER[options.cost]
    narrow(`成本档 ≤ ${options.cost}`, (s) => COST_ORDER[effectiveCost(s)] <= limit)
  }

  let smoke: SmokeSetResult | undefined
  if (options.smoke === true) {
    smoke = suggestSmokeSet(
      current,
      options.smokeBudgetMs === undefined ? {} : { budgetMs: options.smokeBudgetMs },
    )
    const wanted = new Set(smoke.ids)
    const label = `smoke 集（静态估算 ≈ ${smoke.estimateMs}ms）`
    narrow(label, (s) => wanted.has(s.id))
  }

  const lines: string[] = [`筛选：起点 ${all.length} 条`]
  for (const item of steps) {
    const hit = item.after === item.before ? '（未变）' : ''
    lines.push(` · ${item.label}：${item.before} → ${item.after}${hit}`)
  }
  lines.push(` → 命中 ${current.length}/${all.length} 条`)

  if (smoke !== undefined) {
    // 估算口径必须跟着结果一起出现：读者要能看出这是静态量级、不是实测
    lines.push(` smoke 依据（静态估算，不是实测）：${smoke.reason}`)
  }

  if (current.length === 0) {
    lines.push(` ${zeroHitHint(all.length, steps)}`)
  }

  return { matched: current, ids: current.map((s) => s.id), reason: lines.join('\n') }
}

/** 0 命中时给出"放宽哪一条最可能救回来"。 */
function zeroHitHint(
  total: number,
  steps: ReadonlyArray<{ label: string; before: number; after: number }>,
): string {
  if (total === 0) {
    return '提示：输入的场景集合是空的——先确认 casesDir 里真的有 cases/*.yaml。'
  }
  // 从后往前找第一条"把非空清成空"的过滤：它是最严的那条
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const item = steps[i]!
    if (item.after === 0 && item.before > 0) {
      return `提示：最严的一条是「${item.label}」——它把 ${item.before} 条清成了 0，先放宽它。`
    }
  }
  return '提示：没有任何场景命中；检查选择器是否写错（id 精确匹配、tag 区分大小写）。'
}

/* ------------------------------------------------------------- smoke 集 -- */

export interface SmokeSetOptions {
  /** 时间预算（毫秒）；缺省 `DEFAULT_SMOKE_BUDGET_MS`。 */
  budgetMs?: number
}

export interface SmokeSetResult {
  ids: string[]
  /** 选中集合的**静态**估算总耗时（毫秒）。保证 `<= budgetMs`。 */
  estimateMs: number
  /** 人类可读的依据（含"静态估算"字样与预算使用情况）。 */
  reason: string
}

/**
 * 挑一组"能在预算内跑完"的 smoke 场景。
 *
 * 规则（按优先级）：
 *   1. `tags` 含 `smoke` 的场景（这是场景作者显式声明的"这一条值得进冒烟"）；
 *   2. 没有 smoke 标签时，退回**成本档 `none`** 的场景（纯离线：不起进程、不写文件、不调模型）；
 *   3. 候选按"静态估算耗时升序 → 成本档升序 → id 升序"排序，逐条累加到预算为止。
 *
 * 不变式：`estimateMs <= budgetMs`。预算连最便宜的一条都放不下时，返回**空集**并说明——
 * 与其偷偷塞一条超预算的，不如让调用方显式决定提高预算。
 */
export function suggestSmokeSet(
  scenarios: readonly Scenario[],
  options: SmokeSetOptions = {},
): SmokeSetResult {
  const budgetMs = Math.max(0, Math.floor(options.budgetMs ?? DEFAULT_SMOKE_BUDGET_MS))
  const tagged = scenarios.filter((s) => (s.tags ?? []).includes(SMOKE_TAG))
  const pool = tagged.length > 0 ? tagged : scenarios.filter((s) => effectiveCost(s) === 'none')
  const basis =
    tagged.length > 0
      ? `优先取 tags 含 ${SMOKE_TAG} 的 ${tagged.length} 条`
      : `没有 tags 含 ${SMOKE_TAG} 的场景，退回成本档 none 的 ${pool.length} 条`

  if (pool.length === 0) {
    return {
      ids: [],
      estimateMs: 0,
      reason: `${basis}；可纳入 smoke 集的场景为空（静态估算，不是实测）。`,
    }
  }

  const ordered = [...pool].sort((a, b) => {
    const byEstimate = estimateCaseMs(a) - estimateCaseMs(b)
    if (byEstimate !== 0) return byEstimate
    const byCost = COST_ORDER[effectiveCost(a)] - COST_ORDER[effectiveCost(b)]
    if (byCost !== 0) return byCost
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })

  const ids: string[] = []
  let estimateMs = 0
  let next: Scenario | undefined
  for (const scenario of ordered) {
    const ms = estimateCaseMs(scenario)
    if (estimateMs + ms > budgetMs) {
      next = scenario
      break
    }
    ids.push(scenario.id)
    estimateMs += ms
  }

  const head =
    `静态估算（不是实测）：${basis}，按「per-kind 量级表 + 成本档附加值」逐条累加；` +
    `预算 ${budgetMs}ms，选中 ${ids.length} 条 ≈ ${estimateMs}ms`
  const tail =
    ids.length === 0
      ? `；最便宜的一条 ${next?.id ?? '（无）'} 单条就 ≈ ${
          next === undefined ? 0 : estimateCaseMs(next)
        }ms，已超预算——提高预算，或这条本就不该进 smoke 集`
      : next === undefined
        ? '；候选全部在预算内'
        : `；未纳入 ${pool.length - ids.length} 条（下一条 ${next.id} ≈ ${estimateCaseMs(
            next,
          )}ms，加上会超预算）`

  return { ids, estimateMs, reason: `${head}${tail}` }
}
