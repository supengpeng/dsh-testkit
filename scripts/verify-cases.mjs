/**
 * 场景数据校验：cases/*.yaml ↔ cases/index.yaml 一致性。
 *
 * 依赖已编译的 lib/（因此需要先 `npm run build`）。
 *
 * 用法：
 *   node scripts/verify-cases.mjs            # 校验（有问题则 exit 1）
 *   node scripts/verify-cases.mjs --write    # 顺带重建 cases/index.yaml
 *   node scripts/verify-cases.mjs --dir <p>  # 指定目录
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const libEntry = join(root, 'lib', 'cases', 'loader.js')
if (!existsSync(libEntry)) {
  console.error('[verify-cases] 未找到 lib/cases/loader.js —— 请先运行 npm run build')
  process.exit(2)
}

const { loadCases } = await import(new URL('../lib/cases/loader.js', import.meta.url))

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const dirFlag = argv.indexOf('--dir')
const casesDir = dirFlag >= 0 && argv[dirFlag + 1] ? argv[dirFlag + 1] : join(root, 'cases')

const result = loadCases(casesDir)

let failed = false

console.log(`[verify-cases] 目录：${casesDir}`)
console.log(`[verify-cases] 可用场景：${result.scenarios.length}`)

if (result.invalid.length > 0) {
  failed = true
  console.error(`\n[verify-cases] ✗ ${result.invalid.length} 个文件无法解析：`)
  for (const item of result.invalid) {
    const detail = item.error ?? item.issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('\n    ')
    console.error(`  - ${item.name}\n    ${detail}`)
  }
}

// `--write` 会重建索引，所以"新场景未登记 / nextId 落后"这两类问题
// 本次就会被**写操作本身**修掉，不该算作失败；其余索引问题照常失败。
const INDEX_WRITABLE = /未登记进索引|nextId/
const blockingIssues = result.indexIssues.filter(
  (i) => !i.message.includes('索引文件缺失') && !(write && INDEX_WRITABLE.test(i.message)),
)
if (blockingIssues.length > 0) {
  failed = true
  console.error(`\n[verify-cases] ✗ 索引问题 ${blockingIssues.length} 项：`)
  for (const issue of blockingIssues) console.error(`  - ${issue.path || 'index.yaml'}：${issue.message}`)
}

// ---- 架构一致性：kind 列表 ↔ driver 注册 ↔ 场景数据 ----
//
// 这三处必须互相自洽，否则会出"看起来都写了、实际永远跑不过"的场景：
//   · `SCENARIO_KINDS`（types.ts）— 类型层的合法 kind 集合
//   · `createDriverRegistry()`     — 运行时真正有实现的 kind
//   · cases/*.yaml                 — 实际写了场景的 kind
try {
  const { SCENARIO_KINDS } = await import(new URL('../lib/cases/types.js', import.meta.url))
  const { createDriverRegistry } = await import(new URL('../lib/kinds/index.js', import.meta.url))

  const declared = new Set(SCENARIO_KINDS)
  const implemented = new Set(createDriverRegistry().kinds())

  // ① 声明了却没有 driver —— 这类场景会被 runner 记为 errored
  const missingDrivers = [...declared].filter((k) => !implemented.has(k))
  if (missingDrivers.length > 0) {
    console.warn(
      `[verify-cases] ! 已在类型里声明但尚未实现 driver 的 kind：${missingDrivers.join(', ')}`,
    )
  }

  // ② 实现了却没声明 —— 类型层漏登记，用户写这种 kind 会被 schema 拒绝
  const undeclared = [...implemented].filter((k) => !declared.has(k))
  if (undeclared.length > 0) {
    failed = true
    console.error(
      `\n[verify-cases] ✗ 已实现但未登记进 SCENARIO_KINDS 的 kind：${undeclared.join(', ')}` +
        `\n  （这会让用户写出的合法场景被 schema 校验拒绝）`,
    )
  }

  // ③ 场景用了没有 driver 的 kind —— 这条场景永远不会通过
  const orphans = result.scenarios.filter((s) => !implemented.has(s.kind))
  if (orphans.length > 0) {
    failed = true
    console.error(`\n[verify-cases] ✗ ${orphans.length} 条场景的 kind 没有对应 driver：`)
    for (const s of orphans) console.error(`  - ${s.id}: kind=${s.kind}`)
  }

  // ④ 有 driver 但一条 active 场景都没有 —— 建议（不是错误）
  const activeKinds = new Set(
    result.scenarios.filter((s) => (s.status ?? 'active') === 'active').map((s) => s.kind),
  )
  const uncovered = [...implemented].filter((k) => !activeKinds.has(k))
  if (uncovered.length > 0) {
    console.warn(
      `[verify-cases] ! 已实现但无 active 场景的 kind：${uncovered.join(', ')}（建议补一条自检场景）`,
    )
  }
} catch (error) {
  console.warn(
    `[verify-cases] ! 无法加载 kind/driver 注册表，跳过一致性检查：${error instanceof Error ? error.message : String(error)}`,
  )
}

const missingIndex = result.indexIssues.some((i) => i.message.includes('索引文件缺失'))
if (missingIndex) console.warn('[verify-cases] ! cases/index.yaml 缺失（可用 --write 生成）')

if (write) {
  // 渲染逻辑的真源在 src/cases/index-file.ts —— 提炼闸门批准落地时也用它。
  // 这里曾经有一份副本，两处渲染同一文件必然漂移，所以删掉了。
  const { writeIndexFile } = await import(new URL('../lib/cases/index-file.js', import.meta.url))
  const info = writeIndexFile(casesDir)
  console.log(`[verify-cases] 已写出 cases/index.yaml（nextId=${info.nextId}，${info.count} 条）`)
}

if (failed) {
  // 注意：`--write` 只决定"要不要重建索引"，**不能**吞掉校验失败。
  // 早先这里写的是 `failed && !write`，于是带 --write 跑时无效场景被静默放过
  // ——实测中真的骗过一次（TK-0030 的 YAML 重复键没被发现，场景凭空少了一条）。
  console.error('\n[verify-cases] 校验未通过')
  process.exit(1)
}

console.log('[verify-cases] OK')
