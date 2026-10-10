---
domain: kinds
module: compaction
revision: 2

atomics:
  - id: BEH-KIND-COMPACTION-001
    title: compaction-if-needed —— 让宿主压力策略决定是否压缩（null 是正确答案，不是失败）
    atomic: compaction-if-needed
    status: active

    source:
      file: src/kinds/compaction.ts
      lines: "291-302"
      symbols:
        - "compactionDriver"
        - "runIfNeeded"
        - "noteResult"
        - "agentContext"
        - "classifyFailure"
      tests:
        - "tests/compaction-driver.test.mjs::setup：没有 compaction 能力时跳过"
        - "tests/compaction-driver.test.mjs::setup：没有 sessions 能力时跳过（压缩必须有明确的会话目标）"
        - "tests/compaction-driver.test.mjs::setup：缺省自建隔离会话（不落盘、不碰当前会话）"
        - "tests/compaction-driver.test.mjs::setup：seed=current 时把当前会话已提交事件复制进隔离会话"
        - "tests/compaction-driver.test.mjs::setup：target=current 时用当前会话，并明确标记非隔离"
        - "tests/compaction-driver.test.mjs::act：没有可压范围时返回 null —— 这是正确行为，不是失败"
        - "tests/compaction-driver.test.mjs::act：触发方式可指定（context-overflow）"
        - "tests/compaction-driver.test.mjs::act：真压缩时把结果形状完整记进取证"
        - "tests/compaction-driver.test.mjs::act：压缩结果被归一化成稳定取值（no-range / compacted / rejected-not-smaller）"
        - "tests/compaction-driver.test.mjs::act：非 compaction 动作直接报错；未知动作也报错"
        - "tests/compaction-driver.test.mjs::act：没有 setup 时明确报错（而不是随手挑一个会话）"

    capabilities: ["compaction", "sessions"]
    availableIn: IsolatedSessionOnly
    costTier: high
    parallel: exclusive

    observable:
      - given: "setup.compaction 缺省（target: isolated、seed: empty）"
        when: "setup 阶段"
        then: "fx.compactionTarget is 'isolated'；fx.compactionIsolated is true；fx.compactionSessionId 非空；fx.compactionSeededEvents is 0"
        verdict: pass
      - given: "setup.compaction.seed = 'current' 且当前会话有已提交事件"
        when: "setup 阶段"
        then: "fx.compactionSeededEvents atLeast 1（把当前会话事件复制进隔离会话）"
        verdict: pass
      - given: "setup.compaction.target = 'current'"
        when: "setup 阶段"
        then: "fx.compactionIsolated is false；fx.compactionTarget is 'current'"
        verdict: pass
      - given: "隔离会话是新会话（surface 为空）"
        when: "act: { kind: compaction, compaction: { ifNeeded: {} } }"
        then: "fx.compactionResultNull is true；fx.compactionOutcome is 'no-range'（契约：没有安全可压范围时返回 null，这是正确行为）"
        verdict: pass
      - given: "act: { kind: compaction, compaction: { ifNeeded: { trigger: 'context-overflow' } } }"
        when: "触发一次"
        then: "fx.compactionTrigger is 'context-overflow'（缺省是 'pressure'）"
        verdict: pass
      - given: "宿主压力策略真的压缩了范围"
        when: "act ifNeeded"
        then: "fx.compactionOutcome is 'compacted'；fx.compactionCompactionId 是非空字符串；fx.compactionStartSeq / SummarySeq / EndSeq 是数字；fx.compactionSummaryText 是字符串"
        verdict: pass
      - given: "摘要不够短（宿主收缩校验拒绝）"
        when: "act ifNeeded"
        then: "fx.compactionOutcome is 'rejected-not-smaller'；fx.compactionError 是非空字符串（不抛）"
        verdict: fail
      - given: "宿主不具备 compaction 能力"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "宿主 sessions 服务不提供 get() / create()"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase），理由说明压缩需要一个明确的会话目标"
        verdict: skip
      - given: "setup.compaction 未执行"
        when: "act 任何 compaction 动作"
        then: "throws 为 true，错误信息 contains 'setup.compaction 未执行'"
        verdict: fail

    cleanup: none

    nonDeterministic:
      - field: "fx.compactionCompactionId"
        reason: "压缩 id 由宿主生成"
        reconcile: "ignore"
      - field: "fx.compactionSummaryText"
        reason: "**模型生成的摘要**，逐次不同"
        reconcile: "normalize:model-text"
      - field: "fx.compactionStartSeq / SummarySeq / EndSeq / ShadowedTokenCount / ShadowedCount"
        reason: "取决于模型摘要长度与宿主选择的可压范围"
        reconcile: "tolerance:0（只做存在性与区间断言）"
      - field: "fx.compactionSessionId"
        reason: "隔离会话 id 由宿主生成，随机"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      outcome: exact
      summary: model-text
      compactionId: ignore
      seq: non-negative

  - id: BEH-KIND-COMPACTION-002
    title: compaction-region —— 强制压缩一个 surface 范围
    atomic: compaction-region
    status: active

    source:
      file: src/kinds/compaction.ts
      lines: "304-318"
      symbols:
        - "compactionDriver"
        - "runRegion"
        - "noteResult"
        - "agentContext"
        - "extractCompactionCode"
      tests:
        - "tests/compaction-driver.test.mjs::extractCompactionCode：code / info.code / message 三种形状都认"
        - "tests/compaction-driver.test.mjs::act：region 强制压缩指定范围，并把边界记进取证"
        - "tests/compaction-driver.test.mjs::act：范围不合法时如实记录错误码（不吞、不猜）"

    capabilities: ["compaction", "sessions"]
    availableIn: IsolatedSessionOnly
    costTier: high
    parallel: exclusive

    observable:
      - given: "隔离会话有可压的 balanced 范围"
        when: "act: { kind: compaction, compaction: { region: { start: 4, end: 6 } } }"
        then: "fx.compactionRegionStart is 4；fx.compactionRegionEnd is 6；fx.compactionOutcome is 'compacted'"
        verdict: pass
      - given: "范围是 active / missing / reversed / unbalanced"
        when: "act region"
        then: "fx.compactionErrorCode 是 COMPACTION_* 码（或 COMPACTION_ 前缀）；fx.compactionOutcome is 'rejected-range'；不抛"
        verdict: fail
      - given: "宿主 compaction 服务不提供 compactRegion()"
        when: "act region"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip

    cleanup: none

    nonDeterministic:
      - field: "fx.compactionSummaryText"
        reason: "模型生成的摘要"
        reconcile: "normalize:model-text"
      - field: "fx.compactionError / 错误码"
        reason: "错误消息由宿主抛出；extractCompactionCode 只认 COMPACTION_ / MANUAL_COMPACT_ 命名族"
        reconcile: "normalize:normalize-message"
      - field: "fx.compactionCompactionId / seq"
        reason: "宿主生成"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      outcome: exact
      error: normalize-message
      summary: model-text

  - id: BEH-KIND-COMPACTION-005
    title: compaction-now —— 手动触发一次压缩（需要 ManualCompactAgentContext.runMaintenance）
    atomic: compaction-now
    status: active

    source:
      file: src/kinds/compaction.ts
      lines: "249-253, 320-342"
      symbols:
        - "compactionDriver"
        - "runNow"
        - "noteResult"
        - "agentContext"
        - "ManualCompactAgentContext"
      tests:
        - "tests/compaction-driver.test.mjs::act：compactNow 缺 runMaintenance 时如实记为不可用（不伪造回调）"

    capabilities: ["compaction", "sessions"]
    availableIn: RequiresAgentContext
    costTier: high
    parallel: exclusive

    observable:
      - given: "宿主 compaction 服务不提供 compactNow()"
        when: "act: { kind: compaction, compaction: { now: {} } }"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "宿主提供 compactNow()，但目标会话没有 runMaintenance（隔离会话的缺省情形）"
        when: "act: { kind: compaction, compaction: { now: {} } }"
        then: "fx.compactionHasRunMaintenance is false；fx.compactionUnsupported contains 'runMaintenance'；**不调用 compactNow、不伪造 maintenance 回调**；场景不失败"
        verdict: skip
      - given: "目标会话带 runMaintenance（真实 agent 上下文）"
        when: "act now"
        then: "fx.compactionHasRunMaintenance is true；结果经 noteResult 落字段——压缩成功时 fx.compactionOutcome is 'compacted' 且 fx.compactionCompactionId 是非空字符串，宿主返回 null 时 fx.compactionResultNull is true 且 fx.compactionOutcome is 'no-range'"
        verdict: pass
      - given: "compactNow 抛错（含摘要不够短被收缩校验拒绝）"
        when: "act now"
        then: "fx.compactionError 是非空字符串；fx.compactionOutcome is 'error'；不抛到场景外"
        verdict: fail

    cleanup: none

    nonDeterministic:
      - field: "fx.compactionSummaryText"
        reason: "**模型生成的摘要**，逐次不同"
        reconcile: "normalize:model-text"
      - field: "fx.compactionCompactionId / 结果里的 seq"
        reason: "宿主生成"
        reconcile: "ignore"
      - field: "fx.compactionError 文本"
        reason: "错误消息由宿主抛出；extractCompactionCode 只认 COMPACTION_ / MANUAL_COMPACT_ 命名族"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      outcome: exact
      summary: model-text
      compactionId: ignore

  - id: BEH-KIND-COMPACTION-003
    title: compaction-inspect —— 只读报告会话序号、surface 节点数与事件分布
    atomic: compaction-inspect
    status: active

    source:
      file: src/kinds/compaction.ts
      lines: "344-358"
      symbols:
        - "compactionDriver"
        - "inspect"
        - "readEvents"
        - "summarizeEventTypes"
      tests:
        - "tests/compaction-driver.test.mjs::summarizeEventTypes：去重且保持首次出现顺序"
        - "tests/compaction-driver.test.mjs::act：inspect 只读取证序号 / surface 节点 / 事件分布"

    capabilities: ["compaction", "sessions"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "目标会话可读"
        when: "act: { kind: compaction, compaction: { inspect: {} } }"
        then: "fx.compactionSeq 是数字；fx.compactionSurfaceNodes 是数字；fx.compactionEventTypes 是去重后的类型数组；fx.compactionError exists 为 false"
        verdict: pass
      - given: "新建的隔离会话（**不是零事件**：自带 permission/preset、sandbox/mode、approval/policy 三条 bootstrap 事件）"
        when: "act inspect"
        then: "fx.compactionSurfaceNodes is 0（surface 为空）；fx.compactionEventCount atLeast 1（事件计数不为 0）"
        verdict: pass
      - given: "目标会话没有 snapshotEvents()"
        when: "act inspect"
        then: 'fx.compactionEventCount exists 为 false（**区分"取不到"与"确实 0 条"**，不伪造空数组）'
        verdict: skip

    cleanup: none

    nonDeterministic:
      - field: "fx.compactionEventCount / EventTypes"
        reason: "取决于宿主版本自带的 bootstrap 事件与场景此前提交的事件"
        reconcile: "atLeast"
      - field: "fx.compactionSeq"
        reason: "会话累计序号，跨运行不稳定"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      surfaceNodes: exact
      eventCount: atLeast
      seq: ignore

  - id: BEH-KIND-COMPACTION-004
    title: compaction-dump —— 只读交出事件样本与 surface 序号（拿活宿主当契约）
    atomic: compaction-dump
    status: active

    source:
      file: src/kinds/compaction.ts
      lines: "424-459"
      symbols:
        - "compactionDriver"
        - "dumpEvents"
        - "plainEvent"
        - "readEvents"
      tests:
        - "tests/compaction-driver.test.mjs::act：dump 只读交出事件样本与 surface 序号（原样保留 type / seq）"
        - "tests/compaction-driver.test.mjs::act：dump 在目标会话没有 snapshotEvents 时也不炸（事件数为 undefined、样本为空）"

    capabilities: ["compaction", "sessions"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "目标会话有事件"
        when: "act: { kind: compaction, compaction: { dump: { limit: 3 } } }"
        then: "fx.compactionEventSample length atMost 3；每个样本 contains type 与 seq 字段；fx.compactionSurfaceSeqs length atMost 3"
        verdict: pass
      - given: "dump 不给 limit"
        when: "act dump"
        then: "样本最多 8 条（limit 缺省 8）"
        verdict: pass
      - given: "目标会话没有 snapshotEvents()"
        when: "act dump"
        then: "fx.compactionEventCount exists 为 false；fx.compactionEventSample is []；不抛"
        verdict: skip
      - given: "事件带 data 字段"
        when: "act dump"
        then: "样本保留原始 data（`plainEvent` 只挑选 type / seq / time / surfaceOp / ignorable / data 六个键，不改动原事件）"
        verdict: pass

    cleanup: none

    nonDeterministic:
      - field: "fx.compactionEventSample[].data"
        reason: "原始事件载荷可能含时间戳、随机 id 等"
        reconcile: "normalize:event-data"
      - field: "fx.compactionSurfaceSeqs"
        reason: "surface 节点的 seq 从哪开始取决于宿主实现与会话历史"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      eventSample: event-data
      surfaceSeqs: ignore
---

## 共享前提（setup）

**安全约定是这个 driver 存在的首要理由**（源码 4-12 行）：`compactRegion` / `compactNow` 会**改写会话历史**
（把选中的 surface 范围替换成一个摘要节点），在用户正在用的会话上做这件事是破坏性的。所以 driver
**默认只在自己创建的隔离会话上动手**：`sessions.create()` 出来的会话若不绑定 agent 生命周期，
契约明确写着 "a session published outside that lifecycle **persists nothing**"——纯内存、不落盘、不进任何人的对话。

`setup`（160-218 行）：能力门（`compaction`）→ 服务形状门（`compactIfNeeded`）→ 会话服务门（`sessions.get` + `create`）；
然后二选一：

- `target: 'isolated'`（缺省）：可带 `seed: 'current'` 把当前会话已提交事件复制进隔离会话；
  取证 `fx.compactionIsolated: true`、`fx.compactionTarget`、`fx.compactionSessionId`、`fx.compactionSeededEvents`；
- `target: 'current'`：用当前会话（注释说"只读用途"），取证 `fx.compactionIsolated: false`。

`act`（220-263 行）在每次动作前**主动清空上一轮的结果字段**（`compactionResultNull` / `compactionOutcome` /
`compactionCompactionId` / `compactionSummaryText`）。源码注释记录了原因（240-242 行）：实测踩过——
region 抛错后 `compactionResultNull` 仍是前一步 ifNeeded 留下的 `true`，于是断言在检查**上一步**。
这条"每步先清空"的纪律是旧实现用真实故障换来的，新实现必须保留。

### 边界与已知缺陷

1. **`now` 的原子归属曾与源码不一致，已按「先修正真源」纪律勘误（保留此条作为沿革记录）**：
   本仓设计文档一度只给 compaction **四个**原子，而源码的 act 分派有**五个**动作分支
   （`src/kinds/compaction.ts:249-253`：`ifNeeded` / `region` / `now` / `inspect` / `dump`）。
   阶段 0 提取时该矛盾被上报，2026-10-11 已勘误：`docs/REWRITE-DESIGN.md:137` 改为五个原子（含 `compaction-now`）、
   `:160` 改为**逐动作**的 ContextSpec，`docs/rfc/0001-rust-core-full-rewrite.md` §8.4 同步勘误并附行号证据链。
   本文件现在是五个条目。**保留这条是为了让后来者知道「原子清单曾与源码不一致」真实发生过**，而不是当成从未存在。
2. **`target: 'current'` 与破坏性动作的组合没有任何强制**：`target` 的注释写"用当前会话（**只读用途**，如 `inspect`；
   拿它去压缩是破坏性的）"（源码 98-99 行），但实现层**不阻止** `target: 'current'` + `region`/`now`。
   一条写错 target 的场景会改写用户正在用的会话——这正是文件头"安全约定"要防的事，却在实现里只靠注释约束。
3. **压缩失败被静默吞掉**：`act` 的 catch 把异常转成 `fx.compactionError` + `fx.compactionOutcome: 'error'`（254-259 行），
   **不抛**。默认场景因此**通过**——除非显式断言。对比 `region` 是破坏性操作，"失败"与"成功但结果字段全 undefined"
   在报告里不容易一眼区分，这个静默性比 prompt 的 `assembleError` 更危险。
4. **失败分类靠正则匹配错误消息**：`classifyFailure`（411-415 行）用 `/not smaller than the shadowed/`、
   `/not found in surface|balanced|reversed/i` 判断 `rejected-not-smaller` / `rejected-range`。宿主一旦改文案，
   分类就静默退化成 `'error'`——`fx.compactionOutcome` 的取值集合因此**依赖宿主措辞**，不是稳定契约。
5. **`noteResult` 把 `null` 与 `undefined` 同等对待**（374 行）：`fx.compactionResultNull: true` 同时表示
   "契约里的 null（没有安全可压范围）"与"宿主没返回"。前者是有语义的正确结果，后者是异常，两者不可区分。
6. **契约里的 `shadowedRange` 没有任何取证**：`noteResult` 只记 `shadowedSeqs` 的数量与 `shadowedTokenCount`（392-395 行），
   "压缩了哪一段"（`shadowedRange.start/end`）无法断言。

## compaction-if-needed

`compactIfNeeded(agent, trigger, signal) → CompactionResult | null`。契约原文 "Return `null` when no safe range can be
compacted."——所以**"空会话返回 null"是正确行为，不是失败**，spec 用 `fx.compactionResultNull is true` +
`fx.compactionOutcome is 'no-range'` 表达。`trigger` 缺省 `pressure`，可指定 `context-overflow`。

`agentContext`（283-289 行）按契约组装 `{ session, options }`，`options` 只带 `provider` / `model`（缺省不传，用宿主默认）。

## compaction-region

`compactRegion(start, end, agent, signal) → CompactionResult`。契约要求
"Both edges must be balanced so assistant tool calls remain paired with their results… rejects active, missing,
reversed, or unbalanced ranges"——范围选错会抛，driver 如实记录错误码（`extractCompactionCode`）。

`now` 分支**不在本条目**：它已按阶段 0 的上报与 2026-10-11 的裁决抽为独立条目 `compaction-now`（见下节）。
理由是"强制压缩一段指定范围"与"手动触发一次压缩"是两个可独立 pass/fail 的行为，符合
「一个 atomic 对应一个不可再分的 BaseTool」纪律。

## compaction-now

`compactNow(agent, signal, sourceCommandId?) → CompactionResult | null`。它的上下文要求是
`ManualCompactAgentContext = CompactionAgentContext + runMaintenance`（源码 320-342 行，尤其 325 行的注释）。

隔离会话没有归属 agent，自然也没有 `runMaintenance`；driver **如实记为"不可用"而不是伪造一个假的 maintenance 回调**
（源码 325-327 行："那只会把失败推后到更难查的地方"）——先记 `fx.compactionHasRunMaintenance: false`，
再记自由文本 `fx.compactionUnsupported`，然后**直接 return、不调用 `compactNow`**。
只有目标会话真的带 `runMaintenance` 时才会调用，并把结果交给 `noteResult`（返回 null → `fx.compactionResultNull: true`）。
这也是本条目声明 `availableIn: RequiresAgentContext` 的源码依据。

### 边界与已知缺陷

1. **用 `session.runMaintenance` 的存在性代理"是否真实 agent 上下文"**（`compaction.ts:331-332`）：
   宿主若给隔离会话也挂了该回调（或反向缺失），判定即错——"能不能跑 `now`"取决于一个**回调存在性启发式**，
   而不是显式的上下文类型。
2. **"上下文不支持 `now`"只有自由文本表达**：取证键 `fx.compactionUnsupported` 是字符串，
   场景无法用 17 个断言词精确判定该结论（只能 `contains` / `exists`）；而 `fx.compactionHasRunMaintenance`
   是布尔位，可精确断言。两者并存说明这条结论同时有"给人读"与"给机器判"两种表达，spec 只承诺后者。

## compaction-inspect

只读：报目标会话的 `seq`、`surface.nodes` 数量与事件类型分布（`summarizeEventTypes`，去重且保持首次出现顺序）。

**一条实测出来的事实**（源码 37-42 行）：`sessions.create()` 出来的会话自带 **3 条 bootstrap 事件**——
`permission/preset`、`sandbox/mode`、`approval/policy`（都不是 surface 事件）。所以"空会话"的**可压范围确实是 0**
（`surface.nodes` 为空），但**事件计数不是 0**。断言写成 `compactionEventCount is 0` 会直接假红——
这条已写进 `TK-0034` 的注释。

`readEvents` 刻意区分"取不到"与"确实 0 条"：会话没有 `snapshotEvents()` 时返回 `undefined`，
而不是伪造空数组——否则 `compactionEventCount is 0` 会同时匹配两种情况。

## compaction-dump

只读：把事件样本（含原始 `data`）与 surface 序号交出来。用途是**确认真实形状**——合成 seed 事件、
挑选压缩范围之前，先让宿主自己把结构说出来，而不是照着被截断的类型文档猜。

`limit` 缺省 8；`plainEvent` 只挑选 `type` / `seq` / `time` / `surfaceOp` / `ignorable` / `data` 六个键，
**不改动原事件**（只读纪律）。

## 测试覆盖

`tests/compaction-driver.test.mjs`（19 个用例）覆盖 setup 的四条分支与两条能力门、ifNeeded 的 null/真压缩/触发方式、
region 的合法与非法范围、`compactNow` 缺 runMaintenance、inspect / dump 两条只读路径（含无 `snapshotEvents` 的降级）、
结果归一化三态与两个纯函数。**五个原子都有既有测试覆盖**。

其中 `compaction-now` 的覆盖是**条件覆盖**：`act：compactNow 缺 runMaintenance 时如实记为不可用（不伪造回调）`
覆盖了它的主路径（有 `compactNow()` 但无 `runMaintenance`）与"不伪造回调"这条纪律；
"**真的调到 `compactNow`**"只在带 `runMaintenance` 的真实 agent 上下文里可复现，隔离会话下不可达——
这是本条目 `availableIn: RequiresAgentContext` 的直接后果，也说明它的端到端路径需要活宿主才能补。
