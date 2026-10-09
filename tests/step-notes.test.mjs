/**
 * 步骤级取证增量。
 *
 * ## 为什么需要它
 *
 * case 层的 `notes` 只保留**最终值**。多步场景里同名 note（例如每步都写 `stdout`）
 * 会互相覆盖——早期步骤的现场就没了。这是真实 DSH 运行中暴露的：
 * 跑 TK-0025 时，模型指出"步骤 1 的 stdout 无法从报告中取得"。
 *
 * 修法是给每一步记**增量**（只记新出现或值变化的 key），
 * 既补上可追溯性，又不让 run.json 随步骤数线性膨胀。
 *
 * 这里直接跑 runner（不走 bridge）——因为 HTTP 响应有意只回精简 case，
 * 步骤级细节只存在于 run.json 与 `runScenarios` 的返回值里。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CaseRegistry } from '../lib/cases/registry.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { createDriverRegistry } from '../lib/kinds/index.js'
import { runScenarios } from '../lib/runtime/runner.js'

async function runOne(id) {
  const registry = new CaseRegistry('cases')
  registry.reload()
  const headless = await createHeadlessHost()
  try {
    const run = await runScenarios({
      registry,
      drivers: createDriverRegistry(),
      host: headless.host,
      filter: { ids: [id] },
      timeoutMs: 20_000,
    })
    return run.cases[0]
  } finally {
    await headless.dispose()
  }
}

test('每一步都有自己的取证增量（早期步骤不被后续覆盖）', async () => {
  const c = await runOne('TK-0020')
  assert.equal(c.verdict, 'passed')

  const steps = c.steps
  assert.equal(steps.length, 3, 'TK-0020 有三步')

  for (const [i, step] of steps.entries()) {
    assert.ok(
      step.notes && Object.keys(step.notes).length > 0,
      `步骤 ${i + 1} 应当有取证增量（否则早期现场不可追溯）`,
    )
  }

  // 第 1 步读 package.json —— 它的内容不该被后续步骤冲掉
  assert.equal(steps[0].notes.fileRelative, 'package.json')
  assert.match(String(steps[0].notes.fileText), /dsh-testkit/)
})

test('增量是"差异"而不是整份快照（否则 run.json 会随步骤膨胀）', async () => {
  const c = await runOne('TK-0020')
  const steps = c.steps

  // 第 2 步只做 glob，所以它的增量里**只应**有 glob* 键；
  // 若实现成整份快照，这里会混进第一步的 file* 键。
  const secondKeys = Object.keys(steps[1].notes)
  assert.ok(secondKeys.length > 0)
  assert.ok(
    secondKeys.every((k) => k.startsWith('glob')),
    `第 2 步的增量应只含本步产生的键，实际：${secondKeys.join(', ')}`,
  )

  // 反过来：第一步**单独**产生的键不该出现在第 2 步
  assert.ok(!secondKeys.includes('fileText'))
})

test('最终 notes 仍是最后一步的值（case 层语义不变）', async () => {
  const c = await runOne('TK-0020')
  // 第 3 步读一个不存在的文件，所以 case 层 fileExists 是 false
  assert.equal(c.notes.fileExists, false)
  assert.equal(c.steps[2].notes.fileExists, false)
})
