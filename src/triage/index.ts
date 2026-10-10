/**
 * 自动 triage（文档 §7.5 + §8.2）：把"失败之后怎么办"从人工翻日志，
 * 变成**可生成的产物 + 可路由的归属**。
 *
 * 模块分工：
 *   · `artifacts.ts` —— 共用原语 + 两条纪律（只生成文本 / 正文不含取证原文）
 *   · `issue.ts`     —— `buildIssueDraft`：失败 → issue 草稿（标题 / 正文 / 标签 / 指派）
 *   · `comment.ts`   —— `buildPrComment`：失败或全绿 → PR 评论（全绿也有简短证明）
 *   · `route.ts`     —— `routeByOwner`：按 owner 分组，无主归 `(未指派)` 并提示补 owner
 *
 * 三个入口都是**纯函数**：给定同一份 `RunSummary` 得到同一份文本/分组，
 * 不联网、不写盘、不改入参。发布动作（建 issue / 贴评论）由 CI / CLI 执行。
 */

export {
  ELLIPSIS,
  LABELS_BY_CATEGORY,
  LABEL_NEEDS_TRIAGE,
  LIST_LIMIT,
  NO_OWNER,
  NO_OWNER_REASON,
  DETAIL_LIMIT,
  REPRO_LIMIT,
  SNIPPET_LIMIT,
  TITLE_LIMIT,
  assertionDetail,
  categoryLabel,
  collapseWhitespace,
  escapeCell,
  evidenceLines,
  failureFacts,
  failingCases,
  isFailing,
  labelsFor,
  ownerLabel,
  ownerOf,
  safeSnippet,
  summarizeIds,
  symptom,
  truncate,
  type AssertionDetail,
  type EvidenceOptions,
  type FailureFacts,
} from './artifacts.js'

export {
  buildIssueDraft,
  type IssueDraft,
  type IssueDraftOptions,
} from './issue.js'

export { buildPrComment, type PrCommentOptions } from './comment.js'

export { routeByOwner, type OwnerRoute } from './route.js'
