/**
 * 提案的质量预检——把 `docs/ISSUE-PIPELINE.md` §6 的「case 质量红线」
 * 从**人的自觉**变成**机器的闸门**。
 *
 * 两道闸门用同一份判据：提案入库时（`testkit_propose`）与批准落地前
 * （`/testkit issue approve`）。后者是必要的——提案文件在盘上期间可能被改，
 * 落地前必须再查一次。
 *
 * 判据的取舍：**只把机器真能判定的写成 `block`**。
 * "可回滚""有对照"这类需要人来判断的，要么降级成 `warn`，要么不写，
 * 否则就会制造"看起来在测、其实没测"的假象——那正是本项目最反对的事。
 */

import { parse as parseYaml } from 'yaml'

import { validateScenario, type ValidationIssue } from '../cases/schema.js'
import type { Scenario } from '../cases/types.js'
import { PROPOSAL_PLACEHOLDER_ID, type QualityFinding, type QualityReport } from './types.js'

/** 明确未完成的人工标记；残留即视为草稿没写完。 */
const TODO_PATTERNS: readonly RegExp[] = [/TODO\(人工\)/, /\bTODO:/]

/** 判定词里属于"负向"的那些——只有负向断言时，缺少"该成功"的对照。 */
const NEGATIVE_WORDS = new Set(['isNot', 'notIs', 'notExists', 'notContains', 'throws'])

export interface QualityCheckInput {
  yamlText: string
  /** 用于 schema 校验的文件名（提案文件名与 `id` 不对应，故豁免一致性检查）。 */
  fileName: string
}

export interface QualityCheckResult {
  report: QualityReport
  /** 解析 + 校验通过时的场景对象（供落地时分配正式 id）。 */
  scenario?: Scenario
}

export function checkProposalQuality(input: QualityCheckInput): QualityCheckResult {
  const findings: QualityFinding[] = []
  const block = (code: string, message: string): void => {
    findings.push({ level: 'block', code, message })
  }
  const warn = (code: string, message: string): void => {
    findings.push({ level: 'warn', code, message })
  }

  // ---- ① YAML 必须能解析 ----
  let raw: unknown
  try {
    raw = parseYaml(input.yamlText)
  } catch (error) {
    block('yaml-parse', `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`)
    return { report: { ok: false, findings } }
  }
  if (raw === null || raw === undefined) {
    block('yaml-empty', '提案正文为空')
    return { report: { ok: false, findings } }
  }

  // ---- ② schema 校验（豁免"文件名 = id"，因为未分配正式 id） ----
  const validated = validateScenario(raw, input.fileName, { allowIdMismatch: true })
  if (!validated.ok || !validated.scenario) {
    for (const issue of validated.issues) block('schema', formatIssue(issue))
    return { report: { ok: false, findings } }
  }
  const scenario = validated.scenario

  // ---- ③ 占位 id 必须是约定的那一个 ----
  // 正式 TK 号只能由 approve 分配；提案里手写真实号会破坏「ID 只增不复用」。
  if (scenario.id !== PROPOSAL_PLACEHOLDER_ID) {
    block(
      'placeholder-id',
      `提案的 id 必须写成占位值 ${PROPOSAL_PLACEHOLDER_ID}（落地时由 approve 分配正式 TK 号），实际是 ${scenario.id}`,
    )
  }

  // ---- ④ 可溯源：真实 issue 派生 ----
  const issue = scenario.source.issue
  if (typeof issue !== 'string' || issue.trim() === '') {
    block('no-source', 'source.issue 不能为空：提案必须能溯源到一条真实 issue')
  }
  if (!scenario.source.summary || String(scenario.source.summary).trim() === '') {
    warn('no-summary', 'source.summary 为空：现象 / 最小复现 / 判据的建议都写进这里，方便裁决')
  }

  // ---- ⑤ 草稿没写完 ----
  for (const pattern of TODO_PATTERNS) {
    if (pattern.test(input.yamlText)) {
      block('unfinished-todo', '正文里还有 TODO 标记：判据必须由人来定，填完再提交提案')
      break
    }
  }

  // ---- ⑥ 可断言：至少一条机器可判定的断言 ----
  const assertions = scenario.steps.flatMap((step) => step.expect ?? [])
  if (assertions.length === 0) {
    block('no-assertion', '没有任何 expect 断言：不可判定的场景不能进回归集')
  }

  // ---- ⑦ 有对照（机器只能给弱信号，所以是 warn） ----
  if (assertions.length > 0) {
    const positive = assertions.filter((a) => {
      const word = Object.keys(a as unknown as Record<string, unknown>).find((k) =>
        ['is', 'exists', 'contains', 'matches', 'atLeast', 'atMost', 'length', 'lengthAtLeast', 'lengthAtMost'].includes(k),
      )
      return word !== undefined && !NEGATIVE_WORDS.has(word)
    })
    if (positive.length === 0) {
      warn(
        'no-control',
        '只有负向断言（throws / notExists…）：补一条「该成功的地方成功了」的对照断言，否则分不清"修好了"与"根本没跑到"',
      )
    }
  }

  const ok = !findings.some((f) => f.level === 'block')
  return { report: { ok, findings }, scenario }
}

/** 把校验问题渲染成一行（提案预检的输出要可直接给人看）。 */
function formatIssue(issue: ValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message
}
