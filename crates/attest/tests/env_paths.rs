//! **环境相关的生产入口**（task-26 的 (a) 类缺口）：`KeyMaterial::load_from_env` 与
//! `LocalAnchor::from_env`。
//!
//! 为什么它们是 (a) 而不是 (b)：这两条正是 **I1（私钥不出进程）** 与 **§7.6（本地锚定）** 的
//! **生产入口**——此前**没有任何测试调用过它们**：所有测试要么直接构造密钥，要么用
//! `LocalAnchor::unchecked_for_tests`。于是"私钥从哪来"这件事在生产里只被"应该没问题"覆盖着。
//!
//! # ⚠️ 为什么本文件只有一个 `#[test]`
//!
//! 下面每一步都要读写**进程级环境变量**。同一个测试二进制里的 `#[test]` 会并行跑，
//! 若拆成多个测试函数就会出现"另一个测试把我的环境变量清了"的竞争——那是负资产。
//! 所以：**一个函数、顺序执行、结束时清干净**。
//!
//! 不测的（(b)，理由见 `src/signing.rs` 与 `src/anchor.rs` 的注释）：
//! 「密钥文件**在仓库之外**且合法 ⇒ 成功装载」——本会话的沙箱不允许在仓库外建文件，
//! 而这恰恰是组织得最严的那条路；能测的那半边（**拒绝仓库内的密钥文件**）已经在这里了。

mod support;

use dsh_testkit_attest::anchor::{LocalAnchor, ENV_ANCHOR_DIR};
use dsh_testkit_attest::signing::repository_root_of;
use dsh_testkit_attest::{AnchorError, KeyError, KeyMaterial, ENV_KEY_FILE, ENV_KEY_HEX};

/// 一次跑完所有环境分支；每个子步骤都断言**具体句型**，而不是"只要出错就行"。
///
/// 判别力：把 `load_from_env` 里"hex 为空则继续找文件"的那一步删掉，第 ③ 子步会红；
/// 把 `from_env` 的"仓库之外"检查删掉，第 ④ 子步会红（变成 `Ok`）。
#[test]
fn key_and_anchor_env_entry_points() {
    let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let inside_repo = repository_root_of(manifest).is_some();
    let key_file_in_repo = manifest.join("Cargo.toml");
    let anchor_dir_in_repo = manifest.join("../target/attest-env-anchor");
    let cleanup = || {
        std::env::remove_var(ENV_KEY_HEX);
        std::env::remove_var(ENV_KEY_FILE);
        std::env::remove_var(ENV_ANCHOR_DIR);
    };
    cleanup();

    // ① 一个都不设 ⇒ 明确报"没有来源"，不是悄悄用别的密钥。
    assert_eq!(
        KeyMaterial::load_from_env().unwrap_err(),
        KeyError::MissingSource,
        "未设置任何来源时必须报 MissingSource"
    );

    // ② hex 种子这条路（I1 的生产入口之一）：装出来的密钥必须与同一标签派生的完全一致。
    let seed_hex = support::test_seed_hex();
    std::env::set_var(ENV_KEY_HEX, &seed_hex);
    let loaded = KeyMaterial::load_from_env().expect("合法的 hex 种子必须能装载");
    assert_eq!(
        loaded.public_key(),
        support::test_key().public_key(),
        "同一颗种子必须派生出同一把公钥"
    );
    cleanup();

    // ③ hex 只有空白 ⇒ 应当**跳过**它，转而看文件路径；而仓库内的密钥文件必须被拒绝。
    if inside_repo {
        std::env::set_var(ENV_KEY_HEX, "   ");
        std::env::set_var(ENV_KEY_FILE, &key_file_in_repo);
        let error = KeyMaterial::load_from_env().unwrap_err();
        assert!(
            matches!(error, KeyError::InsideRepository(_)),
            "仓库内的密钥文件必须被拒绝，实际：{error:?}"
        );
        cleanup();
    } else {
        println!("跳过 ③：当前副本不在 git 工作树内（InsideRepository 无从触发）");
    }

    // ④ 锚定目录落在仓库内 ⇒ 必须拒绝（设计 §7.6 要求"必须在仓库之外"）。
    if inside_repo {
        std::env::set_var(ENV_ANCHOR_DIR, &anchor_dir_in_repo);
        let error = LocalAnchor::from_env("attest-env-test").unwrap_err();
        assert!(
            matches!(error, AnchorError::DirectoryInsideRepository(_)),
            "仓库内的锚定目录必须被拒绝，实际：{error:?}"
        );
        cleanup();
    } else {
        println!("跳过 ④：当前副本不在 git 工作树内");
    }

    // ⑤ 锚定目录留空 ⇒ 走"缺省 ~/.dsh-testkit/anchors/"这条兜底（不是报错）。
    std::env::set_var(ENV_ANCHOR_DIR, "   ");
    let anchor = LocalAnchor::from_env("attest-env-test").expect("留空应回落到缺省锚定目录");
    assert_eq!(anchor.project_hash().len(), 16);
    println!(
        "⑤ 留空回落成功：project_hash={}（路径不打印，避免把家目录带进日志）",
        anchor.project_hash()
    );
    cleanup();
}
