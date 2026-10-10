/**
 * 夹具治理闸门：schema 合法性 / 命名一致性 / DSH 版本可解析 / 敏感数据扫描。
 *
 * 依赖已编译的 lib/（因此需要先 `npm run build` 或 `node scripts/build-lock.mjs`）。
 *
 * 用法：
 *   node scripts/verify-fixtures.mjs                   # 校验包内 fixtures/ 与 cases/
 *   node scripts/verify-fixtures.mjs --dir <path>      # 换一个夹具根
 *   node scripts/verify-fixtures.mjs --cases <path>    # 换一个场景目录（核对声明是否落地）
 *
 * 退出码：0 = 通过；1 = 有问题；2 = 缺编译产物。
 *
 * ## 为什么它必须是个"会红"的闸门
 *
 * 夹具是**共享资产**：一份写坏的夹具会污染所有引用它的场景，而表现形式是
 * "某条无关的场景莫名其妙跳过了"。所以这里逐项硬校验，而不是打警告：
 *   · 缺 `dsh_version` → 无法做版本绑定，等于把夹具变成永久的隐性依赖；
 *   · `name` 与路径不一致 → 引用它的人会去找一个不存在的文件；
 *   · 出现 token / 私钥 / 邮箱 / 家目录路径 → commit 之后就撤不回来了；
 *   · 场景声明了夹具但夹具不存在 → 该场景会在运行时被跳过，而不是在这里被发现。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const libEntry = join(root, 'lib', 'fixtures', 'load.js')
if (!existsSync(libEntry)) {
  console.error('[verify-fixtures] 未找到 lib/fixtures/load.js —— 请先运行 node scripts/build-lock.mjs')
  process.exit(2)
}

const { loadFixtures, resolveFixturePath, loadFixtureFile, defaultFixturesDir } = await import(
  new URL('../lib/fixtures/load.js', import.meta.url)
)
const { scanSensitive, describeFinding } = await import(
  new URL('../lib/fixtures/sensitive.js', import.meta.url)
)

const argv = process.argv.slice(2)
const dirFlag = argv.indexOf('--dir')
const casesFlag = argv.indexOf('--cases')
const fixturesDir = dirFlag >= 0 && argv[dirFlag + 1] ? argv[dirFlag + 1] : defaultFixturesDir()
const casesDir = casesFlag >= 0 && argv[casesFlag + 1] ? argv[casesFlag + 1] : join(root, 'cases')

let failed = false

console.log(`[verify-fixtures] 夹具根：${fixturesDir}`)

const result = loadFixtures(fixturesDir)
console.log(
  `[verify-fixtures] 夹具文件：${result.files.length}，合法：${result.fixtures.length}，非法：${result.invalid.length}`,
)

// ① 逐个坏件：schema / 命名 / dsh_version / data 结构
if (result.invalid.length > 0) {
  failed = true
  console.error(`\n[verify-fixtures] ✗ ${result.invalid.length} 份夹具不合法：`)
  for (const item of result.invalid) {
    const detail =
      item.error ?? item.issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('\n    ')
    console.error(`  - ${item.name || item.file}\n    ${detail}`)
  }
}

// ② 敏感数据：合法件与坏件都要扫（坏件也可能是"把 token 写错地方"的那种坏）
const scanned = [...result.fixtures, ...result.invalid]
for (const item of scanned) {
  if (typeof item.text !== 'string') continue
  const findings = scanSensitive(item.text)
  if (findings.length === 0) continue
  failed = true
  console.error(`\n[verify-fixtures] ✗ ${item.name || item.file} 命中 ${findings.length} 处敏感数据：`)
  for (const finding of findings) console.error(`  - ${describeFinding(finding)}`)
}

// ③ 重名：同一名字出现在两个文件里，引用时取哪一份完全看扫描顺序
const nameCount = new Map()
for (const item of result.fixtures) nameCount.set(item.name, (nameCount.get(item.name) ?? 0) + 1)
for (const [name, count] of nameCount) {
  if (count > 1) {
    failed = true
    console.error(`\n[verify-fixtures] ✗ 夹具名重复 ${count} 次：${name}`)
  }
}

// ④ 反向核对：场景声明的夹具必须真的存在（否则运行时只会"跳过"）
const casesEntry = join(root, 'lib', 'cases', 'loader.js')
if (existsSync(casesEntry) && existsSync(casesDir)) {
  const { loadCases } = await import(new URL('../lib/cases/loader.js', import.meta.url))
  const cases = loadCases(casesDir)
  const declared = new Map()
  for (const scenario of cases.scenarios) {
    for (const name of scenario.fixtures ?? []) {
      if (!declared.has(name)) declared.set(name, [])
      declared.get(name).push(scenario.id)
    }
  }
  console.log(
    `[verify-fixtures] 场景声明：${declared.size} 个夹具名，出自 ${cases.scenarios.length} 条场景`,
  )
  for (const [name, ids] of declared) {
    const path = resolveFixturePath(fixturesDir, name)
    if (path === undefined) {
      failed = true
      console.error(
        `\n[verify-fixtures] ✗ 场景声明的夹具不存在：${name}（被 ${ids.join('、')} 引用）`,
      )
      continue
    }
    const loaded = loadFixtureFile(fixturesDir, path)
    if (!loaded.ok) {
      failed = true
      console.error(`\n[verify-fixtures] ✗ 场景声明的夹具不合法：${name}（被 ${ids.join('、')} 引用）`)
    }
  }
} else {
  console.warn('[verify-fixtures] ! 跳过"场景声明核对"（缺 lib/cases/loader.js 或场景目录）')
}

// ⑤ 空目录只警告，不算失败：换 --dir 指到一个还没放夹具的目录是合法用法
if (result.files.length === 0) {
  console.warn(`[verify-fixtures] ! ${fixturesDir} 下没有任何夹具文件`)
}

if (failed) {
  console.error('\n[verify-fixtures] 校验未通过')
  process.exit(1)
}

console.log('[verify-fixtures] OK')
