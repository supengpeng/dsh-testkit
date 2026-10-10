/**
 * 阶段 0-D：把「判定口径（change_final）」的**全部历史读数**从日志里汇总出来。
 *
 * 为什么要它：B1 的判定口径读过不止一次（同一命令重复运行 + 裁决变动），
 * 而"取哪一次的数"不能靠记忆。本脚本**从原始日志**抽读数（不是手抄），
 * 给出 min / median / max 与"每一次都过门槛吗"的逐条判定。
 *
 * 数据来源：
 *   baseline/coverage-change-scope-run*.log   每次完整运行的 stdout（按 rows=31 过滤）
 *   baseline/coverage-final-repeat.json       --repeat-final 的复采记录
 *
 * 用法（cwd = 仓库根）：& <node.exe> baseline/coverage-final-summary.mjs
 * 产物：baseline/coverage-final-summary.json
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const baselinedir = join(root, 'baseline')

/** 判定口径的文件数（撤销裁决五后的最终值）。 */
const FINAL_FILE_COUNT = 31
const THRESHOLD = 80

const readings = []

// ① 从每次完整运行的日志里抽 rows=31 的那一行
const runLogs = readdirSync(baselinedir)
  .filter((f) => /^coverage-change-scope-run\d+\.log$/.test(f))
  .sort()
for (const f of runLogs) {
  const text = readFileSync(join(baselinedir, f), 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[([a-z0-9_-]+)\]\s+kept=\s*\d+\s+excluded=\s*\d+\s+rows=\s*(\d+)\s+test_exit=(\d+)\s+wall=([\d.]+)s\s+aggregate=(\{.*\})$/.exec(line.trim())
    if (!m) continue
    const [, label, rows, exit, wall, agg] = m
    if (Number(rows) !== FINAL_FILE_COUNT) continue
    const a = JSON.parse(agg)
    readings.push({
      source: f,
      label,
      branch: a.branch,
      line: a.line,
      funcs: a.funcs,
      rows: Number(rows),
      test_exit_code: Number(exit),
      wall_s: Number(wall),
      note: '来自完整运行的 stdout',
    })
  }
}

// ② 复采记录
try {
  const repeat = JSON.parse(readFileSync(join(baselinedir, 'coverage-final-repeat.json'), 'utf8'))
  for (const r of repeat.readings ?? []) {
    readings.push({
      source: 'coverage-final-repeat.json',
      label: 'change_final(--repeat-final)',
      branch: r.aggregate.branch,
      line: r.aggregate.line,
      funcs: r.aggregate.funcs,
      rows: r.file_rows,
      test_exit_code: r.test_exit_code,
      wall_s: Number((r.wall_ms / 1000).toFixed(1)),
      measured_at: r.measured_at,
      note: '来自 --repeat-final 复采',
    })
  }
} catch {
  // 还没有复采记录
}

if (readings.length === 0) {
  console.error('[final-summary] 没找到任何 rows=' + FINAL_FILE_COUNT + ' 的读数（日志缺失？）')
  process.exit(2)
}

const branches = readings.map((r) => r.branch).sort((a, b) => a - b)
const mid = Math.floor(branches.length / 2)
const median = branches.length % 2 === 1 ? branches[mid] : Number(((branches[mid - 1] + branches[mid]) / 2).toFixed(2))

const out = {
  generated_at: new Date().toISOString(),
  purpose: '判定口径（change_final，31 个文件）的全部历史读数汇总 + 逐条门槛判定',
  definition: '分母 = 设计 §1.2「变更」∪ 归属表显式加入者（tools.ts / commands.ts）− 显式移出者（kinds/types.ts）；裁决五（把 cli/index.ts 计入）已被 Lead 撤销',
  file_count: FINAL_FILE_COUNT,
  threshold: THRESHOLD,
  reading_count: readings.length,
  readings: readings.sort((a, b) => a.branch - b.branch),
  statistics: {
    min: branches[0],
    median,
    max: branches[branches.length - 1],
    range_pp: Number((branches[branches.length - 1] - branches[0]).toFixed(2)),
    mean: Number((branches.reduce((a, b) => a + b, 0) / branches.length).toFixed(3)),
  },
  verdict_per_reading: readings.map((r) => ({ source: r.source, label: r.label, branch: r.branch, pass: r.branch >= THRESHOLD })),
  all_readings_pass: readings.every((r) => r.branch >= THRESHOLD),
  margin_of_weakest_reading_pp: Number((branches[0] - THRESHOLD).toFixed(2)),
  discipline_note:
    'REWRITE-METRICS §18 给覆盖率工具的误差门槛是 ≤0.1%（百分点量级）。本口径 5 次读数的聚合极差已达到 0.26pp——**超过该门槛**。这是"读数必须在多处重采后才可下判定"的直接证据（不是结论，是给裁决者的输入）。',
}
writeFileSync(join(baselinedir, 'coverage-final-summary.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')

console.log(`判定口径（${FINAL_FILE_COUNT} 文件）历史读数 ${readings.length} 次：`)
for (const r of out.readings) console.log(`  ${String(r.branch).padStart(6)}%  [${r.label}]  ${r.source}  wall=${r.wall_s}s`)
console.log(`min=${out.statistics.min}  median=${out.statistics.median}  max=${out.statistics.max}  极差=${out.statistics.range_pp}pp`)
console.log(`每一次都过 ${THRESHOLD}% 吗：${out.all_readings_pass ? '是（最弱一次仍高 ' + out.margin_of_weakest_reading_pp + 'pp）' : '否'}`)
