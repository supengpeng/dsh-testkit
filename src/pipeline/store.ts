/**
 * 提炼闸门的编排层（批次台账 + 提案落盘 + 批准落地）。
 *
 * 三个公开面相一一对应三件事：
 *   · `open` / `close`   —— **人**决定这一轮要不要提炼（模型碰不到）
 *   · `propose`          —— **模型**只能把提案写进 `pipeline/proposals/`，永远不碰 `cases/`
 *   · `approve`/`reject` —— **人**决定提案是否落地，并结案本批
 *
 * 纪律：
 *   ① 提案**质量预检不过就不落盘**——proposals/ 里不留垃圾（这是"高效"的来源：
 *      读不到半成品，就不会出现"看起来在测、其实没测"的假象）
 *   ② 批准时先对**全部目标**做预检，任一条不合格就整体不落地（不做半落地）
 *   ③ 落地失败**回滚**已写文件并重建索引
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { writeIndexFile } from '../cases/index-file.js'
import {
  blankLedger,
  closeBatch,
  findBatch,
  findItem,
  findOpenBatch,
  openBatch,
  pad4,
  patchBatch,
  settleBatchIfDone,
  takeProposalId,
  type GateFailure,
} from './ledger.js'
import { checkProposalQuality } from './quality.js'
import {
  LEDGER_FILE,
  PROPOSALS_DIR,
  type BatchStatus,
  type PipelineBatch,
  type PipelineItem,
  type PipelineLedger,
  type QualityFinding,
  type QualityReport,
} from './types.js'

export interface PipelineStoreOptions {
  /** 闸门数据根（`<包根>/pipeline`）。 */
  pipelineDir: string
  /** 场景真源目录（`<包根>/cases`）——只有 approve 会写它。 */
  casesDir: string
}

export interface ProposeInput {
  yamlText: string
  notes?: string
}

export interface ProposeSuccess {
  ok: true
  batchId: string
  proposalId: string
  /** 相对 `pipeline/` 的路径。 */
  relPath: string
  title: string
  kind: string
  status: string
  quality: QualityReport
}

export interface ProposeFailure {
  ok: false
  error: string
  findings?: QualityFinding[]
}

export type ProposeResult = ProposeSuccess | ProposeFailure

export interface PromotedItem {
  proposalId: string
  caseId: string
  relPath: string
  status: string
}

export interface ApproveSuccess {
  ok: true
  batchId: string
  batchStatus: BatchStatus
  promoted: PromotedItem[]
  remaining: number
  indexCount: number
}

export interface ApproveFailure {
  ok: false
  error: string
  problems?: string[]
}

export type ApproveResult = ApproveSuccess | ApproveFailure

export interface RejectSuccess {
  ok: true
  batchId: string
  batchStatus: BatchStatus
  rejected: string[]
  remaining: number
}

export type RejectResult = RejectSuccess | ApproveFailure

export class PipelineStore {
  private readonly pipelineDir: string
  private readonly casesDir: string
  private readonly ledgerPath: string
  private readonly proposalsDir: string

  constructor(options: PipelineStoreOptions) {
    this.pipelineDir = options.pipelineDir
    this.casesDir = options.casesDir
    this.ledgerPath = join(this.pipelineDir, LEDGER_FILE)
    this.proposalsDir = join(this.pipelineDir, PROPOSALS_DIR)
  }

  /* ------------------------------------------------------------ 台账 IO -- */

  /** 读台账；损坏时抛错（**不静默返回空台账**——那会覆盖掉历史）。 */
  read(): PipelineLedger {
    if (!existsSync(this.ledgerPath)) return blankLedger()
    const raw = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Partial<PipelineLedger>
    return {
      schema: 1,
      nextBatch: Number(raw.nextBatch ?? 1),
      nextProposal: Number(raw.nextProposal ?? 1),
      batches: Array.isArray(raw.batches) ? (raw.batches as PipelineBatch[]) : [],
    }
  }

  write(ledger: PipelineLedger): void {
    mkdirSync(this.pipelineDir, { recursive: true })
    writeFileSync(this.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  }

  /* -------------------------------------------------------- 人的闸门 -- */

  /** 开启一轮提炼：**唯一**能开启"要不要提炼"的入口。 */
  open(scope: string, now = new Date().toISOString()): { ok: true; batch: PipelineBatch } | GateFailure {
    const ledger = this.read()
    const result = openBatch(ledger, scope, now)
    if (!result.ok) return result
    this.write(result.ledger)
    return { ok: true, batch: result.batch }
  }

  /** 作废当前 open 批次（本轮不提炼了）。 */
  close(reason?: string, now = new Date().toISOString()): { ok: true; batch: PipelineBatch } | GateFailure {
    const ledger = this.read()
    const batch = findOpenBatch(ledger)
    if (!batch) return { ok: false, error: '当前没有 open 批次，无需作废' }
    const next = closeBatch(ledger, batch.id, now, reason)
    this.write(next)
    return { ok: true, batch: findBatch(next, batch.id)! }
  }

  /** 看台账：当前批次、每条的裁决状态与预检结论、历史批次。 */
  statusText(): string {
    const ledger = this.read()
    const lines: string[] = []
    const open = findOpenBatch(ledger)

    if (!open) {
      lines.push('当前没有 open 批次 —— 提炼必须先由人开启：')
      lines.push('  /testkit issue open <范围说明>')
    } else {
      lines.push(`当前批次：${open.id}（open，开启于 ${open.openedAt}）`)
      lines.push(`范围：${open.scope}`)
      lines.push(`提案 ${open.items.length} 条：`)
      if (open.items.length === 0) {
        lines.push('  （还没有提案；模型可调用 testkit_propose 提交）')
      }
      for (const item of open.items) {
        lines.push(renderItemLine(item))
      }
      lines.push('')
      lines.push('裁决：/testkit issue approve <P-xxxx|--all> ｜ /testkit issue reject <P-xxxx|--all> [理由]')
      lines.push('      /testkit issue show <P-xxxx> 看正文 ｜ /testkit issue close [理由] 作废本批')
    }

    const history = ledger.batches.filter((b) => b.status !== 'open')
    if (history.length > 0) {
      lines.push('')
      lines.push('历史批次（结案后才允许开启下一批）：')
      for (const b of history.slice(-8)) {
        const promoted = b.items.filter((i) => i.state === 'promoted').length
        const rejected = b.items.filter((i) => i.state === 'rejected').length
        const pending = b.items.filter((i) => i.state === 'pending').length
        lines.push(
          `  ${b.id} [${b.status}] 落地 ${promoted} / 拒绝 ${rejected} / 未决 ${pending}` +
            `${b.closedAt ? ` · ${b.closedAt}` : ''} · ${b.scope}`,
        )
        if (b.reason) lines.push(`    理由：${b.reason}`)
      }
    }
    return lines.join('\n')
  }

  /** 看一份提案的正文与预检明细（人裁决前用它看内容）。 */
  show(proposalId: string): { ok: true; text: string } | GateFailure {
    const ledger = this.read()
    const found = findItem(ledger, proposalId)
    if (!found) return { ok: false, error: `找不到提案 ${proposalId}` }
    const abs = this.itemPath(found.batch.id, found.item)
    if (!existsSync(abs)) return { ok: false, error: `提案文件不存在：${abs}` }

    const body = readFileSync(abs, 'utf8')
    const shown = body.length > 6000 ? `${body.slice(0, 6000)}\n…（截断）` : body
    const quality = renderQuality(found.item.quality)
    return {
      ok: true,
      text: [
        `${found.item.id}（批次 ${found.batch.id}，${found.item.state}）`,
        `源 issue：${found.item.issue}`,
        `文件名：${found.item.file}`,
        quality,
        '',
        shown,
      ].join('\n'),
    }
  }

  /* ------------------------------------------------------ 模型的提案 -- */

  /**
   * 提交一条提案。
   *
   * **闸门一**：没有 open 批次直接拒绝——模型无法自己开启一轮提炼。
   * **闸门二**：质量预检不过不落盘——提交必须一次到位。
   */
  propose(input: ProposeInput, now = new Date().toISOString()): ProposeResult {
    let ledger: PipelineLedger
    try {
      ledger = this.read()
    } catch (error) {
      return { ok: false, error: `台账无法读取：${error instanceof Error ? error.message : String(error)}` }
    }

    const batch = findOpenBatch(ledger)
    if (!batch) {
      return {
        ok: false,
        error:
          '本轮提炼未开启：提炼与否由人决定。请先让用户执行 /testkit issue open <范围说明>，' +
          '再提交提案。',
      }
    }

    // 先粗解析一次，只为拿 title / kind 生成文件名（完整校验在 checkProposalQuality）
    const rough = safeParse(input.yamlText)
    const title = typeof rough?.title === 'string' ? rough.title : ''
    const kind = typeof rough?.kind === 'string' ? rough.kind : ''
    const issueRaw = isObject(rough?.source) ? rough.source.issue : undefined
    const issue = typeof issueRaw === 'string' ? issueRaw : ''

    const taken = takeProposalId(ledger)
    const slug = slugify(title, issueNumber(issue) ? `issue-${issueNumber(issue)}` : kind || 'proposal')
    const file = `${taken.id}-${slug}.yaml`
    // 正斜杠拼接：这是给人看的相对路径（工具回显 / 台账），跨平台显示一致
    const relPath = `${PROPOSALS_DIR}/${batch.id}/${file}`

    const checked = checkProposalQuality({ yamlText: input.yamlText, fileName: file })
    if (!checked.report.ok) {
      return {
        ok: false,
        error: '提案未通过质量预检，**未写盘**。修好下面这些问题后再提交：',
        findings: checked.report.findings,
      }
    }
    const scenario = checked.scenario
    if (!scenario) return { ok: false, error: '提案解析异常：缺少场景对象' }

    mkdirSync(join(this.proposalsDir, batch.id), { recursive: true })
    writeFileSync(join(this.pipelineDir, relPath), input.yamlText, 'utf8')

    const item: PipelineItem = {
      id: taken.id,
      file,
      issue: typeof scenario.source.issue === 'string' ? scenario.source.issue : '',
      title: scenario.title,
      kind: scenario.kind,
      status: scenario.status ?? 'active',
      state: 'pending',
      ...(input.notes && input.notes.trim() !== '' ? { notes: input.notes.trim() } : {}),
      quality: checked.report,
      createdAt: now,
    }

    // `taken.ledger` 已经把 nextProposal 推进过了，这里只补 items
    const next = patchBatch(taken.ledger, batch.id, (b) => ({ ...b, items: [...b.items, item] }))
    this.write(next)

    return {
      ok: true,
      batchId: batch.id,
      proposalId: item.id,
      relPath,
      title: item.title,
      kind: item.kind,
      status: item.status,
      quality: checked.report,
    }
  }

  /* -------------------------------------------------------- 人的裁决 -- */

  /**
   * 批准并落地：把提案写进 `cases/TK-XXXX.yaml` 并重建索引。
   *
   * 落地前**再查一遍质量**（文件在盘上期间可能被改过），
   * 且任一条不合格就整体不落地。
   */
  approve(
    targets: 'all' | string[],
    now = new Date().toISOString(),
  ): ApproveResult {
    let ledger: PipelineLedger
    try {
      ledger = this.read()
    } catch (error) {
      return { ok: false, error: `台账无法读取：${error instanceof Error ? error.message : String(error)}` }
    }

    const batch = findOpenBatch(ledger)
    if (!batch) return { ok: false, error: '当前没有 open 批次：没有可批准的东西' }

    const selection = selectPending(batch, targets)
    if (!selection.ok) return selection

    // ---- 预检全部目标 ----
    const problems: string[] = []
    const plans: Array<{ item: PipelineItem; text: string }> = []
    for (const item of selection.items) {
      const abs = this.itemPath(batch.id, item)
      if (!existsSync(abs)) {
        problems.push(`${item.id}：提案文件丢失（${item.file}）`)
        continue
      }
      const text = readFileSync(abs, 'utf8')
      const checked = checkProposalQuality({ yamlText: text, fileName: item.file })
      if (!checked.report.ok) {
        for (const f of checked.report.findings.filter((x) => x.level === 'block')) {
          problems.push(`${item.id}：${f.message}`)
        }
        continue
      }
      plans.push({ item, text })
    }
    if (problems.length > 0) {
      return {
        ok: false,
        error: '批准前的质量预检未通过，**未落地任何一条**。修好或 reject 掉这些提案后重试：',
        problems,
      }
    }

    // ---- 分配正式 TK 号并写盘 ----
    let nextId = this.maxUsedCaseId() + 1
    const promoted: PromotedItem[] = []
    const writtenFiles: string[] = []
    const caseIdByProposal = new Map<string, string>()

    try {
      for (const plan of plans) {
        const caseId = `TK-${pad4(nextId)}`
        nextId += 1
        const rewritten = rewriteId(plan.text, caseId)
        if (rewritten === undefined) {
          throw new Error(`${plan.item.id}：正文里找不到顶层 id 行，无法分配 ${caseId}`)
        }
        const target = join(this.casesDir, `${caseId}.yaml`)
        if (existsSync(target)) throw new Error(`${caseId} 已存在，拒绝覆盖`)
        mkdirSync(this.casesDir, { recursive: true })
        writeFileSync(target, rewritten, 'utf8')
        writtenFiles.push(target)
        caseIdByProposal.set(plan.item.id, caseId)
        promoted.push({
          proposalId: plan.item.id,
          caseId,
          relPath: join('cases', `${caseId}.yaml`),
          status: plan.item.status,
        })
      }
    } catch (error) {
      for (const file of writtenFiles) {
        try {
          rmSync(file, { force: true })
        } catch {
          /* 回滚尽力而为 */
        }
      }
      try {
        writeIndexFile(this.casesDir)
      } catch {
        /* 索引回滚尽力而为 */
      }
      return {
        ok: false,
        error: `落地失败，已回滚 ${writtenFiles.length} 个文件：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // ---- 重建索引（失败也要回滚文件） ----
    let indexCount = 0
    try {
      indexCount = writeIndexFile(this.casesDir).count
    } catch (error) {
      for (const file of writtenFiles) {
        try {
          rmSync(file, { force: true })
        } catch {
          /* 尽力而为 */
        }
      }
      try {
        writeIndexFile(this.casesDir)
      } catch {
        /* 尽力而为 */
      }
      return {
        ok: false,
        error: `索引重建失败，已回滚落地文件：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    // ---- 记账 + 结案判定 ----
    let next = patchBatch(ledger, batch.id, (b) => ({
      ...b,
      items: b.items.map((i) => {
        const caseId = caseIdByProposal.get(i.id)
        return caseId ? { ...i, state: 'promoted' as const, caseId } : i
      }),
    }))
    next = settleBatchIfDone(next, batch.id, now, `批准落地 ${promoted.length} 条`)
    this.write(next)

    const settled = findBatch(next, batch.id)
    return {
      ok: true,
      batchId: batch.id,
      batchStatus: settled?.status ?? 'open',
      promoted,
      remaining: settled ? settled.items.filter((i) => i.state === 'pending').length : 0,
      indexCount,
    }
  }

  /** 拒绝提案：只改台账，文件保留在 `proposals/` 里留痕。 */
  reject(
    targets: 'all' | string[],
    reason?: string,
    now = new Date().toISOString(),
  ): RejectResult {
    let ledger: PipelineLedger
    try {
      ledger = this.read()
    } catch (error) {
      return { ok: false, error: `台账无法读取：${error instanceof Error ? error.message : String(error)}` }
    }

    const batch = findOpenBatch(ledger)
    if (!batch) return { ok: false, error: '当前没有 open 批次：没有可拒绝的东西' }

    const selection = selectPending(batch, targets)
    if (!selection.ok) return selection

    const ids = new Set(selection.items.map((i) => i.id))
    let next = patchBatch(ledger, batch.id, (b) => ({
      ...b,
      items: b.items.map((i) => (ids.has(i.id) ? { ...i, state: 'rejected' as const } : i)),
    }))
    next = settleBatchIfDone(next, batch.id, now, reason ?? `拒绝 ${ids.size} 条`)
    this.write(next)

    const settled = findBatch(next, batch.id)
    return {
      ok: true,
      batchId: batch.id,
      batchStatus: settled?.status ?? 'open',
      rejected: [...ids],
      remaining: settled ? settled.items.filter((i) => i.state === 'pending').length : 0,
    }
  }

  /* ------------------------------------------------------------ 内部 -- */

  private itemPath(batchId: string, item: PipelineItem): string {
    return join(this.proposalsDir, batchId, item.file)
  }

  private maxUsedCaseId(): number {
    if (!existsSync(this.casesDir)) return 0
    return readdirSync(this.casesDir)
      .map((f) => /^TK-(\d{4})\.yaml$/.exec(f))
      .reduce((max, m) => (m ? Math.max(max, Number(m[1])) : max), 0)
  }
}

/* -------------------------------------------------------------- 小工具 -- */

function selectPending(
  batch: PipelineBatch,
  targets: 'all' | string[],
): { ok: true; items: PipelineItem[] } | ApproveFailure {
  const pending = batch.items.filter((i) => i.state === 'pending')
  if (pending.length === 0) return { ok: false, error: `批次 ${batch.id} 里没有待裁决的提案` }
  if (targets === 'all') return { ok: true, items: pending }
  if (targets.length === 0) return { ok: false, error: '未指定提案号：用 P-0001 … 或 --all' }
  const missing = targets.filter((t) => !pending.some((i) => i.id === t))
  if (missing.length > 0) {
    return { ok: false, error: `这些提案不在待裁决列表里：${missing.join(', ')}（可能是已裁决或不属于本批）` }
  }
  return { ok: true, items: pending.filter((i) => targets.includes(i.id)) }
}

/** 把顶层的 `id:` 换成正式 case id，保留行尾注释。 */
function rewriteId(text: string, caseId: string): string | undefined {
  if (!/^id:[^\n]*$/m.test(text)) return undefined
  return text.replace(/^(id:[ \t]*)(\S+)/m, `$1${caseId}`)
}

function renderItemLine(item: PipelineItem): string {
  const flag = item.state === 'promoted' ? `✅ 已落地 ${item.caseId ?? ''}` : item.state === 'rejected' ? '❌ 已拒绝' : '⏳ 待裁决'
  const warns = item.quality.findings.filter((f) => f.level === 'warn')
  const warnText = warns.length > 0 ? ` · ${warns.length} 条提醒：${warns.map((w) => w.message).join('；')}` : ''
  return `  ${item.id} (${item.kind}/${item.status}) [${flag}] ${item.title} · ${item.issue}${warnText}`
}

function renderQuality(report: QualityReport): string {
  if (report.findings.length === 0) return '质量预检：通过（无提醒）'
  return [
    '质量预检：',
    ...report.findings.map((f) => `  [${f.level === 'block' ? '阻断' : '提醒'}] ${f.message}`),
  ].join('\n')
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const raw = parseYaml(text)
    return isObject(raw) ? raw : undefined
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function issueNumber(issue: string): string | undefined {
  return /\/issues\/(\d+)/.exec(issue)?.[1]
}

function slugify(text: string, fallback: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  return ascii !== '' ? ascii : fallback
}
