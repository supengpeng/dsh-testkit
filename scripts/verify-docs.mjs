/**
 * 文档守卫：检查文档与实现是否漂移。
 *
 * ## 为什么值得单独守
 *
 * 这个项目的文档是**说明书性质**的（架构、场景规范、风险台账），
 * 一旦与实现漂移，读者会照着过时的说明做事。而漂移的典型形态是
 * 「数字忘了更新」「链接指向已改名的文件」「文档里的 `fx.*` 在代码里不存在」——
 * 全是机器能查的。
 *
 * ## 检查项
 *
 *   ① markdown 链接指向的仓库内文件必须存在
 *   ② 文档里出现的 `fx.<name>` 必须在 src/ 里有对应的 note('<name>') / noteAppend('<name>')
 *   ③ 文档里出现的 `pnpm run <script>` 必须在 package.json 里存在
 *   ④ 文档提到的 `scripts/<name>.mjs` 必须真实存在
 *   ⑤ `cases/` 下的场景数量声明必须与实际一致
 *   ⑥ **CLI 子命令数**必须与 `src/cli/index.ts` 的命令条目数一致
 *   ⑦ **质量守卫数**必须与 `package.json` 的 `verify:*` 条数一致
 *
 * ## 两条易误报的边界
 *
 * **（检查 ②）** `fx.add()` / `fx.getNote()` 里的 `add` / `getNote` 是
 * **Fixture 的公开 API 方法名**，不是取证字段。这份名单**从 `src/runtime/fixture.ts`
 * 动态提取**而不是写死：写死的白名单会在 Fixture 增删方法时静默过期，
 * 而那正是本守卫要防的那类漂移。
 *
 * **（检查 ⑥⑦）** 只校验"当前状态"型文档。历史与过程文档（见 `COUNT_EXEMPT_DOCS`）
 * 记录的是**当时的读数**，改掉等于篡改审计痕迹——它们豁免。
 *
 * ## 结构约定
 *
 * 所有 I/O 与 `process.exit` 都在 `main()` 里，由 `isMain` 守卫调用——
 * 于是 `checkDocument()` 是纯函数，可以被单测直接喂文本，不需要构造真实仓库。
 * 回归用例见 `tests/docs-guard.test.mjs`（每条"必须报"旁边都有一条"必须不报"）。
 *
 * 用法：node scripts/verify-docs.mjs
 * 退出码：0 = 干净；1 = 有漂移
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))

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

/**
 * **历史 / 过程文档**不参与"当前计数"校验（⑥⑦）。
 *
 * 它们记录的是**当时的读数**——例如"CLI 15 个子命令""10 个守卫全绿"写于 0.2.0 第四批，
 * 是审计痕迹。把历史读数改成今天的值，等于篡改证据；正确的做法是保留读数、
 * 由后出的文档（或注记）说明它已过期。
 */
const COUNT_EXEMPT_DOCS = new Set(['docs/OPTIMIZATION-REVIEW-2026-10.md', 'docs/ROADMAP.md'])

export function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

/** 收集 src/ 里所有被 `note()` / `noteAppend()` 写下的取证字段名。 */
export function collectKnownRefs(srcDir) {
  const refs = new Set()
  for (const file of walk(srcDir)) {
    if (!file.endsWith('.ts')) continue
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/note(?:Append)?\(\s*'([A-Za-z][A-Za-z0-9_]*)'/g)) {
      refs.add(m[1])
    }
  }
  return refs
}

/**
 * 收集 Fixture 的公开方法名（`add` / `note` / `getNote` / `snapshot` / `release` / `notes` …）。
 *
 * 真源是 `src/runtime/fixture.ts` 的 `class Fixture`。先剥注释再匹配，
 * 否则文档注释里提到的 `add()` 会被当成方法名收进来。
 */
export function collectFixtureApi(rootDir) {
  const api = new Set()
  const file = join(rootDir, 'src', 'runtime', 'fixture.ts')
  if (!existsSync(file)) return api

  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释（含 JSDoc）
    .replace(/^\s*\/\/.*$/gm, '') // 整行注释

  // 普通方法与 async 方法：两空格缩进 + 名字 + 左括号
  for (const m of text.matchAll(/^ {2}(?:async\s+)?([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)) {
    api.add(m[1])
  }
  // getter：`get notes()` 不匹配上面的模式，单独收
  for (const m of text.matchAll(/^ {2}get\s+([A-Za-z][A-Za-z0-9_]*)\s*\(/gm)) {
    api.add(m[1])
  }
  return api
}

/**
 * CLI 子命令真源：`src/cli/index.ts` 里 `{ name: 'x', summary: … }` 形态的命令条目数。
 *
 * 不能用 `summary:` 的总数——选项（如 `--json`）也有 `help`，但命令与选项的
 * 区分点在 `name: '...', summary:` 这个组合上。取不到时返回 `null`（表示"不校验"）。
 */
export function collectCliSubcommandCount(rootDir) {
  const file = join(rootDir, 'src', 'cli', 'index.ts')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  return [...text.matchAll(/\{\s*name:\s*'[a-zA-Z][a-zA-Z0-9-]*',\s*summary:/g)].length
}

/** 质量守卫真源：`package.json` 里 `verify:*` 脚本的条数。取不到时返回 `null`。 */
export function collectGuardCount(rootDir) {
  const file = join(rootDir, 'package.json')
  if (!existsSync(file)) return null
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  return Object.keys(pkg.scripts ?? {}).filter((k) => k.startsWith('verify:')).length
}

/**
 * 检查一份文档正文，返回漂移清单（纯函数，无 I/O——存在性判定走 `ctx.exists`）。
 *
 * @param {{rel: string, text: string, ctx: {
 *   knownRefs: Set<string>, fixtureApi: Set<string>, knownScripts: Set<string>,
 *   actualCaseCount: number, repoRoot: string, exists: (p: string) => boolean,
 *   cliSubcommands?: number|null, guardCount?: number|null,
 * }}} args
 * @returns {string[]} 形如 `docs/X.md:12: <说明>` 的问题列表
 */
export function checkDocument({ rel, text, ctx }) {
  const problems = []
  const lines = text.split(/\r?\n/)
  const countCheckEnabled = !COUNT_EXEMPT_DOCS.has(rel)

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
      const fromDoc = resolve(dirname(join(ctx.repoRoot, rel)), pathOnly)
      const fromRoot = resolve(ctx.repoRoot, pathOnly)
      if (!ctx.exists(fromDoc) && !ctx.exists(fromRoot)) {
        problems.push(`${where}: 链接指向不存在的路径 → ${target}`)
      }
    }

    // ② `fx.*` 取证字段（跳过容器引用与 Fixture 的 API 方法名）
    for (const m of line.matchAll(/\bfx\.([A-Za-z][A-Za-z0-9_]*)/g)) {
      const name = m[1]
      if (REF_CONTAINERS.has(name)) continue
      if (ctx.fixtureApi.has(name)) continue // API 名不是取证字段
      if (!ctx.knownRefs.has(name)) {
        problems.push(
          `${where}: 文档提到 fx.${name}，但 src/ 里没有任何 note('${name}')，也不是 Fixture 的 API 方法`,
        )
      }
    }

    // ③ `pnpm run <script>`（跳过 DSH 自身的外部脚本）
    for (const m of line.matchAll(/pnpm run ([a-z0-9:_-]+)/gi)) {
      const script = m[1]
      if (EXTERNAL_SCRIPTS.has(script)) continue
      if (!ctx.knownScripts.has(script)) {
        problems.push(`${where}: 文档提到 pnpm run ${script}，但 package.json 里没有这个脚本`)
      }
    }

    // ④ `scripts/<name>.mjs` 必须真实存在
    //
    // 只查 `pnpm run <script>` 是不够的：文档里大量直接写
    // `node scripts/check-pack-files.mjs` 这种调用（那些脚本不进 npm scripts）。
    // 少了这条，改了脚本名或删了脚本，文档会**静默失效**——读者照着敲得到 ENOENT。
    for (const m of line.matchAll(/scripts\/([A-Za-z0-9._-]+\.mjs)/g)) {
      const scriptRel = m[1]
      if (!ctx.exists(resolve(ctx.repoRoot, 'scripts', scriptRel))) {
        problems.push(`${where}: 文档提到 scripts/${scriptRel}，但这个文件不存在`)
      }
    }

    // ⑤ `cases/` 下的场景数量声明
    //
    // ⚠️ 只认**明确指向 cases 目录**的表述（`cases/` 下 **N 条场景**）。
    // 早先写的是裸模式 `**N 条场景**`，于是"导出的 **N 条场景**"这类
    // 说的是**别的东西**的句子会被误判——它恰好和总数相等时蒙对，
    // 一旦不等就误报（真踩过）。
    for (const m of line.matchAll(/cases\/[^\n]*?下\s*\*\*(\d+) 条场景\*\*/g)) {
      const claimed = Number(m[1])
      if (claimed !== ctx.actualCaseCount) {
        problems.push(
          `${where}: 文档声称 cases/ 下「${claimed} 条场景」，但实际有 ${ctx.actualCaseCount} 条`,
        )
      }
    }

    // ⑥ CLI 子命令数（真源：src/cli/index.ts 的命令条目数）
    if (countCheckEnabled && ctx.cliSubcommands != null) {
      for (const m of line.matchAll(/(\d+)\s*个\s*CLI\s*子命令/g)) {
        if (Number(m[1]) !== ctx.cliSubcommands) {
          problems.push(
            `${where}: 文档称 ${m[1]} 个 CLI 子命令，真源 src/cli/index.ts 是 ${ctx.cliSubcommands} 个`,
          )
        }
      }
    }

    // ⑦ 质量守卫数（真源：package.json 的 verify:* 条数）
    if (countCheckEnabled && ctx.guardCount != null) {
      for (const m of line.matchAll(/(\d+)\s*个(?:质量)?守卫/g)) {
        if (Number(m[1]) !== ctx.guardCount) {
          problems.push(
            `${where}: 文档称 ${m[1]} 个守卫，真源 package.json 的 verify:* 是 ${ctx.guardCount} 条`,
          )
        }
      }
    }
  })

  return problems
}

/** 收集真源、跑全部文档、打印读数。返回退出码。 */
export function main() {
  const problems = []

  const knownRefs = collectKnownRefs(join(root, 'src'))
  const fixtureApi = collectFixtureApi(root)
  const cliSubcommands = collectCliSubcommandCount(root)
  const guardCount = collectGuardCount(root)
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const knownScripts = new Set(Object.keys(pkg.scripts ?? {}))
  const actualCaseCount = readdirSync(join(root, 'cases')).filter((f) =>
    /^TK-\d+\.yaml$/.test(f),
  ).length

  // 递归收集 docs/（含 docs/rfc/*.md）：RFC 里的链接同样是给人点的，必须存在。
  // 早先只扫 docs/ 顶层，于是 0001 里的 `](REWRITE-DESIGN.md)` 一直没被发现——
  // 它在 docs/rfc/ 下解析成 docs/rfc/REWRITE-DESIGN.md，点不开。
  const docFiles = [
    'README.md',
    'cases/README.md',
    ...walk(join(root, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => relative(root, f).replace(/\\/g, '/')),
  ]

  const ctx = {
    knownRefs,
    fixtureApi,
    knownScripts,
    actualCaseCount,
    repoRoot: root,
    exists: existsSync,
    cliSubcommands,
    guardCount,
  }

  for (const rel of docFiles) {
    const full = join(root, rel)
    if (!existsSync(full)) {
      problems.push(`${rel}: 文件不存在`)
      continue
    }
    problems.push(...checkDocument({ rel, text: readFileSync(full, 'utf8'), ctx }))
  }

  console.log(`[verify-docs] 检查 ${docFiles.length} 份文档`)
  console.log(
    `[verify-docs] 取证字段 ${knownRefs.size}｜Fixture API ${fixtureApi.size}｜CLI 子命令 ${cliSubcommands}｜守卫 ${guardCount}｜脚本 ${knownScripts.size}｜场景 ${actualCaseCount}`,
  )

  if (problems.length > 0) {
    console.error(`\n[verify-docs] ✗ ${problems.length} 处文档与实现漂移：`)
    for (const p of problems) console.error(`  - ${p}`)
    return 1
  }

  console.log('[verify-docs] OK')
  return 0
}

const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url
if (isMain) process.exit(main())
