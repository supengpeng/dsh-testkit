//! 报告形状与 `schemas/run-report.schema.json` 的机器对账。
//!
//! 覆盖三件事（结构契约的那一半；逐字段**等价关系**由 `crates/reconciler` 负责）：
//! 1. 本阶段新增的 `totals.inconclusive` 确实是 schema 里的字段，且**没有**破坏既有的
//!    五个必需计数（RFC §5「只新增、不删既有字段」）；
//! 2. `TestReport` 序列化后的键**都是** schema 声明过的（不冒出未声明字段）；
//! 3. schema 的 `required` 集合在生成的报告里**都存在**。

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use dsh_testkit_executor::{
    AssertionRecord, AssertionVerdict, ConfidenceLevel, ExecutionTrace, Layer, RunTotals,
    ScenarioMetadata, StepTrace, TestReport,
};
use serde_json::{json, Value};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn schema() -> Value {
    let path = repo_root().join("schemas/run-report.schema.json");
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("读不到 {}：{error}", path.display()));
    serde_json::from_str(&text).expect("schema 是合法 JSON")
}

fn keys_of(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default()
}

fn required_of(schema: &Value) -> Vec<String> {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn sample_report() -> TestReport {
    let meta = ScenarioMetadata {
        scenario_id: "TK-9001".to_string(),
        title: "形状自检".to_string(),
        layer: Layer::L3,
        confidence: ConfidenceLevel::Real,
        shared_context: false,
        depth: 1,
        seed: Some(1),
    };
    let trace = ExecutionTrace {
        steps: vec![StepTrace {
            node_id: "n1".to_string(),
            tool_kind: "call-tool".to_string(),
            order: 0,
            verdict: AssertionVerdict::Passed,
            confidence: ConfidenceLevel::Real,
            duration_ms: 1,
            detail: None,
            assertions: vec![AssertionRecord {
                reference: "fx.a".to_string(),
                word: Some("is".to_string()),
                expected: Some(json!(1)),
                soft: false,
                verdict: AssertionVerdict::Passed,
                message: "fx.a 满足 is".to_string(),
                actual: json!(1),
            }],
            notes: serde_json::Map::new(),
        }],
        released: vec!["tmpdir".to_string()],
        release_failures: Vec::new(),
        leftovers: Vec::new(),
        totals: RunTotals {
            total: 1,
            passed: 1,
            ..RunTotals::default()
        },
        // K1：实际执行报出的可信度与 plan 声明一致（此 helper 不制造违规）。
        confidence: Some(ConfidenceLevel::Real),
        confidence_violations: Vec::new(),
    };
    TestReport::from_trace(
        &meta,
        &trace,
        "run-1",
        "t0",
        "t1",
        "cases",
        "0.2.0-rc.2",
        "win32",
    )
}

#[test]
fn inconclusive_is_added_without_touching_existing_required_counts() {
    let schema = schema();
    let totals = &schema["$defs"]["totals"];
    let properties = keys_of(&totals["properties"]);

    assert!(
        properties.contains("inconclusive"),
        "阶段 1 必须给 totals 补上 inconclusive"
    );
    for existing in ["total", "passed", "failed", "skipped", "errored"] {
        assert!(
            properties.contains(existing),
            "既有计数 {existing} 不得消失（RFC §5：只新增、不删既有字段）"
        );
    }

    let required = required_of(totals);
    for existing in ["total", "passed", "failed", "skipped", "errored"] {
        assert!(
            required.contains(&existing.to_string()),
            "既有必需计数 {existing} 的 required 状态不得改动"
        );
    }
    assert!(
        !required.contains(&"inconclusive".to_string()),
        "新增字段不进 required（既有报告缺省即视为 0，不能因此变非法）"
    );
}

#[test]
fn report_keys_are_all_declared_by_the_schema() {
    let schema = schema();
    let value = serde_json::to_value(sample_report()).expect("serialize");

    let declared = keys_of(&schema["properties"]);
    for key in keys_of(&value) {
        assert!(
            declared.contains(&key),
            "报告里出现了 schema 未声明的顶层字段 `{key}`；若这是刻意新增，必须同时改 schema"
        );
    }
    for key in required_of(&schema) {
        assert!(
            value.get(&key).is_some(),
            "schema 的 required 字段 `{key}` 在报告中缺失"
        );
    }
}

#[test]
fn case_step_and_assertion_shapes_match_their_schema_defs() {
    let schema = schema();
    let value = serde_json::to_value(sample_report()).expect("serialize");
    let case = &value["cases"][0];

    let case_def = &schema["$defs"]["caseOutcome"];
    let case_keys = keys_of(case);
    let case_properties = keys_of(&case_def["properties"]);
    for key in &case_keys {
        assert!(
            case_properties.contains(key),
            "case 里出现了未声明字段 `{key}`"
        );
    }
    for key in required_of(case_def) {
        assert!(case_keys.contains(&key), "case 缺 required 字段 `{key}`");
    }

    let step = &case["steps"][0];
    let step_def = &schema["$defs"]["stepOutcome"];
    for key in keys_of(step) {
        assert!(
            keys_of(&step_def["properties"]).contains(&key),
            "step 里出现了未声明字段 `{key}`"
        );
    }
    for key in required_of(step_def) {
        assert!(
            keys_of(step).contains(&key),
            "step 缺 required 字段 `{key}`"
        );
    }

    let assertion = &step["assertions"][0];
    let assertion_def = &schema["$defs"]["assertionOutcome"];
    for key in keys_of(assertion) {
        assert!(
            keys_of(&assertion_def["properties"]).contains(&key),
            "assertion 结果里出现了未声明字段 `{key}`"
        );
    }
    for key in required_of(assertion_def) {
        assert!(
            keys_of(assertion).contains(&key),
            "assertion 结果缺 required 字段 `{key}`"
        );
    }
    // 断言原文的键必须在开放子树的固定键集里（16 键）。
    for key in keys_of(&assertion["assertion"]) {
        assert!(
            [
                "ref",
                "is",
                "isNot",
                "notIs",
                "exists",
                "notExists",
                "contains",
                "notContains",
                "matches",
                "atLeast",
                "atMost",
                "length",
                "lengthAtLeast",
                "lengthAtMost",
                "throws",
                "soft"
            ]
            .contains(&key.as_str()),
            "断言原文出现开放子树固定键集之外的键：`{key}`"
        );
    }
}

#[test]
fn optional_fields_are_omitted_rather_than_null() {
    let value = serde_json::to_value(sample_report()).expect("serialize");
    assert!(
        value.get("policySnapshot").is_none(),
        "未启用的可选字段不该出现"
    );
    assert!(value.get("selection").is_none());
    assert!(value.get("execution").is_none());
    assert!(value.get("redaction").is_none());
    assert!(
        value["cases"][0]["sourceIssue"].is_null(),
        "sourceIssue 必须存在且可为 null（schema 允许 string | null）"
    );
}

#[test]
fn assertion_outcome_is_optional_four_state() {
    let schema = schema();
    let assertion = &schema["$defs"]["assertionOutcome"];

    assert!(
        keys_of(&assertion["properties"]).contains("outcome"),
        "task-16 裁决：断言级四态必须进 schema（否则阶段 2 无法对拍四态）"
    );
    // 「只新增」的底线：不进 required ⇒ 缺 outcome 的旧报告仍然合法。
    assert!(
        !required_of(assertion).contains(&"outcome".to_string()),
        "outcome 不得进 required：旧实现产出的 run.json 不能因此变非法"
    );
    for existing in ["assertion", "ok", "actual", "message", "soft"] {
        assert!(
            required_of(assertion).contains(&existing.to_string()),
            "既有 required 字段 `{existing}` 不得改动"
        );
    }
    let variants: Vec<String> = assertion["properties"]["outcome"]["enum"]
        .as_array()
        .expect("outcome 必须是 enum")
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    assert_eq!(
        variants,
        vec![
            "passed".to_string(),
            "failed".to_string(),
            "skipped".to_string(),
            "inconclusive".to_string()
        ],
        "四态集合必须精确"
    );

    // 生成的报告确实带上了 outcome（本实现总是写它）。
    let value = serde_json::to_value(sample_report()).expect("serialize");
    assert_eq!(
        value["cases"][0]["steps"][0]["assertions"][0]["outcome"],
        "passed"
    );
}

#[test]
fn trace_is_an_optional_free_shape_array() {
    let schema = schema();
    let case_def = &schema["$defs"]["caseOutcome"];
    let trace = &case_def["properties"]["trace"];

    assert_eq!(trace["type"], "array", "trace 声明为数组");
    assert!(
        trace["items"]
            .as_object()
            .map(serde_json::Map::is_empty)
            .unwrap_or(false),
        "trace 的内部结构不声明（空 schema = 自由形状）——这是「任意形状都合法」的结构证据"
    );
    assert!(
        !required_of(case_def).contains(&"trace".to_string()),
        "trace 不得进 required（阶段 0 的旧报告没有它）"
    );

    // 自由形状：放进去任意内容都不违反「items 为空 schema」的约定。
    let mut value = serde_json::to_value(sample_report()).expect("serialize");
    value["cases"][0]["trace"] =
        json!([{ "phase": "act", "weird": [1, "x", null], "nested": { "a": true } }]);
    assert!(value["cases"][0]["trace"].is_array());
    // 生成的报告默认就带 trace（诊断数据，对拍时 not-compared）。
    let produced = serde_json::to_value(sample_report()).expect("serialize");
    assert!(
        produced["cases"][0]["trace"].is_array(),
        "executor 应产出 trace（schema 字段要有真实来源）"
    );
}
