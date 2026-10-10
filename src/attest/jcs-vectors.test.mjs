/**
 * JCS 向量驱动测试（TS 侧）：必须通过 `spec/vectors/jcs/*.json` 的**全部**向量。
 *
 * 这是设计 §7.2 的"向量驱动 + 跨实现一致性"的一半：Rust 侧 65 条全过，
 * TS 侧也要 65 条全过，且都是**各算各的**。若某一侧实现不了，按 §7.2 的降级路径
 * 必须显式标 `degraded`——本文件不做降级，所以两侧都必须全过。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { canonicalizeText, formatEsNumber, quote } from './jcs.mjs'
import { toHex } from './hex.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const vectorDir = join(repoRoot, 'spec', 'vectors', 'jcs')

/** 读取全部向量文件（按文件名排序，保证输出顺序稳定）。 */
function loadVectors() {
  return readdirSync(vectorDir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => ({
      name,
      file: JSON.parse(readFileSync(join(vectorDir, name), 'utf8')),
    }))
}

test('TS 侧通过全部 JCS 向量', () => {
  const files = loadVectors()
  assert.ok(files.length > 0, 'spec/vectors/jcs/ 下必须有向量文件')
  let total = 0
  const coverage = new Set()
  for (const { name, file } of files) {
    assert.equal(file.domain, 'jcs', `${name} 的 domain 必须是 jcs`)
    let passed = 0
    for (const entry of file.cases) {
      const actual = toHex(Buffer.from(canonicalizeText(entry.input_json), 'utf8'))
      assert.equal(
        actual,
        entry.expected_hex,
        `${name} / ${entry.id} 规范化字节不符：${entry.note}\n  输入：${entry.input_json}\n  实测：${actual}\n  期望：${entry.expected_hex}`,
      )
      passed += 1
      total += 1
      coverage.add(entry.covers)
    }
    assert.equal(passed, file.cases.length)
    console.log(`[JCS-TS] ${name.padEnd(22)} ${passed}/${file.cases.length} 通过`)
  }
  console.log(`[JCS-TS] 合计通过 ${total} 条向量；覆盖类别：${[...coverage].sort().join(', ')}`)
  assert.equal(total, 65, `向量总数应当是 65（实际 ${total}）——改动向量文件必须同步说明`)
  for (const required of ['key_order', 'number', 'unicode', 'escape', 'nested', 'empty']) {
    assert.ok(coverage.has(required), `向量必须覆盖 ${required}`)
  }
})

test('数字形态以 ECMAScript Number::toString 为准', () => {
  const expectations = new Map([
    [1.0, '1'],
    [100, '100'],
    [1e21, '1e+21'],
    [1e20, '100000000000000000000'],
    [1e-6, '0.000001'],
    [1e-7, '1e-7'],
    [0.1, '0.1'],
    [1e-323, '1e-323'],
    [-0, '0'],
  ])
  for (const [value, expected] of expectations) {
    assert.equal(formatEsNumber(value), expected, `数字 ${value}`)
  }
  assert.throws(() => formatEsNumber(Number.NaN), /NaN/)
  assert.throws(() => formatEsNumber(Number.POSITIVE_INFINITY), /NaN|Infinity/)
})

test('字符串只逃逸强制集，且拒绝孤立代理项', () => {
  assert.equal(quote('\u00e9'), '"\u00e9"')
  assert.equal(quote('\u0000'), '"\\u0000"')
  assert.equal(quote('\u001f'), '"\\u001f"')
  assert.equal(quote('a\bb'), '"a\\bb"')
  assert.equal(quote('a\tb'), '"a\\tb"')
  // DEL 与 U+2028/U+2029 不在强制逃逸集里。
  assert.equal(quote('\u007f'), '"\u007f"')
  assert.equal(quote('\u2028\u2029'), '"\u2028\u2029"')
  // 孤立代理项必须抛错（不静默替换成 U+FFFD——那会毁掉"同语义 ⇒ 同字节"）。
  assert.throws(() => quote('\ud800'), /孤立代理项/)
  assert.throws(() => quote('a\udfff'), /孤立代理项/)
})
