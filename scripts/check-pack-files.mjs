/**
 * 包发布面检查：`package.json` 的 `files` 白名单是否覆盖了运行必需的文件。
 *
 * ## 为什么需要它（来自真实数据）
 *
 * `dsh-memory` 的 #48 就是这一类：
 *   > 0.6.1 装机态开箱即挂：files 白名单漏了根目录 utf8_boot.py
 *   > → mcp_server 启动即 ModuleNotFoundError
 *
 * 也就是「本地能跑、装出来就挂」——因为 npm 发包时只带 `files` 白名单里的东西。
 * 这类问题的完美检测点就是**发包面本身**：不用安装、不用启动，直接比对清单。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-pack-files.mjs            # 检查本包
 * node scripts/check-pack-files.mjs <包目录>    # 检查指定包
 * ```
 *
 * 退出码：0 = 通过；1 = 有缺件。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(process.argv[2] ?? join(here, '..'))

const pkgPath = join(packageRoot, 'package.json')
if (!existsSync(pkgPath)) {
  console.error(`[check-pack-files] 找不到 package.json：${pkgPath}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const files = Array.isArray(pkg.files) ? pkg.files : undefined

if (files === undefined) {
  // 没有 files 白名单 = 全量发布，不存在"漏件"问题
  console.log('[check-pack-files] package.json 没有 files 白名单（全量发布）→ OK')
  process.exit(0)
}

/**
 * 运行必需的文件/目录：由 package.json 的入口字段推导，而不是手工维护。
 * 这样入口一改，检查自动跟着变。
 */
const required = new Set()

const addEntry = (value, what) => {
  if (typeof value !== 'string' || value === '') return
  // 只关心包内相对路径；`./x` 归一化
  const rel = value.replace(/^\.\//, '')
  if (rel.startsWith('..') || rel.startsWith('/')) return
  required.add(`**${what}** \`${rel}\``)
  required.add(rel)
}

// 1) 入口字段
addEntry(pkg.main, 'main')
addEntry(pkg.types, 'types')

// 2) exports 里的所有目标
const walkExports = (node) => {
  if (typeof node === 'string') {
    addEntry(node, 'exports')
    return
  }
  if (node === null || typeof node !== 'object') return
  for (const value of Object.values(node)) walkExports(value)
}
walkExports(pkg.exports)

// 3) DSH 插件声明里**真正指向文件**的字段。
//    注意别整个遍历 `dsh`——那里面还有 engines/compatibility/platform/inject，
//    它们的值是版本号、平台名、依赖名，当成路径会全是误报（真踩过）。
const dsh = pkg.dsh
if (dsh !== null && typeof dsh === 'object') {
  addEntry(dsh.bundle?.patch, 'dsh.bundle.patch')
  addEntry(dsh.client?.entry, 'dsh.client.entry')
  // client 半的常规入口来自 exports["./client"]，已在上面第 2 步处理
}

/** `files` 里的一条是否覆盖了某个路径。 */
function covered(relPath) {
  return files.some((pattern) => {
    const p = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
    if (p === relPath) return true
    if (relPath.startsWith(`${p}/`)) return true
    // 支持 `lib/**` 这类
    if (p.endsWith('/**')) {
      const base = p.slice(0, -3)
      return relPath === base || relPath.startsWith(`${base}/`)
    }
    return false
  })
}

/**
 * npm **总会**上传的文件，不需要出现在 `files` 里。
 * 不豁免它们会产生误报（实测：`package.json` 被当成缺件）。
 */
const ALWAYS_SHIPPED = new Set([
  'package.json',
  'README.md',
  'README',
  'LICENSE',
  'LICENCE',
  'CHANGELOG.md',
])

const paths = [...required].filter((x) => !x.includes('**') && !ALWAYS_SHIPPED.has(x))

/**
 * 要抓的是 **#48 的形态**：文件在本地**存在**（所以本地跑得好好的），
 * 但**不在 files 白名单里**（所以装出来就缺件）。
 *
 * 反过来（白名单里有、本地却不存在）通常是"还没构建"，不算缺件——
 * 报出来噪音太大，所以只查这一个方向。
 */
const missing = paths.filter((rel) => existsSync(join(packageRoot, rel)) && !covered(rel))

console.log(`[check-pack-files] 包根：${packageRoot}`)
console.log(`[check-pack-files] files 白名单：${files.join(', ')}`)
console.log(`[check-pack-files] 入口声明的路径：${paths.length} 个`)

if (missing.length > 0) {
  console.error(
    `\n[check-pack-files] ✗ ${missing.length} 个入口文件本地存在、但不在 files 白名单里（装出来会缺件）：`,
  )
  for (const m of missing) console.error(`  - ${m}`)
  process.exit(1)
}

console.log('[check-pack-files] OK')
