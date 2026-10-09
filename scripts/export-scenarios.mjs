/**
 * 离线导出场景为 CI 用例。
 *
 * 用法：
 *   node scripts/export-scenarios.mjs [--out <dir>] [--lib <dir>] [--include-fixture]
 *
 * 依赖已编译的 lib/（因此需先 `npm run build`）。
 * 导出的文件自带 headless 宿主，可直接 `node --test <file>` 运行。
 *
 * ## 默认排除 `fixture` 标签的场景
 *
 * 那些场景测的是**外部被测对象**（下载来的包）。被测对象自身有 bug 时它们会如实失败，
 * 但那是**被测对象的问题**，不该让**本插件的质量门**变红。
 * 想跑它们请显式加 `--include-fixture`（做外部对象巡检时用）。
 *
 * ## 结构约定
 *
 * `selectExportable` 是纯函数、留在顶层便于单测；
 * **所有 I/O 与 `process.exit` 都在 `main()` 里**，由 `isMain` 守卫调用。
 * （同 `check-python-topimports.mjs` 的约定——把 I/O 放顶层会让 `import` 本文件的测试在加载阶段就退出。）
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const libDir = join(root, 'lib')

/* ------------------------------------------------------------ 纯函数层 -- */

/**
 * 从场景集合里挑出"可导出的"，并给出被排除的原因计数。
 *
 * 抽成纯函数便于单测——这是**质量门的关键机制**：哪些场景进 CI 轨、哪些不进。
 */
export function selectExportable(scenarios, { includeFixture = false } = {}) {
  const active = scenarios.filter((s) => (s.status ?? 'active') === 'active')
  const selected = includeFixture
    ? active
    : active.filter((s) => !(s.tags ?? []).includes('fixture'))
  return { active, selected, excluded: active.length - selected.length }
}

/* --------------------------------------------------------------- 主流程 -- */

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

async function main() {
  const argv = process.argv.slice(2)

  const required = join(libDir, 'export', 'node-test.js')
  if (!existsSync(required)) {
    console.error('[export-scenarios] 未找到 lib/export/node-test.js —— 请先运行 npm run build')
    process.exit(2)
  }

  const outFlag = argv.indexOf('--out')
  const outDir = outFlag >= 0 && argv[outFlag + 1] ? argv[outFlag + 1] : join(root, 'export')
  const includeFixture = argv.includes('--include-fixture')

  const { CaseRegistry } = await import(new URL('../lib/cases/registry.js', import.meta.url))
  const { generateNodeTestFile, toLibSpecifier } = await import(
    new URL('../lib/export/node-test.js', import.meta.url)
  )

  const registry = new CaseRegistry(join(root, 'cases'))
  const loaded = registry.reload()

  console.log(`[export-scenarios] 场景目录：${registry.dir}`)
  console.log(
    `[export-scenarios] 可用场景：${loaded.scenarios.length}，无法解析：${loaded.invalid.length}`,
  )

  const { selected, excluded } = selectExportable(loaded.scenarios, { includeFixture })
  if (excluded > 0) {
    console.log(
      `[export-scenarios] 跳过 ${excluded} 条 fixture 场景（被测外部对象；用 --include-fixture 纳入）`,
    )
  }
  if (selected.length === 0) {
    console.error('[export-scenarios] 没有可导出的 active 场景')
    process.exit(1)
  }

  const content = generateNodeTestFile(selected, {
    casesDir: registry.dir,
    libSpecifier: toLibSpecifier(outDir, libDir),
  })

  await mkdir(outDir, { recursive: true })
  const file = join(outDir, 'scenarios.test.mjs')
  await writeFile(file, content, 'utf8')

  console.log(`[export-scenarios] 已导出 ${selected.length} 条场景 → ${file}`)
  console.log(`[export-scenarios] 运行：node --test ${file}`)
}

if (isMain) await main()
