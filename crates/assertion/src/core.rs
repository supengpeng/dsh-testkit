//! 判定核心：四态结果与判定原语。
//!
//! 本模块是"判定移出 TS"（RFC 0001 决定 1）的最底层，只处理**判定语义本身**：
//! 深比较、类型名、长度提取、四态结果。
//!
//! **设计约束（`docs/REWRITE-DESIGN.md` §3.1 / §6.4）**：
//!
//! - 断言失败是**正常结果**（[`AssertionOutcome::Failed`]），**不是** `Result::Err`。
//!   `Result` 只留给"工具坏了"（例如注册重名，见 [`crate::AssertionError`]）。
//! - 判定路径**禁止** `std::collections::HashMap` / `HashSet`（§6.4 硬纪律）：
//!   它们用随机种子（`RandomState`），迭代顺序每次运行都不同，会让"同种子同结果"
//!   （指标 C1）当场失效。本 crate 一律用 `BTreeMap` / `BTreeSet` / `Vec`。
//! - **无 `unsafe`**、无全局可变状态。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 断言结果**四态**（设计 §3.3）。
///
/// 与既有 TS 实现的差异必须记清（阶段 0 实测结论，见 `spec/behaviors/engine/assert.md`）：
/// 既有实现只有 `ok: boolean` **两态**；`Skipped` 在旧实现里是**场景级**（`SkipCase`）
/// 而**断言级不存在**；`Inconclusive` 在 `src/**` 与 `tests/**` **零命中**，是本设计新引入的。
///
/// **字段说明（阶段 1 增量，理由是报告要能自证）**：
///
/// - 四个分支都带 `soft`：软断言（`soft: true`）在旧实现里是 `runner` 侧另挂的布尔
///   （`runner.ts:741` 的 `AssertionOutcome.soft`），判定层原来**看不见**它。判定层必须
///   保留它，否则 `hasHardFailure`（`runner.ts:578-579`：`!ok && !soft`）无法在 Rust 侧复算。
/// - `Failed` / `Skipped` / `Inconclusive` 带 `literal`：失败消息要用**词自己的字面量**
///   （`期望 is 1，实际 "1"` 里的 `1`），而 `expected` 是 `serde_json::Value`，从它反推
///   字面量会随类型变化（`1` 与 `1.0`）。这里显式保留判定词原文，让报告与人读的措辞一致。
/// - `Failed` / `Inconclusive` 带 `actual_absent`：ref 指向**不存在的键**时值为
///   `Value::Null`，与"显式记了 `null`"在 JSON 里无法区分（见 [`crate::refs::RefResolution`]）。
///   `exists` / `isNot null` 需要这个区分，所以显式携带。
///
/// **不变量**（由本 crate 内部保证，机械可测）：任何构造出来的结果里
/// `counts_as_passed()` 与 `counts_as_failed()` **不会同时为真**，`Inconclusive` 二者都不为真。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum AssertionOutcome {
    /// 判定通过。
    Passed {
        /// 可选取证细节（进入报告的 `actual` 侧）。
        details: Option<Value>,
        /// 是否为软断言（`soft: true`，失败不改变 case verdict）。
        soft: bool,
    },
    /// 判定失败。`expected` / `actual` / `diff` 都要保留，因为报告要能自证差异。
    Failed {
        /// 期望值的 JSON 形态。
        expected: Value,
        /// 实际取到的值；`actual_absent` 为真时它是 `Value::Null`（对拍按类型）。
        actual: Value,
        /// ref 指向的键**不存在**（而不是存在且为 `null`）。
        actual_absent: bool,
        /// 判定词的期望字面量原文（人类可读消息的一部分）。
        literal: String,
        /// 人类可读的差异说明。
        diff: String,
        /// 是否为软断言（`soft: true`）。
        soft: bool,
    },
    /// 断言级跳过（与场景级 `SkipCase` 不同）。
    Skipped {
        /// 跳过原因，必须说明可归因的事实（例如"宿主不提供该能力"）。
        reason: String,
        /// 是否为软断言（`soft: true`）。
        soft: bool,
    },
    /// 非确定性导致**无法判定**（例如跨平台浮点差异超过容差且不可归因）。
    ///
    /// 它**不计入 passed**，也**不计入 failed**，但：
    /// - 必须计入报告的 `inconclusive` 计数；
    /// - 在 `freeze` / `release` 档下**视为失败**；在 `generic` 档下计为 warning（设计 §8.4 硬约束 3）；
    /// - **同一场景、同一判据连续 3 次 `Inconclusive` → 升级为失败**（设计 §8.4 硬约束 3b）。
    ///   偶发是正常表现；连续 3 次说明**判据本身有缺陷**，不允许它当永久挡箭牌。
    Inconclusive {
        /// 无法判定的原因。**必须**说明可归因的事实，不允许写"未知"。
        reason: String,
        /// 判定词的期望字面量原文。
        literal: String,
        /// 实际取到的值。
        actual: Value,
        /// ref 指向的键不存在。
        actual_absent: bool,
        /// 是否为软断言（`soft: true`）。
        soft: bool,
    },
}

impl AssertionOutcome {
    /// 是否计入 `passed`。
    pub fn counts_as_passed(&self) -> bool {
        matches!(self, Self::Passed { .. })
    }

    /// 是否计入 `failed`。注意 `Inconclusive` 不算 failed——它是独立的第三类计数。
    pub fn counts_as_failed(&self) -> bool {
        matches!(self, Self::Failed { .. })
    }

    /// 是否计入 `skipped`（断言级）。
    pub fn counts_as_skipped(&self) -> bool {
        matches!(self, Self::Skipped { .. })
    }

    /// 是否计入 `inconclusive`（第四类计数，设计 §3.3 要求报告里必须有它）。
    pub fn counts_as_inconclusive(&self) -> bool {
        matches!(self, Self::Inconclusive { .. })
    }

    /// 这条结果是否**改变 case verdict**。
    ///
    /// 复算 `runner.ts:578-579` 的 `hasHardFailure`（`!ok && !soft`）的等价物：
    /// 只有**硬失败**才改变 verdict；软失败、断言级 skip、`Inconclusive` 都不改变
    /// （`Inconclusive` 的档位处置由 [`crate::StreakTracker`] 与 preset 负责，不在这里偷偷升级）。
    pub fn counts_as_hard_failure(&self) -> bool {
        matches!(self, Self::Failed { soft: false, .. })
    }

    /// 是否为软断言（`soft: true`）。
    pub fn is_soft(&self) -> bool {
        match self {
            Self::Passed { soft, .. }
            | Self::Failed { soft, .. }
            | Self::Skipped { soft, .. }
            | Self::Inconclusive { soft, .. } => *soft,
        }
    }

    /// 非通过时的说明（供报告使用）；通过时为 `None`。
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Passed { .. } => None,
            Self::Failed { diff, .. } => Some(diff.as_str()),
            Self::Skipped { reason, .. } | Self::Inconclusive { reason, .. } => {
                Some(reason.as_str())
            }
        }
    }
}

/// 深比较（够用于 JSON 形状的数据）。
///
/// 语义对照 `src/runtime/assert.ts:42-60` 的 `deepEqual`，逐条对齐：
///
/// 1. **快路径**：同型标量（字符串 / 布尔 / 数字 / `null`）直接按值相等；
/// 2. **类型不同** ⇒ false（`1` 与 `"1"`、`1` 与 `1.0` 的数字形态都按值比较，见下）；
/// 3. 数组：长度相同且**逐元素**深比较（**顺序敏感**：`[1,2]` ≠ `[2,1]`）；
/// 4. 对象：**键集相同**且逐键深比较（键顺序无关）；
/// 5. 其它组合一律 false。
///
/// **与 TS 的差异（如实记录）**：TS 里 `null` 只与 `null` 相等，本实现同。
/// 数字不做容差——容差是**对拍器**的等价关系（`docs/REWRITE-DESIGN.md` §9.3
/// "数字容差 1e-9"），不是 `is` 判定词的语义；把容差塞进 `is` 会让 `is: 1` 对
/// `1.0000000001` 也通过，那是**改变判定**而不是归一化。
pub fn deep_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => numbers_equal(x, y),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|(l, r)| deep_equal(l, r))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(k, lv)| y.get(k).is_some_and(|rv| deep_equal(lv, rv)))
        }
        // 跨类型（含任何一侧是 Number 而另一侧不是）一律不相等。
        _ => false,
    }
}

/// 数字按**数值**比较，不按内部形态（对齐 TS 里 `1` 与 `1.0` 是同一个 `number`）。
///
/// 两侧都是整数域时走整数比较，可避免 `u64` 大整数转 `f64` 丢精度（`2^63` 以上）。
fn numbers_equal(x: &serde_json::Number, y: &serde_json::Number) -> bool {
    match (x.as_i64(), x.as_u64(), y.as_i64(), y.as_u64()) {
        (Some(xi), _, Some(yi), _) => xi == yi,
        (_, Some(xu), _, Some(yu)) => xu == yu,
        _ => match (x.as_f64(), y.as_f64()) {
            (Some(xf), Some(yf)) => xf == yf,
            _ => false,
        },
    }
}

/// 判定词消息里用的**类型名**，对齐 TS 的 `typeof` 口径。
///
/// `Value::Null` → `"null"`（TS 里 `typeof null === 'object'`，但本仓的失败消息
/// 用 `实际 null` 更可读，且旧实现 `describe()` 会把 `null` 渲染成 `null`，见
/// `assert.ts:82-89`——两者在报告里可读性等价，这里选更可读的一侧并显式记录）。
/// **ref 指向不存在的键**时不是 `Value` 能表达的，调用方传 `None`，得到 `"undefined"`
/// （对齐 TS 里 `typeof undefined === 'undefined'`）。
pub fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "object",
        Some(Value::Object(_)) => "object",
    }
}

/// 取长度，非可长度对象返回 `None`。
///
/// 对齐 `assert.ts:63-67` 的 `lengthOf`：**字符串与数组取 `.length`，`Map` / `Set` 取 `.size`**。
///
/// **Rust 侧的对应关系（如实记录，这是一处已知差异）**：`execute` 边界传的是 JSON
/// （`serde_json::Value`），没有 `Map` / `Set` 类型。旧实现里 `new Map()` / `new Set()`
/// 取 `.size`，而**普通对象没有 `.length` 也没有 `.size`` ⇒ 返回 `undefined` ⇒ 判失败。
/// 所以本实现**对 `Value::Object` 一律返回 `None`**（对齐"普通对象不可长度"），
/// 而不是拿键集大小冒充 `Map.size`——那会让 `length` 对对象**悄悄通过**，
/// 是"假装成功"。
///
/// 这条差异列入阶段 1 汇报，供阶段 2 对拍裁决（`Map` / `Set` 形态**无法**经 JSON 过桥，
/// 若未来确实要覆盖它，应由 protocol 层的容器标记承担，不在这里猜）。
pub fn length_of(value: &Value) -> Option<usize> {
    match value {
        Value::String(s) => Some(s.chars().count()),
        Value::Array(a) => Some(a.len()),
        _ => None,
    }
}

/// 渲染一个 JSON 值为人类可读文本（失败消息用）。
///
/// 对齐 `assert.ts:82-89` 的 `describe()`：字符串走 JSON 引号形态（`"1"`），
/// 其它值走 `JSON.stringify`。`serde_json` 的对象键序在默认构建下是有序的
/// （`BTreeMap`），因此**同一输入永远得到同一文本**（指标 C1）。
pub fn describe(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::String(s)) => match serde_json::to_string(&Value::String(s.clone())) {
            Ok(text) => text,
            Err(_) => format!("{s:?}"),
        },
        Some(other) => match serde_json::to_string(other) {
            Ok(text) => text,
            Err(_) => format!("{other:?}"),
        },
    }
}

/// 把 JSON 值按 JS `String()` 的口径转成字符串（`contains` 的 expected 侧与 `matches` 的 pattern 侧）。
///
/// 对齐 `assert.ts:148`（`actual.includes(String(expected))`）与 `assert.ts:176`
/// （`parseRegexLiteral(String(expected))`）：**数字 / 布尔转字面量，字符串原样，
/// 其它形态走 JSON 文本**。JS 对 `null` 给 `"null"`、对 `undefined` 给 `"undefined"`，
/// 这里对 `Value::Null` 与"缺失"分别给这两个词，保持可读且确定。
pub fn stringify_like_js(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".to_string(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => serde_json::to_string(other).unwrap_or_else(|_| format!("{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `deep_equal` 对着 `tests/assert.test.mjs::deepEqual 与 parseRegexLiteral 的边界` 的四条断言。
    #[test]
    fn deep_equal_matches_legacy_assertions() {
        assert!(deep_equal(&json!([1, {"a": 2}]), &json!([1, {"a": 2}])));
        assert!(!deep_equal(&json!([1]), &json!([1, 2])));
        assert!(deep_equal(&Value::Null, &Value::Null));
        assert!(!deep_equal(&json!(1), &json!("1")));
    }

    /// `is` 的顺序敏感性：`[1,2]` ≠ `[2,1]`（对应 observable "数组顺序不同"）。
    #[test]
    fn deep_equal_is_order_sensitive_for_arrays() {
        assert!(!deep_equal(&json!(1), &json!([1, 2])));
        assert!(!deep_equal(&json!([1, 2]), &json!([2, 1])));
    }

    /// 对象键集与嵌套结构。
    #[test]
    fn deep_equal_compares_objects_by_key_set() {
        assert!(deep_equal(
            &json!({"a": 1, "b": [2, {"c": 3}]}),
            &json!({"b": [2, {"c": 3}], "a": 1})
        ));
        assert!(!deep_equal(&json!({"a": 1}), &json!({"a": 1, "b": 2})));
        assert!(!deep_equal(&json!({"a": 1}), &json!({"b": 1})));
        assert!(!deep_equal(&json!({"a": 1}), &json!([1])));
    }

    /// 数字按值比较：`1` 与 `1.0` 是同一个 `number`；整数不走 `f64`。
    #[test]
    fn deep_equal_compares_numbers_by_value() {
        assert!(deep_equal(&json!(1), &json!(1.0)));
        assert!(deep_equal(&json!(u64::MAX), &json!(u64::MAX)));
        assert!(!deep_equal(&json!(1), &json!(1.000_000_000_1)));
        assert!(!deep_equal(&json!(true), &json!(1)));
    }

    /// `length_of` 的适用面：字符串 / 数组有长度，其余没有。
    #[test]
    fn length_of_only_applies_to_strings_and_arrays() {
        assert_eq!(length_of(&json!("abc")), Some(3));
        assert_eq!(length_of(&json!([1, 2])), Some(2));
        assert_eq!(length_of(&json!(5)), None);
        assert_eq!(length_of(&Value::Null), None);
        assert_eq!(length_of(&json!({"a": 1})), None);
        // 中文按**字符**计数（不是字节）：`"错误"` 是 2 个字符。
        assert_eq!(length_of(&json!("错误")), Some(2));
    }

    /// `type_name` 的口径，含"缺失"这一非 `Value` 状态。
    #[test]
    fn type_name_reports_legacy_typeof_shape() {
        assert_eq!(type_name(None), "undefined");
        assert_eq!(type_name(Some(&Value::Null)), "null");
        assert_eq!(type_name(Some(&json!(true))), "boolean");
        assert_eq!(type_name(Some(&json!(1))), "number");
        assert_eq!(type_name(Some(&json!("s"))), "string");
        assert_eq!(type_name(Some(&json!([]))), "object");
        assert_eq!(type_name(Some(&json!({}))), "object");
    }
}
