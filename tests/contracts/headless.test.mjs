/**
 * headless 替身契约的 node:test 入口。
 *
 * 契约本体与出处见 `headless.contract.mjs`。
 */

import contract from './headless.contract.mjs'
import { defineContractSuiteTest, defineContractTests } from './helpers.mjs'

defineContractTests(contract)
defineContractSuiteTest(contract)
