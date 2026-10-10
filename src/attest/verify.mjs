/**
 * 独立验证器（设计 §7.4）——TS 侧，**零依赖**，只用 `node:crypto`。
 *
 * 输入：`run.json`（提供外部链头）+ 记录链文件 + 公钥（+ 可选的锚定目录链头）。
 * 输出：`{chainOk, firstBadSeq, verifiedRecords, errors}`。
 * **只读**：本模块不写任何文件、不触碰被测对象、不发网络请求。
 *
 * # 为什么"独立"这两个字是重点
 *
 * 这份实现**不调用 Rust 侧的任何东西**，也不复用它的中间结果；两侧各自实现 JCS、哈希链、
 * Merkle、验签与判定顺序，然后对同一份语料给出**逐字段相同**的结论
 * （`src/attest/cross-check.test.mjs` 逐例 diff）。设计 §7.2 说得很清楚：
 * 只靠一侧实现，另一侧的"独立验证"就不是独立的。
 *
 * # 判定顺序（与 Rust 侧 `crates/attest/src/verify.rs` **逐字对应**）
 *
 * 0. 序号完整性：有重复 → `seq_conflict`；缺号 → `seq_gap`；集合恰好是 `{1..n}` 但顺序不对
 *    （重排）→ `seq_conflict`。这一步不通过时 `verifiedRecords = 0`。
 * 1. 逐条记录（fail-fast）：`prev_hash` → `payload_hash` → **`payload_jcs` 是否已经是 JCS 字节**
 *    → `record_hash` → 逐条签名。
 * 2. 批量（仅 `batch` 模式）：批次划分 → 根 → 公钥 → 根签名 → inclusion proof。
 * 3. 链头摘要。
 * 4. 链头签名。
 * 5. 外部期望（`run.json` 链头 / 预期公钥 / 锚定目录链头）。
 *
 * # ⚠️ 边界（不许表述为"防篡改"）
 *
 * 它能证明的是："**相对一个来自链之外已知的链头**，这份链没有被单独改动过"。
 * 持有私钥的人可以重写整条链、重新签名，并把报告与锚定一起改掉——那时所有签名自洽，
 * 本验证器**检不出**（设计 §7.5）。哈希链是 **tamper-evident（可发现篡改）**，
 * 不是 **tamper-proof（防篡改）**。
 */

import { createHash } from 'node:crypto'

import { verifyEd25519 } from './ed25519.mjs'
import { fromHexFixed, toHex } from './hex.mjs'
import { canonicalizeText } from './jcs.mjs'

/** 链文件格式标识。 */
export const CHAIN_FORMAT = 'dsh-testkit/attest/chain/v1'

/** 记录种类 → 单字节编码（与 Rust 侧 `RecordKind::code` 必须一致）。 */
export const KIND_CODES = Object.freeze({
  result: 1,
  gate: 2,
  capability_change: 3,
  release: 4,
  progress: 5,
})

/** 批量签名原像的域标签。 */
export const BATCH_DOMAIN = Buffer.from('dsh-testkit/attest/v1:batch:', 'utf8')
/** 链头签名原像的域标签。 */
export const HEAD_DOMAIN = Buffer.from('dsh-testkit/attest/v1:head:', 'utf8')

/** 全部错误码（**跨语言契约**：字符串值两侧必须一致）。 */
export const ERROR_CODES = Object.freeze([
  'seq_gap',
  'seq_conflict',
  'prev_hash_mismatch',
  'payload_hash_mismatch',
  'payload_not_canonical',
  'record_hash_mismatch',
  'signature_invalid',
  'merkle_proof_invalid',
  'merkle_proof_missing',
  'batch_root_mismatch',
  'batch_leaf_set_mismatch',
  'batch_signature_invalid',
  'chain_head_mismatch',
  'head_signature_invalid',
  'public_key_mismatch',
  'anchor_missing',
  'anchor_mismatch',
  'verifier_misconfigured',
])

/** Ed25519 签名长度。 */
const SIGNATURE_LENGTH = 64
/** SHA-256 摘要长度。 */
const HASH_LENGTH = 32

/**
 * 多段字节拼接后求 SHA-256。
 * @param {Buffer[]} parts 字节段
 * @returns {Buffer} 32 字节摘要
 */
export function sha256Parts(parts) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/**
 * 单段字节的 SHA-256。
 * @param {Buffer} data 字节
 * @returns {Buffer} 32 字节摘要
 */
export function sha256(data) {
  return sha256Parts([data])
}

/**
 * 8 字节大端无符号整数。
 * @param {number|bigint} value 数值
 * @returns {Buffer} 8 字节
 */
export function u64be(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(value))
  return buffer
}

/**
 * 8 字节大端**有符号**整数（`ts` 是 i64）。
 * @param {number|bigint} value 数值
 * @returns {Buffer} 8 字节
 */
export function i64be(value) {
  const buffer = Buffer.alloc(8)
  buffer.writeBigInt64BE(BigInt(value))
  return buffer
}

/**
 * 记录哈希原像：`seq ‖ prev_hash ‖ kind ‖ payload_hash ‖ ts`（设计 §7.3）。
 * @param {number} seq 序号
 * @param {Buffer} prevHash 上一条哈希
 * @param {string} kind 记录种类
 * @param {Buffer} payloadHash 载荷哈希
 * @param {number} ts 逻辑刻度
 * @returns {Buffer} 81 字节原像
 */
export function recordHashPreimageFields(seq, prevHash, kind, payloadHash, ts) {
  return Buffer.concat([
    u64be(seq),
    prevHash,
    Buffer.from([KIND_CODES[kind]]),
    payloadHash,
    i64be(ts),
  ])
}

/**
 * 记录哈希原像（从线格式记录取字段）。
 * @param {object} record 线格式记录
 * @returns {Buffer} 原像
 */
export function recordHashPreimage(record) {
  return recordHashPreimageFields(
    record.seq,
    fromHexFixed(record.prev_hash, HASH_LENGTH),
    record.kind,
    fromHexFixed(record.payload_hash, HASH_LENGTH),
    record.ts,
  )
}

/**
 * 逐条签名原像：`seq ‖ prev_hash ‖ kind ‖ payload_hash`（设计 §7.1，**不含 `ts`**）。
 * @param {number} seq 序号
 * @param {Buffer} prevHash 上一条哈希
 * @param {string} kind 记录种类
 * @param {Buffer} payloadHash 载荷哈希
 * @returns {Buffer} 73 字节原像
 */
export function signingPreimageFields(seq, prevHash, kind, payloadHash) {
  return Buffer.concat([u64be(seq), prevHash, Buffer.from([KIND_CODES[kind]]), payloadHash])
}

/**
 * 逐条签名原像（从线格式记录取字段）。
 * @param {object} record 线格式记录
 * @returns {Buffer} 原像
 */
export function signingPreimage(record) {
  return signingPreimageFields(
    record.seq,
    fromHexFixed(record.prev_hash, HASH_LENGTH),
    record.kind,
    fromHexFixed(record.payload_hash, HASH_LENGTH),
  )
}

/**
 * 批量签名原像：`域标签 ‖ root ‖ first_seq ‖ last_seq`。
 * @param {Buffer} root Merkle 根
 * @param {number} firstSeq 首 seq
 * @param {number} lastSeq 末 seq
 * @returns {Buffer} 原像
 */
export function batchPreimage(root, firstSeq, lastSeq) {
  return Buffer.concat([BATCH_DOMAIN, root, u64be(firstSeq), u64be(lastSeq)])
}

/**
 * 链头签名原像：`域标签 ‖ chain_head ‖ record_count`。
 * @param {Buffer} chainHead 链头哈希
 * @param {number} recordCount 记录总数
 * @returns {Buffer} 原像
 */
export function headPreimage(chainHead, recordCount) {
  return Buffer.concat([HEAD_DOMAIN, chainHead, u64be(recordCount)])
}

/**
 * 叶子哈希：`SHA-256(0x00 ‖ record_hash)`（域分隔，RFC 6962 做法）。
 * @param {Buffer} recordHash 记录哈希
 * @returns {Buffer} 叶子哈希
 */
export function leafHash(recordHash) {
  return sha256Parts([Buffer.from([0x00]), recordHash])
}

/**
 * 内部节点哈希：`SHA-256(0x01 ‖ left ‖ right)`。
 * @param {Buffer} left 左子
 * @param {Buffer} right 右子
 * @returns {Buffer} 节点哈希
 */
export function nodeHash(left, right) {
  return sha256Parts([Buffer.from([0x01]), left, right])
}

/**
 * 计算 Merkle 根（奇数个节点时**末位直接晋升**，不复制自己）。
 * @param {Buffer[]} leaves 叶子哈希
 * @returns {Buffer|null} 根；空输入为 null
 */
export function merkleRoot(leaves) {
  if (leaves.length === 0) return null
  let level = leaves
  while (level.length > 1) {
    const next = []
    for (let index = 0; index < level.length; index += 2) {
      if (index + 1 < level.length) next.push(nodeHash(level[index], level[index + 1]))
      else next.push(level[index])
    }
    level = next
  }
  return level[0]
}

/**
 * 用 inclusion proof 从叶子重算根。
 * @param {Buffer} leaf 叶子哈希
 * @param {Array<{sibling: string, side: string}>} path 证据步骤（线格式）
 * @returns {Buffer} 重算出的根
 */
export function recomputeRootFromProof(leaf, path) {
  let current = leaf
  for (const step of path) {
    const sibling = fromHexFixed(step.sibling, HASH_LENGTH)
    current = step.side === 'left' ? nodeHash(sibling, current) : nodeHash(current, sibling)
  }
  return current
}

/**
 * 阶段 0：序号完整性。
 *
 * 三步顺序有意义：**有重复 → 冲突；有缺号 → 缺口；集合恰好完整但顺序不对（重排）→ 冲突**。
 * 这样"删记录"与"重排/插入"才会落进不同的错误码。
 * @param {object[]} records 线格式记录
 * @returns {{code: string, seq: number}|null} 第一个问题，或 null
 */
export function checkSequence(records) {
  const total = records.length
  const counts = new Array(total + 2).fill(0)
  for (const record of records) {
    const seq = Number(record.seq)
    if (seq >= 1 && seq <= total + 1) counts[seq] += 1
  }
  for (let seq = 1; seq <= total + 1; seq += 1) {
    if (counts[seq] >= 2) return { code: 'seq_conflict', seq }
  }
  for (let seq = 1; seq <= total; seq += 1) {
    if (counts[seq] === 0) return { code: 'seq_gap', seq }
  }
  for (let index = 0; index < total; index += 1) {
    if (Number(records[index].seq) !== index + 1) {
      return { code: 'seq_conflict', seq: Number(records[index].seq) }
    }
  }
  return null
}

/**
 * 把 hex 字符串或 Buffer 统一成 Buffer。
 * @param {string|Buffer|null|undefined} value 输入
 * @param {number} length 期望字节数
 * @returns {Buffer|null} 字节或 null
 */
function asBytes(value, length) {
  if (value === null || value === undefined) return null
  if (Buffer.isBuffer(value)) {
    if (value.length !== length) throw new Error(`期望 ${length} 字节，实际 ${value.length}`)
    return value
  }
  return fromHexFixed(String(value), length)
}

/**
 * 构造失败结论（错误码去重 + 字典序，与 Rust 侧一致）。
 * @param {number|null} firstBadSeq 首个问题位置
 * @param {number} verifiedRecords 已通过逐条校验的记录数
 * @param {string[]} errors 错误码
 * @returns {object} 结论
 */
function failed(firstBadSeq, verifiedRecords, errors) {
  const unique = [...new Set(errors)].sort()
  return { chainOk: false, firstBadSeq, verifiedRecords, errors: unique }
}

/**
 * 判定一段 `payload_jcs`（hex）是否**已经**是该载荷的 JCS 规范化字节。
 *
 * 设计 §7.2 的原话是"签名的前提是同样的语义 ⇒ 同样的字节"——既然是**前提**，验证器就该
 * 检验它。做法：把字节解析回 JSON 值再规范化一次，逐字节比对。解析不了同样算不合格。
 * @param {string} payloadHex 载荷字节的 hex
 * @returns {boolean} 是否已经是规范化字节
 */
export function payloadIsCanonical(payloadHex) {
  try {
    const text = Buffer.from(payloadHex, 'hex').toString('utf8')
    const canonical = Buffer.from(canonicalizeText(text), 'utf8')
    return canonical.equals(Buffer.from(payloadHex, 'hex'))
  } catch {
    return false
  }
}

/**
 * 验证一条链。
 * @param {object} chain 线格式链
 * @param {object} [options] 外部见证
 * @param {string|Buffer|null} [options.expectedChainHead] `run.json` 的链头
 * @param {boolean} [options.anchorDeclared] 是否声明了本地锚定
 * @param {string|Buffer|null} [options.anchorHead] 锚定目录里的链头
 * @param {string|Buffer|null} [options.expectedPublicKey] 预期公钥
 * @param {boolean} [options.verifyProofs] 是否校验 inclusion proof（缺省 true）
 * @returns {{chainOk: boolean, firstBadSeq: number|null, verifiedRecords: number, errors: string[]}} 结论
 */
export function verifyChain(chain, options = {}) {
  const records = Array.isArray(chain?.records) ? chain.records : []
  const verifyProofs = options.verifyProofs ?? true

  // 阶段 0：序号完整性（前提不成立就什么都没验）。
  const sequenceProblem = checkSequence(records)
  if (sequenceProblem) {
    return failed(sequenceProblem.seq, 0, [sequenceProblem.code])
  }

  const publicKey = fromHexFixed(chain.public_key, HASH_LENGTH)

  // 阶段 1：逐条记录。
  let previous = Buffer.alloc(HASH_LENGTH)
  let verified = 0
  for (const record of records) {
    const prevHash = fromHexFixed(record.prev_hash, HASH_LENGTH)
    if (!prevHash.equals(previous)) {
      return failed(record.seq, verified, ['prev_hash_mismatch'])
    }
    const payloadHash = sha256(Buffer.from(record.payload_jcs, 'hex'))
    if (!payloadHash.equals(fromHexFixed(record.payload_hash, HASH_LENGTH))) {
      return failed(record.seq, verified, ['payload_hash_mismatch'])
    }
    if (!payloadIsCanonical(record.payload_jcs)) {
      return failed(record.seq, verified, ['payload_not_canonical'])
    }
    const recordHash = sha256(recordHashPreimage(record))
    if (!recordHash.equals(fromHexFixed(record.record_hash, HASH_LENGTH))) {
      return failed(record.seq, verified, ['record_hash_mismatch'])
    }
    const signature = Buffer.from(record.sig ?? '', 'hex')
    if (signature.length > 0) {
      if (!verifyEd25519(publicKey, signingPreimage(record), signature)) {
        return failed(record.seq, verified, ['signature_invalid'])
      }
    } else if (chain.signature_mode === 'per_record' && record.kind === 'result') {
      // `per_record` 模式下结果记录必须带签名；缺失不是"跳过"，是失败。
      return failed(record.seq, verified, ['signature_invalid'])
    }
    previous = recordHash
    verified += 1
  }

  // 阶段 2：批量（仅 batch 模式）。
  if (chain.signature_mode === 'batch') {
    const problem = checkBatches(chain, records, publicKey, verifyProofs)
    if (problem) return failed(null, verified, [problem])
  }

  // 阶段 3：链头摘要。
  const recomputedHead = records.length > 0
    ? fromHexFixed(records[records.length - 1].record_hash, HASH_LENGTH)
    : Buffer.alloc(HASH_LENGTH)
  const recordCount = records.length
  const lastSeq = records.length > 0 ? Number(records[records.length - 1].seq) : 0
  const resultCount = records.filter((record) => record.kind === 'result').length
  const declared = chain.head ?? {}
  if (
    !recomputedHead.equals(fromHexFixed(declared.chain_head, HASH_LENGTH)) ||
    Number(declared.record_count) !== recordCount ||
    Number(declared.seq) !== lastSeq ||
    Number(declared.result_records) !== resultCount
  ) {
    return failed(null, verified, ['chain_head_mismatch'])
  }

  // 阶段 4：链头签名。
  if (!chain.head_signature) {
    return failed(null, verified, ['head_signature_invalid'])
  }
  const headPublicKey = fromHexFixed(chain.head_signature.public_key, HASH_LENGTH)
  if (!headPublicKey.equals(publicKey)) {
    return failed(null, verified, ['public_key_mismatch'])
  }
  if (
    !verifyEd25519(
      headPublicKey,
      headPreimage(recomputedHead, recordCount),
      Buffer.from(chain.head_signature.sig ?? '', 'hex'),
    )
  ) {
    return failed(null, verified, ['head_signature_invalid'])
  }

  // 阶段 5：外部见证。
  let expectedPublicKey = null
  let expectedChainHead = null
  let anchorHead = null
  try {
    expectedPublicKey = asBytes(options.expectedPublicKey, HASH_LENGTH)
    expectedChainHead = asBytes(options.expectedChainHead, HASH_LENGTH)
    anchorHead = asBytes(options.anchorHead, HASH_LENGTH)
  } catch {
    return failed(null, verified, ['verifier_misconfigured'])
  }
  if (expectedPublicKey && !expectedPublicKey.equals(publicKey)) {
    return failed(null, verified, ['public_key_mismatch'])
  }
  if (expectedChainHead && !expectedChainHead.equals(recomputedHead)) {
    return failed(null, verified, ['chain_head_mismatch'])
  }
  if (options.anchorDeclared === true && !anchorHead) {
    return failed(null, verified, ['anchor_missing'])
  }
  if (anchorHead && !anchorHead.equals(recomputedHead)) {
    return failed(null, verified, ['anchor_mismatch'])
  }

  return { chainOk: true, firstBadSeq: null, verifiedRecords: verified, errors: [] }
}

/**
 * 阶段 2：批量检查；返回第一个错误码。
 * @param {object} chain 链
 * @param {object[]} records 记录
 * @param {Buffer} publicKey 链公钥
 * @param {boolean} verifyProofs 是否校验证据
 * @returns {string|null} 错误码或 null
 */
function checkBatches(chain, records, publicKey, verifyProofs) {
  const batchSize = Number(chain.batch_size)
  if (!Number.isInteger(batchSize) || batchSize <= 0) return 'verifier_misconfigured'
  const resultSeqs = records
    .filter((record) => record.kind === 'result')
    .map((record) => Number(record.seq))
  const chunks = []
  for (let index = 0; index < resultSeqs.length; index += batchSize) {
    chunks.push(resultSeqs.slice(index, index + batchSize))
  }
  const batches = Array.isArray(chain.batches) ? chain.batches : []
  if (chunks.length !== batches.length) return 'batch_leaf_set_mismatch'

  // 判定路径不用哈希表（与 Rust 侧"禁用 HashMap/HashSet"同一纪律）：
  // 阶段 0 已保证 seq 恰好是 1..n，所以直接用下标数组。
  const recordBySeq = []
  for (const record of records) recordBySeq[Number(record.seq)] = record

  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index]
    const chunk = chunks[index]
    const declaredLeaves = (batch.leaves ?? []).map((value) => Number(value))
    if (
      Number(batch.index) !== index ||
      declaredLeaves.length !== chunk.length ||
      declaredLeaves.some((value, position) => value !== chunk[position])
    ) {
      return 'batch_leaf_set_mismatch'
    }
    if (Number(batch.first_seq) !== chunk[0] || Number(batch.last_seq) !== chunk[chunk.length - 1]) {
      return 'batch_leaf_set_mismatch'
    }
    // 用**链上重算**的叶子重建根（不信任 batch.root）。
    const leaves = chunk.map((seq) => {
      const record = recordBySeq[seq]
      if (!record) return null
      return leafHash(fromHexFixed(record.record_hash, HASH_LENGTH))
    })
    if (leaves.some((leaf) => leaf === null)) return 'batch_leaf_set_mismatch'
    const root = merkleRoot(leaves)
    const declaredRoot = fromHexFixed(batch.root, HASH_LENGTH)
    if (!root || !root.equals(declaredRoot)) return 'batch_root_mismatch'
    const batchPublicKey = fromHexFixed(batch.public_key, HASH_LENGTH)
    if (!batchPublicKey.equals(publicKey)) return 'public_key_mismatch'
    if (
      !verifyEd25519(
        batchPublicKey,
        batchPreimage(declaredRoot, Number(batch.first_seq), Number(batch.last_seq)),
        Buffer.from(batch.sig ?? '', 'hex'),
      )
    ) {
      return 'batch_signature_invalid'
    }
    if (verifyProofs) {
      const proofs = Array.isArray(batch.proofs) ? batch.proofs : []
      for (let position = 0; position < chunk.length; position += 1) {
        const seq = chunk[position]
        const proof = proofs.find((item) => Number(item.seq) === seq)
        if (!proof) return 'merkle_proof_missing'
        if (!recomputeRootFromProof(leaves[position], proof.path ?? []).equals(declaredRoot)) {
          return 'merkle_proof_invalid'
        }
      }
    }
  }
  return null
}

/**
 * 结论的单行呈现（报告与测试日志用）。
 * @param {object} verdict 结论
 * @returns {string} 单行文本
 */
export function renderVerdict(verdict) {
  return (
    `chainOk=${verdict.chainOk} firstBadSeq=${verdict.firstBadSeq ?? 'null'} ` +
    `verifiedRecords=${verdict.verifiedRecords} errors=[${verdict.errors.join(',')}]`
  )
}

/**
 * 从链取"验证器该看的东西"的摘要（工具与测试用）。
 * @param {object} chain 链
 * @returns {object} 摘要
 */
export function chainSummary(chain) {
  return {
    runId: chain.run_id,
    recordCount: chain.records.length,
    resultRecords: chain.records.filter((record) => record.kind === 'result').length,
    chainHead: toHex(fromHexFixed(chain.head.chain_head, HASH_LENGTH)),
    publicKey: chain.public_key,
    signatureMode: chain.signature_mode,
    signatures: chain.stats?.totalSignatures ?? null,
    bound: chain.stats?.bound ?? null,
  }
}

/**
 * 一行边界声明（与 Rust 侧 `boundary_statement` 同一句话）。
 * @returns {string} 边界声明
 */
export function boundaryStatement() {
  return (
    '哈希链是 tamper-evident（可发现篡改），不是 tamper-proof（防篡改）：' +
    '持有私钥者可重写整条链并重新签名，链本身无法阻止'
  )
}

/** 内部常量（供测试与工具引用）。 */
export const INTERNAL = Object.freeze({ SIGNATURE_LENGTH, HASH_LENGTH })
