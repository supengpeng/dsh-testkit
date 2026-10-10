//! 跨语言结论一致性：把 Rust 侧对语料每一条用例的结论落盘，供 TS 侧逐例比对。
//!
//! 设计 §7.4 的验收项：「`cargo` / `node` 两侧对同一份链的验证结论必须一致」。
//! 两侧读同一份语料（`spec/vectors/attest/corpus.json`）、各自用自己的注入器与验证器，
//! 结论落在 `target/attest/rust-verdicts.json`，由 `src/attest/cross-check.test.mjs` 逐例 diff。

mod support;

use std::collections::BTreeMap;

use dsh_testkit_attest::{verify_chain, Verdict, VerifyOptions};
use serde_json::json;

#[test]
fn emit_rust_verdicts_for_cross_language_comparison() {
    let corpus = support::load_corpus();
    let mut cases: BTreeMap<String, Verdict> = BTreeMap::new();
    for case in corpus.cases.iter().chain(corpus.boundary_cases.iter()) {
        let (_chain, verdict) = support::evaluate_case(&corpus, case)
            .unwrap_or_else(|error| panic!("用例 {} 注入失败：{error}", case.id));
        cases.insert(case.id.clone(), verdict);
    }

    // 基准链：用"链自洽 + 三份见证一致"的口径，确认干净链在两侧都是全绿。
    let mut bases: BTreeMap<String, Verdict> = BTreeMap::new();
    for base in &corpus.bases {
        let head = base.chain.head.chain_head;
        let options = VerifyOptions {
            expected_chain_head: Some(head),
            anchor_declared: true,
            anchor_head: Some(head),
            expected_public_key: Some(base.chain.public_key),
            verify_proofs: true,
        };
        bases.insert(base.id.clone(), verify_chain(&base.chain, &options));
    }

    let document = json!({
        "note": "Rust 侧对 spec/vectors/attest/corpus.json 的逐例结论；TS 侧必须给出完全相同的对象。",
        "side": "rust",
        "cases": cases,
        "bases": bases,
    });
    let mut text = serde_json::to_string_pretty(&document).expect("序列化结论");
    text.push('\n');
    let path = support::scratch_dir("rust-verdicts.json");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建 target/attest 目录");
    }
    std::fs::write(&path, &text).expect("写结论文件");
    println!(
        "[一致性] Rust 侧结论已写出：{}（{} 条用例、{} 条基准链）",
        path.display(),
        document["cases"]
            .as_object()
            .map(|map| map.len())
            .unwrap_or(0),
        document["bases"]
            .as_object()
            .map(|map| map.len())
            .unwrap_or(0)
    );
    println!("[一致性] 下一步：node --test src/attest/cross-check.test.mjs");
}

#[test]
fn verdicts_are_reproducible_across_runs() {
    // 同一份语料跑两遍必须给出逐字节相同的结论——否则跨语言比对就没有意义。
    let corpus = support::load_corpus();
    let mut first: Vec<(String, Verdict)> = Vec::new();
    let mut second: Vec<(String, Verdict)> = Vec::new();
    for case in &corpus.cases {
        first.push((
            case.id.clone(),
            support::evaluate_case(&corpus, case).unwrap().1,
        ));
    }
    for case in &corpus.cases {
        second.push((
            case.id.clone(),
            support::evaluate_case(&corpus, case).unwrap().1,
        ));
    }
    assert_eq!(first, second);
    println!("[一致性] {} 条用例结论可复现", first.len());
}
