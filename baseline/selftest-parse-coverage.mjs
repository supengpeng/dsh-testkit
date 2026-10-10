/**
 * 阶段 0-D：`parse-coverage.mjs` 的**负向证明**（REWRITE-METRICS §18 与 rfc/README §6：
 * 守卫必须有"故意造出该缺陷，工具必须红"的证明，而不是安慰剂）。
 *
 * 要证明的缺陷是**最危险的一种覆盖率错误**：
 *   「过滤后一个文件都没有」时，Node 仍然打印 `all files | 100.00 | 100.00 | 100.00`。
 *   如果解析器把这个退化值当成覆盖率，就会得出"覆盖率满分"的完全错误结论。
 *
 * 两侧都钉：
 *   ① 负向：喂一个**空集合**日志 → 脚本必须**退出码 1**，且该 run 被标 `valid:false`、`aggregate=null`
 *   ② 正向对照：喂一个**有文件行**的日志 → 脚本必须**退出码 0**，且 `valid:true`
 *      （没有正向对照，"永远红"也能骗过测试）
 *
 * 用法（cwd = 仓库根）：
 *   & <node.exe> baseline/selftest-parse-coverage.mjs
 * 退出码：0 = 两侧行为都符合预期；1 = 至少一侧不符合
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const script = join(root, 'baseline', 'parse-coverage.mjs')
const work = mkdtempSync(join(tmpdir(), 'parse-cov-selftest-'))

/** Node 在"没有匹配文件"时真实打印的形态（已在本机 Node v24.21.0 实测过）。 */
const EMPTY_LOG = [
  '\u2714 t (1.234ms)',
  '\u2139 tests 1',
  '\u2139 suites 0',
  '\u2139 pass 1',
  '\u2139 fail 0',
  '\u2139 skipped 0',
  '\u2139 duration_ms 100',
  '\u2139 start of coverage report',
  '\u2139 ------------------------------------------------------------------',
  '\u2139 file      | line % | branch % | funcs % | uncovered lines',
  '\u2139 ------------------------------------------------------------------',
  '\u2139 ------------------------------------------------------------------',
  '\u2139 all files | 100.00 |   100.00 |  100.00 | ',
  '\u2139 ------------------------------------------------------------------',
  '\u2139 end of coverage report',
  '',
].join('\n')

/** 正向对照：有一个文件行。 */
const NONEMPTY_LOG = [
  '\u2714 t (1.234ms)',
  '\u2139 tests 1',
  '\u2139 pass 1',
  '\u2139 fail 0',
  '\u2139 skipped 0',
  '\u2139 duration_ms 100',
  '\u2139 start of coverage report',
  '\u2139 ------------------------------------------',
  '\u2139 file      | line % | branch % | funcs % | uncovered lines',
  '\u2139 ------------------------------------------',
  '\u2139 src       |        |          |         | ',
  '\u2139  s.ts     |  90.00 |    66.67 |  100.00 | 8',
  '\u2139 ------------------------------------------',
  '\u2139 all files |  90.00 |    66.67 |  100.00 | ',
  '\u2139 ------------------------------------------',
  '\u2139 end of coverage report',
  '',
].join('\n')

function runCase(name, logText, expectExit) {
  const logPath = join(work, `${name}.log`)
  const outDir = join(work, name)
  writeFileSync(logPath, logText, 'utf8')
  // outDir 由脚本自己写文件，先建目录
  const mk = spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(outDir)},{recursive:true})`], { encoding: 'utf8' })
  if (mk.status !== 0) throw new Error('无法创建临时输出目录')

  const r = spawnSync(process.execPath, [script, '--out-dir', outDir, logPath], { encoding: 'utf8' })
  const summary = JSON.parse(readFileSync(join(outDir, 'coverage-summary.json'), 'utf8'))
  const rec = summary.runs[0]
  return { name, exit: r.status, expectExit, rec, stdout: r.stdout, stderr: r.stderr }
}

const failures = []

const neg = runCase('empty', EMPTY_LOG, 1)
console.log(`[负向] 空集合日志：退出码 ${neg.exit}（期望 1）｜valid=${neg.rec.valid}｜aggregate=${JSON.stringify(neg.rec.aggregate)}｜Node 报的合计=${JSON.stringify(neg.rec.aggregate_reported_by_node)}`)
if (neg.exit !== 1) failures.push(`空集合日志应退出码 1，实得 ${neg.exit}`)
if (neg.rec.valid !== false) failures.push('空集合 run 应标 valid:false')
if (neg.rec.aggregate !== null) failures.push('空集合 run 的 aggregate 应为 null（不许把 100% 留在可消费字段里）')
if (neg.rec.aggregate_reported_by_node?.branch !== 100) failures.push('应保留 Node 报的 100 作为证据')
if (!neg.rec.invalid_reason) failures.push('空集合 run 应写明 invalid_reason')

const pos = runCase('nonempty', NONEMPTY_LOG, 0)
console.log(`[正向] 有文件行日志：退出码 ${pos.exit}（期望 0）｜valid=${pos.rec.valid}｜aggregate=${JSON.stringify(pos.rec.aggregate)}｜files=${pos.rec.files.length}`)
if (pos.exit !== 0) failures.push(`有文件行的日志应退出码 0，实得 ${pos.exit}`)
if (pos.rec.valid !== true) failures.push('有文件行的 run 应标 valid:true')
if (pos.rec.aggregate?.branch !== 66.67) failures.push(`合计应解析为 66.67，实得 ${pos.rec.aggregate?.branch}`)
if (pos.rec.files.length !== 1 || pos.rec.files[0]?.path !== 'src/s.ts') {
  failures.push(`应解析出 1 个文件且路径为 src/s.ts，实得 ${JSON.stringify(pos.rec.files)}`)
}

console.log(failures.length === 0 ? '\n[selftest] 通过：空集合变红、有文件行变绿（两侧都钉住了）' : `\n[selftest] 失败：\n - ${failures.join('\n - ')}`)
process.exit(failures.length === 0 ? 0 : 1)
