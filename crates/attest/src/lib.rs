//! `attest` —— 防篡改报告：JCS 规范化、SHA-256 哈希链、批量 Ed25519 Merkle 签名、本地锚定。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §7（全节）、`docs/REWRITE-METRICS.md` §5（D4a）/ §6（E1–E5）/
//! §10（I1）、RFC 0001 §8 Q2 与 Q4。
//!
//! # ⚠️ 一句话边界（任何超出这句话的表述都是过度承诺）
//!
//! **哈希链是 tamper-evident（可发现篡改），不是 tamper-proof（防篡改）。**
//! 持有私钥的人可以重写整条链、用同一个私钥重新签名，并同时改掉报告与锚定目录——
//! 那时所有签名都自洽，本机制**检不出**（设计 §7.5；这条边界在 `tests/tamper.rs` 里有一条
//! 反向用例：它必须**检不出**，那才是诚实的证据）。
//!
//! 本机制保证的是：**"篡改可被验证者发现"**，不保证"篡改不可能发生"。
//!
//! # 模块
//!
//! - [`jcs`] —— RFC 8785 规范化（向量驱动，见 `spec/vectors/jcs/`）
//! - [`record`] —— 记录格式与哈希链（设计 §7.1 / §7.3）
//! - [`merkle`] —— Merkle 树与 inclusion proof（设计 §7.3.1）
//! - [`chain`] —— 批量 Merkle 签名与链文件装配（D4a 的计数器在这里）
//! - [`signing`] —— 密钥装载、签名、签名次数上界（I1 的一部分）
//! - [`anchor`] —— 链头本地锚定与 `AnchorProvider`（设计 §7.6）
//! - [`verify`] —— Rust 侧独立验证器（与 `src/attest/verify.mjs` 结论必须一致）
//! - [`leak_scan`] —— "全量日志扫描"自检（I1：只报位置，不打印原文）
//!
//! # 本期**不做**（设计 §7.5，逐条照做）
//!
//! | 不做 | 理由 |
//! |---|---|
//! | 链头**外部**锚定（CI 日志 / TSA / 透明日志） | 依赖第三方，引入可用性与信任问题；TSA 要网络，破坏离线场景。**只定义 [`anchor::AnchorProvider`] 接口，一个外部 provider 都不实现** |
//! | 私钥放 HSM / 外部签名服务 | 需要额外基础设施；本期私钥从环境变量或受权限保护的文件读取，**不出进程**（I1 守它） |
//! | 声称"防篡改" | 见上面那条一句话边界 |
//!
//! # 依赖纪律
//!
//! 直接依赖只有四个：`serde`、`serde_json`、`sha2`、`ed25519-dalek`（RFC 0001 §7 停止线 5）。
//! 判定路径上**不使用** `HashMap` / `HashSet`（设计 §6.4），一律 `Vec` + 显式排序。
//! 本 crate **不含** `unsafe`（`#![forbid(unsafe_code)]`）。

#![forbid(unsafe_code)]
#![deny(missing_docs)]

pub mod anchor;
pub mod chain;
pub mod error;
pub mod hash;
pub mod hex;
pub mod jcs;
pub mod leak_scan;
pub mod merkle;
pub mod record;
pub mod signing;
pub mod types;
pub mod verify;

pub use anchor::{AnchorHead, AnchorOutcome, AnchorProvider, AnchorReceipt, LocalAnchor};
pub use chain::{
    AttestConfig, AttestedChain, Attestor, BatchSignature, ChainSummary, HeadSignature, LeafProof,
    SignatureMode, CHAIN_FORMAT, DEFAULT_BATCH_SIZE,
};
pub use error::{AnchorError, AttestError, ErrorCode, JcsError, KeyError};
pub use hash::{sha256, sha256_parts};
pub use hex::{decode as hex_decode, encode as hex_encode};
pub use jcs::{canonicalize, canonicalize_bytes, canonicalize_str, format_es_number};
pub use leak_scan::{scan_artifacts, scan_text, LeakHit, SensitiveNeedle};
pub use merkle::{InclusionProof, MerkleTree, ProofStep, Side};
pub use record::{ChainBuilder, Record, RecordKind};
pub use signing::{
    batch_preimage, head_preimage, signature_bound, KeyFileProtection, KeyMaterial, SignatureStats,
    ENV_KEY_FILE, ENV_KEY_HEX, VERIFIER_VERSION,
};
pub use types::Bytes32;
pub use verify::{verify_chain, verify_json, Verdict, VerifyOptions};

/// 一句话边界（供报告与文档直接引用，避免各处重写时走样）。
pub const TAMPER_EVIDENT_NOT_PROOF: &str = "哈希链是 tamper-evident（可发现篡改），\
不是 tamper-proof（防篡改）：持有私钥者可重写整条链并重新签名，链本身无法阻止";

/// 汇总读数（给阶段 1 报告用的一个结构，避免调用方各处拼凑）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct AttestationSummary {
    /// 链文件格式。
    pub format: String,
    /// 结果记录数（D4a 的 N）。
    pub result_records: u64,
    /// 记录总数。
    pub record_count: u64,
    /// 签名次数读数。
    pub stats: SignatureStats,
    /// 链头。
    pub chain_head: Bytes32,
}

impl AttestationSummary {
    /// 从一条签名链取汇总。
    pub fn from_chain(chain: &AttestedChain) -> Self {
        AttestationSummary {
            format: chain.format.clone(),
            result_records: chain.result_records() as u64,
            record_count: chain.records.len() as u64,
            stats: chain.stats,
            chain_head: chain.head.chain_head,
        }
    }
}

/// 一句话边界 + 本 crate 的边界声明（`cargo doc` 首页与测试都会用到）。
pub fn boundary_statement() -> &'static str {
    TAMPER_EVIDENT_NOT_PROOF
}

#[cfg(test)]
mod tests {
    #[test]
    fn boundary_statement_never_claims_tamper_proof() {
        let statement = crate::boundary_statement();
        assert!(statement.contains("tamper-evident"));
        assert!(statement.contains("不是 tamper-proof"));
        // 反向检查：不能出现"防篡改"这种过度承诺作为**能力**表述。
        assert!(!statement.contains("本机制防篡改"));
    }
}
