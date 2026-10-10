/**
 * 宿主体检：把"这台机器上 dsh-testkit 能不能正常干活"变成一份可读报告。
 *
 * ## 它回答的四个问题
 *
 *   ① **缺什么能力**：按每个 driver 的 `requires` 与宿主 capabilities 推导
 *      哪些 kind 会跳过、为什么——**不硬编码**。硬编码的清单在加 driver 那天就过期，
 *      而"哪些场景会跳过"恰恰是读者最需要相信的一项。
 *   ② **守卫还在不在**：`package.json` 里 `verify:*` / `test:*` 是否齐
 *      （从 scripts 读，不猜脚本名）。
 *   ③ **有没有残留**：由调用方提供 `residue`（`collectHostResidue` 的产物）；
 *      不给就如实写"未探测"，**绝不写"干净"**。
 *   ④ **最近一次跑成什么样**：`runs/` 里最近一份 run.json 的 totals + 覆盖缺口前几条。
 *
 * ## 为什么 `ok` 只看 error
 *
 * `warn`（缺能力会 skip、有陈旧残留、覆盖缺口）是**这台机器的现状**，
 * 不是"工具坏了"。把 warn 也算不健康，会让 doctor 在正常环境下常年报红，
 * 于是没人再看它——那才是体检真正的失败模式。
 */

import { buildCoverage } from '../insight/coverage.js'
import type { HostCapability } from '../cases/types.js'
import { createDriverRegistry } from '../kinds/index.js'
import type { Driver } from '../kinds/types.js'
import type { Scenario } from '../cases/types.js'
import { isDirectory, scanRuns } from './runs.js'
import type {
  DoctorCasesSection,
  DoctorFinding,
  DoctorInput,
  DoctorReport,
  DoctorResidue,
  DriverCapabilityRow,
  GuardEntry,
} from './types.js'

const DEFAULT_MAX_GAPS = 5

/** 跑一次体检。除了读盘（runs/）与可选注入的探针外没有副作用。 */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const capabilities = normalizeCapabilities(input.host.capabilities)
  const drivers = (input.drivers ?? createDriverRegistry()).list()
  const scenarios = input.registry.all
  const counts = countByKind(scenarios)

  const driverRows = buildDriverRows(drivers, capabilities, counts)
  const guards = collectGuards(input.scripts)
  const cases = collectCases(input.registry.all, input.registry.invalidCases.length, input.registry.problems.length, input.casesDir)
  const runs = scanRuns(input.runsDir)
  const coverage = buildCoverage(scenarios)
  const residue = input.residue ?? unprobedResidue()
  const maxGaps = normalizeMaxGaps(input.maxGaps)

  const capabilitiesSection = {
    present: [...capabilities].sort(),
    requiredByDrivers: [...new Set(drivers.flatMap((driver) => [...(driver.requires ?? [])]))].sort(),
    missing: [...new Set(drivers.flatMap((driver) => [...(driver.requires ?? [])]))]
      .filter((capability) => !capabilities.has(capability))
      .sort(),
  }

  const findings = collectFindings({
    cases,
    casesDirExists: isDirectory(input.casesDir),
    runs,
    guards,
    driverRows,
    residue,
    gapCount: coverage.gaps.length,
    highGapCount: coverage.gaps.filter((gap) => gap.severity === 'high').length,
  })

  return {
    ok: !findings.some((finding) => finding.level === 'error'),
    generatedAt: new Date().toISOString(),
    host: {
      dshVersion: input.host.env.dshVersion,
      nodeVersion: input.host.env.nodeVersion,
      platform: input.host.env.platform,
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
    },
    capabilities: capabilitiesSection,
    drivers: driverRows,
    guards,
    cases,
    runs,
    residue,
    coverage: {
      totals: coverage.totals,
      kinds: coverage.rows.length,
      gapCount: coverage.gaps.length,
      highGapCount: coverage.gaps.filter((gap) => gap.severity === 'high').length,
      gaps: coverage.gaps.slice(0, maxGaps),
      smokeMs: coverage.smokeMs,
    },
    findings,
  }
}

/* --------------------------------------------------------------- 能力矩阵 -- */

function normalizeCapabilities(
  input: ReadonlySet<HostCapability> | readonly HostCapability[],
): Set<HostCapability> {
  return new Set(input as Iterable<HostCapability>)
}

/** kind → 场景数 / active 数（跳过预测的影响面要看得见）。 */
function countByKind(scenarios: readonly Scenario[]): Map<string, { total: number; active: number }> {
  const counts = new Map<string, { total: number; active: number }>()
  for (const scenario of scenarios) {
    const row = counts.get(scenario.kind) ?? { total: 0, active: 0 }
    row.total += 1
    if ((scenario.status ?? 'active') === 'active') row.active += 1
    counts.set(scenario.kind, row)
  }
  return counts
}

function buildDriverRows(
  drivers: readonly Driver[],
  capabilities: ReadonlySet<HostCapability>,
  counts: Map<string, { total: number; active: number }>,
): DriverCapabilityRow[] {
  return drivers.map((driver) => {
    // 去重保序：同一个能力被声明两次不该在报告里出现两遍
    const requires = [...new Set(driver.requires ?? [])]
    const missing = requires.filter((capability) => !capabilities.has(capability))
    const row = counts.get(driver.kind) ?? { total: 0, active: 0 }
    return {
      kind: driver.kind,
      description: driver.description,
      requires,
      missing,
      willSkip: missing.length > 0,
      // 与 runner 的 skipReason **同一个口径**（见 src/runtime/runner.ts）
      ...(missing.length === 0 ? {} : { reason: `宿主缺少能力：${missing.join(', ')}` }),
      scenarios: row.total,
      active: row.active,
    }
  })
}

/* ------------------------------------------------------------------ 守卫 -- */

function collectGuards(scripts: Record<string, string>): GuardEntry[] {
  const guards: GuardEntry[] = []
  for (const [name, command] of Object.entries(scripts ?? {})) {
    const group = name.startsWith('verify:') ? 'verify' : name.startsWith('test:') ? 'test' : undefined
    if (group === undefined || typeof command !== 'string') continue
    guards.push({ name, command, group })
  }
  return guards.sort((a, b) => a.name.localeCompare(b.name))
}

/* ------------------------------------------------------------------ 场景 -- */

function collectCases(
  scenarios: readonly Scenario[],
  invalid: number,
  indexIssues: number,
  casesDir: string,
): DoctorCasesSection {
  const statusOf = (scenario: Scenario): string => scenario.status ?? 'active'
  return {
    dir: casesDir,
    scenarios: scenarios.length,
    kinds: new Set(scenarios.map((scenario) => scenario.kind)).size,
    active: scenarios.filter((scenario) => statusOf(scenario) === 'active').length,
    draft: scenarios.filter((scenario) => statusOf(scenario) === 'draft').length,
    retired: scenarios.filter((scenario) => statusOf(scenario) === 'retired').length,
    blocked: scenarios.filter((scenario) => statusOf(scenario) === 'blocked').length,
    invalid,
    indexIssues,
  }
}

/* -------------------------------------------------------------- 未探测残留 -- */

function unprobedResidue(): DoctorResidue {
  return {
    targets: [],
    record: { released: [], leftovers: [] },
    notes: ['调用方未提供残留探测结果（residue）：本报告不对残留做任何结论，**不表示干净**'],
  }
}

/* ------------------------------------------------------------------ 发现 -- */

interface FindingInput {
  cases: DoctorCasesSection
  casesDirExists: boolean
  runs: DoctorReport['runs']
  guards: GuardEntry[]
  driverRows: DriverCapabilityRow[]
  residue: DoctorResidue
  gapCount: number
  highGapCount: number
}

function collectFindings(input: FindingInput): DoctorFinding[] {
  const findings: DoctorFinding[] = []

  if (!input.casesDirExists) {
    findings.push({
      level: 'error',
      code: 'cases-dir-missing',
      message: `场景目录不存在：${input.cases.dir}`,
      hint: '检查配置的 casesDir；空目录会让默认运行集合为空，而不是"全部通过"。',
    })
  }

  if (input.cases.invalid > 0) {
    findings.push({
      level: 'error',
      code: 'invalid-cases',
      message: `有 ${input.cases.invalid} 个场景文件校验/读取失败：它们既不会跑也不会报错，只是消失。`,
      hint: '跑 `npm run verify:cases` 看逐条原因；坏件在 registry.invalidCases 里。',
    })
  }

  if (input.cases.indexIssues > 0) {
    findings.push({
      level: 'warn',
      code: 'index-mismatch',
      message: `index.yaml 与场景集合不一致（${input.cases.indexIssues} 项）。`,
      hint: '跑 `npm run verify:cases` 重新生成索引，别手改。',
    })
  }

  if (!input.runs.exists) {
    findings.push({
      level: 'warn',
      code: 'runs-dir-missing',
      message: `报告目录不存在：${input.runs.dir}`,
      hint: '还没有跑过，或 runsDir 配错了；报告是三份产物（run.json / report.md / junit.xml）的落点。',
    })
  } else if (input.runs.latest === undefined) {
    findings.push({
      level: 'info',
      code: 'no-run-history',
      message: '报告目录里没有可读的 run.json：拿不到"最近一次跑成什么样"。',
      hint: '先跑一次 `dsh-testkit run`，这里才会有趋势可看。',
    })
  }

  const verifyGuards = input.guards.filter((guard) => guard.group === 'verify')
  const testGuards = input.guards.filter((guard) => guard.group === 'test')
  if (verifyGuards.length === 0) {
    findings.push({
      level: 'warn',
      code: 'no-verify-guards',
      message: 'package.json 里没有任何 `verify:*` 守卫：场景/夹具/文档的约束没有自动检查。',
      hint: '把 scripts/verify-*.mjs 接成 `verify:*`，并纳入 gate。',
    })
  }
  if (testGuards.length === 0) {
    findings.push({
      level: 'warn',
      code: 'no-test-guards',
      message: 'package.json 里没有任何 `test:*` 脚本：测试入口不可复现。',
      hint: '至少给出 `test:*`（主轨）与 `test:contracts`（契约轨）。',
    })
  }

  const affected = input.driverRows.filter((row) => row.willSkip && row.active > 0)
  if (affected.length > 0) {
    const detail = affected
      .map((row) => `${row.kind}(${row.active} 条，缺 ${row.missing.join('/')})`)
      .join('、')
    findings.push({
      level: 'warn',
      code: 'capability-skip',
      message: `有 ${affected.length} 类 kind 的 active 场景会因宿主缺能力被跳过：${detail}。`,
      hint: '这不是失败而是"没跑"：在具备这些能力的宿主上复跑，或给场景补 runtime.requires 的替代路径。',
    })
  }

  const known = input.residue.record.leftovers.filter((item) => !item.startsWith('unknown:'))
  const unknown = input.residue.record.leftovers.filter((item) => item.startsWith('unknown:'))
  if (input.residue.targets.length === 0) {
    findings.push({
      level: 'info',
      code: 'residue-not-probed',
      message: '本次未做残留探测：报告不含残留结论（注意：**未探测 ≠ 干净**）。',
      hint: '用 `collectHostResidue()` 探一轮再传进来。',
    })
  } else if (known.length > 0) {
    findings.push({
      level: 'warn',
      code: 'residue-found',
      message: `检测到 ${known.length} 项残留：${summarize(known)}`,
      hint: '陈旧临时目录可以直接删；端口/进程要先确认不是别的服务在用（裸 `port:` 只是"这个端口被占着"）。',
    })
  }
  if (unknown.length > 0) {
    findings.push({
      level: 'warn',
      code: 'residue-unknown',
      message: `有 ${unknown.length} 项探不到（不等于干净）：${summarize(unknown)}`,
      hint: '探针不可用时不要下"干净"的结论；换平台/补工具后重跑。',
    })
  }

  if (input.gapCount > 0) {
    findings.push({
      level: 'info',
      code: 'coverage-gaps',
      message: `覆盖矩阵有 ${input.gapCount} 项缺口（其中 ${input.highGapCount} 项 high）。`,
      hint: '明细见 coverage 段（只列前几条）或 `dsh-testkit insight coverage`。',
    })
  }

  const rank = { error: 0, warn: 1, info: 2 } as const
  return findings.sort((a, b) => rank[a.level] - rank[b.level])
}

function summarize(items: readonly string[]): string {
  const head = items.slice(0, 3).join('、')
  return items.length > 3 ? `${head} 等` : head
}

function normalizeMaxGaps(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_GAPS
  return Math.floor(value)
}
