//! `ExecutionPlan` —— TS 编译器产出、Rust 核心消费的**跨语言**执行计划（设计 §5.4）。
//!
//! 为什么它定义在 `protocol` 而不是 `executor`：它是**跨语言的契约**（设计 §1.1：
//! "两侧都不直接读对方的内部类型：跨语言契约只经由从 Rust 生成的类型"）。
//! `executor` 依赖它，反过来不行。
//!
//! **直接写 `ExecutionPlan` JSON 的入口**：设计 §5.4 允许，但必须标 `unsafe`，
//! 且产出的结果可信度降为 [`ConfidenceLevel::Static`]——它绕过了第 1、2 层防御
//! （TS 类型系统与编译器 `validate`），不能与正常路径的结果同等采信。

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// 可信度四态（设计 §8.1）。
///
/// **`Inconclusive` 是断言结果，不是可信度**——一条 `Real` 可信度的场景
/// 可以有 `Inconclusive` 的断言。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum ConfidenceLevel {
    /// 真实宿主 + 真实能力。**唯一**可用于发布门槛的态。
    Real,
    /// 模拟宿主或模拟能力。
    Simulated,
    /// 真实宿主但部分能力降级（fallback 路径）。
    Degraded,
    /// 未执行：静态推断，或直接写 plan 的 `unsafe` 入口。
    Static,
}

impl ConfidenceLevel {
    /// 是否可进入发布门槛判定（设计 §8.4 硬约束 1）。
    pub fn accepted_for_release(self) -> bool {
        matches!(self, Self::Real)
    }
}

/// 测试分层（设计 §8.2 的 L0–L6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum Layer {
    /// L0 单元逻辑（本工具**不参与**，仅可选聚合）。
    L0,
    /// L1 契约测试（Mock / Mock）。
    L1,
    /// L2 集成（模拟宿主）。
    L2,
    /// L3 集成（真实宿主）—— 既有 `cases/` 所在的层。
    L3,
    /// L4 组合测试。
    L4,
    /// L5 端到端。
    L5,
    /// L6 回归 / 性能 / 安全（周期性）。
    L6,
}

/// 执行计划（设计 §5.4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ExecutionPlan {
    /// 工具节点（拓扑排序后的执行单元）。
    pub nodes: Vec<ToolNode>,
    /// 节点间的依赖边。
    pub edges: Vec<Edge>,
    /// 场景元数据。
    pub metadata: ScenarioMetadata,
    /// 声明式资源与锁（F3 资源冲突检出的依据）。
    pub resources: Vec<ResourceClaim>,
}

/// 一个工具节点。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ToolNode {
    /// 节点 id（图内唯一）。
    pub node_id: String,
    /// BaseTool 原子名（对齐 `docs/REWRITE-DESIGN.md` §2.2）。
    pub tool_kind: String,
    /// 节点输入（自由形状，语义由 TS 侧定义）。
    ///
    /// `#[ts(type = "unknown")]` 是刻意的：让 ts-rs 为 `serde_json::Value` 生成一个
    /// 指向**默认 bindings 目录**的 `JsonValue` import 会把 `tsc` 的 `rootDir` 打破
    /// （TS6059）。自由形状 JSON 在 TS 侧本来就该是 `unknown`——由消费方收窄。
    #[ts(type = "unknown")]
    pub input: serde_json::Value,
    /// 门控声明。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub gate: Option<GateSpec>,
    /// 重试声明。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub retry: Option<RetrySpec>,
    /// 超时（毫秒）。
    ///
    /// **是 `u32` 不是 `u64`**：跨语言契约里出现 `u64` 会让 ts-rs 生成 `bigint`，
    /// 而 `JSON.stringify(1n)` **会抛 TypeError** —— 也就是说一个 u64 字段足以让
    /// TS 侧的协议序列化整体失效。u32 毫秒上限约 49 天，对任何超时都绰绰有余。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub timeout_ms: Option<u32>,
    /// 该节点要求的可信度下限；低于它则拒绝进入发布门槛判定。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub min_confidence: Option<ConfidenceLevel>,
}

/// 依赖边。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct Edge {
    /// 起点节点 id。
    pub from: String,
    /// 终点节点 id。
    pub to: String,
}

/// 门控声明。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct GateSpec {
    /// 该节点要求的能力（成员来自 `spec/contracts/capabilities.yaml` 的 20 个）。
    pub requires: Vec<String>,
    /// 缺失时的处置意图（最终决策仍由 `crates/capability` 的裁决表给出）。
    pub on_missing: OnMissing,
    /// `Degrade` 时的 fallback 路径名。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub fallback: Option<String>,
}

/// 能力缺失时的声明式意图。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum OnMissing {
    /// 继续。
    Proceed,
    /// 跳过。
    Skip,
    /// 失败（仅"必需能力"）。
    Fail,
    /// 降级。
    Degrade,
}

/// 重试声明。
///
/// **只对 `Inconclusive` 与 `env` 归因重试**，`product_bug` **不重试**（设计 §5.1）。
/// 理由：`product_bug` 是确定性的产品缺陷，重试只是把同一件事再做一遍；
/// 而 `env`（环境抖动）与 `Inconclusive`（判据在当前证据下不可判定）重试才可能有意义。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct RetrySpec {
    /// 重试次数上界。
    pub times: u32,
    /// 退避（毫秒，u32 理由同 `ToolNode::timeout_ms`）。
    pub backoff_ms: u32,
    /// 允许重试的归因类别。
    pub on: Vec<RetryOn>,
}

/// 允许重试的归因类别白名单。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "../../../src/contracts/generated/")]
#[non_exhaustive]
pub enum RetryOn {
    /// 判据不可判定。
    Inconclusive,
    /// 环境归因。
    Env,
}

/// 声明式资源与锁（设计 §5.4，用于 F3 资源冲突检出）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ResourceClaim {
    /// 资源标识（会话 / 临时目录 / 端口 / 全局注册表）。
    pub resource_id: String,
    /// 资源种类，用于跨进程冲突判定。
    pub kind: String,
    /// 是否独占。
    pub exclusive: bool,
    /// 声明者（节点 id）——冲突报告要能点名。
    pub declared_by: String,
}

/// 场景元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/contracts/generated/")]
pub struct ScenarioMetadata {
    /// 场景 id（对应 `cases/TK-XXXX.yaml` 的 `id`）。
    pub scenario_id: String,
    /// 场景标题。
    pub title: String,
    /// 所属层。
    pub layer: Layer,
    /// 可信度。
    pub confidence: ConfidenceLevel,
    /// 是否共享宿主（设计 §2.3：大类可选共享，**报告里必须标出来**）。
    pub shared_context: bool,
    /// 场景嵌套深度（编译器硬规则：不超过三层）。
    pub depth: u8,
    /// 随机种子（`Some` ⇒ 同种子同出队顺序，指标 C1 的结构保证）。u32 理由同 `ToolNode::timeout_ms`。
    #[serde(skip_serializing_if = "Option::is_none", default)]
    #[ts(optional)]
    pub seed: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str) -> ToolNode {
        ToolNode {
            node_id: id.into(),
            tool_kind: "call-tool".into(),
            input: serde_json::json!({}),
            gate: None,
            retry: None,
            timeout_ms: None,
            min_confidence: None,
        }
    }

    #[test]
    fn only_real_confidence_is_accepted_for_release_gate() {
        assert!(ConfidenceLevel::Real.accepted_for_release());
        assert!(!ConfidenceLevel::Simulated.accepted_for_release());
        assert!(!ConfidenceLevel::Degraded.accepted_for_release());
        // `unsafe` 入口产出的 Static 结果不得进入发布门槛——这是设计 §5.4 的约束。
        assert!(!ConfidenceLevel::Static.accepted_for_release());
    }

    #[test]
    fn plan_round_trips_through_json() {
        let plan = ExecutionPlan {
            nodes: vec![node("n1"), node("n2")],
            edges: vec![Edge {
                from: "n1".into(),
                to: "n2".into(),
            }],
            metadata: ScenarioMetadata {
                scenario_id: "TK-0001".into(),
                title: "driver 自检".into(),
                layer: Layer::L3,
                confidence: ConfidenceLevel::Real,
                shared_context: false,
                depth: 1,
                seed: Some(42),
            },
            resources: vec![ResourceClaim {
                resource_id: "sessions".into(),
                kind: "session".into(),
                exclusive: true,
                declared_by: "n1".into(),
            }],
        };
        let json = serde_json::to_string(&plan).expect("serialize");
        let back: ExecutionPlan = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(plan, back);
    }

    #[test]
    fn optional_fields_are_omitted_not_null() {
        // `skip_serializing_if` 是刻意的：报告的字段集必须稳定，
        // `null` 与"字段不存在"在阶段 2 的对拍里语义不同。
        let json = serde_json::to_string(&node("n1")).expect("serialize");
        assert!(!json.contains("null"), "可选字段不应序列化成 null：{json}");
        assert!(!json.contains("gate"));
    }

    #[test]
    fn retry_whitelist_excludes_product_bug_by_construction() {
        // `RetryOn` 只有两个变体——"product_bug 不重试"由**类型**保证，
        // 不是靠文档约定。这是"能靠结构消除的，不靠实测"的一个例子。
        let r = RetrySpec {
            times: 2,
            backoff_ms: 100,
            on: vec![RetryOn::Inconclusive, RetryOn::Env],
        };
        assert_eq!(r.on.len(), 2);
    }
}
