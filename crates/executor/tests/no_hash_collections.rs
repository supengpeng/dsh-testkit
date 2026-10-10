//! 守卫：**判定路径禁用 `HashMap` / `HashSet`**（设计 §6.4）。
//!
//! 设计 §6.4 的原话：Rust 的 `HashMap` 默认用随机种子（`RandomState`），
//! **迭代顺序每次运行都不同** —— 这是"换成 Rust 之后的新风险"。
//! 对拍器尤其危险：字段迭代顺序一变，"差异清单的顺序"就变，
//! A4 的"可复现率"会**假性失败**（代码没错，读数在抖）。
//!
//! 强制手段是 clippy 的 `disallowed_types`（本 crate 的 `clippy.toml` + `lib.rs` 的 deny）
//! 加**这条仓库守卫**；守卫必须带**负向证明**（用合成违规源码证明它会红），
//! 否则"本 crate 干净"就是同义反复。

use std::fs;
use std::path::{Path, PathBuf};

/// 去掉 `//` 行注释与 `/* */` 块注释，只留代码。
fn strip_comments(source: &str) -> String {
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut index = 0usize;
    let mut state = 0u8; // 0=正常 1=行注释 2=块注释
    while index < chars.len() {
        let current = chars[index];
        let next = chars.get(index + 1).copied();
        match state {
            0 if current == '/' && next == Some('/') => {
                state = 1;
                index += 2;
            }
            0 if current == '/' && next == Some('*') => {
                state = 2;
                index += 2;
            }
            0 => {
                out.push(current);
                index += 1;
            }
            1 => {
                if current == '\n' {
                    state = 0;
                    out.push('\n');
                }
                index += 1;
            }
            _ => {
                if current == '*' && next == Some('/') {
                    state = 0;
                    index += 2;
                } else {
                    index += 1;
                }
            }
        }
    }
    out
}

/// 找出代码里出现的禁用类型（返回可读的违规行）。
fn violations(source: &str) -> Vec<String> {
    strip_comments(source)
        .lines()
        .enumerate()
        .filter(|(_, line)| {
            line.contains("HashMap") || line.contains("HashSet") || line.contains("RandomState")
        })
        .map(|(index, line)| format!("第 {} 行：{}", index + 1, line.trim()))
        .collect()
}

fn rust_sources(directory: &Path, found: &mut Vec<PathBuf>) {
    let entries = fs::read_dir(directory).expect("可读取目录");
    for entry in entries {
        let path = entry.expect("可读取目录项").path();
        if path.is_dir() {
            rust_sources(&path, found);
        } else if path.extension().map(|ext| ext == "rs").unwrap_or(false) {
            found.push(path);
        }
    }
    found.sort();
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

    // 注释里出现不算违规（否则文档里解释这条纪律就会被自己判红）。
    let commented = "// 判定路径禁用 HashMap（设计 §6.4）\nfn f() {}\n";
    assert!(violations(commented).is_empty());
    let blocked = "/* 设计 §6.4：禁用 HashSet */\nfn f() {}\n";
    assert!(violations(blocked).is_empty());
}

#[test]
fn this_crate_uses_no_hash_collections() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_sources(&root, &mut files);
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
        "{} 的判定路径禁用了 HashMap / HashSet（设计 §6.4），发现：\n{}",
        env!("CARGO_PKG_NAME"),
        hits.join("\n")
    );
}
