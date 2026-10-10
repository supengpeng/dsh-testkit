//! JSON-RPC 错误与错误码（设计 §4.5）。
//!
//! **这个表是唯一真源。** 设计稿曾让四处互相打架（`onUnsupported` / `missingCapability` /
//! 新增退出码 7），本节给出的裁决表是唯一能验收的一版：版本不兼容归 `6`（协议），
//! "必需能力缺失"归 `7`，其余各归其位。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// JSON-RPC 标准错误码（协议层自带）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum StandardRpcError {
    /// `-32700` 解析失败。
    Parse,
    /// `-32600` 无效请求。
    InvalidRequest,
    /// `-32601` 方法不存在。
    MethodNotFound,
    /// `-32602` 参数无效。
    InvalidParams,
    /// `-32603` 内部错误。
    Internal,
}

impl StandardRpcError {
    /// JSON-RPC 数值码。
    pub fn code(self) -> i32 {
        match self {
            Self::Parse => -32700,
            Self::InvalidRequest => -32600,
            Self::MethodNotFound => -32601,
            Self::InvalidParams => -32602,
            Self::Internal => -32603,
        }
    }
}

/// 本协议的自定义错误码（设计 §4.5），每个都绑定一个**退出码**。
///
/// 退出码语义沿用 `src/cli/exit.ts` 的冻结值 `0/1/2/3`，新语义用 `6/7/8`（RFC 决定 3）。
/// `4/5` **保留不使用**——它们已是同名第三方包的发布语义，
/// **同名不同义是最贵的坑**：当 CI 只能依赖退出码时，一个数字的歧义会跨项目传播。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum RpcErrorCode {
    /// 版本不兼容（握手失败）→ 退出码 `6`。
    VersionMismatch,
    /// 能力不可用 → 退出码 `0`（skip）或 `7`（必需能力缺失）。
    CapabilityUnavailable,
    /// 任务已存在 → 退出码 `2`（用法错误）。
    TaskExists,
    /// 任务不存在 → 退出码 `2`（用法错误）。
    TaskNotExists,
    /// 执行超时 → 退出码 `1`（被测对象失败）。
    ExecutionTimeout,
    /// 需要审批 → 退出码 `0`（skip + 理由）。
    ///
    /// **刻意不映射到 `5`**：`5` 在本仓是保留号，而"需要审批"在本仓的语义是
    /// "未获放权 → 如实 skip"（沿用 `--allow-model` 纪律）。
    ApprovalRequired,
    /// **注册名已存在** → 退出码 `2`（用法错误）。
    ///
    /// 设计 §4.5 的表原本没有这一格，而 `crates/assertion` 与 `crates/capability`
    /// **都已经返回** `AlreadyRegistered`（`register` 的重入必须报错、不静默覆盖）。
    /// 协议层此前只能拿 `-32602 InvalidParams` 或 `-32003 TaskExists` 去表达它——
    /// 两者都语义不符：重名**不是**参数格式错，更**不是**"任务已存在"。
    /// **一端有明确的语义、另一端没有对应的码，那就是契约缺一格**（由 `rust-scheduler`
    /// 在实现 TS 客户端时发现并交回裁决）。
    AlreadyRegistered,
}

impl RpcErrorCode {
    /// JSON-RPC 数值码。
    pub fn code(self) -> i32 {
        match self {
            Self::VersionMismatch => -32001,
            Self::CapabilityUnavailable => -32002,
            Self::TaskExists => -32003,
            Self::TaskNotExists => -32004,
            Self::ExecutionTimeout => -32005,
            Self::ApprovalRequired => -32006,
            Self::AlreadyRegistered => -32007,
        }
    }

    /// 映射到进程退出码（设计 §4.5 的裁决表）。
    ///
    /// 注意 `CapabilityUnavailable` 是 **二义**的：必需能力缺失走 `7`、否则走 `0`（skip）。
    /// 所以它在这里返回 `Option`，由门控决策（`crates/capability`）给出最终值。
    pub fn exit_code(self) -> Option<i32> {
        match self {
            Self::VersionMismatch => Some(6),
            Self::CapabilityUnavailable => None, // 0 或 7，取决于是否 mandatory
            Self::TaskExists | Self::TaskNotExists | Self::AlreadyRegistered => Some(2),
            Self::ExecutionTimeout => Some(1),
            Self::ApprovalRequired => Some(0),
        }
    }
}

/// 协议错误载荷（`RpcError` 消息体）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct RpcError {
    /// 数值错误码（标准或自定义）。
    pub code: i32,
    /// 人类可读说明。
    pub message: String,
    /// 可选取证数据。**不得**承载私钥/凭据（指标 I1）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    /// 自由形状 JSON ⇒ TS 侧 `unknown`（并回避 ts-rs 为 `serde_json::Value`
    /// 生成的默认-bindings 目录 import，那会打破 `tsc` 的 `rootDir`）。
    #[ts(type = "unknown")]
    pub data: Option<serde_json::Value>,
    /// 关联的请求 id（应答配对用）。
    ///
    /// **可选**：不是每个错误都对应一个请求——例如握手前收到的非法首帧
    /// （`-32001`）就没有 id 可回。强行要求有 id 会逼出一个假值。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub id: Option<u32>,
}

impl RpcError {
    /// 由自定义码构造。
    pub fn from_code(code: RpcErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.code(),
            message: message.into(),
            data: None,
            id: None,
        }
    }

    /// 由标准码构造。
    pub fn from_standard(code: StandardRpcError, message: impl Into<String>) -> Self {
        Self {
            code: code.code(),
            message: message.into(),
            data: None,
            id: None,
        }
    }

    /// 握手前收到其它帧时的固定应答（设计 §4.4 第 4 条补）。
    ///
    /// **不静默忽略**：静默会让"协议不匹配"表现为"方法找不到"，
    /// 从而把一个版本问题误诊为一个实现漏洞。
    pub fn handshake_required() -> Self {
        Self {
            code: RpcErrorCode::VersionMismatch.code(),
            message: "握手前不接受其它方法：第一帧必须是 Handshake".into(),
            data: None,
            id: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn custom_codes_match_design_table() {
        // 设计 §4.5 的六个数逐个钉住：改它们等于改协议。
        assert_eq!(RpcErrorCode::VersionMismatch.code(), -32001);
        assert_eq!(RpcErrorCode::CapabilityUnavailable.code(), -32002);
        assert_eq!(RpcErrorCode::TaskExists.code(), -32003);
        assert_eq!(RpcErrorCode::TaskNotExists.code(), -32004);
        assert_eq!(RpcErrorCode::ExecutionTimeout.code(), -32005);
        assert_eq!(RpcErrorCode::ApprovalRequired.code(), -32006);
        // 1.0.0 新增：注册名已存在（`register_assertion` / `register_capability` 的重入）。
        // 它此前只能借 `-32602`（参数格式错）或 `-32003`（任务已存在）表达，两者都语义不符。
        assert_eq!(RpcErrorCode::AlreadyRegistered.code(), -32007);
    }

    #[test]
    fn standard_codes_match_jsonrpc_spec() {
        assert_eq!(StandardRpcError::Parse.code(), -32700);
        assert_eq!(StandardRpcError::InvalidRequest.code(), -32600);
        assert_eq!(StandardRpcError::MethodNotFound.code(), -32601);
        assert_eq!(StandardRpcError::InvalidParams.code(), -32602);
        assert_eq!(StandardRpcError::Internal.code(), -32603);
    }

    #[test]
    fn exit_code_mapping_has_exactly_one_ambiguous_entry() {
        // 只有"能力不可用"是二义的（0 或 7），其余必须唯一。
        // 这条断言防的是"有人给某个码偷偷加第二个退出码"。
        let ambiguous = [
            RpcErrorCode::VersionMismatch,
            RpcErrorCode::CapabilityUnavailable,
            RpcErrorCode::TaskExists,
            RpcErrorCode::TaskNotExists,
            RpcErrorCode::ExecutionTimeout,
            RpcErrorCode::ApprovalRequired,
        ]
        .into_iter()
        .filter(|c| c.exit_code().is_none())
        .collect::<Vec<_>>();
        assert_eq!(ambiguous, vec![RpcErrorCode::CapabilityUnavailable]);
    }

    #[test]
    fn approval_required_is_skip_not_reserved_5() {
        // 设计 §4.5 的刻意选择：需要审批 → 0（skip），不是保留号 5。
        assert_eq!(RpcErrorCode::ApprovalRequired.exit_code(), Some(0));
        assert_eq!(RpcErrorCode::AlreadyRegistered.exit_code(), Some(2));
    }

    #[test]
    fn handshake_required_uses_version_mismatch_code() {
        assert_eq!(
            RpcError::handshake_required().code,
            RpcErrorCode::VersionMismatch.code()
        );
    }
}
