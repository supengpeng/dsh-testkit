/**
 * 提炼闸门的回归网。
 *
 * 守的是三条**纪律**（不是功能）——它们错了会静默放行，比崩溃更难查：
 *   ① 没有 open 批次时，模型不能提交提案（要不要提炼由人定）
 *   ② 提案永远不落进 `cases/`，只有人 approve 才落地（模型不能自己收口）
 *   ③ 本批结案前不允许开启下一批（本次完成后用户同意才能进行下次）
 *
 * 外加质量红线：预检不过的提案**不落盘**；approve 前任一条不合格就整体不落地。
 *
 * 全部用临时目录跑，不碰仓库里的 `cases/` 与 `pipeline/`。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { PipelineStore } from '../lib/pipeline/store.js'

const ISSUE = 'https://github.com/example/repo/issues/7'

/** 一份**合格**的提案正文（占位 id + 可溯源 + 可断言）。 */
function proposalYaml(overrides = {}) {
  const o = {
    title: '示例提案：退出码必须是 0',
    kind: 'shell',
    issue: ISSUE,
    assertion: '      - { ref: fx.exitCode, is: 0 }',
    ...overrides,
  }
  return [
    'schema: 1',
    'id: TK-0000',
    `title: ${o.title}`,
    `kind: ${o.kind}`,
    'status: draft',
    'source:',
    `  issue: ${o.issue}`,
    '  summary: 现象 / 最小复现 / 判据都在这里',
    'steps:',
    '  - name: 跑一条命令',
    '    act:',
    '      shell:',
    '        argv: ["echo", "hi"]',
    '    expect:',
    o.assertion,
    '',
  ].join('\n')
}

function makeStore() {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  const pipelineDir = join(root, 'pipeline')
  const casesDir = join(root, 'cases')
  mkdirSync(casesDir, { recursive: true })
  const store = new PipelineStore({ pipelineDir, casesDir })
  return { root, pipelineDir, casesDir, store }
}

test('闸门①：没有 open 批次时提案被拒，且什么都不落盘', () => {
  const { root, store, pipelineDir, casesDir } = makeStore()
  try {
    const result = store.propose({ yamlText: proposalYaml() })
    assert.equal(result.ok, false)
    assert.match(result.error, /未开启/)
    assert.equal(existsSync(join(pipelineDir, 'proposals')), false)
    assert.deepEqual(readdirSync(casesDir), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('闸门②：open 后提案只落在 proposals/，cases/ 一个字节都不动', () => {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })

    assert.equal(store.open('dsh-memory 发包面一条').ok, true)
    const result = store.propose({ yamlText: proposalYaml(), notes: '来自 #48' })
    assert.equal(result.ok, true)
    assert.equal(result.proposalId, 'P-0001')
    assert.equal(result.batchId, 'BATCH-0001')
    assert.ok(existsSync(join(pipelineDir, result.relPath)))
    assert.deepEqual(readdirSync(casesDir), [])

    // 台账里能查到这条待裁决提案
    const status = store.statusText()
    assert.match(status, /P-0001/)
    assert.match(status, /待裁决/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('质量红线：预检不过的提案一律拒绝落盘', () => {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })
    store.open('质量红线')

    const badCases = [
      ['TODO 残留', proposalYaml().replace('argv: ["echo", "hi"]', 'argv: ["echo", "hi"] # TODO(人工)')],
      ['缺 source.issue', proposalYaml().replace(`  issue: ${ISSUE}`, '  issue: ""')],
      ['没有断言', proposalYaml().replace('      - { ref: fx.exitCode, is: 0 }', '')],
      ['id 不是占位值', proposalYaml().replace('id: TK-0000', 'id: TK-0009')],
      ['title 超长', proposalYaml({ title: 'x'.repeat(80) })],
    ]

    for (const [name, text] of badCases) {
      const result = store.propose({ yamlText: text })
      assert.equal(result.ok, false, `${name} 应被拒绝`)
      assert.ok((result.findings ?? []).some((f) => f.level === 'block'), `${name} 应给出阻断理由`)
    }

    // 一条都没落盘：提案目录根本没被创建
    assert.equal(existsSync(join(pipelineDir, 'proposals', 'BATCH-0001')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('批准落地：分配 TK 号、写 cases/、重建索引、结案', () => {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })

    store.open('落地一条')
    const proposed = store.propose({ yamlText: proposalYaml() })
    assert.equal(proposed.ok, true)

    const result = store.approve('all')
    assert.equal(result.ok, true)
    assert.deepEqual(result.promoted.map((p) => p.caseId), ['TK-0001'])
    assert.equal(result.batchStatus, 'approved')

    const target = join(casesDir, 'TK-0001.yaml')
    assert.ok(existsSync(target))
    const text = readFileSync(target, 'utf8')
    assert.match(text, /^id: TK-0001$/m)
    assert.doesNotMatch(text, /TK-0000/)

    const index = readFileSync(join(casesDir, 'index.yaml'), 'utf8')
    assert.match(index, /nextId: 2/)
    assert.match(index, /id: TK-0001/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('闸门③：本批未结案时不允许开启下一批', () => {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })

    assert.equal(store.open('第一批').ok, true)
    const second = store.open('第二批')
    assert.equal(second.ok, false)
    assert.match(second.error, /已有未结案/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('结案后（reject / close）才允许开启下一批', () => {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })

    store.open('第一批')
    assert.equal(store.propose({ yamlText: proposalYaml() }).ok, true)

    const rejected = store.reject('all', '判据不成立')
    assert.equal(rejected.ok, true)
    assert.equal(rejected.batchStatus, 'rejected')

    const next = store.open('第二批')
    assert.equal(next.ok, true)
    assert.equal(next.batch.id, 'BATCH-0002')

    const closed = store.close('本轮不提炼了')
    assert.equal(closed.ok, true)
    assert.equal(closed.batch.status, 'closed')
    assert.equal(store.open('第三批').ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('approve 前二次预检：任一条不合格则整体不落地', () => {
  const root = mkdtempSync(join(tmpdir(), 'testkit-gate-'))
  try {
    const pipelineDir = join(root, 'pipeline')
    const casesDir = join(root, 'cases')
    mkdirSync(casesDir, { recursive: true })
    const store = new PipelineStore({ pipelineDir, casesDir })

    store.open('两条')
    const first = store.propose({ yamlText: proposalYaml() })
    const second = store.propose({ yamlText: proposalYaml({ title: '第二条提案' }) })
    assert.equal(first.ok && second.ok, true)

    // 模拟提案文件在盘上被改坏（少了源头 / 多了 TODO）
    writeFileSync(
      join(pipelineDir, second.relPath),
      proposalYaml({ title: '第二条提案' }).replace(`  issue: ${ISSUE}`, '  issue: ""'),
      'utf8',
    )

    const result = store.approve('all')
    assert.equal(result.ok, false)
    assert.ok(result.problems.length >= 1)
    // 一条都没落地，也没写出索引
    assert.deepEqual(readdirSync(casesDir), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
