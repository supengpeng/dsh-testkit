//! 等价关系表的装载（**行扫描**，不引入 YAML 依赖）。
//!
//! 为什么手写扫描而不是解析 YAML：本仓的依赖纪律是"新增依赖先申请"
//! （RFC 0001 §7 停止线 5），而需要的只是 `spec/contracts/reconcile-fields.yaml` 里
//! **机器生成、格式固定**的 `fields:` 段。扫描器的判别力由 `tests/table_driven.rs`
//! 与 `tests/a3_closure.rs` 共同守着：
//! - 若它少读一条 ⇒ A3 求差会报"schema 叶子没有处置"；
//! - 若它多读一条 ⇒ A3 求差会报"声明了但 schema 里没有"。
//!   两边夹住，扫描器不可静默退化。

use std::collections::{BTreeMap, BTreeSet};

use crate::Equivalence;

/// 表在仓库里的相对路径（测试与调用方共用，避免两处硬编码漂移）。
pub const TABLE_PATH_IN_REPO: &str = "spec/contracts/reconcile-fields.yaml";

/// 开放子树的**固定键集**（`reconcile-fields.yaml` 的 `meta.open_subtree_discipline`）。
///
/// 16 个键 = `ref` + 14 个求值词（`src/runtime/assert.ts:22-37` 的 `ASSERTION_KEYS`）+ `soft`。
/// 运行时出现其它键时：写进 `uncompared_fields`（归 `unknown`），**不**判结构不等价。
pub const OPEN_ASSERTION_KEYS: [&str; 16] = [
    "ref",
    "is",
    "isNot",
    "notIs",
    "exists",
    "notExists",
    "contains",
    "notContains",
    "matches",
    "atLeast",
    "atMost",
    "length",
    "lengthAtLeast",
    "lengthAtMost",
    "throws",
    "soft",
];

/// 表的四个开放子树（`meta.open_subtrees`）。
pub fn open_subtrees() -> Vec<&'static str> {
    vec![
        "cases[].steps[].assertions[].assertion",
        "cases[].steps[].notes",
        "cases[].notes",
        "policySnapshot.sandbox",
    ]
}

/// 字段的处置（A3 的三值口径）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Disposition {
    /// 有处置且要逐字段比对。
    Compared,
    /// 显式不比（仍计入 A3 分子，但必须出现在 `uncompared_fields` 里）。
    DeclaredNotCompared,
    /// 表里没有这个字段（A3 缺口）。
    Undeclared,
}

impl Disposition {
    /// 表里的写法。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Compared => "compared",
            Self::DeclaredNotCompared => "declared-not-compared",
            Self::Undeclared => "undeclared",
        }
    }

    /// 解析；未知取值返回 `None`（不猜）。
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "compared" => Some(Self::Compared),
            "declared-not-compared" => Some(Self::DeclaredNotCompared),
            "undeclared" => Some(Self::Undeclared),
            _ => None,
        }
    }

    /// 是否计入 A3 分子（`disposition !== undeclared`）。
    pub fn counts_toward_a3(self) -> bool {
        !matches!(self, Self::Undeclared)
    }
}

/// 表里的一条字段声明。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileEntry {
    /// 字段路径（schema 叶子口径，数组用 `[]`）。
    pub path: String,
    /// 等价关系。
    pub equivalence: Equivalence,
    /// 处置。
    pub disposition: Disposition,
}

/// 装载后的等价关系表。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReconcileTable {
    /// 路径 → 声明（`BTreeMap`：路径有序，保证差异清单顺序可复现）。
    pub entries: BTreeMap<String, ReconcileEntry>,
    /// `meta.not_compared_allowlist`（只允许这些路径声明为 not-compared）。
    pub allowlist: BTreeSet<String>,
    /// `meta.open_subtrees`。
    pub open_subtrees: Vec<String>,
}

impl ReconcileTable {
    /// 取一条声明。
    pub fn entry(&self, path: &str) -> Option<&ReconcileEntry> {
        self.entries.get(path)
    }

    /// 表里声明的全部路径（有序）。
    pub fn declared_paths(&self) -> BTreeSet<&str> {
        self.entries.keys().map(String::as_str).collect()
    }

    /// 声明为"显式不比"的路径（有序）。
    pub fn not_compared_paths(&self) -> BTreeSet<&str> {
        self.entries
            .values()
            .filter(|entry| entry.disposition == Disposition::DeclaredNotCompared)
            .map(|entry| entry.path.as_str())
            .collect()
    }

    /// 自检：任何 `not-compared` 都必须在 allowlist 上（`meta.set_distinction` 的反刷分闸门）。
    ///
    /// 返回不在清单上的路径（空 = 通过）。
    pub fn allowlist_violations(&self) -> BTreeSet<String> {
        self.entries
            .values()
            .filter(|entry| entry.disposition == Disposition::DeclaredNotCompared)
            .map(|entry| entry.path.clone())
            .filter(|path| !self.allowlist.contains(path))
            .collect()
    }
}

/// 行首缩进宽度（空格数）。
fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

/// 从 `reconcile-fields.yaml` 的文本装载等价关系表。
///
/// **只读两个段**：`meta.not_compared_allowlist` / `meta.open_subtrees` 与 `fields:`。
/// 其余内容（注释、readouts、rulings）一律跳过——表是生成物，本函数不解释叙述性文字。
pub fn parse_reconcile_table(text: &str) -> ReconcileTable {
    let mut table = ReconcileTable::default();
    let mut state = 0u8; // 0=其它 1=allowlist 2=open_subtrees 3=fields
    let mut current: Option<ReconcileEntry> = None;

    for raw in text.lines() {
        let line = raw.trim_end();
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let indent = indent_of(line);

        if indent == 0 && trimmed.ends_with(':') {
            if let Some(entry) = current.take() {
                table.entries.insert(entry.path.clone(), entry);
            }
            state = match trimmed {
                "fields:" => 3,
                "meta:" => 0,
                _ => 0,
            };
            continue;
        }
        if indent == 2 && trimmed.ends_with(':') {
            state = match trimmed {
                "not_compared_allowlist:" => 1,
                "open_subtrees:" => 2,
                _ => 0,
            };
            continue;
        }

        match state {
            1 => {
                if let Some(path) = trimmed.strip_prefix("- path:") {
                    table.allowlist.insert(path.trim().to_string());
                }
            }
            2 => {
                if let Some(path) = trimmed.strip_prefix("- ") {
                    let path = path.trim();
                    if !path.is_empty() {
                        table.open_subtrees.push(path.to_string());
                    }
                }
            }
            3 => {
                if let Some(path) = trimmed.strip_prefix("- path:") {
                    if let Some(entry) = current.take() {
                        table.entries.insert(entry.path.clone(), entry);
                    }
                    current = Some(ReconcileEntry {
                        path: path.trim().to_string(),
                        equivalence: Equivalence::Exact,
                        disposition: Disposition::Compared,
                    });
                    continue;
                }
                if let Some(entry) = current.as_mut() {
                    if let Some(value) = trimmed.strip_prefix("equivalence:") {
                        if let Some(parsed) = Equivalence::parse(value) {
                            entry.equivalence = parsed;
                        }
                    } else if let Some(value) = trimmed.strip_prefix("disposition:") {
                        if let Some(parsed) = Disposition::parse(value) {
                            entry.disposition = parsed;
                        }
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(entry) = current.take() {
        table.entries.insert(entry.path.clone(), entry);
    }
    if table.open_subtrees.is_empty() {
        table.open_subtrees = open_subtrees().iter().map(|s| (*s).to_string()).collect();
    }
    table
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
meta:
  not_compared_allowlist:
    - path: cases[].usage.tokens
      reason: 只比下界
  open_subtrees:
    - cases[].steps[].assertions[].assertion
    - cases[].notes
fields:
  - path: runId
    schema_type: string
    equivalence: normalized
    declared: true
    disposition: compared
  - path: cases[].usage.tokens
    schema_type: number
    equivalence: not-compared
    declared: true
    disposition: declared-not-compared
"#;

    #[test]
    fn parses_fields_and_metadata() {
        let table = parse_reconcile_table(SAMPLE);
        assert_eq!(table.entries.len(), 2);
        assert_eq!(
            table.entry("runId").map(|e| e.equivalence),
            Some(Equivalence::Normalized)
        );
        assert_eq!(
            table.entry("cases[].usage.tokens").map(|e| e.disposition),
            Some(Disposition::DeclaredNotCompared)
        );
        assert!(table.allowlist.contains("cases[].usage.tokens"));
        assert!(table.open_subtrees.iter().any(|s| s.contains("assertion")));
        assert!(table.allowlist_violations().is_empty());
    }

    #[test]
    fn not_compared_outside_allowlist_is_a_violation() {
        let mut table = parse_reconcile_table(SAMPLE);
        table.entries.remove("cases[].usage.tokens");
        // 造一条"声明为不比但不在清单上"的条目：反刷分闸门必须抓住它。
        let mut rogue = table.entries.clone();
        rogue.insert(
            "cases[].verdict".into(),
            ReconcileEntry {
                path: "cases[].verdict".into(),
                equivalence: Equivalence::NotCompared,
                disposition: Disposition::DeclaredNotCompared,
            },
        );
        table.entries = rogue;
        let violations = table.allowlist_violations();
        assert!(violations.contains("cases[].verdict"));
    }

    #[test]
    fn open_assertion_key_set_is_exactly_sixteen() {
        assert_eq!(OPEN_ASSERTION_KEYS.len(), 16);
        let unique: BTreeSet<&str> = OPEN_ASSERTION_KEYS.iter().copied().collect();
        assert_eq!(unique.len(), 16, "16 个键必须互不相同");
    }

    #[test]
    fn disposition_counts_toward_a3_except_undeclared() {
        assert!(Disposition::Compared.counts_toward_a3());
        assert!(Disposition::DeclaredNotCompared.counts_toward_a3());
        assert!(!Disposition::Undeclared.counts_toward_a3());
        assert_eq!(Disposition::parse("nope"), None);
    }
}
