/**
 * 批次状态机的**纯函数**部分（不碰文件系统，便于单测）。
 *
 * 台账不可变更新：每个函数都返回新的 ledger，而不是就地改——
 * 这样"批准到一半失败"时，回滚只是丢掉新 ledger 的事。
 */

import {
  emptyLedger,
  type BatchStatus,
  type PipelineBatch,
  type PipelineItem,
  type PipelineLedger,
} from './types.js'

export type GateFailure = { ok: false; error: string }

export function blankLedger(): PipelineLedger {
  return emptyLedger()
}

export function findOpenBatch(ledger: PipelineLedger): PipelineBatch | undefined {
  return ledger.batches.find((b) => b.status === 'open')
}

export function findBatch(ledger: PipelineLedger, batchId: string): PipelineBatch | undefined {
  return ledger.batches.find((b) => b.id === batchId)
}

export function findItem(
  ledger: PipelineLedger,
  proposalId: string,
): { batch: PipelineBatch; item: PipelineItem } | undefined {
  for (const batch of ledger.batches) {
    const item = batch.items.find((i) => i.id === proposalId)
    if (item) return { batch, item }
  }
  return undefined
}

/** 批次是否已结案（没有待裁决的提案）。 */
export function isBatchSettled(batch: PipelineBatch): boolean {
  return batch.items.every((i) => i.state !== 'pending')
}

/**
 * 开启一个新批次。
 *
 * **这是"要不要提炼"的唯一入口**，且同一时间只允许一个 open 批次——
 * 后者同时实现两件事：一次一批（不并行堆草稿）、
 * 以及「本次提炼完成后用户同意才能进行下次提炼」（没结案就开不了下一批）。
 */
export function openBatch(
  ledger: PipelineLedger,
  scope: string,
  now: string,
): { ok: true; ledger: PipelineLedger; batch: PipelineBatch } | GateFailure {
  const trimmed = scope.trim()
  if (trimmed === '') {
    return { ok: false, error: '开启提炼时必须写明范围（要提炼哪些 issue / 到什么程度）' }
  }
  const existing = findOpenBatch(ledger)
  if (existing) {
    return {
      ok: false,
      error:
        `已有未结案的批次 ${existing.id}（范围：${existing.scope}）——` +
        `本批必须先 approve / reject / close 结案，才允许开启下一批`,
    }
  }

  const batch: PipelineBatch = {
    id: `BATCH-${pad4(ledger.nextBatch)}`,
    scope: trimmed,
    status: 'open',
    openedAt: now,
    items: [],
  }
  return {
    ok: true,
    batch,
    ledger: { ...ledger, nextBatch: ledger.nextBatch + 1, batches: [...ledger.batches, batch] },
  }
}

/** 就地替换某个批次（返回新 ledger）。 */
export function patchBatch(
  ledger: PipelineLedger,
  batchId: string,
  patch: (batch: PipelineBatch) => PipelineBatch,
): PipelineLedger {
  return {
    ...ledger,
    batches: ledger.batches.map((b) => (b.id === batchId ? patch(b) : b)),
  }
}

/** 取一个新提案号（并推进计数器）。 */
export function takeProposalId(ledger: PipelineLedger): { id: string; ledger: PipelineLedger } {
  return {
    id: `P-${pad4(ledger.nextProposal)}`,
    ledger: { ...ledger, nextProposal: ledger.nextProposal + 1 },
  }
}

/**
 * 裁决后自动结案：**没有 pending 提案**就算本批结束。
 *
 * 结案状态按事实取名：有落地就是 `approved`，只有拒绝就是 `rejected`。
 * 用户显式 `close`（不裁决就作废）走另一条路，状态是 `closed`。
 */
export function settleBatchIfDone(
  ledger: PipelineLedger,
  batchId: string,
  now: string,
  reason?: string,
): PipelineLedger {
  const batch = findBatch(ledger, batchId)
  if (!batch || batch.status !== 'open' || !isBatchSettled(batch)) return ledger

  const status: BatchStatus = batch.items.some((i) => i.state === 'promoted') ? 'approved' : 'rejected'
  return patchBatch(ledger, batchId, (b) => ({
    ...b,
    status,
    closedAt: now,
    ...(reason ? { reason } : {}),
  }))
}

/** 用户显式作废当前批次（不裁决未决提案）。 */
export function closeBatch(
  ledger: PipelineLedger,
  batchId: string,
  now: string,
  reason?: string,
): PipelineLedger {
  return patchBatch(ledger, batchId, (b) => ({
    ...b,
    status: 'closed',
    closedAt: now,
    ...(reason ? { reason } : {}),
  }))
}

export function pad4(n: number): string {
  return String(n).padStart(4, '0')
}
