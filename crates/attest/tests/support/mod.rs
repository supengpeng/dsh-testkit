//! 测试支撑：向量语料、**篡改注入器**、确定性伪随机 JSON 生成器。
//!
//! 这个模块被三类目标共用：
//!
//! - `tests/*.rs`（检出侧：读语料、应用注入、跑验证器、比对期望）；
//! - `examples/generate_corpus.rs`（生成侧：**先写注入器与期望，再写检出**）；
//! - `tests/jcs_cross.rs`（跨实现：把 Rust 侧的规范化字节落盘给 TS 侧比对）。
//!
//! 为什么把注入器与语料放在测试侧而不是 `src/`：注入器是**测试夹具**，不该出现在
//! 生产签名路径上。两边的生产 API（`Attestor` / `verify_chain`）都不会引用它。
//!
//! # 测试密钥的派生（**仓库里没有任何私钥材料**）
//!
//! `seed = SHA-256(utf8("dsh-testkit/attest/test-vector-key/v1"))`。标签是公开的，
//! 任何人都能重算出同一把密钥——**它只是测试向量**，绝不可用于生产。
//! 这样做的直接好处：仓库、语料、链文件里都不出现私钥字节（I1 的"不落盘"从源头成立），
//! 而两侧仍然能独立算出同一把签名密钥。

#![allow(dead_code)]

use std::path::{Path, PathBuf};

use attest::chain::{result_seqs, AttestConfig, Attestor, SignatureMode};
use attest::record::{ChainBuilder, Record, RecordKind};
use attest::signing::KeyMaterial;
use attest::types::Bytes32;
use attest::{jcs, sha256_parts, verify, ErrorCode, Verdict, VerifyOptions};
use dsh_testkit_attest as attest;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// 测试密钥标签（公开；见模块文档）。
pub const TEST_KEY_LABEL: &str = "dsh-testkit/attest/test-vector-key/v1";

/// 测试密钥。
pub fn test_key() -> KeyMaterial {
    KeyMaterial::from_seed_bytes(sha256_parts(&[TEST_KEY_LABEL.as_bytes()]).0)
}

/// 测试密钥的**种子**（小写 hex）——给"从环境变量装载密钥"这类测试用。
pub fn test_seed_hex() -> String {
    sha256_parts(&[TEST_KEY_LABEL.as_bytes()]).to_hex()
}

/// 仓库根（`crates/attest/../..`）。
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// 语料文件路径。
pub fn corpus_path() -> PathBuf {
    repo_root().join("spec/vectors/attest/corpus.json")
}

/// 跨实现随机对拍文件的路径（生成在构建目录里，不入库）。
pub fn jcs_cross_path() -> PathBuf {
    repo_root().join("target/attest/jcs-random.txt")
}

/// 测试用可写目录（本仓沙箱只允许子进程写仓库内路径）。
pub fn scratch_dir(tag: &str) -> PathBuf {
    repo_root().join("target/attest").join(tag)
}

// --------------------------- 语料结构 ---------------------------

/// 整个语料。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Corpus {
    /// 语料版本。
    pub version: u32,
    /// 边界声明（**必须随语料一起被读到**）。
    pub note: String,
    /// 测试密钥信息（只有公钥与派生方式，没有私钥）。
    pub key: KeyInfo,
    /// 批大小。
    pub batch_size: usize,
    /// 基准链。
    pub bases: Vec<BaseEntry>,
    /// 注入用例（期望被检出）。
    pub cases: Vec<CaseEntry>,
    /// **已知检不出**的用例（设计 §7.5 的边界；期望 `chainOk == true`）。
    pub boundary_cases: Vec<CaseEntry>,
}

/// 测试密钥信息。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyInfo {
    /// 派生方式（人类可读）。
    pub derivation: String,
    /// 标签。
    pub label: String,
    /// 派生出的公钥（hex）。
    pub public_key: String,
}

/// 一条基准链。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BaseEntry {
    /// 标识。
    pub id: String,
    /// 签名模式。
    pub mode: String,
    /// 链本体。
    pub chain: attest::AttestedChain,
}

/// 外部见证的取值方式（跨语言一致：`null` = 原始运行的值，`"self"` = 被改后的链自己的值）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ContextSpec {
    /// `run.json` 的链头。
    #[serde(default)]
    pub expected_chain_head: Option<String>,
    /// 锚定目录的链头。
    #[serde(default)]
    pub anchor_head: Option<String>,
    /// 是否声明了锚定（缺省 true）。
    #[serde(default)]
    pub anchor_declared: Option<bool>,
    /// 预期公钥（缺省 = 链自己的公钥）。
    #[serde(default)]
    pub expected_public_key: Option<String>,
    /// 是否校验 inclusion proof（缺省 true）。
    #[serde(default)]
    pub verify_proofs: Option<bool>,
}

/// 一个用例。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CaseEntry {
    /// 用例 id。
    pub id: String,
    /// 注入类别（`field` / `delete` / `reorder` / `insert` / `signature` / `extras`）。
    pub class: String,
    /// 用哪条基准链。
    pub base: String,
    /// 这个用例想说明什么（**期望的检出机制写在这里**）。
    pub note: String,
    /// 外部见证取值。
    #[serde(default)]
    pub context: ContextSpec,
    /// 注入操作（按序应用）。
    pub ops: Vec<Op>,
    /// 期望结论——**先于检出实现写下的**，来自设计 §7.3 的机制表。
    pub expected: Verdict,
}

// --------------------------- 注入器 ---------------------------

/// 一次注入操作。两侧（Rust / TS）各有一份**逐字对应**的实现。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// 改载荷里的字段（新增或覆盖），**不动** `payload_hash` / `record_hash`。
    SetPayloadField {
        /// 目标记录 seq。
        seq: u64,
        /// 字段路径。
        path: Vec<String>,
        /// 新值。
        value: Value,
    },
    /// 删掉下标处的记录。
    DeleteRecord {
        /// 0 起下标。
        index: usize,
    },
    /// 交换下标与下标+1 的两条记录。
    SwapRecords {
        /// 0 起下标。
        index: usize,
    },
    /// 在下标处复制一份自己插到后面。
    DuplicateRecord {
        /// 0 起下标。
        index: usize,
    },
    /// 翻转 `payload_hash` 的一个字节。
    FlipPayloadHash {
        /// 目标记录 seq。
        seq: u64,
        /// 字节偏移。
        offset: usize,
    },
    /// 翻转 `record_hash` 的一个字节。
    FlipRecordHash {
        /// 目标记录 seq。
        seq: u64,
        /// 字节偏移。
        offset: usize,
    },
    /// 把 `ts` 加一。
    BumpTs {
        /// 目标记录 seq。
        seq: u64,
    },
    /// 翻转逐条签名的一个字节。
    FlipSig {
        /// 目标记录 seq。
        seq: u64,
        /// 字节偏移。
        offset: usize,
    },
    /// 翻转批量签名的一个字节。
    FlipBatchSig {
        /// 批次下标。
        batch: usize,
        /// 字节偏移。
        offset: usize,
    },
    /// 翻转链头签名的一个字节。
    FlipHeadSig {
        /// 字节偏移。
        offset: usize,
    },
    /// 翻转某片叶的 inclusion proof 的一步。
    FlipProof {
        /// 批次下标。
        batch: usize,
        /// 叶子对应的记录 seq。
        seq: u64,
        /// 第几步。
        step: usize,
        /// 字节偏移。
        offset: usize,
    },
    /// 删掉某片叶的 inclusion proof。
    DropProof {
        /// 批次下标。
        batch: usize,
        /// 叶子对应的记录 seq。
        seq: u64,
    },
    /// 从批次的 `leaves` 里摘掉一个 seq（根不动）。
    RemoveLeaf {
        /// 批次下标。
        batch: usize,
        /// 叶子对应的记录 seq。
        seq: u64,
    },
    /// 把链头摘要改成固定垃圾值（模拟"报告被单独改动"）。
    StaleHeadChainHead {},
    /// 把载荷写成**语义相同但形态不同**的字节（缩进/换行），模拟"不遵守 JCS 约定的生产者"。
    NoncanonicalPayload {
        /// 目标记录 seq。
        seq: u64,
    },
    /// 按当前记录重算 `payload_hash` / `prev_hash` / `record_hash`（保持签名不动）。
    RecomputeChainHashes {},
    /// 按当前记录重算链头摘要。
    RecomputeHead {},
    /// 按当前记录重建批次（`resign` 决定是否重新签名）。
    RecomputeBatches {
        /// 是否用测试密钥重新签名。
        resign: bool,
    },
    /// 重签链头。
    RecomputeHeadSignature {},
    /// 追加一条记录（`prev_hash` 与自身哈希都算对，模拟"精修插入"）。
    AppendRecord {
        /// 记录种类。
        kind: RecordKind,
        /// 载荷。
        payload: Value,
        /// 逻辑刻度。
        ts: i64,
    },
}

/// 应用一串注入操作。
pub fn apply_ops(
    chain: &mut attest::AttestedChain,
    ops: &[Op],
    key: &KeyMaterial,
) -> Result<(), String> {
    for op in ops {
        apply_op(chain, op, key)?;
    }
    Ok(())
}

fn apply_op(chain: &mut attest::AttestedChain, op: &Op, key: &KeyMaterial) -> Result<(), String> {
    match op {
        Op::SetPayloadField { seq, path, value } => {
            let record = find_record_mut(chain, *seq)?;
            let mut payload: Value = serde_json::from_slice(&record.payload_jcs)
                .map_err(|error| format!("载荷不是合法 JSON：{error}"))?;
            set_path(&mut payload, path, value.clone());
            record.payload_jcs = jcs::canonicalize_bytes(&payload).map_err(|e| e.to_string())?;
            Ok(())
        }
        Op::DeleteRecord { index } => {
            if *index >= chain.records.len() {
                return Err(format!("删记录下标越界：{index}"));
            }
            chain.records.remove(*index);
            Ok(())
        }
        Op::SwapRecords { index } => {
            if index + 1 >= chain.records.len() {
                return Err(format!("重排下标越界：{index}"));
            }
            chain.records.swap(*index, index + 1);
            Ok(())
        }
        Op::DuplicateRecord { index } => {
            let Some(copy) = chain.records.get(*index).cloned() else {
                return Err(format!("复制下标越界：{index}"));
            };
            chain.records.insert(index + 1, copy);
            Ok(())
        }
        Op::FlipPayloadHash { seq, offset } => {
            flip(&mut find_record_mut(chain, *seq)?.payload_hash.0, *offset)
        }
        Op::FlipRecordHash { seq, offset } => {
            flip(&mut find_record_mut(chain, *seq)?.record_hash.0, *offset)
        }
        Op::BumpTs { seq } => {
            let record = find_record_mut(chain, *seq)?;
            record.ts += 1;
            Ok(())
        }
        Op::FlipSig { seq, offset } => flip(&mut find_record_mut(chain, *seq)?.sig, *offset),
        Op::FlipBatchSig { batch, offset } => {
            let target = chain
                .batches
                .get_mut(*batch)
                .ok_or_else(|| format!("批次越界：{batch}"))?;
            flip(&mut target.sig, *offset)
        }
        Op::FlipHeadSig { offset } => {
            let target = chain
                .head_signature
                .as_mut()
                .ok_or_else(|| "链头签名不存在".to_string())?;
            flip(&mut target.sig, *offset)
        }
        Op::FlipProof {
            batch,
            seq,
            step,
            offset,
        } => {
            let target = chain
                .batches
                .get_mut(*batch)
                .ok_or_else(|| format!("批次越界：{batch}"))?;
            let proof = target
                .proofs
                .iter_mut()
                .find(|proof| proof.seq == *seq)
                .ok_or_else(|| format!("找不到 seq={seq} 的证明"))?;
            let step_ref = proof
                .path
                .get_mut(*step)
                .ok_or_else(|| format!("证明步越界：{step}"))?;
            flip(&mut step_ref.sibling.0, *offset)
        }
        Op::DropProof { batch, seq } => {
            let target = chain
                .batches
                .get_mut(*batch)
                .ok_or_else(|| format!("批次越界：{batch}"))?;
            let before = target.proofs.len();
            target.proofs.retain(|proof| proof.seq != *seq);
            if target.proofs.len() == before {
                return Err(format!("找不到 seq={seq} 的证明"));
            }
            Ok(())
        }
        Op::RemoveLeaf { batch, seq } => {
            let target = chain
                .batches
                .get_mut(*batch)
                .ok_or_else(|| format!("批次越界：{batch}"))?;
            target.leaves.retain(|value| *value != *seq);
            Ok(())
        }
        Op::StaleHeadChainHead {} => {
            chain.head.chain_head = Bytes32::from_bytes([0xab; 32]);
            Ok(())
        }
        Op::NoncanonicalPayload { seq } => {
            let record = find_record_mut(chain, *seq)?;
            let payload: Value = serde_json::from_slice(&record.payload_jcs)
                .map_err(|error| format!("载荷不是合法 JSON：{error}"))?;
            // 语义完全相同的另一种字节形态：两空格缩进 + 换行。
            record.payload_jcs = serde_json::to_string_pretty(&payload)
                .map_err(|error| error.to_string())?
                .into_bytes();
            Ok(())
        }
        Op::RecomputeChainHashes {} => {
            recompute_chain_hashes(chain);
            Ok(())
        }
        Op::RecomputeHead {} => {
            recompute_head(chain);
            Ok(())
        }
        Op::RecomputeBatches { resign } => recompute_batches(chain, *resign, key),
        Op::RecomputeHeadSignature {} => {
            let preimage =
                attest::head_preimage(&chain.head.chain_head, chain.records.len() as u64);
            chain.head_signature = Some(attest::HeadSignature {
                sig: key.sign(&preimage),
                public_key: key.public_key(),
            });
            Ok(())
        }
        Op::AppendRecord { kind, payload, ts } => {
            let prev = chain
                .records
                .last()
                .map(|record| record.record_hash)
                .unwrap_or_else(Bytes32::zero);
            let seq = chain
                .records
                .last()
                .map(|record| record.seq + 1)
                .unwrap_or(1);
            let payload_jcs = jcs::canonicalize_bytes(payload).map_err(|e| e.to_string())?;
            let payload_hash = Record::compute_payload_hash(&payload_jcs);
            let record_hash = sha256_parts(&[&Record::record_hash_preimage(
                seq,
                &prev,
                *kind,
                &payload_hash,
                *ts,
            )]);
            chain.records.push(Record {
                seq,
                prev_hash: prev,
                kind: *kind,
                payload_jcs,
                payload_hash,
                record_hash,
                ts: *ts,
                sig: Vec::new(),
            });
            Ok(())
        }
    }
}

fn find_record_mut(chain: &mut attest::AttestedChain, seq: u64) -> Result<&mut Record, String> {
    chain
        .records
        .iter_mut()
        .find(|record| record.seq == seq)
        .ok_or_else(|| format!("找不到 seq={seq} 的记录"))
}

fn flip(bytes: &mut [u8], offset: usize) -> Result<(), String> {
    let length = bytes.len();
    let slot = bytes
        .get_mut(offset)
        .ok_or_else(|| format!("字节偏移越界：{offset}（长度 {length}）"))?;
    *slot ^= 0x01;
    Ok(())
}

fn set_path(target: &mut Value, path: &[String], new_value: Value) {
    match path.split_first() {
        None => *target = new_value,
        Some((head, rest)) => {
            if !target.is_object() {
                *target = Value::Object(serde_json::Map::new());
            }
            if let Some(map) = target.as_object_mut() {
                let entry = map.entry(head.clone()).or_insert(Value::Null);
                set_path(entry, rest, new_value);
            }
        }
    }
}

fn recompute_chain_hashes(chain: &mut attest::AttestedChain) {
    let mut prev = Bytes32::zero();
    for record in chain.records.iter_mut() {
        record.prev_hash = prev;
        record.payload_hash = Record::compute_payload_hash(&record.payload_jcs);
        record.record_hash = record.recompute_record_hash();
        prev = record.record_hash;
    }
}

fn recompute_head(chain: &mut attest::AttestedChain) {
    let chain_head = chain
        .records
        .last()
        .map(|record| record.record_hash)
        .unwrap_or_else(Bytes32::zero);
    chain.head = attest::ChainSummary {
        seq: chain.records.len() as u64,
        record_count: chain.records.len() as u64,
        result_records: chain.result_records() as u64,
        chain_head,
    };
}

fn recompute_batches(
    chain: &mut attest::AttestedChain,
    resign: bool,
    key: &KeyMaterial,
) -> Result<(), String> {
    let batch_size = chain.batch_size;
    if batch_size == 0 {
        return Err("批大小为 0".to_string());
    }
    let seqs = result_seqs(&chain.records);
    let record_hashes: Vec<(u64, Bytes32)> = chain
        .records
        .iter()
        .map(|record| (record.seq, record.record_hash))
        .collect();
    let old_batches = chain.batches.clone();
    let mut batches = Vec::new();
    for (index, chunk) in seqs.chunks(batch_size).enumerate() {
        let leaves: Vec<Bytes32> = chunk
            .iter()
            .map(|seq| {
                let hash = record_hashes
                    .iter()
                    .find(|(record_seq, _)| record_seq == seq)
                    .map(|(_, hash)| *hash)
                    .unwrap_or_else(Bytes32::zero);
                attest::merkle::leaf_hash(&hash)
            })
            .collect();
        let tree = attest::MerkleTree::from_leaves(&leaves);
        let Some(root) = tree.root() else {
            continue;
        };
        let first_seq = *chunk.first().ok_or("空批")?;
        let last_seq = *chunk.last().ok_or("空批")?;
        let sig = if resign {
            key.sign(&attest::batch_preimage(&root, first_seq, last_seq))
        } else {
            old_batches
                .get(index)
                .map(|batch| batch.sig.clone())
                .unwrap_or_default()
        };
        let proofs = chunk
            .iter()
            .enumerate()
            .map(|(position, seq)| attest::LeafProof {
                seq: *seq,
                path: tree
                    .proof(position)
                    .map(|proof| proof.path)
                    .unwrap_or_default(),
            })
            .collect();
        batches.push(attest::BatchSignature {
            index,
            first_seq,
            last_seq,
            leaves: chunk.to_vec(),
            root,
            sig,
            public_key: key.public_key(),
            proofs,
        });
    }
    chain.batches = batches;
    Ok(())
}

// --------------------------- 基准链 ---------------------------

/// 基准链的内容（`seq` → 种类 + 载荷）。
fn base_spec() -> Vec<(RecordKind, Value)> {
    vec![
        (
            RecordKind::Result,
            json!({"case_id": "TK-0001", "verdict": "passed", "duration_ms": 12, "usage": {"model_calls": 0, "tokens": 0}, "tags": ["smoke"]}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0002", "verdict": "passed", "duration_ms": 31, "usage": {"model_calls": 1, "tokens": 120}, "tags": ["smoke", "fs"], "note": "\u{e9}\u{0}\u{4e2d}\u{6587}"}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0003", "verdict": "failed", "duration_ms": 44, "usage": {"model_calls": 2, "tokens": 310}, "tags": ["llm"], "error": "\u{65ad}\u{8a00}\u{5931}\u{8d25}\u{ff1a}expected 1.0"}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0004", "verdict": "skipped", "duration_ms": 0, "usage": {"model_calls": 0, "tokens": 0}, "reason": "\u{80fd}\u{529b}\u{7f3a}\u{5931}"}),
        ),
        (
            RecordKind::Gate,
            json!({"gate": "model", "allowed": false, "cost": "high", "reason": "cost-tier"}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0005", "verdict": "passed", "duration_ms": 7, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0006", "verdict": "errored", "duration_ms": 88, "usage": {"model_calls": 3, "tokens": 640}, "tags": ["tool"], "error": "\u{6c99}\u{7bb1}\u{62d2}\u{7edd}\u{5199}\u{5165}"}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0007", "verdict": "passed", "duration_ms": 19, "usage": {"model_calls": 1, "tokens": 90}, "tags": ["smoke"]}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0008", "verdict": "passed", "duration_ms": 23, "usage": {"model_calls": 0, "tokens": 0}, "tags": ["fs"]}),
        ),
        (
            RecordKind::CapabilityChange,
            json!({"capability": "fs.write", "from": "available", "to": "missing"}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0011", "verdict": "failed", "duration_ms": 51, "usage": {"model_calls": 2, "tokens": 220}, "tags": ["llm"]}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0012", "verdict": "passed", "duration_ms": 15, "usage": {"model_calls": 0, "tokens": 0}, "tags": ["smoke"]}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0013", "verdict": "passed", "duration_ms": 9, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0014", "verdict": "skipped", "duration_ms": 0, "usage": {"model_calls": 0, "tokens": 0}, "reason": "\u{5939}\u{5177}\u{7f3a}\u{5931}"}),
        ),
        (
            RecordKind::Release,
            json!({"resource": "tmp-dir", "released": true}),
        ),
        (
            RecordKind::Result,
            json!({"case_id": "TK-0016", "verdict": "passed", "duration_ms": 33, "usage": {"model_calls": 1, "tokens": 77}, "tags": ["smoke", "dsl"]}),
        ),
    ]
}

/// 构造一条基准链。
pub fn base_chain(mode: SignatureMode, count: Option<usize>) -> attest::AttestedChain {
    let spec = base_spec();
    let spec = match count {
        Some(limit) => spec.into_iter().take(limit).collect::<Vec<_>>(),
        None => spec,
    };
    let mut builder = ChainBuilder::new();
    for (index, (kind, payload)) in spec.iter().enumerate() {
        builder
            .append(*kind, payload, index as i64 + 1)
            .expect("基准链载荷必须合法");
    }
    let mut attestor = Attestor::new(
        test_key(),
        AttestConfig {
            batch_size: 4096,
            emit_proofs: true,
            signature_mode: mode,
        },
    );
    attestor
        .sign_chain("run-attest-vector-0001", builder.records())
        .expect("基准链必须能装配")
}

// --------------------------- 用例表 ---------------------------

fn field_case(id: &str, seq: u64, path: &[&str], value: Value, note: &str) -> CaseEntry {
    CaseEntry {
        id: id.to_string(),
        class: "field".to_string(),
        base: "base_batch".to_string(),
        note: note.to_string(),
        context: ContextSpec::default(),
        ops: vec![Op::SetPayloadField {
            seq,
            path: path.iter().map(|item| item.to_string()).collect(),
            value,
        }],
        expected: Verdict::failed(
            Some(seq),
            seq as usize - 1,
            vec![ErrorCode::PayloadHashMismatch],
        ),
    }
}

fn delete_case(id: &str, index: usize, expected: Verdict, note: &str) -> CaseEntry {
    make_case(
        id,
        "delete",
        "base_batch",
        vec![Op::DeleteRecord { index }],
        expected,
        note,
    )
}

fn make_case(
    id: &str,
    class: &str,
    base: &str,
    ops: Vec<Op>,
    expected: Verdict,
    note: &str,
) -> CaseEntry {
    CaseEntry {
        id: id.to_string(),
        class: class.to_string(),
        base: base.to_string(),
        note: note.to_string(),
        context: ContextSpec::default(),
        ops,
        expected,
    }
}

/// 生成完整语料（生成侧与"语料新鲜度"守卫都走这里，保证二者同一份构造逻辑）。
pub fn build_corpus() -> Corpus {
    let key = test_key();
    let base_batch = base_chain(SignatureMode::Batch, None);
    let base_per_record = base_chain(SignatureMode::PerRecord, Some(4));
    let base_total = base_batch.records.len() as u64;

    let mut cases: Vec<CaseEntry> = Vec::new();

    // 1) 改字段（设计 §7.3 表：payload_hash 不匹配）
    cases.push(field_case(
        "field-01-verdict-passed-to-failed",
        1,
        &["verdict"],
        json!("failed"),
        "把通过改成失败",
    ));
    cases.push(field_case(
        "field-02-verdict-passed-to-failed",
        2,
        &["verdict"],
        json!("failed"),
        "把通过改成失败",
    ));
    cases.push(field_case(
        "field-03-verdict-failed-to-passed",
        3,
        &["verdict"],
        json!("passed"),
        "**最常见的篡改形态**：把失败改成通过",
    ));
    cases.push(field_case(
        "field-04-verdict-skipped-to-passed",
        4,
        &["verdict"],
        json!("passed"),
        "把跳过改成通过",
    ));
    cases.push(field_case(
        "field-05-gate-allowed",
        5,
        &["allowed"],
        json!(true),
        "门控记录：把拒绝改成允许",
    ));
    cases.push(field_case(
        "field-06-duration",
        6,
        &["duration_ms"],
        json!(0),
        "改耗时",
    ));
    cases.push(field_case(
        "field-07-usage-tokens",
        7,
        &["usage", "tokens"],
        json!(0),
        "嵌套字段：把 token 用量改成 0",
    ));
    cases.push(field_case(
        "field-08-tags",
        8,
        &["tags"],
        json!(["filesystem", "smoke"]),
        "改数组字段（注意不能把值设成原值，否则就是一条空转用例）",
    ));
    cases.push(field_case(
        "field-09-case-id",
        9,
        &["case_id"],
        json!("TK-9999"),
        "改用例 id",
    ));
    cases.push(field_case(
        "field-10-capability-to",
        10,
        &["to"],
        json!("available"),
        "能力变更记录：把 missing 改成 available",
    ));
    cases.push(field_case(
        "field-11-add-field",
        11,
        &["tampered_note"],
        json!("新增一个字段也算改载荷"),
        "新增字段",
    ));
    cases.push(field_case(
        "field-12-usage-model-calls",
        12,
        &["usage", "model_calls"],
        json!(999),
        "嵌套数字字段",
    ));
    cases.push(field_case(
        "field-13-release",
        15,
        &["released"],
        json!(false),
        "释放记录：把已释放改成未释放",
    ));
    cases.push(field_case(
        "field-14-last-record",
        16,
        &["injected"],
        json!({"nested": [1, 2, 3]}),
        "**末条**篡改（没有后继记录可比 prev_hash，靠 payload_hash 抓）",
    ));
    cases.push(make_case(
        "field-15-flip-payload-hash",
        "field",
        "base_batch",
        vec![Op::FlipPayloadHash { seq: 14, offset: 0 }],
        Verdict::failed(Some(14), 13, vec![ErrorCode::PayloadHashMismatch]),
        "直接改 payload_hash 字段",
    ));
    cases.push(make_case(
        "field-16-flip-payload-hash-tail",
        "field",
        "base_batch",
        vec![Op::FlipPayloadHash {
            seq: 16,
            offset: 31,
        }],
        Verdict::failed(Some(16), 15, vec![ErrorCode::PayloadHashMismatch]),
        "末条记录的 payload_hash 被改",
    ));
    cases.push(make_case(
        "field-17-flip-record-hash",
        "field",
        "base_batch",
        vec![Op::FlipRecordHash { seq: 13, offset: 0 }],
        Verdict::failed(Some(13), 12, vec![ErrorCode::RecordHashMismatch]),
        "改 record_hash",
    ));
    cases.push(make_case(
        "field-18-flip-record-hash-tail",
        "field",
        "base_batch",
        vec![Op::FlipRecordHash { seq: 16, offset: 7 }],
        Verdict::failed(Some(16), 15, vec![ErrorCode::RecordHashMismatch]),
        "末条 record_hash 被改",
    ));
    cases.push(make_case(
        "field-19-bump-ts",
        "field",
        "base_batch",
        vec![Op::BumpTs { seq: 12 }],
        Verdict::failed(Some(12), 11, vec![ErrorCode::RecordHashMismatch]),
        "改逻辑刻度 ts（record_hash 覆盖它）",
    ));
    cases.push(make_case(
        "field-20-bump-ts-tail",
        "field",
        "base_batch",
        vec![Op::BumpTs { seq: 16 }],
        Verdict::failed(Some(16), 15, vec![ErrorCode::RecordHashMismatch]),
        "末条改 ts",
    ));

    // 2) 删记录（设计 §7.3 表：跳号 + 断链）
    for index in 0..12usize {
        cases.push(delete_case(
            &format!("delete-{:02}-index{index}", index + 1),
            index,
            Verdict::failed(Some(index as u64 + 1), 0, vec![ErrorCode::SeqGap]),
            "删掉一条记录：序号出现缺口，缺口号就是被删掉的那条 seq",
        ));
    }
    cases.push(delete_case(
        "delete-13-index14",
        14,
        Verdict::failed(Some(15), 0, vec![ErrorCode::SeqGap]),
        "删掉中后段的记录",
    ));
    cases.push(delete_case(
        "delete-14-last",
        15,
        Verdict::failed(None, base_total as usize - 1, vec![ErrorCode::BatchLeafSetMismatch]),
        "**删末条**：序号不再有缺口，链自身也自洽——只能靠「批量叶子集合 vs 链上结果记录」或链头比对发现（本例先命中批量叶子集合）",
    ));

    // 3) 重排（设计 §7.3 表：断链；本实现的指纹是 seq_conflict）
    for index in 0..12usize {
        cases.push(make_case(
            &format!("reorder-{:02}-swap{index}", index + 1),
            "reorder",
            "base_batch",
            vec![Op::SwapRecords { index }],
            Verdict::failed(Some(index as u64 + 2), 0, vec![ErrorCode::SeqConflict]),
            "交换相邻两条：序号集合仍是 1..n 但顺序错乱",
        ));
    }

    // 4) 插入
    for index in 0..12usize {
        cases.push(make_case(
            &format!("insert-{:02}-duplicate{index}", index + 1),
            "insert",
            "base_batch",
            vec![Op::DuplicateRecord { index }],
            Verdict::failed(Some(index as u64 + 1), 0, vec![ErrorCode::SeqConflict]),
            "复制一条插进链里：序号重复",
        ));
    }
    cases.push(make_case(
        "insert-13-polished-batch",
        "insert",
        "base_batch",
        vec![
            Op::AppendRecord {
                kind: RecordKind::Result,
                payload: json!({"case_id": "TK-9999", "verdict": "passed", "duration_ms": 1, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
                ts: 17,
            },
            Op::RecomputeChainHashes {},
        ],
        Verdict::failed(None, base_total as usize + 1, vec![ErrorCode::BatchLeafSetMismatch]),
        "**精修插入**：新记录的 prev_hash 与自身哈希都算对，链看起来连续，但批量签名覆盖的结果记录集合对不上了",
    ));
    cases.push(make_case(
        "insert-14-polished-resigned-batch",
        "insert",
        "base_batch",
        vec![
            Op::AppendRecord {
                kind: RecordKind::Result,
                payload: json!({"case_id": "TK-9998", "verdict": "passed", "duration_ms": 1, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
                ts: 17,
            },
            Op::RecomputeChainHashes {},
            Op::RecomputeBatches { resign: false },
            Op::RecomputeHead {},
        ],
        Verdict::failed(None, base_total as usize + 1, vec![ErrorCode::BatchSignatureInvalid]),
        "精修插入 + 重建批次但**没有重新签名**：批量签名对不上",
    ));
    cases.push(make_case(
        "insert-15-polished-resigned-report-stale",
        "insert",
        "base_batch",
        vec![
            Op::AppendRecord {
                kind: RecordKind::Result,
                payload: json!({"case_id": "TK-9997", "verdict": "passed", "duration_ms": 1, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
                ts: 17,
            },
            Op::RecomputeChainHashes {},
            Op::RecomputeBatches { resign: true },
            Op::RecomputeHead {},
            Op::RecomputeHeadSignature {},
        ],
        Verdict::failed(None, base_total as usize + 1, vec![ErrorCode::ChainHeadMismatch]),
        "**精修插入 + 全部重新签名**（有私钥的人能做到）：链自身完全自洽，但 run.json 里的链头没跟着改，两处一比就露",
    ));
    cases.push(make_case(
        "insert-16-polished-per-record",
        "insert",
        "base_per_record",
        vec![
            Op::AppendRecord {
                kind: RecordKind::Result,
                payload: json!({"case_id": "TK-9996", "verdict": "passed", "duration_ms": 1, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
                ts: 5,
            },
            Op::RecomputeChainHashes {},
            Op::RecomputeHead {},
        ],
        Verdict::failed(Some(5), 4, vec![ErrorCode::SignatureInvalid]),
        "逐条签名模式下的精修插入：新记录没有签名（缺签名按失败处理，不是跳过）",
    ));

    // 5) 改签名
    for (index, offset) in [0usize, 15, 31, 47, 63].iter().enumerate() {
        cases.push(make_case(
            &format!("signature-{:02}-batch-offset{offset}", index + 1),
            "signature",
            "base_batch",
            vec![Op::FlipBatchSig {
                batch: 0,
                offset: *offset,
            }],
            Verdict::failed(
                None,
                base_total as usize,
                vec![ErrorCode::BatchSignatureInvalid],
            ),
            "翻转批量签名的一个字节",
        ));
    }
    for (index, offset) in [0usize, 16, 32, 63].iter().enumerate() {
        cases.push(make_case(
            &format!("signature-{:02}-head-offset{offset}", index + 6),
            "signature",
            "base_batch",
            vec![Op::FlipHeadSig { offset: *offset }],
            Verdict::failed(
                None,
                base_total as usize,
                vec![ErrorCode::HeadSignatureInvalid],
            ),
            "翻转链头签名的一个字节",
        ));
    }
    for (index, (seq, offset)) in [(1u64, 0usize), (1, 63), (2, 31), (3, 0), (4, 17), (4, 63)]
        .iter()
        .enumerate()
    {
        cases.push(make_case(
            &format!("signature-{:02}-record{seq}-offset{offset}", index + 10),
            "signature",
            "base_per_record",
            vec![Op::FlipSig {
                seq: *seq,
                offset: *offset,
            }],
            Verdict::failed(
                Some(*seq),
                *seq as usize - 1,
                vec![ErrorCode::SignatureInvalid],
            ),
            "逐条签名模式：翻转结果记录的签名一个字节",
        ));
    }

    // 6) 额外机制（Merkle / 链头）
    cases.push(make_case(
        "extra-01-proof-step",
        "extras",
        "base_batch",
        vec![Op::FlipProof {
            batch: 0,
            seq: 6,
            step: 0,
            offset: 0,
        }],
        Verdict::failed(
            None,
            base_total as usize,
            vec![ErrorCode::MerkleProofInvalid],
        ),
        "翻转 inclusion proof 的一步",
    ));
    cases.push(make_case(
        "extra-02-proof-step-deep",
        "extras",
        "base_batch",
        vec![Op::FlipProof {
            batch: 0,
            seq: 14,
            step: 2,
            offset: 31,
        }],
        Verdict::failed(
            None,
            base_total as usize,
            vec![ErrorCode::MerkleProofInvalid],
        ),
        "翻转更深一层的 proof 步骤",
    ));
    cases.push(make_case(
        "extra-03-proof-dropped",
        "extras",
        "base_batch",
        vec![Op::DropProof { batch: 0, seq: 9 }],
        Verdict::failed(
            None,
            base_total as usize,
            vec![ErrorCode::MerkleProofMissing],
        ),
        "删掉某片叶的证明：缺证明是失败，不是跳过",
    ));
    cases.push(make_case(
        "extra-04-leaf-removed",
        "extras",
        "base_batch",
        vec![Op::RemoveLeaf { batch: 0, seq: 7 }],
        Verdict::failed(
            None,
            base_total as usize,
            vec![ErrorCode::BatchLeafSetMismatch],
        ),
        "把某条结果记录从批次的 leaves 里摘掉：漏签",
    ));
    cases.push(make_case(
        "extra-05-stale-head",
        "extras",
        "base_batch",
        vec![Op::StaleHeadChainHead {}],
        Verdict::failed(
            None,
            base_total as usize,
            vec![ErrorCode::ChainHeadMismatch],
        ),
        "只改链文件里的链头摘要",
    ));
    cases.push(make_case(
        "extra-06-noncanonical-payload",
        "extras",
        "base_batch",
        vec![
            Op::NoncanonicalPayload { seq: 6 },
            Op::RecomputeChainHashes {},
            Op::RecomputeBatches { resign: true },
            Op::RecomputeHead {},
            Op::RecomputeHeadSignature {},
        ],
        Verdict::failed(Some(6), 5, vec![ErrorCode::PayloadNotCanonical]),
        "载荷被写成「语义相同、形态不同」的字节（缩进），并把链重算重签成完全自洽——此时哈希与签名全都对得上，只有『载荷必须已经是 JCS 字节』这条前提校验能抓（设计 §7.2）",
    ));

    // 7) 边界：设计 §7.5 明确声明**检不出**的两类
    let boundary_cases = vec![
        CaseEntry {
            id: "boundary-01-rewrite-whole-chain".to_string(),
            class: "boundary".to_string(),
            base: "base_batch".to_string(),
            note: "**已知检不出**：有私钥者改一条载荷、重算全链哈希、重签批次与链头，并把报告与锚定一起改掉；此时所有签名自洽。设计 §7.5：哈希链是 tamper-evident，不是 tamper-proof。".to_string(),
            context: ContextSpec {
                expected_chain_head: Some("self".to_string()),
                anchor_head: Some("self".to_string()),
                ..ContextSpec::default()
            },
            ops: vec![
                Op::SetPayloadField {
                    seq: 3,
                    path: vec!["verdict".to_string()],
                    value: json!("passed"),
                },
                Op::RecomputeChainHashes {},
                Op::RecomputeBatches { resign: true },
                Op::RecomputeHead {},
                Op::RecomputeHeadSignature {},
            ],
            expected: Verdict {
                chain_ok: true,
                first_bad_seq: None,
                verified_records: base_total as usize,
                errors: Vec::new(),
            },
        },
        CaseEntry {
            id: "boundary-02-tail-insert-resigned".to_string(),
            class: "boundary".to_string(),
            base: "base_batch".to_string(),
            note: "**已知检不出**：精修插入 + 重签 + 报告与锚定同步改写。文档必须写清这条，否则就是过度承诺。".to_string(),
            context: ContextSpec {
                expected_chain_head: Some("self".to_string()),
                anchor_head: Some("self".to_string()),
                ..ContextSpec::default()
            },
            ops: vec![
                Op::AppendRecord {
                    kind: RecordKind::Result,
                    payload: json!({"case_id": "TK-9995", "verdict": "passed", "duration_ms": 1, "usage": {"model_calls": 0, "tokens": 0}, "tags": []}),
                    ts: 17,
                },
                Op::RecomputeChainHashes {},
                Op::RecomputeBatches { resign: true },
                Op::RecomputeHead {},
                Op::RecomputeHeadSignature {},
            ],
            expected: Verdict {
                chain_ok: true,
                first_bad_seq: None,
                verified_records: base_total as usize + 1,
                errors: Vec::new(),
            },
        },
    ];

    Corpus {
        version: 1,
        note: format!(
            "防篡改报告语料（设计 §7）。边界：{}。本文件由 examples/generate_corpus.rs 生成，tests/corpus_freshness.rs 会重算并与本文件比对（不一致即红）。",
            attest::boundary_statement()
        ),
        key: KeyInfo {
            derivation: "seed = SHA-256(utf8(label))；Ed25519 取该 32 字节种子".to_string(),
            label: TEST_KEY_LABEL.to_string(),
            public_key: key.public_key_hex(),
        },
        batch_size: 4096,
        bases: vec![
            BaseEntry {
                id: "base_batch".to_string(),
                mode: "batch".to_string(),
                chain: base_batch,
            },
            BaseEntry {
                id: "base_per_record".to_string(),
                mode: "per_record".to_string(),
                chain: base_per_record,
            },
        ],
        cases,
        boundary_cases,
    }
}

/// 序列化语料（两空格缩进 + 结尾换行）。
pub fn corpus_json_text(corpus: &Corpus) -> String {
    let mut text = serde_json::to_string_pretty(corpus).expect("语料必须可序列化");
    text.push('\n');
    text
}

/// 读入已落盘的语料。
pub fn load_corpus() -> Corpus {
    let path = corpus_path();
    let text = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "读不到语料 {}：{error}（先跑 examples/generate_corpus.rs）",
            path.display()
        )
    });
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("语料解析失败：{error}"))
}

/// 按 id 取用例。
pub fn case_by_id<'a>(corpus: &'a Corpus, id: &str) -> &'a CaseEntry {
    corpus
        .cases
        .iter()
        .chain(corpus.boundary_cases.iter())
        .find(|case| case.id == id)
        .unwrap_or_else(|| panic!("语料里没有用例 {id}"))
}

/// 取基准链。
pub fn base_by_id<'a>(corpus: &'a Corpus, id: &str) -> &'a attest::AttestedChain {
    &corpus
        .bases
        .iter()
        .find(|base| base.id == id)
        .unwrap_or_else(|| panic!("语料里没有基准链 {id}"))
        .chain
}

/// 把用例的外部见证解析成验证器输入。
///
/// 约定（跨语言一致，写在 `spec/vectors/README.md` 里）：
///
/// - 缺省（`null`）= **原始运行**的链头：`run.json` 与锚定目录都还是干净那一次的值；
/// - `"self"` = 用**被改后**的链自己的链头（模拟"报告与锚定一起被改写"）。
pub fn resolve_options(
    context: &ContextSpec,
    mutated: &attest::AttestedChain,
    original_head: Bytes32,
) -> VerifyOptions {
    let resolve = |value: &Option<String>| match value.as_deref() {
        None => Some(original_head),
        Some("self") => Some(mutated.head.chain_head),
        Some(hex) => Bytes32::from_hex(hex).ok(),
    };
    let expected_public_key = match context.expected_public_key.as_deref() {
        None => Some(mutated.public_key),
        Some("self") => Some(mutated.public_key),
        Some(hex) => Bytes32::from_hex(hex).ok(),
    };
    VerifyOptions {
        expected_chain_head: resolve(&context.expected_chain_head),
        anchor_declared: context.anchor_declared.unwrap_or(true),
        anchor_head: resolve(&context.anchor_head),
        expected_public_key,
        verify_proofs: context.verify_proofs.unwrap_or(true),
    }
}

/// 应用用例的注入并跑验证器。
pub fn evaluate_case(
    corpus: &Corpus,
    case: &CaseEntry,
) -> Result<(attest::AttestedChain, Verdict), String> {
    let base = base_by_id(corpus, &case.base);
    let original_head = base.head.chain_head;
    let mut chain = base.clone();
    apply_ops(&mut chain, &case.ops, &test_key())?;
    let options = resolve_options(&case.context, &chain, original_head);
    let verdict = verify::verify_chain(&chain, &options);
    Ok((chain, verdict))
}

/// 用例类别的标准顺序（报告与测试都按它遍历）。
pub const CLASSES: [&str; 6] = [
    "field",
    "delete",
    "reorder",
    "insert",
    "signature",
    "extras",
];

/// 语料的一行汇总（给测试打印）。
pub fn summarize_chain(chain: &attest::AttestedChain) -> attest::AttestationSummary {
    attest::AttestationSummary::from_chain(chain)
}

// --------------- 确定性伪随机 JSON（跨实现一致性用） ---------------

/// 生成 `count` 份随机 JSON 文档（**两侧必须生成完全相同的文本**）。
///
/// LCG 用整整 32 位的回绕，两侧都能精确算：Rust 的 `wrapping_mul/wrapping_add(u32)`，
/// JS 的 `Math.imul(...) >>> 0`（`Math.imul` 就是 32 位截断乘法）。
pub fn random_json_documents(count: usize) -> Vec<String> {
    let mut documents = Vec::with_capacity(count);
    for index in 0..count {
        let mut state = 0x9e37_79b9u32.wrapping_add((index as u32).wrapping_mul(2_654_435_761));
        documents.push(gen_value(&mut state, 0));
    }
    documents
}

/// 随机 JSON 值（返回**文本**，两侧逐字一致）。
pub fn gen_value(state: &mut u32, depth: usize) -> String {
    let roll = next(state) % 12;
    if depth >= 3 {
        return gen_scalar(state, roll);
    }
    match roll {
        0..=2 => gen_scalar(state, 0),
        3..=5 => gen_scalar(state, 1),
        6 => gen_scalar(state, 2),
        7 => gen_scalar(state, 3),
        8..=10 => {
            let count = (next(state) % 4) as usize;
            let mut items = Vec::with_capacity(count);
            for _ in 0..count {
                items.push(gen_value(state, depth + 1));
            }
            format!("[{}]", items.join(","))
        }
        _ => {
            let count = (next(state) % 4) as usize;
            let base = (next(state) % KEY_TOKENS.len() as u32) as usize;
            let mut pairs = Vec::with_capacity(count);
            for offset in 0..count {
                let key = KEY_TOKENS[(base + offset) % KEY_TOKENS.len()];
                let value = gen_value(state, depth + 1);
                pairs.push(format!("{key}:{value}"));
            }
            format!("{{{}}}", pairs.join(","))
        }
    }
}

fn gen_scalar(state: &mut u32, bucket: u32) -> String {
    match bucket {
        0 => {
            let index = (next(state) as usize) % NUM_TOKENS.len();
            NUM_TOKENS[index].to_string()
        }
        1 => {
            let index = (next(state) as usize) % STR_TOKENS.len();
            STR_TOKENS[index].to_string()
        }
        2 => {
            let index = (next(state) as usize) % 3;
            ["true", "false", "null"][index].to_string()
        }
        _ => {
            let index = (next(state) as usize) % 2;
            ["{}", "[]"][index].to_string()
        }
    }
}

fn next(state: &mut u32) -> u32 {
    *state = state.wrapping_mul(1_103_515_245).wrapping_add(12_345);
    *state
}

/// 随机文档里出现的数字文本（含 `1.0` / `1e2` / `-0` 这些形态）。
pub const NUM_TOKENS: [&str; 20] = [
    "0",
    "1",
    "-1",
    "1.0",
    "2.5",
    "1e2",
    "1E2",
    "1e-7",
    "1e-6",
    "1e21",
    "1e20",
    "0.0001",
    "123.456",
    "9007199254740993",
    "1000000000000000128",
    "-0",
    "0.0",
    "1.5e300",
    "5e-324",
    "3.141592653589793",
];

/// 随机文档里出现的字符串文本（已含引号与转义）。
pub const STR_TOKENS: [&str; 17] = [
    "\"a\"",
    "\"\"",
    "\"\\u00e9\"",
    "\"\u{e9}\"",
    "\"\\u0000\"",
    "\"\\u001f\"",
    "\"\\\\\"",
    "\"\\\"\"",
    "\"line\\nbreak\"",
    "\"tab\\there\"",
    "\"\\u007f\"",
    "\"\u{4e2d}\u{6587}\"",
    "\"\\ud83d\\ude00\"",
    "\"\u{1f600}\"",
    "\"\\u2028\"",
    "\"e\\u0301\"",
    "\"\\u0008\\u000c\\u000d\"",
];

/// 随机文档里出现的键文本（已含引号与转义）。
pub const KEY_TOKENS: [&str; 11] = [
    "\"a\"",
    "\"b\"",
    "\"z\"",
    "\"A\"",
    "\"\"",
    "\"\u{e9}\"",
    "\"\\u00e9\"",
    "\"\u{4e2d}\u{6587}\"",
    "\"aa\"",
    "\"a b\"",
    "\"\\u0000\"",
];
