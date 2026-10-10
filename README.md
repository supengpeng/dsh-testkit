# dsh-testkit

[![CI](https://github.com/supengpeng/dsh-testkit/actions/workflows/ci.yml/badge.svg)](https://github.com/supengpeng/dsh-testkit/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@supengpeng/dsh-testkit.svg)](https://www.npmjs.com/package/@supengpeng/dsh-testkit)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.19-339933.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **包名已改为 `@supengpeng/dsh-testkit`**（npm 上的 `dsh-testkit` 已被 `iiwish/dsh-testkit`
> 占据，latest `0.4.4`，所以旧名字既不能用也不能发布）。改名依据、模块 id 耦合点与
> **仍需在活宿主验证的最后一步**见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。
> 插件身份（profile roster 里的 id、client 半模块名、locale 命名空间）仍是产品名 `dsh-testkit`。

> DSH（DeepSeek Harness）测试插件。**把 issue 提炼成可复现的测试场景，再让插件去造出那些场景。**
> 提炼是**逐批、由人决定**的：人开批 → 模型只能提交提案 → 人批准才进 `cases/`（见[提炼闸门](docs/ISSUE-PIPELINE.md)）。

它的输入是 issue，输出是**可复现、可断言、可回归**的场景资产：

```
issue ──提炼──▶ cases/TK-XXXX.yaml ──驱动──▶ src/kinds/*.ts ──执行──▶ runs/<RUN-ID>/report.md
```

插件的测试对象不锁定：DSH 宿主能力、第三方插件、端到端行为，都由「场景 kind」决定。

---

## 安装

本包有两种身份，装法不同：

```powershell
# ① 作为 DSH 插件（host 半 + client 半）
$DSH = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

# 从本地路径装（开发时用这个）
& $DSH plugin --profile desktop add <本仓绝对路径>

# 或从 git 装（注意：本包没有 bin，装的是插件本体）
& $DSH plugin --profile desktop add git+ssh://git@github.com/supengpeng/dsh-testkit.git

# ② 作为库 / CI 用例的依赖（⚠️ 尚未发布到 npm，见 docs/PUBLISHING.md）
#    包名已改成 scoped（@supengpeng/dsh-testkit），但**还没有 publish**；
#    在那之前请用 ① 的本地路径或 git 形式。
npm install -D @supengpeng/dsh-testkit
```

> 本包现在**有 CLI**：`dsh-testkit <子命令>`（`bin/dsh-testkit.mjs`）。
> 它与 `/testkit` 人类命令、`testkit_*` 工具**共用同一套引擎**（不重造 runner / 选择器）。
>
> ```bash
> dsh-testkit list                    # 列场景
> dsh-testkit run                     # 跑全部 active（默认拒绝真实模型调用）
> dsh-testkit run --changed           # 只跑受工作区改动影响的场景
> dsh-testkit run --smoke             # 冒烟集（5 秒静态估算预算）
> dsh-testkit coverage                # 覆盖矩阵 + 可行动的缺口
> dsh-testkit trace --format chrome   # 步骤级 trace（可直接喂 chrome://tracing / Perfetto）
> dsh-testkit trend                   # 历史趋势（通过率 / flaky 率 / 耗时）
> ```
>
> **退出码**：`0` 全部通过（含 skipped）· `1` 有 failed/errored · `2` 用法错误或选中 0 条 ·
> `3` 基础设施错误。CLI 走 **headless 宿主**，因此需要 `subprocess` / `fs` / `sessions`
> 能力的场景会**如实 skip**（它不假装自己跑过）。

---

## 当前状态

| 部分 | 状态 |
|---|---|
| 架构与规范文档 | ✅ 五份已完成 |
| host 半（引擎 / 断言 / 夹具 / 装载 / 工具面 / 命令面 / HTTP 通道） | ✅ 可编译，且在**真实 cordis 容器**里装配通过 |
| client 半（会话内「测试」标签页 + 控制台） | ✅ 已构建，且在**真实 web profile** 里验证通过 |
| **`tool` driver** | ✅ 注册临时工具 / guard 拦截 / 真实管道调用取证 |
| **`prompt` driver** | ✅ section / context / variable 注入 + 主动 `assemble()` 取证 |
| **`llm` driver** | ✅ 接管 `llm/stream`：零上游请求、四种失败注入、用量伪造 |
| **`interaction` driver** | ✅ 接管提问与审批：按声明应答、超时路径可断言 |
| **`session` driver** | ✅ 人类命令：注册 / 驱动 / 两条失败路径（返回值 vs 抛异常） |
| **`resource` driver** | ✅ 假 web provider：接管 providerId、截断语义、降级路径 |
| **`agent` driver** | ✅ 派生**真实子 agent** 跑任务并断言轨迹——两条通道：`one-shot`（`subagents.start`）与 `teammate`（**复用 Agent Teams**，`agentTeams.spawnTeammate`）（⚠️ 会真的调模型） |
| **`ui` driver** | ✅ 在隔离 vm 里加载**真实 client bundle**，验证产物契约与 slot / 词典注册（纯离线） |
| **`shell` driver** | ✅ 跑外部命令（`argv` 数组）并取证退出码 / stdout / stderr（**由真实 issue 数据驱动**） |
| **`file` driver** | ✅ 读文件 / 列目录 / **搜内容（`search`，对应 grep）**；纯离线，任何宿主都能跑（**由能力缺口分析驱动**） |
| **Phase 1 / 2 / 4 / 5 / 6 / 7 / 8 / 9 / 10** | ✅ 全部收口——**12 个 driver** 覆盖 12 类干预点，双轨执行可用 |
| **场景可跑通** | ✅ `cases/TK-0001..0026` 在真实 DSH 里 **25 通过 / 1 失败（预期）/ 0 跳过**；`TK-0028`…`TK-0034`（两条 waterfall / `ctx.fs` / session 三件套 / compaction 边界）在独立 headless 新进程 **7/7 通过**；`TK-0035`（真压缩）单跑通过。`TK-0027` / `TK-0033` / `TK-0035` 是 `draft`（留痕或花 token） |
| **组合场景（跨 kind）** | ✅ `setup` 可含多个 kind，`act` 按动作形状分派；实测证明 root 的假 provider 会穿透到子 agent |
| **issue 提炼闸门** | ✅ **要不要提炼、要不要落地都由人定**：人开批次 → 模型只提交提案（质量预检不过不落盘）→ 人批准才进 `cases/`；未结案不允许开下一批（三个闸门都有回归测试，见 `tests/pipeline-gate.test.mjs`） |
| **成本闸门（0.2.0 第一批）** | ✅ 场景可声明 `cost`（`none`/`low`/`high`）与 `budget`；`high`（**真调模型**）默认拒绝，被拒记为 **skipped + 理由**；预算超限判 failed 并归因 `env`。默认档位表在 `src/kinds/index.ts` 的 `DRIVER_COST` |
| **报告标准化** | ✅ `runs/<RUN-ID>/junit.xml`（CI 消费）＋ `schemas/run-report.schema.json`（结构契约）＋ 失败归因与最小复现（`src/analysis/`）；md / json / junit 三种格式**同源** |
| **CI 与自举契约** | ✅ `.github/workflows/ci.yml`：Node 22/24 × ubuntu/windows/macos 共 9 组，唯一入口 `pnpm run gate`（不另拼一套，避免假绿） |
| **适配层守卫** | ✅ `src/adapters/dsh/` 是全仓**唯一**允许依赖 `@deepseek-ai/dsh-*` 的目录，由 `scripts/check-adapter-boundary.mjs` 机器守卫（注释里的包名不算） |
| **增量选择 / 夹具 / 契约 / 并发（0.2.0 第二批）** | ✅ `--changed`/`--since`/`--affected-by`（git 不可用则**退回全量**）· `fixtures/` 声明式夹具（CI 轨与插件面**同一条链**）· `tests/contracts/**` 65 条契约（含反安慰剂）· `parallel: safe` 并发隔离 + 残留检测 |
| **组合系统** | ✅ `registry/steps/**` 片段 + `use:`/`with:` 展开 + `templates/**` 参数化（一键展平成 flat 步骤，禁控制流与场景级 include） |
| **沙箱与隐私** | ✅ **shell 默认只读**（写命令与解释器默认拒）+ 禁止任意网络 + `--redact` 脱敏（findings 只记位置不记原文）+ `check-secrets` 门禁 |
| **可观测性（0.2.0 第三批）** | ✅ 步骤级 **trace**（真实偏移；`trace.json` + 时间线 / Chrome Trace / OTLP 三种导出）· 结果**趋势**（kind/tag/owner/DSH 版本）· **覆盖矩阵**与可行动缺口 · 全文**搜索**（0 条时解释为什么）· 失败**原因分级**（有据才说） |
| **独立 CLI** | ✅ `dsh-testkit <子命令>`（`bin/`）：15 个子命令 + 全部选择/闸门开关；退出码冻结 `0/1/2/3`；与 `/testkit`、`testkit_*` **共用同一套引擎** |
| **供应链与治理（0.2.0 第四批）** | ✅ CI 硬化守卫（最小权限 / 禁止 `pull_request_target` / Action **钉 SHA**）+ 锁文件守卫 + secret 扫描 + `pnpm audit` 独立步骤 + **带 provenance 的发布工作流**；`CODEOWNERS` / 贡献指南 / 行为准则 / PR 与 issue 模板 / RFC 模板 / 迁移指南 |
| **自动 triage 与体检** | ✅ 生成 issue 草稿与 PR 评论（归因标签 + owner 路由，**只出文本不发请求、不含取证原文**）；`dsh-testkit doctor` 报告能力矩阵 / 哪些场景会 skip / 残留（临时目录、端口、进程） |
| 验证 | ✅ `pnpm run gate`：**701 测试**（含契约轨 65）＋ **10 个守卫** ＋ 导出的 **26 条场景**（gate 默认排除 7 条 `fixture` 场景——它们测的是外部被测对象） |

> 📋 **完整功能清单见 [docs/FEATURES.md](docs/FEATURES.md)**（13 个模型工具 / 15 个 CLI 子命令 /
> 12 个 kind / 17 个断言词 / 约 241 个取证字段 / 10 个质量守卫），只列**已实现并实测**的能力。
| **真实 DSH 验证（host 半）** | ✅ **14 通过 / 0 失败 / 2 跳过 / 0 错误**——独立 headless profile 实测，未改动 desktop profile |
| **真实 DSH 验证（client 半 + HTTP bridge）** | ✅ 独立 web profile 实测：「测试」标签渲染、控制台显示 16 条场景 |

风险台账：**R1–R10 全部结案（0 项未决）**，含两次源码推导与四次真实宿主实测，见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9。

### 真实验证怎么做的（不碰你的 desktop profile）

```powershell
$DSH = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $DSH tk --from-default-profile headless --help      # 建独立 profile（一次）
& $DSH plugin --profile tk add <本仓路径>              # 装插件（可逆）
& $DSH tk "调用 testkit_run 工具，报告通过/失败/跳过/错误"   # 跑完即退出
```

`headless` 模式「答一个任务、打印结果、退出」，所以**不占端口、不中断正在进行的会话**。
完整说明与能力缺口见 [DEVELOPMENT.md §5.3](docs/DEVELOPMENT.md)。

### 两条腿都已可用

```powershell
# 腿 1：内置 runner（在活 DSH 里跑）
/testkit run                      # 或让模型调 testkit_run

# 腿 2：导出的 CI 用例（自带 headless 宿主，无需 DSH）
npm run export:ci
node --test export/scenarios.test.mjs
```

| 腿 | 证明了 | 没证明 |
|---|---|---|
| 内置 runner | 真实宿主里的行为 | — |
| CI 导出 | 场景数据 + driver 逻辑 + 断言可判定 | 与真实 DSH 的交互一致（作用域 / 生命周期） |

两条腿**不能互相替代**：CI 轨是回归网，活宿主是真相来源。

### 已能跑通的场景

[`cases/`](cases) 下 **39 条场景**（其中 7 条带 `source.issue` 溯源；`TK-0027` / `TK-0033` / `TK-0035` / `TK-0037`–`TK-0039` 为 `draft`）：

| ID | kind | 测什么 |
|---|---|---|
| [TK-0001](cases/TK-0001.yaml) | tool | driver 自检：注册 → 调用 → 取证链路可用（smoke） |
| [TK-0002](cases/TK-0002.yaml) | tool | 边界：200KB 返回值不失败、值未被截断（精确长度断言） |
| [TK-0003](cases/TK-0003.yaml) | tool | `tools.guard` 拦截：拒绝理由可断言，**且工具本体确实没跑** |
| [TK-0004](cases/TK-0004.yaml) | prompt | 提示词注入：**不跑模型**，靠 `assemble()` 直接断言 |
| [TK-0005](cases/TK-0005.yaml) | llm | 接管模型流：**零上游请求**，输出完全由声明决定 |
| [TK-0006](cases/TK-0006.yaml) | llm | 失败注入：流中途出错时保留已产出内容、以 error finish 收尾 |
| [TK-0007](cases/TK-0007.yaml) | interaction | 提问被应答为声明选择的选项 |
| [TK-0008](cases/TK-0008.yaml) | interaction | 审批返回声明决策，**而不是兜底的 `unavailable`** |
| [TK-0009](cases/TK-0009.yaml) | interaction | 失败路径：无人应答时以超时错误收尾，不静默挂起 |
| [TK-0010](cases/TK-0010.yaml) | session | 人类命令可被驱动，输出与入参都可断言 |
| [TK-0011](cases/TK-0011.yaml) | session | 命令以 error 结果收尾时被如实反映 |
| [TK-0012](cases/TK-0012.yaml) | resource | 假搜索 provider 被接管 + `maxResults` 截断语义 |
| [TK-0013](cases/TK-0013.yaml) | resource | 降级路径：provider 不可用必须报错，不能静默返回空 |
| [TK-0014](cases/TK-0014.yaml) | agent | 派生**真实子 agent** 跑最小任务（⚠️ 会真的调模型；CI 轨里自动跳过） |
| [TK-0015](cases/TK-0015.yaml) | ui | **client 半产物契约**：bundle 可加载、注册了标签与词典、给了渲染函数 |
| [TK-0016](cases/TK-0016.yaml) | agent | **组合场景**：假 web provider（resource）+ 真实子 agent，验证替身会穿透到子 agent |
| [TK-0017](cases/TK-0017.yaml) | tool | **多个 guard 的短路语义**：第一个拒绝后不再询问后续 guard |
| [TK-0018](cases/TK-0018.yaml) | shell | shell driver 自检：跑 `git --version` 与一条必失败命令 |
| [TK-0019](cases/TK-0019.yaml) | shell | **发包面自检**：`files` 白名单必须覆盖入口文件（源自 dsh-memory #48 的形态） |
| [TK-0020](cases/TK-0020.yaml) | file | file driver 自检：读文件、列目录、验证"文件不存在"被如实取证 |
| [TK-0021](cases/TK-0021.yaml) | file | **dsh-memory 发包面回归**：`files` 必须含 `utf8_boot.py`（#48 的直接对应） |
| [TK-0022](cases/TK-0022.yaml) | shell | **隐式顶层导入检查**：自动找出"装机后才会炸"的包内依赖（#12/#48 一类） |
| [TK-0023](cases/TK-0023.yaml) | file | **结构性检查**（`search` 动作）：目标符号必须有调用方（#37「产物无消费方」回归） |
| [TK-0024](cases/TK-0024.yaml) | shell | **#48 的运行时验证**：用 DSH 自带 Python 真跑 `import utf8_boot` 与 `find_spec('md_cg.mcp_server')` |
| [TK-0025](cases/TK-0025.yaml) | shell | **#22 回归**：`_writer_session` 的三条取值口径（显式优先 / 否则取 cg.session / 都没有为 None） |
| [TK-0026](cases/TK-0026.yaml) | shell | **#75（⚠️ 0.8.1 仍存在）**：`csre.build_index()` 因 `md_conn_or_none` 拼写笔误抛 ImportError |
| [TK-0027](cases/TK-0027.yaml) | agent | **team 通道**：`agentTeams.spawnTeammate` 派生真实 teammate，roster 出现成员、回落 `inactive`、产出被取证（`draft`：成员留痕不可逆） |
| [TK-0028](cases/TK-0028.yaml) | tool | **`tools/pre-execute`**：deny / cancel / ask 三条 dispatch 前决策，且**工具本体确实没跑** |
| [TK-0029](cases/TK-0029.yaml) | tool | **`tools/post-execute`**：结果被 `block`（反馈进入交付内容）与 `replace`（改写） |
| [TK-0030](cases/TK-0030.yaml) | fs | **`ctx.fs` 写意图**：`createIfAbsent` 与陈旧版本（`FS_STALE_VERSION`）都必须被拒，且被拒的写不落地 |
| [TK-0031](cases/TK-0031.yaml) | fs | **`ctx.fs` 沙箱**：`read-only` 下写入被拒（`FS_SANDBOX_DENIED`）；后端不实施沙箱策略时诚实跳过 |
| [TK-0032](cases/TK-0032.yaml) | session | **`session/flush` 检查点**：经唯一入口派发，且契约「等每个 listener 结算」有实测耗时佐证 |
| [TK-0033](cases/TK-0033.yaml) | session | **`ctx.goals` 状态机**：`create` 会 arm 自动续轮（driver 默认立刻收回授权）；并实测出「一半目标是 `@Remote` 方法，不能本地直调」（`draft`：留痕） |
| [TK-0034](cases/TK-0034.yaml) | compaction | **压缩边界**：没有安全范围时不压、非法范围被拒、`compactNow` 缺 agent 上下文时如实不可用（只作用于**隔离会话**） |
| [TK-0035](cases/TK-0035.yaml) | compaction | **压缩正向路径**：隔离会话上真的压出摘要；实测出「收缩校验」——成败取决于模型摘要长度，故按 `compactionOutcome` 断言 + soft 形状（`draft`：花 token） |
| [TK-0036](cases/TK-0036.yaml) | shell | **#57 防回退**：保留设备名守卫改「末段直判」后，谓词表两侧（真值须拦 / 假值须放行）与 `_abs_host_path` 的接线都必须在位（`fixture`：需 dsh-memory 0.8.1） |

---

## 快速上手

```powershell
cd <本仓路径>

# 依赖（node/pnpm 用绝对路径，本机不在 PATH 上）
$NODE = '<node 可执行文件路径>'
$PNPM = '<pnpm.mjs 路径>'
& $NODE $PNPM install

# 构建（host 半 tsc + client 半 esbuild）
& $NODE $PNPM run build:all

# 装进 desktop profile（本机实测：**装完无需重启**）
$DSH = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $DSH plugin --profile desktop add .

# 自检
& $NODE $PNPM run gate
```

> **装完即刻可用（本机实测）**：`dsh plugin add` 会触发 profile 热重载，
> 本次会话里 `testkit_list` / `testkit_run` / `testkit_report` / `testkit_export` /
> `testkit_propose` / `testkit_pipeline`
> **当场出现**，不必重启 DSH。
> 客户端那半（会话视图环里的「测试」标签页）如未出现，刷新一次页面即可——
> client bundle 由浏览器加载，不受 host 热重载影响。

装好后在 DSH 里：

- 模型侧工具：`testkit_list` / `testkit_run` / `testkit_report` / `testkit_export` / `testkit_propose` / `testkit_pipeline`
- 人类命令：`/testkit list | run | report | export | reload | issue <open|show|approve|reject|close>`
- 界面：会话视图环里的「测试」标签页

---

## 目录

```
dsh-testkit/
├── docs/            ① 架构 / 开发 / 场景规范 / issue 流程 / 迭代计划 / 发布 / 安全
├── src/
│   ├── cases/       ② 数据层：YAML 类型、校验、装载、注册表
│   ├── kinds/       ③ 驱动层：kind → driver（每类干预点一个）
│   ├── runtime/     ④ 引擎层：夹具、执行、断言、取值、记录
│   ├── report/      ⑤ 报告层：Markdown / JSON / JUnit
│   ├── headless/    ⑥ headless 宿主：契约一致的最小服务集（CI 轨的载体）
│   ├── export/      ⑦ 导出层：生成自包含的 node:test 文件
│   ├── client/      ⑧ client 半：浏览器侧控制台
│   ├── adapters/dsh/  ⑨ 适配层：**全仓唯一允许依赖 `@deepseek-ai/dsh-*` 的目录**（机器守卫）
│   ├── host-facade.ts ⑩ 窄接口 `HostFacade` 的装配（只经适配层取 DSH 原语）
│   ├── http.ts      ⑪ client 通道（webServer 路由）
│   ├── tools.ts     ⑫ 模型工具面
│   └── commands.ts  ⑬ 人类命令面
├── cases/           ⑭ 场景数据：一案一 YAML（真源）
├── pipeline/        ⑮ 提炼闸门：批次台账 `ledger.json` + 提案 `proposals/`（批准后才进 cases/）
├── scripts/         ⑯ 构建 client 半 / 校验场景 / 校验文档 / 适配层守卫 / 导出 CI 用例
│                    ⑯′ 另含**通用检查器**（见下）、串行化编译闸门与 fixture 准备 / 提炼工具
├── tests/           ⑰ 插件自身的单元测试（含 headless 宿主与自举契约）
├── .github/         ⑱ CI 工作流：2 档 Node × 3 个平台的 `pnpm run gate`
├── runs/            运行产物（git 忽略）
├── export/          导出的 CI 用例（git 忽略，gate 会重新生成并跑）
├── .fixtures/       外部被测对象（git 忽略；`scripts/fetch-fixtures.mjs` 准备）
└── cases-draft/     从 issue 数据提炼的草稿（git 忽略；`scripts/from-issue-data.mjs` 生成）
```

### 可复用的检查器

下面三个脚本是**从真实 issue 形态提炼出来的通用判据**，任何 npm 包都能用；
第四个是**本仓自己的结构守卫**（它守的是"适配层是唯一入口"这条架构承诺）：

| 脚本 | 抓什么 | 源自 |
|---|---|---|
| `check-pack-files.mjs` | `files` 白名单是否覆盖入口声明的文件 | `dsh-memory#48` |
| `check-python-topimports.mjs` | 包内非相对顶层导入是否被打进包（"装机后才炸"） | `dsh-memory#12/#48` |
| `check-git-installable.mjs` | 从 git 安装会不会得到没有入口文件的空壳 | `dsh-memory#2` |
| `check-adapter-boundary.mjs` | `@deepseek-ai/dsh-*` 的 import / `import()` / `require()` 是否只出现在 `src/adapters/dsh/` 下（**注释里的包名不算**） | 本仓架构承诺 |

用法：`node scripts/<name>.mjs <包目录>`，退出码 0/1。
适配层守卫也接进了 gate 链（`pnpm run verify:adapter`），所以它不会只躺在脚本目录里。

---

## 三条设计要点

**1. 场景即数据。** 新增一条测试场景，理想情况下只加一个 YAML 文件、不改代码——只有*新类型*的场景才需要写 driver。

**2. 一切干预可回滚。** DSH 的扩展点天然是「注册即返回 disposer」，所以「制造测试条件」=「安装可回滚的注册」。所有 driver 的注册都必须经 `Fixture.add()` 登记，场景结束逆序释放——这是活宿主测试不互相污染的前提。

**3. 双半分离、单点适配。** driver 不直接依赖 cordis `Context`，而是依赖窄接口 `HostFacade`；对 DSH 的真实调用收敛在 `src/host-facade.ts`，而 `@deepseek-ai/dsh-*` 这个包级别的依赖进一步收敛在 `src/adapters/dsh/`。好处是核心逻辑（断言、夹具、校验、执行）可以脱离宿主单测，DSH 升级时改动集中在一层——而且这层边界由 `scripts/check-adapter-boundary.mjs` **机器守住**，不靠 review 记忆。

---

## 文档

| 文档 | 内容 |
|---|---|
| [架构设计](docs/ARCHITECTURE.md) | 双半架构、概念模型、kind 分类学、设计决策、风险清单 |
| [开发文档](docs/DEVELOPMENT.md) | 环境、构建、安装、调试、HMR、真实验证流程、排障、代码约定 |
| [场景数据规范](docs/SCENARIO-SPEC.md) | `cases/*.yaml` 的完整字段规范（含组合场景、`cost` / `budget` 两个成本字段） |
| [issue 提炼流程](docs/ISSUE-PIPELINE.md) | 从一个 issue 到一条可复现场景的五步法 ＋ **提炼闸门**（要不要提炼 / 要不要落地，由人按批决定） |
| [迭代计划](docs/ROADMAP.md) | Phase 0–14 的目标、交付物与验收标准（含剩下的三件"必须由真实环境给证据"的事） |
| [发布与改名清单](docs/PUBLISHING.md) | 0.2.0 发布清单、npm scoped rename 的全量引用与耦合点、活宿主验证步骤 |
| [迁移指南](docs/MIGRATION.md) | 0.1.0 → 0.2.0：默认值变化、新增字段、`enum`/`const` 保真的恢复路径、包名与形态变化 |
| [DSH 官方工具链集成](docs/DSH-INTEGRATION.md) | 与 DSH 的声明式契约、对外四类产物、与 doctor / composition / 单元测试框架的分工 |
| [供应链与合规](docs/SUPPLY-CHAIN.md) | 依赖锁定与审计、场景禁网、secret 扫描、发布 provenance、Actions 硬化，以及**我们做不到的** |
| [治理与 RFC](docs/GOVERNANCE.md) | 版本与弃用策略、RFC 流程、release cadence、**good first issues 候选**（[RFC 模板](docs/rfc/0000-template.md)） |
| [安全策略与数据隐私](SECURITY.md) | 漏洞报告渠道与范围、响应承诺；report / fixture 的数据边界与保留策略 |
| [变更日志](CHANGELOG.md) | 每个版本改了什么、怎么迁移、明确推迟了什么以及为什么 |
| [贡献指南](CONTRIBUTING.md) | 环境、怎么加一条场景 / 一个 driver（12 kind 的纪律）、质量门与不要做的事 |
| [行为准则](CODE_OF_CONDUCT.md) | 参与本项目的社区约定 |

---

## 验证过的事实（非推测）

架构文档里的这些结论来自本机实测或 DSH 发行体源码核对，不是猜的。

- 插件 = Cordis 插件；`dsh.bundle.patch` 声明 host 半，`dsh.client` 声明 client 半
- host 半工具：`defineTool({...})` + `ctx.tools.register(def) → disposer`
- host 半命令：`ctx.commands.register({ name, description, input?, handler(invocation) })`；
  `handler` 收到 `{ rawInput, signal, agent, attachments }`，须返回 `{kind:'success'|'error'}`
- host 半路由：`ctx.webServer.register({ kind: 'exact'|'prefix', path, handler(req, res) })`
- client 半产物：`window.__ModuleLoader__.load({ id, factory })`，`require("react")` 由宿主模块表注入
- **双半通道**：静态插件包**没有** `host.call`（`harness.handle` 属动态包沙箱，定义在
  `dsh-cordis-host-runner` 的 guard 里）→ 本插件用自建 HTTP bridge
- **能力探测**：只能用 `ctx.get(name)`；`ctx.someService` 在未 `inject` 时会**抛错**
  （这个坑被集成测试抓到过，现已回归覆盖）
- **能力探测不能拍快照**：cordis 激活是异步的，`apply()` 时排在后面的插件可能还没注册
  （详见 ARCHITECTURE 教训三）
- **依赖的服务要等**：`apply()` 里要用 `ctx.inject([...], cb)` 等 `webServer` 就绪，
  否则 bridge 路由会静默不注册（详见教训四）
- **headless 宿主可行**：`new Context()` + `ctx.provide(...)` 就能装载本插件并打端点，
  不需要跑完整 DSH
- **client 半 revision** 由入口 `mtimeMs`/`ctimeMs`/大小派生 → 重建 + 刷新即生效，无需重建 Web 产物
- slot 注册：`ctx.slots.inject(name, () => ctx.slots.register(meta, Component))`
- 可用落点：`conversation.view`、`tool.call.toolview`、`settings.section`、`sidebar.right.*`
- **子 agent 不能人工交互**：`ask_user_question` 在子 agent 里直接返回
  `human interaction is unavailable while the calling agent is owned by another live agent`
- **热重载工作**：长期运行的 profile 下改 `cases/*.yaml`，无需重启即生效
- **改 host 半代码必须重启 DSH**：`plugin_manager` 的 disable → enable 会重新 `apply()`
  但**不打破 Node 模块缓存**（实测：重新 apply 后 `testkit_run` 仍是旧代码行为）；
  最省事的验证是另起一个 headless 新进程
- **team 通道真的通**：`TK-0027` 经 `agentTeams.spawnTeammate` 创建 teammate，
  观察到 `running → inactive` 回落、child 会话产出 `TESTKIT_OK`，且该 teammate 会用
  `send_message` 把结果回传给 Lead（实测于 2026-10-10，独立 headless 新进程）
- 当前 DSH 版本 `0.2.0-rc.2`，profile `desktop`

风险台账（R1–R10 全部结案）见 [ARCHITECTURE.md §9](docs/ARCHITECTURE.md)。

---

## 许可

MIT
