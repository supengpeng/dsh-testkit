//! **显式事件队列**：出队顺序由「显式优先级 + 种子派生的秩 + 提交序」决定。
//!
//! **真源**：设计 §6.3 —— "判定路径单线程 + 显式事件队列：出队顺序由「种子 + 显式优先级」
//! 决定，**不由线程池抢占决定**。同种子 ⇒ 同顺序。这是 C1 的**结构**保证。"
//!
//! # 为什么队列的定序键要写死这三段
//!
//! | 段 | 来源 | 作用 |
//! |---|---|---|
//! | `priority` | 调用方**显式**给出 | 唯一的"业务意图"序 |
//! | `rank` | `splitmix64(seed ^ fnv1a64(task_id))` | 同优先级内的**可复现**次序 |
//! | `submit_order` | 调度器单调计数器 | 保底的全序（秩碰撞时不允许出现并列） |
//!
//! 三段都是**纯函数**：与线程、时钟、内存地址、进程启动无关。
//! 实现只依赖 `BTreeSet`（有序），**不使用 `HashMap` / `HashSet` / `RandomState`**
//! （设计 §6.4：它们的迭代顺序每个进程都不同）。

use crate::canonical::{fnv1a64, splitmix64};
use crate::config::Seed;
use dsh_testkit_protocol::message::TaskId;
use std::cmp::Ordering;
use std::collections::BTreeSet;

/// **显式优先级**：数值越大越先出队。
///
/// 定序方向写死在这里，而不是留给调用方"传负数"：
/// 一个方向明确的类型比一个"越大越小由实现决定"的裸 `i64` 更难用错。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Priority(i64);

impl Priority {
    /// 缺省优先级（`0`）。
    pub const NORMAL: Self = Self(0);

    /// 构造。
    pub const fn new(value: i64) -> Self {
        Self(value)
    }

    /// 取值。
    pub const fn get(self) -> i64 {
        self.0
    }
}

/// 出队键：三段定序，**全序无并列**。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QueueKey {
    priority: Priority,
    rank: u64,
    submit_order: u64,
}

impl QueueKey {
    /// 显式优先级。
    pub const fn priority(self) -> Priority {
        self.priority
    }

    /// 种子派生的秩。
    pub const fn rank(self) -> u64 {
        self.rank
    }

    /// 提交序（调度器内单调，从 1 开始）。
    pub const fn submit_order(self) -> u64 {
        self.submit_order
    }
}

impl Ord for QueueKey {
    fn cmp(&self, other: &Self) -> Ordering {
        // 优先级**降序**（数值大者先），秩升序，提交序升序。
        other
            .priority
            .get()
            .cmp(&self.priority.get())
            .then_with(|| self.rank.cmp(&other.rank))
            .then_with(|| self.submit_order.cmp(&other.submit_order))
    }
}

impl PartialOrd for QueueKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 队列条目：键 + 任务。`task_id` 只作最后一段兜底比较，保证全序。
#[derive(Debug, Clone, PartialEq, Eq)]
struct QueueEntry {
    key: QueueKey,
    task_id: TaskId,
}

impl Ord for QueueEntry {
    fn cmp(&self, other: &Self) -> Ordering {
        self.key
            .cmp(&other.key)
            .then_with(|| self.task_id.cmp(&other.task_id))
    }
}

impl PartialOrd for QueueEntry {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 种子派生的秩：**纯函数**，同 `(seed, task_id)` ⇒ 同秩。
pub fn rank_for(seed: Seed, task_id: &TaskId) -> u64 {
    splitmix64(seed.get() ^ fnv1a64(task_id.0.as_bytes()))
}

/// 显式事件队列。
///
/// 用 `BTreeSet` 而不是"排序后的 `Vec`"：插入即有序，且出队是确定的
/// （`pop_first` 取最小键，而最小键的定义完全由 [`QueueKey`] 的 `Ord` 给出）。
#[derive(Debug, Clone, Default)]
pub struct ReadyQueue {
    entries: BTreeSet<QueueEntry>,
}

impl ReadyQueue {
    /// 空队列。
    pub fn new() -> Self {
        Self {
            entries: BTreeSet::new(),
        }
    }

    /// 入队，返回它的出队键（键会被记进判定日志，用于事后复算顺序）。
    pub fn push(
        &mut self,
        task_id: TaskId,
        priority: Priority,
        seed: Seed,
        submit_order: u64,
    ) -> QueueKey {
        let key = QueueKey {
            priority,
            rank: rank_for(seed, &task_id),
            submit_order,
        };
        self.entries.insert(QueueEntry { key, task_id });
        key
    }

    /// 出队：取出当前**最小键**的条目（C1 意义上的"下一条"）。
    pub fn pop_next(&mut self) -> Option<TaskId> {
        self.entries.pop_first().map(|entry| entry.task_id)
    }

    /// 当前下一条（不出队）。
    pub fn peek_next(&self) -> Option<&TaskId> {
        self.entries.iter().next().map(|entry| &entry.task_id)
    }

    /// 取出指定任务（用于"派发前取消"）。
    ///
    /// 复杂度 `O(n)`，因为 `BTreeSet` 的键里没有 `task_id` 索引；
    /// 队列长度是"一次提交批"的量级，换取的是**单一数据结构**与确定性。
    pub fn remove_task(&mut self, task_id: &TaskId) -> bool {
        let target = self
            .entries
            .iter()
            .find(|entry| &entry.task_id == task_id)
            .cloned();
        match target {
            Some(entry) => {
                self.entries.remove(&entry);
                true
            }
            None => false,
        }
    }

    /// 当前队列长度。
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// 当前出队顺序（诊断与读数；**不**改变队列）。
    pub fn order(&self) -> Vec<TaskId> {
        self.entries
            .iter()
            .map(|entry| entry.task_id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str) -> TaskId {
        TaskId(name.to_owned())
    }

    #[test]
    fn explicit_priority_outranks_everything_else() {
        let mut queue = ReadyQueue::new();
        queue.push(id("low"), Priority::new(1), Seed::new(5), 1);
        queue.push(id("high"), Priority::new(9), Seed::new(5), 2);
        assert_eq!(queue.pop_next(), Some(id("high")));
        assert_eq!(queue.pop_next(), Some(id("low")));
        assert_eq!(queue.pop_next(), None);
    }

    #[test]
    fn ties_are_broken_by_the_seed_derived_rank() {
        let tasks = [id("t1"), id("t2"), id("t3")];
        let order_with = |seed: u64| {
            let mut queue = ReadyQueue::new();
            for (index, task_id) in tasks.iter().enumerate() {
                queue.push(
                    task_id.clone(),
                    Priority::NORMAL,
                    Seed::new(seed),
                    index as u64 + 1,
                );
            }
            queue.order()
        };
        assert_eq!(order_with(1), order_with(1), "同种子必须同顺序");
        // 秩是纯函数：换种子的顺序由 rank_for 唯一决定，实现里没有第二处随机源。
        let mut expected: Vec<(&TaskId, u64)> = tasks
            .iter()
            .map(|task_id| (task_id, rank_for(Seed::new(2), task_id)))
            .collect();
        expected.sort_by_key(|(_, rank)| *rank);
        assert_eq!(
            order_with(2),
            expected
                .iter()
                .map(|(id, _)| (*id).clone())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn submit_order_is_the_last_tiebreak_so_the_order_is_total() {
        // 秩由 task_id 派生，正常提交不会碰撞；这里直接构造两个"优先级与秩完全相同"的键，
        // 证明第三段（提交序）确实参与定序 —— 否则并列就是未定义行为，
        // 而"未定义"正是本 crate 最不能接受的东西。
        let early = QueueKey {
            priority: Priority::NORMAL,
            rank: 7,
            submit_order: 1,
        };
        let late = QueueKey {
            priority: Priority::NORMAL,
            rank: 7,
            submit_order: 2,
        };
        assert_ne!(early, late, "并列必须是可区分的（全序，不是偏序）");
        assert!(early < late, "提交序是升序兜底");

        // 优先级是主导项：哪怕秩大得多、提交得晚得多，高优先级仍然先出队。
        let high = QueueKey {
            priority: Priority::new(1),
            rank: u64::MAX,
            submit_order: u64::MAX,
        };
        assert!(high < early);
    }

    #[test]
    fn remove_task_is_selective_and_idempotent() {
        let mut queue = ReadyQueue::new();
        queue.push(id("t1"), Priority::NORMAL, Seed::new(1), 1);
        queue.push(id("t2"), Priority::NORMAL, Seed::new(1), 2);
        assert!(queue.remove_task(&id("t1")));
        assert!(!queue.remove_task(&id("t1")), "重复移除必须是 no-op");
        assert_eq!(queue.order(), vec![id("t2")]);
    }
}
