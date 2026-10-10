//! 方法表（设计 §4.3，修正版）。
//!
//! 设计稿的方法表有两处不闭合，这里逐条修掉：
//!
//! 1. **`submit` 只返回 `TaskHandle`，不返回 `TaskResult`**。
//!    原稿的交互序列让 `submit` 直接返回结果——那等于把"提交"和"等待"绑死，
//!    无法表达"先提交 N 个任务再一起等"。
//! 2. **`wait` 是新增的必需方法**。没有它，这套设计表达不出并发。
//!
//! 本表是**声明**，不是实现：它存在的价值是让"协议里到底有哪几个方法"
//! 成为一个可枚举、可比对（阶段 2 与 TS 侧客户端对拍）的集合。

/// 方法方向。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MethodDirection {
    /// 客户端 → 服务端（请求）。
    ClientToServer,
    /// 服务端 → 客户端（通知）。
    ServerToClient,
}

/// 一个方法的声明。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MethodSpec {
    /// 方法名（JSON-RPC 的 `method` 字段）。
    pub name: &'static str,
    /// 方向。
    pub direction: MethodDirection,
    /// 参数类型名（与 [`crate::message`] 的 struct 对应）。
    pub params: &'static str,
    /// 返回类型名（`()` 表示空返回）。
    pub returns: &'static str,
    /// 是否幂等。
    ///
    /// **幂等的定义**：重复调用与调用一次的可观察效果相同。
    /// `register_*` **不幂等**——重名必须报错，而不是静默覆盖
    /// （静默覆盖会让"我注册的断言词被谁改掉了"变成一个无法回答的问题）。
    pub idempotent: bool,
}

/// 方法表（设计 §4.3 的九行）。
pub const METHODS: &[MethodSpec] = &[
    MethodSpec {
        name: "handshake",
        direction: MethodDirection::ClientToServer,
        params: "ProtocolHandshake",
        returns: "HandshakeAck",
        idempotent: true,
    },
    MethodSpec {
        name: "submit",
        direction: MethodDirection::ClientToServer,
        params: "SubmitParams",
        // ⚠️ 是 TaskHandle 而不是 TaskResult——原稿在这里与自己的交互序列矛盾。
        returns: "TaskHandle",
        idempotent: false,
    },
    MethodSpec {
        name: "wait",
        direction: MethodDirection::ClientToServer,
        params: "WaitParams",
        returns: "TaskResult",
        idempotent: true,
    },
    MethodSpec {
        name: "cancel",
        direction: MethodDirection::ClientToServer,
        params: "CancelParams",
        returns: "()",
        idempotent: true,
    },
    MethodSpec {
        name: "query",
        direction: MethodDirection::ClientToServer,
        params: "QueryParams",
        returns: "TaskStatus",
        idempotent: true,
    },
    MethodSpec {
        name: "register_assertion",
        direction: MethodDirection::ClientToServer,
        params: "RegisterAssertionParams",
        returns: "()",
        // 重名报错 ⇒ 不幂等。
        idempotent: false,
    },
    MethodSpec {
        name: "register_capability",
        direction: MethodDirection::ClientToServer,
        params: "RegisterCapabilityParams",
        returns: "()",
        idempotent: false,
    },
    MethodSpec {
        name: "refresh_capabilities",
        direction: MethodDirection::ClientToServer,
        params: "RefreshParams",
        returns: "CapabilityMap",
        idempotent: true,
    },
    MethodSpec {
        name: "shutdown",
        direction: MethodDirection::ClientToServer,
        params: "ShutdownParams",
        returns: "()",
        idempotent: true,
    },
];

/// 方法表（只读视图）。
pub fn method_specs() -> &'static [MethodSpec] {
    METHODS
}

/// 按名字查方法声明。
pub fn method_spec(name: &str) -> Option<&'static MethodSpec> {
    METHODS.iter().find(|m| m.name == name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn method_table_has_nine_methods_matching_design() {
        assert_eq!(METHODS.len(), 9, "设计 §4.3 的方法表是九行");
        let names: BTreeSet<&str> = METHODS.iter().map(|m| m.name).collect();
        for expected in [
            "handshake",
            "submit",
            "wait",
            "cancel",
            "query",
            "register_assertion",
            "register_capability",
            "refresh_capabilities",
            "shutdown",
        ] {
            assert!(names.contains(expected), "缺方法 {expected}");
        }
    }

    #[test]
    fn submit_returns_handle_not_result() {
        // 这条断言防的是"有人把 submit 改回同步返回结果"——那会破坏并发表达能力。
        let spec = method_spec("submit").expect("submit 必须在表里");
        assert_eq!(spec.returns, "TaskHandle");
    }

    #[test]
    fn wait_exists_and_is_idempotent() {
        let spec = method_spec("wait").expect("wait 是新增的必要方法");
        assert!(spec.idempotent);
        assert_eq!(spec.returns, "TaskResult");
    }

    #[test]
    fn register_methods_are_not_idempotent() {
        // 重名必须报错，不静默覆盖。
        assert!(!method_spec("register_assertion").unwrap().idempotent);
        assert!(!method_spec("register_capability").unwrap().idempotent);
    }

    #[test]
    fn all_methods_are_client_to_server_in_this_table() {
        // 服务端 → 客户端的三条走的是**通知**（ProtocolMessage 的 Progress /
        // CapabilityChanged / Trace），不是方法表里的请求。把它们混进请求表
        // 会让"哪些调用会有应答"变得不可判定。
        for m in METHODS {
            assert_eq!(
                m.direction,
                MethodDirection::ClientToServer,
                "方法 {} 不该是反向的",
                m.name
            );
        }
    }

    #[test]
    fn method_names_have_no_duplicates() {
        let names: BTreeSet<&str> = METHODS.iter().map(|m| m.name).collect();
        assert_eq!(names.len(), METHODS.len());
    }
}
