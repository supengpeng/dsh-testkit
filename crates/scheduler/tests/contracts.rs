//! 设计 §3.2 的四条句柄契约 + §6.3 的并发模型，逐条对应到一个测试。
//!
//! 命名规则：`contract_<编号>_<断言>`，编号与 `src/lib.rs` 的八条表一一对应。
//! 这样"7 条契约对应到哪个测试"不需要另外维护一份文档。

mod common;

use common::{cooperative, run_sleep_scenario, sleepy, Gate};
use dsh_testkit_scheduler::{
    Decision, EventLog, ExecutionContext, Priority, ReplayError, Scheduler, SchedulerConfig, Seed,
    TaskId, TaskOutcome, TaskOutput, TestTask, TASK_SCOPE_RESOURCE,
};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 契约 1：`submit` **立即**返回句柄、不阻塞；结果只能经 `wait` / 通知获得。
///
/// 三段证据：
/// (a) `submit` 返回时任务**还没开始执行**（任务体自己数的"启动计数器"仍是 0）；
/// (b) `submit` 返回时**没有派发**任何工作线程，也没有结果可拿；
/// (c) 只有 `pump` / `wait` 之后，状态才走到 `Running`，最终经 `wait` 拿到结论。
#[test]
fn contract_01_submit_returns_a_handle_immediately_and_does_not_block() {
    let gate = Gate::new();
    let started = Arc::new(AtomicUsize::new(0));
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(7)));

    let body_started = Arc::clone(&started);
    let body_gate = gate.clone();
    let handle = scheduler
        .submit(TestTask::normal(
            TaskId("t1".into()),
            move |_ctx: &ExecutionContext| {
                body_started.fetch_add(1, Ordering::SeqCst);
                body_gate.wait();
                TaskOutput::passed()
            },
        ))
        .expect("submit 必须返回句柄");

    // (a) 任务体一次都没跑过。若 submit 是阻塞式的（原稿的矛盾写法），这里永远到不了。
    assert_eq!(
        started.load(Ordering::SeqCst),
        0,
        "submit 不得开始执行任务体（它是非阻塞的）"
    );
    // (b) 句柄是"提交那一刻"的快照；任务还在显式队列里，没有工作线程。
    assert_eq!(handle.state, dsh_testkit_scheduler::TaskState::Pending);
    let status = scheduler.status();
    assert_eq!(status.in_flight, 0, "submit 不得派发工作线程");
    assert_eq!(status.queued, 1);
    assert_eq!(status.finished, 0);

    // (c) 派发之后任务真的在跑（阻塞在显式门闩上），而结果只能经 wait 获得。
    assert_eq!(scheduler.pump(), 1);
    assert_eq!(
        scheduler.state_of(&handle.task_id),
        Some(dsh_testkit_scheduler::TaskState::Running)
    );
    assert_eq!(scheduler.status().in_flight, 1);
    assert_eq!(
        scheduler
            .wait_timeout(&handle, Some(Duration::ZERO))
            .expect("wait_timeout 必须成功"),
        None,
        "任务体还没结束，此刻不得有结果"
    );

    gate.open();
    let result = scheduler.wait(&handle).expect("wait 必须成功");
    assert_eq!(result.outcome, TaskOutcome::Passed);
    assert_eq!(started.load(Ordering::SeqCst), 1, "任务体恰好执行一次");
}

/// 契约 2：句柄可被多次 `wait`，第二次起立即返回**同一份**结果。
#[test]
fn contract_02_a_handle_can_be_waited_repeatedly_with_an_identical_result() {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(11)));
    let handle = scheduler
        .submit(TestTask::normal(
            TaskId("t1".into()),
            sleepy(Duration::from_millis(5)),
        ))
        .expect("submit");

    let first = scheduler.wait(&handle).expect("wait");
    let second = scheduler.wait(&handle).expect("wait");
    assert_eq!(
        first, second,
        "第二次 wait 必须逐字段相同（含 duration_ms）——终态结果写定后不得再改"
    );

    let third = scheduler
        .wait_timeout(&handle, Some(Duration::ZERO))
        .expect("wait_timeout")
        .expect("已有结果，必须立即返回");
    assert_eq!(third, first);
    assert_eq!(first.outcome, TaskOutcome::Passed);
}

/// 契约 3：`cancel` 幂等；对已终态句柄返回 `Ok(())` 且**不改写**结论。
#[test]
fn contract_03_cancel_is_idempotent_and_terminal_handles_return_ok() {
    let gate = Gate::new();
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(3)));

    // (a) 派发前取消：从显式队列里取走，立刻是终态，且永远不会被派发。
    let queued = scheduler
        .submit(TestTask::normal(
            TaskId("queued".into()),
            |_ctx: &ExecutionContext| TaskOutput::passed(),
        ))
        .expect("submit");
    scheduler.cancel(&queued).expect("cancel");
    scheduler.cancel(&queued).expect("cancel 必须幂等");
    assert_eq!(
        scheduler.state_of(&queued.task_id),
        Some(dsh_testkit_scheduler::TaskState::Cancelled)
    );
    assert_eq!(
        scheduler.wait(&queued).expect("wait 必须成功").outcome,
        TaskOutcome::Cancelled,
        "取消是一个**正常结论**，不是 Err"
    );
    assert_eq!(scheduler.status().queued, 0, "取消必须把它从显式队列里取走");
    assert_eq!(scheduler.pump(), 0, "已取消的任务不得被派发");

    // (b) 在途取消：用显式同步点保证 cancel 一定发生在 Running 期。
    let body_gate = gate.clone();
    let running = scheduler
        .submit(TestTask::normal(
            TaskId("running".into()),
            move |_ctx: &ExecutionContext| {
                body_gate.wait();
                TaskOutput::passed()
            },
        ))
        .expect("submit");
    scheduler.pump();
    assert_eq!(
        scheduler.state_of(&running.task_id),
        Some(dsh_testkit_scheduler::TaskState::Running)
    );
    scheduler.cancel(&running).expect("cancel");
    scheduler.cancel(&running).expect("cancel 幂等");
    let cancelled = scheduler.wait(&running).expect("wait");
    assert_eq!(cancelled.outcome, TaskOutcome::Cancelled);

    // 任务体随后返回什么都不影响已定的结论：它只能进观测日志。
    gate.open();
    let after = scheduler.wait(&running).expect("wait");
    assert_eq!(after, cancelled, "已终态的结果不得被任务体回写");

    // (c) 已终态再取消：Ok(())，且结论原样。
    let finished = scheduler
        .submit(TestTask::normal(
            TaskId("finished".into()),
            |_ctx: &ExecutionContext| TaskOutput::passed(),
        ))
        .expect("submit");
    let finished_result = scheduler.wait(&finished).expect("wait");
    assert_eq!(finished_result.outcome, TaskOutcome::Passed);
    scheduler
        .cancel(&finished)
        .expect("对已终态句柄 cancel 必须返回 Ok(())");
    scheduler
        .cancel(&finished)
        .expect("而且可以再来一次（幂等）");
    assert_eq!(
        scheduler.wait(&finished).expect("wait"),
        finished_result,
        "cancel 不得改写已终态结论"
    );

    let _ = scheduler.shutdown();
}

/// 契约 4：`shutdown` 可重复调用；在途任务被取消，并按 §6.2 **逆序**释放。
///
/// 这个测试刻意让"显式优先级顺序"与"提交序"**相反**：
/// 出队顺序是 `t1 → t2 → t3`，而释放顺序必须是 `t3 → t2 → t1`（提交序的逆序）。
/// 如果实现不小心拿"出队/完成顺序"当释放序，这里会立刻红。
#[test]
fn contract_04_shutdown_is_repeatable_and_releases_in_reverse() {
    let order = Arc::new(Mutex::new(Vec::new()));
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(5)));

    for (index, name) in ["t1", "t2", "t3"].iter().enumerate() {
        let resources = vec![format!("{name}-a"), format!("{name}-b")];
        let body = cooperative(Arc::clone(&order), resources, Duration::from_secs(10));
        // 优先级 2/1/0 ⇒ 出队顺序是提交序（t1, t2, t3）。
        scheduler
            .submit(TestTask::new(
                TaskId((*name).to_owned()),
                Priority::new(2 - index as i64),
                body,
            ))
            .expect("submit");
    }

    assert_eq!(scheduler.pump(), 3, "三个任务都必须派发");
    assert_eq!(scheduler.status().in_flight, 3, "关停前它们都在途");

    scheduler.shutdown().expect("首次 shutdown 必须成功");
    // 关停确实取消了在途任务（协作式取消：任务体观察到标志后自行收尾）。
    assert_eq!(scheduler.status().cancelled, 3);
    assert_eq!(
        scheduler
            .event_log()
            .dequeued_order()
            .into_iter()
            .map(|task_id| task_id.0)
            .collect::<Vec<_>>(),
        vec!["t1".to_owned(), "t2".to_owned(), "t3".to_owned()],
        "出队顺序由显式优先级决定"
    );

    assert_eq!(
        *order.lock().expect("记录锁未中毒"),
        vec![
            "t3-b".to_owned(),
            "t3-a".to_owned(),
            "t2-b".to_owned(),
            "t2-a".to_owned(),
            "t1-b".to_owned(),
            "t1-a".to_owned(),
        ],
        "释放必须按「提交序的逆序 + 作用域内登记序的逆序」"
    );

    // 作用域条目在判定日志里的顺序 = 提交序的逆序（可审计，不用只信上面的副作用记录）。
    let scope_order: Vec<String> = scheduler
        .event_log()
        .events()
        .iter()
        .filter_map(|event| match &event.decision {
            Decision::Released { task_id, resource } if resource == TASK_SCOPE_RESOURCE => {
                Some(task_id.0.clone())
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        scope_order,
        vec!["t3".to_owned(), "t2".to_owned(), "t1".to_owned()]
    );

    let report = scheduler.release_report();
    assert_eq!(report.released_count(), 9, "6 条登记项 + 3 个作用域");
    assert_eq!(report.failed_count(), 0);

    // 可重复调用：第二次不得重复释放、不得改变报告。
    scheduler
        .shutdown()
        .expect("第二次 shutdown 必须返回 Ok(())");
    assert_eq!(
        order.lock().expect("记录锁未中毒").len(),
        6,
        "重复 shutdown 不得重复执行 disposer"
    );
    assert_eq!(scheduler.release_report().released_count(), 9);
    let repeated = scheduler
        .event_log()
        .events()
        .iter()
        .filter(|event| {
            matches!(
                &event.decision,
                Decision::ShutdownRequested {
                    already_shut_down: true,
                    ..
                }
            )
        })
        .count();
    assert_eq!(repeated, 1, "重复关停必须被如实记成 already_shut_down");
}

/// 契约 5：出队顺序是 (种子, 显式优先级, 提交序) 的函数，**与线程时序无关**。
#[test]
fn contract_05_queue_order_is_explicit_and_independent_of_thread_timing() {
    // 同一份提交（同种子、同优先级、同 id），只有**耗时模式相反**。
    let fast_first = run_sleep_scenario(21, 0, &[40, 80, 120, 160]); // t01 最快
    let slow_first = run_sleep_scenario(21, 0, &[160, 120, 80, 40]); // t04 最快

    // 先证明两次运行的线程时序**确实**不同，否则下面那条断言是同义反复。
    assert_ne!(
        fast_first.completion_order, slow_first.completion_order,
        "两次运行的完成顺序必须真的不同，否则这条证明没有判别力"
    );
    // 再证明决策序列逐事件相同（比"结果相同"更强）。
    assert_eq!(
        fast_first.log.events(),
        slow_first.log.events(),
        "完成时序不得影响任何一条决策"
    );
    assert_eq!(fast_first.hash, slow_first.hash);
    assert_eq!(fast_first.dequeued, slow_first.dequeued);
}

/// 契约 5（续）：显式优先级**先于**种子的定序作用。
#[test]
fn contract_05_priority_precedes_the_seed_tiebreak() {
    for seed in [1u64, 99] {
        let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(seed)));
        for (name, priority) in [("low", 1i64), ("high", 9), ("mid", 5)] {
            scheduler
                .submit(TestTask::new(
                    TaskId(name.to_owned()),
                    Priority::new(priority),
                    sleepy(Duration::from_millis(1)),
                ))
                .expect("submit");
        }
        scheduler.drain().expect("drain");
        let order: Vec<String> = scheduler
            .event_log()
            .dequeued_order()
            .into_iter()
            .map(|task_id| task_id.0)
            .collect();
        assert_eq!(
            order,
            vec!["high".to_owned(), "mid".to_owned(), "low".to_owned()],
            "种子的作用域只限于同优先级内部（seed={seed}）"
        );
    }
}

/// 契约 6：事件带连续 `seq`；重放按记录的 `seq` 注入，**与注入顺序无关**。
#[test]
fn contract_06_events_carry_contiguous_seq_and_replay_by_recorded_seq() {
    let record = run_sleep_scenario(13, 0, &[5, 5, 5]);
    let log = &record.log;

    // (a) seq 从 1 开始、连续、不重复。
    let seqs: Vec<u64> = log.events().iter().map(|event| event.seq.get()).collect();
    assert_eq!(
        seqs,
        (1..=log.len() as u64).collect::<Vec<u64>>(),
        "判定路径的事件必须带连续的 seq"
    );

    // (b) 重放与注入顺序无关：把记录倒过来注入，得到逐事件相同、哈希相同的日志。
    let mut reversed = log.events().to_vec();
    reversed.reverse();
    let replayed = EventLog::replay(&reversed).expect("重放必须成功");
    assert_eq!(replayed.events(), log.events());
    assert_eq!(replayed.hash(), log.hash());

    // (c) 负向证明：缺口与重复都必须**报错**，而不是补洞继续算哈希。
    let mut gapped = log.events().to_vec();
    gapped.remove(1);
    assert!(matches!(
        EventLog::replay(&gapped),
        Err(ReplayError::Gap { .. })
    ));
    let mut duplicated = log.events().to_vec();
    duplicated.push(log.events()[0].clone());
    assert!(matches!(
        EventLog::replay(&duplicated),
        Err(ReplayError::DuplicateSeq { .. })
    ));
}

/// 同一份提交 + 不同种子/优先级/长度 ⇒ 每条构建一条日志，用于契约 7 的首分叉断言。
fn scenario(seed: u64, priorities: &[i64]) -> EventLog {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(seed)));
    for (index, priority) in priorities.iter().enumerate() {
        scheduler
            .submit(TestTask::new(
                TaskId(format!("t{:02}", index + 1)),
                Priority::new(*priority),
                sleepy(Duration::from_millis(1)),
            ))
            .expect("submit");
    }
    scheduler.drain().expect("drain");
    scheduler.event_log().clone()
}

/// 契约 7：C1 的判据是**事件序列哈希**；分叉时能报出**第一个分叉的 `seq``。
#[test]
fn contract_07_event_sequence_hash_and_first_divergence_seq() {
    let base = scenario(31, &[0, 0, 0, 0]);
    let same = scenario(31, &[0, 0, 0, 0]);
    assert_eq!(base.hash(), same.hash(), "同种子 ⇒ 同哈希");
    assert!(
        base.first_divergence(&same).is_none(),
        "逐事件相同的两条日志不得报分叉"
    );

    // 第 3 个任务的优先级不同：第一个分叉必须**正好**是第 3 条事件（第 3 次 submit）。
    // 这就是"更好定位"：直接给出 seq，而不是只说"结果不同"。
    let changed = scenario(31, &[0, 0, 5, 0]);
    let divergence = base.first_divergence(&changed).expect("必须报出分叉");
    assert_eq!(
        divergence.seq.get(),
        3,
        "必须报**第一个**分叉的位置，而不是最后一个，也不是「结果不同」"
    );
    assert!(divergence.left.is_some() && divergence.right.is_some());
    assert_ne!(base.hash(), changed.hash());

    // 换种子：Submitted 里记的 rank 不同 ⇒ 第一条事件就分叉。
    let other_seed = scenario(32, &[0, 0, 0, 0]);
    let divergence = base.first_divergence(&other_seed).expect("换种子必须分叉");
    assert_eq!(divergence.seq.get(), 1);
    assert_ne!(base.hash(), other_seed.hash());

    // 前缀关系：截取前两条事件（seq 1、2）构成的日志。
    // 分叉点是"较短一方已经没有事件"的那个 seq —— 必须与"两边都有事件但不同"区分开。
    //
    // （不能用"任务更少的场景"来构造前缀：那条更短的运行**自己**也有
    //   Dequeued / Released 事件，seq 3 上两边都有事件。）
    let prefix = EventLog::replay(&base.events()[..2]).expect("截取的前缀必须能重放");
    assert_eq!(prefix.len(), 2);
    let divergence = base.first_divergence(&prefix).expect("前缀关系也是分叉");
    assert_eq!(divergence.seq.get(), 3);
    assert!(divergence.left.is_some(), "左方在该 seq 上有事件");
    assert!(
        divergence.right.is_none(),
        "右方在该 seq 上不存在事件，必须如实报 None"
    );

    // 日志里的任务序列可以独立复算（审计的基础，不依赖 `dequeued_order` 的实现）。
    let first = base
        .task_sequence()
        .first()
        .cloned()
        .expect("至少有 Submitted 事件");
    assert_eq!(first.0, "t01");
}
