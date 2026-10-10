/**
 * host-facade 契约的 node:test 入口（gate 里排在场景测试之前）。
 *
 * 契约本体在 `host-facade.contract.mjs`（可替换被测工厂，供反安慰剂用例复用）；
 * 这里只负责把它展开成 node 用例。真实契约出处写在契约文件的头注里。
 */

import contract from './host-facade.contract.mjs'
import { defineContractSuiteTest, defineContractTests } from './helpers.mjs'

defineContractTests(contract)
defineContractSuiteTest(contract)
