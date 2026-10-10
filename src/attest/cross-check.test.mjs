/**
 * 跨语言结论一致性（设计 §7.4 的验收项）：`cargo` / `node` 两侧对同一份链的结论必须一致。
 *
 * Rust 侧把逐例结论写在 `target/attest/rust-verdicts.json`（由
 * `cargo test -p dsh-testkit-attest --test consistency` 生成）；这里用 TS 侧**独立**的
 * 注入器与验证器重算一遍，逐例、逐字段比对。
 *
 * 文件不存在时**显式 skip**（可见地跳过，不是静默通过）。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { evaluateAll, evaluateBases, loadCorpus } from './tamper.mjs'
import { renderVerdict } from './verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const rustVerdictsPath = join(repoRoot, 'target', 'attest', 'rust-verdicts.json')

test('两侧结论逐例一致（含边界用例）', (t) => {
  if (!existsSync(rustVerdictsPath)) {
    t.skip(
      `缺少 ${rustVerdictsPath}：先跑 cargo test -p dsh-testkit-attest --test consistency`,
    )
    return
  }
  const rust = JSON.parse(readFileSync(rustVerdictsPath, 'utf8'))
  assert.equal(rust.side, 'rust')
  const corpus = loadCorpus(repoRoot)
  const tsCases = evaluateAll(corpus)
  const tsBases = evaluateBases(corpus)

  const rustCaseIds = Object.keys(rust.cases).sort()
  const tsCaseIds = Object.keys(tsCases).sort()
  assert.deepEqual(tsCaseIds, rustCaseIds, '两侧覆盖的用例集合必须相同')

  let compared = 0
  for (const id of rustCaseIds) {
    assert.deepEqual(
      tsCases[id],
      rust.cases[id],
      `用例 ${id} 两侧结论不一致\n  Rust：${renderVerdict(rust.cases[id])}\n  TS  ：${renderVerdict(tsCases[id])}`,
    )
    compared += 1
  }
  for (const id of Object.keys(rust.bases)) {
    assert.deepEqual(tsBases[id], rust.bases[id], `基准链 ${id} 两侧结论不一致`)
  }
  console.log(
    `[一致性] ${compared} 条用例 + ${Object.keys(rust.bases).length} 条基准链：Rust 与 TS 结论逐字段一致`,
  )
})

test('TS 侧结论可复现（同输入两次相同）', () => {
  const corpus = loadCorpus(repoRoot)
  const first = evaluateAll(corpus)
  const second = evaluateAll(corpus)
  assert.deepEqual(first, second)
  console.log(`[一致性] TS 侧 ${Object.keys(first).length} 条用例结论可复现`)
})
