//! `refresh` 的**原子替换**语义 —— 并发证明（设计 §3.4 契约要点 2）。
//!
//! 契约："刷新期间 `probe` 返回**旧值**，不返回半新半旧。"
//!
//! 实现侧为什么能做到：新快照在锁外整张构造，最后只做**一次** `Arc` 赋值；
//! 读侧先克隆 `Arc` 再放手。因此读到的永远是"某一整张表"。
//!
//! ## 证明结构（四层）
//!
//! 1. **同代性（homogeneity）**：一个线程反复 `refresh`，另一个线程反复 `probe_all`；
//!    每个探测器把"探测时看到的代次"写进 `details.generation`。断言任何一次 `probe_all`
//!    看到的代次**唯一**——出现两个就说明快照半新半旧。
//! 2. **判别力证据（overlap）**：16 次探测是**顺序**发生在同一次 `refresh` 里的。探测器同时
//!    写下"我运行时探针已经取过第几次快照"。若同一张快照里这些序号**有跨度**，就证明
//!    探针确实在某次刷新的**构建期**读过旧快照。**只有这种快照才可能证伪原子性**
//!    （非构建期读到的快照，哪怕实现是逐条写的也一定会"同代"）。所以计数只统计它们。
//! 3. **非空性（non-vacuity）**：断言确实观察到 ≥2 个代次、刷新确实发生过 ≥2 次。
//! 4. **负向对照（negative control）**：另建一个**故意非原子**的门控（逐条写），
//!    用同一套探针证明它**会**被观察到混合（与设计 §6.4"守卫必须带负向证明"同一纪律）。
//!
//! ## 为什么按"证据质量"收口，而不是按"快照次数"
//!
//! 本测试曾两次以不同形态 flaky，两次根因都是**测试自己引入了与断言无关的时序假设**：
//!
//! - **第一次**（`cargo test --workspace` 下 9 次 6 红）：探测器用
//!   `for _ in 0..256 { yield_now() }` **人为制造延迟**去撑开窗口。CPU 超订时这 256 次让出
//!   会拖过探测超时 **500ms**，`run_detector` 便如实返回
//!   `Unavailable { reason: "…探测超时（>500ms）…" }`（设计 §3.4 第 3 条：超时是**可归因的事实**）。
//!   而当时的断言把"16 个代次齐全"当成不变量 —— 于是**环境把探测线程饿死**被误报成
//!   "原子性有问题"，会让人去查一个不存在的 bug。
//! - **第二次**（12 个 CPU 饱和进程 + 6 实例下 6/6 红）：改成"至少取 5000 次快照"后，
//!   在饱和机器上 120 秒只跑得完 1135 次快照 —— "5000 次"其实是一条**吞吐假设**，
//!   它与"快照是否原子"毫无关系。
//!
//! 现在的形态把这两条时序假设都去掉了：
//! - 探测器**不 sleep、不 yield**，立刻给出结论（窗口由 `refresh` 自身成本撑开）；
//! - 通过条件是**证据质量**：收集到 [`MIN_OVERLAP_SNAPSHOTS`] 次"构建期读数"即收口，
//!   与机器快慢无关（快则几十毫秒、慢则几十秒，都能收够）；
//! - 环境中真实发生的探测超时被**显式识别并单列**（只允许这一种来源，其它一律失败），
//!   且不计入证据数 —— 它缩小证据面，但绝不伪装成"通过"：证据不够就失败；
//! - "16/16 齐全且同代"这条不变量移到**静止阶段**（刷新线程 join 之后、无并发争用）断言，
//!   既保留、又不受线程饿死污染。

use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};
use std::thread;
use std::time::{Duration, Instant};

use dsh_testkit_capability::{
    CapabilityDetector, CapabilityGate, CapabilityId, CapabilityState, DefaultCapabilityGate,
    GateError, ProbeContext, ProbeOutcome,
};

/// 收口门槛：需要多少次"构建期读数"才算证明过。
///
/// 每次这样的快照，都是探针**在刷新进行中**读到的旧值；若实现是"逐条写快照"，
/// 这些快照里必然出现混合。100 次已经远超判据所需（一次混合就够红）。
const MIN_OVERLAP_SNAPSHOTS: usize = 100;
/// 需要观察到多少个不同代次（否则"刷新真的发生过"没有证据）。
const MIN_GENERATIONS: usize = 2;
/// 死线：只在"环境把刷新彻底饿死"时用于**明确失败**，不作为通过条件。
const DEADLINE: Duration = Duration::from_secs(120);

/// 把"我探测时看到的代次"与"我运行时探针取过第几次快照"一起写进结论。
///
/// **刻意不 sleep、不 yield**：探测器只负责立刻给出结论。窗口由 `refresh` 的自身成本
/// （16 次探测调用）撑开，不靠人为延迟 —— 上一版正是靠延迟才会在 CPU 超订时撞上探测超时。
struct GenerationDetector {
    capability: CapabilityId,
    generation: Arc<AtomicU64>,
    probe_seq: Arc<AtomicU64>,
}

impl CapabilityDetector for GenerationDetector {
    fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
        let generation = self.generation.load(Ordering::SeqCst);
        let probe_seq = self.probe_seq.load(Ordering::SeqCst);
        Ok(CapabilityState::Available {
            details: Some(serde_json::json!({
                "generation": generation,
                "probe_seq": probe_seq,
                "capability": self.capability.name(),
            })),
        })
    }
}

/// 取 `(代次, 探测时的探针序号)`；结论不是 `Available` 或字段不全时返回 `None`。
fn stamp_of(state: &CapabilityState) -> Option<(u64, u64)> {
    match state {
        CapabilityState::Available {
            details: Some(details),
        } => {
            let generation = details.get("generation").and_then(|value| value.as_u64())?;
            let probe_seq = details.get("probe_seq").and_then(|value| value.as_u64())?;
            Some((generation, probe_seq))
        }
        _ => None,
    }
}

/// 是否是**探测超时**这一种合法未决结论（设计 §3.4 第 3 条：超时可归因，记 `Unavailable`）。
fn is_timeout(state: &CapabilityState) -> bool {
    matches!(state, CapabilityState::Unavailable { reason } if reason.contains("超时"))
}

/// 只取代次（负向对照的门控不写 `probe_seq`，用这个）。
fn generation_of(state: &CapabilityState) -> Option<u64> {
    match state {
        CapabilityState::Available {
            details: Some(details),
        } => details.get("generation").and_then(|value| value.as_u64()),
        _ => None,
    }
}

fn behavior_capabilities() -> Vec<CapabilityId> {
    CapabilityId::ALL
        .iter()
        .copied()
        .filter(|capability| !capability.is_declared_only())
        .collect()
}

/// 逐能力取出代次（负向对照用）。
fn generations_in(map: &BTreeMap<CapabilityId, CapabilityState>) -> Vec<u64> {
    map.iter()
        .filter(|(capability, _)| !capability.is_declared_only())
        .filter_map(|(_, state)| generation_of(state))
        .collect()
}

fn distinct(generations: &[u64]) -> BTreeSet<u64> {
    generations.iter().copied().collect()
}

#[test]
fn refresh_is_an_atomic_swap_and_never_exposes_a_half_new_snapshot() {
    let capabilities = behavior_capabilities();
    let gate = Arc::new(DefaultCapabilityGate::new("0.2.0-rc.2"));
    let generation = Arc::new(AtomicU64::new(0));
    let probe_seq = Arc::new(AtomicU64::new(0));

    for capability in &capabilities {
        gate.register_detector(
            *capability,
            Box::new(GenerationDetector {
                capability: *capability,
                generation: Arc::clone(&generation),
                probe_seq: Arc::clone(&probe_seq),
            }),
        )
        .expect("注册代次探测器");
    }

    let stop = Arc::new(AtomicBool::new(false));
    let refreshes = Arc::new(AtomicU64::new(0));
    let refresher = {
        let gate = Arc::clone(&gate);
        let generation = Arc::clone(&generation);
        let stop = Arc::clone(&stop);
        let refreshes = Arc::clone(&refreshes);
        thread::spawn(move || {
            // 刷到探针收够证据为止（探针收够后会置 `stop`）。
            let mut tick = 0u64;
            while !stop.load(Ordering::SeqCst) {
                tick += 1;
                generation.store(tick, Ordering::SeqCst);
                gate.refresh().expect("refresh 应成功");
                refreshes.fetch_add(1, Ordering::SeqCst);
            }
        })
    };

    let started = Instant::now();
    let mut observed: BTreeSet<u64> = BTreeSet::new();
    let mut mixed_snapshots = 0usize;
    let mut overlap_snapshots = 0usize;
    let mut max_span = 0u64;
    let mut snapshots = 0usize;
    let mut starved_snapshots = 0usize;
    while overlap_snapshots < MIN_OVERLAP_SNAPSHOTS || observed.len() < MIN_GENERATIONS {
        assert!(
            started.elapsed() < DEADLINE,
            "探针在 {DEADLINE:?} 内没收到足够证据（快照 {snapshots} 次、构建期读数 {overlap_snapshots} 次、\
             代次 {observed:?}、刷新 {} 次、环境超时快照 {starved_snapshots} 次）—— 这是空证明，不是通过",
            refreshes.load(Ordering::SeqCst)
        );
        probe_seq.fetch_add(1, Ordering::SeqCst);
        let snapshot = gate.probe_all(&capabilities);
        snapshots += 1;

        let mut stamps: Vec<(u64, u64)> = Vec::new();
        let mut undecided: Vec<(CapabilityId, CapabilityState)> = Vec::new();
        for (capability, state) in &snapshot {
            if capability.is_declared_only() {
                continue;
            }
            match stamp_of(state) {
                Some(stamp) => stamps.push(stamp),
                None => undecided.push((*capability, state.clone())),
            }
        }

        // ① 未决结论**只允许探测超时**这一个来源。其余（漏配探测器 / 探测器故障 /
        //    无法归因的 Unknown）都是结构性缺口，一律失败并贴出结论原文。
        let unexplained: Vec<String> = undecided
            .iter()
            .filter(|(_, state)| !is_timeout(state))
            .map(|(capability, state)| format!("{}={state:?}", capability.name()))
            .collect();
        assert!(
            unexplained.is_empty(),
            "第 {snapshots} 次快照出现非超时的未决结论（结构性缺口，必须查）：{unexplained:?}"
        );

        // ② 原子性：**已给出的**代次必须唯一（一半缺失也照样能看出混合）。
        let generations: Vec<u64> = stamps.iter().map(|(generation, _)| *generation).collect();
        let distinct_generations = distinct(&generations);
        if distinct_generations.len() > 1 {
            mixed_snapshots += 1;
        }
        observed.extend(distinct_generations);

        // ③ 判别力证据：只统计 **16/16 齐全**的快照。环境导致探测超时会缩小证据面，
        //    但它绝不伪装成通过 —— 证据凑不够，上面的死线会明确失败。
        if undecided.is_empty() {
            let lowest = stamps.iter().map(|(_, seq)| *seq).min().unwrap_or(0);
            let highest = stamps.iter().map(|(_, seq)| *seq).max().unwrap_or(0);
            let span = highest - lowest;
            if span > 0 {
                overlap_snapshots += 1;
            }
            max_span = max_span.max(span);
        } else {
            starved_snapshots += 1;
        }

        // 让出 CPU 是**公平性**手段（单核上别把刷新线程饿死），不是制造窗口的延迟手段。
        thread::yield_now();
    }

    stop.store(true, Ordering::SeqCst);
    refresher.join().expect("刷新线程应正常结束");

    assert_eq!(
        mixed_snapshots, 0,
        "任何一次 probe_all 都不得同时看到两个代次（半新半旧）；混合 {mixed_snapshots}/{snapshots} 次"
    );
    assert!(
        overlap_snapshots >= MIN_OVERLAP_SNAPSHOTS,
        "构建期读数必须达到 {MIN_OVERLAP_SNAPSHOTS} 次，实际 {overlap_snapshots}（最大代次跨度 max_span={max_span}）"
    );
    assert!(
        refreshes.load(Ordering::SeqCst) >= 2,
        "刷新必须真的在探测期间发生过多次，实际 {}",
        refreshes.load(Ordering::SeqCst)
    );
    assert!(
        observed.len() >= MIN_GENERATIONS,
        "探针必须观察到 ≥{MIN_GENERATIONS} 个代次（刷新真的发生过），实际 {observed:?}"
    );

    // ④ 静止阶段：刷新线程已 join，此时独占环境再做一次 refresh，断言"16/16 齐全且同代"。
    //    完整性只在无并发争用时断言 —— 于是它既被保留，又不会被线程饿死污染。
    gate.refresh().expect("静止阶段 refresh 应成功");
    let final_snapshot = gate.probe_all(&capabilities);
    let mut final_stamps: Vec<(u64, u64)> = Vec::new();
    let mut missing: Vec<String> = Vec::new();
    for (capability, state) in &final_snapshot {
        if capability.is_declared_only() {
            continue;
        }
        match stamp_of(state) {
            Some(stamp) => final_stamps.push(stamp),
            None => missing.push(format!("{}={state:?}", capability.name())),
        }
    }
    assert!(
        missing.is_empty(),
        "静止阶段必须拿到全部 {expected} 个能力的代次，但有 {actual} 个没有：{missing:?}",
        expected = capabilities.len(),
        actual = missing.len()
    );
    let final_generations: Vec<u64> = final_stamps
        .iter()
        .map(|(generation, _)| *generation)
        .collect();
    assert_eq!(
        distinct(&final_generations).len(),
        1,
        "静止阶段的一次快照必须同代，实际 {final_generations:?}"
    );
}

/// **故意非原子**的门控：把 16 个能力逐条写进共享表（每次一把小锁）。
///
/// 这不是"另一个实现"，而是证明第 1 层断言的**判别力**：
/// 同样的探针在它上面必须观测到混合，否则那条断言只是同义反复。
struct NonAtomicGate {
    entries: RwLock<BTreeMap<CapabilityId, ProbeOutcome>>,
    capabilities: Vec<CapabilityId>,
}

impl NonAtomicGate {
    fn new(capabilities: Vec<CapabilityId>) -> Self {
        let entries = capabilities
            .iter()
            .map(|capability| {
                (
                    *capability,
                    ProbeOutcome::Detected(CapabilityState::Available { details: None }),
                )
            })
            .collect();
        NonAtomicGate {
            entries: RwLock::new(entries),
            capabilities,
        }
    }

    /// 逐条写：写到一半停一下 —— 这正是"半新半旧"的窗口。
    fn refresh(&self, generation: u64) {
        let midpoint = self.capabilities.len() / 2;
        for (index, capability) in self.capabilities.iter().enumerate() {
            let outcome = ProbeOutcome::Detected(CapabilityState::Available {
                details: Some(serde_json::json!({ "generation": generation })),
            });
            self.entries
                .write()
                .unwrap_or_else(|e| e.into_inner())
                .insert(*capability, outcome);
            if index + 1 == midpoint {
                // 这个 sleep 是**被测对象**的属性（非原子实现天生有窗口），不是测试的时序假设。
                thread::sleep(Duration::from_millis(2));
            }
        }
    }

    fn probe_all(&self) -> BTreeMap<CapabilityId, CapabilityState> {
        self.capabilities
            .iter()
            .map(|capability| {
                let outcome = self
                    .entries
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .get(capability)
                    .cloned()
                    .unwrap_or(ProbeOutcome::NoDetector);
                (*capability, outcome.to_state())
            })
            .collect()
    }
}

#[test]
fn negative_control_a_non_atomic_gate_does_expose_mixed_generations() {
    let capabilities = behavior_capabilities();
    let gate = Arc::new(NonAtomicGate::new(capabilities.clone()));
    let stop = Arc::new(AtomicBool::new(false));

    let refresher = {
        let gate = Arc::clone(&gate);
        let stop = Arc::clone(&stop);
        thread::spawn(move || {
            let mut tick = 0u64;
            while !stop.load(Ordering::SeqCst) && tick < 64 {
                tick += 1;
                gate.refresh(tick);
            }
        })
    };

    let mut observed_mixed = 0usize;
    let mut rounds = 0usize;
    while observed_mixed == 0 && rounds < 200_000 {
        let generations = generations_in(&gate.probe_all());
        if distinct(&generations).len() > 1 {
            observed_mixed += 1;
        }
        rounds += 1;
        // 公平性让出：单核上别把刷新线程饿死（否则负向对照会假红）。
        thread::yield_now();
    }

    stop.store(true, Ordering::SeqCst);
    refresher.join().expect("刷新线程应正常结束");

    assert!(
        observed_mixed > 0,
        "非原子的逐条写必须能被探针抓到混合；抓不到说明第 1 层断言没有判别力"
    );
}
