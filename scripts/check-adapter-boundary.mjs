/**
 * 适配层边界守卫：DSH 内部包只能出现在 `src/adapters/dsh/` 下。
 *
 * ## 它对应哪一类真实问题
 *
 * 本仓的设计承诺是「driver 不直接依赖 DSH，DSH 升级时改动收敛在适配层」。
 * 但这条承诺靠人工 review 是守不住的：新增一个 driver 时顺手
 * `import { something } from '@deepseek-ai/dsh-tools'` 是最自然的写法，
 * 而它带来的后果是**延迟暴露**的——CI 里 cordis/tools 都在，编译照样过，
 * 直到某天 DSH 换掉内部签名，改动点已经散布在十几个文件里。
 *
 * ## 为什么不能"grep 到包名就报"
 *
 * 早先方案里的验收方式是一条 grep。它有两个问题：
 *   ① 同一份源码里有 9 处**注释**提到 `@deepseek-ai/dsh-*`
 *      （引用发行体路径、对照上游实现、说明契约来源等），grep 会全部误报；
 *   ② grep 分不清 `import` / `import()` / `require()` 三种真实依赖形式与
 *      字符串字面量里的同名文本。
 *
 * 所以本脚本先**剥离注释**（保留字符串），再只认三种依赖形式。
 *
 * ## 豁免名单
 *
 * `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` **不算 DSH 内部包**：
 * 它们是 cordis 生态的基础设施，真实 DSH 与本包的 headless 宿主都要用，
 * 强行收进适配层只会把依赖关系弄反。判据只对 `@deepseek-ai/dsh-*` 生效。
 *
 * ## 结构约定（同 check-python-topimports.mjs）
 *
 * 纯函数（`stripComments` / `extractDshImports` / `isDshInternalPackage` /
 * `findViolations` / `collectSourceFiles`）留在顶层**便于单测**；
 * **所有 I/O 与 `process.exit` 都在 `main()` 里**，由 `isMain` 守卫调用。
 *
 * 用法：
 *   node scripts/check-adapter-boundary.mjs [包目录]
 * 退出码：0 = 通过；1 = 有越界依赖。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/** 唯一允许直接依赖 `@deepseek-ai/dsh-*` 的目录（仓库相对路径，含尾斜杠）。 */
export const ALLOWED_PREFIX = 'src/adapters/dsh/'

/** 扫描范围：host 半与 client 半的 TS 源码（`.tsx` 也算）。 */
export const SCAN_ROOTS = ['src']

/** 跳过这些目录（体积大且不是本包源码）。 */
export const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'dist', 'build'])

/* ------------------------------------------------------------ 纯函数层 -- */

/**
 * 判定一个模块说明符是不是 **DSH 内部包**。
 *
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 算；
 * `@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 等基础设施不算。
 */
export function isDshInternalPackage(specifier) {
  const name = String(specifier)
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/**
 * 剥离注释：把 `//` 与 `/* *\/` 的内容替换成空格，**保持字符数与换行不变**。
 *
 * 保持长度是为了让后续正则命中的下标能直接换算回原始行号；
 * 字符串字面量原样保留——那里才是说明符真正出现的位置。
 *
 * 简易状态机（不做完整 TS 词法分析）覆盖本仓会出现的形态：
 * 单/双/反引号字符串、模板串、行注释、块注释、转义字符。
 */
export function stripComments(source) {
  const text = String(source)
  const out = text.split('')
  const n = text.length
  let state = 'code'
  let i = 0

  while (i < n) {
    const c = text[i]
    const c2 = i + 1 < n ? text[i + 1] : ''

    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        state = 'line'
        continue
      }
      if (c === '/' && c2 === '*') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        state = 'block'
        continue
      }
      if (c === "'") state = 'single'
      else if (c === '"') state = 'double'
      else if (c === '`') state = 'template'
      i += 1
      continue
    }

    if (state === 'line') {
      if (c === '\n') state = 'code'
      else out[i] = ' '
      i += 1
      continue
    }

    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        state = 'code'
        continue
      }
      if (c !== '\n') out[i] = ' '
      i += 1
      continue
    }

    // 字符串内部：整体保留，只处理转义，避免 `'it\'s'` 提前收尾
    if (c === '\\') {
      out[i] = ' '
      if (i + 1 < n && text[i + 1] !== '\n') out[i + 1] = ' '
      i += 2
      continue
    }
    if (state === 'single' && c === "'") state = 'code'
    else if (state === 'double' && c === '"') state = 'code'
    else if (state === 'template' && c === '`') state = 'code'
    i += 1
  }

  return out.join('')
}

/** 三种真实依赖形式（作用于已剥离注释的源码）。 */
const IMPORT_PATTERNS = [
  {
    kind: 'static-import',
    // `import ... from 'x'` / `export ... from 'x'`（含 type-only）
    regex: /\b(?:import|export)\b[^;\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
  },
  {
    kind: 'side-effect-import',
    // `import 'x'`
    regex: /\bimport\s*['"]([^'"]+)['"]/g,
  },
  {
    kind: 'dynamic-import',
    regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  },
  {
    kind: 'require',
    regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  },
]

function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') line += 1
  }
  return line
}

/**
 * 抽出一份源码里**所有**模块说明符依赖（含非 DSH 的）。
 *
 * 返回 `{ specifier, kind, line }`；纯函数，不碰文件系统。
 */
export function extractDshImports(source) {
  const code = stripComments(source)
  const hits = []
  for (const { kind, regex } of IMPORT_PATTERNS) {
    regex.lastIndex = 0
    for (const match of code.matchAll(regex)) {
      hits.push({ specifier: match[1], kind, line: lineOf(code, match.index) })
    }
  }
  return hits
}

/** 归一化成仓库相对路径（`\` → `/`，去掉前导 `./`）。 */
export function normalizeRel(relPath) {
  return String(relPath).replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * 核心分析：在一组 `{ relPath, source }` 上找越界依赖。
 *
 * 抽成纯函数（I/O 由调用方做）是为了能直接单测——包括"往 src/kinds 下写一行
 * 非法 import 会被抓出来"这条负向用例。
 */
export function findViolations(files, { allowedPrefix = ALLOWED_PREFIX } = {}) {
  const violations = []
  let scanned = 0
  let allowed = 0

  for (const file of files) {
    const rel = normalizeRel(file.relPath ?? file.path ?? '')
    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue
    scanned += 1

    const isAllowed = rel.startsWith(allowedPrefix)
    for (const hit of extractDshImports(file.source ?? '')) {
      if (!isDshInternalPackage(hit.specifier)) continue
      if (isAllowed) {
        allowed += 1
        continue
      }
      violations.push({
        where: rel,
        line: hit.line,
        kind: hit.kind,
        specifier: hit.specifier,
        message:
          `${rel}:${hit.line} 以 ${hit.kind} 形式依赖 DSH 内部包 \`${hit.specifier}\`；` +
          `它必须位于 ${allowedPrefix} 下（或经那里的适配层转发）`,
      })
    }
  }

  return { violations, scanned, allowed }
}

/* ----------------------------------------------------------- I/O 辅助层 -- */

/**
 * 收集待扫描的 TS 源码。
 *
 * 返回 `{ relPath, absPath, source }`；I/O 在这里，但**不 exit**——
 * 便于测试直接在本仓真实源码上跑一遍。
 */
export function collectSourceFiles(packageRoot, { roots = SCAN_ROOTS } = {}) {
  const out = []
  const walk = (dir) => {
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
      if (isDir) {
        walk(full)
        continue
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue
      out.push({
        relPath: normalizeRel(relative(packageRoot, full)),
        absPath: full,
        source: readFileSync(full, 'utf8'),
      })
    }
  }
  for (const rel of roots) walk(join(packageRoot, rel))
  return out
}

/* --------------------------------------------------------------- 主流程 -- */

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

function main() {
  const packageRoot = resolve(process.argv[2] ?? root)
  const files = collectSourceFiles(packageRoot)
  const { violations, scanned, allowed } = findViolations(files)

  console.log(`[check-adapter-boundary] 包根：${packageRoot}`)
  console.log(
    `[check-adapter-boundary] 扫描 ${scanned} 个 .ts/.tsx｜${ALLOWED_PREFIX} 下的 DSH 依赖 ${allowed} 处`,
  )

  if (violations.length > 0) {
    console.error(
      `\n[check-adapter-boundary] ✗ ${violations.length} 处越界的 DSH 内部包依赖：`,
    )
    for (const v of violations) console.error(`  - ${v.message}`)
    console.error(
      `\n修法：把该 import 换成对 ${ALLOWED_PREFIX} 适配面的引用` +
        `（新增能力时先在那里加一层转发）。`,
    )
    process.exit(1)
  }

  console.log('[check-adapter-boundary] OK')
}

if (isMain) main()
