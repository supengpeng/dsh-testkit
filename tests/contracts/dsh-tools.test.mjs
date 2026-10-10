/**
 * DSH 工具适配层契约的 node:test 入口。
 *
 * 契约本体与出处见 `dsh-tools.contract.mjs`。
 */

import contract from './dsh-tools.contract.mjs'
import { defineContractSuiteTest, defineContractTests } from './helpers.mjs'

defineContractTests(contract)
defineContractSuiteTest(contract)
