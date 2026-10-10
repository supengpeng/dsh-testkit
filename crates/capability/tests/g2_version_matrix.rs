//! G2 —— **版本兼容判定正确率** = 兼容判定与实际一致的比例（门槛 100%）。
//!
//! 判据来源：`docs/REWRITE-METRICS.md` §8 L209（"版本矩阵跑判定"）；
//! 判定逻辑真源：`src/fixtures/compat.ts`（经 `spec/contracts/versions.yaml` 的
//! `decision_logic` 登记）。本文件是**对拍前的自证**：每一行的期望值都直接来自
//! `compat.ts` 的语义（含它唯一那条与标准 semver 的有意偏差）。
//!
//! 阶段 2 的对拍契约：`compat.ts` 的 `{ok:true,satisfied:true|false}` 与
//! `{ok:false,reason}` 必须分别等于本 crate 的 `Compatible` / `Incompatible` / `Undecidable`。

use dsh_testkit_capability::{
    check_dsh_version, compare_versions, parse_version, VersionVerdict,
    DECLARED_SUPPORTED_VERSIONS, SUPPORTED_RANGE_SYNTAX,
};

fn compatible(version: &str, range: &str) -> bool {
    check_dsh_version(version, range).is_compatible()
}

#[test]
fn g2_declared_range_matrix() {
    // 声明范围取自 spec/contracts/versions.yaml 的 readouts.declared_range。
    let rows: [(&str, bool); 7] = [
        ("0.2.0-rc.2", true), // 声明支持的那个版本
        ("0.2.0", true),      // 同版本正式版 > 预发布
        ("0.2.1", true),
        ("0.3.0-rc.1", true), // **有意偏差**：不做"预发布默认被排除"
        ("1.0.0", true),
        ("0.2.0-rc.1", false), // 预发布序低于 rc.2
        ("0.1.9", false),
    ];
    for (version, expected) in rows {
        assert_eq!(
            compatible(version, ">=0.2.0-rc.2"),
            expected,
            "{version} 对 >=0.2.0-rc.2 的期望是 {expected}"
        );
    }
}

#[test]
fn g2_syntax_matrix_covers_every_declared_operator() {
    let rows: [(&str, &str, bool); 14] = [
        ("1.2.3", ">=1.2.0", true),
        ("1.1.9", ">=1.2.0", false),
        ("1.2.3", ">1.2.3", false),
        ("1.2.4", ">1.2.3", true),
        ("1.2.3", "<=1.2.3", true),
        ("1.2.4", "<=1.2.3", false),
        ("1.2.2", "<1.2.3", true),
        ("1.2.3", "=1.2.3", true),
        ("1.2.4", "=1.2.3", false),
        // ^：major>0 → [x, x+1.0.0)
        ("1.9.9", "^1.2.0", true),
        ("2.0.0", "^1.2.0", false),
        // ~：写了两段 → [x.y.0, x.y+1.0)
        ("1.2.9", "~1.2.0", true),
        ("1.3.0", "~1.2.0", false),
        // 通配位决定上界
        ("1.9.0", "1.x", true),
    ];
    for (version, range, expected) in rows {
        assert_eq!(
            compatible(version, range),
            expected,
            "{version} 对 {range} 的期望是 {expected}"
        );
    }

    // 通配的另外几个写法。
    assert!(!compatible("2.0.0", "1.x"));
    assert!(compatible("1.2.7", "1.2.*"));
    assert!(!compatible("1.3.0", "1.2.*"));
    assert!(compatible("9.9.9", "*"));
    assert!(compatible("9.9.9", "x"));
    assert!(compatible("9.9.9", "X"));

    // 区间（a - b）与 OR / 空格 AND。
    assert!(compatible("0.5.0", "0.1.0 - 1.0.0"));
    assert!(!compatible("1.0.1", "0.1.0 - 1.0.0"));
    assert!(compatible("1.5.0", ">=1.0.0 <2.0.0"));
    assert!(!compatible("2.0.0", ">=1.0.0 <2.0.0"));
    assert!(compatible("0.1.0", ">=1.0.0 || <0.2.0"));
    assert!(!compatible("0.5.0", ">=1.0.0 || <0.2.0"));
}

#[test]
fn g2_partial_versions_use_npm_range_semantics() {
    // 只写 1~2 段 = 范围；写满三段 = 精确匹配（compat.ts:201-209）。
    assert!(compatible("1.2.3", "1.2"));
    assert!(!compatible("1.3.0", "1.2"));
    assert!(compatible("1.9.0", "1"));
    assert!(!compatible("2.0.0", "1"));
    assert!(compatible("1.2.3", "1.2.3"));
    assert!(!compatible("1.2.4", "1.2.3"));
}

#[test]
fn g2_unparseable_is_undecidable_never_a_boolean() {
    let undecidable: [(&str, &str); 8] = [
        ("not-a-version", ">=0.2.0"),
        ("1.0", "garbage"),
        ("1.0.0", ""),
        ("1.0.0", ">="),
        ("1.0.0", "<>1.0.0"),
        ("1.0.0", ">=1.0.0 >="),
        ("1.0.0", "1.0.0 - "),
        ("1.0.0", "|| >=1.0.0"),
    ];
    for (version, range) in undecidable {
        let verdict = check_dsh_version(version, range);
        assert!(
            matches!(verdict, VersionVerdict::Undecidable { .. }),
            "{version} / {range} 必须不可判定，实际 {verdict:?}"
        );
        assert!(!verdict.is_compatible(), "不可判定不许当成满足");
        assert!(!verdict.is_decidable());
    }
}

#[test]
fn g2_prerelease_ordering_matches_semver_sequence() {
    let earlier = parse_version("1.2.0-rc.1").expect("可解析");
    let later = parse_version("1.2.0-rc.2").expect("可解析");
    let release = parse_version("1.2.0").expect("可解析");
    assert_eq!(compare_versions(&earlier, &later), std::cmp::Ordering::Less);
    assert_eq!(compare_versions(&later, &release), std::cmp::Ordering::Less);
    assert_eq!(
        compare_versions(&release, &release),
        std::cmp::Ordering::Equal
    );
    // 数字标识 < 字母标识（compat.ts:88-90）。
    assert!(
        parse_version("1.0.0-1").expect("可解析") < parse_version("1.0.0-alpha").expect("可解析")
    );
}

#[test]
fn g2_declared_versions_satisfy_the_declared_range() {
    // B3 分子的最小自证：声明的版本必须落在声明的范围内。
    for version in DECLARED_SUPPORTED_VERSIONS {
        assert!(
            compatible(version, ">=0.2.0-rc.2"),
            "声明支持的版本 {version} 必须落在声明范围内"
        );
    }
    assert_eq!(DECLARED_SUPPORTED_VERSIONS.len(), 1);
}

#[test]
fn g2_declared_syntax_list_is_complete_for_parity() {
    // 语法集必须与 versions.yaml 的 supported_syntax 一致，否则对拍域会悄悄缩水。
    assert_eq!(SUPPORTED_RANGE_SYNTAX.len(), 14);
    for token in [
        ">=x.y.z",
        "^x.y.z",
        "~x.y",
        "1.x",
        "1.2.*",
        "*",
        "x",
        "a - b",
        "||",
        "空格 AND",
    ] {
        assert!(
            SUPPORTED_RANGE_SYNTAX.contains(&token),
            "语法清单缺 {token}"
        );
    }
}
