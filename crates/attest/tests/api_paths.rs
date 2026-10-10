//! **公开 API 的错误路径**（task-26 的 (a) 类缺口）。
//!
//! 这些不是"内部防御分支"，而是**文档承诺过的对外行为**，此前没有任何测试调用过它们：
//!
//! | 行为 | 出处 | 判别力 |
//! |---|---|---|
//! | 链文件的 `format` 不是 `dsh-testkit/attest/chain/v1` ⇒ 拒绝 | `AttestedChain::from_json_text` 的文档 | 删掉 format 检查，会把外来文件当自己的链解析 |
//! | `AttestConfig{batch_size: 0}` ⇒ `EmptyBatchSize` | `Attestor::sign_chain` 的文档 | 删掉守卫，`chunks(0)` panic |
//! | 空树的 `root()` 是 `None`（不是 panic） | `MerkleTree::root` 的文档 | 删掉守卫，空批会让 `[0]` 越界 |
//! | `signature_bound(_, 0)` 返回 0（不除零） | `signature_bound` 的文档 | 删掉守卫，除零 panic |
//!
//! **不写**的（(b)/(c)，理由写在 `src/` 的注释里）：`Display` / `Debug` / hex 编解码的小工具
//! 分支、以及 `from_json_text` 里 serde 自己的错误路径（拿它当断言等于在测 serde）。

mod support;

use dsh_testkit_attest::chain::{AttestConfig, Attestor, CHAIN_FORMAT};
use dsh_testkit_attest::record::{ChainBuilder, RecordKind};
use dsh_testkit_attest::{signature_bound, AttestError, AttestedChain, MerkleTree};
use serde_json::json;

/// 链文件格式是**跨语言契约**的一部分：不认识的文件必须被拒绝，而不是被当作链解析。
///
/// 判别力：删掉 `if chain.format != CHAIN_FORMAT`，这条会返回 `Ok`（外来 JSON 只要字段形状
/// 凑巧能反序列化就会被当成链）。
#[test]
fn foreign_chain_format_is_rejected() {
    let corpus = support::load_corpus();
    let chain = support::base_by_id(&corpus, "base_batch");
    let text = chain.to_json_text().unwrap();
    assert!(text.contains(CHAIN_FORMAT));
    let foreign = text.replace(CHAIN_FORMAT, "some-other-tool/chain/v9");

    let error = AttestedChain::from_json_text(&foreign).unwrap_err();
    match error {
        AttestError::Wire(message) => assert!(
            message.contains("format"),
            "错误信息应指向 format，实际：{message}"
        ),
        other => panic!("期望 Wire 错误，实际：{other:?}"),
    }
}

/// 批大小为 0 是**调用方的错**，必须在装配阶段报错，不能等到切片时 panic。
///
/// 判别力：删掉 `if self.config.batch_size == 0`，这条会 panic（`chunks(0)`）。
#[test]
fn zero_batch_size_is_rejected_when_signing() {
    let mut builder = ChainBuilder::new();
    builder
        .append(RecordKind::Result, &json!({"case": 1}), 1)
        .unwrap();
    let mut attestor = Attestor::new(
        support::test_key(),
        AttestConfig {
            batch_size: 0,
            emit_proofs: true,
            signature_mode: dsh_testkit_attest::chain::SignatureMode::Batch,
        },
    );
    let error = attestor.sign_chain("run", builder.records()).unwrap_err();
    assert_eq!(error, AttestError::EmptyBatchSize);
}

/// 空 Merkle 树：`root()` 是 `None`、`is_empty()` 为真、高度 0、任何下标都没有证据。
///
/// 为什么值得测：D4a 的边界情形就是"零条结果记录"（`N = 0`），那时**没有根可签**。
/// 判别力：把 `root()` 的 `if self.is_empty()` 守卫删掉，这条会 panic 在空切片取首元素上。
#[test]
fn empty_merkle_tree_has_no_root() {
    let tree = MerkleTree::from_leaves(&[]);
    assert!(tree.is_empty());
    assert_eq!(tree.leaf_count(), 0);
    assert_eq!(tree.height(), 0);
    assert_eq!(tree.root(), None);
    assert_eq!(tree.proof(0), None);
}

/// 上界公式对 `batch_size = 0` 返回 0，而不是除零。
///
/// 判别力：删掉 `signature_bound` 的 `if batch_size == 0`，这条会 panic（除零）。
#[test]
fn signature_bound_handles_zero_batch_size() {
    assert_eq!(signature_bound(100, 0), 0);
    // 对照：非零批大小仍按 ceil(N/B)+2 走。
    assert_eq!(signature_bound(100, 16), 9);
}
