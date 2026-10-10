//! 执行循环与回滚（设计 §6.1–§6.2）。
//!
//! # 执行顺序
//! 按**拓扑序**执行；同层节点按 id 字典序（确定性——设计 §6.4 的"判定路径可复现"）。
//!
//! # 回滚纪律（§6.2，逐条沿用）
//! * 释放栈**逆序**执行（后登记的先进先出）；
//! * 单个释放失败**不静默**，收进 [`ExecutionTrace::release_failures`]；
//! * 残留探测**探不到标 `unknown`**（[`ResidueState::Unknown`]），绝不标"干净"。
//!
//! # 边界
//! 真正的"执行一个节点"由 TS 侧驱动提供（设计 §1.1：Rust 不持有场景语义），
//! 所以本模块通过 [`NodeRunner`] trait 接收外部实现——这样执行循环可以**脱离活宿主**测试。

use std::collections::{BTreeMap, BTreeSet};

use dsh_testkit_protocol::plan::{Edge, ExecutionPlan, ToolNode};
use serde_json::{Map, Value};

use crate::report::RunTotals;
use crate::ConfidenceLevel;

/// 单个断言的判定（设计 §3.3 的四态）。
///
/// `Inconclusive` 是本阶段**新增**的态：既有实现只有 `ok: boolean` 两态，
/// 且 `RunTotals` 里没有对应计数（阶段 0 实测确认）。它既不计入 passed 也不计入 failed。
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "snake_case")]
pub enum AssertionVerdict {
    /// 通过。
    Passed,
    /// 失败。
    Failed,
    /// 跳过（前置条件不满足）。
    Skipped,
    /// 判据在当前证据下不可判定。
    Inconclusive,
}

impl AssertionVerdict {
    /// 稳定的短名。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Passed => "passed",
            Self::Failed => "failed",
            Self::Skipped => "skipped",
            Self::Inconclusive => "inconclusive",
        }
    }

    /// 是否算硬失败（`Skipped` 与 `Inconclusive` 都不算）。
    pub fn is_hard_failure(self) -> bool {
        matches!(self, Self::Failed)
    }
}

/// 一条断言的记录（进报告）。
#[derive(Debug, Clone, PartialEq)]
pub struct AssertionRecord {
    /// 取值路径（`fx.*` / `case.*` / `env.*`）。
    pub reference: String,
    /// 本行用到的求值词（一行一个）。
    pub word: Option<String>,
    /// 该求值词的期望值（`None` = 只记了路径、没有期望值）。
    pub expected: Option<Value>,
    /// 软断言：失败不改变 verdict（`src/runtime/runner.ts` 的 `hasHardFailure`）。
    pub soft: bool,
    /// 判定结果。
    pub verdict: AssertionVerdict,
    /// 说明（失败时给出差异）。
    pub message: String,
    /// 实际取到的值。
    pub actual: Value,
}

/// 单个节点的执行结果（由外部 [`NodeRunner`] 产出）。
#[derive(Debug, Clone, PartialEq)]
pub struct NodeOutcome {
    /// 该节点的总体判定。
    pub verdict: AssertionVerdict,
    /// 该节点产出的可信度（设计 §8.1）。
    pub confidence: ConfidenceLevel,
    /// 耗时（毫秒）。
    pub duration_ms: u64,
    /// 失败 / 跳过说明。
    pub detail: Option<String>,
    /// 断言记录。
    pub assertions: Vec<AssertionRecord>,
    /// 该节点写入的取证（进 `cases[].steps[].notes`）。
    pub notes: Map<String, Value>,
}

impl Default for NodeOutcome {
    fn default() -> Self {
        Self {
            verdict: AssertionVerdict::Passed,
            confidence: ConfidenceLevel::Real,
            duration_ms: 0,
            detail: None,
            assertions: Vec::new(),
            notes: Map::new(),
        }
    }
}

/// 外部提供的"跑一个节点"的实现。
pub trait NodeRunner {
    /// 执行一个节点。`order` 是它在拓扑序里的下标（从 0 起，供实现记录取证）。
    fn run(&self, node: &ToolNode, order: usize) -> NodeOutcome;
}

/// 外部提供的"释放一个资源"的实现。
pub trait ResourceReleaser {
    /// 释放资源；`Err` 表示释放失败（**必须被上报，不许静默**）。
    fn release(&self, resource_id: &str) -> Result<(), String>;
}

/// 残留探测结果。
///
/// **探不到不是干净**：`Unknown` 是独立的一态（既有 `src/isolation/probes.ts` 的纪律）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResidueState {
    /// 明确干净。
    Clean,
    /// 仍被占用（原因可归因）。
    Busy(String),
    /// 探不到（原因可归因）——**不等于干净**。
    Unknown(String),
}

/// 外部提供的残留探针。
pub trait LeftoverProbe {
    /// 探测一个资源的残留状态。
    fn probe(&self, resource_id: &str) -> ResidueState;
}

/// 一个节点的执行痕迹。
#[derive(Debug, Clone, PartialEq)]
pub struct StepTrace {
    /// 节点 id。
    pub node_id: String,
    /// BaseTool 原子名。
    pub tool_kind: String,
    /// 拓扑序下标。
    pub order: usize,
    /// 判定。
    pub verdict: AssertionVerdict,
    /// 可信度。
    pub confidence: ConfidenceLevel,
    /// 耗时。
    pub duration_ms: u64,
    /// 说明。
    pub detail: Option<String>,
    /// 断言记录。
    pub assertions: Vec<AssertionRecord>,
    /// 取证。
    pub notes: Map<String, Value>,
}

/// 一次释放失败。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseFailure {
    /// 资源 id。
    pub resource_id: String,
    /// 错误原文。
    pub error: String,
}

/// 一次执行的完整痕迹（报告聚合的输入）。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ExecutionTrace {
    /// 逐节点的痕迹（按执行顺序）。
    pub steps: Vec<StepTrace>,
    /// 实际释放成功的资源（**逆序**执行的记录）。
    pub released: Vec<String>,
    /// 释放失败（非空说明有泄漏风险）。
    pub release_failures: Vec<ReleaseFailure>,
    /// 残留（`busy:` / `unknown:` 前缀；探不到标 unknown）。
    pub leftovers: Vec<String>,
    /// 该次执行的汇总计数。
    pub totals: RunTotals,
    /// **实际执行**产出的可信度（取所有节点里最保守的那个；没执行节点则为 `None`）。
    ///
    /// K1 的另一半：plan 的 `metadata.confidence` 是**声明**，这里是 [`NodeRunner`]
    /// 实际报上来的东西。两者不一致 → [`ExecutionTrace::confidence_violations`]。
    pub confidence: Option<ConfidenceLevel>,
    /// **实际执行的可信度与 plan 声明不一致**的节点（K1 的"不一致会被抓到"）。
    pub confidence_violations: Vec<ConfidenceViolation>,
}

/// 一处"实际执行的可信度 ≠ plan 声明的可信度"。
///
/// K1（`REWRITE-METRICS.md:267`）要求两者的比例是 **100%**；这个结构就是那条要求
/// 被违反时的证据——`node_id` 必须能点名，只报"某处不一致"无法定位（同 A1 的取向）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfidenceViolation {
    /// 出问题的节点 id。
    pub node_id: String,
    /// plan 声明的可信度（`metadata.confidence`）。
    pub declared: ConfidenceLevel,
    /// 该节点实际产出的可信度（`NodeOutcome.confidence`）。
    pub actual: ConfidenceLevel,
}

/// 拓扑排序。返回节点 id 的执行顺序；有环时返回 `Err(环上或剩余节点)`。
///
/// 同层按 id 字典序出队（`BTreeSet`），保证顺序可复现。
pub fn topological_order(nodes: &[ToolNode], edges: &[Edge]) -> Result<Vec<String>, Vec<String>> {
    let mut indegree: BTreeMap<String, usize> = nodes
        .iter()
        .map(|node| (node.node_id.clone(), 0usize))
        .collect();
    let mut adjacency: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for edge in edges {
        if !indegree.contains_key(&edge.from) || !indegree.contains_key(&edge.to) {
            continue;
        }
        if adjacency
            .entry(edge.from.clone())
            .or_default()
            .insert(edge.to.clone())
        {
            *indegree.entry(edge.to.clone()).or_insert(0) += 1;
        }
    }

    let mut ready: BTreeSet<String> = indegree
        .iter()
        .filter(|(_, degree)| **degree == 0)
        .map(|(id, _)| id.clone())
        .collect();
    let mut order: Vec<String> = Vec::new();

    while let Some(current) = ready.iter().next().cloned() {
        ready.remove(&current);
        order.push(current.clone());
        if let Some(neighbours) = adjacency.get(&current) {
            for neighbour in neighbours {
                if let Some(degree) = indegree.get_mut(neighbour) {
                    *degree -= 1;
                    if *degree == 0 {
                        ready.insert(neighbour.clone());
                    }
                }
            }
        }
    }

    if order.len() == nodes.len() {
        Ok(order)
    } else {
        let ordered: BTreeSet<&String> = order.iter().collect();
        let stuck: Vec<String> = nodes
            .iter()
            .map(|node| node.node_id.clone())
            .filter(|id| !ordered.contains(id))
            .collect();
        Err(stuck)
    }
}

/// 可信度的"保守度"序：`Static`（未执行）< `Simulated` < `Degraded` < `Real`。
///
/// 取"最保守" = 取序最小的那个：一条 plan 里只要有一个节点是在模拟宿主上跑的，
/// 整条结果就不该被当成 `Real`（§8.4 硬约束 1 的取向：**宁可低报，不可高报**）。
fn confidence_rank(level: ConfidenceLevel) -> u8 {
    match level {
        ConfidenceLevel::Static => 0,
        ConfidenceLevel::Simulated => 1,
        ConfidenceLevel::Degraded => 2,
        ConfidenceLevel::Real => 3,
        // `#[non_exhaustive]`：新增态一律按"最保守"处理（不认识的不高报）。
        _ => 0,
    }
}

fn most_conservative(left: ConfidenceLevel, right: ConfidenceLevel) -> ConfidenceLevel {
    if confidence_rank(left) <= confidence_rank(right) {
        left
    } else {
        right
    }
}

/// 按拓扑序执行 plan，并做逆序释放与残留探测。
///
/// 调用方应先用 [`crate::validate_plan`] 校验；本函数对"有环"做防御性降级
/// （不执行任何节点，把环上节点写进 `leftovers`）。
pub fn execute_plan(
    plan: &ExecutionPlan,
    runner: &dyn NodeRunner,
    releaser: &dyn ResourceReleaser,
    probe: &dyn LeftoverProbe,
) -> ExecutionTrace {
    let mut trace = ExecutionTrace::default();
    // K1 的对账基准：plan 声明的可信度。
    let declared_confidence = plan.metadata.confidence;
    let mut actual_confidence: Option<ConfidenceLevel> = None;

    let order = match topological_order(&plan.nodes, &plan.edges) {
        Ok(order) => order,
        Err(stuck) => {
            for node_id in stuck {
                trace.leftovers.push(format!("cycle:{node_id}"));
            }
            return trace;
        }
    };

    let mut release_stack: Vec<String> = Vec::new();
    for (index, node_id) in order.iter().enumerate() {
        let Some(node) = plan.nodes.iter().find(|node| &node.node_id == node_id) else {
            continue;
        };
        let outcome = runner.run(node, index);
        // K1：把"实际执行的可信度"与 plan 的**声明**逐节点对账（不一致就点名）。
        if outcome.confidence != declared_confidence {
            trace.confidence_violations.push(ConfidenceViolation {
                node_id: node.node_id.clone(),
                declared: declared_confidence,
                actual: outcome.confidence,
            });
        }
        actual_confidence = Some(match actual_confidence {
            None => outcome.confidence,
            Some(current) => most_conservative(current, outcome.confidence),
        });
        // 该节点声明的资源**按声明顺序**压栈（释放时逆序）。
        for resource in &plan.resources {
            if &resource.declared_by == node_id {
                release_stack.push(resource.resource_id.clone());
            }
        }
        trace.totals.record(outcome.verdict);
        trace.steps.push(StepTrace {
            node_id: node.node_id.clone(),
            tool_kind: node.tool_kind.clone(),
            order: index,
            verdict: outcome.verdict,
            confidence: outcome.confidence,
            duration_ms: outcome.duration_ms,
            detail: outcome.detail,
            assertions: outcome.assertions,
            notes: outcome.notes,
        });
    }

    // 逆序释放
    release_stack.reverse();
    for resource_id in &release_stack {
        match releaser.release(resource_id) {
            Ok(()) => trace.released.push(resource_id.clone()),
            Err(error) => trace.release_failures.push(ReleaseFailure {
                resource_id: resource_id.clone(),
                error,
            }),
        }
    }

    // 残留探测（放在释放之后：口径是"清干净了吗"）
    for resource_id in &release_stack {
        match probe.probe(resource_id) {
            ResidueState::Clean => {}
            ResidueState::Busy(reason) => trace
                .leftovers
                .push(format!("busy:{resource_id}（{reason}）")),
            ResidueState::Unknown(reason) => {
                trace
                    .leftovers
                    .push(format!("unknown:{resource_id}（{reason}）"));
            }
        }
    }
    trace.leftovers.sort();
    trace.leftovers.dedup();
    trace.confidence = actual_confidence;

    trace
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsh_testkit_protocol::plan::{Layer, ScenarioMetadata};
    use serde_json::json;

    fn node(id: &str) -> ToolNode {
        ToolNode {
            node_id: id.to_string(),
            tool_kind: "call-tool".to_string(),
            input: json!({}),
            gate: None,
            retry: None,
            timeout_ms: None,
            min_confidence: None,
        }
    }

    fn edge(from: &str, to: &str) -> Edge {
        Edge {
            from: from.to_string(),
            to: to.to_string(),
        }
    }

    struct Scripted;
    impl NodeRunner for Scripted {
        fn run(&self, node: &ToolNode, _order: usize) -> NodeOutcome {
            NodeOutcome {
                verdict: if node.node_id == "b" {
                    AssertionVerdict::Inconclusive
                } else {
                    AssertionVerdict::Passed
                },
                confidence: ConfidenceLevel::Real,
                duration_ms: 1,
                detail: None,
                assertions: Vec::new(),
                notes: Map::new(),
            }
        }
    }

    struct FailingRelease;
    impl ResourceReleaser for FailingRelease {
        fn release(&self, resource_id: &str) -> Result<(), String> {
            if resource_id == "sessions" {
                Err("disposer 炸了".to_string())
            } else {
                Ok(())
            }
        }
    }

    struct UnknownProbe;
    impl LeftoverProbe for UnknownProbe {
        fn probe(&self, resource_id: &str) -> ResidueState {
            if resource_id == "sessions" {
                ResidueState::Unknown("探测超时".to_string())
            } else {
                ResidueState::Clean
            }
        }
    }

    fn plan() -> ExecutionPlan {
        ExecutionPlan {
            nodes: vec![node("a"), node("b")],
            edges: vec![edge("a", "b")],
            metadata: ScenarioMetadata {
                scenario_id: "TK-0001".to_string(),
                title: "自检".to_string(),
                layer: Layer::L3,
                confidence: ConfidenceLevel::Real,
                shared_context: false,
                depth: 1,
                seed: None,
            },
            resources: vec![
                dsh_testkit_protocol::plan::ResourceClaim {
                    resource_id: "tmpdir".to_string(),
                    kind: "dir".to_string(),
                    exclusive: true,
                    declared_by: "a".to_string(),
                },
                dsh_testkit_protocol::plan::ResourceClaim {
                    resource_id: "sessions".to_string(),
                    kind: "session".to_string(),
                    exclusive: true,
                    declared_by: "b".to_string(),
                },
            ],
        }
    }

    #[test]
    fn topological_order_is_deterministic() {
        let plan = plan();
        assert_eq!(
            topological_order(&plan.nodes, &plan.edges).unwrap(),
            vec!["a".to_string(), "b".to_string()]
        );
    }

    #[test]
    fn cycle_is_reported_as_stuck_nodes() {
        let nodes = vec![node("a"), node("b")];
        let edges = vec![edge("a", "b"), edge("b", "a")];
        let stuck = topological_order(&nodes, &edges).unwrap_err();
        assert_eq!(stuck, vec!["a".to_string(), "b".to_string()]);
    }

    #[test]
    fn release_is_reverse_order_and_failures_are_visible() {
        let trace = execute_plan(&plan(), &Scripted, &FailingRelease, &UnknownProbe);
        // 逆序：先 sessions（b 声明的），再 tmpdir（a 声明的）
        assert_eq!(trace.released, vec!["tmpdir".to_string()]);
        assert_eq!(trace.release_failures.len(), 1);
        assert_eq!(trace.release_failures[0].resource_id, "sessions");
        // 探不到标 unknown，绝不标干净
        assert!(trace
            .leftovers
            .iter()
            .any(|item| item.starts_with("unknown:sessions")));
    }

    #[test]
    fn inconclusive_is_counted_separately_from_passed() {
        let trace = execute_plan(&plan(), &Scripted, &FailingRelease, &UnknownProbe);
        assert_eq!(trace.totals.total, 2);
        assert_eq!(trace.totals.passed, 1);
        assert_eq!(trace.totals.inconclusive, 1);
        assert_eq!(trace.totals.failed, 0);
    }
}
