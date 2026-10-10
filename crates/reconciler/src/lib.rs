//! `reconciler` —— 表驱动对拍器。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.6（`Reconciler`）与 §9.3（逐字段等价关系表）；
//! 表本身在 `spec/contracts/reconcile-fields.yaml`（A3 的分子/分母）。
//!
//! **取代"逐字节对拍"**：归一化之后就不是逐字节。正确表述是**逐字段声明等价关系**，
//! 并且**"哪些字段没比"必须可见**。
//!
//! # 三条纪律（设计 §9.3）
//! 1. 等价关系表未列出的字段 ⇒ **不比对**，但必须进入 [`ReconciliationReport::uncompared_fields`]
//!    并出现在报告里。**"没比"必须可见**，否则对拍器的盲区就是重构的盲区。
//! 2. 归一化规则本身要有反向测试：注入已知差异，验证归一化**没有**把它掩盖（指标 A5）。
//!    见 `tests/a5_negative.rs`——它同时给出"归一化过度会把真实差异掩盖掉"的负向证明。
//! 3. 浮点容差 `1e-9` 与"同平台"是**绑定**的：跨平台对拍时容差需重新论证。
//!
//! # 表驱动（而不是把规则写死在 if 里）
//! [`ReconcileTable`] 由 [`parse_reconcile_table`] 从 `reconcile-fields.yaml` 的 `fields:` 段
//! 解析而来（**行扫描**，不引入 YAML 依赖——见该函数文档）。判定路径上只用
//! `BTreeMap` / `BTreeSet`（设计 §6.4），保证"差异清单的顺序"可复现。
//!
//! # 开放子树纪律（`reconcile-fields.yaml` 的 `meta.open_subtree_discipline`）
//! `cases[].steps[].assertions[].assertion` 是**开放**子树：固定键集 16
//! （`ref` + 14 求值词 + `soft`），未知键进 `uncompared_fields` 且归 `unknown`；
//! **不得**因未知键把整条断言判成"结构不等价"。见 [`OPEN_ASSERTION_KEYS`] 与
//! [`compare_reports`] 的 `collect_unknown_assertion_keys`。
//!
//! # 三个指标的口径（A1 / A2 / A3）——**分母不同，不要混**
//!
//! | 指标 | 问题 | 分母 | 读数口 |
//! |---|---|---|---|
//! | **A1** | 新旧两次运行**是否等价** | —（无分母） | [`ReconciliationReport::is_clean`]：`mismatches` 为空 |
//! | **A2** | **该比的**字段有没有真的比 | **只算** `disposition = compared` 的字段 | [`ReconciliationReport::compared_count`] |
//! | **A3** | schema 的字段**有没有被处置** | **全部** schema 叶子（含 `not-compared`） | `tests/a3_closure.rs`（叶子 ↔ 声明双向求差） |
//!
//! **关键区别**：`cases[].usage.tokens`（"有值但不可信"）与 `cases[].trace[]`
//! （"有内容但不该比"）是**有意排除**——它们进 A3 分母、**不进 A2 分母**。
//! **"有意排除"不等于"漏比"**：若把 A2 写成 `78/80`，后来者会以为覆盖率只有 97.5%，
//! 然后为了"补齐"去动一个**故意不比**的字段——那是在修一个不存在的 bug。

#![forbid(unsafe_code)]
#![deny(missing_docs)]
#![deny(clippy::disallowed_types)]

mod compare;
mod normalize;
mod schema;
mod table;

pub use compare::{compare_reports, ReconcileOptions, STAGE1_SCHEMA_ADDITIONS};
pub use normalize::{normalize_str, normalize_value, NormalizationRule};
pub use schema::{enumerate_schema_leaves, schema_leaf_paths, SchemaLeaf};
pub use table::{
    open_subtrees, parse_reconcile_table, Disposition, ReconcileEntry, ReconcileTable,
    OPEN_ASSERTION_KEYS, TABLE_PATH_IN_REPO,
};

use std::collections::BTreeMap;

/// 单个字段的等价关系（设计 §9.3 的六种规则）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Equivalence {
    /// 精确相等。
    Exact,
    /// 归一化后相等（路径 → `<TMP>`、版本号 → `<VER>`、栈帧地址去除）。
    Normalized,
    /// 落在声明的 `[min, max]` 区间内。
    Range,
    /// 排序后按元素比对。
    SetSorted,
    /// 只比下界（记账值"不猜"）。
    LowerBound,
    /// **显式不比**。它与"未声明"不同：
    /// 前者是"声明了处置，处置就是不比"（进 `uncompared_fields`，仍计入 A3 分子）；
    /// 后者是"表里根本没有这个字段"（A3 缺口）。
    NotCompared,
}

impl Equivalence {
    /// 表里的写法（`reconcile-fields.yaml` 的 `equivalence:` 取值）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Exact => "exact",
            Self::Normalized => "normalized",
            Self::Range => "range",
            Self::SetSorted => "set-sorted",
            Self::LowerBound => "lower-bound",
            Self::NotCompared => "not-compared",
        }
    }

    /// 从表里的写法解析；未知取值返回 `None`（**不猜**）。
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim() {
            "exact" => Some(Self::Exact),
            "normalized" => Some(Self::Normalized),
            "range" => Some(Self::Range),
            "set-sorted" => Some(Self::SetSorted),
            "lower-bound" => Some(Self::LowerBound),
            "not-compared" => Some(Self::NotCompared),
            _ => None,
        }
    }
}

/// 一次比对的字段结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldMatch {
    /// 字段路径（以 `run-report.schema.json` 的叶子路径为准）。
    pub path: String,
    /// 本次使用的等价关系。
    pub equivalence: Equivalence,
}

/// 一处差异。**每条必须带 `case_id` + 字段路径 + 用到的等价关系**——
/// 只报"两条断言结果不同"无法定位，而 A1 的 100% 门槛要求能点名到具体 case。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldMismatch {
    /// 该实例路径所属的 case id（无法归属时为 `-`）。
    pub case_id: String,
    /// 实例路径（数组下标已展开，如 `cases[0].verdict`）。
    pub path: String,
    /// 本次使用的等价关系。
    pub equivalence: Equivalence,
    /// 旧实现的取值（可读形态）。
    pub expected: String,
    /// 新实现的取值（可读形态）。
    pub actual: String,
}

impl FieldMismatch {
    /// 从实例路径里抽出 case id（`cases[i].…` → 首个 `cases[i]`；抽不到返回 `-`）。
    pub fn case_id_of(path: &str) -> String {
        let rest = match path.strip_prefix("cases[") {
            Some(rest) => rest,
            None => return "-".to_string(),
        };
        match rest.split_once(']') {
            Some((index, _)) => format!("cases[{index}]"),
            None => "-".to_string(),
        }
    }
}

/// 对拍报告。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReconciliationReport {
    /// 逐字段的比对结果（按路径有序）。
    pub matches: Vec<FieldMatch>,
    /// 差异清单（按路径有序；顺序可复现，判定路径不用 `HashMap`）。
    pub mismatches: Vec<FieldMismatch>,
    /// 本次用到的归一化规则（可审计）。
    pub normalized_fields: Vec<String>,
    /// **未比对的字段路径**。"没比什么"和"比了什么"同等重要（设计 §9.3 纪律 1）。
    pub uncompared_fields: Vec<String>,
    /// 表里**没有**处置、运行期却冒出来的字段（A3 缺口；设计与 `uncompared_fields` 分开）。
    pub undeclared_fields: Vec<String>,
}

impl ReconciliationReport {
    /// **A1 的机器判定**：新旧两次运行是否等价。
    ///
    /// **注意**：`uncompared_fields` 非空**不**让报告变脏——"没比"是声明过的处置，
    /// 不是差异。它必须被看见，但不应把一次对拍判成失败。
    pub fn is_clean(&self) -> bool {
        self.mismatches.is_empty()
    }

    /// **A2 的分子**：本次实际尝试比对的字段数 = `matches + mismatches`。
    ///
    /// **"比了但不等"也是"比过"**——只数 `matches` 会把"检出差异"错算成"没比"，
    /// 于是差异越多、A2 越低，正好把指标的意义弄反。
    ///
    /// 分母是 `reconcile-fields.yaml` 里 `disposition = compared` 的字段数
    /// （**不含** `not-compared`；见模块文档的 A1/A2/A3 口径表）。
    /// 对账测试见 `tests/a2_coverage.rs`。
    pub fn compared_count(&self) -> usize {
        self.matches.len() + self.mismatches.len()
    }

    /// 逐字段读数的汇总（给人看的单行）。
    pub fn summary_line(&self) -> String {
        format!(
            "比对 {} 字段：一致 {}，差异 {}；未比对 {}，未声明 {}；归一化规则 {}",
            self.matches.len() + self.mismatches.len(),
            self.matches.len(),
            self.mismatches.len(),
            self.uncompared_fields.len(),
            self.undeclared_fields.len(),
            self.normalized_fields.len()
        )
    }

    /// 未比对字段按（实例路径 → 原因）列出，供报告渲染。
    pub fn uncompared_by_path(&self) -> BTreeMap<&str, &'static str> {
        self.uncompared_fields
            .iter()
            .map(|path| (path.as_str(), "declared-not-compared"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_compared_is_a_declaration_not_an_omission() {
        // 这条测试钉住设计 §9.3 纪律 1 的要害：
        // "显式不比"必须留下痕迹（进 uncompared_fields），否则对拍器的盲区就是重构的盲区。
        let mut r = ReconciliationReport::default();
        r.uncompared_fields.push("cases[].usage.tokens".into());
        assert!(r.is_clean());
        assert_eq!(r.uncompared_fields.len(), 1);
    }

    #[test]
    fn any_mismatch_makes_report_dirty() {
        let mut r = ReconciliationReport::default();
        r.mismatches.push(FieldMismatch {
            case_id: "cases[0]".into(),
            path: "cases[0].verdict".into(),
            equivalence: Equivalence::Exact,
            expected: "passed".into(),
            actual: "failed".into(),
        });
        assert!(!r.is_clean());
    }

    #[test]
    fn equivalence_round_trips_and_rejects_unknown() {
        for value in [
            Equivalence::Exact,
            Equivalence::Normalized,
            Equivalence::Range,
            Equivalence::SetSorted,
            Equivalence::LowerBound,
            Equivalence::NotCompared,
        ] {
            assert_eq!(Equivalence::parse(value.as_str()), Some(value));
        }
        assert_eq!(Equivalence::parse("almost-equal"), None);
    }

    #[test]
    fn case_id_is_extracted_from_instance_path() {
        assert_eq!(
            FieldMismatch::case_id_of("cases[2].steps[1].name"),
            "cases[2]"
        );
        assert_eq!(FieldMismatch::case_id_of("totals.total"), "-");
    }
}
