//! 错误类型与**验证错误码**（判定结论的唯一词汇表）。
//!
//! `ErrorCode` 是 Rust 侧与 TS 侧验证器之间的跨语言契约：两侧对同一份链必须给出
//! **同一组错误码**。因此这里的字符串值（`snake_case`）是线上格式，不允许随手改名——
//! 改名等于让两侧的结论不可比对。

use std::fmt;

use serde::{Deserialize, Serialize};

use crate::hex::HexError;

/// JCS 规范化失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JcsError {
    /// JSON 解析失败。
    Parse(String),
    /// 出现 `NaN` / `Infinity`（RFC 8785 禁止）。
    NonFiniteNumber,
    /// 内部不变量被打破（例如浮点格式化返回了非预期形态）。
    Internal(&'static str),
}

impl fmt::Display for JcsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JcsError::Parse(reason) => write!(f, "JCS 输入不是合法 JSON：{reason}"),
            JcsError::NonFiniteNumber => write!(f, "JCS 不允许 NaN / Infinity"),
            JcsError::Internal(reason) => write!(f, "JCS 内部错误：{reason}"),
        }
    }
}

impl std::error::Error for JcsError {}

/// 密钥装载与使用失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    /// 环境变量既没有 `DSH_TESTKIT_ATTEST_KEY` 也没有 `DSH_TESTKIT_ATTEST_KEY_FILE`。
    MissingSource,
    /// 种子不是 32 字节。
    BadSeedLength(usize),
    /// 十六进制解码失败。
    Hex(HexError),
    /// 密钥文件读不到。
    Unreadable(String),
    /// 密钥文件位于一个 git 仓库内（会被提交，等于把私钥入库）。
    InsideRepository(String),
    /// 密钥文件权限过宽（仅 Unix 可判定）。
    PermissionsTooWide(String),
}

impl fmt::Display for KeyError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            KeyError::MissingSource => write!(
                f,
                "未设置 DSH_TESTKIT_ATTEST_KEY（hex 种子）或 DSH_TESTKIT_ATTEST_KEY_FILE（受保护的文件）"
            ),
            KeyError::BadSeedLength(len) => write!(f, "Ed25519 种子必须是 32 字节，实际 {len} 字节"),
            KeyError::Hex(error) => write!(f, "{error}"),
            KeyError::Unreadable(path) => write!(f, "密钥文件不可读：{path}"),
            KeyError::InsideRepository(path) => {
                write!(f, "密钥文件位于 git 仓库内（拒绝装载）：{path}")
            }
            KeyError::PermissionsTooWide(path) => {
                write!(f, "密钥文件权限过宽（应仅属主可读）：{path}")
            }
        }
    }
}

impl std::error::Error for KeyError {}

/// 锚定失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AnchorError {
    /// 锚定目录无法确定（缺环境变量且缺家目录）。
    NoDirectory,
    /// 锚定目录落在 git 仓库内——设计 §7.6 明确要求**必须在仓库之外**。
    DirectoryInsideRepository(String),
    /// 读回校验失败（写进去了但读不回来，或内容不一致）。
    ReadbackFailed(String),
    /// 外部锚定 provider 未实现（本期只留接口，见设计 §7.5 / §7.6）。
    ProviderNotImplemented(String),
    /// I/O 失败。
    Io(String),
}

impl fmt::Display for AnchorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AnchorError::NoDirectory => {
                write!(f, "无法确定锚定目录（缺 DSH_TESTKIT_ANCHOR_DIR 与家目录）")
            }
            AnchorError::DirectoryInsideRepository(path) => {
                write!(f, "锚定目录在 git 仓库内（拒绝写入）：{path}")
            }
            AnchorError::ReadbackFailed(reason) => write!(f, "锚定回读校验失败：{reason}"),
            AnchorError::ProviderNotImplemented(name) => {
                write!(f, "外部锚定 provider「{name}」本期未实现（设计 §7.5/§7.6）")
            }
            AnchorError::Io(reason) => write!(f, "锚定 I/O 失败：{reason}"),
        }
    }
}

impl std::error::Error for AnchorError {}

/// 本 crate 的统一错误类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AttestError {
    /// JCS 规范化失败。
    Jcs(JcsError),
    /// 十六进制解码失败。
    Hex(HexError),
    /// 密钥错误。
    Key(KeyError),
    /// 锚定错误。
    Anchor(AnchorError),
    /// 进度通知被拒绝入链（设计 §7.1：只记录结果 / 门控 / 能力变更 / 释放）。
    ProgressNotAdmitted,
    /// 批大小为 0。
    EmptyBatchSize,
    /// 记录序号溢出 `u64`。
    SequenceOverflow,
    /// 线格式反序列化失败。
    Wire(String),
    /// 签名或签名计数出现内部不一致。
    Internal(&'static str),
}

impl fmt::Display for AttestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AttestError::Jcs(error) => write!(f, "{error}"),
            AttestError::Hex(error) => write!(f, "{error}"),
            AttestError::Key(error) => write!(f, "{error}"),
            AttestError::Anchor(error) => write!(f, "{error}"),
            AttestError::ProgressNotAdmitted => {
                write!(f, "进度通知不入记录链、也不签名（设计 §7.1）")
            }
            AttestError::EmptyBatchSize => write!(f, "批大小不能为 0"),
            AttestError::SequenceOverflow => write!(f, "记录序号溢出"),
            AttestError::Wire(reason) => write!(f, "链文件格式错误：{reason}"),
            AttestError::Internal(reason) => write!(f, "内部错误：{reason}"),
        }
    }
}

impl std::error::Error for AttestError {}

impl From<JcsError> for AttestError {
    fn from(error: JcsError) -> Self {
        AttestError::Jcs(error)
    }
}

impl From<HexError> for AttestError {
    fn from(error: HexError) -> Self {
        AttestError::Hex(error)
    }
}

impl From<KeyError> for AttestError {
    fn from(error: KeyError) -> Self {
        AttestError::Key(error)
    }
}

impl From<AnchorError> for AttestError {
    fn from(error: AnchorError) -> Self {
        AttestError::Anchor(error)
    }
}

impl From<serde_json::Error> for AttestError {
    fn from(error: serde_json::Error) -> Self {
        AttestError::Wire(error.to_string())
    }
}

/// 验证错误码——**跨语言契约**，两侧必须一致。
///
/// 每一种码对应设计 §7.3 那张"能检出什么"表里的一种注入形态；`rewrite_whole_chain`
/// （重写整链并重新签名）**没有**对应的码，因为它在设计 §7.5 里被明确声明为**检不出**。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// 序号跳号（删记录的典型指纹）。
    SeqGap,
    /// 序号回退或重复（插入 / 重排的典型指纹）。
    SeqConflict,
    /// `prev_hash` 与上一条的 `record_hash` 不一致（断链）。
    PrevHashMismatch,
    /// `payload_hash` 与 `SHA-256(payload_jcs)` 不一致（改字段）。
    PayloadHashMismatch,
    /// `payload_jcs` **不是**该载荷的 JCS 规范化字节（语义相同但形态不同）。
    ///
    /// 设计 §7.2 把"同样的语义 ⇒ 同样的字节"当作签名的**前提**。既然是前提，验证器就该
    /// 检验它，而不是假设它：否则"把键序换一下、缩进换一下"就能造出一份哈希与签名
    /// 都自洽、却与规范化约定不符的链（两侧的 JCS 实现正是为此才都必须存在）。
    PayloadNotCanonical,
    /// `record_hash` 与按 §7.3 重算的结果不一致（改 `ts` / 改哈希字段）。
    RecordHashMismatch,
    /// 逐条 Ed25519 签名验证失败（改签名）。
    SignatureInvalid,
    /// Merkle inclusion proof 验证失败。
    MerkleProofInvalid,
    /// 结果记录缺少 inclusion proof。
    MerkleProofMissing,
    /// 批量签名的根与按 `leaves` 重算的根不一致。
    BatchRootMismatch,
    /// 批量 `leaves` 与链上结果记录的划分不一致（多签 / 漏签）。
    BatchLeafSetMismatch,
    /// 批量签名验证失败。
    BatchSignatureInvalid,
    /// 链头摘要（`chain_head` / 计数 / 末条 seq）与记录链重算结果不一致。
    ChainHeadMismatch,
    /// 链头签名验证失败。
    HeadSignatureInvalid,
    /// 签名所用公钥与预期公钥不一致。
    PublicKeyMismatch,
    /// 本次运行**声明**了本地锚定，但锚定目录里读不到对应记录。
    AnchorMissing,
    /// `run.json` 的链头与锚定目录的链头不一致（设计 §7.6 的核心检出项）。
    AnchorMismatch,
    /// 验证器配置本身不自洽（例如预期公钥长度不对）。
    VerifierMisconfigured,
}
