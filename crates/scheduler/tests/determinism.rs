//! 确定性的**正向 + 反向**读数（指标 C1）。
//!
//! 这份文件回答两个问题，缺一不可：
//!
//! 1. **同种子 ⇒ 同哈希？**（12 次运行、每轮耗时模式不同 ⇒ 完成时序确实不同）
//! 2. **不同种子 ⇒ 不同顺序？**（否则"确定性"可能是假的 ——
//!    比如实现里根本没有队列，顺序其实是"提交顺序"这个平凡函数）
//!
//! 第 2 条不是多余的：一条"永远相同"的哈希也可以由"根本没排序"产生。
//! 只有"换输入 ⇒ 换输出"才能证明那个哈希是真的在度量某个东西。

mod common;

use dsh_testkit_scheduler::{normalized_result, Decision, NON_DETERMINISTIC_FIELDS};
use std::collections::BTreeSet;

/// C1 正向：同一种子跑 12 次，事件序列哈希必须**全部相同**。
///
/// 每轮把各任务的耗时模式轮转一格，因此"完成顺序"（观测）确实不同；
/// 如果实现让线程时序影响了决策序列，这条测试会红。
#[test]
fn determinism_same_seed_yields_an_identical_event_hash_over_12_runs() {
    const RUNS: usize = 12;
    let base = [40u64, 80, 120, 160];
    let mut hashes = Vec::new();
    let mut completion_orders: BTreeSet<Vec<String>> = BTreeSet::new();

    for run in 0..RUNS {
        let pattern: Vec<u64> = (0..base.len())
            .map(|index| base[(index + run) % base.len()])
            .collect();
        let record = common::run_sleep_scenario(1234, 0, &pattern);
        let completions: Vec<String> = record
            .completion_order
            .iter()
            .map(|task_id| task_id.0.clone())
            .collect();
        let dequeued: Vec<String> = record
            .dequeued
            .iter()
            .map(|task_id| task_id.0.clone())
            .collect();
        println!(
            "run {run:02}: pattern={pattern:?} hash={} dequeued={dequeued:?} completions={completions:?}",
            record.hash.to_hex()
        );
        hashes.push(record.hash);
        completion_orders.insert(completions);
    }

    assert_eq!(hashes.len(), RUNS);
    let first = hashes[0];
    assert!(
        hashes.iter().all(|hash| *hash == first),
        "同种子 12 次必须给出同一个事件序列哈希，实际：{hashes:?}"
    );
    assert!(
        completion_orders.len() >= 2,
        "12 轮的完成时序必须真的不同（否则这条证明是同义反复）：{completion_orders:?}"
    );
    println!(
        "读数：{} 次运行 → 哈希 {} 恒定；完成顺序出现 {} 种（{completion_orders:?}）",
        RUNS,
        first.to_hex(),
        completion_orders.len()
    );
}

/// C1 反向：不同种子必须给出**不同的出队顺序**。
///
/// 这条是"确定性"的判别力证明：如果实现里没有队列（例如直接按提交序执行），
/// 那么 16 个种子只会给出 1 种顺序，本条立刻红。
#[test]
fn determinism_different_seeds_produce_different_dequeue_orders() {
    let mut orders: BTreeSet<Vec<String>> = BTreeSet::new();
    let mut hashes: BTreeSet<u64> = BTreeSet::new();

    for seed in 1u64..=16 {
        let record = common::run_sleep_scenario(seed, 0, &[20, 20, 20, 20]);
        let order: Vec<String> = record
            .dequeued
            .iter()
            .map(|task_id| task_id.0.clone())
            .collect();
        println!(
            "seed={seed:02} hash={} dequeued={order:?}",
            record.hash.to_hex()
        );
        orders.insert(order);
        hashes.insert(record.hash.get());
    }

    assert!(
        orders.len() >= 8,
        "16 个种子必须真的产生多种出队顺序（否则实现里可能根本没有队列）：只有 {} 种",
        orders.len()
    );
    assert!(hashes.len() >= 8, "哈希也必须随种子变化");
    println!(
        "读数：16 个种子 → {} 种出队顺序、{} 个不同哈希",
        orders.len(),
        hashes.len()
    );
}

/// §6.3 措施 3：不可确定者只允许影响**已声明不参与判定**的字段。
///
/// 同种子、相反的耗时模式：观测（完成顺序 / 耗时 / 时刻）**不同**，
/// 而判定日志的规范字节流**逐字节相同**，哈希自然相同。
#[test]
fn determinism_non_deterministic_fields_are_declared_and_excluded_from_the_hash() {
    let fast = common::run_sleep_scenario(7, 0, &[30, 60, 90, 120]);
    let slow = common::run_sleep_scenario(7, 0, &[120, 90, 60, 30]);

    // 观测**确实**不同（它是 I/O 时序的函数）。
    assert_ne!(
        fast.observations.items(),
        slow.observations.items(),
        "两次运行的观测必须真的不同，否则这条证明没有判别力"
    );
    // 判定日志**逐字节**相同（含 seq）。
    assert_eq!(fast.log.canonical_bytes(), slow.log.canonical_bytes());
    assert_eq!(fast.hash, slow.hash);

    // 声明与实现绑在一起：这些字段必须被显式声明为"不参与判定"。
    for needle in [
        "observations[].index",
        "observations[].observed_at_ms",
        "observations[].duration_ms",
        "TaskResult.duration_ms",
    ] {
        assert!(
            NON_DETERMINISTIC_FIELDS.contains(&needle),
            "非确定字段清单缺了 {needle}：清单不完整（指标 C3）就等于声明是假的"
        );
    }

    // C4 的入口：归一化掉已声明字段之后，两次运行的结果逐字段相同。
    let left: Vec<_> = fast.results.iter().map(normalized_result).collect();
    let right: Vec<_> = slow.results.iter().map(normalized_result).collect();
    assert_eq!(left, right, "归一化后必须逐字段相同（C4）");
}

/// 出队顺序必须能**从记录里复算出来** —— 不是"只能相信实现"。
///
/// `Submitted` 决策把出队键的两半（显式优先级与秩）都记了下来，
/// 所以本测试独立地重排一遍，并与 `dequeued_order()` 比对。
#[test]
fn determinism_dequeued_order_is_recomputable_from_the_recorded_keys() {
    let record = common::run_sleep_scenario(77, 0, &[10, 10, 10, 10]);

    let mut keys: Vec<(i64, u64, String)> = Vec::new();
    for event in record.log.events() {
        if let Decision::Submitted {
            task_id,
            priority,
            rank,
        } = &event.decision
        {
            keys.push((priority.get(), *rank, task_id.0.clone()));
        }
    }
    // 独立复算：优先级降序、秩升序。
    keys.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| left.1.cmp(&right.1)));
    let recomputed: Vec<String> = keys.iter().map(|(_, _, id)| id.clone()).collect();
    let actual: Vec<String> = record
        .dequeued
        .iter()
        .map(|task_id| task_id.0.clone())
        .collect();

    assert_eq!(
        recomputed, actual,
        "出队顺序必须能从判定日志里复算，否则日志不足以支撑审计"
    );
    println!("读数：复算顺序 {recomputed:?} == 实际出队 {actual:?}");
}
