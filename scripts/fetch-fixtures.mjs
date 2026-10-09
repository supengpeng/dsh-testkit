/**
 * 准备外部 fixture（被测对象）。
 *
 * ## 为什么需要
 *
 * 有些场景要测**别人发布的包**（例如 `@furongjun1999/dsh-memory`）。
 * 这类对象不适合进仓库（40MB+），但场景需要一个稳定、可复现的引用方式。
 * 于是约定：fixture 解到 `<包根>/.fixtures/<name>`（git 忽略），
 * 场景里用 `$FIXTURES/<name>` 引用。
 *
 * **缺失时不会让场景假装通过**：`file` / `shell` driver 在显式给出了
 * `root` / `cwd` 却不存在时会 **SkipCase 并说明**，报告里会看到
 * 「请先跑 scripts/fetch-fixtures.mjs」。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/fetch-fixtures.mjs            # 准备全部
 * node scripts/fetch-fixtures.mjs dsh-memory # 只准备一个
 * node scripts/fetch-fixtures.mjs --list     # 只列清单
 * ```
 */

import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const fixturesRoot = join(root, '.fixtures')

/**
 * fixture 清单。加一条就多一个可复现的被测对象。
 *
 * `tarball` 用 npm registry 的直链：不需要 npm/pnpm 在场，也不写 package.json，
 * 因此不会碰到任何 profile 或全局状态。
 */
const FIXTURES = [
  {
    name: 'dsh-memory-0.8.1',
    tarball: 'https://registry.npmjs.org/@furongjun1999/dsh-memory/-/dsh-memory-0.8.1.tgz',
    note: 'DSH 记忆插件（Python + MCP server）；issue 数据里的 #48 / #12 都关于它的发包面',
  },
]

const args = process.argv.slice(2)
if (args.includes('--list')) {
  for (const f of FIXTURES) {
    const dir = join(fixturesRoot, f.name)
    console.log(`${existsSync(dir) ? '✓' : '·'} ${f.name}`)
    console.log(`    ${f.note}`)
    console.log(`    ${f.tarball}`)
  }
  process.exit(0)
}

const wanted = args.filter((a) => !a.startsWith('--'))
const targets = wanted.length === 0 ? FIXTURES : FIXTURES.filter((f) => wanted.includes(f.name))

if (targets.length === 0) {
  console.error(`[fetch-fixtures] 没有匹配的 fixture。可选：${FIXTURES.map((f) => f.name).join(', ')}`)
  process.exit(2)
}

mkdirSync(fixturesRoot, { recursive: true })

for (const fixture of targets) {
  const dir = join(fixturesRoot, fixture.name)
  if (existsSync(dir) && !args.includes('--force')) {
    const count = readdirSync(dir).length
    console.log(`[fetch-fixtures] ${fixture.name} 已存在（${count} 个顶层项），跳过（--force 可强制重下）`)
    continue
  }

  const tgz = join(fixturesRoot, `${fixture.name}.tgz`)
  console.log(`[fetch-fixtures] 下载 ${fixture.tarball}`)

  try {
    const res = await fetch(fixture.tarball)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const { writeFileSync } = await import('node:fs')
    writeFileSync(tgz, buf)
    console.log(`[fetch-fixtures] 已下载 ${(buf.length / 1024 / 1024).toFixed(1)} MB`)
  } catch (error) {
    console.error(`[fetch-fixtures] ✗ 下载失败：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    continue
  }

  // 解压：npm tarball 的内部根目录固定是 `package/`
  const staging = join(fixturesRoot, `${fixture.name}.staging`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  const { execFileSync } = await import('node:child_process')
  try {
    execFileSync('tar', ['-xzf', tgz, '-C', staging], { stdio: 'inherit' })
    const inner = join(staging, 'package')
    if (!existsSync(inner)) throw new Error('tarball 里没有 package/ 目录')
    rmSync(dir, { recursive: true, force: true })
    const { renameSync } = await import('node:fs')
    renameSync(inner, dir)
    rmSync(staging, { recursive: true, force: true })
    rmSync(tgz, { force: true })
    console.log(`[fetch-fixtures] ✓ ${fixture.name} → ${dir}`)
  } catch (error) {
    console.error(
      `[fetch-fixtures] ✗ 解压失败（需要系统有 tar）：${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}

console.log('[fetch-fixtures] 完成')
