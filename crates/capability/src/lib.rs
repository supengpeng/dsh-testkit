//! `capability` —— 能力门控（`CapabilityGate`）。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.4；分母清单 `spec/contracts/capabilities.yaml`。
//!
//! **这一段的核心是"如实告知"，不是"尽量通过"**：
//! - 探测超时 **500ms** 视为 `Unavailable`（不是 `Unknown`）——超时是一个**可归因的事实**。
//! - `Unknown` 与"缺能力"**不是一回事**：`Unknown` 在严格档下按 `Fail` 处理
//!   （宁可红，不假装通过），非严格档按 `Skip`。这是既有 `src/isolation/probes.ts`
//!   "探不到标 unknown，绝不标干净"纪律的延续。
//! - `refresh` 必须是**原子替换**：刷新期间 `probe` 返回旧值，不返回半新半旧。
//!
//! # 分层边界（设计 §1.2）
//!
//! 本 crate **只**实现能力门控。`src/executor/policy.ts` 是成本 / 沙箱的**安全边界**，
//! 设计 §1.2 明确它留在 TS —— 能力门控的输入里没有任何成本字段，两者不许合并。
//!
//! # 20 个能力的两段式读数（`capabilities.yaml` 的 `b2_coverage`）
//!
//! - **有行为的能力 16/16**：有真实探测器（[`ServicePresenceDetector`] + [`register_service_presence_detectors`]），
//!   其中 `approval` / `session` / `web` / `goals` 是"只被探测、从不按能力名门控"的 4 个。
//! - **declared-only 4/4（单列）**：`agentLoop` / `storage` / `timer` / `client` —— 零消费点、
//!   无场景可触发，见 [`CapabilityId::DECLARED_ONLY`]。它们**不注册探测器**，
//!   `probe` 返回 `Unknown`，但 [`ProbeOutcome::DeclaredOnly`] 会显式区分出"这是已裁决的常态"
//!   而不是"漏配"。[`CapabilityGate::gate`] 对它们**永远 `Skip`**（不参与策略矩阵）。
//!
//! **不得**把两段合并成 `20/20 = 100%`。
//!
//! # 阶段状态
//!
//! 阶段 1 完整实现：20 个能力标识 + 服务映射、探测器注册 / 缓存、500ms 超时、
//! 原子 refresh、四态决策、G2 版本判定。G1/G3 的表驱动与策略矩阵测试在 `tests/`。

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::disallowed_types)]

mod decision;
mod detector;
mod gate;
mod id;
mod version;

pub use decision::{decide, decide_with_policy, CapabilityState, GateDecision, GatePolicy, Preset};
pub use detector::{
    register_service_presence_detectors, CapabilityDetector, HostServicePresence, ProbeContext,
    ServicePresenceDetector,
};
pub use gate::{
    CapabilityGate, CapabilityMap, DefaultCapabilityGate, GateError, ProbeOutcome,
    DEFAULT_DECLARED_RANGE, PROBE_TIMEOUT_MS,
};
pub use id::CapabilityId;
pub use version::{
    check_dsh_version, compare_versions, parse_version, Version, VersionVerdict,
    DECLARED_SUPPORTED_VERSIONS, SUPPORTED_RANGE_SYNTAX,
};
