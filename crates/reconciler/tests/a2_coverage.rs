//! A2 读数：对拍器**实际比对**的字段数 / spec **声明要比较**的字段数。
//!
//! # A2 与 A3 的分母不同（这条不写清，后来者会去修一个不存在的 bug）
//!
//! | 指标 | 问题 | 分母 |
//! |---|---|---|
//! | **A3** | schema 的字段**有没有被处置** | **全部** schema 叶子（含 `not-compared`） |
//! | **A2** | **该比的**字段有没有真的比 | **只算** `disposition = compared` 的字段 |
//!
//! `cases[].usage.tokens`（"有值但不可信"）与 `cases[].trace[]`（"有内容但不该比"）
//! 是**有意排除**：它们进 A3 分母、**不进 A2 分母**。**"有意排除"不等于"漏比"**——
//! 把 A2 写成 `78/80` 会让人以为覆盖率只有 97.5%，然后为了"补齐"去动一个故意不比的字段。
//!
//! # 纪律：期望值一律**从真源读**
//!
//! 本文件的分子/分母都从 `spec/contracts/reconcile-fields.yaml` 装载的表里算出来，
//! **没有任何硬编码数字**。教训是实的：`a3_closure.rs` 第一版钉死了"allowlist 恰好是
//! `cases[].usage.tokens`"，而 task-17 合法地把 `cases[].trace[]` 加进 allowlist 时，
//! 两条并行工作线（一边改真源、一边钉死真源）撞在一起，workspace 全量测试红了。
//! 真源只有一个，测试要读它，不要复刻它。

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use dsh_testkit_reconciler::{
    compare_reports, parse_reconcile_table, Disposition, ReconcileOptions, ReconcileTable,
    TABLE_PATH_IN_REPO,
};
use serde_json::Value;

fn repo_root() -> PathBuf {
    // crates/reconciler → 仓库根
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn read(relative: &str) -> String {
    let path = repo_root().join(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("读不到 {}：{error}", path.display()))
}

fn table() -> ReconcileTable {
    parse_reconcile_table(&read(TABLE_PATH_IN_REPO))
}

/// 把一个 schema 叶子路径物化成最小 JSON 结构（数组段各放一个元素）。
///
/// 目的：让表里每个字段在构造的报告里**恰好出现一个实例**，
/// 这样"声明了多少个 compared 字段"与"对拍器实际比了多少个实例"可以直接对账。
fn build_leaf(pattern: &str) -> Value {
    let segments: Vec<(String, bool)> = pattern
        .split('.')
        .map(|raw| match raw.strip_suffix("[]") {
            Some(key) => (key.to_string(), true),
            None => (raw.to_string(), false),
        })
        .collect();

    let mut value = Value::String("x".to_string());
    for (key, array) in segments.iter().rev() {
        if *array {
            value = Value::Array(vec![value]);
        }
        let mut object = serde_json::Map::new();
        object.insert(key.clone(), value);
        value = Value::Object(object);
    }
    value
}

/// 深合并两个 JSON 值（对象逐键递归；数组只合并第 0 个元素）。
fn merge(target: &mut Value, incoming: Value) {
    match (target, incoming) {
        (Value::Object(existing), Value::Object(supplement)) => {
            for (key, value) in supplement {
                match existing.get_mut(&key) {
                    Some(slot) => merge(slot, value),
                    None => {
                        existing.insert(key, value);
                    }
                }
            }
        }
        (Value::Array(existing), Value::Array(mut supplement)) => {
            if existing.is_empty() {
                *existing = supplement;
            } else if !supplement.is_empty() {
                merge(&mut existing[0], supplement.remove(0));
            }
        }
        (slot, other) => *slot = other,
    }
}

/// 把表里所有声明字段物化并合并成一份报告。
fn materialize(patterns: &BTreeSet<String>) -> Value {
    let mut root = Value::Object(serde_json::Map::new());
    for pattern in patterns {
        merge(&mut root, build_leaf(pattern));
    }
    root
}

/// 实例路径 → schema 叶子路径（`[0]` → `[]`）。
fn pattern_of(instance_path: &str) -> String {
    let mut out = String::with_capacity(instance_path.len());
    let mut index = 0usize;
    let bytes = instance_path.as_bytes();
    while index < bytes.len() {
        if bytes[index] == b'[' {
            if let Some(close) = instance_path[index..].find(']') {
                out.push_str("[]");
                index += close + 1;
                continue;
            }
        }
        out.push(char::from(bytes[index]));
        index += 1;
    }
    out
}

#[test]
fn a2_compared_count_equals_the_declared_compared_fields() {
    let table = table();
    let declared_compared = table
        .entries
        .values()
        .filter(|entry| entry.disposition == Disposition::Compared)
        .count();
    let declared_not_compared: BTreeSet<String> = table
        .not_compared_paths()
        .into_iter()
        .map(str::to_string)
        .collect();

    // 物化**全部**声明字段（含 not-compared），两份完全相同的报告。
    let patterns: BTreeSet<String> = table.entries.keys().cloned().collect();
    let report_value = materialize(&patterns);
    let report = compare_reports(
        &report_value,
        &report_value,
        &table,
        &ReconcileOptions::default(),
    );

    let compared = report.compared_count();
    let percent = (compared as f64 / declared_compared as f64) * 100.0;
    println!(
        "A2 = {compared}/{declared_compared} = {percent:.2}%（实际比对字段数 / 声明为 compared 的字段数）"
    );
    println!(
        "  明细：matches {}，mismatches {}（两份相同 ⇒ 差异应为 0）",
        report.matches.len(),
        report.mismatches.len()
    );
    println!(
        "  未比对 {} 条（表里声明 not-compared {} 条）：{:?}",
        report.uncompared_fields.len(),
        declared_not_compared.len(),
        report.uncompared_fields
    );
    println!(
        "  A3 口径参考：全部声明 {} 条（A2 分母 = {} = 全部 − not-compared）",
        table.entries.len(),
        declared_compared
    );

    assert!(
        report.is_clean(),
        "A1 判据 is_clean()：两份相同的报告不得有差异：{:?}",
        report.mismatches
    );
    assert_eq!(
        compared, declared_compared,
        "A2 分子（实际比对字段数）必须等于表里 disposition=compared 的字段数；\
         对不上是**发现**，不要调数字——先查是哪个声明字段没能物化出实例"
    );
    assert!(
        report.undeclared_fields.is_empty(),
        "本测试物化了全部声明字段，不应出现未声明字段：{:?}",
        report.undeclared_fields
    );

    // 恰好等于：未比对的**实例路径**归一成 pattern 后，必须与表里 not-compared 的集合一致。
    let uncompared_patterns: BTreeSet<String> = report
        .uncompared_fields
        .iter()
        .map(|path| pattern_of(path))
        .collect();
    assert_eq!(
        uncompared_patterns, declared_not_compared,
        "not-compared 的字段必须逐个进 uncompared_fields（不多不少）"
    );
    // 子集关系（从表读）：每一条未比对都必须是表里显式声明的。
    for path in &report.uncompared_fields {
        assert!(
            declared_not_compared.contains(&pattern_of(path)),
            "未比对字段 `{path}` 不在表里声明的 not-compared 集合中"
        );
    }
}

#[test]
fn a2_denominator_excludes_not_compared_which_still_counts_for_a3() {
    let table = table();
    let declared_compared = table
        .entries
        .values()
        .filter(|entry| entry.disposition == Disposition::Compared)
        .count();
    let not_compared = table.not_compared_paths().len();

    // A3 的分母是全部声明（含 not-compared）；A2 的分母只算 compared。
    assert_eq!(
        declared_compared + not_compared,
        table.entries.len(),
        "每一个声明字段要么是 compared、要么是 not-compared（没有第三种处置）"
    );
    assert!(
        not_compared > 0,
        "本表应当存在 not-compared 的字段；若为 0，说明 table 装载器把 disposition 解析坏了"
    );
    println!(
        "口径核对：A3 分母 {} = A2 分母 {} + not-compared {}",
        table.entries.len(),
        declared_compared,
        not_compared
    );
}
