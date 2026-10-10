//! 任务侧的值类型：任务体、执行上下文、提交项，以及结果归一化。
//!
//! # 边界（设计 §6.3）
//!
//! [`TaskBody::run`] 在**工作线程**上执行，属于"I/O 层"：允许真并发，
//! 因为它只影响"多久拿到结果"，不影响"看到什么顺序"。
//! 它**不得**触碰调度器内部状态 —— 类型上就做不到：
//!
//! - 它拿不到 [`crate::Scheduler`]（没有引用、也没有全局）；
//! - [`ExecutionContext`] 只给三件事：读任务 id、读取消标志、登记释放项。
//!
//! 也就是说，"工作线程写不了判定日志"不是靠纪律，是靠**签名**。

use crate::queue::Priority;
use crate::release::{RegisteredRelease, ReleaseFn};
use dsh_testkit_protocol::message::{TaskId, TaskOutcome, TaskResult};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::fmt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// 任务结论载荷：结论 + 可选取证细节。
///
/// 注意它**不含** `task_id` 与 `duration_ms`：前者由调度器补（任务体不该自报身份），
/// 后者由调度器测（任务体自报的耗时不可信，而且它是已声明的非确定字段）。
#[derive(Debug, Clone, PartialEq)]
pub struct TaskOutput {
    /// 结论。
    pub outcome: TaskOutcome,
    /// 取证细节。
    pub detail: Option<Value>,
}

impl TaskOutput {
    /// 显式构造。
    pub fn new(outcome: TaskOutcome, detail: Option<Value>) -> Self {
        Self { outcome, detail }
    }

    /// 全部断言通过。
    pub fn passed() -> Self {
        Self::new(TaskOutcome::Passed, None)
    }

    /// 有断言失败（细节由断言引擎填，这里只给结论）。
    pub fn failed() -> Self {
        Self::new(TaskOutcome::Failed, None)
    }

    /// 跳过（能力缺失等）。
    pub fn skipped(reason: impl Into<String>) -> Self {
        Self::reasoned(TaskOutcome::Skipped, reason)
    }

    /// 执行期错误（工具/宿主坏了）。
    pub fn errored(reason: impl Into<String>) -> Self {
        Self::reasoned(TaskOutcome::Errored, reason)
    }

    /// 判据不可判定（设计 §3.3 的第四态）。
    pub fn inconclusive(reason: impl Into<String>) -> Self {
        Self::reasoned(TaskOutcome::Inconclusive, reason)
    }

    /// 任务体自己观察到取消并主动收尾。
    ///
    /// 它与调度器的 `cancel`（调用方叫停）不同：这条是**任务体的选择**，
    /// 而调度器记的 `TaskResult.outcome` 以**调度器的判决**为准
    /// （两者若不一致，观测日志里能看到任务体实际返回了什么）。
    pub fn cancelled(reason: impl Into<String>) -> Self {
        Self::reasoned(TaskOutcome::Cancelled, reason)
    }

    fn reasoned(outcome: TaskOutcome, reason: impl Into<String>) -> Self {
        Self::new(outcome, Some(json!({ "reason": reason.into() })))
    }

    /// 附带取证细节（链式）。
    pub fn with_detail(mut self, detail: Value) -> Self {
        self.detail = Some(detail);
        self
    }
}

/// 结果归一化：把**已声明的非确定字段**抹平（`duration_ms`）。
///
/// 用途：C1 的判据是事件序列哈希（见 [`crate::EventLog::hash`]），
/// 但有时确实需要"逐字段比对两次运行的结果" —— 那时必须先归一化，
/// 否则每次都会因为耗时不同而"不同"，指标会永远红。
///
/// 这与 C4（归一化后确定性）配套：归一化**只能**抹掉已声明的字段
/// （见 [`crate::NON_DETERMINISTIC_FIELDS`]），多抹一个字段就是掩盖真实差异。
pub fn normalized_result(result: &TaskResult) -> TaskResult {
    let mut normalized = result.clone();
    normalized.duration_ms = 0;
    normalized
}

/// 任务体：判定路径**之外**的执行（设计 §6.3 的 "I/O 层"）。
///
/// `Send + Sync + 'static`：它会被搬到工作线程上执行。
pub trait TaskBody: Send + Sync + 'static {
    /// 执行任务。实现里**不要**做"顺序敏感"的事：这里的并发顺序不参与判定。
    fn run(&self, context: &ExecutionContext) -> TaskOutput;
}

impl<F> TaskBody for F
where
    F: Fn(&ExecutionContext) -> TaskOutput + Send + Sync + 'static,
{
    fn run(&self, context: &ExecutionContext) -> TaskOutput {
        self(context)
    }
}

/// 执行上下文：工作线程能看到的**全部**调度器信息。
///
/// 三个能力，一个都不多：
/// - [`Self::task_id`]：日志与归因需要知道自己是谁；
/// - [`Self::is_cancelled`]：**协作式取消**的唯一依据（Rust 无法安全强杀线程，
///   所以取消只能是"被请求 + 任务体配合退出"）；
/// - [`Self::on_release`]：设计 §6.2 的**登记入口**。
#[derive(Debug)]
pub struct ExecutionContext {
    task_id: TaskId,
    cancel: Arc<AtomicBool>,
    releases: RefCell<Vec<RegisteredRelease>>,
}

impl ExecutionContext {
    /// 构造（只由调度器在工作线程内调用）。
    pub(crate) fn new(task_id: TaskId, cancel: Arc<AtomicBool>) -> Self {
        Self {
            task_id,
            cancel,
            releases: RefCell::new(Vec::new()),
        }
    }

    /// 本任务的 id。
    pub fn task_id(&self) -> &TaskId {
        &self.task_id
    }

    /// 是否已被请求取消（`cancel` 或 `shutdown`）。
    ///
    /// 语义要点：**请求**取消 ⇒ 标志为 `true`，但调度器给出的结论不会因为
    /// "任务体没理会"而改变（设计 §3.2 第 3 条：`cancel` 立刻生效）。
    /// 任务体的正确做法是在能停下的地方检查它，然后返回
    /// [`TaskOutput::cancelled`]。
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// 登记一个释放项（设计 §6.2 第 1 条的唯一入口）。
    ///
    /// `disposer` 的返回值为 `Err(String)` 时**不会**中断其余释放：
    /// 失败会进 [`crate::ReleaseReport`] 与判定日志（"释放失败不静默"）。
    ///
    /// 同一任务内多次调用时，释放按**登记的逆序**执行；
    /// 任务之间则按"提交序的逆序"（见 [`crate::ReleaseStack`] 的模块文档）。
    pub fn on_release(
        &self,
        resource: impl Into<String>,
        disposer: impl FnOnce() -> Result<(), String> + Send + 'static,
    ) {
        let entry: ReleaseFn = Box::new(disposer);
        self.releases
            .borrow_mut()
            .push(RegisteredRelease::new(resource.into(), entry));
    }

    /// 取出全部登记项（工作线程收尾时调用）。
    pub(crate) fn take_releases(self) -> Vec<RegisteredRelease> {
        self.releases.into_inner()
    }
}

/// 提交给调度器的任务。
///
/// 只有三个字段：身份、显式优先级、任务体。
/// 其余一切（计划、能力门控、断言）都不在这里 ——
/// 那属于 TS 编译器与别的 crate，调度器不该认识它们（设计 §1.1 的边界纪律）。
pub struct TestTask {
    /// 任务 id（由 TS 编译器生成，见 `protocol::SubmitParams`）。
    pub task_id: TaskId,
    /// 显式优先级（数值越大越先出队）。
    pub priority: Priority,
    /// 任务体。
    pub body: Box<dyn TaskBody>,
}

impl TestTask {
    /// 构造。
    pub fn new(task_id: TaskId, priority: Priority, body: impl TaskBody) -> Self {
        Self {
            task_id,
            priority,
            body: Box::new(body),
        }
    }

    /// 用缺省优先级构造。
    pub fn normal(task_id: TaskId, body: impl TaskBody) -> Self {
        Self::new(task_id, Priority::NORMAL, body)
    }
}

impl fmt::Debug for TestTask {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("TestTask")
            .field("task_id", &self.task_id)
            .field("priority", &self.priority)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outcome_constructors_match_the_protocol_wire_names() {
        // 结论的"线上名"是**跨语言契约**（`#[serde(rename_all = "snake_case")]`）。
        // 这里把每个构造器与它的线上名绑起来，防止以后改名悄悄破坏 TS 侧。
        let cases = [
            (TaskOutput::passed().outcome, "passed"),
            (TaskOutput::failed().outcome, "failed"),
            (TaskOutput::skipped("x").outcome, "skipped"),
            (TaskOutput::errored("x").outcome, "errored"),
            (TaskOutput::inconclusive("x").outcome, "inconclusive"),
            (TaskOutput::cancelled("x").outcome, "cancelled"),
        ];
        for (outcome, wire) in cases {
            assert_eq!(
                serde_json::to_value(outcome).expect("可序列化"),
                Value::String(wire.to_owned()),
                "结论 {outcome:?} 的线上名不是 {wire}"
            );
        }
        assert_eq!(cases.len(), 6, "TaskOutcome 变体数变化时必须更新这条守卫");
    }

    #[test]
    fn normalized_result_only_erases_the_declared_non_deterministic_field() {
        let result = TaskResult {
            task_id: TaskId("t1".into()),
            outcome: TaskOutcome::Passed,
            duration_ms: 123,
            detail: Some(json!({"a": 1})),
        };
        let normalized = normalized_result(&result);
        assert_eq!(normalized.duration_ms, 0);
        assert_eq!(normalized.outcome, result.outcome);
        assert_eq!(normalized.detail, result.detail);
        assert_eq!(normalized.task_id, result.task_id);
    }
}
