---
domain: kinds
module: tool
revision: 1

atomics:
  - id: BEH-KIND-TOOL-001
    title: register-tool —— 注册临时工具并按声明装配 guard / pre-execute / post-execute 干预
    atomic: register-tool
    status: active

    source:
      file: src/kinds/tool.ts
      lines: "327-439"
      symbols:
        - "toolDriver"
        - "runToolBehavior"
        - "generateValue"
        - "contentToText"
        - "pickByCallIndex"
        - "buildPreDecision"
        - "buildPostDecision"
        - "summarizeDecision"
        - "installPreExecute"
        - "installPostExecute"
        - "splitListenerArgs"
      tests:
        - "tests/tool-driver.test.mjs::setup：按声明注册临时工具，且注册经 Fixture 登记"
        - "tests/tool-driver.test.mjs::setup：注册的工具执行时走声明的行为"
        - "tests/tool-driver.test.mjs::setup：intercept.deny 安装 guard，且只拦目标工具"
        - "tests/tool-driver.test.mjs::setup：intercept.allow 不安装干预"
        - "tests/tool-driver.test.mjs::setup：ask / cancel 走 tools/pre-execute（不再是 Phase 2 跳过）"
        - "tests/tool-driver.test.mjs::setup：宿主不提供 guard 时抛 SkipCase 而不是崩"
        - "tests/tool-driver.test.mjs::generateValue：repeat-string 按声明生成长度"
        - "tests/tool-driver.test.mjs::generateValue：未知 kind 抛错"
        - "tests/tool-driver.test.mjs::runToolBehavior：throws 优先于 returns"
        - "tests/tool-driver.test.mjs::runToolBehavior：returns 原样返回，缺省为 null"
        - "tests/tool-driver.test.mjs::runToolBehavior：generate 优先于 returns"
        - "tests/tool-driver.test.mjs::runToolBehavior：delayMs 真的延迟"
        - "tests/tool-driver.test.mjs::runToolBehavior：已取消的 signal 立即拒绝"
        - "tests/tool-driver.test.mjs::contentToText：拼接 text 块，忽略非文本块"
        - "tests/tool-driver.test.mjs::driver 元信息：kind / requires 正确"
        - "tests/tool-waterfall.test.mjs::pickByCallIndex：单值 / 列表 / 越界取最后一个"
        - "tests/tool-waterfall.test.mjs::buildPreDecision：allow 表示「不拥有决策」（返回 undefined）"
        - "tests/tool-waterfall.test.mjs::buildPreDecision：deny 带上 info.{name,code,reason}"
        - "tests/tool-waterfall.test.mjs::buildPreDecision：cancel 与 ask（含 displayReason）"
        - "tests/tool-waterfall.test.mjs::buildPreDecision：decisions 列表按下标取，缺声明则报错"
        - "tests/tool-waterfall.test.mjs::buildPostDecision：accept 委托；replace 走 content 或 value；block 带 feedback"
        - "tests/tool-waterfall.test.mjs::summarizeDecision：压成报告友好的摘要"
        - "tests/tool-waterfall.test.mjs::preExecute：匹配调用返回 deny，并记账形状"
        - "tests/tool-waterfall.test.mjs::preExecute：不是我的调用必须委托（链不能断在这里）"
        - "tests/tool-waterfall.test.mjs::preExecute：decisions 列表让一条场景覆盖多种决策"
        - "tests/tool-waterfall.test.mjs::preExecute：awaitDownstream 时下游的拒绝不被覆盖"
        - "tests/tool-waterfall.test.mjs::intercept：ask / cancel 现在走 waterfall（不再是 Phase 2 跳过）"
        - "tests/tool-waterfall.test.mjs::postExecute：block 带 feedback，且记账原始结果"
        - "tests/tool-waterfall.test.mjs::postExecute：replace 改写结果内容"
        - "tests/tool-waterfall.test.mjs::postExecute：accept 委托下游；其他工具不记账"
        - "tests/tool-waterfall.test.mjs::setup：缺 name 且没有 register.name 时明确报错（而不是静默放行）"
        - "tests/tool-waterfall.test.mjs::setup：listener 注册经 Fixture 登记（场景结束会被释放）"

    capabilities: ["tools"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.tool.register = { name: 'tk_echo', returns: 'hello' }"
        when: "setup 阶段注册临时工具"
        then: "fx.registeredTools contains 'tk_echo'；宿主 tools 服务可查到该工具，描述缺省为 'dsh-testkit 临时工具 tk_echo'"
        verdict: pass
      - given: "setup.tool.register = { name: 'tk_big', generate: { kind: 'repeat-string', char: 'A', times: 100000 } }"
        when: "该工具被调用"
        then: "返回值是字符串，length is 100000"
        verdict: pass
      - given: "setup.tool.register = { throws: 'boom', returns: 'x' }"
        when: "该工具被调用"
        then: "throws 为 true（throws 优先于 returns 与 generate）"
        verdict: fail
      - given: "setup.tool.intercept = { decision: 'deny', reason: 'no' }，register.name = 'tk_x'"
        when: "调用 tk_x；再调用另一个工具名"
        then: "tk_x 的调用为错误；fx.guardCalls contains 记账标签；另一个工具名放行（guard 返回 undefined）"
        verdict: fail
      - given: "setup.tool.intercept = { guards: [{ reason: 'no', record: 'g1' }, { record: 'g2' }] }"
        when: "调用目标工具"
        then: "fx.guardCalls is ['g1']（宿主短路）或 is ['g1','g2']（不短路）——两者都是既定观察，不做单值约定"
        verdict: fail
      - given: "setup.tool.intercept = { decision: 'allow' }"
        when: "setup 阶段"
        then: "fx.interceptNote is 'allow 是默认行为，未安装干预'；不安装任何 guard"
        verdict: pass
      - given: "setup.tool.intercept 既无 name，register 也无 name"
        when: "setup 阶段"
        then: "throws 为 true，错误信息含 'setup.tool.intercept 需要 name'"
        verdict: fail
      - given: "setup.tool.preExecute = { decision: 'deny', code: 'E_X', errorName: 'MyErr' }"
        when: "匹配的工具调用经过 tools/pre-execute"
        then: "fx.preExecuteDecision.kind is 'deny'，.code is 'E_X'；不匹配的调用不增加 fx.preExecuteCount"
        verdict: fail
      - given: "setup.tool.preExecute = { decisions: ['deny', 'ask', 'cancel'] }"
        when: "同一场景连续三次调用同一工具"
        then: "三次的 fx.preExecuteDecision.kind 依次是 'deny' / 'ask' / 'cancel'（越界固定取列表最后一项）"
        verdict: fail
      - given: "setup.tool.preExecute = { decision: 'deny', awaitDownstream: true }，且链下游给出 deny"
        when: "匹配的调用"
        then: "fx.preExecuteDecision.kind is 'deny'（下游更严格的拒绝不被本层覆盖）"
        verdict: fail
      - given: "setup.tool.postExecute = { action: 'replace', text: 'REPLACED' }"
        when: "匹配的调用"
        then: "fx.resultText is 'REPLACED'；fx.postExecuteOriginal 记原始文本"
        verdict: pass
      - given: "setup.tool.postExecute = { action: 'block', feedback: 'NOPE' }"
        when: "匹配的调用"
        then: "调用结果为错误，失败反馈 contains 'NOPE'"
        verdict: fail
      - given: "宿主 tools 服务不提供 guard()"
        when: "setup.tool.intercept.decision = 'deny'"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip

    cleanup: registered

    nonDeterministic:
      - field: "fx.guardCalls 的长度（多 guard 时）"
        reason: "取决于宿主 guard 是否短路，旧实现不假定也不强制"
        reconcile: "normalize:guard-shortcircuit"
      - field: "fx.preExecuteDownstream 的文本"
        reason: "下游 listener 的决策文本不由本 driver 控制"
        reconcile: "ignore"
      - field: "fx.callError / 工具抛错文本"
        reason: "错误消息来自宿主或场景声明的 throws 文本"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      error: normalize-message
      guardCalls: guard-shortcircuit

  - id: BEH-KIND-TOOL-002
    title: call-tool —— 经真实工具管道调用一次并采集结果与调用序列取证
    atomic: call-tool
    status: active

    source:
      file: src/kinds/tool.ts
      lines: "441-489"
      symbols:
        - "toolDriver"
        - "contentToText"
      tests:
        - "tests/tool-driver.test.mjs::act：成功调用写入完整取证"
        - "tests/tool-driver.test.mjs::act：失败调用把错误写进 callError"
        - "tests/tool-driver.test.mjs::act：多次调用累积 callCount 与 calls"
        - "tests/tool-driver.test.mjs::act：非 tool 动作直接报错（不静默跳过）"
        - "tests/tool-driver.test.mjs::act：宿主不提供 execute 时报错"

    capabilities: ["tools"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "已注册工具 tk_echo 返回 'hello'"
        when: "act: { kind: tool, tool: 'tk_echo', args: {} }"
        then: "fx.lastResult.isError is false；fx.resultText is 'hello'；fx.resultLength is 5；fx.resultValueLength is 5；fx.callError exists 为 false"
        verdict: pass
      - given: "已注册工具 tk_throw 声明 throws: 'boom'"
        when: "act: { kind: tool, tool: 'tk_throw' }"
        then: "fx.lastResult.isError is true；fx.callError 是非空字符串"
        verdict: fail
      - given: "同一场景连续三次调用"
        when: "三次 act: { kind: tool, tool: ... }"
        then: "fx.callCount is 3；fx.calls length is 3；fx.calls[].index 依次为 1/2/3"
        verdict: pass
      - given: "宿主 tools 服务不提供 execute()"
        when: "act: { kind: tool, tool: 'x' }"
        then: "throws 为 true，错误信息 contains '不提供 execute()'"
        verdict: fail
      - given: "act 收到非 tool 动作"
        when: "把 tool 动作以外的 StepAction 交给 tool driver"
        then: "throws 为 true，错误信息 contains 'tool driver 只支持'"
        verdict: fail

    cleanup: registered

    nonDeterministic:
      - field: "fx.lastResult.durationMs"
        reason: "挂钟时间差（Date.now 相减），由宿主与调度抖动决定"
        reconcile: "ignore"

    equivalence:
      verdict: exact
      durationMs: ignore
---

## register-tool

职责：把场景声明变成一个真实注册的工具，并在 `tools` 服务的三个扩展点上装配干预。

**三个干预通道，不是三个随意选项**（源码 4-16 行给出了选择依据）：

| 声明 | 走哪条通道 | 为什么 |
|---|---|---|
| `intercept.decision: deny` / `guards[]` | `tools.guard(fn)` | 同步检查、代价最低、**与注册顺序无关** |
| `intercept.decision: allow` | 不装干预 | 显式表达"放行"，只记 `fx.interceptNote` |
| `intercept.decision: ask` / `cancel` | 合成 `tools/pre-execute` | 只有 waterfall 能 await 审批 / cancel |
| `preExecute` | `tools/pre-execute` | allow / deny / ask / cancel，支持按调用序号的 `decisions[]`、`awaitDownstream`、`prepend` |
| `postExecute` | `tools/post-execute` | accept / replace / block，支持 `actions[]`、`prepend` |

**工具行为的取值优先级**（`runToolBehavior`）：`throws` → `delayMs`（可与 `returns` 组合）→ `generate` → `returns`（缺省 `null`）。

**waterfall listener 形态是实测契约，不是推断**：`pre-execute` 是 `(exec, next)`、`post-execute` 是 `(exec, result, next)`；
「不拥有决策」必须返回 `undefined`/`next()` 以委托，否则会切断链上其它 listener。`splitListenerArgs`（500-513）用
「参数个数 + 第二个参数是否函数」启发式区分两种形态，这是对框架实现细节的适配，不是稳定契约。

注册与全部 disposer 都经 `ctx.fixture.add()` 登记，场景结束逆序释放。

### 边界与已知缺陷

1. **`allow` 是"可读但基本不可验证"的**：`intercept.decision: 'allow'` 不装任何干预，只写一条自由文本 `fx.interceptNote`
   （源码 390-393）。17 个断言词无法表达"确实没有安装 guard"——没有计数器或集合取证；它与 `guards: []` 也无法区分。
2. **`summarizeDecision` 丢掉决策的大部分载荷**：只保留 `{kind, reason, code}`（源码 308-320）。
   `replace` 的 `value`、`block` 的 `feedback`、`ask` 的 `displayReason` 都不进取证，故"决策对象的完整形状"不可断言；
   `replace` 的最终效果只能靠 `fx.resultText` 间接观察。
3. **异常路径没有决策取证**：`spec.throws`（535、593 行）在写 `*Decision` note **之前**抛出，
   因此"listener 抛错"与"未匹配到调用"在取证上不可区分。
4. **`splitListenerArgs` 的启发式是脆弱点**：`hasResult = args.length >= 3 || (args.length === 2 && typeof args[1] !== 'function')`。
   上游框架若改变 next 的位置，post 的原始结果会被误判，症状是"`fx.postExecuteOriginal` 恒为空"而不是报错。
5. **`src/kinds/index.ts:9-11` 的模块头注释已过时**：仍写"待实现 Phase 2 interaction/session/resource、Phase 5 agent"，
   但 95-113 行早已注册全部 12 个 driver。以注释为准会误判实现状态。

## call-tool

职责：经宿主 `tools.execute()` 真实 dispatch 一次调用并取证。

每次 act 先自增 `fx.callCount` 并追加 `fx.calls`（`{index, name, args}`），再以 `callId = 'testkit-<n>'` 调 `tools.execute()`。
取证面：`fx.lastResult{name,isError,durationMs}`、`fx.resultText`（`contentToText` 抽取 `content[].text` 并以 `\n` 连接）、
`fx.resultLength`、`fx.resultValue`、`fx.resultValueLength`、`fx.callError`。成功时 `fx.callError` 显式记 `undefined`，
让 `exists: false` 成为可达表达式（README 强调过这条语义）。

### 边界与已知缺陷

1. **`fx.resultText` 的拼接丢失块边界**：`contentToText` 把多个 text 块用 `\n` 连接（源码 202-212），
   因此"两个块"与"一个块里含换行"在外观上相同——只能 `contains`，不能断言块数。
2. **`fx.resultValue` 与 `fx.resultText` 的取舍未强制**：宿主若同时给 `value` 与 `content`，两者都会取证，但 spec
   没有规定哪个是"权威结果"。新实现对拍时可能出现"一个相等、另一个不等"的歧义。
3. **调用序号是唯一标识，不保证跨重复运行稳定**：`fx.calls[].index` 由 `fx.callCount` 派生，
   在 `repeat` / 并发重跑下语义未定义（`parallel` 缺省 `exclusive` 掩盖了这一点）。

## 测试覆盖

`tests/tool-driver.test.mjs`（20 个用例）与 `tests/tool-waterfall.test.mjs`（17 个用例）覆盖两个原子的全部主要分支。
**两个原子都有既有测试覆盖**，无缺口。
