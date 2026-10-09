# 场景数据规范（Scenario Spec）

> Schema 版本 **1** · 状态：`tool`（§3.2）、`prompt`（§3.3）、`llm`（§3.1）、`interaction`（§3.4）、`session`（§3.5，命令部分）、`resource`（§3.6，web 部分）**已实现并落地**；其余仍为提案。
>
> 本文档跟随实现走：driver 一旦落地，对应小节就从"提案"改成"实现"，
> 并按代码的真实语义（而不是最初设想）重写。

本规范定义 `cases/*.yaml` 的结构。目标是：**读一个 YAML，就知道这条场景在做什么**；
**写一个新场景，多数情况下不需要碰 TypeScript**。

---

## 1. 文件组织

```
cases/
├── index.yaml          索引：ID → 来源 issue、kind、状态
├── README.md           怎么写一个 case（面向人）
├── TK-0001.yaml        一案一文件
├── TK-0002.yaml
└── ...
```

规则：

| 规则 | 说明 |
|---|---|
| 一案一文件 | 禁止把多条 case 塞进一个文件；`index.yaml` 只做索引与溯源，**不是真相源** |
| 文件名 = `id` | `TK-0001.yaml` 里的 `id` 必须是 `TK-0001`，不一致视为校验失败 |
| ID 只增不改 | case 作废时标 `status: retired`，不复用 ID |
| 编码 | UTF-8，无 BOM；换行 LF |
| 排序稳定 | 文件内字段顺序按本文档示例排列，便于 diff |

### ID 分配

`TK-%04d` 顺序分配。`index.yaml` 记录已用最大号，新增时取 `max + 1`。

---

## 2. 通用结构

每条 case 由四段组成：

```yaml
# ① 元信息：这是什么、从哪来
schema: 1
id: TK-0001
title: ...
kind: tool
...

# ② 运行参数：怎么跑
runtime:
  ...

# ③ 条件：制造什么局面（字段由 kind 决定）
setup:
  ...

# ④ 期望：该发生什么
steps:
  - ...
```

### 2.1 元信息段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | int | 是 | 规范版本，当前 `1` |
| `id` | string | 是 | `TK-\d{4}`，与文件名一致 |
| `title` | string | 是 | 一句话说明测什么，不超过 60 字 |
| `kind` | enum | 是 | 见 §3，决定 `setup` 的字段集 |
| `severity` | enum | 否 | `low` \| `medium` \| `high`，默认 `medium` |
| `status` | enum | 否 | `active`（默认）\| `draft` \| `retired` \| `blocked` |
| `tags` | string[] | 否 | 自由标签，便于筛选。见下面的**约定标签** |
| `source` | object | 是 | 溯源，见下 |

**约定标签**：

| 标签 | 含义 | 影响 |
|---|---|---|
| `fixture` | 这条测的是**外部被测对象**（`$FIXTURES/…` 下下载来的包） | **`gate` 默认不导出**——被测对象自身的 bug 不该让本插件的质量门变红。用 `--include-fixture` 纳入 |
| `smoke` | 轻量冒烟，用来确认通路可用 | 无 |
| `regression` | 由某个真实 issue 提炼而来 | 无 |
| `known-broken` | 已确认**当前会失败**（被测对象的缺陷） | 与 `fixture` 搭配，明确"红是预期的" |

> **为什么要 `fixture` 这个分层**：加了 `TK-0026` 之后（它如实抓到了
> `dsh-memory` 0.8.1 里一个真实的 import 笔误），如果它进 gate，
> **被测对象的缺陷就会把插件的质量门染红**。两者必须分开：
> 插件的 gate 只回答"插件本身健康吗"，外部对象的健康由单独的巡检回答。

`source` 字段：

```yaml
source:
  issue: https://github.com/<owner>/<repo>/issues/123   # 原始 issue（无 URL 时写文本标识）
  reported: 2026-10-09                                   # 症状首次被报告的日期
  summary: 工具结果超过 32k 时未按预期裁剪                 # 原始症状的一句话还原
```

### 2.2 运行参数段

全部可选，省略即用全局默认。

```yaml
runtime:
  timeoutMs: 30000            # 本 case 超时；超时记为 fail
  requires: [tools, fs]       # 依赖的宿主能力；缺失时 SKIP（不是 FAIL）
  session: fresh              # fresh=新会话隔离（默认） | reuse=复用当前会话
  repeat: 1                   # 重复次数，用于验证稳定性/竞态
  isolate: true               # 默认 true：本 case 的干预不泄漏到其他 case
```

**`requires` 是降级开关**：在最小宿主（比如只有 `tools`）里跑全量场景时，
缺能力的 case 应该 **skip 并说明原因**，而不是红一片。

可用能力名（与 host 半服务对应）：

```
tools  commands  systemPrompt  approval  userQuestions  session  fs
subprocess  web  webServer  agentLoop  storage  timer  client
```

### 2.3 条件段：`setup`

`setup` 的字段集由 `kind` 决定（见 §3）。所有 kind 共享一个通用子结构：

```yaml
setup:
  # 干预项的公共形态
  <intervention>:
    <kind 专属字段>
```

若一个 case 需要**多种干预**（例如"工具 + 模型"组合），用 `also` 追加：

```yaml
kind: tool
setup:
  tool: { ... }        # 主干预
  also:                # 附加干预，按类型逐条列出
    - kind: llm
      llm: { ... }
```

### 2.4 期望段：`steps`

```yaml
steps:
  - name: 说明这一步在验证什么          # 可选，建议写
    act: <动作>                        # 可选；省略则只做断言
    expect:
      - ref: <取值路径>
        <断言词>: <期望值>
```

`act` 可用动作（由 driver 支持，见 §3）：

```yaml
act: { tool: bash, args: { command: 'echo hi' } }    # 发起一次工具调用
act: { prompt: '请读取 README' }                      # 发起一轮用户消息
act: { wait: { ms: 500 } }                           # 等待
act: { emit: { event: 'tools/change' } }             # 主动触发事件
```

### 2.4.1 每一步都留下自己的取证（步骤级 notes）

`fx.*` 是**该场景累计**的取证，case 层的 `notes` 只保留**最终值**。
多步场景里同名 key（例如每步都写 `fx.stdout`）会互相覆盖——早期步骤的现场就没了。

所以每一步额外记录一份**增量**（`steps[i].notes`）：只包含该步**新出现或值变化**的 key。

```jsonc
"steps": [
  { "name": "…", "notes": { "fileRelative": "package.json", "fileText": "…" } },  // 该步产生的
  { "name": "…", "notes": { "globCount": 20 } },                                  // 只有 glob*
  { "name": "…", "notes": { "filePath": "…", "fileExists": false } }              // 值变了的
]
```

两个要点：

- **用增量而不是整份快照**——否则 `run.json` 会随步骤数线性膨胀。
- **HTTP `/run` 有意只回精简 case**（不含 `steps`）。要步骤级细节请读 `run.json`，
  或用 `runScenarios` 的返回值。见 [`tests/step-notes.test.mjs`](../tests/step-notes.test.mjs)。

### 2.5 断言语法

`ref` 是一个**取值路径**，以数据源开头：

| 前缀 | 含义 |
|---|---|
| `fx.<...>` | driver 通过 `Fixture.note()` 暴露的运行期数据 |
| `case.<...>` | case 自身的字段（用于自检，少用） |
| `env.<...>` | 运行环境信息（dshVersion、platform、node） |

> **`fx.*` 的语义是「容器存在、键可能没有」**：没记过的键取到 `undefined`，
> 而**不是**「取值失败」。所以 `exists: false`（断言"这件事没有发生"）是合法且常用的写法。
> 只有**未知前缀**（不属于 `fx` / `case` / `env`）才算取值失败。
>
> 这条语义曾经写错过（缺失键被判为取值失败），导致 `exists: false` 永远无法表达——
> 是 `cases/TK-0001.yaml` 把它暴露出来的。

断言词（互斥，一行一个）：

| 断言词 | 语义 | 值类型 |
|---|---|---|
| `is` | 严格相等（`===`，对象走深比较） | any |
| `isNot` | 不等于 | any |
| `exists` | 非 `undefined` / `null` | bool |
| `contains` | 字符串包含 / 数组含元素 | string \| array |
| `matches` | 正则匹配（`/pattern/flags` 形式） | string |
| `atLeast` | `>=` | number |
| `atMost` | `<=` | number |
| `length` | 长度等于 | number |
| `lengthAtLeast` / `lengthAtMost` | 长度区间 | number |
| `throws` | 求值过程应抛错 | bool |

**否定**：任何断言词前加 `not`（`notIs`、`notContains`、`notExists`）表示取反。

**软断言**：加 `soft: true` 表示失败不中断本 case 的后续步骤，只记录。

---

## 3. 各 kind 的字段

> 只列**已定义**的 kind。新增 kind 时同步扩写本节，并在 `src/kinds/index.ts` 注册。

### 3.1 `kind: llm` —— 接管模型流（**已实现**）

```yaml
kind: llm
setup:
  llm:
    respond:
      chunks: ['你好，', '这是分块输出']   # 依次作为 text-delta 产出
      finishReason: stop                  # stop | tool-calls | max-tokens（缺省 stop）
      usage: { input: 100, output: 20 }   # 换算成 DSH 的 inputTokens/outputTokens/totalTokens
      delayMs: 0                          # 每块之间的延迟
    failMode: none                        # none | error | mid-stream-error | timeout | malformed
    failAfterChunks: 1                    # mid-stream-error 在几块内容之后失败
```

触发方式（case 里显式写 `act`）：

```yaml
steps:
  - act: { llm: { prompt: 说点什么 } }
    expect:
      - { ref: fx.mockText, is: 你好，这是分块输出 }
```

**零上游请求**：driver 注册的 listener **故意不调用 `next()`**，
所以真实适配器永远不会被触达，`provider` / `model` 只是占位符。

它接管的正是 `dsh-llm` 的这处触发点：

```js
// @deepseek-ai/dsh-llm/lib/index.js
streamWithRegistration(options, prepared) {
  return this.ctx.waterfall(this, "llm/stream", options, () => this.adapterStream(options, prepared));
}
```

> ⚠️ **两个易错点**
> 1. `next()` **直接返回 `AsyncIterable`**（不是 `Promise`）。这与 `tools/pre-execute`
>    那类 `next: () => Promise<...>` 的 waterfall 不同——照抄会拿到 `undefined` 并**静默产出空流**。
> 2. 不调 `next()` = 完全旁路；想**包装**真实流就调 `next()` 再 yield 它的内容。
>    真实范例见 `@deepseek-ai/dsh-llm/lib/invariant.js`：
>    `ctx.on("llm/stream", (_options, next) => validateStream(next(), fail))`。

**取证**：

| ref | 含义 |
|---|---|
| `fx.llmCallCount` | `llm/stream` 被触达的次数 |
| `fx.llmCalls` | 每次触达的记录数组 |
| `fx.plannedChunks` | 计划产出的 chunk 类型序列 |
| `fx.mockText` | **下游实际消费到的**文本（不是"打算产出的"） |
| `fx.chunkTypes` / `fx.chunkCount` | 实际收到的 chunk 类型与数量 |
| `fx.finishReason` | finish chunk 的 kind |
| `fx.streamError` | 消费过程中的异常；正常为 `undefined` |

> `fx.mockText` 从**实际消费的流**里累积，所以它同时证明了「拦截生效」
> 与「chunk 结构被下游正确识别」——比断言"我打算产出什么"强得多。

**`failMode` 的四种取值**：

| 取值 | 行为 |
|---|---|
| `error` | 直接产出 error finish（不含任何内容） |
| `mid-stream-error` | 先产出 `failAfterChunks` 块内容，再以 error finish 收尾（**已产出内容保留**） |
| `timeout` | 只产出开头后挂住，模拟上游不响应（由 runner 超时或取消收尾） |
| `malformed` | 产出结构畸形的 chunk（缺字段），用于测下游健壮性 |

> **尚未支持**：`match.turn`（只命中第 N 轮请求）与 `failOnAttempt`（只让第 N 次尝试失败）。
> 它们需要先确认 turn / attempt 计数在 `llm/stream` 这一层是否可见。**写了不会报错、但也不会生效**——
> 这是当前规范的一个已知缺口，列入 Phase 2。

### 3.2 `kind: tool` —— 工具注册与调用（**已实现**）

```yaml
kind: tool
setup:
  tool:
    register:
      name: testkit_probe              # 必填
      description: 测试用探针
      parameters:                      # 标准 JSON Schema；缺省为空对象
        type: object
        properties: { text: { type: string } }
        required: [text]

      # ── 行为四选一，判定顺序即下列顺序 ──
      throws: '错误信息'                # ① 让工具抛错（优先级最高）
      delayMs: 500                     # ② 延迟返回（可与 returns 组合）
      generate:                        # ③ 生成大值（与 returns 互斥）
        kind: repeat-string            #    目前只支持这一种
        char: A                        #    缺省 'A'
        times: 200000                  #    必须 ≥ 0
      returns: { echoed: true }        # ④ 直接返回该值
                                       #    四者皆无 ⇒ 返回 null

    intercept:
      name: testkit_guarded
      decision: deny                   # 已实现：deny（走 tools.guard）
                                       # allow 是默认行为，显式声明仅表意图
                                       # ask / cancel 需 pre-execute waterfall → Phase 2
      reason: TESTKIT_GUARD_DENIED     # deny 时回给调用方的理由
```

**为什么用平级键而不是 `returns: { throw: ... }`**：返回值本身可能恰好长得像指令对象
（`{ throw: 1 }` 是一个合法返回值）。平级键让"指令"与"数据"在同一层级就分开，没有歧义。

**driver 写出的取证**（断言里用 `fx.` 引用）：

| ref | 含义 |
|---|---|
| `fx.calls` | 调用记录数组：`{ index, name, args }` |
| `fx.callCount` | 累计调用次数 |
| `fx.lastResult` | `{ name, isError, durationMs }` |
| `fx.resultText` | 结果内容块的纯文本 |
| `fx.resultLength` | 上述文本的字符数 |
| `fx.resultValue` | 工具的返回值本身 |
| `fx.resultValueLength` | 返回值为字符串时的**精确**长度（否则 `undefined`） |
| `fx.callError` | 失败时的错误信息；**成功时为 `undefined`**（便于 `exists: false`） |

> **判定"工具是否真的被执行过"要两条断言一起用**：
> `fx.callError contains <拒绝理由>` **加上** `fx.resultText notContains <工具本体返回值>`。
> 只看前者，会被"报了错但其实也跑过"蒙混过去。`cases/TK-0003.yaml` 就是这条纪律的示范。

### 3.2.1 尚未支持的 intercept 形态

| 形态 | 为什么没做 | 计划 |
|---|---|---|
| `decision: ask` | 需要 `tools/pre-execute` waterfall 的 `next()` 链语义，必须先拿活宿主确认 | Phase 2 |
| `decision: cancel` | 同上 | Phase 2 |
| `rewriteResult` | 需要 `tools/post-execute` waterfall | Phase 2 |

这些情况下 driver 会抛 `SkipCase`（场景记为 **skipped 而非 failed**），
并在 `skipReason` 里说明原因——不会假装执行过。

### 3.3 `kind: prompt` —— 提示词注入（**已实现**）

```yaml
kind: prompt
setup:
  prompt:
    section:
      name: testkit-marker          # 必填
      order: 1200                   # 必填，必须有限
      text: TESTKIT_MARKER_ALPHA    # 必填（是 text，不是 content）
      interpolate: false            # 可选
      complete: false               # 可选
    context:
      name: testkit-ctx
      order: 900
      text: CTX_TEXT
    variable:
      name: testkit_var             # 必须匹配 [a-z][a-z0-9_]*（**只能小写**）
      value: VAR_VALUE
```

**这个 kind 不需要跑模型就能验证。** `systemPrompt.assemble()` 是公开可调的方法，
driver 在注册后主动组装一次并把结果记进 Fixture，所以断言直接查组装结果：

| ref | 含义 |
|---|---|
| `fx.assembled` | 完整 `PromptAssembly`（sections / contexts / tools / variables） |
| `fx.sectionNames` | 已组装 section 的名字数组 |
| `fx.sectionText` | 所有 section 文本的拼接（便于 `contains`） |
| `fx.contextNames` / `fx.contextText` | 同上，针对 context |
| `fx.variableValue` | 所声明 variable 解析出的值 |
| `fx.assembleError` | 组装失败时的错误描述；**成功时为 `undefined`** |

```yaml
steps:
  - name: 组装不应失败
    expect:
      - ref: fx.assembleError
        exists: false
  - name: 注入生效
    expect:
      - ref: fx.sectionText
        contains: TESTKIT_MARKER_ALPHA
      - ref: fx.variableValue
        is: VAR_VALUE
```

> **易踩点**：`variable.name` 只能小写。写 `testkitVar` 会被 DSH 拒绝。
> driver 在注册前先自查并给出带规则原文的错误，省得你对着宿主异常猜。
>
> **prompt 类场景不应有 `act`**——注册即条件，组装即取证。
> 写了 `act` 会被 driver 明确报错，而不是被静默忽略。
>
> 组装失败**不会**让场景崩：driver 把它记进 `fx.assembleError`，
> 由 case 自己用 `exists: false` 表达期望。这样"别人的 section 写坏了"
> 也能被这条场景如实报出来。

### 3.4 `kind: interaction` —— 模拟人的回答与审批（**已实现**）

```yaml
kind: interaction
setup:
  interaction:
    question:
      # 给答案的三种方式，优先级从高到低
      answers: [{ id: q1, selected: [选项 A] }]   # ① 完全显式
      select: [选项 A, 选项 B]                    # ② 每个问题都用这个数组
      answer: 选项 A                              # ③ 简写：单选
      custom: 我自己写的回答                       #    进 custom 字段
      timeout: false                              # true = 故意不答
    approval:
      decision: rejected        # allowed-once | rejected | cancelled | unavailable（缺省 rejected）
      reason: 测试拒绝           # 仅记账
```

触发方式（act 是**替宿主发起这次请求**）：

```yaml
steps:
  - act:
      interaction:
        question:
          question: 请选择一项
          header: 测试提问
          options: [{ label: 选项 A }, { label: 选项 B }]
    expect:
      - { ref: fx.answer.answers[0].selected, contains: 选项 A }

  - act:
      interaction:
        approval: { toolName: bash, reason: 测试审批 }
    expect:
      - { ref: fx.approvalOutcome, is: rejected }
```

**为什么 act 不直接调服务方法**：`approval.request()` 要求**有开启的 turn**
（审计对必须被会话日志的 commit/replay 边界包住），否则在追加任何东西之前就拒绝。
自检场景没有 turn，直接调必然抛错。所以 act 用 `host.waterfall(...)` 替宿主触发——
绕过 turn 前置条件，但仍然经过完整的 listener 链。

> ⚠️ **这两个 waterfall 的 `next` 是 `() => Promise<...>`**，
> 而 `llm/stream` 的 `next` 是**同步**返回 `AsyncIterable`。
> 本插件里两种形状都存在——照抄隔壁 driver 会得到静默失效。

> ⚠️ **兜底值是宽松的，所以断言必须写紧。** 没有答者时，
> `approval/request` 会 fail closed 成 `'unavailable'`，提问则走 `next` 抛错。
> 因此应断言 `is: rejected` 而不是 `exists: true`——否则 driver 根本没接上也会通过。

**取证**：

| ref | 含义 |
|---|---|
| `fx.questionCount` / `fx.questions` | 提问被应答的次数与请求记录 |
| `fx.answer` | 我们返回的 `AskUserQuestionAnswer` |
| `fx.questionError` | 提问失败时的错误描述（如 `TESTKIT_QUESTION_TIMEOUT`） |
| `fx.approvalCount` / `fx.approvals` | 审批被应答的次数与请求记录 |
| `fx.approvalOutcome` | 最终的 `ApprovalOutcome` |
| `fx.approvalError` | 审批失败时的错误描述 |
| `fx.plannedDecision` | 声明的决策（用来验证它没被兜底值顶掉） |

> **作用域注意**：这两个事件在 DSH 里是 `Scoped<Agent>` 事件，
> 而本 driver 用全局注册。agent 作用域下的事件是否会被全局 listener 收到，
> 需要在活宿主上确认——已列入待验证项，**不要在活宿主验证前把它当既定事实**。

### 3.5 `kind: session` —— 人类命令（**部分实现**）

```yaml
kind: session
setup:
  session:
    command:
      name: testkit-echo          # 必填
      description: 回显命令
      inputHint: '<要回显的文本>'  # 对应 DSH 的 input.hint
      returns: 命令输出            # 成功时的文本；缺省回显输入
      error: false                # true = 返回 { kind: 'error' } 结果
      throws: ''                  # 抛异常（与 error 是**两条不同路径**）
      delayMs: 0
```

驱动方式：

```yaml
steps:
  - act: { session: { command: { name: testkit-echo, input: hello } } }
    expect:
      - { ref: fx.commandKind, is: success }
      - { ref: fx.commandText, is: 命令输出 }
```

**失败有两条路径，别混为一谈**：

| 声明 | 路径 | DSH 侧表现 |
|---|---|---|
| `error: true` | handler **返回** `{ kind: 'error', text }` | 正常的失败表达 |
| `throws: '...'` | handler **抛异常** | DSH 把它 settle 成 `kind: 'error'`，但过程不同 |

断言重点也不同：前者 `fx.commandKind is error` 且 `fx.commandError exists: false`；
后者 `fx.commandError` 有值、而 `fx.commandKind` 为 undefined。

> **本 driver 的边界**：它测的是**命令自身的行为**（handler 怎么答），
> **不测** DSH 的分发逻辑（解析斜杠、找命令、归属 agent、`command/run` 审计事件）。
> 后者需要真实 agent，属活宿主验证范围。所以 `act` 直接调用 driver 保存的
> `definition.execute(...)`，而不是 `ctx.commands.execute(agent, line, ...)`
> ——后者会引入一个与断言无关的前置条件（假 agent 能不能过校验）。

**取证**：

| ref | 含义 |
|---|---|
| `fx.registeredCommands` | 本场景注册的命令名数组 |
| `fx.commandCount` / `fx.commandInvocations` | 驱动次数与入参记录 |
| `fx.commandResult` | handler 的原始返回 |
| `fx.commandKind` | 结果形态：`success` / `error`（异常路径为 undefined） |
| `fx.commandText` | 结果文本 |
| `fx.commandError` | 异常路径的错误描述 |

> **尚未实现**：`session/event` 事件观测、`session/flush`、`ctx.goals` 相关。
> 它们在 DSH 里是 `Scoped<Session>` 事件或需要活跃会话，与 `interaction` 的 R9
> 同属「作用域 / 生命周期」类问题——**留到活宿主验证之后再动**，免得再做一次白工。

### 3.6 `kind: resource` —— 外部资源（**部分实现：web 面**）

```yaml
kind: resource
setup:
  resource:
    webSearch:
      providerId: testkit-fake-search    # 缺省与常量同名
      available: true                    # false = 测"已配置但不可用"
      results:
        - { title: 结果一, url: 'https://example.invalid/1', snippet: 第一条 }
      content: 汇总文本
      throws: ''                         # 让 provider 抛错
    webFetch:
      providerId: testkit-fake-fetch
      available: true
      statusCode: 200
      kind: html                         # html | text
      body: '<html>假页面</html>'
      throws: ''
```

驱动方式：

```yaml
steps:
  - act: { resource: { search: { query: 测试查询, maxResults: 2 } } }
    expect:
      - { ref: fx.searchSourceCount, is: 2 }
      - { ref: fx.searchTruncated, is: true }

  - act: { resource: { fetch: { url: 'https://example.invalid/p' } } }
    expect:
      - { ref: fx.fetchStatusCode, is: 200 }
```

**为什么必须"接管 providerId"而不只是注册 provider**

`web.search()` 的 provider 是**按配置 id 在调用时解析**的：

| 情形 | 结果 |
|---|---|
| 配置的 id 已注册且 `available()` | 用它 |
| 配置的 id 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
| 配置的 id 已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配 id，恰好一个可用 | 用它 |
| 未配 id，多个可用 | **`WEB_PROVIDER_AMBIGUOUS`** |
| 未配 id，没有可用 | `WEB_PROVIDER_UNAVAILABLE` |

也就是说：**注册 ≠ 会被选中**。真实 profile 里通常已经配了 `bing` 或
`deepseek-official`，光注册一个假 provider 是拿不到它的。

所以 driver 显式写 `ctx.web.searchProviderId`（该属性**可写**，
`dsh-free-search` 就是这么运行时接管的），并在 Fixture 释放时**恢复原值**。

**取证**：

| ref | 含义 |
|---|---|
| `fx.searchResult` / `fx.searchError` | 搜索的原始返回 / 错误描述（含 `WebError` 的 code） |
| `fx.searchSourceCount` / `fx.searchSources` / `fx.searchTruncated` | 条数、条目、是否被截断 |
| `fx.fetchResult` / `fx.fetchError` | 抓取的原始返回 / 错误描述 |
| `fx.fetchStatusCode` / `fx.fetchBody` | 状态码与响应体文本 |
| `fx.searchProviderId` / `fx.fetchProviderId` | 我们接管的 id |
| `fx.previousSearchProviderId` / `fx.previousFetchProviderId` | 接管前的原值（证明可回滚） |

> **尚未实现**：`ctx.fs`（沙箱拒绝、并发写）与 `ctx.subprocess`（非零退出码）。
> 它们需要真实文件系统 / 进程，且沙箱策略依赖宿主配置——
> 属"需要活宿主才能定语义"的一类，与 R9 同理，**留到安装验证之后再做**。

### 3.7 `kind: agent` —— 端到端

```yaml
kind: agent
setup:
  agent:
    prompt: '请把 README 第一行原样回给我'
    model: deepseek-flash           # 省略用当前默认
    maxSteps: 8
```

断言 `fx.notes.finalText` / `fx.notes.toolCalls` / `fx.notes.steps`。

### 3.8 `kind: ui` —— 前端

```yaml
kind: ui
setup:
  ui:
    slot: conversation.view
    probe: register-succeeds        # 探测项；具体探测点见文档
```

> `ui` kind 的断言能力受限于"能否在宿主侧观测到浏览器状态"，
> 第一版只做**注册类探测**（slot 是否成功注册、是否抛错），不做像素级验证。

---

## 3.7 `kind: agent` —— 端到端：驱动真实子 agent（**已实现**）

> ⚠️ **这个 kind 与其它六个有本质区别：它会真的调模型、花 token、耗时。**
> 其它 driver 都是「造条件」，这一个不是。

```yaml
kind: agent
setup:
  agent:
    provider: spawn                 # 缺省取宿主注册的第一个
    label: testkit-smoke            # 子 agent 标签（进 catalog）
    model: deepseek-flash           # 可选：单独覆盖子 agent 的模型
    toolFilter: { deny: [bash] }    # 可选：限制子 agent 的工具
    persona: '你是测试助手'          # 可选
```

```yaml
steps:
  - act: { agent: { prompt: '请只回复 TESTKIT_OK' } }
    expect:
      - { ref: fx.agentError, exists: false }
      - { ref: fx.agentStopReason, is: completed }
```

**取证**：

| ref | 含义 |
|---|---|
| `fx.availableSubagentProviders` | 宿主注册的 provider 名单（跳过时用它解释原因） |
| `fx.agentProvider` | 实际使用的 provider |
| `fx.agentRunId` | 子 agent 的 session id |
| `fx.agentStopReason` | `completed` / `aborted` / `error` / `max-tokens` / `refusal` |
| `fx.agentOutput` | 子 agent 产出的文本 |
| `fx.agentDiagnostic` / `fx.agentStructured` | 诊断信息 / 结构化输出 |
| `fx.agentDurationMs` | 耗时（毫秒） |
| `fx.agentError` | 派生或运行失败时的错误描述 |

> **provider 名不确定时不猜。** 不同 profile 注册的 provider 名可能不同
> （实测 headless profile 是 `spawn` / `fork`）。driver 缺省取第一个；
> 显式指定的名字不存在时**跳过并列出可用名**。

> **使用纪律**：agent 类是**黑盒**用例，适合"端到端结果不对"这类说不清归类的 issue。
> 根因清楚后应**下沉**到精确 kind（`tool` / `llm` / `prompt` …），黑盒那条保留当回归网。

> **在 CI 轨里的行为**：headless 宿主没有 `subagents` 能力，所以这条场景会被**跳过**
> （导出用例里显示为 `t.skip`）。这是刻意的——CI 里不该意外产生模型调用与费用。

---

## 3.8 `kind: ui` —— client 半（浏览器产物）的契约验证（**已实现**）

**这个 driver 解决了一个长期盲区**：client 半的代码跑在浏览器里，而内置 runner
与 CI 轨都在 Node 里，于是它一直是测试盲区。本 driver 用**隔离 vm** 把真实产物
加载起来并驱动它——验证的是**真实 bundle 的真实行为**，不是另写一份替身。

```yaml
kind: ui
setup:
  ui:
    bundle: lib/client.js              # 缺省即本包产物
    expectSlots: [conversation.view]   # 声明了却没注册 → 立即失败（附实际注册项）
    expectLocaleNamespaces: [dsh-testkit]
```

```yaml
steps:
  - act: { ui: { load: true } }        # load: false 只验产物存在，不执行 apply
    expect:
      - { ref: fx.uiBundleExists, is: true }
      - { ref: fx.uiError, exists: false }
      - { ref: fx.uiRegisteredSlotNames, contains: conversation.view }
```

**取证**：

| ref | 含义 |
|---|---|
| `fx.uiBundlePath` / `fx.uiBundleExists` / `fx.uiBundleBytes` | 产物位置与大小 |
| `fx.uiLoadCalls` | `__ModuleLoader__.load` 被调了几次（应为 1） |
| `fx.uiModuleId` / `fx.uiName` | bundle 声明的 id 与 `name` 导出 |
| `fx.uiInject` | 依赖声明（数组） |
| `fx.uiHasApply` | 是否导出 `apply` |
| `fx.uiInjectedSlots` | `slots.inject(...)` 的调用记录 |
| `fx.uiRegisteredSlotNames` / `fx.uiRegisteredSlots` | `slots.register(...)` 的记录（含 id / order） |
| `fx.uiLocaleNamespaces` | `locale.register(...)` 的命名空间 |
| `fx.uiRendererProvided` | 注册 slot 时是否给了渲染函数 |
| `fx.uiEffectLabels` | 走过的 effect 标签（确认注册确实发生） |
| `fx.uiError` | 加载或 apply 抛错时的描述 |

> **它是什么**：产物契约 + 注册行为的**回归网**。
> 实测踩过的两类坑都靠它兜住——`lib/client.js` 被构建脚本删掉、
> bundle 导出面或注册名变化。
>
> **它不是什么**：不验证**渲染结果**（React 组件长什么样、像素对不对）。那是浏览器的事。

> **`requires` 为空**——纯离线，所以**在任何宿主（含 CI 轨）里都能跑**。
> 这在八个 kind 里是唯一的：其它都多少依赖宿主能力。

---

## 3.9 组合场景：`setup` 里可以写多个 kind

`scenario.kind` 是**主 kind**（用于分类与选择器），而 `setup` 下**每个出现过的 kind 键**
都会在 setup 阶段被对应 driver 处理；`act` 则按**动作的形状**分派给对应 driver。

```yaml
kind: agent                 # 主 kind
setup:
  resource:                 # ← 这个 driver 的 setup 也会跑
    webSearch:
      results: [{ url: https://testkit.invalid/first, title: 假结果 }]
  agent:                    # ← 主 kind 的配置
    label: combo-probe
steps:
  - act: { agent: { prompt: '请调用 web_search 搜索 testkit' } }
    expect:
      - { ref: fx.agentStopReason, is: completed }
      - { ref: fx.providerSearchCalls, atLeast: 1 }   # 假 provider 被子 agent 调用了
```

**这解锁了什么**：把**宿主级测试替身**与**真实 agent 行为**组合起来，
从而断言一些只测单 kind 时看不到的性质——例如上例证明了
**root 上注册的假 provider 会穿透到子 agent 的会话**。

**能力判定**：所有参与 driver 的 `requires` 取并集（∪ `runtime.requires`）。

**setup 顺序**固定为 `SCENARIO_KINDS` 的顺序（不依赖对象键顺序），teardown 逆序。

> **schema 规则**：`setup` 下的键必须是合法 kind（挡住 `setup.tolls` 这类拼写错误）；
> 但**不要求**出现主 kind 的键——有些 driver 不需要 setup 配置（例如 `ui`）。

> ### 一条被实测否决的设想（值得记住的 DSH 约束）
>
> 组合场景最初的动机是端到端验证 R9：注册假答者（`interaction`）＋ 派子 agent 问用户（`agent`）。
>
> **实测否决**：子 agent 调 `ask_user_question` 时，工具直接返回
> `human interaction is unavailable while the calling agent is owned by another live agent`，
> 压根走不到 `user-questions/request` 的 waterfall。
>
> 即 **DSH 不允许被委派的子 agent 进行人工交互**。所以 R9 的"agent 作用域触发"路径
> 只能靠源码推导回答（root listener 没有 scope tag，不被 `scopeTarget` 过滤），
> **无法用场景端到端验证**——这不是我们的测试缺失，而是被验证对象本身不提供那条路径。

---

## 3.10 `kind: shell` —— 跑外部命令并取证（**已实现**）

**这个 kind 是被真实 issue 数据驱动出来的。** `dsh-memory` / `lingshu` 的 issue 里，
绝大多数「可回归候选」的判据都是同一个形态：**跑一条命令，看输出或退出码**。

```yaml
kind: shell
runtime:
  requires: [subprocess]
setup:
  shell:
    cwd: $PKG                 # 令牌，见下
    env: { LANG: C }
    maxBytes: 262144          # 输出采集上限
    graceMs: 5000
steps:
  - act: { shell: { argv: [$NODE, scripts/some-check.mjs] } }
    expect:
      - { ref: fx.spawnError, exists: false }
      - { ref: fx.exitCode, is: 0 }
      - { ref: fx.stdout, contains: OK }
```

**令牌**（只替换「整段等于令牌」的实参，不做子串替换）：

| 令牌 | 替换成 | 为什么需要 |
|---|---|---|
| `$NODE` | `process.execPath` | 本机 `node` 不在 PATH 上；而 DSH 自己就是 node 进程 |
| `$PYTHON` | 探测到的 Python 解释器 | DSH 桌面端**自带 Python**，但它不在 PATH、也没有约定启动器（`runtime/bin` 只有 node，`versions.json` 只记 node/pnpm）。见下 |
| `$PKG` | 本插件包根 | 场景不该硬编码绝对路径，但"跑包内脚本"需要知道包在哪 |
| `$PKG/<子路径>` | 包根下的子路径 | 同上 |
| `$FIXTURES` | 外部 fixture 根（`<包根>/.fixtures`） | 被测对象（下载来的包）放在这里，不进仓库 |
| `$FIXTURES/<名字>` | fixture 下的子路径 | 同上 |

**`$PYTHON` 的回退顺序**（找不到就**跳过并说明**，不假装通过）：

1. `DSH_TESTKIT_PYTHON` / `DSH_PYTHON` 环境变量（逃生口）
2. `<DSH 安装目录>/resources/runtime/*/dependencies/python/python.exe`
   —— 遍历 `runtime` 下的一层，不写死 `primary-runtime`
3. PATH 上的 `python3`

> 第 2 档靠 `process.execPath` 推安装目录。**只有在 DSH 进程里才会命中**——
> 在普通 `node` 进程里 `execPath` 是 node 自己，会落到第 3 档。这是可观测的，
> `fx.shellResolvedArgv0` 会如实显示最终用了哪个。

**取证**：

| ref | 含义 |
|---|---|
| `fx.exitCode` / `fx.signal` | 退出码与信号 |
| `fx.stdout` / `fx.stderr` | 采集到的输出 |
| `fx.stdoutLength` / `fx.stderrLength` | 长度 |
| `fx.stdoutTruncated` / `fx.stderrTruncated` | 是否因超上限被截断（`lossy`） |
| `fx.spawnError` | spawn 或可执行文件解析失败的原因 |
| `fx.runError` | `done` reject 的原因（provider 故障等） |
| `fx.durationMs` | 耗时 |
| `fx.shellArgv` / `fx.shellResolvedArgv0` / `fx.shellCwd` | 实际执行的形态 |

**两个刻意的设计**：

1. **非零退出码不是失败。** 命令"跑完了"本身就是结果，判由断言决定——
   很多被测行为恰恰是"应该报错"（例如"装机缺件 → ModuleNotFoundError"）。
2. **`argv` 是数组**，与 DSH `subprocess.spawn` 一致，不经 shell 解析。
   所以没有引号/管道/重定向，也就没有注入面；要 shell 特性就显式调 `sh -c`。

> **能力边界**：需要 `subprocess` 能力。`headless` 宿主**不提供**它（跑不了进程），
> 所以 shell 场景在 CI 轨里会**明确跳过**——这是如实反映，不是缺陷。

> **提炼模式**（来自 `dsh-memory` #48「files 白名单漏件导致装机即挂」）：
> 任何"装机后缺件 / 找不到模块"的 issue，都可以落成：
> ① 写一个把判据固定下来的脚本；② 用 `kind: shell` 跑它并断言退出码。
> 好处是判据**可复跑、可进回归集**，而不是"人工装一遍看看"。
> 见 [`cases/TK-0019.yaml`](../cases/TK-0019.yaml) 与 [`scripts/check-pack-files.mjs`](../scripts/check-pack-files.mjs)。

---

## 3.11 `kind: file` —— 读文件 / 列目录 / 搜内容并取证（**已实现**）

**这个 kind 也是被数据驱动出来的**：对 238 条可回归候选做形态分类后，
**97 条**（41%）属于 `file-inspect`——判据是"某个文件里有没有某段内容"、
"清单里有没有这一项"、"frontmatter 里有没有这个字段"。

`setup.file.root` 支持 `$PKG` 与 `$FIXTURES`（含 `<令牌>/<子路径>` 形式）。
**显式给了 `root` 却不存在时会 SkipCase 并说明**——依赖未准备的 fixture 时
应当明确跳过，而不是在莫名其妙的路径上失败。

三种动作：

```yaml
kind: file
setup:
  file:
    root: $FIXTURES/dsh-memory-0.8.1   # 基准目录；缺省 process.cwd()
    maxChars: 524288                    # 单文件读取上限
    maxGlob: 500                        # 返回条数上限
steps:
  - act: { file: { read: package.json } }          # 读一个文件
    expect:
      - { ref: fx.fileExists, is: true }
      - { ref: fx.fileText, contains: dsh-testkit }

  - act: { file: { glob: "cases/TK-*.yaml" } }     # 列文件
    expect:
      - { ref: fx.globCount, atLeast: 15 }

  - act: { file: { search: { pattern: "compact_access", glob: "**/*.py" } } }   # 搜内容（对应 grep）
    expect:
      - { ref: fx.searchCount, atLeast: 2 }
      - { ref: fx.searchText, contains: "def compact_access" }
```

**`search` 的字段**：`pattern`（正则，必填）、`glob`（限定范围）、`flags`（如 `i`）、`maxResults`。

**取证**：

| ref | 含义 |
|---|---|
| `fx.filePath` / `fx.fileRelative` | 解析后的绝对 / 相对路径 |
| `fx.fileExists` | 是否存在（**不存在是取证、不是抛错**） |
| `fx.fileBytes` | 字节数 |
| `fx.fileText` | 文本内容（超 `maxChars` 时截断） |
| `fx.fileLines` / `fx.fileLineCount` | 按 `\n` 切分的行 |
| `fx.fileHasCRLF` | 是否含 CRLF（跨平台真实故障源） |
| `fx.fileTruncated` | 是否被上限截断 |
| `fx.globPattern` / `fx.globMatches` / `fx.globCount` / `fx.globScanned` | 列目录的取证 |
| `fx.globTotal` / `fx.globTruncated` | 截断**前**的匹配总数 / 是否被截断（用于区分"没匹配"与"匹配很多被截断"） |
| `fx.searchPattern` / `fx.searchGlob` | 搜了什么 |
| `fx.searchMatches` | `[{ file, line, text }]` |
| `fx.searchCount` / `fx.searchFileCount` / `fx.searchFiles` | 命中数 / 涉及文件数 / 文件列表 |
| `fx.searchText` | 所有命中行拼成的一行行文本——**便于用 `contains` 写断言**（对对象数组写断言很别扭） |
| `fx.fileError` | 读失败或目标是目录时的说明 |

> **纯离线**：用 `node:fs` 直接读，`requires` 为空——任何宿主（含 CI 轨）都能跑。
> 这是继 `ui` 之后第二个纯离线的 kind。
>
> **为什么单独立一个 kind 而不是用 `shell` + `grep`**：不依赖外部命令是否可用
> （Windows 上未必有 `grep`），而且断言直接针对内容，不用再解析文本输出。

> **glob 是自带的小实现**，支持 `**`（跨层）与 `*`（单层内）/`?`；
> 刻意不引第三方 glob——判据要能在任何环境复现，行为完全确定、可单测。

> ⚠️ **一个实现坑（已修，写下来因为很容易再犯）**：`walkFiles` 的**扫描上限**
> 必须**远大于**返回上限。早先两者混用同一个 `cap`，于是深度优先扫到 cap 就停了——
> `lib/` 下文件多时 `cases/` 根本没轮到，glob 结果**恒为空**，而且表现还依赖目录遍历顺序。

> **提炼模式**（来自 `dsh-memory` #37「产物无消费方」）：
> "某个符号有没有被引用 / 某个约定有没有被破坏"这类**结构性判据**，
> 用 `search` 固定下来即可。见 [`cases/TK-0023.yaml`](../cases/TK-0023.yaml)。

---

## 4. 完整示例

```yaml
schema: 1
id: TK-0001
title: 工具结果超过上限时被裁剪而非报错
kind: tool
severity: medium
tags: [tool, pruner, boundary]
source:
  issue: https://github.com/example/dsh/issues/123
  reported: 2026-10-09
  summary: 单次工具返回 200KB，会话直接报错而不是裁剪结果

runtime:
  timeoutMs: 20000
  requires: [tools]
  session: fresh

setup:
  tool:
    register:
      name: testkit_bigresult
      description: 返回超大结果
      parameters: { type: object, properties: {}, additionalProperties: false }
      returns: { repeat: { char: 'A', times: 200000 } }

steps:
  - name: 工具本身应当执行成功，不抛错
    act: { tool: testkit_bigresult, args: {} }
    expect:
      - ref: fx.notes.callError
        exists: false

  - name: 返回给模型的内容应被裁剪到上限内
    expect:
      - ref: fx.notes.resultLength
        atMost: 32000
      - ref: fx.notes.resultText
        contains: '已裁剪'
```

---

## 5. 索引文件 `cases/index.yaml`

**只存元数据，不是真相源。** 由脚本生成/校验，避免手工维护漂移。

```yaml
schema: 1
nextId: 42
cases:
  - id: TK-0001
    kind: tool
    status: active
    issue: https://github.com/example/dsh/issues/123
  - id: TK-0002
    kind: llm
    status: draft
    issue: null
```

校验脚本（`scripts/verify-cases.mjs`）检查：

1. 每个 `cases/*.yaml` 都在索引里，且索引里没有孤儿项
2. `id` 与文件名一致、格式合法、无重复
3. `kind` 在已注册列表内
4. `source.issue` 存在（允许 `null` 但要显式写）
5. `nextId` > 所有已用 ID

---

## 6. 版本演进

- `schema: 1` 固定；**新增可选字段不算破坏性变更**，不必升版本
- 删除/改名已有字段 → 升 `schema: 2`，且 loader 需保留对 v1 的读取兼容
- 每个 case 自带 `schema`，loader 按 case 的版本分别解析

---

## 相关文档

- [架构设计](ARCHITECTURE.md) —— kind 分类学的由来
- [issue 提炼流程](ISSUE-PIPELINE.md) —— 从 issue 到这份 YAML 的步骤
- [开发文档](DEVELOPMENT.md) —— 校验命令
