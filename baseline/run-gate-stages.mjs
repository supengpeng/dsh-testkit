/**
 * 阶段 0-D：把 `package.json` 的 `gate` 链**逐阶段**跑一遍并计时。
 *
 * 为什么需要它：
 *   `pnpm run gate` 是一条 `a && b && c ...` 的长链，只有一个总时间。
 *   D2 基线要的是"全套执行时间"，而**各阶段的耗时分解**是判断回归发生在哪一段的依据。
 *   本脚本不复制 gate 的逻辑——它**解析 package.json 里的真源字符串**，按 ` && ` 切段，
 *   所以 gate 改了链，本脚本自动跟着改（不存在第二份会漂移的副本）。
 *
 * 语义：忠实复刻 shell 的 `&&`——某个阶段非 0 就停在它那里，后续阶段标 `not_run`。
 *
 * 用法（工作目录 = 仓库根）：
 *   & <node.exe> baseline/run-gate-stages.mjs
 * 产物：
 *   baseline/gate-stages.log    原始输出（UTF-8 无 BOM）
 *   baseline/gate-stages.json   逐阶段墙钟 + 退出码
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url))) // baseline/ 的上一级
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const gate = pkg.scripts?.gate
if (typeof gate !== 'string' || gate.length === 0) {
  console.error('[gate-stages] package.json 里没有 scripts.gate')
  process.exit(3)
}

const stages = gate.split(' && ').map((s) => s.trim()).filter(Boolean)

// 直接跑（不经 pnpm）时，node_modules/.bin 不在 PATH 上；node 自身也不在。
const nodeBin = dirname(process.execPath)
const env = {
  ...process.env,
  PATH: `${join(root, 'node_modules', '.bin')};${nodeBin};${process.env.PATH ?? ''}`,
}

const logPath = join(root, 'baseline', 'gate-stages.log')
writeFileSync(
  logPath,
  [
    '# [gate-stages] 逐阶段执行日志（由 baseline/run-gate-stages.mjs 生成）',
    `# started_at: ${new Date().toISOString()}`,
    `# node: ${process.version}`,
    `# stages: ${stages.length}`,
    '',
  ].join('\n'),
  'utf8',
)

const results = []
const totalStart = Date.now()
let stopped = false

for (let i = 0; i < stages.length; i += 1) {
  const cmd = stages[i]
  const label = `[${String(i + 1).padStart(2, '0')}/${stages.length}]`
  if (stopped) {
    results.push({ index: i, command: cmd, status: 'not_run', exit_code: null, wall_ms: null })
    appendFileSync(logPath, `${label} NOT RUN (前面阶段已失败)\n  $ ${cmd}\n`, 'utf8')
    console.log(`${label} not_run  ${cmd}`)
    continue
  }

  const t0 = Date.now()
  const r = spawnSync(cmd, { cwd: root, env, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const wallMs = Date.now() - t0
  const code = r.status === null ? -1 : r.status

  appendFileSync(
    logPath,
    [
      `${label} exit=${code} wall_ms=${wallMs}`,
      `  $ ${cmd}`,
      '  --- stdout ---',
      r.stdout ?? '',
      '  --- stderr ---',
      r.stderr ?? '',
      '',
    ].join('\n'),
    'utf8',
  )

  results.push({
    index: i,
    command: cmd,
    status: code === 0 ? 'pass' : 'fail',
    exit_code: code,
    wall_ms: wallMs,
  })
  console.log(`${label} exit=${code} ${String(wallMs).padStart(7)}ms  ${cmd.slice(0, 90)}`)
  if (code !== 0) stopped = true
}

const totalMs = Date.now() - totalStart
const summary = {
  generated_at: new Date().toISOString(),
  source: 'package.json#scripts.gate（按 " && " 切段，忠实复刻 && 短路语义）',
  node: process.version,
  platform: process.platform,
  total_wall_ms: totalMs,
  first_failing_index: results.find((r) => r.status === 'fail')?.index ?? null,
  stages: results,
}
writeFileSync(join(root, 'baseline', 'gate-stages.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
console.log(`[gate-stages] total_wall_ms=${totalMs}  first_failing_index=${summary.first_failing_index}`)
process.exit(summary.first_failing_index === null ? 0 : 1)
