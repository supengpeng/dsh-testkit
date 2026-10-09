/**
 * 提炼闸门的数据模型。
 *
 * ## 这个模块解决什么
 *
 * 项目的输入是 issue，但**「要不要提炼」不该由模型自己决定**：
 * 自动批量提炼会同时制造两个问题——低效（读一堆用不上的 issue）
 * 与低质量（草稿堆成山，没人逐条定判据）。
 *
 * 所以提炼被建模成一个**显式的批次（batch）**，模型只能往已开启的批次里
 * 放提案，**开启**与**落地**两处都必须由人发起：
 *
 * ```
 * 用户 /testkit issue open <范围>      ← 决定"要提炼"
 *      ↓
 * 模型 testkit_propose                ← 只写 pipeline/proposals/，碰不到 cases/
 *      ↓
 * 用户 /testkit issue approve|reject  ← 决定"是否落地"，并结案本批
 *      ↓
 * 结案后才允许 open 下一批             ← 本次完成后才知道有没有下一次
 * ```
 *
 * 台账是唯一的真源（`pipeline/ledger.json`），提案正文是待落地的 case YAML。
 */

/** 批次状态。`approved` / `rejected` / `closed` 都算**已结案**。 */
export type BatchStatus = 'open' | 'approved' | 'rejected' | 'closed'

/** 单条提案的裁决状态。 */
export type ItemState = 'pending' | 'promoted' | 'rejected'

/** 提案里 `id` 的占位值：正式 TK 号只在批准落地时分配。 */
export const PROPOSAL_PLACEHOLDER_ID = 'TK-0000'

/** 占位 id 的文件名（提案目录内的规范名，与 case 的「文件名 = id」纪律对齐）。 */
export const PROPOSAL_PLACEHOLDER_FILE = `${PROPOSAL_PLACEHOLDER_ID}.yaml`

export interface QualityFinding {
  /** `block` 会拦住提案；`warn` 只提示。 */
  level: 'block' | 'warn'
  code: string
  message: string
}

export interface QualityReport {
  ok: boolean
  findings: QualityFinding[]
}

export interface PipelineItem {
  /** 批内提案号，如 `P-0001`（全局递增，跨批次唯一）。 */
  id: string
  /** 相对 `proposals/<batchId>/` 的文件名。 */
  file: string
  /** 源 issue（红线：真实 issue 派生的提案必须可溯源）。 */
  issue: string
  title: string
  kind: string
  /** 提案自带的 status（`draft` / `active` …），落地时原样保留。 */
  status: string
  state: ItemState
  /** `promoted` 后分配到的正式 case id。 */
  caseId?: string
  /** 提炼要点（给裁决的人看）。 */
  notes?: string
  quality: QualityReport
  createdAt: string
}

export interface PipelineBatch {
  /** 如 `BATCH-0001`。 */
  id: string
  /** 用户开启本批时写的范围说明——这是"要不要提炼"的原始依据。 */
  scope: string
  status: BatchStatus
  openedAt: string
  closedAt?: string
  /** 结案理由（拒绝理由 / 作废理由）。 */
  reason?: string
  items: PipelineItem[]
}

export interface PipelineLedger {
  schema: 1
  /** 下一个批次号。 */
  nextBatch: number
  /** 下一个提案号。 */
  nextProposal: number
  batches: PipelineBatch[]
}

export function emptyLedger(): PipelineLedger {
  return { schema: 1, nextBatch: 1, nextProposal: 1, batches: [] }
}

/** 写入盘上的台账文件名。 */
export const LEDGER_FILE = 'ledger.json'
/** 提案目录名。 */
export const PROPOSALS_DIR = 'proposals'
