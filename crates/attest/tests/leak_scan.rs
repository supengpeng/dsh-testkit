//! I1：私钥不出进程（指标 §10）——"全量日志扫描"，**只报位置，不打印原文**。
//!
//! 扫描对象是"会离开进程的文本"：链文件、报告字段、锚定文件、协议消息形态的 JSON、
//! 以及日志行。针来自 [`KeyMaterial::sensitive_needles`]（种子与扩展私钥的 hex 形态）。
//!
//! 两条纪律：
//!
//! 1. **负向证明**：故意把针放进日志，扫描器必须命中（否则这条自检就是永远绿的摆设）；
//! 2. **命中只报位置**：`LeakHit::render` 里不含命中原文——扫描器不能自己变成泄露渠道。

mod support;

use dsh_testkit_attest::leak_scan::{scan_artifacts, scan_text, SensitiveNeedle};

/// 走一遍完整的签名 → 装配 → 锚定 → 验证流程，收集**每一段会离开进程的文本**。
fn collect_artifacts() -> (Vec<(String, String)>, Vec<SensitiveNeedle>) {
    let key = support::test_key();
    let needles = key.sensitive_needles();
    let corpus = support::build_corpus();
    let base = support::base_by_id(&corpus, "base_batch");

    let mut artifacts: Vec<(String, String)> = Vec::new();
    artifacts.push(("chain.json".to_string(), base.to_json_text().unwrap()));
    artifacts.push((
        "run.json".to_string(),
        serde_json::to_string_pretty(&serde_json::json!({
            "run_id": base.run_id,
            "chain_head": base.head.chain_head.to_hex(),
            "signature": format!("ed25519:{}", base.head_signature.as_ref().map(|s| s.sig.len()).unwrap_or(0)),
            "public_key": base.public_key.to_hex(),
            "stats": base.stats,
        }))
        .unwrap(),
    ));
    artifacts.push((
        "anchor.anchor".to_string(),
        base.anchor_head().to_json_text().unwrap(),
    ));
    let verdict = dsh_testkit_attest::verify_chain(
        base,
        &dsh_testkit_attest::VerifyOptions {
            expected_chain_head: Some(base.head.chain_head),
            anchor_declared: true,
            anchor_head: Some(base.head.chain_head),
            expected_public_key: Some(base.public_key),
            verify_proofs: true,
        },
    );
    artifacts.push((
        "verdict.json".to_string(),
        serde_json::to_string_pretty(&verdict).unwrap(),
    ));
    // "协议消息"形态：把链头与签名单独发出去（设计 §4 的消息面）。
    artifacts.push((
        "protocol-message.json".to_string(),
        serde_json::to_string(&serde_json::json!({
            "method": "submit",
            "params": {"chain_head": base.head.chain_head.to_hex(), "record_count": base.head.record_count}
        }))
        .unwrap(),
    ));
    // 日志行：包括**故意打印密钥对象的 Debug**——它必须是脱敏的。
    let log = [
        format!("signing run {}", base.run_id),
        format!("attestor = {:?}", "Attestor(public_key=…)"),
        format!("key = {key:?}"),
        format!("stats = {:?}", base.stats),
        format!("head = {}", base.head.chain_head),
    ];
    artifacts.push(("journal.log".to_string(), log.join("\n")));
    (artifacts, needles)
}

#[test]
fn no_key_material_leaks_into_any_artifact() {
    let (artifacts, needles) = collect_artifacts();
    let hits = scan_artifacts(&artifacts, &needles);
    println!(
        "[I1] 扫描 {} 份产物 / {} 根敏感针，命中 {} 处",
        artifacts.len(),
        needles.len(),
        hits.len()
    );
    for hit in &hits {
        println!("[I1] 命中：{}", hit.render());
    }
    assert!(
        hits.is_empty(),
        "I1 要求私钥材料零泄漏，实际命中 {} 处（只报位置，不打印原文）",
        hits.len()
    );
    // 顺带确认 Debug 已脱敏：Debug 输出里必须出现 <redacted> 且不含任何针。
    let debug_line = artifacts
        .iter()
        .find(|(name, _)| name == "journal.log")
        .map(|(_, text)| text.clone())
        .unwrap_or_default();
    assert!(
        debug_line.contains("<redacted>"),
        "KeyMaterial 的 Debug 必须脱敏"
    );
}

#[test]
fn leak_scanner_is_not_vacuous() {
    // 负向证明 ①：把针放进文本，必须命中。
    let (_, needles) = collect_artifacts();
    let needle_text = String::from_utf8(needles[0].bytes.clone()).expect("针的 hex 形态是 ASCII");
    let haystack = format!("clean line\nleaked {needle_text} here\n");
    let hits = scan_text("journal.log", &haystack, &needles);
    assert!(!hits.is_empty(), "把针放进文本必须被扫出来");
    assert_eq!(hits[0].line, 2, "位置必须正确");
    // 负向证明 ②：命中呈现里不能出现原文。
    for hit in &hits {
        assert!(
            !hit.render().contains(&needle_text),
            "命中呈现不得包含命中原文"
        );
    }
    // 负向证明 ③：干净文本不得误报。
    assert!(scan_text("journal.log", "clean text", &needles).is_empty());
}

#[test]
fn sensitive_needles_cover_both_seed_and_expanded_key() {
    let needles = support::test_key().sensitive_needles();
    assert_eq!(needles.len(), 2);
    assert_eq!(needles[0].label, "ed25519-seed-hex");
    assert_eq!(needles[1].label, "ed25519-keypair-hex");
    // 长度：种子 32 字节 → 64 个 hex 字符；密钥对 64 字节 → 128 个。
    assert_eq!(needles[0].bytes.len(), 64);
    assert_eq!(needles[1].bytes.len(), 128);
    // 针本身不该出现在任何公开产物里——这里断言的是"针只存在于进程内"这一事实的一半。
    let serialized = serde_json::to_string(&support::build_corpus()).unwrap();
    for needle in &needles {
        let text = String::from_utf8(needle.bytes.clone()).unwrap();
        assert!(
            !serialized.contains(&text),
            "语料里不得出现密钥材料（{}）",
            needle.label
        );
    }
}
