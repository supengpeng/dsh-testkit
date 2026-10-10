//! Rust 侧独立验证器（设计 §7.4）。
//!
//! 与 `src/attest/verify.mjs`（TS 侧零依赖验证器）**必须对同一份链给出同一份结论**：
//! `{chainOk, firstBadSeq, verifiedRecords, errors}`。结论的形状与错误码的来源都在
//! [`crate::error::ErrorCode`] 与 [`Verdict`]。
//!
//! # 判定顺序（两侧必须逐字一致，否则"独立验证"无从比对）
//!
//! 0. **序号完整性**（链的前提）：先看 `seq` 多重集——有重复 → `seq_conflict`；缺号 →
//!    `seq_gap`；集合恰好是 `{1..n}` 但顺序不对（重排）→ `seq_conflict`。
//!    这一步不通过时 `verifiedRecords = 0`（序号是前提，前提不成立就什么都没验）。
//! 1. **逐条记录**（fail-fast，停在第一条出问题的记录上）：
//!    `prev_hash` 串接 → `payload_hash` → **`payload_jcs` 是否已经是 JCS 字节** →
//!    `record_hash` → 逐条签名。
//! 2. **批量**（仅 `batch` 模式）：批次划分 → 根 → 公钥 → 根签名 → inclusion proof。
//! 3. **链头摘要**：与记录链重算结果逐字段比。
//! 4. **链头签名**。
//! 5. **外部期望**：`run.json` 的链头、预期公钥、锚定目录的链头。
//!
//! 某一阶段全过才进入下一阶段；某阶段内部停在第一个错误上。因此 `errors` 至多只有
//! 一两个码，且**可复现**。
//!
//! # `firstBadSeq` 的取值规则（必须写清，否则两侧会各自解释）
//!
//! - 第 0 阶段：重复 → 重复的那个 `seq`；缺号 → **缺的那个号**；重排 → 第一条错位的记录
//!   所声明的 `seq`；
//! - 第 1 阶段：该条记录声明的 `seq`；
//! - 第 2–5 阶段（批量 / 链头 / 外部）：`null`——它们不是记录级异常，硬塞一个 `seq`
//!   只会让人误以为"那条记录坏了"。
//!
//! # (b) 按构造不可达的分支：为什么它们**没有**测试覆盖
//!
//! task-26（J1 覆盖率）的性质判定里，本文件有一批分支属于"(b) 防御性 / 按构造不可达"。
//! 它们**刻意不补测试**：为它们写"手工构造内部状态"的测试只会让套件变长、判别力为零
//! （一个**改错也不会红**的测试是负资产）。每一处写明它兜的是什么、以及为什么造不出来：
//!
//! | 位置 | 兜的是什么 | 为什么按构造不可达 |
//! |---|---|---|
//! | `check_batches` 的 `chunks.get(index)` 为 `None` | 批次数量比划分多 | 上一行的 `chunks.len() != chain.batches.len()` 刚比过 |
//! | `check_batches` 的 `chunk.first()/last()` 为 `None` | 空批次 | `chunks` 由 `result_seqs.chunks(batch_size)` 产出且 `batch_size > 0`，每块非空 |
//! | `check_batches` 的 `leaves.len() != chunk.len()` | 某个 `seq` 在链上找不到 | 阶段 0 已保证序号恰好是 `1..n`，而 `chunk` 来自链上的结果记录 |
//! | `leaf_from_position` 的 `unwrap_or_else(zero)` | 证明位置越界 | 位置来自 `chunk.enumerate()`，与 `leaves` 同长 |
//! | `record_at` 的 `None` | 链上缺某条记录 | 阶段 0 的序号完整性已经排除 |
//! | `payload_is_canonical` 里 `serde_json::from_slice` 失败的 `else` | 载荷不是合法 JSON | 真出现"坏字节"时 `payload_hash`（同一段字节算的）**先**对不上；要走到这里得手工把哈希也对齐，正常生产者不产出这种状态 |
//!
//! 除上表之外，本文件还剩下若干**单臂**未覆盖（`&&` / `||` 的短路续行、`Option::get` 的
//! `None` 臂等）。它们分两类：**"条件不成立"的正常路径**（由基线用例覆盖，另一半由
//! `tests/verifier_paths.rs` 的定向用例覆盖），以及上表里的 (b)。
//! **真实的篡改形态都已经有定向用例**：断链、头计数（三项）、头签名公钥、预期公钥、
//! 批次数量 / 序号 / 边界 / 公钥 / 根、批大小为 0 —— 见 `tests/verifier_paths.rs`。
//!
//! 另外两类**不补**的未覆盖代码：
//!
//! - `Display` / `Debug` 的实现——测它们等于测标准库；
//! - `serde` 反序列化失败的路径——那是 serde 的行为，不是本 crate 的判定。
//!
//! # 这个验证器能证明什么、不能证明什么
//!
//! 它能证明："**相对某个已知链头**（来自报告外部：`run.json` 或本地锚定目录），这份链
//! 没有被单独改动过"。它**不能**证明"篡改不可能发生"——持有私钥的人可以重写整条链并
//! 重新签名，那时所有签名都自洽。哈希链是 **tamper-evident（可发现篡改）**，
//! 不是 **tamper-proof（防篡改）**（设计 §7.5）。

use serde::{Deserialize, Serialize};

use crate::chain::{result_seqs, AttestedChain, SignatureMode};
use crate::error::{AttestError, ErrorCode};
use crate::merkle::{self, InclusionProof};
use crate::record::{Record, RecordKind};
use crate::signing::{head_preimage, KeyMaterial};
use crate::types::Bytes32;

/// 验证结论（**跨语言契约**：字段名、语义、错误码都与 TS 侧一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// 链是否通过全部检查。
    pub chain_ok: bool,
    /// 第一条出问题的记录 `seq`（非记录级异常为 `null`）。
    pub first_bad_seq: Option<u64>,
    /// 通过全部逐条检查的记录数。
    pub verified_records: usize,
    /// 错误码（去重 + 字典序，保证可复现）。
    pub errors: Vec<ErrorCode>,
}

impl Verdict {
    /// 全绿。
    pub fn chain_ok() -> Self {
        Verdict {
            chain_ok: true,
            first_bad_seq: None,
            verified_records: 0,
            errors: Vec::new(),
        }
    }

    /// 失败结论（错误码会去重排序）。
    pub fn failed(
        first_bad_seq: Option<u64>,
        verified_records: usize,
        mut errors: Vec<ErrorCode>,
    ) -> Self {
        errors.sort();
        errors.dedup();
        Verdict {
            chain_ok: false,
            first_bad_seq,
            verified_records,
            errors,
        }
    }

    /// 单行呈现（进报告 / 测试日志）。
    pub fn render(&self) -> String {
        let codes = self
            .errors
            .iter()
            .map(|code| format!("{code:?}"))
            .collect::<Vec<_>>()
            .join(",");
        let first = match self.first_bad_seq {
            Some(seq) => seq.to_string(),
            None => "null".to_string(),
        };
        format!(
            "chainOk={} firstBadSeq={} verifiedRecords={} errors=[{}]",
            self.chain_ok, first, self.verified_records, codes
        )
    }
}

/// 验证器的外部输入。
///
/// `expected_chain_head` / `anchor_head` 就是"链之外的第二个见证"——没有它们，
/// 验证器只能证明"链自洽"，证明不了"链没被整体换掉"。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyOptions {
    /// `run.json` 里声明的链头。
    pub expected_chain_head: Option<Bytes32>,
    /// 本次运行是否声明了本地锚定。
    pub anchor_declared: bool,
    /// 锚定目录里读到的链头。
    pub anchor_head: Option<Bytes32>,
    /// 预期公钥（调用方从可信渠道拿到时填）。
    pub expected_public_key: Option<Bytes32>,
    /// 是否校验 inclusion proof（默认 `true`；关掉只影响成本、不影响本模块的承诺）。
    pub verify_proofs: bool,
}

impl Default for VerifyOptions {
    fn default() -> Self {
        VerifyOptions {
            expected_chain_head: None,
            anchor_declared: false,
            anchor_head: None,
            expected_public_key: None,
            verify_proofs: true,
        }
    }
}

impl VerifyOptions {
    /// 只要链自洽（不比对任何外部见证）。**只用于单元测试**——它证明不了锚定那一层。
    pub fn self_consistent() -> Self {
        VerifyOptions::default()
    }
}

/// 验证一条链文件文本。
pub fn verify_json(chain_text: &str, options: &VerifyOptions) -> Result<Verdict, AttestError> {
    let chain = AttestedChain::from_json_text(chain_text)?;
    Ok(verify_chain(&chain, options))
}

/// 验证一条装配完成的链。
pub fn verify_chain(chain: &AttestedChain, options: &VerifyOptions) -> Verdict {
    // ── 阶段 0：序号完整性 ──────────────────────────────────────────
    if let Some((code, seq)) = check_sequence(&chain.records) {
        return Verdict::failed(Some(seq), 0, vec![code]);
    }

    // ── 阶段 1：逐条记录 ──────────────────────────────────────────────
    let mut prev_expected = Bytes32::zero();
    let mut verified = 0usize;
    for (index, record) in chain.records.iter().enumerate() {
        let expected_seq = index as u64 + 1;
        debug_assert_eq!(record.seq, expected_seq, "阶段 0 已保证序号连续");
        if record.prev_hash != prev_expected {
            return Verdict::failed(
                Some(record.seq),
                verified,
                vec![ErrorCode::PrevHashMismatch],
            );
        }
        let payload_hash = Record::compute_payload_hash(&record.payload_jcs);
        if payload_hash != record.payload_hash {
            return Verdict::failed(
                Some(record.seq),
                verified,
                vec![ErrorCode::PayloadHashMismatch],
            );
        }
        if !payload_is_canonical(&record.payload_jcs) {
            return Verdict::failed(
                Some(record.seq),
                verified,
                vec![ErrorCode::PayloadNotCanonical],
            );
        }
        if record.recompute_record_hash() != record.record_hash {
            return Verdict::failed(
                Some(record.seq),
                verified,
                vec![ErrorCode::RecordHashMismatch],
            );
        }
        if record.has_signature() {
            if !KeyMaterial::verify_with(
                &chain.public_key,
                &record.signing_preimage_of(),
                &record.sig,
            ) {
                return Verdict::failed(
                    Some(record.seq),
                    verified,
                    vec![ErrorCode::SignatureInvalid],
                );
            }
        } else if chain.signature_mode == SignatureMode::PerRecord
            && record.kind == RecordKind::Result
        {
            // `per_record` 模式下结果记录必须带签名；缺失不是"跳过"，是失败。
            return Verdict::failed(
                Some(record.seq),
                verified,
                vec![ErrorCode::SignatureInvalid],
            );
        }
        prev_expected = record.record_hash;
        verified += 1;
    }

    // ── 阶段 2：批量 ────────────────────────────────────────────────
    if chain.signature_mode == SignatureMode::Batch {
        if let Some(code) = check_batches(chain, options) {
            return Verdict::failed(None, verified, vec![code]);
        }
    }

    // ── 阶段 3：链头摘要 ────────────────────────────────────────────
    let recomputed_head = chain
        .records
        .last()
        .map(|record| record.record_hash)
        .unwrap_or_else(Bytes32::zero);
    let record_count = chain.records.len() as u64;
    let last_seq = chain.records.last().map(|record| record.seq).unwrap_or(0);
    let result_count = chain.result_records() as u64;
    if chain.head.chain_head != recomputed_head
        || chain.head.record_count != record_count
        || chain.head.seq != last_seq
        || chain.head.result_records != result_count
    {
        return Verdict::failed(None, verified, vec![ErrorCode::ChainHeadMismatch]);
    }

    // ── 阶段 4：链头签名 ────────────────────────────────────────────
    match &chain.head_signature {
        None => return Verdict::failed(None, verified, vec![ErrorCode::HeadSignatureInvalid]),
        Some(head_signature) => {
            if head_signature.public_key != chain.public_key {
                return Verdict::failed(None, verified, vec![ErrorCode::PublicKeyMismatch]);
            }
            if !KeyMaterial::verify_with(
                &head_signature.public_key,
                &head_preimage(&recomputed_head, record_count),
                &head_signature.sig,
            ) {
                return Verdict::failed(None, verified, vec![ErrorCode::HeadSignatureInvalid]);
            }
        }
    }

    // ── 阶段 5：外部见证 ────────────────────────────────────────────
    if let Some(expected) = options.expected_public_key {
        if expected != chain.public_key {
            return Verdict::failed(None, verified, vec![ErrorCode::PublicKeyMismatch]);
        }
    }
    if let Some(expected) = options.expected_chain_head {
        if expected != recomputed_head {
            return Verdict::failed(None, verified, vec![ErrorCode::ChainHeadMismatch]);
        }
    }
    if options.anchor_declared && options.anchor_head.is_none() {
        return Verdict::failed(None, verified, vec![ErrorCode::AnchorMissing]);
    }
    if let Some(anchor) = options.anchor_head {
        if anchor != recomputed_head {
            return Verdict::failed(None, verified, vec![ErrorCode::AnchorMismatch]);
        }
    }

    Verdict {
        chain_ok: true,
        first_bad_seq: None,
        verified_records: verified,
        errors: Vec::new(),
    }
}

/// 判定一段 `payload_jcs` 是否**已经**是该载荷的 JCS 规范化字节。
///
/// 设计 §7.2 的原话是"签名的前提是同样的语义 ⇒ 同样的字节"——既然是**前提**，验证器就该
/// 检验它。做法：把字节解析回 JSON 值再规范化一次，逐字节比对。解析不了（不是合法
/// UTF-8 JSON）同样算不合格。
pub fn payload_is_canonical(payload_jcs: &[u8]) -> bool {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(payload_jcs) else {
        return false;
    };
    match crate::jcs::canonicalize_bytes(&value) {
        Ok(canonical) => canonical == payload_jcs,
        Err(_) => false,
    }
}

/// 阶段 0：序号完整性。
///
/// 三步，顺序有意义（三者的组合把设计 §7.3 表里的三种注入区分开）：
///
/// 1. **有重复** → `seq_conflict`（插入的指纹）；
/// 2. **有缺号** → `seq_gap`（删记录的指纹）；
/// 3. **集合恰好是 `{1..n}` 但顺序不对** → `seq_conflict`（重排的指纹）。
///
/// 判定路径不用 `HashMap`（设计 §6.4）：用按 `seq` 下标的计数数组，`O(n)` 且完全确定。
pub fn check_sequence(records: &[Record]) -> Option<(ErrorCode, u64)> {
    let n = records.len() as u64;
    let mut counts = vec![0u32; n as usize + 2];
    for record in records {
        if record.seq >= 1 && record.seq <= n + 1 {
            counts[record.seq as usize] += 1;
        }
    }
    for seq in 1..=n + 1 {
        if counts[seq as usize] >= 2 {
            return Some((ErrorCode::SeqConflict, seq));
        }
    }
    for seq in 1..=n {
        if counts[seq as usize] == 0 {
            return Some((ErrorCode::SeqGap, seq));
        }
    }
    for (index, record) in records.iter().enumerate() {
        let expected = index as u64 + 1;
        if record.seq != expected {
            return Some((ErrorCode::SeqConflict, record.seq));
        }
    }
    None
}

/// 批量阶段的检查；返回第一个错误码。
fn check_batches(chain: &AttestedChain, options: &VerifyOptions) -> Option<ErrorCode> {
    let Some(chunks) = partition_result_seqs(&chain.records, chain.batch_size) else {
        return Some(ErrorCode::VerifierMisconfigured);
    };
    if chunks.len() != chain.batches.len() {
        return Some(ErrorCode::BatchLeafSetMismatch);
    }
    for (index, batch) in chain.batches.iter().enumerate() {
        let Some(chunk) = chunks.get(index) else {
            return Some(ErrorCode::BatchLeafSetMismatch);
        };
        if batch.index != index || &batch.leaves != chunk {
            return Some(ErrorCode::BatchLeafSetMismatch);
        }
        let Some(first_seq) = chunk.first() else {
            return Some(ErrorCode::BatchLeafSetMismatch);
        };
        let Some(last_seq) = chunk.last() else {
            return Some(ErrorCode::BatchLeafSetMismatch);
        };
        if batch.first_seq != *first_seq || batch.last_seq != *last_seq {
            return Some(ErrorCode::BatchLeafSetMismatch);
        }
        // 用**链上重算**的叶子重建根（不信任 batch.root）。
        let leaves: Vec<Bytes32> = chunk
            .iter()
            .filter_map(|seq| record_at(chain, *seq))
            .map(|record| merkle::leaf_hash(&record.record_hash))
            .collect();
        if leaves.len() != chunk.len() {
            return Some(ErrorCode::BatchLeafSetMismatch);
        }
        if merkle::merkle_root(&leaves) != Some(batch.root) {
            return Some(ErrorCode::BatchRootMismatch);
        }
        if batch.public_key != chain.public_key {
            return Some(ErrorCode::PublicKeyMismatch);
        }
        if !KeyMaterial::verify_with(&batch.public_key, &batch.preimage(), &batch.sig) {
            return Some(ErrorCode::BatchSignatureInvalid);
        }
        if options.verify_proofs {
            for (position, seq) in chunk.iter().enumerate() {
                let Some(proof) = batch.proofs.iter().find(|proof| proof.seq == *seq) else {
                    return Some(ErrorCode::MerkleProofMissing);
                };
                let leaf = leaf_from_position(&leaves, position);
                let proof = InclusionProof {
                    path: proof.path.clone(),
                };
                if !proof.verifies(&leaf, &batch.root) {
                    return Some(ErrorCode::MerkleProofInvalid);
                }
            }
        }
    }
    None
}

fn partition_result_seqs(records: &[Record], batch_size: usize) -> Option<Vec<Vec<u64>>> {
    if batch_size == 0 {
        return None;
    }
    let seqs = result_seqs(records);
    Some(
        seqs.chunks(batch_size)
            .map(|chunk| chunk.to_vec())
            .collect(),
    )
}

fn record_at(chain: &AttestedChain, seq: u64) -> Option<&Record> {
    // 记录链的 seq 连续且与下标一一对应（阶段 1 已验证），所以可以按下标取；
    // 但这里仍按 seq 查，避免"假设"悄悄溜进来。
    chain.records.iter().find(|record| record.seq == seq)
}

fn leaf_from_position(leaves: &[Bytes32], position: usize) -> Bytes32 {
    leaves.get(position).copied().unwrap_or_else(Bytes32::zero)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::{AttestConfig, Attestor};
    use crate::record::ChainBuilder;
    use serde_json::json;

    fn chain_of(count: usize) -> (AttestedChain, crate::signing::KeyMaterial) {
        let key = crate::signing::KeyMaterial::from_seed_bytes([5u8; 32]);
        let mut builder = ChainBuilder::new();
        for index in 0..count {
            builder
                .append(RecordKind::Result, &json!({"i": index}), index as i64 + 1)
                .unwrap();
        }
        let mut attestor = Attestor::new(
            crate::signing::KeyMaterial::from_seed_bytes([5u8; 32]),
            AttestConfig::default(),
        );
        (attestor.sign_chain("run", builder.records()).unwrap(), key)
    }

    #[test]
    fn clean_chain_passes_including_two_head_witnesses() {
        let (chain, _key) = chain_of(5);
        let options = VerifyOptions {
            expected_chain_head: Some(chain.head.chain_head),
            anchor_declared: true,
            anchor_head: Some(chain.head.chain_head),
            expected_public_key: Some(chain.public_key),
            verify_proofs: true,
        };
        let verdict = verify_chain(&chain, &options);
        assert!(verdict.chain_ok, "{}", verdict.render());
        assert_eq!(verdict.verified_records, 5);
    }

    #[test]
    fn anchor_mismatch_and_missing_are_distinct() {
        let (chain, _key) = chain_of(2);
        let mismatched = VerifyOptions {
            anchor_declared: true,
            anchor_head: Some(Bytes32::from_bytes([9u8; 32])),
            ..VerifyOptions::default()
        };
        assert_eq!(
            verify_chain(&chain, &mismatched).errors,
            vec![ErrorCode::AnchorMismatch]
        );
        let missing = VerifyOptions {
            anchor_declared: true,
            anchor_head: None,
            ..VerifyOptions::default()
        };
        assert_eq!(
            verify_chain(&chain, &missing).errors,
            vec![ErrorCode::AnchorMissing]
        );
    }

    #[test]
    fn payload_tamper_is_located_at_the_record() {
        let (mut chain, _key) = chain_of(4);
        chain.records[2].payload_jcs = json!({"i": 999}).to_string().into_bytes();
        let verdict = verify_chain(&chain, &VerifyOptions::default());
        assert_eq!(verdict.first_bad_seq, Some(3));
        assert_eq!(verdict.verified_records, 2);
        assert_eq!(verdict.errors, vec![ErrorCode::PayloadHashMismatch]);
    }
}
