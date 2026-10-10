/**
 * 宿主体检（doctor）的数据形状。
 *
 * 设计原则：**报告即证据**。每个结论都要带上"依据是什么"——
 * 哪些能力缺、哪些 driver 因此会跳过、探到了什么、探不到什么。
 * 只写"健康 / 不健康"的报告没人能用它做决定。
 */

import type { CaseRegistry } from '../cases/registry.js'
import type { HostCapability } from '../cases/types.js'
import type { CoverageGap, CoverageReport } from '../insight/coverage.js'
import type { PortProbeResult, ProcessProbeResult } from '../isolation/probes.js'
import type { DriverRegistry } from '../kinds/types.js'
import type { CleanupRecord, RunTotals } from '../runtime/runlog.js'

/** 宿主面（能力集合 + 环境事实）。 */
export interface DoctorHostInput {
  capabilities: ReadonlySet<HostCapability> | readonly HostCapability[]
  env: {
    dshVersion: string
    platform: string
    nodeVersion: string
  }
}

/** `runDoctor` 的入参。除 `residue` / `drivers` / `maxGaps` 外均为必填。 */
export interface DoctorInput {
  /** 已 reload 的场景注册表（doctor 只读，不改它）。 */
  registry: CaseRegistry
  host: DoctorHostInput
  /** `package.json` 的 scripts（守卫清单从这里读）。 */
  scripts: Record<string, string>
  /** 运行产物目录（`runs/<RUN-ID>/run.json`）。 */
  runsDir: string
  /** 场景目录（与 registry.dir 通常是同一个，显式给便于报告里直接回显）。 */
  casesDir: string
  /** driver 注册中心；缺省 `createDriverRegistry()`（真实 12 个 driver）。 */
  drivers?: DriverRegistry
  /** 残留探测结果；省略 = 报告如实写"未探测"，**不写"干净"**。 */
  residue?: DoctorResidue
  /** 覆盖缺口最多列几条（缺省 5）。 */
  maxGaps?: number
}

/** 驱动 × 能力：这条 kind 在本宿主上会不会因缺能力而跳过。 */
export interface DriverCapabilityRow {
  kind: string
  description: string
  /** driver 声明的依赖（去重、保序）。 */
  requires: HostCapability[]
  /** 声明了但宿主没有的能力（空 = 不会因能力缺失跳过）。 */
  missing: HostCapability[]
  /** 会不会跳过（= `missing.length > 0`）。 */
  willSkip: boolean
  /** 跳过原因；与 runner 的 skipReason **同口径**（`宿主缺少能力：…`）。 */
  reason?: string
  /** 该 kind 在注册表里的场景数。 */
  scenarios: number
  /** 其中 active 的场景数（真正会被跳过的那些）。 */
  active: number
}

/** `package.json` scripts 里的守卫条目。 */
export interface GuardEntry {
  name: string
  command: string
  group: 'verify' | 'test'
}

export interface DoctorCasesSection {
  dir: string
  scenarios: number
  kinds: number
  active: number
  draft: number
  retired: number
  blocked: number
  /** 校验失败 / 读取失败的场景文件数。 */
  invalid: number
  /** 索引与场景集合不一致的问题条数。 */
  indexIssues: number
}

export interface DoctorLatestRun {
  runId: string
  startedAt?: string
  finishedAt?: string
  totals: RunTotals
  reportPath: string
}

export interface DoctorRunsSection {
  dir: string
  exists: boolean
  /** 目录里能读到的运行次数（含最近一次之外的历史）。 */
  runCount: number
  latest?: DoctorLatestRun
  notes: string[]
}

/** 残留探测结论（由 `collectHostResidue` 或 runner 现场探测提供）。 */
export interface DoctorResidue {
  /** 探测了哪些目标（人类可读，例如 `os.tmpdir() 下的 dsh-testkit-* 目录`）。 */
  targets: string[]
  record: CleanupRecord
  /** 探测过程的诚实说明（探不到、命令不可用、未探测……）。 */
  notes: string[]
  /** 端口探照明细（可选，只读展示）。 */
  ports?: PortProbeResult[]
  /** 进程探照明细（可选，只读展示）。 */
  processes?: ProcessProbeResult
}

export interface DoctorCoverageSection {
  totals: CoverageReport['totals']
  /** 覆盖矩阵行数（= 已注册 kind 数）。 */
  kinds: number
  /** 缺口总数（`gaps` 只保留前 N 条）。 */
  gapCount: number
  /** 高位缺口数（严重度 high）。 */
  highGapCount: number
  gaps: CoverageGap[]
  smokeMs: number
}

export interface DoctorCapabilitySection {
  /** 宿主实际具备的能力（排序）。 */
  present: HostCapability[]
  /** 全部 driver 依赖的并集（排序）。 */
  requiredByDrivers: HostCapability[]
  /** 前者减后者：缺哪些（排序）。 */
  missing: HostCapability[]
}

export interface DoctorFinding {
  level: 'error' | 'warn' | 'info'
  code: string
  message: string
  hint?: string
}

export interface DoctorReport {
  /** 无 error 级发现即为 true。 */
  ok: boolean
  generatedAt: string
  host: {
    dshVersion: string
    nodeVersion: string
    platform: string
    /** 真实运行时（进程自己报的），与宿主声明可能不同。 */
    runtime: { node: string; platform: string; arch: string }
  }
  capabilities: DoctorCapabilitySection
  drivers: DriverCapabilityRow[]
  guards: GuardEntry[]
  cases: DoctorCasesSection
  runs: DoctorRunsSection
  residue: DoctorResidue
  coverage: DoctorCoverageSection
  findings: DoctorFinding[]
}
