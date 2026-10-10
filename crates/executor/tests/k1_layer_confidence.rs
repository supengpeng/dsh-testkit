//! K1 —— **层级可信度正确率**（定义在 `REWRITE-METRICS.md:267`）。
//!
//! **定义（原文）**：*层级标记的可信度与实际执行一致的比例*；门槛 **100%**；
//! 测量方式是"**构造每层场景，验证标记**"。
//!
//! # 先分清 K1 与它的两个邻居（`REWRITE-METRICS.md:267-272`）
//!
//! | 指标 | 测什么 | 会漏掉什么 |
//! |---|---|---|
//! | **K1（本文件）** | **标记本身对不对**（层级 → 可信度） | 结果被误用的情形 |
//! | K2 | 进入发布门槛判定的结果**全部为 `Real`** | 「用户用 `--allow-simulated` 绕过」 |
//! | K4 | `release` 档下 `Simulated` 结果被**拦截**的比例 | 「标记本身错了」 |
//!
//! METRICS 的原话是「只有 K2 会漏掉 K4 那类、只有 K4 会漏掉 K1 那类，**两条都要**」。
//! 所以本文件**只**验证标记：既不测"错的结果有没有被拦"（K4），
//! 也不测"进入判定的结果是不是全 `Real`"（K2）。**不做成复制品。**
//!
//! # 判据来自真源，不是自创
//!
//! 合法组合的唯一真源是 [`allowed_confidence_for`]，它的文档逐条引用
//! 设计 §8.1（`:704-709` 的四态定义）与 §8.2（`:717-726` 的七层表）。
//! 本文件**从它算**"哪些组合非法"，不硬编码映射表。
//!
//! # 分子 / 分母
//!
//! * **分母** = 构造的层级数（L0..L6 = 7）。
//! * **分子** = 同时满足两条的层数：① **标记自洽**（`validate_plan` 不报
//!   `LayerConfidenceMismatch`）；② **实际执行一致**（执行后 `confidence_violations`
//!   为空，且 `trace.confidence` 等于声明值）。
//!
//! # 阶段 1 的诚实边界（先说清，不假装）
//!
//! "实际执行"这一端在阶段 1 是**由 `NodeRunner` trait 注入的实现**报出来的
//! （`NodeOutcome.confidence`），**不是**端到端真跑的 Rust 服务端——设计 §4 的
//! JSON-RPC 服务端可执行文件在阶段 1 还不存在。
//! 所以本文件证明的是：**标记链在 executor 内部自洽、可逐节点对账，且不一致会被抓到**
//! （负向证明见下）。"真实宿主端到端执行时标记仍然正确"这一环，留待阶段 2 用真宿主复测。

use dsh_testkit_capability::{DefaultCapabilityGate, Preset};
use dsh_testkit_executor::{
    allowed_confidence_for, execute_plan, layer_confidence_ok, validate_plan, AssertionVerdict,
    ConfidenceLevel, ExecutionPlan, ExecutionTrace, Layer, LeftoverProbe, NodeOutcome, NodeRunner,
    PlanIssueKind, ResidueState, ResourceReleaser, ScenarioMetadata, ToolNode,
};
use serde_json::json;

/// 协议定义的四态（`crates/protocol/src/plan.rs` 的 `ConfidenceLevel`）。
///
/// 它是 `#[non_exhaustive]`，Rust 无法在运行期枚举，所以这里显式列出四个变体——
/// 这属于**类型定义本身**，不是第二处真源：本文件的判据（哪些组合合法）
/// 一律从 [`allowed_confidence_for`] 读出来。
const ALL_CONFIDENCE: [ConfidenceLevel; 4] = [
    ConfidenceLevel::Static,
    ConfidenceLevel::Simulated,
    ConfidenceLevel::Degraded,
    ConfidenceLevel::Real,
];

/// 七层（设计 §8.2 的表）。
const ALL_LAYERS: [Layer; 7] = [
    Layer::L0,
    Layer::L1,
    Layer::L2,
    Layer::L3,
    Layer::L4,
    Layer::L5,
    Layer::L6,
];

/// 某层的"代表标记"：**从真源取**（`allowed_confidence_for` 的首项），不硬编码映射表。
///
/// L0 → `Static`；L1/L2 → `Simulated`；L3–L6 → `Real`（首项就是 `Real`）。
fn expected_confidence(layer: Layer) -> ConfidenceLevel {
    *allowed_confidence_for(layer)
        .first()
        .unwrap_or_else(|| panic!("{layer:?} 必须至少允许一个可信度标记"))
}

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

fn plan(layer: Layer, confidence: ConfidenceLevel) -> ExecutionPlan {
    ExecutionPlan {
        nodes: vec![node("n1")],
        edges: Vec::new(),
        metadata: ScenarioMetadata {
            scenario_id: "TK-K1-001".to_string(),
            title: "K1 层级可信度".to_string(),
            layer,
            confidence,
            shared_context: false,
            depth: 1,
            seed: Some(1),
        },
        resources: Vec::new(),
    }
}

/// 一个"报固定可信度"的执行实现（`NodeRunner` 的测试替身）。
struct FixedRunner(ConfidenceLevel);

impl NodeRunner for FixedRunner {
    fn run(&self, _node: &ToolNode, _order: usize) -> NodeOutcome {
        NodeOutcome {
            verdict: AssertionVerdict::Passed,
            confidence: self.0,
            duration_ms: 1,
            detail: None,
            assertions: Vec::new(),
            notes: serde_json::Map::new(),
        }
    }
}

/// 两个节点报不同可信度（用于验证"最保守者被如实记录"）。
struct MixedRunner;

impl NodeRunner for MixedRunner {
    fn run(&self, node: &ToolNode, _order: usize) -> NodeOutcome {
        NodeOutcome {
            verdict: AssertionVerdict::Passed,
            confidence: if node.node_id == "a" {
                ConfidenceLevel::Real
            } else {
                ConfidenceLevel::Simulated
            },
            duration_ms: 1,
            detail: None,
            assertions: Vec::new(),
            notes: serde_json::Map::new(),
        }
    }
}

struct NoRelease;
impl ResourceReleaser for NoRelease {
    fn release(&self, _resource_id: &str) -> Result<(), String> {
        Ok(())
    }
}

struct CleanProbe;
impl LeftoverProbe for CleanProbe {
    fn probe(&self, _resource_id: &str) -> ResidueState {
        ResidueState::Clean
    }
}

fn run(built: &ExecutionPlan, reported: ConfidenceLevel) -> ExecutionTrace {
    execute_plan(built, &FixedRunner(reported), &NoRelease, &CleanProbe)
}

fn gate() -> DefaultCapabilityGate {
    DefaultCapabilityGate::new("0.2.0-rc.2")
}

/// **K1 正式读数**：每层构造一个场景，标记自洽 + 实际执行一致才算通过。
#[test]
fn k1_every_layer_marker_matches_actual_execution() {
    let gate = gate();
    let mut passed = 0usize;
    let mut lines: Vec<String> = Vec::new();

    for layer in ALL_LAYERS {
        let confidence = expected_confidence(layer);
        let built = plan(layer, confidence);
        // 用 Freeze 档：它不产生 ConfidenceBelowGate（那是"发布门槛"的判定，属 K2 的范围），
        // 这样本测试只观察 K1 关心的那一类问题。
        let validation = validate_plan(&built, &gate, Preset::Freeze);
        let marker_ok = !validation.has(PlanIssueKind::LayerConfidenceMismatch);
        let trace = run(&built, confidence);
        let execution_ok =
            trace.confidence_violations.is_empty() && trace.confidence == Some(confidence);
        if marker_ok && execution_ok {
            passed += 1;
        }
        lines.push(format!(
            "{layer:?} → {confidence:?}：标记自洽={marker_ok}，执行一致={execution_ok}"
        ));
    }

    let total = ALL_LAYERS.len();
    let percent = passed as f64 / total as f64 * 100.0;
    println!("K1 = {passed}/{total} = {percent:.2}%");
    for line in &lines {
        println!("  {line}");
    }

    assert_eq!(
        passed, total,
        "K1 门槛是 100%：每一层的标记都必须与实际执行一致"
    );
}

/// 负向证明 ①：**错误的标记必须全部被检出**（只测"一致时全绿"是没有判别力的）。
///
/// "错误"的集合**从真源算**：对每层遍历四态，凡 `layer_confidence_ok == false` 的就是注入样本。
#[test]
fn k1_wrong_markers_are_all_detected() {
    let gate = gate();
    let mut injected = 0usize;
    let mut detected = 0usize;
    let mut by_layer: Vec<String> = Vec::new();

    for layer in ALL_LAYERS {
        let mut layer_injected = 0usize;
        for confidence in ALL_CONFIDENCE {
            if layer_confidence_ok(layer, confidence) {
                continue;
            }
            layer_injected += 1;
            injected += 1;
            let built = plan(layer, confidence);
            let validation = validate_plan(&built, &gate, Preset::Freeze);
            assert!(
                validation.has(PlanIssueKind::LayerConfidenceMismatch),
                "{layer:?} + {confidence:?} 是非法标记，但没有被检出：{:?}",
                validation.issues
            );
            assert!(
                !validation.execution_allowed,
                "标记错误必须阻断执行（否则后面所有按可信度分流的判断都建立在错标记上）"
            );
            detected += 1;
        }
        by_layer.push(format!("{layer:?} 注入 {layer_injected} 条"));
    }

    println!("K1 负向（错误标记）：检出 {detected}/{injected} = 100%");
    println!("  逐层：{}", by_layer.join("，"));
    assert!(
        injected > 0,
        "必须真的注入了非法组合，否则这条负向证明是空转"
    );
    assert_eq!(detected, injected, "非法标记的检出率必须 100%");
}

/// 负向证明 ②：**实际执行报出的可信度与声明不一致时，必须被抓到并点名**。
#[test]
fn k1_execution_conflicts_are_all_detected_and_pointed() {
    let mut injected = 0usize;
    let mut detected = 0usize;

    for layer in ALL_LAYERS {
        let declared = expected_confidence(layer);
        let built = plan(layer, declared);
        for actual in ALL_CONFIDENCE {
            if actual == declared {
                continue;
            }
            injected += 1;
            let trace = run(&built, actual);
            assert_eq!(
                trace.confidence_violations.len(),
                1,
                "{layer:?}：声明 {declared:?} 但执行报 {actual:?}，必须记一条违规"
            );
            let violation = &trace.confidence_violations[0];
            assert_eq!(violation.node_id, "n1", "违规必须点名到节点 id");
            assert_eq!(violation.declared, declared);
            assert_eq!(violation.actual, actual);
            assert_eq!(
                trace.confidence,
                Some(actual),
                "整条痕迹的实际可信度应等于实际报出的值"
            );
            detected += 1;
        }
    }

    println!("K1 负向（执行不一致）：检出 {detected}/{injected} = 100%");
    assert_eq!(detected, injected, "执行不一致的检出率必须 100%");
}

/// 零假阳性：**合法**的 `(层级, 可信度)` 组合一个都不许被报。
#[test]
fn k1_legal_markers_are_never_flagged() {
    let gate = gate();
    let mut checked = 0usize;
    for layer in ALL_LAYERS {
        for confidence in allowed_confidence_for(layer) {
            checked += 1;
            let built = plan(layer, *confidence);
            let validation = validate_plan(&built, &gate, Preset::Freeze);
            assert!(
                !validation.has(PlanIssueKind::LayerConfidenceMismatch),
                "合法组合 {layer:?} + {confidence:?} 被误报：{:?}",
                validation.issues
            );
        }
    }
    println!("K1 零假阳性：检查了 {checked} 个合法组合，误报 0");
    assert!(
        checked >= ALL_LAYERS.len(),
        "每个层级至少要检查一个合法组合"
    );
}

/// 混合可信度：整条痕迹取**最保守**者（宁可低报，不可高报）。
#[test]
fn k1_trace_confidence_is_the_most_conservative() {
    let mut built = plan(Layer::L3, ConfidenceLevel::Real);
    built.nodes = vec![node("a"), node("b")];
    let trace = execute_plan(&built, &MixedRunner, &NoRelease, &CleanProbe);

    assert_eq!(
        trace.confidence_violations.len(),
        1,
        "b 报 Simulated ≠ 声明 Real"
    );
    assert_eq!(trace.confidence_violations[0].node_id, "b");
    assert_eq!(
        trace.confidence,
        Some(ConfidenceLevel::Simulated),
        "两个节点报 Real / Simulated 时，整条结果不得被判成 Real"
    );
}
