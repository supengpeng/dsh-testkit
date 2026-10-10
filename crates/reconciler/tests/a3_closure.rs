//! A3 机器自检：**枚举 `run-report.schema.json` 的叶子路径，与
//! `spec/contracts/reconcile-fields.yaml` 的声明集合求差**。
//!
//! 这是 A3 = 100% 的唯一机器证明（`REWRITE-METRICS.md` §2 A3）。
//! 它是双向的：
//! * `声明 \ 叶子` 非空 ⇒ 表里有 schema 中不存在的字段（声明漂移）；
//! * `叶子 \ 声明` 非空 ⇒ 有叶子没有处置（A3 缺口）。
//!
//! # 差集为什么不是"断言为空"而是"断言 ⊆ 阶段 1 新增清单"
//!
//! `reconcile-fields.yaml` 是**生成物**（生成器在仓库外的临时目录，见它的 `meta.recompute`），
//! 而本 crate 的写权限不含 `spec/**`。阶段 1 按 RFC §5 给 schema 新增了几个字段
//! （见 `STAGE1_SCHEMA_ADDITIONS`：`totals.inconclusive`、
//! `cases[].steps[].assertions[].outcome`、`cases[].trace[]`），差集恰好等于这份清单。
//! 把它写成"差集必须 ⊆ **且** = 一个显式的、可审计的清单"，既不静默放过，也不假装已经闭合。
//!
//! **这是"schema 先变、声明后补"的真实顺序的留痕**（Lead 2026-10-11 要求保留）。
//! spec-contracts 补完声明后，应把下面的断言收紧为「差集为空」，
//! 但**不要删掉这段注释**——它记录了"没闭合"与"假装闭合"的区别。

use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use dsh_testkit_reconciler::{
    enumerate_schema_leaves, parse_reconcile_table, schema_leaf_paths, STAGE1_SCHEMA_ADDITIONS,
    TABLE_PATH_IN_REPO,
};

const SCHEMA_PATH_IN_REPO: &str = "schemas/run-report.schema.json";

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

#[test]
fn a3_closure_schema_leaves_match_declared_fields() {
    let schema: serde_json::Value =
        serde_json::from_str(&read(SCHEMA_PATH_IN_REPO)).expect("schema 是合法 JSON");
    let leaves = schema_leaf_paths(&schema);
    let table = parse_reconcile_table(&read(TABLE_PATH_IN_REPO));

    let declared: BTreeSet<String> = table
        .declared_paths()
        .into_iter()
        .map(str::to_string)
        .collect();
    let additions: BTreeSet<String> = STAGE1_SCHEMA_ADDITIONS
        .iter()
        .map(|path| (*path).to_string())
        .collect();

    let undeclared: BTreeSet<String> = leaves.difference(&declared).cloned().collect();
    let extra: BTreeSet<String> = declared.difference(&leaves).cloned().collect();

    println!(
        "A3 自检：schema 叶子 {}；表声明 {}；未声明 {}；声明了但 schema 没有 {}",
        leaves.len(),
        declared.len(),
        undeclared.len(),
        extra.len()
    );
    for path in &undeclared {
        println!("  未声明（阶段 1 新增）：{path}");
    }
    for path in &extra {
        println!("  声明了但 schema 没有：{path}");
    }
    for leaf in enumerate_schema_leaves(&schema) {
        let _ = leaf.schema_type;
    }

    assert!(
        extra.is_empty(),
        "表里声明了 schema 中不存在的字段（声明漂移）：{extra:?}"
    );
    assert!(
        undeclared.is_subset(&additions),
        "存在未经处置的 schema 叶子（A3 缺口）：{:?}",
        undeclared
            .difference(&additions)
            .cloned()
            .collect::<Vec<_>>()
    );
    // 阶段 1 的三条 schema 增量（`totals.inconclusive` / `assertions[].outcome` /
    // `cases[].trace[]`）已由 `spec/contracts/reconcile-fields.yaml` 补上声明（task-17）。
    // 所以差集**收紧为空**。上面那个 `STAGE1_SCHEMA_ADDITIONS` 常量保留为**沿革**：
    // 它记录了"schema 先变、声明后补"这个真实顺序（task-16 时差集恰好等于它），
    // 也保留了那三个字段的名字——**不要删它**，删了就没人知道当时多出过哪三条。
    assert!(
        undeclared.is_empty(),
        "A3 差集必须为空（schema 叶子与声明集合逐条对应）：{:?}",
        undeclared
    );
}

#[test]
fn a3_numerator_counts_every_disposition_except_undeclared() {
    let table = parse_reconcile_table(&read(TABLE_PATH_IN_REPO));
    let numerator = table
        .entries
        .values()
        .filter(|entry| entry.disposition.counts_toward_a3())
        .count();
    println!(
        "A3 分子 {} / 声明 {}（not-compared {} 条，undeclared {} 条）",
        numerator,
        table.entries.len(),
        table.not_compared_paths().len(),
        table
            .entries
            .values()
            .filter(|entry| !entry.disposition.counts_toward_a3())
            .count()
    );
    assert_eq!(
        numerator,
        table.entries.len(),
        "当前表里不应有 disposition=undeclared 的条目"
    );
    // ⚠️ 这里**不硬编码 allowlist 的内容**。
    //
    // 第一版写的是 `BTreeSet::from(["cases[].usage.tokens"])`——真源在
    // `reconcile-fields.yaml` 的 `meta.not_compared_allowlist` 里，测试硬编码它
    // 等于造第二处真源，而且会让"合法地新增一条 not-compared"变成测试失败：
    // task-17 按 Lead 裁决把 `cases[].trace[]` 加进 allowlist 时，就撞上了这一点
    // （两条并行工作线，一边改真源、一边钉死真源）。
    //
    // 正确的判据是"not-compared 的集合**受 allowlist 约束**"，由下一个测试
    // （`a3_not_compared_paths_are_all_on_the_allowlist`）用 `allowlist_violations()` 完整承担。
    // 这里只保留"这一层没坏"的最小检查。
    assert!(
        !table.not_compared_paths().is_empty(),
        "本表至少应有一条 not-compared（cases[].usage.tokens + cases[].trace[]），\
         空集合说明 disposition 解析坏了——而不是说明它更严格"
    );
    assert!(
        table.allowlist_violations().is_empty(),
        "not-compared 路径必须都在 meta.not_compared_allowlist 上：{:?}",
        table.allowlist_violations()
    );
}

#[test]
fn a3_not_compared_paths_are_all_on_the_allowlist() {
    // 反刷分闸门：不允许靠"多写几条 not-compared"把 A3 刷到 100%（meta.set_distinction）。
    let table = parse_reconcile_table(&read(TABLE_PATH_IN_REPO));
    let violations = table.allowlist_violations();
    assert!(
        violations.is_empty(),
        "not-compared 路径不在 meta.not_compared_allowlist 上：{violations:?}"
    );
    assert!(
        !table.allowlist.is_empty(),
        "allowlist 不应为空（否则闸门失效）"
    );
}

#[test]
fn a3_open_subtrees_are_declared_and_match_the_discipline() {
    let table = parse_reconcile_table(&read(TABLE_PATH_IN_REPO));
    assert_eq!(
        table.open_subtrees,
        dsh_testkit_reconciler::open_subtrees()
            .iter()
            .map(|value| (*value).to_string())
            .collect::<Vec<_>>(),
        "开放子树清单必须与契约里声明的四条一致"
    );
    assert_eq!(dsh_testkit_reconciler::OPEN_ASSERTION_KEYS.len(), 16);
}
