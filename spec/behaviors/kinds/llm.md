---
domain: kinds
module: llm
revision: 1

atomics:
  - id: BEH-KIND-LLM-001
    title: intercept-llm-stream —— 接管 llm/stream，模型输出与失败全由声明决定（零上游请求）
    atomic: intercept-llm-stream
    status: active

    source:
      file: src/kinds/llm.ts
      lines: "165-243"
      symbols:
        - "llmDriver"
        - "LlmSetup"
        - "LlmRespondSpec"
        - "StreamChunkLike"
        - "buildChunkPlan"
        - "emitChunks"
        - "minimalLlmOptions"
        - "TESTKIT_LLM_ERROR_CODE"
      tests:
        - "tests/llm-driver.test.mjs::buildChunkPlan：正常路径产出完整序列"
        - "tests/llm-driver.test.mjs::buildChunkPlan：无 usage 声明时不产出 usage chunk"
        - "tests/llm-driver.test.mjs::buildChunkPlan：error 模式只产出 error finish"
        - "tests/llm-driver.test.mjs::buildChunkPlan：mid-stream-error 截断内容并补 error finish"
        - "tests/llm-driver.test.mjs::buildChunkPlan：timeout 模式只产出开头（不误走正常路径）"
        - "tests/llm-driver.test.mjs::buildChunkPlan：malformed 模式产出结构畸形的 chunk"
        - "tests/llm-driver.test.mjs::emitChunks：按计划顺序产出"
        - "tests/llm-driver.test.mjs::emitChunks：已取消的 signal 立即停止"
        - "tests/llm-driver.test.mjs::emitChunks：timeout 模式在开头之后挂住，取消才结束"
        - "tests/llm-driver.test.mjs::minimalLlmOptions：带齐 DSH 要求的必填字段"
        - "tests/llm-driver.test.mjs::setup：注册 llm/stream listener，且能力探测识别到 llm"
        - "tests/llm-driver.test.mjs::拦截真实性：act 消费到 mock 流，且真实适配器从未被触达"
        - "tests/llm-driver.test.mjs::拦截真实性：没有 driver 时，真实适配器会被触达（对照组）"
        - "tests/llm-driver.test.mjs::act：mid-stream-error 时保留已产出内容并报 error finish"
        - "tests/llm-driver.test.mjs::act：非 llm 动作直接报错"
        - "tests/llm-driver.test.mjs::act：宿主不提供 llm.stream 时报错"
        - "tests/llm-driver.test.mjs::driver 元信息：kind / requires 正确"

    capabilities: ["llm"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.llm.respond = { chunks: ['你', '好'], usage: { input: 3, output: 2 }, finishReason: 'stop' }"
        when: "act: { kind: llm, llm: { prompt: 'hi' } }"
        then: "fx.mockText is '你好'；fx.chunkTypes is ['block-start','text-delta','text-delta','block-end','usage','finish']；fx.finishReason is 'stop'；fx.streamError exists 为 false"
        verdict: pass
      - given: "setup.llm.respond = { chunks: [] }（不给 usage）"
        when: "act: { kind: llm }"
        then: "fx.chunkTypes notContains 'usage'"
        verdict: pass
      - given: "setup.llm.failMode = 'error'"
        when: "act: { kind: llm }"
        then: "fx.chunkTypes is ['finish']；fx.finishReason is 'error'；fx.mockText is ''"
        verdict: fail
      - given: "setup.llm = { respond: { chunks: ['a','b','c'] }, failMode: 'mid-stream-error', failAfterChunks: 2 }"
        when: "act: { kind: llm }"
        then: "fx.mockText is 'ab'；fx.finishReason is 'error'；fx.chunkCount is 4"
        verdict: fail
      - given: "setup.llm.failMode = 'timeout'"
        when: "act: { kind: llm }，且场景 signal 在超时前被 abort"
        then: "fx.chunkTypes is ['block-start']；fx.finishReason exists 为 false；fx.streamError exists 为 false（取消是正常出口）"
        verdict: pass
      - given: "setup.llm.failMode = 'malformed'"
        when: "act: { kind: llm }"
        then: "fx.chunkTypes is ['block-start','text-delta','finish']；fx.mockText is ''（畸形的 text-delta 没有 text 字段）"
        verdict: fail
      - given: "setup.llm 存在且宿主具备 llm 能力"
        when: "setup 阶段注册 listener"
        then: "fx.plannedChunks 是计划里的 chunk type 列表；真实适配器调用次数 is 0"
        verdict: pass
      - given: "宿主 llm 服务不提供 stream()"
        when: "act: { kind: llm }"
        then: "throws 为 true，错误信息 contains '不提供 stream()'"
        verdict: fail
      - given: "act 收到非 llm 动作"
        when: "把非 llm 的 StepAction 交给 llm driver"
        then: "throws 为 true，错误信息 contains 'llm driver 只支持'"
        verdict: fail

    cleanup: registered

    nonDeterministic:
      - field: "fx.chunkCount / 结束时机的（timeout 模式）"
        reason: "结束时刻由场景 signal 的 abort（runner 超时）决定，不是 driver 自己产出"
        reconcile: "ignore"
      - field: "fx.streamError 文本"
        reason: "错误消息由宿主抛出"
        reconcile: "normalize:normalize-message"
      - field: "respond.delayMs 造成的总耗时"
        reason: "挂钟时间（setTimeout 链）"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      error: normalize-message
      chunkTypes: exact
      durationMs: ignore
---

## intercept-llm-stream

**拦截点（实测契约，不是推断）。** `setup` 用 `ctx.host.on('llm/stream', ...)` 注册 listener，返回
`emitChunks(...)` 产出的 `AsyncIterable`。两条来自 DSH 发行体的关键事实（源码 4-24 行）：

1. 该 waterfall 的 `next()` **同步返回 `AsyncIterable`**（不是 Promise）——照抄 `tools/pre-execute` 那类会得到
   `undefined` 从而静默产出空流；
2. **不调用 `next()` 就完全旁路真实模型**——本 driver 正是靠这一点做到"零上游请求"。

所以 `fx.mockText` 不是"我们打算产出的文本"，而是**下游实际消费到的流**里累积出来的：它同时证明"拦截生效"
与"chunk 结构被正确识别"。`tests/llm-driver.test.mjs` 用 `realAdapterCalls === 0` 守住前者，并附了
"没有 driver 时真实适配器会被触达"的对照组。

**chunk 计划（`buildChunkPlan`，纯函数）** 五种模式：

| failMode | 计划 |
|---|---|
| `none`（缺省） | `block-start` → 每个 chunk 一个 `text-delta` → `block-end`（text 为全部 chunk 拼接）→ 有 `usage` 声明时补 `usage` → `finish`（`respond.finishReason ?? 'stop'`） |
| `error` | 只有 `finish`，`reason.kind = 'error'`，`failure.code = TESTKIT_LLM_ERROR_CODE` |
| `mid-stream-error` | `block-start` → 前 `failAfterChunks ?? 1` 个 `text-delta` → error finish |
| `timeout` | 只有 `block-start`；`emitChunks` 在计划耗尽后挂住直到取消，**绝不产出 finish** |
| `malformed` | 故意缺字段：`text-delta` 无 `text`、`finish` 无 `reason` |

**触发与消费（`act`）** 用 `provider/model = 'testkit-mock'` 占位（listener 不调 next，不会真的路由），
迭代 `service.stream(options)`，累积 `fx.mockText`（仅 text-delta）、`fx.chunkTypes`、`fx.chunkCount`、
`fx.finishReason`、`fx.streamError`。迭代异常被吞进 `fx.streamError`，**不抛出**。

### 边界与已知缺陷

1. **`usage` chunk 的载荷不可观察**：`act` 只把 chunk 的 `type` 记进 `fx.chunkTypes`，`inputTokens/outputTokens/totalTokens`
   没有任何取证字段。因此 `setup.llm.respond.usage` 的效果**无法用 17 个断言词断言**（只能断言"存在一个 usage chunk"）。
   这是 A3 对拍字段覆盖率的直接缺口。
2. **多条 act 共用同一份计划**：`plan` 在 `setup` 期构建一次并被 listener 闭包复用，一条场景里多次 `act: { kind: llm }`
   会得到完全相同的响应序列，无法表达"第一次超时、第二次成功"这类状态机——对比 `tool` 的 `decisions[]`（按调用序号取值）
   是明确的表达力落差。
3. **注册没有 `prepend` 开关**：`ctx.host.on('llm/stream', handler)` 未传选项。若宿主或其它插件也监听 `llm/stream`
   （例如 DSH 自带的 stream 校验 listener），谁先拿到请求由注册顺序决定，场景结果可能随加载顺序漂移。
   `tool` driver 的 pre/post-execute 都提供 `prepend`，此处不一致。
4. **失败的两条通道语义重叠、无断言纪律**：`failMode: 'error'` 得到 `fx.finishReason = 'error'` 而 `fx.streamError` 为 `undefined`；
   若宿主把 error finish 转成异常，则变成 `fx.streamError` 有值、`fx.finishReason` 为 `undefined`。同一物理失败有两种断言写法，
   spec 没有机制强制场景声明用哪条。
5. **`malformed` 有意破坏自身类型契约**：源码用 `as unknown as StreamChunkLike` 塞入缺字段对象。它的可观察结果
   **取决于下游是否做结构校验**——这是"未与宿主约定的行为"，不应被当成新实现必须保留的确定性语义。
6. **`timeout` 模式没有自主上界**：`sleepUntilAborted` 只监听 abort。若 runner 未按 `timeoutMs` abort，act 将永久挂起；
   driver 自身不设兜底超时。

## 测试覆盖

`tests/llm-driver.test.mjs`（17 个用例）覆盖 `buildChunkPlan` 全部五种模式、`emitChunks` 的顺序/取消/挂住、
`minimalLlmOptions`、两条拦截真实性用例与 `act` 的错误路径。**单个原子有既有测试覆盖**，无缺口；
但缺陷 1 说明覆盖是**行为级**的，不是**取证字段级**的。
