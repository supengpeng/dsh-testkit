/**
 * 敏感数据闸门：扫仓库里**会进产物或进版本库**的文件，发现疑似凭据即非 0 退出。
 *
 * 为什么需要（文档 §7.1「供应链安全 / 数据隐私」）：
 *   · `report.md` / `run.json` / `junit.xml` 会进 CI 产物、PR 评论、issue 附件；
 *   · `cases/` 与 `fixtures/` 会被打包发布（`files` 白名单里有它们）；
 *   · 一旦把 token / 私钥 / 内部邮箱写进这些地方，泄露是**不可撤回**的。
 *
 * 纪律：**只输出位置与类型，绝不输出命中的原文**——否则这个脚本自己就成了泄露渠道。
 *
 * 用法：`node scripts/check-secrets.mjs [目录]`（默认包根）
 * 退出码：0 = 干净；1 = 有命中。
 *
 * 误报处理：把该行加注释标记 `secrets-ok`，或在 `src/report/redact.ts` 的
 * `PLACEHOLDER_RE` 里补上占位域；**不要**为了让它变绿而删检查项。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 复用报告层的模式表（`src/report/redact.ts`）——单源，别在这里再抄一份。
// 走 lib/ 是因为脚本跑的是**已构建**产物（与 scripts/export-scenarios.mjs 同惯例）。
let scanFindings
try {
  ;({ scanFindings } = await import('../lib/report/redact.js'))
} catch (error) {
  console.error(
    `[check-secrets] 需要先构建：node scripts/build-lock.mjs（原始错误：${
      error instanceof Error ? error.message : String(error)
    }）`,
  )
  process.exit(1)
}

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(process.argv[2] ?? join(here, '..'))

/** 要扫的东西：会入库或会进产物的。 */
const TARGETS = [
  'src',
  'tests',
  'cases',
  'fixtures',
  'registry',
  'templates',
  'pipeline',
  'docs',
  'schemas',
  '.github',
  'README.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'package.json',
]

/** 永不扫的（构建产物 / 外部对象 / 运行产物）。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'lib',
  'export',
  'export-all',
  'runs',
  '.fixtures',
  'cases-draft',
  'baseline',
])

/**
 * 按文件排除：**模式表与它的测试必然包含这些模式**。
 *
 * 这是"排除文件"而不是"削弱模式"的取舍——削弱模式会让真实凭据也漏过去，
 * 而这三个文件的内容是固定的、可人工审阅的（模式定义 + 构造出来的假样本）。
 */
const SKIP_FILES = new Set(['src/report/redact.ts', 'scripts/check-secrets.mjs', 'tests/redact.test.mjs'])

/** 只扫文本文件，且跳过明显是二进制的。 */
const TEXT_EXT = new Set([
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.md',
  '.txt',
  '.sh',
  '.ps1',
])

function walk(target, out = []) {
  let stat
  try {
    stat = statSync(target)
  } catch {
    return out
  }
  if (stat.isDirectory()) {
    const base = target.split(/[\\/]/).pop() ?? ''
    if (SKIP_DIRS.has(base)) return out
    for (const entry of readdirSync(target)) walk(join(target, entry), out)
    return out
  }
  const dot = target.lastIndexOf('.')
  const ext = dot < 0 ? '' : target.slice(dot).toLowerCase()
  if (TEXT_EXT.has(ext)) out.push(target)
  return out
}

const files = []
for (const target of TARGETS) walk(join(root, target), files)

const hits = []
for (const file of files) {
  const rel = relative(root, file).replace(/\\/g, '/')
  if (SKIP_FILES.has(rel)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    if (line.includes('secrets-ok')) return
    const findings = scanFindings(line)
    for (const finding of findings) {
      hits.push({
        file: rel,
        line: index + 1,
        kind: finding.kind,
      })
    }
  })
}

console.log(`[check-secrets] 包根：${root}`)
console.log(`[check-secrets] 扫描 ${files.length} 个文本文件`)

if (hits.length === 0) {
  console.log('[check-secrets] OK')
  process.exit(0)
}

console.error(`\n[check-secrets] ✗ ${hits.length} 处疑似敏感数据（只报位置与类型，不打印原文）：`)
for (const hit of hits) console.error(`  - ${hit.file}:${hit.line}  [${hit.kind}]`)
console.error(
  '\n处理方式：真的敏感 → 从文件里删掉并轮换该凭据；误报 → 该行加注释标记 `secrets-ok`，' +
    '或在 src/report/redact.ts 的 PLACEHOLDER_RE 里补占位域。不要删检查项。',
)
process.exit(1)
