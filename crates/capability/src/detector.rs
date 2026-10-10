//! 能力探测器与宿主服务存在性来源。
//!
//! **真源的更正（`spec/contracts/capabilities.yaml` 的 `DRIFT-CAP-4`）**：
//! 能力探测**不在** `src/isolation/probes.ts`（那里探的是 tmpdir / 端口 / 进程残留）。
//! 能力的真正探测链是：
//!
//! 1. 声明：`src/cases/types.ts:26-50`（`HostCapability` 联合类型）
//! 2. 映射：`src/host-facade.ts:29-54`（`CAPABILITY_SERVICE`，形如 [`crate::CapabilityId::service_key`]）
//! 3. 探测：`src/host-facade.ts:105-147`（`CapabilitySet`，**惰性** `ctx.get(service) !== undefined`）
//!
//! 本模块的 [`HostServicePresence`] 就是第 3 步的**可注入替身**：
//! `has_service(key)` 与 `ctx.get(key) !== undefined` 一一对应。
//! Rust 侧不直连 cordis（设计 §1.1：跨语言契约只走协议），所以宿主把"服务在不在"喂进来，
//! 由本模块把它转成 [`CapabilityState`]。
//!
//! **惰性 vs 快照**：旧实现踩过的坑（`src/host-facade.ts:88-104`）是"拍快照会把后注册的
//! `subagents` / `userQuestions` 误判为缺失"。本 crate 的对策不是"更晚拍快照"，
//! 而是把**重新探测**变成一个显式动作 [`crate::CapabilityGate::refresh`]——
//! 什么时候信这张快照由调用方决定，且刷新是原子的。

use std::sync::Arc;
use std::time::Duration;

use crate::decision::CapabilityState;
use crate::gate::{CapabilityGate, GateError};
use crate::id::CapabilityId;

/// 一次探测的上下文。
///
/// 设计 §3.4 要求"`probe` 的输入需要 DSH 版本"：能力是否存在常常取决于宿主版本，
/// 所以探测上下文里带宿主版本与声明范围，探测器可以据此返回 `Unavailable`。
///
/// **版本不兼容本身不走能力门控**（设计 §3.4 第 5 条：归退出码 `6`/`3`，归 `7` 的只有
/// "必需能力缺失"）。上下文只负责把事实交给探测器，不做裁决。
#[derive(Debug, Clone)]
pub struct ProbeContext {
    /// 被探测的能力。
    pub capability: CapabilityId,
    /// 宿主 DSH 版本（原始字符串，未规范化）。
    pub dsh_version: String,
    /// 本仓声明支持的 DSH 版本范围（`spec/contracts/versions.yaml`）。
    pub declared_range: String,
    /// 本次探测的超时上限（设计 §3.4 第 3 条：超时即"可归因的事实"）。
    pub timeout: Duration,
}

impl ProbeContext {
    /// 构造探测上下文。
    pub fn new(
        capability: CapabilityId,
        dsh_version: impl Into<String>,
        declared_range: impl Into<String>,
        timeout: Duration,
    ) -> Self {
        ProbeContext {
            capability,
            dsh_version: dsh_version.into(),
            declared_range: declared_range.into(),
            timeout,
        }
    }

    /// 宿主版本与声明范围的**薄**判定结果（见 [`crate::VersionVerdict`]）。
    pub fn version_verdict(&self) -> crate::VersionVerdict {
        crate::check_dsh_version(&self.dsh_version, &self.declared_range)
    }
}

/// 能力探测器：把"这台机器有没有这个能力"变成一个可断言的结论。
///
/// 对象安全、`Send + Sync`（`CapabilityGate` 要在线程间共享，超时要在 worker 线程上跑）。
///
/// ## 返回值的语义边界（**必须区分**）
///
/// - `Ok(state)` = 探测**得出了结论**。其中 `Unknown` 也是一条结论：**"探不到"**——
///   它不是"干净"，也不是"不可用"。
/// - `Err(_)` = **探测器本身坏了**（探测代码异常、注入失败、协议错误……）。
///   这与"探不到"不是一回事，绝不能被 `unwrap()` 吞掉；门控会把它记成
///   [`crate::ProbeOutcome::DetectorError`]，并在 `probe` 那层如实退化成 `Unknown`
///   （因为没得出可归因结论），同时错误在 [`crate::ProbeOutcome`] 与 `refresh` 的返回值里可见。
pub trait CapabilityDetector: Send + Sync {
    /// 执行一次探测。见 trait 文档的"返回值的语义边界"。
    fn detect(&self, ctx: &ProbeContext) -> Result<CapabilityState, GateError>;
}

/// 宿主服务存在性来源 —— 旧实现 `getService(ctx, name)` 的可注入替身。
///
/// 语义与 `src/host-facade.ts:76-86` 的 `getService` 一致：
/// `ctx.get(key)` 返回 `undefined` / `null` 或抛错，一律算"不具备"。
pub trait HostServicePresence: Send + Sync {
    /// 指定服务 key 是否存在。
    fn has_service(&self, service_key: &str) -> bool;
}

impl<F> HostServicePresence for F
where
    F: Fn(&str) -> bool + Send + Sync,
{
    fn has_service(&self, service_key: &str) -> bool {
        self(service_key)
    }
}

/// 通用探测器：**服务在 → `Available`；服务不在 → `Unavailable`**。
///
/// 这是阶段 1 唯一"真实探测"形态，直接照搬 `CapabilitySet.has()` 的判定
/// （`ctx.get(service_key) !== undefined`），用的服务名一律取自
/// [`CapabilityId::service_key`]（含 `session → agents`、`client → clientModules` 两处不同名）。
///
/// 细节里刻意带上了服务名，这样 G1 的"已知环境 → 期望结果"表能看见探测**走了哪个 key**，
/// 而不是只看到一个布尔结论。
pub struct ServicePresenceDetector {
    capability: CapabilityId,
    presence: Arc<dyn HostServicePresence>,
}

impl ServicePresenceDetector {
    /// 为一个能力构造探测器。
    pub fn new(capability: CapabilityId, presence: Arc<dyn HostServicePresence>) -> Self {
        ServicePresenceDetector {
            capability,
            presence,
        }
    }

    /// 该探测器使用的服务 key。
    pub fn service_key(&self) -> &'static str {
        self.capability.service_key()
    }
}

impl CapabilityDetector for ServicePresenceDetector {
    fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
        let service = self.capability.service_key();
        if self.presence.has_service(service) {
            Ok(CapabilityState::Available {
                details: Some(serde_json::json!({
                    "service": service,
                    "capability": self.capability.name(),
                })),
            })
        } else {
            Ok(CapabilityState::Unavailable {
                reason: format!(
                    "宿主未提供 DSH 服务 `{service}`，能力 `{}` 不可用",
                    self.capability.name()
                ),
            })
        }
    }
}

/// 给 16 个"有行为"的能力批量注册服务存在性探测器，返回注册个数。
///
/// **declared-only 的 4 个能力会被跳过**（`agentLoop` / `storage` / `timer` / `client`）：
/// 它们零消费点、无场景可触发，给它们造探测器等于把"没有行为可验"伪装成"有行为可验"。
/// 若强行注册，[`CapabilityGate::register_detector`] 会返回
/// [`GateError::DeclaredOnlyNotDetectable`]。所以这里的返回个数**应当**是 16，
/// 调用方可以据此断言（`spec/contracts/capabilities.yaml`：有行为的能力 16/16）。
pub fn register_service_presence_detectors(
    gate: &dyn CapabilityGate,
    presence: Arc<dyn HostServicePresence>,
) -> Result<usize, GateError> {
    let mut registered = 0usize;
    for capability in CapabilityId::ALL {
        if capability.is_declared_only() {
            continue;
        }
        let detector = ServicePresenceDetector::new(capability, Arc::clone(&presence));
        gate.register_detector(capability, Box::new(detector))?;
        registered += 1;
    }
    Ok(registered)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn service_presence_maps_to_available_or_unavailable() {
        let present: BTreeSet<String> = ["fs", "agents"].iter().map(|s| s.to_string()).collect();
        let presence: Arc<dyn HostServicePresence> =
            Arc::new(move |key: &str| present.contains(key));

        let ctx = ProbeContext::new(
            CapabilityId::Fs,
            "0.2.0-rc.2",
            ">=0.2.0-rc.2",
            Duration::from_millis(500),
        );
        let fs_detector = ServicePresenceDetector::new(CapabilityId::Fs, Arc::clone(&presence));
        assert!(matches!(
            fs_detector.detect(&ctx).expect("探测器不报错"),
            CapabilityState::Available { .. }
        ));

        // session 的服务名是 agents：能力名 grep 不到的 key 必须仍然命中。
        let session_detector =
            ServicePresenceDetector::new(CapabilityId::Session, Arc::clone(&presence));
        assert_eq!(session_detector.service_key(), "agents");
        assert!(matches!(
            session_detector.detect(&ctx).expect("探测器不报错"),
            CapabilityState::Available { .. }
        ));

        let storage_detector =
            ServicePresenceDetector::new(CapabilityId::Subprocess, Arc::clone(&presence));
        assert!(matches!(
            storage_detector.detect(&ctx).expect("探测器不报错"),
            CapabilityState::Unavailable { .. }
        ));
    }
}
