/**
 * 编码守卫：仓库内文本文件必须是 **UTF-8 无 BOM**。
 *
 * ## 为什么需要它
 *
 * Windows 上有两种"静默污染"，都不会立刻报错，但会在别处炸：
 *
 *   ① 用 PowerShell 5.1 的 `Out-File` / `Set-Content` 写中文
 *      → 落成 UTF-16LE 或 ANSI(CP936)。之后 diff 全红、解析器读到乱码。
 *   ② 用**带 BOM** 的 UTF-8 保存
 *      → JSON / YAML / shell 会把 BOM 当内容，典型症状是"第一个键解析不出来"。
 *
 * 本仓约定：**所有文本文件 UTF-8 无 BOM**。
 * 诊断细节与各 shell 的解法见 docs/WINDOWS-ENCODING.md。
 *
 * ## 检查项
 *
 *   ① 无 UTF-8 BOM（头 3 字节不是 EF BB BF）
 *   ② 无 UTF-16 BOM（FF FE / FE FF）
 *   ③ 可按严格 UTF-8 解码（不产生 U+FFFD 替换字符）
 *
 * `U+FFFD` 这一条最值得留：它意味着这段字节**曾经被错误解码过又存了回去**——
 * 那时原文已经不可恢复，只能靠"文件被改过"这件事本身提醒人。
 *
 * ## 结构约定
 *
 * 检查逻辑写在可导出的 `inspectBuffer()` 里，I/O 与 `process.exit` 留在 `main()`——
 * 于是单测可以直接喂 Buffer，不需要在盘上造污染文件。
 *
 * 用法：node scripts/check-encoding.mjs
 * 退出码：0 = 干净；1 = 有违规
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))

/** 按扩展名判定"文本文件"。二进制（png / tgz / exe …）不在检查范围。 */
export const TEXT_EXT = new Set([
  '.md',
  '.ts',
  '.tsx',
  '.mjs',
  '.js',
  '.cjs',
  '.json',
  '.yaml',
  '.yml',
  '.txt',
  '.ps1',
  '.py',
  '.html',
  '.css',
  '.jsonl',
  '.patch',
  '.toml',
  '.gitattributes',
  '.gitignore',
  '.editorconfig',
])

/** 不检查的目录：第三方、构建产物、运行产物、外部夹具副本。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.fixtures',
  'lib',
  'runs',
  'export',
  'cases-draft',
  '__pycache__',
  '.pytest_cache',
])

/**
 * 检查一段字节。返回问题类型数组（空数组 = 干净）。
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function inspectBuffer(buf) {
  const problems = []

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    problems.push('UTF-8 BOM（EF BB BF）')
  }
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) {
    problems.push('UTF-16 BOM（FF FE / FE FF）')
  }
  // 用严格解码：有非法序列时 Node 会插入 U+FFFD
  const text = buf.toString('utf8')
  if (text.includes('\uFFFD')) {
    problems.push('不是合法 UTF-8（解码产生 U+FFFD）')
  }
  return problems
}

/** 递归收集待检查的文本文件（相对路径）。 */
export function collectTextFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectTextFiles(full, base, out)
      continue
    }
    const lower = entry.toLowerCase()
    const dot = lower.lastIndexOf('.')
    const ext = dot >= 0 ? lower.slice(dot) : ''
    // 少数无扩展名的文本文件（.gitattributes 之类）按全名判
    if (TEXT_EXT.has(ext) || TEXT_EXT.has(lower)) {
      out.push(relative(base, full).replace(/\\/g, '/'))
    }
  }
  return out
}

/** 跑全仓检查，打印读数。返回退出码。 */
export function main() {
  if (!existsSync(root)) {
    console.error(`[check-encoding] 仓库根不存在：${root}`)
    return 1
  }

  const files = collectTextFiles(root)
  const problems = []

  for (const rel of files) {
    const buf = readFileSync(join(root, rel))
    for (const kind of inspectBuffer(buf)) {
      problems.push(`${rel}: ${kind}`)
    }
  }

  console.log(`[check-encoding] 检查 ${files.length} 个文本文件（UTF-8 无 BOM）`)

  if (problems.length > 0) {
    console.error(`\n[check-encoding] ✗ ${problems.length} 处编码违规：`)
    for (const p of problems) console.error(`  - ${p}`)
    console.error('\n修法见 docs/WINDOWS-ENCODING.md §3/§4（PowerShell 5.1 要用 -Encoding UTF8）。')
    return 1
  }

  console.log('[check-encoding] OK')
  return 0
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) process.exit(main())
