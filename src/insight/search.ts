/**
 * 场景搜索 —— 在场景集里按文本 + 结构化条件找东西。
 *
 * ## 两个设计点
 *
 * ① **命中理由必须回显**：搜索的价值不只是"找到 3 条"，而是"为什么是这 3 条"。
 *    每条命中都带 `reasons`（命中了哪些字段、命中什么），否则用户只能一条条点开对照。
 * ② **0 条必须解释**：空结果有两种完全不同的原因——"某个条件本身就没东西"
 *    与"各条件单独都有命中，但交集为空"。只回一个"0 条"会让人以为场景集缺东西。
 *    所以结果里带 `filterCounts`（每个条件**单独**生效时的命中数）。
 *
 * 纯函数：拿 `Scenario[]` 出结果，不读盘、不写盘。
 */

import { DRIVER_COST } from '../kinds/index.js'
import type { CostClass, Scenario } from '../cases/types.js'

export interface ScenarioSearchQuery {
  /** 全文关键词（忽略大小写）。 */
  text?: string
  /** 限定 kind（任一命中）。 */
  kinds?: readonly string[]
  /** 限定 tag（任一命中）。 */
  tags?: readonly string[]
  /** 限定 owner；比较时忽略大小写与 `@` 前缀。 */
  owner?: string
  /** 限定成本档（取 `scenario.cost ?? DRIVER_COST[kind]`）。 */
  cost?: string
  /** 限定状态（默认**不限制**——搜索要能找到 draft/retired，否则等于藏起来）。 */
  status?: string | readonly string[]
}

export interface SearchHit {
  id: string
  title: string
  kind: string
  status: string
  owner?: string
  cost: string
  tags: string[]
  /** 命中的字段数（越多越靠前）。 */
  score: number
  /** 人读的命中理由，例如 `title 命中 "timeout"`。 */
  reasons: string[]
}

export interface FilterCount {
  filter: string
  matched: number
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  /** 参与搜索的场景总数。 */
  scanned: number
  query: ScenarioSearchQuery
  /** 每个条件**单独**生效时的命中数（解释"为什么 0 条"用）。 */
  filterCounts: FilterCount[]
  /** 结论（含空结果的解释）。 */
  reason: string
}

function effectiveCost(scenario: Scenario): string {
  const declared = scenario.cost as CostClass | undefined
  if (declared !== undefined) return declared
  return (DRIVER_COST as Record<string, CostClass | undefined>)[scenario.kind] ?? 'unknown'
}

function normalizeOwner(value: string | undefined): string {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase()
}

/** 把一条场景摊平成"字段名 → 可搜索文本"。 */
function searchableFields(scenario: Scenario): Array<{ field: string; text: string }> {
  const fields: Array<{ field: string; text: string }> = [
    { field: 'id', text: scenario.id },
    { field: 'title', text: scenario.title },
    { field: 'kind', text: scenario.kind },
    { field: 'tags', text: (scenario.tags ?? []).join(' ') },
    { field: 'owner', text: scenario.owner ?? '' },
    { field: 'issue', text: scenario.source?.issue ?? '' },
    { field: 'source.summary', text: scenario.source?.summary ?? '' },
    { field: 'fixtures', text: (scenario.fixtures ?? []).join(' ') },
    { field: 'setup', text: JSON.stringify(scenario.setup ?? {}) },
  ]
  ;(scenario.steps ?? []).forEach((step, index) => {
    const label = `步骤${index + 1}`
    if (step.name !== undefined) fields.push({ field: `${label}.name`, text: step.name })
    if (step.id !== undefined) fields.push({ field: `${label}.id`, text: step.id })
    if (step.use !== undefined) fields.push({ field: `${label}.use`, text: step.use })
    if (step.act !== undefined) fields.push({ field: `${label}.act`, text: JSON.stringify(step.act) })
    if (step.expect !== undefined) fields.push({ field: `${label}.expect`, text: JSON.stringify(step.expect) })
  })
  return fields
}

function matchText(scenario: Scenario, needle: string): string[] {
  const reasons: string[] = []
  for (const { field, text } of searchableFields(scenario)) {
    if (text === '') continue
    if (text.toLowerCase().includes(needle)) reasons.push(`${field} 命中 "${needle}"`)
  }
  return reasons
}

function describeQuery(query: ScenarioSearchQuery): string {
  const parts: string[] = []
  if (query.text !== undefined && query.text.trim() !== '') parts.push(`text="${query.text.trim()}"`)
  if (query.kinds !== undefined && query.kinds.length > 0) parts.push(`kinds=${query.kinds.join('/')}`)
  if (query.tags !== undefined && query.tags.length > 0) parts.push(`tags=${query.tags.join('/')}`)
  if (query.owner !== undefined && query.owner.trim() !== '') parts.push(`owner=${query.owner}`)
  if (query.cost !== undefined && query.cost !== '') parts.push(`cost=${query.cost}`)
  if (query.status !== undefined && (typeof query.status === 'string' ? query.status !== '' : query.status.length > 0)) {
    parts.push(`status=${Array.isArray(query.status) ? query.status.join('/') : query.status}`)
  }
  return parts.length === 0 ? '（无过滤条件）' : parts.join(' · ')
}

function statusMatches(scenario: Scenario, wanted: string | readonly string[] | undefined): boolean {
  if (wanted === undefined) return true
  const list = (Array.isArray(wanted) ? wanted : [wanted]).map((item) => String(item))
  if (list.length === 0) return true
  return list.includes(scenario.status ?? 'active')
}

function hasText(query: ScenarioSearchQuery): boolean {
  return query.text !== undefined && query.text.trim() !== ''
}

/** 条件是否都是空集合（空数组 = 不限制，与"没有"等价）。 */
function isActiveList(list: readonly string[] | undefined): boolean {
  return Array.isArray(list) && list.length > 0
}

/** 搜索场景；结果带命中理由与空结果解释。 */
export function searchScenarios(
  scenarios: readonly Scenario[],
  query: ScenarioSearchQuery = {},
): SearchResult {
  const needle = (query.text ?? '').trim().toLowerCase()
  const kinds = isActiveList(query.kinds) ? query.kinds!.map((k) => String(k)) : undefined
  const tags = isActiveList(query.tags) ? query.tags!.map((t) => String(t).toLowerCase()) : undefined
  const owner = query.owner !== undefined && query.owner.trim() !== '' ? normalizeOwner(query.owner) : undefined
  const cost = query.cost !== undefined && query.cost !== '' ? String(query.cost) : undefined

  const textHit = (scenario: Scenario): string[] => (needle === '' ? [] : matchText(scenario, needle))
  const kindHit = (scenario: Scenario): boolean => kinds === undefined || kinds.includes(scenario.kind)
  const tagHit = (scenario: Scenario): boolean => {
    if (tags === undefined) return true
    const own = (scenario.tags ?? []).map((t) => t.toLowerCase())
    return tags.some((t) => own.includes(t))
  }
  const ownerHit = (scenario: Scenario): boolean => owner === undefined || normalizeOwner(scenario.owner) === owner
  const costHit = (scenario: Scenario): boolean => cost === undefined || effectiveCost(scenario) === cost
  const statusHit = (scenario: Scenario): boolean => statusMatches(scenario, query.status)

  const matchesAll = (scenario: Scenario): { ok: boolean; reasons: string[] } => {
    const reasons = textHit(scenario)
    if (needle !== '' && reasons.length === 0) return { ok: false, reasons: [] }
    if (!kindHit(scenario) || !tagHit(scenario) || !ownerHit(scenario) || !costHit(scenario) || !statusHit(scenario)) {
      return { ok: false, reasons: [] }
    }
    return { ok: true, reasons }
  }

  /** 只有**这一个**条件生效时的判定（用于解释"为什么 0 条"）。 */
  const matchesOnly = (scenario: Scenario, only: string): boolean => {
    switch (only) {
      case 'text':
        return textHit(scenario).length > 0
      case 'kinds':
        return kindHit(scenario)
      case 'tags':
        return tagHit(scenario)
      case 'owner':
        return ownerHit(scenario)
      case 'cost':
        return costHit(scenario)
      case 'status':
        return statusHit(scenario)
      default:
        return false
    }
  }

  const hits: SearchHit[] = []
  for (const scenario of scenarios) {
    const { ok, reasons } = matchesAll(scenario)
    if (!ok) continue
    hits.push({
      id: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      status: scenario.status ?? 'active',
      ...(scenario.owner === undefined ? {} : { owner: scenario.owner }),
      cost: effectiveCost(scenario),
      tags: [...(scenario.tags ?? [])],
      score: reasons.length,
      reasons,
    })
  }

  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  // 每个条件**单独**生效时的命中数：解释"0 条"的关键证据
  const filterCounts: FilterCount[] = []
  const countWith = (label: string, only: string): void => {
    filterCounts.push({ filter: label, matched: scenarios.filter((scenario) => matchesOnly(scenario, only)).length })
  }
  if (needle !== '') countWith(`text="${query.text!.trim()}"`, 'text')
  if (kinds !== undefined) countWith(`kinds=${kinds.join('/')}`, 'kinds')
  if (tags !== undefined) countWith(`tags=${query.tags!.join('/')}`, 'tags')
  if (owner !== undefined) countWith(`owner=${query.owner}`, 'owner')
  if (cost !== undefined) countWith(`cost=${cost}`, 'cost')
  if (query.status !== undefined) countWith(`status=${Array.isArray(query.status) ? query.status.join('/') : query.status}`, 'status')

  const summary = describeQuery(query)
  let reason: string
  if (filterCounts.length === 0) {
    reason = `未给过滤条件：返回全部 ${scenarios.length} 条场景。`
  } else if (hits.length > 0) {
    reason = `命中 ${hits.length}/${scenarios.length} 条场景（${summary}）。`
  } else {
    const zero = filterCounts.filter((item) => item.matched === 0)
    const nonZero = filterCounts.filter((item) => item.matched > 0)
    const detail = filterCounts.map((item) => `${item.filter} → 单独命中 ${item.matched} 条`).join('；')
    reason =
      zero.length > 0
        ? `0 条：条件本身就没有命中——${zero.map((item) => item.filter).join('、')}；各条件单独结果：${detail}。`
        : `0 条：各条件单独都有命中（${nonZero.map((item) => `${item.filter}:${item.matched}`).join('、')}），但没有场景**同时**满足全部条件。`
  }

  return { hits, total: hits.length, scanned: scenarios.length, query, filterCounts, reason }
}

/* --------------------------------------------------------------- 渲染 -- */

/** 渲染成 Markdown 表 + 命中理由；0 条时回显解释。 */
export function renderSearchResult(result: SearchResult): string {
  const lines: string[] = []
  lines.push('## 场景搜索')
  lines.push('')
  lines.push(`- 条件：${describeQuery(result.query)}`)
  lines.push(`- 命中：${result.total}/${result.scanned}`)
  lines.push(`- 说明：${result.reason}`)

  if (result.total === 0) {
    if (result.filterCounts.length > 0) {
      lines.push('')
      lines.push('| 条件 | 单独命中 |')
      lines.push('| --- | ---: |')
      for (const item of result.filterCounts) lines.push(`| ${item.filter} | ${item.matched} |`)
    }
    return lines.join('\n')
  }

  lines.push('')
  lines.push('| ID | kind | status | owner | cost | tags | 命中理由 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const hit of result.hits) {
    const reasons = hit.reasons.length > 0 ? hit.reasons.slice(0, 4).join('；') + (hit.reasons.length > 4 ? ' …' : '') : '—'
    lines.push(
      `| ${hit.id} | ${hit.kind} | ${hit.status} | ${hit.owner ?? '—'} | ${hit.cost} | ` +
        `${hit.tags.join('/') || '—'} | ${reasons} |`,
    )
  }
  return lines.join('\n')
}
