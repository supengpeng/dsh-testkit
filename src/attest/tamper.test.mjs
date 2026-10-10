/**
 * E2（TS 侧）：五类篡改注入的检出率必须 100%，且每类 ≥ 10 个用例（指标 §6）。
 *
 * 与 Rust 侧 `crates/attest/tests/tamper.rs` 读**同一份语料**、用**各自独立的注入器与验证器**，
 * 结论必须逐字段相同（`cross-check.test.mjs` 逐例 diff 兜底）。
 */

import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { baseById, evaluateCase, loadCorpus, resolveOptions } from './tamper.mjs'
import { renderVerdict, verifyChain } from './verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

/** 指标 E2 要求的五类。 */
const REQUIRED_CLASSES = ['field', 'delete', 'reorder', 'insert', 'signature']

test('五类篡改：每类 ≥10 例且检出率 100%', () => {
  const corpus = loadCorpus(repoRoot)
  console.log(`=== E2 篡改检出率（TS 侧，语料 ${join(repoRoot, 'spec/vectors/attest/corpus.json')}）===`)
  let grandTotal = 0
  let grandDetected = 0
  for (const className of REQUIRED_CLASSES) {
    const cases = corpus.cases.filter((entry) => entry.class === className)
    assert.ok(cases.length >= 10, `类别 ${className} 的用例数 ${cases.length} < 10`)
    let detected = 0
    for (const entry of cases) {
      const { verdict } = evaluateCase(corpus, entry)
      assert.deepEqual(
        verdict,
        entry.expected,
        `用例 ${entry.id} 结论不符：实测 ${renderVerdict(verdict)} / 期望 ${renderVerdict(entry.expected)}`,
      )
      if (!verdict.chainOk) detected += 1
    }
    const rate = (detected * 100) / cases.length
    console.log(
      `[E2-TS] ${className.padEnd(10)} 用例 ${String(cases.length).padStart(2)} / 检出 ${String(detected).padStart(2)} / 检出率 ${rate.toFixed(1)}%`,
    )
    assert.equal(detected, cases.length, `类别 ${className} 的检出率不是 100%`)
    grandTotal += cases.length
    grandDetected += detected
  }
  console.log(
    `[E2-TS] 合计 ${grandDetected}/${grandTotal} = ${((grandDetected * 100) / grandTotal).toFixed(1)}%（门槛 100%）`,
  )
  assert.equal(grandDetected, grandTotal)
})

test('额外机制（Merkle 证据 / 链头）也能被检出', () => {
  const corpus = loadCorpus(repoRoot)
  const cases = corpus.cases.filter((entry) => entry.class === 'extras')
  assert.ok(cases.length >= 4)
  for (const entry of cases) {
    const { verdict } = evaluateCase(corpus, entry)
    assert.deepEqual(verdict, entry.expected, `用例 ${entry.id} 结论不符`)
    assert.equal(verdict.chainOk, false, `用例 ${entry.id} 应当被检出`)
  }
  console.log(`[E2-TS-extras] ${cases.length}/${cases.length} 被检出`)
})

test('边界：重写整链并重新签名**检不出**（设计 §7.5）', () => {
  const corpus = loadCorpus(repoRoot)
  assert.ok(corpus.boundary_cases.length >= 2, '边界用例必须存在')
  for (const entry of corpus.boundary_cases) {
    const { verdict } = evaluateCase(corpus, entry)
    assert.deepEqual(verdict, entry.expected, `边界用例 ${entry.id} 结论不符`)
    assert.equal(
      verdict.chainOk,
      true,
      `边界用例 ${entry.id} 按设计 §7.5 应当检不出，实际：${renderVerdict(verdict)}`,
    )
    console.log(`[边界-TS] ${entry.id} 检不出（符合 §7.5）：${entry.note}`)
  }
})

test('干净的基准链在两侧见证下全绿（E1 / E3）', () => {
  const corpus = loadCorpus(repoRoot)
  for (const base of corpus.bases) {
    const head = base.chain.head.chain_head
    const options = resolveOptions(
      { expected_chain_head: head, anchor_head: head },
      base.chain,
      head,
    )
    const verdict = verifyChain(base.chain, options)
    assert.equal(verdict.chainOk, true, `基准链 ${base.id} 必须全绿：${renderVerdict(verdict)}`)
    assert.equal(verdict.verifiedRecords, base.chain.records.length)
    const summary = {
      records: base.chain.records.length,
      results: base.chain.records.filter((record) => record.kind === 'result').length,
      signatures: base.chain.stats.totalSignatures,
      bound: base.chain.stats.bound,
    }
    console.log(
      `[E1/E3-TS] ${base.id} 记录 ${summary.records} 结果记录 ${summary.results} 签名 ${summary.signatures} 上界 ${summary.bound}`,
    )
  }
})

test('干净链的链头必须能被"报告 + 锚定"两份见证同时确认', () => {
  const corpus = loadCorpus(repoRoot)
  const base = baseById(corpus, 'base_batch')
  // 报告里的链头被单独改动：必须报 chain_head_mismatch（这就是本地锚定要挡的形态）。
  const tampered = structuredClone(base)
  tampered.head.chain_head = '5a'.repeat(32)
  const verdict = verifyChain(tampered, {
    expectedChainHead: base.head.chain_head,
    anchorDeclared: true,
    anchorHead: base.head.chain_head,
    expectedPublicKey: base.public_key,
    verifyProofs: true,
  })
  assert.equal(verdict.chainOk, false)
  console.log(`[§7.6-TS] 报告链头被单独改动：${renderVerdict(verdict)}`)
  assert.deepEqual(verdict.errors, ['chain_head_mismatch'])
})
