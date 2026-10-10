---
domain: kinds
module: resource
revision: 1

atomics:
  - id: BEH-KIND-RESOURCE-001
    title: fake-provider —— 注册假 web provider 并接管 providerId，让外部资源访问由声明决定
    atomic: fake-provider
    status: active

    source:
      file: src/kinds/resource.ts
      lines: "142-254"
      symbols:
        - "resourceDriver"
        - "ResourceSetup"
        - "WebSearchSpec"
        - "WebFetchSpec"
        - "buildSearchProvider"
        - "buildFetchProvider"
        - "DEFAULT_SEARCH_PROVIDER_ID"
        - "DEFAULT_FETCH_PROVIDER_ID"
        - "describe"
      tests:
        - "tests/resource-driver.test.mjs::buildSearchProvider：返回声明的条目与 content"
        - "tests/resource-driver.test.mjs::buildSearchProvider：available=false 时如实报告不可用"
        - "tests/resource-driver.test.mjs::buildSearchProvider：throws 让 search 抛错"
        - "tests/resource-driver.test.mjs::buildSearchProvider：provider 自身也按 maxResults 裁（与 seam 职责重叠但语义一致）"
        - "tests/resource-driver.test.mjs::buildFetchProvider：默认 200 + html 体"
        - "tests/resource-driver.test.mjs::buildFetchProvider：可声明非 2xx 与 text 体（非 2xx 是结果、不是抛出）"
        - "tests/resource-driver.test.mjs::setup：注册 provider 并接管 searchProviderId"
        - "tests/resource-driver.test.mjs::release：恢复原先的 searchProviderId（不污染宿主配置）"
        - "tests/resource-driver.test.mjs::release：原先没有 providerId 时恢复成 undefined"
        - "tests/resource-driver.test.mjs::act：搜索返回声明结果，且 seam 会按 maxResults 截断"
        - "tests/resource-driver.test.mjs::act：provider 不可用时以点名错误收尾（不静默返回空结果）"
        - "tests/resource-driver.test.mjs::act：fetch 返回声明的状态码与响应体"
        - "tests/resource-driver.test.mjs::setup：宿主没有 web 服务时抛 SkipCase"
        - "tests/resource-driver.test.mjs::act：非 resource 动作直接报错"
        - "tests/resource-driver.test.mjs::driver 元信息：kind 正确，且不静态声明 requires"

    capabilities: ["web"]
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.resource.webSearch = { results: [{ url: 'https://a' }], content: 'C' }"
        when: "setup 阶段注册 provider 并接管 providerId"
        then: "fx.searchProviderId is 'testkit-fake-search'；fx.previousSearchProviderId 记原值（可能 exists 为 false）；provider 注册经 Fixture 登记"
        verdict: pass
      - given: "setup.resource.webFetch = {}"
        when: "setup 阶段"
        then: "fx.fetchProviderId is 'testkit-fake-fetch'；fx.previousFetchProviderId 记原值"
        verdict: pass
      - given: "场景结束（Fixture 释放）"
        when: "读取宿主 web 服务的 providerId"
        then: "searchProviderId / fetchProviderId 恢复为 setup 前的值（不污染宿主配置）"
        verdict: pass
      - given: "setup.resource.webSearch = { results: [{url:'a'},{url:'b'},{url:'c'}] }"
        when: "act: { kind: resource, resource: { search: { query: 'q', maxResults: 2 } } }"
        then: "fx.searchSourceCount is 2；fx.searchTruncated is true；fx.providerSearchLastQuery is 'q'；fx.providerSearchCalls is 1"
        verdict: pass
      - given: "setup.resource.webSearch = { available: false }"
        when: "act: { kind: resource, resource: { search: { query: 'q' } } }"
        then: "fx.searchError 是非空字符串（点名错误码，不静默返回空结果）；fx.searchResult exists 为 false"
        verdict: fail
      - given: "setup.resource.webSearch = { throws: 'web down' }"
        when: "act search"
        then: "fx.searchError contains 'web down'"
        verdict: fail
      - given: "setup.resource.webFetch = { statusCode: 404, kind: 'text', body: 'no' }"
        when: "act: { kind: resource, resource: { fetch: { url: 'https://x' } } }"
        then: "fx.fetchStatusCode is 404；fx.fetchBody is 'no'；fx.fetchError exists 为 false（非 2xx 是结果，不是抛出）"
        verdict: pass
      - given: "宿主没有 web 服务"
        when: "setup 或 act"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "web 服务不提供 registerSearchProvider() / registerFetchProvider()"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip
      - given: "act 收到非 resource 动作"
        when: "把非 resource 的 StepAction 交给 resource driver"
        then: "throws 为 true，错误信息 contains 'resource driver 只支持'"
        verdict: fail

    cleanup: registered

    nonDeterministic:
      - field: "fx.searchError / fx.fetchError 文本"
        reason: "错误消息由宿主 seam 抛出，含点名错误码，字符串可变"
        reconcile: "normalize:normalize-message"
      - field: "fx.previousSearchProviderId / previousFetchProviderId"
        reason: "取决于运行该场景的宿主 profile 配置（本机通常配了 bing / deepseek-official）"
        reconcile: "ignore"
      - field: "fx.searchSources[] 的宿主侧附加字段"
        reason: "seam 可能在 provider 返回的条目上补字段"
        reconcile: "normalize:superset-of-declared"

    equivalence:
      verdict: exact
      error: normalize-message
      previousProviderId: ignore
---

## fake-provider

**为什么必须"接管 providerId"而不只是注册 provider**（源码 4-23 行的实测语义表）：

| 情形 | 结果 |
|---|---|
| 配置的 id 已注册且 `available()` | 用它 |
| 配置的 id 未注册 | `WEB_PROVIDER_CONFIGURED_MISSING` |
| 配置的 id 已注册但不可用 | `WEB_PROVIDER_CONFIGURED_UNAVAILABLE` |
| 未配 id，恰好一个可用 | 用它 |
| 未配 id，多个可用 | `WEB_PROVIDER_AMBIGUOUS` |
| 未配 id，没有可用 | `WEB_PROVIDER_UNAVAILABLE` |

**注册 ≠ 会被选中**：真实 profile 里通常已经配了 `deepseek-official` 或 `bing`，光注册一个假 provider 拿不到它。
所以 setup 显式写 `ctx.web.searchProviderId`（该属性可写，`dsh-free-search` 就是这么运行时接管的），
并在 Fixture 释放时**恢复原值**——这样场景行为确定，且不污染宿主配置。

**`onSearch` 记账穿透子 agent**：provider 的每次调用都写 `fx.providerSearchCalls` / `Queries` / `LastQuery` /
`LastSourceCount`，**包括不是本场景主动发起的那些**（例如被派生的子 agent 在自己的会话里调 `web_search`）。
没有它，组合场景无法证明"宿主级替身真的穿透到了子 agent"。

**假 provider 的声明面**：search 支持 `providerId` / `available` / `results` / `content` / `throws`；
fetch 支持 `providerId` / `available` / `statusCode` / `body` / `kind`（`html` | `text`，缺省 `html`）/ `throws`。
非 2xx 是**结果**而不是抛出。

### 边界与已知缺陷

1. **文件头的"未实现"清单已过时**：`src/kinds/resource.ts:25-31` 仍写"**未实现**：`ctx.fs`（沙箱拒绝、并发写）、
   `ctx.subprocess`（非零退出码）"，但 `src/kinds/fs.ts` 与 `src/kinds/shell.ts` 早已实现并被注册
   （`src/kinds/index.ts:107-109`）。以注释为准会误判覆盖范围。
2. **`capabilities: ["web"]` 与旧实现的静态声明不一致（计划期 vs 运行期）**：旧实现写 `requires: []`
   （`resource.ts:145-147`，注释说是"避免只测 fetch 的场景被 web 能力判定误伤"），能力探测放在 setup/act 里抛 `SkipCase`。
   本 spec 声明 `["web"]`，会让阶段 1 的 `validate` 在**计划期**就判 skip，而不是跑起来才发现。
   两者最终结论（skip）相同，但**判定时机不同**，且旧实现的取舍（避免最早期误伤）在新结构下应被明确采用哪一侧——
   这是一处需要设计裁决的点，不是可以默默改掉的细节。
3. **`fx.searchTruncated` 的来源不明（A3 隐患）**：provider 自己就按 `request.maxResults` 裁并置 `truncated`
   （源码 101-105），而注释说"seam 会按 maxResults 截断并置 truncated"。也就是说这个布尔值**可能由 provider 置位、
   也可能由 seam 置位**，上层无法区分究竟是谁截的。测试名也承认"职责重叠但语义一致"。
4. **错误码只在文本里**：`describe()` 把头 `code` 拼进消息（`Error[CODE]: msg`），没有独立的
   `fx.searchErrorCode` / `fetchErrorCode` 字段。断言只能 `contains`，无法精确 `is`——
   与 `session.extractGoalCode`、`fs.extractFsCode`（都抽独立字段）的处理方式不一致。
5. **`fx.searchResult` 整个对象进 notes**：provider 声明的所有 sources 会原样进报告，报告体积随声明线性增长；
   而 `searchSources` 已经提供了同一份数据的切片。属于重复取证。

## 测试覆盖

`tests/resource-driver.test.mjs`（15 个用例）覆盖两个假 provider 的纯函数行为、providerId 接管与恢复、
截断语义、不可用与抛错两条降级路径。**单个原子有既有测试覆盖**，无缺口。
