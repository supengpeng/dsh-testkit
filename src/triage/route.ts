/**
 * 按 owner 路由（文档 §7.5）。
 *
 * 这是覆盖矩阵 `no-owner` 缺口在**运行侧**的闭环：矩阵告诉你"哪条场景没有 owner"，
 * 这里告诉你"这次失败里哪些没人认领"——没有 owner 的失败只能靠人肉认领，
 * 所以它们单独成组、排在最前，并带上"该补 owner"的可行动提示。
 *
 * 分组规则：
 *   · `@alice`、`alice`、`Alice` 是**同一个人**（去 `@` + 忽略大小写），
 *     与 `src/insight/search.ts` 的 owner 比较语义一致；
 *   · 组名用**首次出现**的拼写（保留作者本来的大小写）；
 *   · `(未指派)` 组永远排第一（它需要动作），其余按组名字母序——顺序稳定，
 *     报告与评论才能 diff；
 *   · 组内保持输入的 case 顺序。
 *
 * 纯函数：不改任何入参，也不筛 verdict（要只路由失败，调用方先 `failingCases`）。
 */

import type { CaseOutcome } from '../runtime/runlog.js'
import { NO_OWNER, NO_OWNER_REASON, ownerOf } from './artifacts.js'

export interface OwnerRoute {
  /** owner 名（无 `@`），或 `(未指派)`。 */
  owner: string
  cases: CaseOutcome[]
  /** 只在 `(未指派)` 组出现：为什么这一组需要人补 owner。 */
  reason?: string
}

/** `(未指派)` 的内部键：用不可能与真实 owner 撞车的哨兵值。 */
const UNASSIGNED_KEY = '\u0000unassigned'

export function routeByOwner(cases: readonly CaseOutcome[]): OwnerRoute[] {
  const groups = new Map<string, { owner: string; cases: CaseOutcome[] }>()

  for (const outcome of cases) {
    const owner = ownerOf(outcome)
    const key = owner === undefined ? UNASSIGNED_KEY : owner.toLowerCase()
    const existing = groups.get(key)
    if (existing !== undefined) {
      existing.cases.push(outcome)
      continue
    }
    groups.set(key, { owner: owner ?? NO_OWNER, cases: [outcome] })
  }

  const routes: OwnerRoute[] = []
  const unassigned = groups.get(UNASSIGNED_KEY)
  if (unassigned !== undefined) {
    routes.push({ owner: unassigned.owner, cases: unassigned.cases, reason: NO_OWNER_REASON })
  }

  const assigned = [...groups.entries()]
    .filter(([key]) => key !== UNASSIGNED_KEY)
    .sort(([a], [b]) => compareText(a, b))
  for (const [, group] of assigned) {
    routes.push({ owner: group.owner, cases: group.cases })
  }

  return routes
}

/** 不受运行环境 locale 影响，输出可复现。 */
function compareText(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}
