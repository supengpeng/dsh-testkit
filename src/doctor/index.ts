/**
 * doctor 的公共出口。
 *
 * CLI（`dsh-testkit doctor`）与工具面（`testkit_doctor`）都从这里取，
 * 避免各自 import 到内部文件后签名漂移。
 */

export { runDoctor } from './run.js'
export { renderDoctor } from './render.js'
export { collectHostResidue, defaultTmpRoot, type HostResidueOptions } from './residue.js'
export { scanRuns, isDirectory } from './runs.js'
export type {
  DoctorCapabilitySection,
  DoctorCasesSection,
  DoctorCoverageSection,
  DoctorFinding,
  DoctorHostInput,
  DoctorInput,
  DoctorLatestRun,
  DoctorReport,
  DoctorResidue,
  DoctorRunsSection,
  DriverCapabilityRow,
  GuardEntry,
} from './types.js'
