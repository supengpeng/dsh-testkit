/**
 * 报告脱敏（`--redact`）与敏感数据扫描。
 *
 * ## 为什么需要
 *
 * 报告会进 CI 产物、PR 评论、issue 附件，甚至交给第三方（touchstone）。
 * 里面装着**被测对象的真实输出**——命令 stdout、文件内容、错误消息。
 * 这些东西里出现 token、私钥、邮箱、家目录路径是常态，而它们一旦进了
 * 公开的 CI 产物，就等于泄露。
 *
 * ## 两条纪律
 *
 * 1. **默认不脱敏**：脱敏会改写取证原文，不该在没人要求时悄悄发生。
 *    要开就显式开（配置 `redact: true` 或工具参数），并在报告里**写明脱敏了几处**。
 * 2. **只记位置，不记内容**：findings 里只保留字段路径与类型，
 *    **绝不保留命中的原文**——否则报告本身又变成了泄露源（这一点很容易写反）。
 *
 * ## 边界
 *
 * 这是**模式匹配**，不是数据分级。它能挡住"不小心把 GitHub token 贴进日志"
 * 这类事故，挡不住精心构造的泄露（比如把密钥拆成两半拼接）。
 * 用 scanFindings 做**闸门**（发现即失败），用 redactSummary 做**兜底**。
 */

import type { CaseOutcome, RunSummary } from '../runtime/runlog.js'

export interface RedactionFinding {
  /** 出现位置（字段路径，如 `cases[0].notes.stdout`）。 */
  path: string
  /** 命中的类型（如 `github-token` / `email` / `home-path`）。 */
  kind: string
}

/**
 * 敏感模式表。
 *
 * 顺序有意义：**具体模式在前，宽泛模式在后**（否则 `token=xxx` 会先被
 * 宽泛的"长随机串"吃掉，findings 的类型就没法读）。
 */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'aws-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  {
    kind: 'assigned-secret',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[=:]\s*["']?[^\s"',;]{6,}/gi,
  },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // 两种斜杠写法都要认：`C:\Users\x` 与 `C:/Users/x`（配置文件里常见后者）。
  { kind: 'home-path', re: /\b(?:[A-Za-z]:[\\/]Users[\\/]|\/home\/|\/Users\/)([^\\/\s"']+)/g },
]

/** 明显的占位/示例，不算敏感（否则文档里的 `security@example.com` 会天天红）。 */
const PLACEHOLDER_RE =
  /(?:example\.(?:com|org|net)|invalid|localhost|127\.0\.0\.1|your-|<[^>]*>|git@[A-Za-z0-9.-]+)/i

function replacement(kind: string): string {
  return `[已脱敏:${kind}]`
}

/**
 * 脱敏一段文本；同时收集命中类型。
 *
 * 注意 `home-path` 的处理：只替换**用户目录名**（`C:\Users\alice` → `C:\Users\<user>`），
 * 因为项目路径本身常常是理解问题所必需的上下文，整段抹掉反而让报告没法用。
 */
export function redactText(text: string): { text: string; findings: RedactionFinding[] } {
  const findings: RedactionFinding[] = []
  let out = text

  for (const { kind, re } of SECRET_PATTERNS) {
    const regex = new RegExp(re.source, re.flags)
    if (kind === 'home-path') {
      out = out.replace(regex, (match, user: string) => {
        if (typeof user !== 'string' || user === '' || PLACEHOLDER_RE.test(user)) return match
        findings.push({ path: '', kind })
        return match.replace(user, '<user>')
      })
      continue
    }
    out = out.replace(regex, (match: string) => {
      if (PLACEHOLDER_RE.test(match)) return match
      findings.push({ path: '', kind })
      return replacement(kind)
    })
  }

  return { text: out, findings }
}

/** 单纯扫描（不脱敏）：给 `scripts/check-secrets.mjs` 与 CI 闸门用。 */
export function scanFindings(text: string, path = ''): RedactionFinding[] {
  return redactText(text).findings.map((f) => ({ ...f, path: f.path === '' ? path : f.path }))
}

/** 递归脱敏任意值（对象/数组/字符串）；返回新值与 findings。 */
export function redactValue(
  value: unknown,
  path = '',
): { value: unknown; findings: RedactionFinding[] } {
  const findings: RedactionFinding[] = []

  const walk = (node: unknown, at: string): unknown => {
    if (typeof node === 'string') {
      const result = redactText(node)
      for (const f of result.findings) findings.push({ path: at, kind: f.kind })
      return result.text
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${at}[${i}]`))
    if (node !== null && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(node)) {
        out[key] = walk(item, at === '' ? key : `${at}.${key}`)
      }
      return out
    }
    return node
  }

  return { value: walk(value, path), findings }
}

/** findings 去重后按（路径, 类型）排序——报告里要稳定可 diff。 */
export function summarizeFindings(findings: readonly RedactionFinding[]): RedactionFinding[] {
  const seen = new Set<string>()
  const out: RedactionFinding[] = []
  for (const f of findings) {
    const key = `${f.path}\u0000${f.kind}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ path: f.path, kind: f.kind })
  }
  return out.sort((a, b) => (a.path === b.path ? a.kind.localeCompare(b.kind) : a.path.localeCompare(b.path)))
}

/**
 * 脱敏整份运行记录。
 *
 * 只动**取证内容**（`notes` / 断言实际值 / 错误文本 / 释放失败信息），
 * 不动结构字段（id / verdict / 时间）——后者是报告的骨架，改了就不可比了。
 */
export function redactSummary(summary: RunSummary): {
  summary: RunSummary
  findings: RedactionFinding[]
} {
  const findings: RedactionFinding[] = []
  const collect = (items: RedactionFinding[]): void => {
    for (const item of items) findings.push(item)
  }

  const cases: CaseOutcome[] = summary.cases.map((item, index) => {
    const at = `cases[${index}]`
    const notes = redactValue(item.notes, `${at}.notes`)
    collect(notes.findings)

    const steps = item.steps.map((step, si) => {
      const stepAt = `${at}.steps[${si}]`
      const assertions = step.assertions.map((assertion, ai) => {
        const actual = redactValue(assertion.actual, `${stepAt}.assertions[${ai}].actual`)
        collect(actual.findings)
        const message = redactText(assertion.message)
        collect(message.findings.map((f) => ({ ...f, path: `${stepAt}.assertions[${ai}].message` })))
        return { ...assertion, actual: actual.value, message: message.text }
      })
      const stepNotes =
        step.notes === undefined ? undefined : redactValue(step.notes, `${stepAt}.notes`)
      if (stepNotes !== undefined) collect(stepNotes.findings)
      const actionDetail =
        step.action?.detail === undefined ? undefined : redactText(step.action.detail)
      if (actionDetail !== undefined) {
        collect(actionDetail.findings.map((f) => ({ ...f, path: `${stepAt}.action.detail` })))
      }
      return {
        ...step,
        assertions,
        ...(stepNotes === undefined ? {} : { notes: stepNotes.value as Record<string, unknown> }),
        ...(actionDetail === undefined || step.action === undefined
          ? {}
          : { action: { ...step.action, detail: actionDetail.text } }),
      }
    })

    const error = item.error === undefined ? undefined : redactText(item.error)
    if (error !== undefined) collect(error.findings.map((f) => ({ ...f, path: `${at}.error` })))
    const skipReason = item.skipReason === undefined ? undefined : redactText(item.skipReason)
    if (skipReason !== undefined) {
      collect(skipReason.findings.map((f) => ({ ...f, path: `${at}.skipReason` })))
    }
    const repro = item.minimalRepro === undefined ? undefined : redactText(item.minimalRepro)
    if (repro !== undefined) collect(repro.findings.map((f) => ({ ...f, path: `${at}.minimalRepro` })))

    const releaseFailures = item.releaseFailures.map((failure, fi) => {
      const text = redactText(failure.error)
      collect(text.findings.map((f) => ({ ...f, path: `${at}.releaseFailures[${fi}].error` })))
      return { ...failure, error: text.text }
    })

    return {
      ...item,
      notes: notes.value as Record<string, unknown>,
      steps,
      releaseFailures,
      ...(error === undefined ? {} : { error: error.text }),
      ...(skipReason === undefined ? {} : { skipReason: skipReason.text }),
      ...(repro === undefined ? {} : { minimalRepro: repro.text }),
    }
  })

  const unique = summarizeFindings(findings)
  const redacted: RunSummary = {
    ...summary,
    cases,
    ...(unique.length === 0
      ? {}
      : {
          redaction: {
            count: unique.length,
            findings: unique,
          },
        }),
  }

  return { summary: redacted, findings: unique }
}
