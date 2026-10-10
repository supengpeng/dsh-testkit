//! 纪律守卫：把"说过的约束"变成**会红的测试**。
//!
//! 这里不含业务断言，只有三类"边界不能被静默放松"的检查：
//!
//! 1. **边界 8**：本 crate 只管单进程内的判定路径顺序。
//!    它不得引入异步运行时（设计 §6.3：那会把"顺序由谁决定"从类型层退回运行时层），
//!    也不得自己开子进程（用例之间的多进程并行是 TS 侧的进程池职责）。
//! 2. **三条 crate 级 lint 必须保留**（`forbid(unsafe_code)` / `deny(missing_docs)` /
//!    `deny(clippy::disallowed_types)`）—— 它们可以被一次"顺手清理"悄悄删掉。
//! 3. **结构性事实**：调度器必须是 `Send`；而"共享引用上进不了判定路径"
//!    由 `src/lib.rs` 的 `compile_fail` doctest 证明（它会在约束丢失时**通过**）。

mod common;

use dsh_testkit_scheduler::{Scheduler, SchedulerStatus, TestTask};
use std::fs;
use std::path::Path;

/// `src/` 里禁止出现的模式（判定路径的边界）。
const FORBIDDEN_SRC_PATTERNS: &[&str] = &[
    "async fn",
    ".await",
    "tokio",
    "async_std",
    "async-std",
    "smol",
    "std::process",
    "Command::new",
];

/// `Cargo.toml` 里禁止出现的依赖名。
const FORBIDDEN_DEPENDENCIES: &[&str] = &[
    "tokio",
    "async-std",
    "async-trait",
    "smol",
    "futures",
    "loom",
];

fn src_violations(source: &str) -> Vec<String> {
    let code = common::strip_comments(source);
    code.lines()
        .enumerate()
        .filter(|(_, line)| {
            FORBIDDEN_SRC_PATTERNS
                .iter()
                .any(|needle| line.contains(needle))
        })
        .map(|(index, line)| format!("第 {} 行：{}", index + 1, line.trim()))
        .collect()
}

/// 去掉 TOML 的 `#` 注释后再查依赖名。
///
/// 必须去注释：本 crate 的 `Cargo.toml` 里**故意**用注释解释了"为什么不引 tokio / loom"，
/// 不去注释的扫描器会把这段解释本身判成违规。
fn manifest_violations(manifest: &str) -> Vec<String> {
    let code: String = manifest
        .lines()
        .map(|line| line.split('#').next().unwrap_or(""))
        .collect::<Vec<&str>>()
        .join("\n");
    code.lines()
        .enumerate()
        .filter(|(_, line)| {
            FORBIDDEN_DEPENDENCIES
                .iter()
                .any(|needle| line.contains(needle))
        })
        .map(|(index, line)| format!("第 {} 行：{}", index + 1, line.trim()))
        .collect()
}

/// 边界 8：用例之间是多进程并行（**不在本 crate**）；本 crate 不引异步运行时、不开子进程。
#[test]
fn contract_08_boundary_has_no_async_runtime_and_no_cross_process_api() {
    let root = common::source_dir();
    let files = common::rust_sources(&root);
    assert!(!files.is_empty(), "必须扫到源码文件，否则守卫是空证明");

    let mut hits: Vec<String> = Vec::new();
    for file in &files {
        let source = fs::read_to_string(file).expect("可读取源码文件");
        for violation in src_violations(&source) {
            hits.push(format!("{}: {violation}", file.display()));
        }
    }
    assert!(
        hits.is_empty(),
        "本 crate 不得引异步运行时 / 不得开子进程（设计 §6.3 的边界）：\n{}",
        hits.join("\n")
    );

    let manifest_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let manifest = fs::read_to_string(manifest_path).expect("可读取 Cargo.toml");
    let manifest_hits = manifest_violations(&manifest);
    assert!(
        manifest_hits.is_empty(),
        "Cargo.toml 不得出现这些依赖（RFC 0001 §7 停止线 5）：\n{}",
        manifest_hits.join("\n")
    );
}

/// 负向证明：上面两个扫描器**有判别力**（否则那两条"干净"的断言是同义反复）。
#[test]
fn discipline_boundary_scanners_have_teeth() {
    assert!(!src_violations("async fn run() {}").is_empty());
    assert!(!src_violations("let x = fut.await;").is_empty());
    assert!(!src_violations("use tokio::runtime::Runtime;").is_empty());
    assert!(!src_violations("std::process::Command::new(\"x\")").is_empty());

    // 注释/文档里解释这些约束**不算**违规（否则这条纪律的文档会把自己判红）。
    assert!(src_violations("// 不引 tokio（设计 §6.3）\nfn f() {}").is_empty());
    assert!(src_violations("/* loom 不需要：见 lib.rs */\nfn f() {}").is_empty());

    assert!(!manifest_violations("tokio = \"1\"\nfutures = \"0.3\"").is_empty());
    // 注释里出现依赖名不算违规 —— 本 crate 的 Cargo.toml 正是这种形态。
    assert!(manifest_violations("# 不引 tokio / loom\nserde_json.workspace = true").is_empty());
    assert!(manifest_violations("serde_json.workspace = true").is_empty());
}

/// 三条 crate 级 lint 必须保留（它们是另外两条守卫的"开关"）。
#[test]
fn discipline_crate_level_lints_stay_on() {
    let lib = fs::read_to_string(common::source_dir().join("lib.rs")).expect("可读取 lib.rs");
    for attribute in [
        "#![forbid(unsafe_code)]",
        "#![deny(missing_docs)]",
        "#![deny(clippy::disallowed_types)]",
    ] {
        assert!(
            lib.contains(attribute),
            "src/lib.rs 必须保留 {attribute}：删掉它等于静默放松一条纪律"
        );
    }
}

/// clippy 侧配置必须仍然禁用哈希集合（否则 `deny(clippy::disallowed_types)` 变成空开关）。
#[test]
fn discipline_clippy_config_still_forbids_hash_collections() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("clippy.toml");
    let text = fs::read_to_string(path).expect("可读取 clippy.toml");
    for needle in [
        "std::collections::HashMap",
        "std::collections::HashSet",
        "RandomState",
    ] {
        assert!(
            text.contains(needle),
            "clippy.toml 必须仍然禁用 {needle}（设计 §6.4）"
        );
    }
}

fn assert_send<T: Send>() {}

/// 结构性事实：调度器可被搬到别的线程（协议服务端的持有方式）。
///
/// **反向**的那一条（共享引用上进不了判定路径）是 `src/lib.rs` 的 `compile_fail` doctest；
/// 两者合起来才是完整的结构结论。
#[test]
fn discipline_scheduler_types_are_send() {
    assert_send::<Scheduler>();
    assert_send::<TestTask>();
    assert_send::<SchedulerStatus>();
}
