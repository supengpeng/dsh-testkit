//! **观测**：判定路径**之外**的事实。**不参与 C1 判定**。
//!
//! 设计 §6.3 措施 3 的原话是**约束**，不是期望：
//!
//! > 不可确定者必须移出判定路径：任何无法确定化的输入（OS 级 I/O 完成顺序等）
//! > **只允许影响已标记为"不参与判定"的字段**。
//!
//! 本模块就是那些字段的**唯一**容器。它的三条性质：
//!
//! 1. [`ObservationLog`] **不是** [`crate::EventLog`] 的一部分，
//!    [`crate::EventLog::hash`] 的输入里没有它（`tests/determinism.rs` 正向证明：
//!    完成顺序确实不同的两次运行，事件序列哈希逐位相同）。
//! 2. 每条观测都带 `index`（到达序）与 `observed_at_ms`（相对调度器创建时刻），
//!    它们是**显式声明**的非确定字段 —— 见 [`NON_DETERMINISTIC_FIELDS`]（指标 C3：
//!    非确定性字段清单完整度）。
//! 3. 观测**只增不改**：终态结果是不可变快照，第二次 `wait` 拿到的必须是同一次执行的结果
//!    （契约 2）。所以"被取消的在途任务，其任务体最终返回了什么"只能出现在这里，
//!    不能回写进 `TaskResult` —— 否则重复 `wait` 会得到不同的结果。

use dsh_testkit_protocol::message::{TaskId, TaskOutcome};

/// 已声明的非确定性字段清单（指标 C3）。
///
/// 这张表是**声明**，不是注释：`tests/determinism.rs` 会断言
/// `EventLog` 的哈希输入里没有这些字段，从而把"声明"与"实现"绑在一起。
pub const NON_DETERMINISTIC_FIELDS: &[&str] = &[
    "observations[].index",
    "observations[].observed_at_ms",
    "observations[].duration_ms",
    "TaskResult.duration_ms",
];

/// 一条观测：工作线程（判定路径之外）产出的事实。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observation {
    /// 到达序号（从 0 开始，**按实际到达顺序**，因此不可复现）。
    pub index: u64,
    /// 哪个任务。
    pub task_id: TaskId,
    /// 任务体给出的结论（注意：若任务已被取消，`TaskResult.outcome` 是 `Cancelled`，
    /// 这里保留的是任务体**实际返回**的结论 —— 两者的差别是取证信息）。
    pub outcome: TaskOutcome,
    /// 任务体自报耗时（毫秒，不可复现）。单位与 `TaskResult::duration_ms` 一致（`u32`）。
    pub duration_ms: u32,
    /// 观测到达时刻相对调度器创建时刻的毫秒数（不可复现）。单位与 `duration_ms` 一致（`u32`）。
    pub observed_at_ms: u32,
}

/// 观测日志（**不参与判定**）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ObservationLog {
    items: Vec<Observation>,
}

impl ObservationLog {
    /// 空日志。
    pub fn new() -> Self {
        Self { items: Vec::new() }
    }

    /// 追加一条观测（只由调度器调用）。
    pub(crate) fn push(&mut self, observation: Observation) {
        self.items.push(observation);
    }

    /// 全部观测，**按到达顺序**。
    pub fn items(&self) -> &[Observation] {
        &self.items
    }

    /// 条数。
    pub fn len(&self) -> usize {
        self.items.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.items.is_empty()
    }

    /// **完成顺序**（到达顺序下的任务 id 列表）。
    ///
    /// 这是"线程时序"最直接的读数：`tests/determinism.rs` 用它证明
    /// "两次运行的完成顺序确实不同"，从而使"哈希相同"这个断言**不是同义反复**。
    pub fn completion_order(&self) -> Vec<TaskId> {
        self.items.iter().map(|item| item.task_id.clone()).collect()
    }

    /// 按任务 id 排序后的观测（**规范化视图**：剔除到达顺序后是确定的）。
    pub fn sorted_by_task(&self) -> Vec<&Observation> {
        let mut sorted: Vec<&Observation> = self.items.iter().collect();
        sorted.sort_by(|left, right| left.task_id.cmp(&right.task_id));
        sorted
    }
}
