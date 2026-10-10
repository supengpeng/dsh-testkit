/**
 * 覆盖矩阵与缺口报告 —— "我们的场景集到底覆盖了什么、缺什么"。
 *
 * ## 为什么要按 kind 出矩阵
 *
 * 场景总数会骗人：36 条里可能 20 条都在测 `tool`，而 `compaction` 只有 1 条且是 draft。
 * 矩阵把"每类干预点有几条、其中几条是真能跑的（active）、几条有主（owner）、
 * 几条带标签、成本档怎么分布"摊平，缺口自然浮出来。
 *
 * ## 缺口必须"可行动"
 *
 * 每条缺口都带三样东西：**缺什么**（message）、**涉及哪些场景**（ids）、
 * **怎么补**（action）。只报"覆盖不足"没有用——那是废话，不是工作项。
 *
 * 本模块是纯函数：拿 `Scenario[]` 出报告，不读盘、不写盘。
 */

import { DRIVER_COST } from '../kinds/index.js'
import type { CostClass, Scenario } from '../cases/types.js'
import { SCENARIO_KINDS } from '../cases/types.js'

export interface CoverageRow {
  kind: string
  total: number
  active: number
  draft: number
  /** 带 `owner` 的场景数（自动 triage 的覆盖率）。 */
  withOwner: number
  /** 成本档分布（取 `scenario.cost ?? DRIVER_COST[kind]`）。 */
  costs: Record<string, number>
  /** 带至少一个 tag 的场景数（按 tag 选择器能选中的覆盖率）。 */
  tagged: number
  /** —— 以下为附加列（不破坏上面的冻结字段）—— */
  /** 带 `smoke` 标签的场景数（快速门的显式覆盖）。 */
  smoke: number
  /** `runtime.timeoutMs ≤ smokeMs` 的场景数（快速门的**候选**）。 */
  light: number
}

export type CoverageGapCode =
  | 'empty-kind'
  | 'no-active'
  | 'draft-stale'
  | 'no-owner'
  | 'no-tag'
  | 'no-smoke'
  | 'no-fixture'

export interface CoverageGap {
  code: CoverageGapCode
  /** 缺口所在范围：kind 名，或 `ALL`（全局缺口）。 */
  scope: string
  severity: 'high' | 'medium' | 'low'
  /** 缺什么。 */
  message: string
  /** 怎么补（具体到动作）。 */
  action: string
  /** 涉及哪些场景 ID。 */
  ids: string[]
}

export interface CoverageReport {
  rows: CoverageRow[]
  gaps: CoverageGap[]
  /* ---- 附加汇总（便于工具面直接回显，不改变 rows/gaps 契约） ---- */
  totals: {
    scenarios: number
    kinds: number
    kindsWithoutScenarios: number
    active: number
    draft: number
    withOwner: number
    tagged: number
    withFixtures: number
  }
  /** 本次判定采用的快速门耗时预算（毫秒）。 */
  smokeMs: number
  notes: string[]
}

export interface BuildCoverageOptions {
  /**
   * 快速门（smoke）候选的耗时预算，默认 5000ms。
   *
   * 判定"轻量候选"用的是场景**自己声明的** `runtime.timeoutMs`；
   * 没声明的不算候选（不猜默认超时，那会把所有场景都算进去）。
   */
  smokeMs?: number
}

const DEFAULT_SMOKE_MS = 5000
const SMOKE_TAG = 'smoke'

function effectiveCost(scenario: Scenario): string {
  const declared = scenario.cost as CostClass | undefined
  if (declared !== undefined) return declared
  const fromDriver = (DRIVER_COST as Record<string, CostClass | undefined>)[scenario.kind]
  return fromDriver ?? 'unknown'
}

function statusOf(scenario: Scenario): string {
  return scenario.status ?? 'active'
}

function emptyRow(kind: string): CoverageRow {
  return {
    kind,
    total: 0,
    active: 0,
    draft: 0,
    withOwner: 0,
    costs: {},
    tagged: 0,
    smoke: 0,
    light: 0,
  }
}

/** 生成覆盖矩阵与缺口报告。 */
export function buildCoverage(
  scenarios: readonly Scenario[],
  options: BuildCoverageOptions = {},
): CoverageReport {
  const smokeMs = Number.isFinite(options.smokeMs) ? Number(options.smokeMs) : DEFAULT_SMOKE_MS

  // 行覆盖**已注册的全部 kind**（哪怕 0 条），行序固定为 SCENARIO_KINDS——可复现；
  // 再兜底收下数据里出现的、注册表之外的 kind（数据坏了也要看得见）。
  const rows = new Map<string, CoverageRow>()
  for (const kind of SCENARIO_KINDS) rows.set(kind, emptyRow(kind))

  for (const scenario of scenarios) {
    let row = rows.get(scenario.kind)
    if (!row) {
      row = emptyRow(scenario.kind)
      rows.set(scenario.kind, row)
    }
    row.total += 1
    if (statusOf(scenario) === 'active') row.active += 1
    if (statusOf(scenario) === 'draft') row.draft += 1
    if (typeof scenario.owner === 'string' && scenario.owner.trim() !== '') row.withOwner += 1
    const cost = effectiveCost(scenario)
    row.costs[cost] = (row.costs[cost] ?? 0) + 1
    if (Array.isArray(scenario.tags) && scenario.tags.length > 0) row.tagged += 1
    if ((scenario.tags ?? []).includes(SMOKE_TAG)) row.smoke += 1
    const timeout = scenario.runtime?.timeoutMs
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout <= smokeMs) row.light += 1
  }

  const gaps: CoverageGap[] = []
  const byKind = new Map<string, Scenario[]>()
  for (const scenario of scenarios) {
    const list = byKind.get(scenario.kind) ?? []
    list.push(scenario)
    byKind.set(scenario.kind, list)
  }

  // 全局覆盖情况决定缺口的**粒度**：某一项全仓为 0 时出 1 条 ALL 缺口（而不是 12 条重复），
  // 只有"某些 kind 有、某些没有"时才是真正的按 kind 缺口。
  const anyOwner = scenarios.some((s) => typeof s.owner === 'string' && s.owner.trim() !== '')
  const anyTag = scenarios.some((s) => (s.tags ?? []).length > 0)
  const anySmoke = scenarios.some((s) => (s.tags ?? []).includes(SMOKE_TAG))
  const anyFixture = scenarios.some((s) => (s.fixtures ?? []).length > 0)

  for (const [kind, row] of rows) {
    const list = byKind.get(kind) ?? []
    const noOwner = list.filter((s) => !(typeof s.owner === 'string' && s.owner.trim() !== '')).map((s) => s.id)
    const noTag = list.filter((s) => (s.tags ?? []).length === 0).map((s) => s.id)

    if (row.total === 0) {
      gaps.push({
        code: 'empty-kind',
        scope: kind,
        severity: 'high',
        message: `kind=${kind} 一条场景都没有：这类干预点当前完全没有回归网。`,
        action: `补一条 self-check 场景（cases/TK-XXXX.yaml，kind: ${kind}），先覆盖"驱动器接线正确"，再补真实交互路径。`,
        ids: [],
      })
      continue
    }

    if (row.active === 0) {
      gaps.push({
        code: 'no-active',
        scope: kind,
        severity: 'high',
        message: `kind=${kind} 有 ${row.total} 条场景但全部不是 active（draft/blocked/retired）：默认运行集合里一条都不会跑。`,
        action: '把能稳定跑的转 active（补齐 runtime.requires 与确定性断言）；确认跑不了的标 retired 并写清原因，别让它烂在 draft 里。',
        ids: list.map((s) => s.id),
      })
    } else if (row.draft > 0) {
      gaps.push({
        code: 'draft-stale',
        scope: kind,
        severity: 'low',
        message: `kind=${kind} 有 ${row.draft} 条 draft 与 ${row.active} 条 active 并存：draft 既不进默认集合也不会有人看到。`,
        action: '逐条裁决：能跑的转 active，跑不了的在 source.summary 里写清原因后标 retired。',
        ids: list.filter((s) => statusOf(s) === 'draft').map((s) => s.id),
      })
    }

    if (anyOwner && noOwner.length > 0) {
      gaps.push({
        code: 'no-owner',
        scope: kind,
        severity: 'medium',
        message: `kind=${kind} 有 ${noOwner.length}/${row.total} 条场景没有 owner：失败后无法自动路由到人。`,
        action: '补 `owner: "@<人名>"`（SCENARIO-SPEC 的 owner 是机器可读字段，不是署名）。',
        ids: noOwner,
      })
    }

    if (anyTag && noTag.length > 0) {
      gaps.push({
        code: 'no-tag',
        scope: kind,
        severity: 'low',
        message: `kind=${kind} 有 ${noTag.length}/${row.total} 条场景没有 tag：--tags 选择器永远选不中它们。`,
        action: '补能描述"它测什么"的 tag（例如 smoke / failure-path / host-service），别用 kind 名当 tag。',
        ids: noTag,
      })
    }

    if (anySmoke && row.smoke === 0) {
      gaps.push({
        code: 'no-smoke',
        scope: kind,
        severity: 'medium',
        message:
          `kind=${kind} 没有带 \`smoke\` 标签的场景：快速门（--smoke）覆盖不到这一类。` +
          (row.light > 0 ? `该 kind 有 ${row.light} 条 \`runtime.timeoutMs ≤ ${smokeMs}ms\` 的轻量候选。` : ''),
        action:
          row.light > 0
            ? `把其中最快的一条标上 \`smoke\` 标签（已满足 ≤ ${smokeMs}ms 的耗时预算）。`
            : `先写一条只做只读动作、\`runtime.timeoutMs ≤ ${smokeMs}ms\` 的场景，再标 \`smoke\`。`,
        ids: list.map((s) => s.id),
      })
    }
  }

  if (scenarios.length > 0 && !anyOwner) {
    gaps.push({
      code: 'no-owner',
      scope: 'ALL',
      severity: 'medium',
      message: `全部 ${scenarios.length} 条场景都没有 owner：失败后没有任何自动路由依据，只能人肉认领。`,
      action: '先给每条场景补 `owner: "@<人名>"`（按领域分工比按人平均更实际）；之后新场景在提炼阶段就带 owner。',
      ids: scenarios.map((s) => s.id),
    })
  }

  if (scenarios.length > 0 && !anyTag) {
    gaps.push({
      code: 'no-tag',
      scope: 'ALL',
      severity: 'low',
      message: `全部 ${scenarios.length} 条场景都没有 tag：按 tag 的选择器与快速门都失效。`,
      action: '补一组基础 tag（smoke / failure-path / host-service / regression），至少让 --tags smoke 可用。',
      ids: scenarios.map((s) => s.id),
    })
  }

  if (scenarios.length > 0 && !anySmoke) {
    gaps.push({
      code: 'no-smoke',
      scope: 'ALL',
      severity: 'high',
      message: `没有任何场景带 \`smoke\` 标签：没有可以在几十秒内跑完的快速门。`,
      action: `挑只读、确定性、\`runtime.timeoutMs ≤ ${smokeMs}ms\` 的场景标 \`smoke\`，组成 --smoke 集。`,
      ids: scenarios.map((s) => s.id),
    })
  }

  if (scenarios.length > 0 && !anyFixture) {
    gaps.push({
      code: 'no-fixture',
      scope: 'ALL',
      severity: 'low',
      message: `没有任何场景引用夹具（fixtures/**）：条件在多条场景里重复手写，改一处要改多处。`,
      action: '把重复出现的条件抽成 fixtures/<kind>/<name>.yaml（带 dsh_version 与 source），再在场景里用 `fixtures: [<kind>/<name>]` 引用。',
      ids: scenarios.map((s) => s.id),
    })
  }

  // 夹具是"按 kind 缺失"最有价值的一类：全局有、但某些 kind 一条都没有
  const kindsWithoutFixture = [...rows.values()]
    .filter((row) => row.total > 0 && !(byKind.get(row.kind) ?? []).some((s) => (s.fixtures ?? []).length > 0))
    .map((row) => row.kind)
  if (anyFixture && kindsWithoutFixture.length > 0) {
    gaps.push({
      code: 'no-fixture',
      scope: kindsWithoutFixture.join('、'),
      severity: 'low',
      message: `以下 kind 一条夹具都没引用：${kindsWithoutFixture.join('、')}。它们的条件只能靠各场景手写重复。`,
      action: '每个 kind 先抽 1 份最常用的条件成 fixtures/<kind>/<name>.yaml，再挑 2~3 条场景改用它，验证兼容性判定有效。',
      ids: [],
    })
  }

  const allActive = scenarios.filter((s) => statusOf(s) === 'active')
  if (scenarios.length > 0 && allActive.length === 0) {
    gaps.push({
      code: 'no-active',
      scope: 'ALL',
      severity: 'high',
      message: `全部 ${scenarios.length} 条场景都不是 active：默认运行集合是空的。`,
      action: '先把一条最基本的 self-check 转 active，让默认跑有东西可跑。',
      ids: scenarios.map((s) => s.id),
    })
  }

  const severityRank = { high: 0, medium: 1, low: 2 } as const
  gaps.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0))

  const kindsWithoutScenarios = [...rows.values()].filter((row) => row.total === 0).length
  const report: CoverageReport = {
    rows: [...rows.values()],
    gaps,
    totals: {
      scenarios: scenarios.length,
      kinds: rows.size,
      kindsWithoutScenarios,
      active: rows.size === 0 ? 0 : [...rows.values()].reduce((sum, row) => sum + row.active, 0),
      draft: [...rows.values()].reduce((sum, row) => sum + row.draft, 0),
      withOwner: [...rows.values()].reduce((sum, row) => sum + row.withOwner, 0),
      tagged: [...rows.values()].reduce((sum, row) => sum + row.tagged, 0),
      withFixtures: scenarios.filter((s) => (s.fixtures ?? []).length > 0).length,
    },
    smokeMs,
    notes: [],
  }

  if (report.totals.withOwner < report.totals.scenarios) {
    report.notes.push(
      `owner 覆盖 ${report.totals.withOwner}/${report.totals.scenarios}：未覆盖的失败只能靠人肉认领。`,
    )
  }
  if (report.totals.withFixtures === 0) {
    report.notes.push('当前没有任何场景引用夹具：fixture 治理（fixtures/**）还没有被真正用起来。')
  }
  if (kindsWithoutScenarios > 0) {
    report.notes.push(`有 ${kindsWithoutScenarios} 个已注册 kind 没有场景（见 high 缺口 empty-kind）。`)
  }

  return report
}

/* --------------------------------------------------------------- 渲染 -- */

/** 渲染成 Markdown 表 + 缺口清单（按严重度排序）。 */
export function renderCoverage(report: CoverageReport): string {
  const lines: string[] = []
  const { totals } = report
  lines.push('## 覆盖矩阵')
  lines.push('')
  lines.push(
    `- 场景 ${totals.scenarios} 条 · kind ${totals.kinds} 个（其中 ${totals.kindsWithoutScenarios} 个无场景）` +
      ` · active ${totals.active} · draft ${totals.draft} · 带 owner ${totals.withOwner} · 带 tag ${totals.tagged}` +
      ` · 引用夹具 ${totals.withFixtures}`,
  )
  lines.push('')
  lines.push('| kind | 场景数 | active | draft | 带 owner | 带 tag | smoke | 轻量(≤' + report.smokeMs + 'ms) | 成本档 |')
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |')
  for (const row of report.rows) {
    const costs =
      Object.entries(row.costs)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([cost, count]) => `${cost}:${count}`)
        .join(' ') || '—'
    lines.push(
      `| ${row.kind} | ${row.total} | ${row.active} | ${row.draft} | ${row.withOwner} | ${row.tagged} | ` +
        `${row.smoke} | ${row.light} | ${costs} |`,
    )
  }

  lines.push('')
  lines.push(`## 覆盖缺口（${report.gaps.length} 项，按严重度）`)
  if (report.gaps.length === 0) {
    lines.push('')
    lines.push('没有发现缺口。')
    return lines.join('\n')
  }

  const labels: Record<string, string> = {
    high: '高',
    medium: '中',
    low: '低',
  }
  for (const gap of report.gaps) {
    lines.push('')
    lines.push(`### [${labels[gap.severity] ?? gap.severity}] ${gap.scope} · ${gap.code}`)
    lines.push(`- 缺什么：${gap.message}`)
    lines.push(`- 怎么补：${gap.action}`)
    if (gap.ids.length > 0) lines.push(`- 涉及：${gap.ids.join('、')}`)
  }

  if (report.notes.length > 0) {
    lines.push('')
    lines.push('### 说明')
    for (const note of report.notes) lines.push(`- ${note}`)
  }
  return lines.join('\n')
}
