//! 批量 Merkle 签名与链文件装配（设计 §7.3.1）。
//!
//! # 为什么是"只签根"
//!
//! 逐条签名让开销与消息数**线性相关**，于是只能靠一个机器相关的"耗时占比 ≤ 5%"门槛来守——
//! 而那个门槛既不可移植、也无法先验设定（RFC §8 Q4）。改成批量后：
//!
//! ```text
//! N 条结果记录 → 构 Merkle 树 → 只签根（1 次 Ed25519）+ 每叶附 inclusion proof
//! 签名次数：O(N/B)   B = 批大小（默认 4096）
//! 验证成本：O(log N) 每叶
//! ```
//!
//! 于是门槛从"耗时占比"（机器相关）变成"**签名次数上界**"（结构相关）：
//! `签名次数 ≤ ceil(N/B) + 2`（指标 D4a）。本模块把计数做成 [`SignatureStats`] 公开读数，
//! 并且在 `batch` 模式下**超界即报错**——不靠"跑一次看看"。
//!
//! # 签名原像（三处，全部有域标签）
//!
//! | 位置 | 原像 | 何时用 |
//! |---|---|---|
//! | 逐条记录（§7.1） | `seq ‖ prev_hash ‖ kind ‖ payload_hash` | `per_record` 对照模式 |
//! | 批量根 | `域标签:batch: ‖ root ‖ first_seq ‖ last_seq` | `batch` 生产模式 |
//! | 链头 | `域标签:head: ‖ chain_head ‖ record_count` | 两种模式都有（一次） |
//!
//! 链头签名绑定整条链（含门控 / 能力变更 / 释放这些不单独签名的记录），
//! 因此"只对结果类记录签名"省掉的是**逐条**开销，不是覆盖面。

use serde::{Deserialize, Serialize};

use crate::anchor::AnchorHead;
use crate::error::AttestError;
use crate::jcs;
use crate::merkle::{self, ProofStep};
use crate::record::{Record, RecordKind};
use crate::signing::{
    batch_preimage, head_preimage, KeyMaterial, SignatureStats, VERIFIER_VERSION,
};
use crate::types::{hex_bytes, Bytes32};

/// 链文件格式标识（跨语言契约的一部分）。
pub const CHAIN_FORMAT: &str = "dsh-testkit/attest/chain/v1";

/// 缺省批大小（设计 §7.3.1）。
pub const DEFAULT_BATCH_SIZE: usize = 4096;

/// 签名模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureMode {
    /// 批量 Merkle 签名——**生产路径**，D4a 的上界只对它承诺。
    Batch,
    /// 逐条签名——只用于对照 §7.1 的"记录级签名"语义，签名次数 `O(N)`，不在 D4a 口径内。
    PerRecord,
}

/// 一片叶子的 inclusion proof。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LeafProof {
    /// 该叶对应的记录 `seq`。
    pub seq: u64,
    /// 证据步骤。
    #[serde(default)]
    pub path: Vec<ProofStep>,
}

/// 一个批次的签名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchSignature {
    /// 批次序号（从 0 起）。
    pub index: usize,
    /// 本批第一条记录（含）的 `seq`。
    pub first_seq: u64,
    /// 本批最后一条记录（含）的 `seq`。
    pub last_seq: u64,
    /// 本批叶子对应的记录 `seq`（升序，且**只含结果记录**）。
    pub leaves: Vec<u64>,
    /// Merkle 根。
    pub root: Bytes32,
    /// 对根（及其批次边界）的 Ed25519 签名。
    #[serde(with = "hex_bytes")]
    pub sig: Vec<u8>,
    /// 签名公钥。
    pub public_key: Bytes32,
    /// 每片叶的 inclusion proof。
    #[serde(default)]
    pub proofs: Vec<LeafProof>,
}

impl BatchSignature {
    /// 本批的签名原像。
    pub fn preimage(&self) -> Vec<u8> {
        batch_preimage(&self.root, self.first_seq, self.last_seq)
    }
}

/// 链头签名。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadSignature {
    /// Ed25519 签名。
    #[serde(with = "hex_bytes")]
    pub sig: Vec<u8>,
    /// 签名公钥。
    pub public_key: Bytes32,
}

/// 链头摘要（写进报告的 `chain_head` 一族字段）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChainSummary {
    /// 末条记录的 `seq`（空链为 0）。
    pub seq: u64,
    /// 记录总数。
    pub record_count: u64,
    /// 结果记录数（D4a 的 N）。
    pub result_records: u64,
    /// 链头哈希（空链为全零）。
    pub chain_head: Bytes32,
}

/// 一条装配完成的签名链（= 链文件的内容）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttestedChain {
    /// 格式标识，固定 [`CHAIN_FORMAT`]。
    pub format: String,
    /// 运行 id。
    pub run_id: String,
    /// 批大小。
    pub batch_size: usize,
    /// 签名模式。
    pub signature_mode: SignatureMode,
    /// 签名公钥（公开值；私钥永远不在这个结构里——I1）。
    pub public_key: Bytes32,
    /// 记录链。
    pub records: Vec<Record>,
    /// 批次签名（`batch` 模式下非空）。
    #[serde(default)]
    pub batches: Vec<BatchSignature>,
    /// 链头摘要。
    pub head: ChainSummary,
    /// 链头签名。
    #[serde(default)]
    pub head_signature: Option<HeadSignature>,
    /// 签名次数读数（D4a）。
    pub stats: SignatureStats,
}

impl AttestedChain {
    /// 序列化成链文件文本（两空格缩进 + 结尾换行）。
    pub fn to_json_text(&self) -> Result<String, AttestError> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        Ok(text)
    }

    /// 从链文件文本解析（**格式必须先自检**，别把意外输入的解析错误当成"链有问题"）。
    pub fn from_json_text(text: &str) -> Result<Self, AttestError> {
        let chain: AttestedChain = serde_json::from_str(text)?;
        if chain.format != CHAIN_FORMAT {
            return Err(AttestError::Wire(format!(
                "format 期望 {}，实际 {}",
                CHAIN_FORMAT, chain.format
            )));
        }
        Ok(chain)
    }

    /// 结果记录数。
    pub fn result_records(&self) -> usize {
        self.records
            .iter()
            .filter(|record| record.kind.is_signed())
            .count()
    }

    /// 末条逻辑刻度（空链为 0）。
    pub fn last_ts(&self) -> i64 {
        self.records.last().map(|record| record.ts).unwrap_or(0)
    }

    /// 本链对应的锚定记录（设计 §7.6 的五个字段）。
    pub fn anchor_head(&self) -> AnchorHead {
        AnchorHead::new(
            &self.run_id,
            self.head.chain_head,
            self.head.record_count,
            self.last_ts(),
        )
    }

    /// 验证器版本（链文件本身不写版本，锚定文件写——这里只暴露给调用方）。
    pub fn verifier_version(&self) -> &'static str {
        VERIFIER_VERSION
    }
}

/// 装配参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AttestConfig {
    /// 批大小（默认 4096）。
    pub batch_size: usize,
    /// 是否生成 inclusion proof（D4a 计数不需要它，但 §7.3.1 要求生产链带上它）。
    pub emit_proofs: bool,
    /// 签名模式。
    pub signature_mode: SignatureMode,
}

impl Default for AttestConfig {
    fn default() -> Self {
        AttestConfig {
            batch_size: DEFAULT_BATCH_SIZE,
            emit_proofs: true,
            signature_mode: SignatureMode::Batch,
        }
    }
}

/// 签名者：持有密钥与配置，把"记录链"装配成"签名链"。
///
/// 私钥进得来、出不去：本结构不实现 `Serialize`，[`KeyMaterial`] 也不实现 `Clone`。
pub struct Attestor {
    key: KeyMaterial,
    config: AttestConfig,
    batch_signatures: u64,
    head_signatures: u64,
    per_record_signatures: u64,
}

impl std::fmt::Debug for Attestor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Attestor")
            .field("public_key", &self.key.public_key_hex())
            .field("config", &self.config)
            .finish()
    }
}

impl Attestor {
    /// 构造签名者。
    pub fn new(key: KeyMaterial, config: AttestConfig) -> Self {
        Attestor {
            key,
            config,
            batch_signatures: 0,
            head_signatures: 0,
            per_record_signatures: 0,
        }
    }

    /// 本签名者的公钥。
    pub fn public_key(&self) -> Bytes32 {
        self.key.public_key()
    }

    /// 到目前为止的签名次数读数。
    pub fn stats(&self, result_records: u64) -> SignatureStats {
        SignatureStats::new(
            result_records,
            self.config.batch_size,
            self.batch_signatures,
            self.head_signatures,
            self.per_record_signatures,
        )
    }

    /// 把记录链装配成签名链。
    ///
    /// `batch` 模式下签名次数**超界即报错**（D4a 是硬约束，不是"跑完再看看"）。
    pub fn sign_chain(
        &mut self,
        run_id: &str,
        records: &[Record],
    ) -> Result<AttestedChain, AttestError> {
        if self.config.batch_size == 0 {
            return Err(AttestError::EmptyBatchSize);
        }
        let public_key = self.key.public_key();
        let mut signed_records: Vec<Record> = records.to_vec();

        // 1) 逐条签名（只对结果记录；`per_record` 对照模式）。
        if self.config.signature_mode == SignatureMode::PerRecord {
            for record in signed_records.iter_mut() {
                if record.kind.is_signed() && record.sig.is_empty() {
                    record.sig = self.key.sign(&record.signing_preimage_of());
                    self.per_record_signatures += 1;
                }
            }
        }

        // 2) 批量 Merkle 签名：叶序 = 结果记录在链上的 seq 升序。
        let result_indexes: Vec<usize> = signed_records
            .iter()
            .enumerate()
            .filter(|(_, record)| record.kind.is_signed())
            .map(|(index, _)| index)
            .collect();
        let mut batches = Vec::new();
        for (batch_index, chunk) in result_indexes.chunks(self.config.batch_size).enumerate() {
            let leaves: Vec<Bytes32> = chunk
                .iter()
                .map(|&index| merkle::leaf_hash(&signed_records[index].record_hash))
                .collect();
            let tree = merkle::MerkleTree::from_leaves(&leaves);
            let Some(root) = tree.root() else {
                continue;
            };
            let first_seq = signed_records[chunk[0]].seq;
            let last_seq = signed_records[chunk[chunk.len() - 1]].seq;
            let sig = self.key.sign(&batch_preimage(&root, first_seq, last_seq));
            self.batch_signatures += 1;
            let proofs = if self.config.emit_proofs {
                chunk
                    .iter()
                    .enumerate()
                    .map(|(position, &index)| LeafProof {
                        seq: signed_records[index].seq,
                        path: tree.proof(position).map(|p| p.path).unwrap_or_default(),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            batches.push(BatchSignature {
                index: batch_index,
                first_seq,
                last_seq,
                leaves: chunk
                    .iter()
                    .map(|&index| signed_records[index].seq)
                    .collect(),
                root,
                sig,
                public_key,
                proofs,
            });
        }

        // 3) 链头摘要 + 链头签名（绑定整条链，含不单独签名的记录种类）。
        let chain_head = signed_records
            .last()
            .map(|record| record.record_hash)
            .unwrap_or_else(Bytes32::zero);
        let record_count = signed_records.len() as u64;
        let head_sig = self.key.sign(&head_preimage(&chain_head, record_count));
        self.head_signatures += 1;

        let stats = SignatureStats::new(
            result_indexes.len() as u64,
            self.config.batch_size,
            self.batch_signatures,
            self.head_signatures,
            self.per_record_signatures,
        );
        // (b) 按构造不可达（task-26 的性质判定）：`batch` 模式下每次签名都被计数，
        // 而 `stats.bound = ceil(N/B) + 2`、实际次数 = `ceil(N/B) + 1`，所以这里的
        // `!stats.within_bound` **永远为假**——除非有人把上面的签名次数改少。
        // 这一条是**不变量断言**（改错就报错，而不是悄悄产出一条超界的链），
        // 刻意不补测试：要触发它必须先把计数器改成假的，那样的测试只是在测自己的手脚。
        if self.config.signature_mode == SignatureMode::Batch && !stats.within_bound {
            return Err(AttestError::Internal(
                "签名次数超过 D4a 上界 ceil(N/B)+2（batch 模式不允许）",
            ));
        }

        Ok(AttestedChain {
            format: CHAIN_FORMAT.to_string(),
            run_id: run_id.to_string(),
            batch_size: self.config.batch_size,
            signature_mode: self.config.signature_mode,
            public_key,
            records: signed_records,
            batches,
            head: ChainSummary {
                seq: record_count,
                record_count,
                result_records: result_indexes.len() as u64,
                chain_head,
            },
            head_signature: Some(HeadSignature {
                sig: head_sig,
                public_key,
            }),
            stats,
        })
    }

    /// 计数器归零（同一进程里跑多次装配时，D4a 读的是**单次装配**的次数）。
    pub fn reset_counters(&mut self) {
        self.batch_signatures = 0;
        self.head_signatures = 0;
        self.per_record_signatures = 0;
    }
}

/// 把任意 JSON 载荷规范化后追加进链的便捷函数（供调用方构造记录）。
pub fn payload_bytes(payload: &serde_json::Value) -> Result<Vec<u8>, AttestError> {
    Ok(jcs::canonicalize_bytes(payload)?)
}

/// 结果记录的 `seq` 列表（升序）——验证器与测试都要用同一份定义。
pub fn result_seqs(records: &[Record]) -> Vec<u64> {
    records
        .iter()
        .filter(|record| record.kind.is_signed())
        .map(|record| record.seq)
        .collect()
}

/// 记录种类是否是"结果类"（转发，避免调用方到处 import [`RecordKind`]）。
pub fn is_result_kind(kind: RecordKind) -> bool {
    kind.is_signed()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::record::ChainBuilder;
    use serde_json::json;

    fn key() -> KeyMaterial {
        KeyMaterial::from_seed_bytes([42u8; 32])
    }

    fn builder(count: usize) -> ChainBuilder {
        let mut builder = ChainBuilder::new();
        for index in 0..count {
            builder
                .append(
                    RecordKind::Result,
                    &json!({"case": index}),
                    index as i64 + 1,
                )
                .unwrap();
        }
        builder
    }

    #[test]
    fn batch_mode_signs_once_per_batch_plus_head() {
        let mut attestor = Attestor::new(key(), AttestConfig::default());
        let mut chain_builder = builder(3);
        chain_builder
            .append(RecordKind::Gate, &json!({"allowed": true}), 4)
            .unwrap();
        let chain = attestor
            .sign_chain("run-1", chain_builder.records())
            .unwrap();
        assert_eq!(chain.batches.len(), 1);
        assert_eq!(chain.batches[0].leaves, vec![1, 2, 3]);
        assert_eq!(chain.batches[0].proofs.len(), 3);
        assert_eq!(chain.stats.batch_signatures, 1);
        assert_eq!(chain.stats.head_signatures, 1);
        assert_eq!(chain.stats.total_signatures, 2);
        assert!(chain.stats.within_bound);
        assert_eq!(chain.head.result_records, 3);
        assert_eq!(chain.head.record_count, 4);
        assert!(chain.records.iter().all(|record| record.sig.is_empty()));
    }

    #[test]
    fn bound_violation_is_impossible_in_batch_mode_by_construction() {
        // 逐批计数：N=10000, B=100 → 100 批 + 1 链头 = 101 ≤ ceil(10000/100)+2 = 102。
        let config = AttestConfig {
            batch_size: 100,
            emit_proofs: false,
            signature_mode: SignatureMode::Batch,
        };
        let mut attestor = Attestor::new(key(), config);
        let chain = attestor
            .sign_chain("run-big", builder(10_000).records())
            .unwrap();
        assert_eq!(chain.batches.len(), 100);
        assert_eq!(chain.stats.total_signatures, 101);
        assert_eq!(chain.stats.bound, 102);
        assert!(chain.stats.within_bound);
    }

    #[test]
    fn per_record_mode_signs_every_result_record() {
        let config = AttestConfig {
            signature_mode: SignatureMode::PerRecord,
            ..AttestConfig::default()
        };
        let mut attestor = Attestor::new(key(), config);
        let chain = attestor.sign_chain("run-2", builder(4).records()).unwrap();
        assert_eq!(chain.stats.per_record_signatures, 4);
        assert!(chain.records.iter().all(|record| record.has_signature()));
    }
}
