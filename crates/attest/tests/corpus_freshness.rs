//! 语料新鲜度守卫：提交进仓的 `spec/vectors/attest/corpus.json` 必须能由生成器**逐字节**重算出来。
//!
//! 这条纪律与指标 H3（`types/generated/` 用 `git diff` 守）同源：**声明挡不住手改，diff 挡得住**。
//! 有人手改语料去迁就实现，这里就会红。

mod support;

#[test]
fn committed_corpus_matches_regenerated_one() {
    let path = support::corpus_path();
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "读不到 {}：{error}\n先跑：cargo run -p dsh-testkit-attest --example generate_corpus",
            path.display()
        )
    });
    let regenerated = support::corpus_json_text(&support::build_corpus());
    assert_eq!(
        committed, regenerated,
        "语料与生成器不一致——要么有人手改了语料，要么改了生成器却没重新生成。\n\
         重新生成：cargo run -p dsh-testkit-attest --example generate_corpus"
    );
}

#[test]
fn corpus_carries_the_boundary_statement() {
    // 边界声明必须**随语料一起**被读到，否则读语料的人只会看到"检出率 100%"，
    // 看不到"重写整链检不出"。这是设计 §7.5 对文档的要求在数据侧的落点。
    let corpus = support::load_corpus();
    assert!(
        corpus.note.contains("tamper-evident"),
        "语料的 note 必须带上边界声明，实际：{}",
        corpus.note
    );
    assert!(
        corpus.note.contains("不是 tamper-proof"),
        "语料的 note 必须写清「不是防篡改」"
    );
    assert!(
        !corpus.key.public_key.is_empty(),
        "语料必须带上公钥（公开值）"
    );
    // 语料里**不允许**出现任何私钥形态：只有公钥与派生说明。
    let text = support::corpus_json_text(&corpus);
    assert!(
        !text.contains("seed_hex") && !text.contains("private"),
        "语料不得包含私钥字段"
    );
}
