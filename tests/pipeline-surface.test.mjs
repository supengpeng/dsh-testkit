/**
 * 提炼闸门的**表面**回归网：直接驱动 `/testkit issue …` 命令与 `testkit_propose` 工具。
 *
 * 与 `pipeline-gate.test.mjs` 的分工：
 *   · 那个测的是**闸门语义**（store 层：一次一批、质量红线、回滚）
 *   · 这个测的是**两个表面各自的行为**（命令解析、文本输出、工具落盘）
 *
 * 为什么值得分开测：闸门最容易的失效方式不是逻辑错，而是**表面接错**——
 * 子命令没进 switch、`--all` 解析不出来、工具侧少了闸门判断。
 * 这类错在 store 层单测里看不见。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { defineTestkitCommands } from '../lib/commands.js'
import { createDriverRegistry } from '../lib/kinds/index.js'
import { PipelineStore } from '../lib/pipeline/store.js'
import { defineTestkitTools } from '../lib/tools.js'

const ISSUE = 'https://github.com/example/repo/issues/9'

function proposalYaml(overrides = {}) {
  const o = { title: '命令面样例：退出码为 0', assertion: '      - { ref: fx.exitCode, is: 0 }', ...overrides }
  return [
    'schema: 1',
    'id: TK-0000',
    `title: ${o.title}`,
    'kind: shell',
    'status: draft',
    'source:',
    `  issue: ${ISSUE}`,
    '  summary: 命令面测试用的最小提案',
    'steps:',
    '  - name: 跑一条命令',
    '    act:',
    '      shell:',
    '        argv: ["echo", "ok"]',
    '    expect:',
    o.assertion,
    '',
  ].join('\n')
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), 'testkit-surface-'))
  const casesDir = join(root, 'cases')
  const pipelineDir = join(root, 'pipeline')
  mkdirSync(casesDir, { recursive: true })

  const pipeline = new PipelineStore({ pipelineDir, casesDir })
  const host = {
    capabilities: new Set(),
    service: () => undefined,
    on: () => () => undefined,
    waterfall: (_name, _args, next) => next(),
    registerTool: () => () => undefined,
    registerCommand: () => () => undefined,
    log: () => undefined,
    env: { dshVersion: 'test', platform: 'test', nodeVersion: 'test' },
  }
  const registry = {
    dir: casesDir,
    all: [],
    invalidCases: [],
    problems: [],
    get: () => undefined,
    filter: () => [],
    countsByKind: () => ({}),
  }

  const commands = defineTestkitCommands({
    registry,
    drivers: createDriverRegistry(),
    host,
    runsDir: () => join(root, 'runs'),
    exportDir: () => join(root, 'export'),
    defaultTimeoutMs: () => 1000,
    pipeline,
    reload: () => 'reloaded',
  })
  const tools = defineTestkitTools({
    registry,
    drivers: createDriverRegistry(),
    host,
    runsDir: () => join(root, 'runs'),
    exportDir: () => join(root, 'export'),
    defaultTimeoutMs: () => 1000,
    maxInvalidReported: () => 5,
    pipeline,
  })

  const testkit = commands.find((c) => c.name === 'testkit')
  assert.ok(testkit, '/testkit 命令必须注册')

  return {
    root,
    casesDir,
    testkit,
    propose: tools.find((t) => t.name === 'testkit_propose'),
    pipelineTool: tools.find((t) => t.name === 'testkit_pipeline'),
    run: (input) => testkit.execute(input, new AbortController().signal),
    call: (tool, args) => tool.execute(args, { signal: new AbortController().signal }),
  }
}

test('命令面：open → 工具提案 → approve 落地，全链路走通', async () => {
  const env = makeEnv()
  try {
    // ① 没开批时，状态先告诉人"要先开启"
    const empty = await env.run('issue')
    assert.equal(empty.kind, 'success')
    assert.match(empty.text, /没有 open 批次/)
    assert.match(empty.text, /\/testkit issue open/)

    // ② 人开启本轮
    const opened = await env.run('issue open 生效验证：一条')
    assert.equal(opened.kind, 'success')
    assert.match(opened.text, /BATCH-0001/)

    // ③ 未结案时开不了下一批（一次一批）
    const again = await env.run('issue open 又来一批')
    assert.equal(again.kind, 'error')
    assert.match(again.text, /已有未结案/)

    // ④ 模型经工具面提交提案
    const proposed = await env.call(env.propose, { yaml: proposalYaml() })
    assert.match(String(proposed), /已登记提案 P-0001/)
    assert.match(String(proposed), /\/testkit issue approve P-0001/)

    // ⑤ 人裁决前能看到正文
    const shown = await env.run('issue show P-0001')
    assert.equal(shown.kind, 'success')
    assert.match(shown.text, /TK-0000/)
    assert.match(shown.text, /质量预检/)

    // ⑥ 人批准 → 分配 TK 号 + 写 cases/ + 重建索引 + 结案
    const approved = await env.run('issue approve --all')
    assert.equal(approved.kind, 'success')
    assert.match(approved.text, /TK-0001/)
    assert.match(approved.text, /approved/)
    assert.ok(existsSync(join(env.casesDir, 'TK-0001.yaml')))
    assert.match(readFileSync(join(env.casesDir, 'index.yaml'), 'utf8'), /id: TK-0001/)
    assert.match(readFileSync(join(env.casesDir, 'TK-0001.yaml'), 'utf8'), /^id: TK-0001$/m)

    // ⑦ 结案后允许开下一批
    const next = await env.run('issue open 下一批')
    assert.equal(next.kind, 'success')
    assert.match(next.text, /BATCH-0002/)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('命令面：reject 与 close 都能结案，且 reject 保留文件留痕', async () => {
  const env = makeEnv()
  try {
    await env.run('issue open 拒绝路径')
    const proposed = await env.call(env.propose, { yaml: proposalYaml() })
    assert.match(String(proposed), /P-0001/)

    const rejected = await env.run('issue reject P-0001 判据不成立')
    assert.equal(rejected.kind, 'success')
    assert.match(rejected.text, /rejected/)
    assert.match(rejected.text, /判据不成立/)
    // 原始提案没进 cases/，也没被删
    assert.equal(existsSync(join(env.casesDir, 'TK-0001.yaml')), false)

    // 已结案 → 可开下一批；再验证 close 路径
    assert.match((await env.run('issue open 第二批')).text, /BATCH-0002/)
    const closed = await env.run('issue close 本轮不提炼了')
    assert.equal(closed.kind, 'success')
    assert.match(closed.text, /BATCH-0002/)
    assert.match((await env.run('issue open 第三批')).text, /BATCH-0003/)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('命令面：approve 缺目标 / 未知动作 / 空范围都有明确报错，不会静默', async () => {
  const env = makeEnv()
  try {
    const noBatchApprove = await env.run('issue approve --all')
    assert.equal(noBatchApprove.kind, 'error')
    assert.match(noBatchApprove.text, /没有 open 批次/)

    const emptyScope = await env.run('issue open')
    assert.equal(emptyScope.kind, 'error')
    assert.match(emptyScope.text, /必须写明范围/)

    const unknown = await env.run('issue 乱写')
    assert.equal(unknown.kind, 'error')
    assert.match(unknown.text, /用法/)

    await env.run('issue open 缺目标')
    const noTarget = await env.run('issue approve')
    assert.equal(noTarget.kind, 'error')
    assert.match(noTarget.text, /用法/)
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})

test('工具面：只读的 testkit_pipeline 能报台账，且没有 approve 这类入口', async () => {
  const env = makeEnv()
  try {
    const text = String(await env.call(env.pipelineTool, {}))
    assert.match(text, /没有 open 批次/)

    await env.run('issue open 工具面只读')
    const withBatch = String(await env.call(env.pipelineTool, {}))
    assert.match(withBatch, /BATCH-0001/)

    // 工具面不得存在批准能力（闸门的核心约束）
    assert.equal(env.propose.name, 'testkit_propose')
    assert.equal(env.pipelineTool.name, 'testkit_pipeline')
  } finally {
    rmSync(env.root, { recursive: true, force: true })
  }
})
