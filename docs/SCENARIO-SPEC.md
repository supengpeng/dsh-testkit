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

### 提案：批准前的形态

`cases/` 里只应有**已批准**的场景。模型提炼出来的正文先作为**提案**落在
`pipeline/proposals/<BATCH-ID>/`，它本身就是**合法 case YAML**，只有两处不同：

| 差异 | 说明 |
|---|---|
| `id` 写成占位 `TK-0000` | 正式 TK 号由 `/testkit issue approve` 分配（ID 只增不改） |
| 文件名带提案号（`P-0001-xxx.yaml`） | 因此「文件名 = `id`」这条规则对提案**豁免**（校验器有显式开关 `allowIdMismatch`） |

提案经 `/testkit issue approve` 落地时改写 `id`、写入 `cases/TK-XXXX.yaml` 并重建索引。
要不要提炼、要不要落地，见 [`ISSUE-PIPELINE.md`](ISSUE-PIPELINE.md) §0「提炼闸门」。

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
| `cost` | enum | 否 | `none` \| `low` \| `high`，**成本档位**；缺省按参与 driver 的默认表取最高档。详见 §2.2.1 |
| `budget` | object | 否 | `{ maxModelCalls, maxTokens }`，`0`/缺省 = 不限；只在 `cost: low \| high` 时有意义。详见 §2.2.2 |
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

### 2.2.1 成本档位：`cost`

`cost` 把「这次运行允不允许花钱」变成**场景数据里的一等公民**——在此之前，
"跑全部 active 场景"会把真实模型调用悄悄塞进 CI 与日常回归，没人能事先声明跑一次最多花多少。

三档：

| 档位 | 含义 | 典型 kind |
|---|---|---|
| `none` | **纯离线**：不调模型、不起外部进程、不写文件 | `llm`（接管流）、`tool`、`prompt`、`ui`、`file` |
| `low` | **本地副作用**：起进程 / 写文件，但**没有模型成本** | `shell`、`fs` |
| `high` | **真实模型调用** | `agent`（派生真实子 agent）、`compaction`（真压缩） |

**缺省规则**：不写 `cost` 时，取**参与这条场景的 driver**默认档位里的**最高档**。
默认表集中在 `src/kinds/index.ts` 的 `DRIVER_COST`（一处集中，便于逐条审阅）：

| 默认档位 | kind |
|---|---|
| `none` | `llm` `tool` `prompt` `interaction` `session` `resource` `ui` `file` |
| `low` | `shell` `fs` |
| `high` | `compaction` `agent` |

组合场景（`setup` 里出现多个 kind，见 §3.9）取**参与者的最高档**：
一条组合场景里只要出现 `agent`，整条就是 `high`。判定结果会如实记下档位的来源
`source`：`scenario`（场景显式声明）/ `driver`（按默认表）。

**逃生舱：显式降档。** driver 的默认档位回答的是"**这一类 kind 通常有多贵**"，
对具体动作未必成立。`compaction` 就是最典型的一条：`compactNow` 确实要一次真实模型摘要，
但「没有安全范围时不压」「非法范围被拒」「缺 agent 上下文时如实不可用」这些**边界**路径
一个 token 都不花。这类场景应显式写 `cost: none` 降档——
`cases/TK-0034.yaml` 正是这么标注的，理由写在该文件头注里。

**闸门如何消费它**（实现见 `src/executor/policy.ts`）：

| 档位 | 默认 | 放行条件 |
|---|---|---|
| `none` | 放行 | 任何配置下都放行 |
| `low` | 放行 | `cost.allowLowCost`（默认 `true`） |
| `high` | **拒绝** | `cost.allowModel`（默认 `false`），必须显式放权 |

**放权入口只有一个：人类命令面** `/testkit run --allow-model` / `--allow-low-cost`。

`testkit_run` 的工具参数 `allowModel` / `allowLowCost` / `maxModelCalls` / `allowFileWrite`
只能**收紧**、不能提权：`false` 一律生效；`true` 只在配置本身已允许时才有效果；
`maxModelCalls` 取 `min(配置, 参数)`。**理由**：闸门若能被模型自己打开，就只是装饰——
「默认拒绝」必须把唯一的开闸权留在人类手里。

被闸门拒绝的场景记为 **skipped（不是 failed）**，并带上判定理由（`skipReason` 与 `policy` 快照）。
「没跑」和「跑了但不对」是两件事，混在一起会让报告失去意义。

### 2.2.2 预算上限：`budget`

场景可以给自己加**上限**：

```yaml
cost: high
budget:
  maxModelCalls: 2     # 模型调用次数上限；0 / 缺省 = 不限
  maxTokens: 20000     # token 上限；0 / 缺省 = 不限
```

超限的行为是直接**判 failed**，错误信息以固定前缀「预算超限：」开头、并写清"上限 N，已用 M"
（它会被原样摘进报告，所以要能独立读懂）。归因落到 `env`：
**预算超限是运行条件不足，不是被测对象的判定结论**——同一条场景放宽预算后可能就绿了，
把它记成"产品有 bug"是错误归因。

`budget` 只能**收紧**、不能放宽：实际生效上限是 `min(策略上限, 场景预算)`（`0` 视为不限）。
否则场景数据自己就能绕开本次运行的预算约束。

> **限界（如实声明，别把它当账单）**：用量记账是**下界**——
> 1 个高成本 `act` 记 1 次调用；driver 不主动上报 token 就记 0。
> 因此 `maxModelCalls` 是**保守闸门**（超了必拦，但别指望它精确到"实际调了几次"），
> `maxTokens` 只在 driver 真的上报 token 时才真正强制。
> 宁可如实说"没上报"，也不编一个看起来精确的数字。

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
      decision: deny                   # deny 走 tools.guard（同步、与注册顺序无关）
                                       # allow 是默认行为，显式声明仅表意图
                                       # ask / cancel 走 tools/pre-execute（见下）
      reason: TESTKIT_GUARD_DENIED     # deny 时回给调用方的理由

    # ── dispatch 之前：tools/pre-execute（真实 waterfall）──
    preExecute:
      name: testkit_pre_target         # 缺省继承 register.name
      decision: deny                   # allow | deny | ask | cancel
      decisions: [deny, cancel, ask]   # 或按第 N 次调用取不同决策
      reason: TESTKIT_PRE_REASON
      code: TESTKIT_PRE_DENIED         # deny 时写进 info.code
      displayReason: { en: ask why, zh: 询问理由 }   # ask 专用
      awaitDownstream: false           # true = 先 await next() 读下游决策再决定
      prepend: false                   # true = 排到 listener 链最前

    # ── 结果已产生之后：tools/post-execute（真实 waterfall）──
    postExecute:
      name: testkit_post_target
      action: block                    # accept | replace | block
      actions: [block, replace]        # 或按第 N 次调用取不同动作
      feedback: TESTKIT_BLOCKED        # block 的反馈文本
      text: TESTKIT_REPLACED           # replace 的替换文本（优先于 value）
      value: { ok: true }              # replace 的替换值
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

### 3.2.1 两条 waterfall 的契约（实测，别猜）

```js
ctx.on('tools/pre-execute',  async (exec, next) => { … })          // dispatch 之前
ctx.on('tools/post-execute', async (exec, result, next) => { … })  // 结果已产生之后
```

**最重要的一条**：不拥有决策时必须 `return next()`——直接返回 `undefined`
会把链断在自己这里，别人的决策全部失效。
（DSH 开发指引原文：*a waterfall listener that does not own the decision must return `next()`*；
证据：`dsh-experimental-auto-review` 与 `dsh-hooks-codex` 的真实监听器。）

driver 写出的决策形状与真实 `PreToolDecision` / `PostToolDecision` 对齐：

| decision | 形状 |
|---|---|
| `allow`（pre）/ `accept`（post） | 不拥有决策 → `next()` |
| `deny` | `{ kind:'deny', reason, info:{ name, code, reason? } }` |
| `cancel` | `{ kind:'cancel' }` |
| `ask` | `{ kind:'ask', reason?, displayReason? }`（无可用答者时 DSH 会降级为拒绝） |
| `replace` | `{ kind:'accept', content:[…] }` 或 `{ kind:'accept', value }` |
| `block` | `{ kind:'block', feedback:[{ type:'text', text }] }` |

**driver 写出的取证**：

| ref | 含义 |
|---|---|
| `fx.preExecuteCount` / `fx.preExecuteCalls` | 匹配到的调用次数与记录（`{ index, name, args }`） |
| `fx.preExecuteDecision` | 本层返回的决策摘要（`{ kind, reason, code }`） |
| `fx.preExecuteDownstream` | `awaitDownstream: true` 时读到的**下游**决策摘要 |
| `fx.postExecuteCount` / `fx.postExecuteCalls` | 匹配到的调用次数与记录（含 `isError` 与 `resultText`） |
| `fx.postExecuteOriginal` | 监听器收到的**原始**结果文本（改写前的证据） |
| `fx.postExecuteDecision` | 本层返回的决策摘要 |
| `fx.interceptVia` | `intercept` 的 ask/cancel 实际走的通道（`tools/pre-execute`） |

> 只对 `name` 匹配的调用生效；不匹配时**必须委托**（有专项单测守着这条）。
> 场景见 `cases/TK-0028.yaml`（三条 pre 决策）与 `cases/TK-0029.yaml`（block 与 replace）。

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

### 3.5 `kind: session` —— 会话与目标面（**已实现**）

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

**另外三个分支**（Phase 10 补的）：

```yaml
setup:
  session:
    flushObserver: { slowMs: 30 }   # 注册 session/flush 观察者（慢一点，用来验证"真的 await 了"）
    eventObserver: true             # 注册 session/event 只读观察者

steps:
  - act: { session: { flush: { note: 检查点 } } }        # ctx.sessions.flush()
    expect:
      - { ref: fx.sessionFlushParticipated, exists: true }
      - { ref: fx.sessionFlushDurationMs, atLeast: 30 }  # 契约：等每个 listener 结算完

  - act: { session: { goal: { op: create, objective: 目标 } } }   # ctx.goals
    expect:
      - { ref: fx.goalCreatedActivation, is: armed }
      - { ref: fx.goalAfterDisarmActivation, is: disarmed }        # driver 的安全阀

  - act: { session: { events: { limit: 10 } } }          # 只读观察
    expect: [{ ref: fx.sessionEventSeqMonotonic, is: true }]
```

> ⚠️ **`events` 分支只读，绝不写入。** DSH 的纪律原文：不要用新的 `type` 追加会话事件
> ——读取方只接受带 `ignorable: true` 的未知事件，而 `Session.append()` **设不了**这个标记，
> 于是那个会话会**拒绝重开**。所以这里只监听、只记录类型与序号。

> ⚠️ **`goal` 的 `create` 会 arm 自动续轮**（`goal-round-driver` 会一直唤醒模型）。
> driver 默认在 create 之后**立刻 `disarm`**（只清进程内授权、不动持久 phase），
> 并把两个状态都写进取证：`fx.goalCreatedActivation` 看 armed、
> `fx.goalAfterDisarmActivation` 看 disarmed。要保留 armed 得显式写 `disarmAfter: false`。

> 🔎 **实测发现：一半的目标操作是 `@Remote` 方法，不能本地直调。**
> `get` / `create` / `disarm` / `block` 是本地方法；
> 而 `pause` / `resume` / `complete` / `clear` / `edit` 带 `@Remote` 标记——
> 本地直调会崩在内部属性访问上（`…(reading 'transition')` / `…(reading 'prepareMutation')`），
> 那不是 `GoalError`，而是缺少远程通道上下文。
> driver 把这种崩溃翻译成 `fx.goalRemoteOpRequired is true` 的明确诊断。
> 连带后果：**teardown 的 `clear` 往往不可用**，这类场景创建过的目标可能留在会话里
> ——这也是它必须写成 `draft` 的原因之一。
>
> 另外实测：`block` 的 `code` 必须是 **lower-kebab-case**（`GOAL_XXX` 会被服务拒绝）。

**取证**：

| ref | 含义 |
|---|---|
| `fx.sessionTargetId` | 本场景认定的当前会话 id（事件过滤用） |
| `fx.sessionFlushSessionId` / `fx.sessionFlushNote` | flush 的目标会话与备注 |
| `fx.sessionFlushDurationMs` | flush 耗时（慢观察者的存在证明它真的 await 了） |
| `fx.sessionFlushParticipated` | `sessions.flush()` 的返回值：有没有 listener 参与 |
| `fx.sessionFlushObserverCalls` / `fx.sessionFlushObserverDelayMs` | 观察者被调用次数与它声明的慢速 |
| `fx.sessionFlushSeqBefore` / `fx.sessionFlushSeqAfter` | flush 前后的会话序号 |
| `fx.sessionFlushError` | flush 失败原文 |
| `fx.sessionEventCount` / `fx.sessionEvents` / `fx.sessionEventTypes` | 只读观察到的事件（计数 / 最近若干条 / 类型去重） |
| `fx.sessionEventSeqMonotonic` | 事件序号是否严格递增（抓"日志乱序"） |
| `fx.goalOp` / `fx.goalError` / `fx.goalErrorCode` | 目标操作、失败原文与尽力提取的稳定码 |
| `fx.goalRemoteOpRequired` | 该操作是 `@Remote` 方法、本地直调不可用 |
| `fx.goalId` / `fx.goalRevision` / `fx.goalPhase` / `fx.goalActivation` / `fx.goalObjective` | 最近一次目标视图 |
| `fx.goalCreatedPhase` / `fx.goalCreatedActivation` / `fx.goalAfterDisarmActivation` | create 当时与收回授权后的状态 |
| `fx.goalExists` / `fx.goalClearedRevision` | 当前是否还有目标 / clear 返回的墓碑 revision |
| `fx.goalTeardownCleared` / `fx.goalTeardownError` | teardown 补 clear 的结果 |

> 场景样例：[`TK-0032`](../cases/TK-0032.yaml)（flush）、
> [`TK-0033`](../cases/TK-0033.yaml)（goals + 事件观察）。

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

它有两**条通道**，由 `setup.agent.mode` 选择（也可在动作上覆盖），缺省不改既有行为：

| mode | 入口 | 语义 | 留痕 |
|---|---|---|---|
| `one-shot`（缺省） | `ctx.subagents.start()` | 一次性运行，父级只收最终输出 | 跑完 `dispose`，宿主不留痕 |
| `teammate` | `ctx.agentTeams.spawnTeammate()` | **复用 Agent Teams**：durable 可续接 child，进 roster | **成员永久留在 Lead 会话日志** |

两条通道共用同一个 subagent provider（实测注册名 `spawn` / `fork`），差别在**上层**：
`teammate` 内部走 `subagents.startContinuable()` 并向 Lead 会话追加 `team/member` 记录；
`one-shot` 只留一条 `subagent/catalog` 事实。

### `mode: one-shot`（缺省）

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

### `mode: teammate`（复用 Agent Teams）

```yaml
kind: agent
status: draft                       # ← 团队留痕不可逆，默认不进回归集
runtime:
  # 场景上限必须留在工具调用超时（testkit_run 是 120s）以内，否则外层先超时
  timeoutMs: 110000
  requires: [subagents, agentTeams]
setup:
  agent:
    mode: teammate
    context: fresh                  # fresh（缺省，不带 Lead 历史）｜fork（带 Lead 已完成轮次）
    description: 自检队友            # 进 roster 的职责描述
    waitMs: 60000                   # 等它跑完的上限（缺省 60000）
    #
    # name 只影响 roster 里的名字；缺省生成 tk-<caseId>-<rand> 唯一名。
    # ⚠️ 团队名**永不复用**（连创建失败的也保留），所以不要写死名字反复跑。
    #
    # 团队通道只接受 name / description / prompt / context / provider。
    # label / model / toolFilter / persona 写了**不会生效**，driver 会把它们
    # 记进 fx.teammateIgnoredSetup（而不是静默忽略）。

steps:
  - act: { agent: { prompt: '请只回复这四个字符：TESTKIT_OK' } }
    expect:
      - { ref: fx.teammateFinalStatus, is: inactive }
      - { ref: fx.teammateOutputs, lengthAtLeast: 1 }
```

**取证（两条通道共用）**：

| ref | 含义 |
|---|---|
| `fx.availableSubagentProviders` | 宿主注册的 provider 名单（跳过时用它解释原因） |
| `fx.agentProvider` | 实际使用的 provider |
| `fx.agentRunId` | 子会话 id（teammate 模式下即成员 id） |
| `fx.agentStopReason` | 一次性通道：`completed` / `aborted` / `error` / `max-tokens` / `refusal` |
| `fx.agentOutput` | 一次性通道：子 agent 产出的文本 |
| `fx.agentDiagnostic` / `fx.agentStructured` | 诊断信息 / 结构化输出 |
| `fx.agentDurationMs` | 耗时（毫秒） |
| `fx.agentError` | 派生或运行失败时的错误描述 |

**取证（`mode: teammate` 追加）**：

| ref | 含义 |
|---|---|
| `fx.teammateName` / `fx.teammateId` / `fx.teammateRole` | roster 里的成员名 / 会话 id / 角色 |
| `fx.teammateStatus` | `spawnTeammate` 返回时的状态（通常是 `running`） |
| `fx.teammateFinalStatus` | 跑完后的状态——**团队没有同步 result，"跑完了"就靠它回落为 `inactive`** |
| `fx.teammateWaitTimedOut` / `fx.teammateWaitMs` / `fx.teammateWakeReason` | 等待是否超时 / 等了多久 / 被团队变化还是轮询唤醒 |
| `fx.teammateOutput` / `fx.teammateOutputs` | 该成员会话里的 `assistant/message` 文本（经 `session/event` 收集） |
| `fx.teammateMembers` | 结束时的 roster 精简快照（`name` / `role` / `status`） |
| `fx.teammateRetained` | 恒为 `true`：成员**按设计保留**（团队没有删除成员的能力） |
| `fx.teammateIgnoredSetup` | 团队通道不支持的 setup 字段清单 |

> **teammate 的代价（这就是它默认不跑的原因）**：每次运行都在 Lead 会话里
> **永久**留下一个成员记录；`maxMembers` 是组合配置（DSH 的 Agent Teams profile bundle
> 设为 8，服务内建默认 16）且没有任何删除能力；名字不可复用。
> 所以走 team 通道的场景应写成 `status: draft`（默认 `active` 的回归集不含它），
> 只在需要时按 id 单跑。样例见 [`cases/TK-0027.yaml`](../cases/TK-0027.yaml)。

> **实测（2026-10-10，独立 headless 新进程）**：`TK-0027 passed`（703ms）——
> 成员名 `tk-0027-voi1`、状态 `running → inactive`（等待 604ms）、
> 其会话产出 `TESTKIT_OK` 进入 `fx.teammateOutputs`、成员按预期留在 roster；
> teammate 还用 `send_message` 把结果回传给了 Lead。

> **provider 名不确定时不猜。** 不同 profile 注册的 provider 名可能不同
> （实测 headless profile 是 `spawn` / `fork`）。一次性通道缺省取第一个；
> 显式指定的名字不存在时**跳过并列出可用名**。
> `teammate` 模式按 `context` 取 `spawn` / `fork`，可用 `provider` 覆盖。

> **使用纪律**：agent 类是**黑盒**用例，适合"端到端结果不对"这类说不清归类的 issue。
> 根因清楚后应**下沉**到精确 kind（`tool` / `llm` / `prompt` …），黑盒那条保留当回归网。

> **跳过而不是失败**：宿主没 `subagents`（一次性通道）、没 `agentTeams`（team 通道）、
> 或当前 agent 不是 Team Lead（团队是扁平的，teammate 不能再建 teammate）——
> 三种情况都走 `SkipCase`，并在报告里说明原因。

> **在 CI 轨里的行为**：headless 宿主没有 `subagents` / `agentTeams` 能力，所以这两类场景
> 都会被**跳过**（导出用例里显示为 `t.skip`）。这是刻意的——CI 里不该意外产生模型调用与费用，
> 更不该动真实团队的 roster。

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
> 这在当时的八个 kind 里是唯一的：其它都多少依赖宿主能力。
> （后来 `file` 成了第二个纯离线的 kind；`fs` **不是**——它需要宿主的文件服务。）

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

## 3.12 `kind: fs` —— 驱动宿主文件服务（**已实现**）

**它补的是分类学里 `resource` 行的 ⚠️**：表里写着 `ctx.fs` 未实现。
既有的 `kind: file` 走的是 `node:fs`，**绕过了宿主文件服务**——
沙箱策略、写意图、陈旧版本保护这些语义从来没有被测过。

```yaml
kind: fs
runtime:
  requires: [fs]
setup:
  fs:
    root: /tmp/xxx         # 缺省自动建临时目录（场景结束删掉）
    workspace: sub         # workspace-write 的根（相对 root 解析）
    mode: workspace-write  # 缺省沙箱模式（动作级可覆盖）
    probeSandbox: false    # true = 先探测后端是否真的实施沙箱

steps:
  - act: { fs: { write: { path: a.txt, text: 'v1' } } }
    expect: [{ ref: fx.fsOperation, is: create }]

  - act:
      fs: { write: { path: a.txt, text: 'v2', intent: replaceIfVersion, expectedVersion: last } }
    expect: [{ ref: fx.fsBefore, is: v1 }]

  - act:
      fs: { write: { path: a.txt, text: 'v3', intent: replaceIfVersion, expectedVersion: first } }
    expect: [{ ref: fx.fsErrorCode, is: FS_STALE_VERSION }]
```

**动作**：`resolve` / `stat` / `read` / `list` / `write` / `edit`（一个动作一个操作）。
`write` 支持写意图（`createIfAbsent` / `replaceIfVersion`）、期望版本来源（`first` / `last`）
与动作级沙箱覆盖（`sandbox: { mode, workspace }`）。

**取证**：

| ref | 含义 |
|---|---|
| `fx.fsRoot` / `fx.fsWorkspace` / `fx.fsSetupMode` | 本轮的工作根、沙箱根与缺省模式 |
| `fx.fsAction` | 这一步做的操作 |
| `fx.fsTargetPath` / `fx.fsTargetKeyPresent` | `resolve` 的结果（显示路径 + 是否给了稳定 targetKey） |
| `fx.fsExists` / `fx.fsType` / `fx.fsSize` / `fx.fsVersion` | `stat` / `resolve` 的元数据（不存在时 `fx.fsExists is false`） |
| `fx.fsText` / `fx.fsTextLength` | `read` 的内容与长度 |
| `fx.fsEntries` / `fx.fsEntryCount` | `list` 的目录项（已投影成 `{name,type,size}`） |
| `fx.fsOperation` / `fx.fsBefore` / `fx.fsAfter` | 写入结果（`create` / `update` 与前后内容） |
| `fx.fsWriteIntent` / `fx.fsExpectedVersion` | 这次写用的意图与守卫版本（已折叠显示） |
| `fx.fsSandboxMode` / `fx.fsSandboxWorkspace` | 这次调用实际传下去的沙箱策略 |
| `fx.fsSandboxProbe` / `fx.fsSandboxProbeCode` | `probeSandbox` 的探测结论与错误码 |
| `fx.fsError` / `fx.fsErrorCode` | 失败原文与尽力提取的稳定错误码（成功时为 `undefined`） |

**为什么必须有 `probeSandbox`**：契约原文写着 *a sandboxing backend fences the write by it,
**the bare backend ignores it***。同一个 `read-only` 策略，装了沙箱层的 profile 会拒绝，
bare 后端会照常写入。不探测就断言"必然被拒"，这条场景会在另一种 profile 上**假红**。
探测被拒 ⇒ 继续按真实语义断言；写成功 ⇒ **跳过**（明说此宿主不实施沙箱）。

> **活宿主实测的两个码**（2026-10-10，desktop 组合）：
> 陈旧版本写 → `FS_STALE_VERSION`；`read-only` 沙箱写 → `FS_SANDBOX_DENIED`。
>
> 另外 `createIfAbsent` 撞上已存在时报的是 **`FS_NOT_OBSERVED`**
> （"没先读过就不许覆盖"，来自 `fs-observation-policy`）——这条**取决于 profile
> 装没装该策略**，所以场景只断言"有稳定错误码"，不把具体码写死。
> 这也是"替身必须与真实契约一致"的一次现场纠正：单测的假服务最初自造了
> `FS_ALREADY_EXISTS`，实测后已改回真实语义。

> **与 `kind: file` 的分工**：`file` 用 `node:fs`，**纯离线**，任何宿主都能跑；
> `fs` 用 `ctx.fs`，测的正是宿主的沙箱与版本语义，因此在 CI 轨（headless 最小宿主）里会**跳过**。

> 场景样例：[`TK-0030`](../cases/TK-0030.yaml)（写意图与陈旧版本）、
> [`TK-0031`](../cases/TK-0031.yaml)（沙箱与探测降级）。

---

## 3.13 `kind: compaction` —— 会话历史压缩边界（**已实现**）

**它补的是分类学里 session 行的「压缩边界」**，也是 Phase 10 四个能力缺口里的最后一个。

### ⚠️ 安全约定：只在隔离会话上动手

`compactRegion` / `compactNow` 会**改写会话历史**（把选中的 surface 范围换成摘要节点）。
在用户正在用的会话上做这件事是破坏性的，所以本 driver 的缺省目标是**自己创建的隔离会话**：

```ts
sessions.create()   // 不绑定 agent 生命周期 ⇒ 契约保证 "persists nothing"
```

```yaml
kind: compaction
runtime:
  requires: [sessions, compaction]
setup:
  compaction:
    target: isolated        # 缺省：自建隔离会话（`current` 仅供只读用途）
    seed: empty             # 或 current（把当前会话已提交事件复制进来）
    provider: ''            # 可选：summarization 的路由
    model: ''

steps:
  - act: { compaction: { inspect: {} } }                     # 只读探测
  - act: { compaction: { ifNeeded: { trigger: pressure } } } # 让宿主决定该不该压
  - act: { compaction: { region: { start: 1, end: 4 } } }    # 强制压缩一段范围
  - act: { compaction: { now: {} } }                         # 需要真实 agent 上下文
```

**取证**：

| ref | 含义 |
|---|---|
| `fx.compactionTarget` / `fx.compactionIsolated` / `fx.compactionSessionId` | 目标来源与是不是隔离会话 |
| `fx.compactionSeededEvents` | 隔离会话 seed 了多少条事件 |
| `fx.compactionAction` | 这一步做的操作 |
| `fx.compactionTrigger` | `pressure` / `context-overflow` |
| `fx.compactionResultNull` | 宿主判定"没有可压的安全范围" |
| `fx.compactionCompactionId` / `fx.compactionStartSeq` / `fx.compactionSummarySeq` / `fx.compactionEndSeq` | 压缩结果的身份与边界 |
| `fx.compactionShadowedCount` / `fx.compactionShadowedTokenCount` / `fx.compactionSummaryText` | 被遮蔽的条目数 / token 数 / 摘要文本 |
| `fx.compactionRegionStart` / `fx.compactionRegionEnd` | 请求压缩的范围 |
| `fx.compactionSeq` / `fx.compactionSurfaceNodes` / `fx.compactionEventCount` / `fx.compactionEventTypes` | 只读探测（序号 / surface 节点 / 事件分布） |
| `fx.compactionHasRunMaintenance` / `fx.compactionUnsupported` | `compactNow` 需要 agent 上下文时的如实记录 |
| `fx.compactionOutcome` | 归一化结果：`compacted` / `rejected-not-smaller` / `rejected-range` / `no-range` / `error` |
| `fx.compactionEventSample` / `fx.compactionSurfaceSeqs` | `dump` 交出的原始事件样本（含 `data`）与 surface 序号 |
| `fx.compactionError` / `fx.compactionErrorCode` | 失败原文与尽力提取的稳定码 |

> 🔎 **实测：新建会话不是零事件。** `sessions.create()` 出来的会话自带 3 条 bootstrap 事件
> ——`permission/preset`、`sandbox/mode`、`approval/policy`（都是非 surface 事件）。
> 所以"空会话"的可压范围确实是 0（`surface.nodes` 为空），但**事件计数不是 0**；
> 断言写成 `compactionEventCount is 0` 会当场假红。

> 🔎 **实测：不存在的范围会被明确拒绝。** 空 surface 上压 `[1,1]` 得到
> `compactRegion: start seq 1 not found in surface`。契约原文也列出了另外几类：
> "rejects active, missing, reversed, or unbalanced ranges"。

> 🔎 **正向路径怎么跑通的**：手工挑 balanced 范围既脆又容易假红，实测改用
> `compactIfNeeded(session, 'context-overflow')`——契约说它会 "force a useful balanced
> reduction even below the normal threshold"，由**服务自己**挑范围。
> 实测成功读数：`startSeq=22 summarySeq=24 endSeq=26`、遮蔽 4 条 / 646 tokens、
> 摘要是一段真实的模型生成文本。

> ⚠️ **但真压缩的成败取决于模型摘要长度**：同一个场景再跑一次会报
> `summary is not smaller than the shadowed content (774 estimated framed tokens >= 646)`
> ——服务有**收缩校验**，摘要不够短就拒绝。那不是被测对象的缺陷，而是模型输出的函数。
> 所以 driver 把结果归一化成 `fx.compactionOutcome`
> （`compacted` / `rejected-not-smaller` / `rejected-range` / `no-range` / `error`），
> 场景的硬断言只放在"落在可归类结果上、且不是无法归类的 `error`"，
> 形状类断言（id / 边界 / 遮蔽计数 / 摘要）用 **soft**。
> 这样它不会因为模型这次话多就变红，而报告里仍能一眼看出是哪种结果。

> 场景样例：[`TK-0034`](../cases/TK-0034.yaml)（边界语义，零成本回归项）、
> [`TK-0035`](../cases/TK-0035.yaml)（正向路径，`draft`，花 token）。

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
- `cost` 与 `budget`（§2.2.1 / §2.2.2）属于**新增可选字段**：不写的场景行为不变，
  因此 `schema` 保持 `1`。报告里多出来的闸门快照 / 用量 / 归因同样是**只增不改**的字段

---

## 相关文档

- [架构设计](ARCHITECTURE.md) —— kind 分类学的由来
- [issue 提炼流程](ISSUE-PIPELINE.md) —— 从 issue 到这份 YAML 的步骤
- [开发文档](DEVELOPMENT.md) —— 校验命令
