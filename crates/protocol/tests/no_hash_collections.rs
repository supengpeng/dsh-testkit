//! 守卫：禁用 `HashMap` / `HashSet` / `RandomState`（设计 §6.4），
//! **外加一条本 crate 特有的检查**（见下）。
//!
//! ## 为什么这条纪律在 protocol 上比在别的 crate 上更敏感
//!
//! 别的 crate 怕的是"**判定顺序每次运行都变**"（A4 的可复现率会假性失败：代码没错、读数在抖）。
//! protocol 多怕一层 —— **它产出的是字节**：
//!
//! 一条 [`ProtocolMessage`] 要被序列化成 NDJSON 帧，而 **JSON 的字段顺序就是字节顺序**。
//! Rust 的 `HashMap` 默认用 `RandomState`（每次进程启动都不同的随机种子）⇒
//! **同一条消息在不同进程里会序列化成不同字节** ⇒ 而 H3（类型同步一致率）与阶段 2 的对拍
//! 都以"同样输入产生同样输出"为前提。**一个 `HashMap` 字段就足以让协议级对拍变成一场随机失败。**
//!
//! ## 第二条检查：`serde_json` 不得开 `preserve_order`
//!
//! `preserve_order` 会把 `serde_json::Map` 从 `BTreeMap` 换成 `IndexMap`（键序 = **插入序**）。
//! 插入序一旦依赖运行期到达顺序，就回到了与 `HashMap` 同一个问题 —— 而且它**更隐蔽**：
//! 在本机上插入序往往恰好稳定，所以本地怎么跑都是绿的。
//!
//! 这与设计 §6.4 的原话同源（"换成 Rust 之后的新风险"），只是风险面从"判定顺序"扩到了"字节顺序"。
//!
//! ## 为什么这条守卫必须带负向证明
//!
//! 没有负向证明的守卫是**同义反复**：它说"本 crate 干净"，而"干净"的判据就是它自己不报错。
//! 所以 [`guard_has_teeth_on_a_synthetic_violation`] 用**合成的违规源码**证明扫描器真的会红，
//! 并且证明它**不会**把注释里的说明也判成违规（否则解释这条纪律的文档会把守卫自己弄红）。

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

    // 注释里出现不算违规——否则解释这条纪律的文档会把守卫自己判红。
    let commented = "// 协议帧的字段顺序即字节顺序，因此禁用 HashMap（设计 §6.4）\nfn f() {}\n";
    assert!(violations(commented).is_empty());
    let blocked = "/* 禁用 HashSet / RandomState */\nfn f() {}\n";
    assert!(violations(blocked).is_empty());

    // 只报"看起来像"不算：`BTreeMap` 必须放行（它是被指定用来替代 HashMap 的那个）。
    let allowed =
        "use std::collections::BTreeMap;\nfn f() -> BTreeMap<u8, u8> { BTreeMap::new() }\n";
    assert!(
        violations(allowed).is_empty(),
        "BTreeMap 是被指定的替代品，不得被误报"
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
        "{} 禁用了 HashMap / HashSet / RandomState（设计 §6.4），发现：\n{}",
        env!("CARGO_PKG_NAME"),
        hits.join("\n")
    );
}

/// **第二条检查**：`serde_json` 不得开 `preserve_order`。
///
/// 判据是**读依赖声明**而不是读行为：`preserve_order` 一旦被任何人打开（无论是本 crate 还是
/// workspace 的 `[workspace.dependencies]`），`serde_json::Map` 的键序就从"字典序（BTreeMap）"
/// 变成"插入序（IndexMap）"——于是帧字节取决于**运行期键的到达顺序**。
/// 那种失败在本机上通常看不见（插入序往往恰好稳定），所以必须在**声明层**拦住。
#[test]
fn serde_json_must_not_enable_preserve_order() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace_root = manifest
        .parent()
        .and_then(Path::parent)
        .expect("crates/<name> 的上两级是仓库根");

    let mut offenders: Vec<String> = Vec::new();
    for path in [
        manifest.join("Cargo.toml"),
        workspace_root.join("Cargo.toml"),
    ] {
        let text = fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("可读取 {}：{error}", path.display()));
        for (index, line) in text.lines().enumerate() {
            let code = strip_comments(line);
            // 只在**依赖声明**里判：`serde_json` 或 `features` 行。
            let looks_like_dep = code.contains("serde_json") || code.contains("features");
            if looks_like_dep && code.contains("preserve_order") {
                offenders.push(format!("{}:{}：{}", path.display(), index + 1, line.trim()));
            }
        }
    }

    assert!(
        offenders.is_empty(),
        "serde_json 开了 preserve_order（键序会变成插入序 ⇒ 帧字节依赖运行期顺序）：\n{}",
        offenders.join("\n")
    );
}
