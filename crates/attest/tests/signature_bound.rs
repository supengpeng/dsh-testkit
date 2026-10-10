//! D4a：**签名次数上界**（指标 §5）——`签名次数 ≤ ceil(结果记录数 / B) + 2`，B 默认 4096。
//!
//! 这条指标是"改设计而不是调门槛"的产物（RFC §8 Q4）：它读的是**计数器**，
//! 与机器速度无关，所以可以在 CI 里当硬门槛，而不是"跑一次看看"。
//!
//! 本测试同时打印 N 与 `ceil(N/B)+2` 的对照表，供阶段 1 汇报直接引用。

mod support;

use dsh_testkit_attest::chain::{AttestConfig, Attestor, SignatureMode, DEFAULT_BATCH_SIZE};
use dsh_testkit_attest::record::{ChainBuilder, RecordKind};
use dsh_testkit_attest::signature_bound;
use serde_json::json;

/// 造一条链，其中**恰好** `result_records` 条是结果记录；每 7 条结果记录之间插一条门控记录，
/// 用来验证 D4a 的 N 口径是"结果记录数"而不是"记录总数"。
fn chain_with(result_records: usize) -> Vec<dsh_testkit_attest::Record> {
    let mut builder = ChainBuilder::new();
    let mut produced = 0usize;
    let mut tick = 0i64;
    while produced < result_records {
        if produced > 0 && produced.is_multiple_of(7) {
            builder
                .append(RecordKind::Gate, &json!({"gate": produced}), tick)
                .unwrap();
            tick += 1;
        }
        builder
            .append(RecordKind::Result, &json!({"case": produced}), tick)
            .unwrap();
        tick += 1;
        produced += 1;
    }
    builder.into_records()
}

fn measure(result_records: usize, batch_size: usize) -> (u64, u64, u64, u64) {
    let mut attestor = Attestor::new(
        support::test_key(),
        AttestConfig {
            batch_size,
            emit_proofs: false, // D4a 只关心计数；生成证据会让大 N 变慢
            signature_mode: SignatureMode::Batch,
        },
    );
    let records = chain_with(result_records);
    let chain = attestor
        .sign_chain("d4a-measure", &records)
        .expect("装配必须成功");
    let stats = chain.stats;
    assert_eq!(stats.result_records, chain.result_records() as u64);
    assert_eq!(stats.result_records, result_records as u64);
    // 有非结果记录参与：链长必须大于 N（否则这条测试证明不了"口径"）。
    if result_records >= 7 {
        assert!(chain.records.len() > result_records);
    }
    (
        stats.total_signatures,
        stats.batch_signatures,
        stats.head_signatures,
        stats.bound,
    )
}

#[test]
fn d4a_signature_count_upper_bound_holds() {
    println!("=== D4a 签名次数上界（B = {DEFAULT_BATCH_SIZE}）===");
    println!("N（结果记录数） | 实际签名次数 | ceil(N/B)+2 | 批签名 | 链头签名");
    let cases = [
        0usize, 1, 2, 4095, 4096, 4097, 8191, 8192, 8193, 10_000, 20_000,
    ];
    for result_records in cases {
        let (total, batches, heads, bound) = measure(result_records, DEFAULT_BATCH_SIZE);
        let expected_bound = signature_bound(result_records as u64, DEFAULT_BATCH_SIZE);
        println!("{result_records:>14} | {total:>12} | {bound:>11} | {batches:>6} | {heads:>8}");
        assert_eq!(bound, expected_bound, "上界公式必须是 ceil(N/B)+2");
        assert!(
            total <= bound,
            "N={result_records}：签名次数 {total} 超过上界 {bound}"
        );
        assert_eq!(
            batches,
            (result_records as u64).div_ceil(DEFAULT_BATCH_SIZE as u64),
            "批签名次数必须是 ceil(N/B)"
        );
        assert_eq!(heads, 1, "链头签名恰好一次");
    }
    // 结论：本实现的实际次数是 ceil(N/B)+1，落在 ceil(N/B)+2 的额度之内（留 1 次富余）。
    for result_records in [0usize, 1, 4096, 100_000] {
        let (total, _, _, bound) = measure(result_records, DEFAULT_BATCH_SIZE);
        assert_eq!(
            total + 1,
            bound,
            "N={result_records}：实际次数应恰好比上界少 1"
        );
    }
}

#[test]
fn batch_size_changes_the_bound_as_designed() {
    for batch_size in [1usize, 2, 16, 4096] {
        let result_records = 33usize;
        let (total, batches, heads, bound) = measure(result_records, batch_size);
        println!("[D4a] B={batch_size:<5} N={result_records} 签名={total} 上界={bound}");
        assert_eq!(batches, (result_records as u64).div_ceil(batch_size as u64));
        assert_eq!(heads, 1);
        assert!(total <= bound);
        assert_eq!(bound, signature_bound(result_records as u64, batch_size));
    }
}

#[test]
fn per_record_mode_is_explicitly_outside_the_bound() {
    // 对照模式：逐条签名必然 O(N)，**不在 D4a 口径内**。这条测试把这个事实写进代码，
    // 免得有人把 per_record 当生产路径又把 D4a 说成"永远成立"。
    let mut attestor = Attestor::new(
        support::test_key(),
        AttestConfig {
            batch_size: DEFAULT_BATCH_SIZE,
            emit_proofs: false,
            signature_mode: SignatureMode::PerRecord,
        },
    );
    let chain = attestor.sign_chain("per-record", &chain_with(100)).unwrap();
    let stats = chain.stats;
    assert!(stats.per_record_signatures > 0);
    assert!(
        !stats.within_bound,
        "per_record 的签名次数必然超过 D4a 上界（这正是它不作为生产路径的原因）"
    );
    println!(
        "[D4a] per_record（对照，不在口径内）：结果记录 {} 总签名 {} 上界 {}",
        stats.result_records, stats.total_signatures, stats.bound
    );
}
