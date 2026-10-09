/**
 * 文档守卫：检查文档与实现是否漂移。
 *
 * 为什么值得单独守：这个项目的文档是**说明书性质**的（架构、场景规范、风险台账），
 * 一旦与实现漂移，读者会照着过时的说明做事。而漂移的典型形态是
 * 「数字忘了更新」「链接指向已改名的文件」「文档里的 fx.* 在代码里不存在」——
 * 全是机器能查的。
 *
 * 检查项：
 *   ① markdown 链接指向的仓库内文件必须存在
 *   ② 文档里出现的 `fx.<name>` 必须在 src/ 里有对应的 note('<name>') / noteAppend('<name>')
 *   ③ 文档里出现的 `pnpm run <script>` 必须在 package.json 里存在
 *   ④ README 声称的场景数量必须与 cases/ 实际一致
 *
 * 用法：node scripts/verify-docs.mjs
 * 退出码：0 = 干净；1 = 有漂移
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const problems = []
const warnings = []

/**
 * `fx.<name>` 里有一类**容器引用**，不是具体取证字段：
 *   · `fx.notes` 指整份取证对象
 *   · `fx.` 后接省略号/描述性文字时同理会误报
 * 这些不算漂移。
 */
const REF_CONTAINERS = new Set(['notes'])

/**
 * 已知的**外部脚本**：文档里会提到 DSH 自身的脚本（例如 client 插件的 HMR 用
 * `pnpm run dev:web`，那是 DSH 仓库的命令，不是本包的）。它们不在本包
 * `package.json` 里，属于正常引用。
 */
const EXTERNAL_SCRIPTS = new Set(['dev:web'])

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/* ---------------------------------------------------------------- 收集真源 -- */

// ① src 里所有取证字段名
const knownRefs = new Set()
for (const file of walk(join(root, 'src'))) {
  if (!file.endsWith('.ts')) continue
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/note(?:Append)?\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) {
    knownRefs.add(m[1])
  }
}

// ② package.json 里的 scripts
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const knownScripts = new Set(Object.keys(pkg.scripts ?? {}))

// ③ cases 实际数量
const actualCaseCount = readdirSync(join(root, 'cases')).filter((f) =>
  /^TK-\d+\.yaml$/.test(f),
).length

// ④ 要检查的文档
const docFiles = [
  'README.md',
  'cases/README.md',
  ...readdirSync(join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
]

/* ------------------------------------------------------------------ 检查 -- */

for (const rel of docFiles) {
  const full = join(root, rel)
  if (!existsSync(full)) {
    problems.push(`${rel}: 文件不存在`)
    continue
  }
  const text = readFileSync(full, 'utf8')
  const lines = text.split(/\r?\n/)

  // 跳过 ``` 围栏内的内容：那是**示例**，里面的路径不是真链接
  let inFence = false

  lines.forEach((line, index) => {
    const where = `${rel}:${index + 1}`

    if (/^\s*```/.test(line)) {
      inFence = !inFence
      return
    }
    if (inFence) return

    // ① markdown 链接（只看仓库内相对路径）
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1]
      if (/^[a-z]+:/i.test(target)) continue // http: / mailto: 等
      if (target.startsWith('#')) continue // 纯锚点
      const pathOnly = target.split('#')[0]
      if (pathOnly === '') continue
      // 相对文档所在目录解析；也接受相对仓库根
      const fromDoc = resolve(dirname(full), pathOnly)
      const fromRoot = resolve(root, pathOnly)
      if (!existsSync(fromDoc) && !existsSync(fromRoot)) {
        problems.push(`${where}: 链接指向不存在的路径 → ${target}`)
      }
    }

    // ② fx.* 取证字段（跳过容器引用）
    for (const m of line.matchAll(/\bfx\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      const name = m[1]
      if (REF_CONTAINERS.has(name)) continue
      if (!knownRefs.has(name)) {
        problems.push(`${where}: 文档提到 fx.${name}，但 src/ 里没有任何 note('${name}')`)
      }
    }

    // ③ pnpm run <script>（跳过 DSH 自身的外部脚本）
    for (const m of line.matchAll(/pnpm run ([a-z0-9:_-]+)/gi)) {
      const script = m[1]
      if (EXTERNAL_SCRIPTS.has(script)) continue
      if (!knownScripts.has(script)) {
        problems.push(`${where}: 文档提到 pnpm run ${script}，但 package.json 里没有这个脚本`)
      }
    }

    // ③.5 scripts/<name>.mjs 必须真实存在
    //
    // 只查 `pnpm run <script>` 是不够的：文档里大量直接写
    // `node scripts/check-pack-files.mjs` 这种调用（那些脚本不进 npm scripts）。
    // 少了这条，改了脚本名或删了脚本，文档会**静默失效**——读者照着敲得到 ENOENT。
    for (const m of line.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g)) {
      const rel = m[1]
      if (!existsSync(resolve(root, 'scripts', rel))) {
        problems.push(`${where}: 文档提到 scripts/${rel}，但这个文件不存在`)
      }
    }

    // ④ `cases/` 下的场景数量声明
    //
    // ⚠️ 只认**明确指向 cases 目录**的表述（`cases/` 下 **N 条场景**）。
    // 早先写的是裸模式 `**N 条场景**`，于是"导出的 **N 条场景**"这类
    // 说的是**别的东西**的句子会被误判——它恰好和总数相等时蒙对，
    // 一旦不等就误报（真踩过）。
    for (const m of line.matchAll(/cases\/[^\n]*?下\s*\*\*(\d+) 条场景\*\*/g)) {
      const claimed = Number(m[1])
      if (claimed !== actualCaseCount) {
        problems.push(
          `${where}: 文档声称 cases/ 下「${claimed} 条场景」，但实际有 ${actualCaseCount} 条`,
        )
      }
    }
  })
}

/* ---------------------------------------------------------------- 汇总 -- */

console.log(`[verify-docs] 检查 ${docFiles.length} 份文档`)
console.log(`[verify-docs] 已知取证字段 ${knownRefs.size} 个｜脚本 ${knownScripts.size} 个｜场景 ${actualCaseCount} 条`)

for (const w of warnings) console.warn(`[verify-docs] ! ${w}`)

if (problems.length > 0) {
  console.error(`\n[verify-docs] ✗ ${problems.length} 处文档与实现漂移：`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

console.log('[verify-docs] OK')
