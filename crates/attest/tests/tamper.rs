//! E2：五类篡改注入的检出率必须 100%，且**每类 ≥ 10 个用例**（指标 §6）。
//!
//! 语料与注入器在 `tests/support/`：期望结论来自设计 §7.3 的机制表，**先于**检出实现写下；
//! 本测试只负责跑、比对、报数。两侧（Rust / TS）读同一份语料，因此结论必然可比。

mod support;

use support::{evaluate_case, load_corpus};

/// 指标 E2 要求的五类。
const REQUIRED_CLASSES: [&str; 5] = ["field", "delete", "reorder", "insert", "signature"];

#[test]
fn every_class_has_at_least_ten_cases_and_hundred_percent_detection() {
    let corpus = load_corpus();
    println!(
        "=== E2 篡改检出率（语料 {}）===",
        support::corpus_path().display()
    );
    let mut grand_total = 0usize;
    let mut grand_detected = 0usize;
    for class in REQUIRED_CLASSES {
        let cases: Vec<_> = corpus
            .cases
            .iter()
            .filter(|case| case.class == class)
            .collect();
        assert!(
            cases.len() >= 10,
            "类别 {class} 的用例数 {} < 10（E2 要求每类 ≥ 10）",
            cases.len()
        );
        let mut detected = 0usize;
        for case in &cases {
            let (_chain, verdict) = evaluate_case(&corpus, case)
                .unwrap_or_else(|error| panic!("用例 {} 注入失败：{error}", case.id));
            assert_eq!(
                verdict,
                case.expected,
                "用例 {} 结论不符：实测 {} / 期望 {}",
                case.id,
                verdict.render(),
                case.expected.render()
            );
            if !verdict.chain_ok {
                detected += 1;
            }
        }
        let rate = detected as f64 * 100.0 / cases.len() as f64;
        println!(
            "[E2] {class:<10} 用例 {:>2} / 检出 {:>2} / 检出率 {rate:.1}%",
            cases.len(),
            detected
        );
        assert_eq!(
            detected,
            cases.len(),
            "类别 {class} 的检出率不是 100%（{detected}/{}）",
            cases.len()
        );
        grand_total += cases.len();
        grand_detected += detected;
    }
    println!(
        "[E2] 合计 {grand_detected}/{grand_total} = {:.1}%（门槛 100%）",
        grand_detected as f64 * 100.0 / grand_total as f64
    );
    assert_eq!(grand_detected, grand_total);
}

#[test]
fn extra_mechanisms_are_also_covered() {
    // Merkle 证据 / 链头这一层不属于 E2 的五类，但它们是 §7.3.1 与 §7.6 的机制，
    // 一样要能被检出——否则"每叶附 inclusion proof"就是摆设。
    let corpus = load_corpus();
    let cases: Vec<_> = corpus
        .cases
        .iter()
        .filter(|case| case.class == "extras")
        .collect();
    assert!(cases.len() >= 4, "额外机制用例太少：{}", cases.len());
    for case in &cases {
        let (_chain, verdict) = evaluate_case(&corpus, case).unwrap();
        assert_eq!(verdict, case.expected, "用例 {} 结论不符", case.id);
        assert!(!verdict.chain_ok, "用例 {} 应当被检出", case.id);
    }
    println!("[E2-extras] {}/{} 被检出", cases.len(), cases.len());
}

#[test]
fn documented_boundary_is_not_detected() {
    // 设计 §7.5：有私钥者重写整链并重新签名 → **检不出**。
    // 这条测试是"诚实标注"的实证：文档说要挡住的事，我们不假装挡得住。
    let corpus = load_corpus();
    assert!(
        corpus.boundary_cases.len() >= 2,
        "边界用例必须存在，否则这份语料在隐瞒机制的边界"
    );
    for case in &corpus.boundary_cases {
        let (_chain, verdict) = evaluate_case(&corpus, case).unwrap();
        assert_eq!(verdict, case.expected, "边界用例 {} 结论不符", case.id);
        assert!(
            verdict.chain_ok,
            "边界用例 {} 按设计 §7.5 应当检不出，实际被检出：{}",
            case.id,
            verdict.render()
        );
        println!(
            "[边界] {} 检不出（符合 §7.5 的声明）：{}",
            case.id, case.note
        );
    }
}

#[test]
fn clean_bases_pass_with_all_requirements() {
    // E1（签名验证通过率 100%）与 E3（链完整性 100%）：干净的链必须全绿，
    // 而且是在**三份外部见证**（链自洽 + run.json 的链头 + 锚定目录的链头）都参与的情况下全绿。
    let corpus = load_corpus();
    for base in &corpus.bases {
        let original_head = base.chain.head.chain_head;
        let options = support::resolve_options(
            &support::ContextSpec {
                expected_chain_head: Some(original_head.to_hex()),
                anchor_head: Some(original_head.to_hex()),
                ..support::ContextSpec::default()
            },
            &base.chain,
            original_head,
        );
        let verdict = dsh_testkit_attest::verify_chain(&base.chain, &options);
        assert!(
            verdict.chain_ok,
            "基准链 {} 必须全绿：{}",
            base.id,
            verdict.render()
        );
        assert_eq!(verdict.verified_records, base.chain.records.len());
        let summary = support::summarize_chain(&base.chain);
        println!(
            "[E1/E3] {} 记录 {} 结果记录 {} 签名 {} 上界 {} 链头 {}",
            base.id,
            summary.record_count,
            summary.result_records,
            summary.stats.total_signatures,
            summary.stats.bound,
            summary.chain_head
        );
    }
}
