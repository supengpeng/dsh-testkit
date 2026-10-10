/**
 * 阶段 0-D：把 `node --test --experimental-test-coverage` 的**人类可读表格**
 * 解析成机器可读 JSON，避免把数字手抄进报告（手抄 = 引入错误的地方）。
 *
 * 表格是**树形缩进**的（目录行没有百分比），所以要按缩进重建完整路径：
 *   ℹ src               |    |      |    |      <- indent 0，目录
 *   ℹ  adapters         |    |      |    |      <- indent 1，目录
 *   ℹ    tools.ts       |100 | 100  |100 |      <- indent 3，文件
 *
 * 用法（cwd = 仓库根）：
 *   & <node.exe> baseline/parse-coverage.mjs <log1> <log2> ...
 * 产物：
 *   baseline/coverage-summary.json   各次运行的合计 + 逐文件读数
 *   baseline/coverage-weakest.md     分支覆盖率最低的 src 文件（便于写报告）
 * 退出码：
 *   0 = 每条 run 都有效（报告里确实有文件行）
 *   1 = 出现"空集合"run（Node 在 files 为空时仍打印 all files = 100%）；该 run 被标 valid:false
 *       —— 这是**故意**的红：容错到"把空集合算成 100%"就等于自欺（REWRITE-METRICS §18）。
 *       负向证明见 baseline/selftest-parse-coverage.mjs。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const argv = process.argv.slice(2)
// --out-dir <dir>：把产物写到别处（负向证明脚本要用，避免覆盖已入库的 coverage-summary.json）
let outDir = join(root, 'baseline')
const logs = []
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--out-dir') {
    outDir = argv[i + 1]
    i += 1
    continue
  }
  logs.push(argv[i])
}
if (logs.length === 0) {
  console.error('用法: node baseline/parse-coverage.mjs [--out-dir <dir>] <coverage-log>...')
  process.exit(2)
}

const OBS = '\u2139 ' // 'ℹ '

function parseLog(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)

  const totals = {}
  for (const line of lines) {
    const m = /^.\s(tests|suites|pass|fail|cancelled|skipped|todo|duration_ms)\s+([\d.]+)\s*$/.exec(line)
    if (m) totals[m[1]] = Number(m[2])
  }

  const start = lines.findIndex((l) => l.includes('start of coverage report'))
  const end = lines.findIndex((l) => l.includes('end of coverage report'))
  const body = start >= 0 ? lines.slice(start, end < 0 ? undefined : end) : []

  /** @type {{path:string,line:number|null,branch:number|null,funcs:number|null,uncovered:string}[]} */
  const files = []
  let aggregate = null
  const stack = []

  for (const line of body) {
    if (!line.startsWith(OBS)) continue
    const rest = line.slice(OBS.length)
    const bar = rest.indexOf('|')
    if (bar < 0) continue
    const nameField = rest.slice(0, bar)
    const indent = nameField.length - nameField.trimStart().length
    const name = nameField.trim()
    if (name === '' || name === 'file' || name.startsWith('---')) continue

    const cols = rest
      .slice(bar + 1)
      .split('|')
      .map((c) => c.trim())
    const [linePct, branchPct, funcsPct, uncovered] = cols

    if (name === 'all files') {
      aggregate = { line: Number(linePct), branch: Number(branchPct), funcs: Number(funcsPct) }
      continue
    }

    stack.length = indent
    stack[indent] = name

    if (linePct === '') continue // 目录行
    files.push({
      path: stack.slice(0, indent + 1).join('/'),
      line: Number(linePct),
      branch: Number(branchPct),
      funcs: Number(funcsPct),
      uncovered: uncovered ?? '',
    })
  }

  return { log: basename(file), totals, aggregate, files }
}

const runs = logs.map(parseLog)

// ---- 空集合守卫（REWRITE-METRICS §18：测量工具自身也要被测）------------------
// Node 在"过滤后一个文件都没有"时，仍然打印 `all files | 100.00 | 100.00 | 100.00`。
// 那是**空集合上的退化值**，不是覆盖率——本仓纪律是"绝不假装成功"，所以：
//   · 把它标成 valid:false，并把 Node 报的合计挪到 aggregate_reported_by_node（留证据）
//   · aggregate 置 null，防止消费方误用
//   · 只要出现一条无效 run，本脚本**退出码 1**（拒绝给出"通过"的外观）
for (const run of runs) {
  if (run.files.length === 0) {
    run.valid = false
    run.aggregate_reported_by_node = run.aggregate
    run.aggregate = null
    run.invalid_reason =
      '过滤后文件集合为空（files: []）：Node 仍会打印 all files = 100.00/100.00/100.00，但空集合上的合计不是覆盖率读数。禁止当作覆盖率上报。常见原因：--test-coverage-exclude 把所有文件都排掉了（本次就是 **/lib/** 匹配到了 source map 回映前的 lib 路径）。'
    continue
  }
  run.valid = true
  if (!run.aggregate) {
    run.valid = false
    run.invalid_reason = '解析不到 `all files` 合计行'
  }
}
const invalidRuns = runs.filter((r) => r.valid === false)

const out = {
  generated_at: new Date().toISOString(),
  note: '数字来自 Node 内置 V8 覆盖率报告，经 baseline/parse-coverage.mjs 解析',
  empty_set_guard: 'files 为空的 run 一律 valid:false，且本脚本退出码 1（不允许把空集合的 100% 当读数）',
  runs,
}
writeFileSync(join(outDir, 'coverage-summary.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')

// 只挑 "旧 TS 源码"（src/ 前缀，排除 lib/client.js 这类打包产物）。
// 取**最后一次有效**运行，并按路径去重——否则多轮读数会把同一个文件列多次。
const validRuns = runs.filter((r) => r.valid)
const lastRun = validRuns[validRuns.length - 1]
if (!lastRun) {
  console.error('[parse-coverage] 没有任何有效 run（全部为空集合）——拒绝继续')
  process.exit(1)
}
const srcFiles = lastRun.files.filter((f) => f.path.startsWith('src/'))
const weakest = srcFiles.sort((a, b) => a.branch - b.branch).slice(0, 15)

const md = [
  '| 文件（分支覆盖率最低的 15 个 src 文件） | 行 % | 分支 % | 函数 % |',
  '|---|---:|---:|---:|',
  ...weakest.map((f) => `| \`${f.path}\` | ${f.line.toFixed(2)} | ${f.branch.toFixed(2)} | ${f.funcs.toFixed(2)} |`),
].join('\n')
writeFileSync(join(outDir, 'coverage-weakest.md'), `${md}\n`, 'utf8')

for (const run of runs) {
  const agg = run.valid
    ? `line=${run.aggregate.line} branch=${run.aggregate.branch} funcs=${run.aggregate.funcs}`
    : `INVALID（${run.invalid_reason}）；Node 报的合计是 ${JSON.stringify(run.aggregate_reported_by_node)}`
  console.log(
    `${run.log}\n  valid=${run.valid}  totals: ${JSON.stringify(run.totals)}\n  all files: ${agg}\n  rows=${run.files.length}  src rows=${run.files.filter((f) => f.path.startsWith('src/')).length}`,
  )
}
console.log(`\n--- weakest src files (by branch %)，取自最后一次有效 run：${lastRun.log} ---`)
console.log(md)

if (invalidRuns.length > 0) {
  console.error(
    `\n[parse-coverage] 退出码 1：${invalidRuns.length} 条 run 是无效读数（files 为空而 Node 仍报 100%）——已标 valid:false 并写入 coverage-summary.json：${invalidRuns.map((r) => r.log).join(', ')}`,
  )
  process.exit(1)
}
console.log('\n[parse-coverage] 全部 run 有效（files 非空）')
