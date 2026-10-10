---
domain: kinds
module: agent
revision: 1

atomics:
  - id: BEH-KIND-AGENT-001
    title: spawn-agent —— 派生一个真实子 agent 跑任务并断言轨迹（one-shot / teammate 两条通道）
    atomic: spawn-agent
    status: active

    source:
      file: src/kinds/agent.ts
      lines: "399-469"
      symbols:
        - "agentDriver"
        - "AgentSetup"
        - "AgentMode"
        - "listProviders"
        - "resolveInitiator"
        - "makeTeammateName"
        - "assertTeammateName"
        - "findMember"
        - "summarizeMembers"
        - "resolveTeamRole"
        - "waitForTeammateIdle"
        - "TeammateWaitResult"
        - "runOneShot"
        - "runTeammate"
        - "outputList"
        - "outputText"
        - "DEFAULT_TEAMMATE_WAIT_MS"
        - "TEAMMATE_NAME_RE"
        - "TEAMMATE_BUSY_STATUSES"
        - "TEAMMATE_POLL_MS"
        - "TEAM_CHANGE_MIN_MS"
        - "TEAM_CHANGE_MAX_MS"
      tests:
        - "tests/agent-driver.test.mjs::listProviders：只收字符串，畸形输入不炸"
        - "tests/agent-driver.test.mjs::resolveInitiator：优先 currentInitiator，抛错时落回 requireInitiator"
        - "tests/agent-driver.test.mjs::setup：记录可用的 provider 名单"
        - "tests/agent-driver.test.mjs::setup：provider 名不存在时跳过并列出可用名（不猜）"
        - "tests/agent-driver.test.mjs::setup：宿主没有注册任何 provider 时跳过"
        - "tests/agent-driver.test.mjs::setup：宿主没有 subagents 服务时跳过"
        - "tests/agent-driver.test.mjs::act：派生成功、写全取证、并释放 run"
        - "tests/agent-driver.test.mjs::act：结果失败（stopReason 异常）也会被如实记录"
        - "tests/agent-driver.test.mjs::act：start 抛错被记账，且 dispose 仍会被尝试"
        - "tests/agent-driver.test.mjs::act：拿不到当前 agent 时跳过（而不是崩）"
        - "tests/agent-driver.test.mjs::act：工具过滤与人格会透传"
        - "tests/agent-driver.test.mjs::act：非 agent 动作直接报错"
        - "tests/agent-driver.test.mjs::driver 元信息：kind / requires 正确"
        - "tests/agent-team.test.mjs::makeTeammateName：lower-kebab、唯一、且能过服务端校验"
        - "tests/agent-team.test.mjs::makeTeammateName：畸形 caseId 也要产出合法名"
        - "tests/agent-team.test.mjs::assertTeammateName：非法名抛错（这是场景数据错误，不是跳过）"
        - "tests/agent-team.test.mjs::resolveTeamRole：优先 tryMembership，落回 membership，非成员为 undefined"
        - "tests/agent-team.test.mjs::summarizeMembers / findMember：畸形输入不炸"
        - "tests/agent-team.test.mjs::waitForTeammateIdle：running 之后回落 inactive 才算跑完"
        - "tests/agent-team.test.mjs::waitForTeammateIdle：waitForChange 抛错时靠轮询兜底"
        - "tests/agent-team.test.mjs::waitForTeammateIdle：一直 running 时按上限超时（不无限等）"
        - "tests/agent-team.test.mjs::waitForTeammateIdle：failed 也算跑完（不能让场景一直等到超时）"
        - "tests/agent-team.test.mjs::setup：teammate 模式缺 agentTeams 能力时跳过（并说明原因）"
        - "tests/agent-team.test.mjs::setup：one-shot 模式不受 agentTeams 缺失影响（原行为不变）"
        - "tests/agent-team.test.mjs::act：非 Lead（团队成员会话）跳过而不是崩"
        - "tests/agent-team.test.mjs::act：走团队通道 —— spawn 参数正确、roster 状态与产出全被取证"
        - "tests/agent-team.test.mjs::act：fork 上下文缺省走 fork provider"
        - "tests/agent-team.test.mjs::act：缺省自动生成唯一名（团队名永不复用）"
        - "tests/agent-team.test.mjs::act：团队不支持的参数被如实记账（而不是静默忽略）"
        - "tests/agent-team.test.mjs::act：动作级 mode 覆盖 setup（同一场景可混用两条通道）"
        - "tests/agent-team.test.mjs::act：spawn 抛错被记账（成员创建失败不该伪装成通过）"
        - "tests/agent-team.test.mjs::teardown：跑飞的 teammate 会被中断（只停当前轮次）"
        - "tests/agent-team.test.mjs::teardown：不调 interrupt 时静默（缺服务不炸）"
        - "tests/agent-team.test.mjs::driver 元信息：仍只硬依赖 subagents（agentTeams 走能力探测）"

    capabilities: ["subagents", "agentTeams"]
    availableIn: RequiresAgentContext
    costTier: high
    parallel: exclusive

    observable:
      - given: "mode 缺省（one-shot），宿主有 subagents 且注册了 provider"
        when: "setup 阶段"
        then: "fx.availableSubagentProviders 是 provider 名数组，length atLeast 1"
        verdict: pass
      - given: "setup.agent.provider 指定了宿主未注册的名字"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase），理由列出已注册的可用名（**不猜**）"
        verdict: skip
      - given: "mode = 'teammate' 但宿主不具备 agentTeams 能力"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase），理由含 'dsh-experimental-agent-team'"
        verdict: skip
      - given: "mode = 'one-shot' 且宿主不具备 agentTeams 能力"
        when: "setup 阶段"
        then: "不被跳过（one-shot 不依赖 agentTeams）"
        verdict: pass
      - given: "宿主没有 subagents 服务"
        when: "setup.agent 存在"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "one-shot 派生成功"
        when: "act: { kind: agent, agent: { prompt: '...' } }"
        then: "fx.agentProvider 是 provider 名；fx.agentRunId 是字符串；fx.agentHasLocalAgent is 布尔；fx.agentStopReason、fx.agentOutput、fx.agentDurationMs 均 exists；fx.agentError exists 为 false"
        verdict: pass
      - given: "子 agent 的结果以异常 stopReason 结束"
        when: "act agent"
        then: "fx.agentStopReason 被如实记录（异常结果不被当成 driver 失败）"
        verdict: fail
      - given: "subagents.start() 抛错"
        when: "act agent"
        then: "fx.agentError 非空；且 `run.dispose()` 仍会被尝试（holder-owned 资源必须释放）"
        verdict: fail
      - given: "拿不到当前 agent（agents.currentInitiator 为空）"
        when: "act agent"
        then: "case 被标为 skipped（SkipCase），理由说明 agent 动作必须在 agent 调用的工具里执行"
        verdict: skip
      - given: "setup.agent.model / toolFilter / persona 已声明"
        when: "act agent（one-shot）"
        then: "三者被透传进 start 请求（agentOptions.model / toolFilter / persona）"
        verdict: pass
      - given: "mode = 'teammate' 且当前角色是 Lead"
        when: "act: { kind: agent, agent: { prompt: '...', mode: 'teammate' } }"
        then: "fx.teammateName 是非空字符串；fx.teammateId 是字符串；fx.teammateFinalStatus 不是 running/provisioning；fx.teammateRetained is true（成员永久留痕，设计如此）"
        verdict: pass
      - given: "mode = 'teammate'，当前角色不是 Lead（团队成员会话里）"
        when: "act agent"
        then: "case 被标为 skipped（SkipCase），理由说明团队是扁平的、不支持嵌套"
        verdict: skip
      - given: "teammate 名不合法（含大写、超 64 字符或等于 'lead'）"
        when: "act agent"
        then: "throws 为 true（这是**场景数据错误**，不是宿主缺能力）"
        verdict: fail
      - given: "teammate 通道下声明了 label / model / toolFilter / persona"
        when: "act agent"
        then: "fx.teammateIgnoredSetup contains 这些键名（**如实记账而不是静默忽略**）"
        verdict: pass
      - given: "teammate 在 waitMs 内没有回落到非忙碌状态"
        when: "act agent"
        then: "fx.teammateWaitTimedOut is true；fx.teammateFinalStatus 是 running / provisioning；fx.teammateWaitMs atLeast waitMs"
        verdict: fail
      - given: "child 会话产生 assistant/message 事件"
        when: "act agent（teammate）"
        then: "fx.teammateOutputs 含这些文本；fx.teammateOutput 是最后一条非空文本"
        verdict: pass
      - given: "teammate 的 spawn 抛错"
        when: "act agent"
        then: "fx.agentError 非空，成员创建失败不伪装成通过"
        verdict: fail
      - given: "场景结束（teardown）"
        when: "本场景派生过 teammate"
        then: "只调用 `agentTeams.interrupt(caller, name)` 停当前轮次，不动 inbox / 任务归属；失败静默"
        verdict: pass
      - given: "subagents 服务不提供 start()"
        when: "act agent（one-shot）"
        then: "throws 为 true，错误信息 contains '不提供 start()'"
        verdict: fail
      - given: "act 收到非 agent 动作"
        when: "把非 agent 的 StepAction 交给 agent driver"
        then: "throws 为 true，错误信息 contains 'agent driver 只支持'"
        verdict: fail

    cleanup: none

    nonDeterministic:
      - field: "fx.agentOutput / fx.teammateOutput / fx.teammateOutputs"
        reason: "**真实模型输出**，逐次不同；也是本 kind 唯一必须显式标明的核心非确定量"
        reconcile: "normalize:model-text"
      - field: "fx.agentDurationMs / fx.teammateWaitMs"
        reason: "真实模型调用与等待的挂钟时间"
        reconcile: "atLeast"
      - field: "fx.agentRunId / fx.teammateId / fx.teammateName"
        reason: "run id 与自动生成的 teammate 名由宿主/Math.random 生成"
        reconcile: "normalize:identifier"
      - field: "fx.agentStopReason / fx.teammateFinalStatus"
        reason: "模型可能以 stop / max-tokens / error 等不同方式结束"
        reconcile: "normalize:enum-set"
      - field: "fx.teammateWakeReason"
        reason: "被 waitForChange 唤醒（'change'）还是轮询到点（'poll'），取决于宿主是否发 activity 边"
        reconcile: "ignore"
      - field: "fx.teammateMembers"
        reason: "roster 含其它并发成员的快照"
        reconcile: "normalize:superset-of-declared"

    equivalence:
      verdict: exact
      output: model-text
      stopReason: enum-set
      durationMs: atLeast
      runId: identifier
---

## spawn-agent

**⚠️ 与其它 driver 的本质区别**（源码 4-11 行）：前面那些 driver 都是「造条件」——注册监听、造假 provider、
注入提示词，**不花 token**。这一个不是：它会**真的派生一个子 agent、真的调模型、真的产出结果**。
所以 agent 类场景要克制使用：它是**黑盒**用例，适合"端到端结果不对"这类说不清归类的 issue；
结论清楚后应**下沉**到精确 kind（`tool` / `llm` / `prompt` …），黑盒那条保留当回归网。

**两条通道（`setup.agent.mode` 或动作级 `agent.mode`，动作级优先）**：

| mode | 入口 | 语义 | 代价 |
|---|---|---|---|
| `one-shot`（缺省） | `ctx.subagents.start()` | 一次性运行，父级只收最终输出 | 跑完即 `dispose`，不留痕 |
| `teammate` | `ctx.agentTeams.spawnTeammate()` | **复用 Agent Teams**：durable 可续接 child | **成员永久留痕**，占 `maxMembers`，名字不可复用 |

两条通道共用同一个 subagent provider（实测注册名 `spawn` / `fork`），差别在**上层**：`teammate` 会向 Lead 会话日志
追加 `team/member` 记录，进入 roster / mailbox / 任务板；`one-shot` 只留一条 `subagent/catalog` 事实。

**为什么不强绑 provider 名**（源码 49-53 行）：provider 名由宿主注册（headless profile 里是
`subagent-spawn-in-process` 之类），不同组合下可能不同。所以缺省取 `subagents.list()` 的第一个，
也允许场景显式指定；名不对时**跳过并列出可用名**，而不是猜。

**teammate 的结果怎么取**（源码 55-59 行）：团队通道**没有** `run.result`——它是异步协作原语，不是同步委派。
所以输出走 `session/event`：driver 在 spawn **之前**挂监听（child 的 assistant 消息可能早于下一次读），
只收**那个 child 会话**的 `assistant/message` 事件，等成员转为非 `running`/`provisioning` 后把最后一条文本记为
`fx.teammateOutput`。等待策略是"两条腿走路"：`waitForChange` 唤醒 + 500ms 轮询兜底
（团队成员状态变化不保证每次都发 activity 边）。

### 边界与已知缺陷

1. **`capabilities` 无法表达"按通道"的能力需求（粒度问题，会引入回归）**：`one-shot` 只需 `subagents`，
   `teammate` 需要 `agentTeams`；源码刻意**分开探测**（`agent.ts:411-419` 的注释："两者分开探测，
   这样'宿主有 subagents 但没装 Agent Teams'能给出准确原因"），静态 `requires` 只写 `['subagents']`。
   但 §2.2 只给一个原子名 `spawn-agent`，条目级 `capabilities` 只能写并集
   `["subagents", "agentTeams"]`——这会让 `one-shot` 场景在**没有** Agent Teams 的宿主上被**计划期**误判为缺能力。
   既有测试 `tests/agent-team.test.mjs::setup：one-shot 模式不受 agentTeams 缺失影响（原行为不变）` 正好守着这条回归。
   → 需要设计裁决：给条目加"通道 → 能力"的映射，或允许 `spawn-agent` 声明条件能力。
2. **`fx.agentOutput` 是"最后一条非空 assistant 文本"**：`outputText` 取 `outputs[outputs.length - 1]`（667-670 行），
   而 `teammateOutputs` 保留全部。若最后一条是"让我检查一下…"这类中间语，断言拿到的就不是最终答复——
   而 spec 没有任何"哪条才是最终答复"的判据。
3. **`makeTeammateName` 用 `Math.random()` 生成后缀**（212 行）：名字**不可复现**，报告里无法固定；
   断言只能用 `matches` 正则。它同时保证"团队名永不复用"（用过的名字连失败的都保留），
   所以这个非确定性是**必要的代价**，但必须在 spec 里显式（本条目已列）。
4. **`agentRunId` 一个字段两种语义**：one-shot 记 `run.id`（514 行），teammate 记 child 的 `member.id`（627 行）。
   同一个 `fx` 键在不同通道下指不同的东西，跨通道断言容易写错。
5. **`readStatus` 把"状态未知"当"仍在忙碌"**：`status !== undefined && !BUSY.has(status)`（341 行）——
   roster 行缺 `status` 时会一直循环到超时，`fx.teammateWaitTimedOut: true`。语义上可接受，
   但"成员状态读不到"与"成员真的没跑完"在取证上不可区分（都是超时）。
6. **teammate 的残留不可清理**：roster 没有删除能力，`teardown` 只能 `interrupt` 当前轮次（456-468 行），
   `fx.teammateRetained is true` 是刻意标注。于是**重复运行同一场景会累积成员**并占用 `maxMembers`——
   `cleanup` 在本条目只能是 `none`。这是本 kind 与其它 kind 在残留纪律上的根本差异。
7. **端到端路径的测试覆盖是"假服务级"的**：`tests/agent-driver.test.mjs` 与 `tests/agent-team.test.mjs`
   用假 `subagents` / `agentTeams` 覆盖了全部**分支与取证**，但"真派生一个子 agent 并跑完"这段
   只能靠活宿主验证（会花 token）。spec 因此把"真实模型输出"整体标为 `normalize:model-text`，
   **不能承诺逐字对拍**。

## 测试覆盖

- `tests/agent-driver.test.mjs`（13 个用例）：`listProviders` / `resolveInitiator` 两个纯函数、
  setup 的三条跳过路径、one-shot 的成功/异常/释放/透传、动作分派与元信息。
- `tests/agent-team.test.mjs`（21 个用例）：teammate 名生成与校验、角色解析、roster 投影、
  `waitForTeammateIdle` 四条等待边界、teammate 通道的 spawn 参数与全量取证、非 Lead 跳过、
  忽略参数记账、spawn 失败、teardown 的中断与静默。
- **单个原子有既有测试覆盖**（用假服务）；真实模型调用的端到端行为**不可离线覆盖**，见缺陷 7。
