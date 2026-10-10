//! `assertion` —— 断言引擎（`AssertionEngine`）。
//!
//! **真源**：`docs/REWRITE-DESIGN.md` §3.3；行为规格 `spec/behaviors/engine/assert.md`；
//! 断言词语义 `docs/SCENARIO-SPEC.md` §2.5。
//!
//! **这是"判定移出 TS"的落点**（RFC 0001 决定 1）：TS 侧可以拒绝（编译期校验失败），
//! 但**不可以**决定"这条断言过没过"。
//!
//! **两条设计约束必须保留**：
//! 1. 断言失败**不是** `Result::Err`，是正常结果（设计 §3.1）。否则 `?` 会把
//!    "被测对象失败"和"工具坏了"混在一起——`Result` 只留给 [`AssertionEngine::register`]
//!    的重名冲突这类"工具坏了"。
//! 2. 判定路径上**禁止** `std::collections::HashMap` / `HashSet`（设计 §6.4 硬纪律）——
//!    它们的迭代顺序每次运行都不同，会让"同种子同结果"（指标 C1）当场失效。
//!    本 crate 一律用 `BTreeMap` / `BTreeSet` / `Vec`；`BTreeSet` 只在正则引擎内部
//!    表示"结束位置集合"（有序，且它的消费方只做顺序无关的并集/包含判断）。
//!
//! # 模块结构
//!
//! | 模块 | 内容 |
//! |---|---|
//! | [`core`] | 四态结果 [`AssertionOutcome`]、深比较、类型名、长度提取 |
//! | [`refs`] | `ref` 取值路径（`fx` / `case` / `env` 前缀与 fx 容器纪律） |
//! | [`matching`] | `matches` 的正则支持（`/pattern/flags` 解析 + 最小 JS 子集引擎） |
//! | [`assertions`] | 16 个断言词（14 判定词 + `soft` + `ref`）的逐词判定 |
//! | [`engine`] | [`AssertionEngine`] / [`AssertionEvaluator`]、注册表、`Inconclusive` 升级 |
//!
//! # 快速上手
//!
//! ```
//! use dsh_testkit_assertion::{
//!     AssertionContext, AssertionEngine, AssertionOutcome, AssertionSpec, BufferedAssertionEngine,
//! };
//! use serde_json::json;
//!
//! let engine = BufferedAssertionEngine::new();
//!
//! let mut ctx = AssertionContext::new("TK-0001");
//! ctx.fixture = Some(json!({ "a": { "b": [1, 2] } }));
//!
//! // 1) `fx` 是"存在的容器"：没记过的键取到"缺失"，于是 `exists:false` 是合法表达。
//! let spec: AssertionSpec = serde_json::from_value(json!({
//!     "ref": "fx.neverNoted",
//!     "exists": false,
//! }))?;
//! assert!(matches!(
//!     engine.assert(&ctx, &spec),
//!     AssertionOutcome::Passed { .. }
//! ));
//!
//! // 2) 判定失败是**结果**（`Failed`），不是 `Err`。
//! let spec: AssertionSpec = serde_json::from_value(json!({
//!     "ref": "fx.a.b[0]",
//!     "is": 1,
//! }))?;
//! assert!(engine.assert(&ctx, &spec).counts_as_passed());
//! let spec: AssertionSpec = serde_json::from_value(json!({
//!     "ref": "fx.a.b[0]",
//!     "is": 2,
//! }))?;
//! let outcome = engine.assert(&ctx, &spec);
//! assert!(outcome.counts_as_failed());
//! assert_eq!(outcome.reason(), Some("期望 is 2，实际 1"));
//! # Ok::<(), serde_json::Error>(())
//! ```
//!
//! # 阶段 1 落地的范围与**明确的限制**（不许含糊）
//!
//! - 16 个断言词**全部实现**，逐词有测试（见 `crates/assertion/tests/`）。
//! - 四态齐备：`Passed` / `Failed` / `Skipped` / `Inconclusive`。四态与既有 TS 实现
//!   （只有 `ok: boolean` 两态）的差异逐条记在 [`AssertionOutcome`] 的文档里。
//! - `Inconclusive` 连续 3 次升级为失败由 [`StreakTracker`] 承担（设计 §8.4 硬约束 3b），
//!   状态**可传参**（引擎实例字段 + 判据键），不是全局可变状态。
//! - `matches` 用**手写的最小 JS 子集引擎**而非 `regex` crate：本 crate 的依赖受
//!   RFC 0001 §7 停止线约束，新增依赖需评审。不支持的构造（lookahead / 反向引用 /
//!   `u` 旗标…）一律判 `Inconclusive`，**绝不猜**。理由与边界见 [`matching`]。
//! - `throws` 的判据**强于**旧实现（旧实现是恒 false / 恒 true 的空壳），但**弱于**
//!   `SCENARIO-SPEC.md:388` 的完整语义：本 crate 看不到"driver 观察到的异常"，
//!   所以用"取值是否缺失"近似。阶段 2 应把它升级成一等输入（需 RFC）。见 [`assertions`]。
//! - **插件词的派发面是不完整的**：[`AssertionSpec`] 的字段是 `cases` schema 的镜像
//!   （`deny_unknown_fields`），所以**没有办法在断言里指名一个插件词**。
//!   现行规则是"**注册即参与派发，先注册先说话**"——它能跑通设计 §3.3 要求的
//!   "可插件式注册"，但一个插件词会对**每一条**断言都被调用。
//!   要把它做成真正的插件面（`AssertionSpec` 带扩展字段），需要另立 RFC
//!   （那会改动 `cases` schema 语义）。这条限制**不许含糊**。

#![forbid(unsafe_code)]
#![warn(missing_docs)]
// 说明：设计 §6.4 建议用 clippy 的 `disallowed_types` 禁 `HashMap`。本仓库**没有**
// `clippy.toml`（全局配置在根 `Cargo.toml`，本任务的写权限不含它），所以在 crate 内声明
// `clippy::disallowed_types` 只会是空转——反而给人"已经守住了"的错觉。
// 这里改用一条**真的会红**的仓库守卫：`tests/determinism.rs` 直接扫描 `src/**`，
// 出现 `HashMap` / `HashSet` 即失败（并带一个负向证明：守卫认得这两个名字）。
// clippy 若可用，仍应按设计 §6.4 在仓库级补 `disallowed_types`（属阶段 1 之外的范围）。

pub mod assertions;
pub mod core;
pub mod engine;
pub mod matching;
pub mod refs;

pub use assertions::{ASSERTION_KEYS, ASSERTION_WORDS, REF_PATH, SOFT_MODIFIER};
pub use core::{deep_equal, describe, length_of, stringify_like_js, type_name, AssertionOutcome};
pub use engine::{
    builtin_words, AggregateAssertionResult, AssertionContext, AssertionEngine, AssertionError,
    AssertionEvaluator, AssertionMetadata, AssertionSpec, BufferedAssertionEngine, Streak,
    StreakTracker,
};
pub use matching::{
    evaluate as evaluate_pattern, matches as match_pattern, parse_regex_literal, MatchOptions,
    MatchVerdict, RegexLiteral,
};
pub use refs::{resolve_path, resolve_ref, RefResolution, RefSources};
