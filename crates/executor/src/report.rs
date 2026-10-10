//! 报告聚合：把执行痕迹折成 `run.json` 形状。
//!
//! **结构真源**是 `schemas/run-report.schema.json`；**语义真源**是
//! `docs/REWRITE-DESIGN.md` §9.3 的逐字段等价关系表。序列化字段名与 schema 一致
//! （`camelCase`），可选字段缺省即**不出现**（既有报告里 `null` 与"字段不存在"语义不同）。
//!
//! # 本阶段的 schema 增量
//! 按 RFC §5「只新增、不删既有字段」，本次给 schema 新增了 `totals.inconclusive`
//! （见 [`RunTotals::inconclusive`]）。理由：`Inconclusive` 是本阶段新引入的**断言级**
//! 状态（设计 §3.3 四态），而既有 `RunTotals` 与 schema 都没有对应计数——阶段 0 实测确认。
//!
//! # 断言级四态有 schema 落点了（task-16 补）
//! `assertionOutcome.outcome`（enum 四态，**可选、不进 required**）是本阶段新增字段；
//! 字段缺失时语义是"用既有的 `ok` 推导"（`ok ? "passed" : "failed"`），
//! 所以旧实现产出的 run.json 仍然合法。本实现**总是**写出 `outcome`
//! ——四态是本次新增的核心能力，藏在缺省里就无法在阶段 2 被对拍。
//!
//! `cases[].trace` 也进了 schema（可选数组、内部自由形状，等价关系为 `not-compared`）：
//! 它是诊断数据，对"新旧行为是否等价"没有信息量。

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::execute::{AssertionRecord, AssertionVerdict, ExecutionTrace};
use dsh_testkit_protocol::plan::ScenarioMetadata;

/// 一条 case 的判定（与既有 `CaseVerdict` 逐字一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// 全部通过。
    Passed,
    /// 有硬失败。
    Failed,
    /// 前置条件不满足（不是失败）。
    Skipped,
    /// 引擎侧异常。
    Errored,
}

impl Verdict {
    /// 稳定的短名（与 serde 的序列化一致）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Errored => "errored",
        }
    }
}

/// 运行汇总。**六个计数**——`inconclusive` 是本阶段新增的（RFC §5）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTotals {
    /// 总条数（= `cases.length`）。
    pub total: u64,
    /// 通过数。
    pub passed: u64,
    /// 失败数。
    pub failed: u64,
    /// 跳过数。
    pub skipped: u64,
    /// 引擎异常数。
    pub errored: u64,
    /// 判据不可判定的断言数（既不计入 passed 也不计入 failed）。
    pub inconclusive: u64,
}

impl RunTotals {
    /// 记一条**节点 / 断言级**明细判定。
    ///
    /// 注意：报告里的 `TestReport.totals` 是 **case 级**（`total = cases.length`，
    /// 与既有 `tallyTotals` 同口径）；本方法供 `ExecutionTrace` 的明细计数使用。
    pub fn record(&mut self, verdict: AssertionVerdict) {
        self.total += 1;
        match verdict {
            AssertionVerdict::Passed => self.passed += 1,
            AssertionVerdict::Failed => self.failed += 1,
            AssertionVerdict::Skipped => self.skipped += 1,
            AssertionVerdict::Inconclusive => self.inconclusive += 1,
        }
    }

    /// 记一条 case 级判定（`errored` 只能在这一层出现）。
    pub fn record_case(&mut self, verdict: Verdict) {
        self.total += 1;
        match verdict {
            Verdict::Passed => self.passed += 1,
            Verdict::Failed => self.failed += 1,
            Verdict::Skipped => self.skipped += 1,
            Verdict::Errored => self.errored += 1,
        }
    }

    /// 是否一切正常（无 failed / errored；`skipped` 与 `inconclusive` 都不是失败）。
    pub fn is_clean(&self) -> bool {
        self.failed == 0 && self.errored == 0
    }
}

/// 一条释放失败（进 `cases[].releaseFailures`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseFailureReport {
    /// 登记时的标签（这里是资源 id）。
    pub label: String,
    /// 错误原文。
    pub error: String,
}

/// 清理取证（进 `cases[].cleanup`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupReport {
    /// 已释放的资源（逆序执行的结果）。
    pub released: Vec<String>,
    /// 残留（`busy:` / `unknown:` 前缀；探不到标 unknown）。
    pub leftovers: Vec<String>,
}

/// 一个动作的执行结果（进 `cases[].steps[].action`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionReport {
    /// 动作标签（如 `tool:read_file`）。
    pub kind: String,
    /// 是否成功。
    pub ok: bool,
    /// 失败说明。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 一条断言的结果（进 `cases[].steps[].assertions[]`）。
///
/// 字段与 schema 的 `assertionOutcome` 一一对应；`actual` 无类型约束（任意 JSON）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssertionReport {
    /// 断言原文（`ref` + 一个求值词 + `soft`）。
    pub assertion: Map<String, Value>,
    /// 是否通过。**`inconclusive` 与 `skipped` 都记为 `false`**——它是二值回退字段，
    /// 精确的态看 `outcome`。
    pub ok: bool,
    /// 实际取到的值。
    pub actual: Value,
    /// 说明。
    pub message: String,
    /// 是否软断言。
    pub soft: bool,
    /// 断言级四态（设计 §3.3；阶段 1 新增的 schema 字段，**可选、不进 required**）。
    pub outcome: AssertionVerdict,
}

/// 一步的结果（进 `cases[].steps[]`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepReport {
    /// 步骤名（这里用节点 id）。
    pub name: String,
    /// 断言清单。
    pub assertions: Vec<AssertionReport>,
    /// 耗时（毫秒）。
    pub duration_ms: u64,
    /// 动作结果。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<ActionReport>,
    /// 该步的取证增量。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<Map<String, Value>>,
}

/// 一条 case 的结果（进 `cases[]`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseReport {
    /// 场景 id。
    pub id: String,
    /// 标题。
    pub title: String,
    /// kind。
    pub kind: String,
    /// 判定。
    pub verdict: Verdict,
    /// 耗时（毫秒）。
    pub duration_ms: u64,
    /// 跳过原因。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skip_reason: Option<String>,
    /// 错误描述。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// 步骤清单。
    pub steps: Vec<StepReport>,
    /// 该 case 的取证快照。
    pub notes: Map<String, Value>,
    /// 释放失败（非空说明有泄漏风险）。
    pub release_failures: Vec<ReleaseFailureReport>,
    /// 来源 issue（**必须存在**，可为 `null`——schema 允许 `string | null`）。
    pub source_issue: Option<String>,
    /// 清理取证。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cleanup: Option<CleanupReport>,
    /// 失败归因（`product_bug` / `case_bug` / `driver_bug` / `env` / `flaky`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_category: Option<String>,
    /// 负责人。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// 步骤级 trace（诊断数据；schema 里可选、内部自由形状，等价关系为 `not-compared`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<Vec<Value>>,
}

/// 闸门快照（进根级 `policySnapshot`）。**成本闸门留在 TS**，这里是它的只读快照。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicySnapshotReport {
    /// 是否允许真实模型调用。
    pub allow_model: bool,
    /// 是否允许低成本档。
    pub allow_low_cost: bool,
    /// 沙箱策略快照（键集由 TS 侧的 `ExecutionPolicy.sandbox` 决定，这里只透传）。
    pub sandbox: Map<String, Value>,
}

/// 选择器取证（进根级 `selection`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionReport {
    /// 选择模式。
    pub mode: String,
    /// 人读依据。
    pub detail: String,
    /// 命中的场景 id（有序）。
    pub matched: Vec<String>,
}

/// 执行方式取证（进根级 `execution`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionReport {
    /// `off` 或 `limited`。
    pub parallel: String,
    /// 并发度上限。
    pub limit: u64,
    /// 声明 `parallel: safe` 的场景数。
    pub safe: u64,
    /// 强制独占的场景数。
    pub exclusive: u64,
}

/// 脱敏取证（进根级 `redaction`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionReport {
    /// 命中处数。
    pub count: u64,
    /// 命中位置与类型（**只记位置与类型，不记原文**）。
    pub findings: Vec<RedactionFinding>,
}

/// 一条脱敏命中。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionFinding {
    /// 字段路径。
    pub path: String,
    /// 命中类型。
    pub kind: String,
}

/// 一次运行的完整报告（`run.json` 的形状）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReport {
    /// 运行 id。
    pub run_id: String,
    /// 开始时间（ISO 串）。
    pub started_at: String,
    /// 结束时间（ISO 串）。
    pub finished_at: String,
    /// cases 目录。
    pub cases_dir: String,
    /// DSH 版本。
    pub dsh_version: String,
    /// 平台。
    pub platform: String,
    /// 汇总计数（含新增的 `inconclusive`）。
    pub totals: RunTotals,
    /// case 清单。
    pub cases: Vec<CaseReport>,
    /// 闸门快照（未启用闸门时不写）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub policy_snapshot: Option<PolicySnapshotReport>,
    /// 选择器取证（`all` 模式时不写）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection: Option<SelectionReport>,
    /// 执行方式取证。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionReport>,
    /// 脱敏取证。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub redaction: Option<RedactionReport>,
}

fn assertion_map(record: &AssertionRecord) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert("ref".to_string(), Value::String(record.reference.clone()));
    if let Some(word) = &record.word {
        map.insert(word.clone(), record.expected.clone().unwrap_or(Value::Null));
    }
    map.insert("soft".to_string(), Value::Bool(record.soft));
    map
}

fn to_assertion_report(record: &AssertionRecord) -> AssertionReport {
    AssertionReport {
        assertion: assertion_map(record),
        ok: record.verdict == AssertionVerdict::Passed,
        actual: record.actual.clone(),
        message: record.message.clone(),
        soft: record.soft,
        outcome: record.verdict,
    }
}

/// 生成步骤级 trace（形状对齐既有实现的 `TraceSpan`：阶段 / 名字 / 相对偏移 / 耗时）。
///
/// 基准是 **case 起点**（`startMs = 0` 即起点），先各步的 `act` 跨度，最后一条 `case` 总跨度
/// ——与 `src/runtime/runner.ts` 的 `mark()` + case 兜底跨度同形。
/// 它是**诊断数据**：schema 里声明为可选数组、内部自由形状，对拍时 `not-compared`。
fn trace_spans(
    meta: &ScenarioMetadata,
    trace: &ExecutionTrace,
    verdict: Verdict,
) -> Option<Vec<Value>> {
    if trace.steps.is_empty() {
        return None;
    }
    let mut spans: Vec<Value> = Vec::new();
    let mut offset = 0u64;
    for step in &trace.steps {
        spans.push(serde_json::json!({
            "phase": "act",
            "name": step.node_id,
            "startMs": offset,
            "durationMs": step.duration_ms,
            "ok": !step.verdict.is_hard_failure(),
        }));
        offset += step.duration_ms;
    }
    let case_span = if verdict == Verdict::Skipped {
        serde_json::json!({ "phase": "case", "name": meta.scenario_id, "startMs": 0, "durationMs": offset })
    } else {
        serde_json::json!({
            "phase": "case",
            "name": meta.scenario_id,
            "startMs": 0,
            "durationMs": offset,
            "ok": verdict == Verdict::Passed,
        })
    };
    spans.push(case_span);
    Some(spans)
}

impl TestReport {
    /// 从一条执行痕迹聚合出一条 case（一个 plan = 一条 case）。
    ///
    /// `verdict` 的聚合规则：任一**硬失败** → `failed`；否则全 `skipped` → `skipped`；
    /// 否则 `passed`（`inconclusive` 不改 verdict，只进计数——设计 §3.3）。
    #[allow(clippy::too_many_arguments)]
    pub fn from_trace(
        meta: &ScenarioMetadata,
        trace: &ExecutionTrace,
        run_id: impl Into<String>,
        started_at: impl Into<String>,
        finished_at: impl Into<String>,
        cases_dir: impl Into<String>,
        dsh_version: impl Into<String>,
        platform: impl Into<String>,
    ) -> Self {
        let steps: Vec<StepReport> = trace
            .steps
            .iter()
            .map(|step| StepReport {
                name: step.node_id.clone(),
                assertions: step.assertions.iter().map(to_assertion_report).collect(),
                duration_ms: step.duration_ms,
                action: Some(ActionReport {
                    kind: step.tool_kind.clone(),
                    ok: !step.verdict.is_hard_failure(),
                    detail: step.detail.clone(),
                }),
                notes: if step.notes.is_empty() {
                    None
                } else {
                    Some(step.notes.clone())
                },
            })
            .collect();

        let verdict = if trace
            .steps
            .iter()
            .any(|step| step.verdict.is_hard_failure())
        {
            Verdict::Failed
        } else if !trace.steps.is_empty()
            && trace
                .steps
                .iter()
                .all(|step| step.verdict == AssertionVerdict::Skipped)
        {
            Verdict::Skipped
        } else {
            Verdict::Passed
        };

        let failures: Vec<ReleaseFailureReport> = trace
            .release_failures
            .iter()
            .map(|failure| ReleaseFailureReport {
                label: failure.resource_id.clone(),
                error: failure.error.clone(),
            })
            .collect();

        let cleanup = if trace.released.is_empty() && trace.leftovers.is_empty() {
            None
        } else {
            Some(CleanupReport {
                released: trace.released.clone(),
                leftovers: trace.leftovers.clone(),
            })
        };

        let case = CaseReport {
            id: meta.scenario_id.clone(),
            title: meta.title.clone(),
            kind: "plan".to_string(),
            verdict,
            duration_ms: trace.steps.iter().map(|step| step.duration_ms).sum(),
            skip_reason: None,
            error: None,
            steps,
            notes: Map::new(),
            release_failures: failures,
            source_issue: None,
            cleanup,
            failure_category: None,
            owner: None,
            trace: trace_spans(meta, trace, verdict),
        };

        // `TestReport.totals` 是 **case 级**（`total = cases.length`），与既有 `tallyTotals`
        // 同口径；`inconclusive` 记"含不可判定断言的 case 数"。
        // 断言级 / 节点级的明细计数在 `ExecutionTrace.totals`（它不是报告字段）。
        let mut totals = RunTotals::default();
        totals.record_case(case.verdict);
        let has_inconclusive = trace.steps.iter().any(|step| {
            step.assertions
                .iter()
                .any(|assertion| assertion.verdict == AssertionVerdict::Inconclusive)
        });
        if has_inconclusive {
            totals.inconclusive = 1;
        }

        TestReport {
            run_id: run_id.into(),
            started_at: started_at.into(),
            finished_at: finished_at.into(),
            cases_dir: cases_dir.into(),
            dsh_version: dsh_version.into(),
            platform: platform.into(),
            totals,
            cases: vec![case],
            policy_snapshot: None,
            selection: None,
            execution: None,
            redaction: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::execute::{ReleaseFailure, StepTrace};
    use crate::ConfidenceLevel;

    fn meta() -> ScenarioMetadata {
        ScenarioMetadata {
            scenario_id: "TK-0001".to_string(),
            title: "示例".to_string(),
            layer: dsh_testkit_protocol::plan::Layer::L3,
            confidence: ConfidenceLevel::Real,
            shared_context: false,
            depth: 1,
            seed: None,
        }
    }

    fn trace_with(verdict: AssertionVerdict) -> ExecutionTrace {
        let mut totals = RunTotals::default();
        totals.record(verdict);
        ExecutionTrace {
            steps: vec![StepTrace {
                node_id: "n1".to_string(),
                tool_kind: "call-tool".to_string(),
                order: 0,
                verdict,
                confidence: ConfidenceLevel::Real,
                duration_ms: 3,
                detail: None,
                assertions: vec![AssertionRecord {
                    reference: "fx.a".to_string(),
                    word: Some("is".to_string()),
                    expected: Some(serde_json::json!(1)),
                    soft: false,
                    verdict,
                    message: "期望 1，实际 2".to_string(),
                    actual: serde_json::json!(2),
                }],
                notes: Map::new(),
            }],
            released: vec!["tmpdir".to_string()],
            release_failures: vec![ReleaseFailure {
                resource_id: "sessions".to_string(),
                error: "炸了".to_string(),
            }],
            leftovers: vec!["unknown:sessions（探测超时）".to_string()],
            totals,
            // K1：这个 helper 让"实际执行报出的可信度"与 plan 声明一致（不制造违规）。
            confidence: Some(ConfidenceLevel::Real),
            confidence_violations: Vec::new(),
        }
    }

    #[test]
    fn inconclusive_is_counted_but_does_not_change_the_verdict() {
        let report = TestReport::from_trace(
            &meta(),
            &trace_with(AssertionVerdict::Inconclusive),
            "run-1",
            "t0",
            "t1",
            "cases",
            "0.2.0-rc.2",
            "win32",
        );
        assert_eq!(report.totals.inconclusive, 1);
        assert_eq!(report.cases[0].verdict, Verdict::Passed);
        // 「保住计数、丢了态」的旧处理已废止：态落在 outcome 上，message 保持纯语义。
        assert_eq!(
            report.cases[0].steps[0].assertions[0].outcome,
            AssertionVerdict::Inconclusive
        );
        assert!(!report.cases[0].steps[0].assertions[0].ok);
        assert!(!report.cases[0].steps[0].assertions[0]
            .message
            .starts_with("inconclusive:"));
    }

    #[test]
    fn hard_failure_makes_the_case_fail() {
        let report = TestReport::from_trace(
            &meta(),
            &trace_with(AssertionVerdict::Failed),
            "run-1",
            "t0",
            "t1",
            "cases",
            "0.2.0-rc.2",
            "win32",
        );
        assert_eq!(report.cases[0].verdict, Verdict::Failed);
        assert_eq!(report.totals.failed, 1);
    }

    #[test]
    fn cleanup_and_release_failures_are_visible() {
        let report = TestReport::from_trace(
            &meta(),
            &trace_with(AssertionVerdict::Passed),
            "run-1",
            "t0",
            "t1",
            "cases",
            "0.2.0-rc.2",
            "win32",
        );
        assert_eq!(report.cases[0].release_failures.len(), 1);
        let cleanup = report.cases[0].cleanup.clone().expect("cleanup 必须写出");
        assert_eq!(cleanup.released, vec!["tmpdir".to_string()]);
        assert!(cleanup.leftovers[0].starts_with("unknown:"));
    }

    #[test]
    fn serialized_shape_is_camel_case_and_omits_optional_fields() {
        let report = TestReport::from_trace(
            &meta(),
            &trace_with(AssertionVerdict::Passed),
            "run-1",
            "t0",
            "t1",
            "cases",
            "0.2.0-rc.2",
            "win32",
        );
        let json = serde_json::to_value(&report).expect("serialize");
        assert!(json.get("runId").is_some());
        assert!(json.get("startedAt").is_some());
        assert!(
            json.get("policySnapshot").is_none(),
            "未启用的可选字段不该出现"
        );
        assert!(
            json["cases"][0]["sourceIssue"].is_null(),
            "sourceIssue 必须存在且可为 null"
        );
        assert!(json["totals"].get("inconclusive").is_some());
    }
}
