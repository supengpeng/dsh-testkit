# 功能清单

本文只列**已经实现并实测过**的能力。每条都标注了验证方式，没有"计划中"的内容——
路线图见 [ROADMAP.md](ROADMAP.md)。

---

## 1. 模型工具（4 个）

装进 profile 后由模型直接调用。**本机实测：`dsh plugin add` 后当场出现，无需重启。**

| 工具 | 作用 | 参数 |
|---|---|---|
| `testkit_list` | 列出场景，可按 kind / tag / status 过滤，同时回显无法解析的文件 | `kinds?` `tags?` `status?` `includeInvalid?` |
| `testkit_run` | 运行场景（省略选择器 = 跑全部 active），返回摘要并写出报告 | `ids?` `kinds?` `tags?` `timeoutMs?` |
| `testkit_report` | 读取最近一次或指定 Run ID 的报告 | `runId?` `full?` |
| `testkit_export` | 导出为可脱离活宿主运行的 CI 用例 | `target` `ids?` `outDir?` |

## 2. 人类命令（1 个命令 + 5 个子命令）

```
/testkit list      /testkit run      /testkit report
/testkit export    /testkit reload
```

## 3. 场景类型：10 个 kind

每个 kind 对应一类"可干预的扩展点"。`requires` 是**运行时能力声明**——
宿主缺这个能力时场景会**跳过并说明原因**，而不是失败。

| kind | requires | 干什么 |
|---|---|---|
| `tool` | `tools` | 注册临时工具 / 按声明制造返回行为 / 经**真实工具管道**调用并取证 |
| `prompt` | `systemPrompt` | 注册系统提示的 section / context / variable，并主动组装一次以取证 |
| `llm` | `llm` | 接管 `llm/stream`：输出、失败注入、用量伪造全部由声明决定（**零上游请求**） |
| `interaction` | — | 模拟人的回答与审批决策（接管 `user-questions/request` 与 `approval/request`） |
| `session` | `commands` | 注册临时人类命令并驱动它 |
| `resource` | — | 假 web provider（含"不可用"与"抛错"两条降级路径） |
| `agent` | `subagents` | 派生**真实**子 agent 跑任务并断言轨迹（⚠️ 会真调模型、花 token） |
| `ui` | — | 在隔离 `node:vm` 里加载 **client 半真实产物**，验证契约与 slot / 词典注册 |
| `shell` | `subprocess` | 跑外部命令（`argv` 数组，**无 shell 解析**）并取证输出与退出码 |
| `file` | — | 读文件 / 列目录 / **搜内容**（对应 grep）；**纯离线** |

> **两个纯离线 kind**：`ui` 与 `file` 不依赖任何宿主服务，所以在 CI 轨里也**不会**被跳过。

## 4. 场景数据

- **一案一 YAML**（`cases/TK-XXXX.yaml`），加一条场景理想情况下**只加文件、不改代码**
- **26 条场景**，分布：`shell=6` `tool=4` `interaction=3` `file=3` `llm=2` `session=2` `resource=2` `agent=2` `prompt=1` `ui=1`
- **索引** `cases/index.yaml` 由守卫自动维护，禁止手工编辑
- **溯源**：场景可带 `source.issue`（真实 issue 派生的场景必须带）

## 5. 断言能力

**17 个断言词**：

```
is  isNot  exists  notExists  contains  notContains  matches
length  lengthAtLeast  lengthAtMost  atLeast  atMost  throws
```

- 取值路径前缀：`fx.*`（取证）/ `env.*`（场景变量）/ 容器
- **约 130 个取证字段**（`fx.*`），由 `verify:docs` 守卫保证"文档里写的字段一定真实存在"

## 6. 执行引擎

| 能力 | 说明 |
|---|---|
| **一切干预可回滚** | 所有注册经 `Fixture.add()` 登记，场景结束**逆序释放** → 场景之间不互相污染（有专项测试） |
| **双轨执行** | ① 内置 runner（活宿主）② 导出为**自包含** `node:test`（不需要 DSH 就能跑） |
| **跨 kind 组合** | 一个场景的 `setup` 可含多个 kind，`act` 按**动作形状**分派 driver |
| **每步取证增量** | 多步场景里同名 key 不互相覆盖，早期步骤的现场可追溯 |
| **惰性能力探测** | 宿主缺能力 → 跳过并说明原因，而不是失败（cordis 激活是异步的） |
| **超时与取消** | 单场景超时 + `AbortSignal` 贯穿 |

## 7. 报告

- **Markdown 报告** `runs/<RUN-ID>/report.md`（人读）
- **JSON 报告** `runs/<RUN-ID>/run.json`（机读，含逐步断言与取证）
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

> 这两个守卫都是**踩坑之后加的**——文档与实现静默漂移过一次。

## 10. 三个通用检查器

从真实 issue 形态提炼，**任何 npm 包都能用**，退出码 0/1：

| 脚本 | 抓什么 | 源自 |
|---|---|---|
| `check-pack-files.mjs <包目录>` | `files` 白名单是否覆盖入口声明的文件 | #48 |
| `check-python-topimports.mjs <包目录>` | 包内**非相对顶层导入**是否被打进包（"装机后才炸"） | #12 / #48 |
| `check-git-installable.mjs <包目录>` | 从 git 安装会不会得到没有入口文件的**空壳** | #2 |

## 11. 提炼工具链

| 脚本 | 作用 |
|---|---|
| `from-issue-data.mjs <数据目录>` | issue 数据 → 逐条草稿 + **按形态分组的能力缺口报告** |
| `fetch-fixtures.mjs [--list] [名字]` | 下载外部被测对象到 `.fixtures/`（走 registry 直链，不碰任何 profile） |

**纪律**：草稿的 `expect` 全是显式 TODO。**判据必须人来定**——
机器猜出来的判据只会制造"看起来在测、其实没测"的假象。

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
gate            276 项单测 + 20 条导出场景          全绿
真实 DSH 全量    26 条 → 25 通过 / 1 失败 / 0 跳过    见下
client 半       typecheck 通过，bundle 可加载
```

**那 1 条失败是 `TK-0026`**，它如实抓到了 `dsh-memory` 0.8.1（latest）里一个真实缺陷：

```
csre.py:61        from md_access import md_conn_or_none    ← 不带下划线
md_access.py:447  def _md_conn_or_none():                  ← 实际带下划线
```

这不是插件的缺陷，而是**插件抓到了被测对象的缺陷**——正是它存在的意义。
