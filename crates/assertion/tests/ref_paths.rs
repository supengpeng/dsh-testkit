//! `ref` 取值路径（`assert-resolve-ref` 原子）的**公开 API** 验收。
//!
//! 真源：`spec/behaviors/engine/assert.md` 的 `assert-resolve-ref`（7 条 observable）
//! 与 `docs/SCENARIO-SPEC.md` §2.5。
//!
//! # 关键纪律（spec 明写）
//!
//! `fx.*` 取的是 Fixture 取证快照：**没记过的键取到"缺失"，而不是"取值失败"**。
//! 只有**未知前缀**才算取值失败。这条语义让 `exists:false`（断言"这件事没有发生"）
//! 成为合法表达——它是本仓最常用的断言形态之一（`cases/**` 里 40+ 处）。

use dsh_testkit_assertion::{resolve_path, resolve_ref, RefSources};
use serde_json::{json, Value};

/// 造三个取值源。
fn sources() -> RefSources {
    RefSources {
        fixture: Some(json!({
            "a": {"b": [{"c": 7}]},
            "list": [10, 20],
            "flag": null,
        })),
        scenario: Some(json!({"title": "自检场景", "steps": [{"name": "第一步"}]})),
        env: Some(json!({
            "dshVersion": "1.0.0",
            "platform": "win32",
            "nodeVersion": "22.0.0",
        })),
    }
}

/// observable：`fx.` 前缀取 Fixture 快照（命中）。
#[test]
fn fx_prefix_reads_fixture_snapshot() {
    let resolved = resolve_ref("fx.a.b[0].c", &sources());
    assert!(resolved.found);
    assert_eq!(resolved.value, Some(json!(7)));
    assert!(resolved.reason.is_none());
}

/// observable（**核心纪律**）：`fx` 里**未记过的键**取到"缺失"，**不是**取值失败。
#[test]
fn fx_missing_key_is_absent_not_unresolved() {
    let resolved = resolve_ref("fx.neverNoted", &sources());
    assert!(
        resolved.found,
        "fx 是存在的容器：缺失键的 found 仍是 true（否则 exists:false 无法表达）"
    );
    assert!(resolved.is_absent());
    assert_eq!(resolved.value_or_null(), Value::Null);
    assert!(resolved.reason.is_none(), "缺失不是失败，没有 reason");
}

/// 显式 `null` 与"缺失"是**两回事**（JSON 域必须显式建模）。
#[test]
fn explicit_null_is_present_not_absent() {
    let resolved = resolve_ref("fx.flag", &sources());
    assert!(resolved.found);
    assert!(!resolved.is_absent(), "记过的 null 是**存在**的");
    assert_eq!(resolved.value, Some(Value::Null));
}

/// observable：`case.` 前缀读场景自身字段。
#[test]
fn case_prefix_reads_scenario() {
    let resolved = resolve_ref("case.title", &sources());
    assert!(resolved.found);
    assert_eq!(resolved.value, Some(json!("自检场景")));
    assert_eq!(
        resolve_ref("case.steps[0].name", &sources()).value,
        Some(json!("第一步"))
    );
}

/// observable：`env.` 前缀读运行环境（`dshVersion` / `platform` / `nodeVersion`）。
#[test]
fn env_prefix_reads_environment() {
    for (reference, expected) in [
        ("env.dshVersion", json!("1.0.0")),
        ("env.platform", json!("win32")),
        ("env.nodeVersion", json!("22.0.0")),
    ] {
        let resolved = resolve_ref(reference, &sources());
        assert!(resolved.found, "{reference} 的前缀是已知的");
        assert_eq!(resolved.value, Some(expected));
    }
}

/// observable：**未知前缀**才算取值失败，措辞 `未知 ref 前缀：<p>`。
#[test]
fn unknown_prefix_is_unresolved() {
    let resolved = resolve_ref("bogus.x", &sources());
    assert!(!resolved.found);
    assert!(resolved.is_absent());
    assert_eq!(resolved.reason.as_deref(), Some("未知 ref 前缀：bogus"));
}

/// observable：**不含点号**也算取值失败，措辞 `ref 缺少前缀：<ref>`（与未知前缀不同措辞）。
#[test]
fn missing_prefix_is_unresolved_with_a_different_reason() {
    let resolved = resolve_ref("fx", &sources());
    assert!(!resolved.found);
    assert_eq!(resolved.reason.as_deref(), Some("ref 缺少前缀：fx"));
}

/// observable：路径语法边界（点路径 / `[n]` 下标 / 空路径 / 中途断掉 / 下标落在非数组上）。
#[test]
fn resolve_path_syntax_boundaries() {
    let root = json!({"a": {"b": [{"c": 7}]}, "list": [10, 20], "nil": null});
    assert_eq!(resolve_path(&root, "a.b[0].c"), Some(json!(7)));
    assert_eq!(resolve_path(&root, "list[1]"), Some(json!(20)));
    assert_eq!(resolve_path(&root, "a.missing"), None);
    assert_eq!(
        resolve_path(&root, ""),
        Some(root.clone()),
        "空路径返回 root 本身"
    );
    assert_eq!(
        resolve_path(&root, "a."),
        None,
        "空段取不到（旧实现结论等价）"
    );
    assert_eq!(resolve_path(&root, "a.b.x[0]"), None, "下标落在非数组上");
    assert_eq!(resolve_path(&root, "list[2]"), None, "越界");
    assert_eq!(resolve_path(&root, "list[0][0]"), None);
    assert_eq!(resolve_path(&root, "nil.x"), None, "中途遇 null");
    let nested = json!([[1, 2], [3]]);
    assert_eq!(resolve_path(&nested, "[1][0]"), Some(json!(3)), "连续下标");
    assert_eq!(resolve_path(&nested, "[0][1]"), Some(json!(2)));
    assert_eq!(resolve_path(&root, "list[x]"), None, "非数字下标");
    assert_eq!(resolve_path(&root, "list[0"), None, "未闭合下标");
    assert_eq!(resolve_path(&root, "list[0]x"), None, "尾随字符");
}

/// 数据源整体缺失（`fx` 前缀但调用方没给 fixture）：仍是"缺失"而非取值失败
/// ——因为**前缀**是已知的，与"容器里有没有这个键"是两件事。
#[test]
fn missing_source_still_has_a_known_prefix() {
    let empty = RefSources::default();
    let resolved = resolve_ref("fx.anything", &empty);
    assert!(resolved.found);
    assert!(resolved.is_absent());
    // `case` / `env` 同理。
    assert!(resolve_ref("case.title", &empty).found);
    assert!(resolve_ref("env.dshVersion", &empty).found);
}

/// observable：ref 解析失败时 runner 合成的结论——`ok` 恒 false、message 取 `reason`。
///
/// 这里经**公开引擎**验证这条合成规则（阶段 2 的 executor 会照着它落 `run.json`）。
#[test]
fn unresolved_ref_fails_the_assertion_with_the_reason() {
    use dsh_testkit_assertion::{
        AssertionContext, AssertionEngine, AssertionOutcome, AssertionSpec, BufferedAssertionEngine,
    };
    let engine = BufferedAssertionEngine::new();
    let mut ctx = AssertionContext::new("TK-REF");
    ctx.fixture = Some(json!({"n": 1}));
    let spec: AssertionSpec =
        serde_json::from_value(json!({"ref": "bogus.x", "is": 1})).expect("合法");
    let outcome = engine.assert(&ctx, &spec);
    assert!(outcome.counts_as_failed(), "未知前缀 ⇒ 判定失败");
    assert_eq!(outcome.reason(), Some("未知 ref 前缀：bogus"));
    match outcome {
        AssertionOutcome::Failed {
            actual,
            actual_absent,
            expected,
            ..
        } => {
            assert_eq!(
                actual,
                Value::Null,
                "actual 写 resolved.value（缺失 ⇒ null）"
            );
            assert!(actual_absent);
            // expected 侧保留原样（本实现选 `Value::Null`：取值失败时"期望值"无意义）。
            assert_eq!(expected, Value::Null);
        }
        other => panic!("应为 Failed：{other:?}"),
    }
}

/// 未知前缀与缺前缀都失败，但**原因措辞不同**（对拍按 `normalize-path` 处理）。
#[test]
fn the_two_failure_reasons_are_distinguishable() {
    let unknown = resolve_ref("bogus.x", &sources());
    let no_prefix = resolve_ref("fx", &sources());
    assert_ne!(unknown.reason, no_prefix.reason);
    assert!(unknown.reason.unwrap_or_default().contains("未知 ref 前缀"));
    assert!(no_prefix
        .reason
        .unwrap_or_default()
        .contains("ref 缺少前缀"));
}
