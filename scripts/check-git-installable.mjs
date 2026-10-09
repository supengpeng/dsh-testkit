/**
 * "从 git 安装会不会装出空壳"检查。
 *
 * ## 它对应哪条真实 issue
 *
 * `dsh-memory` #2：
 *   > 从 git 安装时装出的是空壳：缺少 prepare 脚本
 *   > 装出来的目录里只有 LICENSE README.md cordis.patch.yml docs package.json
 *   > —— 没有 lib/，也没有 src/ → Cannot find module '.../lib/index.js'
 *
 * 而走 npm 安装一切正常。**同一个包，两条安装路径，行为完全不同。**
 *
 * ## 判据（完全可机械判定）
 *
 * 从 git 安装时，包管理器跑的是 **`prepare`**（不是 `prepublishOnly`）。
 * 于是"空壳"要同时满足三件事：
 *
 *   1. 入口（`main` / `exports` / `dsh.bundle.patch`）指向**构建产物**目录
 *   2. **没有** `prepare` 脚本 —— 于是不会在安装时构建
 *   3. `files` **不含**源码目录 —— 于是源码也没被带进去，用户也没法自己构建
 *
 * 三者缺一就不会是空壳：
 *   · 有 prepare → 安装时会构建
 *   · files 含 src → 至少源码在，能自己构建
 *   · 入口不在构建产物里（直接跑源码）→ 本来就不需要构建
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-git-installable.mjs [包目录]
 * ```
 * 退出码：0 = 通过；1 = 有风险。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))

/** 常见构建产物目录名。 */
export const BUILD_DIRS = ['lib', 'dist', 'build', 'out', 'esm', 'cjs']

/** 常见源码目录名。 */
export const SOURCE_DIRS = ['src', 'source', 'sources']

/* ------------------------------------------------------------ 纯函数层 -- */

/** 从 `package.json` 对象里收集所有"指向包的路径"（入口类字段）。 */
export function collectEntryPaths(pkg) {
  const out = new Set()

  const visit = (node, depth = 0) => {
    if (depth > 6) return
    if (typeof node === 'string') {
      const rel = node.replace(/^\.\//, '')
      // 只关心包内相对路径
      if (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('node:')) out.add(rel)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const value of Object.values(node)) visit(value, depth + 1)
  }

  visit(pkg.main)
  visit(pkg.types)
  visit(pkg.exports)
  visit(pkg.bin)
  if (pkg.dsh !== null && typeof pkg.dsh === 'object') visit(pkg.dsh)

  return [...out]
}

/** 判定入口路径是否落在构建产物目录里（那意味着"需要先构建"）。 */
export function isBuiltArtifact(relPath) {
  const normalized = relPath.replace(/\\/g, '/')
  return BUILD_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
}

/**
 * 核心判定：给出"从 git 安装是否空壳"的结论与原因。
 *
 * 抽成纯函数便于单测；I/O 由调用方负责。
 */
export function analyzeGitInstallability(pkg, { dirExists = () => false } = {}) {
  const entryPaths = collectEntryPaths(pkg)
  const builtEntries = entryPaths.filter(isBuiltArtifact)

  const files = Array.isArray(pkg.files) ? pkg.files.map(String) : undefined
  // 没有 files 白名单 = 全量发布，源码一定在
  const shipsSource =
    files === undefined ||
    files.some((p) => {
      const clean = p.replace(/^\.\//, '').replace(/\/+$/, '')
      return SOURCE_DIRS.includes(clean) || SOURCE_DIRS.some((s) => clean.startsWith(`${s}/`))
    })

  const scripts = pkg.scripts !== null && typeof pkg.scripts === 'object' ? pkg.scripts : {}
  const hasPrepare = typeof scripts.prepare === 'string' && scripts.prepare.trim() !== ''

  const risks = []

  if (builtEntries.length > 0 && !hasPrepare && !shipsSource) {
    risks.push({
      code: 'GIT_INSTALL_EMPTY_SHELL',
      entry: builtEntries[0],
      message:
        `入口 \`${builtEntries[0]}\` 指向构建产物，但既没有 \`scripts.prepare\`（从 git 安装时跑的是它，` +
        `不是 prepublishOnly），\`files\` 里也不含源码目录（${SOURCE_DIRS.join(' / ')}）——` +
        `从 git 安装会得到一个没有入口文件的空壳。` +
        `修法：加 \`"prepare": "npm run build"\`，或把源码目录加进 files。`,
    })
  } else if (builtEntries.length > 0 && !hasPrepare && shipsSource && files !== undefined) {
    risks.push({
      code: 'GIT_INSTALL_NO_PREPARE_BUT_SOURCE_SHIPPED',
      entry: builtEntries[0],
      message:
        `入口 \`${builtEntries[0]}\` 指向构建产物，没有 \`scripts.prepare\`；` +
        `源码已在 files 里，所以装出来不是空壳，但**装在用户机器上不会自动构建**，` +
        `入口文件仍然缺失。建议补 prepare。`,
      severity: 'warning',
    })
  }

  // 入口声明的文件在本地是否存在（"本地就缺"是另一类问题）
  const missingLocally = entryPaths.filter(
    (p) => !p.endsWith('/') && !dirExists(p.split('/').slice(0, -1).join('/')),
  )

  return {
    entryPaths,
    builtEntries,
    hasPrepare,
    shipsSource,
    hasFilesWhitelist: files !== undefined,
    risks,
    missingLocally,
  }
}

/* --------------------------------------------------------------- 主流程 -- */

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

function main() {
  const packageRoot = resolve(process.argv[2] ?? join(here, '..'))
  const pkgPath = join(packageRoot, 'package.json')
  if (!existsSync(pkgPath)) {
    console.error(`[check-git-installable] 找不到 package.json：${pkgPath}`)
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  const dirExists = (rel) => {
    if (rel === '') return true
    try {
      return statSync(join(packageRoot, rel)).isDirectory()
    } catch {
      return false
    }
  }

  const result = analyzeGitInstallability(pkg, { dirExists })

  console.log(`[check-git-installable] 包根：${packageRoot}`)
  console.log(`[check-git-installable] 入口路径 ${result.entryPaths.length} 个（其中构建产物 ${result.builtEntries.length} 个）`)
  console.log(
    `[check-git-installable] scripts.prepare：${result.hasPrepare ? '有' : '无'}｜` +
      `files 白名单：${result.hasFilesWhitelist ? '有（含源码：' + (result.shipsSource ? '是' : '否') + '）' : '无（全量发布）'}`,
  )

  const errors = result.risks.filter((r) => r.severity !== 'warning')
  for (const r of result.risks) {
    const tag = r.severity === 'warning' ? '!' : '✗'
    console.error(`\n[check-git-installable] ${tag} ${r.code}\n  ${r.message}`)
  }

  if (errors.length > 0) process.exit(1)
  if (result.risks.length > 0) {
    console.log('[check-git-installable] 通过（有 1 条建议）')
    process.exit(0)
  }
  console.log('[check-git-installable] OK')
}

if (isMain) main()
