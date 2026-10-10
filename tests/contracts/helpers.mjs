/**
 * 契约 → node:test 的薄桥。
 *
 * 为什么一条契约用例对应一个 `node:test` 用例（而不是"整个契约一个 test"）：
 * node 的测试报告按用例名展开，红了能直接看到**哪一条**契约被破坏；
 * 整体包成一个 test 的话，日志里只剩一句汇总，定位又回到人工。
 *
 * 运行器本身仍只用一次（`runContract`），所以"运行器点名"这条链路
 * 同时被 `runner.test.mjs` 直接断言。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatContractResults, runContract } from '../../lib/contracts/run.js'

/** 逐条注册：`<adapter> › <用例名>`。 */
export function defineContractTests(contract) {
  for (const contractCase of contract.tests) {
    test(`${contract.adapter} › ${contractCase.name}`, async () => {
      const result = await runContract({ ...contract, tests: [contractCase] })
      assert.equal(result.failed, 0, result.failures.join('\n') || '契约用例失败')
      assert.equal(result.passed, 1)
      assert.equal(result.total, 1)
    })
  }
}

/** 整体再跑一遍，钉住计数汇总（契约文件数量 × 1 条）。 */
export function defineContractSuiteTest(contract) {
  test(`${contract.adapter}：契约整体跑完零失败（${contract.tests.length} 条用例）`, async () => {
    const result = await runContract(contract)
    assert.equal(result.failed, 0, formatContractResults([result]))
    assert.equal(result.total, contract.tests.length)
    assert.equal(result.passed, contract.tests.length)
    assert.ok(contract.tests.length >= 1, '空契约等于没测')
  })
}
