//! `CapabilityGate`：探测器注册 / 缓存 / **原子** refresh / 唯一决策表。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.4 的五条契约要点，逐条落点如下：
//!
//! 1. **探测器注册后立即执行一次并缓存** —— [`CapabilityGate::register_detector`]；
//!    随后 `probe` 只读缓存（`probe` 不触碰探测器）。
//! 2. **`refresh` 是原子替换** —— 刷新期间 `probe` 返回**旧值**，不返回半新半旧。
//!    实现方式：新快照在锁外整张构造，最后用**一次 `Arc` 赋值**替换
//!    （`RwLock<Arc<BTreeMap<..>>>`）。读侧先克隆 `Arc` 再放手，因此要么全旧、要么全新。
//! 3. **探测超时 500ms 视为 `Unavailable`（不是 `Unknown`）** —— 超时是一个**可归因的事实**。
//! 4. **`Unknown` 与缺能力不是一回事** —— `Unknown` 在严格档按 `Fail`、非严格档按 `Skip`，
//!    这条语义在 [`crate::decide`] 里，本模块不重复实现。
//! 5. **门控与退出码的唯一裁决表** —— [`crate::decide`] + [`crate::GateDecision::exit_code`]。
//!
//! ## 与"成本闸门"的边界（不许混淆）
//!
//! `src/executor/policy.ts` 是**安全边界**（成本 / 沙箱 / 模型调用授权），设计 §1.2 明确
//! 它留在 TS。本 crate **只**实现能力门控：`gate` 的输入只有"能力状态 + 档位 + 是否必需"，
//! 没有任何成本字段。把两者合并会让"这台机器有什么能力"与"这次运行准不准花钱"互相污染。
//!
//! ## 额外暴露的两个读口（为什么比设计 §3.4 多）
//!
//! 设计 §3.4 的 `probe` 只返回三态 [`CapabilityState`]，于是两种**不同**的事会退化成同一个
//! `Unknown`：declared-only 的 4 个能力（**永远**不参与门控）与"漏配探测器"（阶段 1 的缺口）。
//! 这正是 `spec/contracts/capabilities.yaml` 警告的"静默判错"形态。所以本 crate 额外暴露
//! [`ProbeOutcome`]（`probe_outcome`）/ [`CapabilityGate::outcomes`] 作为**如实告知**的读口，
//! 同时保持 `probe` 的三态签名不动。

use std::collections::BTreeMap;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::decision::{decide_with_policy, CapabilityState, GateDecision, GatePolicy};
use crate::detector::{CapabilityDetector, ProbeContext};
use crate::id::CapabilityId;
use crate::version::{check_dsh_version, VersionVerdict};

/// 能力探测超时阈值（毫秒，设计 §3.4 第 3 条）。
pub const PROBE_TIMEOUT_MS: u64 = 500;

/// 本仓声明的 DSH 版本范围（`spec/contracts/versions.yaml` → `readouts.declared_range`）。
///
/// 它是**声明**，不是运行期门控：该声明在旧实现 `src/` 里零消费者（`versions.yaml` 的
/// `declared_set.has_code_consumer = false`）。运行期真正生效的版本判定走夹具的
/// `dsh_version` 范围（与 [`crate::check_dsh_version`] 同源）。
pub const DEFAULT_DECLARED_RANGE: &str = ">=0.2.0-rc.2";

/// 能力状态映射：`capability → state`。
///
/// 用 `BTreeMap`（有序）而不是 `HashMap`：设计 §6.4 的硬纪律——判定路径禁用
/// `HashMap` / `HashSet`，因为 Rust 的 `HashMap` 迭代顺序每次运行都不同，
/// 会把"Rust 更确定"的论断当场作废。
pub type CapabilityMap = BTreeMap<CapabilityId, CapabilityState>;

/// 探测结果 —— 比 [`CapabilityState`] 多一维"**为什么没有 state**"。
///
/// 三种"不是 `Detected`"的情形在 `probe` 那层都会退化成 `Unknown`，但在本类型里**必须可区分**：
/// declared-only 是**已裁决的常态**，漏配探测器是**阶段 1 的缺口**，探测器报错是**故障**。
/// 把三者混成一个 `Unknown` 就是"静默判错"。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum ProbeOutcome {
    /// 探测**得出了结论**（`Unknown` 也是一条结论：探不到）。
    Detected(CapabilityState),
    /// 探测器本身坏了（`Err` 通道）。**不是"探不到"。**
    DetectorError {
        /// 出错的能力。
        capability: CapabilityId,
        /// 错误说明。
        message: String,
    },
    /// declared-only：只有联合类型成员身份，无消费点、无场景可触发。
    /// **永不触发、不参与策略矩阵、不注册探测器。**
    DeclaredOnly,
    /// 有行为的能力却没有注册探测器 —— 阶段 1 的**缺口**，必须可见（不静默当 `Unknown`）。
    NoDetector,
}

impl ProbeOutcome {
    /// 退化成设计 §3.4 的三态。
    ///
    /// `DeclaredOnly` / `NoDetector` / `DetectorError` 一律退化成 `Unknown`：
    /// 它们是"**没得出可归因结论**"，而不是"缺能力"（`Unavailable`）——
    /// 在严格档下这会让门控 `Fail`（宁可红，不假装通过）。
    pub fn to_state(&self) -> CapabilityState {
        match self {
            ProbeOutcome::Detected(state) => state.clone(),
            ProbeOutcome::DetectorError { .. }
            | ProbeOutcome::DeclaredOnly
            | ProbeOutcome::NoDetector => CapabilityState::Unknown,
        }
    }

    /// 是否为 declared-only 占位。
    pub fn is_declared_only(&self) -> bool {
        matches!(self, ProbeOutcome::DeclaredOnly)
    }

    /// 是否为"该有探测却没有"的缺口（漏配探测器或探测器故障）。
    pub fn is_gap(&self) -> bool {
        matches!(
            self,
            ProbeOutcome::NoDetector | ProbeOutcome::DetectorError { .. }
        )
    }
}

/// 门控错误。
///
/// 关键语义：**`Err` 表示"探测器/门控本身坏了"，不表示"能力不可用"**。
/// 能力不可用是 [`CapabilityState::Unavailable`]，两者不能互换。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum GateError {
    /// 探测器报了错（`detect` 返回 `Err`）。
    DetectorFailed {
        /// 出错的能力。
        capability: CapabilityId,
        /// 错误说明。
        message: String,
    },
    /// 试图给 declared-only 能力注册探测器（已裁决：它们永不触发、不参与策略矩阵）。
    DeclaredOnlyNotDetectable {
        /// 被拒绝的能力。
        capability: CapabilityId,
    },
    /// 快照锁中毒：前一次持写锁的线程 panic 了。写路径**宁可报错也不假装刷新成功**。
    ///
    /// ## 为什么这条按设计几乎不可达（所以**没有**单测）
    ///
    /// 持写锁的代码只有两处，且都只会"克隆整张表 + 一次 `Arc` 赋值"或"插入一个键"——
    /// 没有会 panic 的逻辑。而**探测器的调用发生在锁外**（这正是原子替换的要点），
    /// 所以探测器自己 panic 或超时都污染不到这两把锁，只会变成 [`ProbeOutcome::DetectorError`]。
    /// 要构造锁中毒，只能人为让某个线程持锁时 panic —— 那种测试验证的是
    /// "我们能不能制造锁中毒"，不是"代码在锁中毒下对不对"，所以不写；
    /// 这里用注释把"不可达 + 兜的是什么"讲清，而不是补一个测不到该分支的假测试。
    ///
    /// ## 它兜的是什么
    ///
    /// 万一将来有人在持锁区间里塞进会 panic 的逻辑，写路径会**明确失败**，
    /// 而不是把一张可能半截的表当成"刷新成功"——这与本 crate"不静默"的整体纪律一致。
    SnapshotPoisoned {
        /// 中毒的那把锁。
        what: String,
    },
}

impl GateError {
    /// 构造"探测器故障"错误。
    pub fn detector_failed(capability: CapabilityId, message: impl Into<String>) -> Self {
        GateError::DetectorFailed {
            capability,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for GateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GateError::DetectorFailed {
                capability,
                message,
            } => write!(f, "能力 `{}` 的探测器报错：{message}", capability.name()),
            GateError::DeclaredOnlyNotDetectable { capability } => write!(
                f,
                "能力 `{}` 是 declared-only（无消费点、无场景可触发），不注册探测器",
                capability.name()
            ),
            GateError::SnapshotPoisoned { what } => {
                write!(f, "能力快照锁中毒（{what}）：前一次持锁线程 panic")
            }
        }
    }
}

impl std::error::Error for GateError {}

/// 能力门控（设计 §3.4）。
///
/// 全部方法取 `&self`：`register_detector` / `refresh` 是可共享引用上的原子操作，
/// 这样门控可以放进 `Arc` 被多线程同时读。
pub trait CapabilityGate: Send + Sync {
    /// 查一个能力的（缓存）状态。
    fn probe(&self, capability: &CapabilityId) -> CapabilityState;

    /// 批量查状态。返回 [`CapabilityMap`]。
    fn probe_all(&self, capabilities: &[CapabilityId]) -> CapabilityMap;

    /// 按策略裁决。
    fn gate(&self, capability: &CapabilityId, policy: GatePolicy) -> GateDecision;

    /// 注册探测器：**立即执行一次并缓存**；随后 `probe` 只读缓存。
    ///
    /// 若首次探测就报错，返回 `Err`，但**注册已生效**且错误结果已缓存
    /// （`probe_outcome` 会看到 [`ProbeOutcome::DetectorError`]）——不静默丢弃故障。
    fn register_detector(
        &self,
        capability: CapabilityId,
        detector: Box<dyn CapabilityDetector>,
    ) -> Result<(), GateError>;

    /// 重新执行所有已注册探测器，**原子替换**整张快照。
    ///
    /// 刷新期间 `probe` 返回旧值。若某个探测器报错，新快照**仍然**原子安装
    /// （该能力记为 [`ProbeOutcome::DetectorError`] → `Unknown`），同时返回 `Err` 让故障可见。
    fn refresh(&self) -> Result<(), GateError>;

    /// 探测结果的**完整**形态（含 declared-only / 漏配 / 故障三种"为什么没有 state"）。
    ///
    /// 这是设计 §3.4 之外**刻意**增加的一条读口：`probe` 的三态会把上述三者压成一个
    /// `Unknown`，那样"如实告知"就丢了。见本模块文档末节。
    fn probe_outcome(&self, capability: &CapabilityId) -> ProbeOutcome;

    /// 当前快照里 20 个能力的完整结果（有序）。
    ///
    /// 默认实现逐个调 [`CapabilityGate::probe_outcome`]；实现方可以覆盖成"一次读快照"。
    fn outcomes(&self) -> BTreeMap<CapabilityId, ProbeOutcome> {
        let mut map = BTreeMap::new();
        for capability in CapabilityId::ALL {
            map.insert(capability, self.probe_outcome(&capability));
        }
        map
    }
}

/// 宿主版本事实（探测上下文的输入）。
#[derive(Debug, Clone)]
struct HostFacts {
    dsh_version: String,
    declared_range: String,
}

/// 已注册探测器表：能力 → 探测器。用 `BTreeMap`（有序），理由见设计 §6.4。
type DetectorMap = BTreeMap<CapabilityId, Arc<dyn CapabilityDetector>>;

/// 当前快照表：能力 → 探测结果。整张表用 `Arc` 包住，`refresh` 只换这一个 `Arc`。
type SnapshotMap = BTreeMap<CapabilityId, ProbeOutcome>;

/// 默认能力门控实现。
///
/// 内部状态：
/// - `detectors`：已注册探测器（`BTreeMap`，有序）。
/// - `snapshot`：**当前快照**，用 `Arc` 包住整张表；`refresh` 只换这一个 `Arc`。
/// - `host`：宿主版本事实。
/// - `probe_timeout`：探测超时（缺省 [`PROBE_TIMEOUT_MS`]）。
pub struct DefaultCapabilityGate {
    detectors: RwLock<DetectorMap>,
    snapshot: RwLock<Arc<SnapshotMap>>,
    host: RwLock<HostFacts>,
    probe_timeout: Duration,
}

impl DefaultCapabilityGate {
    /// 新建门控。初始快照里 declared-only 是占位、其余能力是 [`ProbeOutcome::NoDetector`]
    /// （"还没注册"是事实，不假装成 `Unknown`）。
    pub fn new(dsh_version: impl Into<String>) -> Self {
        DefaultCapabilityGate {
            detectors: RwLock::new(BTreeMap::new()),
            snapshot: RwLock::new(Arc::new(Self::base_snapshot())),
            host: RwLock::new(HostFacts {
                dsh_version: dsh_version.into(),
                declared_range: DEFAULT_DECLARED_RANGE.to_string(),
            }),
            probe_timeout: Duration::from_millis(PROBE_TIMEOUT_MS),
        }
    }

    /// 覆盖声明支持的版本范围（缺省 [`DEFAULT_DECLARED_RANGE`]）。
    pub fn with_declared_range(mut self, range: impl Into<String>) -> Self {
        self.host
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .declared_range = range.into();
        self
    }

    /// 覆盖探测超时（测试用；缺省 [`PROBE_TIMEOUT_MS`]）。
    pub fn with_probe_timeout(mut self, timeout: Duration) -> Self {
        self.probe_timeout = timeout;
        self
    }

    /// 当前探测超时。
    pub fn probe_timeout(&self) -> Duration {
        self.probe_timeout
    }

    /// 当前宿主 DSH 版本。
    pub fn host_version(&self) -> String {
        self.read_host().dsh_version.clone()
    }

    /// 当前声明支持的版本范围。
    pub fn declared_range(&self) -> String {
        self.read_host().declared_range.clone()
    }

    /// 更新宿主 DSH 版本。**不自动重新探测**——版本变了要不要重探是调用方的决定，
    /// 隐式重探会让"什么时候信这张快照"变得不可见；需要新结论就显式 [`CapabilityGate::refresh`]。
    pub fn set_host_version(&self, version: impl Into<String>) {
        let version = version.into();
        let mut host = self.host.write().unwrap_or_else(|e| e.into_inner());
        host.dsh_version = version;
    }

    /// 宿主版本与声明范围的判定结果（G2）。
    ///
    /// 版本不兼容**不经能力门控**：这里只给判定，不产生 `GateDecision`（设计 §3.4 第 5 条）。
    pub fn version_verdict(&self) -> VersionVerdict {
        let host = self.read_host();
        check_dsh_version(&host.dsh_version, &host.declared_range)
    }

    /// 初始快照：declared-only 显式占位，其余为"尚未注册探测器"。
    fn base_snapshot() -> BTreeMap<CapabilityId, ProbeOutcome> {
        let mut map = BTreeMap::new();
        for capability in CapabilityId::ALL {
            let outcome = if capability.is_declared_only() {
                ProbeOutcome::DeclaredOnly
            } else {
                ProbeOutcome::NoDetector
            };
            map.insert(capability, outcome);
        }
        map
    }

    fn read_host(&self) -> RwLockReadGuard<'_, HostFacts> {
        // 读路径拿不到锁就算了不要 panic：毒锁时取内部值（如实告知优先于崩溃）。
        self.host.read().unwrap_or_else(|e| e.into_inner())
    }

    fn snapshot_arc(&self) -> Arc<SnapshotMap> {
        // 先克隆 Arc 再放手：读侧因此永远看到"某一整张表"，不可能看到半张。
        Arc::clone(&self.snapshot.read().unwrap_or_else(|e| e.into_inner()))
    }

    fn snapshot_write(&self) -> Result<RwLockWriteGuard<'_, Arc<SnapshotMap>>, GateError> {
        // 这条 `map_err` 按设计不可达（本函数体内不会 panic，探测器又跑在锁外）；
        // 保留它是为了"将来有人在持锁区间里加会 panic 的逻辑"时**明确失败**而非假装成功。
        // 不可达论证见 `GateError::SnapshotPoisoned` 的文档（含"为什么不补测试"）。
        self.snapshot
            .write()
            .map_err(|_| GateError::SnapshotPoisoned {
                what: "snapshot".to_string(),
            })
    }

    fn detectors_write(&self) -> Result<RwLockWriteGuard<'_, DetectorMap>, GateError> {
        // 同 `snapshot_write`：不可达的兜底，理由见 `GateError::SnapshotPoisoned` 的文档。
        self.detectors
            .write()
            .map_err(|_| GateError::SnapshotPoisoned {
                what: "detectors".to_string(),
            })
    }

    fn probe_context(&self, capability: CapabilityId) -> ProbeContext {
        let host = self.read_host();
        ProbeContext::new(
            capability,
            host.dsh_version.clone(),
            host.declared_range.clone(),
            self.probe_timeout,
        )
    }
}

impl CapabilityGate for DefaultCapabilityGate {
    fn probe(&self, capability: &CapabilityId) -> CapabilityState {
        self.probe_outcome(capability).to_state()
    }

    fn probe_all(&self, capabilities: &[CapabilityId]) -> CapabilityMap {
        // 一张快照读到底：同一批结果必然来自同一次 refresh。
        let snapshot = self.snapshot_arc();
        capabilities
            .iter()
            .map(|capability| {
                let outcome = snapshot
                    .get(capability)
                    .cloned()
                    .unwrap_or(ProbeOutcome::NoDetector);
                (*capability, outcome.to_state())
            })
            .collect()
    }

    fn gate(&self, capability: &CapabilityId, policy: GatePolicy) -> GateDecision {
        match self.probe_outcome(capability) {
            // declared-only 永不触发、不参与策略矩阵：**任何档位、任何 mandatory 都只能 Skip**。
            // 它们没有消费点，把"探不到"按严格档判 Fail 会凭空造出与行为无关的红灯。
            ProbeOutcome::DeclaredOnly => GateDecision::Skip {
                reason: format!(
                    "能力 `{}` 是 declared-only（只有联合类型成员身份，无消费点）；不参与门控",
                    capability.name()
                ),
            },
            // 漏配探测器与探测器故障都退化成 Unknown：严格档 Fail（宁可红），非严格档 Skip。
            outcome => decide_with_policy(&outcome.to_state(), &policy),
        }
    }

    fn register_detector(
        &self,
        capability: CapabilityId,
        detector: Box<dyn CapabilityDetector>,
    ) -> Result<(), GateError> {
        if capability.is_declared_only() {
            return Err(GateError::DeclaredOnlyNotDetectable { capability });
        }
        let detector: Arc<dyn CapabilityDetector> = Arc::from(detector);
        // 契约要点 1：注册后**立即执行一次**。
        let outcome = run_detector(
            Arc::clone(&detector),
            self.probe_context(capability),
            self.probe_timeout,
        );
        let failure = detector_failure(&outcome);

        self.detectors_write()?.insert(capability, detector);
        {
            let mut snapshot = self.snapshot_write()?;
            let mut next = (**snapshot).clone();
            next.insert(capability, outcome);
            *snapshot = Arc::new(next);
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn refresh(&self) -> Result<(), GateError> {
        // 1) 快照式地取出探测器清单（读完就放锁，绝不在持锁时跑探测器）。
        let detectors: Vec<(CapabilityId, Arc<dyn CapabilityDetector>)> = {
            let guard = self.detectors.read().unwrap_or_else(|e| e.into_inner());
            guard
                .iter()
                .map(|(capability, detector)| (*capability, Arc::clone(detector)))
                .collect()
        };

        // 2) 在锁外构造**整张**新表（declared-only 占位 + 尚无探测器 + 本次探测结果）。
        let mut next = Self::base_snapshot();
        let mut first_error: Option<GateError> = None;
        for (capability, detector) in detectors {
            let outcome =
                run_detector(detector, self.probe_context(capability), self.probe_timeout);
            if first_error.is_none() {
                first_error = detector_failure(&outcome);
            }
            next.insert(capability, outcome);
        }

        // 3) 一次赋值替换整张表 —— 这就是"原子替换"的全部：读侧要么看到旧的 Arc，要么看到新的。
        {
            let mut snapshot = self.snapshot_write()?;
            *snapshot = Arc::new(next);
        }

        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn probe_outcome(&self, capability: &CapabilityId) -> ProbeOutcome {
        self.snapshot_arc()
            .get(capability)
            .cloned()
            .unwrap_or(ProbeOutcome::NoDetector)
    }

    fn outcomes(&self) -> BTreeMap<CapabilityId, ProbeOutcome> {
        (*self.snapshot_arc()).clone()
    }
}

/// 把探测结果里的故障提出来（`Err` 通道的可见化）。
fn detector_failure(outcome: &ProbeOutcome) -> Option<GateError> {
    match outcome {
        ProbeOutcome::DetectorError {
            capability,
            message,
        } => Some(GateError::detector_failed(*capability, message.clone())),
        _ => None,
    }
}

/// 在 worker 线程上跑一次探测，**强制**超时。
///
/// 为什么要开线程：`CapabilityDetector::detect` 是同步阻塞的，没有线程就**无法**真正止损——
/// 只能在探测器返回**之后**发现"它超时了"，那对"探测卡住"毫无帮助。这里用
/// `mpsc::recv_timeout` 在一段可控的时间内拿到结论或判定超时，**不用 `unsafe`**。
///
/// 代价（如实记录）：若探测器永久卡死，那个 worker 线程会泄漏（Rust 无法安全地杀线程）。
/// 这是刻意的取舍——门控本身不被卡住的探测器拖死，比不留一个线程更重要。
fn run_detector(
    detector: Arc<dyn CapabilityDetector>,
    ctx: ProbeContext,
    timeout: Duration,
) -> ProbeOutcome {
    let capability = ctx.capability;
    let (sender, receiver) = mpsc::channel::<Result<CapabilityState, GateError>>();
    let spawned = thread::Builder::new()
        .name(format!("probe-{}", capability.name()))
        .spawn(move || {
            let result = detector.detect(&ctx);
            // 接收端可能已因超时离开；发送失败说明"没人要了"，不是探测错误。
            let _ = sender.send(result);
        });

    let handle = match spawned {
        Ok(handle) => handle,
        // 按设计不可达：线程创建失败只在资源耗尽（线程数上限 / 内存）时发生，
        // 测试里构造它等于人为制造系统级故障，验的不是本 crate 的逻辑。
        // 保留它是为了"起不了线程"时**如实报成探测器故障**（`DetectorError`），
        // 而不是静默当成"探不到"——那会把系统性故障伪装成能力缺失。
        Err(error) => {
            return ProbeOutcome::DetectorError {
                capability,
                message: format!("无法启动探测线程：{error}"),
            }
        }
    };

    match receiver.recv_timeout(timeout) {
        Ok(Ok(state)) => ProbeOutcome::Detected(state),
        Ok(Err(error)) => ProbeOutcome::DetectorError {
            capability,
            message: error.to_string(),
        },
        // 契约要点 3：超时 → `Unavailable`（**不是** `Unknown`）——超时是一个可归因的事实。
        Err(RecvTimeoutError::Timeout) => ProbeOutcome::Detected(CapabilityState::Unavailable {
            reason: format!(
                "能力 `{}` 的探测超时（>{}ms）；超时可归因，故记 Unavailable 而不是 Unknown",
                capability.name(),
                timeout.as_millis()
            ),
        }),
        Err(RecvTimeoutError::Disconnected) => {
            // `Disconnected` 只在"全部 sender 已丢弃且通道为空"时发生。本函数的 worker
            // 闭包**总是先 `send` 再返回**，所以 `Ok(())` 这条分支按构造不可达
            // （正常返回 ⇒ 值已在通道里 ⇒ 不会走到这里）；能走到这里的只有 panic。
            // 保留它作为兜底，覆盖率上它是一条有理由的未覆盖行，不为它造测试。
            let message = match handle.join() {
                Ok(()) => "探测线程未返回任何结果".to_string(),
                Err(_) => "探测器 panic".to_string(),
            };
            ProbeOutcome::DetectorError {
                capability,
                message,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::decision::Preset;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// 一个可计数的固定结果探测器。
    struct CountingDetector {
        state: CapabilityState,
        calls: Arc<AtomicU64>,
    }

    impl CapabilityDetector for CountingDetector {
        fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.state.clone())
        }
    }

    /// 永远报错的探测器：模拟"探测器本身坏了"（`Err` 通道）。
    struct BrokenDetector;

    impl CapabilityDetector for BrokenDetector {
        fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
            Err(GateError::detector_failed(
                CapabilityId::Fs,
                "注入的服务句柄为 null",
            ))
        }
    }

    /// 直接 panic 的探测器：模拟"探测器**炸了**"（连 `Err` 都回不来的那种坏）。
    ///
    /// 走的是 `run_detector` 的 `Disconnected` 分支：worker 线程 unwind 时 sender 被丢弃，
    /// 接收端在超时前就断连，于是不再等满 500ms。
    struct PanickingDetector;

    impl CapabilityDetector for PanickingDetector {
        fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
            panic!("探测时发生了未捕获的 panic（测试用）");
        }
    }

    /// 睡过超时的探测器。
    struct SlowDetector {
        sleep: Duration,
    }

    impl CapabilityDetector for SlowDetector {
        fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
            std::thread::sleep(self.sleep);
            Ok(CapabilityState::Available { details: None })
        }
    }

    fn available() -> CapabilityState {
        CapabilityState::Available {
            details: Some(serde_json::json!({ "probe": "ok" })),
        }
    }

    #[test]
    fn probe_timeout_is_attributable_fact_not_unknown() {
        assert_eq!(PROBE_TIMEOUT_MS, 500);
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        assert_eq!(gate.probe_timeout(), Duration::from_millis(500));
    }

    #[test]
    fn registration_probes_once_then_probe_reads_cache() {
        let calls = Arc::new(AtomicU64::new(0));
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        gate.register_detector(
            CapabilityId::Fs,
            Box::new(CountingDetector {
                state: available(),
                calls: Arc::clone(&calls),
            }),
        )
        .expect("注册应成功");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "注册后应立即探测一次");

        for _ in 0..5 {
            assert!(matches!(
                gate.probe(&CapabilityId::Fs),
                CapabilityState::Available { .. }
            ));
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1, "probe 必须只读缓存");

        gate.refresh().expect("refresh 应成功");
        assert_eq!(calls.load(Ordering::SeqCst), 2, "refresh 重跑一次探测器");
    }

    #[test]
    fn declared_only_refuses_a_detector_and_never_fails_the_gate() {
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        let error = gate
            .register_detector(
                CapabilityId::Storage,
                Box::new(CountingDetector {
                    state: available(),
                    calls: Arc::new(AtomicU64::new(0)),
                }),
            )
            .expect_err("declared-only 不许注册探测器");
        assert_eq!(
            error,
            GateError::DeclaredOnlyNotDetectable {
                capability: CapabilityId::Storage
            }
        );

        for capability in CapabilityId::DECLARED_ONLY {
            assert_eq!(gate.probe_outcome(&capability), ProbeOutcome::DeclaredOnly);
            assert_eq!(gate.probe(&capability), CapabilityState::Unknown);
            for preset in [Preset::Freeze, Preset::Release, Preset::Generic] {
                for mandatory in [true, false] {
                    assert!(
                        gate.gate(&capability, GatePolicy::new(preset, mandatory))
                            .is_skip(),
                        "declared-only 在任何档位都只能 Skip"
                    );
                }
            }
        }
    }

    #[test]
    fn missing_detector_is_a_visible_gap_not_a_silent_unknown() {
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        assert_eq!(
            gate.probe_outcome(&CapabilityId::Fs),
            ProbeOutcome::NoDetector
        );
        assert_eq!(gate.probe(&CapabilityId::Fs), CapabilityState::Unknown);
        // 缺口在严格档下必须红：宁可红，也不假装通过。
        assert!(matches!(
            gate.gate(&CapabilityId::Fs, GatePolicy::new(Preset::Freeze, false)),
            GateDecision::Fail { .. }
        ));
    }

    #[test]
    fn detector_failure_is_not_confused_with_unknown() {
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        let error = gate
            .register_detector(CapabilityId::Fs, Box::new(BrokenDetector))
            .expect_err("首次探测就坏了，必须报错");
        assert!(matches!(error, GateError::DetectorFailed { .. }));
        // 注册已生效，故障结果可读，且不被当成"探不到"或"缺能力"。
        assert!(matches!(
            gate.probe_outcome(&CapabilityId::Fs),
            ProbeOutcome::DetectorError { .. }
        ));
        assert_eq!(gate.probe(&CapabilityId::Fs), CapabilityState::Unknown);
    }

    /// 契约：**探测器 panic ≠ "探不到"**。
    ///
    /// 四种"给不出 `Available`"的情形必须互不混淆：
    /// `NoDetector`（漏配）/ `DetectorError`（探测器坏了）/ `Unknown`（探不到）/
    /// `Unavailable`（明确不可用）。`Err` 通道测过了（[`BrokenDetector`]），
    /// 这里测**更极端的一种坏**：探测器直接 panic，连 `Err` 都没机会返回。
    ///
    /// 它必须：① 被记成 `DetectorError`（而不是 `Unknown`）；② 故障说明**点明 panic**
    /// —— 这一条同时**结构性**证明走的是 `Disconnected` 分支而不是超时分支
    /// （超时分支的说明里是"超时"），所以本测试**不需要**任何墙钟断言；
    /// ③ 注册返回值是 `Err`，但同时**注册已生效**且故障已缓存 —— 不静默丢弃。
    #[test]
    fn detector_panic_is_recorded_as_detector_error_not_as_unknown() {
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");

        let error = gate
            .register_detector(CapabilityId::Fs, Box::new(PanickingDetector))
            .expect_err("探测器 panic 必须报错，不能静默");

        assert!(
            matches!(error, GateError::DetectorFailed { .. }),
            "panic 必须走 DetectorFailed，实际 {error:?}"
        );
        // ①③ 故障被记成 DetectorError（不是"探不到"、不是"缺能力"），且注册已生效。
        match gate.probe_outcome(&CapabilityId::Fs) {
            ProbeOutcome::DetectorError { message, .. } => {
                assert!(
                    message.contains("panic"),
                    "故障说明必须点明 panic（这同时证明走的是 Disconnected 而非超时分支），实际：{message}"
                );
            }
            other => panic!("panic 必须记成 DetectorError，实际 {other:?}"),
        }
        assert_eq!(gate.probe(&CapabilityId::Fs), CapabilityState::Unknown);
        assert!(gate.probe_outcome(&CapabilityId::Fs).is_gap());
        // refresh 也必须如实报错，而不是把这张表当成刷新成功。
        assert!(matches!(
            gate.refresh(),
            Err(GateError::DetectorFailed { .. })
        ));
    }

    #[test]
    fn probe_timeout_maps_to_unavailable_even_though_the_detector_succeeds_later() {
        let gate =
            DefaultCapabilityGate::new("0.2.0-rc.2").with_probe_timeout(Duration::from_millis(40));
        let started = std::time::Instant::now();
        gate.register_detector(
            CapabilityId::Fs,
            Box::new(SlowDetector {
                sleep: Duration::from_millis(400),
            }),
        )
        .expect("超时不等于注册失败");
        let elapsed = started.elapsed();

        assert!(
            elapsed < Duration::from_millis(400),
            "超时必须真的止损：实际 {elapsed:?}"
        );
        match gate.probe(&CapabilityId::Fs) {
            CapabilityState::Unavailable { reason } => {
                assert!(reason.contains("超时"), "理由必须可归因：{reason}");
            }
            other => panic!("超时必须记 Unavailable，而不是 {other:?}"),
        }
    }

    #[test]
    fn refresh_rejects_nothing_and_keeps_declared_only_placeholders() {
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        gate.register_detector(
            CapabilityId::Fs,
            Box::new(CountingDetector {
                state: available(),
                calls: Arc::new(AtomicU64::new(0)),
            }),
        )
        .expect("注册应成功");
        gate.refresh().expect("refresh 应成功");
        assert_eq!(
            gate.probe_outcome(&CapabilityId::Storage),
            ProbeOutcome::DeclaredOnly
        );
        assert!(matches!(
            gate.probe_outcome(&CapabilityId::Fs),
            ProbeOutcome::Detected(CapabilityState::Available { .. })
        ));
    }

    #[test]
    fn version_verdict_is_exposed_without_touching_the_decision_table() {
        let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
        assert_eq!(gate.version_verdict(), VersionVerdict::Compatible);
        assert_eq!(gate.declared_range(), DEFAULT_DECLARED_RANGE);
        gate.set_host_version("0.1.0");
        assert_eq!(gate.version_verdict(), VersionVerdict::Incompatible);
        assert_eq!(gate.host_version(), "0.1.0");
    }
}
