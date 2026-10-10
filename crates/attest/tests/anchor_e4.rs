//! E4：**本地**锚定写入成功率 ≥ 99%（指标 §6）；写入后立即回读校验，失败如实标记。
//!
//! # 本会话的一处诚实标注（`degraded`）
//!
//! 本仓的开发沙箱**只允许子进程写仓库内路径**（`cargo` 起的测试进程写 `%TEMP%` 会
//! 得到 `PermissionDenied`，实测见汇报）。而设计 §7.6 要求锚定目录**必须在仓库之外**。
//! 两者冲突时，本测试的选择是：
//!
//! 1. **不削弱生产规则**：`LocalAnchor::new` / `from_env` 仍然强制"仓库之外"，
//!    本文件里有一条守卫测试证明它拒绝仓库内目录；
//! 2. 用**显式命名**的 `LocalAnchor::unchecked_for_tests` 旁路，把这条限制写在代码里
//!    而不是悄悄删掉检查；
//! 3. 因此 E4 的读数是在"测试旁路 + 仓库内目录"下取得的，**标注为 degraded**，
//!    生产路径（`DSH_TESTKIT_ANCHOR_DIR` 或 `~/.dsh-testkit/anchors/`）才是设计要求的形态。

mod support;

use dsh_testkit_attest::anchor::{AnchorHead, AnchorOutcome, AnchorProvider, LocalAnchor};
use dsh_testkit_attest::{sha256_parts, AnchorError, Bytes32};

fn head(index: usize) -> AnchorHead {
    AnchorHead::new(
        &format!("run-{index:04}"),
        sha256_parts(&[format!("head-{index}").as_bytes()]),
        (16 + index) as u64,
        index as i64,
    )
}

#[test]
fn local_anchor_write_readback_success_rate() {
    let dir = support::scratch_dir("anchor-e4");
    let anchor = LocalAnchor::unchecked_for_tests(dir, "dsh-testkit-attest-e4");
    let rounds = 100usize;
    let mut written = 0usize;
    let mut readback_ok = 0usize;
    let mut failed: Vec<String> = Vec::new();
    for index in 0..rounds {
        let expected = head(index);
        match anchor.write(&expected) {
            AnchorOutcome::Anchored { path, receipt } => {
                assert!(receipt.verified, "Anchored 必须意味着回读校验通过");
                written += 1;
                match anchor.read(&expected.run_id) {
                    Ok(read_back) if read_back == expected => readback_ok += 1,
                    Ok(read_back) => failed.push(format!(
                        "run-{index:04} 回读不一致：{} != {}",
                        read_back.chain_head, expected.chain_head
                    )),
                    Err(error) => failed.push(format!("run-{index:04} 回读失败：{error}")),
                }
                assert!(std::path::Path::new(&path).exists(), "锚定文件必须真的存在");
            }
            AnchorOutcome::Failed { path, reason } => {
                failed.push(format!("run-{index:04} 写入失败（{path}）：{reason}"));
            }
        }
    }
    let rate = readback_ok as f64 / rounds as f64;
    println!("[E4] 写入 {written}/{rounds}，写入+回读校验通过 {readback_ok}/{rounds} = {:.2}%（门槛 ≥99%，degraded：见文件头说明）", rate * 100.0);
    for item in &failed {
        println!("[E4] 失败项：{item}");
    }
    assert!(failed.is_empty(), "锚定不应有失败项：{failed:?}");
    assert!(rate >= 0.99, "E4 门槛 ≥99%，实际 {rate}");
}

#[test]
fn provider_trait_round_trip_and_detects_replacement() {
    let dir = support::scratch_dir("anchor-provider");
    let anchor = LocalAnchor::unchecked_for_tests(dir, "dsh-testkit-attest-provider");
    let expected = head(7);
    let receipt = anchor.anchor(&expected).expect("本地锚定必须成功");
    assert_eq!(anchor.name(), "local");
    assert!(receipt.verified);
    assert!(
        anchor.verify(&expected, &receipt).unwrap(),
        "同一链头必须能反查到"
    );
    // 换一个链头：反查必须为 false（而不是"找不到就算通过"）。
    let other = head(8);
    assert!(!anchor.verify(&other, &receipt).unwrap());
    // 凭据指向别处：明确为 false（凭据被换掉的信号）。
    let forged = dsh_testkit_attest::AnchorReceipt {
        location: support::scratch_dir("anchor-elsewhere")
            .join("x.anchor")
            .to_string_lossy()
            .to_string(),
        verified: true,
    };
    assert!(!anchor.verify(&expected, &forged).unwrap());
}

#[test]
fn production_constructor_still_refuses_repository_dirs() {
    // 守卫：生产入口的"必须在仓库之外"没有被这次 degraded 旁路削弱。
    let Some(root) = dsh_testkit_attest::signing::repository_root_of(&support::repo_root()) else {
        eprintln!("跳过：当前工作副本不在 git 工作树内");
        return;
    };
    let error = LocalAnchor::new(root.join("target/attest/should-refuse"), "p").unwrap_err();
    assert!(matches!(error, AnchorError::DirectoryInsideRepository(_)));
    // 顺便证明：默认锚定目录（家目录下）确实是仓库之外的形态。
    assert!(dsh_testkit_attest::anchor::home_dir().is_some());
}

#[test]
fn write_failure_is_reported_never_silently_degraded() {
    let dir = support::scratch_dir("anchor-failure");
    let anchor = LocalAnchor::unchecked_for_tests(dir, "dsh-testkit-attest-failure");
    let expected = head(99);
    // 让目标路径先变成一个目录：写入必然失败。
    std::fs::create_dir_all(anchor.path_for(&expected.run_id)).unwrap();
    let outcome = anchor.write(&expected);
    assert!(
        matches!(outcome, AnchorOutcome::Failed { .. }),
        "{outcome:?}"
    );
    let json = outcome.to_json();
    assert_eq!(json["status"], "failed");
    assert!(!json["reason"].as_str().unwrap_or("").is_empty());
    println!("[E4] 失败如实标记：{}", json);
}

#[test]
fn chain_head_mismatch_between_report_and_anchor_is_detected() {
    // 设计 §7.6 的核心检出项：报告里的链头与锚定目录里的链头不一致 → anchor_mismatch。
    let corpus = support::load_corpus();
    let base = support::base_by_id(&corpus, "base_batch");
    let mut tampered = base.clone();
    tampered.head.chain_head = Bytes32::from_bytes([0x5a; 32]);
    let options = dsh_testkit_attest::VerifyOptions {
        expected_chain_head: Some(base.head.chain_head),
        anchor_declared: true,
        anchor_head: Some(base.head.chain_head),
        expected_public_key: Some(base.public_key),
        verify_proofs: true,
    };
    let verdict = dsh_testkit_attest::verify_chain(&tampered, &options);
    assert!(!verdict.chain_ok);
    println!("[E4/§7.6] 报告链头被单独改动：{}", verdict.render());
    assert_eq!(
        verdict.errors,
        vec![dsh_testkit_attest::ErrorCode::ChainHeadMismatch]
    );
}
