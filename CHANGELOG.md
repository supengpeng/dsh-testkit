# 变更日志

本仓的版本语义：**补丁**只改实现与文档；**次版本**加能力面；**主版本**才会改
`cases/*.yaml` 的既有字段语义（新增可选字段不算破坏性变更，`schema` 保持 `1`）。

> ⚠️ **npm 上的 `dsh-testkit`（无 scope）属于另一个项目**，本包已改名 scoped：
> `@supengpeng/dsh-testkit`。改名前的说明见 [docs/PUBLISHING.md](docs/PUBLISHING.md)；
> **0.2.0 起从 `@supengpeng/dsh-testkit` 发布**（首次发布经活宿主四步验证，见该文档 §5.1）。

---

## 0.2.0（2026-10-10）

主题：把「**跑一次要花多少**」和「**结果怎么读**」从口头约定变成**可声明、可判定、可复现**的东西，
再把「架构边界」和「CI」变成**机器守卫**。本版**没有新增 kind**——12 个 kind 不变，
变的是它们外围的四层。

### 一、成本闸门（P0：成本不可控）

在此之前，"跑全部 active 场景"会把**真实模型调用**（`agent` 派生、`compaction` 真压缩）
悄悄塞进 CI 与日常回归，没人能事先声明"这一跑最多花多少"。

- 新增 `src/executor/policy.ts`：`ExecutionPolicy` / `SandboxPolicy` / `resolvePolicy` /
  `DEFAULT_POLICY` / `evaluateScenario` / `policySnapshot` / `UsageMeter` / `checkBudget` / `BudgetExceeded`。
- 场景新增两个**可选**字段：`cost: none | low | high` 与 `budget: { maxModelCalls, maxTokens }`
  （规范见 [docs/SCENARIO-SPEC.md §2.2.1 / §2.2.2](docs/SCENARIO-SPEC.md)）。
- 判定：`none` 恒放行；`low` 需 `allowLowCost`；`high` **默认拒绝**，必须显式 `allowModel`。
  被拒绝的场景记为 **skipped + 理由**（不是 failed）——「没跑」与「跑了但不对」必须分开。
- 超预算判 **failed**，消息以「预算超限：」开头，归因落 `env`（运行条件不足，不是产品结论）。
- **放权入口只有一个：人类命令面** `/testkit run --allow-model` / `--allow-low-cost`。
  `testkit_run` 的工具参数 `allowModel` / `allowLowCost` / `maxModelCalls` / `allowFileWrite`
  **只能收紧、不能提权**：`false` 一律生效；`true` 只在配置本身已允许时才有效果；
  `maxModelCalls` 取 `min(配置, 参数)`。
  **理由（安全边界，不是细节）**：闸门若能被模型自己打开，就只是装饰——
  一个"默认拒绝"的闸门必须把唯一的开闸权留在人类手里，
  否则模型只要多写一个参数就能绕过它。
- runner 侧新增：`policy` 快照、每步 `usage`、`repeat` 的 `rounds`、`failureCategory`、`minimalRepro`。
- `cost` 的默认档位表集中在 `src/kinds/index.ts` 的 `DRIVER_COST`（一处集中，便于逐条审阅）。

### 二、报告标准化

- 新增 **`runs/<RUN-ID>/junit.xml`**（`src/report/junit.ts`）：`testsuites` 根、按 kind 分
  `testsuite`、每条场景一个 `testcase`；failed → `<failure type="…">`（含最小复现与失败断言明细）、
  errored → `<error>`、skipped → `<skipped message>`；XML 特殊字符转义、非法控制字符剔除。
  写入失败**不抛出**（沿用既有语义：报告写不出去不该让运行本身失败）。
- 新增 **`schemas/run-report.schema.json`**（JSON Schema draft 2020-12）：`run.json` 的结构契约，
  新增字段一律允许缺省。
- Markdown 报告：概览表加「归因」列；「需要关注」段给出归因标签、最小复现代码块、
  repeat 轮次、闸门判定（`policy`）与用量（`usage`）。
- 失败归因与最小复现的实现集中在 `src/analysis/`（`classify.ts` / `repro.ts`）。
- 三种格式（md / json / junit）**同源**：同一份 `RunSummary` 渲染，case 数一致由测试守住。

### 三、CI 与自举契约

- 新增 **`.github/workflows/ci.yml`**：矩阵 `node 22.x / 24.x` × `ubuntu / windows / macos`（9 个组合），
  `pnpm/action-setup@v4` 钉 `11.7.0` + `actions/setup-node`（`cache: pnpm`）、
  `pnpm install --frozen-lockfile`，唯一执行的就是 `pnpm run gate`——
  不另拼一套步骤，避免"CI 绿但本地红"的双标准。
- README 加 CI / npm version / node engines / license 四个 badge，并补齐安装段。
- 新增 **`tests/self-bootstrap.test.mjs`**（自举契约）：
  `SCENARIO_KINDS` 与 `createDriverRegistry()` 必须**同集**（不多不少）；
  每个 driver 的 `kind` / `description` 必须非空且自洽；
  **`llm` driver 的"零上游请求"由 headless 宿主暴露的真实适配器计数证明**
  （并配一个对照组证明那个探针有效——driver 自己数自己永远数得出想要的数）。
- 把「本包**没有 `bin`**」这一既有事实变成显式断言（当时的形态：插件 + 库，不是 CLI；
  CI 轨由 `scripts/export-scenarios.mjs` + `export/scenarios.test.mjs` 承担）。
  > ⚠️ **这条决定已在「十四」被翻转**：现在有 CLI（`bin/dsh-testkit.mjs`），
  > 该断言改守新形态（bin 存在、指向真实文件、且在 `files` 白名单里），导出链路同时保留。

### 四、适配层守卫

- 新增 `src/adapters/dsh/tools.ts`：`@deepseek-ai/dsh-tools` 的 `defineTool` 收敛到这里。
  `src/host-facade.ts` 改为从 `./adapters/dsh/tools.js` 导入。
- 新增 `scripts/check-adapter-boundary.mjs` + `tests/adapter-boundary.test.mjs`：
  `src/**/*.ts(x)` 里凡出现 `@deepseek-ai/dsh-*` 的**静态 import / 动态 `import()` / `require()`**，
  其文件必须位于 `src/adapters/dsh/` 下。`@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery`
  不算（它们是基础设施，不是 DSH 内部包）。
- 接入 gate（`pnpm run verify:adapter`）——**守卫不接进 gate 就等于没写**。
- **澄清一条被证伪的验收方式**：早先方案里的判据是"grep 到 `@deepseek-ai/dsh-*` 就报"。
  实测本仓源码里有 9 处**注释**提到这些包名（引用发行体路径、对照上游实现、说明契约来源），
  grep 会把它们全部误报。本守卫先**剥离注释**再扫描，并在单测里专门覆盖"注释不算"。

### 五、增量测试选择（P0 §5.2）

- 新增 `src/selection/**`：`changedFilesSince(ref)`（`git diff --name-only --relative` +
  `ls-files --others`，**新增文件也算改动**）、`affectedScenarios(files, …)`（三档规则：
  精确命中 / 明确无关 / **保守全选**）、`selectByDshVersion(version, …)`。
- 入口：`testkit_run` 的 `changed` / `since` / `affectedBy` / `dshVersion` 参数，
  命令面 `/testkit run --changed|--since <ref>|--affected-by <file>|--dsh-version <v>`。
- **纪律：选不出来就退回全量**（git 不可用、ref 写错 → 退回全量并告警），
  绝不静默变成"跑 0 条"；判定依据原样落进 `RunSummary.selection`（mode / detail / matched），
  报告里能回答"我改了一行，为什么它一条都没跑"。
- 实测加速比（CI 轨集合 26 条）：改单个 kind → 命中 1–2 条；
  但端到端被 `node --test` 启动地板压住，只有约 2×——**真正的收益在"少跑"，
  不在"跑得快"**，别把它当性能特性用。

### 六、fixture 治理（P0 §5.3）

- 新增 `fixtures/**`（入库的声明式夹具，区别于 `.fixtures/` 里下载来的被测对象）：
  字段固定为 `$schema` / `name` / `dsh_version` / `source: hand-written|record|generate` / `data`。
- 场景用 `fixtures: [llm/error-mid-stream]` 引用；`data` 的键是 **kind 名**，
  合并规则 `setup[kind] = deepMerge(fixture.data[kind], scenario.setup[kind])`
  ——**场景显式字段优先**，数组整体替换，多份夹具按声明顺序后者覆盖前者。
- `applyScenarioFixtures()` **只读、不抛**：夹具缺失 / 解析失败 / 版本不匹配 → 该场景
  **skipped 并说明原因**（绝不用一份错的夹具硬跑）；采用情况进 `CaseOutcome.fixtures`。
- **CI 轨与插件面走同一条夹具链**：`src/export/node-test.ts` 生成物里显式带
  `fixtures: { fixturesDir, dshVersion }`。这条不加，会出现"插件绿、CI 红"
  （或反过来）——生成物与插件行为分叉的经典形态。
- `scripts/verify-fixtures.mjs`（进 gate）：schema / name↔路径一致 / `dsh_version` 可解析 /
  敏感扫描 / 重名 / **反向核对**（场景声明的夹具必须存在且合法）。
- `cases/TK-0006.yaml` 改为**纯夹具版**（删掉原来重复写的 `setup.llm`）：
  等价性由 `tests/fixture-governance.test.mjs` 用"夹具展开 vs 把条件写回场景"的
  实跑比对钉住（verdict / 断言指纹 / 取证 deepEqual / 零上游）。

### 七、契约测试（P0 §5.4）

- 新增 `src/contracts/**`（契约形状 + 运行器 + 点名报错）与 `tests/contracts/**`：
  `host-facade` / `dsh-tools` / `cordis` / `headless` 四个 adapter 各一组契约。
- **先于场景测试跑**：gate 里 `tests/contracts/*.test.mjs` 排在 `tests/*.test.mjs` 之前——
  替身漂移了就不该继续跑场景（否则 CI 轨绿着骗人）。
- 每个契约都配**反安慰剂**：把实现打回旧行为，断言契约**必须变红并点名**。
  只加断言不证明契约有效。
- 顺带修掉三处真实漂移（详见「迁移说明」的 enum/const 一行）。

### 八、并发隔离 + 幂等/清理（P0 §5.5 + §7.4）

- 新增 `src/isolation/**`：`IsolationContext`（namespace / tmpdir / ports / session）、
  `groupScenarios`（只有 `parallel: safe` 才并发；`exclusive` 与缺省永远独占；
  连续 safe 按 `parallelLimit` 切块且**保序**）、`detectLeftovers`（tmpdir 真检测；
  端口/进程探针**可注入、缺省不探测**——不猜就不写假条目）、`releaseStepNotes`（步骤级清理，幂等）。
- 场景新增可选 `parallel: safe | exclusive`（**缺省 `exclusive`**：不认识的东西不并发）；
  报告新增 `RunSummary.execution`（串行还是并发、并发度、safe/exclusive 各多少条）。
- 步骤级清理：`step.cleanup.releaseNotes` 在**本步结束后**释放（幂等、失败不抛穿）；
  残留检测在 **dispose 之前**做（口径是"这条场景自己清干净了吗"，dispose 是兜底不是检测手段）。
- 验收口径：并发与串行**逐条**比 verdict 与断言 ok 矩阵（不是只比总数），
  并用探针证明"并发真的发生了"（4 条 80ms 场景：串行 maxActive=1、并发 maxActive=4）。

### 九、组合系统：step registry + 参数化模板（P0 第 5 步）

- 新增 `registry/steps/**`（9 份片段，`name` / `version` / `params` / `dependencies` /
  `cost` / `sandbox` + 字面 `act`/`expect` 模板）、`src/registry/**`（加载 / DAG 校验 / 展开 / 模板）。
- 场景可用 `use: invoke/tool` + `with: {...}` 引用片段；`act` 与 `use` **互斥**；
  展开是**纯文本替换**（`{param}` / `{a.b}`），`with` 里多给或漏给参数都在**校验期**报错。
- 硬约束全部进守卫（`scripts/verify-registry.mjs`）：片段**不得** use 别的片段（无环）、
  `act`/`use` 互斥、禁止 YAML 控制流（`if`/`for`/`while`）与场景级 `include`/`extends`、
  场景锁 registry 版本（载体是 tag 约定 `registry:v1`）、展开后不得残留 `use`/`with`。
- 参数化模板 `templates/**`：矩阵笛卡尔积 → 独立 TK 号的 **draft** 场景（不撞既有号段）。
- 新增 3 条 `use:` 场景（`TK-0037`/`0038`/`0039`，draft）；等价性证明：展开结果与
  等价手写场景**逐步逐字段 deepEqual**，且在 headless 上 verdict 与断言 ok 矩阵完全一致。

### 十、touchstone 三阶段适配器（文档第九部分）

- 阶段一 `export`：`run.json` → `bug_report/<CASE-ID>/{report.md, repro.yaml, severity.txt,
  evidence/trace.json, evidence/logs.txt}` + 索引；只导出 `failed`/`errored`，
  `repro.yaml` 的命令**逐字取自** `src/analysis/repro.ts`（不另发明一套）。
- 阶段二 `import`：`case.md` → 场景 YAML **草稿**（恒 `status: draft` / `id: TK-0000`），
  结构映射为主、映射不了的原样成注释，且**只走提案闸门**（不自动开批次、不写 `cases/`）。
  **停止线**：转换器 > 500 行即抛错（当前 469 行，守卫真的拦过它自己一次）。
- 阶段三 `webhook`：`POST /on_fix_complete` → 增量选择出受影响场景 →
  **在 `git worktree` 临时目录里复跑**（`node_modules` 用 junction 接入）→ 结果同步回传 +
  可选 POST 回 `callbackUrl`；`finally` 无条件清理 worktree。只监听 `127.0.0.1`。
- 纪律：不 import 对方代码、不共享数据库、不嵌入对方运行时、不做 API 稳定承诺。
- 文档见 [docs/TOUCHSTONE.md](docs/TOUCHSTONE.md)（协议表 / 产物结构 / severity 规则 / 停止线）。

### 十一、沙箱默认值：shell 默认只读 + 禁止任意网络（文档 §3.2.4 / §7.1）

- `DEFAULT_POLICY.sandbox.denyWriteCommands` 默认 = `READ_ONLY_DENY_COMMANDS`：
  删/移/拷/改权限/格式化/写块设备，以及**无法静态判定写什么**的解释器
  （`sh` / `bash` / `cmd` / `powershell` / `wsl`）默认拒绝。
- `sandbox.allowNetwork` 默认 `false`：`resource` 动作没有假 provider 时被拒
  （场景自带 `setup.resource` = 网络已被替身接管，放行）。
- `allowFileWrite` **仍默认 `true`**：`fs` driver 的存在意义就是驱动宿主文件服务、
  观察**宿主自己**的沙箱语义（`TK-0030`/`0031` 测的正是它）；在闸门层默认拒绝写入
  等于把这个 driver 变成哑巴。要收紧请显式关。

### 十二、数据隐私：`--redact` + secret 扫描（文档 §7.1）

- 新增 `src/report/redact.ts`：token / 私钥 / JWT / AWS key / 赋值式凭据 / 邮箱 / 家目录路径。
  **默认关闭**（脱敏会改写取证原文，不该在没人要求时悄悄发生）；
  开启后三份产物渲染同一份已脱敏 summary，并在报告头部写明"过滤了几处、哪些类型"。
- **findings 只记位置与类型，绝不记原文**——否则报告自己又变成泄露源。
- 新增 `scripts/check-secrets.mjs`（进 gate）：扫仓库里会入库或会进产物的文件；
  只输出 `file:line [kind]`，**不打印命中原文**；误报用行内 `secrets-ok` 标注。
  顺带修掉 `docs/DEVELOPMENT.md` 里的真实用户名路径与一处第三方邮箱。

### 十三、包名改为 scoped（npm 名归属）

- `package.json` 的 `name` 改为 **`@supengpeng/dsh-testkit`**：npm 上的 `dsh-testkit`
  已被他人占用（实测 registry 200，latest `0.4.4`），发布到那个名字物理上不可能。
- **client 模块 id 与包名解耦为"一处真源"**：`scripts/build-client.mjs` 不再硬编码 id，
  改为从 `package.json` 读。证据：DSH 自己的客户端包正是用 scoped 包名做 module id
  （发行体里可见 `__ModuleLoader__.load({ id: "@deepseek-ai/dsh-api-gateway" … })`）。
- **插件身份不变**：`src/index.ts` 的 `name`、`dsh/cordis.patch.yml` 的 id、
  client 半的 `name`、locale 命名空间仍是产品名 `dsh-testkit`。
- **改名后必须重建 client 产物**（`node scripts/build-client.mjs`）：`lib/client.js` 是
  共享构建产物，不重建会留下"源码已改名、产物还是旧 id"的分叉（本轮实测踩过一次，
  表现为 `TK-0015` / `ui-driver` 突然变红）。gate 已保证 `build-client` 先跑。

### 十四、可观测性、检索与独立 CLI（文档 §6.1–§6.5）

- **trace（§6.1）**：`CaseOutcome.trace` 记**真实偏移**（`setup` / `act` / `assert` / `cleanup` /
  `case` 五类跨度，相对 case 起点）。`runs/<RUN-ID>/trace.json` 每次运行自动落盘；
  四种导出同源：`renderTimeline`（人看）/ `renderTraceJson`（本仓规范）/
  `renderChromeTrace`（`chrome://tracing`、Perfetto）/ `renderOtelSpans`（OTLP JSON）。
  历史 `run.json` 没有 trace 时按步骤时长**重建**，并如实标 `generatedFrom: 'reconstructed'`。
- **结果趋势（§6.5）**：`collectRuns` → `buildTrend(dimension: kind|tag|owner|dshVersion)` →
  通过率 / flaky 率（用 `rounds`）/ 平均与 p95 耗时 / 模型用量；样本不足时**明说"别据此下结论"**，
  缺数据说"未知"而不是 0。**只读历史产物**。
- **覆盖矩阵与缺口（§6.4）**：`buildCoverage` 输出每个 kind 的 active/draft/owner/tag/夹具分布
  与**可行动的缺口清单**（缺什么、怎么补）。
- **场景搜索（§6.4）**：`searchScenarios` 全文匹配 + kind/tag/owner/cost/status 过滤，
  0 条时回显"每个条件单独命中多少"，解释为什么是空的。
- **错误消息质量（§6.3）**：`probableCauses(outcome)` 给"原因 / 可能性 / 依据 / 下一步"，
  按依据强弱排序并封顶 3 条；**没有依据就返回空数组**（不编）。报告与工具/命令输出都带上它。
- **本地 DX（§6.2）**：`--owner` / `--cost`（上限含）/ `--smoke`（静态估算预算，默认 5s）/
  `watchCases`（`fs.watch` + 防抖，供 `--watch` 用）。
- **独立 CLI（§6.2/§8.2）**：**形态翻转** —— 新增 `bin/dsh-testkit.mjs` 与 `src/cli/**`。
  子命令 `run / list / report / expand / export / import / trace / trend / coverage / search /
  registry / fixtures / help / version`；`run` 支持全部选择与闸门开关。
  **退出码冻结**：`0` 全部 passed/skipped、`1` 有 failed/errored、`2` 用法错误或选中 0 条、
  `3` 基础设施错误。CLI 走 headless 宿主，并**如实标注**需要 subprocess/fs/sessions 的场景会 skip。

> **为什么现在才加 CLI**：此前刻意不加，是因为"先在真实仓库的 CI 里跑通导出轨"这条前置没满足，
> 早加会得到第二套与场景数据重复的命令面。现在导出轨已经进 gate 并在全新 checkout 上验证过，
> 且 CLI 只做**同一套引擎的入口**（不重造 runner / 不重造选择器）。

### 十五、供应链、治理、官方集成与自动 triage（文档 §7.1–§7.5）

- **供应链守卫（进 gate，离线可判）**：`scripts/check-ci-hardening.mjs`（workflows 必须有显式
  `permissions:`、禁 `pull_request_target`、禁 `secrets.`、**每个 `uses:` 钉 40 位 SHA**、
  禁 `continue-on-error: true`、必须 `--frozen-lockfile`）与 `scripts/check-lockfile.mjs`
  （`package.json` 的依赖逐项能在 `pnpm-lock.yaml` 里找到，`packageManager` 与 lockfile 一致）。
- **发布工作流**：`.github/workflows/release.yml` —— 打 `v*` tag 才触发；frozen 安装 → `gate` →
  断言 `npm pack --dry-run` 清单含 `bin/`、`lib/cli/`、`schemas/`、`cases/`、`fixtures/`、
  `registry/`、`templates/`、`dsh/` → `npm publish --provenance --access public`
  （走 GitHub OIDC trusted publishing：`contents: read` + `id-token: write`，**不需要任何 secret**）。
  文件头写明"打 tag 即发布"的风险。
- **CI 里的 `pnpm audit --prod --audit-level=high` 是独立步骤、不进 gate**：它需要网络，
  而 gate 必须能在**离线**机器上跑通——分工写在工作流注释里。
- **治理机制**：`CODEOWNERS`、`CONTRIBUTING.md`（含"怎么加一条场景 / 怎么加一个 driver"与
  12 kind 的纪律）、`CODE_OF_CONDUCT.md`、`.github/PULL_REQUEST_TEMPLATE.md`、
  `.github/ISSUE_TEMPLATE/*`（bug 模板强制要求最小复现 + 期望/实际 + 环境）、
  `docs/GOVERNANCE.md`（版本与弃用策略 / RFC 流程 / release cadence / **good first issues 候选**）、
  [`docs/rfc/`](docs/rfc/README.md) 模板与流程。
- **迁移指南**：[docs/MIGRATION.md](docs/MIGRATION.md) —— 0.1.0 → 0.2.0，写成"我要做什么"
  （默认值变化 / 新增可选字段 / `enum`·`const` 保真的恢复路径 / 包名与形态变化 / 工具面 6→11）。
- **官方工具链集成**：[docs/DSH-INTEGRATION.md](docs/DSH-INTEGRATION.md) —— 本包与 DSH 的
  声明式契约（`dsh` 段）、对外的四类产物（JUnit / JSON+schema / trace / Markdown）、
  与 doctor / composition / 单元测试框架的**分工**、对 DSH 内部约定的依赖表，
  以及"仍然需要活宿主验证"的三项。
- **GitHub Action**：根目录 `action.yml` + `scripts/action-entry.mjs` —— 读 `run.json` 生成
  PR 评论正文（写 `$GITHUB_STEP_SUMMARY` 或 stdout）；`comment: true` 且有 token 时 POST，
  **失败不静默**并把正文打印出来供人工贴。
- **自动 triage（生成侧完整，发布侧需真实仓库）**：`src/triage/**` —— `buildIssueDraft`
  （labels 由归因推导、assignees 由 `owner` 推导）、`buildPrComment`（全绿时也有内容）、
  `routeByOwner`（无 owner 归 `(未指派)` 并提示该补）。**只生成文本、不发请求**；
  正文**不含完整取证原文**（issue 是公开面）。
- **残留检测扩到端口与进程**：`src/isolation/probes.ts` —— `probePorts`（探不到标 `unknown`，
  绝不当作干净）、`probeProcesses`（命令不可用 → `available: false` + 说明）、
  `detectResidue`（同步 tmpdir + 异步探针合成）。
- **宿主体检入口**：`src/doctor/**` + `dsh-testkit doctor` / `testkit_doctor` —— 宿主能力矩阵
  （按 `driver.requires` **推导**哪些场景会 skip 及原因）、守卫清单、残留探测、版本与平台、
  最近一次运行读数、覆盖矩阵前几条缺口。

> **本批之前版本号一直是 `0.1.0`、CHANGELOG 标"未发布"**——因为发布前必须先在**活宿主**
> 里跑完 [PUBLISHING.md](docs/PUBLISHING.md) §5 的 V1–V4（改名后的 client 模块 id 与
> 「测试」标签渲染）。**2026-10-10 已跑完那次验证并抓到真 bug**（§十六 的前身：
> bundle patch 的 `name` 写旧名 → client 半静默不进启动图），修完才把版本号提到 `0.2.0` 并打 tag。

### 十六、首次推到 GitHub 后，远端 CI 暴露并修掉的六类问题

本地 `pnpm run gate` 全绿**不等于**远端绿。第一次推送后 6 个矩阵任务全红，逐轮修完
（每一轮都把 CI 日志里的真因写进提交信息，并把结论回填到
[OPTIMIZATION-REVIEW](docs/OPTIMIZATION-REVIEW-2026-10.md) 的真问题 #13–#18）：

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| 13 | 6 个任务全红，本地绿 | `act` 阶段的 `SkipCase` 被当成"这一步失败"→ 缺外部 fixture 的场景判 failed（本地有 `.fixtures`，CI 没有） | runner 统一口径：`act` 阶段的 `SkipCase` 也判 skipped（保留已跑取证、不记进 `rounds`）；`file` driver 的 root 校验前移到 `setup`；新增 `tests/skip-semantics.test.mjs`（修复前 2 红 / 修复后 3 绿） |
| 14 | 我自己的"全新 checkout 验证"没发现 #13 | 验证配方把 `.fixtures` junction 进了全新工作树——那正是 CI 缺失的目录 | 验证配方改为不 junction 任何被 gitignore 的目录；补一条"移走 `.fixtures` 跑完整 gate"的本地 CI 模拟 |
| 15 | macOS：`ERR_MODULE_NOT_FOUND`（指向不存在的 `private/` 前缀） | `toLibSpecifier` 把 realpath 与非 realpath 混算（macOS 的 `/var` ↔ `/private/var`） | realpath 两边 + **往返校验**，解不回去退回绝对 `file://` URL；顺带让 **Windows 跨盘符**从"报错"变成"可用" |
| 16 | macOS：`watchCases` 把被监听目录自身当变更文件 | FSEvents 会上报目录自身的事件 | 过滤 `filename === basename(dir)` 与 `..` 开头的条目 |
| 17 | Windows：shebang 断言红 | 缺 `.gitattributes`，`core.autocrlf=true` 把 `bin/dsh-testkit.mjs` 首行变成 `...node\r`——**这在 POSIX 上是真实发包缺陷**（`bad interpreter`） | 新增 `.gitattributes`（`eol=lf` + 二进制显式 `binary`）；断言比较前去掉 `\r` |
| 18 | ubuntu/macOS：我新加的断言红 | 断言盯的是**形态**（"必须出现 `file://`"），而 POSIX 上跨树的相对形态本来合法 | 改为盯**性质**：说明符解出来必须还是 libDir |
| 19 | **发布工作流第一次跑就红在"清单断言"**（Release run #1） | `npm pack` 会执行 `prepare`，而 `build-lock` / `build-client` 用 `console.log` 往 **stdout** 打诊断 → `pack.json` 首行是 `[build-client] …` → `JSON.parse` 抛 `Unexpected token 'b'`，报错里**完全不缺件**。判据当时内联在 YAML 里，无法单测 | ① 两个构建脚本的诊断改走 stderr；② 判据搬进可单测的 `scripts/check-pack-manifest.mjs`，解析失败**回显输出开头**；③ `tests/pack-manifest.test.mjs`（8 条，含"污染 ≠ 缺件"的语义区分）+ 静态守卫"prepare 脚本不许有 `console.log`" |
| 20 | **活宿主四步验证抓到 A6 漏改**（V1/V2 的静默失败） | `dsh/cordis.patch.yml` 的 `name` 是 **Node 模块说明符**，改名后没同步：宿主半照常加载（bridge 一直通），**client 半静默不进启动图**（「测试」标签不出现、控制台无异常），`verify:cases`/`docs`/`pack` 全绿 | `name` 改为 `@supengpeng/dsh-testkit`；新增 `scripts/check-bundle-patch.mjs`（gate 的 `verify:bundle`，5 条测试含旧名/空 insert/重复 id 三条负向）；PUBLISHING 补 A13（改名后必须重装已安装 profile）与 §5.1 实测结果 |
| 21 | **发布卡在 npm 侧的 `ENEEDAUTH`**（Release run #2 的最后一步） | 仓库侧全对（gate/tag/清单都过），但 npm 与 PyPI 不同：**必须先有包才能配 trusted publisher**，所以"首次发布"不能走 OIDC | 记录在 [PUBLISHING.md](docs/PUBLISHING.md) §11.1：路径 A（先用 token 发首次，再切 OIDC）或路径 B（先发 `0.0.0` 占位，让 `0.2.0` 本身也带 provenance） |

最终 **run #5：6/6 全绿**（Node 22/24 × ubuntu/windows/macos）。

### 迁移说明

| 变化 | 对既有使用者的影响 | 要不要动手 |
|---|---|---|
| 新字段 `cost` | 不写 = 按参与 driver 的默认表取最高档，**既有场景行为完全不变** | 只有想让高成本 driver 的离线动作降档时才写（例：`cases/TK-0034.yaml` 标 `cost: none`） |
| 新字段 `budget` | 不写 = 不限 | 可选 |
| 闸门默认值 | `allowModel: false`（`high` 档**默认跳过**）、`allowLowCost: true` | 想跑 `agent` / `compaction` 真压缩时，显式 `--allow-model` |
| **沙箱默认值（**行为变化**）** | **shell 默认只读**：`rm`/`mv`/`cp`/`chmod`/`dd`/`mkfs`… 与 `sh`/`bash`/`cmd`/`powershell` 这类解释器**默认被拒**，该场景记 **skipped 并给理由**（不是失败）；真实网络默认禁止 | 有 legit 写操作或需要 shell 特性的场景：放开 `sandboxDenyWriteCommands` / `sandboxAllowNetwork`（配置项），或改用不经 shell 的 argv 直调 |
| 新字段 `owner` / `parallel` / `fixtures` | 不写 = 无归属、`exclusive`（串行）、不用夹具 | 可选 |
| 步骤新字段 `use` / `with` / `id` / `cleanup` | 不写 = 既有 `act`/`expect` 写法原样可用（`schema` 仍为 `1`） | 可选；用组合时注意 `act` 与 `use` 互斥、片段名拼错会在校验期报错 |
| **`enum` / `const` 保真（**行为变化**）** | 之前只保留 string 的 `enum`、完全丢弃 `const`（约束被静默放松）；现在按 DSH 支持集合（string/number/integer/boolean/null）忠实传递，**类型对不上的 schema 会在 `defineTool` 期抛 `JsonSchemaError`**（响亮的失败，而不是悄悄放宽） | 升级后若工具注册报 `JsonSchemaError: … .enum/.const must be …`：把该参数的 `enum`/`const` 值改成与声明的 `type` 一致（`integer` 只能整数、`boolean` 只能 `true`/`false`、`null` 只能 `null`），`enum` 必须非空，`enum` 与 `const` 同时声明时 `const` 必须取 enum 里的一个值；约束若写在 array/object 上，请移到 `items` / `properties.<key>` 的标量节点。**别改转换器——它现在不再替你丢约束了** |
| 库调用方（直接 `RunRequest`） | `policy` 省略 = **不启用闸门**，既有语义与既有测试不变；`fixtures` 省略 = 不应用夹具 | 不需要 |
| 新产物 `runs/<RUN-ID>/junit.xml` | 多一个文件；写失败不抛出 | 不需要 |
| 报告新增字段 | `policy` / `usage` / `failureCategory` / `minimalRepro` / `rounds` / `owner` / `fixtures` / `cleanup` / `selection` / `execution` / `redaction` **只增不改**；`schema` 仍是 `1` | 解析方按可选字段处理 |
| 包名 `dsh-testkit` → `@supengpeng/dsh-testkit` | 插件 id 与 locale 命名空间**不变**；client 模块 id 跟随包名变化（已重建产物） | 从 git / 本地路径安装的用法不变；**改名后的活宿主渲染仍需人工验一次**（见 [docs/PUBLISHING.md](docs/PUBLISHING.md) §5） |
| 工具面新增 `testkit_expand`；`testkit_export` 增 `target: touchstone` | 注册面从 6 个工具变 7 个 | 断言"恰好 6 个工具"的调用方需要更新（本仓的 `host-apply` 已同步） |
| **工具面再增 4 个（第二批 ②）**：`testkit_trace` / `testkit_trend` / `testkit_coverage` / `testkit_search` | 注册面 7 → **11** 个工具 | 同上：断言工具数/名字集合的调用方需更新（本仓 `host-apply` 已同步到 11） |
| **新增 `bin`（**形态变化**）** | 本包从"插件 + 库"变成"插件 + 库 + CLI"；`files` 增加 `bin/` | 不需要动手；`npm i -g @supengpeng/dsh-testkit` 后可直接 `dsh-testkit list`（CLI 是同一套引擎的入口，不是第二套实现） |
| 新产物 `runs/<RUN-ID>/trace.json` | 多一个文件；**只在这次运行真的记了 trace 时才写**（不给没记 trace 的运行写"重建"文件，避免分不清实测与近似） | 不需要 |
| 报告新增字段 `CaseOutcome.trace` | 只增不改；`schema` 仍是 `1` | 解析方按可选字段处理 |
| `src/host-facade.ts` 的导入路径 | 内部实现，导出面不变 | 不需要 |

### 已知限界（本次交付的诚实边界）

1. **用量记账是下界。** 语义是「真实调用次数 ≥ 记账值」：1 个高成本 `act` 记 1 次调用，
   driver 不主动上报 token 就记 0。因此 `budget.maxModelCalls` 是**保守闸门**
   （超了必拦，但别拿它当账单），`maxTokens` 只在 driver 真的上报 token 时才真正强制。
   宁可如实说"没上报"，也不编一个看起来精确的数字。
2. **沙箱默认值的取舍边界。** `shell` **默认只读**、真实网络**默认禁止**（见「十一」），
   但 `allowFileWrite` 仍默认 `true`：`fs` driver 的存在意义就是驱动宿主文件服务、
   观察**宿主自己**的沙箱语义（`TK-0030`/`0031` 测的正是它）——在闸门层默认拒绝写入
   等于把这个 driver 变成哑巴。要收紧请显式关。
3. **`--redact` 是"模式匹配"级，不是数据分级。** 它能挡住"不小心把 token 贴进日志"，
   挡不住精心构造的泄露（比如把密钥拆成两半拼接）。用 `check-secrets` 做**闸门**、
   用 `--redact` 做**兜底**，别把任一个当安全认证。默认关闭（脱敏会改写取证原文）。
4. 模型相关的两个 driver（`agent` / `compaction` 真压缩）**未在本版做 CI 覆盖**：
   它们要么花钱、要么留痕，只按 id 单跑；这是成本闸门存在的直接后果，不是覆盖率疏漏。
5. **增量选择的收益是"少跑"，不是"跑得快"**：API 口径改一个 kind 只命中 1–2/26 条，
   但端到端口径被 `node --test` 的启动地板（约 1.1s）压住，只有约 2×。
6. **`detectLeftovers` 的工具链只做 tmpdir 真检测**：Node 没有可靠的**同步**端口探测，
   孤儿进程名要按平台给——所以端口/进程探针缺省**不探测**（不写假阴性），
   要真检测得由调用方注入探针。
7. **组合系统的参数校验是"简化 JSON Schema"级**：`string/number/integer/boolean/object/array`
   + `enum` + `default`，不递归校验嵌套 `properties`；占位符**嵌入字符串**时要求标量，
   对象/数组必须整串占位（`"{args}"`）。
8. **`enum` 与 `const` 对"畸形输入"的处理风格略有差异**（畸形 `enum` 被丢弃、畸形 `const` 抛错）。
   合法 schema 不受影响；若要统一成"键存在即忠实传递、由 DSH 裁决"，需另开一条并接受
   "畸形 enum 从静默丢弃改为注册期抛"的行为变化。

### 明确推迟的项（连同理由与前置条件）

| 推迟项 | 为什么现在不做 | 解除前置条件 |
|---|---|---|
| **供应链与治理（产物签名 / RFC / CODEOWNERS / 贡献指南 / good first issues）** | 这些是**发布之后**才有意义的机制（签名要签发布产物、RFC 要有外部参与者、CODEOWNERS 要有第二个维护者） | 先完成一次真实发布（含活宿主验证），再按 [docs/PUBLISHING.md](docs/PUBLISHING.md) 的清单补齐 |
| **自动 triage（失败关联 issue / 贴 PR / 按 owner 路由）** | 前置是"有真实的 issue 与 PR 流"；现在给它接上只会产生空草稿。**数据面已就绪**：`owner` / `failureCategory` / `minimalRepro` / `selection` 都在 `run.json` 里 | ① 至少一个真实仓库在用本包的 CI 轨；② 定下"什么条件下自动开 issue"（否则就是刷屏） |

---

## 0.1.0

当前 `package.json` 的版本，也是这套东西**真正长出来**的那一版：

- 双半插件（host 半 + client 半），host 半工具 6 个、人类命令 1 个 + 6 个子命令、
  4 条 HTTP bridge 路由
- **12 个 kind**、17 个断言词、约 235 个取证字段
- `cases/` 36 条场景（一案一 YAML，真源），索引 `cases/index.yaml` 由守卫维护
- 双轨执行：内置 runner（活宿主）＋ 导出的自包含 `node:test`（CI 轨）
- 提炼闸门：人开批次 → 模型只能提交提案 → 人批准才进 `cases/`
- 三个通用检查器（`check-pack-files` / `check-python-topimports` / `check-git-installable`）
- 文档守卫（`verify-cases` / `verify-docs`）与 386 项单测（0.1.0 时点的读数；0.2.0 之后见上）

详见 [docs/ROADMAP.md](docs/ROADMAP.md) 的 Phase 0–10。
