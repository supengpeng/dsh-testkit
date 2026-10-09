# 迭代计划（Roadmap）

> 原则：**先把"能造条件、能看结果"的最小闭环跑通，再靠 issue 迭代长能力。**
> 每个 Phase 都以"能处理哪类 issue"为验收标准，而不是以代码量为标准。

---

## Phase 0 · 骨架与通道验证

**目标**：确认双半插件的两条链路真的通。

| # | 交付物 | 状态 |
|---|---|---|
| 0.1 | 工程可构建 | ✅ `pnpm run gate` exit 0；`lib/index.js` + `lib/client.js` 均产出且形态已核对 |
| 0.2 | 通道选型定论 | ✅ R1–R5 结案（依据见 [ARCHITECTURE.md §9.1](ARCHITECTURE.md)）；实现为**自建 HTTP bridge** |
| 0.3 | host 半可装配 | ✅ 在**真实 cordis 容器**里装配通过：4 工具 + 1 命令 + 4 路由（`tests/host-apply.test.mjs`） |
| 0.4 | headless 宿主可行（CI 轨前提） | ✅ 无需完整 DSH，`new Context()` + `ctx.provide()` 即可（原 R8 结案） |
| 0.5 | 插件装进 profile 并激活 | ✅ **已完成**——装进独立的 `tk` profile（headless 模板派生），工具注册成功、模型可调用 |
| 0.5b | **13 条场景在真实 DSH 里执行** | ✅ **11 通过 / 0 失败 / 2 跳过 / 0 错误**（详见下方「真实验证结果」） |
| 0.6 | client 半装载、「测试」标签出现 | ✅ **已在真实 web profile 验证**——「测试」标签渲染在「对话 / 轨迹」旁 |
| 0.7 | 双半通信端到端 | ✅ **HTTP bridge 4 条路由全部可用**；`/list` 返回 200 + 14 条场景，控制台完整渲染 |
| 0.8 | 剩余风险 R6 / R7 结论 | R7 ✅ 结案（`inject` 集合合法）；R6 热监听仍待验证（手动 `/testkit reload` 始终可用） |

### 真实验证结果（独立 profile + headless 模式）

**怎么做的**：不碰 desktop profile，另建一个从 `headless` 模板派生的独立 profile，
用「答一个任务、打印结果、退出」的方式验证。完整命令见
[DEVELOPMENT.md §5.3](DEVELOPMENT.md)。

| 验证项 | 结果 |
|---|---|
| 插件装进独立 profile 并进入插件树 | ✅ |
| host 半激活、`testkit_*` 工具可被模型调用 | ✅ |
| 场景加载（13 条、kind 分布正确） | ✅ |
| **全部场景执行** | ✅ **14 通过 / 0 失败 / 0 跳过 / 0 错误** |
| `tools.guard` 真实语义（TK-0003） | ✅ 拦截生效且工具本体未执行 |
| `llm/stream` waterfall 真实语义（TK-0005 / TK-0006） | ✅ 接管生效、零上游请求、失败注入正确 |
| `approval/request` 真实语义（TK-0008） | ✅ 全局注册在真实宿主里生效 |
| **`user-questions/request` 真实语义（TK-0007 / TK-0009）** | ✅ 修掉能力探测的时序 bug 后由 skipped 转为 passed |
| **`agent` 端到端（TK-0014）** | ✅ 真实派生 subagent（provider `spawn`）、`stopReason=completed`、输出 `TESTKIT_OK` |
| `systemPrompt.assemble`（TK-0004） | ✅ |
| 命令面（TK-0010 / TK-0011） | ✅ |
| web provider 接管与降级（TK-0012 / TK-0013） | ✅ |
| 能力降级机制 | ✅ 缺能力时**跳过并说明原因**，没有误报失败 |

**client 半（另一个 profile：`tkweb`，从 `web` 模板派生）**：

| 验证项 | 结果 |
|---|---|
| bundle 被组合进启动图 | ✅ index.html 的 combo URL 里出现 `dsh-testkit/client.js` |
| bundle 可被浏览器加载 | ✅ 拉到 401523 字节，含 `__ModuleLoader__.load({ id: "dsh-testkit" … })` |
| `conversation.view` 标签渲染 | ✅ 「测试」标签出现在「对话 / 轨迹」旁 |
| **HTTP bridge 通道** | ✅ 4 条路由注册成功；`POST /api/dsh-testkit/list` → 200 + 14 条场景 |
| 控制台完整渲染 | ✅ 标题、说明、cases 路径、14 行表格（ID / 类型 / 状态 / 标题 / run） |

> **注意这两块必须用不同的 profile 验**：`headless` 没有 `webServer`，
> 而 `web` 没有 headless 的"跑一个任务就退出"模式。两者互补，缺一不可。

> **这一轮最重要的收获不是"通过了"，而是"跳过的方式是对的"。**
> `headless` profile 缺 `userQuestions`，两条 question 场景被如实标为 skipped 并给出原因
> （`宿主缺少能力：userQuestions`）——而不是崩溃、也不是伪装成通过。

**仍未验证**（需带 GUI 的 profile）：client 半装载与「测试」标签页、HTTP bridge 通道、
agent 作用域触发的 `Scoped<Agent>` 事件（R9 的另一半）。

---

## Phase 1 · 核心引擎 + 三个基础 kind

**目标**：能处理"工具/模型/提示词"三类 issue，端到端出报告。

| # | 交付物 | 状态 |
|---|---|---|
| 1.1 | `cases/loader.ts` + `schema.ts`：扫描、解析、校验、invalid 收集 | ✅ |
| 1.2 | `runtime/fixture.ts`：夹具容器（登记 + 逆序释放 + 证据收集） | ✅ |
| 1.3 | `runtime/runner.ts`：串行执行、超时、取消、结果汇总 | ✅ |
| 1.4 | `runtime/assert.ts`：断言词全表 + `refs.ts` 取值 | ✅ |
| 1.5 | `kinds/tool.ts`：注册临时工具、guard 拦截、真实管道调用取证 | ✅ |
| 1.6 | **`kinds/llm.ts`：接管 `llm/stream`、四种失败注入、用量伪造** | ✅ **本轮完成 — Phase 1 收口** |
| 1.7 | `kinds/prompt.ts`：section / context / variable 注入 + 主动组装取证 | ✅ |
| 1.8 | 工具面：`testkit_list` / `testkit_run` / `testkit_report` | ✅ |
| 1.9 | 命令面：`/testkit list / run / report / reload` | ✅ |
| 1.10 | 报告：`runs/<RUN-ID>/report.md` + `run.json` | ✅ |

**验收**：`cases/TK-0001..0006` 在 headless 宿主里逐条与批量均通过
（`tests/scenario-run.test.mjs`），全仓 **100 测试全绿**。

**Phase 1 至此收口**：`tool` / `prompt` / `llm` 三个 driver 全部落地，
六条场景可在 headless 宿主里确定性跑通。

> **一条值得带进后续阶段的纪律**：`llm` driver 之所以能一次做对，是因为
> **先读源码再动手**——`llm/stream` 的触发点、`next()` 的同步返回、
> `StreamChunk` 的完整联合类型，全部是从 `@deepseek-ai/dsh-llm` 的发行体里读出来的。
> 若按事件目录的签名"想当然"实现，会写出 `next: () => Promise<...>` 的错误拦截器，
> 而它的失效方式恰恰是最难查的那种：**注册成功、静默产出空流**。

---

## Phase 2 · 交互 / 会话 / 资源 kind

**目标**：覆盖面扩到"需要模拟人、需要模拟环境"的 issue。

| # | 交付物 | 状态 |
|---|---|---|
| 2.1 | `kinds/interaction.ts`：接管提问与审批两个 waterfall | ✅ |
| 2.2 | **`kinds/session.ts`：人类命令的注册与驱动（含两条失败路径）** | ✅ **本轮完成** |
| 2.3 | **`kinds/resource.ts`：假 web provider（含不可用 / 抛错降级）** | ✅ **本轮完成 — Phase 2 收口** |
| 2.4 | `requires` 降级机制：缺能力 SKIP 而非 FAIL | ✅（随 Phase 1 各 driver 落地） |
| 2.5 | `repeat` 稳定性验证 | ✅（runner 已实现） |

**验收**：一条「用户不回答提问导致超时」的场景能被自动复现并断言
—— 即 `cases/TK-0009`（全仓 150 测试全绿，13 条场景）。

**Phase 2 至此收口**：`interaction` / `session` / `resource` 三个 driver 落地，
driver 总数达到 **6 个**（`tool` / `prompt` / `llm` / `interaction` / `session` / `resource`）。

**Phase 2 内明确未做的部分**（不是遗漏，是有理由的裁剪）：

| 未做 | 理由 |
|---|---|
| `session/event`、`session/flush` 观测 | `Scoped<Session>` 事件——R9 已证明 headless 测不出作用域差异 |
| `ctx.fs`（沙箱拒绝、并发写） | 沙箱策略依赖宿主配置，语义需活宿主确认 |
| `ctx.subprocess`（非零退出码） | 同上；且真跑进程会让自检变慢变脆 |

三者的共同点：**它们的正确语义取决于宿主配置或作用域，headless 下无法证伪**。
在 Phase 0 安装验证完成前做它们，产出的是"看起来对"的实现。

---

## Phase 3 · client 半控制台

**目标**：不靠对话也能看场景与结果。

| # | 交付物 |
|---|---|
| 3.1 | `client/console.tsx`：场景列表（按 kind/tag/status 筛选） |
| 3.2 | 运行触发 + 实时状态 |
| 3.3 | 结果详情：断言逐条展示、失败高亮 |
| 3.4 | `client/toolview.tsx`：`testkit_*` 工具的定制卡片 |
| 3.5 | `client/settings.tsx`：casesDir、并发、超时、导出目标 |
| 3.6 | 国际化（zh/en 词典） |

---

## Phase 4 · CI 导出（双轨的另一条腿）✅ 完成

**目标**：同一批 case 能在没有 GUI 的环境里跑。

| # | 交付物 | 状态 |
|---|---|---|
| 4.1 | `headless/services.ts`：**产品化**的最小服务集（tools / llm / systemPrompt / web / commands / interaction / webServer） | ✅ |
| 4.2 | `headless/index.ts`：`createHeadlessHost()` 组装最小宿主 | ✅ |
| 4.3 | `export/node-test.ts`：生成**自包含**的 `node:test` 文件 | ✅ |
| 4.4 | `testkit_export` 工具 + `scripts/export-scenarios.mjs`（离线导出） | ✅ |
| 4.5 | 与 gate 合流：每次 gate 都真跑一遍导出的用例 | ✅ |

**验收**：`npm run gate` 里同时跑两轨 —— 内置测试套件 **276 项** ＋ 导出的场景
（默认 20 条；带 `fixture` 标签的 6 条测的是外部被测对象，不进 gate）。

### 关键设计：导出文件是"自包含"的

导出的用例不依赖活宿主——它自带 `createHeadlessHost()`。无 DSH 的 CI 机器上，
只要本包（含 cordis peer）可用就能跑。

> **它证明了什么、没证明什么**（这条边界写在生成物的文件头里，不只写在文档里）：
>
> | 证明了 | 没证明 |
> |---|---|
> | 场景数据合法、driver 逻辑正确、断言可判定 | 与**真实 DSH** 的交互一致（作用域 / 生命周期 / 真实配置） |
>
> CI 轨是**回归网**，不是活宿主验证的替代品。两者都要有。

### 一个副产品：假服务从测试升级为产品代码

原先散落在 `tests/*.test.mjs` 里的测试替身，现在集中在 `src/headless/services.ts`。
这不只是搬家——它带来两条硬约束：

1. **替身必须与真实契约一致**（因为 CI 轨的正确性依赖它）。例如 `web` 服务
   完整复刻了 provider 选择规则表（含 `WEB_PROVIDER_AMBIGUOUS`）与 seam 截断；
   `tools` 如实校验 `arguments` 必须是对象。
2. **替身自己也要被测**（`tests/headless.test.mjs`，21 项）。

> **本轮的收获**：写 headless 服务时发现 `defineTool` 会校验 `arguments` 必须是对象，
> 而原先测试里的替身"宽容地"跳过了这个校验——如果带着这个替身去做 CI 轨，
> 导出用例会掩盖"调用方忘了传参数对象"这类 bug。
> 这是"替身必须与真实契约一致"那条纪律的又一次兑现。

---

## Phase 5 · 端到端 agent 场景 + 常态化迭代

**目标**：进入"你给 issue、我出 case"的稳定节奏。

| # | 交付物 | 状态 |
|---|---|---|
| 5.1 | **`kinds/agent.ts`：派生真实子 agent 跑任务并断言轨迹** | ✅ **本轮完成** |
| 5.2 | 下沉机制：黑盒 agent case → 精确 kind case | ⏳ 纪律已写进 [SCENARIO-SPEC §3.7](SCENARIO-SPEC.md)，还需在实战中检验 |
| 5.3 | 回归集：`/testkit run --tag regression` | ⏳ `--tag` 筛选已可用，缺约定俗成的 `regression` 标签 |
| 5.4 | 迭代记录自动化：每次 run 产出可比对的历史 | ✅ `runs/<RUN-ID>/run.json` 已可逐次比对 |

**验收**：`cases/TK-0014` 在真实 DSH 里派生 subagent 并跑通
（实测 `provider=spawn`、`stopReason=completed`、输出 `TESTKIT_OK`，耗时约 560ms）。

> **agent kind 的使用纪律**：它是**黑盒**用例，适合"端到端结果不对"这类说不清归类的 issue。
> 根因清楚后应**下沉**到精确 kind（`tool` / `llm` / …），黑盒那条保留当回归网。

**常态化**：此后每批 issue 走 [ISSUE-PIPELINE.md](ISSUE-PIPELINE.md)，能力缺口驱动新的 Phase 6+。

---

## Phase 6 · `ui` kind：让 client 半不再有测试盲区 ✅ 完成

**目标**：把"浏览器里的那一半"也纳入可断言的范围。

| # | 交付物 | 状态 |
|---|---|---|
| 6.1 | `kinds/ui.ts`：在隔离 vm 里加载真实 client bundle 并驱动它 | ✅ |
| 6.2 | 假宿主面（`__ModuleLoader__` / `require` / `slots` / `locale`） | ✅ |
| 6.3 | `TK-0015`：产物契约 + slot / 词典注册自检 | ✅ |
| 6.4 | 放进 CI 轨（`requires` 为空，任何宿主都能跑） | ✅ |

**验收**：`TK-0015` 在真实 DSH 里通过，取证为
`uiModuleId=dsh-testkit`、`uiRegisteredSlotNames=["conversation.view"]`、
`uiRegisteredSlots=[{name:"conversation.view", id:"testkit", order:30}]`、
`uiRendererProvided=true`。

**这一步之后，八个 kind 全部有 driver**（`verify-cases` 的一致性守卫不再报任何警告）。

> **它守住的是两类真实踩过的坑**：`lib/client.js` 被构建脚本删掉（GUI 里标签凭空不见）、
> bundle 的导出面或注册名变化（加载静默失败）。
>
> **它不是**渲染测试——React 组件长什么样、像素对不对，仍归浏览器。

### 那还剩什么？

| 项 | 状态 |
|---|---|
| R6 热监听 | ✅ **结案**：长期运行的 web profile 下改 YAML 即刻反映（实测，未重启） |
| R9 `Scoped<Agent>` 作用域 | ✅ **结案**：源码推导——root listener 无 scope tag，不被过滤 |
| 按 issue 迭代 | **等真实 issue 输入**：数据层已就绪，[ISSUE-PIPELINE.md](ISSUE-PIPELINE.md) 定义了流程 |

> **Phase 0 提出的 R1–R10 全部结案。** 剩余的唯一变量是 issue 输入本身。

---

## Phase 7 · 组合场景（跨 kind 的 setup / act）✅ 完成

**目标**：让"先造条件、再用另一种动作驱动"成为可表达的场景——
原先 `scenario.kind` 决定唯一的 driver，组合需求根本无法写出来。

| # | 交付物 | 状态 |
|---|---|---|
| 7.1 | runner：setup 跑「主 kind ＋ setup 里出现的每个 kind 键」 | ✅ |
| 7.2 | runner：act 按**动作形状**分派（而不是固定用主 driver） | ✅ |
| 7.3 | runner：能力判定合并所有参与 driver 的 `requires` | ✅ |
| 7.4 | schema：允许 setup 含其它 kind 键，但拒绝非 kind 键（挡拼写） | ✅ |
| 7.5 | `resource` driver：假 provider 自己记账（供组合场景断言） | ✅ |
| 7.6 | `TK-0016`：假 web provider ＋ 真实子 agent | ✅ |

**验收**：`TK-0016` 在真实 DSH 里通过——
`providerSearchCalls=1`、`providerSearchQueries=["testkit"]`、
`agentStopReason=completed`，且子 agent 的输出里带着我们注入的
`https://testkit.invalid/first`。

> **它证明的性质**：**root 上注册的测试替身会穿透到子 agent 的会话**。
> 这是只测单 kind 时绝对看不到的——组合场景的核心价值就在这里。

> **一条被实测否决的设想**：组合场景最初的动机是端到端验证 R9
> （假答者 + 子 agent 问用户）。实测发现 DSH **不允许被委派的子 agent 进行人工交互**
> （工具直接返回 `human interaction is unavailable while the calling agent is owned by another live agent`），
> 走不到 waterfall。详见 [SCENARIO-SPEC §3.9](SCENARIO-SPEC.md)。
>
> **教训**：把"能写出场景"当成"那条路径存在"是错的。
> 先花一次运行去确认前提，比写完一整套断言再发现前提不成立便宜得多。

---

## Phase 8 · 数据驱动的 driver 开发 ✅ 首批完成

**目标**：用**真实的 issue 数据**驱动 driver 开发，而不是凭空设想需要什么能力。

**输入**：`FuRongJun-1999/dsh-memory` 与 `FuRongJun-1999/lingshu` 的 541 条
issue/PR（其中 238 条带最小复现 + 实测读数/验收判据）。

**从数据里读出来的形态**：绝大多数「可回归候选」的判据都是同一个——
**跑一条命令，看它的输出或退出码**（`python -m md_cg.mcp_server`、
`git apply --check`、`pytest tests/...`）。

| # | 交付物 | 状态 |
|---|---|---|
| 8.1 | `kinds/shell.ts`：跑外部命令并取证退出码 / stdout / stderr | ✅ |
| 8.2 | 令牌 `$NODE` / `$PKG`（不硬编码路径） | ✅ |
| 8.3 | `TK-0018`：shell driver 自检 | ✅ |
| 8.4 | `TK-0019` + `scripts/check-pack-files.mjs`：**从 #48「files 漏件」提炼的通用模式** | ✅ |
| 8.5 | `TK-0017`：多 guard 短路语义（顺带修掉"缺 name 就静默放行"的坑） | ✅ |
| 8.6 | `scripts/from-issue-data.mjs`：**提炼本身产品化**——238 条候选 → 草稿 + 能力缺口报告 | ✅ |
| 8.7 | `kinds/file.ts` + `TK-0020`：按缺口分析实现"文件内容检查" | ✅ |

**验收**：`TK-0018` / `TK-0019` / `TK-0020` 在真实 DSH 里通过；
`from-issue-data.mjs` 对 238 条候选产出分布报告。

### 能力缺口分析的结论（这就是"数据驱动"的样子）

对 238 条可回归候选做形态分类：

| 形态 | 条数 | 结论 |
|---|---|---|
| `file-inspect` | **97** | ⚠️ 缺 `kind: file` → **已补** |
| `unknown` | 78 | ❌ 需人工读原文定判据 |
| `reading-only` | 28 | ❌ 只有读数，需先写复现脚本 |
| `python-run` | 18 | ✅ shell 够用 |
| `exec-command` | 15 | ✅ shell 够用 |
| `git-command` | 2 | ✅ shell 够用 |

**41% 的候选卡在同一个能力缺口上**——这只有在真的把 238 条过一遍之后才看得出来。
凭直觉设计 kind 是发现不了的。

### 从 #48 提炼出的**可复用模式**

> 任何"装机后缺件 / 找不到模块"的 issue，都可以落成：
> **① 写一个把判据固定下来的脚本；② 用 `kind: shell` 跑它并断言退出码。**
>
> 好处是判据**可复跑、可进回归集**，而不是"人工装一遍看看"。
> 这条模式已写进 [SCENARIO-SPEC §3.10](SCENARIO-SPEC.md)。

### 还没做的（需要更多输入）

| 项 | 缺什么 |
|---|---|
| `dsh-memory` 运行时行为的场景（#22 记忆串台、#32 session 未落盘、#51 安装失败） | 插件**未装在任何 profile**，无法离线复现 |
| `lingshu` 的 pytest 类场景 | 同上（需要仓库与 Python 环境） |
| 106 条 `unknown` / `reading-only` 的判据 | 需人工读原文，工具只能把它们列出来 |

> `collect.py && extract.py` 可刷新快照；数据本身是 2026-10-09 的一次快照。
> 生成的草稿在 `cases-draft/`（git 忽略），`status: draft` 不会被默认运行集选中。

---

## Phase 9 · 复用 Agent Teams 的 team 通道 ✅ 本轮完成

**目标**：让 `agent` kind 不只复用底层 subagent provider，而是**复用 DSH 的智能体团队**
（`ctx.agentTeams`）——把"派生一个 durable 队友"变成可断言、可回归的场景资产。

| # | 交付物 | 状态 |
|---|---|---|
| 9.1 | `agent` kind 增 `mode: one-shot \| teammate`（缺省不变；动作级可覆盖） | ✅ |
| 9.2 | `agentTeams` 能力探测 + Lead 身份判定（非 Lead **跳过**而不是崩） | ✅ |
| 9.3 | teammate 唯一名生成（`tk-<caseId>-<rand>`）与非法名校验 | ✅ |
| 9.4 | 结果取证：`session/event` 收 child 的 `assistant/message`；`waitForTeammateIdle` 等状态回落 | ✅ |
| 9.5 | 留痕诚实化：`fx.teammateRetained` / `fx.teammateIgnoredSetup` / teardown `interrupt` | ✅ |
| 9.6 | `TK-0027`（`status: draft`）与 21 条单测 | ✅ |

**验收**：✅ **已在真实 DSH 里跑通**（独立 headless 新进程，`TK-0027 passed`，703ms）：

| 取证 | 实测值 |
|---|---|
| `fx.teammateName` | `tk-0027-voi1`（driver 自动生成的唯一名） |
| `fx.teammateId` / `fx.agentRunId` | `f30907a9-2c9e-4fdb-b0af-ff661be7cb2a` |
| `fx.teammateStatus` → `fx.teammateFinalStatus` | `running` → `inactive`（`teammateWaitMs=604`，`wakeReason=change`） |
| `fx.teammateOutputs` | `["TESTKIT_OK"]`（从 child 会话的 `assistant/message` 收集） |
| `fx.teammateMembers` | `lead(running)` + `tk-0027-voi1(inactive)` |

CLI 侧另观察到 teammate 用 `send_message` 把结果回传给 Lead——说明它拿到的是一套
**完整可用的团队身份**，不只是被塞进 roster 的一行。

> **为什么它必须是 `draft`**：团队没有删除成员的能力，`maxMembers` 在桌面组合里是 8
> （服务内建默认 16），
> 名字永不复用——每跑一次都**永久**消耗一个名额。走 team 通道的场景默认不进回归集，
> 只在按 id 单跑时执行。这条限制写进了 [SCENARIO-SPEC §3.7](SCENARIO-SPEC.md)。

> **两条通道的关系**：`one-shot` 调 `subagents.start()`；`teammate` 调
> `agentTeams.spawnTeammate()`，其内部走 `subagents.startContinuable()`。
> 底层是同一个 provider 注册表（实测 `spawn` / `fork`），团队语义只在上层。

---

## 里程碑视图

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4 ──▶ Phase 5 ──▶ 常态化
 通道验证    核心引擎     模拟人/环境   看板         CI 轨       端到端
   ↑                                                                     │
   └───────────────── R1–R6 若推翻假设，回到这里重定 ─────────────────────┘
```

---

## 明确不做（现阶段）

| 不做 | 原因 |
|---|---|
| 通用测试框架（断言库、mock 库） | 与 `node:test` 重复，本插件只做"造 DSH 条件"这件事 |
| 像素级 UI 测试 | 需要浏览器驱动链，成本远高于收益；第一版只做注册类探测 |
| 场景数据的可视化编辑器 | 数据量小时 YAML 直接编辑更快 |
| 多 profile 并行 | 活宿主测试本身要求环境确定 |

---

## 相关文档

- [架构设计](ARCHITECTURE.md)
- [开发文档](DEVELOPMENT.md)
- [场景数据规范](SCENARIO-SPEC.md)
- [issue 提炼流程](ISSUE-PIPELINE.md)
