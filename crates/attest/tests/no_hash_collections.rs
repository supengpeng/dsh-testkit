//! 守卫：禁用 `HashMap` / `HashSet` / `RandomState`（设计 §6.4）。
//!
//! ## 为什么这条纪律在 attest 上尤其致命
//!
//! 本 crate 的核心是**签名链**：`payload_jcs`（JCS 规范化字节）是**签名与哈希的输入**。
//!
//! 而 Rust 的 `HashMap` 默认用 `RandomState`（每次进程启动都不同的随机种子）⇒
//! 迭代顺序随机 ⇒ **同一条 payload 会规范化出不同的字节** ⇒ 签名不同、`payload_hash` 不同、
//! 链上后续每一条记录的 `prev_hash` 都不同。
//!
//! 换句话说：本 crate 里出现一个 `HashMap`，症状不是"读数抖"，而是
//! **"验证器说链是伪造的"** —— 而链本身没问题。设计 §6.4 把这种风险称为
//! "换成 Rust 之后的新风险"，在 attest 上它是**最强形态**。
//!
//! ## 与 `E5`（零依赖独立验证器）的关系
//!
//! 两侧（Rust 签名侧 / TS 验证侧）都必须能从**同一份字节**得到同一结论。
//! 任何一侧的顺序不确定性都会让"两侧结论一致"这条读数变成随机事件。
//!
//! ## 为什么必须带负向证明
//!
//! 没有负向证明的守卫是同义反复：它说"本 crate 干净"，而"干净"的判据就是它自己不报错。
//! 所以 `guard_has_teeth_on_a_synthetic_violation` 用合成违规源码证明扫描器真会红，
//! 并证明它**不会**把注释里的说明判成违规（否则 `src/lib.rs`、`src/types.rs`、`src/verify.rs`
//! 里那三处"本 crate 不使用 HashMap"的说明会把守卫自己弄红）。

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
    let offending_random = "fn f() { let _ = std::collections::hash_map::RandomState::new(); }";
    assert!(!violations(offending_random).is_empty());

    // 注释里出现不算违规 —— 这条在**本 crate 尤其重要**：
    // `src/lib.rs`、`src/types.rs`、`src/verify.rs` 各有一处"本 crate 不使用 HashMap"的说明。
    let commented = "// 判定路径不使用 HashMap / HashSet（设计 §6.4）\nfn f() {}\n";
    assert!(violations(commented).is_empty());
    let blocked = "/* JCS 要求字节确定 ⇒ 禁用 HashSet */\nfn f() {}\n";
    assert!(violations(blocked).is_empty());

    // 被指定的替代品（Vec + 显式排序 / BTreeMap）必须放行。
    let allowed = "use std::collections::BTreeMap;\nfn f() -> Vec<u8> { let _ = BTreeMap::<u8, u8>::new(); Vec::new() }\n";
    assert!(
        violations(allowed).is_empty(),
        "BTreeMap 与 Vec 是被指定的替代品，不得被误报"
    );
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
        "{} 禁用了 HashMap / HashSet / RandomState（设计 §6.4）——\
         签名链的输入必须字节确定，发现：\n{}",
        env!("CARGO_PKG_NAME"),
        hits.join("\n")
    );
}
