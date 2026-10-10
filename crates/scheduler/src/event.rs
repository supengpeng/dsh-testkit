//! 判定路径上的**事件序列**：`seq` + 决策 + 事件序列哈希 + 首分叉定位。
//!
//! **真源**：设计 §6.3 的三条使能措施。
//!
//! 1. **事件序列可重放**：所有进入判定路径的事件带 `seq`，重放按记录的 `seq` 注入
//!    （见 [`EventLog::replay`]）。
//! 2. **C1 的判据是「事件序列哈希相同」**（比"结果相同"更强），不一致时直接报出
//!    **第一个分叉的 `seq`**（见 [`EventLog::first_divergence`]），而不是只说"结果不同"。
//! 3. **不可确定者必须移出判定路径**：本模块**只**承载判定事件；
//!    工作线程的完成顺序等不可确定输入进 `crate::observation`，**不参与哈希**。
//!
//! # 为什么 `EventLog` 的追加入口是 `pub(crate)`
//!
//! 因为"只有一个线程能写判定日志"是本 crate 的核心约束（设计 §6.3）：
//! 对外只暴露**读**（[`EventLog::events`] / [`EventLog::hash`] / [`EventLog::first_divergence`]），
//! 追加只发生在 [`crate::Scheduler`] 的 `&mut self` 方法里 —— 由类型系统保证单写者。
//! 如果哪天代码里出现"两个线程都写 `EventLog`"，那**不是**需要 `loom` 的场景，
//! 而是设计违反 §6.3 的信号（见 `lib.rs` 的"为什么不用 loom"）。

use crate::canonical::{fnv1a64, put_bool, put_i64, put_str, put_u64, put_u8};
use crate::queue::Priority;
use dsh_testkit_protocol::message::TaskId;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

/// 事件序号：判定路径内的**全序身份**，从 1 开始、连续、不重复。
///
/// 连续性不是"好看"：它是"序列没有缺口"的可检查形式。
/// 重放时若有缺口（丢了事件）或重复（记了两次），[`EventLog::replay`] 必须报错，
/// 而不是补一个空洞继续算哈希 —— 补洞会让两条**不同**的序列算出一个相同的哈希。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct EventSeq(u64);

impl EventSeq {
    /// 第一条事件的序号。
    pub const FIRST: Self = Self(1);

    /// 取值（从 1 开始）。
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for EventSeq {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "#{}", self.0)
    }
}

/// 判定路径上的一条**决策**（设计 §6.3 的"调度决策"）。
///
/// 这里**只有调度器自己的决定**：入队、出队、取消、释放、关停。
/// 工作线程的完成（"谁先跑完"）**不在这里** —— 它是观测（[`crate::Observation`]），
/// 因为它不可确定，而设计 §6.3 措施 3 要求不可确定者只能影响**已声明不参与判定**的字段。
///
/// `#[non_exhaustive]`：新增决策类型不构成下游破坏性变更（与 `protocol` 的序列化纪律一致）。
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Decision {
    /// 任务被接受并入队（记录出队键的两个输入：显式优先级与种子派生的秩）。
    Submitted {
        /// 任务 id。
        task_id: TaskId,
        /// 显式优先级（数值越大越先出队）。
        priority: Priority,
        /// 种子派生的秩（只用于同优先级内的定序）。
        rank: u64,
    },
    /// 任务**出队**（从显式事件队列取走，交给工作线程去跑 I/O）。
    Dequeued {
        /// 任务 id。
        task_id: TaskId,
    },
    /// 收到取消请求。
    CancelRequested {
        /// 任务 id。
        task_id: TaskId,
        /// 请求到达时任务**是否已经处于终态**（幂等路径为 `true`）。
        ///
        /// 这个字段存在的意义是**可审计**：`cancel` 与任务完成天然是一场比赛
        /// （设计 §6.4：顺序敏感处必须用显式同步点）。把它如实记下来，
        /// 比"两种情况看起来一样"更容易在归因时区分。
        was_terminal: bool,
    },
    /// 一个释放作用域内的登记项被**成功**释放。
    Released {
        /// 任务 id。
        task_id: TaskId,
        /// 资源名（作用域本身用 [`crate::TASK_SCOPE_RESOURCE`]）。
        resource: String,
    },
    /// 释放失败。**不静默**（设计 §6.2 第 2 条）：它既进判定日志，也进 `ReleaseReport`。
    ReleaseFailed {
        /// 任务 id。
        task_id: TaskId,
        /// 资源名。
        resource: String,
        /// 失败原因（`Err(String)` 的原文）。
        reason: String,
    },
    /// 收到关停请求。
    ShutdownRequested {
        /// 收到请求时仍在途（已派发、未收尾）的任务数。
        in_flight: usize,
        /// 是否是对已关停调度器的**重复**调用。
        already_shut_down: bool,
    },
    /// 关停收尾完成。
    ShutdownCompleted {
        /// 本次关停释放的登记项数。
        released: usize,
    },
}

impl Decision {
    /// 决策的种类名（稳定字符串，用于报告与守卫；**不用 `Debug`**）。
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Submitted { .. } => "submitted",
            Self::Dequeued { .. } => "dequeued",
            Self::CancelRequested { .. } => "cancel_requested",
            Self::Released { .. } => "released",
            Self::ReleaseFailed { .. } => "release_failed",
            Self::ShutdownRequested { .. } => "shutdown_requested",
            Self::ShutdownCompleted { .. } => "shutdown_completed",
        }
    }

    /// 该决策所属的任务（关停类决策没有任务）。
    pub fn task_id(&self) -> Option<&TaskId> {
        match self {
            Self::Submitted { task_id, .. }
            | Self::Dequeued { task_id }
            | Self::CancelRequested { task_id, .. }
            | Self::Released { task_id, .. }
            | Self::ReleaseFailed { task_id, .. } => Some(task_id),
            Self::ShutdownRequested { .. } | Self::ShutdownCompleted { .. } => None,
        }
    }

    /// 追加该决策的规范字节编码（配合 [`EventLog::canonical_bytes`]）。
    fn encode(&self, out: &mut Vec<u8>) {
        match self {
            Self::Submitted {
                task_id,
                priority,
                rank,
            } => {
                put_u8(out, 1);
                put_str(out, &task_id.0);
                put_i64(out, priority.get());
                put_u64(out, *rank);
            }
            Self::Dequeued { task_id } => {
                put_u8(out, 2);
                put_str(out, &task_id.0);
            }
            Self::CancelRequested {
                task_id,
                was_terminal,
            } => {
                put_u8(out, 3);
                put_str(out, &task_id.0);
                put_bool(out, *was_terminal);
            }
            Self::Released { task_id, resource } => {
                put_u8(out, 4);
                put_str(out, &task_id.0);
                put_str(out, resource);
            }
            Self::ReleaseFailed {
                task_id,
                resource,
                reason,
            } => {
                put_u8(out, 5);
                put_str(out, &task_id.0);
                put_str(out, resource);
                put_str(out, reason);
            }
            Self::ShutdownRequested {
                in_flight,
                already_shut_down,
            } => {
                put_u8(out, 6);
                put_u64(out, *in_flight as u64);
                put_bool(out, *already_shut_down);
            }
            Self::ShutdownCompleted { released } => {
                put_u8(out, 7);
                put_u64(out, *released as u64);
            }
        }
    }

    /// 单条决策的规范字节编码（诊断用；整条日志的编码见 [`EventLog::canonical_bytes`]）。
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode(&mut out);
        out
    }
}

impl fmt::Display for Decision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Submitted {
                task_id,
                priority,
                rank,
            } => write!(
                formatter,
                "submitted({}, priority={}, rank={rank:#018x})",
                task_id.0,
                priority.get()
            ),
            Self::Dequeued { task_id } => write!(formatter, "dequeued({})", task_id.0),
            Self::CancelRequested {
                task_id,
                was_terminal,
            } => write!(
                formatter,
                "cancel_requested({}, was_terminal={was_terminal})",
                task_id.0
            ),
            Self::Released { task_id, resource } => {
                write!(formatter, "released({}, {resource})", task_id.0)
            }
            Self::ReleaseFailed {
                task_id,
                resource,
                reason,
            } => write!(
                formatter,
                "release_failed({}, {resource}, {reason})",
                task_id.0
            ),
            Self::ShutdownRequested {
                in_flight,
                already_shut_down,
            } => write!(
                formatter,
                "shutdown_requested(in_flight={in_flight}, already_shut_down={already_shut_down})"
            ),
            Self::ShutdownCompleted { released } => {
                write!(formatter, "shutdown_completed(released={released})")
            }
        }
    }
}

/// 带序号的事件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    /// 序号。
    pub seq: EventSeq,
    /// 决策。
    pub decision: Decision,
}

impl fmt::Display for Event {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} {}", self.seq, self.decision)
    }
}

/// 判定路径日志：**唯一**的 C1 判据来源。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EventLog {
    events: Vec<Event>,
}

impl EventLog {
    /// 空日志。
    pub fn new() -> Self {
        Self { events: Vec::new() }
    }

    /// 追加一条决策，返回它的 `seq`（从 1 开始连续）。
    ///
    /// `pub(crate)`：见模块头"为什么追加入口是 `pub(crate)`"。
    pub(crate) fn record(&mut self, decision: Decision) -> EventSeq {
        let seq = EventSeq(self.events.len() as u64 + 1);
        self.events.push(Event { seq, decision });
        seq
    }

    /// 全部事件（按 `seq` 升序）。
    pub fn events(&self) -> &[Event] {
        &self.events
    }

    /// 事件条数。
    pub fn len(&self) -> usize {
        self.events.len()
    }

    /// 是否为空。
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    /// 下一条事件的 `seq`（= 已记录条数 + 1）。
    pub fn next_seq(&self) -> EventSeq {
        EventSeq(self.events.len() as u64 + 1)
    }

    /// **出队顺序**（判定路径的核心读数：同种子 ⇒ 同顺序）。
    pub fn dequeued_order(&self) -> Vec<TaskId> {
        self.events
            .iter()
            .filter_map(|event| match &event.decision {
                Decision::Dequeued { task_id } => Some(task_id.clone()),
                _ => None,
            })
            .collect()
    }

    /// 每条带任务的决策所对应的任务 id（按 `seq` 顺序）。
    pub fn task_sequence(&self) -> Vec<TaskId> {
        self.events
            .iter()
            .filter_map(|event| event.decision.task_id().cloned())
            .collect()
    }

    /// 规范字节编码：**整条日志**（含每条事件的 `seq`）逐字节稳定的表示。
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        put_u64(&mut out, self.events.len() as u64);
        for event in &self.events {
            put_u64(&mut out, event.seq.get());
            event.decision.encode(&mut out);
        }
        out
    }

    /// 事件序列哈希 —— **C1 的判据**（"同种子 ⇒ 同哈希"）。
    pub fn hash(&self) -> EventHash {
        EventHash(fnv1a64(&self.canonical_bytes()))
    }

    /// 第一个分叉的位置（设计 §6.3 措施 2）。
    ///
    /// 返回 `None` 表示两条日志逐事件相同。
    /// 否则返回**第一个 `seq` 上不同（或一方缺失）的事件** ——
    /// 这正是"直接报第一个分叉的位置，而不是只说结果不同"。
    pub fn first_divergence(&self, other: &Self) -> Option<Divergence> {
        let left: BTreeMap<u64, &Decision> = self
            .events
            .iter()
            .map(|event| (event.seq.get(), &event.decision))
            .collect();
        let right: BTreeMap<u64, &Decision> = other
            .events
            .iter()
            .map(|event| (event.seq.get(), &event.decision))
            .collect();
        let mut seqs: BTreeSet<u64> = left.keys().copied().collect();
        seqs.extend(right.keys().copied());
        for seq in seqs {
            let left_decision = left.get(&seq).copied();
            let right_decision = right.get(&seq).copied();
            if left_decision != right_decision {
                return Some(Divergence {
                    seq: EventSeq(seq),
                    left: left_decision.cloned(),
                    right: right_decision.cloned(),
                });
            }
        }
        None
    }

    /// **重放**：按记录的 `seq` 注入，重建同一条日志。
    ///
    /// 关键性质（`tests/contracts.rs` 验证）：
    /// - **与注入顺序无关**：把记录打乱后重放，得到逐事件相同、哈希相同的日志。
    /// - **缺口与重复必须报错**：`seq` 不连续说明记录不完整，
    ///   此时"补洞继续算哈希"会掩盖"序列真的不同"这一事实。
    pub fn replay(recorded: &[Event]) -> Result<Self, ReplayError> {
        let mut by_seq: BTreeMap<u64, Decision> = BTreeMap::new();
        for event in recorded {
            if by_seq
                .insert(event.seq.get(), event.decision.clone())
                .is_some()
            {
                return Err(ReplayError::DuplicateSeq {
                    seq: event.seq.get(),
                });
            }
        }
        let mut events = Vec::with_capacity(by_seq.len());
        for (expected, (seq, decision)) in (1u64..).zip(by_seq) {
            if seq != expected {
                return Err(ReplayError::Gap {
                    expected,
                    found: seq,
                });
            }
            events.push(Event {
                seq: EventSeq(seq),
                decision,
            });
        }
        Ok(Self { events })
    }
}

/// 事件序列哈希（FNV-1a 64）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct EventHash(u64);

impl EventHash {
    /// 构造（一般来自 [`EventLog::hash`]）。
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// 取值。
    pub const fn get(self) -> u64 {
        self.0
    }

    /// 小写 16 位十六进制（报告里贴读数用 —— 十进制不便于目视比对）。
    pub fn to_hex(self) -> String {
        format!("{:016x}", self.0)
    }
}

impl fmt::Display for EventHash {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.to_hex())
    }
}

/// 第一条分叉（设计 §6.3 措施 2 的"更好定位"）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Divergence {
    /// 分叉发生（或一方缺失）的 `seq`。
    pub seq: EventSeq,
    /// 左侧在该 `seq` 上的决策（`None` = 左侧更短，已结束）。
    pub left: Option<Decision>,
    /// 右侧在该 `seq` 上的决策（`None` = 右侧更短，已结束）。
    pub right: Option<Decision>,
}

impl fmt::Display for Divergence {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let describe = |decision: &Option<Decision>| match decision {
            Some(decision) => decision.to_string(),
            None => "<序列在此结束>".to_owned(),
        };
        write!(
            formatter,
            "第一处分歧在 {}：左 = {}，右 = {}",
            self.seq,
            describe(&self.left),
            describe(&self.right)
        )
    }
}

/// 重放失败：记录本身不完整或不合法。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReplayError {
    /// 同一个 `seq` 出现了多次。
    DuplicateSeq {
        /// 重复的序号。
        seq: u64,
    },
    /// 序号不连续（缺事件，或不是从 1 开始）。
    Gap {
        /// 期望的序号。
        expected: u64,
        /// 实际拿到的序号。
        found: u64,
    },
}

impl fmt::Display for ReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateSeq { seq } => write!(formatter, "重放失败：序号 #{seq} 重复"),
            Self::Gap { expected, found } => write!(
                formatter,
                "重放失败：序号不连续，期望 #{expected}，实际 #{found}"
            ),
        }
    }
}

impl std::error::Error for ReplayError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn submitted(id: &str) -> Decision {
        Decision::Submitted {
            task_id: TaskId(id.to_owned()),
            priority: Priority::NORMAL,
            rank: 0,
        }
    }

    fn log_of(ids: &[&str]) -> EventLog {
        let mut log = EventLog::new();
        for id in ids {
            log.record(submitted(id));
        }
        log
    }

    #[test]
    fn seq_starts_at_one_and_is_contiguous() {
        let log = log_of(&["t1", "t2", "t3"]);
        let seqs: Vec<u64> = log.events().iter().map(|event| event.seq.get()).collect();
        assert_eq!(seqs, vec![1, 2, 3]);
        assert_eq!(log.next_seq(), EventSeq(4));
    }

    #[test]
    fn hash_is_a_pure_function_of_the_decisions() {
        assert_eq!(log_of(&["t1", "t2"]).hash(), log_of(&["t1", "t2"]).hash());
        assert_ne!(log_of(&["t1", "t2"]).hash(), log_of(&["t2", "t1"]).hash());
    }

    #[test]
    fn first_divergence_reports_the_earliest_seq_not_the_result() {
        let left = log_of(&["t1", "t2", "t3"]);
        let right = log_of(&["t1", "t9", "t3"]);
        let divergence = left.first_divergence(&right).expect("第二条就不同");
        assert_eq!(divergence.seq.get(), 2, "必须报最早的，不是最晚的");
        assert!(left.first_divergence(&left.clone()).is_none());
    }

    #[test]
    fn first_divergence_handles_a_prefix_relationship() {
        let long = log_of(&["t1", "t2"]);
        let short = log_of(&["t1"]);
        let divergence = long.first_divergence(&short).expect("短的一方提前结束");
        assert_eq!(divergence.seq.get(), 2);
        assert!(divergence.left.is_some());
        assert!(divergence.right.is_none());
    }

    #[test]
    fn replay_is_injection_order_independent() {
        let log = log_of(&["t1", "t2", "t3"]);
        let mut shuffled = log.events().to_vec();
        shuffled.reverse();
        let replayed = EventLog::replay(&shuffled).expect("重放必须成功");
        assert_eq!(replayed.events(), log.events());
        assert_eq!(replayed.hash(), log.hash());
    }

    #[test]
    fn replay_rejects_a_gap_or_a_duplicate() {
        let log = log_of(&["t1", "t2", "t3"]);

        let mut gapped = log.events().to_vec();
        gapped.remove(1);
        assert!(matches!(
            EventLog::replay(&gapped),
            Err(ReplayError::Gap {
                expected: 2,
                found: 3
            })
        ));

        let mut duplicated = log.events().to_vec();
        duplicated.push(log.events()[0].clone());
        assert!(matches!(
            EventLog::replay(&duplicated),
            Err(ReplayError::DuplicateSeq { seq: 1 })
        ));
    }

    #[test]
    fn decision_tags_are_unique_and_stable() {
        let tags = [
            submitted("t1").tag(),
            Decision::Dequeued {
                task_id: TaskId("t1".into()),
            }
            .tag(),
            Decision::CancelRequested {
                task_id: TaskId("t1".into()),
                was_terminal: false,
            }
            .tag(),
            Decision::Released {
                task_id: TaskId("t1".into()),
                resource: "r".into(),
            }
            .tag(),
            Decision::ReleaseFailed {
                task_id: TaskId("t1".into()),
                resource: "r".into(),
                reason: "boom".into(),
            }
            .tag(),
            Decision::ShutdownRequested {
                in_flight: 0,
                already_shut_down: false,
            }
            .tag(),
            Decision::ShutdownCompleted { released: 0 }.tag(),
        ];
        let mut sorted = tags.to_vec();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(sorted.len(), tags.len(), "决策 tag 有重复");
        assert_eq!(tags.len(), 7, "新增决策类型时必须显式更新这条守卫");
    }
}
