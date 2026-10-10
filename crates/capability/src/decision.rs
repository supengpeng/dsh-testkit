//! 能力状态、门控决策、三档 preset 与**唯一裁决表**。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.4（`CapabilityState` / `GateDecision` / 裁决表）
//! 与 §8.3（三档 preset）、§8.4（硬约束）。

use serde::{Deserialize, Serialize};

/// 能力探测状态（设计 §3.4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum CapabilityState {
    /// 可用，可选带证据。
    Available {
        /// 可选证据（例如探测命中的服务名、宿主版本）。
        details: Option<serde_json::Value>,
    },
    /// 明确不可用，`reason` 必须可归因。
    Unavailable {
        /// 可归因的原因（"为什么这台机器没有该能力"）。
        reason: String,
    },
    /// 探不到。**不等于干净，也不等于不可用。**
    Unknown,
}

/// 门控决策四态（设计 §3.4）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum GateDecision {
    /// 继续执行。
    Proceed,
    /// 跳过，不计失败。
    Skip {
        /// 跳过原因（必须可归因）。
        reason: String,
    },
    /// 失败（仅"必需能力缺失"走这里）。
    Fail {
        /// 失败原因（必须可归因）。
        reason: String,
    },
    /// 降级到 fallback 路径（`release` 档禁止，见设计 §8.4 硬约束 6）。
    Degrade {
        /// 降级走的那条路径名。
        fallback: String,
    },
}

impl GateDecision {
    /// 该决策对应的进程退出码（设计 §3.4 第 5 条的唯一裁决表）。
    ///
    /// - `Proceed` / `Skip` / `Degrade` → `0`（跳过与降级都不是失败，沿用 `src/cli/exit.ts` 语义）
    /// - `Fail` → `7`（**只有**"必需能力缺失"能走到 `7`）
    ///
    /// 表里另外两个码**不经本 crate**：协议不匹配 → `6`（握手阶段拒绝）、
    /// 版本不兼容 → `6`（协议）/ `3`（环境）。把它们落到 `7` 是本设计明确要修正的原稿错误。
    pub fn exit_code(&self) -> i32 {
        match self {
            GateDecision::Proceed | GateDecision::Skip { .. } | GateDecision::Degrade { .. } => 0,
            GateDecision::Fail { .. } => 7,
        }
    }

    /// 是否为"没跑"（`Skip`）。`Skip` 与 `Fail` 必须是两回事：前者不计失败，后者计。
    pub fn is_skip(&self) -> bool {
        matches!(self, GateDecision::Skip { .. })
    }
}

/// 运行时档位（设计 §8.3 的三档 preset）。
///
/// 三档分开的理由：原稿让同一个 `dsh-strict` 同时承担"冻结旧行为"（对拍需要）
/// 与"提高门槛"（发布需要），而这两件事**互斥**——一个承诺"与原实现逐字节等价"的档
/// 不能包含新增层级。拆开后 `freeze` 的每一分输出都可用作等价性证据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Preset {
    /// 重构期专用：唯一承诺"与原 0.2.0 行为等价"的档；缺能力只能 `Skip`，禁止 mock 冒充。
    Freeze,
    /// 发布门槛：`Real` 结果才被接受；必需能力缺失 → `Fail`。
    Release,
    /// 快速反馈：允许 mock。
    Generic,
}

/// 一次性门控策略（设计 §3.4 的 `GatePolicy`）。
///
/// `preset` 决定档位，`mandatory` 决定"缺少该能力时是不是失败"，
/// `fallback` 是**非严格档**允许走的降级路径名（设计 §3.4 裁决表第 3 行：
/// "非严格档缺能力 → `Degrade`（有 fallback）或 `Skip`"）。
///
/// 注意 `fallback` 只在 [`Preset::Generic`] 生效：`release` / `freeze` 是严格档，
/// 不允许把"缺能力"静默降级成"换条路跑"（设计 §8.4 硬约束 4：不允许隐式降级）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GatePolicy {
    /// 运行时档位。
    pub preset: Preset,
    /// 该能力是否为"必需"（场景声明 `requires: mandatory`）。
    pub mandatory: bool,
    /// 非严格档可用的降级路径名；`None` = 没有 fallback 可走，只能 `Skip`。
    pub fallback: Option<String>,
}

impl GatePolicy {
    /// 构造一个没有 fallback 的策略（最常用）。
    pub fn new(preset: Preset, mandatory: bool) -> Self {
        GatePolicy {
            preset,
            mandatory,
            fallback: None,
        }
    }

    /// 指定降级路径（只对 [`Preset::Generic`] 有意义）。
    pub fn with_fallback(mut self, fallback: impl Into<String>) -> Self {
        self.fallback = Some(fallback.into());
        self
    }
}

/// 根据档位与能力状态给出决策（设计 §3.4 的裁决表，**唯一真源**）。
///
/// 缺席的"必需能力"才 `Fail`；"未知"在严格档按 `Fail`、非严格档按 `Skip`。
pub fn decide(preset: Preset, state: &CapabilityState, mandatory: bool) -> GateDecision {
    match state {
        CapabilityState::Available { .. } => GateDecision::Proceed,
        CapabilityState::Unavailable { reason } => {
            // 只有 `release` 档会把"必需能力缺失"判为 `Fail`（设计 §8.3：必需 → 退出码 7；否则 Skip）。
            //
            // `freeze` 档**永远 Skip**：它是唯一承诺"与原 0.2.0 行为等价"的档，
            // 把"这台机器没有该能力"记成 Fail 会让等价性证据被环境问题污染——
            // 这正是 §8.3 把 freeze 与 release 拆开的理由（原稿让同一个 dsh-strict
            // 同时承担"冻结旧行为"与"提高门槛"，而这两件事互斥）。
            //
            // 这条差异由本 crate 的单元测试钉住：freeze 与 release 在同一输入下必须给出不同决策。
            if preset == Preset::Release && mandatory {
                GateDecision::Fail {
                    reason: reason.clone(),
                }
            } else {
                GateDecision::Skip {
                    reason: reason.clone(),
                }
            }
        }
        CapabilityState::Unknown => {
            if preset == Preset::Generic {
                GateDecision::Skip {
                    reason: "能力探测未得出结论（非严格档按 skip 处理）".into(),
                }
            } else {
                GateDecision::Fail {
                    reason: "能力探测未得出结论；严格档下宁可红，不假装通过".into(),
                }
            }
        }
    }
}

/// 带完整策略的裁决：在 [`decide`] 之上叠加"非严格档的 fallback 降级"。
///
/// 拆成两层是为了让 `decide` 保持设计 §3.4 裁决表的三元签名（档 × 状态 × mandatory），
/// 而 fallback 只在第 3 行（非严格档缺能力）追加一个 `Degrade` 选择。
pub fn decide_with_policy(state: &CapabilityState, policy: &GatePolicy) -> GateDecision {
    let base = decide(policy.preset, state, policy.mandatory);
    match (base, policy.preset, policy.fallback.as_ref()) {
        (GateDecision::Skip { .. }, Preset::Generic, Some(fallback)) => GateDecision::Degrade {
            fallback: fallback.clone(),
        },
        (base, _, _) => base,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_capability_in_release_fails_when_mandatory() {
        let st = CapabilityState::Unavailable {
            reason: "subagents 未提供".into(),
        };
        assert!(matches!(
            decide(Preset::Release, &st, true),
            GateDecision::Fail { .. }
        ));
        // 非必需 → skip，退出码 0
        assert!(matches!(
            decide(Preset::Release, &st, false),
            GateDecision::Skip { .. }
        ));
    }

    #[test]
    fn freeze_preset_never_fails_on_missing_capability() {
        // freeze 的语义是"冻结旧行为"：缺能力只能 skip，不能把环境问题算成行为差异。
        let st = CapabilityState::Unavailable {
            reason: "fs 未提供".into(),
        };
        assert!(matches!(
            decide(Preset::Freeze, &st, true),
            GateDecision::Skip { .. }
        ));
    }

    #[test]
    fn unknown_is_treated_as_failure_in_strict_presets() {
        // 这是"探不到标 unknown，绝不标干净"的机器形式。
        assert!(matches!(
            decide(Preset::Release, &CapabilityState::Unknown, false),
            GateDecision::Fail { .. }
        ));
        assert!(matches!(
            decide(Preset::Generic, &CapabilityState::Unknown, false),
            GateDecision::Skip { .. }
        ));
    }

    #[test]
    fn only_fail_gets_exit_code_seven() {
        assert_eq!(GateDecision::Proceed.exit_code(), 0);
        assert_eq!(GateDecision::Skip { reason: "x".into() }.exit_code(), 0);
        assert_eq!(
            GateDecision::Degrade {
                fallback: "mock".into()
            }
            .exit_code(),
            0
        );
        assert_eq!(GateDecision::Fail { reason: "x".into() }.exit_code(), 7);
    }

    #[test]
    fn degrade_only_exists_in_generic_preset() {
        let unavailable = CapabilityState::Unavailable {
            reason: "fs 未提供".into(),
        };
        let generic = GatePolicy::new(Preset::Generic, false).with_fallback("offline-file");
        assert_eq!(
            decide_with_policy(&unavailable, &generic),
            GateDecision::Degrade {
                fallback: "offline-file".into()
            }
        );
        // 严格档即使给了 fallback 也不降级（§8.4 硬约束 4：不允许隐式降级）。
        for preset in [Preset::Freeze, Preset::Release] {
            let strict = GatePolicy::new(preset, false).with_fallback("offline-file");
            assert!(matches!(
                decide_with_policy(&unavailable, &strict),
                GateDecision::Skip { .. }
            ));
        }
        // release + mandatory + fallback 仍然是 Fail（缺必需能力不因 fallback 而放行）。
        let release_mandatory =
            GatePolicy::new(Preset::Release, true).with_fallback("offline-file");
        assert!(matches!(
            decide_with_policy(&unavailable, &release_mandatory),
            GateDecision::Fail { .. }
        ));
    }

    #[test]
    fn available_always_proceeds_in_every_preset() {
        let available = CapabilityState::Available {
            details: Some(serde_json::json!({ "probe": "ok" })),
        };
        for preset in [Preset::Freeze, Preset::Release, Preset::Generic] {
            for mandatory in [true, false] {
                assert_eq!(decide(preset, &available, mandatory), GateDecision::Proceed);
            }
        }
    }
}
