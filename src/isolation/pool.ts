/**
 * 并发分组（第 5.5 节：并发隔离）。
 *
 * ## 语义（三条，缺一条报告就无法复盘）
 *
 *   ① 只有显式声明 `parallel: safe` 的场景才允许并发；
 *      缺省（没写）与 `exclusive` **一律串行**——不认识的东西不并发。
 *   ② `limit <= 1` 时全串行（等于关掉并发，也是配置默认值）。
 *   ③ 连续多个 `safe` 组成一个并发组，但**组内并发度不超过 `limit`**，
 *      所以一个连续 safe 段可能被切成若干组。
 *
 * ## 保序（报告可复盘的前提）
 *
 * 返回的组按执行顺序排列，且把每个组的 `items` 依次拼接后，
 * **恰好等于输入数组**（同顺序、同元素）。也就是说：
 *   · 组内场景的相对顺序确定（数组顺序，不是 Set 顺序）；
 *   · 串行组与并发组的先后确定（就是输入里的先后）。
 *
 * 不保序的话，"并发跑出来的结果"与"串行跑出来的结果"之间
 * 就多了一个自由变量，报告里的差异将无法归因。
 */

import type { Scenario } from '../cases/types.js'

export interface ScenarioGroup {
  kind: 'parallel' | 'serial'
  /** 并发组的元素个数在 1..limit 之间；串行组恒为 1 个元素。 */
  items: Scenario[]
}

export interface GroupOptions {
  /** 并发度上限；`<= 1` 或非法值一律按串行处理。 */
  limit: number
}

/** 场景是否显式声明了可并发（缺省 = 独占）。 */
export function isSafeScenario(scenario: Scenario): boolean {
  return scenario.parallel === 'safe'
}

/**
 * 把场景序列切成可执行的执行计划（串行单元 + 并发单元）。
 *
 * 返回值不是"任务队列"而是"**执行计划**"：调用方按顺序遍历，
 * 遇到 `parallel` 组就把组内所有场景同时跑起来（并发度 = `items.length`），
 * 遇到 `serial` 组就单独跑那一条。
 */
export function groupScenarios(
  scenarios: readonly Scenario[],
  options: GroupOptions,
): ScenarioGroup[] {
  const limit = normalizeLimit(options?.limit)
  const groups: ScenarioGroup[] = []
  let pending: Scenario[] = []

  const flush = (): void => {
    if (pending.length === 0) return
    groups.push({ kind: 'parallel', items: pending })
    pending = []
  }

  for (const scenario of scenarios) {
    // limit <= 1 时连缓冲都不用：safe 也走串行分支（关掉并发）
    if (limit > 1 && isSafeScenario(scenario)) {
      pending.push(scenario)
      if (pending.length >= limit) flush()
      continue
    }
    // 独占场景必须先把前面的并发段收口，独占才有意义
    flush()
    groups.push({ kind: 'serial', items: [scenario] })
  }

  flush()
  return groups
}

/** 非法 / 越界 limit 一律退化成串行（1），绝不"猜一个大一点的并发度"。 */
function normalizeLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return 1
  const floored = Math.floor(limit)
  return floored >= 1 ? floored : 1
}
