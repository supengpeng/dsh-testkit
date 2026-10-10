/**
 * 发布清单断言（`scripts/check-pack-manifest.mjs`）的回归测试。
 *
 * ## 为什么值得单测
 *
 * 这条判据**第一次上发布工作流就炸了**，而且炸得很有教育意义：断言本身没写错，
 * 是 `npm pack` 会执行 `prepare`（构建脚本），而构建脚本当时往 **stdout** 打诊断，
 * 于是 `pack.json` = `[build-client] → ...` + JSON → `JSON.parse` 直接抛
 * `Unexpected token 'b'`，报错信息里**完全不缺件**。
 *
 * 所以这里钉三件事：
 *   ① 正常清单 → 通过；
 *   ② 缺件 → 红，且点名缺哪一项；
 *   ③ **输出被污染 → 红，且把污染的开头打出来**（下次一眼看出是谁打的）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

import {
  REQUIRED_PREFIXES,
  missingPrefixes,
  parsePackJson,
} from '../scripts/check-pack-manifest.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'scripts', 'check-pack-manifest.mjs')

/** 造一份最小 pack.json：必需目录都在 + 一个普通文件。 */
function packJson(extraFiles = [], omit = []) {
  const files = [
    ...REQUIRED_PREFIXES.filter((p) => !omit.includes(p)).map((p) => `${p}index.js`),
    ...extraFiles,
  ].map((path) => ({ path }))
  return [{ name: '@supengpeng/dsh-testkit', files }]
}

function runWith(content) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-pack-'))
  try {
    const file = join(dir, 'pack.json')
    writeFileSync(file, content)
    const result = spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('纯函数：必需前缀齐全 → 无缺件', () => {
  const files = REQUIRED_PREFIXES.flatMap((p) => [`${p}index.js`])
  assert.deepEqual(missingPrefixes(files), [])
})

test('纯函数：缺 bin/ 与 dsh/ → 精确点名', () => {
  const files = REQUIRED_PREFIXES.filter((p) => p !== 'bin/' && p !== 'dsh/').map((p) => `${p}x.js`)
  assert.deepEqual(missingPrefixes(files), ['bin/', 'dsh/'])
})

test('parsePackJson：合法 JSON → 取出 files', () => {
  const parsed = parsePackJson(JSON.stringify(packJson(['package.json', 'README.md'])))
  assert.equal(parsed.ok, true)
  assert.ok(parsed.ok && parsed.files.includes('package.json'))
  assert.ok(parsed.ok && parsed.files.includes('README.md'))
})

test('parsePackJson：被 prepare 的 stdout 污染 → 明确报"不是合法 JSON"并回显开头', () => {
  const polluted = `[build-client] → lib/client.js (id=@supengpeng/dsh-testkit)\n${JSON.stringify(packJson())}`
  const parsed = parsePackJson(polluted)
  assert.equal(parsed.ok, false)
  assert.match(parsed.ok === false ? parsed.reason : '', /不是合法 JSON/)
  assert.match(parsed.ok === false ? parsed.head : '', /build-client/)
})

test('端到端：齐全 → exit 0', () => {
  const { status, stdout } = runWith(JSON.stringify(packJson()))
  assert.equal(status, 0, stdout)
  assert.match(stdout, /check-pack-manifest\] OK/)
})

test('端到端：缺 bin/ → exit 1 且点名', () => {
  const { status, stderr } = runWith(JSON.stringify(packJson([], ['bin/'])))
  assert.equal(status, 1)
  assert.match(stderr, /发布清单缺件：bin\//)
})

test('端到端：输出被污染 → exit 1 且回显污染内容（不是报"缺件"）', () => {
  const polluted = `[build-lock] 已取到锁，开始编译\n${JSON.stringify(packJson())}`
  const { status, stderr } = runWith(polluted)
  assert.equal(status, 1)
  assert.match(stderr, /不是合法 JSON/)
  assert.match(stderr, /build-lock/)
  assert.doesNotMatch(stderr, /缺件/, '这不是缺件，别误导后来人')
})

/**
 * 根因守卫：`prepare` 用的两个脚本**不许**往 stdout 打日志。
 *
 * 静态检查而不是执行：`build-lock.mjs` 会跑 tsc（几十秒且要抢构建锁），
 * 在并行的测试进程里执行它既慢又会互相干扰；而"有没有 console.log"是纯文本问题。
 */
test('prepare 脚本不许往 stdout 打日志（诊断必须走 stderr）', () => {
  for (const script of ['build-lock.mjs', 'build-client.mjs']) {
    const source = readFileSync(join(ROOT, 'scripts', script), 'utf8')
    assert.doesNotMatch(
      source,
      /console\.log\(/,
      `${script} 里有 console.log：它属于 prepare，stdout 被污染会让 npm pack --json 变成非 JSON`,
    )
  }
})
