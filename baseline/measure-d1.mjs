/**
 * 阶段 0-D：D1「单用例执行时间」冻结测量器。
 *
 * 口径（必须写进报告，否则数字没有意义）：
 *   - 代表用例：`TK-0001`（kind=tool，`cost=none`，纯离线，确定性最高，是 README 里
 *     自述的 driver 自检 smoke 用例）。
 *   - 每次运行是**全新进程**，因此**包含** Node 冷启动 + CLI 装载 + headless 宿主装配；
 *     不预热（预热会把冷启动藏起来，而冷启动正是"单用例成本"的一部分）。
 *   - 串行执行，N 默认 7（≥5）；取**中位数**，同时给出 min/max/mean 供对照。
 *   - 每条运行解析 `--json` 载荷的 `totals`，确认这一条**确实 passed**
 *     （否则"时间"可能只是失败得快）。
 *
 * 用法（cwd = 仓库根）：
 *   & <node.exe> baseline/measure-d1.mjs [N]
 * 产物：
 *   baseline/d1-samples.json  原始逐次读数 + 汇总
 *   baseline/d1-samples.log   逐次运行的原始 stdout（取证）
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const N = Number.parseInt(process.argv[2] ?? '7', 10)
if (!Number.isFinite(N) || N < 5) {
  console.error('[D1] 需要 N >= 5（分辨率纪律：样本太少无法取中位数）')
  process.exit(2)
}

const CLI = ['bin/dsh-testkit.mjs', 'run', '--only', 'TK-0001', '--json']
const env = { ...process.env, PATH: `${dirname(process.execPath)};${process.env.PATH ?? ''}` }
const logPath = join(root, 'baseline', 'd1-samples.log')
writeFileSync(
  logPath,
  `# [D1] 单用例执行时间逐次原始输出\n# started_at: ${new Date().toISOString()}\n# command: node ${CLI.join(' ')}\n# N=${N}\n\n`,
  'utf8',
)

const round = (x, d = 3) => Number(x.toFixed(d))
const samples = []

for (let i = 0; i < N; i += 1) {
  const t0 = process.hrtime.bigint()
  const r = spawnSync(process.execPath, CLI, { cwd: root, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6

  let totals = null
  let runId = null
  let parseError = null
  try {
    const payload = JSON.parse(r.stdout)
    totals = payload.totals ?? null
    runId = payload.runId ?? null
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error)
  }

  const item = {
    run: i + 1,
    wall_ms: round(wallMs),
    exit_code: r.status,
    run_id: runId,
    totals,
    parse_error: parseError,
  }
  samples.push(item)
  appendFileSync(logPath, `--- run ${i + 1}: wall_ms=${item.wall_ms} exit=${item.exit_code} ---\n${r.stdout ?? ''}\n${r.stderr ? `[stderr]\n${r.stderr}\n` : ''}`, 'utf8')
  console.log(`[D1] run ${i + 1}/${N}  ${String(item.wall_ms).padStart(9)}ms  exit=${item.exit_code}  totals=${JSON.stringify(totals)}`)
}

const times = samples.map((s) => s.wall_ms).sort((a, b) => a - b)
const mid = Math.floor(times.length / 2)
const median = times.length % 2 === 1 ? times[mid] : (times[mid - 1] + times[mid]) / 2
const mean = times.reduce((a, b) => a + b, 0) / times.length

const summary = {
  metric: 'D1',
  definition: '单条代表用例（TK-0001）端到端墙钟：全新进程，含冷启动',
  command: `node ${CLI.join(' ')}`,
  case_id: 'TK-0001',
  sample_size: N,
  warmup: 'none',
  includes_cold_start: true,
  value_ms_median: round(median),
  min_ms: times[0],
  max_ms: times[times.length - 1],
  mean_ms: round(mean),
  all_runs_passed: samples.every((s) => s.exit_code === 0 && s.totals?.passed === 1 && s.totals?.failed === 0),
  raw_samples_ms: samples.map((s) => s.wall_ms),
  generated_at: new Date().toISOString(),
  samples,
}
writeFileSync(join(root, 'baseline', 'd1-samples.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(`[D1] median=${summary.value_ms_median}ms  min=${summary.min_ms}  max=${summary.max_ms}  all_passed=${summary.all_runs_passed}`)
process.exit(summary.all_runs_passed ? 0 : 1)
