//! **错误路径、生命周期边界与兜底机制**的行为测试（task-24 的 (a) 类缺口）。
//!
//! 这些测试不是为覆盖率写的：它们每一条都断言一个**已文档化但从未被验证**的行为，
//! 而且都能因为实现改错而变红（判别力论证写在每条测试的注释里）。
//!
//! 覆盖的行为清单（全部出自 `src/scheduler.rs` / `src/error.rs` / `src/release.rs`
//! 的公开文档）：
//!
//! | 行为 | 测试 |
//! |---|---|
//! | `DuplicateTaskId` / `ShutDown` / `UnknownTask` 三条错误路径 | `duplicate_task_id…` / `submit_after_shutdown…` / `unknown_handles…` |
//! | 关停后 `pump`/`drain` 是 no-op，但已终结的结果仍可读 | `wait_cancel_and_drain_after_shutdown…` |
//! | `shutdown` 取消**未派发**的任务，顺序 = 显式出队顺序 | `shutdown_cancels_queued_tasks_in_explicit_dequeue_order` |
//! | `wait_timeout` 到点返回 `None`（不是错误） | `wait_timeout_returns_none_when_the_deadline_passes` |
//! | 任务体 panic ⇒ `Errored`（绝不挂死 `wait`） | `task_body_panic_becomes_errored_with_the_panic_message` |
//! | 释放失败**不静默**：报告 + `status` + 判定日志三处可见 | `deferred_release_failure_is_visible…` |
//! | `TestScheduler` 特征对象可用（设计 §3.2 的插件式接口） | `trait_object_exposes_the_whole_interface` |
//! | `Drop` 兜底：请求取消并等在途线程退出 | `drop_without_shutdown_cancels_and_joins_in_flight_workers` |
//! | 观测的规范化视图是到达序的一个**排列**（不丢不重） | `observation_normalized_view_is_a_permutation…` |

mod common;

use common::{sleepy, Gate};
use dsh_testkit_scheduler::{
    Decision, ExecutionContext, Priority, Scheduler, SchedulerConfig, SchedulerError,
    SchedulerLifecycle, Seed, TaskId, TaskOutcome, TaskOutput, TaskState, TestScheduler, TestTask,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn id(name: &str) -> TaskId {
    TaskId(name.to_owned())
}

/// `DuplicateTaskId`：同一个 id 提交两次必须报错（静默覆盖会让结果不可审计）。
///
/// 判别力：把 `submit` 的查重删掉，这条会红（第二次会成功返回句柄）。
#[test]
fn duplicate_task_id_is_rejected_and_named() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(1)));
    let body = || |_ctx: &ExecutionContext| TaskOutput::passed();
    scheduler
        .submit(TestTask::normal(id("t1"), body()))
        .expect("首次提交必须成功");
    let outcome = scheduler.submit(TestTask::normal(id("t1"), body()));
    match outcome {
        Err(SchedulerError::DuplicateTaskId { task_id }) => {
            assert_eq!(task_id, id("t1"));
            let text = SchedulerError::DuplicateTaskId { task_id }.to_string();
            assert!(text.contains("t1"), "诊断信息必须点出是哪个 id：{text}");
        }
        other => panic!("期望 DuplicateTaskId，实际 {other:?}"),
    }
}

/// `ShutDown` + 关停后的只读语义：`wait` / `cancel` 仍可用，`pump` / `drain` 变成 no-op。
///
/// 判别力：把 `wait` 在关停后改成直接报 `ShutDown`，第一条断言会红；
/// 把 `pump` 的关停守卫删掉，`pump()` 会返回 1 而不是 0。
#[test]
fn submit_after_shutdown_and_read_only_after_shutdown() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(2)));
    let handle = scheduler
        .submit(TestTask::normal(id("t1"), sleepy(Duration::from_millis(5))))
        .expect("submit");
    let finished = scheduler.wait(&handle).expect("wait");
    assert_eq!(finished.outcome, TaskOutcome::Passed);

    scheduler.shutdown().expect("shutdown");
    assert_eq!(scheduler.status().lifecycle, SchedulerLifecycle::ShutDown);

    // 关停后：已终结的结果仍必须可读（设计 §3.2 第 2 条不能在关停边界上失效）。
    assert_eq!(scheduler.wait(&handle).expect("关停后仍可 wait"), finished);
    scheduler
        .cancel(&handle)
        .expect("关停后 cancel 仍是幂等 Ok");

    // 关停后：泵点与收尾都是 no-op。
    assert_eq!(scheduler.pump(), 0, "关停后不得派发");
    assert_eq!(scheduler.drain().expect("关停后 drain 必须是 Ok"), 0);

    // 关停后：不再接受提交。
    let rejected = scheduler.submit(TestTask::normal(id("t2"), sleepy(Duration::from_millis(1))));
    match rejected {
        Err(SchedulerError::ShutDown) => {
            assert_eq!(SchedulerError::ShutDown.to_string(), "调度器已关停");
        }
        other => panic!("期望 ShutDown，实际 {other:?}"),
    }
}

/// `UnknownTask`：句柄来自别的调度器（或 id 写错）时，`wait` 与 `cancel` 都必须报错，
/// 且**不能**把它当成"还没好"静默等待。
///
/// 判别力：删掉 `tasks.contains_key` 检查，`wait` 会走成"目标非终态 ⇒ 一直等"，
/// 这条测试会以超时（而不是断言失败）暴露 —— 那正是最贵的失败形态，所以必须显式测。
#[test]
fn unknown_handles_are_rejected_by_wait_and_cancel() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(3)));
    let ghost = dsh_testkit_scheduler::TaskHandle {
        task_id: id("ghost"),
        state: TaskState::Running,
    };
    match scheduler.wait(&ghost) {
        Err(SchedulerError::UnknownTask { task_id }) => {
            assert_eq!(task_id, id("ghost"));
            assert!(SchedulerError::UnknownTask { task_id }
                .to_string()
                .contains("ghost"));
        }
        other => panic!("期望 UnknownTask，实际 {other:?}"),
    }
    assert!(matches!(
        scheduler.cancel(&ghost),
        Err(SchedulerError::UnknownTask { .. })
    ));
    // 关停之后也必须先报 UnknownTask（而不是 ShutDown）—— 检查顺序是契约的一部分。
    scheduler.shutdown().expect("shutdown");
    assert!(matches!(
        scheduler.wait(&ghost),
        Err(SchedulerError::UnknownTask { .. })
    ));
}

/// `shutdown` 必须取消**尚未派发**的任务，且取消顺序 = **显式出队顺序**（不是提交顺序）。
///
/// 判别力：把 `for task_id in self.ready.order()` 换成"按提交序遍历 tasks"，顺序断言会红；
/// 不把队列里的任务取出来，`pump()` 会派发它们（断言 0 会红）。
#[test]
fn shutdown_cancels_queued_tasks_in_explicit_dequeue_order() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(4)));
    // 提交顺序：low(1) → high(5) → mid(3)；显式出队顺序应是 high → mid → low。
    for (name, priority) in [("low", 1i64), ("high", 5), ("mid", 3)] {
        scheduler
            .submit(TestTask::new(
                id(name),
                Priority::new(priority),
                sleepy(Duration::from_millis(1)),
            ))
            .expect("submit");
    }
    assert_eq!(scheduler.status().queued, 3, "还没派发");

    scheduler.shutdown().expect("shutdown");

    let cancel_order: Vec<String> = scheduler
        .event_log()
        .events()
        .iter()
        .filter_map(|event| match &event.decision {
            Decision::CancelRequested {
                task_id,
                was_terminal: false,
            } => Some(task_id.0.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(
        cancel_order,
        vec!["high".to_owned(), "mid".to_owned(), "low".to_owned()],
        "取消未派发任务必须按显式出队顺序，而不是提交顺序"
    );
    assert_eq!(scheduler.pump(), 0, "已取消的任务不得在关停后被派发");
    assert_eq!(scheduler.status().cancelled, 3);
    assert!(
        scheduler.observations().items().is_empty(),
        "从未派发 ⇒ 一条观测都不该有"
    );
    // 释放逆序执行（§6.2）：3 个任务作用域全部释放。
    assert_eq!(scheduler.release_report().released_count(), 3);
}

/// `wait_timeout` 到点返回 `None`（**不是错误**：超时是可归因的事实），
/// 之后仍能正常等到结果。
///
/// 判别力：把 `Ok(None)` 改成 `Err(Stalled)` 或改成一直等，这条会红。
#[test]
fn wait_timeout_returns_none_when_the_deadline_passes() {
    let gate = Gate::new();
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(5)));
    let body_gate = gate.clone();
    let handle = scheduler
        .submit(TestTask::normal(
            id("t1"),
            move |_ctx: &ExecutionContext| {
                body_gate.wait();
                TaskOutput::passed()
            },
        ))
        .expect("submit");

    let started = Instant::now();
    let outcome = scheduler
        .wait_timeout(&handle, Some(Duration::from_millis(60)))
        .expect("超时不是错误");
    let elapsed = started.elapsed();
    assert_eq!(outcome, None, "到点未终结必须返回 None");
    assert!(
        elapsed >= Duration::from_millis(60),
        "必须真的等满超时（实际 {elapsed:?}）"
    );
    assert_eq!(
        scheduler.state_of(&handle.task_id),
        Some(TaskState::Running),
        "超时不得改变任务状态"
    );

    gate.open();
    assert_eq!(
        scheduler.wait(&handle).expect("wait").outcome,
        TaskOutcome::Passed
    );
}

/// 任务体 panic 必须变成 **`Errored` 结论**，而不是"永远等不到的消息"。
///
/// 三种 panic 载荷各测一次（`&'static str` / `String` / 非字符串）：
/// 判别力：删掉 `catch_unwind`，`wait` 会挂死（测试超时暴露）；
/// 只处理 `&str` 而不处理 `String`，第二条会红。
#[test]
fn task_body_panic_becomes_errored_with_the_panic_message() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(6)));
    let literal = scheduler
        .submit(TestTask::normal(id("lit"), |_ctx: &ExecutionContext| {
            panic!("字面量载荷炸了")
        }))
        .expect("submit");
    let formatted = scheduler
        .submit(TestTask::normal(id("fmt"), |_ctx: &ExecutionContext| {
            panic!("格式化载荷炸了：{}", 42)
        }))
        .expect("submit");
    let opaque = scheduler
        .submit(TestTask::normal(id("opaque"), |_ctx: &ExecutionContext| {
            std::panic::panic_any(7u8)
        }))
        .expect("submit");

    for (handle, needle) in [
        (literal, "字面量载荷炸了"),
        (formatted, "格式化载荷炸了：42"),
        (opaque, "非字符串 panic 载荷"),
    ] {
        let result = scheduler.wait(&handle).expect("panic 不得让 wait 挂死");
        assert_eq!(
            result.outcome,
            TaskOutcome::Errored,
            "任务体 panic 是**执行期错误**，不是断言失败"
        );
        let rendered = format!("{:?}", result.detail);
        assert!(
            rendered.contains(needle),
            "取证细节必须保留 panic 原因（期望含 {needle}，实际 {rendered}）"
        );
    }
    assert_eq!(scheduler.status().finished, 3);
    assert_eq!(scheduler.status().cancelled, 0);
}

/// 释放失败**不静默**（§6.2 第 2 条）：报告、`status()`、判定日志三处都必须看得见。
///
/// 判别力：把 `apply_releases` 的失败分支去掉，三条断言同时红。
#[test]
fn deferred_release_failure_is_visible_in_report_status_and_log() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(7)));
    let handle = scheduler
        .submit(TestTask::normal(id("t1"), |ctx: &ExecutionContext| {
            ctx.on_release("boom", || Err("夹具炸了".to_owned()));
            ctx.on_release("ok", || Ok(()));
            TaskOutput::passed()
        }))
        .expect("submit");
    let result = scheduler.wait(&handle).expect("wait");
    assert_eq!(
        result.outcome,
        TaskOutcome::Passed,
        "释放失败不改写任务结论"
    );

    let report = scheduler.release_report();
    assert_eq!(report.failed_count(), 1, "失败必须进报告");
    assert_eq!(report.failed[0].resource, "boom");
    assert_eq!(report.failed[0].reason, "夹具炸了");
    assert!(report.has_failures());
    // 成功的是 1 个登记项 + 1 个作用域条目。
    assert_eq!(report.released_count(), 2);
    assert_eq!(scheduler.status().release_failures, 1);
    assert!(scheduler.event_log().events().iter().any(|event| matches!(
        &event.decision,
        Decision::ReleaseFailed { resource, reason, .. }
            if resource == "boom" && reason == "夹具炸了"
    )));
}

/// `TestScheduler` 的特征对象必须覆盖全部五个方法（设计 §3.2 的插件式接口）。
///
/// 判别力：任一特征方法的转发写错（例如 `wait` 调到 `cancel`），这条会红。
#[test]
fn trait_object_exposes_the_whole_interface() {
    let mut scheduler: Box<dyn TestScheduler> =
        Box::new(Scheduler::new(SchedulerConfig::new(Seed::new(8))));
    let handle = scheduler
        .submit(TestTask::normal(id("t1"), sleepy(Duration::from_millis(5))))
        .expect("特征对象的 submit");
    assert_eq!(
        scheduler.wait(&handle).expect("特征对象的 wait").outcome,
        TaskOutcome::Passed
    );
    let status = scheduler.status();
    assert_eq!(status.finished, 1);
    assert_eq!(status.seed, Seed::new(8));
    scheduler.cancel(&handle).expect("特征对象的 cancel");
    scheduler.shutdown().expect("特征对象的 shutdown");
    assert!(scheduler.status().events > 0, "判定日志必须有内容");
}

/// `Drop` 是兜底：它必须**请求取消**并**等在途线程退出**（否则线程泄漏）。
///
/// 判别力：把 `Drop` 里的 `cancel.store(true)` 删掉，任务体会一直转到 30s 预算耗尽，
/// `elapsed < 5s` 与 `observed == true` 两条断言都会红（而且是**慢**红，能看出差别）。
#[test]
fn drop_without_shutdown_cancels_and_joins_in_flight_workers() {
    let observed = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&observed);
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(9)));
    scheduler
        .submit(TestTask::normal(id("t1"), move |ctx: &ExecutionContext| {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !ctx.is_cancelled() {
                if Instant::now() >= deadline {
                    return TaskOutput::errored("在预算内没有等到取消请求");
                }
                std::thread::sleep(Duration::from_millis(2));
            }
            flag.store(true, Ordering::SeqCst);
            TaskOutput::cancelled("Drop 兜底取消了任务")
        }))
        .expect("submit");
    assert_eq!(scheduler.pump(), 1, "派发到工作线程上");

    let started = Instant::now();
    drop(scheduler);
    let elapsed = started.elapsed();

    assert!(
        observed.load(Ordering::SeqCst),
        "Drop 必须请求取消（否则任务体只能等自己的预算）"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "Drop 必须等在途线程退出（实际 {elapsed:?}）"
    );
}

/// `drain` 的返回值是"**本次**收尾的任务数"，因此第二次调用必须是 `0`（幂等）。
///
/// 判别力：把 `drain` 的计数改成"终态任务总数"，第二次会返回 2 而不是 0；
/// 把收尾做成非幂等，`release_report` 会重复累加。
#[test]
fn drain_is_idempotent_and_reports_only_newly_finalized_tasks() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(11)));
    for name in ["t1", "t2"] {
        scheduler
            .submit(TestTask::normal(id(name), sleepy(Duration::from_millis(1))))
            .expect("submit");
    }
    assert_eq!(scheduler.drain().expect("首次 drain"), 2);
    let released = scheduler.release_report().released_count();
    assert_eq!(released, 2, "每个任务一个作用域条目");
    assert_eq!(
        scheduler.drain().expect("第二次 drain"),
        0,
        "已经收尾过的任务不得再次计数"
    );
    assert_eq!(
        scheduler.release_report().released_count(),
        released,
        "重复收尾不得重复释放"
    );
}

/// 观测的**规范化视图**必须是到达序的一个排列：同一批观测、同一个集合、不同顺序。
///
/// 判别力：`sorted_by_task` 里若用了 `filter` 而不是 `sort`（丢掉一些观测），
/// 集合比较会红 —— 这正是"归一化不得掩盖差异"（指标 C4/A5）在观测层的镜像。
#[test]
fn observation_normalized_view_is_a_permutation_of_the_arrival_order() {
    // 耗时倒序：完成顺序（到达序）与 task_id 升序**不同**，否则这条测试没有判别力。
    let record = common::run_sleep_scenario(10, 0, &[160, 120, 80, 40]);
    let arrival: Vec<String> = record
        .completion_order
        .iter()
        .map(|task_id| task_id.0.clone())
        .collect();
    let normalized: Vec<String> = record
        .observations
        .sorted_by_task()
        .iter()
        .map(|observation| observation.task_id.0.clone())
        .collect();

    assert_ne!(arrival, normalized, "两种视图必须真的不同顺序");
    assert_eq!(
        normalized,
        vec![
            "t01".to_owned(),
            "t02".to_owned(),
            "t03".to_owned(),
            "t04".to_owned()
        ],
        "规范化视图按 task_id 升序"
    );
    let mut sorted_arrival = arrival.clone();
    sorted_arrival.sort();
    assert_eq!(
        sorted_arrival, normalized,
        "规范化视图必须是到达序的排列（不丢、不重）"
    );
    assert_eq!(record.observations.len(), 4);
    assert!(!record.observations.is_empty());
}
