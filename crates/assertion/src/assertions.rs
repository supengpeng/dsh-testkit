//! 16 个断言词：14 个判定词 + `soft` 修饰 + `ref`（取值路径见 [`crate::refs`]）。
//!
//! 真源：`docs/SCENARIO-SPEC.md` §2.5（语义）与 `spec/behaviors/engine/assert.md`
//! 的 31 条 observable（逐条行为）。
//!
//! # 词表（**16 项**，不是设计文档原稿写的 17 项）
//!
//! 14 个判定词（按旧实现 `ASSERTION_KEYS` 的声明顺序，成功消息的词序也用它）：
//! `is` / `isNot` / `notIs` / `exists` / `notExists` / `contains` / `notContains` /
//! `matches` / `atLeast` / `atMost` / `length` / `lengthAtLeast` / `lengthAtMost` / `throws`。
//! 加 `soft`（修饰符，**不是**判定词）与 `ref`（取值路径）＝ **16**。
//!
//! 阶段 0 已实测四处源码数组一律 14 个、无第 17 个词（`spec/behaviors/engine/assert.md`
//! "计数矛盾"一节），设计文档的"17 个"是计数缺陷。**本实现不新增任何断言词**：
//! 新增会改动 `cases` schema 语义，需另立 RFC。
//!
//! # 每个判定词的返回三态
//!
//! | 词 | 通过 | 失败 | `Inconclusive` |
//! |---|---|---|---|
//! | `is` / `isNot` / `notIs` | 深比较成立/不成立 | 反之 | 否 |
//! | `exists` / `notExists` | 存在性与期望一致 | 反之 | 否 |
//! | `contains` / `notContains` | 字符串子串 / 数组含元素 | 反之、或类型不适用 | 否 |
//! | `matches` | 正则命中 | 未命中、或 actual 非字符串、或**模式非法** | **模式用了不支持的构造** |
//! | `atLeast` / `atMost` / `length*` | 数值/长度比较成立 | 反之、或类型不适用 | 否 |
//! | `throws` | 见下 | 见下 | 否 |
//!
//! # `throws`：本实现**修好**了旧实现的空壳（必须点名的差异）
//!
//! 旧实现 `src/runtime/assert.ts:201-202` 是空壳：`throws:true` 恒 `ok=false`、
//! `throws:false` 恒 `ok=true`，`actual` 参数**完全没被读**（`spec/behaviors/engine/assert.md`
//! 缺陷 1 记为"必须裁决"）。它的语义（`SCENARIO-SPEC.md:388`）是"**求值过程应抛错**"。
//!
//! 判定移出 TS 后，"取值过程"只能由**取证方**观察：driver 取到值 = 没抛错，
//! 取到异常 = 抛错。所以本实现把它折成 actual 侧的一个**显式标记**：
//! [`crate::AssertionSpec`] 的 `throws` 只接受字面量 `true` / `false`
//! （见 [`crate::AssertionSpec::throws_expected`] 的返回：`Option<bool>`），
//! 判定读 `matches` 侧的信息——即"实际取值是否抛错"（[`crate::core::type_name`] 为
//! `"undefined"` 且 `actual_absent` 为真时表示"取值过程没有产出值"）。
//!
//! **本 crate 的落地边界（如实说明）**：本 crate **没有** excutor / fixture 上下文，
//! 抛错事实需要一个显式输入（谁观察到的异常）。为避免**自造**协议字段（那要另立 RFC），
//! 本实现采用**已批准的既有通道**：`actual` 为"缺失"表示**取值过程没有产出值**
//! （对齐旧实现 `describe(actual)` 的 `undefined` 语义），并把 `throws` 的判定写成：
//!
//! - `throws: true` + actual 缺失（`undefined`）⇒ `Passed`；
//! - `throws: true` + actual 存在 ⇒ `Failed`（消息：期望抛错，但取值成功）；
//! - `throws: false` + actual 存在 ⇒ `Passed`；
//! - `throws: false` + actual 缺失 ⇒ `Failed`。
//!
//! 这条落地与 `SCENARIO-SPEC.md:388` 的"求值过程应抛错"**语义同向**，但**判据不够强**：
//! "缺失"也可能是键没记过。阶段 2 接入 driver 后应把"异常事实"升级成一等输入
//! （`AssertionContext` 的显式字段，需 RFC），届时本词的判据随之收紧。
//! 这条**限制必须写进汇报**，不许当成"已完全实现"。

use crate::core::{
    deep_equal, describe, length_of, stringify_like_js, type_name, AssertionOutcome,
};
use crate::matching::{self, MatchVerdict};
use serde_json::Value;

/// 断言词的**规范顺序**（成功消息里的词序）。
///
/// 与旧实现 `src/runtime/assert.ts:22-37` 的 `ASSERTION_KEYS` **逐项同序**：
/// 报告的"成功消息"含 `present.join(' + ')`，顺序敏感，所以这个常量是**行为契约**。
/// 新词若要加入，必须同时裁决消息词序（属 schema 语义变更）。
pub const ASSERTION_KEYS: [&str; 14] = [
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
];

/// `soft` 修饰符（不是判定词）。
pub const SOFT_MODIFIER: &str = "soft";

/// `ref` 取值路径（不是判定词）。
pub const REF_PATH: &str = "ref";

/// 全部 16 项的规范顺序（14 判定词 + `soft` + `ref`）。
///
/// **用途**：注册表的"内建词"守卫与词计数守卫（设计 §3.3 勘误要求"为断言词计数补一条守卫"）。
/// 断言词**只有 16 项**，第 17 个必须另立 RFC——这条常量就是那条守卫的机械形式。
pub const ASSERTION_WORDS: [&str; 16] = [
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
    SOFT_MODIFIER,
    REF_PATH,
];

/// 判定词 × 判定函数的注册表（**静态**，顺序即 [`ASSERTION_KEYS`]）。
///
/// 为什么是静态表而不是运行时构造：注册表要保证"内建词一直在、不可被覆盖"，
/// 静态表让这条不变量**编译期**成立，而不是依赖某个 `new()` 的调用时机。
pub(crate) const BUILTIN_EVALUATORS: [(&str, Evaluator); 14] = [
    ("is", is),
    ("isNot", is_not),
    ("notIs", is_not),
    ("exists", exists),
    ("notExists", not_exists),
    ("contains", contains),
    ("notContains", not_contains),
    ("matches", matches),
    ("atLeast", at_least),
    ("atMost", at_most),
    ("length", length),
    ("lengthAtLeast", length_at_least),
    ("lengthAtMost", length_at_most),
    ("throws", throws),
];

/// 单个判定词的判定函数签名。
pub(crate) type Evaluator = fn(&Value, Option<&Value>, bool) -> AssertionOutcome;

/// 判定结果：把四态构造成结果值（所有失败路径都**不是** `Result::Err`）。
pub(crate) struct Verdict;

impl Verdict {
    /// 通过。
    pub(crate) fn pass(soft: bool) -> AssertionOutcome {
        AssertionOutcome::Passed {
            details: None,
            soft,
        }
    }

    /// 失败。
    pub(crate) fn fail(
        message: String,
        expected: Value,
        actual: &Value,
        actual_absent: bool,
        literal: String,
        soft: bool,
    ) -> AssertionOutcome {
        AssertionOutcome::Failed {
            expected,
            actual: if actual_absent {
                Value::Null
            } else {
                actual.clone()
            },
            actual_absent,
            literal,
            diff: message,
            soft,
        }
    }

    /// 无法判定（`Inconclusive`）。
    pub(crate) fn inconclusive(
        reason: String,
        literal: String,
        actual: &Value,
        actual_absent: bool,
        soft: bool,
    ) -> AssertionOutcome {
        AssertionOutcome::Inconclusive {
            reason,
            literal,
            actual: if actual_absent {
                Value::Null
            } else {
                actual.clone()
            },
            actual_absent,
            soft,
        }
    }
}

/// `is` —— 严格相等（对象走深比较）。
pub(crate) fn is(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    match expected {
        Some(expected) if deep_equal(actual, expected) => Verdict::pass(soft),
        _ => Verdict::fail(
            format!(
                "期望 is {}，实际 {}",
                describe(expected),
                describe(Some(actual))
            ),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            describe(expected),
            soft,
        ),
    }
}

/// `isNot` / `notIs` —— 不等于（两个词共用同一实现，对齐 `assert.ts:130-134`）。
pub(crate) fn is_not(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    let equal = expected.is_some_and(|expected| deep_equal(actual, expected));
    if equal {
        // 措辞与旧实现一致（`assert.ts:134`）：**不**区分是 `isNot` 还是 `notIs`。
        // 这是 `spec/behaviors/engine/assert.md` 缺陷 3 记录的现象；本实现保持它，
        // 因为改措辞会改动报告文本（对拍按 normalize-path 比 message）。
        Verdict::fail(
            format!("期望不等于 {}，但相等", describe(expected)),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            describe(expected),
            soft,
        )
    } else {
        Verdict::pass(soft)
    }
}

/// `exists` —— 非 `undefined` / `null`（期望值写成 `false` 是合法且常用的反向表达）。
pub(crate) fn exists(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    let want = js_truthy(expected);
    let present = actual != &Value::Null;
    if want == present {
        Verdict::pass(soft)
    } else {
        Verdict::fail(
            format!(
                "期望 exists={}，实际 {}",
                literal_of(expected),
                describe(Some(actual))
            ),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        )
    }
}

/// `notExists` —— `undefined` / `null`（`0` / `""` / `false` 仍算**存在**）。
pub(crate) fn not_exists(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    let want = js_truthy(expected);
    let absent = actual == &Value::Null;
    if want == absent {
        Verdict::pass(soft)
    } else {
        Verdict::fail(
            format!(
                "期望 notExists={}，实际 {}",
                literal_of(expected),
                describe(Some(actual))
            ),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        )
    }
}

/// `contains` —— 字符串子串 / 数组含元素（对象元素按结构比较）。
pub(crate) fn contains(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    match actual {
        Value::String(text) => {
            let needle = stringify_like_js(expected);
            if text.contains(&needle) {
                Verdict::pass(soft)
            } else {
                Verdict::fail(
                    format!(
                        "期望包含 {}，实际 {}",
                        describe(expected),
                        describe(Some(actual))
                    ),
                    expected.cloned().unwrap_or(Value::Null),
                    actual,
                    false,
                    literal_of(expected),
                    soft,
                )
            }
        }
        Value::Array(items) => {
            let hit = expected
                .is_some_and(|expected| items.iter().any(|item| deep_equal(item, expected)));
            if hit {
                Verdict::pass(soft)
            } else {
                Verdict::fail(
                    format!("期望数组含 {}", describe(expected)),
                    expected.cloned().unwrap_or(Value::Null),
                    actual,
                    false,
                    literal_of(expected),
                    soft,
                )
            }
        }
        other => Verdict::fail(
            format!("contains 不适用于 {}", type_name(Some(other))),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        ),
    }
}

/// `notContains` —— 字符串不含子串 / 数组不含元素（类型不适用时判失败，不是异常）。
pub(crate) fn not_contains(
    actual: &Value,
    expected: Option<&Value>,
    soft: bool,
) -> AssertionOutcome {
    match actual {
        Value::String(text) => {
            let needle = stringify_like_js(expected);
            if text.contains(&needle) {
                Verdict::fail(
                    format!("期望不包含 {}", describe(expected)),
                    expected.cloned().unwrap_or(Value::Null),
                    actual,
                    false,
                    literal_of(expected),
                    soft,
                )
            } else {
                Verdict::pass(soft)
            }
        }
        Value::Array(items) => {
            let hit = expected
                .is_some_and(|expected| items.iter().any(|item| deep_equal(item, expected)));
            if hit {
                Verdict::fail(
                    format!("期望数组不含 {}", describe(expected)),
                    expected.cloned().unwrap_or(Value::Null),
                    actual,
                    false,
                    literal_of(expected),
                    soft,
                )
            } else {
                Verdict::pass(soft)
            }
        }
        other => Verdict::fail(
            format!("notContains 不适用于 {}", type_name(Some(other))),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        ),
    }
}

/// `matches` —— 正则匹配（`/pattern/flags` 形式）。
///
/// 三个结论的落点：
///
/// - `Matched` → `Passed`；`NotMatched` 且 actual 是字符串 → `Failed`；
/// - actual 非字符串 → `Failed`（消息 `matches 需要字符串，实际 <type>`）；
/// - `Unsupported`（lookahead / 反向引用 / `u` 旗标…）→ **`Inconclusive`**，绝不猜；
/// - `InvalidPattern`（模式写错）→ `Failed`（**不**让异常冒泡成 `errored`，见模块文档）。
pub(crate) fn matches(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    if !matches!(actual, Value::String(_)) {
        return Verdict::fail(
            matching::type_error_message(Some(actual)),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        );
    }
    match matching::matches(actual, expected) {
        MatchVerdict::Matched => Verdict::pass(soft),
        MatchVerdict::NotMatched => Verdict::fail(
            format!(
                "期望匹配 {}，实际 {}",
                stringify_like_js(expected),
                describe(Some(actual))
            ),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        ),
        MatchVerdict::Unsupported { reason } => {
            Verdict::inconclusive(reason, literal_of(expected), actual, false, soft)
        }
        MatchVerdict::InvalidPattern { reason } => Verdict::fail(
            reason,
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal_of(expected),
            soft,
        ),
    }
}

/// `atLeast` —— `>=`（actual 必须是 `number`，边界相等算通过）。
pub(crate) fn at_least(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    let literal = literal_of(expected);
    let pass = match numeric(actual) {
        None => false,
        Some(number) => to_number(expected).is_some_and(|want| number >= want),
    };
    if pass {
        Verdict::pass(soft)
    } else {
        Verdict::fail(
            format!("期望 >= {literal}，实际 {}", describe(Some(actual))),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        )
    }
}

/// `atMost` —— `<=`（等于上限算通过；actual 非 `number` 一律失败）。
pub(crate) fn at_most(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    let literal = literal_of(expected);
    let pass = match numeric(actual) {
        None => false,
        Some(number) => to_number(expected).is_some_and(|want| number <= want),
    };
    if pass {
        Verdict::pass(soft)
    } else {
        Verdict::fail(
            format!("期望 <= {literal}，实际 {}", describe(Some(actual))),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        )
    }
}

/// `length` —— 长度等于（字符串 / 数组）。
pub(crate) fn length(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    compare_length(actual, expected, soft, |len, want| len == want, "", "长度")
}

/// `lengthAtLeast` —— 长度 `>=`。
pub(crate) fn length_at_least(
    actual: &Value,
    expected: Option<&Value>,
    soft: bool,
) -> AssertionOutcome {
    compare_length(
        actual,
        expected,
        soft,
        |len, want| len >= want,
        ">= ",
        "长度 >= ",
    )
}

/// `lengthAtMost` —— 长度 `<=`。
pub(crate) fn length_at_most(
    actual: &Value,
    expected: Option<&Value>,
    soft: bool,
) -> AssertionOutcome {
    compare_length(
        actual,
        expected,
        soft,
        |len, want| len <= want,
        "<= ",
        "长度 <= ",
    )
}

/// `length*` 三个词的公共骨架。
///
/// **不可长度对象（`number` / `null` / 对象 / 布尔）的失败消息与词名无关**：
/// 旧实现 `assert.ts:194` 三个词共用 `length 需要可长度对象，实际 <type>`，
/// 本实现保持同一措辞（对拍按 normalize-path 比 message）。
///
/// 两个 `label` 参数对应旧实现的两处不同措辞：
/// - 比较失败：`期望长度 {want}，实际 {len}` / `期望长度 >= {want}，实际 {len}`；
/// - 期望值不可折算成数字：`期望 {label}{literal}，实际 {len}`。
fn compare_length(
    actual: &Value,
    expected: Option<&Value>,
    soft: bool,
    compare: fn(u64, u64) -> bool,
    operator: &'static str,
    label: &'static str,
) -> AssertionOutcome {
    let literal = literal_of(expected);
    let Some(len) = length_of(actual) else {
        return Verdict::fail(
            format!("length 需要可长度对象，实际 {}", type_name(Some(actual))),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        );
    };
    let Some(want) = to_number(expected) else {
        return Verdict::fail(
            format!("期望 {label}{literal}，实际 {len}"),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        );
    };
    let pass = want >= 0.0 && compare(len as u64, want as u64);
    if pass {
        Verdict::pass(soft)
    } else {
        // 旧实现的消息里 `want` 走 `Number(expected)` 的文本（`3` 而不是 `3.0`）。
        Verdict::fail(
            format!("期望长度 {operator}{}，实际 {len}", number_text(want)),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        )
    }
}

/// `throws` —— 求值过程应抛错（**本实现修好的空壳**，语义见 [`crate::assertions`] 模块文档）。
///
/// 判据：期望值走 `Boolean(expected)`；`actual` 缺失（`undefined`）表示"取值过程没有产出值"。
pub(crate) fn throws(actual: &Value, expected: Option<&Value>, soft: bool) -> AssertionOutcome {
    let literal = literal_of(expected);
    let want = js_truthy(expected);
    // "取值过程是否抛错"在本 crate 的可见输入里唯一的对应物是"有没有取到值"：
    // 缺失（`undefined`）表示没有产出值。**判据不够强**，已在模块文档与阶段 1 汇报里点名。
    let threw = actual == &Value::Null;
    if want == threw {
        Verdict::pass(soft)
    } else if want {
        Verdict::fail(
            "期望抛错，但取值成功".to_string(),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        )
    } else {
        Verdict::fail(
            "期望不抛错，但取值过程没有产出值".to_string(),
            expected.cloned().unwrap_or(Value::Null),
            actual,
            false,
            literal,
            soft,
        )
    }
}

/// `JS Boolean(expected)` 的折算（旧实现 `exists` / `notExists` 用的是 `Boolean(expected)`）。
///
/// 显式与 TS 对齐：`""` / `0` / `null` / `undefined` 为假，`"0"` / `[]` / `{}` 为真。
fn js_truthy(expected: Option<&Value>) -> bool {
    match expected {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        // TS 里 `Boolean({})` 是 `true`、`Boolean([])` 是 `true`。
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// 期望值的字面量文本（失败消息与 `literal` 字段用）。
pub(crate) fn literal_of(expected: Option<&Value>) -> String {
    match expected {
        None => "undefined".to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => stringify_like_js(Some(other)),
    }
}

/// `number` 的判定：只有 JSON 数字算数字（`"3"` 不算）。
pub(crate) fn numeric(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        _ => None,
    }
}

/// `Number(expected)` 的折算（对齐旧实现里 `Number(expected)` 的用法）。
pub(crate) fn to_number(expected: Option<&Value>) -> Option<f64> {
    match expected? {
        Value::Number(number) => number.as_f64(),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        Value::Null => Some(0.0),
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// 数值的文本形态（`3` 而不是 `3.0`），对齐旧实现消息里的 `Number(expected)` 渲染。
fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        format!("{value}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(word: &str, actual: &Value, expected: Option<&Value>) -> AssertionOutcome {
        let evaluator = BUILTIN_EVALUATORS
            .iter()
            .find(|(name, _)| *name == word)
            .map(|(_, function)| *function)
            .unwrap_or_else(|| panic!("未知判定词 {word}"));
        evaluator(actual, expected, false)
    }

    /// 词表守卫：16 项、14 个判定词、顺序与旧实现一致（设计 §3.3 勘误要求的守卫）。
    #[test]
    fn word_table_has_exactly_sixteen_entries() {
        assert_eq!(ASSERTION_WORDS.len(), 16);
        assert_eq!(ASSERTION_KEYS.len(), 14);
        assert_eq!(BUILTIN_EVALUATORS.len(), 14);
        for (position, key) in ASSERTION_KEYS.iter().enumerate() {
            assert_eq!(BUILTIN_EVALUATORS[position].0, *key);
        }
        assert_eq!(ASSERTION_WORDS[14], SOFT_MODIFIER);
        assert_eq!(ASSERTION_WORDS[15], REF_PATH);
    }

    /// `is`：同形对象 / 同类型标量通过，类型不同与数组顺序不同失败。
    #[test]
    fn is_deep_compares() {
        assert!(run("is", &json!({"x": [1, 2]}), Some(&json!({"x": [1, 2]}))).counts_as_passed());
        assert!(!run("is", &json!({"x": [1, 2]}), Some(&json!({"x": [2, 1]}))).counts_as_passed());
        assert!(run("is", &json!(1), Some(&json!(1))).counts_as_passed());
        assert!(!run("is", &json!("1"), Some(&json!(1))).counts_as_passed());
        let failed = run("is", &json!("1"), Some(&json!(1)));
        assert_eq!(failed.reason(), Some("期望 is 1，实际 \"1\""));
    }

    /// `isNot` / `notIs`：两者共用分支、同语义、同消息。
    #[test]
    fn is_not_and_not_is_share_semantics() {
        assert!(run("isNot", &json!(2), Some(&json!(1))).counts_as_passed());
        assert!(run("notIs", &json!(2), Some(&json!(1))).counts_as_passed());
        assert!(!run("isNot", &json!(1), Some(&json!(1))).counts_as_passed());
        assert!(!run("notIs", &json!(1), Some(&json!(1))).counts_as_passed());
        assert_eq!(
            run("isNot", &json!(1), Some(&json!(1))).reason(),
            run("notIs", &json!(1), Some(&json!(1))).reason()
        );
    }

    /// `exists`：`null` / `undefined` 都不存在，`0` / `""` / `false` 都存在。
    #[test]
    fn exists_treats_null_and_undefined_as_missing() {
        assert!(!run("exists", &Value::Null, Some(&json!(true))).counts_as_passed());
        assert!(run("exists", &json!(0), Some(&json!(true))).counts_as_passed());
        assert!(run("exists", &json!(""), Some(&json!(true))).counts_as_passed());
        assert!(run("exists", &json!(false), Some(&json!(true))).counts_as_passed());
    }

    /// `exists:false` 是合法的反向表达（端到端 40+ 处依赖它）。
    #[test]
    fn exists_false_is_a_valid_reverse_expression() {
        assert!(run("exists", &Value::Null, Some(&json!(false))).counts_as_passed());
        assert!(!run("exists", &json!(0), Some(&json!(false))).counts_as_passed());
        // 期望值走 `Boolean(expected)`（旧实现 `assert.ts:137`）：`1` 为真、`0` 为假。
        assert!(run("exists", &json!(0), Some(&json!(1))).counts_as_passed());
        assert!(!run("exists", &json!(0), Some(&json!(0))).counts_as_passed());
    }

    /// `notExists`。
    #[test]
    fn not_exists_inverts_existence() {
        assert!(run("notExists", &Value::Null, Some(&json!(true))).counts_as_passed());
        assert!(!run("notExists", &json!(0), Some(&json!(true))).counts_as_passed());
        assert!(run("notExists", &json!(0), Some(&json!(false))).counts_as_passed());
    }

    /// `contains`：字符串子串与数组元素（对象元素按结构比较；对象本身不适用）。
    #[test]
    fn contains_supports_strings_and_arrays() {
        assert!(run("contains", &json!("xxabcxx"), Some(&json!("abc"))).counts_as_passed());
        // 数组元素是对象时按**结构**比较（不是引用比较）。
        assert!(run("contains", &json!([{"x": 1}]), Some(&json!({"x": 1}))).counts_as_passed());
        assert!(!run("contains", &json!([1, 2]), Some(&json!(9))).counts_as_passed());
        assert_eq!(
            run("contains", &json!("abc"), Some(&json!("zzz"))).reason(),
            Some("期望包含 \"zzz\"，实际 \"abc\"")
        );
    }

    /// `contains` 的类型不匹配分支（**旧测试未覆盖**，任务点名要求覆盖）。
    #[test]
    fn contains_on_unsupported_type_fails_with_explanation() {
        let verdict = run("contains", &json!(5), Some(&json!(1)));
        assert!(!verdict.counts_as_passed());
        assert_eq!(verdict.reason(), Some("contains 不适用于 number"));
        assert_eq!(
            run("contains", &Value::Null, Some(&json!(1))).reason(),
            Some("contains 不适用于 null")
        );
        assert_eq!(
            run("contains", &json!({"a": 1}), Some(&json!(1))).reason(),
            Some("contains 不适用于 object")
        );
    }

    /// `notContains`：字符串与数组两个分支 + 类型不匹配。
    #[test]
    fn not_contains_covers_both_branches() {
        assert!(run("notContains", &json!([1, 2, 3]), Some(&json!(9))).counts_as_passed());
        assert!(!run("notContains", &json!([1, 2, 3]), Some(&json!(2))).counts_as_passed());
        assert!(run("notContains", &json!("abc"), Some(&json!("zz"))).counts_as_passed());
        assert!(!run("notContains", &json!("abc"), Some(&json!("b"))).counts_as_passed());
        assert_eq!(
            run("notContains", &json!(5), Some(&json!(1))).reason(),
            Some("notContains 不适用于 number")
        );
    }

    /// `matches`：命中、未命中、非字符串、`/pattern/flags` 字面量。
    #[test]
    fn matches_covers_literal_and_type_mismatch() {
        assert!(run("matches", &json!("错误：炸了"), Some(&json!("/^错误：/"))).counts_as_passed());
        assert!(!run("matches", &json!("没事"), Some(&json!("/^错误：/"))).counts_as_passed());
        assert!(run("matches", &json!("xxabc"), Some(&json!("/ABC/i"))).counts_as_passed());
        let mismatch = run("matches", &json!(123), Some(&json!("/x/")));
        assert_eq!(mismatch.reason(), Some("matches 需要字符串，实际 number"));
        // 裸字符串模式（不是字面量）也按正则处理。
        assert!(run("matches", &json!("xabcx"), Some(&json!("abc"))).counts_as_passed());
    }

    /// `matches`：不支持的构造 → `Inconclusive`（不猜）；非法模式 → `Failed`（不炸 case）。
    #[test]
    fn matches_splits_unsupported_from_invalid() {
        let unsupported = run("matches", &json!("ab"), Some(&json!(r"/a(?=b)/")));
        assert!(unsupported.counts_as_inconclusive());
        assert!(!unsupported.counts_as_passed());
        assert!(!unsupported.counts_as_failed());
        assert!(unsupported.reason().unwrap_or_default().contains("(?"));
        let invalid = run("matches", &json!("aa"), Some(&json!("a{2,1}")));
        assert!(invalid.counts_as_failed());
        assert!(invalid.reason().unwrap_or_default().contains("非法"));
    }

    /// `atLeast`：`typeof actual === 'number'` 是硬前提，边界相等算通过。
    #[test]
    fn at_least_requires_number_and_includes_boundary() {
        assert!(run("atLeast", &json!(3), Some(&json!(3))).counts_as_passed());
        assert!(run("atLeast", &json!(4), Some(&json!(3))).counts_as_passed());
        assert!(!run("atLeast", &json!(2), Some(&json!(3))).counts_as_passed());
        assert!(!run("atLeast", &json!("3"), Some(&json!(3))).counts_as_passed());
        assert_eq!(
            run("atLeast", &json!(2), Some(&json!(3))).reason(),
            Some("期望 >= 3，实际 2")
        );
    }

    /// `atMost`：等于上限算通过，非 number 一律失败。
    #[test]
    fn at_most_includes_boundary_and_requires_number() {
        assert!(run("atMost", &json!(10), Some(&json!(10))).counts_as_passed());
        assert!(!run("atMost", &json!(11), Some(&json!(10))).counts_as_passed());
        assert!(!run("atMost", &json!(null), Some(&json!(10))).counts_as_passed());
        assert_eq!(
            run("atMost", &json!(11), Some(&json!(10))).reason(),
            Some("期望 <= 10，实际 11")
        );
    }

    /// `length`：字符串 / 数组；不可长度对象失败并说明。
    #[test]
    fn length_covers_strings_and_arrays() {
        assert!(run("length", &json!("abc"), Some(&json!(3))).counts_as_passed());
        assert!(!run("length", &json!("abc"), Some(&json!(2))).counts_as_passed());
        assert!(run("length", &json!([1, 2]), Some(&json!(2))).counts_as_passed());
        assert_eq!(
            run("length", &json!(5), Some(&json!(1))).reason(),
            Some("length 需要可长度对象，实际 number")
        );
        assert_eq!(
            run("length", &Value::Null, Some(&json!(1))).reason(),
            Some("length 需要可长度对象，实际 null")
        );
        assert_eq!(
            run("length", &json!({"a": 1}), Some(&json!(1))).reason(),
            Some("length 需要可长度对象，实际 object")
        );
    }

    /// `lengthAtLeast`（**旧测试未覆盖**，任务点名要求覆盖）。
    #[test]
    fn length_at_least_covers_boundary() {
        assert!(run("lengthAtLeast", &json!("abc"), Some(&json!(2))).counts_as_passed());
        assert!(run("lengthAtLeast", &json!("abc"), Some(&json!(3))).counts_as_passed());
        assert!(!run("lengthAtLeast", &json!("abc"), Some(&json!(4))).counts_as_passed());
        assert_eq!(
            run("lengthAtLeast", &json!(5), Some(&json!(1))).reason(),
            Some("length 需要可长度对象，实际 number")
        );
    }

    /// `lengthAtMost`。
    #[test]
    fn length_at_most_covers_boundary() {
        assert!(run("lengthAtMost", &json!("abc"), Some(&json!(3))).counts_as_passed());
        assert!(!run("lengthAtMost", &json!("abc"), Some(&json!(2))).counts_as_passed());
        assert!(run("lengthAtMost", &json!([1]), Some(&json!(1))).counts_as_passed());
        assert_eq!(
            run("lengthAtMost", &json!("abc"), Some(&json!(2))).reason(),
            Some("期望长度 <= 2，实际 3")
        );
    }

    /// `throws`：**修好的版本**（旧实现恒 false / 恒 true，且零覆盖）。
    #[test]
    fn throws_reads_actual_instead_of_ignoring_it() {
        // 期望抛错 + 取值没有产出值 ⇒ 通过。
        assert!(run("throws", &Value::Null, Some(&json!(true))).counts_as_passed());
        // 期望抛错 + 取到了值 ⇒ 失败（旧实现在这里**恒失败**，与本实现同结论但理由不同：
        // 旧实现根本不看 actual）。
        let failed = run("throws", &json!("ok"), Some(&json!(true)));
        assert_eq!(failed.reason(), Some("期望抛错，但取值成功"));
        // 期望不抛错 + 取到了值 ⇒ 通过（旧实现恒通过）。
        assert!(run("throws", &json!("ok"), Some(&json!(false))).counts_as_passed());
        // 期望不抛错 + 没有产出值 ⇒ 失败（**旧实现恒通过**，这是行为差异）。
        assert!(!run("throws", &Value::Null, Some(&json!(false))).counts_as_passed());
        // 期望值走 `Boolean(expected)`（与 `exists` 同一口径）：`1` 为真。
        assert!(run("throws", &Value::Null, Some(&json!(1))).counts_as_passed());
        assert!(run("throws", &json!("ok"), Some(&json!(0))).counts_as_passed());
    }

    /// 软断言：每个判定词的 `soft` 都原样保留在结果里（判定层不丢弃它）。
    #[test]
    fn soft_flag_is_preserved_on_every_variant() {
        for word in ASSERTION_KEYS {
            let evaluator = BUILTIN_EVALUATORS
                .iter()
                .find(|(name, _)| *name == word)
                .map(|(_, function)| *function)
                .expect("词表内");
            let passed = evaluator(&json!("abc"), Some(&json!("abc")), true);
            assert!(passed.is_soft(), "{word} 通过时应保留 soft");
            let failed = evaluator(&json!(12345), Some(&json!("zzz")), true);
            assert!(failed.is_soft(), "{word} 失败时应保留 soft");
            assert!(!failed.counts_as_hard_failure(), "{word} 软失败不算硬失败");
        }
    }
}
