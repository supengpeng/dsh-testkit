/**
 * 跨实现一致性：随机 JSON 的规范化字节必须与 Rust 侧**逐字节相同**（设计 §7.2）。
 *
 * 生成器是一条确定性 LCG，两侧各写一份（Rust：`crates/attest/tests/support/mod.rs`
 * 的 `random_json_documents`；TS：本文件）。这里做两件事：
 *
 *   1. 用 TS 侧生成器重算输入文本，与 Rust 落盘的输入**逐行比对**——
 *      证明"两侧的生成器是同一个"；
 *   2. 用 TS 侧的 JCS 实现重算规范化字节，与 Rust 落盘的 hex 比对——
 *      证明"两侧的规范化实现是同一个语义"。
 *
 * 对拍文件由 `cargo test -p dsh-testkit-attest --test jcs_cross` 生成在
 * `target/attest/jcs-random.txt`。文件不存在时**显式 skip**（可见地跳过，不是静默通过）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { toHex } from './hex.mjs'
import { canonicalizeText } from './jcs.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const crossPath = join(repoRoot, 'target', 'attest', 'jcs-random.txt')

/** 随机文档数量（必须与 Rust 侧 `RANDOM_DOCUMENT_COUNT` 相同）。 */
export const RANDOM_DOCUMENT_COUNT = 200

/** 数字 token（必须与 Rust 侧 `NUM_TOKENS` 逐字相同）。 */
const NUM_TOKENS = [
  '0',
  '1',
  '-1',
  '1.0',
  '2.5',
  '1e2',
  '1E2',
  '1e-7',
  '1e-6',
  '1e21',
  '1e20',
  '0.0001',
  '123.456',
  '9007199254740993',
  '1000000000000000128',
  '-0',
  '0.0',
  '1.5e300',
  '5e-324',
  '3.141592653589793',
]

/** 字符串 token（已含引号与转义；必须与 Rust 侧 `STR_TOKENS` 逐字相同）。 */
const STR_TOKENS = [
  '"a"',
  '""',
  '"\\u00e9"',
  '"\u00e9"',
  '"\\u0000"',
  '"\\u001f"',
  '"\\\\"',
  '"\\""',
  '"line\\nbreak"',
  '"tab\\there"',
  '"\\u007f"',
  '"\u4e2d\u6587"',
  '"\\ud83d\\ude00"',
  '"\u{1f600}"',
  '"\\u2028"',
  '"e\\u0301"',
  '"\\u0008\\u000c\\u000d"',
]

/** 键 token（必须与 Rust 侧 `KEY_TOKENS` 逐字相同）。 */
const KEY_TOKENS = [
  '"a"',
  '"b"',
  '"z"',
  '"A"',
  '""',
  '"\u00e9"',
  '"\\u00e9"',
  '"\u4e2d\u6587"',
  '"aa"',
  '"a b"',
  '"\\u0000"',
]

/**
 * LCG 步进（32 位回绕，与 Rust 的 wrapping 运算等价）。
 * @param {number} state 当前状态
 * @returns {number} 新状态
 */
function next(state) {
  return (Math.imul(state, 1103515245) + 12345) >>> 0
}

/**
 * 生成一个标量文本。
 *
 * 状态推进必须与 Rust 侧逐字对应：`gen_scalar` **只消耗恰好一次** `next()`。
 * @param {number} state 状态
 * @param {number} bucket 桶号
 * @returns {{text: string, state: number}} 文本与新状态
 */
function genScalar(state, bucket) {
  const cursor = next(state)
  if (bucket === 0) {
    return { text: NUM_TOKENS[cursor % NUM_TOKENS.length], state: cursor }
  }
  if (bucket === 1) {
    return { text: STR_TOKENS[cursor % STR_TOKENS.length], state: cursor }
  }
  if (bucket === 2) {
    return { text: ['true', 'false', 'null'][cursor % 3], state: cursor }
  }
  return { text: ['{}', '[]'][cursor % 2], state: cursor }
}

/**
 * 生成一个随机 JSON 文档的**文本**（与 Rust 侧 `gen_value` 结构一一对应）。
 * @param {number} state 状态
 * @param {number} depth 深度
 * @returns {{text: string, state: number}} 文本与新状态
 */
function genValue(state, depth) {
  let cursor = next(state)
  const roll = cursor % 12
  if (depth >= 3) return genScalar(cursor, roll)
  if (roll <= 2) return genScalar(cursor, 0)
  if (roll <= 5) return genScalar(cursor, 1)
  if (roll === 6) return genScalar(cursor, 2)
  if (roll === 7) return genScalar(cursor, 3)
  if (roll <= 10) {
    const countCursor = next(cursor)
    const count = countCursor % 4
    let inner = countCursor
    const items = []
    for (let index = 0; index < count; index += 1) {
      const step = genValue(inner, depth + 1)
      items.push(step.text)
      inner = step.state
    }
    return { text: `[${items.join(',')}]`, state: inner }
  }
  const countCursor = next(cursor)
  const count = countCursor % 4
  const baseCursor = next(countCursor)
  const base = baseCursor % KEY_TOKENS.length
  let inner = baseCursor
  const pairs = []
  for (let offset = 0; offset < count; offset += 1) {
    const step = genValue(inner, depth + 1)
    pairs.push(`${KEY_TOKENS[(base + offset) % KEY_TOKENS.length]}:${step.text}`)
    inner = step.state
  }
  return { text: `{${pairs.join(',')}}`, state: inner }
}

/**
 * 生成与 Rust 侧同一批随机文档。
 * @param {number} count 数量
 * @returns {string[]} 文档文本
 */
export function randomJsonDocuments(count) {
  const documents = []
  for (let index = 0; index < count; index += 1) {
    const seed = (0x9e3779b9 + (Math.imul(index, 2654435761) >>> 0)) >>> 0
    documents.push(genValue(seed, 0).text)
  }
  return documents
}

test('生成器与 JCS 实现都与 Rust 侧逐字节一致', (t) => {
  if (!existsSync(crossPath)) {
    t.skip(
      `缺少 ${crossPath}：先跑 cargo test -p dsh-testkit-attest --test jcs_cross（该测试会生成对拍文件）`,
    )
    return
  }
  const lines = readFileSync(crossPath, 'utf8').split('\n').filter((line) => line.length > 0)
  assert.equal(lines.length, RANDOM_DOCUMENT_COUNT, '对拍文件的行数必须等于随机文档数')
  const documents = randomJsonDocuments(RANDOM_DOCUMENT_COUNT)
  assert.equal(documents.length, RANDOM_DOCUMENT_COUNT)

  let compared = 0
  for (let index = 0; index < lines.length; index += 1) {
    const [rustInput, rustHex] = lines[index].split('\t')
    const tsInput = documents[index]
    assert.equal(tsInput, rustInput, `第 ${index} 份文档的输入文本不一致（生成器漂移了）`)
    const tsHex = toHex(Buffer.from(canonicalizeText(tsInput), 'utf8'))
    assert.equal(tsHex, rustHex, `第 ${index} 份文档的规范化字节不一致\n  输入：${tsInput}`)
    compared += 1
  }
  console.log(`[JCS-cross] 两侧对 ${compared} 份随机文档的规范化字节逐字节一致`)
})
