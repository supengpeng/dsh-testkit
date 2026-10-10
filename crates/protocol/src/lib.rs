//! `protocol` —— TS 编译器与 Rust 核心之间的跨语言契约层。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §4（通信协议，闭合版）与 §5.4（`ExecutionPlan`）；
//! RFC 0001 决定 7。
//!
//! **边界纪律（设计 §1.1）**：本 crate 只承载跨语言契约。
//! 它不认识 `kind` 的业务含义（那是 TS 侧的），也不持有任何判定（那是 `assertion` 的）。
//! 两侧都不直接读对方的内部类型——跨语言契约只经由这里（`ts-rs` 生成 TS 类型到
//! `types/generated/`，**禁止手改**，指标 H3 用 `git diff` 守它）。
//!
//! # 模块
//!
//! - [`error`] —— JSON-RPC 错误码与**错误码→退出码**的裁决表（唯一真源）
//! - [`plan`] —— `ExecutionPlan`（TS 编译器产出、Rust 核心消费）
//! - [`message`] —— `ProtocolMessage` 消息集（含握手，修掉了设计稿的闭合漏洞）
//! - [`handshake`] —— 握手状态机与版本兼容规则
//! - [`frame`] —— NDJSON 帧读写
//! - [`methods`] —— 方法表（`submit` 只返回句柄；`wait` 是新增的必要方法）

pub mod error;
pub mod frame;
pub mod handshake;
pub mod message;
pub mod methods;
pub mod plan;

pub use error::{RpcError, RpcErrorCode, StandardRpcError};
pub use frame::{read_frame, write_frame, FrameError, MAX_FRAME_BYTES};
pub use handshake::{
    gate_before_handshake, handle_handshake, is_version_compatible, local_version,
    HandshakeOutcome, HandshakeState, PROTOCOL_MAJOR, PROTOCOL_MINOR,
};
pub use message::{
    CancelParams, CapabilityChangedNotification, HandshakeAck, ProgressNotification,
    ProtocolHandshake, ProtocolMessage, QueryParams, RefreshParams, RegisterAssertionParams,
    RegisterCapabilityParams, ShutdownParams, SubmitParams, TaskHandle, TaskId, TaskOutcome,
    TaskResult, TaskState, TaskStatus, TraceNotification, Version, WaitParams,
};
pub use methods::{method_specs, MethodDirection, MethodSpec, METHODS};
pub use plan::{
    ConfidenceLevel, Edge, ExecutionPlan, GateSpec, Layer, OnMissing, ResourceClaim, RetryOn,
    RetrySpec, ScenarioMetadata, ToolNode,
};
