# 功能清单

本文只列**已经实现并实测过**的能力。每条都标注了验证方式，没有"计划中"的内容——
路线图见 [ROADMAP.md](ROADMAP.md)。

---

## 1. 模型工具（13 个）

装进 profile 后由模型直接调用。**本机实测：`dsh plugin add` 后当场出现，无需重启。**

| 工具 | 作用 | 参数 |
|---|---|---|
| `testkit_list` | 列出场景，可按 kind / tag / status 过滤，同时回显无法解析的文件 | `kinds?` `tags?` `status?` `includeInvalid?` |
| `testkit_run` | 运行场景（省略选择器 = 跑全部 active），返回摘要并写出报告；**总是带成本闸门** | `ids?` `only?` `kinds?` `tags?` `owner?` `cost?` `smoke?` `changed?` `since?` `affectedBy?` `dshVersion?` `parallelLimit?` `redact?` `allowModel?` `allowLowCost?` `maxModelCalls?` `allowFileWrite?` `timeoutMs?` |
| `testkit_report` | 读取最近一次或指定 Run ID 的报告 | `runId?` `full?` |
| `testkit_export` | 导出为可脱离活宿主运行的 CI 用例，或把失败项导成 `bug_report/`（touchstone） | `target` `ids?` `outDir?` `runId?` |
| `testkit_expand` | 把 `use:` 步骤展开成 flat 步骤（组合系统自证） | `id` |
| `testkit_trace` | 步骤级 trace：`timeline` / `json` / `chrome` / `otel` | `runId?` `format?` `top?` `full?` |
| `testkit_trend` | 历史趋势（kind / tag / owner / dshVersion 四维） | `dimension?` `limit?` |
| `testkit_coverage` | 覆盖矩阵 + 可行动的缺口清单 | — |
| `testkit_search` | 场景全文搜索 + 过滤（0 条时解释为什么） | `text?` `kinds?` `tags?` `owner?` `cost?` `status?` |
| `testkit_triage` | 生成 PR 评论或 issue 草稿（**只出文本，不发请求**） | `runId?` `format?` |
| `testkit_doctor` | 宿主体检：能力矩阵 / 哪些场景会 skip / 残留 / 最近读数 | `maxGaps?` |
| `testkit_propose` | 提交一条提炼提案：**只写 `pipeline/proposals/`**，质量预检不过不落盘；没有 open 批次会被拒绝 | `yaml` `notes?` |
| `testkit_pipeline` | 只读查看提炼台账（当前批次 / 提案裁决状态 / 历史） | `proposalId?` |

> 模型**没有** `approve`：落地能力只挂在人类命令面。这是提炼闸门成立的前提。
> 工具面的权限也只**收**不放：`allowModel: true` 只在配置已允许时才有效（放权只有 `/testkit run --allow-model`）。

## 2. 人类命令与独立 CLI

**DSH 命令面**（`/testkit`；完整子命令表见 `src/commands.ts`，`/testkit help` 会列全部。下面是常用集）：

```
/testkit list  run  report  expand  export  import  trace  trend  coverage  search  triage  doctor  reload  issue
```

`run` 的开关：`--kind --tag --owner --cost --smoke --smoke-budget --changed --since --affected-by
--dsh-version --parallel --redact --allow-model --allow-low-cost`。

**独立 CLI**（`bin/dsh-testkit.mjs`，与命令面**共用同一套引擎**）：

```bash
dsh-testkit run --changed --parallel 4      # 增量 + 并发
dsh-testkit doctor                          # 宿主体检
dsh-testkit triage --format issue           # 生成 issue 草稿（不发请求）
dsh-testkit coverage / trend / trace --format chrome / search <词> / export / import
```

退出码：`0` 全部通过（含 skipped）· `1` 有 failed/errored · `2` 用法错误或选中 0 条 · `3` 基础设施错误。

提炼闸门挂在 `issue` 子命令里——**要不要提炼、要不要落地，只有这里能决定**：

```
/testkit issue open <范围说明>          开启本轮提炼（模型此后才能提交提案）
/testkit issue show <P-xxxx>           看提案正文与质量预检明细
/testkit issue approve <P-xxxx|--all>  批准落地：分配 TK 号 + 写 cases/ + 重建索引
/testkit issue reject <P-xxxx|--all>   拒绝（提案文件留在 proposals/ 留痕）
/testkit issue close [理由]            作废本轮（不裁决）
/testkit issue                         查看台账
```

## 3. 场景类型：12 个 kind

每个 kind 对应一类"可干预的扩展点"。`requires` 是**运行时能力声明**——
宿主缺这个能力时场景会**跳过并说明原因**，而不是失败。

| kind | requires | 干什么 |
|---|---|---|
| `tool` | `tools` | 注册临时工具 / 按声明制造返回行为 / 经**真实工具管道**调用并取证；两条 waterfall：`tools/pre-execute`（dispatch 前决策）与 `tools/post-execute`（结果改写/阻塞） |
| `prompt` | `systemPrompt` | 注册系统提示的 section / context / variable，并主动组装一次以取证 |
| `llm` | `llm` | 接管 `llm/stream`：输出、失败注入、用量伪造全部由声明决定（**零上游请求**） |
| `interaction` | — | 模拟人的回答与审批决策（接管 `user-questions/request` 与 `approval/request`） |
| `session` | `commands` ＋ `sessions` ＋ `goals` | 四个分支：临时人类命令 / `session/flush` 检查点 / `ctx.goals` 目标状态机 / **只读**观察 `session/event` |
| `resource` | — | 假 web provider（含"不可用"与"抛错"两条降级路径） |
| `agent` | `subagents` ＋ `agentTeams` | 两条通道：`one-shot` 派生**真实**子 agent；`teammate` **复用 Agent Teams** 创建 durable 队友并断言 roster（⚠️ 会真调模型、花 token） |
| `ui` | — | 在隔离 `node:vm` 里加载 **client 半真实产物**，验证契约与 slot / 词典注册 |
| `shell` | `subprocess` | 跑外部命令（`argv` 数组，**无 shell 解析**）并取证输出与退出码 |
| `file` | — | 读文件 / 列目录 / **搜内容**（对应 grep）；**纯离线** |
| `fs` | `fs` | 驱动**宿主文件服务**：沙箱策略（`read-only` / `workspace-write`）、写意图（`createIfAbsent` / `replaceIfVersion`）、陈旧版本保护 |
| `compaction` | `sessions` ＋ `compaction` | 会话历史压缩边界：压力策略**该压才压**、非法范围被拒、`compactNow` 缺 agent 上下文时如实不可用（**只作用于隔离会话**） |

> **两个纯离线 kind**：`ui` 与 `file` 不依赖任何宿主服务，所以在 CI 轨里也**不会**被跳过。
> `fs` **不在此列**——它测的正是宿主服务的语义（沙箱与版本），CI 轨里会跳过。

## 4. 场景数据

- **一案一 YAML**（`cases/TK-XXXX.yaml`），加一条场景理想情况下**只加文件、不改代码**
- **39 条场景**，分布：`shell=7` `tool=8` `session=4` `interaction=3` `file=3` `agent=3` `llm=2` `resource=2` `fs=2` `compaction=2` `prompt=1` `ui=1`（含 3 条用 `use:` 组合的 draft）
- **索引** `cases/index.yaml` 由守卫自动维护，禁止手工编辑
- **溯源**：场景可带 `source.issue`（真实 issue 派生的场景必须带）

## 5. 断言能力

**17 个断言词**：

```
is  isNot  exists  notExists  contains  notContains  matches
length  lengthAtLeast  lengthAtMost  atLeast  atMost  throws
```

- 取值路径前缀：`fx.*`（取证）/ `env.*`（场景变量）/ 容器
- **约 241 个取证字段**（`fx.*`），由 `verify:docs` 守卫保证"文档里写的字段一定真实存在"

## 6. 执行引擎

| 能力 | 说明 |
|---|---|
| **一切干预可回滚** | 所有注册经 `Fixture.add()` 登记，场景结束**逆序释放** → 场景之间不互相污染（有专项测试） |
| **双轨执行** | ① 内置 runner（活宿主）② 导出为**自包含** `node:test`（不需要 DSH 就能跑） |
| **跨 kind 组合** | 一个场景的 `setup` 可含多个 kind，`act` 按**动作形状**分派 driver |
| **每步取证增量** | 多步场景里同名 key 不互相覆盖，早期步骤的现场可追溯 |
| **惰性能力探测** | 宿主缺能力 → 跳过并说明原因，而不是失败（cordis 激活是异步的） |
| **超时与取消** | 单场景超时 + `AbortSignal` 贯穿 |
| **成本闸门** | 按场景 `cost` 档位（缺省取参与 driver 的最高档）判定放行：`none` 恒放行、`low` 需 `allowLowCost`、`high`（真调模型）**默认拒绝**；被拒记为 skipped 并带理由，不伪装成失败 |
| **预算上限** | 场景可写 `budget: { maxModelCalls, maxTokens }`（`0` = 不限），只能收紧不能放宽；超限判 failed 并归因 `env`（运行条件不足，不是产品结论） |
| **失败归因 + 最小复现** | 失败给出机器可读的类别与一段可直接复跑的最小复现（`src/analysis/`），报告与 `testkit_run` 都能看到 |

## 7. 报告

- **Markdown 报告** `runs/<RUN-ID>/report.md`（人读）
- **JSON 报告** `runs/<RUN-ID>/run.json`（机读，含逐步断言与取证）
- **JUnit XML** `runs/<RUN-ID>/junit.xml`（**CI 消费**：`testsuites` 根、按 kind 分 `testsuite`、
  每条场景一个 `testcase`；failed → `<failure>`、errored → `<error>`、skipped → `<skipped message>`，
  XML 特殊字符与控制字符已转义/剔除）
- **JSON Schema** `schemas/run-report.schema.json`（draft 2020-12）覆盖 `run.json` 的结构，
  新增字段一律允许缺省——它是**契约**，不是"最好别改"的建议
- **失败归因**：概览表带「归因」列；"需要关注"段给出归因标签、最小复现、repeat 轮次、
  闸门判定（`policy`）与用量（`usage`）
- **两种表面**：模型工具面 / 人类命令面**共用同一份实现**，避免漂移

## 8. 界面（client 半）

- 会话视图环里的**「测试」标签页**
- 通过自建 HTTP bridge 与 host 半通信（`/api/dsh-testkit/<endpoint>`）
- **`ui` kind 能验证它**：在隔离 vm 里加载真实 bundle，断言导出了 apply、注册了 slot、加载了词典

## 9. 质量守卫（每次 `gate` 都跑）

| 守卫 | 抓什么 |
|---|---|
| `verify:cases` | **架构一致性**：每个 kind 必须有 driver、索引自洽、`setup` 键合法（能抓 `setup.tolls` 这类笔误）、无孤儿场景 |
| `verify:docs` | **文档漂移**：链接存在、`fx.*` 字段存在、`pnpm run <script>` 存在、`scripts/*.mjs` 存在、`cases/` 场景计数一致 |
| `verify:adapter` | **适配层边界**：`@deepseek-ai/dsh-*` 的静态 import / `import()` / `require()` 只允许出现在 `src/adapters/dsh/` 下（注释里的包名不算） |
| `verify:pack` | **打包面**：`files` 白名单覆盖 `main` / `types` / `exports` / `dsh.bundle.patch` / **`bin`** 声明的路径 |
| `verify:git-install` | **git 安装形态**：从 git 装出来不能是没有入口的空壳（`prepare` 是否存在） |
| `verify:fixtures` | **夹具**：schema、`name` ↔ 路径一致、`dsh_version` 可解析、敏感扫描，以及"场景声明的夹具必须存在" |
| `verify:registry` | **组合系统**：片段无环、`act`/`use` 互斥、禁 YAML 控制流与场景级 include、展开不残留 `use`/`with` |
| `verify:secrets` | **敏感数据**：会入库或进产物的文件里不许有 token / 私钥 / 邮箱 / 家目录路径（**只报位置不打印原文**） |
| `verify:lock` | **供应链**：`package.json` 的依赖逐项能在 `pnpm-lock.yaml` 找到，`packageManager` 与 CI 声明一致 |
| `verify:ci` | **Actions 硬化**：显式最小 `permissions`、禁 `pull_request_target` / secrets 取值 / `continue-on-error`、每个 `uses:` 钉 40 位 SHA |

> 这十个守卫都是**踩坑之后加的**——文档与实现静默漂移过一次，
> "DSH 依赖散落各处""装出来缺件""临时目录堆成垃圾""假 token 混进测试"
> 这些形态，只有机器查得出来。

## 10. 检查器（通用判据 + 本仓结构）

前三个是**从真实 issue 形态提炼、任何 npm 包都能用**的通用判据，
其余是本仓的结构守卫；退出码统一 0/1：

| 脚本 | 抓什么 | 源自 |
|---|---|---|
| `check-pack-files.mjs <包目录>` | `files` 白名单是否覆盖入口声明的文件（含 `bin`） | #48 |
| `check-python-topimports.mjs <包目录>` | 包内**非相对顶层导入**是否被打进包（"装机后才炸"） | #12 / #48 |
| `check-git-installable.mjs <包目录>` | 从 git 安装会不会得到没有入口文件的**空壳** | #2 |
| `check-adapter-boundary.mjs` | DSH 内部包依赖是否越出 `src/adapters/dsh/` | 本仓架构承诺 |
| `check-secrets.mjs` | 敏感数据（见 §9） | 数据隐私 |
| `check-ci-hardening.mjs` | Actions 权限与 SHA 钉（见 §9） | 供应链 |
| `check-lockfile.mjs` | 依赖与锁文件一致性 | 供应链 |

## 11. 提炼工具链

| 脚本 / 机制 | 作用 |
|---|---|
| `from-issue-data.mjs <数据目录>` | issue 数据 → 逐条草稿 + **按形态分组的能力缺口报告**（批量候选，产出到 git 忽略的 `cases-draft/`） |
| `fetch-fixtures.mjs [--list] [名字]` | 下载外部被测对象到 `.fixtures/`（走 registry 直链，不碰任何 profile） |
| `/testkit issue` ＋ `testkit_propose` | **逐批闸门**：人开批次 → 模型提交提案 → 人批准才落地 |

**纪律**：草稿的 `expect` 全是显式 TODO。**判据必须人来定**——
机器猜出来的判据只会制造"看起来在测、其实没测"的假象。

**两套东西的分工**（别混）：

- `scripts/from-issue-data.mjs` 是**批量筛查**：一次把几百条候选过一遍，
  产出"哪些形态值得提炼"的地图——它管的是**线索**。
- `/testkit issue` 是**逐批闸门**：一次一批、每批都要人批准，
  提案进 `pipeline/proposals/`，批准后才成为 `cases/TK-XXXX.yaml`——
  它管的是**质量与节奏**，不是数量。
- 台账 `pipeline/ledger.json` 是"要不要提炼 / 有没有落地"的唯一证据。

## 12. 令牌与外部对象

| 令牌 | 替换成 |
|---|---|
| `$NODE` | `process.execPath` |
| `$PYTHON` | 探测到的 Python（环境变量 → **DSH 自带** → PATH，三级回退） |
| `$PKG` / `$PKG/<子路径>` | 本插件包根 |
| `$FIXTURES` / `$FIXTURES/<名字>` | 外部 fixture 根（git 忽略） |

**`fixture` 标签**是质量门的分层机制：带它的场景测的是**外部被测对象**，
`gate` 默认不导出它们——否则**被测对象的 bug 会把插件的质量门染红**。
巡检外部对象用 `--include-fixture`。

---

## 实测验证状态

```
gate            705 项单测（含契约轨 65）+ 26 条导出场景          全绿
真实 DSH 全量    27 条时点的读数：26 条 active → 25 通过 / 1 失败 / 0 跳过   见下
                （TK-0027 是 draft：团队通道留痕不可逆，按需单跑）
team 通道        TK-0027 在独立 headless 新进程 passed（703ms，真 spawnTeammate）
tool waterfall   TK-0028 / TK-0029 在同一条独立 headless 新进程 2/2 passed
fs 语义          TK-0030 / TK-0031 在同一条独立 headless 新进程 2/2 passed
session 面       TK-0032 / TK-0033 在同一条独立 headless 新进程 2/2 passed
compaction 边界  TK-0034 在同一条独立 headless 新进程 passed
compaction 正向  TK-0035 单跑通过（已实测压出真实摘要；成败取决于模型摘要长度，故按 outcome 断言）
client 半       typecheck 通过，bundle 可加载
```

**那 1 条失败是 `TK-0026`**，它如实抓到了 `dsh-memory` 0.8.1（latest）里一个真实缺陷：

```
csre.py:61        from md_access import md_conn_or_none    ← 不带下划线
md_access.py:447  def _md_conn_or_none():                  ← 实际带下划线
```

这不是插件的缺陷，而是**插件抓到了被测对象的缺陷**——正是它存在的意义。
