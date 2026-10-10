//! 生成 `spec/vectors/attest/corpus.json`。
//!
//! **人工触发**（不是每次 `cargo test` 都写仓库）：`cargo run -p dsh-testkit-attest --example generate_corpus`
//!
//! 顺序上是"先写注入器与期望、再写检出"：本文件里的每个用例都带了**从设计 §7.3 的机制表
//! 推出**的期望结论；生成前会先让 Rust 验证器跑一遍并核对期望——不一致就直接失败，
//! 不允许"把期望改成实测"这种自欺（真要改，得先在代码评审里说清为什么机制表读错了）。

#[path = "../tests/support/mod.rs"]
mod support;

fn main() {
    let corpus = support::build_corpus();

    // 自检 1：注入用例必须被检出，且实测结论与**预先写下的**期望逐字段一致。
    let mut detected_total = 0usize;
    for class in support::CLASSES {
        let cases: Vec<_> = corpus
            .cases
            .iter()
            .filter(|case| case.class == class)
            .collect();
        let mut detected = 0usize;
        for case in &cases {
            let (chain, verdict) = support::evaluate_case(&corpus, case)
                .unwrap_or_else(|error| panic!("用例 {} 注入失败：{error}", case.id));
            assert_eq!(
                verdict,
                case.expected,
                "用例 {} 的实测结论与预先写下的期望不一致\n  实测：{}\n  期望：{}",
                case.id,
                verdict.render(),
                case.expected.render()
            );
            // 负向证明：注入必须真的改变了链。若某个用例的值恰好等于原值，
            // 那它是一条"空转用例"——绿得毫无意义，必须报出来。
            let original = &corpus
                .bases
                .iter()
                .find(|base| base.id == case.base)
                .expect("基准链必须存在")
                .chain;
            assert_ne!(
                original.to_json_text().unwrap(),
                chain.to_json_text().unwrap(),
                "用例 {} 的注入没有改变链（值等于原值？），这是一条空转用例",
                case.id
            );
            assert!(chain.records.len() > 1, "用例 {} 的链不该塌掉", case.id);
            if !verdict.chain_ok {
                detected += 1;
            }
        }
        detected_total += detected;
        println!("[generate] {class}: {detected}/{} 被检出", cases.len());
        assert!(
            detected == cases.len(),
            "类别 {class} 的检出率必须是 100%，实际 {detected}/{}",
            cases.len()
        );
        // E2 的"每类 ≥10"只对五类篡改成立；`extras` 是机制覆盖（Merkle / 链头），不在此列。
        if class != "extras" {
            assert!(cases.len() >= 10, "类别 {class} 的用例数必须 ≥10");
        }
    }

    // 自检 2：边界用例必须**检不出**——这是诚实的证据，不是漏检。
    for case in &corpus.boundary_cases {
        let (_chain, verdict) = support::evaluate_case(&corpus, case)
            .unwrap_or_else(|error| panic!("边界用例 {} 注入失败：{error}", case.id));
        assert_eq!(
            verdict,
            case.expected,
            "边界用例 {} 的结论不一致：{}",
            case.id,
            verdict.render()
        );
        assert!(
            verdict.chain_ok,
            "边界用例 {} 按设计 §7.5 就应当检不出，但它被检出了——那说明文档写的边界过保守，需要更新文档",
            case.id
        );
    }

    let path = support::corpus_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("建 spec/vectors/attest 目录");
    }
    std::fs::write(&path, support::corpus_json_text(&corpus)).expect("写语料");
    println!(
        "[generate] 写入 {}（{} 个注入用例、{} 个边界用例、{detected_total} 例被检出）",
        path.display(),
        corpus.cases.len(),
        corpus.boundary_cases.len()
    );
    println!(
        "[generate] 边界声明：{}",
        dsh_testkit_attest::boundary_statement()
    );
}
