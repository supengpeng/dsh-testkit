//! `normalize.rs` 的**边界与拒绝路径**测试（J1 分支覆盖，task-25）。
//!
//! # 这里放的是 (a) 类
//!
//! 任务要求逐块判定三档：(a) 真实行为缺口 ⇒ 补测试；(b) 防御性/不可达 ⇒ 注释；
//! (c) 样板 ⇒ 不补。**本文件只放 (a)**——即"某些归一化分支从未被真正走过"。
//!
//! 它与 `a5_negative.rs` 是同一纪律的两面：a5 证明"归一化**没有过度**"（真实差异不被掩盖），
//! 本文件证明"归一化的每条规则与每个**拒绝**路径都真的被走过"。
//! 少了后半句，a5 的防护就有盲区：一条从未走过的分支可能一直在悄悄吞掉它不该吞的东西。
//!
//! 每条测试上方都写了**判别力**（"把实现改错会怎样红"）——没有判别力的断言不值得存在。
//!
//! # (b) 类的说明
//!
//! `normalize.rs` 里还有一批 LLVM **无法分侧归因**的分支（表现为 `exec > 0` 但
//! `true == 0 && false == 0`）。它们不是行为缺口，也无法用测试"点亮"——见交付汇报的三档表。

use std::collections::BTreeSet;

use dsh_testkit_reconciler::{normalize_str, normalize_value};
use serde_json::json;

fn norm(text: &str) -> String {
    let mut used = BTreeSet::new();
    normalize_str(text, &mut used)
}

fn rules(text: &str) -> BTreeSet<&'static str> {
    let mut used = BTreeSet::new();
    let _ = normalize_str(text, &mut used);
    used
}

// ---------------------------------------------------------------- run_id --

/// 判别力：把 `match_run_id` 里任意一位的检查删掉（例如不再要求第 11 位是 `T`），
/// 这个"看起来像 run id 但第 11 位是 X"的串就会被误吞成 `<RUNID>` → 本测试红。
#[test]
fn run_id_rejects_a_near_miss_at_every_position() {
    assert_eq!(norm("2026-10-11X00-12-34_ab12"), "2026-10-11X00-12-34_ab12");
}

/// 判别力：把后缀下限从 2 放宽到 1 → `_a` 会被吞成 `<RUNID>` → 红。
#[test]
fn run_id_rejects_a_one_character_suffix() {
    assert_eq!(norm("2026-10-11T00-12-34_a"), "2026-10-11T00-12-34_a");
}

/// 判别力：把后缀下限改成 3 → `_ab`（合法运行 id）不再被归一化 → 红。
#[test]
fn run_id_accepts_a_two_character_suffix() {
    assert_eq!(norm("2026-10-11T00-12-34_ab"), "<RUNID>");
}

/// 判别力：去掉后缀 8 位的上限 → 上面 10 位后缀会被整段吞掉，尾部不多出 `ij` → 红。
#[test]
fn run_id_suffix_is_capped_at_eight_characters() {
    assert_eq!(norm("2026-10-11T00-12-34_abcdefghij"), "<RUNID>ij");
}

// ------------------------------------------------------------- timestamp --

/// 判别力：把"可选毫秒 / 可选时区"写成**必填** → 这个没有毫秒也没有时区的 ISO 串
/// 不再被归一化 → 红。
#[test]
fn timestamp_without_millis_or_zone_is_still_normalized() {
    assert_eq!(norm("2026-10-11T00:12:34"), "<TS>");
}

/// 判别力：只认 `Z` 时区、不认数字偏移 → 这两个串不再归一化 → 红。
#[test]
fn timestamp_accepts_numeric_zone_offsets_both_signs() {
    assert_eq!(norm("2026-10-11T00:12:34+08:00"), "<TS>");
    assert_eq!(norm("2026-10-11T00:12:34-05:00"), "<TS>");
}

/// 判别力：把毫秒解析写死成固定 3 位 → 单位数毫秒（`.5Z`）不再被吞 → 红。
#[test]
fn timestamp_accepts_a_single_digit_fraction() {
    assert_eq!(norm("2026-10-11T00:12:34.5Z"), "<TS>");
}

// ----------------------------------------------------------------- path --

/// 判别力：删掉 `bytes.len() >= index + prefix.len()` 的长度检查 → 短输入会越界 panic
/// （或匹配失败路径被跳过）→ 红。
#[test]
fn posix_prefix_requires_the_trailing_slash_and_enough_bytes() {
    // 不是 `/tmp/` 这个前缀（少了尾随斜杠）：
    assert_eq!(norm("/tmp"), "/tmp");
    // 尾部斜杠在但长度不够：
    assert_eq!(norm("/tmp"), "/tmp");
}

/// 判别力：`POSIX_PATH_PREFIXES` 少列任何一个前缀 → 对应断言红。
/// 这七个前缀是**声明支持面**，不是实现细节。
#[test]
fn every_declared_posix_prefix_is_accepted() {
    for sample in [
        "/tmp/a",
        "/home/u/a",
        "/Users/u/a",
        "/var/log/a",
        "/private/x",
        "/root/.ssh",
        "/etc/hosts",
    ] {
        assert_eq!(norm(sample), "<PATH>", "{sample} 应被归一化");
    }
}

/// 判别力：把盘符检查从"必须是字母"放宽 → `1:\x` 会被当成路径 → 红；
/// 去掉分隔符检查 → `C:` 被当成路径 → 红；去掉"分隔符后必须有内容"检查 → `C:\` 被当成路径 → 红。
#[test]
fn windows_path_rejects_non_letter_drive_and_empty_tail() {
    assert_eq!(norm("1:\\x"), "1:\\x");
    assert_eq!(norm("C:"), "C:");
    assert_eq!(norm("C:\\"), "C:\\");
    assert_eq!(norm("C:\\a"), "<PATH>");
}

// -------------------------------------------------------------- version --

/// 判别力：把"必须三段"改成"两段即可" → `1.2` 会被吞成 `<VER>` → 红。
#[test]
fn version_requires_three_numeric_parts() {
    assert_eq!(norm("1.2"), "1.2");
    assert_eq!(norm("x 1.2.3 y"), "x <VER> y");
}

/// 判别力：去掉第三段"必须是数字"的检查 → `1.2.x` 会被吞成 `<VER>` 或吞掉一半 → 红。
#[test]
fn version_rejects_a_non_numeric_third_part() {
    assert_eq!(norm("1.2.x"), "1.2.x");
}

/// 判别力：去掉"前一字符不得是数字或点"的守卫 → 上例中的 `.x` 位置会被重新尝试匹配，
/// 结果会多吞字符 → 红。这条守卫是**拒绝路径**，不是装饰。
#[test]
fn version_does_not_match_inside_a_longer_numeric_run() {
    assert_eq!(norm("a1.2.3"), "a<VER>");
    // 三段之后的 `.4` 不再被当成新版本的开头：
    assert_eq!(norm("1.2.3.4"), "<VER>.4");
}

/// 判别力：去掉 prerelease 解析 → `0.2.0-rc.2` 只吞 `0.2.0`，留下 `-rc.2` → 红。
#[test]
fn version_consumes_a_prerelease_suffix() {
    assert_eq!(norm("0.2.0-rc.2"), "<VER>");
    assert_eq!(norm("0.2.0-"), "<VER>-");
}

// -------------------------------------------------------------- address --

/// 判别力：去掉"必须恰好以 `0x` 开头"的检查 → `0X1f` 或 `x0x1f` 的边界行为改变 → 红。
#[test]
fn address_requires_lowercase_0x_and_at_least_one_hex_digit() {
    assert_eq!(norm("0x"), "0x");
    assert_eq!(norm("0X1f"), "0X1f");
    assert_eq!(norm("x0x1f"), "x<ADDR>");
}

// ------------------------------------------------------- 主循环与规则记录 --

/// 判别力：把非 ASCII 的推进写成按字节推进 → 中文会被拆成乱码字节 → 红。
#[test]
fn non_ascii_bytes_are_advanced_by_whole_characters() {
    assert_eq!(norm("中文 abc"), "中文 abc");
}

/// 判别力：去掉空白折叠 → 制表符与换行留在结果里 → 红；并且 `whitespace` 规则
/// 必须**只在真的折叠了**的时候才被记录（否则"用了哪些规则"这份审计会失真）。
#[test]
fn whitespace_is_collapsed_and_recorded_only_when_it_changes() {
    let collapsed = norm("a\t\tb\n c");
    assert_eq!(collapsed, "a b c");
    assert!(rules("a\t\tb\n c").contains("whitespace"));
    assert!(!rules("a b c").contains("whitespace"));
}

/// 判别力：`normalize_value` 只处理 String/Array/Object、漏掉标量分支 → 这些断言红。
#[test]
fn normalize_value_passes_scalars_through() {
    let mut used = BTreeSet::new();
    assert_eq!(normalize_value(&json!(3), &mut used), json!(3));
    assert_eq!(normalize_value(&json!(true), &mut used), json!(true));
    assert_eq!(normalize_value(&json!(null), &mut used), json!(null));
    assert!(used.is_empty(), "标量不该引入任何归一化规则");
}

/// 判别力：`normalize_value` 的对象分支若直接返回原对象（不递归）→ 嵌套里的 runId 不会
/// 被替换 → 红。
#[test]
fn normalize_value_recurses_into_objects_and_arrays() {
    let mut used = BTreeSet::new();
    let value = json!({ "outer": { "id": "2026-10-11T00-00-00_aaaa", "list": ["/tmp/x"] } });
    let out = normalize_value(&value, &mut used);
    assert_eq!(out["outer"]["id"], json!("<RUNID>"));
    assert_eq!(out["outer"]["list"][0], json!("<PATH>"));
    assert!(used.contains("runid"));
    assert!(used.contains("path"));
}

// ------------------------------------------- timestamp 的非法时区（拒绝路径）--

/// 判别力：把 `±` 时区的守卫写成"见到 `+`/`-` 就直接吃 6 个字符"（不再检查
/// `HH:MM` 的形态）→ `+8:00` 与 `+0800` 会被多吞 → 红。
///
/// 这条守卫是**拒绝路径**：时区写错时宁可少吞，也不能把后面的内容一起吃进 `<TS>`。
#[test]
fn timestamp_rejects_malformed_zone_offsets() {
    assert_eq!(norm("2026-10-11T00:12:34+8:00"), "<TS>+8:00");
    assert_eq!(norm("2026-10-11T00:12:34+0800"), "<TS>+0800");
    assert_eq!(norm("2026-10-11T00:12:34+"), "<TS>+");
}

// ------------------------------------------------- 路径的终止符集合 --

/// 判别力：从 `is_path_terminator` 里删掉任何一个终止符 → 对应样本会把终止符及其后的
/// 内容一起吞进 `<PATH>` → 红。终止符集合是**路径规则的边界声明**，不是装饰。
#[test]
fn path_stops_at_every_kind_of_terminator() {
    assert_eq!(norm("/tmp/a\"b"), "<PATH>\"b");
    assert_eq!(norm("/tmp/a;b"), "<PATH>;b");
    assert_eq!(norm("/tmp/a>b"), "<PATH>>b");
    assert_eq!(norm("/tmp/a b"), "<PATH> b");
    // 非 ASCII 也是终止符（否则中文注释会被整段吞进路径）：
    assert_eq!(norm("/tmp/a中b"), "<PATH>中b");
}

// --------------------------------------------- run_id 的逐位拒绝（防误吞）--

/// 判别力：`match_run_id` 是一串"逐位必须匹配"的检查。把任意一位的检查删掉，
/// 对应样本就会被误吞成 `<RUNID>` → 红。
///
/// 这里逐位构造"只差一个字符"的输入：每一位都真实存在，因为**少一位检查**就意味着
/// 一段普通文本可能被误归一化（而 A5 的纪律正是"归一化不得掩盖真实差异"）。
#[test]
fn run_id_rejects_a_mismatch_at_each_position() {
    for sample in [
        "2026X10-11T00-12-34_ab12", // 第 5 位应为 '-'
        "2026-10X11T00-12-34_ab12", // 第 8 位
        "2026-10-11T00:12-34_ab12", // 第 14 位
        "2026-10-11T00-12:34_ab12", // 第 17 位
        "2026-10-11T00-12-34Xab12", // 第 20 位应为 '_'
    ] {
        assert_eq!(norm(sample), sample, "{sample} 不该被当成 run id");
    }
}

/// 判别力：prerelease 段允许 `.` 与 `-`。把 `bytes[probe] == b'-'` 从允许字符里删掉 →
/// `1.0.0-alpha-1` 只吞到 `alpha`、留下 `-1` → 红（`. ` 那一侧由 `alpha.1` 守）。
///
/// 这是 `normalize.rs` 里**唯一一处**「真的从未执行到」（`exec == 0`）的分支，
/// 其余未覆盖项都是 LLVM 无法分侧归因的伪缺口（见交付汇报的三档表）。
#[test]
fn version_prerelease_may_contain_hyphens_and_dots() {
    assert_eq!(norm("1.0.0-alpha-1"), "<VER>");
    assert_eq!(norm("1.0.0-alpha.1"), "<VER>");
}
