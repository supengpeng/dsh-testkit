//! 守卫：**判定路径禁用 `HashMap` / `HashSet`**（设计 §6.4）。
//!
//! 设计 §6.4 的原话：Rust 的 `HashMap` 默认用随机种子（`RandomState`），
//! **迭代顺序每次运行都不同** —— 这是"换成 Rust 之后的新风险"。
//! 本 crate 的产物是**事件序列哈希**（指标 C1 的读数），一旦判定路径用它，
//! 同种子重跑就可能给出不同哈希，而且失败形态是偶发、不可复现的。
//!
//! 强制手段有两层：
//!
//! 1. clippy 的 `disallowed_types`（`crates/scheduler/clippy.toml` 已配，
//!    `src/lib.rs` 以 `#![deny(clippy::disallowed_types)]` 打开）；
//! 2. **本文件** —— 一条能在 `cargo test` 里跑的文本守卫。
//!    它必需，因为 `#![deny(...)]` 是 lib 单元的内层属性，**不覆盖 `tests/`**。
//!
//! 负向证明：`guard_has_teeth_on_a_synthetic_violation` 用**合成的违规源码**
//! 证明这个扫描器会红。若扫描器永远返回空，那条"本 crate 干净"的断言就是同义反复。

mod common;

use std::fs;

/// 被禁的类型名（含 `RandomState` —— 它是非确定性的来源本身）。
const FORBIDDEN: &[&str] = &["HashMap", "HashSet", "RandomState", "DefaultHasher"];

/// 找出代码里出现的禁用类型（返回可读的违规行）。
fn violations(source: &str) -> Vec<String> {
    common::strip_comments(source)
        .lines()
        .enumerate()
        .filter(|(_, line)| FORBIDDEN.iter().any(|needle| line.contains(needle)))
        .map(|(index, line)| format!("第 {} 行：{}", index + 1, line.trim()))
        .collect()
}

#[test]
fn guard_has_teeth_on_a_synthetic_violation() {
    let offending =
        "use std::collections::HashMap;\nfn f() -> HashMap<u8, u8> { HashMap::new() }\n";
    assert!(
        !violations(offending).is_empty(),
        "扫描器必须能抓到合成违规，否则守卫没有判别力"
    );
    let offending_set = "fn f() { let _ = std::collections::HashSet::<u8>::new(); }";
    assert!(!violations(offending_set).is_empty());
    let offending_hasher = "fn f() { let _ = std::collections::hash_map::DefaultHasher::new(); }";
    assert!(!violations(offending_hasher).is_empty());

    // 注释里出现不算违规（否则"解释这条纪律"的文档会把守卫自己判红）。
    let commented = "// 判定路径禁用 HashMap（设计 §6.4）\nfn f() {}\n";
    assert!(violations(commented).is_empty());
    let blocked = "/* 设计 §6.4：禁用 HashSet */\nfn f() {}\n";
    assert!(violations(blocked).is_empty());

    // 正例：允许的类型不得被误报。
    let allowed = "use std::collections::{BTreeMap, BTreeSet};\nfn f() { let _ = BTreeMap::<u8, u8>::new(); }\n";
    assert!(violations(allowed).is_empty(), "BTreeMap/BTreeSet 是允许的");
}

#[test]
fn scheduler_crate_source_uses_no_hash_collections() {
    let root = common::source_dir();
    let files = common::rust_sources(&root);
    assert!(!files.is_empty(), "必须扫到源码文件，否则守卫是空证明");

    let mut hits: Vec<String> = Vec::new();
    for file in &files {
        let source = fs::read_to_string(file).expect("可读取源码文件");
        for violation in violations(&source) {
            hits.push(format!("{}: {violation}", file.display()));
        }
    }
    assert!(
        hits.is_empty(),
        "判定路径禁用了 HashMap / HashSet / RandomState（设计 §6.4），发现：\n{}",
        hits.join("\n")
    );
}
