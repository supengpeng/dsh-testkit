//! 握手与版本兼容（设计 §4.4）。
//!
//! 四步（设计 §4.4）：
//! 1. 客户端启动 Rust 进程后**第一帧必须是 `Handshake`**。
//! 2. 服务端验证：**主版本相同**，且**服务端次版本 ≥ 客户端次版本**。
//! 3. 服务端返回 `HandshakeAck`；此后才接受其它方法。
//! 4. **补**：握手前的任何其它帧一律回 `RpcError{code:-32001}` 并**关闭连接**
//!    ——不静默忽略（静默会让"协议不匹配"表现为"方法找不到"）。

use crate::error::RpcError;
use crate::message::{HandshakeAck, ProtocolHandshake, Version};

/// 本协议支持的主版本。
pub const PROTOCOL_MAJOR: u16 = 1;
/// 本协议支持的次版本。
pub const PROTOCOL_MINOR: u16 = 0;

/// 版本兼容判定（设计 §4.4 第 2 条）。
///
/// 规则：主版本必须相同，且服务端次版本 ≥ 客户端次版本。
/// 补丁版本**不参与**判定——它不改变线格式。
pub fn is_version_compatible(client: Version, server: Version) -> bool {
    client.major == server.major && server.minor >= client.minor
}

/// 本端版本。
pub fn local_version() -> Version {
    Version::new(PROTOCOL_MAJOR, PROTOCOL_MINOR, 0)
}

/// 握手状态机。
///
/// 只有两个状态，但它是**必需的**：没有它就表达不出"第一帧必须是握手"这条约束，
/// 而那正是"协议不匹配"与"方法找不到"能区分开的原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HandshakeState {
    /// 等待客户端握手（此时除 `Handshake` 外一律拒绝）。
    #[default]
    AwaitingHandshake,
    /// 已握手，可接受其它方法。
    Established,
}

/// 服务端握手处理结果。
#[derive(Debug, Clone, PartialEq)]
pub struct HandshakeOutcome {
    /// 应答。
    pub ack: HandshakeAck,
    /// 握手后的状态（成功时一定是 `Established`）。
    pub state: HandshakeState,
}

/// 处理客户端的 `Handshake`。
///
/// 失败返回 `RpcError`（版本不兼容），调用方应**回该错误并关闭连接**。
pub fn handle_handshake(hs: &ProtocolHandshake) -> Result<HandshakeOutcome, RpcError> {
    let server = local_version();
    if !is_version_compatible(hs.client_version, server) {
        return Err(RpcError::from_code(
            crate::error::RpcErrorCode::VersionMismatch,
            format!(
                "协议版本不兼容：客户端 {}.{}.{}，服务端 {}.{}.{}（要求主版本相同且服务端次版本 ≥ 客户端）",
                hs.client_version.major,
                hs.client_version.minor,
                hs.client_version.patch,
                server.major,
                server.minor,
                server.patch
            ),
        ));
    }

    Ok(HandshakeOutcome {
        ack: HandshakeAck {
            server_version: server,
            supported_major: PROTOCOL_MAJOR,
            supported_minor: PROTOCOL_MINOR,
            known_capabilities: Vec::new(),
        },
        state: HandshakeState::Established,
    })
}

/// 在某个状态下收到非握手帧时的处置（设计 §4.4 第 4 条补）。
///
/// 返回 `Some(err)` 表示"必须回错误并关闭连接"；`None` 表示可继续处理。
pub fn gate_before_handshake(state: HandshakeState, message_tag: &str) -> Option<RpcError> {
    match (state, message_tag) {
        (HandshakeState::AwaitingHandshake, "handshake") => None,
        (HandshakeState::AwaitingHandshake, _) => Some(RpcError::handshake_required()),
        (HandshakeState::Established, _) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_compat_follows_design_rule() {
        assert!(is_version_compatible(
            Version::new(1, 0, 0),
            Version::new(1, 0, 0)
        ));
        // 服务端次版本更新 → 兼容
        assert!(is_version_compatible(
            Version::new(1, 0, 0),
            Version::new(1, 3, 9)
        ));
        // 服务端次版本更旧 → 不兼容
        assert!(!is_version_compatible(
            Version::new(1, 3, 0),
            Version::new(1, 0, 0)
        ));
        // 主版本不同 → 不兼容
        assert!(!is_version_compatible(
            Version::new(1, 0, 0),
            Version::new(2, 0, 0)
        ));
        assert!(!is_version_compatible(
            Version::new(2, 0, 0),
            Version::new(1, 9, 0)
        ));
        // 补丁版本不参与判定
        assert!(is_version_compatible(
            Version::new(1, 0, 99),
            Version::new(1, 0, 0)
        ));
    }

    #[test]
    fn handshake_succeeds_for_local_version() {
        let out = handle_handshake(&ProtocolHandshake {
            client_version: local_version(),
            extensions: vec![],
        })
        .expect("本地版本必须兼容");
        assert_eq!(out.state, HandshakeState::Established);
        assert_eq!(out.ack.supported_major, PROTOCOL_MAJOR);
    }

    #[test]
    fn handshake_rejects_newer_minor_client() {
        // 客户端次版本更高 ⇒ 它可能用到服务端不认识的方法 ⇒ 拒绝。
        let err = handle_handshake(&ProtocolHandshake {
            client_version: Version::new(PROTOCOL_MAJOR, PROTOCOL_MINOR + 1, 0),
            extensions: vec![],
        })
        .expect_err("次版本更高的客户端必须被拒");
        assert_eq!(err.code, crate::error::RpcErrorCode::VersionMismatch.code());
    }

    #[test]
    fn first_frame_must_be_handshake() {
        // 握手前的任何其它帧 → 回 -32001 并关闭（不静默忽略）。
        let err = gate_before_handshake(HandshakeState::AwaitingHandshake, "submit")
            .expect("握手前 submit 必须被拒");
        assert_eq!(err.code, crate::error::RpcErrorCode::VersionMismatch.code());
        assert!(gate_before_handshake(HandshakeState::AwaitingHandshake, "handshake").is_none());
        assert!(gate_before_handshake(HandshakeState::Established, "submit").is_none());
    }

    #[test]
    fn unknown_extensions_are_ignored_not_rejected() {
        // 扩展必须是可选的：服务端不认识也不该失败（否则扩展机制无法演进）。
        assert!(handle_handshake(&ProtocolHandshake {
            client_version: local_version(),
            extensions: vec!["future-thing".into()],
        })
        .is_ok());
    }
}
