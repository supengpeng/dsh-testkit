//! 调度器配置：**种子**与生命周期无关的静态设定。
//!
//! 设计 §6.3 把"出队顺序由「种子 + 显式优先级」决定"写成 C1 的**结构保证**。
//! 种子在这里不是"随机数发生器的初始化参数"，而是**判定顺序的输入**：
//! 同种子 ⇒ 同顺序；换种子 ⇒ 换顺序（见 `tests/determinism.rs` 的正反两个方向）。

use std::fmt;

/// 事件序列的种子。**同种子 ⇒ 同出队顺序**（设计 §6.3 的 C1 结构保证）。
///
/// 它不是加密材料。它只用于「同优先级任务的出队次序」这一处：
/// `rank = splitmix64(seed ^ fnv1a64(task_id))`，**完全不使用 `RandomState`**
/// （后者的种子每个进程都不同，那正是设计 §6.4 要堵掉的不确定性来源）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Seed(u64);

impl Seed {
    /// 构造。
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    /// 取值（用于日志与读数）。
    pub const fn get(self) -> u64 {
        self.0
    }
}

impl fmt::Display for Seed {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "seed:{}", self.0)
    }
}

/// 调度器配置。
///
/// 目前只有一个字段（种子）。它被显式做成结构体而不是裸 `u64` 参数，
/// 是为了让"将来要加配置"不必改动 `Scheduler::new` 的签名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct SchedulerConfig {
    seed: Seed,
}

impl SchedulerConfig {
    /// 指定种子。
    pub const fn new(seed: Seed) -> Self {
        Self { seed }
    }

    /// 换一个种子（链式）。
    pub const fn with_seed(self, seed: Seed) -> Self {
        Self { seed }
    }

    /// 当前种子。
    pub const fn seed(self) -> Seed {
        self.seed
    }
}
