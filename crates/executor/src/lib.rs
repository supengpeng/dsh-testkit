//! `executor` —— 执行器与报告聚合。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.5（`TestExecutor` / `ReportAggregator`）、
//! §5.3（四层防御的第三层：plan 运行期校验）、§5.4（`ExecutionPlan` 与资源锁）、
//! §6.1–§6.2（执行与回滚纪律）。
//!
//! # 报告字段的兼容要求
//! [`TestReport`] 序列化后必须能填出既有 `schemas/run-report.schema.json` 的**全部既有字段**
//! （逐字段等价关系见设计 §9.3）。按 RFC §5「只新增、不删既有字段」，本任务新增的唯一
//! schema 字段是 `totals.inconclusive`（见 [`RunTotals`]）——阶段 0 实测确认既有实现
//! 既没有 `Inconclusive` 断言态、也没有对应计数。
//!
//! # 隔离与回滚纪律（设计 §6.2，逐条沿用不放松）
//! 1. 任何注册必须经夹具登记入口，登记的 disposer 进释放栈；
//! 2. 释放**逆序**执行；释放失败**不静默**，记进 `cleanup.released` / `cleanup.leftovers`；
//! 3. 残留探测**探不到标 `unknown`**，绝不标"干净"。
//!
//! Rust 侧承担的是"释放栈的**正确性**"（逆序、幂等、失败可见）；
//! "登记了什么"仍由 TS 侧驱动提供——这与设计 §1.1 的边界纪律一致。
//!
//! # 分层边界
//! 成本闸门（`src/executor/policy.ts`）**留在 TS**（设计 §1.2：它是安全边界）；
//! 本 crate 不含任何成本 / 沙箱字段，两者不许合并。

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::disallowed_types)]

mod execute;
mod report;
mod validate;

pub use execute::{
    execute_plan, topological_order, AssertionRecord, AssertionVerdict, ConfidenceViolation,
    ExecutionTrace, LeftoverProbe, NodeOutcome, NodeRunner, ReleaseFailure, ResidueState,
    ResourceReleaser, StepTrace,
};
pub use report::{
    ActionReport, AssertionReport, CaseReport, CleanupReport, ExecutionReport,
    PolicySnapshotReport, RedactionFinding, RedactionReport, ReleaseFailureReport, RunTotals,
    SelectionReport, StepReport, TestReport, Verdict,
};
pub use validate::{
    allowed_confidence_for, capability_id_of, layer_confidence_ok, validate_plan,
    CapabilityDecision, PlanIssue, PlanIssueKind, PlanValidation,
};

// 跨语言契约复用 `protocol` 的类型——**不在本 crate 里重新定义**（设计 §1.1）。
pub use dsh_testkit_protocol::plan::{
    ConfidenceLevel, Edge, ExecutionPlan, GateSpec, Layer, OnMissing, ResourceClaim, RetrySpec,
    ScenarioMetadata, ToolNode,
};

/// 本 crate 的 plan 校验默认分层（`metadata.depth` 的上界）。
///
/// 真源是编译器的硬规则"嵌套不超过三层"（`docs/REWRITE-DESIGN.md` §5.4）。
pub const MAX_PLAN_DEPTH: u8 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_confidence_level_is_reused_not_redefined() {
        // 设计 §1.1 的边界纪律：跨语言契约只经由 protocol。
        // 这条测试用"类型同一性"钉住它——如果本 crate 又定义了一个同名的枚举，
        // 下面的赋值就不会通过。
        let level: ConfidenceLevel = dsh_testkit_protocol::plan::ConfidenceLevel::Real;
        assert!(level.accepted_for_release());
        assert!(!ConfidenceLevel::Static.accepted_for_release());
    }
}
