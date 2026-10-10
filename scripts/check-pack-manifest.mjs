/**
 * 发布清单断言：`npm pack --dry-run --json` 的产出里必须含关键目录。
 *
 * ## 为什么单独成一个脚本（原来内联在 release.yml 里）
 *
 * 内联版本直接 `JSON.parse(pack.json)`，结果**发布工作流第一次跑就炸了**：
 * `npm pack` 会执行 `prepare`（= `build-lock` + `build-client`），而那时脚本还在
 * 用 `console.log` 打诊断——于是 `pack.json` 的第一行是
 * `[build-client] → lib/client.js (...)`，JSON.parse 抛 `Unexpected token 'b'`。
 *
 * 也就是说：**报错信息完全没提"缺件"，而真实原因是"输出被污染"**。
 * 所以这里做三件事：
 *   ① 构建脚本的诊断一律走 stderr（stdout 留给机器可读数据）；
 *   ② 解析失败时**把头部内容打出来**，一眼看出是被谁污染的；
 *   ③ 把它从 YAML 里搬进可单测的脚本（本仓库纪律：判据要能被测试钉住）。
 *
 * 用法：`npm pack --dry-run --json > pack.json && node scripts/check-pack-manifest.mjs pack.json`
 * 退出码：0 通过 / 1 缺件或输出非法 / 2 参数或文件问题。
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** 发布物必须含的路径前缀（本轮实际发生过漏件的都在这）。 */
export const REQUIRED_PREFIXES = [
  'bin/',
  'lib/cli/',
  'schemas/',
  'cases/',
  'fixtures/',
  'registry/',
  'templates/',
  'dsh/',
]

/**
 * 从 `npm pack --json` 的原始输出里取出 JSON。
 *
 * @returns {{ ok: true, files: string[] } | { ok: false, reason: string, head: string }}
 */
export function parsePackJson(raw) {
  const head = String(raw).slice(0, 400)
  try {
    const parsed = JSON.parse(raw)
    const first = Array.isArray(parsed) ? parsed[0] : parsed
    if (first === null || typeof first !== 'object' || !Array.isArray(first.files)) {
      return { ok: false, reason: 'JSON 里没有 files 数组（npm 版本差异？）', head }
    }
    return { ok: true, files: first.files.map((entry) => String(entry?.path ?? '')) }
  } catch (error) {
    return {
      ok: false,
      reason: `输出不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      head,
    }
  }
}

/** 计算缺失的必需前缀。 */
export function missingPrefixes(files, required = REQUIRED_PREFIXES) {
  return required.filter((prefix) => !files.some((p) => p === prefix || p.startsWith(prefix)))
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href

if (invokedDirectly) {
  const arg = process.argv[2]
  if (arg === undefined || arg.trim() === '') {
    console.error('[check-pack-manifest] 用法：node scripts/check-pack-manifest.mjs <pack.json>')
    process.exit(2)
  }
  let raw
  try {
    raw = readFileSync(resolve(arg), 'utf8')
  } catch (error) {
    console.error(
      `[check-pack-manifest] 读不到 ${arg}：${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(2)
  }

  const parsed = parsePackJson(raw)
  if (!parsed.ok) {
    console.error(`[check-pack-manifest] ✗ ${parsed.reason}`)
    console.error('[check-pack-manifest] 输出开头（看是谁往 stdout 打了东西）：')
    console.error(parsed.head)
    process.exit(1)
  }

  const missing = missingPrefixes(parsed.files)
  if (missing.length > 0) {
    console.error(`[check-pack-manifest] ✗ 发布清单缺件：${missing.join(', ')}`)
    console.error(`[check-pack-manifest] 清单共 ${parsed.files.length} 项，前 20 项：`)
    console.error(parsed.files.slice(0, 20).join('\n'))
    process.exit(1)
  }

  console.log(`[check-pack-manifest] OK｜清单 ${parsed.files.length} 项｜必需目录 ${REQUIRED_PREFIXES.length} 个都在`)
}
