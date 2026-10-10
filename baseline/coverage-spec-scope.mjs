/**
 * 阶段 0-D：B1 的**实质读数（spec 声明范围口径）**。
 *
 * 背景（Lead 指出的方法学张力）：
 *   · 代理读数 = 既有测试套件对**全部** src 的分支覆盖率（78%）。它会被"阶段 0 的 spec 压根没
 *     声明覆盖"的模块（CLI 面、surface 注册面、touchstone 适配器、doctor…）拉低。
 *   · 实质读数 = 只统计 **spec 的条目真正声明覆盖的文件**（source.file 去重集合）的分支覆盖率。
 *     它回答的是另一个问题：**spec 声称覆盖的代码，被测试执行得怎么样？**
 *
 * 实现要点：`--test-coverage-exclude` 匹配的是 source map 回映**前**的 `lib/...` 路径，
 * 所以"只留 spec 声明的文件"= 把**其余所有** `lib/**\/*.js` 都排掉。排除项由脚本从
 * `baseline/spec-source-map.json` 与磁盘上的 `lib/` 现况自动推导，不手写。
 *
 * 空集合守卫：解析后若文件行数为 0，**退出码 1**（不许把空集合的 100% 当读数）。
 *
 * 用法（cwd = 仓库根，且 lib/ 已构建）：
 *   & <node.exe> baseline/coverage-spec-scope.mjs
 * 产物：
 *   baseline/coverage-stage0-spec-scope.log   原始 Node 覆盖率报告
 *   baseline/coverage-spec-scope.json         aggregate + 逐文件 + 排除项数 + 退出码
 * 退出码：0 = 有真实文件行；1 = 空集合或测试非零退出
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkJs(full, out)
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

const specMap = JSON.parse(readFileSync(join(root, 'baseline', 'spec-source-map.json'), 'utf8'))
const specSrcFiles = new Set(specMap.spec_covered_src_files.map((f) => f.path))
if (specSrcFiles.size === 0) {
  console.error('[spec-scope] spec-source-map.json 里没有任何 spec 声明的源文件，拒绝运行')
  process.exit(2)
}

const libFiles = walkJs(join(root, 'lib'))
const excludes = []
const kept = []
for (const full of libFiles) {
  const rel = relative(join(root, 'lib'), full).replace(/\\/g, '/')
  if (rel === 'client.js') continue // esbuild 产物，不是 TS 源码的 1:1 映射
  const srcPath = `src/${rel.replace(/\.js$/, '.ts')}`
  if (specSrcFiles.has(srcPath)) kept.push(srcPath)
  else excludes.push(`--test-coverage-exclude=**/lib/${rel}`)
}

const logPath = join(root, 'baseline', 'coverage-stage0-spec-scope.log')
const testArgs = [
  '--test',
  '--experimental-test-coverage',
  '--enable-source-maps',
  '--test-coverage-exclude=**/node_modules/**',
  '--test-coverage-exclude=**/tests/**',
  '--test-coverage-exclude=**/scripts/**',
  '--test-coverage-exclude=**/bin/**',
  // 精确排除生成的测试产物。**不要**写成 export 目录通配（星号+/export/+星号）：
  // 它会连带排掉 lib/export/node-test.js 与 lib/export/write.js（见 coverage.md §4.5）。
  '--test-coverage-exclude=**/export/scenarios.test.mjs',
  '--test-coverage-exclude=**/lib/client.js',
  ...excludes,
  'tests/contracts/*.test.mjs',
  'tests/*.test.mjs',
  'export/scenarios.test.mjs',
]

const t0 = Date.now()
const r = spawnSync(process.execPath, testArgs, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
const wallMs = Date.now() - t0
writeFileSync(logPath, r.stdout ?? '', 'utf8')

// 用同一个解析器解析（不复制解析逻辑）；空集合会让解析器退出 1
const tmp = mkdtempSync(join(tmpdir(), 'spec-scope-'))
const p = spawnSync(process.execPath, [join(root, 'baseline', 'parse-coverage.mjs'), '--out-dir', tmp, logPath], {
  cwd: root,
  encoding: 'utf8',
})
const parsed = JSON.parse(readFileSync(join(tmp, 'coverage-summary.json'), 'utf8'))
const run = parsed.runs[0]

const result = {
  generated_at: new Date().toISOString(),
  purpose: 'B1 的实质读数：只统计 spec 条目声明覆盖的文件',
  spec_snapshot: specMap.spec_snapshot,
  spec_declared_src_files: [...specSrcFiles].sort(),
  spec_declared_file_count: specSrcFiles.size,
  lib_kept: kept.sort(),
  lib_excluded_count: excludes.length,
  command: `node ${testArgs.join(' ')}`,
  test_exit_code: r.status,
  wall_ms: wallMs,
  run_valid: run.valid,
  totals: run.totals,
  aggregate: run.aggregate,
  file_rows: run.files.length,
  aggregate_reported_by_node_if_invalid: run.aggregate_reported_by_node ?? null,
  files: run.files,
  guard: 'file_rows === 0 ⇒ 退出码 1（空集合上的 100% 不是覆盖率）',
}
writeFileSync(join(root, 'baseline', 'coverage-spec-scope.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

console.log(`[spec-scope] spec 声明 ${specSrcFiles.size} 个文件；lib 命中 ${kept.length} 个；排除 ${excludes.length} 个`)
console.log(`[spec-scope] 测试退出码=${r.status} 墙钟=${(wallMs / 1000).toFixed(3)}s 文件行数=${run.files.length}`)
console.log(`[spec-scope] aggregate = ${JSON.stringify(run.aggregate)}`)
if (run.files.length === 0) {
  console.error('[spec-scope] 文件行数为 0 —— 空集合，拒绝把任何百分比当读数')
  process.exit(1)
}
if (r.status !== 0) {
  console.error(`[spec-scope] 测试非零退出（${r.status}），读数不可用`)
  process.exit(1)
}
console.log(`[spec-scope] OK → baseline/coverage-spec-scope.json`)
