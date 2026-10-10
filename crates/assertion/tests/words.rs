//! 逐词验收：16 个断言词各自独立成用例（不是一个大测试）。
//!
//! 真源：
//! - 语义 `docs/SCENARIO-SPEC.md` §2.5；
//! - 行为 `spec/behaviors/engine/assert.md` 的 `assert-evaluate` observable（31 条）；
//! - `tests/assert.test.mjs`（旧实现的既有用例，逐条对照）。
//!
//! 本文件只经**公开 API**（[`AssertionEngine::assert`] / [`AssertionSpec`] / [`AssertionContext`]）
//! 驱动，避免"测试直接调内部函数"导致公开面没被覆盖。

use dsh_testkit_assertion::{
    AssertionContext, AssertionEngine, AssertionOutcome, AssertionSpec, BufferedAssertionEngine,
};
use serde_json::{json, Value};

/// 造一个标注了 fixture 的上下文。
fn ctx() -> AssertionContext {
    let mut ctx = AssertionContext::new("TK-WORDS");
    ctx.fixture = Some(json!({
        "s": "xxabcxx",
        "n": 5,
        "zero": 0,
        "empty": "",
        "bool": false,
        "nil": null,
        "list": [1, 2, 3],
        "objects": [{"x": 1}, {"y": 2}],
        "nested": {"a": {"b": [{"c": 7}]}},
        "text": "错误：炸了",
        "obj": {"x": 1},
    }));
    ctx
}

/// 从 JSON 造一条断言（同时也校验了 `serde` 的字段名契约）。
fn spec(value: Value) -> AssertionSpec {
    serde_json::from_value(value).expect("断言行必须能反序列化")
}

/// 断言一条断言"通过"，并返回结果。
fn passed(engine: &BufferedAssertionEngine, spec: &AssertionSpec) -> AssertionOutcome {
    let outcome = engine.assert(&ctx(), spec);
    assert!(
        outcome.counts_as_passed(),
        "{spec:?} 应通过，实际 {outcome:?}"
    );
    outcome
}

/// 断言一条断言"失败"，并返回失败消息。
fn failed(engine: &BufferedAssertionEngine, spec: &AssertionSpec) -> String {
    let outcome = engine.assert(&ctx(), spec);
    assert!(
        outcome.counts_as_failed(),
        "{spec:?} 应失败，实际 {outcome:?}"
    );
    outcome.reason().unwrap_or_default().to_string()
}

/// 断言一条断言"无法判定"。
fn inconclusive(engine: &BufferedAssertionEngine, spec: &AssertionSpec) -> String {
    let outcome = engine.assert(&ctx(), spec);
    assert!(
        outcome.counts_as_inconclusive(),
        "{spec:?} 应无法判定，实际 {outcome:?}"
    );
    outcome.reason().unwrap_or_default().to_string()
}

// ---------------------------------------------------------------------------
// 1. is
// ---------------------------------------------------------------------------

/// 词 1/16：`is` —— 严格相等（对象走深比较）。
///
/// 对应 observable：`is 走深比较` 的两条（同形对象通过、类型不同与顺序不同失败）。
#[test]
fn word_is_deep_compares() {
    let engine = BufferedAssertionEngine::new();
    passed(
        &engine,
        &spec(json!({"ref": "fx.nested", "is": {"a": {"b": [{"c": 7}]}}})),
    );
    passed(&engine, &spec(json!({"ref": "fx.n", "is": 5})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "is": "5"}))),
        "期望 is \"5\"，实际 5"
    );
    // 数组顺序敏感：`[1,2,3]` ≠ `[3,2,1]`（消息里 actual 是完整数组）。
    let message = failed(&engine, &spec(json!({"ref": "fx.list", "is": [3, 2, 1]})));
    assert_eq!(message, "期望 is [3,2,1]，实际 [1,2,3]");
}

// ---------------------------------------------------------------------------
// 2. isNot
// ---------------------------------------------------------------------------

/// 词 2/16：`isNot` —— 不等于。
#[test]
fn word_is_not() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.n", "isNot": 1})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "isNot": 5}))),
        "期望不等于 5，但相等"
    );
}

// ---------------------------------------------------------------------------
// 3. notIs
// ---------------------------------------------------------------------------

/// 词 3/16：`notIs` —— `isNot` 的别名（旧实现同分支、同消息；spec 缺陷 2/3）。
#[test]
fn word_not_is_is_an_alias_of_is_not() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.n", "notIs": 1})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "notIs": 5}))),
        "期望不等于 5，但相等"
    );
}

// ---------------------------------------------------------------------------
// 4. exists
// ---------------------------------------------------------------------------

/// 词 4/16：`exists` —— 非 `undefined` / `null`。
#[test]
fn word_exists() {
    let engine = BufferedAssertionEngine::new();
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.nil", "exists": true}))),
        "期望 exists=true，实际 null"
    );
    passed(&engine, &spec(json!({"ref": "fx.zero", "exists": true})));
    passed(&engine, &spec(json!({"ref": "fx.empty", "exists": true})));
    passed(&engine, &spec(json!({"ref": "fx.bool", "exists": true})));
}

/// 词 4/16（续）：`exists:false` 是合法的反向表达——**fx 是存在的容器**，
/// 没记过的键取到"缺失"而不是"取值失败"（`assert-resolve-ref` 的关键纪律）。
#[test]
fn word_exists_false_on_never_noted_key() {
    let engine = BufferedAssertionEngine::new();
    passed(
        &engine,
        &spec(json!({"ref": "fx.neverNoted", "exists": false})),
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.zero", "exists": false}))),
        "期望 exists=false，实际 0"
    );
}

// ---------------------------------------------------------------------------
// 5. notExists
// ---------------------------------------------------------------------------

/// 词 5/16：`notExists` —— `undefined` / `null`（`0` / `""` / `false` 仍算存在）。
#[test]
fn word_not_exists() {
    let engine = BufferedAssertionEngine::new();
    passed(
        &engine,
        &spec(json!({"ref": "fx.neverNoted", "notExists": true})),
    );
    passed(&engine, &spec(json!({"ref": "fx.nil", "notExists": true})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.zero", "notExists": true}))),
        "期望 notExists=true，实际 0"
    );
}

// ---------------------------------------------------------------------------
// 6. contains
// ---------------------------------------------------------------------------

/// 词 6/16：`contains` —— 字符串子串。
#[test]
fn word_contains_string() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.s", "contains": "abc"})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.s", "contains": "zzz"}))),
        "期望包含 \"zzz\"，实际 \"xxabcxx\""
    );
}

/// 词 6/16（续）：`contains` —— 数组含元素（对象元素按**结构**比较）。
#[test]
fn word_contains_array() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.list", "contains": 2})));
    passed(
        &engine,
        &spec(json!({"ref": "fx.objects", "contains": {"x": 1}})),
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.list", "contains": 9}))),
        "期望数组含 9"
    );
}

/// 词 6/16（续）：类型不匹配判失败并给说明（**旧测试未覆盖**，任务点名要求覆盖）。
#[test]
fn word_contains_type_mismatch_fails_with_explanation() {
    let engine = BufferedAssertionEngine::new();
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "contains": 1}))),
        "contains 不适用于 number"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.obj", "contains": 1}))),
        "contains 不适用于 object"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.nil", "contains": 1}))),
        "contains 不适用于 null"
    );
}

// ---------------------------------------------------------------------------
// 7. notContains
// ---------------------------------------------------------------------------

/// 词 7/16：`notContains` —— 字符串与数组两个分支 + 类型不匹配。
#[test]
fn word_not_contains() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.list", "notContains": 9})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.list", "notContains": 2}))),
        "期望数组不含 2"
    );
    passed(&engine, &spec(json!({"ref": "fx.s", "notContains": "zzz"})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.s", "notContains": "abc"}))),
        "期望不包含 \"abc\""
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "notContains": 1}))),
        "notContains 不适用于 number"
    );
}

// ---------------------------------------------------------------------------
// 8. matches
// ---------------------------------------------------------------------------

/// 词 8/16：`matches` —— `/pattern/flags` 字面量（逐条对照 `tests/assert.test.mjs`）。
#[test]
fn word_matches_regex_literal() {
    let engine = BufferedAssertionEngine::new();
    passed(
        &engine,
        &spec(json!({"ref": "fx.text", "matches": "/^错误：/"})),
    );
    assert_eq!(
        failed(
            &engine,
            &spec(json!({"ref": "fx.s", "matches": "/^错误：/"}))
        ),
        "期望匹配 /^错误：/，实际 \"xxabcxx\""
    );
    passed(&engine, &spec(json!({"ref": "fx.s", "matches": "/ABC/i"})));
    // 裸字符串模式（不是字面量）同样按正则处理。
    passed(&engine, &spec(json!({"ref": "fx.s", "matches": "abc"})));
}

/// 词 8/16（续）：`matches` 遇到非字符串 actual ⇒ 失败并说明（不 throw）。
#[test]
fn word_matches_requires_string() {
    let engine = BufferedAssertionEngine::new();
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "matches": "/x/"}))),
        "matches 需要字符串，实际 number"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.nil", "matches": "/x/"}))),
        "matches 需要字符串，实际 null"
    );
}

/// 词 8/16（续）：**非法正则**判 `Failed`（可归因的事实），**不**让异常冒泡成 `errored`
/// （旧实现的边界 6 是缺陷：非法模式会炸整条 case）。这决定了"判定移出 TS"后
/// 判定层不会有异常路径。
#[test]
fn word_matches_invalid_pattern_is_a_failure_not_a_panic() {
    let engine = BufferedAssertionEngine::new();
    let message = failed(&engine, &spec(json!({"ref": "fx.s", "matches": "a{2,1}"})));
    assert!(message.contains("非法"), "{message}");
    let message = failed(&engine, &spec(json!({"ref": "fx.s", "matches": "/(/"})));
    assert!(
        message.contains("非法") || message.contains("不支持"),
        "{message}"
    );
}

/// 词 8/16（续）：**不支持的构造**判 `Inconclusive`（测不准就如实说测不准），
/// 而不是悄悄给一个可能错的布尔结论。
///
/// **每个模式用一台新引擎**：同一判据连续 3 次 `Inconclusive` 会被升级成 `Failed`
/// （设计 §8.4 硬约束 3b），那会让本测试测到"升级规则"而不是"不支持 ⇒ Inconclusive"。
/// 升级规则本身另有专门用例（`tests/inconclusive_streak.rs`）。
#[test]
fn word_matches_unsupported_construct_is_inconclusive() {
    for pattern in ["/a(?=b)/", "/a\\1/", "/\\bword/", "/x/u", "/\\p{L}/"] {
        let engine = BufferedAssertionEngine::new();
        let reason = inconclusive(&engine, &spec(json!({"ref": "fx.s", "matches": pattern})));
        assert!(!reason.is_empty(), "模式 {pattern} 的原因不能为空");
    }
}

// ---------------------------------------------------------------------------
// 9. atLeast
// ---------------------------------------------------------------------------

/// 词 9/16：`atLeast` —— `>=`（`typeof actual === 'number'` 是硬前提，边界相等通过）。
#[test]
fn word_at_least() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.n", "atLeast": 5})));
    passed(&engine, &spec(json!({"ref": "fx.n", "atLeast": 4})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "atLeast": 6}))),
        "期望 >= 6，实际 5"
    );
    // `"5"` 是字符串：非 number 一律失败。
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.s", "atLeast": 1}))),
        "期望 >= 1，实际 \"xxabcxx\""
    );
}

// ---------------------------------------------------------------------------
// 10. atMost
// ---------------------------------------------------------------------------

/// 词 10/16：`atMost` —— `<=`（等于上限通过；非 number 一律失败）。
#[test]
fn word_at_most() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.n", "atMost": 5})));
    passed(&engine, &spec(json!({"ref": "fx.n", "atMost": 6})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "atMost": 4}))),
        "期望 <= 4，实际 5"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.nil", "atMost": 4}))),
        "期望 <= 4，实际 null"
    );
}

// ---------------------------------------------------------------------------
// 11. length
// ---------------------------------------------------------------------------

/// 词 11/16：`length` —— 字符串与数组；不可长度对象失败并说明。
#[test]
fn word_length() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.s", "length": 7})));
    passed(&engine, &spec(json!({"ref": "fx.list", "length": 3})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.list", "length": 2}))),
        "期望长度 2，实际 3"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "length": 1}))),
        "length 需要可长度对象，实际 number"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.obj", "length": 1}))),
        "length 需要可长度对象，实际 object"
    );
}

// ---------------------------------------------------------------------------
// 12. lengthAtLeast
// ---------------------------------------------------------------------------

/// 词 12/16：`lengthAtLeast` —— 长度 `>=`（**旧测试未覆盖**，任务点名要求覆盖）。
#[test]
fn word_length_at_least() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.s", "lengthAtLeast": 2})));
    passed(&engine, &spec(json!({"ref": "fx.s", "lengthAtLeast": 7})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.s", "lengthAtLeast": 8}))),
        "期望长度 >= 8，实际 7"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "lengthAtLeast": 1}))),
        "length 需要可长度对象，实际 number"
    );
}

// ---------------------------------------------------------------------------
// 13. lengthAtMost
// ---------------------------------------------------------------------------

/// 词 13/16：`lengthAtMost` —— 长度 `<=`。
#[test]
fn word_length_at_most() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.s", "lengthAtMost": 7})));
    passed(&engine, &spec(json!({"ref": "fx.s", "lengthAtMost": 8})));
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.s", "lengthAtMost": 6}))),
        "期望长度 <= 6，实际 7"
    );
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.list", "lengthAtMost": 1}))),
        "期望长度 <= 1，实际 3"
    );
}

// ---------------------------------------------------------------------------
// 14. throws
// ---------------------------------------------------------------------------

/// 词 14/16：`throws` —— **本实现修好的空壳**。
///
/// 旧实现 `src/runtime/assert.ts:201-202` 只读 `expected`、`actual` 完全没被读：
/// `throws:true` **恒** false、`throws:false` **恒** true，且全仓零测试。
/// spec 缺陷 1 要求阶段 1 裁决。本实现的判据是"`actual` 是否缺失"（模块文档已说明
/// 这条判据**弱于** SCENARIO-SPEC 的完整语义，阶段 2 需把它升级成一等输入）。
#[test]
fn word_throws_reads_actual() {
    let engine = BufferedAssertionEngine::new();
    // 期望抛错 + 取值没有产出值 ⇒ 通过（旧实现恒失败）。
    passed(
        &engine,
        &spec(json!({"ref": "fx.neverNoted", "throws": true})),
    );
    // 期望抛错 + 取到了值 ⇒ 失败（旧实现同样失败，但理由不同：旧实现根本不看 actual）。
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "throws": true}))),
        "期望抛错，但取值成功"
    );
    // 期望不抛错 + 取到了值 ⇒ 通过（旧实现恒通过）。
    passed(&engine, &spec(json!({"ref": "fx.n", "throws": false})));
    // 期望不抛错 + 没有产出值 ⇒ 失败（**旧实现恒通过**，这是本词的行为差异）。
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.nil", "throws": false}))),
        "期望不抛错，但取值过程没有产出值"
    );
}

// ---------------------------------------------------------------------------
// 15. soft
// ---------------------------------------------------------------------------

/// 词 15/16：`soft` 修饰符 —— 失败不改变 case verdict，但**判定层必须保留这个标记**
/// （旧实现里它是 runner 侧另挂的布尔 `runner.ts:741`）。
#[test]
fn word_soft_is_preserved_and_not_a_hard_failure() {
    let engine = BufferedAssertionEngine::new();
    let outcome = engine.assert(&ctx(), &spec(json!({"ref": "fx.n", "is": 1, "soft": true})));
    assert!(outcome.counts_as_failed(), "软断言失败仍是 Failed");
    assert!(outcome.is_soft(), "软标记必须被保留");
    assert!(!outcome.counts_as_hard_failure(), "软失败不算硬失败");
    // 硬断言对照。
    let hard = engine.assert(&ctx(), &spec(json!({"ref": "fx.n", "is": 1})));
    assert!(hard.counts_as_hard_failure());
    // `soft` 不是判定词：只给 `soft` 的断言仍然缺判定词。
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n", "soft": true}))),
        "断言缺少判定词（fx.n 只给了 ref）"
    );
}

// ---------------------------------------------------------------------------
// 16. ref
// ---------------------------------------------------------------------------

/// 词 16/16：`ref` —— 取值路径（`fx` / `case` / `env` 三类前缀）。
///
/// 详见 `tests/ref_paths.rs`；这里给出"三类前缀都能取到值"的最小断言，
/// 保证 16/16 逐词覆盖在本文件里是**完整**的。
#[test]
fn word_ref_resolves_three_prefixes() {
    let engine = BufferedAssertionEngine::new();
    let mut ctx = ctx();
    ctx.scenario = Some(json!({"title": "自检"}));
    ctx.env = Some(json!({"dshVersion": "1.0.0", "platform": "win32"}));

    for (reference, expected) in [
        ("fx.nested.a.b[0].c", json!(7)),
        ("case.title", json!("自检")),
        ("env.dshVersion", json!("1.0.0")),
    ] {
        let outcome = engine.assert(&ctx, &spec(json!({"ref": reference, "is": expected})));
        assert!(outcome.counts_as_passed(), "{reference} 应取到 {expected}");
    }
    // 未知前缀是**取值失败**，与"键缺失"不同。
    let outcome = engine.assert(&ctx, &spec(json!({"ref": "bogus.x", "is": 1})));
    assert_eq!(outcome.reason(), Some("未知 ref 前缀：bogus"));
}

// ---------------------------------------------------------------------------
// 交叉：多词 AND、缺词、成功消息词序
// ---------------------------------------------------------------------------

/// observable：一个 Assertion 里出现多个判定词时**全部**必须通过（AND），
/// 成功消息的词序由规范顺序（`ASSERTION_KEYS`）决定。
#[test]
fn multiple_words_are_all_required_and_message_keeps_canonical_order() {
    let engine = BufferedAssertionEngine::new();
    // 断言写成"先 atMost 再 atLeast"，但消息里的词序仍是规范序（atLeast 在 atMost 前）。
    let outcome = passed(
        &engine,
        &spec(json!({"ref": "fx.n", "atMost": 5, "atLeast": 1})),
    );
    assert_eq!(
        outcome,
        AssertionOutcome::Passed {
            details: Some(json!("fx.n 满足 atLeast + atMost")),
            soft: false,
        }
    );
    // 任一词失败即失败，消息是该词的。
    assert_eq!(
        failed(
            &engine,
            &spec(json!({"ref": "fx.n", "atLeast": 1, "atMost": 4}))
        ),
        "期望 <= 4，实际 5"
    );
}

/// observable：一个断言没有任何判定词（只给 `ref`，或只给 `soft`）⇒ 失败。
#[test]
fn missing_words_is_a_failure() {
    let engine = BufferedAssertionEngine::new();
    assert_eq!(
        failed(&engine, &spec(json!({"ref": "fx.n"}))),
        "断言缺少判定词（fx.n 只给了 ref）"
    );
}

/// observable：`is` 用 `null` 当期望值时，**缺失的键**与**显式 null** 结论一致（都通过）
/// —— 对齐旧实现里 `undefined` 与 `null` 都走"没取到值"的判定路径。
#[test]
fn is_null_matches_both_absent_and_explicit_null() {
    let engine = BufferedAssertionEngine::new();
    passed(&engine, &spec(json!({"ref": "fx.neverNoted", "is": null})));
    passed(&engine, &spec(json!({"ref": "fx.nil", "is": null})));
}
