//! G1 —— **能力探测正确率** = 探测结果与已知环境事实一致的比例（门槛 100%）。
//!
//! 判据来源：`docs/REWRITE-METRICS.md` §8 L208（"已知环境跑 `probe_all`，比对预期表"）。
//!
//! "已知环境"由 [`HostServicePresence`] 注入：它一一对应旧实现的
//! `CapabilitySet.has(cap) === (ctx.get(CAPABILITY_SERVICE[cap]) !== undefined)`
//! （`src/host-facade.ts:105-147`）。所以这张表同时验证两件事：
//!
//! 1. 20 个能力**逐个**的探测结论；
//! 2. 探测走的是 [`CapabilityId::service_key`] 那张映射表（含 `session → agents` 的不同名）。
//!
//! 4 个 declared-only 能力（`agentLoop` / `storage` / `timer` / `client`）在两段式读数里
//! 是**单列**的：它们的期望结论是"没有探测器、永不触发"，而不是"探测到可用"。

use std::collections::BTreeSet;
use std::sync::Arc;

use dsh_testkit_capability::{
    register_service_presence_detectors, CapabilityGate, CapabilityId, CapabilityState,
    DefaultCapabilityGate, HostServicePresence, ProbeOutcome,
};

/// 已知环境：宿主提供了哪些 DSH 服务。
struct KnownHost {
    present: BTreeSet<&'static str>,
}

impl KnownHost {
    fn with(services: &[&'static str]) -> Arc<dyn HostServicePresence> {
        let present: BTreeSet<&'static str> = services.iter().copied().collect();
        Arc::new(KnownHost { present })
    }
}

impl HostServicePresence for KnownHost {
    fn has_service(&self, service_key: &str) -> bool {
        self.present.contains(service_key)
    }
}

/// 16 个"有行为"能力的服务 key（顺序 = `capabilities.yaml` 的 members 顺序）。
///
/// 注意 `session → agents`：能力名在服务面上**不存在**，只有 `agents`。
const BEHAVIOR_SERVICE_KEYS: [&str; 16] = [
    "tools",
    "llm",
    "commands",
    "systemPrompt",
    "approval",
    "userQuestions",
    "agents",
    "fs",
    "subprocess",
    "web",
    "webServer",
    "subagents",
    "agentTeams",
    "sessions",
    "goals",
    "compaction",
];

/// G1 的预期表：20 个能力 × 2 个已知环境。
///
/// 每行 = (能力, 该能力的服务 key, 服务在时的期望, 服务不在时的期望)。
/// declared-only 的 4 行两种环境下的期望都是"占位"，因为它们根本没有服务探测面。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// `Detected(Available)`，且 `probe` 三态也是 `Available`。
    Available,
    /// `Detected(Unavailable)`，且 `probe` 三态是 `Unknown`（"缺能力"不退化成"探不到"）。
    Unavailable,
    /// `DeclaredOnly` 占位（既不 `Available` 也不 `Unavailable`）。
    DeclaredOnly,
}

fn expectation_table() -> Vec<(CapabilityId, &'static str, Expect, Expect)> {
    let behavior: [CapabilityId; 16] = [
        CapabilityId::Tools,
        CapabilityId::Llm,
        CapabilityId::Commands,
        CapabilityId::SystemPrompt,
        CapabilityId::Approval,
        CapabilityId::UserQuestions,
        CapabilityId::Session,
        CapabilityId::Fs,
        CapabilityId::Subprocess,
        CapabilityId::Web,
        CapabilityId::WebServer,
        CapabilityId::Subagents,
        CapabilityId::AgentTeams,
        CapabilityId::Sessions,
        CapabilityId::Goals,
        CapabilityId::Compaction,
    ];

    let mut rows: Vec<(CapabilityId, &'static str, Expect, Expect)> = behavior
        .iter()
        .zip(BEHAVIOR_SERVICE_KEYS.iter())
        .map(|(capability, service)| {
            (
                *capability,
                *service,
                Expect::Available,
                Expect::Unavailable,
            )
        })
        .collect();

    for capability in CapabilityId::DECLARED_ONLY {
        rows.push((
            capability,
            "\u{2014}",
            Expect::DeclaredOnly,
            Expect::DeclaredOnly,
        ));
    }

    // 表必须逐格覆盖 20 个成员，且与 ALL 集合完全相同（防"漏一个也算过"）。
    let covered: BTreeSet<CapabilityId> = rows.iter().map(|row| row.0).collect();
    let all: BTreeSet<CapabilityId> = CapabilityId::ALL.iter().copied().collect();
    assert_eq!(covered, all, "预期表必须逐个覆盖 20 个能力");
    assert_eq!(rows.len(), 20);
    rows
}

fn check_row(
    gate: &DefaultCapabilityGate,
    capability: CapabilityId,
    service: &str,
    expected: Expect,
    env_name: &str,
) {
    let outcome = gate.probe_outcome(&capability);
    let state = gate.probe(&capability);
    match expected {
        Expect::Available => {
            assert!(
                matches!(
                    outcome,
                    ProbeOutcome::Detected(CapabilityState::Available { .. })
                ),
                "[{env_name}] {} 期望 Available，实际 {outcome:?}",
                capability.name()
            );
            // 探测必须走对服务 key —— 这是 mapping_asymmetry 的机器化证据。
            let used = match &state {
                CapabilityState::Available {
                    details: Some(details),
                } => details
                    .get("service")
                    .and_then(|value| value.as_str())
                    .map(|value| value.to_string()),
                _ => None,
            };
            assert_eq!(
                used.as_deref(),
                Some(service),
                "[{env_name}] {} 用了错的服务 key",
                capability.name()
            );
        }
        Expect::Unavailable => {
            assert!(
                matches!(
                    outcome,
                    ProbeOutcome::Detected(CapabilityState::Unavailable { .. })
                ),
                "[{env_name}] {} 期望 Unavailable，实际 {outcome:?}",
                capability.name()
            );
            // "缺能力"不是"探不到"：三态必须是 Unavailable 而不是 Unknown。
            assert!(
                matches!(state, CapabilityState::Unavailable { .. }),
                "[{env_name}] {} 缺能力必须记 Unavailable，实际 {state:?}",
                capability.name()
            );
        }
        Expect::DeclaredOnly => {
            assert_eq!(
                outcome,
                ProbeOutcome::DeclaredOnly,
                "[{env_name}] {} 必须是 declared-only 占位",
                capability.name()
            );
            assert_eq!(
                state,
                CapabilityState::Unknown,
                "declared-only 的 probe 只能是 Unknown"
            );
            assert!(!outcome.is_gap(), "declared-only 不是缺口");
        }
    }
}

#[test]
fn g1_full_environment_matches_expectation_table_for_all_20_capabilities() {
    let rows = expectation_table();
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
    let registered =
        register_service_presence_detectors(&gate, KnownHost::with(&BEHAVIOR_SERVICE_KEYS))
            .expect("注册 16 个探测器");
    assert_eq!(registered, 16, "有行为的能力 = 16/16");

    for (capability, service, when_present, _) in &rows {
        check_row(&gate, *capability, service, *when_present, "full");
    }

    // 两段式读数：16 有行为 + 4 declared-only，不得合并成一个 20。
    let outcomes = gate.outcomes();
    assert_eq!(outcomes.len(), 20);
    let available = outcomes
        .values()
        .filter(|o| matches!(o, ProbeOutcome::Detected(CapabilityState::Available { .. })))
        .count();
    let declared_only = outcomes.values().filter(|o| o.is_declared_only()).count();
    let gaps = outcomes.values().filter(|o| o.is_gap()).count();
    assert_eq!((available, declared_only, gaps), (16, 4, 0));
}

#[test]
fn g1_minimal_environment_marks_absent_capabilities_unavailable() {
    let rows = expectation_table();
    let minimal: [&str; 2] = ["tools", "llm"];
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
    register_service_presence_detectors(&gate, KnownHost::with(&minimal))
        .expect("注册 16 个探测器");

    for (capability, service, when_present, when_absent) in &rows {
        // 这张表按"该能力的服务在不在"给期望；最小环境只提供 tools / llm。
        let expected = if capability.is_declared_only() {
            Expect::DeclaredOnly
        } else if minimal.contains(service) {
            *when_present
        } else {
            *when_absent
        };
        check_row(&gate, *capability, service, expected, "minimal");
    }

    let outcomes = gate.outcomes();
    let available = outcomes
        .values()
        .filter(|o| matches!(o, ProbeOutcome::Detected(CapabilityState::Available { .. })))
        .count();
    let unavailable = outcomes
        .values()
        .filter(|o| {
            matches!(
                o,
                ProbeOutcome::Detected(CapabilityState::Unavailable { .. })
            )
        })
        .count();
    assert_eq!(
        (available, unavailable),
        (2, 14),
        "16 个有行为的能力里只有 tools/llm 在"
    );
}

#[test]
fn g1_batch_probe_agrees_with_single_probe() {
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
    register_service_presence_detectors(&gate, KnownHost::with(&BEHAVIOR_SERVICE_KEYS))
        .expect("注册 16 个探测器");

    let all = gate.probe_all(&CapabilityId::ALL);
    assert_eq!(all.len(), 20);
    for capability in CapabilityId::ALL {
        assert_eq!(
            all.get(&capability),
            Some(&gate.probe(&capability)),
            "probe_all 与 probe 必须一致：{}",
            capability.name()
        );
    }
}

#[test]
fn g1_without_detectors_every_behavior_capability_is_a_visible_gap() {
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
    let outcomes = gate.outcomes();
    let gaps = outcomes.values().filter(|o| o.is_gap()).count();
    let no_detector = outcomes
        .values()
        .filter(|o| matches!(o, ProbeOutcome::NoDetector))
        .count();
    let declared_only = outcomes.values().filter(|o| o.is_declared_only()).count();
    assert_eq!((gaps, no_detector, declared_only), (16, 16, 4));
    // 探不到 ≠ 缺能力：三态都退化成 Unknown（严格档下会 Fail，宁可红）。
    for capability in CapabilityId::ALL {
        if capability.is_declared_only() {
            continue;
        }
        assert_eq!(gate.probe(&capability), CapabilityState::Unknown);
    }
}
