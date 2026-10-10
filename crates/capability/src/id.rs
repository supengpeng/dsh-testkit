//! 能力标识：`HostCapability` 联合类型的 20 个成员。
//!
//! **真源**：`spec/contracts/capabilities.yaml`（逐成员清单）→ `src/cases/types.ts:26-50`（唯一类型真源）。
//!
//! ## 为什么能力名 → 服务名的映射必须住在同一个类型上
//!
//! `spec/contracts/capabilities.yaml` 的 `mapping_asymmetry` 记了一条会静默判错的风险：
//! 有**两个**能力名与 DSH 服务名不同名——
//!
//! - `session` → `agents`（活跃 agent 注册表）
//! - `client` → `clientModules`（client 半的注册表）
//!
//! 按能力名去 grep 服务消费点会漏掉这两处。所以 Rust 门控**不允许**自己拼服务名，
//! 只能用 [`CapabilityId::service_key`] 这一张与 `src/host-facade.ts:29-54` 同源的表。

use serde::{Deserialize, Serialize};

/// 宿主能力名，对应 DSH 侧的服务 / 扩展点。
///
/// 序列化用 camelCase，与 TS 侧的能力名逐字节一致
/// （`systemPrompt` / `userQuestions` / `webServer` / `agentLoop` / `agentTeams`）。
///
/// `#[non_exhaustive]`：阶段 4 若新增能力成员，使用方不必跟改（设计 §9.1 的兼容承诺是
/// 「只新增、不删既有成员」）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum CapabilityId {
    /// 工具注册面（`tools` driver / `tool` kind 的底座）。
    Tools,
    /// 模型调用面（真实 LLM 成本闸门的载体，但成本闸门本身留在 TS）。
    Llm,
    /// 命令注册面（`/testkit` 命令）。
    Commands,
    /// 系统提示词面。
    SystemPrompt,
    /// 审批交互面。**只被探测、从不被门控**（`gated: false`）。
    Approval,
    /// 用户提问面（`interaction` driver 的 question 分支）。
    UserQuestions,
    /// 会话面；服务名是 `agents`（**能力名 ≠ 服务名**）。
    Session,
    /// 宿主的文件服务语义（沙箱 / 写意图 / 版本冲突），区别于纯离线的 `file`。
    Fs,
    /// 子进程面。
    Subprocess,
    /// 网页资源面。**只被探测、从不被门控**，缺失时走 service 为 `undefined` 的降级分支。
    Web,
    /// webServer 桥注册面。
    WebServer,
    /// 宿主 agent 主循环。**declared-only**：本仓从不驱动它。
    AgentLoop,
    /// 一次性子 agent 派生面。
    Subagents,
    /// Agent Teams 协作面（实验包 `dsh-experimental-agent-team`）。
    AgentTeams,
    /// 会话存储面（`ctx.sessions`）：`flush` 检查点、隔离会话创建。
    Sessions,
    /// 目标服务面（`ctx.goals`）。**只被探测、从不被门控**。
    Goals,
    /// 会话历史压缩面（`ctx.compaction`）。
    Compaction,
    /// 通用键值存储面。**declared-only**：本仓零消费点。
    Storage,
    /// 宿主 timer 面。**declared-only**：等待语义由场景自己的 `setTimeout` 承担。
    Timer,
    /// client 半的模块注册表。**declared-only**；服务名是 `clientModules`（**能力名 ≠ 服务名**）。
    Client,
}

impl CapabilityId {
    /// 20 个成员的完整清单，顺序与 `spec/contracts/capabilities.yaml` 的 `members` 一致。
    ///
    /// 用数组而不是 `HashSet`：判定路径禁用 `HashMap` / `HashSet`（设计 §6.4），
    /// 且固定顺序让报告可逐格 diff。
    pub const ALL: [CapabilityId; 20] = [
        CapabilityId::Tools,
        CapabilityId::Llm,
        CapabilityId::Commands,
        CapabilityId::SystemPrompt,
        CapabilityId::Approval,
        CapabilityId::UserQuestions,
        CapabilityId::Session,
        CapabilityId::Fs,
        CapabilityId::Subprocess,
        CapabilityId::Web,
        CapabilityId::WebServer,
        CapabilityId::AgentLoop,
        CapabilityId::Subagents,
        CapabilityId::AgentTeams,
        CapabilityId::Sessions,
        CapabilityId::Goals,
        CapabilityId::Compaction,
        CapabilityId::Storage,
        CapabilityId::Timer,
        CapabilityId::Client,
    ];

    /// 4 个 **declared-only** 成员：只有联合类型成员身份与能力→服务映射，`src/` 里零消费点。
    ///
    /// `spec/contracts/capabilities.yaml` 的 `b2_risk.ruling`（2026-10-11 Lead 裁决）：
    /// **不删类型**（删类型是破坏性变更），改为显式声明 declared-only。
    /// 本清单就是那个"显式声明"的机器可读形态——阶段 1 的处置是**永不触发、不参与策略矩阵**，
    /// 且**不给它们注册探测器**（注册会被 [`crate::GateError::DeclaredOnlyNotDetectable`] 拒绝），
    /// 免得"假装有探测器"把"没有行为可验"伪装成"有行为可验"。
    pub const DECLARED_ONLY: [CapabilityId; 4] = [
        CapabilityId::AgentLoop,
        CapabilityId::Storage,
        CapabilityId::Timer,
        CapabilityId::Client,
    ];

    /// 与 TS 侧 `HostCapability` 逐字节一致的能力名（线格式名字）。
    pub const fn name(self) -> &'static str {
        match self {
            CapabilityId::Tools => "tools",
            CapabilityId::Llm => "llm",
            CapabilityId::Commands => "commands",
            CapabilityId::SystemPrompt => "systemPrompt",
            CapabilityId::Approval => "approval",
            CapabilityId::UserQuestions => "userQuestions",
            CapabilityId::Session => "session",
            CapabilityId::Fs => "fs",
            CapabilityId::Subprocess => "subprocess",
            CapabilityId::Web => "web",
            CapabilityId::WebServer => "webServer",
            CapabilityId::AgentLoop => "agentLoop",
            CapabilityId::Subagents => "subagents",
            CapabilityId::AgentTeams => "agentTeams",
            CapabilityId::Sessions => "sessions",
            CapabilityId::Goals => "goals",
            CapabilityId::Compaction => "compaction",
            CapabilityId::Storage => "storage",
            CapabilityId::Timer => "timer",
            CapabilityId::Client => "client",
        }
    }

    /// DSH 侧的服务 key，与 `src/host-facade.ts:29-54` 的 `CAPABILITY_SERVICE` 同源。
    ///
    /// 只有两处不同名，见模块文档：`session` → `agents`、`client` → `clientModules`。
    pub const fn service_key(self) -> &'static str {
        match self {
            CapabilityId::Session => "agents",
            CapabilityId::Client => "clientModules",
            other => other.name(),
        }
    }

    /// 该能力是否为 declared-only（见 [`CapabilityId::DECLARED_ONLY`]）。
    pub const fn is_declared_only(self) -> bool {
        matches!(
            self,
            CapabilityId::AgentLoop
                | CapabilityId::Storage
                | CapabilityId::Timer
                | CapabilityId::Client
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn twenty_members_and_four_declared_only() {
        assert_eq!(CapabilityId::ALL.len(), 20);
        assert_eq!(CapabilityId::DECLARED_ONLY.len(), 4);
        assert_eq!(
            CapabilityId::ALL
                .iter()
                .filter(|c| c.is_declared_only())
                .count(),
            4
        );
        // 没有重复：用 BTreeSet（设计 §6.4 禁 HashSet）。
        let unique: std::collections::BTreeSet<_> = CapabilityId::ALL.iter().copied().collect();
        assert_eq!(unique.len(), 20);
    }

    #[test]
    fn only_two_capabilities_have_a_different_service_name() {
        let asymmetric: Vec<&str> = CapabilityId::ALL
            .iter()
            .filter(|c| c.service_key() != c.name())
            .map(|c| c.name())
            .collect();
        assert_eq!(asymmetric, vec!["session", "client"]);
        assert_eq!(CapabilityId::Session.service_key(), "agents");
        assert_eq!(CapabilityId::Client.service_key(), "clientModules");
    }

    #[test]
    fn wire_names_are_camel_case_and_match_serde() {
        for capability in CapabilityId::ALL {
            let json = serde_json::to_string(&capability).expect("能力名可序列化");
            assert_eq!(json, format!("\"{}\"", capability.name()));
        }
    }
}
