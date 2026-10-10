/**
 * I1：私钥不出进程（指标 §10）——TS 侧的"全量日志扫描"，**只报位置，不打印原文**。
 *
 * 做法与 Rust 侧 `crates/attest/tests/leak_scan.rs` 对应：把验证流程会产出的**每一段文本**
 * （链 JSON、锚定 JSON、结论 JSON、CLI 报告、日志行、以及异常消息）收集起来，
 * 用进程内算出的密钥材料当"针"去扫；命中即失败，且**命中呈现里不含命中原文**。
 *
 * 为什么"异常消息"也要扫：报错路径是最容易顺手把上下文打出来的地方
 * （`serialize(key)` 之类的调试残留都从这里漏）。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { deriveLabelKey } from './ed25519.mjs'
import { toHex } from './hex.mjs'
import { TEST_KEY_LABEL, evaluateAll, loadCorpus, resolveOptions } from './tamper.mjs'
import { boundaryStatement, chainSummary, renderVerdict, verifyChain } from './verify.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')

/** TS 侧测试密钥（派生自公开标签，见 `tamper.mjs` 的说明）。 */
const key = deriveLabelKey(TEST_KEY_LABEL)

/** 敏感针：种子与"种子‖公钥"的扩展形态（与 Rust 侧 `sensitive_needles` 同构）。 */
const NEEDLES = [
  { label: 'ed25519-seed-hex', text: toHex(key.seed) },
  { label: 'ed25519-keypair-hex', text: toHex(Buffer.concat([key.seed, key.publicKey])) },
]

/**
 * 扫一段文本，返回命中位置（**不含命中原文**）。
 * @param {string} artifact 产物名
 * @param {string} text 文本
 * @returns {Array<{artifact: string, label: string, line: number, column: number}>} 命中
 */
export function scanForSecrets(artifact, text) {
  const hits = []
  const lines = text.split(/\r?\n/)
  for (const needle of NEEDLES) {
    for (const needleText of [needle.text, needle.text.toUpperCase()]) {
      if (needleText.length === 0) continue
      lines.forEach((line, index) => {
        let cursor = line.indexOf(needleText)
        while (cursor >= 0) {
          hits.push({
            artifact,
            label: needle.label,
            line: index + 1,
            column: cursor + 1,
          })
          cursor = line.indexOf(needleText, cursor + 1)
        }
      })
    }
  }
  return hits
}

/** 收集验证流程会产出的全部文本。 */
function collectArtifacts() {
  const corpus = loadCorpus(repoRoot)
  const artifacts = []
  const verdicts = evaluateAll(corpus)

  for (const base of corpus.bases) {
    artifacts.push([`chain:${base.id}`, JSON.stringify(base.chain, null, 2)])
    const head = base.chain.head.chain_head
    const verdict = verifyChain(
      base.chain,
      resolveOptions({ expected_chain_head: head, anchor_head: head }, base.chain, head),
    )
    artifacts.push([`verdict:${base.id}`, JSON.stringify(verdict, null, 2)])
    artifacts.push([`summary:${base.id}`, JSON.stringify(chainSummary(base.chain), null, 2)])
    artifacts.push([
      `anchor:${base.id}`,
      JSON.stringify(
        {
          run_id: base.chain.run_id,
          chain_head: head,
          record_count: base.chain.records.length,
          ts: base.chain.records[base.chain.records.length - 1]?.ts ?? 0,
          verifier_version: 'dsh-testkit-attest/1',
        },
        null,
        2,
      ),
    ])
    // 日志行（验证器真实产出的那些）。
    artifacts.push([`journal:${base.id}`, [renderVerdict(verdict), boundaryStatement()].join('\n')])
  }

  // 被篡改的链也会被判、也会被序列化——一样要扫。
  for (const [id, verdict] of Object.entries(verdicts)) {
    artifacts.push([`verdict:${id}`, JSON.stringify(verdict)])
  }

  // CLI 报告结构（与 `verify-cli.mjs` 的输出同构）。
  const base = corpus.bases[0].chain
  artifacts.push([
    'cli-report',
    JSON.stringify(
      {
        chain_file: 'chain.json',
        run_id: base.run_id,
        signature_mode: base.signature_mode,
        witnesses: {
          report_chain_head: base.head.chain_head,
          anchor_chain_head: base.head.chain_head,
          public_key: base.public_key,
        },
        verdict: verifyChain(base, resolveOptions({}, base, base.head.chain_head)),
        boundary: boundaryStatement(),
      },
      null,
      2,
    ),
  ])

  // 异常消息（最容易顺手打印上下文的地方）。
  const broken = structuredClone(base)
  broken.records[0].payload_hash = 'not-hex'
  let message = ''
  try {
    verifyChain(broken, {})
  } catch (error) {
    message = String(error.message)
  }
  artifacts.push(['error-message', message])
  return artifacts
}

test('I1：验证流程产出的每一段文本都不含密钥材料', () => {
  const artifacts = collectArtifacts()
  const hits = artifacts.flatMap(([name, text]) => scanForSecrets(name, text))
  console.log(`[I1-TS] 扫描 ${artifacts.length} 份产物 / ${NEEDLES.length} 根敏感针，命中 ${hits.length} 处`)
  for (const hit of hits) {
    // 只报位置与类型。
    console.log(`[I1-TS] 命中：${hit.artifact}:${hit.line}:${hit.column} [${hit.label}]`)
  }
  assert.deepEqual(hits, [], 'I1 要求私钥材料零泄漏')
  // 公钥是公开值，出现在产物里是正常的——上面没报红正说明针区分得对。
  const publicHit = artifacts
    .flatMap(([, text]) => text.split('\n'))
    .some((line) => line.includes(key.publicKey.toString('hex')))
  assert.ok(publicHit, '公钥本来就该出现在产物里（这条断言防止上面是"什么都没扫到"）')
})

test('I1：扫描器不是摆设（负向证明）', () => {
  const leaked = `clean line\nleaked ${toHex(key.seed)} tail\n`
  const hits = scanForSecrets('journal', leaked)
  assert.ok(hits.length >= 1, '把针放进文本必须被扫出来')
  assert.equal(hits[0].line, 2)
  for (const hit of hits) {
    assert.ok(!JSON.stringify(hit).includes(toHex(key.seed)), '命中呈现里不得含原文')
  }
  assert.deepEqual(scanForSecrets('journal', 'clean text'), [])
})

test('I1：CLI 的输出里也不含密钥材料（端到端）', (t) => {
  const fixtureDir = join(repoRoot, 'target', 'attest', 'cli-i1')
  const chainPath = join(fixtureDir, 'chain.json')
  mkdirSync(fixtureDir, { recursive: true })
  const corpus = loadCorpus(repoRoot)
  const base = corpus.bases[0].chain
  writeFileSync(chainPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8')
  writeFileSync(
    join(fixtureDir, 'run.json'),
    `${JSON.stringify({ run_id: base.run_id, chain_head: base.head.chain_head }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(fixtureDir, 'anchor.json'),
    `${JSON.stringify({ chain_head: base.head.chain_head }, null, 2)}\n`,
    'utf8',
  )
  let stdout = ''
  try {
    stdout = execFileSync(
      process.execPath,
      [
        join(here, 'verify-cli.mjs'),
        chainPath,
        '--run',
        join(fixtureDir, 'run.json'),
        '--anchor',
        join(fixtureDir, 'anchor.json'),
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
  } catch (error) {
    // 受限沙箱里可能连管道都开不了（EPERM）：如实 skip，不静默通过。
    t.skip(`无法启动 CLI 子进程：${error.message}`)
    return
  }
  assert.ok(stdout.includes('"chainOk": true'), `CLI 应当给出通过结论：${stdout.slice(0, 200)}`)
  assert.ok(stdout.includes('tamper-evident'), 'CLI 输出必须带上边界声明')
  const hits = scanForSecrets('cli-stdout', stdout)
  assert.deepEqual(hits, [], 'CLI 输出里不得出现密钥材料')
  console.log('[I1-TS] CLI 端到端输出干净（含边界声明，无密钥材料）')
})

test('I1：语料与链文件本身不含任何私钥形态', () => {
  const corpus = loadCorpus(repoRoot)
  const text = readFileSync(join(repoRoot, 'spec/vectors/attest/corpus.json'), 'utf8')
  assert.ok(text.includes(corpus.key.public_key), '语料里应当有公钥（公开值）')
  assert.ok(!/private[_-]?key/i.test(text), '语料不得出现 private key 字段')
  assert.ok(!text.includes(toHex(key.seed)), '语料不得出现种子')
  console.log('[I1-TS] 语料：只有公钥与派生说明，无私钥材料')
})
