//! G3 —— **Gate 决策正确率** = 决策与设计 §3.4 裁决表一致的比例（门槛 100%）。
//!
//! 判据来源：`docs/REWRITE-METRICS.md` §8 L210（"策略矩阵（档 × 能力状态 × `requires`）跑决策"）。
//!
//! 矩阵 = 3 档 preset × 3 种 [`CapabilityState`] × mandatory 两值 = **18 格**。
//! 每一格的期望决策在下面**逐行写死**（不是用被测逻辑推导出来的），期望退出码也一并钉住
//! （设计 §3.4 第 5 条是"门控与退出码的唯一裁决表"）。
//!
//! 矩阵同时跑两条路径：
//! - [`DefaultCapabilityGate::gate`]：端到端（探测器 → 快照 → 决策）；
//! - [`dsh_testkit_capability::decide_with_policy`]：纯决策函数。
//!
//! 两条必须逐格一致，否则说明"门控"和"裁决表"之间漏了一层。

use dsh_testkit_capability::{
    decide_with_policy, CapabilityDetector, CapabilityGate, CapabilityId, CapabilityState,
    DefaultCapabilityGate, GateDecision, GateError, GatePolicy, Preset, ProbeContext,
};

/// 探测器返回的固定结论。
struct FixedDetector(CapabilityState);

impl CapabilityDetector for FixedDetector {
    fn detect(&self, _ctx: &ProbeContext) -> Result<CapabilityState, GateError> {
        Ok(self.0.clone())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StateKind {
    Available,
    Unavailable,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecisionKind {
    Proceed,
    Skip,
    Fail,
    Degrade,
}

fn state_of(kind: StateKind) -> CapabilityState {
    match kind {
        StateKind::Available => CapabilityState::Available {
            details: Some(serde_json::json!({ "probe": "known-environment" })),
        },
        StateKind::Unavailable => CapabilityState::Unavailable {
            reason: "宿主未提供该服务".to_string(),
        },
        StateKind::Unknown => CapabilityState::Unknown,
    }
}

fn gate_with(state: StateKind) -> DefaultCapabilityGate {
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
    gate.register_detector(CapabilityId::Fs, Box::new(FixedDetector(state_of(state))))
        .expect("注册固定结论探测器");
    gate
}

fn kind_of(decision: &GateDecision) -> DecisionKind {
    match decision {
        GateDecision::Proceed => DecisionKind::Proceed,
        GateDecision::Skip { .. } => DecisionKind::Skip,
        GateDecision::Fail { .. } => DecisionKind::Fail,
        GateDecision::Degrade { .. } => DecisionKind::Degrade,
        other => panic!("未知决策：{other:?}"),
    }
}

/// 设计 §3.4 裁决表的 18 格，逐行写死：(档, 状态, mandatory, 期望决策, 期望退出码)。
const MATRIX: [(Preset, StateKind, bool, DecisionKind, i32); 18] = [
    // freeze：唯一承诺"与原 0.2.0 等价"的档。
    (
        Preset::Freeze,
        StateKind::Available,
        true,
        DecisionKind::Proceed,
        0,
    ),
    (
        Preset::Freeze,
        StateKind::Available,
        false,
        DecisionKind::Proceed,
        0,
    ),
    // 缺能力在 freeze **永远 Skip**（把环境问题记成 Fail 会污染等价性证据）。
    (
        Preset::Freeze,
        StateKind::Unavailable,
        true,
        DecisionKind::Skip,
        0,
    ),
    (
        Preset::Freeze,
        StateKind::Unavailable,
        false,
        DecisionKind::Skip,
        0,
    ),
    // 但"探不到"在 freeze 是 Fail：严格档宁可红，不假装通过。
    (
        Preset::Freeze,
        StateKind::Unknown,
        true,
        DecisionKind::Fail,
        7,
    ),
    (
        Preset::Freeze,
        StateKind::Unknown,
        false,
        DecisionKind::Fail,
        7,
    ),
    // release：发布门槛。
    (
        Preset::Release,
        StateKind::Available,
        true,
        DecisionKind::Proceed,
        0,
    ),
    (
        Preset::Release,
        StateKind::Available,
        false,
        DecisionKind::Proceed,
        0,
    ),
    // 只有"必需能力缺失"走退出码 7。
    (
        Preset::Release,
        StateKind::Unavailable,
        true,
        DecisionKind::Fail,
        7,
    ),
    (
        Preset::Release,
        StateKind::Unavailable,
        false,
        DecisionKind::Skip,
        0,
    ),
    (
        Preset::Release,
        StateKind::Unknown,
        true,
        DecisionKind::Fail,
        7,
    ),
    (
        Preset::Release,
        StateKind::Unknown,
        false,
        DecisionKind::Fail,
        7,
    ),
    // generic：快速反馈，允许 mock。
    (
        Preset::Generic,
        StateKind::Available,
        true,
        DecisionKind::Proceed,
        0,
    ),
    (
        Preset::Generic,
        StateKind::Available,
        false,
        DecisionKind::Proceed,
        0,
    ),
    (
        Preset::Generic,
        StateKind::Unavailable,
        true,
        DecisionKind::Skip,
        0,
    ),
    (
        Preset::Generic,
        StateKind::Unavailable,
        false,
        DecisionKind::Skip,
        0,
    ),
    (
        Preset::Generic,
        StateKind::Unknown,
        true,
        DecisionKind::Skip,
        0,
    ),
    (
        Preset::Generic,
        StateKind::Unknown,
        false,
        DecisionKind::Skip,
        0,
    ),
];

#[test]
fn g3_matrix_covers_every_cell_of_the_3x3x2_cross_product_exactly_once() {
    assert_eq!(MATRIX.len(), 18);
    let mut seen: Vec<(Preset, StateKind, bool)> = MATRIX
        .iter()
        .map(|(preset, state, mandatory, _, _)| (*preset, *state, *mandatory))
        .collect();
    seen.sort_by_key(|(preset, state, mandatory)| {
        (format!("{preset:?}"), format!("{state:?}"), *mandatory)
    });
    seen.dedup();
    assert_eq!(seen.len(), 18, "18 格必须互不相同且恰好覆盖 3×3×2");

    for preset in [Preset::Freeze, Preset::Release, Preset::Generic] {
        for state in [
            StateKind::Available,
            StateKind::Unavailable,
            StateKind::Unknown,
        ] {
            for mandatory in [true, false] {
                assert!(
                    seen.contains(&(preset, state, mandatory)),
                    "矩阵漏格：{preset:?} × {state:?} × mandatory={mandatory}"
                );
            }
        }
    }
}

#[test]
fn g3_every_cell_matches_the_design_ruling_table() {
    for (preset, state_kind, mandatory, expected_kind, expected_exit) in MATRIX {
        let state = state_of(state_kind);
        let policy = GatePolicy::new(preset, mandatory);

        // 路径 1：纯决策函数。
        let pure = decide_with_policy(&state, &policy);
        assert_eq!(
            kind_of(&pure),
            expected_kind,
            "decide_with_policy：{preset:?} × {state_kind:?} × mandatory={mandatory}"
        );
        assert_eq!(pure.exit_code(), expected_exit);

        // 路径 2：端到端门控。
        let gate = gate_with(state_kind);
        let decision = gate.gate(&CapabilityId::Fs, policy.clone());
        assert_eq!(
            kind_of(&decision),
            expected_kind,
            "gate：{preset:?} × {state_kind:?} × mandatory={mandatory}"
        );
        assert_eq!(decision.exit_code(), expected_exit);
    }
}

#[test]
fn g3_exit_code_seven_only_for_missing_mandatory_or_unknown_in_strict_presets() {
    let seven: Vec<(Preset, StateKind, bool)> = MATRIX
        .iter()
        .filter(|(_, _, _, _, exit)| *exit == 7)
        .map(|(preset, state, mandatory, _, _)| (*preset, *state, *mandatory))
        .collect();
    assert_eq!(
        seven,
        vec![
            (Preset::Freeze, StateKind::Unknown, true),
            (Preset::Freeze, StateKind::Unknown, false),
            (Preset::Release, StateKind::Unavailable, true),
            (Preset::Release, StateKind::Unknown, true),
            (Preset::Release, StateKind::Unknown, false),
        ]
    );
    // 版本不匹配 / 协议不匹配**不在**这张表里：它们归 6 / 3，不经能力门控（设计 §3.4 第 5 条）。
    assert_eq!(PROTOCOL_AND_ENV_EXIT_CODES, [6, 3]);
}

/// 显式登记"不经门控"的两个退出码，防止有人把它们塞进 `Fail`。
const PROTOCOL_AND_ENV_EXIT_CODES: [i32; 2] = [6, 3];

#[test]
fn g3_generic_with_fallback_degrades_instead_of_skipping() {
    // 设计 §3.4 裁决表第 3 行：非严格档缺能力 → `Degrade`（有 fallback）或 `Skip`。
    let gate = gate_with(StateKind::Unavailable);
    let decision = gate.gate(
        &CapabilityId::Fs,
        GatePolicy::new(Preset::Generic, false).with_fallback("offline-file"),
    );
    assert_eq!(
        decision,
        GateDecision::Degrade {
            fallback: "offline-file".to_string()
        }
    );
    assert_eq!(decision.exit_code(), 0, "降级不是失败");

    // 严格档即使给了 fallback 也不降级（§8.4 硬约束 4：不允许隐式降级）。
    for preset in [Preset::Freeze, Preset::Release] {
        let decision = gate.gate(
            &CapabilityId::Fs,
            GatePolicy::new(preset, false).with_fallback("offline-file"),
        );
        assert!(
            decision.is_skip(),
            "{preset:?} 不允许降级，实际 {decision:?}"
        );
    }
}

#[test]
fn g3_declared_only_capabilities_never_enter_the_policy_matrix() {
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");
    for capability in CapabilityId::DECLARED_ONLY {
        for preset in [Preset::Freeze, Preset::Release, Preset::Generic] {
            for mandatory in [true, false] {
                let decision = gate.gate(&capability, GatePolicy::new(preset, mandatory));
                assert_eq!(
                    kind_of(&decision),
                    DecisionKind::Skip,
                    "declared-only `{}` 在 {preset:?} × mandatory={mandatory} 只能 Skip",
                    capability.name()
                );
                assert_eq!(decision.exit_code(), 0);
            }
        }
    }
}
