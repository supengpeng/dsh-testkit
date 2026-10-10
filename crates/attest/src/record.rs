//! 记录格式与哈希链（设计 §7.1 / §7.3）。
//!
//! ```text
//! Record {
//!   seq:         u64            // 从 1 起，连续，不允许跳号（跳号 = 删记录）
//!   prev_hash:   [u8; 32]       // 上一条的 record_hash；第 1 条为全零
//!   kind:        RecordKind     // 结果 / 门控 / 能力变更 / 释放（不含进度通知）
//!   payload_jcs: [u8]           // 载荷的 JCS 规范化字节
//!   payload_hash:[u8; 32]       // SHA-256(payload_jcs)
//!   ts:          i64            // 逻辑时钟刻度，不是挂钟时间
//!   sig:         [u8; 64]       // Ed25519 覆盖 (seq ‖ prev_hash ‖ kind ‖ payload_hash)
//! }
//! ```
//!
//! # 与设计稿的两处显式偏差（都写在这里，不藏进代码）
//!
//! 1. **线格式多一个 `record_hash` 字段。** 设计稿的 `Record` 只有上面八个字段，`record_hash`
//!    是导出量。但只有导出量的话，"改末条的 `ts`"就无人可比——下一条的 `prev_hash` 不存在，
//!    而 `chain_head` 只在报告里。所以线格式里**存**它，验证器**永远重算**它再做比较。
//! 2. **`sig` 允许为空。** 批量 Merkle 模式（§7.3.1）下记录不带逐条签名，由
//!    "批量签名 + inclusion proof"承担。空串是"该记录无独立签名"的线格式表示。
//!    `per_record` 模式（对照用，非生产路径）下每条结果记录都带 64 字节签名。

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AttestError;
use crate::hash::{sha256, sha256_parts};
use crate::jcs;
use crate::types::{hex_bytes, Bytes32};

/// 记录种类（设计 §7.1）。
///
/// [`RecordKind::Progress`] **不入链**：它的存在只是为了让"拒绝进度通知"成为一条
/// 可测试的显式行为，而不是一条只写在文档里的承诺。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    /// 结果记录（唯一会被签名的主体，指标 D4a 的分子）。
    Result,
    /// 门控记录（成本闸门裁决）。
    Gate,
    /// 能力变更记录。
    CapabilityChange,
    /// 资源释放记录。
    Release,
    /// 进度通知——**不入链、不签名**（设计 §7.1 明确排除）。
    Progress,
}

impl RecordKind {
    /// 单字节编码，进签名原像与记录哈希原像。
    pub const fn code(self) -> u8 {
        match self {
            RecordKind::Result => 1,
            RecordKind::Gate => 2,
            RecordKind::CapabilityChange => 3,
            RecordKind::Release => 4,
            RecordKind::Progress => 5,
        }
    }

    /// 是否允许进入记录链。
    pub const fn is_admitted(self) -> bool {
        !matches!(self, RecordKind::Progress)
    }

    /// 是否属于"结果类"（唯一需要签名的类别，设计 §7.1）。
    pub const fn is_signed(self) -> bool {
        matches!(self, RecordKind::Result)
    }

    /// 线格式名。
    pub const fn as_str(self) -> &'static str {
        match self {
            RecordKind::Result => "result",
            RecordKind::Gate => "gate",
            RecordKind::CapabilityChange => "capability_change",
            RecordKind::Release => "release",
            RecordKind::Progress => "progress",
        }
    }
}

/// 一条记录。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    /// 从 1 起的连续序号。
    pub seq: u64,
    /// 上一条的 `record_hash`；第 1 条为全零。
    pub prev_hash: Bytes32,
    /// 记录种类。
    pub kind: RecordKind,
    /// 载荷的 JCS 规范化字节（十六进制线格式）。
    #[serde(with = "hex_bytes")]
    pub payload_jcs: Vec<u8>,
    /// `SHA-256(payload_jcs)`。
    pub payload_hash: Bytes32,
    /// `SHA-256(seq ‖ prev_hash ‖ kind ‖ payload_hash ‖ ts)`（派生量，但存在线格式里供逐条核对）。
    pub record_hash: Bytes32,
    /// 逻辑时钟刻度（不是挂钟时间）。
    pub ts: i64,
    /// Ed25519 签名；批量模式下为空。
    #[serde(with = "hex_bytes")]
    pub sig: Vec<u8>,
}

impl Record {
    /// 计算 `payload_hash`。
    pub fn compute_payload_hash(payload_jcs: &[u8]) -> Bytes32 {
        sha256(payload_jcs)
    }

    /// 计算 §7.3 的 `record_hash` 原像：`seq ‖ prev_hash ‖ kind ‖ payload_hash ‖ ts`。
    ///
    /// `seq` 与 `ts` 用**大端**定长编码（8 字节），`kind` 1 字节——定长编码避免
    /// "`seq=1, kind=23`" 与 "`seq=12, kind=3`" 这类拼接歧义。
    pub fn record_hash_preimage(
        seq: u64,
        prev_hash: &Bytes32,
        kind: RecordKind,
        payload_hash: &Bytes32,
        ts: i64,
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + 32 + 1 + 32 + 8);
        out.extend_from_slice(&seq.to_be_bytes());
        out.extend_from_slice(prev_hash.as_bytes());
        out.push(kind.code());
        out.extend_from_slice(payload_hash.as_bytes());
        out.extend_from_slice(&ts.to_be_bytes());
        out
    }

    /// 计算 §7.1 的签名原像：`seq ‖ prev_hash ‖ kind ‖ payload_hash`。
    ///
    /// 注意**不含 `ts`**——设计稿就是这么写的。`ts` 仍被 `record_hash` 覆盖，而
    /// `record_hash` 被链头签名覆盖，所以 `ts` 没有被漏掉，只是不在逐条签名里。
    pub fn signing_preimage(
        seq: u64,
        prev_hash: &Bytes32,
        kind: RecordKind,
        payload_hash: &Bytes32,
    ) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + 32 + 1 + 32);
        out.extend_from_slice(&seq.to_be_bytes());
        out.extend_from_slice(prev_hash.as_bytes());
        out.push(kind.code());
        out.extend_from_slice(payload_hash.as_bytes());
        out
    }

    /// 本记录的签名原像。
    pub fn signing_preimage_of(&self) -> Vec<u8> {
        Record::signing_preimage(self.seq, &self.prev_hash, self.kind, &self.payload_hash)
    }

    /// 按 §7.3 重算本记录的 `record_hash`（**不信任**线格式里的那个字段）。
    pub fn recompute_record_hash(&self) -> Bytes32 {
        sha256_parts(&[&Record::record_hash_preimage(
            self.seq,
            &self.prev_hash,
            self.kind,
            &self.payload_hash,
            self.ts,
        )])
    }

    /// 记录是否带独立签名。
    pub fn has_signature(&self) -> bool {
        !self.sig.is_empty()
    }
}

/// 追加式记录链的构造器：负责 `seq` 连续、`prev_hash` 串接、载荷规范化。
///
/// 它**不接受**进度通知（[`RecordKind::Progress`]），这条拒绝是设计 §7.1
/// "只对结果类记录签名，不对进度通知签名"在 API 层的落地。
#[derive(Debug, Clone, Default)]
pub struct ChainBuilder {
    records: Vec<Record>,
    last_hash: Bytes32,
}

impl ChainBuilder {
    /// 新建空链。
    pub fn new() -> Self {
        ChainBuilder {
            records: Vec::new(),
            last_hash: Bytes32::zero(),
        }
    }

    /// 追加一条记录；`payload` 会被 JCS 规范化，`ts` 是调用方给的逻辑刻度。
    pub fn append(
        &mut self,
        kind: RecordKind,
        payload: &Value,
        ts: i64,
    ) -> Result<&Record, AttestError> {
        let payload_jcs = jcs::canonicalize_bytes(payload)?;
        self.append_jcs(kind, payload_jcs, ts)
    }

    /// 追加一条**已规范化**载荷的记录。
    pub fn append_jcs(
        &mut self,
        kind: RecordKind,
        payload_jcs: Vec<u8>,
        ts: i64,
    ) -> Result<&Record, AttestError> {
        if !kind.is_admitted() {
            return Err(AttestError::ProgressNotAdmitted);
        }
        let seq = self.records.len() as u64 + 1;
        let prev_hash = self.last_hash;
        let payload_hash = Record::compute_payload_hash(&payload_jcs);
        let record_hash = sha256_parts(&[&Record::record_hash_preimage(
            seq,
            &prev_hash,
            kind,
            &payload_hash,
            ts,
        )]);
        let record = Record {
            seq,
            prev_hash,
            kind,
            payload_jcs,
            payload_hash,
            record_hash,
            ts,
            sig: Vec::new(),
        };
        self.last_hash = record_hash;
        self.records.push(record);
        self.records
            .last()
            .ok_or(AttestError::Internal("追加后取不到记录"))
    }

    /// 已追加的记录。
    pub fn records(&self) -> &[Record] {
        &self.records
    }

    /// 取出记录（移动语义）。
    pub fn into_records(self) -> Vec<Record> {
        self.records
    }

    /// 当前链头（空链为 `None`）。
    pub fn chain_head(&self) -> Option<Bytes32> {
        self.records.last().map(|record| record.record_hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn chain_links_and_rejects_progress() {
        let mut builder = ChainBuilder::new();
        builder
            .append(RecordKind::Result, &json!({"a": 1}), 1)
            .unwrap();
        builder
            .append(RecordKind::Gate, &json!({"allowed": true}), 2)
            .unwrap();
        let records = builder.records();
        assert_eq!(records[0].prev_hash, Bytes32::zero());
        assert_eq!(records[1].prev_hash, records[0].record_hash);
        assert!(records
            .iter()
            .all(|r| r.recompute_record_hash() == r.record_hash));
        assert!(records.iter().all(|r| r.sig.is_empty()));

        let error = builder
            .append(RecordKind::Progress, &json!({"tick": 3}), 3)
            .unwrap_err();
        assert_eq!(error, AttestError::ProgressNotAdmitted);
        assert_eq!(builder.records().len(), 2);
    }

    #[test]
    fn signing_preimage_excludes_ts_but_record_hash_includes_it() {
        let mut builder = ChainBuilder::new();
        let record = builder
            .append(RecordKind::Result, &json!({"a": 1}), 1)
            .unwrap()
            .clone();
        let preimage = record.signing_preimage_of();
        assert_eq!(preimage.len(), 73);
        assert_eq!(&preimage[40..41], &[RecordKind::Result.code()]);
        let mut other = record.clone();
        other.ts = 99;
        assert_eq!(other.signing_preimage_of(), preimage);
        assert_ne!(other.recompute_record_hash(), record.record_hash);
    }
}
