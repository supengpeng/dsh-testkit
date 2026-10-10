//! **释放栈**：登记的 disposer **逆序**释放、**幂等**、失败**可见**。
//!
//! **真源**：设计 §6.2（既有纪律逐条沿用，不放松）：
//!
//! 1. 任何注册必须走登记入口（本 crate 的入口是
//!    [`ExecutionContext::on_release`](crate::ExecutionContext::on_release)），
//!    登记的 disposer 进释放栈。
//! 2. 释放**逆序**执行；释放失败**不静默** —— 记进 [`ReleaseReport`]。
//! 3. 步骤级释放在本步结束就做，不等整条场景。
//!
//! # 本 crate 在分工里承担什么
//!
//! 设计 §6.2 的分工是：Rust 侧承担"释放栈的**正确性**（逆序、幂等、失败可见）"；
//! "登记了什么"仍由 TS 侧驱动提供。所以这里**不**判断某个资源该不该登记，
//! 只保证"既然登记了，就一定按逆序释放、且失败被记录"。
//!
//! # "逆序"的基准是**登记序**，不是"观测到完成的顺序"
//!
//! 这是本模块唯一的非显然决定，值得写清楚：
//! 作用域的顺序取**提交序**（`register_task` 的调用顺序），
//! 而不是"任务完成被观测到的顺序"。后者是 I/O 时序的函数，
//! 若拿它当释放序的基准，§6.2 的逆序就变成了"线程抢占顺序的函数"，
//! 与设计 §6.3 的结论直接冲突（`tests/contracts.rs` 的 shutdown 测试会因此偶发失败）。
//!
//! 作用域内的顺序取**登记序的逆序**（`on_release` 的调用顺序反过来），
//! 这与 §6.2 第 1 条的字面要求一致。

use dsh_testkit_protocol::message::TaskId;
use std::fmt;

/// 释放函数：登记入口收下的 disposer。
///
/// `Err(String)` 而不是自定义错误类型：disposer 来自宿主侧（TS 驱动的夹具），
/// 它能给出的最有价值的信息就是一句可读的原因；把原因包成枚举只会增加样板。
pub type ReleaseFn = Box<dyn FnOnce() -> Result<(), String> + Send>;

/// 任务作用域自身的资源名。
///
/// 每个任务在提交时都会登记一个"作用域"条目，释放它在语义上表示
/// "该任务的隔离干预已全部回收完毕"。它**不是**虚构的 disposer：
/// [`ReleaseStack::release_task`] 只在真正执行完该作用域的全部 disposer 之后
/// 才把这条记录吐出来。
pub const TASK_SCOPE_RESOURCE: &str = "<task-scope>";

/// 一条登记项：资源名 + disposer。
pub struct RegisteredRelease {
    resource: String,
    disposer: ReleaseFn,
}

impl RegisteredRelease {
    /// 构造（只由 [`ExecutionContext`](crate::ExecutionContext) 调用）。
    pub(crate) fn new(resource: String, disposer: ReleaseFn) -> Self {
        Self { resource, disposer }
    }

    /// 资源名。
    pub fn resource(&self) -> &str {
        &self.resource
    }
}

impl fmt::Debug for RegisteredRelease {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // disposer 不可 Debug：只打资源名，避免"为了 Debug 给闭包加约束"。
        formatter
            .debug_struct("RegisteredRelease")
            .field("resource", &self.resource)
            .finish_non_exhaustive()
    }
}

/// 一次释放的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReleaseOutcome {
    /// 成功释放。
    Released {
        /// 任务 id。
        task_id: TaskId,
        /// 资源名（作用域条目为 [`TASK_SCOPE_RESOURCE`]）。
        resource: String,
    },
    /// 释放失败（原因原文保留，**不静默**）。
    Failed {
        /// 任务 id。
        task_id: TaskId,
        /// 资源名。
        resource: String,
        /// 失败原因。
        reason: String,
    },
}

impl ReleaseOutcome {
    /// 所属任务。
    pub fn task_id(&self) -> &TaskId {
        match self {
            Self::Released { task_id, .. } | Self::Failed { task_id, .. } => task_id,
        }
    }

    /// 资源名。
    pub fn resource(&self) -> &str {
        match self {
            Self::Released { resource, .. } | Self::Failed { resource, .. } => resource,
        }
    }

    /// 是否失败。
    pub fn is_failure(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }
}

/// 成功释放的记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseRecord {
    /// 任务 id。
    pub task_id: TaskId,
    /// 资源名。
    pub resource: String,
}

/// 释放失败的记录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseFailure {
    /// 任务 id。
    pub task_id: TaskId,
    /// 资源名。
    pub resource: String,
    /// 失败原因。
    pub reason: String,
}

/// 释放报告：**"释放失败不静默"** 的落地（设计 §6.2 第 2 条）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReleaseReport {
    /// 成功释放的记录（按实际释放顺序）。
    pub released: Vec<ReleaseRecord>,
    /// 失败的记录（按实际释放顺序）。
    pub failed: Vec<ReleaseFailure>,
}

impl ReleaseReport {
    /// 成功释放的次数。
    pub fn released_count(&self) -> usize {
        self.released.len()
    }

    /// 失败的次数。
    pub fn failed_count(&self) -> usize {
        self.failed.len()
    }

    /// 是否有失败（给上层"释放未完全成功"的判据，而不是让人去数 `failed`）。
    pub fn has_failures(&self) -> bool {
        !self.failed.is_empty()
    }
}

/// 一个任务的释放作用域。
struct TaskScope {
    task_id: TaskId,
    entries: Vec<RegisteredRelease>,
    released: bool,
}

/// 释放栈：按**提交序**排列作用域，作用域内按**登记序**排列条目。
#[derive(Default)]
pub struct ReleaseStack {
    scopes: Vec<TaskScope>,
}

impl ReleaseStack {
    /// 空栈。
    pub fn new() -> Self {
        Self { scopes: Vec::new() }
    }

    /// 登记一个任务作用域（在 `submit` 时调用，位置即**提交序**）。
    pub(crate) fn register_task(&mut self, task_id: TaskId) {
        self.scopes.push(TaskScope {
            task_id,
            entries: Vec::new(),
            released: false,
        });
    }

    /// 追加任务体登记的 disposer（顺序 = `on_release` 的调用顺序）。
    ///
    /// 只在任务体收尾之后调用，因此一定在对应的 [`Self::release_task`] 之前。
    ///
    /// 返回值：**无法挂上的资源名**（作用域已释放，或任务未知）。
    /// 正常情况下必为空 —— 调度器保证"先收尾、后释放"。
    /// 但这里**不允许静默丢弃**（§6.2 第 2 条）：真发生了，调用方必须把
    /// 这些名字记成释放失败，而不是让 disposer 悄悄消失。
    ///
    /// **(b) 按构造不可达**（task-24 的性质判定）：`attach` 只由
    /// `Scheduler::apply_completion` 调用，而 `finalize_task` 要求
    /// `worker_done || !dispatched` 才释放作用域 —— 即"登记项入栈一定早于释放"。
    /// 所以下面 `_ =>` 那一支（连同调用方的 `apply_dropped_releases`）**刻意不补测试**：
    /// 要造出它，先得破坏那个顺序不变量。
    pub(crate) fn attach(
        &mut self,
        task_id: &TaskId,
        releases: Vec<RegisteredRelease>,
    ) -> Vec<String> {
        if releases.is_empty() {
            return Vec::new();
        }
        match self
            .scopes
            .iter_mut()
            .find(|scope| &scope.task_id == task_id)
        {
            Some(scope) if !scope.released => {
                scope.entries.extend(releases);
                Vec::new()
            }
            _ => releases
                .into_iter()
                .map(|entry| entry.resource)
                .collect::<Vec<String>>(),
        }
    }

    /// 释放一个作用域（**逆序**：先条目后作用域，条目内部再逆序）。
    ///
    /// 幂等：已释放的作用域返回空 `Vec`（§6.2 要求释放栈可重复触发）。
    ///
    /// **(b) 按构造不可达**：`task_id` 只可能来自调度器的任务表，
    /// 而每个任务在 `submit` 时就登记了作用域 —— 所以"找不到作用域就返回空"
    /// 这一支**刻意不补测试**；它兜的是"未知 id 不许 panic"。
    pub(crate) fn release_task(&mut self, task_id: &TaskId) -> Vec<ReleaseOutcome> {
        let Some(scope) = self
            .scopes
            .iter_mut()
            .find(|scope| &scope.task_id == task_id)
        else {
            return Vec::new();
        };
        if scope.released {
            return Vec::new();
        }
        scope.released = true;
        let mut outcomes = Vec::new();
        for entry in scope.entries.drain(..).rev() {
            let resource = entry.resource;
            let outcome = match (entry.disposer)() {
                Ok(()) => ReleaseOutcome::Released {
                    task_id: task_id.clone(),
                    resource,
                },
                Err(reason) => ReleaseOutcome::Failed {
                    task_id: task_id.clone(),
                    resource,
                    reason,
                },
            };
            outcomes.push(outcome);
        }
        // 作用域条目**最后**出栈：它表示"这个作用域的干预已全部回收"。
        outcomes.push(ReleaseOutcome::Released {
            task_id: task_id.clone(),
            resource: TASK_SCOPE_RESOURCE.to_owned(),
        });
        outcomes
    }

    /// 关停路径：**全部**未释放的作用域按"提交序的逆序"释放（§6.2 的逆序）。
    pub(crate) fn release_all_reverse(&mut self) -> Vec<ReleaseOutcome> {
        let task_ids: Vec<TaskId> = self
            .scopes
            .iter()
            .rev()
            .filter(|scope| !scope.released)
            .map(|scope| scope.task_id.clone())
            .collect();
        let mut outcomes = Vec::new();
        for task_id in task_ids {
            outcomes.extend(self.release_task(&task_id));
        }
        outcomes
    }

    /// 尚未释放的登记项数（不含作用域条目）。
    pub fn pending(&self) -> usize {
        self.scopes
            .iter()
            .filter(|scope| !scope.released)
            .map(|scope| scope.entries.len())
            .sum()
    }

    /// 作用域顺序（= 提交序；诊断用）。
    pub fn scope_order(&self) -> Vec<TaskId> {
        self.scopes
            .iter()
            .map(|scope| scope.task_id.clone())
            .collect()
    }

    /// 已释放的作用域数。
    pub fn released_scopes(&self) -> usize {
        self.scopes.iter().filter(|scope| scope.released).count()
    }
}

impl fmt::Debug for ReleaseStack {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReleaseStack")
            .field("scopes", &self.scopes.len())
            .field("released_scopes", &self.released_scopes())
            .field("pending", &self.pending())
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn id(name: &str) -> TaskId {
        TaskId(name.to_owned())
    }

    fn recorder() -> (Arc<Mutex<Vec<String>>>, impl Fn(&str) -> RegisteredRelease) {
        let order = Arc::new(Mutex::new(Vec::new()));
        let factory = {
            let order = Arc::clone(&order);
            move |name: &str| {
                let order = Arc::clone(&order);
                let name = name.to_owned();
                RegisteredRelease::new(
                    name.clone(),
                    Box::new(move || {
                        order.lock().expect("锁未中毒").push(name);
                        Ok(())
                    }),
                )
            }
        };
        (order, factory)
    }

    #[test]
    fn entries_are_released_in_reverse_registration_order() {
        let (order, make) = recorder();
        let mut stack = ReleaseStack::new();
        stack.register_task(id("t1"));
        stack.attach(&id("t1"), vec![make("a"), make("b"), make("c")]);
        let outcomes = stack.release_task(&id("t1"));
        assert_eq!(
            order.lock().unwrap().clone(),
            vec!["c".to_owned(), "b".to_owned(), "a".to_owned()]
        );
        // 作用域条目最后出栈。
        assert_eq!(
            outcomes.last().map(ReleaseOutcome::resource),
            Some(TASK_SCOPE_RESOURCE)
        );
        assert_eq!(outcomes.len(), 4);
    }

    #[test]
    fn release_is_idempotent_and_never_double_runs_a_disposer() {
        let (order, make) = recorder();
        let mut stack = ReleaseStack::new();
        stack.register_task(id("t1"));
        stack.attach(&id("t1"), vec![make("a")]);
        assert_eq!(stack.release_task(&id("t1")).len(), 2);
        assert!(stack.release_task(&id("t1")).is_empty(), "第二次必须空");
        assert_eq!(order.lock().unwrap().len(), 1, "disposer 只能跑一次");
    }

    #[test]
    fn a_failing_disposer_is_visible_and_does_not_stop_the_rest() {
        let mut stack = ReleaseStack::new();
        stack.register_task(id("t1"));
        stack.attach(
            &id("t1"),
            vec![
                RegisteredRelease::new("ok".to_owned(), Box::new(|| Ok(()))),
                RegisteredRelease::new("boom".to_owned(), Box::new(|| Err("炸了".to_owned()))),
            ],
        );
        let outcomes = stack.release_task(&id("t1"));
        // 逆序：boom 先跑、失败；ok 仍然要跑（失败不中断释放）。
        assert_eq!(outcomes[0].resource(), "boom");
        assert!(outcomes[0].is_failure());
        assert_eq!(outcomes[1].resource(), "ok");
        assert!(!outcomes[1].is_failure());
    }

    #[test]
    fn release_all_reverse_walks_scopes_in_reverse_registration_order() {
        let (order, make) = recorder();
        let mut stack = ReleaseStack::new();
        for name in ["t1", "t2", "t3"] {
            stack.register_task(id(name));
            stack.attach(&id(name), vec![make(&format!("{name}-a"))]);
        }
        let outcomes = stack.release_all_reverse();
        assert_eq!(
            order.lock().unwrap().clone(),
            vec!["t3-a".to_owned(), "t2-a".to_owned(), "t1-a".to_owned()]
        );
        assert_eq!(outcomes.len(), 6, "3 个条目 + 3 个作用域");
        assert_eq!(stack.pending(), 0);
    }
}
