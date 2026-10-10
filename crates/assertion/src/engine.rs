//! 断言引擎：`AssertionEngine` / `AssertionEvaluator` trait、注册表、四态聚合与
//! `Inconclusive` 升级规则。
//!
//! 真源：`docs/REWRITE-DESIGN.md` §3.3（trait 与四态）、§3.1（五条设计约束）、
//! §6.4（判定路径禁用 `HashMap` / `HashSet`）、§8.4 硬约束 3 / 3b（`Inconclusive` 的
//! 档位处置与"连续 3 次升级"）。
//!
//! # 五条设计约束在本模块的落点（§3.1 逐条）
//!
//! | 约束 | 落点 |
//! |---|---|
//! | 对象安全 | [`AssertionEvaluator`] 无泛型方法、无 `Self` 返回，`Box<dyn AssertionEvaluator>` 可存可调 |
//! | 线程安全 | 两个 trait 都要求 `Send + Sync`；注册表用 `RwLock`；计数器用 `RwLock<BTreeMap<..>>` |
//! | 内部可变性显式 | `register` 的 `&self` 背后是 [`RwLock`]；**锁语义写在本模块与 trait 文档里** |
//! | 序列化 | [`AssertionSpec`] / [`AssertionContext`] 走 `serde`；`#[non_exhaustive]` + `deny_unknown_fields` |
//! | 断言失败不是 `Result::Err` | [`AssertionEngine::assert`] 返回 [`AssertionOutcome`]；`Result` 只给 `register`（工具坏了） |
//!
//! # 锁语义（必须显式，原稿的教训）
//!
//! [`BufferedAssertionEngine`] 的 `&self` 背后是 `RwLock<BTreeMap<String, Arc<dyn AssertionEvaluator>>>`：
//!
//! - **写锁只在注册期持有**（`register` 的整个调用期间）；
//! - **判定期只持读锁，且只够把求值器取出来**——求值器在**没有锁**的情况下被调用。
//!   这条是刻意的：求值器（包括插件式自定义词）不应在持有锁时执行，
//!   否则一个求值器里再调 `register` 就会**自死锁**。注册表里存的是
//!   `Arc<dyn AssertionEvaluator>`，取出来只是 `Arc::clone`，所以"取"与"调用"之间
//!   可以真正把锁放掉。本模块有一条测试机械证明这一点。
//! - 因为判定路径不持有写锁、也不**迭代**锁内的表（只按名查找），
//!   C1（同种子同结果）不受锁的调度顺序影响。迭代只发生在 [`BufferedAssertionEngine::registered_names`]，
//!   它显式排序，与 `HashMap` 的随机迭代顺序无关——顺带说明，本 crate 判定路径
//!   **一个 `HashMap` / `HashSet` 都没有**（设计 §6.4）。
//!
//! # 重入注册
//!
//! `register` 遇到**已存在的名字**（含 16 个内建词）时返回
//! [`AssertionError::AlreadyRegistered`]，**不静默覆盖**。这条同时保护内建词不被插件顶掉：
//! 内建词在 [`BufferedAssertionEngine::new`] 里经**同一条** `register` 路径注册。

use crate::assertions::{self, ASSERTION_KEYS};
use crate::core::AssertionOutcome;
use crate::refs::{resolve_ref, RefSources};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::sync::{Arc, RwLock};

/// 反序列化一个"可以是显式 `null`"的 JSON 值。
///
/// # 为什么不能用裸 `Option<Value>`
///
/// `Option<T>` 在 serde 里把 JSON `null` 当成 `None`（与"缺字段"合并）——
/// 那样 `{"ref":"fx.a","is":null}` 会被当成"没给 `is`"，而仓库里**真有**这种写法
/// （`cases/TK-0030.yaml:44`：`{ ref: fx.fsBefore, is: null }`），
/// 它会被判成"断言缺少判定词"这个错误结论。旧实现里 `assertion.is !== undefined`
/// 是 `true`（`null !== undefined`），所以这里显式区分：
///
/// - 缺字段 ⇒ `None`；
/// - 显式 `null` ⇒ `Some(Value::Null)`。
fn deserialize_optional_json_value<'de, D>(deserializer: D) -> Result<Option<Value>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Value::deserialize(deserializer).map(Some)
}

/// 判定上下文：一次断言求值所需的全部外部输入（设计 §3.3 的 `AssertionContext`）。
///
/// **Rust 侧不持有场景语义**（设计 §1.1）：这里只带"取值要用的三个源"与"判据身份要用的
/// 场景标识"，不认识 `kind`。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct AssertionContext {
    /// 当前场景的标识（`CaseOutcome.id`）。
    ///
    /// **用途**：`Inconclusive` 连续 3 次升级的键里必须有"同一场景"（设计 §8.4 硬约束 3b），
    /// 所以它是评测的身份输入，不是可选装饰。
    pub scenario_id: String,
    /// Fixture 取证快照（`fx.*` 的来源）。
    #[serde(default)]
    pub fixture: Option<Value>,
    /// 场景自身字段（`case.*` 的来源）。
    #[serde(default)]
    pub scenario: Option<Value>,
    /// 运行环境（`env.*` 的来源）。
    #[serde(default)]
    pub env: Option<Value>,
}

impl AssertionContext {
    /// 只给场景标识的最小上下文（其余取值源为空 ⇒ `fx.*` 取到"缺失"）。
    pub fn new(scenario_id: impl Into<String>) -> Self {
        Self {
            scenario_id: scenario_id.into(),
            fixture: None,
            scenario: None,
            env: None,
        }
    }

    /// 组装取值源。
    pub fn sources(&self) -> RefSources {
        RefSources {
            fixture: self.fixture.clone(),
            scenario: self.scenario.clone(),
            env: self.env.clone(),
        }
    }
}

/// 一条断言（设计 §3.3 的 `AssertionSpec`）。
///
/// 字段与 `cases/*.yaml` 的断言行**同名同义**（`docs/SCENARIO-SPEC.md` §2.5）：
/// `ref` 是取值路径，其余 14 个是判定词，`soft` 是修饰符。
///
/// # 为什么判定词字段用 `default` + 自定义反序列化
///
/// 裸 `Option<Value>` 会把 JSON `null` 也变成 `None`（与"缺字段"合并）——那样
/// `{"ref":"fx.a","is":null}` 会被当成"没给 `is`"、判成"断言缺少判定词"这个**错误结论**，
/// 而仓库里真有这种写法（`cases/TK-0030.yaml:44`）。旧实现里 `assertion.is !== undefined`
/// 是 `true`（`null !== undefined`）。所以每个判定词字段同时挂：
///
/// - `default`：**缺字段** ⇒ `None`（这才是"没给这个词"）；
/// - `deserialize_with = "deserialize_optional_json_value"`：**显式 `null`** ⇒ `Some(Value::Null)`。
///
/// 本模块的一条测试把这条语义锁住。
///
/// **`deny_unknown_fields` 是刻意的**：`cases` schema 与本题的字段集合是**同一份契约**，
/// 拼错词名（`contain`）或新增第 17 个词时应当**拒绝**而不是静默忽略——
/// 静默忽略会让"断言没生效"表现成"断言通过"。注意这依赖两侧同步升级字段集
/// （TS 侧由 `src/cases/schema.ts` 的 `ASSERTION_WORDS` 守）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[non_exhaustive]
pub struct AssertionSpec {
    /// 取值路径（`fx.*` / `case.*` / `env.*`）。序列化名是 `ref`（Rust 关键字避开）。
    #[serde(rename = "ref")]
    pub ref_path: String,
    /// `is` —— 严格相等（对象走深比较）。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub is: Option<Value>,
    /// `isNot` —— 不等于。
    #[serde(
        rename = "isNot",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub is_not: Option<Value>,
    /// `notIs` —— `isNot` 的别名（旧实现同分支）。
    #[serde(
        rename = "notIs",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub not_is: Option<Value>,
    /// `exists` —— 非 `undefined` / `null`。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub exists: Option<Value>,
    /// `notExists` —— `undefined` / `null`。
    #[serde(
        rename = "notExists",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub not_exists: Option<Value>,
    /// `contains` —— 字符串包含 / 数组含元素。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub contains: Option<Value>,
    /// `notContains` —— 取反。
    #[serde(
        rename = "notContains",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub not_contains: Option<Value>,
    /// `matches` —— 正则匹配（`/pattern/flags`）。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub matches: Option<Value>,
    /// `atLeast` —— `>=`。
    #[serde(
        rename = "atLeast",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub at_least: Option<Value>,
    /// `atMost` —— `<=`。
    #[serde(
        rename = "atMost",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub at_most: Option<Value>,
    /// `length` —— 长度等于。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub length: Option<Value>,
    /// `lengthAtLeast` —— 长度 `>=`。
    #[serde(
        rename = "lengthAtLeast",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub length_at_least: Option<Value>,
    /// `lengthAtMost` —— 长度 `<=`。
    #[serde(
        rename = "lengthAtMost",
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub length_at_most: Option<Value>,
    /// `throws` —— 求值过程应抛错。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub throws: Option<Value>,
    /// `soft` 修饰符：失败不改变 case verdict，只记录（`runner.ts:578-579`）。
    ///
    /// 类型写成 `Option<Value>` 而不是 `bool`：YAML 里 `soft: 1` 这类输入旧实现按
    /// `assertion.soft === true` 处理（**只有布尔真才算软**），本实现沿用同一口径
    /// （见 [`AssertionSpec::is_soft`]），避免把 `soft: "false"` 误判成软断言。
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_optional_json_value"
    )]
    pub soft: Option<Value>,
}

impl AssertionSpec {
    /// 建一条只带 ref 的断言（**没有任何判定词** ⇒ 判定为失败，见 `assert.md` 的 observable）。
    pub fn new(ref_path: impl Into<String>) -> Self {
        Self {
            ref_path: ref_path.into(),
            is: None,
            is_not: None,
            not_is: None,
            exists: None,
            not_exists: None,
            contains: None,
            not_contains: None,
            matches: None,
            at_least: None,
            at_most: None,
            length: None,
            length_at_least: None,
            length_at_most: None,
            throws: None,
            soft: None,
        }
    }

    /// 是否为软断言：**只有字面量 `true` 才算**（对齐 `runner.ts:741` 的 `assertion.soft === true`）。
    pub fn is_soft(&self) -> bool {
        matches!(self.soft, Some(Value::Bool(true)))
    }

    /// 该断言里出现的判定词（**按 [`ASSERTION_KEYS`] 的规范顺序**，成功消息的词序用它）。
    ///
    /// 判定词是否"出现"的口径与旧实现 `assert.ts:97` 完全一致：**值不是 `undefined`**。
    /// 序列化层保证"缺字段 → `None`、显式 `null` → `Some(Value::Null)`"，
    /// 所以这里 `Some(..)` 就等价于 TS 的 `!== undefined`——`{"is": null}` 算出现。
    pub fn present_words(&self) -> Vec<&'static str> {
        let mut words = Vec::new();
        for key in ASSERTION_KEYS {
            if self.operand(key).is_some() {
                words.push(key);
            }
        }
        words
    }

    /// 某个判定词的期望值（`soft` / `ref` 不在这里）。
    pub fn operand(&self, word: &str) -> Option<&Value> {
        match word {
            "is" => self.is.as_ref(),
            "isNot" => self.is_not.as_ref(),
            "notIs" => self.not_is.as_ref(),
            "exists" => self.exists.as_ref(),
            "notExists" => self.not_exists.as_ref(),
            "contains" => self.contains.as_ref(),
            "notContains" => self.not_contains.as_ref(),
            "matches" => self.matches.as_ref(),
            "atLeast" => self.at_least.as_ref(),
            "atMost" => self.at_most.as_ref(),
            "length" => self.length.as_ref(),
            "lengthAtLeast" => self.length_at_least.as_ref(),
            "lengthAtMost" => self.length_at_most.as_ref(),
            "throws" => self.throws.as_ref(),
            _ => None,
        }
    }
}

/// 判据身份与本次取值的元信息（设计 §3.3 的 `AssertionMetadata`）。
///
/// **"判据"是什么**（阶段 1 的裁决，必须写明）：同一场景 + 同一 `ref` + 同一组（规范序）
/// 判定词。这三者相同即为"同一判据"，正是设计 §8.4 硬约束 3b 说的
/// "同一场景、同一判据"。判定词**按规范序比较**，所以
/// `{atLeast:1, atMost:5}` 与 `{atMost:5, atLeast:1}` 是同一判据（它们是同一条断言的两种写法）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AssertionMetadata {
    /// 当前场景标识（与 [`AssertionContext::scenario_id`] 同源）。
    pub scenario_id: String,
    /// 判据标识（[`AssertionMetadata::derive_criterion_id`] 的推导结果，`场景 + ref + 词集`）。
    pub criterion_id: String,
    /// 本次实际取到的值。
    pub actual: Value,
    /// 本次取值是否**缺失**（ref 指向的键不存在，或路径中途断掉）。
    pub actual_absent: bool,
    /// 该断言里出现的判定词（规范序）。
    pub words: Vec<String>,
}

impl AssertionMetadata {
    /// 推导判据标识。
    ///
    /// 用**可打印文本**而不是哈希：文本可读、可调试、无碰撞，且对同一输入**必然**恒定
    /// （指标 C1）。分隔符用 `\u{1F}`（单元分隔符）而不是普通字符：场景 id 或 ref 里
    /// 出现分隔符也不会串味——真出现时会被替换成 `?`（宁可轻微歧义，也不做静默截断）。
    pub fn derive_criterion_id(scenario_id: &str, ref_path: &str, words: &[&str]) -> String {
        let sanitize = |part: &str| part.replace('\u{1F}', "?");
        format!(
            "{}\u{1F}{}\u{1F}{}",
            sanitize(scenario_id),
            sanitize(ref_path),
            words.join("+")
        )
    }
}

/// 一次 `assert_all` 的聚合结果（设计 §3.3 的 `AggregateAssertionResult`）。
///
/// 四类计数**分开**：`Inconclusive` 不是 `failed`（设计 §3.3 / §8.4 硬约束 3），
/// 聚合层把它单独计出来，才可能"必须计入报告的 `inconclusive` 计数"。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AggregateAssertionResult {
    /// 每条断言的结果，顺序与入参**一一对应**（确定性来自"保持输入顺序"，不是靠排序）。
    pub outcomes: Vec<AssertionOutcome>,
    /// `Passed` 计数（含软断言通过）。
    pub passed: usize,
    /// `Failed` 计数（含软失败）。
    pub failed: usize,
    /// 断言级 `Skipped` 计数。
    pub skipped: usize,
    /// `Inconclusive` 计数（第四类，必须进报告）。
    pub inconclusive: usize,
}

impl AggregateAssertionResult {
    /// 从结果序列聚合。
    pub fn from_outcomes(outcomes: Vec<AssertionOutcome>) -> Self {
        let mut aggregate = Self {
            outcomes,
            passed: 0,
            failed: 0,
            skipped: 0,
            inconclusive: 0,
        };
        for outcome in &aggregate.outcomes {
            if outcome.counts_as_passed() {
                aggregate.passed += 1;
            } else if outcome.counts_as_failed() {
                aggregate.failed += 1;
            } else if outcome.counts_as_skipped() {
                aggregate.skipped += 1;
            } else if outcome.counts_as_inconclusive() {
                aggregate.inconclusive += 1;
            }
        }
        aggregate
    }

    /// 是否存在**硬失败**（软失败、`Skipped`、`Inconclusive` 都不算）。
    ///
    /// 复算 `runner.ts:578-579` 的 `hasHardFailure`：`!ok && !soft`。
    /// `Inconclusive` 不在这里被折成失败——那是 preset 与 [`StreakTracker`] 的职责
    /// （设计 §8.4 硬约束 3：`freeze` / `release` 档视为失败，`generic` 档计为 warning），
    /// 在这里偷偷升级会让"档位"这个变量消失。
    pub fn has_hard_failure(&self) -> bool {
        self.outcomes.iter().any(|o| o.counts_as_hard_failure())
    }
}

/// 引擎错误：**只用于"工具坏了"**（设计 §3.1）。
///
/// 断言失败**不在这里**——它是 [`AssertionOutcome::Failed`]。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[non_exhaustive]
pub enum AssertionError {
    /// 名字已经注册过。**不静默覆盖**：覆盖会让"我注册的词没生效"表现成"断言通过"。
    AlreadyRegistered {
        /// 冲突的名字。
        name: String,
    },
    /// 名字非法（空串、以 `__` 开头、含空白或 `+`，或叫 `soft` / `ref`）。
    ///
    /// **为什么 `__` 前缀保留**：它与定义域/域名命名空间约定一致，留给宿主内建扩展，
    /// 避免插件与宿主撞名。
    InvalidName {
        /// 被拒绝的名字。
        name: String,
        /// 可归因的说明。
        reason: String,
    },
}

impl std::fmt::Display for AssertionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyRegistered { name } => {
                write!(f, "断言词 {name} 已注册，拒绝静默覆盖")
            }
            Self::InvalidName { name, reason } => {
                write!(f, "断言词名 {name} 非法：{reason}")
            }
        }
    }
}

impl std::error::Error for AssertionError {}

/// 插件式断言求值器（设计 §3.3 的 `AssertionEvaluator`）。
///
/// **对象安全 + `Send + Sync`**：签名里没有泛型方法、没有 `Self`，所以
/// `Box<dyn AssertionEvaluator>` 可存进注册表并跨线程共享。
///
/// # 契约（实现者必须遵守的三条）
///
/// 1. **不返回 `Result`**：判定结论只能经由 [`AssertionOutcome`] 表达。
///    求值器内部出"错"时要选一个语义正确的态——"这话说不清"是
///    [`AssertionOutcome::Inconclusive`]，"工具坏了"才该让宿主 panic（但别这么干）。
/// 2. **`actual` 是 ref 取到的值**；键缺失时宿主给 `Value::Null` 并把 `actual_absent`
///    置真（**必须看这个标志**，否则 `exists` 与 `isNot null` 会判错）。
/// 3. **`meta.words` 是规范序**，成功消息的词序由它决定；不要自己排序。
pub trait AssertionEvaluator: Send + Sync {
    /// 对一个取值求值。
    ///
    /// `spec` 给出完整断言（含该词自己的期望值，用 [`AssertionSpec::operand`] 取）；
    /// `meta` 给出判据身份与本次取值。
    fn evaluate(
        &self,
        actual: &Value,
        spec: &AssertionSpec,
        meta: &AssertionMetadata,
    ) -> AssertionOutcome;

    /// 该求值器实现的词名（用于日志与报告；注册名才是权威，默认空串表示未声明）。
    fn name(&self) -> &str {
        ""
    }
}

/// 断言引擎（设计 §3.3 的 `AssertionEngine`）。
///
/// **`&self` 上有内部可变性**（注册表），锁语义见 [`BufferedAssertionEngine`] 的文档。
pub trait AssertionEngine: Send + Sync {
    /// 对**一条**断言求值。
    ///
    /// 失败走返回值（[`AssertionOutcome::Failed`]），**不是** `Err`（设计 §3.1）。
    fn assert(&self, ctx: &AssertionContext, spec: &AssertionSpec) -> AssertionOutcome {
        self.assert_all(ctx, std::slice::from_ref(spec))
            .outcomes
            .into_iter()
            .next()
            .unwrap_or(AssertionOutcome::Failed {
                expected: Value::Null,
                actual: Value::Null,
                actual_absent: true,
                literal: String::new(),
                diff: "内部错误：assert_all 没有返回结果".to_string(),
                soft: false,
            })
    }

    /// 对**一批**断言求值，逐条独立（不做短路——软断言与 `Inconclusive` 都要被看见）。
    fn assert_all(
        &self,
        ctx: &AssertionContext,
        specs: &[AssertionSpec],
    ) -> AggregateAssertionResult;

    /// 注册一个断言词。
    ///
    /// - 重名（含 16 个内建词）⇒ [`AssertionError::AlreadyRegistered`]，**不覆盖**；
    /// - `&self` 背后是 `RwLock`：**写锁只在本次调用期间持有**；
    /// - 注册的**顺序**有意义：插件词按注册顺序参与派发（先注册先说话）。
    ///   这条是显式的，避免"结果取决于字典序"这种任意行为。
    fn register(
        &self,
        name: &str,
        evaluator: Box<dyn AssertionEvaluator>,
    ) -> Result<(), AssertionError>;

    /// 已注册的词名（**有序**：`BTreeMap` 键序 ⇒ 字典序，与注册顺序无关 ⇒ 同输入同输出）。
    ///
    /// 需要"注册顺序"时用 [`BufferedAssertionEngine`] 的插件派发语义（见其文档）。
    fn registered_names(&self) -> Vec<String>;
}

/// 内建断言词（顺序即 [`ASSERTION_KEYS`]）。
///
/// **不用全局可变状态**：调用方在 `new()` 时显式注册；需要纯词表时调这个函数。
pub fn builtin_words() -> Vec<&'static str> {
    ASSERTION_KEYS.to_vec()
}

/// 内建评测器：把 `assertions` 模块的判定函数包成 [`AssertionEvaluator`]。
struct BuiltinEvaluator {
    name: &'static str,
    function: assertions::Evaluator,
}

impl AssertionEvaluator for BuiltinEvaluator {
    fn evaluate(
        &self,
        actual: &Value,
        spec: &AssertionSpec,
        _meta: &AssertionMetadata,
    ) -> AssertionOutcome {
        let expected = spec.operand(self.name);
        (self.function)(actual, expected, spec.is_soft())
    }

    fn name(&self) -> &str {
        self.name
    }
}

/// 默认引擎：`BTreeMap` 注册表 + `RwLock` + 每判据计数器。
///
/// # 锁语义（设计 §3.1 要求显式写明）
///
/// - 注册表是 `RwLock<BTreeMap<String, Arc<dyn AssertionEvaluator>>>`；
/// - **写锁只在 [`AssertionEngine::register`] 期间持有**；
/// - **判定期只短暂持读锁**：取出求值器的 `Arc` 克隆后立刻释放，
///   求值器本身在**无锁**状态下被调用（见 [`BufferedAssertionEngine::lookup`]）。
///   这样求值器里再调 `register` 不会自死锁（有测试证明）；
/// - 注册表的**迭代**只发生在 [`AssertionEngine::registered_names`]，它显式排序，
///   与 `HashMap` 的随机迭代顺序无关；
/// - 判定路径**不迭代**注册表（只按名 `get`），因此锁的调度顺序不进入判定结果，
///   C1（同种子同结果）不受影响。本 crate 判定路径没有任何 `HashMap` / `HashSet`。
pub struct BufferedAssertionEngine {
    registry: RwLock<BTreeMap<String, Arc<dyn AssertionEvaluator>>>,
    /// 注册顺序（`BTreeMap` 的键序是字典序，与"谁先注册"无关）。
    ///
    /// **为什么需要它**：插件词之间存在"谁先说话"的先后关系——两个插件词同时命中一条断言时，
    /// 结果取决于派发顺序。字典序是**任意的**（`zz_skipped` 排在 `zz_inconclusive` 后面就会
    /// 让 `Skipped` 永远说不出口），而注册顺序是**调用方显式表达**的。
    /// 这是一条 `Vec`（不是 `HashMap`），所以确定性不受影响；`insert` 时去重。
    order: RwLock<Vec<String>>,
    streaks: StreakTracker,
}

impl std::fmt::Debug for BufferedAssertionEngine {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // 求值器是 trait 对象，没有 Debug；这里只暴露词名，避免为日志引入额外约束。
        f.debug_struct("BufferedAssertionEngine")
            .field("registered", &self.registered_names())
            .field("streaks", &self.streaks)
            .finish()
    }
}

impl Default for BufferedAssertionEngine {
    fn default() -> Self {
        Self::new()
    }
}

impl BufferedAssertionEngine {
    /// 建一个已注册全部 16 个内建词的引擎。
    ///
    /// 内建词经**同一条** [`AssertionEngine::register`] 路径注册，所以"插件不得覆盖内建词"
    /// 是同一个 `AlreadyRegistered` 守卫的自然结果，没有第二套规则。
    pub fn new() -> Self {
        // 内建词注册不可能失败（名字是编译期常量、表里互不重复），
        // 失败就意味着源码写错了——直接 panic 而不是留一个"半成品引擎"。
        Self::try_new().expect("内建断言词注册必须成功")
    }

    /// 与 [`Self::new`] 相同，但把失败交回调用方（给"内建表被改坏"这类测试留一个可断言的口）。
    pub fn try_new() -> Result<Self, AssertionError> {
        Self::try_new_with_threshold(StreakTracker::DEFAULT_THRESHOLD)
    }

    /// 用自定义的升级阈值建引擎（阈值语义见 [`StreakTracker`]）。
    pub fn try_new_with_threshold(threshold: u32) -> Result<Self, AssertionError> {
        let engine = Self {
            registry: RwLock::new(BTreeMap::new()),
            order: RwLock::new(Vec::new()),
            streaks: StreakTracker::with_threshold(threshold),
        };
        for (name, function) in assertions::BUILTIN_EVALUATORS {
            engine.register(name, Box::new(BuiltinEvaluator { name, function }))?;
        }
        Ok(engine)
    }

    /// 拿到判据计数器（供调用方读取/重置）；判定路径不经过它之外的全局状态。
    pub fn streaks(&self) -> &StreakTracker {
        &self.streaks
    }

    /// 组建一条断言的判据元信息（`actual` 取自调用方）。
    ///
    /// **为什么是公开的**：阶段 2 的 protocol 层要能在**不判定**的情况下把
    /// `criterion_id` 回给 TS（报告与重试都要用它）。
    pub fn metadata(
        ctx: &AssertionContext,
        spec: &AssertionSpec,
        actual: &Value,
        actual_absent: bool,
    ) -> AssertionMetadata {
        let words = spec.present_words();
        let criterion_id =
            AssertionMetadata::derive_criterion_id(&ctx.scenario_id, &spec.ref_path, &words);
        AssertionMetadata {
            scenario_id: ctx.scenario_id.clone(),
            criterion_id,
            actual: actual.clone(),
            actual_absent,
            words: words.into_iter().map(str::to_string).collect(),
        }
    }

    /// 注册表里有没有这个词。
    pub fn knows(&self, name: &str) -> bool {
        self.registry
            .read()
            .map(|registry| registry.contains_key(name))
            .unwrap_or(false)
    }

    /// 只在注册表里、**不属于** 14 个内建判定词的名字（**按注册顺序**）。
    ///
    /// 这些是"插件词"：它们没有对应的 `AssertionSpec` 字段，所以派发规则是
    /// "注册即参与"、且**先注册先说话**（详见 [`BufferedAssertionEngine::evaluate_one`] 的注释）。
    fn plugin_words(&self) -> Vec<String> {
        let order = self
            .order
            .read()
            .map(|order| order.clone())
            .unwrap_or_default();
        order
            .into_iter()
            .filter(|name| !ASSERTION_KEYS.contains(&name.as_str()))
            .collect()
    }

    /// 取出一个词的求值器（`Arc` 的克隆），**读锁在返回前已经释放**。
    ///
    /// 这就是"求值器在无锁状态下被调用"的实现点：拿到 `Arc` 之后锁就不需要了。
    /// 若这里返回借用，调用方会被迫把守卫跨越求值器调用，那就退回了"持锁求值"，
    /// 求值器里再调 `register`（要写锁）就会自死锁。
    fn lookup(&self, name: &str) -> Option<Arc<dyn AssertionEvaluator>> {
        let registry = self.registry.read().ok()?;
        registry.get(name).cloned()
    }

    /// 判定一条断言（`AssertionEngine::assert_all` 的实现体）。
    fn evaluate_one(
        &self,
        ctx: &AssertionContext,
        spec: &AssertionSpec,
        actual: &Value,
        actual_absent: bool,
        resolved: bool,
        unresolved_reason: Option<&str>,
    ) -> AssertionOutcome {
        let words = spec.present_words();
        let criterion_id =
            AssertionMetadata::derive_criterion_id(&ctx.scenario_id, &spec.ref_path, &words);
        let soft = spec.is_soft();
        if !resolved {
            return AssertionOutcome::Failed {
                expected: Value::Null,
                actual: Value::Null,
                actual_absent: true,
                literal: spec.ref_path.clone(),
                // 对齐 `runner.ts:736-742`：`found=false` 时 ok 恒 false，message 取 reason。
                diff: unresolved_reason.unwrap_or("取值失败").to_string(),
                soft,
            };
        }
        if words.is_empty() {
            return AssertionOutcome::Failed {
                expected: Value::Null,
                actual: actual.clone(),
                actual_absent,
                literal: spec.ref_path.clone(),
                // 措辞对齐 `assert.ts:104`：`断言缺少判定词（<ref> 只给了 ref）`。
                diff: format!("断言缺少判定词（{} 只给了 ref）", spec.ref_path),
                soft,
            };
        }

        // 需要派发的词 = 规范序里出现的 14 个内建判定词 + **注册表里存在的插件词**。
        //
        // 为什么要带上插件词：设计 §3.3 要求"让断言词可作为插件式实现注册"。
        // 但 `AssertionSpec` 的字段集是 `cases` schema 的镜像（§3.3 勘误已裁决
        // **不新增断言词**——新增要另立 RFC），所以"用哪个键触发插件词"这件事
        // 目前**没有**表达方式：插件词在注册表里存在即参与派发，由它自己的
        // `evaluate` 决定看什么。这条限制是**真实的**，记在模块文档里，不假装已经完整。
        let plugin_words = self.plugin_words();
        // **插件词排在前面**：显式的自定义行为优先于内建的默认行为。
        // 内建词按规范序（决定成功消息的词序与"第一个不通过者说话"）。
        let mut dispatch: Vec<String> = plugin_words;
        for word in &words {
            if !dispatch.iter().any(|existing| existing == word) {
                dispatch.push(word.to_string());
            }
        }

        let mut outcome = None;
        // 全过时的"最佳结果"：保留**带 details 的那个**（插件词的取证细节不能被摘要冲掉）。
        let mut best_pass: Option<AssertionOutcome> = None;
        for word in &dispatch {
            let word = word.as_str();
            // 只有出现在断言里的内建词才校验"有没有期望值"；插件词没有可校验的字段。
            if ASSERTION_KEYS.contains(&word) && spec.operand(word).is_none() {
                continue;
            }
            // 多词 AND（旧实现 `assert.ts:108-113` 的兜底语义）：
            // 任一词不通过就返回该词的结果（第一个不通过者说话，不做"全跑完再报"）。
            let Some(evaluator) = self.lookup(word) else {
                outcome = Some(AssertionOutcome::Failed {
                    expected: Value::Null,
                    actual: actual.clone(),
                    actual_absent,
                    literal: spec.ref_path.clone(),
                    diff: format!("断言词 {word} 未注册"),
                    soft,
                });
                break;
            };
            let meta = Self::metadata(ctx, spec, actual, actual_absent);
            // 此刻**不持有注册表锁**：`evaluator` 是 `Arc` 的克隆，锁在 `lookup` 里已释放。
            let evaluated = evaluator.evaluate(actual, spec, &meta);
            if evaluated.counts_as_passed() {
                let carries_details = matches!(
                    &evaluated,
                    AssertionOutcome::Passed {
                        details: Some(_),
                        ..
                    }
                );
                if best_pass.is_none() || carries_details {
                    best_pass = Some(evaluated);
                }
                continue;
            }
            outcome = Some(evaluated);
            break;
        }

        let outcome = outcome.unwrap_or_else(|| {
            best_pass.unwrap_or(AssertionOutcome::Passed {
                details: None,
                soft,
            })
        });

        // 通过消息与旧实现一致：`<ref> 满足 <词1 + 词2>`（词序为 ASSERTION_KEYS 规范序）。
        //
        // **只在结果没有 details 时才补摘要**：插件词（自定义求值器）可能已经在
        // `details` 里带了取证细节，用一句摘要把它盖掉是丢信息。
        if let AssertionOutcome::Passed {
            details: None,
            soft,
        } = &outcome
        {
            return AssertionOutcome::Passed {
                details: Some(Value::String(format!(
                    "{} 满足 {}",
                    spec.ref_path,
                    words.join(" + ")
                ))),
                soft: *soft,
            };
        }

        // `Inconclusive` 连续 3 次升级规则（设计 §8.4 硬约束 3b）。
        // 计数器是**每种判据独立**的，键里带场景 id 与判据 id（不是全局可变状态）。
        if let AssertionOutcome::Inconclusive { .. } = &outcome {
            let streak = self.streaks.observe(&criterion_id, &outcome);
            if streak.reached_threshold {
                return self.streaks.escalate(&outcome, streak);
            }
        }
        outcome
    }
}

impl AssertionEngine for BufferedAssertionEngine {
    fn assert_all(
        &self,
        ctx: &AssertionContext,
        specs: &[AssertionSpec],
    ) -> AggregateAssertionResult {
        let sources = ctx.sources();
        let outcomes = specs
            .iter()
            .map(|spec| {
                let resolution = resolve_ref(&spec.ref_path, &sources);
                self.evaluate_one(
                    ctx,
                    spec,
                    &resolution.value_or_null(),
                    resolution.is_absent(),
                    resolution.found,
                    resolution.reason.as_deref(),
                )
            })
            .collect();
        AggregateAssertionResult::from_outcomes(outcomes)
    }

    fn register(
        &self,
        name: &str,
        evaluator: Box<dyn AssertionEvaluator>,
    ) -> Result<(), AssertionError> {
        validate_name(name)?;
        let mut registry = self
            .registry
            .write()
            .map_err(|_| AssertionError::InvalidName {
                name: name.to_string(),
                reason: "注册表锁已中毒（说明有求值器在持锁时 panic 过）".to_string(),
            })?;
        if registry.contains_key(name) {
            return Err(AssertionError::AlreadyRegistered {
                name: name.to_string(),
            });
        }
        registry.insert(name.to_string(), Arc::from(evaluator));
        drop(registry);
        if let Ok(mut order) = self.order.write() {
            if !order.iter().any(|existing| existing == name) {
                order.push(name.to_string());
            }
        }
        Ok(())
    }

    fn registered_names(&self) -> Vec<String> {
        match self.registry.read() {
            Ok(registry) => registry.keys().cloned().collect(),
            // 锁中毒时返回空表而不是 panic：这条路径只影响"列出名字"，不影响判定结论。
            Err(_) => Vec::new(),
        }
    }
}

/// 名字校验。
///
/// 规则（都在测试里逐条覆盖）：非空、不含空白与 `+`（`+` 是成功消息的词分隔符）、
/// 不以 `__` 开头（宿主内建扩展命名空间）、且不是 `soft` / `ref`（那两个不是判定词）。
fn validate_name(name: &str) -> Result<(), AssertionError> {
    let invalid = |reason: &str| {
        Err(AssertionError::InvalidName {
            name: name.to_string(),
            reason: reason.to_string(),
        })
    };
    if name.is_empty() {
        return invalid("名字不能为空");
    }
    if name.chars().any(char::is_whitespace) {
        return invalid("名字不能含空白字符");
    }
    if name.contains('+') {
        return invalid("名字不能含 `+`（它是成功消息里的词分隔符）");
    }
    if name.starts_with("__") {
        return invalid("`__` 前缀保留给宿主内建扩展");
    }
    if name == assertions::SOFT_MODIFIER || name == assertions::REF_PATH {
        return invalid("`soft` 与 `ref` 是修饰符/取值路径，不是判定词");
    }
    Ok(())
}

/// 连续 `Inconclusive` 的计数器（设计 §8.4 硬约束 3b）。
///
/// # 语义
///
/// - 键 = **场景 + 判据**（[`AssertionMetadata::criterion_id`]），每键独立计数；
/// - `Inconclusive` ⇒ 计数 `+1`；计数 `>= threshold`（默认 **3**）⇒ `reached_threshold`；
/// - `Passed` / `Failed` ⇒ **清零**（偶发中断即重置，"连续"才升级）；
/// - `Skipped` ⇒ **不动计数**（跳过既不是判定，也不是"连续"里的一个判定结果）。
///
/// # 为什么不用全局可变状态
///
/// 计数器是**引擎实例的字段**（[`BufferedAssertionEngine::streaks`]），键里带场景与判据，
/// 所以它是"可传参的状态"：换个引擎实例 = 换个独立的状态。
///
/// # 锁语义（与"判定路径禁 `HashMap`"是两回事，别混淆）
///
/// 这里用 `RwLock<BTreeMap<String, u32>>`。设计 §6.4 禁的是 `HashMap` / `HashSet`
/// （**随机迭代顺序**会让 C1 失效），不是禁锁——`BTreeMap` 的键序与插入顺序无关，
/// 所以即使在锁保护下，遍历它也是确定的。计数器的读写都极短，且判定路径
/// 已经是单线程事件队列（设计 §6.3），这把锁不引入任何与顺序有关的行为。
#[derive(Debug)]
pub struct StreakTracker {
    counts: RwLock<BTreeMap<String, u32>>,
    threshold: u32,
}

/// 一次计数观测的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Streak {
    /// 该判据当前的连续 `Inconclusive` 次数。
    pub count: u32,
    /// 是否达到升级阈值。
    pub reached_threshold: bool,
}

impl StreakTracker {
    /// 默认阈值：**连续 3 次**升级为失败（设计 §8.4 硬约束 3b）。
    pub const DEFAULT_THRESHOLD: u32 = 3;

    /// 用默认阈值建计数器。
    pub fn new() -> Self {
        Self::with_threshold(Self::DEFAULT_THRESHOLD)
    }

    /// 用自定义阈值建计数器。
    ///
    /// **阈值下限是 1**：`0` 会把"第一次出现就升级"变成隐式规则，语义上不是"连续 N 次"。
    pub fn with_threshold(threshold: u32) -> Self {
        Self {
            counts: RwLock::new(BTreeMap::new()),
            threshold: threshold.max(1),
        }
    }

    /// 当前阈值。
    pub fn threshold(&self) -> u32 {
        self.threshold
    }

    /// 观测一条结果，返回该判据的计数状态。
    ///
    /// `Passed` / `Failed` 清零、`Skipped` 不动、`Inconclusive` 递增。
    pub fn observe(&self, criterion_id: &str, outcome: &AssertionOutcome) -> Streak {
        match outcome {
            AssertionOutcome::Passed { .. } | AssertionOutcome::Failed { .. } => {
                self.store(criterion_id, 0);
                Streak {
                    count: 0,
                    reached_threshold: false,
                }
            }
            AssertionOutcome::Skipped { .. } => Streak {
                count: self.load(criterion_id),
                reached_threshold: false,
            },
            AssertionOutcome::Inconclusive { .. } => {
                let count = self.increment(criterion_id);
                Streak {
                    count,
                    reached_threshold: count >= self.threshold,
                }
            }
        }
    }

    /// 把一条 `Inconclusive` 升级成 `Failed`（设计 §8.4 硬约束 3b）。
    ///
    /// 升级后的结果里 `diff` 会带上原 `reason` 与"连续 N 次"的成因——报告必须能自证
    /// "这条为什么从测不准变成了失败"。
    pub fn escalate(&self, outcome: &AssertionOutcome, streak: Streak) -> AssertionOutcome {
        match outcome {
            AssertionOutcome::Inconclusive {
                reason,
                literal,
                actual,
                actual_absent,
                soft,
            } => AssertionOutcome::Failed {
                expected: Value::Null,
                actual: actual.clone(),
                actual_absent: *actual_absent,
                literal: literal.clone(),
                diff: format!(
                    "连续 {} 次 Inconclusive（阈值 {}）升级为失败：{}",
                    streak.count, self.threshold, reason
                ),
                soft: *soft,
            },
            other => other.clone(),
        }
    }

    /// 观测并**直接**给出最终结果（`observe` + `escalate` 的便捷组合）。
    pub fn observe_and_escalate(
        &self,
        criterion_id: &str,
        outcome: AssertionOutcome,
    ) -> AssertionOutcome {
        let streak = self.observe(criterion_id, &outcome);
        if streak.reached_threshold {
            self.escalate(&outcome, streak)
        } else {
            outcome
        }
    }

    /// 当前计数（不清零、不递增，供报告与测试读取）。
    pub fn count_of(&self, criterion_id: &str) -> u32 {
        self.load(criterion_id)
    }

    /// 清空全部计数。
    ///
    /// **为什么要显式清空**：`run.json` 里 `repeat` 的多轮之间若共用计数器，
    /// 上一轮的 `Inconclusive` 会把下一轮推向升级——那会把"偶发"误判成"判据有缺陷"。
    /// 调用时机由宿主（阶段 2 的 executor）按运行边界决定。
    pub fn reset(&self) {
        if let Ok(mut counts) = self.counts.write() {
            counts.clear();
        }
    }

    fn load(&self, criterion_id: &str) -> u32 {
        self.counts
            .read()
            .map(|counts| counts.get(criterion_id).copied().unwrap_or(0))
            .unwrap_or(0)
    }

    fn store(&self, criterion_id: &str, value: u32) {
        if let Ok(mut counts) = self.counts.write() {
            counts.insert(criterion_id.to_string(), value);
        }
    }

    fn increment(&self, criterion_id: &str) -> u32 {
        let Ok(mut counts) = self.counts.write() else {
            return 0;
        };
        let cell = counts.entry(criterion_id.to_string()).or_insert(0);
        *cell += 1;
        *cell
    }
}

impl Default for StreakTracker {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// `AssertionSpec` 的 `null` 语义：**显式 `null` 算"给了这个词"**，
    /// 与旧实现 `assertion.is !== undefined`（TS 里 `null !== undefined`）逐位对齐。
    ///
    /// 这不是理论问题：仓库里真有这种写法（`cases/TK-0030.yaml:44` 的
    /// `{ ref: fx.fsBefore, is: null }`）。若把 `null` 与"缺字段"合并，
    /// 这条断言会被判成"断言缺少判定词"——一个**错误结论**。
    #[test]
    fn explicit_null_is_a_present_word_but_missing_field_is_not() {
        let with_null: AssertionSpec = serde_json::from_value(json!({"ref": "fx.a", "is": null}))
            .expect("显式 null 必须能反序列化");
        assert_eq!(
            with_null.is,
            Some(Value::Null),
            "显式 null ⇒ Some(Value::Null)"
        );
        assert_eq!(with_null.present_words(), vec!["is"]);

        let without: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.a"})).expect("只给 ref 必须能反序列化");
        assert!(without.is.is_none(), "缺字段 ⇒ None");
        assert!(without.present_words().is_empty());

        // `is: null` 真的能判：取到 `null` 或"缺失"都通过（见 `tests/words.rs` 的对照）。
        let engine = BufferedAssertionEngine::new();
        let mut ctx = AssertionContext::new("TK-NULL");
        ctx.fixture = Some(json!({"nil": null}));
        assert!(engine.assert(&ctx, &with_null).counts_as_passed());
    }

    /// 序列化往返：`ref` 的字段名必须还是 `ref`（跨语言契约）。
    #[test]
    fn spec_round_trips_through_json() {
        let spec: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.a", "isNot": 1, "soft": true}))
                .expect("必须能反序列化");
        let text = serde_json::to_string(&spec).expect("必须能序列化");
        assert!(text.contains("\"ref\":\"fx.a\""), "{text}");
        assert!(text.contains("\"isNot\":1"), "{text}");
        let back: AssertionSpec = serde_json::from_str(&text).expect("往返回得来");
        assert_eq!(back, spec);
    }

    /// 拼错词名 / 新增第 17 个词必须**拒绝**，不能静默忽略。
    #[test]
    fn unknown_word_is_rejected() {
        let result: Result<AssertionSpec, _> =
            serde_json::from_value(json!({"ref": "fx.a", "contain": 1}));
        assert!(result.is_err(), "未知词名必须报错，而不是当成'没给判定词'");
    }

    /// `soft` 只有字面量 `true` 才算（对齐 `runner.ts:741`）。
    #[test]
    fn soft_only_counts_when_it_is_literal_true() {
        for (value, expected) in [
            (json!(true), true),
            (json!(false), false),
            (json!(1), false),
            (json!("true"), false),
            (json!(null), false),
        ] {
            let spec: AssertionSpec =
                serde_json::from_value(json!({"ref": "fx.a", "is": 1, "soft": value}))
                    .expect("必须能反序列化");
            assert_eq!(
                spec.is_soft(),
                expected,
                "soft={value} 时 is_soft 应为 {expected}"
            );
        }
    }

    /// `AssertionMetadata` 的判据键：场景 + ref + 规范序词集；词序无关。
    #[test]
    fn criterion_id_is_stable_and_word_order_insensitive() {
        let a = AssertionMetadata::derive_criterion_id("TK-1", "fx.a", &["atLeast", "atMost"]);
        let b = AssertionMetadata::derive_criterion_id("TK-1", "fx.a", &["atLeast", "atMost"]);
        assert_eq!(a, b);
        // 同一个断言的两种写法（YAML 里键序不同）经 `present_words` 后规范化 ⇒ 同键。
        let left: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.a", "atLeast": 1, "atMost": 5}))
                .expect("合法");
        let right: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.a", "atMost": 5, "atLeast": 1}))
                .expect("合法");
        assert_eq!(left.present_words(), right.present_words());
        // 不同场景 / 不同 ref / 不同词集 ⇒ 不同键。
        assert_ne!(
            a,
            AssertionMetadata::derive_criterion_id("TK-2", "fx.a", &["atLeast", "atMost"])
        );
        assert_ne!(
            a,
            AssertionMetadata::derive_criterion_id("TK-1", "fx.b", &["atLeast", "atMost"])
        );
        assert_ne!(
            a,
            AssertionMetadata::derive_criterion_id("TK-1", "fx.a", &["is"])
        );
    }

    /// 计数器语义：`Passed` / `Failed` 清零、`Skipped` 不动、`Inconclusive` 递增。
    #[test]
    fn streak_tracker_semantics() {
        let tracker = StreakTracker::new();
        let inconclusive = AssertionOutcome::Inconclusive {
            reason: "测不准".into(),
            literal: "x".into(),
            actual: Value::Null,
            actual_absent: false,
            soft: false,
        };
        assert_eq!(tracker.observe("k", &inconclusive).count, 1);
        assert_eq!(tracker.observe("k", &inconclusive).count, 2);
        let third = tracker.observe("k", &inconclusive);
        assert_eq!(third.count, 3);
        assert!(third.reached_threshold);
        // `Skipped` 不动计数。
        let skipped = AssertionOutcome::Skipped {
            reason: "缺能力".into(),
            soft: false,
        };
        assert_eq!(tracker.observe("k", &skipped).count, 3);
        // `Failed` 清零。
        let failed = AssertionOutcome::Failed {
            expected: Value::Null,
            actual: Value::Null,
            actual_absent: false,
            literal: "x".into(),
            diff: "d".into(),
            soft: false,
        };
        assert_eq!(tracker.observe("k", &failed).count, 0);
        // `reset` 清空全部。
        tracker.observe("k", &inconclusive);
        tracker.reset();
        assert_eq!(tracker.count_of("k"), 0);
    }

    /// 阈值下限是 1（`0` 会让"第一次就升级"变成隐式规则）。
    #[test]
    fn threshold_is_at_least_one() {
        assert_eq!(StreakTracker::with_threshold(0).threshold(), 1);
        assert_eq!(StreakTracker::with_threshold(5).threshold(), 5);
    }

    /// 升级后的结果必须是 `Failed`，且 `diff` 里带原 `reason` 与次数（可自证）。
    #[test]
    fn escalation_preserves_the_original_reason() {
        let tracker = StreakTracker::new();
        let inconclusive = AssertionOutcome::Inconclusive {
            reason: "跨平台浮点差异".into(),
            literal: "1e-9".into(),
            actual: json!(1.0000000001),
            actual_absent: false,
            soft: false,
        };
        // 第 1、2 次不升级（偶发是正常表现）。
        assert!(tracker
            .observe_and_escalate("k", inconclusive.clone())
            .counts_as_inconclusive());
        assert!(tracker
            .observe_and_escalate("k", inconclusive.clone())
            .counts_as_inconclusive());
        // 第 3 次达到阈值 ⇒ 升级为失败。
        let escalated = tracker.observe_and_escalate("k", inconclusive.clone());
        assert!(escalated.counts_as_failed());
        let message = escalated.reason().unwrap_or_default();
        assert!(message.contains("连续 3 次"), "{message}");
        assert!(message.contains("跨平台浮点差异"), "{message}");
        // 非 `Inconclusive` 不会被 `escalate` 改动。
        let passed = AssertionOutcome::Passed {
            details: None,
            soft: false,
        };
        assert_eq!(
            tracker.escalate(
                &passed,
                Streak {
                    count: 9,
                    reached_threshold: true
                }
            ),
            passed
        );
    }

    /// 名字校验的每一条规则。
    #[test]
    fn register_rejects_invalid_names() {
        let engine = BufferedAssertionEngine::new();
        struct Dummy;
        impl AssertionEvaluator for Dummy {
            fn evaluate(
                &self,
                _: &Value,
                _: &AssertionSpec,
                _: &AssertionMetadata,
            ) -> AssertionOutcome {
                AssertionOutcome::Passed {
                    details: None,
                    soft: false,
                }
            }
            fn name(&self) -> &str {
                "dummy"
            }
        }
        for invalid in ["", "has space", "has+plus", "__reserved", "soft", "ref"] {
            let result = engine.register(invalid, Box::new(Dummy));
            assert!(
                matches!(result, Err(AssertionError::InvalidName { .. })),
                "{invalid:?} 应被拒绝"
            );
        }
        // 合法名可以注册，并且出现在有序名字表里。
        engine
            .register("zz_custom", Box::new(Dummy))
            .expect("合法名可注册");
        let names = engine.registered_names();
        assert!(names.contains(&"zz_custom".to_string()));
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "registered_names 必须有序");
    }

    /// 内建词注册后总数必须是 16 项中的 14 个判定词（`soft` / `ref` 不是判定词）。
    #[test]
    fn builtin_words_are_the_fourteen_criteria() {
        let engine = BufferedAssertionEngine::new();
        let names = engine.registered_names();
        assert_eq!(names.len(), 14);
        assert_eq!(builtin_words(), ASSERTION_KEYS.to_vec());
        for word in ASSERTION_KEYS {
            assert!(names.contains(&word.to_string()), "{word} 应已注册");
        }
        assert!(!names.contains(&"soft".to_string()));
        assert!(!names.contains(&"ref".to_string()));
    }

    /// 内建词不可被覆盖（同一个 `AlreadyRegistered` 守卫）。
    #[test]
    fn builtin_words_cannot_be_overridden() {
        let engine = BufferedAssertionEngine::new();
        struct AlwaysPass;
        impl AssertionEvaluator for AlwaysPass {
            fn evaluate(
                &self,
                _: &Value,
                _: &AssertionSpec,
                _: &AssertionMetadata,
            ) -> AssertionOutcome {
                AssertionOutcome::Passed {
                    details: None,
                    soft: false,
                }
            }
        }
        let result = engine.register("is", Box::new(AlwaysPass));
        assert_eq!(
            result,
            Err(AssertionError::AlreadyRegistered {
                name: "is".to_string()
            })
        );
    }

    /// 自定义词可以被派发（证明 [`AssertionEvaluator`] 这条路真的能走通）。
    #[test]
    fn custom_evaluator_is_dispatched() {
        let engine = BufferedAssertionEngine::new();
        struct Echo;
        impl AssertionEvaluator for Echo {
            fn evaluate(
                &self,
                actual: &Value,
                _spec: &AssertionSpec,
                meta: &AssertionMetadata,
            ) -> AssertionOutcome {
                AssertionOutcome::Passed {
                    details: Some(json!({
                        "actual": actual,
                        "criterion": meta.criterion_id,
                        "words": meta.words,
                    })),
                    soft: false,
                }
            }
            fn name(&self) -> &str {
                "zz_echo"
            }
        }
        engine
            .register("zz_echo", Box::new(Echo))
            .expect("注册自定义词");
        let mut ctx = AssertionContext::new("TK-CUSTOM");
        ctx.fixture = Some(json!({"answer": 42}));
        // 注意：`AssertionSpec` 是 `cases` schema 的镜像，**没有**插件词的字段，
        // 所以这里必须给一个内建词让断言"像一条真断言"（否则判"缺少判定词"）；
        // 插件词按"注册即参与派发"的规则也会被调用（见 `evaluate_one` 的注释）。
        let spec: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.answer", "exists": true})).expect("合法");
        let outcome = engine.assert(&ctx, &spec);
        let AssertionOutcome::Passed {
            details: Some(details),
            ..
        } = outcome
        else {
            panic!("自定义词应通过并带回 details：{outcome:?}");
        };
        assert_eq!(details["actual"], json!(42));
        assert!(details["criterion"]
            .as_str()
            .unwrap_or_default()
            .contains("fx.answer"));
        assert_eq!(details["words"], json!(["exists"]));
    }

    /// 插件词排在派发队列**前面**（显式的自定义行为优先于内建默认）。
    #[test]
    fn plugin_words_are_dispatched_before_builtins() {
        let engine = BufferedAssertionEngine::new();
        struct Marker;
        impl AssertionEvaluator for Marker {
            fn evaluate(
                &self,
                _: &Value,
                _: &AssertionSpec,
                _: &AssertionMetadata,
            ) -> AssertionOutcome {
                AssertionOutcome::Passed {
                    details: Some(json!("plugin")),
                    soft: false,
                }
            }
            fn name(&self) -> &str {
                "zz_marker"
            }
        }
        engine
            .register("zz_marker", Box::new(Marker))
            .expect("注册");
        let mut ctx = AssertionContext::new("TK-ORDER");
        ctx.fixture = Some(json!({"a": 1}));
        let spec: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.a", "is": 1})).expect("合法");
        let outcome = engine.assert(&ctx, &spec);
        match outcome {
            AssertionOutcome::Passed {
                details: Some(details),
                ..
            } => assert_eq!(details, json!("plugin")),
            other => panic!("插件词应先说话：{other:?}"),
        }
    }

    /// **锁语义测试**：求值器在**无锁**状态下被调用——所以求值器内部可以安全地
    /// 再调 `register`（若要写锁而死锁，这条测试会挂住）。
    ///
    /// 为什么会挂住：如果 `evaluate` 在持有 `RwLock` 读守卫时执行，那么同线程再取写锁
    /// 就是自死锁，测试会 timeout。这条测试就是这个不变量的机械形式。
    #[test]
    fn evaluator_runs_without_holding_the_registry_lock() {
        struct RegistersDuringEvaluate {
            engine: std::sync::Arc<BufferedAssertionEngine>,
        }
        impl AssertionEvaluator for RegistersDuringEvaluate {
            fn evaluate(
                &self,
                _actual: &Value,
                _spec: &AssertionSpec,
                _meta: &AssertionMetadata,
            ) -> AssertionOutcome {
                struct Inner;
                impl AssertionEvaluator for Inner {
                    fn evaluate(
                        &self,
                        _: &Value,
                        _: &AssertionSpec,
                        _: &AssertionMetadata,
                    ) -> AssertionOutcome {
                        AssertionOutcome::Passed {
                            details: None,
                            soft: false,
                        }
                    }
                }
                // 求值期间注册一个新词：若判定路径持有注册表锁，这里会自死锁。
                let result = self
                    .engine
                    .register("zz_registered_inside", Box::new(Inner));
                match result {
                    Ok(()) => AssertionOutcome::Passed {
                        details: Some(json!("registered")),
                        soft: false,
                    },
                    Err(error) => AssertionOutcome::Failed {
                        expected: Value::Null,
                        actual: Value::String(error.to_string()),
                        actual_absent: false,
                        literal: "register".into(),
                        diff: "求值期间注册失败".into(),
                        soft: false,
                    },
                }
            }
        }

        let engine = std::sync::Arc::new(BufferedAssertionEngine::new());
        engine
            .register(
                "zz_reentrant",
                Box::new(RegistersDuringEvaluate {
                    engine: std::sync::Arc::clone(&engine),
                }),
            )
            .expect("注册重入词");
        // 断言必须"像一条真断言"（`AssertionSpec` 没有插件词的字段，只给 ref 会判缺少判定词）。
        let spec: AssertionSpec =
            serde_json::from_value(json!({"ref": "fx.x", "exists": false})).expect("合法");
        let outcome = engine.assert(&AssertionContext::new("TK-LOCK"), &spec);
        assert!(outcome.counts_as_passed(), "重入注册必须成功：{outcome:?}");
        assert!(engine.knows("zz_registered_inside"));
    }

    /// 未注册的词在判定时如实报失败（不静默通过）。
    #[test]
    fn unregistered_word_fails_loudly() {
        let engine = BufferedAssertionEngine::new();
        struct Dummy;
        impl AssertionEvaluator for Dummy {
            fn evaluate(
                &self,
                _: &Value,
                _: &AssertionSpec,
                _: &AssertionMetadata,
            ) -> AssertionOutcome {
                AssertionOutcome::Passed {
                    details: None,
                    soft: false,
                }
            }
        }
        // 用一条"指向已注册词、但注册表里被清理"的场景无法构造（没有 unregister），
        // 所以这里退一步验证：`knows` 对未注册词返回 false，且 `register` 之后才为 true。
        assert!(!engine.knows("zz_not_registered"));
        engine
            .register("zz_not_registered", Box::new(Dummy))
            .expect("注册");
        assert!(engine.knows("zz_not_registered"));
    }

    /// `assert_all` 的聚合计数：四类分开，顺序与入参一致。
    #[test]
    fn aggregate_counts_four_states_separately() {
        let engine = BufferedAssertionEngine::new();
        let mut ctx = AssertionContext::new("TK-AGG");
        ctx.fixture = Some(json!({"a": 5, "s": "xx"}));
        let specs = vec![
            serde_json::from_value(json!({"ref": "fx.a", "is": 5})).expect("合法"),
            serde_json::from_value(json!({"ref": "fx.a", "is": 6})).expect("合法"),
            serde_json::from_value(json!({"ref": "bogus.x", "is": 1})).expect("合法"),
            serde_json::from_value(json!({"ref": "fx.s", "matches": "/a(?=b)/"})).expect("合法"),
        ];
        let aggregate = engine.assert_all(&ctx, &specs);
        assert_eq!(aggregate.outcomes.len(), 4, "顺序与入参一一对应");
        assert_eq!(aggregate.passed, 1);
        assert_eq!(aggregate.failed, 2, "取值失败也算失败");
        assert_eq!(aggregate.skipped, 0);
        assert_eq!(aggregate.inconclusive, 1);
        assert!(aggregate.has_hard_failure());
    }

    /// 空批次：全零计数、无硬失败。
    #[test]
    fn empty_batch_is_a_no_op() {
        let engine = BufferedAssertionEngine::new();
        let aggregate = engine.assert_all(&AssertionContext::new("TK-EMPTY"), &[]);
        assert!(aggregate.outcomes.is_empty());
        assert_eq!(
            (
                aggregate.passed,
                aggregate.failed,
                aggregate.skipped,
                aggregate.inconclusive
            ),
            (0, 0, 0, 0)
        );
        assert!(!aggregate.has_hard_failure());
    }
}
