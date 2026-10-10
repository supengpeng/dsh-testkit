//! JCS 向量驱动测试：Rust 侧必须通过 `spec/vectors/jcs/*.json` 的**全部**向量。
//!
//! 为什么是向量而不是"我觉得对"（RFC §8 Q10）：JCS 的每一条规则（键序、数字形态、转义集）
//! 都有反直觉的边界。把"输入 + 期望规范化字节"落成文件，两侧各自实现、各自过同一批向量，
//! 才有资格说"两个实现是一致的"。TS 侧跑同一批文件：`src/attest/jcs-vectors.test.mjs`。

mod support;

use std::path::PathBuf;

use dsh_testkit_attest::{hex, jcs};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct VectorFile {
    domain: String,
    covers: Vec<String>,
    note: String,
    cases: Vec<VectorCase>,
}

#[derive(Debug, Deserialize)]
struct VectorCase {
    id: String,
    covers: String,
    note: String,
    input_json: String,
    expected_hex: String,
}

fn vector_dir() -> PathBuf {
    support::repo_root().join("spec/vectors/jcs")
}

fn load_vectors() -> Vec<(String, VectorFile)> {
    let mut files: Vec<(String, VectorFile)> = Vec::new();
    let entries = std::fs::read_dir(vector_dir())
        .unwrap_or_else(|error| panic!("读不到向量目录 {}：{error}", vector_dir().display()));
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().map(|ext| ext == "json").unwrap_or(false))
        .collect();
    paths.sort();
    for path in paths {
        let text = std::fs::read_to_string(&path).expect("读向量文件");
        let file: VectorFile = serde_json::from_str(&text)
            .unwrap_or_else(|error| panic!("向量文件 {} 解析失败：{error}", path.display()));
        assert_eq!(file.domain, "jcs", "向量文件的 domain 必须是 jcs");
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        files.push((name, file));
    }
    files
}

#[test]
fn rust_passes_every_jcs_vector() {
    let files = load_vectors();
    assert!(!files.is_empty(), "spec/vectors/jcs/ 下必须有向量文件");
    let mut total = 0usize;
    let mut coverage: Vec<String> = Vec::new();
    for (name, file) in &files {
        let mut passed = 0usize;
        for case in &file.cases {
            let canonical = jcs::canonicalize_str(&case.input_json).unwrap_or_else(|error| {
                panic!(
                    "[{}] {} 规范化失败：{error}（{}）",
                    name, case.id, case.note
                )
            });
            let actual = hex::encode(canonical.as_bytes());
            assert_eq!(
                actual, case.expected_hex,
                "[{name}] {} 规范化字节不符：{}\n  输入：{}\n  实测：{}\n  期望：{}",
                case.id, case.note, case.input_json, actual, case.expected_hex
            );
            passed += 1;
            total += 1;
            if !coverage.contains(&case.covers) {
                coverage.push(case.covers.clone());
            }
        }
        println!(
            "[JCS] {name:<22} {} / {} 通过（{}）",
            passed,
            file.cases.len(),
            file.note
        );
    }
    println!("[JCS] Rust 侧合计通过 {total} 条向量；覆盖类别：{coverage:?}");

    // 设计 §7.2 要求向量覆盖的六个方面，一个都不能少。
    for required in [
        "key_order",
        "number",
        "unicode",
        "escape",
        "nested",
        "empty",
    ] {
        assert!(
            coverage.iter().any(|item| item == required),
            "向量必须覆盖 {required}"
        );
    }
    assert!(total >= 30, "向量太少（{total}），覆盖不足");
}

#[test]
fn vector_files_declare_their_coverage() {
    // 每个文件自己声明的 covers 必须与用例里出现的 covers 一致——防止"文件说覆盖了数字，
    // 实际一条数字向量都没有"这种账实不符。
    for (name, file) in load_vectors() {
        for case in &file.cases {
            assert!(
                file.covers.iter().any(|item| item == &case.covers),
                "[{name}] 用例 {} 的 covers={} 没在文件级 covers 里声明",
                case.id,
                case.covers
            );
            assert!(!case.note.trim().is_empty(), "[{name}] {} 缺说明", case.id);
        }
    }
}

#[test]
fn numbers_follow_ecmascript_reference_forms() {
    // 数字是最容易"自己发明一套"的地方。这里用一批**公开可核对**的 ECMAScript 形态钉住它。
    let expectations: [(&str, &str); 12] = [
        ("1.0", "1"),
        ("1e2", "100"),
        ("-0", "0"),
        ("0.0", "0"),
        ("1e21", "1e+21"),
        ("1e20", "100000000000000000000"),
        ("1e-6", "0.000001"),
        ("1e-7", "1e-7"),
        ("0.1", "0.1"),
        ("2.5", "2.5"),
        ("1e-323", "1e-323"),
        ("5e-324", "5e-324"),
    ];
    for (input, expected) in expectations {
        assert_eq!(
            jcs::canonicalize_str(input).unwrap(),
            expected,
            "输入 {input}"
        );
    }
}
