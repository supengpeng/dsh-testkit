//! **验证器的三段顺序逻辑**：每种篡改形态的"组合"都要被走到（task-26 的 (a) 类缺口）。
//!
//! # 为什么需要这个文件
//!
//! `verify.rs` 的判定顺序是设计 §7.3 那张表的落地：某一种注入会**先**撞上哪一道检查，
//! 决定了报出来的错误码。语料（`spec/vectors/attest/corpus.json`）覆盖了五大类注入，
//! 但它们全都是**在链上做一件事**——于是有几条真实存在的形态**一次都没被走到**：
//!
//! | 未覆盖的路径 | 为什么语料没走到它 | 本文件的用例 |
//! |---|---|---|
//! | `prev_hash` 断链（`prev_hash_mismatch`） | "删记录/重排"在**阶段 0 序号完整性**就先被抓走了，永远到不了断链这一层 | `single_record_resigned_but_link_not_fixed_*` |
//! | 链头**计数**被单独改动（`record_count` / `seq` / `result_records`） | 语料只改过 `chain_head` 自己（`||` 短路，后面的项从未被求值） | `head_count_and_last_seq_must_be_bound_*` |
//! | 链头签名的**公钥字段**被换（`public_key_mismatch`） | 语料只翻转签名字节，没换过公钥 | `head_signature_public_key_must_equal_chain_key` |
//! | 验证器手里的**预期公钥**与链不符 | 语料固定用链自己的公钥 | `expected_public_key_must_match_the_chain` |
//! | **批次数量 / 批次公钥 / 批次边界**被改 | 语料只删过叶（`leaves`）与证明 | `batch_*` 三条 |
//! | 批大小为 0（`verifier_misconfigured`，而不是 panic） | 语料没造过这种输入 | `zero_batch_size_is_rejected_not_panicked` |
//!
//! **这些都是 (a) 类**：删除实现里的对应检查，本文件的测试就会红；而它们每一条都是
//! "报告里能不能看出被改过"的直接保证。**没有一条是为凑覆盖率写的**。
//!
//! # 与语料的关系（口径纪律）
//!
//! 本文件**不进 `spec/vectors/attest/corpus.json`**，因此：
//! · E2 的检出率证据保持原样（83 例注入 + 2 例边界，期望先写）；
//! · 两侧一致性读数（85 用例 + 2 基准链逐字段相同）**不受影响**；
//! · 这些形态目前只在 **Rust 侧**有测试——它们要不要也进语料（两侧都验）见交付汇报里的说明。

mod support;

use dsh_testkit_attest::chain::AttestedChain;
use dsh_testkit_attest::{verify_chain, Bytes32, ErrorCode, Record, Verdict, VerifyOptions};

/// 干净的基准链（语料里的 `base_batch`）。
fn base() -> AttestedChain {
    support::base_by_id(&support::load_corpus(), "base_batch").clone()
}

/// 三份外部见证全部对齐的验证选项。
fn options_for(chain: &AttestedChain) -> VerifyOptions {
    VerifyOptions {
        expected_chain_head: Some(chain.head.chain_head),
        anchor_declared: true,
        anchor_head: Some(chain.head.chain_head),
        expected_public_key: Some(chain.public_key),
        verify_proofs: true,
    }
}

fn expect(verdict: &Verdict, first_bad_seq: Option<u64>, verified: usize, errors: &[ErrorCode]) {
    assert!(!verdict.chain_ok, "必须被检出：{}", verdict.render());
    assert_eq!(
        verdict.first_bad_seq,
        first_bad_seq,
        "定位不符：{}",
        verdict.render()
    );
    assert_eq!(
        verdict.verified_records,
        verified,
        "已通过条数不符：{}",
        verdict.render()
    );
    assert_eq!(verdict.errors, errors, "错误码不符：{}", verdict.render());
}

/// 对照：干净链 + 三份见证 → 全绿。**其余每条用例都以它为基线**（否则"红了"没有意义）。
///
/// 判别力：把 `verify_chain` 的任一段检查删掉/写错，这条会红或后面的用例会红。
#[test]
fn clean_chain_passes_as_the_baseline() {
    let chain = base();
    let verdict = verify_chain(&chain, &options_for(&chain));
    assert!(verdict.chain_ok, "基线必须全绿：{}", verdict.render());
    assert_eq!(verdict.verified_records, chain.records.len());
}

/// **单条记录自我修复但链链接没跟** ⇒ 在下一条上报 `prev_hash_mismatch`。
///
/// 设计 §7.3 的表把"断链"列为删记录 / 重排的检出机制。但**语料里那两类在阶段 0 的序号
/// 完整性就先被抓住了**，于是断链这一层从未被走到——它是"单独重签一条记录"这种
/// （对自己自洽、对链不自洽的）攻击的第一道防线。
///
/// ⚠️ 构造这一步有个坑（我第一版就踩了）：只"重算"一条**没改过**的记录，它的哈希其实
/// 一点没变，链当然还是绿的。必须**先改载荷**，再让它自我一致（`payload_hash` +
/// `record_hash` 都对），而**下一条的 `prev_hash` 仍指向改动前的那条**。
///
/// 判别力：删掉 `if record.prev_hash != prev_expected` 这道检查，下面两条断言都会红
/// （错误码会从 `prev_hash_mismatch` 变成批量根对不上 `batch_root_mismatch`——
/// 也就是说"是链断了"还是"是签名对不上"将无法区分）。
#[test]
fn single_record_resigned_but_link_not_fixed_is_reported_as_broken_link() {
    for target_seq in [6u64, 13] {
        let mut chain = base();
        let index = chain
            .records
            .iter()
            .position(|record| record.seq == target_seq)
            .expect("基准链里必须有这个 seq");
        {
            let record = &mut chain.records[index];
            // ① 改载荷（这里是"多插一个字段"，对结果记录与门控记录都成立）。
            let mut payload: serde_json::Value =
                serde_json::from_slice(&record.payload_jcs).expect("载荷必须是合法 JSON");
            payload["resigned_by_single_record"] = serde_json::json!(true);
            record.payload_jcs =
                dsh_testkit_attest::jcs::canonicalize_bytes(&payload).expect("载荷必须可规范化");
            // ② 只把这**一条**记录自己的哈希修正：payload_hash 与 record_hash 都自洽。
            record.payload_hash = Record::compute_payload_hash(&record.payload_jcs);
            record.record_hash = record.recompute_record_hash();
            // ③ 不去改下一条的 prev_hash —— 链就在这里断了。
        }
        let verdict = verify_chain(&chain, &options_for(&chain));
        expect(
            &verdict,
            Some(target_seq + 1),
            target_seq as usize,
            &[ErrorCode::PrevHashMismatch],
        );
    }
}

/// 链头摘要里的**三个计数字段**必须逐个被绑定：只改其中一个、`chain_head` 不动 ⇒ 必须检出。
///
/// 为什么值得测：链头摘要是**锚定层要比对的那一份东西**（设计 §7.6）。如果验证器只比
/// `chain_head` 而放过计数，那么"改报告里的总数"就能悄悄溜过——而这正是本地锚定要挡的形态。
///
/// 判别力：把 `chain.head.record_count != record_count` 这类项删掉，对应那条用例会红
/// （改成全绿）。
#[test]
fn head_count_and_last_seq_must_be_bound() {
    // 三项分别单独改：`||` 是短路的，所以每一项都需要一个自己的用例才会被求值。
    type HeadMutation = (&'static str, fn(&mut AttestedChain));
    let cases: [HeadMutation; 3] = [
        ("record_count", |chain| chain.head.record_count -= 1),
        ("seq（末条记录号）", |chain| chain.head.seq -= 1),
        ("result_records（结果记录数）", |chain| {
            chain.head.result_records -= 1
        }),
    ];
    for (label, mutate) in cases {
        let mut chain = base();
        mutate(&mut chain);
        let verdict = verify_chain(&chain, &options_for(&chain));
        expect(
            &verdict,
            None,
            chain.records.len(),
            &[ErrorCode::ChainHeadMismatch],
        );
        println!("[head] 改 {label} → {}", verdict.render());
    }
}

/// 链头签名里的**公钥字段**必须与链声明的公钥一致（否则签名再"合法"也不能算数）。
///
/// 判别力：删掉 `if head_signature.public_key != chain.public_key`，这条会红——它会掉进
/// 验签失败（`head_signature_invalid`），错误码不同。
#[test]
fn head_signature_public_key_must_equal_chain_key() {
    let mut chain = base();
    chain
        .head_signature
        .as_mut()
        .expect("基准链必须有链头签名")
        .public_key = Bytes32::from_bytes([0x11; 32]);
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::PublicKeyMismatch],
    );
}

/// 验证器**手里的预期公钥**与链的公钥不符 ⇒ 必须报 `public_key_mismatch`（E1 的信任锚）。
///
/// 判别力：删掉阶段 5 的 `expected != chain.public_key`，这条会变成全绿——
/// 那意味着"用别的密钥签的链"也能通过一台只知道旧公钥的验证器。
#[test]
fn expected_public_key_must_match_the_chain() {
    let chain = base();
    let mut options = options_for(&chain);
    options.expected_public_key = Some(Bytes32::from_bytes([0x22; 32]));
    let verdict = verify_chain(&chain, &options);
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::PublicKeyMismatch],
    );
}

/// **批次数量**与链上的结果记录划分对不上（少一个批次）⇒ 必须检出。
///
/// 判别力：删掉 `if chunks.len() != chain.batches.len()`，这条会掉进后面的批次循环，
/// 错误码从 `batch_leaf_set_mismatch` 变成别的（或直接 panic 在索引上）。
#[test]
fn missing_batch_is_detected() {
    let mut chain = base();
    chain.batches.clear();
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::BatchLeafSetMismatch],
    );
}

/// **批次序号**被改（`index` 与位置不符）⇒ 必须检出。
///
/// 判别力：删掉 `batch.index != index`，这条会全绿——批次顺序就不再被绑定。
#[test]
fn batch_index_must_match_its_position() {
    let mut chain = base();
    chain.batches[0].index = 7;
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::BatchLeafSetMismatch],
    );
}

/// **批次公钥**被换成另一把 ⇒ 必须检出（与链头签名同一条纪律）。
///
/// 判别力：删掉 `if batch.public_key != chain.public_key`，错误码会变成
/// `batch_signature_invalid`——两种"为什么会失败"被合并，排障时看不出是换了密钥还是改坏了签名。
#[test]
fn batch_public_key_must_equal_chain_key() {
    let mut chain = base();
    chain.batches[0].public_key = Bytes32::from_bytes([0x33; 32]);
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::PublicKeyMismatch],
    );
}

/// **批次边界**（`first_seq` / `last_seq`）被改 ⇒ 必须检出。
///
/// 设计 §7.3.1 把首末 `seq` 绑进批量签名原像，就是为了让"同一棵树换个批次边界"不能再产生同样的签名；
/// 这一条测的是**声明层**的边界也要被核对。
///
/// 判别力：删掉 `batch.first_seq != *first_seq || batch.last_seq != *last_seq`，这条会全绿。
#[test]
fn batch_bounds_must_match_the_leaf_set() {
    let mut chain = base();
    chain.batches[0].first_seq = 99;
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::BatchLeafSetMismatch],
    );

    let mut chain = base();
    chain.batches[0].last_seq = 99;
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::BatchLeafSetMismatch],
    );
}

/// **批次的 Merkle 根**被换成另一个值 ⇒ 必须检出（`batch_root_mismatch`）。
///
/// 语料里有"删叶"（叶子集合对不上）与"改证明"（`merkle_proof_invalid`），但**没有**"改根"——
/// 于是最直白的一条（根自己不是那批叶子的根）此前没人走过。
///
/// 判别力：删掉 `merkle::merkle_root(&leaves) != Some(batch.root)` 这道检查，这条会全绿——
/// 也就是说"根可以是随便一个值"，而批量签名签的正是这个根。
#[test]
fn batch_root_must_match_the_leaf_set() {
    let mut chain = base();
    chain.batches[0].root = Bytes32::from_bytes([0x44; 32]);
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::BatchRootMismatch],
    );
}

/// **批大小为 0** 的链必须被拒绝（`verifier_misconfigured`），**不是 panic**。
///
/// 判别力：把 `partition_result_seqs` 里的 `batch_size == 0` 守卫删掉，
/// `chunks(0)` 会 panic（测试以"线程 panic"的形态红，而不是断言失败）。
#[test]
fn zero_batch_size_is_rejected_not_panicked() {
    let mut chain = base();
    chain.batch_size = 0;
    let verdict = verify_chain(&chain, &options_for(&chain));
    expect(
        &verdict,
        None,
        chain.records.len(),
        &[ErrorCode::VerifierMisconfigured],
    );
}
