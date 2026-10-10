//! DSH 版本兼容判定（指标 G2）。
//!
//! ## 与 `src/fixtures/compat.ts` 的关系（阶段 2 的对拍契约）
//!
//! **真源**：`spec/contracts/versions.yaml` → `decision_logic.file = src/fixtures/compat.ts`。
//! 本模块是它的**薄移植**：去掉 JS 无关逻辑，只保留判定所需的语义，判据逐条对齐。
//!
//! - **与标准 semver 的唯一有意偏差照搬**：不做"预发布默认被排除"，
//!   直接按 semver 序比较（预发布 < 同版本正式版）。理由见 `compat.ts:8-17`——
//!   本仓夹具恰恰是给 RC 用的，按标准规则会把 RC 宿主判成不兼容。
//! - **解析失败绝不当作"满足"或"不满足"**：一律返回 [`VersionVerdict::Undecidable`]，
//!   对应 `compat.ts` 的 `{ ok: false, reason }`。两处调用方对"不可判定"的退回方向
//!   **相反**（`src/fixtures/apply.ts:146` 走 skip；`src/selection/by-version.ts:77` 走纳入），
//!   那是调用方的决定，本模块只如实给出三态。
//! - **对拍映射**（阶段 2 逐输入比对时必须成立）：
//!
//! | `compat.ts` 的 `VersionCheck` | 本模块 |
//! |---|---|
//! | `{ ok: true, satisfied: true }` | [`VersionVerdict::Compatible`] |
//! | `{ ok: true, satisfied: false }` | [`VersionVerdict::Incompatible`] |
//! | `{ ok: false, reason }` | [`VersionVerdict::Undecidable`] |
//!
//! - **语法集按 `versions.yaml` 的 `supported_syntax` 全量对齐**（见 [`SUPPORTED_RANGE_SYNTAX`]）。
//!   这是"两者结论必须一致"的前提：若只支持 `>=` 系，`^0.2.0` / `1.x` / `1.2.*` 会被本模块
//!   静默判成"不可判定"，而 `compat.ts` 会判"满足"——那就是一条**必然对拍失败**的静默降级。
//!
//! ## 闸门边界（不许越界）
//!
//! 版本不兼容**不经能力门控**（设计 §3.4 第 5 条：归退出码 `6`（协议）/ `3`（环境））；
//! 归 `7` 的只有"必需能力缺失"。所以本模块**不产生** [`crate::GateDecision`]，
//! 只把一个可归因的判定交给调用方。

use std::cmp::Ordering;
use std::fmt;

use serde::{Deserialize, Serialize};

/// 本仓**声明**支持的 DSH 版本清单（`spec/contracts/versions.yaml` 的 `declared_version_names`）。
///
/// 注意它是**声明**：该声明在旧实现 `src/` 里零消费者（`versions.yaml` 的
/// `declared_set.has_code_consumer = false`），B3 的分子只能靠夹具链机械复算。
pub const DECLARED_SUPPORTED_VERSIONS: [&str; 1] = ["0.2.0-rc.2"];

/// `compat.ts` 支持的范围语法（`versions.yaml` → `decision_logic.supported_syntax`，逐条照抄）。
pub const SUPPORTED_RANGE_SYNTAX: [&str; 14] = [
    ">=x.y.z",
    "<=x.y.z",
    ">x.y.z",
    "<x.y.z",
    "=x.y.z",
    "^x.y.z",
    "~x.y",
    "1.x",
    "1.2.*",
    "*",
    "x",
    "a - b",
    "||",
    "空格 AND",
];

/// 版本兼容判定三态。
///
/// 第三态 [`VersionVerdict::Undecidable`] 是**刻意**的：它让"看不懂的范围"无法被当成
/// "满足"或"不满足"混进结论（`compat.ts:17-18` 的纪律）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum VersionVerdict {
    /// 解析成功且满足范围。
    Compatible,
    /// 解析成功但不满足范围。
    Incompatible,
    /// 解析失败：**既不是满足，也不是不满足**，调用方必须自己决定退回策略。
    Undecidable {
        /// 不可判定的原因。
        reason: String,
    },
}

impl VersionVerdict {
    /// 是否判定为兼容（只有 [`VersionVerdict::Compatible`] 为真）。
    pub fn is_compatible(&self) -> bool {
        matches!(self, VersionVerdict::Compatible)
    }

    /// 是否得出了可归因结论（`Compatible` / `Incompatible` 为真，`Undecidable` 为假）。
    pub fn is_decidable(&self) -> bool {
        !matches!(self, VersionVerdict::Undecidable { .. })
    }
}

/// 预发布标识的一个片段：数字标识或字母标识。
///
/// 语义照搬 `compat.ts:79-94`：数字标识 < 字母标识；同名同型逐段比较。
#[derive(Debug, Clone, PartialEq, Eq)]
enum PreId {
    /// 纯数字标识。
    Num(u64),
    /// 含非数字字符的标识（含空串——`compat.ts` 的 `[0-9A-Za-z.-]+` 允许 `a..b`）。
    Alpha(String),
}

impl PreId {
    fn parse(part: &str) -> PreId {
        if !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(number) = part.parse::<u64>() {
                return PreId::Num(number);
            }
        }
        PreId::Alpha(part.to_string())
    }

    fn cmp_pre(a: &PreId, b: &PreId) -> Ordering {
        match (a, b) {
            (PreId::Num(x), PreId::Num(y)) => x.cmp(y),
            // 标识集是 ASCII（`[0-9A-Za-z.-]`），所以 Rust 的字节序与 JS 的码元序一致。
            (PreId::Alpha(x), PreId::Alpha(y)) => x.cmp(y),
            // 数字标识 < 字母标识
            (PreId::Num(_), PreId::Alpha(_)) => Ordering::Less,
            (PreId::Alpha(_), PreId::Num(_)) => Ordering::Greater,
        }
    }
}

/// 已解析的版本号（semver 的三段 + 预发布标识；构建元数据照 `compat.ts` 忽略）。
#[derive(Debug, Clone)]
pub struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    prerelease: Vec<PreId>,
}

impl Version {
    /// 主版本号。
    pub fn major(&self) -> u64 {
        self.major
    }

    /// 次版本号。
    pub fn minor(&self) -> u64 {
        self.minor
    }

    /// 修订号。
    pub fn patch(&self) -> u64 {
        self.patch
    }

    /// 是否为预发布版本。
    pub fn is_prerelease(&self) -> bool {
        !self.prerelease.is_empty()
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if !self.prerelease.is_empty() {
            let parts: Vec<String> = self
                .prerelease
                .iter()
                .map(|p| match p {
                    PreId::Num(n) => n.to_string(),
                    PreId::Alpha(s) => s.clone(),
                })
                .collect();
            write!(f, "-{}", parts.join("."))?;
        }
        Ok(())
    }
}

// 版本的相等 / 序**一律按 semver 序**（`1.2` 与 `1.2.0` 相等），不按原始字符串。
//
// 手写（而非 derive）是因为"相等"必须是 semver 序而不是字段逐一比对：
// `1.2` / `1.2.0` / `v1.2.0` / `1.2.0+build.7` 是**同一个**版本。
// `eq` / `partial_cmp` 一律委托给 `cmp`，即 `Ord`/`PartialOrd`/`Eq` 的规范形态
// （clippy `non_canonical_partial_ord_impl` 要求的写法）。这与旧写法**逐字等价**
// （旧写法两处都直接调 `compare_versions`），但"三者一致"从此是结构上成立的、
// 不靠人读；不变量另由 `version_order_is_a_consistent_total_order` 钉住。
//
// 为什么这不是纯风格问题、必须确认：本 crate 的判定路径全用 `BTreeMap`/`BTreeSet`，
// 若 `Ord` 与 `Eq`/`PartialOrd` 语义不一致，BTreeMap 的行为不可预测。实测结论：
// 一致（见该测试）。
impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Version {}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_versions(self, other)
    }
}

/// 解析一个版本号；不合法返回 `None`（**不静默兜底**）。
///
/// 语法照 `compat.ts:44` 的 `VERSION_RE`：可选的 `v` 前缀、1~3 段数字、
/// 可选预发布、可选构建元数据（忽略）。
pub fn parse_version(text: &str) -> Option<Version> {
    let raw = text.trim();
    let body = raw.strip_prefix('v').unwrap_or(raw);

    // 构建元数据：`+` 之后一律忽略，但字符集要合法（照 compat.ts 的正则）。
    let body = match body.split_once('+') {
        Some((before, build)) => {
            if build.is_empty() || !build.chars().all(is_identifier_char) {
                return None;
            }
            before
        }
        None => body,
    };

    let (core, prerelease) = match body.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (body, None),
    };

    let mut segments = core.split('.');
    let major = parse_number(segments.next()?)?;
    let minor = match segments.next() {
        Some(segment) => parse_number(segment)?,
        None => 0,
    };
    let patch = match segments.next() {
        Some(segment) => parse_number(segment)?,
        None => 0,
    };
    if segments.next().is_some() {
        return None;
    }

    let prerelease = match prerelease {
        Some(pre) => {
            if pre.is_empty() || !pre.chars().all(is_identifier_char) {
                return None;
            }
            pre.split('.').map(PreId::parse).collect()
        }
        None => Vec::new(),
    };

    Some(Version {
        major,
        minor,
        patch,
        prerelease,
    })
}

/// 按 semver 序比较两个已解析版本（`compat.ts:68` 的移植）。
///
/// `<` / `=` / `>` 分别表示 `a` 早于 / 等于 / 晚于 `b`。
pub fn compare_versions(a: &Version, b: &Version) -> Ordering {
    for (left, right) in [(a.major, b.major), (a.minor, b.minor), (a.patch, b.patch)] {
        match left.cmp(&right) {
            Ordering::Equal => {}
            other => return other,
        }
    }

    let (left, right) = (&a.prerelease, &b.prerelease);
    if left.is_empty() && right.is_empty() {
        return Ordering::Equal;
    }
    // 预发布 < 正式版
    if left.is_empty() {
        return Ordering::Greater;
    }
    if right.is_empty() {
        return Ordering::Less;
    }

    let length = left.len().max(right.len());
    for index in 0..length {
        match (left.get(index), right.get(index)) {
            (Some(x), Some(y)) => match PreId::cmp_pre(x, y) {
                Ordering::Equal => {}
                other => return other,
            },
            (Some(_), None) => return Ordering::Greater,
            (None, Some(_)) => return Ordering::Less,
            (None, None) => return Ordering::Equal,
        }
    }
    Ordering::Equal
}

/// 判定 `version` 是否落在 `range` 内（`compat.ts:276` 的移植）。
///
/// 任一环节解析失败 → [`VersionVerdict::Undecidable`]，**绝不**当满足或硬判不满足。
pub fn check_dsh_version(version: &str, range: &str) -> VersionVerdict {
    let Some(parsed) = parse_version(version) else {
        return VersionVerdict::Undecidable {
            reason: format!("DSH 版本无法解析：{version:?}"),
        };
    };
    let alternatives = match parse_range(range) {
        Ok(alternatives) => alternatives,
        Err(reason) => return VersionVerdict::Undecidable { reason },
    };
    let satisfied = alternatives.iter().any(|comparators| {
        comparators
            .iter()
            .all(|comparator| passes(comparator, &parsed))
    });
    if satisfied {
        VersionVerdict::Compatible
    } else {
        VersionVerdict::Incompatible
    }
}

/// 比较操作符（`^` / `~` 在解析期就展开成上下界，不会留在比较期）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
    Gt,
    Gte,
    Lt,
    Lte,
    Eq,
    Caret,
    Tilde,
}

/// 单个"操作符 + 版本"子句。
#[derive(Debug, Clone)]
struct Comparator {
    op: Op,
    version: Version,
}

fn make_version(major: u64, minor: u64, patch: u64) -> Version {
    Version {
        major,
        minor,
        patch,
        prerelease: Vec::new(),
    }
}

fn with_prerelease(base: &Version, prerelease: &[String]) -> Version {
    Version {
        major: base.major,
        minor: base.minor,
        patch: base.patch,
        prerelease: prerelease.iter().map(|p| PreId::parse(p)).collect(),
    }
}

fn is_identifier_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '-' || c == '.'
}

fn parse_number(text: &str) -> Option<u64> {
    if text.is_empty() || !text.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    text.parse::<u64>().ok()
}

/// 解析 `1.2` / `1.2.3-rc.1` 这类片段（`compat.ts:103` 的 `parsePartial`）。
fn parse_partial(text: &str) -> Option<(Vec<u64>, Vec<String>)> {
    let raw = text.trim();
    let body = raw.strip_prefix('v').unwrap_or(raw);
    let (core, prerelease) = match body.split_once('-') {
        Some((core, pre)) => (core, Some(pre.to_string())),
        None => (body, None),
    };

    let mut parts: Vec<u64> = Vec::new();
    for (index, segment) in core.split('.').enumerate() {
        if index >= 3 {
            return None;
        }
        parts.push(parse_number(segment)?);
    }
    if parts.is_empty() {
        return None;
    }

    let prerelease = match prerelease {
        Some(pre) => {
            if pre.is_empty() || !pre.chars().all(is_identifier_char) {
                return None;
            }
            pre.split('.').map(|part| part.to_string()).collect()
        }
        None => Vec::new(),
    };

    Some((parts, prerelease))
}

fn split_op(token: &str) -> (Option<Op>, &str) {
    const PREFIXES: [(&str, Op); 7] = [
        (">=", Op::Gte),
        ("<=", Op::Lte),
        (">", Op::Gt),
        ("<", Op::Lt),
        ("=", Op::Eq),
        ("^", Op::Caret),
        ("~", Op::Tilde),
    ];
    for (prefix, op) in PREFIXES {
        if let Some(rest) = token.strip_prefix(prefix) {
            return (Some(op), rest);
        }
    }
    (None, token)
}

/// 解析一段由单个"操作符 + 版本"组成的比较子句（`compat.ts:121` 的移植）。
fn parse_comparator(token: &str) -> Result<Vec<Comparator>, String> {
    let (op, rest) = split_op(token);
    let rest = rest.trim();
    if rest.is_empty() {
        return Err(format!("比较子句缺少版本号：{token}"));
    }

    // 通配只在**数字段**上认（先切掉预发布 / 构建元数据），
    // 否则 `1.0.0-abc.x` 这种预发布标识会被误判成通配。
    let numeric = rest.split(['-', '+']).next().unwrap_or("");

    if numeric == "*" || numeric == "x" || numeric == "X" {
        // 裸通配 = 任意版本。
        return Ok(vec![Comparator {
            op: Op::Gte,
            version: make_version(0, 0, 0),
        }]);
    }

    if numeric.chars().any(|c| c == 'x' || c == 'X' || c == '*') {
        let parts: Vec<&str> = numeric.split('.').collect();
        let index = parts
            .iter()
            .position(|part| *part == "*" || *part == "x" || *part == "X");
        let Some(index) = index else {
            return Err(format!("通配版本无法解析：{token}"));
        };
        if index >= 3 {
            return Err(format!("通配版本无法解析：{token}"));
        }
        let mut numbers: Vec<u64> = Vec::new();
        for part in &parts[..index] {
            match part.parse::<u64>() {
                Ok(number) => numbers.push(number),
                Err(_) => return Err(format!("通配版本无法解析：{token}")),
            }
        }
        let first = numbers.first().copied().unwrap_or(0);
        let second = numbers.get(1).copied().unwrap_or(0);
        let lower = make_version(first, second, 0);

        let range_op = match op {
            Some(Op::Gt) => Some(Op::Gt),
            Some(Op::Gte) => Some(Op::Gte),
            Some(Op::Lt) => Some(Op::Lt),
            Some(Op::Lte) => Some(Op::Lte),
            _ => None,
        };
        if let Some(mapped) = range_op {
            return Ok(vec![Comparator {
                op: mapped,
                version: lower,
            }]);
        }

        // 通配位决定上界：`1.x` → <2.0.0；`1.2.x` → <1.3.0
        let upper = if index <= 1 {
            make_version(first + 1, 0, 0)
        } else {
            make_version(first, second + 1, 0)
        };
        return Ok(vec![
            Comparator {
                op: Op::Gte,
                version: lower,
            },
            Comparator {
                op: Op::Lt,
                version: upper,
            },
        ]);
    }

    let (parts, prerelease) =
        parse_partial(rest).ok_or_else(|| format!("版本号无法解析：{rest}"))?;
    let major = *parts.first().unwrap_or(&0);
    let minor = *parts.get(1).unwrap_or(&0);
    let patch = *parts.get(2).unwrap_or(&0);
    let base = make_version(major, minor, patch);
    let version = with_prerelease(&base, &prerelease);

    let comparators = match op {
        Some(Op::Gt) => vec![Comparator {
            op: Op::Gt,
            version,
        }],
        Some(Op::Gte) => vec![Comparator {
            op: Op::Gte,
            version,
        }],
        Some(Op::Lt) => vec![Comparator {
            op: Op::Lt,
            version,
        }],
        Some(Op::Lte) => vec![Comparator {
            op: Op::Lte,
            version,
        }],
        Some(Op::Eq) => vec![Comparator {
            op: Op::Eq,
            version,
        }],
        Some(Op::Caret) => {
            let upper = if major > 0 {
                make_version(major + 1, 0, 0)
            } else if minor > 0 {
                make_version(0, minor + 1, 0)
            } else {
                make_version(0, 0, patch + 1)
            };
            vec![
                Comparator {
                    op: Op::Gte,
                    version,
                },
                Comparator {
                    op: Op::Lt,
                    version: upper,
                },
            ]
        }
        Some(Op::Tilde) => {
            let upper = if parts.len() >= 2 {
                make_version(major, minor + 1, 0)
            } else {
                make_version(major + 1, 0, 0)
            };
            vec![
                Comparator {
                    op: Op::Gte,
                    version,
                },
                Comparator {
                    op: Op::Lt,
                    version: upper,
                },
            ]
        }
        None => {
            // 裸版本：写满三段 = 精确匹配；只写 1~2 段 = npm 的"范围"语义。
            if parts.len() >= 3 {
                vec![Comparator {
                    op: Op::Eq,
                    version,
                }]
            } else {
                let upper = if parts.len() == 2 {
                    make_version(major, minor + 1, 0)
                } else {
                    make_version(major + 1, 0, 0)
                };
                vec![
                    Comparator {
                        op: Op::Gte,
                        version,
                    },
                    Comparator {
                        op: Op::Lt,
                        version: upper,
                    },
                ]
            }
        }
    };
    Ok(comparators)
}

/// 解析版本范围：空格 = AND，`||` = OR，`a - b` = 区间（`compat.ts:215` 的移植）。
fn parse_range(range: &str) -> Result<Vec<Vec<Comparator>>, String> {
    let text = range.trim();
    if text.is_empty() {
        return Err("版本范围为空".to_string());
    }

    let mut alternatives: Vec<Vec<Comparator>> = Vec::new();
    for raw_alternative in text.split("||") {
        let alternative = raw_alternative.trim();
        if alternative.is_empty() {
            return Err(format!("范围里有空的 || 分支：{range}"));
        }

        let tokens: Vec<&str> = alternative.split_whitespace().collect();
        if tokens.len() == 3 && tokens[1] == "-" {
            let from = parse_version(tokens[0])
                .ok_or_else(|| format!("区间端点无法解析：{alternative}"))?;
            let to = parse_version(tokens[2])
                .ok_or_else(|| format!("区间端点无法解析：{alternative}"))?;
            alternatives.push(vec![
                Comparator {
                    op: Op::Gte,
                    version: from,
                },
                Comparator {
                    op: Op::Lte,
                    version: to,
                },
            ]);
            continue;
        }

        if tokens.is_empty() {
            return Err(format!("范围分支为空：{range}"));
        }
        let mut comparators: Vec<Comparator> = Vec::new();
        for token in tokens {
            comparators.extend(parse_comparator(token)?);
        }
        alternatives.push(comparators);
    }
    Ok(alternatives)
}

fn passes(comparator: &Comparator, version: &Version) -> bool {
    let ordering = compare_versions(version, &comparator.version);
    match comparator.op {
        Op::Gt => ordering == Ordering::Greater,
        Op::Gte => ordering != Ordering::Less,
        Op::Lt => ordering == Ordering::Less,
        Op::Lte => ordering != Ordering::Greater,
        Op::Eq => ordering == Ordering::Equal,
        // `^` / `~` 在解析期已展开成 Gte + Lt，永远到不了比较期。
        Op::Caret | Op::Tilde => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn verdict(version: &str, range: &str) -> VersionVerdict {
        check_dsh_version(version, range)
    }

    #[test]
    fn declared_range_accepts_rc_host_without_prerelease_exclusion() {
        // 这是与标准 semver 的唯一有意偏差：不做"预发布默认被排除"。
        assert_eq!(
            verdict("0.2.0-rc.2", ">=0.2.0-rc.2"),
            VersionVerdict::Compatible
        );
        assert_eq!(verdict("0.2.0", ">=0.2.0-rc.2"), VersionVerdict::Compatible);
        assert_eq!(
            verdict("0.2.0-rc.1", ">=0.2.0-rc.2"),
            VersionVerdict::Incompatible
        );
        // 标准 semver 会把 0.3.0-rc.1 判成不满足 `>=0.2.0`；本实现照 compat.ts 判满足。
        assert_eq!(verdict("0.3.0-rc.1", ">=0.2.0"), VersionVerdict::Compatible);
    }

    #[test]
    fn unparseable_input_is_undecidable_never_compatible() {
        for (version, range) in [
            ("not-a-version", ">=0.2.0"),
            ("0.2.0", "garbage range"),
            ("0.2.0", ""),
            ("0.2.0", ">="),
            ("", ">=0.2.0"),
            ("1.0.0-", "*"),
        ] {
            let result = verdict(version, range);
            assert!(
                matches!(result, VersionVerdict::Undecidable { .. }),
                "{version} / {range} 必须不可判定，实际 {result:?}"
            );
            assert!(!result.is_compatible());
            assert!(!result.is_decidable());
        }
    }

    #[test]
    fn wildcard_quirk_is_preserved_for_parity() {
        // `*` 展开成 `>=0.0.0`，而预发布 < 同版本正式版 ⇒ 预发布宿主**不**满足 `*`。
        // 这是 compat.ts 的既有行为（不是本模块的 bug），阶段 2 对拍必须一致。
        assert_eq!(verdict("1.2.3", "*"), VersionVerdict::Compatible);
        assert_eq!(verdict("0.0.0-rc.1", "*"), VersionVerdict::Incompatible);
    }

    #[test]
    fn version_ordering_ignores_trailing_zero_segments() {
        assert_eq!(parse_version("1.2"), parse_version("1.2.0"));
        assert!(
            parse_version("1.2.0-rc.1").expect("可解析") < parse_version("1.2.0").expect("可解析")
        );
    }

    /// `Ord` / `PartialOrd` / `Eq` 三个语义必须彼此一致。
    ///
    /// 这条是 clippy `non_canonical_partial_ord_impl` 触发后**先做语义核对**的机器化结论：
    /// 本 crate 的判定路径全用 `BTreeMap` / `BTreeSet`，若 `Ord` 与 `Eq`/`PartialOrd`
    /// 不一致，容器行为不可预测。核对结果：一致（旧写法与规范写法逐字等价）。
    #[test]
    fn version_order_is_a_consistent_total_order() {
        let samples = [
            "0.2.0-rc.1",
            "0.2.0-rc.2",
            "0.2.0",
            "0.2.1",
            "0.3.0-rc.1",
            "1.0.0-1",
            "1.0.0-alpha",
            "1.0.0",
            "1.2",
        ];
        let parsed: Vec<Version> = samples
            .iter()
            .map(|text| parse_version(text).expect("样例必须可解析"))
            .collect();

        for a in &parsed {
            for b in &parsed {
                // ① `PartialOrd` 必须与 `Ord` 逐点一致（不是"方向大致相同"）。
                assert_eq!(
                    a.partial_cmp(b),
                    Some(a.cmp(b)),
                    "partial_cmp 与 cmp 不一致：{a} vs {b}"
                );
                // ② `Eq` 必须等价于"序相等"。
                assert_eq!(
                    a == b,
                    a.cmp(b) == Ordering::Equal,
                    "Eq 与 cmp 不一致：{a} vs {b}"
                );
                // ③ 反对称。
                assert_eq!(a.cmp(b), b.cmp(a).reverse(), "序不反对称：{a} vs {b}");
                // ④ 三歧性（总序：`<` / `==` / `>` 恰有一个成立）。
                assert_eq!(
                    (a < b) as u8 + (a == b) as u8 + (a > b) as u8,
                    1,
                    "三歧性被破坏：{a} vs {b}"
                );
            }
        }

        // ⑤ 传递性（对全部三元组穷举）。
        for a in &parsed {
            for b in &parsed {
                for c in &parsed {
                    if a <= b && b <= c {
                        assert!(a <= c, "传递性被破坏：{a} <= {b} <= {c}");
                    }
                }
            }
        }

        // ⑥ 与真正用到序的容器一致：semver 相等的写法必须塌成同一个键。
        let set: std::collections::BTreeSet<Version> = ["1.2", "1.2.0", "v1.2.0", "1.2.0+build.7"]
            .iter()
            .map(|text| parse_version(text).expect("样例必须可解析"))
            .collect();
        assert_eq!(
            set.len(),
            1,
            "BTreeSet 必须把 semver 相等的四种写法当成同一个键，实际 {set:?}"
        );
    }
}
