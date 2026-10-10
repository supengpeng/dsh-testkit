//! 归一化器（`normalized` 等价关系的实现）。
//!
//! # 纪律：归一化**只替换已知的非确定片段**，不吞整串
//!
//! 设计 §9.3 纪律 2 要求"归一化规则本身要有反向测试：注入已知差异，验证归一化**没有**
//! 把它掩盖"。`tests/a5_negative.rs` 里有一个**过度归一化**的对照实现
//! （把任意非空文本抹成同一个占位），它必须**漏检**——如果它也能"通过"，
//! 说明本模块的测试没有判别力。
//!
//! # 规则表（可审计）
//!
//! | 规则名 | 替换 | 例子 |
//! |---|---|---|
//! | `runid` | `<RUNID>` | `2026-10-11T00-12-34_ab12` |
//! | `timestamp` | `<TS>` | `2026-10-11T00:12:34.567Z` |
//! | `path` | `<PATH>` | `C:\Users\x\AppData\Local\Temp\…`、`/tmp/dsh-testkit-…` |
//! | `version` | `<VER>` | `0.2.0-rc.2` |
//! | `stack-address` | `<ADDR>` | `0x7ffd1a2b` |
//! | `whitespace` | 折叠成单空格 | 多行错误文本 |
//!
//! `reconcile-fields.yaml` 的 `rule` 文本里写的 `<RUNID>` / `<TS>` / `<CASESDIR>` 是
//! **叙述性占位**；Rust 侧的规则名以上表为准（表驱动的是"用哪种等价关系"，
//! 归一化的具体替换由本模块唯一实现）。

use std::collections::BTreeSet;

use serde_json::{Map, Value};

/// 归一化规则（写进 `ReconciliationReport::normalized_fields` 的就是它的 `as_str`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum NormalizationRule {
    /// 运行 id（含时间戳与随机后缀）。
    RunId,
    /// ISO 8601 时间戳。
    Timestamp,
    /// 绝对路径（Windows 或 POSIX）。
    Path,
    /// 版本号。
    Version,
    /// 栈帧地址。
    StackAddress,
    /// 空白折叠。
    Whitespace,
}

impl NormalizationRule {
    /// 规则名（可审计；出现在报告里）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunId => "runid",
            Self::Timestamp => "timestamp",
            Self::Path => "path",
            Self::Version => "version",
            Self::StackAddress => "stack-address",
            Self::Whitespace => "whitespace",
        }
    }
}

/// 递归归一化任意 JSON 值，并把用到的规则记进 `used`。
pub fn normalize_value(value: &Value, used: &mut BTreeSet<&'static str>) -> Value {
    match value {
        Value::String(text) => Value::String(normalize_str(text, used)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| normalize_value(item, used))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key.clone(), normalize_value(item, used));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// 归一化一段文本（规则见模块文档）。
pub fn normalize_str(input: &str, used: &mut BTreeSet<&'static str>) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut index = 0usize;

    while index < bytes.len() {
        if let Some(end) = match_run_id(bytes, index) {
            used.insert(NormalizationRule::RunId.as_str());
            out.push_str("<RUNID>");
            index = end;
            continue;
        }
        if let Some(end) = match_timestamp(bytes, index) {
            used.insert(NormalizationRule::Timestamp.as_str());
            out.push_str("<TS>");
            index = end;
            continue;
        }
        if let Some(end) =
            match_windows_path(bytes, index).or_else(|| match_posix_path(bytes, index))
        {
            used.insert(NormalizationRule::Path.as_str());
            out.push_str("<PATH>");
            index = end;
            continue;
        }
        if let Some(end) = match_version(bytes, index) {
            used.insert(NormalizationRule::Version.as_str());
            out.push_str("<VER>");
            index = end;
            continue;
        }
        if let Some(end) = match_address(bytes, index) {
            used.insert(NormalizationRule::StackAddress.as_str());
            out.push_str("<ADDR>");
            index = end;
            continue;
        }
        if bytes[index].is_ascii() {
            out.push(char::from(bytes[index]));
            index += 1;
        } else {
            let ch = input[index..].chars().next().unwrap_or('\u{fffd}');
            out.push(ch);
            index += ch.len_utf8();
        }
    }

    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed != out {
        used.insert(NormalizationRule::Whitespace.as_str());
    }
    collapsed
}

fn digits_at(bytes: &[u8], start: usize, count: usize) -> bool {
    bytes.len() >= start + count && bytes[start..start + count].iter().all(u8::is_ascii_digit)
}

fn byte_at(bytes: &[u8], index: usize) -> Option<u8> {
    bytes.get(index).copied()
}

/// 是否是路径的终止字节（空白、引号、常见分隔符，或任何非 ASCII 字符）。
fn is_path_terminator(byte: u8) -> bool {
    byte.is_ascii_whitespace()
        || matches!(
            byte,
            b'"' | b'\'' | b',' | b')' | b']' | b'}' | b';' | b'>' | b'<'
        )
        || !byte.is_ascii()
}

fn eat_until_terminator(bytes: &[u8], start: usize) -> usize {
    let mut index = start;
    while index < bytes.len() && !is_path_terminator(bytes[index]) {
        index += 1;
    }
    index
}

/// `YYYY-MM-DDTHH-MM-SS_xxxx`（运行 id 的形态，见 `src/runtime/runner.ts` 的 `makeRunId`）。
fn match_run_id(bytes: &[u8], index: usize) -> Option<usize> {
    let matched = digits_at(bytes, index, 4)
        && byte_at(bytes, index + 4) == Some(b'-')
        && digits_at(bytes, index + 5, 2)
        && byte_at(bytes, index + 7) == Some(b'-')
        && digits_at(bytes, index + 8, 2)
        && byte_at(bytes, index + 10) == Some(b'T')
        && digits_at(bytes, index + 11, 2)
        && byte_at(bytes, index + 13) == Some(b'-')
        && digits_at(bytes, index + 14, 2)
        && byte_at(bytes, index + 16) == Some(b'-')
        && digits_at(bytes, index + 17, 2)
        && byte_at(bytes, index + 19) == Some(b'_');
    if !matched {
        return None;
    }
    let mut end = index + 20;
    let mut count = 0usize;
    while count < 8 && bytes.get(end).is_some_and(u8::is_ascii_alphanumeric) {
        end += 1;
        count += 1;
    }
    if count >= 2 {
        Some(end)
    } else {
        None
    }
}

/// `YYYY-MM-DDTHH:MM:SS`（可选毫秒、可选时区）。
fn match_timestamp(bytes: &[u8], index: usize) -> Option<usize> {
    let matched = digits_at(bytes, index, 4)
        && byte_at(bytes, index + 4) == Some(b'-')
        && digits_at(bytes, index + 5, 2)
        && byte_at(bytes, index + 7) == Some(b'-')
        && digits_at(bytes, index + 8, 2)
        && byte_at(bytes, index + 10) == Some(b'T')
        && digits_at(bytes, index + 11, 2)
        && byte_at(bytes, index + 13) == Some(b':')
        && digits_at(bytes, index + 14, 2)
        && byte_at(bytes, index + 16) == Some(b':')
        && digits_at(bytes, index + 17, 2);
    if !matched {
        return None;
    }
    let mut end = index + 19;
    if byte_at(bytes, end) == Some(b'.') && digits_at(bytes, end + 1, 1) {
        end += 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
    }
    match byte_at(bytes, end) {
        Some(b'Z') => end += 1,
        Some(b'+' | b'-')
            if digits_at(bytes, end + 1, 2) && byte_at(bytes, end + 3) == Some(b':') =>
        {
            end += 6;
        }
        _ => {}
    }
    Some(end)
}

/// Windows 绝对路径：`X:\…` 或 `X:/…`。
fn match_windows_path(bytes: &[u8], index: usize) -> Option<usize> {
    let drive = byte_at(bytes, index)?;
    if !drive.is_ascii_alphabetic() {
        return None;
    }
    if byte_at(bytes, index + 1) != Some(b':') {
        return None;
    }
    if !matches!(byte_at(bytes, index + 2), Some(b'\\') | Some(b'/')) {
        return None;
    }
    let end = eat_until_terminator(bytes, index + 3);
    if end == index + 3 {
        return None;
    }
    Some(end)
}

const POSIX_PATH_PREFIXES: [&str; 7] = [
    "/tmp/",
    "/home/",
    "/Users/",
    "/var/",
    "/private/",
    "/root/",
    "/etc/",
];

/// POSIX 绝对路径（只认常见前缀，避免把普通斜杠文本当成路径）。
fn match_posix_path(bytes: &[u8], index: usize) -> Option<usize> {
    if byte_at(bytes, index) != Some(b'/') {
        return None;
    }
    let matched = POSIX_PATH_PREFIXES.iter().any(|prefix| {
        let prefix = prefix.as_bytes();
        bytes.len() >= index + prefix.len() && &bytes[index..index + prefix.len()] == prefix
    });
    if !matched {
        return None;
    }
    Some(eat_until_terminator(bytes, index + 1))
}

/// `x.y.z`（可选 `-prerelease`）。
fn match_version(bytes: &[u8], index: usize) -> Option<usize> {
    if index > 0 {
        let previous = bytes[index - 1];
        if previous.is_ascii_digit() || previous == b'.' {
            return None;
        }
    }
    let mut cursor = index;
    for part in 0..3 {
        let start = cursor;
        while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
            cursor += 1;
        }
        if cursor == start {
            return None;
        }
        if part < 2 {
            if byte_at(bytes, cursor) != Some(b'.') {
                return None;
            }
            cursor += 1;
        }
    }
    if byte_at(bytes, cursor) == Some(b'-') {
        let mut probe = cursor + 1;
        let start = probe;
        while probe < bytes.len()
            && (bytes[probe].is_ascii_alphanumeric()
                || bytes[probe] == b'.'
                || bytes[probe] == b'-')
        {
            probe += 1;
        }
        if probe > start {
            cursor = probe;
        }
    }
    Some(cursor)
}

/// `0x` + 至少一位十六进制（栈帧地址）。
fn match_address(bytes: &[u8], index: usize) -> Option<usize> {
    if byte_at(bytes, index) != Some(b'0') || byte_at(bytes, index + 1) != Some(b'x') {
        return None;
    }
    let mut cursor = index + 2;
    while cursor < bytes.len() && bytes[cursor].is_ascii_hexdigit() {
        cursor += 1;
    }
    if cursor == index + 2 {
        None
    } else {
        Some(cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn norm(text: &str) -> (String, BTreeSet<&'static str>) {
        let mut used = BTreeSet::new();
        let out = normalize_str(text, &mut used);
        (out, used)
    }

    #[test]
    fn replaces_run_id_timestamp_path_version_and_address() {
        assert_eq!(norm("2026-10-11T00-12-34_ab12").0, "<RUNID>");
        assert_eq!(norm("2026-10-11T00:12:34.567Z").0, "<TS>");
        assert_eq!(norm("C:\\Users\\x\\Temp\\a.txt").0, "<PATH>");
        assert_eq!(norm("/tmp/dsh-testkit-a/b").0, "<PATH>");
        assert_eq!(norm("0.2.0-rc.2").0, "<VER>");
        assert_eq!(norm("0x7ffd1a2b").0, "<ADDR>");
    }

    #[test]
    fn does_not_swallow_real_differences() {
        // A5 的要害：只替换路径片段，路径之外的差异必须留下。
        let (out, _) = norm("错误：/tmp/a/x.txt 打不开（EACCES）");
        assert!(out.contains("打不开"), "真实差异被吞掉了：{out}");
        assert!(out.contains("EACCES"), "错误码必须保留：{out}");
        assert!(out.contains("<PATH>"), "路径应被替换：{out}");
    }

    #[test]
    fn records_the_rules_that_were_used() {
        let (_, used) = norm("/tmp/a 0.2.0 0xdead");
        assert!(used.contains("path"));
        assert!(used.contains("version"));
        assert!(used.contains("stack-address"));
        assert!(!used.contains("runid"));
    }

    #[test]
    fn normalizes_nested_values() {
        let mut used = BTreeSet::new();
        let value = json!({ "a": ["/tmp/x"], "b": 3 });
        let out = normalize_value(&value, &mut used);
        assert_eq!(out["a"][0], json!("<PATH>"));
        assert_eq!(out["b"], json!(3));
    }
}
