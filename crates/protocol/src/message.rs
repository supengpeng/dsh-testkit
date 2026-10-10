//! 协议消息集（设计 §4.2，闭合版）。
//!
//! 设计稿的协议**不闭合**有两处，这里逐条修掉：
//! (a) 握手消息 `ProtocolHandshake` 不在 `ProtocolMessage` 枚举里 → 已在枚举内；
//! (b) 方法表说 `submit` 返回 `TaskHandle`，交互序列却说返回 `TaskResult` → 见 [`crate::methods`]。
//!
//! 序列化纪律（设计 §3.1）：`#[serde(tag = "type")]` + `#[non_exhaustive]`。
//! **未知 tag 显式失败** —— 这样版本不匹配能被检出，而不是静默降级。

use crate::error::RpcError;
use crate::plan::ExecutionPlan;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 协议版本（握手交换用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct Version {
    /// 主版本。**必须相同**。
    pub major: u16,
    /// 次版本。**服务端 ≥ 客户端**。
    pub minor: u16,
    /// 补丁版本（不参与兼容判定）。
    pub patch: u16,
}

impl Version {
    /// 便捷构造。
    pub fn new(major: u16, minor: u16, patch: u16) -> Self {
        Self {
            major,
            minor,
            patch,
        }
    }
}

/// 握手（C→S 的第一帧，设计 §4.4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ProtocolHandshake {
    /// 客户端版本。
    pub client_version: Version,
    /// 客户端启用的扩展名（服务端不认识的一律忽略，**不报错**——扩展必须是可选的）。
    #[serde(default)]
    pub extensions: Vec<String>,
}

/// 握手应答（S→C）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct HandshakeAck {
    /// 服务端版本。
    pub server_version: Version,
    /// 服务端支持的主版本。
    pub supported_major: u16,
    /// 服务端支持的次版本。
    pub supported_minor: u16,
    /// 服务端已知的能力名（用于 TS 侧的早期校验，**不是**探测结果）。
    #[serde(default)]
    pub known_capabilities: Vec<String>,
}

/// 任务标识（UUID v7 承载，可按时间排序）。
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct TaskId(pub String);

/// 任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum TaskState {
    /// 已提交、尚未开始。
    Pending,
    /// 执行中。
    Running,
    /// 正常结束（含断言失败——断言失败不是调度器错误）。
    Finished,
    /// 已取消。
    Cancelled,
}

impl TaskState {
    /// 是否终态。`wait` 对终态立即返回；`cancel` 对终态返回 `Ok(())`（幂等）。
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Finished | Self::Cancelled)
    }
}

/// 任务句柄：`submit` 的返回。**可被多次 `wait`**（第二次起立即返回）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct TaskHandle {
    /// 任务 id。
    pub task_id: TaskId,
    /// 当前状态（提交那一刻的快照）。
    pub state: TaskState,
}

/// 任务结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum TaskOutcome {
    /// 全部断言通过。
    Passed,
    /// 有断言失败。
    Failed,
    /// 跳过（能力缺失等）。
    Skipped,
    /// 执行期错误（**工具/宿主坏了**，与"断言失败"不是一回事）。
    Errored,
    /// 判据不可判定（设计 §3.3 的第四态）。
    Inconclusive,
    /// 任务被取消（设计 §3.2 的 `cancel`）。
    ///
    /// 它是一个**结论**，不是调度器错误——与 `Errored` 分开的理由同"断言失败不走
    /// `Result::Err`"（设计 §3.1）：用 `Err` 表达"取消"会把"我们主动叫停"与
    /// "工具坏了"混在一起，而那正是设计 §1 要避免的误诊。
    Cancelled,
}

/// 任务结果（`wait` 的返回）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct TaskResult {
    /// 任务 id。
    pub task_id: TaskId,
    /// 结论。
    pub outcome: TaskOutcome,
    /// 墙钟耗时（毫秒）——**非确定字段**，对拍时归一化。u32 理由同 `WaitParams::timeout_ms`。
    pub duration_ms: u32,
    /// 可选取证细节（自由形状 JSON ⇒ TS 侧 `unknown`）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    #[ts(type = "unknown")]
    pub detail: Option<serde_json::Value>,
}

/// 状态查询结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct TaskStatus {
    /// 任务 id。
    pub task_id: TaskId,
    /// 当前状态。
    pub state: TaskState,
    /// 当前阶段描述（执行中才有）。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub phase: Option<String>,
}

/// `submit` 参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct SubmitParams {
    /// 由 TS 编译器生成的任务 id。
    pub task_id: TaskId,
    /// 执行计划。
    pub plan: ExecutionPlan,
}

/// `wait` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct WaitParams {
    /// 句柄。
    pub handle: TaskHandle,
    /// 超时（毫秒）；`0` 表示不等待、立即返回当前状态。
    ///
    /// u32 而非 u64：见 `plan.rs` 的同名注释——跨语言契约里的 u64 会变成 `bigint`，
    /// 而 bigint 不能被 `JSON.stringify` 序列化。
    pub timeout_ms: u32,
}

/// `cancel` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct CancelParams {
    /// 句柄。
    pub handle: TaskHandle,
}

/// `query` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct QueryParams {
    /// 句柄。
    pub handle: TaskHandle,
}

/// `register_assertion` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct RegisterAssertionParams {
    /// 断言词名。
    pub name: String,
}

/// `register_capability` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct RegisterCapabilityParams {
    /// 能力名（成员来自 `spec/contracts/capabilities.yaml`）。
    pub capability: String,
}

/// `refresh_capabilities` 参数（空体，保留扩展位）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct RefreshParams {
    /// 保留：将来可指定只刷新某几个能力。
    #[serde(default)]
    pub only: Vec<String>,
}

/// `shutdown` 参数。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ShutdownParams {
    /// 是否强制（在途任务被取消并按 §6.2 逆序释放）。
    pub force: bool,
}

/// 进度通知（S→C，多条）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ProgressNotification {
    /// 任务 id。
    pub task_id: TaskId,
    /// 阶段名。
    pub phase: String,
    /// 人类可读说明。
    pub message: String,
}

/// 能力变更通知（S→C）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct CapabilityChangedNotification {
    /// 能力名。
    pub capability: String,
    /// 新状态（`available` / `unavailable` / `unknown`）。
    pub state: String,
}

/// 追踪通知（S→C）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct TraceNotification {
    /// 任务 id。
    pub task_id: TaskId,
    /// 追踪载荷（自由形状 JSON ⇒ TS 侧 `unknown`）。
    #[ts(type = "unknown")]
    pub trace: serde_json::Value,
}

/// 成功应答参数（**设计 §4.2 的补缺**）。
///
/// 缺口是真的，而且是**照抄文档**造成的：设计 §4.2 的 14 个 tag 里，S→C 只有
/// `handshake_ack` / `progress` / `capability_changed` / `trace` / `rpc_error`——
/// **没有任何 result 变体**，而 §4.3 的方法表承诺 9 个方法有返回
/// （`submit→TaskHandle`、`wait→TaskResult`、`query→TaskStatus`、
/// `refresh_capabilities→CapabilityMap`）。按原文实现，服务端**物理上无法**
/// 回出一个句柄或结果——`frame::write_frame` 只接受 `ProtocolMessage`，把这一点变成了编译期事实。
///
/// 形状与 JSON-RPC 2.0 一致：应答不重复方法名，靠 `id` 配对。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ResultParams {
    /// 请求 id（与请求配对；单调递增由客户端负责）。
    pub id: u32,
    /// 结果载荷。
    ///
    /// **`None` 有确切含义**：`wait` 到点而任务**仍未终结**。设计没有定义这种情形，
    /// 而 `TaskResult` 里没有"还没好"态——所以用 JSON 的 `null` 表达"暂时无结果"，
    /// 而不是编造一个 `Cancelled` / `Skipped` 结论（那是伪造语义）。
    #[serde(default)]
    #[ts(type = "unknown")]
    pub result: Option<serde_json::Value>,
}

/// 协议消息集（设计 §4.2）。
///
/// **`#[non_exhaustive]` 不是装饰**：它让"未来新增一个 tag"不会破坏既有匹配，
/// 同时让**未知 tag 在反序列化时显式失败**（而不是静默降级成一个空消息）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum ProtocolMessage {
    /// 握手（C→S 第一帧）。
    Handshake(ProtocolHandshake),
    /// 握手应答（S→C）。
    HandshakeAck(HandshakeAck),
    /// 提交任务（C→S，只返回句柄）。
    Submit(SubmitParams),
    /// 取消任务（C→S，幂等）。
    Cancel(CancelParams),
    /// 等待结果（C→S，**新增方法**；没有它就无法表达"先提交 N 个再一起等"）。
    Wait(WaitParams),
    /// 查询状态（C→S，幂等）。
    Query(QueryParams),
    /// 注册断言词（C→S，重名报错）。
    RegisterAssertion(RegisterAssertionParams),
    /// 注册能力探测器（C→S，重名报错）。
    RegisterCapability(RegisterCapabilityParams),
    /// 刷新能力（C→S，原子替换）。
    RefreshCapabilities(RefreshParams),
    /// 关闭（C→S，可重复）。
    Shutdown(ShutdownParams),
    /// 进度通知（S→C）。
    Progress(ProgressNotification),
    /// 能力变更通知（S→C）。
    CapabilityChanged(CapabilityChangedNotification),
    /// 追踪通知（S→C）。
    Trace(TraceNotification),
    /// **成功应答（S→C）** —— 设计 §4.2 的补缺，见 [`ResultParams`]。
    Result(ResultParams),
    /// 错误应答。
    RpcError(RpcError),
}

impl ProtocolMessage {
    /// 消息的 tag 名（与 serde 的 `rename_all = "snake_case"` 一致）。
    ///
    /// 存在的理由：契约守卫（H3）要能枚举 tag 集合并与 TS 侧比对，
    /// 不依赖"跑一次序列化看输出"。
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Handshake(_) => "handshake",
            Self::HandshakeAck(_) => "handshake_ack",
            Self::Submit(_) => "submit",
            Self::Cancel(_) => "cancel",
            Self::Wait(_) => "wait",
            Self::Query(_) => "query",
            Self::RegisterAssertion(_) => "register_assertion",
            Self::RegisterCapability(_) => "register_capability",
            Self::RefreshCapabilities(_) => "refresh_capabilities",
            Self::Shutdown(_) => "shutdown",
            Self::Progress(_) => "progress",
            Self::CapabilityChanged(_) => "capability_changed",
            Self::Trace(_) => "trace",
            Self::Result(_) => "result",
            Self::RpcError(_) => "rpc_error",
        }
    }

    /// 全部 tag（用于契约守卫与文档；顺序与枚举声明一致）。
    pub fn all_tags() -> &'static [&'static str] {
        &[
            "handshake",
            "handshake_ack",
            "submit",
            "cancel",
            "wait",
            "query",
            "register_assertion",
            "register_capability",
            "refresh_capabilities",
            "shutdown",
            "progress",
            "capability_changed",
            "trace",
            "result",
            "rpc_error",
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::{ConfidenceLevel, ExecutionPlan, Layer, ScenarioMetadata, ToolNode};

    fn plan() -> ExecutionPlan {
        ExecutionPlan {
            nodes: vec![ToolNode {
                node_id: "n1".into(),
                tool_kind: "call-tool".into(),
                input: serde_json::json!({"tool": "testkit_list"}),
                gate: None,
                retry: None,
                timeout_ms: None,
                min_confidence: None,
            }],
            edges: vec![],
            metadata: ScenarioMetadata {
                scenario_id: "TK-0001".into(),
                title: "t".into(),
                layer: Layer::L3,
                confidence: ConfidenceLevel::Real,
                shared_context: false,
                depth: 1,
                seed: None,
            },
            resources: vec![],
        }
    }

    #[test]
    fn message_is_internally_tagged_with_snake_case() {
        let msg = ProtocolMessage::Submit(SubmitParams {
            task_id: TaskId("t1".into()),
            plan: plan(),
        });
        let v: serde_json::Value = serde_json::to_value(&msg).expect("serialize");
        assert_eq!(v["type"], "submit");
        assert_eq!(v["task_id"], "t1");
    }

    #[test]
    fn unknown_tag_fails_loudly_rather_than_degrading() {
        // 设计 §3.1：未知 tag 显式失败 → 版本不匹配能被检出，而不是静默降级。
        let raw = r#"{"type":"this_tag_does_not_exist","x":1}"#;
        let err = serde_json::from_str::<ProtocolMessage>(raw);
        assert!(err.is_err(), "未知 tag 必须反序列化失败，实际：{err:?}");
    }

    #[test]
    fn handshake_is_inside_the_message_enum() {
        // 设计 §4.2 的修正 (a)：握手必须在枚举内，否则"第一帧"是未定义类型。
        let msg = ProtocolMessage::Handshake(ProtocolHandshake {
            client_version: Version::new(1, 0, 0),
            extensions: vec!["jcs-v1".into()],
        });
        assert_eq!(msg.tag(), "handshake");
        let back: ProtocolMessage =
            serde_json::from_str(&serde_json::to_string(&msg).unwrap()).unwrap();
        assert_eq!(msg, back);
    }

    #[test]
    fn all_tags_are_unique_and_match_tag_method() {
        let tags = ProtocolMessage::all_tags();
        let mut sorted = tags.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), tags.len(), "tag 有重复");
        assert_eq!(
            tags.len(),
            15,
            "消息集数量变化时必须显式更新契约守卫（14 → 15：补上缺失的 result 应答）"
        );
    }

    #[test]
    fn task_state_terminality() {
        assert!(TaskState::Finished.is_terminal());
        assert!(TaskState::Cancelled.is_terminal());
        assert!(!TaskState::Pending.is_terminal());
        assert!(!TaskState::Running.is_terminal());
    }

    #[test]
    fn handle_is_reusable_and_serializable() {
        // 句柄可被多次 wait：它是纯数据，不带"一次性"语义。
        let h = TaskHandle {
            task_id: TaskId("t1".into()),
            state: TaskState::Running,
        };
        let json = serde_json::to_string(&h).unwrap();
        assert!(json.contains("\"running\""));
    }
}
