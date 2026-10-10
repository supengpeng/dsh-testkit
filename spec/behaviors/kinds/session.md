---
domain: kinds
module: session
revision: 1

atomics:
  - id: BEH-KIND-SESSION-001
    title: run-command —— 注册临时人类命令并直接驱动其 handler
    atomic: run-command
    status: active

    source:
      file: src/kinds/session.ts
      lines: "321-354"
      symbols:
        - "sessionDriver"
        - "buildCommandDefinition"
        - "SessionCommandSpec"
        - "TESTKIT_COMMAND_ERROR"
      tests:
        - "tests/session-driver.test.mjs::buildCommandDefinition：缺省回显输入（并填好元信息）"
        - "tests/session-driver.test.mjs::buildCommandDefinition：returns 覆盖回显"
        - "tests/session-driver.test.mjs::buildCommandDefinition：error=true 返回 error 结果（不抛）"
        - "tests/session-driver.test.mjs::buildCommandDefinition：throws 走异常路径（与 error 不同）"
        - "tests/session-driver.test.mjs::buildCommandDefinition：throws 优先于 error"
        - "tests/session-driver.test.mjs::buildCommandDefinition：已取消的 signal 立即拒绝"
        - "tests/session-driver.test.mjs::buildCommandDefinition：执行是可重复的（无隐藏状态）"
        - "tests/session-driver.test.mjs::setup：把命令注册进宿主，并走 facade 的 DSH 形状"
        - "tests/session-driver.test.mjs::setup：宿主没有 commands 能力时抛 SkipCase"
        - "tests/session-driver.test.mjs::act：驱动命令成功并写全取证"
        - "tests/session-driver.test.mjs::act：error 结果路径不抛异常，但 kind 为 error"
        - "tests/session-driver.test.mjs::act：异常路径被记账进 commandError"
        - "tests/session-driver.test.mjs::act：驱动未注册的命令时明确报错（而不是静默什么都不做）"
        - "tests/session-driver.test.mjs::act：release 之后命令索引失效（证明状态确实挂在 Fixture 上）"
        - "tests/session-driver.test.mjs::act：非 session 动作直接报错"
        - "tests/session-driver.test.mjs::setup：没有 command 声明时是空操作"
        - "tests/session-driver.test.mjs::driver 元信息：kind / requires 正确"

    capabilities: ["commands"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.session.command = { name: 'tk-cmd' }，宿主具备 commands 能力"
        when: "setup 阶段注册"
        then: "fx.registeredCommands contains 'tk-cmd'；宿主 command 定义 description 缺省为 'dsh-testkit 临时命令 tk-cmd'"
        verdict: pass
      - given: "命令声明 returns 缺失"
        when: "act: { kind: session, session: { command: { name: 'tk-cmd', input: 'hi' } } }"
        then: "fx.commandKind is 'success'；fx.commandText is 'echo:hi'"
        verdict: pass
      - given: "命令声明 { error: true, returns: 'BOOM' }"
        when: "act 驱动该命令"
        then: "fx.commandKind is 'error'；fx.commandText is 'BOOM'；fx.commandError exists 为 false（返回值形态的失败不抛异常）"
        verdict: fail
      - given: "命令声明 throws: 'bang'"
        when: "act 驱动该命令"
        then: "fx.commandError contains 'bang'；fx.commandResult exists 为 false"
        verdict: fail
      - given: "命令声明同时有 throws 与 error: true"
        when: "act 驱动该命令"
        then: "走异常路径（throws 优先于 error）"
        verdict: fail
      - given: "命令名未在 setup 里注册"
        when: "act: { kind: session, session: { command: { name: 'nope' } } }"
        then: "throws 为 true，错误信息 contains '未注册'"
        verdict: fail
      - given: "宿主不具备 commands 能力，但声明了 setup.session.command"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "同一命令连续驱动两次"
        when: "两次 act: { kind: session, session: { command } }"
        then: "fx.commandCount is 2；fx.commandInvocations length is 2（index 依次 1/2）"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.commandError 文本"
        reason: "错误消息来自场景声明的 throws 文本或宿主执行"
        reconcile: "normalize:normalize-message"
      - field: "commandInvocations[].rawInput 缺省值"
        reason: "input 省略时按 '' 处理，场景是否显式给值不影响语义但影响记录"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      error: normalize-message

  - id: BEH-KIND-SESSION-002
    title: flush-session —— 触发一次会话日志持久化检查点并观察 listener 参与
    atomic: flush-session
    status: active

    source:
      file: src/kinds/session.ts
      lines: "358-398"
      symbols:
        - "sessionDriver"
        - "SessionSetup"
        - "SessionFlushObserverSpec"
        - "currentSessionId"
      tests:
        - "tests/session-goal.test.mjs::flush：宿主没有 sessions 能力时跳过"
        - 'tests/session-goal.test.mjs::flush：经唯一入口触发，并取证"有没有 listener 参与"'
        - "tests/session-goal.test.mjs::flush：慢观察者会拖长 flush —— 证明宿主真的 await 了 listener"
        - 'tests/session-goal.test.mjs::flush：宿主报告"没有 listener 参与"时如实记录'

    capabilities: ["sessions"]
    availableIn: RequiresAgentContext
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.session.flushObserver = {}，宿主具备 sessions 能力且有活会话"
        when: "act: { kind: session, session: { flush: { note: 'n1' } } }"
        then: "fx.sessionFlushNote is 'n1'；fx.sessionFlushError exists 为 false；fx.sessionFlushObserverCalls is 1；fx.sessionFlushSessionId is 当前会话 id"
        verdict: pass
      - given: "flushObserver.slowMs = 120"
        when: "act: { kind: session, session: { flush: {} } }"
        then: "fx.sessionFlushDurationMs atLeast 120（证明宿主真的 await 了 listener，而不是 fire-and-forget）"
        verdict: pass
      - given: "宿主的 sessions.flush() 返回 false"
        when: "act flush"
        then: "fx.sessionFlushParticipated is false"
        verdict: pass
      - given: "拿不到当前会话 id（agents 的 initiator 为空）"
        when: "act flush"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "宿主 sessions 服务不提供 flush() / get()"
        when: "act flush"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "宿主不具备 sessions 能力但声明了 flushObserver"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip

    cleanup: registered

    nonDeterministic:
      - field: "fx.sessionFlushDurationMs"
        reason: "挂钟时间差，含调度抖动"
        reconcile: "atLeast 语义（下限 120ms）"
      - field: "fx.sessionFlushError 文本"
        reason: "错误消息由宿主抛出"
        reconcile: "normalize:normalize-message"
      - field: "fx.sessionFlushSeqBefore / SeqAfter"
        reason: "会话序号取决于宿主此前累计的事件数，不是本场景的确定值"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      error: normalize-message
      durationMs: atLeast
      seq: ignore

  - id: BEH-KIND-SESSION-003
    title: goal-op —— 驱动机会话目标状态机（get / create / edit / pause / resume / complete / clear / disarm / block）
    atomic: goal-op
    status: active

    source:
      file: src/kinds/session.ts
      lines: "422-525"
      symbols:
        - "sessionDriver"
        - "extractGoalCode"
        - "matchGoalCode"
        - "REMOTE_OP_MISUSE"
        - "noteGoal"
        - "requireRef"
        - "currentRef"
      tests:
        - "tests/session-goal.test.mjs::extractGoalCode：code / info.code / message 三种形状都认"
        - "tests/session-goal.test.mjs::goal：没有 goals 服务时跳过"
        - "tests/session-goal.test.mjs::goal：拿不到当前 agent 时跳过（目标服务要确切活 agent 作凭据）"
        - "tests/session-goal.test.mjs::goal：create 记录 armed，并**默认立刻收回授权**（不留下自动续轮）"
        - "tests/session-goal.test.mjs::goal：disarmAfter=false 时保留 armed（显式要求才这么做）"
        - "tests/session-goal.test.mjs::goal：pause / resume / complete 全链都带 revision 守卫"
        - "tests/session-goal.test.mjs::goal：clear 返回墓碑 ref，且之后的 get 应为空"
        - "tests/session-goal.test.mjs::goal：没有当前目标时做 pause → 记 goalError（不抛）"
        - "tests/session-goal.test.mjs::goal：block 带稳定错误码写入"
        - "tests/session-goal.test.mjs::goal：@Remote 方法本地直调会崩 —— driver 把它翻译成明确诊断"
        - "tests/session-goal.test.mjs::teardown：本场景创建过目标时留下墓碑（减少对宿主会话的影响）"
        - "tests/session-goal.test.mjs::teardown：没创建过目标时什么都不做"

    capabilities: ["goals"]
    availableIn: RequiresAgentContext
    costTier: none
    parallel: exclusive

    observable:
      - given: "宿主有完整 goals 服务，且能解析出当前 agent"
        when: "act: { kind: session, session: { goal: { op: 'create', objective: 'X' } } }"
        then: "fx.goalObjective is 'X'；fx.goalId exists 为 true；fx.goalCreatedPhase is 'active'；fx.goalError exists 为 false"
        verdict: pass
      - given: "create 未显式写 disarmAfter: false"
        when: "act goal create"
        then: "fx.goalCreatedActivation is 'armed'；fx.goalAfterDisarmActivation is 'disarmed'（默认立刻收回授权，不留下自动续轮）"
        verdict: pass
      - given: "create 显式写 disarmAfter: false"
        when: "act goal create"
        then: "fx.goalAfterDisarmActivation exists 为 false（保留 armed）"
        verdict: pass
      - given: "已有当前目标"
        when: "act goal { op: 'block', code: 'GOAL_X', message: 'm' }"
        then: "fx.goalErrorCode is 'GOAL_X'"
        verdict: fail
      - given: "没有任何当前目标"
        when: "act goal { op: 'pause' }"
        then: "fx.goalError contains '需要先有一个当前目标'；场景不失败（错误被吞进取证）"
        verdict: fail
      - given: "goals.edit / pause / resume / complete / clear 被本地直接调用（@Remote 方法）"
        when: "act goal 上述任一 op"
        then: "fx.goalRemoteOpRequired is true；fx.goalError 记崩溃消息（driver 把内部崩溃翻译成可执行诊断）"
        verdict: fail
      - given: "宿主不提供 goals 服务"
        when: "act goal"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "解析不出当前 agent"
        when: "act goal"
        then: "case 被标为 skipped（SkipCase），说明目标服务需要确切的活 agent 作授权凭据"
        verdict: skip
      - given: "本场景 create 过目标"
        when: "场景 teardown"
        then: "fx.goalTeardownCleared is true（留下墓碑，减少对宿主会话的影响）"
        verdict: pass
      - given: "act goal { op: 'clear' }"
        when: "读取取证"
        then: "fx.goalClearedRevision 是数字（clear 返回墓碑 ref 而不是 view）"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.goalId / fx.goalRevision"
        reason: "目标 id 与 revision 由宿主目标服务分配，跨运行不稳定"
        reconcile: "normalize:goal-ref"
      - field: "fx.goalError 文本"
        reason: "错误消息由宿主抛出（含 @Remote 直调时的内部崩溃消息）"
        reconcile: "normalize:normalize-message"
      - field: "fx.goalRoundsStarted"
        reason: "取决于宿主自动续轮的调度情况"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      error: normalize-message
      goalRef: goal-ref

  - id: BEH-KIND-SESSION-004
    title: observe-events —— 只读观察 session/event 追加流并给出单调性结论
    atomic: observe-events
    status: active

    source:
      file: src/kinds/session.ts
      lines: "402-418"
      symbols:
        - "sessionDriver"
        - "isMonotonicSeq"
        - "SessionSetup"
      tests:
        - "tests/session-goal.test.mjs::isMonotonicSeq：严格递增才算单调"
        - "tests/session-goal.test.mjs::events：观察者只记本会话的事件，并给出单调性结论"
        - 'tests/session-goal.test.mjs::events：序号倒退时单调性判否（这就是它要抓的"日志乱序"）'
        - "tests/session-goal.test.mjs::act：未知的 session 动作明确报错"
        - "tests/session-goal.test.mjs::act：非 session 动作直接报错"

    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.session.eventObserver = true，且能解析出当前会话 id"
        when: "act: { kind: session, session: { events: { waitMs: 50, limit: 5 } } }"
        then: "fx.sessionEventCount atLeast 0；fx.sessionEvents length atMost 5；fx.sessionEventTypes 是去重后的类型数组；fx.sessionEventSeqMonotonic is true"
        verdict: pass
      - given: "宿主产生了序号倒退的事件"
        when: "act session events"
        then: 'fx.sessionEventSeqMonotonic is false（这就是它要抓的"日志乱序"）'
        verdict: fail
      - given: "观察者只收到其它会话的事件"
        when: "act session events"
        then: "fx.sessionEventCount is 0（非本会话的事件被过滤）"
        verdict: pass
      - given: "session 动作既不是 command / flush / goal 也不是 events"
        when: "act: { kind: session, session: {} }"
        then: "throws 为 true，错误信息 contains '未知的 session 动作'"
        verdict: fail

    cleanup: registered

    nonDeterministic:
      - field: "fx.sessionEventCount / fx.sessionEvents"
        reason: "取决于宿主在 waitMs 窗口内提交了多少事件，以及此前会话已积累的事件"
        reconcile: "tolerance:0（只做下界/存在性断言）"
      - field: "fx.sessionEvents[].seq"
        reason: "会话序号全局累计，跨运行不稳定"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      eventTypes: exact
      count: atLeast
---

## run-command

`setup.session.command` 走 `buildCommandDefinition` 造出 `CommandDefinition`，经 `ctx.host.registerCommand()` 注册，
disposer 进 Fixture；同时把定义存进 `commandIndex`（WeakMap，挂在 fixture 上，**不进 notes**——notes 会被序列化进报告，
函数字段会在 JSON 化时丢失，存进去反而制造"看起来有、实际取不到"的假象）。

命令行为三条路径：`throws`（优先）→ `error: true`（返回 `{kind:'error'}`，不抛）→ `{kind:'success', text: returns ?? 'echo:'+input}`。

**为什么 act 直接调我们注册的 handler，而不是 `commands.execute(...)`**（源码 11-20 行）：
`ctx.commands.execute(agent, line, attachments, signal)` 需要一个 `agent`（Remote 方法，第一个参数就是接收者）。
自检场景没有真实 agent，硬凑假 agent 只会让"测命令逻辑"变成"测假 agent 能不能过校验"。

### 边界与已知缺陷

1. **宿主的分发链完全没被覆盖**：act 只调 `definition.execute(...)`，于是"解析斜杠 → 找命令 → 归属 agent →
   记录 `command/run` 审计事件"这一串 `commands` 服务的行为不在断言范围内（源码 18-20 行自认）。这是明确的范围取舍，
   但新实现不能假设它已被 spec 记录。
2. **`commandIndex` 的存在使"注册"与"可驱动"强耦合**：act 只能驱动**本场景 setup 声明过的**命令；
   用别的途径注册的命令即使存在于宿主里也会被判定为"未注册"而报错。断言"宿主里存在某命令"因此不可表达。
3. **静默空操作**：`setup.session.command` 缺失时整个 setup 是空操作（无取证、无报错），拼错字段名会得到一条通过但什么都没做的场景。

## flush-session

`ctx.sessions.flush(session)` 是**唯一入口**，返回"有没有 listener 参与"。
`setup.session.flushObserver.slowMs` 不是为了"制造延迟"，而是**验证 flush 真的 await 了 listener**——
契约原文是 "after every listener has settled successfully"；若宿主 fire-and-forget，`fx.sessionFlushDurationMs` 就不会 ≥ slowMs。

`targetSessionId` 由 `currentSessionId` 从 `ctx.host.service('agents')` 解析而来；拿不到就 `SkipCase`——
flush 需要一个**确切会话**。因此本条目声明 `availableIn: RequiresAgentContext`（依据 `session.ts:369-371`
的 SkipCase 分支：没有 initiator 就没有可 flush 的会话）。

### 边界与已知缺陷

1. **`targetSessionId` 为空时过滤条件整体失效**：setup 只在解析成功时写 `fx.sessionTargetId`；
   而事件/flush 观察者的过滤都是"`targetSessionId !== undefined` 才过滤"（源码 262、272 行）。
   一旦解析不出 initiator，观察范围从"本会话"**静默扩大成全局**——断言 `sessionEventCount is 0` 之类的场景可能因此误判。
2. **`fx.sessionFlushParticipated` 只在返回值是布尔时记录**：非布尔返回值记 `undefined`，于是"没有 listener 参与"与
   "宿主返回值类型变了"在 `fx` 上不可区分。
3. **`fx.sessionFlushSeqBefore/After` 是环境相关的绝对值**：不是"本次 flush 加了几条"，断言只能用 `atLeast`。

## goal-op

`ctx.goals` 是会话自带的目标状态机。`runGoal` 需要「**确切的活 agent**」作为授权凭据
（`session.ts:427-430`：拿不到就 `SkipCase`）——因此本条目声明 `availableIn: RequiresAgentContext`。

**两个安全阀**（源码 29-34 行）：

1. `create` 会 **arm 自动续轮**（`goal-round-driver` 会一直唤醒模型）。driver 默认在 create 之后**立刻 `disarm`**
   （只清进程内授权、不改持久 phase），armed / disarmed 两个状态都写进取证；要观察 armed 就断言 `goalCreatedActivation`。
2. teardown 对本场景创建过的目标尝试 `clear`（墓碑），减少残留。

`extractGoalCode` 从 `code` / `errorCode` / `info.code` / message 四类位置提取稳定错误码（`GOAL_*` / `TEAM_*`），
**不猜形状**、原文另记进 `fx.goalError`。

### 边界与已知缺陷

1. **`edit` / `pause` / `resume` / `complete` / `clear` 在自检场景里实际不可用**：它们是 `@Remote` 方法，
   本地直调会崩在内部属性访问上（`REMOTE_OP_MISUSE` 正则匹配 `transition|prepareMutation|mutate|commit|journal`）。
   driver 只能**事后识别**这种崩溃并翻成 `fx.goalRemoteOpRequired`（源码 520-523 行），不能真正驱动这些 op。
   测试 `goal：@Remote 方法本地直调会崩` 证明这是已观测事实而非推断。
2. **teardown 与 act 对同一已知崩溃的处理不一致**：act 路径把 `REMOTE_OP_MISUSE` 翻译成可执行诊断，
   但 teardown 直接调 `goals.clear(agent, ref)`（310 行）且 catch 只记 `goalTeardownError`——同一个 `@Remote` 崩溃
   在两条路径上的可读性不同。
3. **`capabilities: ["goals"]` 不足以表达真实前提**：`runGoal` 还需要用 `ctx.host.service('agents')` 解析出**确切的活 agent**
   （427-430 行），而 `agents` 不在 `HostCapability` 枚举里（`src/cases/types.ts:26-50` 有 `agentLoop` / `subagents` / `agentTeams`
   但没有通用的 `agents`）。这是 spec 与能力枚举之间的一个真实缺口：静态 `validate` 无法只看 capabilities 判定 goal-op 可跑。
4. **`clear` 与其它 op 的返回形态不同**：`clear` 返回墓碑 ref 而不是 `GoalView`，所以它不写 `fx.goalId` 等字段，
   只写 `fx.goalClearedRevision`；断言时容易写错字段名。
5. **`requireRef` 的"先 create 或宿主里已存在"依赖隐式状态**：`state.goalRef` 是场景内记忆，`currentRef` 从宿主的 `get()` 现取。
   若宿主在场景中途清掉目标，`requireRef` 的报错与"从未创建过"完全相同，无法区分。

## observe-events

只监听 `session/event`，记录 `{type, seq}`，**绝不写入**。原因（源码 22-27 行，来自 DSH `practices.md`）：
不要用新的 `type` 追加会话事件——读取方只接受带 `ignorable: true` 的未知事件，而 `Session.append()` 设不了这个标记，
于是**那个会话会拒绝重开**。

`act events` 可选 `waitMs` 等待，然后给出 `fx.sessionEventCount`（全量）、`fx.sessionEvents`（末 `limit ?? 20` 条）、
`fx.sessionEventTypes`（去重）与 `fx.sessionEventSeqMonotonic`（`isMonotonicSeq`：严格递增才算单调）。

### 边界与已知缺陷

1. **`seq` 缺失被兜成 0**：观察者写 `seq: typeof seq === 'number' ? seq : 0`（276 行），于是"字段缺失"与"序号真的是 0"
   在 `fx.sessionEvents` 中不可区分，可能让单调性检查误判（首个事件缺 seq 时会得 0，与后续真实 0 冲突）。
2. **`limit` 与 count 的口径不同**：`fx.sessionEventCount` 是全量，`fx.sessionEvents` 只给末 20 条。
   断 `length is N` 时若不显式写 `limit: N`，会得到与直觉不符的结果。
3. **能力声明为 `[]`，但实际依赖会话身份**：过滤依赖 `targetSessionId`（来自 `agents` 服务）。
   没有 initiator 时事件观察者会记录**所有**会话的事件（见 flush 的缺陷 1），而此时 `capabilities: []` 仍允许场景运行。

## 测试覆盖

- `tests/session-driver.test.mjs`（17 个用例）覆盖 run-command 的注册、三条执行路径与命令索引生命周期。
- `tests/session-goal.test.mjs`（21 个用例）覆盖 flush / events / goal / teardown 四类分支与两个纯函数。
- **四个原子都有既有测试覆盖**，无缺口。
