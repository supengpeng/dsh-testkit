//! 调度器本体：句柄契约 + 单线程判定路径 + 显式事件队列 + 工作线程（I/O 层）。
//!
//! **真源**：设计 §3.2（四条契约）与 §6.3（并发模型）。
//!
//! # 四条契约怎么落地（逐条）
//!
//! 1. **`submit` 立即返回句柄、不阻塞**：`submit` 只做三件事——查重、入队、记一条
//!    `Submitted` 决策，然后返回 `TaskHandle`。它**不**派发工作线程。
//!    真正的出队发生在泵点（[`Scheduler::pump`]，由 `wait` / `drain` / `shutdown` 触发），
//!    这样"出队顺序"才是队列的函数，而不是"提交时顺便跑了没"的函数。
//! 2. **句柄可被多次 `wait`**：终态结果一写定就不再改动
//!    （[`TerminalSlot`] 里 `state + result` 同时落位），第二次 `wait` 直接返回同一份克隆。
//!    这也是"任务体返回了什么"不能回写进已终态结果的原因（那会破坏本条）。
//! 3. **`cancel` 幂等**：对已终态句柄记一条 `CancelRequested { was_terminal: true }`
//!    并返回 `Ok(())`，**不改写**已有结论。
//! 4. **`shutdown` 可重复**：重复调用只记 `already_shut_down: true` 与
//!    `ShutdownCompleted { released: 0 }`；首次调用取消在途任务并按 §6.2 **逆序**释放。
//!
//! # 并发模型怎么落地（§6.3 逐条自问）
//!
//! | §6.3 的约束 | 由什么保证 |
//! |---|---|
//! | 判定路径单线程 | 所有 mutating 方法是 `&mut self`：**共享引用上进不来**。工作线程拿不到 `&Scheduler` |
//! | 显式事件队列，不由线程池抢占决定 | [`crate::ReadyQueue`] 的 `BTreeSet` + `QueueKey` 全序；出队只在泵点发生 |
//! | 事件带 `seq`，可重放 | [`crate::EventLog`] 的 `record` 是 `pub(crate)`，`replay` 按 `seq` 注入 |
//! | C1 = 事件序列哈希；报首个分叉 | [`crate::EventLog::hash`] / [`crate::EventLog::first_divergence`] |
//! | 不可确定者只影响"不参与判定"的字段 | 完成顺序进 [`crate::ObservationLog`]，**不进** `EventLog`；哈希输入里没有它 |
//! | 用例之间多进程并行（不在本 crate） | 本 crate 不提供跨进程调度；进程池由 TS 侧驱动 |
//!
//! # 一个刻意的"不做"
//!
//! `submit` **不派发**。如果 `submit` 就顺手把任务丢给线程，那么"先到的低优先级任务"
//! 一定抢在"后到的高优先级任务"前面——优先级队列会退化成一个普通通道。
//! 泵点的存在就是为了让优先级真的有语义。
//!
//! # (b) 按构造不可达的分支：为什么它们**没有**测试覆盖
//!
//! task-24（J1 覆盖率）的性质判定里，本文件有一批分支属于"防御性 / 按构造不可达"。
//! 它们**刻意不补测试**：为它们写"手工构造内部状态"的测试只会让套件变长、判别力为零。
//! 按纪律，每一处都写明它兜的是什么、以及为什么造不出来：
//!
//! | 位置 | 兜的是什么 | 为什么按构造不可达 |
//! |---|---|---|
//! | `pump` 的 `None => None`（队列里有未知任务） | 队列与任务表不一致时不要 panic | 只有 `submit` 会入队，两处同时登记 |
//! | `pump` 的 `body.take()` 为 `None` | "任务体只被取出一次" | 每个任务只被派发一次 |
//! | `wait` 的 `None => Stalled` | 无超时等待却不终结 | 无超时的 `wait` 只在终结或关停时退出循环 |
//! | `wait_timeout` 关停后的 `Stalled` | 关停后仍有非终态任务 | 关停会把每个任务都落成终态 |
//! | `drain` 的 `in_flight() == 0` / `Stalled` | 有未终态任务但无人推进 | 非终态任务要么在显式队列里、要么在途 |
//! | `spawn_worker` 的 `Err(error)` + `terminalize` | 工作线程创建失败（资源耗尽） | 测试环境无法可移植地造出该失败 |
//! | `join_workers` 的循环体 | 线程结束却没发完成消息 | `reap_workers` 已回收结束的句柄；`catch_unwind` 保证一定会发 |
//! | 多处 `if let Some(slot) = self.tasks.get_mut(..)` 的 `None` 支 | 任务表不一致时不 panic | 上游都先查过 `contains_key` |
//!
//! 另外两类**不补**的未覆盖代码：
//!
//! 1. **纯样板**：`Display` / `Debug` / getter / builder（见 `queue.rs`、`task.rs`、`config.rs`
//!    与 `release.rs` 的若干行）—— 给它们写测试不会因为实现改错而红。
//! 2. **LLVM 对复合条件的分支记账**：例如
//!    `has_unfinished_terminal && (slot.worker_done || !slot.dispatched)` 的
//!    子条件组合空间比真实状态空间大，其中若干组合不可达。

use crate::config::{SchedulerConfig, Seed};
use crate::error::SchedulerError;
use crate::event::{Decision, EventHash, EventLog};
use crate::observation::{Observation, ObservationLog};
use crate::queue::ReadyQueue;
use crate::release::{
    RegisteredRelease, ReleaseFailure, ReleaseOutcome, ReleaseRecord, ReleaseReport, ReleaseStack,
};
use crate::task::{ExecutionContext, TaskBody, TaskOutput, TestTask};
use dsh_testkit_protocol::message::{TaskHandle, TaskId, TaskOutcome, TaskResult, TaskState};
use serde_json::json;
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

/// `wait` 内部单次阻塞的上限。
///
/// 不用无穷大：`recv_timeout` 会周期性回到循环顶部重新读状态，
/// 这样"取消/关停"之类的状态变化不必等一个永远不会到的消息。
/// 它**不是**轮询间隔（正常情况下每次都会收到完成消息）。
const MAX_WAIT_SLICE: Duration = Duration::from_secs(86_400);

/// 调度器生命周期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchedulerLifecycle {
    /// 可提交、可等待。
    Running,
    /// 已关停：`submit` 拒绝，`wait` / `cancel` 仍可读已终结的结论。
    ShutDown,
}

/// [`Scheduler::status`] 的快照（设计 §3.2 的 `fn status(&self) -> SchedulerStatus`）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchedulerStatus {
    /// 生命周期。
    pub lifecycle: SchedulerLifecycle,
    /// 种子（C1 的输入）。
    pub seed: Seed,
    /// 已提交任务总数。
    pub submitted: usize,
    /// 仍在显式队列里、尚未派发的任务数。
    pub queued: usize,
    /// 已派发、尚未收尾的任务数。
    pub in_flight: usize,
    /// 已正常结束的任务数（含断言失败——断言失败不是调度器错误）。
    pub finished: usize,
    /// 已取消的任务数。
    pub cancelled: usize,
    /// 已成功释放的登记项数。
    pub released: usize,
    /// 释放失败的登记项数（**不静默**：这里非零就必须被看见）。
    pub release_failures: usize,
    /// 尚未释放的登记项数。
    pub pending_releases: usize,
    /// 判定事件条数。
    pub events: usize,
    /// 当前事件序列哈希（C1 读数）。
    pub event_hash: EventHash,
}

/// **同步版** `TestScheduler`（设计 §3.2 的落地）。
///
/// # 与设计稿的两处显式偏差（Lead 已裁决批准）
///
/// 1. **没有 `async`**：设计稿写 `#[async_trait]`，但本 crate 的并发是
///    "单线程事件队列 + 用例间多进程并行"，**不需要**异步运行时；
///    引入 `tokio` 只会把"顺序由谁决定"从类型层退回到运行时层，与 §6.3 冲突。
/// 2. **mutating 方法是 `&mut self`**（设计稿写 `&self` + 内部可变性）。
///    这不是风格选择：`&mut self` 让"判定路径单线程"成为**编译器强制**的事实。
///    `lib.rs` 里有一条 `compile_fail` doctest 专门证明"共享引用上进不了判定路径"。
///
/// 换句话说：契约（`submit` 不阻塞、句柄可重复 `wait`、`cancel` 幂等、`shutdown` 可重复）
/// 与设计稿完全一致；只有"用类型而不是锁来表达单线程"这一点是改进了的实现方式。
pub trait TestScheduler {
    /// 提交任务，**立即**返回句柄（不阻塞、不派发）。
    fn submit(&mut self, task: TestTask) -> Result<TaskHandle, SchedulerError>;

    /// 等待任务终结（阻塞）。可对同一句柄重复调用。
    fn wait(&mut self, handle: &TaskHandle) -> Result<TaskResult, SchedulerError>;

    /// 请求取消（幂等）。
    fn cancel(&mut self, handle: &TaskHandle) -> Result<(), SchedulerError>;

    /// 当前状态快照。
    fn status(&self) -> SchedulerStatus;

    /// 关停（可重复调用）。
    fn shutdown(&mut self) -> Result<(), SchedulerError>;
}

/// 任务槽：调度器的内部状态。
///
/// 关键设计：**终态是一个"二合一"记录**（[`TerminalSlot`]），
/// 因此"状态是终态但没有结果"在类型上不可表达 ——
/// [`Scheduler::wait`] 不必写"理论上不可能"的兜底分支。
struct TaskSlot {
    queued: bool,
    dispatched: bool,
    worker_done: bool,
    cancel: Arc<AtomicBool>,
    terminal: Option<TerminalSlot>,
    body: Option<Box<dyn TaskBody>>,
}

/// 终态记录：状态与结果同时落位，写定后不再改动。
struct TerminalSlot {
    state: TaskState,
    result: TaskResult,
    finalized: bool,
}

impl TaskSlot {
    /// 当前状态（`Pending` / `Running` / `Finished` / `Cancelled`）。
    fn state(&self) -> TaskState {
        match &self.terminal {
            Some(terminal) => terminal.state,
            None if self.dispatched => TaskState::Running,
            None => TaskState::Pending,
        }
    }
}

/// 工作线程回传给判定路径的完成消息。
///
/// 它**不是**判定事件：到达顺序由 OS 决定。判定路径收到它之后，
/// 只做两件与顺序无关的事（记观测、把释放项挂到对应作用域），
/// 以及一次"状态从未终态变终态"的迁移。
struct Completion {
    task_id: TaskId,
    output: TaskOutput,
    releases: Vec<RegisteredRelease>,
    duration_ms: u32,
}

/// 测试调度器。
pub struct Scheduler {
    config: SchedulerConfig,
    lifecycle: SchedulerLifecycle,
    tasks: BTreeMap<TaskId, TaskSlot>,
    ready: ReadyQueue,
    log: EventLog,
    observations: ObservationLog,
    releases: ReleaseStack,
    report: ReleaseReport,
    completion_tx: Sender<Completion>,
    completion_rx: Receiver<Completion>,
    workers: Vec<JoinHandle<()>>,
    submit_order: u64,
    started_at: Instant,
}

impl Scheduler {
    /// 用配置构造。
    pub fn new(config: SchedulerConfig) -> Self {
        let (completion_tx, completion_rx) = mpsc::channel();
        Self {
            config,
            lifecycle: SchedulerLifecycle::Running,
            tasks: BTreeMap::new(),
            ready: ReadyQueue::new(),
            log: EventLog::new(),
            observations: ObservationLog::new(),
            releases: ReleaseStack::new(),
            report: ReleaseReport::default(),
            completion_tx,
            completion_rx,
            workers: Vec::new(),
            submit_order: 0,
            started_at: Instant::now(),
        }
    }

    /// 当前种子。
    pub const fn seed(&self) -> Seed {
        self.config.seed()
    }

    /// 判定事件日志（C1 的读数来源）。
    pub fn event_log(&self) -> &EventLog {
        &self.log
    }

    /// 观测日志（**不参与判定**）。
    pub fn observations(&self) -> &ObservationLog {
        &self.observations
    }

    /// 释放报告（"释放失败不静默"的落点）。
    pub fn release_report(&self) -> &ReleaseReport {
        &self.report
    }

    /// 任务当前状态（已取消任务的如实读口；见 `SchedulerError` 的文档）。
    pub fn state_of(&self, task_id: &TaskId) -> Option<TaskState> {
        self.tasks.get(task_id).map(TaskSlot::state)
    }

    /// 提交任务，**立即**返回句柄。
    ///
    /// 不派发、不阻塞：只查重、入队、记 `Submitted`。详见类型文档"一个刻意的不做"。
    pub fn submit(&mut self, task: TestTask) -> Result<TaskHandle, SchedulerError> {
        if self.lifecycle == SchedulerLifecycle::ShutDown {
            return Err(SchedulerError::ShutDown);
        }
        let TestTask {
            task_id,
            priority,
            body,
        } = task;
        if self.tasks.contains_key(&task_id) {
            return Err(SchedulerError::DuplicateTaskId { task_id });
        }
        self.submit_order += 1;
        let key = self.ready.push(
            task_id.clone(),
            priority,
            self.config.seed(),
            self.submit_order,
        );
        // 释放作用域**在提交时就登记**：作用域顺序 = 提交序，
        // 而不是"完成被观测到的顺序"（后者是 I/O 时序的函数，见 release.rs）。
        self.releases.register_task(task_id.clone());
        self.log.record(Decision::Submitted {
            task_id: task_id.clone(),
            priority,
            rank: key.rank(),
        });
        self.tasks.insert(
            task_id.clone(),
            TaskSlot {
                queued: true,
                dispatched: false,
                worker_done: false,
                cancel: Arc::new(AtomicBool::new(false)),
                terminal: None,
                body: Some(body),
            },
        );
        Ok(TaskHandle {
            task_id,
            state: TaskState::Pending,
        })
    }

    /// 泵点：把队列里能派发的任务按**显式出队顺序**交给工作线程。返回派发数。
    ///
    /// 它是本 crate 唯一的"出队现场"：想改变出队顺序，只能改 `ReadyQueue` 的键，
    /// 改不了这里的"谁先被取走"。
    pub fn pump(&mut self) -> usize {
        if self.lifecycle == SchedulerLifecycle::ShutDown {
            return 0;
        }
        let mut dispatched = 0usize;
        while let Some(task_id) = self.ready.pop_next() {
            let taken = match self.tasks.get_mut(&task_id) {
                Some(slot) => match slot.body.take() {
                    Some(body) => {
                        slot.queued = false;
                        slot.dispatched = true;
                        Some((body, Arc::clone(&slot.cancel)))
                    }
                    None => {
                        // 内部不变量：队列里的任务必有任务体。真发生了就留在 Pending，
                        // 由 `drain` 的 Stalled 守卫显式暴露，而不是假装在跑。
                        slot.queued = false;
                        None
                    }
                },
                None => None,
            };
            let Some((body, cancel)) = taken else {
                continue;
            };
            self.log.record(Decision::Dequeued {
                task_id: task_id.clone(),
            });
            self.spawn_worker(task_id, body, cancel);
            dispatched += 1;
        }
        dispatched
    }

    /// 等待任务终结（无超时）。
    pub fn wait(&mut self, handle: &TaskHandle) -> Result<TaskResult, SchedulerError> {
        match self.wait_timeout(handle, None)? {
            Some(result) => Ok(result),
            None => Err(SchedulerError::Stalled {
                pending: self.pending(),
            }),
        }
    }

    /// 带超时的等待。`timeout = None` 表示一直等。
    ///
    /// 返回 `Ok(None)` 表示"到点了还没终结"（**不是**错误：
    /// 超时是可归因的事实，与"工具坏了"必须分开）。
    /// 返回 `Ok(Some(_))` 时，第二次调用会立即返回同一份结果。
    pub fn wait_timeout(
        &mut self,
        handle: &TaskHandle,
        timeout: Option<Duration>,
    ) -> Result<Option<TaskResult>, SchedulerError> {
        let task_id = handle.task_id.clone();
        if !self.tasks.contains_key(&task_id) {
            return Err(SchedulerError::UnknownTask { task_id });
        }
        if self.lifecycle == SchedulerLifecycle::Running {
            self.pump();
        }
        let deadline = timeout.map(|limit| Instant::now() + limit);
        loop {
            if let Some(result) = self.settle(&task_id)? {
                return Ok(Some(result));
            }
            if self.lifecycle == SchedulerLifecycle::ShutDown {
                // 关停后仍非终态：只可能是内部不变量被破坏。显式报错，不假装"还没好"。
                return Err(SchedulerError::Stalled {
                    pending: self.pending(),
                });
            }
            let slice = match deadline {
                Some(deadline) => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return Ok(None);
                    }
                    remaining.min(MAX_WAIT_SLICE)
                }
                None => MAX_WAIT_SLICE,
            };
            // 先收消息、再回到循环顶部判超时：这样"恰好卡在截止时刻完成"的任务
            // 不会被误报成超时。
            self.drain_completions(Some(slice));
        }
    }

    /// 请求取消（幂等）。
    ///
    /// - 已终态：记 `was_terminal: true`，返回 `Ok(())`，**不改写**已有结论。
    /// - 未派发：从显式队列取走，立即转 `Cancelled` 并释放其作用域。
    /// - 在途：置取消标志并**立即**把状态转 `Cancelled`（`cancel` 即时生效）；
    ///   其登记的释放项要等工作线程收尾后才入栈，因此**释放**发生在收尾之后或关停时。
    ///
    /// # 与完成竞争
    ///
    /// "取消"与"刚好跑完"天然是一场比赛（设计 §6.4：顺序敏感处必须用显式同步点）。
    /// 判定日志会如实记下实际发生的那一种（`was_terminal` 字段），
    /// 要消除这场比赛，调用方需要显式同步点（例如让任务体阻塞在某个门闩上）。
    pub fn cancel(&mut self, handle: &TaskHandle) -> Result<(), SchedulerError> {
        let task_id = handle.task_id.clone();
        let (terminal, dispatched) = {
            let slot = self.slot(&task_id)?;
            (slot.terminal.is_some(), slot.dispatched)
        };
        if terminal {
            self.log.record(Decision::CancelRequested {
                task_id,
                was_terminal: true,
            });
            return Ok(());
        }
        if dispatched {
            if let Some(slot) = self.tasks.get_mut(&task_id) {
                slot.cancel.store(true, Ordering::SeqCst);
                slot.terminal = Some(TerminalSlot {
                    state: TaskState::Cancelled,
                    result: cancelled_result(&task_id, CANCELLED_IN_FLIGHT),
                    finalized: false,
                });
            }
            self.log.record(Decision::CancelRequested {
                task_id,
                was_terminal: false,
            });
            return Ok(());
        }
        self.ready.remove_task(&task_id);
        if let Some(slot) = self.tasks.get_mut(&task_id) {
            slot.queued = false;
            slot.terminal = Some(TerminalSlot {
                state: TaskState::Cancelled,
                result: cancelled_result(&task_id, CANCELLED_BEFORE_START),
                finalized: false,
            });
        }
        self.log.record(Decision::CancelRequested {
            task_id: task_id.clone(),
            was_terminal: false,
        });
        self.finalize_task(&task_id);
        Ok(())
    }

    /// 泵到底并收尾全部任务。返回**本次收尾**的任务数。
    ///
    /// 收尾顺序 = 提交序（`ReleaseStack` 的作用域顺序），因此它是确定的。
    /// 这也是"先 `submit` 一批、最后统一 `drain`"这种用法的正规入口。
    pub fn drain(&mut self) -> Result<usize, SchedulerError> {
        if self.lifecycle == SchedulerLifecycle::ShutDown {
            return Ok(0);
        }
        self.pump();
        while self.pending() > 0 {
            if self.in_flight() == 0 {
                return Err(SchedulerError::Stalled {
                    pending: self.pending(),
                });
            }
            self.drain_completions(None);
        }
        let mut finalized = 0usize;
        for task_id in self.releases.scope_order() {
            let already = self.is_finalized(&task_id);
            self.finalize_task(&task_id);
            if !already && self.is_finalized(&task_id) {
                finalized += 1;
            }
        }
        Ok(finalized)
    }

    /// 状态快照。
    pub fn status(&self) -> SchedulerStatus {
        let mut queued = 0usize;
        let mut in_flight = 0usize;
        let mut finished = 0usize;
        let mut cancelled = 0usize;
        for slot in self.tasks.values() {
            if slot.queued {
                queued += 1;
            }
            if slot.dispatched && !slot.worker_done {
                in_flight += 1;
            }
            match &slot.terminal {
                Some(terminal) if terminal.state == TaskState::Finished => finished += 1,
                Some(_) => cancelled += 1,
                None => {}
            }
        }
        SchedulerStatus {
            lifecycle: self.lifecycle,
            seed: self.config.seed(),
            submitted: self.tasks.len(),
            queued,
            in_flight,
            finished,
            cancelled,
            released: self.report.released_count(),
            release_failures: self.report.failed_count(),
            pending_releases: self.releases.pending(),
            events: self.log.len(),
            event_hash: self.log.hash(),
        }
    }

    /// 关停（可重复调用）。
    ///
    /// 首次调用：取消未派发与在途任务、等它们在途的工作线程收尾、
    /// 再按 §6.2 **逆序**（提交序的逆序，作用域内登记序的逆序）释放全部作用域。
    /// 重复调用：只记一条 `already_shut_down: true` 与 `ShutdownCompleted { released: 0 }`。
    ///
    /// # 会阻塞的情况（诚实说明）
    ///
    /// Rust 不能安全地强杀线程，所以关停会**等**在途任务体返回。
    /// 一个永不返回、也不看取消标志的任务体会让 `shutdown`（以及 `Drop`）一直等下去。
    /// 这正是设计 §6.3 把"用例之间"放在**多进程**上的原因：
    /// 进程级的强杀由宿主负责，不在本 crate 的职责里。
    pub fn shutdown(&mut self) -> Result<(), SchedulerError> {
        if self.lifecycle == SchedulerLifecycle::ShutDown {
            self.log.record(Decision::ShutdownRequested {
                in_flight: 0,
                already_shut_down: true,
            });
            self.log.record(Decision::ShutdownCompleted { released: 0 });
            return Ok(());
        }
        let in_flight = self.in_flight();
        self.log.record(Decision::ShutdownRequested {
            in_flight,
            already_shut_down: false,
        });

        // 1) 未派发的任务：按显式出队顺序取消（顺序本身是确定的，不是遍历哈希表的副产品）。
        for task_id in self.ready.order() {
            self.ready.remove_task(&task_id);
            if let Some(slot) = self.tasks.get_mut(&task_id) {
                slot.queued = false;
                slot.terminal = Some(TerminalSlot {
                    state: TaskState::Cancelled,
                    result: cancelled_result(&task_id, CANCELLED_BY_SHUTDOWN_QUEUED),
                    finalized: false,
                });
            }
            self.log.record(Decision::CancelRequested {
                task_id,
                was_terminal: false,
            });
        }

        // 2) 在途任务：置取消标志并立即转 Cancelled（BTreeMap 迭代 ⇒ 任务 id 序）。
        let mut cancelled_in_flight = Vec::new();
        for (task_id, slot) in &mut self.tasks {
            if slot.dispatched && !slot.worker_done && slot.terminal.is_none() {
                slot.cancel.store(true, Ordering::SeqCst);
                slot.terminal = Some(TerminalSlot {
                    state: TaskState::Cancelled,
                    result: cancelled_result(task_id, CANCELLED_BY_SHUTDOWN_IN_FLIGHT),
                    finalized: false,
                });
                cancelled_in_flight.push(task_id.clone());
            }
        }
        for task_id in cancelled_in_flight {
            self.log.record(Decision::CancelRequested {
                task_id,
                was_terminal: false,
            });
        }

        // 3) 收完在途完成：保证工作线程登记的释放项都已入栈（否则关停会漏释放）。
        while self.in_flight() > 0 {
            self.drain_completions(None);
        }

        // 4) 收掉工作线程（此时它们都已发过完成消息）。
        self.join_workers();

        // 5) 按"提交序的逆序"释放全部未释放作用域（§6.2 的逆序释放）。
        let outcomes = self.releases.release_all_reverse();
        let released = outcomes.len();
        self.apply_releases(outcomes);

        // 6) 第 5 步已释放所有作用域：把已终态任务统一标记为已收尾。
        for slot in self.tasks.values_mut() {
            if let Some(terminal) = slot.terminal.as_mut() {
                terminal.finalized = true;
            }
        }

        self.log.record(Decision::ShutdownCompleted { released });
        self.lifecycle = SchedulerLifecycle::ShutDown;
        Ok(())
    }

    // ---- 以下为内部实现 ----

    fn slot(&self, task_id: &TaskId) -> Result<&TaskSlot, SchedulerError> {
        self.tasks
            .get(task_id)
            .ok_or_else(|| SchedulerError::UnknownTask {
                task_id: task_id.clone(),
            })
    }

    fn is_finalized(&self, task_id: &TaskId) -> bool {
        match self
            .tasks
            .get(task_id)
            .and_then(|slot| slot.terminal.as_ref())
        {
            Some(terminal) => terminal.finalized,
            None => false,
        }
    }

    /// 若任务已终结则返回结果（并顺带收尾）；否则 `Ok(None)`。
    fn settle(&mut self, task_id: &TaskId) -> Result<Option<TaskResult>, SchedulerError> {
        let (terminal, finalized, result) = {
            let slot = self.slot(task_id)?;
            let terminal = slot.state().is_terminal();
            let (finalized, result) = match slot.terminal.as_ref() {
                Some(terminal) => (terminal.finalized, Some(terminal.result.clone())),
                None => (false, None),
            };
            (terminal, finalized, result)
        };
        if !terminal {
            return Ok(None);
        }
        if !finalized {
            self.finalize_task(task_id);
        }
        Ok(result)
    }

    /// 收尾一个任务（幂等）：释放它的作用域，并把结果记进报告与判定日志。
    ///
    /// 只在"工作线程已收尾"或"从未派发"时才动手 —— 否则会漏掉
    /// 任务体**之后**才登记的释放项（那些条目还没进栈）。
    fn finalize_task(&mut self, task_id: &TaskId) {
        let ready = match self.tasks.get(task_id) {
            Some(slot) => {
                let has_unfinished_terminal = match slot.terminal.as_ref() {
                    Some(terminal) => !terminal.finalized,
                    None => false,
                };
                has_unfinished_terminal && (slot.worker_done || !slot.dispatched)
            }
            None => false,
        };
        if !ready {
            return;
        }
        let outcomes = self.releases.release_task(task_id);
        self.apply_releases(outcomes);
        if let Some(slot) = self.tasks.get_mut(task_id) {
            if let Some(terminal) = slot.terminal.as_mut() {
                terminal.finalized = true;
            }
        }
    }

    fn spawn_worker(&mut self, task_id: TaskId, body: Box<dyn TaskBody>, cancel: Arc<AtomicBool>) {
        let sender = self.completion_tx.clone();
        let worker_task_id = task_id.clone();
        let started = Instant::now();
        let spawned = thread::Builder::new()
            .name(format!("dsh-testkit-task-{}", task_id.0))
            .spawn(move || {
                let context = ExecutionContext::new(worker_task_id.clone(), cancel);
                // 任务体 panic 必须变成**结论**（Errored），不能变成"永远等不到的消息"：
                // 否则 `wait` 会挂死，而挂死是最难归因的失败形态。
                let output = match catch_unwind(AssertUnwindSafe(|| body.run(&context))) {
                    Ok(output) => output,
                    Err(payload) => TaskOutput::errored(format!(
                        "任务体 panic：{}",
                        panic_message(payload.as_ref())
                    )),
                };
                let releases = context.take_releases();
                let completion = Completion {
                    task_id: worker_task_id,
                    output,
                    releases,
                    duration_ms: elapsed_ms(started),
                };
                let _ = sender.send(completion);
            });
        match spawned {
            Ok(handle) => self.workers.push(handle),
            Err(error) => {
                // 线程创建失败是**可归因的环境故障**：如实变成 Errored，而不是让任务挂在 Running。
                self.terminalize(
                    &task_id,
                    TaskOutput::errored(format!("工作线程创建失败：{error}")),
                );
            }
        }
    }

    /// 直接落到 `Finished`（只用于"工作线程都没起来"这种环境故障）。
    fn terminalize(&mut self, task_id: &TaskId, output: TaskOutput) {
        if let Some(slot) = self.tasks.get_mut(task_id) {
            if slot.terminal.is_none() {
                slot.terminal = Some(TerminalSlot {
                    state: TaskState::Finished,
                    result: make_result(task_id, output, 0),
                    finalized: false,
                });
            }
        }
    }

    fn apply_completion(&mut self, completion: Completion) {
        let Completion {
            task_id,
            output,
            releases,
            duration_ms,
        } = completion;
        // 观测（判定路径之外的事实）：到达顺序、耗时、时刻都记下来，
        // 但它们**不会**进 `EventLog`，因此不影响 C1。
        let index = self.observations.len() as u64;
        let observed_at_ms = elapsed_ms(self.started_at);
        self.observations.push(Observation {
            index,
            task_id: task_id.clone(),
            outcome: output.outcome,
            duration_ms,
            observed_at_ms,
        });
        let dropped = self.releases.attach(&task_id, releases);
        self.apply_dropped_releases(&task_id, dropped);
        if let Some(slot) = self.tasks.get_mut(&task_id) {
            slot.worker_done = true;
            if slot.terminal.is_none() {
                slot.terminal = Some(TerminalSlot {
                    state: TaskState::Finished,
                    result: make_result(&task_id, output, duration_ms),
                    finalized: false,
                });
            }
            // 已终态（例如已被取消）时**不改写**结果：契约 2 要求重复 `wait`
            // 得到同一份结果，而任务体"最终返回了什么"只能进观测日志。
        }
    }

    /// 收一条完成消息；返回是否收到。
    ///
    /// `timeout = None` 表示"一定有在途工作线程，等到为止"（调用方负责保证）。
    fn drain_completions(&mut self, timeout: Option<Duration>) -> bool {
        let received = match timeout {
            Some(limit) => self.completion_rx.recv_timeout(limit),
            None => self
                .completion_rx
                .recv()
                .map_err(|_| RecvTimeoutError::Disconnected),
        };
        match received {
            Ok(completion) => {
                self.apply_completion(completion);
                self.reap_workers();
                true
            }
            Err(_) => false,
        }
    }

    /// 回收已结束的工作线程句柄（避免长生命周期调度器无限堆积 `JoinHandle`）。
    fn reap_workers(&mut self) {
        self.workers.retain(|handle| !handle.is_finished());
    }

    fn join_workers(&mut self) {
        let workers = std::mem::take(&mut self.workers);
        for handle in workers {
            let _ = handle.join();
        }
    }

    fn apply_releases(&mut self, outcomes: Vec<ReleaseOutcome>) {
        for outcome in outcomes {
            match outcome {
                ReleaseOutcome::Released { task_id, resource } => {
                    self.log.record(Decision::Released {
                        task_id: task_id.clone(),
                        resource: resource.clone(),
                    });
                    self.report
                        .released
                        .push(ReleaseRecord { task_id, resource });
                }
                ReleaseOutcome::Failed {
                    task_id,
                    resource,
                    reason,
                } => {
                    self.log.record(Decision::ReleaseFailed {
                        task_id: task_id.clone(),
                        resource: resource.clone(),
                        reason: reason.clone(),
                    });
                    self.report.failed.push(ReleaseFailure {
                        task_id,
                        resource,
                        reason,
                    });
                }
            }
        }
    }

    /// 无法挂上作用域的登记项：**不允许静默**（§6.2 第 2 条），一律记成释放失败。
    fn apply_dropped_releases(&mut self, task_id: &TaskId, dropped: Vec<String>) {
        for resource in dropped {
            let reason = "作用域已释放，登记项无法执行（内部不变量被破坏）".to_owned();
            self.log.record(Decision::ReleaseFailed {
                task_id: task_id.clone(),
                resource: resource.clone(),
                reason: reason.clone(),
            });
            self.report.failed.push(ReleaseFailure {
                task_id: task_id.clone(),
                resource,
                reason,
            });
        }
    }

    fn in_flight(&self) -> usize {
        self.tasks
            .values()
            .filter(|slot| slot.dispatched && !slot.worker_done)
            .count()
    }

    fn pending(&self) -> usize {
        self.tasks
            .values()
            .filter(|slot| slot.terminal.is_none())
            .count()
    }
}

impl TestScheduler for Scheduler {
    fn submit(&mut self, task: TestTask) -> Result<TaskHandle, SchedulerError> {
        Scheduler::submit(self, task)
    }

    fn wait(&mut self, handle: &TaskHandle) -> Result<TaskResult, SchedulerError> {
        Scheduler::wait(self, handle)
    }

    fn cancel(&mut self, handle: &TaskHandle) -> Result<(), SchedulerError> {
        Scheduler::cancel(self, handle)
    }

    fn status(&self) -> SchedulerStatus {
        Scheduler::status(self)
    }

    fn shutdown(&mut self) -> Result<(), SchedulerError> {
        Scheduler::shutdown(self)
    }
}

/// `Drop` 是**兜底**，不是正常路径：它只请求取消并等在途工作线程退出。
///
/// 它**不**释放资源、**不**记事件：此时对象正在销毁，没有观察者，
/// 记录一条没人能读到的"释放成功"是自欺。正常路径必须显式调用
/// [`Scheduler::shutdown`] 或 [`Scheduler::drain`]。
impl Drop for Scheduler {
    fn drop(&mut self) {
        for slot in self.tasks.values() {
            if slot.dispatched && !slot.worker_done {
                slot.cancel.store(true, Ordering::SeqCst);
            }
        }
        let workers = std::mem::take(&mut self.workers);
        for handle in workers {
            let _ = handle.join();
        }
    }
}

/// "在途任务被取消"的结果。
const CANCELLED_IN_FLIGHT: &str =
    "在途任务被取消：工作线程正在收尾，其登记的释放项在收尾入栈后才释放";
/// "派发前被取消"的结果。
const CANCELLED_BEFORE_START: &str = "任务在派发前被取消：从未执行，因此没有耗时读数";
/// "shutdown 取消未派发任务"的结果。
const CANCELLED_BY_SHUTDOWN_QUEUED: &str = "shutdown：任务尚未派发即被取消";
/// "shutdown 取消在途任务"的结果。
const CANCELLED_BY_SHUTDOWN_IN_FLIGHT: &str = "shutdown：在途任务被取消";

fn cancelled_result(task_id: &TaskId, reason: &str) -> TaskResult {
    TaskResult {
        task_id: task_id.clone(),
        outcome: TaskOutcome::Cancelled,
        duration_ms: 0,
        detail: Some(json!({ "reason": reason, "state": "cancelled" })),
    }
}

fn make_result(task_id: &TaskId, output: TaskOutput, duration_ms: u32) -> TaskResult {
    TaskResult {
        task_id: task_id.clone(),
        outcome: output.outcome,
        duration_ms,
        detail: output.detail,
    }
}

/// 墙钟耗时（毫秒）。单位与 `TaskResult::duration_ms` 一致（`u32`，饱和到 `u32::MAX`）。
///
/// 它是**已声明的非确定字段**：只进观测与结果，**不进**事件序列哈希。
fn elapsed_ms(start: Instant) -> u32 {
    u32::try_from(start.elapsed().as_millis()).unwrap_or(u32::MAX)
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<&'static str>() {
        (*text).to_owned()
    } else if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else {
        "非字符串 panic 载荷".to_owned()
    }
}
