/**
 * cordis 交互契约的 node:test 入口。
 *
 * 契约本体与出处见 `cordis.contract.mjs`。
 */

import contract from './cordis.contract.mjs'
import { defineContractSuiteTest, defineContractTests } from './helpers.mjs'

defineContractTests(contract)
defineContractSuiteTest(contract)
