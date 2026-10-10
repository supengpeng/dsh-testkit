/**
 * 敏感数据扫描 —— 夹具入库前的守门。
 *
 * 扫四类**绝对不该进仓库**的东西：
 *   ① token（API key / GitHub / Slack / AWS / Google / JWT / `key: value` 形式的赋值）
 *   ② 私钥块（`-----BEGIN ... PRIVATE KEY-----`）
 *   ③ 邮箱
 *   ④ 绝对家目录路径（`/Users/<name>`、`/home/<name>`、`C:\Users\<name>`、`~/.ssh/…`）
 *
 * ## 为什么是「扫描」而不是「脱敏」
 *
 * 脱敏是**运行时**把已经采到的内容模糊掉（见 `src/report/` 的 redact，默认关闭）；
 * 扫描是**入库前**拒绝把秘密写进夹具。前者的失效可以事后补救，后者的失效是永久的
 * ——一旦 commit，撤销也无济于事。所以这里一律**报 finding 并要求人处理**。
 *
 * `sample` 会做遮蔽：扫描结果经常被打进 CI 日志，把命中原文整段回显等于二次泄漏。
 *
 * 纯函数、无 I/O：便于单测，也便于被 `scripts/verify-fixtures.mjs` 与工具面复用。
 */

export type SensitiveKind = 'token' | 'private-key' | 'email' | 'home-path'

export interface SensitiveFinding {
  kind: SensitiveKind
  /** 1-based 行号。 */
  line: number
  /** 1-based 列号（按代码点近似）。 */
  column: number
  /** 遮蔽后的样本；用于报告，不泄漏原文。 */
  sample: string
}

interface Rule {
  kind: SensitiveKind
  re: RegExp
  /** 命中后是否保留价值（例如带引号的普通路径）；返回 undefined = 不报。 */
  keep?: (match: string) => boolean
}

/** 文档/占位用途的域名不算泄漏（否则任何示例都会被误报）。 */
const PLACEHOLDER_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'invalid', 'test'])

const RULES: readonly Rule[] = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'token', re: /\bsk-[A-Za-z0-9]{16,}\b/g },
  { kind: 'token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'token', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'token', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'token', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  {
    kind: 'token',
    re: /(?:api[_-]?key|apikey|secret|token|password|passwd|access[_-]?key|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{16,}/gi,
  },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\b/g },
  { kind: 'home-path', re: /(?:^|[\s"'(=,/])\/(?:Users|home)\/[A-Za-z0-9._-]+/g },
  { kind: 'home-path', re: /\b[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g },
  { kind: 'home-path', re: /~\/\.(?:ssh|aws|gnupg|config|netrc|npmrc)\b/g },
]

function mask(kind: SensitiveKind, text: string): string {
  switch (kind) {
    case 'email': {
      const at = text.indexOf('@')
      const local = text.slice(0, at)
      return `${local.slice(0, 1)}***@${text.slice(at + 1)}`
    }
    case 'token':
    case 'private-key':
      return `${text.slice(0, 4)}…（长度 ${text.length}）`
    default:
      return text
  }
}

function locate(text: string, index: number): { line: number; column: number } {
  let line = 1
  let last = -1
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') {
      line += 1
      last = i
    }
  }
  return { line, column: index - last }
}

/** 扫描一段文本，返回全部命中（按出现位置排序）。 */
export function scanSensitive(text: string): SensitiveFinding[] {
  const source = String(text ?? '')
  const findings: Array<SensitiveFinding & { index: number }> = []
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    let match: RegExpExecArray | null
    while ((match = re.exec(source)) !== null) {
      const hit = match[0]
      if (hit === '') {
        re.lastIndex += 1
        continue
      }
      if (rule.kind === 'email') {
        const domain = hit.slice(hit.indexOf('@') + 1).toLowerCase()
        if (PLACEHOLDER_DOMAINS.has(domain)) continue
      }
      const { line, column } = locate(source, match.index)
      findings.push({ kind: rule.kind, line, column, sample: mask(rule.kind, hit), index: match.index })
    }
  }
  findings.sort((a, b) => a.index - b.index)
  return findings.map(({ kind, line, column, sample }) => ({ kind, line, column, sample }))
}

/** 是否干净（verify 脚本与测试的便捷入口）。 */
export function isSensitiveFree(text: string): boolean {
  return scanSensitive(text).length === 0
}

/** 人类可读的一行描述（verify 脚本直接打印）。 */
export function describeFinding(finding: SensitiveFinding): string {
  const label: Record<SensitiveKind, string> = {
    token: '疑似 token / API key',
    'private-key': '私钥块',
    email: '邮箱',
    'home-path': '绝对家目录路径',
  }
  return `${label[finding.kind]}（${finding.line}:${finding.column}）：${finding.sample}`
}
