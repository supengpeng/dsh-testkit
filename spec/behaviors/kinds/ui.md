---
domain: kinds
module: ui
revision: 1

atomics:
  - id: BEH-KIND-UI-001
    title: load-client-bundle —— 在隔离 vm 里加载 client 半真实产物并验证 slot / 词典注册
    atomic: load-client-bundle
    status: active

    source:
      file: src/kinds/ui.ts
      lines: "240-339"
      symbols:
        - "uiDriver"
        - "UiSetup"
        - "UiAction"
        - "UiObservation"
        - "inspectClientBundle"
        - "makeFakeRequire"
        - "resolveBundlePath"
        - "uiConfigs"
        - "describe"
      tests:
        - "tests/ui-driver.test.mjs::inspectClientBundle：抓取模块 id / name / inject / apply"
        - "tests/ui-driver.test.mjs::inspectClientBundle：记录 locale 注册与 slot 注册"
        - "tests/ui-driver.test.mjs::inspectClientBundle：apply 抛错被如实记录（不炸掉检查器）"
        - "tests/ui-driver.test.mjs::inspectClientBundle：没有 apply 时不执行，也不报错"
        - "tests/ui-driver.test.mjs::inspectClientBundle：产物没有 load 调用时返回空观察（不抛）"
        - "tests/ui-driver.test.mjs::inspectClientBundle：bundle 请求未提供的模块时给出点名错误"
        - "tests/ui-driver.test.mjs::inspectClientBundle：React 替身可用（createElement 能造元素）"
        - "tests/ui-driver.test.mjs::act：bundle 不存在时记 uiBundleExists=false 而不是抛错"
        - "tests/ui-driver.test.mjs::act：load=false 时只验存在性，不执行 apply"
        - "tests/ui-driver.test.mjs::act：真实产物被加载并注册了 conversation.view"
        - "tests/ui-driver.test.mjs::act：声明了期望但产物没注册时立即失败（附实际注册项）"
        - "tests/ui-driver.test.mjs::act：声明了期望词典命名空间但没注册时立即失败"
        - "tests/ui-driver.test.mjs::act：非 ui 动作直接报错"
        - "tests/ui-driver.test.mjs::driver 元信息：kind=ui 且不静态声明 requires（纯离线）"

    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.ui = { expectSlots: ['conversation.view'] }，bundle 存在且可加载"
        when: "act: { kind: ui, ui: { load: true } }"
        then: "fx.uiBundleExists is true；fx.uiModuleId 非空；fx.uiHasApply is true；fx.uiLoadCalls is 1；fx.uiRegisteredSlotNames contains 'conversation.view'；fx.uiError exists 为 false"
        verdict: pass
      - given: "bundle 文件不存在"
        when: "act: { kind: ui, ui: {} }"
        then: "fx.uiBundleExists is false；fx.uiBundleBytes is 0；fx.uiError contains '读不到 bundle'；场景不失败（不抛）"
        verdict: fail
      - given: "bundle 存在"
        when: "act: { kind: ui, ui: { load: false } }"
        then: "fx.uiBundleExists is true；fx.uiBundleBytes atLeast 1；fx.uiModuleId exists 为 false（不执行 apply）"
        verdict: pass
      - given: "client 半的 apply() 抛错"
        when: "act: { kind: ui, ui: {} }"
        then: "fx.uiError contains 错误消息；检查器本身不抛错"
        verdict: fail
      - given: "bundle 请求了未提供的 external 模块"
        when: "act: { kind: ui, ui: {} }"
        then: "fx.uiError contains '加载 bundle 失败'"
        verdict: fail
      - given: "setup.ui.expectSlots 声明了产物没有注册的 slot"
        when: "act: { kind: ui, ui: {} }"
        then: "throws 为 true，错误信息 contains 'client 半没有注册期望的 slot'（并附实际注册项）"
        verdict: fail
      - given: "setup.ui.expectLocaleNamespaces 声明了未注册的命名空间"
        when: "act: { kind: ui, ui: {} }"
        then: "throws 为 true，错误信息 contains '没有注册期望的词典命名空间'"
        verdict: fail
      - given: "bundle 声明了 locale 与 slots"
        when: "act: { kind: ui, ui: {} }"
        then: "fx.uiLocaleNamespaces 是非空数组；fx.uiInjectedSlots 与 fx.uiRegisteredSlots 记录了调用；fx.uiRendererProvided is true"
        verdict: pass
      - given: "act 收到非 ui 动作"
        when: "把非 ui 的 StepAction 交给 ui driver"
        then: "throws 为 true，错误信息 contains 'ui driver 只支持'"
        verdict: fail

    cleanup: none

    nonDeterministic:
      - field: "fx.uiBundleBytes"
        reason: "随构建产物变化，是构建指纹而不是行为量"
        reconcile: "atLeast"
      - field: "fx.uiError 文本"
        reason: "错误消息含产物路径与 vm 抛出的原文，跨平台/跨构建可变"
        reconcile: "normalize:normalize-message"
      - field: "fx.uiBundlePath"
        reason: "绝对路径取决于安装位置"
        reconcile: "normalize:normalize-path"

    equivalence:
      verdict: exact
      bundlePath: normalize-path
      error: normalize-message
      bundleBytes: atLeast
---

## load-client-bundle

**为什么这个 driver 值得存在**：client 半是双半插件的另一半，但长期是**测试盲区**——它的代码在浏览器里跑，
而 runner 与 CI 轨都活在 Node 里。实测踩过两类只能靠它兜住的坑：`lib/client.js` 不存在（构建脚本把它删了）
→ GUI 里「测试」标签凭空不见；client bundle 导出形态变了 → 加载静默失败。

**怎么在 Node 里验证浏览器产物**：bundle 的形态是 `window.__ModuleLoader__.load({ id, factory })`，
所以只要在**隔离 vm context** 里提供 `window.__ModuleLoader__.load`（收集注册项）与 `require`（满足 external，最小替身即可）
就能把它跑起来；拿 `factory(require)` 得到模块对象，再用**假 ctx** 调 `apply()`，记录它对 `slots` / `locale` 的每一次调用。
得到的是**真实产物的真实行为**，不是另写一份"测试用的 client 半"。

**它不验证什么**：不验证渲染结果（React 组件长什么样、像素对不对）——那是浏览器的事。它验证的是
"bundle 能加载、导出面正确、注册调用正确、注册项的名字正确"。

**两种失败收尾方式**：产物缺失 / 加载失败 / apply 抛错 → 写 `fx.uiError` 不抛（让场景用断言表达期望）；
**声明了期望却没注册** → 立即 throw（"标签不出现"那类 issue 的直接证据，不该留给断言慢慢找）。

### 边界与已知缺陷

1. **`observation.bundleExists` 是恒为 true 的死字段**：它在 `inspectClientBundle` 里初始化为 `true` 且再没被改过，
   而该函数只在 `readFileSync` 成功后调用。于是 `fx.uiBundleExists is true` **不能推出"bundle 可用"**，
   必须配合 `fx.uiError exists: false`。这组组合断言纪律没有写在任何文档或 schema 里，场景作者极易误用。
2. **`inject` 里的非字符串项被静默丢弃**：`observation.inject` 用 `.filter(typeof x === 'string')` 构造（178-180 行），
   没有任何"丢了几项"的取证。产物的导出面若含非字符串，场景只会看到数组更短，不会失败。
3. **vm 沙箱只提供 `window.__ModuleLoader__` / console / setTimeout / globalThis**：产物在**顶层**访问
   `document` / `navigator` / `localStorage` 会在 `vm.runInContext` 阶段抛错，被归到"加载 bundle 失败"——
   与"bundle 本身语法错误"共用同一个 `fx.uiError` 前缀，不可区分。
4. **`makeFakeRequire` 只提供 react / react/jsx-runtime**，其它 id 直接抛错（110 行）。产物新增（或改名）依赖会让
   **所有** ui 场景立刻失败，而诊断只有一条 `client bundle 请求了未提供的模块：<id>`。这是刻意的"方便发现新依赖"，
   但代价是失败面很大。
5. **没有 `setup.ui` 时 act 仍能跑**：`uiConfigs.get(ctx.fixture) ?? {}`（259 行）会退化成"加载本包包根下的
   `lib/client.js`"。也就是说，一条忘了写 setup 的 ui 场景会**安静地验证本包产物**并可能通过，而不是报"缺少配置"。

## 测试覆盖

`tests/ui-driver.test.mjs`（14 个用例）覆盖 `inspectClientBundle` 的模块解析/注册记录/异常容忍、
bundle 缺失、`load: false`、期望缺失两种立即失败，以及真实产物注册 `conversation.view`。
**单个原子有既有测试覆盖**，无缺口。
