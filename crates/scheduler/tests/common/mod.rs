//! 集成测试共用的夹具。
//!
//! 这里的东西都刻意保持"**显式**"：
//!
//! - [`Gate`] 是**显式同步点**（设计 §6.4：顺序敏感处必须用显式同步点），
//!   用来把"submit 不阻塞"、"cancel 发生在 Running 期"这类断言变成**不可能碰运气**的断言。
//! - [`sleepy`] 用睡眠模拟 I/O 耗时：它只改变"多久拿到结果"，
//!   于是可以直接检验"完成时序不影响决策序列"。
//! - [`cooperative`] 是**协作式取消**的任务体：轮询取消标志，
//!   这样 `shutdown` 一定有确定的、不靠超时的退出路径。
#![allow(dead_code)]

use dsh_testkit_scheduler::{
    EventHash, EventLog, ExecutionContext, ObservationLog, Priority, Scheduler, SchedulerConfig,
    Seed, TaskId, TaskOutput, TaskResult, TestTask,
};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// 显式门闩：任务体阻塞到测试放行为止。
#[derive(Clone, Default)]
pub struct Gate {
    inner: Arc<(Mutex<bool>, Condvar)>,
}

impl Gate {
    /// 关着的门闩。
    pub fn new() -> Self {
        Self {
            inner: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    /// 放行（唤醒所有等待者）。
    pub fn open(&self) {
        let (lock, condvar) = &*self.inner;
        *lock.lock().expect("门闩锁未中毒") = true;
        condvar.notify_all();
    }

    /// 是否已放行。
    pub fn is_open(&self) -> bool {
        *self.inner.0.lock().expect("门闩锁未中毒")
    }

    /// 阻塞直到放行。
    pub fn wait(&self) {
        let (lock, condvar) = &*self.inner;
        let mut open = lock.lock().expect("门闩锁未中毒");
        while !*open {
            open = condvar.wait(open).expect("门闩锁未中毒");
        }
    }
}

/// 睡眠 `duration` 后按取消标志给出结论的任务体（模拟"I/O 耗时"）。
pub fn sleepy(
    duration: Duration,
) -> impl Fn(&ExecutionContext) -> TaskOutput + Send + Sync + 'static {
    move |context: &ExecutionContext| {
        std::thread::sleep(duration);
        if context.is_cancelled() {
            TaskOutput::cancelled("观察到取消标志")
        } else {
            TaskOutput::passed()
        }
    }
}

/// 协作式取消的任务体：按 `resources` 的**顺序**登记释放项，然后轮询取消标志。
///
/// `budget` 是防测试挂死的预算：超预算就返回 `Errored`（而不是永远转下去）。
pub fn cooperative(
    order: Arc<Mutex<Vec<String>>>,
    resources: Vec<String>,
    budget: Duration,
) -> impl Fn(&ExecutionContext) -> TaskOutput + Send + Sync + 'static {
    move |context: &ExecutionContext| {
        for resource in &resources {
            let order = Arc::clone(&order);
            let name = resource.clone();
            context.on_release(resource.clone(), move || {
                order.lock().expect("记录锁未中毒").push(name);
                Ok(())
            });
        }
        let deadline = Instant::now() + budget;
        while !context.is_cancelled() {
            if Instant::now() >= deadline {
                return TaskOutput::errored("在预算内没有等到取消请求");
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        TaskOutput::cancelled("观察到取消标志")
    }
}

/// 一次运行的全部读数。
pub struct RunRecord {
    /// 判定事件日志（C1 的判据来源）。
    pub log: EventLog,
    /// 观测日志（**不参与判定**）。
    pub observations: ObservationLog,
    /// 事件序列哈希。
    pub hash: EventHash,
    /// 出队顺序。
    pub dequeued: Vec<TaskId>,
    /// 完成顺序（由 OS 决定）。
    pub completion_order: Vec<TaskId>,
    /// 每个任务的结果（按提交序）。
    pub results: Vec<TaskResult>,
}

/// 提交 `sleep_ms.len()` 个同优先级任务（id 为 `t01`…），各睡眠指定毫秒数，然后泵到底并收尾。
pub fn run_sleep_scenario(seed: u64, priority: i64, sleep_ms: &[u64]) -> RunRecord {
    let mut scheduler = Scheduler::new(SchedulerConfig::new(Seed::new(seed)));
    let mut handles = Vec::new();
    for (index, sleep) in sleep_ms.iter().enumerate() {
        let task_id = TaskId(format!("t{:02}", index + 1));
        let task = TestTask::new(
            task_id,
            Priority::new(priority),
            sleepy(Duration::from_millis(*sleep)),
        );
        handles.push(scheduler.submit(task).expect("submit 必须成功"));
    }
    scheduler.drain().expect("drain 必须成功");
    let results = handles
        .iter()
        .map(|handle| scheduler.wait(handle).expect("wait 必须成功"))
        .collect();
    RunRecord {
        log: scheduler.event_log().clone(),
        observations: scheduler.observations().clone(),
        hash: scheduler.event_log().hash(),
        dequeued: scheduler.event_log().dequeued_order(),
        completion_order: scheduler.observations().completion_order(),
        results,
    }
}

/// 去掉 `//` 行注释与 `/* */` 块注释，只留代码（文本守卫共用）。
///
/// 简化：不解析字符串字面量。守卫扫描的目标是类型名与关键字，
/// 本 crate 的 `src/` 里没有包含这些词的字符串字面量，所以这个简化是**显式**的且不影响判别力。
pub fn strip_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut index = 0usize;
    // 0 = 正常，1 = 行注释，2 = 块注释
    let mut state = 0u8;
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        match state {
            0 if current == '/' && next == Some('/') => {
                state = 1;
                index += 2;
            }
            0 if current == '/' && next == Some('*') => {
                state = 2;
                index += 2;
            }
            0 => {
                out.push(current);
                index += 1;
            }
            1 => {
                if current == '\n' {
                    state = 0;
                    out.push('\n');
                }
                index += 1;
            }
            _ => {
                if current == '*' && next == Some('/') {
                    state = 0;
                    index += 2;
                } else {
                    index += 1;
                }
            }
        }
    }
    out
}

/// 递归收集 `directory` 下全部 `.rs` 文件（排序后返回，保证扫描顺序确定）。
pub fn rust_sources(directory: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    collect_rust_sources(directory, &mut found);
    found.sort();
    found
}

fn collect_rust_sources(directory: &std::path::Path, found: &mut Vec<std::path::PathBuf>) {
    let entries = std::fs::read_dir(directory).expect("可读取目录");
    for entry in entries {
        let path = entry.expect("可读取目录项").path();
        if path.is_dir() {
            collect_rust_sources(&path, found);
        } else if path.extension().map(|ext| ext == "rs").unwrap_or(false) {
            found.push(path);
        }
    }
}

/// 本 crate 的 `src/` 目录。
pub fn source_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")
}
