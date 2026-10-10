//! F2 / F3 / F4 的机器读数。
//!
//! * **F2**（plan 校验拦截率 ≥ 95%）：一组**错误注入**，逐条检查是否被拦下。
//! * **F3**（资源冲突检出率 = 100%）：注入无序共享 + 独占，必须检出并**点名到节点 id**。
//! * **F4**（依赖环检出率 = 100%）：注入多种环，必须检出并**点名环上节点**。
//!
//! 每条指标都配**负向对照**（合法 plan 不得被误报）——否则"拦截率高"可能只是"什么都拦"。

use std::collections::BTreeSet;

use dsh_testkit_capability::{DefaultCapabilityGate, Preset};
use dsh_testkit_executor::{
    validate_plan, ConfidenceLevel, Edge, ExecutionPlan, Layer, OnMissing, PlanIssueKind,
    PlanValidation, ResourceClaim, ScenarioMetadata, ToolNode,
};
use serde_json::json;

/// 一种环形状：名字 + 边集 + 期望被点名的节点。
type CycleShape = (
    &'static str,
    Vec<(&'static str, &'static str)>,
    Vec<&'static str>,
);

/// 一个资源冲突用例：名字 + 资源声明集。
type ConflictCase = (&'static str, Vec<ResourceClaim>);

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

fn node_with_capability(id: &str, capability: &str, mandatory: bool) -> ToolNode {
    let mut built = node(id);
    built.gate = Some(dsh_testkit_executor::GateSpec {
        requires: vec![capability.to_string()],
        on_missing: if mandatory {
            OnMissing::Fail
        } else {
            OnMissing::Skip
        },
        fallback: None,
    });
    built
}

fn edge(from: &str, to: &str) -> Edge {
    Edge {
        from: from.to_string(),
        to: to.to_string(),
    }
}

fn plan(nodes: Vec<ToolNode>, edges: Vec<Edge>, resources: Vec<ResourceClaim>) -> ExecutionPlan {
    ExecutionPlan {
        nodes,
        edges,
        metadata: ScenarioMetadata {
            scenario_id: "TK-9001".to_string(),
            title: "注入".to_string(),
            layer: Layer::L3,
            confidence: ConfidenceLevel::Real,
            shared_context: false,
            depth: 1,
            seed: Some(1),
        },
        resources,
    }
}

fn exclusive(resource: &str, by: &str) -> ResourceClaim {
    ResourceClaim {
        resource_id: resource.to_string(),
        kind: "session".to_string(),
        exclusive: true,
        declared_by: by.to_string(),
    }
}

fn shared(resource: &str, by: &str) -> ResourceClaim {
    ResourceClaim {
        resource_id: resource.to_string(),
        kind: "dir".to_string(),
        exclusive: false,
        declared_by: by.to_string(),
    }
}

fn validate(plan: &ExecutionPlan) -> PlanValidation {
    validate_plan(
        plan,
        &DefaultCapabilityGate::new("0.2.0-rc.2"),
        Preset::Release,
    )
}

/// F4：多种环形状都必须被检出，且点名到环上的每个节点。
#[test]
fn f4_dependency_cycle_detection_is_complete_and_pointed() {
    let shapes: Vec<CycleShape> = vec![
        ("自环", vec![("a", "a")], vec!["a"]),
        ("二元环", vec![("a", "b"), ("b", "a")], vec!["a", "b"]),
        (
            "三元环",
            vec![("a", "b"), ("b", "c"), ("c", "a")],
            vec!["a", "b", "c"],
        ),
        (
            "带尾巴的环",
            vec![("x", "a"), ("a", "b"), ("b", "c"), ("c", "a")],
            vec!["a", "b", "c"],
        ),
        (
            "两个不相交的环",
            vec![("a", "b"), ("b", "a"), ("c", "d"), ("d", "c")],
            vec!["a", "b", "c", "d"],
        ),
    ];

    let mut detected = 0usize;
    for (label, edges, expected) in &shapes {
        let node_ids: Vec<&str> = {
            let mut ids: Vec<&str> = edges.iter().flat_map(|(from, to)| [*from, *to]).collect();
            ids.sort_unstable();
            ids.dedup();
            ids
        };
        let built = plan(
            node_ids.iter().map(|id| node(id)).collect(),
            edges.iter().map(|(from, to)| edge(from, to)).collect(),
            Vec::new(),
        );
        let validation = validate(&built);
        let cycles = validation.issues_of(PlanIssueKind::DependencyCycle);
        assert!(
            !cycles.is_empty(),
            "F4 漏检：{label} 的环没有被检出（{:?}）",
            validation.issues
        );
        // 并集：一条 plan 里可能有多个不相交的环，每个坏节点都要被点到。
        let named: BTreeSet<String> = cycles
            .iter()
            .flat_map(|cycle| cycle.node_ids.clone())
            .collect();
        for expected_id in expected {
            assert!(
                named.contains(*expected_id),
                "F4 点名不全：{label} 的环上节点 {expected_id} 没被点出（实际 {named:?}）"
            );
        }
        assert!(!validation.execution_allowed, "{label} 必须阻断执行");
        detected += 1;
    }
    println!("F4 环检出率：{detected}/{}", shapes.len());
    assert_eq!(detected, shapes.len(), "F4 检出率必须 100%");
}

/// F3：无序共享 + 独占必须检出并点名；有序或纯共享不得误报。
#[test]
fn f3_resource_conflict_detection_is_complete_and_pointed() {
    // 真冲突：无序（无依赖边）共享同一资源且至少一方独占。
    let conflicts: Vec<ConflictCase> = vec![
        (
            "双独占",
            vec![exclusive("sessions", "a"), exclusive("sessions", "b")],
        ),
        (
            "一独占一共享",
            vec![exclusive("sessions", "a"), shared("sessions", "b")],
        ),
        (
            "三节点同资源",
            vec![
                exclusive("tmpdir", "a"),
                shared("tmpdir", "b"),
                exclusive("tmpdir", "c"),
            ],
        ),
    ];
    let mut detected = 0usize;
    for (label, resources) in &conflicts {
        let built = plan(
            vec![node("a"), node("b"), node("c")],
            Vec::new(),
            resources.clone(),
        );
        let validation = validate(&built);
        let found = validation.issues_of(PlanIssueKind::ResourceConflict);
        assert!(
            !found.is_empty(),
            "F3 漏检：{label}（{:?}）",
            validation.issues
        );
        assert!(
            found[0].node_ids.len() >= 2,
            "F3 必须点名到具体节点 id：{label} → {:?}",
            found[0]
        );
        assert!(!validation.execution_allowed, "{label} 必须阻断执行");
        detected += 1;
    }
    assert_eq!(detected, conflicts.len(), "F3 检出率必须 100%");
    println!("F3 冲突检出率：{detected}/{}", conflicts.len());

    // 负向对照：有序共享不是冲突；纯共享读也不是冲突。
    let ordered = plan(
        vec![node("a"), node("b")],
        vec![edge("a", "b")],
        vec![exclusive("sessions", "a"), exclusive("sessions", "b")],
    );
    assert!(
        !validate(&ordered).has(PlanIssueKind::ResourceConflict),
        "有序共享（a → b）不得误报冲突"
    );

    let read_only = plan(
        vec![node("a"), node("b")],
        Vec::new(),
        vec![shared("tmpdir", "a"), shared("tmpdir", "b")],
    );
    assert!(
        !validate(&read_only).has(PlanIssueKind::ResourceConflict),
        "纯共享读不得误报冲突"
    );
}

/// F2：错误注入集 → 拦截率（门槛 ≥ 95%）。
#[test]
fn f2_plan_validation_interception_rate() {
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");

    let mut structural: Vec<(&str, ExecutionPlan)> = vec![
        ("空 plan", plan(Vec::new(), Vec::new(), Vec::new())),
        (
            "节点 id 重复",
            plan(vec![node("a"), node("a")], Vec::new(), Vec::new()),
        ),
        (
            "边起点不存在",
            plan(vec![node("a")], vec![edge("ghost", "a")], Vec::new()),
        ),
        (
            "边终点不存在",
            plan(vec![node("a")], vec![edge("a", "ghost")], Vec::new()),
        ),
        (
            "自环",
            plan(vec![node("a")], vec![edge("a", "a")], Vec::new()),
        ),
        (
            "二元环",
            plan(
                vec![node("a"), node("b")],
                vec![edge("a", "b"), edge("b", "a")],
                Vec::new(),
            ),
        ),
        (
            "资源冲突",
            plan(
                vec![node("a"), node("b")],
                Vec::new(),
                vec![exclusive("sessions", "a"), exclusive("sessions", "b")],
            ),
        ),
    ];

    let mut depth_plan = plan(vec![node("a")], Vec::new(), Vec::new());
    depth_plan.metadata.depth = 4;
    structural.push(("深度超限", depth_plan));

    let mut deep_plan = plan(vec![node("a")], Vec::new(), Vec::new());
    deep_plan.metadata.depth = 255;
    structural.push(("深度远超", deep_plan));

    let mut intercepted = 0usize;
    for (label, built) in &structural {
        let validation = validate_plan(built, &gate, Preset::Release);
        let blocked = !validation.execution_allowed;
        println!(
            "F2 结构注入 [{label}] → {}",
            if blocked { "拦截" } else { "放行" }
        );
        if blocked {
            intercepted += 1;
        }
    }
    assert_eq!(
        intercepted,
        structural.len(),
        "结构性错误的拦截率必须是 100%（{intercepted}/{}）",
        structural.len()
    );

    // 能力相关注入：未知能力名必拦；必需能力缺失按 §3.4 裁决。
    let unknown = plan(
        vec![node_with_capability("a", "not-a-capability", true)],
        Vec::new(),
        Vec::new(),
    );
    let unknown_validation = validate_plan(&unknown, &gate, Preset::Release);
    assert!(
        unknown_validation.has(PlanIssueKind::UnknownCapability),
        "未知能力名必须拦下：{:?}",
        unknown_validation.issues
    );

    let mandatory = plan(
        vec![node_with_capability("a", "subprocess", true)],
        Vec::new(),
        Vec::new(),
    );
    let mandatory_validation = validate_plan(&mandatory, &gate, Preset::Release);
    println!(
        "F2 能力注入 [必需能力 subprocess] → 决策 {:?}，allowed={}",
        mandatory_validation.decisions, mandatory_validation.execution_allowed
    );

    assert!(
        !mandatory_validation.execution_allowed,
        "必需能力缺失必须阻断执行（§3.4：严格档下必需能力缺失 → Fail）"
    );

    // 两条能力注入都已被上面的断言钉住，一并计入分子。
    let total = structural.len() + 2;
    let intercepted_total = intercepted + 2;
    let rate = intercepted_total as f64 / total as f64 * 100.0;
    println!("F2 拦截率：{rate:.1}%（{intercepted_total}/{total}）");
    assert!(rate >= 95.0, "F2 拦截率必须 ≥ 95%，实际 {rate:.1}%");
}

/// 负向对照：合法 plan 不得被误报（否则"拦截率"没有意义）。
#[test]
fn valid_plans_are_not_blocked() {
    let gate = DefaultCapabilityGate::new("0.2.0-rc.2");

    let chain = plan(
        vec![node("a"), node("b"), node("c")],
        vec![edge("a", "b"), edge("b", "c")],
        vec![exclusive("tmpdir", "a"), exclusive("sessions", "b")],
    );
    let validation = validate_plan(&chain, &gate, Preset::Freeze);
    assert!(
        validation.execution_allowed,
        "合法 plan 不该被拦：{:?}",
        validation.issues
    );

    // 同一份 plan 在 release 档下不得因为"可信度"把执行拦掉（它只影响发布门槛）。
    let release = validate_plan(&chain, &gate, Preset::Release);
    assert!(release.execution_allowed);
    assert!(release.release_allowed, "Real 可信度应可进入发布门槛");
}
