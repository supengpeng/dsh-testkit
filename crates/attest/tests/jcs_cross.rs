//! 跨实现一致性（设计 §7.2 的"proptest 生成随机 JSON → 两侧规范化字节必须逐字节相同"）。
//!
//! 本仓不能引入 `proptest`（它是开发依赖，会扩大依赖面，须先过 RFC §7 停止线 5）。
//! 所以用一条**确定性 LCG**在两侧生成同一批随机 JSON 文档：Rust 侧把
//! `<输入文本>\t<规范化字节 hex>` 落盘到 `target/attest/jcs-random.txt`，
//! TS 侧（`src/attest/jcs-cross.test.mjs`）用同一套生成器重算输入、比对输入文本与规范化字节。
//!
//! 生成器规范（两侧逐字对应）写在 `spec/vectors/README.md`。
//! 文件落在 `target/` 下：它是**对拍产物**，不是向量源——向量源是 `spec/vectors/jcs/`。

mod support;

use dsh_testkit_attest::{hex, jcs};

/// 随机文档数量（两侧必须一致）。
pub const RANDOM_DOCUMENT_COUNT: usize = 200;

#[test]
fn emit_random_json_canonicalization_for_cross_check() {
    let documents = support::random_json_documents(RANDOM_DOCUMENT_COUNT);
    assert_eq!(documents.len(), RANDOM_DOCUMENT_COUNT);

    let mut lines = String::new();
    for document in &documents {
        // 生成器保证文本里不含制表符与换行（转义是 `\\t` 这种字面量）。
        assert!(!document.contains('\t'), "随机文档不能含制表符");
        assert!(!document.contains('\n'), "随机文档不能含换行");
        let canonical = jcs::canonicalize_str(document)
            .unwrap_or_else(|error| panic!("随机文档规范化失败：{error}\n输入：{document}"));
        lines.push_str(document);
        lines.push('\t');
        lines.push_str(&hex::encode(canonical.as_bytes()));
        lines.push('\n');
    }

    // 确定性：再算一遍必须逐字节相同（否则 TS 侧没法比对）。
    let mut again = String::new();
    for document in &documents {
        let canonical = jcs::canonicalize_str(document).unwrap();
        again.push_str(document);
        again.push('\t');
        again.push_str(&hex::encode(canonical.as_bytes()));
        again.push('\n');
    }
    assert_eq!(lines, again, "同一批输入的规范化结果必须可复现");

    let path = support::jcs_cross_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建 target/attest 目录");
    }
    std::fs::write(&path, &lines).expect("写跨实现对拍文件");
    println!(
        "[JCS-cross] 已写出 {} 份随机文档的规范化结果：{}",
        RANDOM_DOCUMENT_COUNT,
        path.display()
    );
    println!("[JCS-cross] 下一步：node --test src/attest/jcs-cross.test.mjs 用 TS 侧重算并比对");
}

#[test]
fn generator_itself_is_deterministic_and_well_formed() {
    let first = support::random_json_documents(50);
    let second = support::random_json_documents(50);
    assert_eq!(first, second, "生成器必须可复现");
    for document in first {
        // 生成出来的必须是**合法 JSON**（否则"两侧都解析失败"会伪装成一致）。
        let parsed: serde_json::Value = serde_json::from_str(&document)
            .unwrap_or_else(|error| panic!("生成的文本不是合法 JSON：{error}\n{document}"));
        assert!(!parsed.is_null() || document == "null");
    }
}
