//! 比对引擎：按表逐字段比对两份 `run.json`。
//!
//! 输入是**旧实现**与**新实现**各自产出的报告（`serde_json::Value`），
//! 规则来自 [`ReconcileTable`]。输出 [`ReconciliationReport`]。
//!
//! # 三条实现纪律
//! 1. **判定路径只用 `BTreeMap` / `BTreeSet`**（设计 §6.4）：差异清单的顺序必须可复现，
//!    否则 A4 的"可复现率"会假性失败。
//! 2. **未声明 ≠ 不等价**：表里没有的字段进 `undeclared_fields`，**不**产生 mismatch。
//! 3. **开放子树**：`assertion` 对象上的未知键进 `uncompared_fields`（归 `unknown`），
//!    **不得**把整条断言判成结构不等价（`reconcile-fields.yaml` 的 `open_subtree_discipline` ②）。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::Value;

use crate::normalize::normalize_value;
use crate::table::{open_subtrees, Disposition, ReconcileTable, OPEN_ASSERTION_KEYS};
use crate::{Equivalence, FieldMatch, FieldMismatch, ReconciliationReport};

/// 阶段 1 **新增**进 `schemas/run-report.schema.json` 的叶子路径。
///
/// 为什么在这里显式列出：`reconcile-fields.yaml` 是**生成物**（生成器在仓库外的临时目录），
/// 而本 crate 的写权限不含 `spec/**`。所以 A3 闭环测试的断言写成
/// 「未声明叶子 ⊆ 本清单」——差集**不是**静默放过，而是被点名到一个已知、可审计的集合。
/// **这是"schema 先变、声明后补"的真实顺序的留痕**（Lead 2026-10-11 明确要求保留）：
/// 阶段 1 的 schema 增量先落地（task-15 的 `totals.inconclusive`、task-16 的
/// `cases[].steps[].assertions[].outcome` 与 `cases[].trace`），
/// `reconcile-fields.yaml` 的对应声明由 spec-contracts 侧补。
/// 补完后应把 A3 断言收紧为「差集为空」，但**这条中间态注释要留着**——
/// 它记录了"没闭合"与"假装闭合"的区别。
pub const STAGE1_SCHEMA_ADDITIONS: [&str; 3] = [
    "totals.inconclusive",
    "cases[].steps[].assertions[].outcome",
    "cases[].trace[]",
];

/// 比对选项。
#[derive(Debug, Clone, PartialEq)]
pub struct ReconcileOptions {
    /// `range` 等价关系的 ratio 口径：**声明式** `rule: "ratio: legacy/3 .. legacy*3"`
    /// 的实现（`reconcile-fields.yaml` 的 `cases[].durationMs` 用它）。
    ///
    /// 为什么用 ratio 而不是绝对区间：绝对区间与机器相关（D1–D3 的基线冻结已经踩过这个坑），
    /// ratio 口径可跨机器复算。缺省 `3.0` 即 `legacy/3 .. legacy*3`；
    /// 个别路径需要绝对区间时用 [`ReconcileOptions::ranges`] 覆盖。
    pub range_ratio: f64,
    /// 显式区间（按 schema 叶子路径声明）；给了就不走缺省倍数。
    pub ranges: BTreeMap<String, (f64, f64)>,
}

impl Default for ReconcileOptions {
    fn default() -> Self {
        Self {
            range_ratio: 3.0,
            ranges: BTreeMap::new(),
        }
    }
}

/// 把 schema 叶子路径（`cases[].verdict`）切成段。
#[derive(Debug, Clone, PartialEq, Eq)]
struct Segment {
    key: String,
    array: bool,
}

fn parse_segments(pattern: &str) -> Vec<Segment> {
    pattern
        .split('.')
        .map(|raw| {
            if let Some(key) = raw.strip_suffix("[]") {
                Segment {
                    key: key.to_string(),
                    array: true,
                }
            } else {
                Segment {
                    key: raw.to_string(),
                    array: false,
                }
            }
        })
        .collect()
}

fn join_path(path: &str, key: &str) -> String {
    if path.is_empty() {
        key.to_string()
    } else {
        format!("{path}.{key}")
    }
}

fn walk(value: &Value, segments: &[Segment], path: &str, out: &mut BTreeMap<String, Value>) {
    match segments.first() {
        None => {
            out.insert(path.to_string(), value.clone());
        }
        Some(segment) => {
            let Some(child) = value.get(&segment.key) else {
                return;
            };
            let child_path = join_path(path, &segment.key);
            if segment.array {
                if let Value::Array(items) = child {
                    for (index, item) in items.iter().enumerate() {
                        walk(item, &segments[1..], &format!("{child_path}[{index}]"), out);
                    }
                }
            } else {
                walk(child, &segments[1..], &child_path, out);
            }
        }
    }
}

/// 把某个 JSON 按 pattern 展开成 `实例路径 → 值`（有序）。
fn collect_instances(value: &Value, pattern: &str) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    walk(value, &parse_segments(pattern), "", &mut out);
    out
}

/// 稳定的可读形态（`serde_json` 的 `Map` 缺省是 `BTreeMap`，键有序）。
fn display(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "<unprintable>".to_string())
}

fn canonical(value: &Value) -> String {
    display(value)
}

fn sorted_canonical(value: &Value) -> Vec<String> {
    match value {
        Value::Array(items) => {
            let mut rendered: Vec<String> = items.iter().map(canonical).collect();
            rendered.sort();
            rendered
        }
        other => vec![canonical(other)],
    }
}

fn number_of(value: &Value) -> Option<f64> {
    value.as_f64()
}

/// 按一条等价关系比对两个值，返回是否一致。
fn values_match(
    equivalence: Equivalence,
    pattern: &str,
    legacy: &Value,
    new: &Value,
    options: &ReconcileOptions,
    used: &mut BTreeSet<&'static str>,
) -> bool {
    match equivalence {
        Equivalence::Exact => canonical(legacy) == canonical(new),
        Equivalence::Normalized => {
            let left = normalize_value(legacy, used);
            let right = normalize_value(new, used);
            canonical(&left) == canonical(&right)
        }
        Equivalence::SetSorted => sorted_canonical(legacy) == sorted_canonical(new),
        Equivalence::LowerBound => match (number_of(legacy), number_of(new)) {
            (Some(low), Some(high)) => high >= low,
            // 非数值时退化为"归一化后精确相等"，而不是直接判不一致——
            // 那是把"字段类型变了"与"值不一样"混为一谈。
            _ => canonical(legacy) == canonical(new),
        },
        Equivalence::Range => match (number_of(legacy), number_of(new)) {
            (Some(low), Some(high)) => {
                let (min, max) = options.ranges.get(pattern).copied().unwrap_or_else(|| {
                    let ratio = if options.range_ratio.abs() < 1.0 {
                        1.0
                    } else {
                        options.range_ratio.abs()
                    };
                    (low / ratio, low * ratio)
                });
                let (min, max) = if min <= max { (min, max) } else { (max, min) };
                high >= min && high <= max
            }
            _ => canonical(legacy) == canonical(new),
        },
        // `NotCompared` 在调用方处理（它要进 uncompared_fields，不产生 mismatch）。
        Equivalence::NotCompared => true,
    }
}

/// 开放子树里的未知断言键（`assertion` 对象上不在固定键集里的键）。
fn collect_unknown_assertion_keys(value: &Value, prefix: &str, dirties: &mut BTreeSet<String>) {
    let Some(cases) = value.get("cases").and_then(Value::as_array) else {
        return;
    };
    for (case_index, case) in cases.iter().enumerate() {
        let Some(steps) = case.get("steps").and_then(Value::as_array) else {
            continue;
        };
        for (step_index, step) in steps.iter().enumerate() {
            let Some(assertions) = step.get("assertions").and_then(Value::as_array) else {
                continue;
            };
            for (assertion_index, assertion) in assertions.iter().enumerate() {
                let Some(object) = assertion.get("assertion").and_then(Value::as_object) else {
                    continue;
                };
                let base = format!(
                    "{prefix}cases[{case_index}].steps[{step_index}].assertions[{assertion_index}].assertion"
                );
                for key in object.keys() {
                    if !OPEN_ASSERTION_KEYS.contains(&key.as_str()) {
                        dirties.insert(format!("{base}.{key}"));
                    }
                }
            }
        }
    }
}

/// 表驱动对拍：把两份报告逐字段比对。
///
/// `case_id` 归属由实例路径推导（`cases[2].…` → `cases[2]`），A1 的"点名到具体 case"靠它。
pub fn compare_reports(
    legacy: &Value,
    new: &Value,
    table: &ReconcileTable,
    options: &ReconcileOptions,
) -> ReconciliationReport {
    let mut report = ReconciliationReport::default();
    let mut used: BTreeSet<&'static str> = BTreeSet::new();
    let mut uncompared: BTreeSet<String> = BTreeSet::new();
    let mut undeclared: BTreeSet<String> = BTreeSet::new();

    for (pattern, entry) in &table.entries {
        let legacy_instances = collect_instances(legacy, pattern);
        let new_instances = collect_instances(new, pattern);
        let mut instance_paths: BTreeSet<String> = BTreeSet::new();
        instance_paths.extend(legacy_instances.keys().cloned());
        instance_paths.extend(new_instances.keys().cloned());

        for instance_path in instance_paths {
            let legacy_value = legacy_instances.get(&instance_path);
            let new_value = new_instances.get(&instance_path);

            if entry.disposition == Disposition::DeclaredNotCompared {
                uncompared.insert(instance_path);
                continue;
            }

            match (legacy_value, new_value) {
                (Some(left), Some(right)) => {
                    if values_match(entry.equivalence, pattern, left, right, options, &mut used) {
                        report.matches.push(FieldMatch {
                            path: instance_path,
                            equivalence: entry.equivalence,
                        });
                    } else {
                        report.mismatches.push(FieldMismatch {
                            case_id: FieldMismatch::case_id_of(&instance_path),
                            path: instance_path,
                            equivalence: entry.equivalence,
                            expected: display(left),
                            actual: display(right),
                        });
                    }
                }
                (Some(left), None) => {
                    if entry.equivalence != Equivalence::NotCompared {
                        report.mismatches.push(FieldMismatch {
                            case_id: FieldMismatch::case_id_of(&instance_path),
                            path: instance_path,
                            equivalence: entry.equivalence,
                            expected: display(left),
                            actual: "<missing>".to_string(),
                        });
                    }
                }
                (None, Some(right)) => {
                    if entry.equivalence != Equivalence::NotCompared {
                        report.mismatches.push(FieldMismatch {
                            case_id: FieldMismatch::case_id_of(&instance_path),
                            path: instance_path,
                            equivalence: entry.equivalence,
                            expected: "<missing>".to_string(),
                            actual: display(right),
                        });
                    }
                }
                (None, None) => {}
            }
        }
    }

    // 运行期冒出来的、表里没有的字段：A3 缺口，必须可见（但不产生 mismatch）。
    for side in [legacy, new] {
        collect_unknown_assertion_keys(side, "", &mut uncompared);
    }

    // 运行期冒出来、表里没声明的字段（**不止顶层**）：阶段 0 实测的 `cases[].trace`
    // 就是活样本——它真的被写进 run.json（spec/behaviors/engine/report.md 的 RP-1），
    // 而 schema 里根本没有。排除两类：
    //   ① 声明路径的**父前缀**（如 `cases[]`、`cases[].steps[]` 本身不是叶子）；
    //   ② 开放子树**内部**的键（它们由 collect_unknown_assertion_keys 单独处理）。
    let declared: BTreeSet<&str> = table.declared_paths();
    let open: Vec<String> = if table.open_subtrees.is_empty() {
        open_subtrees()
            .iter()
            .map(|item| (*item).to_string())
            .collect()
    } else {
        table.open_subtrees.clone()
    };
    let mut observed: BTreeSet<String> = BTreeSet::new();
    for side in [legacy, new] {
        collect_all_patterns(side, "", &mut observed);
    }
    for pattern in observed {
        if declared.contains(pattern.as_str()) {
            continue;
        }
        if declared
            .iter()
            .any(|candidate| candidate.starts_with(&format!("{pattern}.")))
        {
            continue;
        }
        if open
            .iter()
            .any(|subtree| pattern.starts_with(&format!("{subtree}.")))
        {
            continue;
        }
        undeclared.insert(pattern);
    }

    report
        .matches
        .sort_by(|left, right| left.path.cmp(&right.path));
    report
        .mismatches
        .sort_by(|left, right| left.path.cmp(&right.path));
    report.normalized_fields = used.iter().copied().map(str::to_string).collect();
    report.uncompared_fields = uncompared.into_iter().collect();
    report.undeclared_fields = undeclared.into_iter().collect();
    report
}

/// 枚举一份报告里**所有**叶子的 schema 形态路径（数组下标归一成 `[]`）。
///
/// 用途只有一个：把"表里没声明"的字段找出来（`undeclared_fields`）。
/// 粒度是叶子——一个未声明的对象会产出它下面的每个叶子路径。
fn collect_all_patterns(value: &Value, path: &str, out: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if map.is_empty() {
                out.insert(path.to_string());
                return;
            }
            for (key, child) in map {
                collect_all_patterns(child, &join_path(path, key), out);
            }
        }
        Value::Array(items) => {
            if items.is_empty() {
                out.insert(format!("{path}[]"));
                return;
            }
            for item in items {
                collect_all_patterns(item, &format!("{path}[]"), out);
            }
        }
        _ => {
            out.insert(path.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::table::parse_reconcile_table;
    use serde_json::json;

    fn table() -> ReconcileTable {
        parse_reconcile_table(
            r#"
meta:
  not_compared_allowlist:
    - path: cases[].usage.tokens
  open_subtrees:
    - cases[].steps[].assertions[].assertion
fields:
  - path: runId
    equivalence: normalized
    disposition: compared
  - path: totals.total
    equivalence: exact
    disposition: compared
  - path: cases[].id
    equivalence: exact
    disposition: compared
  - path: cases[].verdict
    equivalence: exact
    disposition: compared
  - path: cases[].durationMs
    equivalence: range
    disposition: compared
  - path: cases[].usage.modelCalls
    equivalence: lower-bound
    disposition: compared
  - path: cases[].usage.tokens
    equivalence: not-compared
    disposition: declared-not-compared
  - path: cases[].steps[].assertions[].assertion.ref
    equivalence: exact
    disposition: compared
  - path: cases[].steps[].assertions[].assertion.is
    equivalence: exact
    disposition: compared
  - path: cases[].steps[].assertions[].assertion.soft
    equivalence: exact
    disposition: compared
"#,
        )
    }

    fn report(run_id: &str, verdict: &str) -> Value {
        json!({
            "runId": run_id,
            "totals": { "total": 1 },
            "cases": [{
                "id": "TK-0001",
                "verdict": verdict,
                "durationMs": 100,
                "usage": { "modelCalls": 1, "tokens": 10 },
                "steps": [{ "assertions": [{ "assertion": { "ref": "fx.a", "is": 1, "soft": false } }] }]
            }]
        })
    }

    #[test]
    fn identical_reports_are_clean() {
        let options = ReconcileOptions::default();
        let report = compare_reports(
            &report("2026-10-11T00-00-00_aaaa", "passed"),
            &report("2026-10-11T09-99-99_zzzz", "passed"),
            &table(),
            &options,
        );
        assert!(report.is_clean(), "runId 差异应被归一化掉：{report:?}");
        assert!(report.normalized_fields.contains(&"runid".to_string()));
    }

    #[test]
    fn verdict_difference_is_reported_with_case_id() {
        let options = ReconcileOptions::default();
        let report = compare_reports(
            &report("run-1", "passed"),
            &report("run-1", "failed"),
            &table(),
            &options,
        );
        assert!(!report.is_clean());
        let mismatch = &report.mismatches[0];
        assert_eq!(mismatch.path, "cases[0].verdict");
        assert_eq!(mismatch.case_id, "cases[0]");
    }

    #[test]
    fn not_compared_goes_to_uncompared_and_never_to_mismatch() {
        let options = ReconcileOptions::default();
        let report = compare_reports(
            &report("run-1", "passed"),
            &report("run-1", "passed"),
            &table(),
            &options,
        );
        assert!(report
            .uncompared_fields
            .contains(&"cases[0].usage.tokens".to_string()));
        assert!(report.is_clean());
    }

    #[test]
    fn unknown_assertion_key_does_not_make_the_assertion_structurally_different() {
        let options = ReconcileOptions::default();
        let legacy = json!({
            "cases": [{ "steps": [{ "assertions": [
                { "assertion": { "ref": "fx.a", "is": 1, "soft": false } }
            ]}]}]
        });
        let new = json!({
            "cases": [{ "steps": [{ "assertions": [
                { "assertion": { "ref": "fx.a", "is": 1, "soft": false, "futureWord": 7 } }
            ]}]}]
        });
        let report = compare_reports(&legacy, &new, &table(), &options);
        assert!(report.is_clean(), "未知键不得判结构不等价：{report:?}");
        assert!(report
            .uncompared_fields
            .iter()
            .any(|path| path.contains("futureWord")));
    }

    #[test]
    fn lower_bound_and_range_semantics() {
        let options = ReconcileOptions::default();
        let legacy = json!({
            "cases": [{ "durationMs": 100, "usage": { "modelCalls": 2 } }]
        });
        let within = json!({
            "cases": [{ "durationMs": 150, "usage": { "modelCalls": 2 } }]
        });
        let beyond = json!({
            "cases": [{ "durationMs": 10_000, "usage": { "modelCalls": 1 } }]
        });
        assert!(compare_reports(&legacy, &within, &table(), &options).is_clean());
        let dirty = compare_reports(&legacy, &beyond, &table(), &options);
        // durationMs 超出区间 + modelCalls 低于下界 → 两处差异
        assert_eq!(dirty.mismatches.len(), 2, "{dirty:?}");
    }
}
