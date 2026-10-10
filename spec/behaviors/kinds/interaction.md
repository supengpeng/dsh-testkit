---
domain: kinds
module: interaction
revision: 3

atomics:
  - id: BEH-KIND-INTERACTION-001
    title: answer-question —— 注册提问答者并触发一次 user-questions/request
    atomic: answer-question
    status: active

    source:
      file: src/kinds/interaction.ts
      lines: "119-213"
      symbols:
        - "interactionDriver"
        - "InteractionSetup"
        - "InteractionQuestionSpec"
        - "buildAnswer"
        - "TESTKIT_QUESTION_TIMEOUT"
      tests:
        - "tests/interaction-driver.test.mjs::buildAnswer：answer 简写放进 selected"
        - "tests/interaction-driver.test.mjs::buildAnswer：select 显式数组优先"
        - "tests/interaction-driver.test.mjs::buildAnswer：显式 answers 原样透传"
        - "tests/interaction-driver.test.mjs::buildAnswer：问题缺 id 时回退到 q1/q2"
        - "tests/interaction-driver.test.mjs::buildAnswer：没有 questions 时产出空数组（不崩）"
        - "tests/interaction-driver.test.mjs::buildAnswer：custom 会被带上"
        - "tests/interaction-driver.test.mjs::setup：question 分支要求 userQuestions 能力"
        - "tests/interaction-driver.test.mjs::act：提问被应答，且拿到的是声明值（不是兜底）"
        - "tests/interaction-driver.test.mjs::act：故意不答时以超时错误收尾并记账"
        - "tests/interaction-driver.test.mjs::act：release 后答者被摘掉，兜底值重新生效"

    capabilities: ["userQuestions"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.interaction.question = { answer: 'YES' }，宿主具备 userQuestions"
        when: "act: { kind: interaction, interaction: { question: { question: '继续？' } } }"
        then: "fx.answer.answers[0].selected contains 'YES'；fx.questionCount is 1；fx.questionError exists 为 false"
        verdict: pass
      - given: "setup.interaction.question = { select: ['A','B'] }，宿主 request 里有 2 个问题"
        when: "act: { kind: interaction, interaction: { question: ... } }"
        then: "fx.answer.answers length is 2，且每个元素的 selected is ['A','B']"
        verdict: pass
      - given: "setup.interaction.question = { answers: [{ id: 'x', selected: ['1'] }] }"
        when: "act: { kind: interaction, interaction: { question: ... } }"
        then: "fx.answer.answers is [{ id: 'x', selected: ['1'] }]（完全显式，原样透传）"
        verdict: pass
      - given: "setup.interaction.question = { timeout: true }"
        when: "act: { kind: interaction, interaction: { question: ... } }"
        then: "fx.questionError contains 'TESTKIT_QUESTION_TIMEOUT'；fx.answer exists 为 false"
        verdict: fail
      - given: "没有任何答者（无 driver 介入）"
        when: "act: { kind: interaction, interaction: { question: ... } }"
        then: "fx.questionError contains 'TESTKIT_NO_ANSWERER'（waterfall 兜底是明确抛错）"
        verdict: fail
      - given: "宿主不具备 userQuestions 能力"
        when: "setup.interaction.question 存在"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "宿主不具备 userQuestions 能力"
        when: "act 发出 question 动作"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "setup.interaction.question = {}（无 answer / select / answers）"
        when: "act: { kind: interaction, interaction: { question: { question: '随便问' } } }"
        then: "fx.answer.answers length is 1；fx.answer.answers[0].id is 'testkit-q1'；fx.answer.answers[0].selected is []（空数组，不崩、不猜）；fx.questionError exists 为 false"
        verdict: pass
      - given: "setup.interaction.question = { custom: '我自己写的' }"
        when: "act: { kind: interaction, interaction: { question: { question: '随便问' } } }"
        then: "fx.answer.answers[0].custom is '我自己写的'；fx.answer.answers[0].selected is []（只给 custom 时 selected 为空）"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.questionError 文本"
        reason: "错误消息由 waterfall 兜底或宿主抛出"
        reconcile: "normalize:normalize-message"
      - field: "fx.questionRequest 的宿主侧字段"
        reason: "request 对象的形状由 DSH 版本决定"
        reconcile: "normalize:superset-of-declared"
      - field: "fx.questions[].questionCount"
        reason: "真实宿主在一次 request 里放几个问题不由 driver 决定"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      error: normalize-message
      request: superset-of-declared

  - id: BEH-KIND-INTERACTION-002
    title: answer-approval —— 注册审批者并触发一次 approval/request
    atomic: answer-approval
    status: active

    source:
      file: src/kinds/interaction.ts
      lines: "147-239"
      symbols:
        - "interactionDriver"
        - "InteractionApprovalSpec"
        - "InteractionSetup"
        - "normalizeDecision"
        - "APPROVAL_OUTCOMES"
        - "ApprovalOutcomeLike"
      tests:
        - "tests/interaction-driver.test.mjs::normalizeDecision：合法词汇通过，缺省 rejected"
        - "tests/interaction-driver.test.mjs::normalizeDecision：非法词汇给出带词汇表的错误"
        - "tests/interaction-driver.test.mjs::setup：approval-only 场景不因缺 userQuestions 而跳过"
        - "tests/interaction-driver.test.mjs::setup：非法 decision 在注册前就被拦下"
        - "tests/interaction-driver.test.mjs::act：审批返回声明的决策，而不是兜底的 unavailable"
        - "tests/interaction-driver.test.mjs::act：没有 driver 时兜底值是 unavailable（对照组）"
        - "tests/interaction-driver.test.mjs::driver 元信息：kind 正确，且不静态声明 requires"

    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.interaction.approval = { decision: 'allowed-once' }"
        when: "act: { kind: interaction, interaction: { approval: { toolName: 'x' } } }"
        then: "fx.approvalOutcome is 'allowed-once'；fx.plannedDecision is 'allowed-once'；fx.approvalCount is 1；fx.approvals length is 1；fx.approvalError exists 为 false"
        verdict: pass
      - given: "setup.interaction.approval = {}（不给 decision）"
        when: "act: { kind: interaction, interaction: { approval: { toolName: 'x' } } }"
        then: "fx.approvalOutcome is 'rejected'（缺省拒绝，fail closed）；fx.plannedDecision is 'rejected'"
        verdict: fail
      - given: "setup.interaction.approval = { decision: 'cancelled' }"
        when: "act: { kind: interaction, interaction: { approval: { toolName: 'x' } } }"
        then: "fx.approvalOutcome is 'cancelled'；fx.plannedDecision is 'cancelled'；fx.approvalCount is 1；fx.approvals length is 1（声明值被原样回显，不是兜底）"
        verdict: fail
      - given: "setup.interaction.approval = { decision: 'unavailable' }（作为**声明值**）"
        when: "act: { kind: interaction, interaction: { approval: { toolName: 'x' } } }"
        then: "fx.approvalOutcome is 'unavailable'；且 fx.plannedDecision is 'unavailable'、fx.approvalCount is 1、fx.approvals length is 1"
        verdict: fail
      - given: "没有任何答者（无 driver 介入）"
        when: "act: { kind: interaction, interaction: { approval: { toolName: 'x' } } }"
        then: "fx.approvalOutcome is 'unavailable'；且 fx.plannedDecision exists 为 false、fx.approvalCount exists 为 false、fx.approvals exists 为 false（没有答者就没有这三个键）"
        verdict: fail
      - given: "同一个 outcome 字符串 'unavailable' 有两个来源（声明值 / 答者缺席兜底）"
        when: "分别构造两条路径后比较取证"
        then: "判定必须读**键的存在性**——声明值路径 fx.plannedDecision is 'unavailable' 且 fx.approvalCount is 1；兜底路径这两个键 exists 均为 false。只看 fx.approvalOutcome 的读者或对拍器会把两条路径判成同一条"
        verdict: fail
      - given: "setup.interaction.approval.decision = 'maybe'"
        when: "setup 阶段"
        then: "throws 为 true，错误信息 contains 'allowed-once | rejected | cancelled | unavailable'"
        verdict: fail
      - given: "setup.interaction 缺失，但 act 发出 approval 动作"
        when: "act 触发 approval waterfall"
        then: "fx.approvalRequest.toolName is 'x'；fx.approvalRequest.agent is { id: 'testkit-agent' }"
        verdict: pass
      - given: "宿主不具备 userQuestions 能力，而场景只声明 setup.interaction.approval = { decision: 'allowed-once' }"
        when: "act: { kind: interaction, interaction: { approval: { toolName: 'x' } } }"
        then: "场景**不**被跳过（不抛 SkipCase）；fx.approvalOutcome is 'allowed-once'；fx.plannedDecision is 'allowed-once'；fx.approvalCount is 1（能力门只在 question 分支，approval 分支不受影响）"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.approvalError 文本"
        reason: "错误消息由 waterfall 兜底或宿主抛出"
        reconcile: "normalize:normalize-message"
      - field: "fx.approvalRequest 的宿主侧字段（signal 等）"
        reason: "request 对象的形状由 DSH 版本决定"
        reconcile: "normalize:superset-of-declared"

    equivalence:
      verdict: exact
      error: normalize-message
      request: superset-of-declared
---

## answer-question

**为什么 act 直接触发 waterfall 而不调服务方法**（源码 17-24 行）：`approval.request()` 要求"必须有开启的 turn"
（审计对要被会话日志的 commit/replay 边界包住），自检场景没有 turn，直接调必然抛错。所以 act 走
`ctx.host.waterfall(...)`「替宿主发起这次请求」——绕过 turn 前置条件，但仍经过完整 listener 链。

**waterfall 形状与 `llm/stream` 不同（实测）**：`user-questions/request` 的 `next` 是 `() => Promise<...>`；
`llm/stream` 的 `next` 是同步返回 `AsyncIterable`。照抄隔壁 driver 会静默失效（源码 4-15 行明确警告）。

**`buildAnswer`（纯函数）的三档取值优先级**：显式 `answers` → 逐问题映射
`{ id: q.id 或 qN, selected, custom? }`；`selected` 取 `select` 数组，否则 `[answer]`，否则 `[]`。

**兜底与失败**：question 的 waterfall 兜底抛 `TESTKIT_NO_ANSWERER`（自检时用于区分"没人答"与"答错了"），
`timeout: true` 抛 `TESTKIT_QUESTION_TIMEOUT`（附 `code = 'ASK_TIMED_OUT'`）。两者都被吞进 `fx.questionError`，不抛出。

能力检查是**条目级**的：`question` 需要 `userQuestions`，setup 与 act 各检查一次，缺能力抛 `SkipCase`。

### 边界与已知缺陷

1. **answer-question 的提问分支硬编码单个问题**：`id: 'testkit-q1'`（178-191 行），而 setup 分支面对的 request
   来自真实宿主（可能是多问题）。于是 `buildAnswer` 的多问题映射只有单测覆盖，端到端路径永远只走一个问题。
2. **`selected` 对所有问题共用一份**：`buildAnswer` 把同一个 `selected` 数组赋给每个问题，
   无法表达"第 1 题选 A、第 2 题选 B"——除非改用完全显式的 `answers`（此时 `custom` 等便利字段都用不上）。
3. **`fx.questions` 取证过薄**：只记问题个数，不记问题文本、选项与 `multiSelect`。断言"宿主正确传递了
   header/detail/options"在 `fx` 上不可判定。
4. **旧实现的静态 `requires` 取舍**：`interactionDriver` 故意**不**声明 `requires`（源码 110-113 的注释），
   因为静态并集会让 approval-only 场景被误判成"缺能力"。本 spec 用**条目级** `capabilities` 表达这一差异
   （answer-question → `userQuestions`，answer-approval → `[]`）——方案 (C) 的文件/条目两级结构正好消解了旧实现的这个两难。
5. **`QP-07`（request 里没有 questions → `answers === []`）在场景面不可触发**：`buildAnswer` 的
   `Array.isArray(request?.questions) ? request.questions : []`（`interaction.ts:76`）确实是实现里的一个分支，
   但 act 构造的 request **恒有 1 个 question**（`interaction.ts:178-191` 写死 `questions: [{ id: 'testkit-q1', … }]`），
   而 act 是 `user-questions/request` 的唯一触发点 ⇒ 该 else 分支在测试台**不可达**。
   它只在"真实宿主以空 questions 调该事件"时可达，属**单测可达、场景不可达**：
   `tests/interaction-driver.test.mjs:51-55` 用 `buildAnswer(undefined, {})` 直测纯函数覆盖了它。
   ⇒ 这条路径**无法写成 `fx.*` 可判定条目**（没有场景能构造出对应的 given）；B5 的分母是否保留它需 Lead 裁决。
6. **`DP-06`（非 interaction 动作 → 显式报错）不是交互/审批路径（2026-10-11 裁决：出 B5 分母）**：
   `interaction.ts:166-170` 的动作类型守卫是**每个 driver 都有一份**的通用输入校验
   （`tool.ts:442-446`、`llm.ts:195-199`、`session.ts:283-287`、`file.ts:166-170` 同款），
   它不承载任何交互/审批语义——把其中一份计入 B5 分母是机械展开的产物，与 B1 的 `kinds/types.ts` 同型。
   沿革：它曾计入分母（原值 **20**），2026-10-11 因"不属审批面"移出（→ **19**）；**原值在此保留，分母变化必须可见**。
   同族还有一条**本来就没进分母**的守卫：`interaction.ts:241`（"interaction 动作必须包含 question 或 approval"）——
   两条守卫同类，现在都不在分母里，口径一致。

## answer-approval

**`normalizeDecision`（纯函数）** 校验 `APPROVAL_OUTCOMES = ['allowed-once','rejected','cancelled','unavailable']`，
缺省 `rejected`，非法值在 **setup 期**就报错（而不是让 DSH 归一化成 `unavailable`）。
act 的兜底返回 `'unavailable'`，与 DSH「答者缺席 fail closed」一致。

**四条词汇都能用场景声明**（证据链：`interaction.ts:37` 声明 4 值 → `:53-58` 的 `InteractionApprovalSpec.decision`
类型就是这 4 值的联合 → `:93-102` 的 `normalizeDecision` 只做白名单校验、**不做任何值域收窄** →
`:147-159` 的 setup listener 无条件 `return decision`）。按 B5 清单的口径：approved = `allowed-once`、
denied = `rejected`，另两条是 `cancelled` / `unavailable`。

**两条来源的机械区分（本文件的核心判定规则）**：`fx.approvalOutcome` 的字符串 `'unavailable'` 有两个来源——
答者**声明**了它，或**没有答者**时 waterfall 的兜底（`interaction.ts:229` 的 `() => 'unavailable'`）。
只读 `approvalOutcome` 无法区分；分界是三个键的**存在性**：

| 路径 | `fx.plannedDecision` | `fx.approvalCount` | `fx.approvals` |
|---|---|---|---|
| 声明值（`setup.interaction.approval.decision`） | 存在（setup 期 `note`，`interaction.ts:161`） | is 1（listener 真被调用） | length is 1 |
| 兜底（答者缺席） | 不存在 | 不存在 | 不存在 |

`fx.plannedDecision` 在 **setup** 期就落（只要有 `setup.interaction.approval` 声明），而 `fx.approvalCount` /
`fx.approvals` 只在 **listener 真被调用**时落——所以三键合起来同时证明了"有声明"与"声明真的生效"。

### 边界与已知缺陷

1. **【沿革记录】「只有两条审批词汇可被声明」的结论已被实跑证伪（CONFLICT-AP-1，2026-10-11）**：
   本文件原文写「`InteractionApprovalSpec.decision` 实际只被用于 `allowed-once` / `rejected`；
   `cancelled` / `unavailable` 只能通过"答者缺席"的兜底间接出现（源码 28-30 行承认"另外两个留给真实路径"）。
   因此 B5「审批路径覆盖 100%」在旧实现上**无法用场景声明**表达全部四条路径」。
   **该结论不成立**：`normalizeDecision`（`interaction.ts:93-102`）接受 `APPROVAL_OUTCOMES` 全部 4 值、
   不做值域收窄，setup 的 listener 也无条件 `return decision`（`interaction.ts:148-159`）。
   实跑证据见 `spec/contracts/approval-paths.yaml` 的 `expressibility_proofs`——AP-03（`decision: cancelled`）与
   AP-04（`decision: unavailable`）均 `passed`，且 `notes.plannedDecision` 等于声明值。
   **错误来源**：本文件把驱动头注释（`interaction.ts:28-30`"本 driver 只产出前两个为代表，另外两个留给真实路径"）
   误读成了实现约束——那是注释里的取舍叙述，代码里没有对应分支或校验。**注释与代码冲突时以代码 + 实跑为准**。
   （按 `spec/README.md` §3.1 第 7 条保留为沿革记录，不删除。）
2. **【沿革 + 已补】「声明值 vs 兜底」的区分规则长期未被 observable 声明**：两条路径都可能产出字符串
   `'unavailable'`，只读 `fx.approvalOutcome` 无法区分——真正的分界是 `fx.plannedDecision` /
   `fx.approvalCount` / `fx.approvals` 三个键的存在性（见上节表格）。沿革：`spec/contracts/approval-paths.yaml`
   先登记过「AP-04 与 DP-03 取证不可区分」，随后**自我修正**为「可区分，但区分规则未被 observable 声明」——
   后者才是准确表述，本轮已把规则写进本文件的 observable（第 5、6 条）。留此条是为了提醒阶段 2 的对拍器：
   **规则必须先被声明，才可能被机械检查**。
3. **审批者不看请求内容**：setup 注册的 listener 无条件返回同一个 `decision`，`InteractionApprovalSpec` 也没有
   按 `toolName` 过滤的字段。"只批准某个工具、其余拒绝"这类真实策略**不可表达**；`fx.approvals[].toolName` 只做事后记账。
4. **`InteractionApprovalSpec.reason` 是死字段**：字段存在且只在注释里说"记账用"，但 setup/act 都没有读它，
   也没有写任何 `fx.*`。场景作者写它会以为在影响审批理由。
5. **`DP-07`（release 后答者被摘掉 → 兜底重新生效）在场景面不可表达**：触发它需要"答者已被释放、但场景继续跑"，
   而 DSL 里唯一的提前释放入口是 `step.cleanup.releaseNotes`，它按**取证键**从 notes 取资源句柄
   （`src/isolation/cleanup.ts:87-108`：`stepResourceOf(fixture.getNote(key))`）。
   本 driver 的两个 disposer 走的是 `fixture.add('interaction:question' | 'interaction:approval', …)`
   （`interaction.ts:144,160`）——**label 不进 notes，也没有任何 note 键指向它们**；并且全仓库**没有任何 driver
   调用正规登记入口 `registerStepDisposer`**（grep 证据：`isolation/cleanup.ts:60` 定义、`runner.ts:19,775` 消费，
   `src/kinds/**` 零调用），裸函数路径（`fixture.note(key, fn)`）也零使用
   ⇒ `releaseNotes` 对 interaction 是 no-op（`cleanup.ts:58` 明确"找不到不报错，只是这一步拆不掉，等场景结束"）。
   故 DP-07 **单测可达**（`tests/interaction-driver.test.mjs:203-213` 直接调 `fixture.release()`）、
   **场景不可达**，无法写成 `fx.*` 可判定条目。
   **⚠️ 这条同时是一条框架级发现（不在本文件写权限内）**：`docs/SCENARIO-SPEC.md:342-356` 向场景作者承诺
   `releaseNotes` 会"在本步结束后释放对应 disposer"，但**当前实现里对全部 12 个 driver 都不生效**——
   这是"文档承诺 vs 实现"的偏差，而且因为 `cleanup.ts:58` 的"找不到不报错"是静默的，没有任何测试会红。
   修它属于 `src/isolation/cleanup.ts` + 各 driver 的登记面，需要另立任务。

## 测试覆盖

`tests/interaction-driver.test.mjs`（18 个用例）覆盖两个原子：`buildAnswer` / `normalizeDecision` 纯函数、
分支级能力检查、超时与缺席两条兜底路径、release 后兜底值恢复。**两个原子都有既有测试覆盖**。

但审批**声明值路径**的端到端覆盖只到两条：`normalizeDecision：合法词汇通过，缺省 rejected` 用
`for (const outcome of APPROVAL_OUTCOMES)` 在**纯函数层**遍历了全部 4 值（:62-67），而经 waterfall 回显的
端到端用例只有 `allowed-once`（:116-122）与 `rejected`（:169-183）。
**`decision: cancelled` 与 `decision: unavailable`（声明值）在既有测试里零覆盖**——`tests/` 全文检索
`cancelled` 无命中，`unavailable` 只出现在"没有 driver 时的兜底对照"用例（:185-192）里。
这是本轮修订暴露出的真实覆盖缺口（不是提取错误）；补测形状见 `spec/contracts/approval-paths.yaml` 里
AP-03 / AP-04 的 `test_landing`——它明确要求**必须同时断言 `fx.plannedDecision` + `fx.approvalCount`**，
否则无法与 DP-03 的兜底分界。

**task-19 新增三条 observable 与测试的对照**：
- `QP-04`（空选中 → `selected: []`）：**spec 与测试双缺**。`interaction.ts:77-81` 的 `selected = []` 分支既无端到端用例，
  纯函数层也没有 `buildAnswer(undefined, {})` 的用例。补测形状见 `approval-paths.yaml` 的 QP-04 `test_landing`。
- `QP-05`（custom）：**单测已覆盖**（`tests/interaction-driver.test.mjs:56-61`），本轮补的是 spec 侧的可判定条目。
- `DP-05`（approval-only 不因缺 userQuestions 跳过）：**单测已覆盖**（`:116-123`、`:215-217`），同样只补 spec 侧。
- `QP-07` / `DP-07`：**单测可达、场景不可达**（见两条原子的「边界与已知缺陷」），因此 spec 侧**无法**补成 `fx.*` 条目——
  这不是"分子缺"，而是"该路径的触发条件在场景面不存在"。
