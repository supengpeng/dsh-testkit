//! `scheduler` —— 测试调度器：**句柄契约 + 单线程判定路径 + 显式事件队列**。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.2（`TestScheduler` 的四条契约）与 §6.3
//! （并发模型 —— **这一节就是本 crate 的规格书**）；`docs/rfc/0001-rust-core-full-rewrite.md`
//! §8.2（Q1：并发与确定性为什么相容）。
//!
//! 跨语言契约**直接用** `crates/protocol` 的 [`TaskId`] / [`TaskState`] / [`TaskHandle`] /
//! [`TaskResult`]，本 crate 不另立一套（它们已经在这里重新导出，方便一处引入）。
//!
//! # 一句话
//!
//! 把并发**限制在 I/O 上**：判定路径单线程 + 显式事件队列，
//! 于是"同种子 ⇒ 同出队顺序 ⇒ 同事件序列哈希"是**结构的推论**，不是实测的结论。
//!
//! # 三层（设计 §6.3 的表，逐行落地）
//!
//! | 层 | 本 crate 的对应物 | 谁决定顺序 |
//! |---|---|---|
//! | I/O（网络 / 文件 / 子进程） | [`TaskBody`] 在**工作线程**上跑 | 不由本 crate 决定（只看"多久拿到结果"） |
//! | 判定路径（调度决策 / 报告写入） | [`Scheduler`] 的 `&mut self` 方法 | **种子 + 显式优先级 + 提交序** |
//! | 用例之间 | 多进程并行（**不在本 crate**） | TS 侧的进程池 |
//!
//! 明确不做：**不追求"单进程内多线程跑一条用例"** —— 那会让顺序变成调度器的函数，
//! C1 必然失守（设计 §6.3 的结论）。
//!
//! # 八条要落地的东西，逐条对应到测试
//!
//! 前四条是设计 §3.2 的契约，后四条是 §6.3 的并发模型。
//!
//! | # | 约束 | 对应测试 |
//! |---|---|---|
//! | 1 | `submit` 立即返回句柄、不阻塞；结果只能经 `wait` / 通知获得 | `contract_01_submit_returns_a_handle_immediately_and_does_not_block` |
//! | 2 | 句柄可被多次 `wait`（第二次起立即返回同一份结果） | `contract_02_a_handle_can_be_waited_repeatedly_with_an_identical_result` |
//! | 3 | `cancel` 幂等；对已终态句柄返回 `Ok(())` | `contract_03_cancel_is_idempotent_and_terminal_handles_return_ok` |
//! | 4 | `shutdown` 可重复；在途任务被取消并按 §6.2 **逆序**释放 | `contract_04_shutdown_is_repeatable_and_releases_in_reverse` |
//! | 5 | 判定路径单线程 + 显式事件队列：顺序 = f(种子, 显式优先级, 提交序)，**不由线程抢占决定** | `contract_05_queue_order_is_explicit_and_independent_of_thread_timing`、`contract_05_priority_precedes_the_seed_tiebreak` |
//! | 6 | 事件带 `seq`，序列可重放（按记录的 `seq` 注入） | `contract_06_events_carry_contiguous_seq_and_replay_by_recorded_seq` |
//! | 7 | C1 判据 = **事件序列哈希**；分叉时报**第一个分叉的 `seq`** | `contract_07_event_sequence_hash_and_first_divergence_seq` |
//! | 8 | 用例之间是多进程并行（**边界**：本 crate 只管单进程内的判定路径顺序） | `contract_08_boundary_has_no_async_runtime_and_no_cross_process_api` |
//!
//! # 为什么哈希是 FNV-1a 而不是 SHA-256
//!
//! 因为两者在本 crate 里**职责不同**：这里的哈希是**变化探测器**
//! （"两次运行的决策序列一样吗"，冲突概率 2⁻⁶⁴ 量级，且失败形态是"疑似分叉"，不是安全事件）；
//! 而防篡改哈希链是 `crates/attest` 的职责（设计 §7.1，SHA-256 + Ed25519），
//! 它要挡的是**故意伪造**。
//!
//! 把安全的哈希函数用在这里只会引入一个与判据无关的依赖；
//! 反过来，把 FNV-1a 用在报告链上则是真错误。**两者不可互换**。
//!
//! # 为什么不用 `loom`（这不是省略，是这个设计让 loom 失去检验对象）
//!
//! `loom` 枚举的是**共享可变状态上的线程交错**。本 crate 里那种交错不存在：
//!
//! - 判定路径的互斥由 `&mut self` 在**类型层**保证（下面那条 `compile_fail` doctest 就是证据）；
//! - 工作线程**不接触** [`EventLog`]，它们只往 `std::sync::mpsc` 写 [`Completion`] 观测；
//! - 观测进的是 [`ObservationLog`]，**不进** [`EventLog::hash`] 的输入。
//!
//! 所以 loom 能枚举的"交错"只剩 `mpsc` 内部的原子操作 —— 那验证的是 std，不是本设计。
//! 真正需要被证明的命题是"**决策序列是 (种子, 显式优先级, 提交序) 的函数，与完成时序无关**"，
//! 而它的判据是构造性的：同一份提交 + 两种**相反**的完成时序（观测序列确实不同）
//! → 决策日志逐字节相同（`tests/determinism.rs` 正向给出这条证据，并且**先**断言
//! "两次的完成顺序确实不同"，否则整条证明就是同义反复）。
//!
//! 反向判据同样重要：**如果哪天实现里出现"两个线程都写 `EventLog`"，
//! 那才是 loom 该上场的地方 —— 而那种设计在 §6.3 下本身就是错的**。
//!
//! # 与设计稿的两处显式偏差（已被 Lead 裁决批准）
//!
//! 1. **同步 API**，没有 `async_trait` / `tokio`：本 crate 的并发是
//!    "单线程事件队列 + 用例间多进程并行"，不需要异步运行时；
//!    引入它只会把"顺序由谁决定"从类型层退回运行时层，与 §6.3 直接冲突。
//! 2. **mutating 方法是 `&mut self`**（设计稿写 `&self` + 内部可变性）。
//!    `&mut self` 让"判定路径单线程"成为**编译器强制**的事实，
//!    而不是"文档里写明的锁语义"。契约本身与设计稿完全一致。
//!
//! 另外 [`Error`](SchedulerError) 只表达"调度器/工具坏了"：**任务被取消不是错误**，
//! `wait` 对已取消句柄返回 `Ok(TaskResult { outcome: TaskOutcome::Cancelled, .. })`
//! （`TaskOutcome` 的 `Cancelled` 变体由 Lead 在 `crates/protocol` 补齐；
//! 与"断言失败不是 `Err`"同源，见设计 §3.1）。
//!
//! # 例
//!
//! ```
//! use dsh_testkit_scheduler::{
//!     ExecutionContext, Priority, Scheduler, SchedulerConfig, Seed, TaskId, TaskOutcome,
//!     TaskOutput, TestTask,
//! };
//!
//! let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(7)));
//!
//! // submit 只入队并返回句柄：不阻塞、也不派发。
//! let high = scheduler
//!     .submit(TestTask::new(
//!         TaskId("high".into()),
//!         Priority::new(9),
//!         |_ctx: &ExecutionContext| TaskOutput::passed(),
//!     ))
//!     .expect("submit");
//! let low = scheduler
//!     .submit(TestTask::normal(TaskId("low".into()), |_ctx: &ExecutionContext| {
//!         TaskOutput::passed()
//!     }))
//!     .expect("submit");
//!
//! // 泵到底并收尾（释放逆序执行）。
//! scheduler.drain().expect("drain");
//!
//! // 出队顺序由显式优先级决定，且可从判定日志复算。
//! let order: Vec<String> = scheduler
//!     .event_log()
//!     .dequeued_order()
//!     .into_iter()
//!     .map(|task_id| task_id.0)
//!     .collect();
//! assert_eq!(order, vec!["high".to_owned(), "low".to_owned()]);
//!
//! // 同一句柄可以重复 wait，拿到的是同一份结果。
//! let first = scheduler.wait(&high).expect("wait");
//! let second = scheduler.wait(&high).expect("wait");
//! assert_eq!(first.outcome, TaskOutcome::Passed);
//! assert_eq!(first, second);
//!
//! assert!(scheduler.wait(&low).is_ok());
//! let _ = scheduler.shutdown();
//! ```
//!
//! # 结构性证据：共享引用上**进不了**判定路径
//!
//! 下面这段**必须编译失败** —— 它证明"判定路径单线程"不是注释，是类型事实
//! （若哪天有人把 `submit` 改回 `&self`，这条 doctest 会**通过**，说明约束丢了）：
//!
//! ```compile_fail
//! use dsh_testkit_scheduler::{
//!     ExecutionContext, Priority, Scheduler, TaskId, TaskOutput, TestTask,
//! };
//!
//! fn submit_through_a_shared_reference(scheduler: &Scheduler) {
//!     let task = TestTask::new(
//!         TaskId("t1".into()),
//!         Priority::NORMAL,
//!         |_ctx: &ExecutionContext| TaskOutput::passed(),
//!     );
//!     // error[E0596]: cannot borrow `*scheduler` as mutable, as it is behind a `&` reference
//!     let _ = scheduler.submit(task);
//! }
//! ```

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::disallowed_types)]

mod canonical;
mod config;
mod error;
mod event;
mod observation;
mod queue;
mod release;
mod scheduler;
mod task;

pub use config::{SchedulerConfig, Seed};
pub use error::SchedulerError;
pub use event::{Decision, Divergence, Event, EventHash, EventLog, EventSeq, ReplayError};
pub use observation::{Observation, ObservationLog, NON_DETERMINISTIC_FIELDS};
pub use queue::{rank_for, Priority, QueueKey, ReadyQueue};
pub use release::{
    RegisteredRelease, ReleaseFailure, ReleaseFn, ReleaseOutcome, ReleaseRecord, ReleaseReport,
    ReleaseStack, TASK_SCOPE_RESOURCE,
};
pub use scheduler::{Scheduler, SchedulerLifecycle, SchedulerStatus, TestScheduler};
pub use task::{normalized_result, ExecutionContext, TaskBody, TaskOutput, TestTask};

// 跨语言契约类型的**重新导出**（不是另立一套）：让调用方一处引入即可。
pub use dsh_testkit_protocol::message::{
    TaskHandle, TaskId, TaskOutcome, TaskResult, TaskState, TaskStatus,
};
