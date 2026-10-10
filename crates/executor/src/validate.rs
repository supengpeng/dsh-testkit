//! plan 校验（设计 §5.3 的**第 3 层防御**：运行期检查）。
//!
//! 四层防御里，前两层是 TS 的类型系统与编译器 `validate`；本模块是**Rust 侧**
//! 在启动前做的最后一道运行期检查。三项必查：
//!
//! 1. **能力探测前置**：把 plan 里所有节点的 `requires` 取并集，**一次性 `probe_all`**；
//!    缺失且必需者按设计 §3.4 的裁决表决策，**不进入执行**（避免跑一半才发现）。
//! 2. **资源锁（F3）**：两个**无序**（依赖图上互不可达）的节点声明同一个资源、
//!    且至少一方要求独占 → 冲突，**点名到节点 id**。
//! 3. **依赖环（F4）**：拓扑排序前先找环，有环则**点名环上的节点 id**。
//!
//! 另外三项防御性检查：空 plan、节点 id 重复、边引用了不存在的节点。
//! 它们同样**点名**，因为"哪条 plan 坏了"必须能直接定位。

use std::collections::{BTreeMap, BTreeSet};

use dsh_testkit_capability::{
    decide, CapabilityGate, CapabilityId, CapabilityState, GateDecision, Preset,
};
use dsh_testkit_protocol::plan::{ConfidenceLevel, ExecutionPlan, Layer, OnMissing};

use crate::MAX_PLAN_DEPTH;

/// 一条校验问题的种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PlanIssueKind {
    /// plan 里没有任何节点。
    EmptyPlan,
    /// 节点 id 重复。
    DuplicateNodeId,
    /// 边引用了不存在的节点。
    UnknownEdgeEndpoint,
    /// 依赖图有环（F4）。
    DependencyCycle,
    /// 资源冲突（F3）。
    ResourceConflict,
    /// `requires` 里出现了不认识的 CapabilityId。
    UnknownCapability,
    /// 必需能力缺失（按 §3.4 裁决为 `Fail`）。
    MissingCapability,
    /// 嵌套深度超过三层（编译器硬规则）。
    DepthExceeded,
    /// 可信度低于"可进入发布门槛"的要求（设计 §8.4 硬约束 1）。
    ConfidenceBelowGate,
    /// **K1**：层级标记与可信度**不一致**（`metadata.layer` → 允许的 `confidence`；
    /// 判据真源见 [`allowed_confidence_for`]）。
    LayerConfidenceMismatch,
}

impl PlanIssueKind {
    /// 稳定的短名（进报告与错误信息）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyPlan => "empty-plan",
            Self::DuplicateNodeId => "duplicate-node-id",
            Self::UnknownEdgeEndpoint => "unknown-edge-endpoint",
            Self::DependencyCycle => "dependency-cycle",
            Self::ResourceConflict => "resource-conflict",
            Self::UnknownCapability => "unknown-capability",
            Self::MissingCapability => "missing-capability",
            Self::DepthExceeded => "depth-exceeded",
            Self::ConfidenceBelowGate => "confidence-below-gate",
            Self::LayerConfidenceMismatch => "layer-confidence-mismatch",
        }
    }

    /// 是否阻断执行（"不进入执行"的判据）。
    pub fn blocks_execution(self) -> bool {
        !matches!(self, Self::ConfidenceBelowGate)
    }
}

/// 一条校验问题。**必须带节点 id**（除非问题本身与节点无关）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanIssue {
    /// 问题种类。
    pub kind: PlanIssueKind,
    /// 相关节点 id（有序；环与冲突都会点名到具体节点）。
    pub node_ids: Vec<String>,
    /// 人读说明。
    pub message: String,
}

/// 一个能力的门控决策（进报告，回答"为什么没跑"）。
#[derive(Debug, Clone, PartialEq)]
pub struct CapabilityDecision {
    /// 能力名（`CapabilityId::name`）。
    pub capability: String,
    /// 裁决结果（设计 §3.4）。
    pub decision: GateDecision,
    /// 该能力是否被声明为必需（任一节点 `on_missing = fail`）。
    pub mandatory: bool,
}

/// 校验结果。
#[derive(Debug, Clone, PartialEq)]
pub struct PlanValidation {
    /// 全部问题（按种类与节点名有序）。
    pub issues: Vec<PlanIssue>,
    /// 能力决策（即使没问题也记，供报告解释"为什么放行"）。
    pub decisions: Vec<CapabilityDecision>,
    /// 是否允许进入执行。
    pub execution_allowed: bool,
    /// 该 plan 的可信度是否可进入发布门槛判定（设计 §8.4 硬约束 1）。
    pub release_allowed: bool,
}

impl PlanValidation {
    /// 按种类筛选问题。
    pub fn issues_of(&self, kind: PlanIssueKind) -> Vec<&PlanIssue> {
        self.issues
            .iter()
            .filter(|issue| issue.kind == kind)
            .collect()
    }

    /// 某类问题是否出现。
    pub fn has(&self, kind: PlanIssueKind) -> bool {
        self.issues.iter().any(|issue| issue.kind == kind)
    }
}

/// 把能力名映射到 [`CapabilityId`]（`requires` 里写的是 TS 侧的名字）。
pub fn capability_id_of(name: &str) -> Option<CapabilityId> {
    CapabilityId::ALL
        .iter()
        .copied()
        .find(|capability| capability.name() == name)
}

/// **K1 的判据真源**：某个层级**允许**哪些可信度标记（设计 §8.1 四态 + §8.2 七层模型）。
///
/// 逐条依据（`docs/REWRITE-DESIGN.md`，不自行发明规则）：
///
/// * **§8.1**（`:704-709`）定义四态：
///   `Real` = 真实宿主 + 真实能力；`Simulated` = 模拟宿主或模拟能力；
///   `Degraded` = **真实宿主**但部分能力降级（fallback）；`Static` = 未执行。
/// * **§8.2**（`:717-726`）的七层表逐行给出"宿主 / 能力"与"可信度"：
///   L0 无宿主 → `Static`（本工具**不参与**）；L1、L2 = Mock/Mock → `Simulated`；
///   L3、L4、L5、L6 = 真实/真实 → `Real`。
/// * **`Degraded` 不在层级表里**：它是**真实宿主上的降级态**（§8.1），
///   所以只可能出现在 L3–L6（真实宿主层），不可能出现在 L0–L2（模拟/无宿主）。
///
/// 注意 `Layer` 是 `#[non_exhaustive]`（跨 crate）：新增层级时**必须**在这里显式裁决。
/// 缺省返回**空集**（不认识的层级不放行任何可信度）——"不认识的东西不放行"，
/// 而不是静默通过。
pub fn allowed_confidence_for(layer: Layer) -> &'static [ConfidenceLevel] {
    match layer {
        Layer::L0 => &[ConfidenceLevel::Static],
        Layer::L1 | Layer::L2 => &[ConfidenceLevel::Simulated],
        Layer::L3 | Layer::L4 | Layer::L5 | Layer::L6 => {
            &[ConfidenceLevel::Real, ConfidenceLevel::Degraded]
        }
        _ => &[],
    }
}

/// **K1 的判定**：这条 `(层级, 可信度)` 标记是否合法。
///
/// 它是"标记本身对不对"的唯一判据；**不管**结果有没有被误用（那是 K2/K4 的事）。
pub fn layer_confidence_ok(layer: Layer, confidence: ConfidenceLevel) -> bool {
    allowed_confidence_for(layer).contains(&confidence)
}

/// 从 `from` 出发能否到达 `to`（用于判断两个节点是否"无序"）。
fn reaches(edges: &[(String, String)], from: &str, to: &str) -> bool {
    let mut stack: Vec<&str> = vec![from];
    let mut visited: BTreeSet<&str> = BTreeSet::new();
    while let Some(current) = stack.pop() {
        if current == to {
            return true;
        }
        if !visited.insert(current) {
            continue;
        }
        for (edge_from, edge_to) in edges {
            if edge_from.as_str() == current {
                stack.push(edge_to.as_str());
            }
        }
    }
    false
}

/// 找一条环（返回环上的节点，按名有序）。没有环返回 `None`。
fn find_cycle(edges: &[(String, String)]) -> Option<Vec<String>> {
    let mut adjacency: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for (from, to) in edges {
        adjacency
            .entry(from.as_str())
            .or_default()
            .insert(to.as_str());
    }
    let mut colour: BTreeMap<&str, u8> = BTreeMap::new(); // 0 未访问 1 在栈 2 完成
    let mut path: Vec<&str> = Vec::new();

    fn visit<'a>(
        node: &'a str,
        adjacency: &BTreeMap<&'a str, BTreeSet<&'a str>>,
        colour: &mut BTreeMap<&'a str, u8>,
        path: &mut Vec<&'a str>,
    ) -> Option<Vec<String>> {
        colour.insert(node, 1);
        path.push(node);
        if let Some(neighbours) = adjacency.get(node) {
            for neighbour in neighbours {
                match colour.get(neighbour).copied().unwrap_or(0) {
                    1 => {
                        let start = path.iter().position(|item| item == neighbour).unwrap_or(0);
                        let mut cycle: Vec<String> = path[start..]
                            .iter()
                            .map(|item| (*item).to_string())
                            .collect();
                        cycle.push((*neighbour).to_string());
                        cycle.sort();
                        cycle.dedup();
                        return Some(cycle);
                    }
                    0 => {
                        if let Some(cycle) = visit(neighbour, adjacency, colour, path) {
                            return Some(cycle);
                        }
                    }
                    _ => {}
                }
            }
        }
        path.pop();
        colour.insert(node, 2);
        None
    }

    for node in adjacency.keys().copied().collect::<Vec<_>>() {
        if colour.get(node).copied().unwrap_or(0) == 0 {
            if let Some(cycle) = visit(node, &adjacency, &mut colour, &mut path) {
                return Some(cycle);
            }
        }
    }
    None
}

/// 找出**所有**不相交的环（逐个检出后把已发现环上的边移除，再找下一个）。
///
/// 为什么不是"只报第一条"：一条 plan 里可能存在两个互不相交的环，
/// 只报一条会让另一处缺陷藏在报告之外（F4 的"点名"要求覆盖每个坏节点）。
fn find_cycles(edges: &[(String, String)]) -> Vec<Vec<String>> {
    let mut remaining = edges.to_vec();
    let mut found: Vec<Vec<String>> = Vec::new();
    // 防御：环数不可能超过边数，但显式封顶避免任何病态输入把校验拖死。
    while found.len() <= edges.len() {
        let Some(cycle) = find_cycle(&remaining) else {
            break;
        };
        let members: BTreeSet<&String> = cycle.iter().collect();
        remaining.retain(|(from, to)| !(members.contains(from) && members.contains(to)));
        found.push(cycle);
    }
    found
}

/// 资源冲突（F3）：**无序**且共享同一资源、至少一方独占 → 冲突并点名。
fn resource_conflicts(plan: &ExecutionPlan) -> Vec<PlanIssue> {
    let edges: Vec<(String, String)> = plan
        .edges
        .iter()
        .map(|edge| (edge.from.clone(), edge.to.clone()))
        .collect();
    let mut found: BTreeSet<(String, String)> = BTreeSet::new();
    let mut issues = Vec::new();

    let resources = &plan.resources;
    for (index, left) in resources.iter().enumerate() {
        for right in resources.iter().skip(index + 1) {
            if left.resource_id != right.resource_id {
                continue;
            }
            if left.declared_by == right.declared_by {
                continue;
            }
            // 共享读（双方都非独占）可以并行；只要有一方独占就冲突。
            if !(left.exclusive || right.exclusive) {
                continue;
            }
            // 有序则串行执行不冲突：只有**互不可达**才是真冲突。
            if reaches(&edges, &left.declared_by, &right.declared_by)
                || reaches(&edges, &right.declared_by, &left.declared_by)
            {
                continue;
            }
            let (first, second) = if left.declared_by <= right.declared_by {
                (left.declared_by.clone(), right.declared_by.clone())
            } else {
                (right.declared_by.clone(), left.declared_by.clone())
            };
            if !found.insert((first.clone(), second.clone())) {
                continue;
            }
            issues.push(PlanIssue {
                kind: PlanIssueKind::ResourceConflict,
                node_ids: vec![first.clone(), second.clone()],
                message: format!(
                    "资源 `{}` 被 `{first}` 与 `{second}` 无序共享且要求独占（F3 资源冲突）",
                    left.resource_id
                ),
            });
        }
    }
    issues
}

/// 校验一条 plan。
///
/// `gate` 是能力门控（`crates/capability`）；`preset` 决定缺能力时的裁决档位。
pub fn validate_plan(
    plan: &ExecutionPlan,
    gate: &dyn CapabilityGate,
    preset: Preset,
) -> PlanValidation {
    let mut issues: Vec<PlanIssue> = Vec::new();
    let mut decisions: Vec<CapabilityDecision> = Vec::new();

    // 1. 空 plan
    if plan.nodes.is_empty() {
        issues.push(PlanIssue {
            kind: PlanIssueKind::EmptyPlan,
            node_ids: Vec::new(),
            message: "plan 里没有任何节点，无法执行".to_string(),
        });
    }

    // 2. 节点 id 唯一
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    let mut duplicates: BTreeSet<String> = BTreeSet::new();
    for node in &plan.nodes {
        if !seen.insert(node.node_id.as_str()) {
            duplicates.insert(node.node_id.clone());
        }
    }
    for node_id in &duplicates {
        issues.push(PlanIssue {
            kind: PlanIssueKind::DuplicateNodeId,
            node_ids: vec![node_id.clone()],
            message: format!("节点 id `{node_id}` 重复"),
        });
    }

    // 3. 边的端点必须存在
    let known: BTreeSet<&str> = plan
        .nodes
        .iter()
        .map(|node| node.node_id.as_str())
        .collect();
    let mut dangling: BTreeSet<String> = BTreeSet::new();
    for edge in &plan.edges {
        if !known.contains(edge.from.as_str()) {
            dangling.insert(edge.from.clone());
        }
        if !known.contains(edge.to.as_str()) {
            dangling.insert(edge.to.clone());
        }
    }
    for node_id in &dangling {
        issues.push(PlanIssue {
            kind: PlanIssueKind::UnknownEdgeEndpoint,
            node_ids: vec![node_id.clone()],
            message: format!("边引用了不存在的节点 `{node_id}`"),
        });
    }

    // 4. 依赖环（F4）
    let edges: Vec<(String, String)> = plan
        .edges
        .iter()
        .map(|edge| (edge.from.clone(), edge.to.clone()))
        .collect();
    for cycle in find_cycles(&edges) {
        issues.push(PlanIssue {
            kind: PlanIssueKind::DependencyCycle,
            node_ids: cycle.clone(),
            message: format!("依赖图有环，环上节点：{}", cycle.join(" → ")),
        });
    }

    // 5. 资源冲突（F3）
    issues.extend(resource_conflicts(plan));

    // 6. 嵌套深度
    if plan.metadata.depth > MAX_PLAN_DEPTH {
        issues.push(PlanIssue {
            kind: PlanIssueKind::DepthExceeded,
            node_ids: Vec::new(),
            message: format!(
                "嵌套深度 {} 超过上界 {MAX_PLAN_DEPTH}（编译器硬规则）",
                plan.metadata.depth
            ),
        });
    }

    // 7. 能力探测前置：并集 → 一次性 probe_all
    let mut required: BTreeSet<String> = BTreeSet::new();
    let mut mandatory: BTreeMap<String, bool> = BTreeMap::new();
    for node in &plan.nodes {
        let Some(spec) = &node.gate else {
            continue;
        };
        for name in &spec.requires {
            required.insert(name.clone());
            let is_mandatory = matches!(spec.on_missing, OnMissing::Fail);
            let slot = mandatory.entry(name.clone()).or_insert(false);
            *slot = *slot || is_mandatory;
        }
    }

    let mut probed: Vec<(String, CapabilityId, bool)> = Vec::new();
    for name in &required {
        match capability_id_of(name) {
            Some(id) => {
                let is_mandatory = mandatory.get(name).copied().unwrap_or(false);
                probed.push((name.clone(), id, is_mandatory));
            }
            None => issues.push(PlanIssue {
                kind: PlanIssueKind::UnknownCapability,
                node_ids: Vec::new(),
                message: format!("`requires` 里的 `{name}` 不是已知的 CapabilityId"),
            }),
        }
    }

    let ids: Vec<CapabilityId> = probed.iter().map(|(_, id, _)| *id).collect();
    let map = gate.probe_all(&ids);
    for (name, id, is_mandatory) in &probed {
        // 探不到（map 里没有）按 `Unknown` 处理——**不假装可用**。
        let state = map.get(id).cloned().unwrap_or(CapabilityState::Unknown);
        let decision = decide(preset, &state, *is_mandatory);
        if matches!(decision, GateDecision::Fail { .. }) {
            issues.push(PlanIssue {
                kind: PlanIssueKind::MissingCapability,
                node_ids: Vec::new(),
                message: format!("必需能力 `{name}` 不可用：{decision:?}"),
            });
        }
        decisions.push(CapabilityDecision {
            capability: name.clone(),
            decision,
            mandatory: *is_mandatory,
        });
    }

    // 7b. K1：层级 → 可信度的**标记自洽性**（判据真源见 `allowed_confidence_for`）。
    // 标记错了就不该进入执行——否则后面所有"按可信度分流"的判断都建立在错标记上。
    if !layer_confidence_ok(plan.metadata.layer, plan.metadata.confidence) {
        issues.push(PlanIssue {
            kind: PlanIssueKind::LayerConfidenceMismatch,
            node_ids: Vec::new(),
            message: format!(
                "层级标记与可信度不一致：layer={:?} 只允许 {:?}，实际标记 {:?}",
                plan.metadata.layer,
                allowed_confidence_for(plan.metadata.layer),
                plan.metadata.confidence
            ),
        });
    }

    // 8. 可信度门槛（不阻断执行，只影响"能否进入发布门槛判定"）
    let release_allowed = plan.metadata.confidence.accepted_for_release();
    if !release_allowed && matches!(preset, Preset::Release) {
        issues.push(PlanIssue {
            kind: PlanIssueKind::ConfidenceBelowGate,
            node_ids: Vec::new(),
            message: format!(
                "`release` 档只接受 real 可信度的结果，实际是 {:?}",
                plan.metadata.confidence
            ),
        });
    }

    issues.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.node_ids.cmp(&right.node_ids))
    });
    decisions.sort_by(|left, right| left.capability.cmp(&right.capability));

    let execution_allowed = !issues.iter().any(|issue| issue.kind.blocks_execution());

    PlanValidation {
        issues,
        decisions,
        execution_allowed,
        release_allowed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dsh_testkit_protocol::plan::{ConfidenceLevel, Edge, Layer, ScenarioMetadata, ToolNode};
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

    fn plan(nodes: Vec<ToolNode>, edges: Vec<(&str, &str)>) -> ExecutionPlan {
        ExecutionPlan {
            nodes,
            edges: edges
                .into_iter()
                .map(|(from, to)| Edge {
                    from: from.to_string(),
                    to: to.to_string(),
                })
                .collect(),
            metadata: ScenarioMetadata {
                scenario_id: "TK-0001".to_string(),
                title: "自检".to_string(),
                layer: Layer::L3,
                confidence: ConfidenceLevel::Real,
                shared_context: false,
                depth: 1,
                seed: Some(7),
            },
            resources: Vec::new(),
        }
    }

    #[test]
    fn detects_duplicate_ids_and_dangling_edges() {
        let validation = validate_plan(
            &plan(vec![node("a"), node("a")], vec![("a", "ghost")]),
            &dsh_testkit_capability::DefaultCapabilityGate::new("0.2.0-rc.2"),
            Preset::Freeze,
        );
        assert!(validation.has(PlanIssueKind::DuplicateNodeId));
        assert!(validation.has(PlanIssueKind::UnknownEdgeEndpoint));
        assert!(!validation.execution_allowed);
    }

    #[test]
    fn detects_cycle_and_names_every_node_on_it() {
        let validation = validate_plan(
            &plan(
                vec![node("a"), node("b"), node("c")],
                vec![("a", "b"), ("b", "c"), ("c", "a")],
            ),
            &dsh_testkit_capability::DefaultCapabilityGate::new("0.2.0-rc.2"),
            Preset::Freeze,
        );
        let cycles = validation.issues_of(PlanIssueKind::DependencyCycle);
        assert_eq!(cycles.len(), 1);
        assert_eq!(
            cycles[0].node_ids,
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
    }

    #[test]
    fn ordered_shared_resource_is_not_a_conflict() {
        let mut plan = plan(vec![node("a"), node("b")], vec![("a", "b")]);
        plan.resources = vec![
            dsh_testkit_protocol::plan::ResourceClaim {
                resource_id: "sessions".to_string(),
                kind: "session".to_string(),
                exclusive: true,
                declared_by: "a".to_string(),
            },
            dsh_testkit_protocol::plan::ResourceClaim {
                resource_id: "sessions".to_string(),
                kind: "session".to_string(),
                exclusive: true,
                declared_by: "b".to_string(),
            },
        ];
        let validation = validate_plan(
            &plan,
            &dsh_testkit_capability::DefaultCapabilityGate::new("0.2.0-rc.2"),
            Preset::Freeze,
        );
        assert!(
            !validation.has(PlanIssueKind::ResourceConflict),
            "有序共享不是冲突：{validation:?}"
        );
    }
}
