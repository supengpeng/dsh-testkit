#!/usr/bin/env node
/**
 * 独立验证器 CLI（设计 §7.4）——**只读**。
 *
 * 用法：
 *   node src/attest/verify-cli.mjs <chain.json> [选项]
 *
 * 选项：
 *   --run <run.json>          取报告里的 `chain_head` 作为外部见证
 *   --anchor <anchor.json>    取锚定文件里的 `chain_head` 作为第二份外部见证
 *   --pubkey <hex>            预期公钥（从可信渠道拿到时给）
 *   --expected-head <hex>     直接给外部链头（与 --run 等价，便于脚本）
 *   --no-proofs               跳过 inclusion proof 校验（只影响成本，不改变承诺）
 *
 * 行为约定：
 *   · **不写任何文件**、不修改被测对象、不发网络请求；
 *   · 结论以 JSON 打印到 stdout，并**带上边界声明**（避免结论被单独引用时丢掉边界）；
 *   · 退出码：0 = 链通过；1 = 链未通过（有篡改）；2 = 用法/读取错误。
 *
 * 这条边界必须随结论一起被读到：
 *   哈希链是 tamper-evident（可发现篡改），不是 tamper-proof（防篡改）。
 */

import { readFileSync } from 'node:fs'

import { boundaryStatement, renderVerdict, verifyChain } from './verify.mjs'

/**
 * 从 run.json / anchor 文件里取链头。
 * @param {unknown} document 解析后的文档
 * @returns {string|null} 链头 hex 或 null
 */
function pickChainHead(document) {
  const value = document?.chain_head
  if (typeof value !== 'string' || value.length === 0) return null
  // 报告层可能写成 `sha256:...`；剥掉前缀后仍是裸字节的 hex。
  return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value
}

/**
 * 解析命令行。
 * @param {string[]} argv 参数
 * @returns {{chainPath: string, runPath: string|null, anchorPath: string|null, publicKey: string|null, expectedHead: string|null, verifyProofs: boolean}} 选项
 */
function parseArgs(argv) {
  const options = {
    chainPath: null,
    runPath: null,
    anchorPath: null,
    publicKey: null,
    expectedHead: null,
    verifyProofs: true,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    switch (item) {
      case '--run':
        options.runPath = argv[++index]
        break
      case '--anchor':
        options.anchorPath = argv[++index]
        break
      case '--pubkey':
        options.publicKey = argv[++index]
        break
      case '--expected-head':
        options.expectedHead = argv[++index]
        break
      case '--no-proofs':
        options.verifyProofs = false
        break
      default:
        if (item.startsWith('--')) throw new Error(`未知选项：${item}`)
        if (options.chainPath) throw new Error('只接受一个链文件参数')
        options.chainPath = item
    }
  }
  if (!options.chainPath) throw new Error('缺少链文件参数')
  return options
}

/**
 * 主流程。
 * @returns {number} 退出码
 */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`[verify] 用法错误：${error.message}`)
    console.error(
      '用法：node src/attest/verify-cli.mjs <chain.json> [--run run.json] [--anchor anchor.json] [--pubkey hex] [--expected-head hex] [--no-proofs]',
    )
    return 2
  }

  let chain
  let expectedHead = options.expectedHead
  let anchorHead = null
  try {
    chain = JSON.parse(readFileSync(options.chainPath, 'utf8'))
    if (options.runPath) {
      expectedHead = pickChainHead(JSON.parse(readFileSync(options.runPath, 'utf8'))) ?? expectedHead
    }
    if (options.anchorPath) {
      anchorHead = pickChainHead(JSON.parse(readFileSync(options.anchorPath, 'utf8')))
    }
  } catch (error) {
    console.error(`[verify] 读取失败：${error.message}`)
    return 2
  }

  let verdict
  try {
    verdict = verifyChain(chain, {
      expectedChainHead: expectedHead,
      anchorDeclared: Boolean(options.anchorPath),
      anchorHead,
      expectedPublicKey: options.publicKey,
      verifyProofs: options.verifyProofs,
    })
  } catch (error) {
    // 输入结构本身有问题（不是"链被篡改"）：如实报"验证器无法判定"，不伪装成通过。
    console.error(`[verify] 无法判定（输入结构不合法）：${error.message}`)
    return 2
  }

  const report = {
    chain_file: options.chainPath,
    run_id: chain.run_id ?? null,
    signature_mode: chain.signature_mode ?? null,
    witnesses: {
      report_chain_head: expectedHead,
      anchor_chain_head: anchorHead,
      public_key: options.publicKey,
    },
    verdict,
    boundary: boundaryStatement(),
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  console.error(`[verify] ${renderVerdict(verdict)}`)
  return verdict.chainOk ? 0 : 1
}

process.exit(main())
