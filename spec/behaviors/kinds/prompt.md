---
domain: kinds
module: prompt
revision: 1

atomics:
  - id: BEH-KIND-PROMPT-001
    title: assemble-prompt —— 主动组装一次系统提示并把结果或失败原因记进取证
    atomic: assemble-prompt
    status: active

    source:
      file: src/kinds/prompt.ts
      lines: "149-176"
      symbols:
        - "promptDriver"
        - "summarizeAssembly"
        - "PromptSetup"
      tests:
        - "tests/prompt-driver.test.mjs::setup：注册 section 与 variable 并主动组装取证"
        - "tests/prompt-driver.test.mjs::setup：组装失败被记账而非抛出（让 case 自己表达期望）"
        - "tests/prompt-driver.test.mjs::setup：宿主不提供 assemble 时记账说明，不崩"
        - "tests/prompt-driver.test.mjs::summarizeAssembly：抽出 section / context 的名字与文本"
        - "tests/prompt-driver.test.mjs::summarizeAssembly：畸形输入不炸"

    capabilities: ["systemPrompt"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "至少注册了 section / context / variable 之一"
        when: "setup 末尾的主动 assemble({ signal })"
        then: "fx.assembled exists 为 true；fx.assembleError exists 为 false"
        verdict: pass
      - given: "宿主的 assemble() 抛错"
        when: "setup 末尾的主动 assemble"
        then: "fx.assembleError 是非空字符串（形如 'Error: ...'），场景本身不失败"
        verdict: pass
      - given: "宿主 systemPrompt 服务不提供 assemble()"
        when: "至少注册了一项之后"
        then: "fx.assembleError is 'systemPrompt 服务不提供 assemble()，无法取证'"
        verdict: skip
      - given: "组装成功且声明了 variable"
        when: "读取 fx.variableValue"
        then: "fx.variableValue is 声明值"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.sectionNames / fx.sectionText / fx.contextNames / fx.contextText / fx.assembled"
        reason: "assemble 结果是整个宿主的组装快照，含其它插件注册的 section/context 与 tools 列表"
        reconcile: "normalize:superset-of-declared"
      - field: "fx.assembleError 的消息文本"
        reason: "错误文本由宿主抛出，字符串可变"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      error: normalize-message
      assembly: superset-of-declared

  - id: BEH-KIND-PROMPT-002
    title: inject-section —— 注册 section / context / variable 三类提示注入点
    atomic: inject-section
    status: active

    source:
      file: src/kinds/prompt.ts
      lines: "100-147"
      symbols:
        - "promptDriver"
        - "PromptSetup"
        - "VARIABLE_NAME_RE"
      tests:
        - "tests/prompt-driver.test.mjs::setup：注册 section 与 variable 并主动组装取证"
        - "tests/prompt-driver.test.mjs::setup：context 也能注册"
        - "tests/prompt-driver.test.mjs::setup：非法 variable 名在注册前就被拦下，并给出可读原因"
        - "tests/prompt-driver.test.mjs::setup：宿主没有 systemPrompt 服务时抛 SkipCase"
        - "tests/prompt-driver.test.mjs::setup：服务缺 section() 时抛 SkipCase 而不是 TypeError"
        - "tests/prompt-driver.test.mjs::setup：setup.prompt 缺失时是空操作"
        - "tests/prompt-driver.test.mjs::act：prompt 类场景不该有动作，被调用即报错"
        - "tests/prompt-driver.test.mjs::VARIABLE_NAME_RE：符合 DSH 的 [a-z][a-z0-9_]* 约束"
        - "tests/prompt-driver.test.mjs::driver 元信息：kind / requires 正确"

    capabilities: ["systemPrompt"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.prompt.section = { name: 'tk_sec', order: 10, text: 'HELLO' }"
        when: "setup 阶段注册（随后立即组装一次）"
        then: "fx.sectionNames contains 'tk_sec'；fx.sectionText contains 'HELLO'"
        verdict: pass
      - given: "setup.prompt.context = { name: 'tk_ctx', order: 20, text: 'CTX' }"
        when: "setup 阶段注册"
        then: "fx.contextNames contains 'tk_ctx'；fx.contextText contains 'CTX'"
        verdict: pass
      - given: "setup.prompt.variable.name = 'tkVar'（含大写）"
        when: "setup 阶段"
        then: "throws 为 true，错误信息 contains 'prompt.variable.name 不合法' 与 '[a-z][a-z0-9_]*'"
        verdict: fail
      - given: "宿主 systemPrompt 服务不提供 section()"
        when: "setup.prompt.section 存在"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "宿主没有 systemPrompt 服务"
        when: "setup.prompt 存在"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "setup.prompt 整体缺失"
        when: "setup 阶段"
        then: "无任何 fx.* 取证写入，场景不被判失败（空操作）"
        verdict: skip

    cleanup: registered

    nonDeterministic:
      - field: "注册的 disposer 释放顺序（同名的 section 与 context）"
        reason: "Fixture 逆序释放，同名不同类的注入点相对顺序取决于声明顺序"
        reconcile: "ignore"

    equivalence:
      verdict: exact
---

## assemble-prompt

`systemPrompt.assemble()` 是**可主动调用**的公开方法，返回组装后的
`PromptAssembly { sections, contexts, tools, variables }`。因此本原子不需要等模型真的跑一轮：
注册完立刻组装一次，把结果记进取证，断言直接查 `fx.sectionText` / `fx.variableValue`。

组装只在**至少注册了一项**时发生（`registered > 0`）；`assemble` 的异常被吞进 `fx.assembleError` 而**不抛出**——
设计理由是"组装失败本身就是被测对象，让 case 用 `fx.assembleError exists: false` 表达期望更直白"。
`summarizeAssembly` 把组装结果压成 `sectionNames / sectionText / contextNames / contextText` 四个可断言的扁平面，
纯函数、可离线单测。

### 边界与已知缺陷

1. **组装失败默认不失败（静默通过风险）**：`assemble` 抛错只写 `fx.assembleError`，不抛出。任何**没有显式断言**
   `fx.assembleError exists: false` 的 prompt 场景，会在宿主组装彻底坏掉时判**通过**。
2. **`fx.variableValue` 只对 `setup.variable` 取值**（166-169）：若变量由其它插件提供，取不到；`variables` 全集没有单独取证。
3. **`sectionText` 用 `\n` 拍平、丢失 section 边界**（80 行）：断言 `contains` 可用，但"哪个 section 贡献了这段文本"无法判定，
   也无法断言 section 数量（因为快照含宿主全量）。
4. **组装快照是宿主全量**：`fx.sectionNames` 等包含其它插件的 section/context，所以精确断言（`length is 1`）
   在本机可用、换环境即失败。spec 只承诺 `contains` 级语义。

## inject-section

三条注册通道各自独立，全部经 `ctx.fixture.add()` 登记 disposer：

- `section({ name, order, text, interpolate?, complete? })`——后两个字段透传；
- `context({ name, order, text })`；
- `variable(name, () => value)`——注册**前**先用 `VARIABLE_NAME_RE = /^[a-z][a-z0-9_]*$/` 自查名字并给可读错误。
  这条规则来自 DSH（只能小写字母开头，后接小写字母/数字/下划线），不是本仓库的偏好。

缺对应服务方法时抛 `SkipCase` 而不是 `TypeError`（100-147 行），所以"宿主能力不足"表现为 skip 而不是 crash。

prompt 类场景**没有 act**：`act` 恒抛错（180-184），注册即条件、组装即取证。

### 边界与已知缺陷

1. **`setup.prompt: {}`（空对象）是静默空操作**：`registered === 0` 时直接 `return`，既不写取证也不报错。
   把 `section` 拼错成 `sections` 会得到一条"通过但什么都没发生"的场景，没有任何 `fx.*` 痕迹能让它暴露。
2. **`variable` 只覆盖常量返回值**：`PromptSetup.variable` 是 `{ name, value: string }`，provider 被硬编码成 `() => spec.value`。
   而宿主契约是 `variable(name, (ctx) => string | undefined)`——**允许返回 undefined**。该分支在 driver 层不可达。
3. **`act` 恒抛错是刻意的**：意味着 prompt 场景不能有任何 `act` 步骤；组合场景里若与其它 kind 共享 `steps`，
   必须保证 prompt 的动作只出现在 setup。

## 测试覆盖

`tests/prompt-driver.test.mjs`（13 个用例）覆盖两个原子：三条注册通道、组装成功/失败两条路径、
`SkipCase` 分支、`act` 报错与纯函数。**两个原子都有既有测试覆盖**，无缺口。
