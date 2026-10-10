//! A5 反向测试：**对拍器自身也是被测对象**（`REWRITE-METRICS.md` §18）。
//!
//! 两类负向证明，缺一不可：
//! 1. **归一化过度**会掩盖真实差异 —— 用一个"把任何非空文本抹成同一占位"的对照实现
//!    证明它确实会漏检；再用**真实**归一化证明同一对值会被检出。两者同时成立，
//!    才说明"归一化只替换已知片段"这条纪律真的在起作用（而不是测试没判别力）。
//! 2. **对拍器漏检** —— 注入一组已知差异，逐条断言被检出；同时用一组"应当被归一化掉/
//!    应当不比对"的对照断言**零假阳性**。
//!
//! 还有一条元证明：若把某个字段在表里声明成 `not-compared`，对拍器就**确实**看不见它的差异
//! —— 这是"盲区来自声明"的直接证据，也是为什么 `not-compared` 必须有 allowlist 闸门。

use std::fs;
use std::path::PathBuf;

use dsh_testkit_reconciler::{
    compare_reports, parse_reconcile_table, ReconcileOptions, ReconcileTable, TABLE_PATH_IN_REPO,
};
use serde_json::{json, Value};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn real_table() -> ReconcileTable {
    let path = repo_root().join(TABLE_PATH_IN_REPO);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("读不到 {}：{error}", path.display()));
    parse_reconcile_table(&text)
}

/// 过度归一化的对照实现：把**任何**非空文本抹成同一个占位。
///
/// 它不是产品代码，是**负向证明的对照物**：如果本 crate 的真实归一化也是这个行为，
/// 那么"A5：归一化没有掩盖差异"这条就当场失效。
fn over_normalize(text: &str) -> String {
    if text.trim().is_empty() {
        String::new()
    } else {
        "<ANY>".to_string()
    }
}

/// 一条"注入差异"用例：名字 + 一个非捕获的改动函数。
type Injection = (&'static str, fn(&mut Value));

fn baseline() -> Value {
    json!({
        "runId": "2026-10-11T00-00-00_aaaa",
        "startedAt": "2026-10-11T00:00:00.000Z",
        "finishedAt": "2026-10-11T00:00:01.000Z",
        "casesDir": "C:\\repo\\cases",
        "dshVersion": "0.2.0-rc.2",
        "platform": "win32",
        "totals": { "total": 1, "passed": 1, "failed": 0, "skipped": 0, "errored": 0 },
        "cases": [{
            "id": "TK-0001",
            "title": "示例",
            "kind": "tool",
            "verdict": "passed",
            "durationMs": 100,
            "skipReason": "宿主缺少能力：llm",
            "error": "打不开 /tmp/a.txt（EACCES）",
            "steps": [],
            "notes": { "callCount": 1 },
            "releaseFailures": [],
            "sourceIssue": null,
            "usage": { "modelCalls": 2, "tokens": 10 }
        }]
    })
}

fn compare(legacy: &Value, new: &Value) -> dsh_testkit_reconciler::ReconciliationReport {
    compare_reports(legacy, new, &real_table(), &ReconcileOptions::default())
}

fn canary(legacy: &Value, new: &Value, label: &str) -> bool {
    let report = compare(legacy, new);
    if report.is_clean() {
        return false;
    }
    println!(
        "{label}：检出 {} 处差异（{}）",
        report.mismatches.len(),
        report.summary_line()
    );
    true
}

#[test]
fn real_normalization_detects_a_genuine_difference() {
    let mut new = baseline();
    new["cases"][0]["error"] = json!("连接被拒绝（ECONNREFUSED）");
    let report = compare(&baseline(), &new);
    assert!(
        !report.is_clean(),
        "真实差异（错误原因不同）必须被检出：{report:?}"
    );
    assert!(
        report.mismatches.iter().any(|m| m.path == "cases[0].error"),
        "差异必须点名到 cases[0].error：{:?}",
        report.mismatches
    );
}

#[test]
fn over_normalization_would_have_masked_it() {
    // 对照证明：过度归一化会把上面那对**真实不同**的文本判成一致。
    let left = over_normalize("打不开 /tmp/a.txt（EACCES）");
    let right = over_normalize("连接被拒绝（ECONNREFUSED）");
    assert_eq!(
        left, right,
        "对照实现必须掩盖差异；若它不掩盖，本文件的两个断言就都在自证同义反复"
    );
}

#[test]
fn pure_path_differences_are_normalized_away() {
    let mut new = baseline();
    new["runId"] = json!("2026-10-11T09-09-09_zzzz");
    new["startedAt"] = json!("2026-10-11T09:09:09.123Z");
    new["casesDir"] = json!("D:\\other\\cases");
    new["cases"][0]["error"] = json!("打不开 C:\\other\\tmp\\a.txt（EACCES）");
    let report = compare(&baseline(), &new);
    assert!(
        report.is_clean(),
        "纯路径 / 时间戳 / runId 差异必须被归一化掉（否则对拍永远红）：{report:?}"
    );
    assert!(
        report.normalized_fields.contains(&"runid".to_string())
            && report.normalized_fields.contains(&"timestamp".to_string())
            && report.normalized_fields.contains(&"path".to_string()),
        "用到的归一化规则必须可审计：{:?}",
        report.normalized_fields
    );
}

#[test]
fn every_injected_difference_is_detected_and_pointed_at() {
    // 注入 8 类差异：检出率必须 100%，且每条都点名到具体路径。
    let injections: Vec<Injection> = vec![
        ("cases[0].verdict", |v| {
            v["cases"][0]["verdict"] = json!("failed")
        }),
        ("totals.total", |v| v["totals"]["total"] = json!(2)),
        ("totals.failed", |v| v["totals"]["failed"] = json!(1)),
        ("cases[0].id", |v| v["cases"][0]["id"] = json!("TK-0002")),
        ("cases[0].title", |v| {
            v["cases"][0]["title"] = json!("改了标题")
        }),
        ("cases[0].kind", |v| v["cases"][0]["kind"] = json!("shell")),
        ("cases[0].sourceIssue", |v| {
            v["cases"][0]["sourceIssue"] = json!("https://x.invalid/1")
        }),
        ("cases[0].usage.modelCalls", |v| {
            v["cases"][0]["usage"]["modelCalls"] = json!(1)
        }),
    ];

    let mut detected = 0usize;
    for (path, mutate) in &injections {
        let mut new = baseline();
        mutate(&mut new);
        let report = compare(&baseline(), &new);
        assert!(
            !report.is_clean(),
            "注入 {path} 后对拍器必须报差异，但它说报告是干净的"
        );
        assert!(
            report.mismatches.iter().any(|m| m.path == *path),
            "注入 {path} 的差异没有被点名到该路径：{:?}",
            report
                .mismatches
                .iter()
                .map(|m| m.path.clone())
                .collect::<Vec<_>>()
        );
        detected += 1;
    }
    assert_eq!(
        detected,
        injections.len(),
        "检出率必须 100%（{detected}/{}）",
        injections.len()
    );
    println!("注入差异检出率：{detected}/{}", injections.len());
}

#[test]
fn no_false_positives_on_declared_not_compared_and_range() {
    // 对照：不该报的三类，必须一条都不报。
    let mut new = baseline();
    new["cases"][0]["usage"]["tokens"] = json!(999); // not-compared
    new["cases"][0]["durationMs"] = json!(150); // range 内（100 的 3 倍内）
    new["cases"][0]["notes"] = json!({ "callCount": 1 }); // 相同
    let report = compare(&baseline(), &new);
    assert!(
        report.is_clean(),
        "not-compared / 区间内 / 相等的字段不得产生假阳性：{report:?}"
    );
    assert!(
        report
            .uncompared_fields
            .contains(&"cases[0].usage.tokens".to_string()),
        "not-compared 必须进 uncompared_fields：{:?}",
        report.uncompared_fields
    );
}

#[test]
fn blindness_comes_from_the_declaration_itself() {
    // 元证明：把某条字段在表里改成 not-compared，对拍器就看不见它的差异了。
    // 这正是"未比什么必须可见"与"allowlist 闸门"存在的理由。
    let mut table = real_table();
    let entry = table
        .entries
        .get_mut("cases[].verdict")
        .expect("表里应有 cases[].verdict");
    entry.equivalence = dsh_testkit_reconciler::Equivalence::NotCompared;
    entry.disposition = dsh_testkit_reconciler::Disposition::DeclaredNotCompared;

    let mut new = baseline();
    new["cases"][0]["verdict"] = json!("failed");
    let report = compare_reports(&baseline(), &new, &table, &ReconcileOptions::default());
    assert!(
        report.is_clean(),
        "声明成 not-compared 后差异确实看不见——这是盲区的直接证据"
    );
    assert!(
        report
            .uncompared_fields
            .contains(&"cases[0].verdict".to_string()),
        "但盲区必须留在 uncompared_fields 里可见：{:?}",
        report.uncompared_fields
    );
    // 且这条改动会立刻触发 allowlist 闸门。
    assert!(
        table.allowlist_violations().contains("cases[].verdict"),
        "篡改成 not-compared 必须被 allowlist 闸门抓到"
    );
}

#[test]
fn runtime_only_field_like_trace_is_reported_as_undeclared() {
    // 阶段 0 的实证（spec/behaviors/engine/report.md 的 RP-1）：`cases[].trace`
    // 真的被写进 run.json，而 schema 里根本没有这个字段。
    // 对拍器必须让它**可见**——"没比"与"没声明"是两件事，两者都要能看见。
    // 这里刻意**用局部表**（只声明 runId 与 cases[].id），不依赖 `reconcile-fields.yaml`
    // 的当前状态：task-16 已把 trace 写进 schema，spec-contracts 随后会把它声明为
    // `not-compared`；那时真实表里就有 trace 的处置，这个"未声明"用例会自然失效。
    // 机制本身不依赖 spec 的进度，所以用最小表把它钉住。
    let table = parse_reconcile_table(
        r#"
fields:
  - path: runId
    equivalence: normalized
    disposition: compared
  - path: cases[].id
    equivalence: exact
    disposition: compared
"#,
    );
    let options = ReconcileOptions::default();
    let mut legacy = baseline();
    legacy["cases"][0]["trace"] = json!([{ "phase": "case", "name": "TK-0001" }]);
    let mut new = baseline();
    new["cases"][0]["trace"] = json!([{ "phase": "case", "name": "TK-0001", "durationMs": 7 }]);
    let report = compare_reports(&legacy, &new, &table, &options);
    assert!(
        report
            .undeclared_fields
            .iter()
            .any(|path| path.starts_with("cases[].trace")),
        "未声明字段必须可见（粒度是叶子）：{:?}",
        report.undeclared_fields
    );
}

#[test]
fn canary_smoke() {
    // 自检 canary 函数本身有效（避免它永远返回 false 而把上面的断言变成摆设）。
    let mut new = baseline();
    new["totals"]["total"] = json!(7);
    assert!(canary(&baseline(), &new, "canary"));
    assert!(!canary(&baseline(), &baseline(), "canary-clean"));
}
