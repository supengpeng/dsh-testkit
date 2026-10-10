//! 调度器错误：**只表达"调度器/工具坏了"**。
//!
//! 设计 §3.1 的约束在这里的落点是：**任务被取消不是错误**。
//! `TaskOutcome` 有 `Cancelled` 变体（`wait` 返回 `Ok(TaskResult { outcome: Cancelled })`），
//! 因为"我们主动叫停"与"工具坏了"必须能被区分——把前者塞进 `Err`
//! 会让调用方用同一段代码处理两类完全不同的处境（与"断言失败不是 `Err`"同源）。

use dsh_testkit_protocol::message::TaskId;
use std::fmt;

/// 调度器错误。
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SchedulerError {
    /// 句柄指向的任务不在本调度器的任务表里（句柄来自别的调度器，或 id 写错）。
    UnknownTask {
        /// 任务 id。
        task_id: TaskId,
    },
    /// 同一个 `task_id` 被提交了两次。
    ///
    /// 为什么不静默覆盖：`TaskId` 是任务结果的**唯一标识**，
    /// 覆盖会让"这条结果是哪次提交的"变得不可审计，而审计正是本项目的产出物。
    DuplicateTaskId {
        /// 任务 id。
        task_id: TaskId,
    },
    /// 调度器已 `shutdown`，不再接受 `submit`。
    ///
    /// 注意 `wait` / `cancel` **不**受此限制：关停前已终结的任务，
    /// 其结果仍必须可读（否则"句柄可被多次 `wait`"会在关停边界上失效）。
    ShutDown,
    /// 内部不变量被破坏：还有未终态任务，但已无在途工作线程可推进它。
    ///
    /// 这条**不应该**出现（每个非终态任务要么在显式队列里，要么有在途工作线程）。
    /// 它存在的意义是：宁可显式报"卡住了"，也不要静默返回一个假的"还没好"。
    ///
    /// **(b) 按构造不可达**（task-24 的性质判定）：要触发它必须先破坏
    /// "非终态任务必有人推进"这个不变量。因此它下面那条 `Display` 分支
    /// **刻意不补测试** —— 手工构造一个错误再 `format!` 它，只会让套件变长，判别力为零。
    Stalled {
        /// 仍未终态的任务数。
        pending: usize,
    },
}

impl fmt::Display for SchedulerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownTask { task_id } => {
                write!(formatter, "未知任务：{}", task_id.0)
            }
            Self::DuplicateTaskId { task_id } => {
                write!(formatter, "任务 id 重复提交：{}", task_id.0)
            }
            Self::ShutDown => write!(formatter, "调度器已关停"),
            Self::Stalled { pending } => write!(
                formatter,
                "调度器卡住：仍有 {pending} 个任务未终结，但没有在途工作线程"
            ),
        }
    }
}

impl std::error::Error for SchedulerError {}
