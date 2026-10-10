//! 四态判定与 `Inconclusive` 连续 3 次升级规则（设计 §3.3、§8.4 硬约束 3 / 3b）。
//!
//! # 与既有 TS 实现的差异（必须点名）
//!
//! 旧实现只有 `ok: boolean` **两态**（`AssertionResult.ok`）；`Skipped` 在旧实现里是
//! **场景级**（`SkipCase` → `CaseVerdict='skipped'`），**断言级不存在**；
//! `Inconclusive` 在 `src/**` 与 `tests/**` **零命中**，是本设计新引入的第四态。
//! 本文件同时覆盖四态**与**新增的升级规则——它们在旧实现里都没有对应物，
//! 所以这里没有"旧用例对照"，只有设计文档与硬约束。
//!
//! # 插件词"只对特定 ref 生效"的约定
//!
//! 本 crate 的 `AssertionSpec` 是 `cases` schema 的镜像（**没有**插件词的字段），
//! 所以插件词按"注册即参与派发"处理。为了不让插件词影响其它断言的判定，
//! 本文件的插件只对 `fx.probe*` 这类 ref 生效，其余 ref 一律返回 `Passed`——
//! 这样每一条用例的意图都是**显式**的，而不是靠派发顺序猜出来的。

use dsh_testkit_assertion::{
    AssertionContext, AssertionEngine, AssertionError, AssertionEvaluator, AssertionMetadata,
    AssertionOutcome, AssertionSpec, BufferedAssertionEngine, StreakTracker,
};
use serde_json::{json, Value};

/// 造上下文。
fn ctx(scenario: &str) -> AssertionContext {
    let mut ctx = AssertionContext::new(scenario);
    ctx.fixture = Some(json!({"n": 5, "s": "xxabcxx", "nil": null, "probe": "probe"}));
    ctx
}

/// 从 JSON 造断言。
fn spec(value: Value) -> AssertionSpec {
    serde_json::from_value(value).expect("断言行必须能反序列化")
}

/// 一个只对 `fx.probe` 生效、返回 `Inconclusive` 的求值器。
struct ProbeInconclusive;

impl AssertionEvaluator for ProbeInconclusive {
    fn evaluate(
        &self,
        actual: &Value,
        spec: &AssertionSpec,
        meta: &AssertionMetadata,
    ) -> AssertionOutcome {
        if spec.ref_path != "fx.probe" {
            // 不关我的事：让内建词说话。
            return AssertionOutcome::Passed {
                details: None,
                soft: spec.is_soft(),
            };
        }
        AssertionOutcome::Inconclusive {
            reason: "跨平台浮点差异超过容差且不可归因".to_string(),
            literal: spec.ref_path.clone(),
            actual: actual.clone(),
            actual_absent: meta.actual_absent,
            soft: spec.is_soft(),
        }
    }

    fn name(&self) -> &str {
        "zz_inconclusive"
    }
}

/// 一个只对 `fx.probe` 生效、返回断言级 `Skipped` 的求值器。
struct ProbeSkipped;

impl AssertionEvaluator for ProbeSkipped {
    fn evaluate(
        &self,
        _actual: &Value,
        spec: &AssertionSpec,
        _meta: &AssertionMetadata,
    ) -> AssertionOutcome {
        if spec.ref_path != "fx.probe" {
            return AssertionOutcome::Passed {
                details: None,
                soft: spec.is_soft(),
            };
        }
        AssertionOutcome::Skipped {
            reason: "宿主不提供该能力".to_string(),
            soft: spec.is_soft(),
        }
    }

    fn name(&self) -> &str {
        "zz_skipped"
    }
}

/// 只装 `Skipped` 插件的引擎（`fx.probe` 上产出断言级 `Skipped`）。
///
/// **每个引擎只装一个插件**是刻意的：插件词按"注册即参与"派发，
/// 两个插件同时命中一条断言时，结果取决于**注册顺序**（见 `plugin_words` 的文档）。
/// 让每条用例只面对一个插件，意图才是显式的。
fn skipped_engine() -> BufferedAssertionEngine {
    let engine = BufferedAssertionEngine::new();
    engine
        .register("zz_skipped", Box::new(ProbeSkipped))
        .expect("注册");
    engine
}

/// 只装 `Inconclusive` 插件的引擎（`fx.probe` 上产出 `Inconclusive`）。
fn inconclusive_engine() -> BufferedAssertionEngine {
    let engine = BufferedAssertionEngine::new();
    engine
        .register("zz_inconclusive", Box::new(ProbeInconclusive))
        .expect("注册");
    engine
}

/// 四态之一：`Passed`。
#[test]
fn state_passed() {
    let engine = BufferedAssertionEngine::new();
    let outcome = engine.assert(&ctx("TK-S"), &spec(json!({"ref": "fx.n", "is": 5})));
    assert!(outcome.counts_as_passed());
    assert!(!outcome.counts_as_failed());
    assert!(!outcome.counts_as_skipped());
    assert!(!outcome.counts_as_inconclusive());
    assert!(outcome.reason().is_none(), "通过时没有失败原因");
    assert!(!outcome.counts_as_hard_failure());
}

/// 四态之二：`Failed`（**不是** `Result::Err`——设计 §3.1 的核心纪律）。
#[test]
fn state_failed_is_a_value_not_an_error() {
    let engine = BufferedAssertionEngine::new();
    let outcome = engine.assert(&ctx("TK-S"), &spec(json!({"ref": "fx.n", "is": 1})));
    assert!(outcome.counts_as_failed());
    assert!(!outcome.counts_as_passed());
    assert!(outcome.counts_as_hard_failure(), "硬失败要改变 verdict");
    assert_eq!(outcome.reason(), Some("期望 is 1，实际 5"));
    // `Failed` 必须带 `expected` / `actual` / `diff`，报告才能自证差异。
    match outcome {
        AssertionOutcome::Failed {
            expected,
            actual,
            diff,
            actual_absent,
            soft,
            ..
        } => {
            assert_eq!(expected, json!(1));
            assert_eq!(actual, json!(5));
            assert!(!actual_absent);
            assert!(!diff.is_empty());
            assert!(!soft);
        }
        other => panic!("应为 Failed：{other:?}"),
    }
}

/// 四态之三：`Skipped`（**断言级**，与场景级 `SkipCase` 不同层）。
#[test]
fn state_skipped_is_assertion_level() {
    let engine = skipped_engine();
    let outcome = engine.assert(
        &ctx("TK-S"),
        &spec(json!({"ref": "fx.probe", "exists": true})),
    );
    assert!(outcome.counts_as_skipped());
    assert!(!outcome.counts_as_passed());
    assert!(!outcome.counts_as_failed());
    assert!(!outcome.counts_as_inconclusive());
    assert!(
        !outcome.counts_as_hard_failure(),
        "断言级 skip 不改变 verdict"
    );
    assert_eq!(outcome.reason(), Some("宿主不提供该能力"));
}

/// 四态之四：`Inconclusive`（不计入 passed、也不计入 failed——设计 §3.3）。
#[test]
fn state_inconclusive_is_a_separate_bucket() {
    let engine = inconclusive_engine();
    let outcome = engine.assert(
        &ctx("TK-S"),
        &spec(json!({"ref": "fx.probe", "exists": true})),
    );
    assert!(outcome.counts_as_inconclusive());
    assert!(!outcome.counts_as_passed());
    assert!(
        !outcome.counts_as_failed(),
        "Inconclusive 不是 failed（独立计数）"
    );
    assert!(!outcome.counts_as_hard_failure());
    assert_eq!(outcome.reason(), Some("跨平台浮点差异超过容差且不可归因"));
}

/// 聚合层把四态**分开计数**（不能把 `Inconclusive` 悄悄并进 failed）。
#[test]
fn aggregate_keeps_four_buckets_separate() {
    let specs = [
        spec(json!({"ref": "fx.n", "is": 5})),
        spec(json!({"ref": "fx.n", "is": 1})),
        spec(json!({"ref": "fx.probe", "exists": true})),
    ];
    // 引擎 A：`fx.probe` 落在断言级 `Skipped`。
    let skipped = skipped_engine().assert_all(&ctx("TK-AGG"), &specs);
    assert_eq!(skipped.outcomes.len(), 3, "顺序与入参一一对应");
    assert_eq!(skipped.passed, 1);
    assert_eq!(skipped.failed, 1);
    assert_eq!(skipped.skipped, 1);
    assert_eq!(skipped.inconclusive, 0);
    assert!(skipped.has_hard_failure());

    // 引擎 B：同样的输入，`fx.probe` 落在 `Inconclusive` —— **绝不能并进 failed**。
    let inconclusive = inconclusive_engine().assert_all(&ctx("TK-AGG"), &specs);
    assert_eq!(inconclusive.passed, 1);
    assert_eq!(inconclusive.failed, 1, "Inconclusive 不算 failed");
    assert_eq!(inconclusive.skipped, 0);
    assert_eq!(inconclusive.inconclusive, 1);
    assert!(inconclusive.has_hard_failure(), "硬失败来自那条 is:1");
}

/// 升级规则：**偶发 2 次不升级、连续 3 次升级**（设计 §8.4 硬约束 3b 的机械形式）。
#[test]
fn streak_two_does_not_escalate_three_does() {
    let engine = inconclusive_engine();
    let ctx = ctx("TK-STREAK");
    // 同一个判据：同一场景 + 同一 ref + 同一词集。
    let spec = spec(json!({"ref": "fx.probe", "exists": true}));

    let first = engine.assert(&ctx, &spec);
    assert!(first.counts_as_inconclusive(), "第 1 次：偶发，不升级");
    let second = engine.assert(&ctx, &spec);
    assert!(second.counts_as_inconclusive(), "第 2 次：偶发，不升级");
    let third = engine.assert(&ctx, &spec);
    assert!(third.counts_as_failed(), "第 3 次：连续 3 次 ⇒ 升级为失败");
    let message = third.reason().unwrap_or_default();
    assert!(message.contains("连续 3 次"), "{message}");
    assert!(
        message.contains("跨平台浮点差异"),
        "升级消息必须带原 reason：{message}"
    );
    // 升级后的结果**算硬失败**（否则升级没有意义）。
    assert!(third.counts_as_hard_failure());
}

/// **不同判据各自独立计数**：A 判据连续 2 次不会把 B 判据也推到升级。
#[test]
fn streak_counters_are_per_criterion() {
    let engine = inconclusive_engine();
    let ctx = ctx("TK-STREAK");
    let spec_a = spec(json!({"ref": "fx.probe", "exists": true}));
    let spec_b = spec(json!({"ref": "fx.probe", "notExists": false}));

    assert!(engine.assert(&ctx, &spec_a).counts_as_inconclusive());
    assert!(engine.assert(&ctx, &spec_a).counts_as_inconclusive());
    // B 判据（同场景、同 ref，但**词集不同**）是"全新"的：第 1 次不该升级。
    let b_first = engine.assert(&ctx, &spec_b);
    assert!(
        b_first.counts_as_inconclusive(),
        "另一个判据的计数必须独立：{b_first:?}"
    );
    // A 的第 3 次升级。
    assert!(engine.assert(&ctx, &spec_a).counts_as_failed());
}

/// **不同场景各自独立计数**（键里必须带场景 id，否则跨场景会串味）。
#[test]
fn streak_counters_are_per_scenario() {
    let engine = inconclusive_engine();
    let spec = spec(json!({"ref": "fx.probe", "exists": true}));
    let first = ctx("TK-A");
    let second = ctx("TK-B");

    assert!(engine.assert(&first, &spec).counts_as_inconclusive());
    assert!(engine.assert(&first, &spec).counts_as_inconclusive());
    let other_scenario = engine.assert(&second, &spec);
    assert!(
        other_scenario.counts_as_inconclusive(),
        "不同场景必须独立计数：{other_scenario:?}"
    );
}

/// 一次通过（或一次失败）**清零**计数——"连续"才升级，偶发中断即重置。
#[test]
fn pass_resets_the_streak() {
    let engine = inconclusive_engine();
    let ctx = ctx("TK-RESET");
    let inconclusive_spec = spec(json!({"ref": "fx.probe", "exists": true}));

    assert!(engine
        .assert(&ctx, &inconclusive_spec)
        .counts_as_inconclusive());
    assert!(engine
        .assert(&ctx, &inconclusive_spec)
        .counts_as_inconclusive());
    let criterion = AssertionMetadata::derive_criterion_id("TK-RESET", "fx.probe", &["exists"]);
    assert_eq!(engine.streaks().count_of(&criterion), 2);
    // 直接观测一条通过：清零。
    engine.streaks().observe(
        &criterion,
        &AssertionOutcome::Passed {
            details: None,
            soft: false,
        },
    );
    assert_eq!(engine.streaks().count_of(&criterion), 0, "通过必须清零");
    // 清零后连两次仍不升级。
    assert!(engine
        .assert(&ctx, &inconclusive_spec)
        .counts_as_inconclusive());
    assert!(engine
        .assert(&ctx, &inconclusive_spec)
        .counts_as_inconclusive());
}

/// 断言级 `Skipped` **不改动**计数（跳过既不是判定，也不是"连续"里的一次）。
#[test]
fn skip_does_not_touch_the_streak() {
    let tracker = StreakTracker::new();
    let inconclusive = AssertionOutcome::Inconclusive {
        reason: "测不准".into(),
        literal: "x".into(),
        actual: Value::Null,
        actual_absent: false,
        soft: false,
    };
    tracker.observe("k", &inconclusive);
    tracker.observe("k", &inconclusive);
    let skipped = AssertionOutcome::Skipped {
        reason: "缺能力".into(),
        soft: false,
    };
    assert_eq!(tracker.observe("k", &skipped).count, 2, "skip 不动计数");
    assert!(!tracker.observe("k", &skipped).reached_threshold);
    // 再来一次 Inconclusive ⇒ 第 3 次 ⇒ 升级。
    assert!(tracker.observe("k", &inconclusive).reached_threshold);
}

/// `reset()` 清空全部计数（`repeat` 多轮之间必须能清，否则上一轮会把下一轮推向升级）。
#[test]
fn reset_clears_all_counters() {
    let tracker = StreakTracker::new();
    let inconclusive = AssertionOutcome::Inconclusive {
        reason: "测不准".into(),
        literal: "x".into(),
        actual: Value::Null,
        actual_absent: false,
        soft: false,
    };
    tracker.observe("a", &inconclusive);
    tracker.observe("b", &inconclusive);
    tracker.reset();
    assert_eq!(tracker.count_of("a"), 0);
    assert_eq!(tracker.count_of("b"), 0);
}

/// 阈值可传参（不写死 3）：阈值 2 时第 2 次就升级；阈值下限是 1。
#[test]
fn threshold_is_configurable_and_at_least_one() {
    let engine = BufferedAssertionEngine::try_new_with_threshold(2).expect("建引擎");
    engine
        .register("zz_inconclusive", Box::new(ProbeInconclusive))
        .expect("注册");
    let ctx = ctx("TK-THRESHOLD");
    let spec = spec(json!({"ref": "fx.probe", "exists": true}));
    assert!(engine.assert(&ctx, &spec).counts_as_inconclusive());
    assert!(
        engine.assert(&ctx, &spec).counts_as_failed(),
        "阈值 2 ⇒ 第 2 次升级"
    );
    assert_eq!(
        StreakTracker::with_threshold(0).threshold(),
        1,
        "阈值下限是 1"
    );
    assert_eq!(engine.streaks().threshold(), 2);
}

/// `AssertionError` 是"工具坏了"的错误类型，实现 `std::error::Error` 且可读。
#[test]
fn assertion_error_is_a_std_error() {
    let engine = BufferedAssertionEngine::new();
    struct Dummy;
    impl AssertionEvaluator for Dummy {
        fn evaluate(
            &self,
            _: &Value,
            _: &AssertionSpec,
            _: &AssertionMetadata,
        ) -> AssertionOutcome {
            AssertionOutcome::Passed {
                details: None,
                soft: false,
            }
        }
    }
    let error: AssertionError = engine
        .register("is", Box::new(Dummy))
        .expect_err("重名应报错");
    assert_eq!(
        error,
        AssertionError::AlreadyRegistered {
            name: "is".to_string()
        }
    );
    let as_std: &dyn std::error::Error = &error;
    assert!(as_std.to_string().contains("is"));
}
