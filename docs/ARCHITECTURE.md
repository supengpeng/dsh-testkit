# dsh-testkit 架构设计

> 版本 0.1.0 · 对应 DSH `0.2.0-rc.2`

## 1. 定位

**dsh-testkit 是一个可以装进 DSH 的"测试场景宿主"。**

它不锁定任何单一被测对象。它的输入是 **issue**，输出是 **可复现的测试场景**：

```
issue（你给我的缺陷报告 / 边界描述 / 需求）
   │  ① 提炼（人 + 模型）
   ▼
cases/<CASE-ID>.yaml        声明式场景数据：要制造什么条件、期望发生什么
   │  ② 归位（选择场景 kind）
   ▼
src/kinds/<kind>.ts         该 kind 的 driver：把声明变成对活宿主的具体干预
   │  ③ 执行（内置 runner 或 CI）
   ▼
runs/<RUN-ID>/               运行记录 + Markdown/JSON 报告
```

**每一次迭代 = 一批 issue → 一批 case → 必要时补一个 kind driver。** 场景数据持续累积，插件能力随 kind 增长而扩张。

### 设计目标

| 目标 | 说明 |
|---|---|
| 场景即数据 | 新增一个测试场景，理想情况下**只加一个 YAML 文件**，不改代码 |
| 干预可回滚 | 任何对宿主的干预都必须可撤销，场景之间互不串扰 |
| 双轨执行 | 同一份 case 既能"在活宿主里跑"，也能"导出成 CI 用例跑" |
| 双半可见 | host 半能造条件，client 半能看结果 |
| 迭代可追踪 | 每个 case 能溯源到来源 issue，形成回归资产 |

### 非目标

- 不做通用单元测试框架（那是 `node:test` / `vitest` 的事）
- 不做被测对象的业务逻辑（只负责"造条件 + 断言 + 报告"）
- 不在第一版追求场景数据的完全声明式（复杂场景允许 driver 提供参数化的行为）

---

## 2. 核心概念

| 术语 | 含义 | 载体 |
|---|---|---|
| **Case（场景/用例）** | 一份声明式测试数据，描述"条件 → 期望" | `cases/*.yaml` |
| **Kind（场景类型）** | 一类干预点的归类，决定由哪个 driver 执行 | YAML 的 `kind` 字段 |
| **Driver（驱动）** | 把某个 kind 的声明变成对宿主的具体干预与断言 | `src/kinds/*.ts` |
| **Fixture（夹具）** | driver 在 setup 阶段安装的可回滚干预集合 | `src/runtime/fixture.ts` |
| **Run（运行）** | 一次执行 case 的过程与结果 | `runs/<RUN-ID>/` |
| **Step（步骤）** | case 内的一个动作/断言单元 | YAML 的 `steps[]` |
| **Sink（收纳）** | 运行记录的落地位置（会话 / 文件 / 两者） | `src/report/*` |
| **Export（导出）** | 把 case 转成外部测试框架可执行的形态 | `src/export/*` |

### 关键洞察：DSH 的注册模型天然就是夹具模型

DSH（Cordis）里几乎所有扩展点都是**"注册即返回 disposer"**：

```ts
ctx.tools.register(def)        // → () => void
ctx.effect(fn, label)          // → () => void，作用域销毁时自动回滚
ctx.on('tools/pre-execute', l) // → () => void
ctx.commands.register(def)     // → () => void
```

这意味着**制造测试条件 = 安装可回滚的注册**，拆除条件 = 调用 disposer。
dsh-testkit 不需要发明隔离机制，它只需要**把这一点系统化**：所有 driver 的干预都通过 `Fixture` 收集，`teardown` 时逆序释放。

---

## 3. 总体架构

```
┌──────────────────────── DSH Host（Node 进程，活宿主）─────────────────────────┐
│                                                                              │
│  模型 / 用户                                                                  │
│     │ 工具调用                     ┌──────── dsh-testkit（host 半）─────────┐ │
│     ├─────────────────────────────▶│                                      │ │
│     │ 人类命令 /testkit            │  tools.ts   commands.ts   remote.ts  │ │
│     └─────────────────────────────▶│      │          │            │       │ │
│                                    │      └────┬─────┴────────────┘       │ │
│                                    │           ▼                          │ │
│                                    │    ┌─────────────┐                   │ │
│                                    │    │  runtime/   │ 引擎层           │ │
│                                    │    │ runner      │ 加载→夹具→执行    │ │
│                                    │    │ fixture     │ →断言→记录        │ │
│                                    │    │ assert      │                   │ │
│                                    │    └──────┬──────┘                   │ │
│                                    │           ▼                          │ │
│                                    │    ┌─────────────┐  ┌──────────────┐  │ │
│                                    │    │  kinds/*    │◀─│ cases/*.yaml │  │ │
│                                    │    │ 驱动层       │  │ 数据层        │  │ │
│                                    │    └──────┬──────┘  └──────────────┘  │ │
│                                    └───────────┼──────────────────────────┘ │
│                                                │ 干预（可回滚注册）           │
│   ┌────────────────────────────────────────────┼──────────────────────────┐ │
│   │ ctx.tools │ llm/stream │ systemPrompt │ approval │ userQuestions │ fs │ │
│   │ ctx.commands │ ctx.web │ ctx.webServer │ ctx.subprocess │ agentLoop   │ │
│   └───────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
                                    ▲
                     host.call / remote
                                    │
┌────────────────────── DSH Web（浏览器）──────────────────────────────────────┐
│  dsh-testkit（client 半）                                                     │
│   conversation.view →「测试」标签页（场景列表 · 运行 · 结果）                    │
│   tool.call.toolview → 测试工具的定制渲染                                      │
│   settings.section   → 测试插件设置页                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. 目录结构

```
dsh-testkit/
├── package.json              dsh.bundle.patch（host 半）+ dsh.client（client 半）
├── tsconfig.json             host 半编译（tsc → lib/）
├── tsconfig.client.json      client 半类型检查
├── dsh/
│   └── cordis.patch.yml      bundle 入口：一行 insert
├── scripts/
│   ├── build-client.mjs      client 半打包 → lib/client.js
│   └── verify-cases.mjs      cases/*.yaml 的 schema 校验（CI 用）
├── src/
│   ├── index.ts              host 半插件入口（name / inject / apply / Config）
│   ├── config.ts             schemastery Config schema
│   ├── cases/                【数据层】场景数据的读取与注册
│   │   ├── types.ts          Scenario / Step / Expect 的类型定义
│   │   ├── schema.ts         运行时结构校验（不引第三方 schema 库）
│   │   ├── loader.ts         扫描 cases/、解析 YAML、构建索引
│   │   └── registry.ts       已加载场景的内存注册表 + 变更通知
│   ├── kinds/                【驱动层】每类干预点一个 driver
│   │   ├── index.ts          kind → driver 注册中心
│   │   ├── types.ts          Driver 接口契约
│   │   ├── llm.ts            llm/stream 干预
│   │   ├── tool.ts           工具注册与结果干预
│   │   ├── prompt.ts         系统提示注入
│   │   ├── interaction.ts    用户提问 / 审批应答
│   │   ├── session.ts        会话事件与命令
│   │   ├── resource.ts       fs / subprocess / web
│   │   └── agent.ts          端到端：驱动真实 agent
│   ├── runtime/              【执行层】
│   │   ├── fixture.ts        夹具容器（安装 + 逆序释放）
│   │   ├── runner.ts         执行引擎（串行/并行、超时、取消）
│   │   ├── assert.ts         断言求值
│   │   └── runlog.ts         运行记录数据结构
│   ├── report/               【报告层】
│   │   ├── markdown.ts
│   │   └── json.ts
│   ├── export/               【导出层】case → CI 用例
│   │   ├── node-test.ts
│   │   └── pure.ts           纯函数可测部分的导出
│   ├── host-facade.ts        ★ 唯一直接依赖 DSH API 的适配点
│   ├── tools.ts              暴露给模型的工具（testkit_*）
│   ├── commands.ts           人类命令（/testkit ...）
│   ├── http.ts               client 通道：webServer 路由 + JSON 信封
│   └── client/               【client 半】浏览器侧
│       ├── index.ts          client 插件入口（{name, inject, apply}）
│       ├── bridge.ts         callHost：经 HTTP 调 host 半
│       ├── console.tsx       测试控制台（挂 conversation.view）
│       ├── dict.ts           zh/en 词典
│       └── types.ts          client 侧窄接口
├── cases/                    【数据层落地】一案一 YAML
│   ├── index.yaml            索引：case → issue 溯源、kind 分组
│   ├── README.md             怎么写一个 case
│   └── <CASE-ID>.yaml
├── docs/
│   ├── ARCHITECTURE.md       本文
│   ├── DEVELOPMENT.md        开发、构建、安装、调试
│   ├── SCENARIO-SPEC.md      场景 YAML 规范
│   ├── ISSUE-PIPELINE.md     issue → 测试数据 的作业流程
│   └── ROADMAP.md            分阶段迭代计划
├── runs/                     运行产物（git 忽略）
└── tests/                    插件自身的单元测试
```

---

## 5. host 半架构

### 5.1 插件入口

与 DSH 插件惯例一致（对照 `dsh-memory`、`dsh-context`）：

```ts
export const name = 'dsh-testkit'
export const inject = ['tools']            // 硬依赖；其余能力运行时探测
export interface Config { /* 见 config.ts */ }
export function apply(ctx: Context, config: Config): void
```

**依赖策略**：只把 `tools` 声明为硬依赖（保证最小宿主也能激活）。
`commands` / `systemPrompt` / `web` / `webServer` / `subprocess` 等按需 `ctx.get()` 探测，缺失则降级并告警——沿用 `dsh-memory` 的教训（强声明可选服务会让插件在最小宿主里永远 PENDING）。

### 5.2 数据层：case 的加载

```
启动 → 解析 casesDir → 扫描 *.yaml → 逐个 parse + schema 校验 → 注册表
                                            ↓ 失败
                                    记为 invalid（不阻断启动，可在 UI 看到）
```

设计要点：

- **失败不阻断**：单个 YAML 写错不能让插件起不来；错误进 `registry.invalid[]` 并在工具/UI 中暴露。
- **热更新**：监听 `casesDir`（`ctx.fs.watch` 或 `node:fs.watch`），文件变化时增量重载。
- **索引纪律**：`cases/index.yaml` 只存"溯源与分组"元数据；**case 的真相在各自文件里**，避免单文件成为合并冲突热点。

### 5.3 驱动层：Driver 契约

```ts
export interface Driver<T extends Scenario = Scenario> {
  /** 该 driver 负责的 kind。 */
  readonly kind: ScenarioKind
  /** 在活宿主里安装干预，返回夹具与可选的运行期句柄。 */
  setup(ctx: Context, scenario: T, fx: Fixture): Promise<DriverHandle>
  /** 在干预生效后执行动作（可选；纯被动场景可省略）。 */
  act?(handle: DriverHandle, fx: Fixture): Promise<void>
  /** 场景结束后的额外清理（fixture 之外的资源）。 */
  teardown?(handle: DriverHandle): Promise<void>
}
```

`DriverHandle` 是一个自由形状的对象，driver 用它把"运行期产生的可断言数据"（收到的请求、被改写的参数、命中的次数）暴露给断言层。

**为什么用 driver + 数据分离，而不是纯声明式？**

纯声明式 schema 会让复杂场景（"第 3 次请求才失败，前两次正常"）变成一门自造的小语言，维护成本高于收益。
现在的取法是：**数据负责描述"什么条件、什么期望"，driver 负责"怎么做到"**。新场景只写 YAML；新*类型*的场景才写 driver。

### 5.4 夹具：Fixture

```ts
export class Fixture {
  /** 登记一个可回滚的干预；逆序释放。 */
  add(label: string, dispose: () => void | Promise<void>): void
  /** 收集干预期间产生的证据（供断言与报告使用）。 */
  note(key: string, value: unknown): void
  /** 逆序释放全部干预；单个释放失败不阻断其余释放。 */
  async release(): Promise<ReleaseReport>
}
```

约束（**写 driver 时必须遵守**）：

1. 任何注册都必须经 `Fixture.add` 登记，禁止裸注册。
2. 释放必须幂等——DSH 的作用域销毁可能与我们自己的 teardown 竞争。
3. 干预必须**作用域化**（优先挂到与被测 agent 相关的子作用域），避免污染其他会话。

### 5.5 执行引擎

```
run(caseIds, options)
  ├─ 选择：按 id / kind / tag / 全量
  ├─ 并发：默认串行（活宿主状态共享，串行最可预测）；--parallel 需显式开启
  ├─ 逐 case：
  │    ├─ 建 Fixture
  │    ├─ driver.setup()
  │    ├─ driver.act()
  │    ├─ 逐步求值 steps[].expect
  │    ├─ fixture.release()   ← 无论成败都必须执行
  │    └─ 记录 RunResult
  ├─ 汇总：通过 / 失败 / 跳过 / 错误
  └─ 报告：Markdown + JSON → runs/<RUN-ID>/
```

**超时与取消**：每个 case 有独立超时（默认 30s，可 per-case 覆盖）；整个 run 支持 `AbortSignal` 取消。超时视为 fail（区别于 error）。

### 5.6 对外暴露面

| 面 | 名称 | 用途 |
|---|---|---|
| 工具 | `testkit_list` | 列出场景（可按 kind/tag 过滤），含 invalid 项 |
| 工具 | `testkit_run` | 运行场景，返回结构化结果摘要 |
| 工具 | `testkit_report` | 读取某次 run 的报告 |
| 工具 | `testkit_export` | 导出为 CI 用例 |
| 命令 | `/testkit` | `list` / `run <id>` / `run --kind llm` / `report` / `reload` |
| HTTP | `/api/dsh-testkit/{list,run,report,reload}` | client 半的读取与触发通道（**唯一**通道，理由见 §6.3） |

---

### 5.7 headless 宿主（CI 轨的载体）

```
src/headless/
├── index.ts        createHeadlessHost()：组装最小宿主
└── services.ts     各服务的最小实现（含契约语义）
```

**它不是 DSH**，而是一个契约一致的替身。用途有两个：测试，以及**让导出的
CI 用例自带宿主**（见 `src/export/node-test.ts`）。

| 提供 | 不提供 |
|---|---|
| `tools`（注册表 + guard + `arguments` 校验） | `fs`、`subprocess`、`agentLoop` |
| `llm`（走 `llm/stream` waterfall） | `session`、`storage`、`timer` |
| `systemPrompt`（section / context / variable + `assemble`） | `client` |
| `web`（完整 provider 选择规则表 + seam 截断） | |
| `commands`、`userQuestions`、`approval`、`webServer` | |

**能力边界即验证边界**：

- 「driver 逻辑对不对」→ headless 能验证
- 「与真实 DSH 的交互一致吗」→ **不能**，必须在活宿主上验证

所以 headless 为绿、活宿主为红 ⇒ 问题在宿主交互层（作用域 / 生命周期 / 真实配置）。
这句话是使用说明，不是免责声明——它决定了 CI 轨与活宿主验证**不能互相替代**。

> **替身纪律**：`services.ts` 里的每个服务都按其**真实契约**实现关键语义，
> 而不是"够用就行"。反例：若 `web` 退化成"直接用最后注册的 provider"，
> `resource` driver 的 providerId 接管逻辑就测不出来。
> **替身与真实契约不一致，比没有替身更危险**——它给出绿色的假象。

---

## 6. client 半架构

### 6.1 产物契约（已实测确认）

client 半**不是**普通 ESM 模块，而是被打包成 DSH 的模块加载器入口：

```js
window.__ModuleLoader__.load({
  id: 'dsh-testkit',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    /* …bundle 内容… */
    module.exports = { name: 'dsh-testkit', inject: ['slots', 'locale'], apply }
    return module.exports;
  }
});
```

要点（来自 `@deepseek-ai/dsh-client-modules` 的包文档，已逐条核对）：

- 导出形态是 Cordis 插件：`{ name, inject, apply(ctx) }`
- **惰性 CJS 模型**：执行 bundle 只注册 factory；模块主体副作用（含 CSS 注入）在 **物化时**
  才运行，所以插件首次被使用之前什么都不跑
- `require` 解析顺序：平台 seed 表 → 已记忆记录 → 启动图 row → 已注册 factory，其余一律抛错
- 基座 `PLATFORM_MODULES`（React、Cordis 与静态 UI 库）之外的模块请求必须写进
  `dsh.client.external`，否则组合阶段直接拒绝
- 只支持**自包含 chunk**：入口与 chunk 产物不能同步 `require` 另一个相对 `client*.js` 产物
  （本插件是单文件 bundle，天然满足）
- **缺失 `lib/client.js` 会明确导致激活失败**，并列出包名与路径——所以 client 半必须先构建
- **revision 由入口的 `mtimeMs` / `ctimeMs` / 大小派生**（不对内容求哈希）。推论很重要：
  重建 `lib/client.js` 后刷新页面即加载新版本，**不需要重建 DSH 的 Web 产物**
- 打包器：`esbuild`（本仓），与 `dsh-context` 用 `tsdown` 的产物形态等价
- client 侧可用符号：`React`、`console`、`styles.insert`、`ctx`（服务）。
  ⚠️ **没有 `host.call`**——那是动态包沙箱的符号，理由见 §6.3

### 6.2 Slot 落点

| Slot | kind | 用途 |
|---|---|---|
| `conversation.view` | list | **主入口**：会话内「测试」标签页，Chat/Trajectory 旁 |
| `tool.call.toolview` | keyed | 为 `testkit_*` 工具定制渲染（场景卡片、结果表） |
| `settings.section` | list | 插件设置页（casesDir、并发、超时、导出目标） |
| `conversation.input.right` | list | 快捷「重跑上次场景」按钮（后续） |
| `sidebar.right.*` | keyed | 独立测试面板（后续，需要更大视野时） |

注册写法（对照 `dsh-streamfold` 的实测用法）：

```ts
ctx.slots.inject('conversation.view', () =>
  ctx.slots.register(
    { name: 'conversation.view', id: 'testkit', order: 30, locale: NS, label: () => t('tab') },
    (props) => React.createElement(ConsoleView, props),
  ),
)
```

### 6.3 数据流与通道（**已实测定论**）

**通道选型：自建 HTTP bridge，不用 `host.call`。**

DSH 确实提供包私有 RPC `host.call(method, args)`，但它是**动态包专属**机制：

- host 端是 `harness.handle(method, fn)`，定义在
  `@deepseek-ai/dsh-cordis-host-runner/lib/types/guard.js` 的沙箱边界归一化器里
  （原文："the `harness.handle` invoke-handler normalizer, the SANDBOX CONTEXT"）；
- 由 `dsh-cordis-client-runner` 在求值动态包源码时注入给浏览器半
  （其 README 明写浏览器半「拿到一组固定的名字——`React`、`console`、`styles` 与 `host`」）；
- **静态插件**的浏览器半由 `dsh-client-modules` 装载，其 `lib/client.js` 里**没有任何 builtin
  注入逻辑**；已装的两个静态插件也都不使用它——
  `dsh-free-search` 自建 `/api/dsh-free-search-settings` bridge（源码注释：
  「配置读写走自建 bridge，不依赖 dsh-web-ui」），`dsh-model-extension` 复用官方已有的
  `ctx.remote.*` namespace。

因此本插件走**已被实战验证**的路径：

```
host 半（真相源：CaseRegistry + runlog）
   │  ctx.webServer.register({ kind: 'exact', path: '/api/dsh-testkit/<method>', handler(req, res) })
   ▼   POST JSON  ↕  { ok: true, value } | { ok: false, code, message }
client 半 src/client/bridge.ts：callHost('list' | 'run' | 'report' | 'reload')
   ▼
ConsoleView（场景表 → 触发运行 → 展示结果）
```

端点契约（两侧共用 `BRIDGE_PREFIX = '/api/dsh-testkit'`；host 侧实现见 `src/http.ts`）：

| 端点 | 作用 | 返回 |
|---|---|---|
| `POST /list` | 场景清单 + 无效项 + 索引问题 | `ScenarioListPayload` |
| `POST /run` | 运行（可带 `ids` / `kinds` / `tags`） | `RunPayload`（含 totals 与报告路径） |
| `POST /report` | 取最近或指定 run 的 Markdown | `{ runId, markdown }` |
| `POST /reload` | 重扫场景目录 | 计数摘要 |

原则：**client 半不持有真相**——场景与运行记录都在 host 半，client 只做投影与触发
（与 `dsh-context` 把重集合放在 host 端 detail endpoint 的做法一致）。

降级：宿主没有 `webServer` 能力时不注册通道，client 面板显示通道错误，
**host 半的工具面与命令面完全不受影响**。

### 6.4 client 半的构建

`scripts/build-client.mjs`：

```js
await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', /^@deepseek-ai\//],
  banner: { js: `window.__ModuleLoader__.load({ id: "dsh-testkit", factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: `return module.exports; } });` },
  outfile: 'lib/client.js',
})
```

---

## 7. 场景 kind 分类学

分类学的依据是 **DSH 的干预点**，不是业务领域。这样"新 issue 该归到哪一类"永远有确定答案。

| kind | 干预点（DSH 侧） | 典型 issue 场景 |
|---|---|---|
| `llm` ✅ | `llm/stream` waterfall | 畸形流、中途断流、重试、路由错、token 计数异常 |
| `tool` ✅ | `ctx.tools.register`、**`ctx.tools.guard`**、`tools/execute` | 工具未注册、参数校验、权限拦截、结果过大、超时、并发调用 |
| `prompt` ✅ | `ctx.systemPrompt.section/context/variable`、`assemble()` | 提示词缺失、顺序错乱、变量未替换、上下文超预算 |
| `interaction` ✅ | `user-questions/request`、`approval/request` | 用户不答、答超时、审批拒绝、连续提问 |
| `session` ⚠️ | `ctx.commands.register`（**已实现**）；`session/event`、`session/flush`、`ctx.goals`（**未实现**） | 命令行为、会话事件丢失、日志乱序、压缩边界 |
| `resource` ⚠️ | `ctx.web` 的 search / fetch provider（**已实现**）；`ctx.fs`、`ctx.subprocess`（**未实现**） | 联网失败降级、文件并发写、沙箱拒绝、子进程非零退出 |
| `agent` | `ctx.agentLoop` / `ctx.agents`（驱动真实 agent）；`ctx.subagents`（一次性派生）／`ctx.agentTeams`（**复用 Agent Teams** 的可续接队友） | 端到端：模型该做什么、工具链是否走通 |
| `ui` | client 半 slot / `ctx.theme` | 渲染错、slot 冲突、主题 token 缺失、交互无响应 |

> **状态标记**：✅ = 已实现（`src/kinds/*.ts`）。未标记的 kind 会把场景记为
> **errored 并明说「driver 尚未实现」**，而不是假装跑过。
>
> `tool` 只用 `tools.guard`（同步拒绝）+ `tools.execute`（真实管道）；
> `tools/pre-execute` / `post-execute` 两条 waterfall 留到 Phase 2——
> 它们的 `next()` 链语义必须先拿活宿主确认，**不猜**。

**归类决策树**（提炼 issue 时使用）：
```
issue 描述的是"模型看到/发出什么"吗？       → llm 或 prompt
issue 描述的是"某个工具的行为"吗？           → tool
issue 描述的是"人要回答/批准什么"吗？        → interaction
issue 描述的是"会话/命令/目标的状态"吗？      → session
issue 描述的是"文件/进程/网络"吗？           → resource
issue 描述的是"端到端结果不对"吗？            → agent
issue 描述的是"界面上看到什么"吗？            → ui
说不清 → 先归 agent（端到端黑盒），跑通后再下沉
```

---

## 8. 关键设计决策

| # | 决策 | 理由 | 代价 |
|---|---|---|---|
| D1 | TypeScript + tsc 直出 `lib/`（不用打包器编 host 半） | 与 `dsh-memory` 一致；产物可读、栈可查、依赖最少 | 无 tree-shaking；`dependencies` 需精简 |
| D2 | host 半与 client 半**分构建**（tsc / esbuild） | 两者运行时环境不同（Node vs 浏览器），产物形态不同 | 两条构建链、两个 tsconfig |
| D3 | 场景数据一案一 YAML | 人可读、diff 干净、单文件不冲突、便于持续追加 | 需要 loader + 索引 |
| D4 | Driver 与数据分离（非纯声明式） | 避免自造 DSL；复杂场景用 TS 表达 | 新*类型*场景需要写代码 |
| D5 | 干预全部走 Fixture 登记 + 逆序释放 | 活宿主测试的最大风险是"污染"，必须可回滚 | driver 作者要守纪律 |
| D6 | 默认串行执行 | 活宿主状态共享，串行结果最可预测 | 慢 |
| D7 | client 半不持有真相 | 避免两半状态分叉 | 每次读取需要一次 RPC |
| D8 | `inject` 只声明 `tools` | 最小宿主也能激活（`dsh-memory` 踩过的坑） | 需要运行时探测 + 降级路径 |
| D9 | case 校验失败不阻断启动 | 一个坏文件不该让插件消失 | 需要把 invalid 项浮到 UI/工具 |

---

## 9. 风险台账

### 9.1 已结案（实测确认）

| # | 问题 | 结论 | 依据 |
|---|---|---|---|
| R1 | 双半通信走什么通道 | **自建 HTTP bridge**。`host.call` / `harness.handle` 属动态包沙箱，静态插件包拿不到 | `dsh-cordis-host-runner/lib/types/guard.js` 的沙箱归一化器；`dsh-client-modules/lib/client.js` 无任何 builtin 注入；`dsh-free-search` 与 `dsh-model-extension` 的实际做法 |
| R2 | `dsh.client` 与 external 语义 | `platform: 'web'` + 导出 `./client`；基座（React / Cordis / 静态 UI 库）**无需**声明，只有基座之外的请求才进 `dsh.client.external` | `dsh-client-modules` 包文档「共享模块」节 |
| R3 | client 半产物格式 | `window.__ModuleLoader__.load({ id, factory })`，导出 `{ name, inject, apply }`；须为自包含单文件 chunk | 本仓 `lib/client.js` 实测（导出面已核对）；`dsh-context` 尾部打包注释 |
| R4 | client 产物改动后是否要重建 Web | **不需要**。revision 由 `mtimeMs` / `ctimeMs` / 大小派生，重建 + 刷新即生效 | `dsh-client-modules` 包文档「增量组合」节 |
| R5 | 缺 `lib/client.js` 的后果 | **明确激活失败**并列出包名与路径（不是静默） | 同上「构建要求」节 |
| R8 | 能否起 **headless 最小宿主**（CI 轨的前提） | 双轨执行里「CI 轨」的成色 | ✅ 可行。`new Context()` + `ctx.provide(...)` 即可组装最小宿主，已用于集成测试，见 `tests/host-apply.test.mjs` |
| — | `ctx.get()` 与属性访问的差异 | 决定能力探测怎么写 | ✅ cordis 4 里 `ctx.someService` 未 `inject` 时**抛错**；`ctx.get(name)` 是唯一安全的可选访问方式（详见下方教训二） |
| — | **15 条场景在真实 DSH 里的表现** | 插件的实际可用性 | ✅ **14 通过 / 0 失败 / 1 跳过 / 0 错误**（独立 headless profile 实测；跳过的是 agent 类，因该 profile 无 subagents 能力——**这是降级机制正确工作的证据**）。**8 个 driver 全部在真实宿主验证** |
| R10 | `headless` profile 下 `userQuestions` / `subagents` **探测不到** | 会不会被误判成"宿主缺能力"而跳过场景 | ✅ **已结案**——不是宿主缺能力，而是能力探测**拍了快照**（cordis 激活是异步的）。改惰性求值后两者都可用，`TK-0007/0009/0014` 由 skipped 转为 passed（详见教训三） |
| — | **十个 kind 是否都有 driver** | 数据层与驱动层是否自洽 | ✅ **全部落地**——`tool` / `prompt` / `llm` / `interaction` / `session` / `resource` / `agent` / `ui` / `shell` / `file`。`verify-cases` 的一致性守卫不再报任何警告 |
| R1/R2/R3/R7 | **client 半（浏览器侧）能否在真实 web profile 里装载并与 host 半通信** | 双半插件的另一半 | ✅ **已在真实 web profile 验证**：bundle 被组合进启动图、`conversation.view` 的「测试」标签渲染、HTTP bridge 4 条路由全部可用（`/list` 返回 200 + 14 条场景）。故 R7 的 `inject` 集合合法 |
| R11 | **复用 Agent Teams 会不会造成不可逆副作用**（`ctx.agentTeams.spawnTeammate()`） | 场景跑一次就可能污染用户的真实团队 | ✅ **已结案并落成机制**：成员记录只写进 Lead 会话日志、`maxMembers` 是组合配置（DSH 的 Agent Teams profile bundle 设为 8，服务内建默认 16）、**没有删除成员的能力**、名字永不复用。处置：team 通道的场景一律 `status: draft`（默认回归集不含）、driver 每次生成 `tk-<caseId>-<rand>` 唯一名、团队不支持的 setup 字段记入 `fx.teammateIgnoredSetup`（不静默）、teardown 对跑飞的成员 `interrupt`。详见 [SCENARIO-SPEC §3.7](SCENARIO-SPEC.md) |

### 9.2 未决项

**当前没有未决风险项**——Phase 0 期间提出的 R1–R10 全部结案（见 §9.1）。

| 项 | 结论 |
|---|---|
| R1–R5、R8、R10 | ✅ 结案（§9.1） |
| R6 热监听 | ✅ 结案：**实测工作**（长期运行的 web profile 下改 YAML 即刻反映） |
| R7 client `inject` 集合 | ✅ 结案：真实 web profile 下装载成功，声明合法 |
| R9 `Scoped<Agent>` 作用域 | ✅ 结案：**源码推导**——root listener 没有 scope tag，不被 `scopeTarget` 过滤。**端到端不可验证**：DSH 不允许被委派的子 agent 进行人工交互（`ask_user_question` 直接返回 `human interaction is unavailable while the calling agent is owned by another live agent`），那条路径不存在 |

**今后若出现新风险**，登记到这里，并写清"影响面 + 验证方式"，
而不是留在口头或对话里。

> **一段值得留下的过程记录**：R6 与 R9 在 Phase 0 长期被标为"待验证"，
> 理由是"需要装进 desktop profile 才能观察"。这个理由**后来被证明是不必要的**——
> 另建独立 profile（`headless` 用于无 GUI 验证、`web` 用于 client 半）各起一个实例，
> 就能观察到，而且全程不碰用户正在用的 desktop。
>
> **教训：「必须等某个条件」有时候只是「还没想到别的办法」。**
> 这个念头让 R6/R9 白白挂了好几轮，而真正的成本只是"造一个有 GUI 的 profile"。

> ### 教训记录：一次被推翻的架构级假设
>
> R1 原先写作「`host.call(method, args)` 的 host 端注册方式」，隐含前提是
> **静态插件包也能用 `host.call`**。这个前提是错的。
>
> 错误的来源值得记下来：我最初从 `cordis_inspect_query` 的 client `Builtin` 列表里看到
> `host.call` 的描述为「Package-private JSON RPC from Client to this Package's Host half」，
> 就把它当成了通用能力。实际上那个 inspect provider 由 `dsh-cordis-client-runner` 提供，
> **只描述动态包的符号面**。
>
> 代价被控制住了：修正只涉及 `src/client/bridge.ts` 与新增 `src/http.ts` 两个文件，
> 引擎层、断言层、夹具层、driver 契约**一行未改**。这正是「driver 不依赖 cordis `Context`、
> 对宿主的调用全部收敛在 `HostFacade` 单点」这条设计纪律（见 README 三条设计要点之三）的价值。

> ### 教训二：`ctx.get()` 与 `ctx.someService` 不是一回事>
> 能力探测最初写成「先 `ctx.get(name)`，拿不到就回退属性访问」。放进真实 cordis 容器
> 立刻炸：`cannot get property "systemPrompt" without inject`。
>
> cordis 4 的语义是：`ctx.someService` 只有在插件 `inject` 了该服务时才可读，否则**抛错**；
> 而 `ctx.get(name)`（DSH 服务契约里 `access.optional.expression` 给出的写法）
> 才是安全的可选访问方式，缺失返回 `undefined`。
>
> 这个 bug 的杀伤力很大：本插件按设计只硬依赖 `tools`、其余 13 项能力靠探测——
> 一旦用属性访问探测，`apply` 会在第一个未注入的服务上抛错，**插件彻底不激活**，
> 表现为工具凭空消失（与 `dsh-memory` 记录过的失效形态同源，也是本仓 `apply` 探针
> 存在的理由）。
>
> 它现在由 `tests/host-apply.test.mjs` 的「只提供 tools」用例守住，作为回归测试长期保留。
> **教训**：能力探测只走 `ctx.get()`；这条纪律写在 `src/host-facade.ts` 的函数头注里。

> ### 教训三：能力探测不能用快照 —— cordis 的激活是**异步**的
>
> 这个是**只有真实验证才能发现**的 bug，而且形态最隐蔽。
>
> **现象**：真实 headless profile 的 `--dump-config` 明确列出了
> `user-questions` 与 `subagent-spawn-in-process` 条目，
> 但插件报「宿主缺少能力」——两条 question 场景与 agent 场景被**错误跳过**。
>
> **根因**：`apply()` 执行时，排在**后面**的插件还没注册服务。
> 在构造 `HostFacade` 时拍一张能力快照，就把"宿主有这个能力"误判成了"没有"。
>
> **修复**：能力集合改为**惰性求值**——`has()` 每次现查
> （见 `src/host-facade.ts` 的 `CapabilitySet`）。
>
> **为什么它最危险**：它不报错、不崩溃，只是**安静地把本该跑的场景跳过**。
> 而 `skipped` 在报告里看起来像"环境不支持"，很容易被当成正常。
> 实测修正后，`TK-0007` / `TK-0009` / `TK-0014` 从 skipped 变成 passed。
>
> **教训**：**凡是"探测外部状态"的地方，都要问一句"这个状态此刻稳定了吗"**。
> 异步激活的环境里，快照默认是错的。
>
> 这条也反过来证明了真实验证的价值——前 11 轮里它一直藏着，
> 而且随着 driver 增多，影响面只会越来越大。

> ### 教训四：依赖的服务可能在 `apply()` **之后**才就绪 —— 用 `ctx.inject` 等它
>
> 与教训三**同源**（都是异步激活），但表现与修法不同。
>
> **现象**：在真实 web profile 下，host 半**明明激活了**（`testkit_list` 工具可用、
> 模型能调、回答"共 14 条测试场景"），但 `/api/dsh-testkit/*` **一律 404**。
> client 半的控制台只能显示「host 半返回了非 JSON 响应（HTTP 404）」。
>
> **根因**：路由注册写在 `apply()` 里，而 `apply()` 执行时 `webServer` **还没注册**。
> `ctx.get('webServer')` 返回 `undefined`，整段注册被跳过——而 `apply()` 只执行一次，
> **没有第二次机会**。
>
> **诊断过程值得记下**：这个问题靠读代码定位不了。加了一个把关键事实**直接写盘**的
> 探针（`~/.dsh/logs/dsh-testkit-bridge.log`，不依赖 DSH logger），才看到那行
> `能力探测：不具备 webServer`——而同一进程里工具明明可用。两条信息一对照，根因就出来了。
>
> **修复**：改用 `ctx.inject(['webServer'], cb)`，服务就绪后回调再注册
> （`dsh-free-search` 同样如此）。
>
> **教训**：`apply()` 里**不能假设可选服务已就绪**。凡是"依赖别的插件提供的服务"，
> 都要用 `ctx.inject` 或等价机制等它。

> ### 教训五：构建脚本删掉了另一半产物（工程缺陷，不是运行时 bug）
>
> `build` 脚本是 `rmSync('lib') → tsc`，只产出 host 半；
> 而 `gate` 里**没有** `build:client`。于是每次跑完 gate，`lib/client.js` 就消失了。
>
> **表现**：GUI 里「测试」标签**凭空不见**，host 半一切正常。
> `dsh-client-modules` 那条"缺 `client.js` 会明确激活失败"的提示在浏览器控制台里，
> 被 DSH 自身的日志淹没了，很难一眼看到。
>
> **修复**：`gate` 里补上 `build:client`（见 [DEVELOPMENT §3](DEVELOPMENT.md) 的警告框）。
>
> **教训**：**验证脚本本身也要被验证。** gate 通过不等于产物完整——
> 它只证明"它检查的那些事"成立。一个会把工作区弄坏的 gate，比没有 gate 更糟。

---

## 10. 扩展点速查：新增一个场景要动什么

| 情况 | 需要动的东西 |
|---|---|
| 新场景，已有同类 kind | 只加 `cases/<ID>.yaml` |
| 新场景，需要现有 driver 未覆盖的参数 | 扩 `src/kinds/<kind>.ts` 的参数处理 + `SCENARIO-SPEC.md` |
| 新场景，属于**全新干预点** | 加 `src/kinds/<new>.ts` + 在 `kinds/index.ts` 注册 + 更新本文档 §7 与 §SCENARIO-SPEC |
| client 半展示新内容 | 加 `src/client/*.tsx` 组件 + 必要时扩 `remote.ts` |

---

## 相关文档

- [开发与调试](DEVELOPMENT.md) —— 怎么把它跑起来
- [场景数据规范](SCENARIO-SPEC.md) —— YAML 怎么写
- [issue 提炼流程](ISSUE-PIPELINE.md) —— 你给我 issue 后我做什么
- [迭代计划](ROADMAP.md) —— 分阶段做什么
