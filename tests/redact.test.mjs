/**
 * `--redact` 与敏感数据扫描的回归测试。
 *
 * 两个要点（本项目的数据隐私纪律）：
 *   ① 报告里**不能出现**被脱敏的原文；
 *   ② findings 本身**也不能出现原文**——否则报告又变成泄露源。
 */

import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { redactSummary, redactText, redactValue, scanFindings } from '../lib/report/redact.js'
import { writeRunArtifacts } from '../lib/report/json.js'

/**
 * 本文件建的临时目录统一登记，跑完一次性删除。
 *
 * 教训：漏清理会在 `%TEMP%` 里堆出成百上千个 `dsh-testkit-redact-*`
 * （实测 92 个），是 `dsh-testkit doctor` 的残留探测先发现的。
 */
const TEMP_DIRS = []
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

// 说明：本文件本身在 scripts/check-secrets.mjs 的 SKIP_FILES 里——
// 它**必须**包含构造出来的假凭据，否则测不出脱敏。假值一律用明显可辨识的形态。
const FAKE_GITHUB = `ghp_${'A'.repeat(36)}`
const FAKE_PRIVATE_KEY = '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakefakefake\n-----END RSA PRIVATE KEY-----'
const FAKE_ASSIGNED = 'api_key = "abcdef1234567890"'

function makeSummary(notes) {
  return {
    runId: '2026-10-10T00-00-00_test',
    startedAt: '2026-10-10T00:00:00.000Z',
    finishedAt: '2026-10-10T00:00:01.000Z',
    casesDir: 'C:/repo/cases',
    dshVersion: '0.2.0-rc.2',
    platform: 'win32',
    totals: { total: 1, passed: 0, failed: 1, skipped: 0, errored: 0 },
    cases: [
      {
        id: 'TK-0001',
        title: '带敏感数据的用例',
        kind: 'tool',
        verdict: 'failed',
        durationMs: 12,
        error: `调用失败：${FAKE_ASSIGNED}`,
        steps: [
          {
            name: 'step 1',
            assertions: [
              {
                assertion: { ref: 'fx.token', is: 'x' },
                ok: false,
                actual: FAKE_GITHUB,
                message: `实际是 ${FAKE_GITHUB}`,
                soft: false,
              },
            ],
            durationMs: 3,
          },
        ],
        notes,
        releaseFailures: [{ label: 'tmp', error: `清理失败：${FAKE_PRIVATE_KEY}` }],
        sourceIssue: null,
      },
    ],
  }
}

test('redactText：各类模式都被替换，且记录命中类型', () => {
  const cases = [
    [FAKE_GITHUB, 'github-token'],
    [FAKE_PRIVATE_KEY, 'private-key'],
    [FAKE_ASSIGNED, 'assigned-secret'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'bearer-token'],
    ['联系 alice@corp-internal.cn 处理', 'email'],
    ['路径 C:\\Users\\alice\\work\\x.ts', 'home-path'],
  ]
  for (const [text, kind] of cases) {
    const result = redactText(text)
    assert.ok(
      result.findings.some((f) => f.kind === kind),
      `${kind} 应被识别，实际：${JSON.stringify(result.findings)}`,
    )
    assert.ok(result.text !== text, `${kind} 应被改写`)
  }
})

test('redactText：占位域与 SSH remote 不算敏感（否则文档天天红）', () => {
  for (const text of [
    'security@example.com',
    'git+ssh://git@github.com/supengpeng/dsh-testkit.git',
    'http://127.0.0.1:19387',
    'C:\\Users\\<user>\\work',
  ]) {
    const result = redactText(text)
    assert.equal(result.text, text, `不应改写：${text}`)
    assert.deepEqual(result.findings, [])
  }
})

test('home-path：只抹用户名，保留项目路径（否则报告没法读）', () => {
  const result = redactText('C:\\Users\\alice\\Documents\\proj\\a.ts')
  assert.equal(result.text, 'C:\\Users\\<user>\\Documents\\proj\\a.ts')
})

test('findings 绝不含原文（否则报告本身成为泄露源）', () => {
  const result = redactValue({ a: FAKE_GITHUB, b: [FAKE_ASSIGNED], c: { d: FAKE_PRIVATE_KEY } }, 'fx')
  const dump = JSON.stringify(result.findings)
  for (const secret of [FAKE_GITHUB, 'abcdef1234567890', 'MIIEfakefakefake']) {
    assert.ok(!dump.includes(secret), `findings 里出现了原文片段：${secret}`)
  }
  assert.ok(result.findings.length >= 3)
})

test('redactSummary：改写取证，不改结构字段，并记录 redaction', () => {
  const summary = makeSummary({ stdout: `token: ${FAKE_GITHUB}`, safe: 'ok' })
  const { summary: redacted, findings } = redactSummary(summary)

  assert.ok(findings.length > 0)
  assert.equal(redacted.cases[0].id, 'TK-0001')
  assert.equal(redacted.cases[0].verdict, 'failed')
  assert.equal(redacted.totals.failed, 1)
  assert.equal(redacted.redaction.count, findings.length)

  const dump = JSON.stringify(redacted)
  assert.ok(!dump.includes(FAKE_GITHUB), 'run.json 里不应再有 token 原文')
  assert.ok(!dump.includes('MIIEfakefakefake'), 'releaseFailures 里不应再有私钥原文')
  assert.ok(!dump.includes('abcdef1234567890'), 'error 里不应再有 api_key 原文')
  assert.ok(dump.includes('safe'), '非敏感取证必须原样保留')
  assert.ok(dump.includes('[已脱敏:github-token]'))
})

test('writeRunArtifacts：--redact 时三份产物同一份已脱敏 summary，报告里写明脱敏', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-redact-'))
  TEMP_DIRS.push(dir)
  const summary = makeSummary({ stdout: FAKE_GITHUB })

  const result = await writeRunArtifacts(summary, dir, { redact: true })
  assert.ok(result.artifacts, `写入应成功：${result.error ?? ''}`)
  assert.ok(result.redaction && result.redaction.count > 0)

  for (const file of ['run.json', 'report.md', 'junit.xml']) {
    const text = readFileSync(join(result.artifacts.dir, file), 'utf8')
    assert.ok(!text.includes(FAKE_GITHUB), `${file} 不应含 token 原文`)
  }
  const md = readFileSync(result.artifacts.markdownPath, 'utf8')
  assert.match(md, /已脱敏/)
})

test('writeRunArtifacts：不开 --redact 时原样保留（默认不悄悄改写取证）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-redact-off-'))
  TEMP_DIRS.push(dir)
  const summary = makeSummary({ stdout: FAKE_GITHUB })
  const result = await writeRunArtifacts(summary, dir)
  assert.ok(result.artifacts)
  assert.equal(result.redaction, undefined)
  const json = readFileSync(result.artifacts.jsonPath, 'utf8')
  assert.ok(json.includes(FAKE_GITHUB), '默认必须原样保留')
})

test('scanFindings：给闸门用的只读扫描（带位置）', () => {
  const findings = scanFindings(`x = "${FAKE_GITHUB}"`, 'cases/TK-9999.yaml')
  assert.equal(findings.length, 1)
  assert.equal(findings[0].path, 'cases/TK-9999.yaml')
  assert.equal(findings[0].kind, 'github-token')
})
