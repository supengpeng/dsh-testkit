/**
 * Python 顶层导入检查：找出"装机后才会炸"的隐式依赖。
 *
 * ## 它对应哪一类真实问题
 *
 * `dsh-memory` 的两条 issue 是同一类：
 *   · #48「files 白名单漏了根目录 utf8_boot.py → mcp_server 启动即 ModuleNotFoundError」
 *   · #12「md_cg 随包发布但启动时找不到」
 *
 * 共同形态：代码里有 `from <顶层模块> import ...` 这样的**非相对导入**，
 * 它要求那个模块躺在 **sys.path 的根**上。于是：
 *   · 在仓库里跑 → 能 import（因为 cwd 就是根）
 *   · 装出来跑 → `ModuleNotFoundError`（因为那个文件没被打进包）
 *
 * ## 为什么值得单独查
 *
 * 这类依赖**在源码里看不出来**——`from utf8_boot import x` 不像依赖，
 * 它就是一行 import。只有把「import 的名字」与「发包白名单」对照才暴露。
 *
 * 本脚本纯文本分析，**不需要 Python 环境**。
 *
 * ## 结构约定（别把 I/O 放回顶层）
 *
 * 纯函数（`extractTopLevelImports` / `makeCovered` / `collectPyFiles`）留在顶层**便于单测**；
 * **所有 I/O 与 `process.exit` 都在 `main()` 里**，由 `isMain` 守卫调用。
 * 早先把读 package.json 放在顶层，结果 `import` 本文件的测试在加载阶段就 `process.exit(1)` 了。
 *
 * 用法：
 *   node scripts/check-python-topimports.mjs [包目录]
 * 退出码：0 = 通过；1 = 有隐患。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))

/** 跳过这些目录（体积大且不是包内容）。 */
export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
])

/* ------------------------------------------------------------ 纯函数层 -- */

/**
 * 从 Python 源码里抽出**非相对**的顶层导入名。
 *
 * 只看两种形式：
 *   `import X`            → X
 *   `from X import ...`   → X
 * 且 X 必须是**单段名**（`import a.b` 取 a；`from .x import` 是相对导入，跳过）。
 */
export function extractTopLevelImports(source) {
  const names = new Set()
  for (const rawLine of String(source).split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') continue

    let m = /^import\s+([A-Za-z_][A-Za-z0-9_.]*)/.exec(line)
    if (m) {
      names.add(m[1].split('.')[0])
      continue
    }
    m = /^from\s+([A-Za-z_][A-Za-z0-9_.]*)\s+import\b/.exec(line)
    if (m) {
      names.add(m[1].split('.')[0])
      continue
    }
  }
  return [...names]
}

/** 造一个"`files` 白名单是否覆盖某路径"的判定函数。 */
export function makeCovered(files) {
  return (relPath) => {
    const normalized = String(relPath).replace(/\\/g, '/')
    return files.some((pattern) => {
      const p = String(pattern).replace(/^\.\//, '').replace(/\/+$/, '')
      if (p === '**') return true
      if (p === normalized) return true
      if (normalized.startsWith(`${p}/`)) return true
      if (p.endsWith('/**')) {
        const base = p.slice(0, -3)
        return normalized === base || normalized.startsWith(`${base}/`)
      }
      return false
    })
  }
}

/** 递归收集 `.py` 文件（相对 `base` 的路径与绝对路径都返回）。 */
export function collectPyFiles(base, { walker = walkRaw, cap = 100_000 } = {}) {
  const out = []
  walker(base, out, 0, cap)
  return out
}

function walkRaw(dir, out, depth, cap) {
  if (depth > 14 || out.length >= cap) return
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) walkRaw(full, out, depth + 1, cap)
    else if (entry.endsWith('.py')) out.push(full)
  }
}

/**
 * 核心分析：给定包根、白名单与 .py 列表，找出隐式顶层导入的缺件。
 *
 * 抽成纯函数（I/O 由调用方做）是为了能直接单测。
 */
export function analyzeTopImports({ packageRoot, files, pyFiles }) {
  const covered = makeCovered(files)
  const readSource = (file) => readFileSync(file, 'utf8')

  // 包内可被 import 的**顶层模块**名 → 对应文件
  const localTopModules = new Map()
  for (const file of pyFiles) {
    const rel = relative(packageRoot, file).replace(/\\/g, '/')
    if (rel.includes('/')) continue
    const base = rel.replace(/\.py$/, '')
    if (base === '__init__') continue
    localTopModules.set(base, rel)
  }
  // 包内的子包（有 __init__.py 的目录）
  const localPackages = new Set()
  try {
    for (const entry of readdirSync(packageRoot)) {
      const full = join(packageRoot, entry)
      if (SKIP_DIRS.has(entry)) continue
      try {
        if (statSync(full).isDirectory() && existsSync(join(full, '__init__.py'))) {
          localPackages.add(entry)
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }

  const problems = []
  let imports = 0

  for (const file of pyFiles) {
    const rel = relative(packageRoot, file).replace(/\\/g, '/')
    for (const name of extractTopLevelImports(readSource(file))) {
      imports += 1
      const target =
        localTopModules.get(name) ?? (localPackages.has(name) ? `${name}/__init__.py` : undefined)
      if (target === undefined) continue
      if (!covered(target)) {
        problems.push({
          where: rel,
          importName: name,
          target,
          message: `\`${rel}\` 里 \`import ${name}\` 依赖包内的 ${target}，但它不在 files 白名单里——装出来会 ModuleNotFoundError`,
        })
      }
    }
  }

  return { problems, imports, topModules: localTopModules.size }
}

/* --------------------------------------------------------------- 主流程 -- */

/**
 * 只在**被直接运行**时执行。
 *
 * 单测要 `import` 本文件拿纯函数；没有这个守卫的话，主流程会在加载阶段就跑完
 * （甚至 `process.exit`），测试文件会整体失败。**所有 I/O 必须待在 main() 里。**
 */
const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

function main() {
  const packageRoot = resolve(process.argv[2] ?? join(here, '..'))

  const pkgPath = join(packageRoot, 'package.json')
  if (!existsSync(pkgPath)) {
    console.error(`[check-python-topimports] 找不到 package.json：${pkgPath}`)
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const files = Array.isArray(pkg.files) ? pkg.files : ['**']

  const pyFiles = collectPyFiles(packageRoot)
  const { problems, imports, topModules } = analyzeTopImports({ packageRoot, files, pyFiles })

  console.log(`[check-python-topimports] 包根：${packageRoot}`)
  console.log(
    `[check-python-topimports] 扫描 ${pyFiles.length} 个 .py｜包内顶层模块 ${topModules} 个｜import 语句 ${imports} 条`,
  )

  if (problems.length > 0) {
    console.error(`\n[check-python-topimports] ✗ ${problems.length} 处"装机后才会炸"的隐式依赖：`)
    for (const p of problems) console.error(`  - ${p.message}`)
    process.exit(1)
  }

  console.log('[check-python-topimports] OK')
}

if (isMain) main()
