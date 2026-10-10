//! 确定性守卫（设计 §6.4 硬纪律）。
//!
//! 设计 §6.4 要求：**判定路径上禁止使用 `std::collections::HashMap` / `HashSet`**
//! ——它们默认用随机种子（`RandomState`），迭代顺序**每次运行都不同**，
//! 会让"同种子同结果"（指标 C1）当场失效。要求用 `BTreeMap` / `BTreeSet`。
//!
//! # 为什么这里不用 clippy 的 `disallowed_types`
//!
//! 那需要仓库级 `clippy.toml`（本任务的写权限不含根配置），在 crate 内声明只会空转，
//! **给人"已经守住了"的错觉**。所以这里改用一条真的会红的守卫：直接扫描 `src/**` 的
//! **代码形态**（剥掉注释与文档，避免"文档里提到 HashMap 就误报"），
//! 并附**负向证明**（守卫确实认得这两个名字）。

use std::path::{Path, PathBuf};

/// 禁止出现在判定路径上的类型名。
const FORBIDDEN: [&str; 2] = ["HashMap", "HashSet"];

/// 剥掉行注释、块注释与字符串字面量的内容（只用于扫描，不用于任何判定）。
fn code_only(source: &str) -> String {
    let mut code = String::with_capacity(source.len());
    let mut chars = source.chars().peekable();
    let mut block_depth: usize = 0;
    let mut in_line_comment = false;
    let mut in_string: Option<char> = None;
    // `<` / `>` 是泛型括号，不是注释起始；只有 `//` 与 `/* */` 是。
    while let Some(c) = chars.next() {
        if in_line_comment {
            if c == '\n' {
                in_line_comment = false;
                code.push('\n');
            }
            continue;
        }
        if block_depth > 0 {
            if c == '*' && chars.peek() == Some(&'/') {
                chars.next();
                block_depth -= 1;
            } else if c == '/' && chars.peek() == Some(&'*') {
                chars.next();
                block_depth += 1;
            }
            continue;
        }
        if let Some(quote) = in_string {
            if c == '\\' {
                chars.next();
                continue;
            }
            if c == quote {
                in_string = None;
            }
            continue;
        }
        match c {
            '/' if chars.peek() == Some(&'/') => {
                chars.next();
                in_line_comment = true;
            }
            '/' if chars.peek() == Some(&'*') => {
                chars.next();
                block_depth += 1;
            }
            '"' | '\'' => {
                in_string = Some(c);
                code.push(' ');
            }
            other => code.push(other),
        }
    }
    code
}

/// 该代码文本里出现的违禁类型名。
fn forbidden_hits(code: &str) -> Vec<&'static str> {
    FORBIDDEN
        .into_iter()
        .filter(|name| code.contains(name))
        .collect()
}

/// 收集 `src/**` 下的全部 Rust 源文件。
fn rust_sources(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            files.extend(rust_sources(&path));
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// **守卫本体**：判定路径上不得出现 `HashMap` / `HashSet`。
#[test]
fn no_hash_containers_in_the_decision_path() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let files = rust_sources(&src);
    assert!(!files.is_empty(), "没找到源文件，守卫本身失效了：{src:?}");

    let mut violations = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).expect("源文件必须可读");
        let hits = forbidden_hits(&code_only(&text));
        if !hits.is_empty() {
            violations.push(format!("{}: {hits:?}", file.display()));
        }
    }
    assert!(
        violations.is_empty(),
        "判定路径禁 HashMap/HashSet（设计 §6.4）；改用 BTreeMap/BTreeSet/Vec：\n{}",
        violations.join("\n")
    );
}

/// **负向证明**：守卫确实认得这两个名字（注入即红）。
///
/// 没有这条，上面那条测试可能只是"永远通过"——那是假守卫。
#[test]
fn guard_actually_detects_hash_containers() {
    // 代码形态：必须命中。
    assert_eq!(
        forbidden_hits(&code_only("let m = HashMap::new();")),
        vec!["HashMap"]
    );
    assert_eq!(
        forbidden_hits(&code_only("use std::collections::HashSet;")),
        vec!["HashSet"]
    );
    assert_eq!(
        forbidden_hits(&code_only("// HashMap 在注释里")),
        Vec::<&str>::new(),
        "注释里的提及不算违例（文档要能讨论它）"
    );
    assert_eq!(
        forbidden_hits(&code_only("/* HashMap */")),
        Vec::<&str>::new()
    );
    assert_eq!(
        forbidden_hits(&code_only("let s = \"HashMap\";")),
        Vec::<&str>::new(),
        "字符串字面量里的提及不算违例"
    );
    assert!(forbidden_hits(&code_only("BTreeMap::new()")).is_empty());
}

/// 同一输入跑两次，结果必须**逐字节相同**（含成功消息的词序）。
///
/// 这条是 C1 在断言引擎这个小范围内的可执行形式：不依赖"运气好"，
/// 而是靠"判定路径只用有序容器 + 显式排序"。
#[test]
fn identical_input_produces_identical_outcomes() {
    use dsh_testkit_assertion::{
        AssertionContext, AssertionEngine, AssertionSpec, BufferedAssertionEngine,
    };
    use serde_json::json;

    let engine = BufferedAssertionEngine::new();
    let mut ctx = AssertionContext::new("TK-DET");
    ctx.fixture = Some(json!({"n": 5, "list": [1, 2, 3], "s": "xxabcxx"}));
    let specs: Vec<AssertionSpec> = [
        json!({"ref": "fx.n", "atLeast": 1, "atMost": 5}),
        json!({"ref": "fx.list", "contains": 2, "length": 3}),
        json!({"ref": "fx.s", "matches": "/ABC/i", "notContains": "zzz"}),
        json!({"ref": "fx.n", "is": 6}),
        json!({"ref": "fx.nope", "exists": false}),
    ]
    .into_iter()
    .map(|value| serde_json::from_value(value).expect("合法"))
    .collect();

    let first = engine.assert_all(&ctx, &specs);
    for _ in 0..8 {
        let again = engine.assert_all(&ctx, &specs);
        assert_eq!(
            serde_json::to_string(&first).expect("可序列化"),
            serde_json::to_string(&again).expect("可序列化"),
            "同一输入必须产出同一结果（指标 C1）"
        );
    }
    // 成功消息里的词序必须由规范序决定，与 YAML 里的键序无关。
    let reordered: Vec<AssertionSpec> = [
        json!({"ref": "fx.n", "atMost": 5, "atLeast": 1}),
        json!({"ref": "fx.list", "length": 3, "contains": 2}),
    ]
    .into_iter()
    .map(|value| serde_json::from_value(value).expect("合法"))
    .collect();
    let reordered_result = engine.assert_all(&ctx, &reordered);
    match &reordered_result.outcomes[0] {
        dsh_testkit_assertion::AssertionOutcome::Passed {
            details: Some(details),
            ..
        } => assert_eq!(details, &json!("fx.n 满足 atLeast + atMost")),
        other => panic!("应为带摘要的 Passed：{other:?}"),
    }
    match &reordered_result.outcomes[1] {
        dsh_testkit_assertion::AssertionOutcome::Passed {
            details: Some(details),
            ..
        } => assert_eq!(details, &json!("fx.list 满足 contains + length")),
        other => panic!("应为带摘要的 Passed：{other:?}"),
    }
    assert_eq!(
        serde_json::to_string(&engine.registered_names()).expect("可序列化"),
        serde_json::to_string(&engine.registered_names()).expect("可序列化")
    );
}
