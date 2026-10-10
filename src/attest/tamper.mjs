/**
 * 篡改**注入器**与语料装载（TS 侧）。
 *
 * ⚠️ 这个文件是**测试夹具**，不是验证器的一部分：验证器（`verify.mjs` / `jcs.mjs` /
 * `hex.mjs` / `ed25519.mjs`）不导入它，也不依赖它。它存在的理由是设计 §7.2 的一项要求——
 * 两侧都要**各自**实现"注入 → 检出"这条链路，然后对同一份语料给出相同结论；
 * 如果 TS 侧只是调用 Rust 侧的注入结果，那就不是独立验证了。
 *
 * 注入操作与 `crates/attest/tests/support/mod.rs` 的 `Op` 枚举**逐字对应**（同名字段、
 * 同一语义、同一执行顺序）。语料 `spec/vectors/attest/corpus.json` 里存的就是这些操作。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalizeBytes } from './jcs.mjs'
import { deriveLabelKey, signEd25519 } from './ed25519.mjs'
import { fromHexFixed, toHex } from './hex.mjs'
import {
  batchPreimage,
  headPreimage,
  leafHash,
  merkleRoot,
  recordHashPreimageFields,
  sha256,
  u64be,
  verifyChain,
} from './verify.mjs'

/** 测试密钥标签（与 Rust 侧 `TEST_KEY_LABEL` 相同）。 */
export const TEST_KEY_LABEL = 'dsh-testkit/attest/test-vector-key/v1'

/** 语料路径（相对仓库根）。 */
export const CORPUS_RELATIVE_PATH = 'spec/vectors/attest/corpus.json'

const ZERO_HASH = Buffer.alloc(32)

/**
 * 读入语料。
 * @param {string} repoRoot 仓库根
 * @returns {object} 语料
 */
export function loadCorpus(repoRoot) {
  const text = readFileSync(join(repoRoot, CORPUS_RELATIVE_PATH), 'utf8')
  return JSON.parse(text)
}

/**
 * 取基准链。
 * @param {object} corpus 语料
 * @param {string} id 基准链 id
 * @returns {object} 链
 */
export function baseById(corpus, id) {
  const entry = corpus.bases.find((base) => base.id === id)
  if (!entry) throw new Error(`语料里没有基准链 ${id}`)
  return entry.chain
}

/**
 * 按 id 取用例（含边界用例）。
 * @param {object} corpus 语料
 * @param {string} id 用例 id
 * @returns {object} 用例
 */
export function caseById(corpus, id) {
  const entry = [...corpus.cases, ...corpus.boundary_cases].find((item) => item.id === id)
  if (!entry) throw new Error(`语料里没有用例 ${id}`)
  return entry
}

/**
 * 把用例的外部见证解析成验证器输入（与 Rust 侧 `resolve_options` 同一约定）。
 *
 * - 缺省（`null`）= **原始运行**的链头；
 * - `"self"` = 用被改后链自己的链头（模拟"报告与锚定一起被改写"）。
 * @param {object} context 用例的 context
 * @param {object} mutated 被改后的链
 * @param {string} originalHead 原始链头（hex）
 * @returns {object} `verifyChain` 的 options
 */
export function resolveOptions(context = {}, mutated, originalHead) {
  const resolve = (value) => {
    if (value === null || value === undefined) return originalHead
    if (value === 'self') return mutated.head.chain_head
    return value
  }
  return {
    expectedChainHead: resolve(context.expected_chain_head),
    anchorDeclared: context.anchor_declared ?? true,
    anchorHead: resolve(context.anchor_head),
    expectedPublicKey:
      context.expected_public_key === undefined || context.expected_public_key === null
        ? mutated.public_key
        : context.expected_public_key === 'self'
          ? mutated.public_key
          : context.expected_public_key,
    verifyProofs: context.verify_proofs ?? true,
  }
}

/**
 * 找出某 seq 的记录（就地引用）。
 * @param {object} chain 链
 * @param {number} seq 序号
 * @returns {object} 记录
 */
function recordMut(chain, seq) {
  const record = chain.records.find((item) => Number(item.seq) === Number(seq))
  if (!record) throw new Error(`找不到 seq=${seq} 的记录`)
  return record
}

/**
 * 翻转字节数组（hex 字段）里的一个字节。
 * @param {string} hex 十六进制文本
 * @param {number} offset 偏移
 * @returns {string} 翻转后的十六进制
 */
function flipHex(hex, offset) {
  const bytes = Buffer.from(hex, 'hex')
  if (offset < 0 || offset >= bytes.length) {
    throw new Error(`字节偏移越界：${offset}（长度 ${bytes.length}）`)
  }
  bytes[offset] ^= 0x01
  return toHex(bytes)
}

/**
 * 改载荷里的字段（新增或覆盖）。
 * @param {object} target 载荷对象
 * @param {string[]} path 字段路径
 * @param {unknown} value 新值
 */
function setPath(target, path, value) {
  if (path.length === 0) throw new Error('路径不能为空')
  let cursor = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (typeof cursor[key] !== 'object' || cursor[key] === null || Array.isArray(cursor[key])) {
      cursor[key] = {}
    }
    cursor = cursor[key]
  }
  cursor[path[path.length - 1]] = value
}

/**
 * 按当前记录重算 `payload_hash` / `prev_hash` / `record_hash`（不动签名）。
 * @param {object} chain 链
 */
function recomputeChainHashes(chain) {
  let previous = ZERO_HASH
  for (const record of chain.records) {
    record.prev_hash = toHex(previous)
    record.payload_hash = toHex(sha256(Buffer.from(record.payload_jcs, 'hex')))
    record.record_hash = toHex(
      sha256(
        recordHashPreimageFields(
          Number(record.seq),
          fromHexFixed(record.prev_hash, 32),
          record.kind,
          fromHexFixed(record.payload_hash, 32),
          Number(record.ts),
        ),
      ),
    )
    previous = fromHexFixed(record.record_hash, 32)
  }
}

/**
 * 按当前记录重算链头摘要。
 * @param {object} chain 链
 */
function recomputeHead(chain) {
  const last = chain.records[chain.records.length - 1]
  chain.head = {
    seq: chain.records.length,
    record_count: chain.records.length,
    result_records: chain.records.filter((record) => record.kind === 'result').length,
    chain_head: last ? last.record_hash : toHex(ZERO_HASH),
  }
}

/**
 * 按当前记录重建批次（可选重新签名）。
 * @param {object} chain 链
 * @param {boolean} resign 是否重新签名
 * @param {object} key 测试密钥
 */
function recomputeBatches(chain, resign, key) {
  const batchSize = Number(chain.batch_size)
  if (!Number.isInteger(batchSize) || batchSize <= 0) throw new Error('批大小非法')
  const resultSeqs = chain.records
    .filter((record) => record.kind === 'result')
    .map((record) => Number(record.seq))
  const recordHashBySeq = []
  for (const record of chain.records) recordHashBySeq[Number(record.seq)] = record.record_hash
  const oldBatches = chain.batches ?? []
  const batches = []
  for (let start = 0, index = 0; start < resultSeqs.length; start += batchSize, index += 1) {
    const leavesSeqs = resultSeqs.slice(start, start + batchSize)
    const leaves = leavesSeqs.map((seq) => leafHash(fromHexFixed(recordHashBySeq[seq], 32)))
    const root = merkleRoot(leaves)
    const firstSeq = leavesSeqs[0]
    const lastSeq = leavesSeqs[leavesSeqs.length - 1]
    const sig = resign
      ? toHex(signEd25519(key.privateKey, batchPreimage(root, firstSeq, lastSeq)))
      : (oldBatches[index]?.sig ?? '')
    batches.push({
      index,
      first_seq: firstSeq,
      last_seq: lastSeq,
      leaves: leavesSeqs,
      root: toHex(root),
      sig,
      public_key: toHex(key.publicKey),
      proofs: leavesSeqs.map((seq, position) => ({
        seq,
        path: proofPath(leaves, position),
      })),
    })
  }
  chain.batches = batches
}

/**
 * 求第 `index` 片叶子的 inclusion proof。
 * @param {Buffer[]} leaves 叶子哈希
 * @param {number} index 位置
 * @returns {Array<{sibling: string, side: string}>} 证据步骤
 */
export function proofPath(leaves, index) {
  const path = []
  let level = leaves
  let cursor = index
  while (level.length > 1) {
    if (cursor % 2 === 1) {
      path.push({ sibling: toHex(level[cursor - 1]), side: 'left' })
    } else if (cursor + 1 < level.length) {
      path.push({ sibling: toHex(level[cursor + 1]), side: 'right' })
    }
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length) {
        // 与 Rust 侧同一套域分隔：0x01 前缀的内部节点。
        next.push(nodeHashLocal(level[i], level[i + 1]))
      } else {
        next.push(level[i])
      }
    }
    level = next
    cursor = Math.floor(cursor / 2)
  }
  return path
}

/**
 * 内部节点哈希（本地小工具，避免为了求证据再导出一遍）。
 * @param {Buffer} left 左子
 * @param {Buffer} right 右子
 * @returns {Buffer} 节点哈希
 */
function nodeHashLocal(left, right) {
  return sha256(Buffer.concat([Buffer.from([0x01]), left, right]))
}

/**
 * 应用一条注入操作。
 * @param {object} chain 链
 * @param {object} op 操作
 * @param {object} key 测试密钥
 */
function applyOp(chain, op, key) {
  switch (op.op) {
    case 'set_payload_field': {
      const record = recordMut(chain, op.seq)
      const payload = JSON.parse(Buffer.from(record.payload_jcs, 'hex').toString('utf8'))
      setPath(payload, op.path, op.value)
      record.payload_jcs = toHex(canonicalizeBytes(payload))
      return
    }
    case 'delete_record': {
      if (op.index < 0 || op.index >= chain.records.length) throw new Error('删记录下标越界')
      chain.records.splice(op.index, 1)
      return
    }
    case 'swap_records': {
      if (op.index + 1 >= chain.records.length) throw new Error('重排下标越界')
      const temporary = chain.records[op.index]
      chain.records[op.index] = chain.records[op.index + 1]
      chain.records[op.index + 1] = temporary
      return
    }
    case 'duplicate_record': {
      const copy = chain.records[op.index]
      if (!copy) throw new Error('复制下标越界')
      chain.records.splice(op.index + 1, 0, structuredClone(copy))
      return
    }
    case 'flip_payload_hash':
      recordMut(chain, op.seq).payload_hash = flipHex(recordMut(chain, op.seq).payload_hash, op.offset)
      return
    case 'flip_record_hash':
      recordMut(chain, op.seq).record_hash = flipHex(recordMut(chain, op.seq).record_hash, op.offset)
      return
    case 'bump_ts': {
      const record = recordMut(chain, op.seq)
      record.ts = Number(record.ts) + 1
      return
    }
    case 'flip_sig': {
      const record = recordMut(chain, op.seq)
      record.sig = flipHex(record.sig, op.offset)
      return
    }
    case 'flip_batch_sig': {
      const batch = chain.batches[op.batch]
      if (!batch) throw new Error(`批次越界：${op.batch}`)
      batch.sig = flipHex(batch.sig, op.offset)
      return
    }
    case 'flip_head_sig': {
      if (!chain.head_signature) throw new Error('链头签名不存在')
      chain.head_signature.sig = flipHex(chain.head_signature.sig, op.offset)
      return
    }
    case 'flip_proof': {
      const batch = chain.batches[op.batch]
      if (!batch) throw new Error(`批次越界：${op.batch}`)
      const proof = batch.proofs.find((item) => Number(item.seq) === Number(op.seq))
      if (!proof) throw new Error(`找不到 seq=${op.seq} 的证明`)
      const step = proof.path[op.step]
      if (!step) throw new Error(`证明步越界：${op.step}`)
      step.sibling = flipHex(step.sibling, op.offset)
      return
    }
    case 'drop_proof': {
      const batch = chain.batches[op.batch]
      if (!batch) throw new Error(`批次越界：${op.batch}`)
      const before = batch.proofs.length
      batch.proofs = batch.proofs.filter((item) => Number(item.seq) !== Number(op.seq))
      if (batch.proofs.length === before) throw new Error(`找不到 seq=${op.seq} 的证明`)
      return
    }
    case 'remove_leaf': {
      const batch = chain.batches[op.batch]
      if (!batch) throw new Error(`批次越界：${op.batch}`)
      batch.leaves = batch.leaves.filter((value) => Number(value) !== Number(op.seq))
      return
    }
    case 'stale_head_chain_head':
      chain.head.chain_head = 'ab'.repeat(32)
      return
    case 'noncanonical_payload': {
      const record = recordMut(chain, op.seq)
      const payload = JSON.parse(Buffer.from(record.payload_jcs, 'hex').toString('utf8'))
      // 语义完全相同的另一种字节形态：两空格缩进 + 换行。
      record.payload_jcs = toHex(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'))
      return
    }
    case 'recompute_chain_hashes':
      recomputeChainHashes(chain)
      return
    case 'recompute_head':
      recomputeHead(chain)
      return
    case 'recompute_batches':
      recomputeBatches(chain, Boolean(op.resign), key)
      return
    case 'recompute_head_signature': {
      const head = fromHexFixed(chain.head.chain_head, 32)
      chain.head_signature = {
        sig: toHex(signEd25519(key.privateKey, headPreimage(head, chain.records.length))),
        public_key: toHex(key.publicKey),
      }
      return
    }
    case 'append_record': {
      const last = chain.records[chain.records.length - 1]
      const prev = last ? last.record_hash : toHex(ZERO_HASH)
      const seq = last ? Number(last.seq) + 1 : 1
      const payloadJcs = canonicalizeBytes(op.payload)
      const payloadHash = sha256(payloadJcs)
      const recordHash = sha256(
        recordHashPreimageFields(
          seq,
          fromHexFixed(prev, 32),
          op.kind,
          payloadHash,
          Number(op.ts),
        ),
      )
      chain.records.push({
        seq,
        prev_hash: prev,
        kind: op.kind,
        payload_jcs: toHex(payloadJcs),
        payload_hash: toHex(payloadHash),
        record_hash: toHex(recordHash),
        ts: Number(op.ts),
        sig: '',
      })
      return
    }
    default:
      throw new Error(`未知注入操作：${op.op}`)
  }
}

/**
 * 对一条链应用一串注入操作（返回**深拷贝**，不改原链）。
 * @param {object} chain 基准链
 * @param {object[]} ops 操作
 * @param {object} key 测试密钥
 * @returns {object} 被改后的链
 */
export function applyOps(chain, ops, key) {
  const mutated = structuredClone(chain)
  for (const op of ops) applyOp(mutated, op, key)
  return mutated
}

/**
 * 跑一条用例：注入 + 验证，返回 `{chain, verdict}`。
 * @param {object} corpus 语料
 * @param {object} entry 用例
 * @returns {{chain: object, verdict: object}} 结果
 */
export function evaluateCase(corpus, entry) {
  const base = baseById(corpus, entry.base)
  const key = deriveLabelKey(TEST_KEY_LABEL)
  const chain = applyOps(base, entry.ops, key)
  const options = resolveOptions(entry.context, chain, base.head.chain_head)
  return { chain, verdict: verifyChain(chain, options) }
}

/**
 * 逐例跑完语料，返回 `id → 结论`（含边界用例）。
 * @param {object} corpus 语料
 * @returns {Object<string, object>} 结论映射
 */
export function evaluateAll(corpus) {
  const verdicts = {}
  for (const entry of [...corpus.cases, ...corpus.boundary_cases]) {
    verdicts[entry.id] = evaluateCase(corpus, entry).verdict
  }
  return verdicts
}

/**
 * 基准链的"全绿"口径：链自洽 + 三份见证一致。
 * @param {object} corpus 语料
 * @returns {Object<string, object>} 结论映射
 */
export function evaluateBases(corpus) {
  const verdicts = {}
  for (const base of corpus.bases) {
    const head = base.chain.head.chain_head
    verdicts[base.id] = verifyChain(base.chain, {
      expectedChainHead: head,
      anchorDeclared: true,
      anchorHead: head,
      expectedPublicKey: base.chain.public_key,
      verifyProofs: true,
    })
  }
  return verdicts
}

/**
 * 记录哈希原像（转发，便于测试直接算）。
 * @param {object} record 记录
 * @returns {Buffer} 原像
 */
export function recordPreimageOf(record) {
  return recordHashPreimageFields(
    Number(record.seq),
    fromHexFixed(record.prev_hash, 32),
    record.kind,
    fromHexFixed(record.payload_hash, 32),
    Number(record.ts),
  )
}

/** 8 字节大端（转发，便于测试构造原像）。 */
export { u64be }
