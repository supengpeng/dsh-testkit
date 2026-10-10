# 与 DSH 官方工具链的集成（Integration）

> 目标读者：想知道"这东西在 DSH 生态里到底占哪一格、怎么与官方工具配合"的人。
> 原则（文档 §7.3）：**官方有工具就做适配，不替代。**

---

## 1. 本包不是一个独立工具，它就是一个 DSH 插件

`package.json` 的 `dsh` 段是它与宿主之间的**声明式契约**：

```jsonc
"dsh": {
  "engines": { "dsh": ">=0.2.0-rc.2" },
  "compatibility": { "dshReleases": { "0.2.0-rc.2": "compatible" }, "profiles": ["desktop", "web"] },
  "bundle": { "patch": "./dsh/cordis.patch.yml" },          // host 半：往 profile 的插件 roster 插一行
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "…-ui-conversation", "…-ui-settings"] }
}
```

安装方式因此有两条，且**只有**这两条：

| 半 | 入口 | 说明 |
|---|---|---|
| host 半 | `main` → `lib/index.js`（`inject = ['tools']`） | 注册 **13 个工具**（真源：`src/tools.ts`）/ **1 个人类命令**（子命令表见 `src/commands.ts`）/ **4 条 HTTP bridge 路由** / cases 热重载 |
| client 半 | `dsh.client` → `./client` → `lib/client.js` | 在 `conversation.view` 插入「测试」标签页；注册 locale 命名空间 `dsh-testkit` |

## 2. 我们对外**产出**什么格式（这是集成的真正接口）

| 产物 | 谁消费 | 说明 |
|---|---|---|
| `runs/<RUN-ID>/junit.xml` | 任何 CI（GitHub Actions、Jenkins、GitLab、`dorny/test-reporter`…） | 标准 JUnit XML；failed→`<failure type="<归因>">`、errored→`<error>`、skipped→`<skipped>` |
| `runs/<RUN-ID>/run.json` | 机器 / 看板 / 后续工具 | 结构契约在 [`schemas/run-report.schema.json`](../schemas/run-report.schema.json)（draft 2020-12）；新增字段**只增不改** |
| `runs/<RUN-ID>/trace.json` | 性能排查 | 步骤级真实偏移；另有 Chrome Trace / OTLP 两种导出（见 `testkit_trace`） |
| `runs/<RUN-ID>/report.md` | 人 | 概览 + 归因 + 最小复现 + 可能原因 |
| `export/scenarios.test.mjs` | 没有 DSH 的机器 | **自包含** `node:test` 文件（自带 headless 宿主）；证明的是"场景数据 + driver 逻辑"，不替代活宿主验证 |
| `bug_report/<CASE-ID>/…` | [touchstone-dsh](TOUCHSTONE.md) | 适配器产物（不合并代码库、不共享数据库） |

> **一句话**：给 CI 的是 JUnit，给工具的是 JSON（有 schema），给人看的是 Markdown，给 APM 的是 OTLP。

## 3. 与官方/社区邻近工具的分工（不重叠）

| 需求 | 该用谁 | 为什么不是我们 |
|---|---|---|
| 插件 manifest / patch / 打包的**静态**预检 | 官方与社区的 doctor 类工具 | 我们是**运行期**行为测试，不做静态体检 |
| profile / session / 环境的**离线**诊断 | 同上 | 我们只回答"这条场景在宿主里跑出来是什么样" |
| 多 bundle 在 composition 阶段冲突 | composition 检查类工具 | 我们一次只驱动一个目标 |
| 插件自身逻辑的单元测试 | 你的测试框架（`node:test` / vitest） | 我们不重造断言库（本仓只用 `node:test`） |
| **用真实宿主生命周期验证行为**（工具注册、waterfall 接管、子 agent、会话压缩…） | **本包** | 这是我们的生态位 |

## 4. 我们对 DSH 内部约定的依赖（改动会影响本包，必须知道）

| 约定 | 我们的用法 | 反查方式 |
|---|---|---|
| `llm/stream`、`tools/pre-execute`、`tools/post-execute`、`approval/request`、`user-questions/request` 等 **waterfall/event 名** | driver 靠它们造条件 | `scripts/check-adapter-boundary.mjs` 保证 `@deepseek-ai/dsh-*` 只出现在 `src/adapters/dsh/`；换名字只改适配层 |
| client 模块 id = **package.json 的 name** | `scripts/build-client.mjs` 从 `package.json` 读，不硬编码（DSH 自己的客户端包同样用 scoped 包名做 id） | `cases/TK-0015.yaml` + `tests/ui-driver.test.mjs` 在隔离 vm 里加载真实产物并断言 id / slot / 词典 |
| bundle patch 由 `dsh.bundle.patch` 声明 | `dsh/cordis.patch.yml` 把 host 半插进 roster | `tests/adapter-boundary.test.mjs` 会用本仓 `yaml` 解析 CI 工作流；patch 文件由集成测试覆盖 |
| `defineTool` 的 ParameterSchemaSpec 只接受**标量**约束（`enum` / `const`），且根级 `additionalProperties` **无法表达** | `jsonSchemaToParameters` 忠实传递标量约束、显式丢弃根级 openness（并在契约里写清） | `tests/contracts/dsh-tools.contract.mjs`（含"非法 schema 必须早炸"的反安慰剂） |

## 5. DSH 版本对齐策略

- 声明在 `dsh.engines.dsh`；`compatibility.dshReleases` 记录**实测过**的版本（当前 `0.2.0-rc.2`）。
- 报告里记录 `dshVersion`（配置项 > `DSH_VERSION` 环境变量 > `unknown`）。**为什么不能自动读**：插件以符号链接装在 profile 的 `node_modules` 下，而宿主包在 asar 里，不在插件的解析路径上——所以需要精确值时在 profile patch 里显式配。
- `--dsh-version <v>` / `testkit_run { dshVersion }` 可按版本过滤场景：fixture 的 `dsh_version` 不匹配就**跳过并说明**，而不是装作跑过。

## 6. 我们不做的（以免与官方工具打架）

- 不做插件**安装器**（`dsh plugin add` 是官方入口）；我们只是一个"可被安装的包"。
- 不做 profile / 配置的**修复**（那是 doctor 类工具的活）。
- 不重造 CI 引擎：`gate` 就是一层脚本链，任何 CI 都能跑（本仓用的是 GitHub Actions 矩阵）。
- 不承诺跨 DSH 大版本兼容：`compatibility` 是**实测记录**，不是"应该没问题"。

## 7. 仍然需要活宿主验证的部分（如实声明）

| 项 | 为什么本机做不了 | 怎么验 |
|---|---|---|
| 改名后的 client 模块 id 与「测试」标签渲染 | 需要跑着 GUI 的 web profile | [PUBLISHING.md](PUBLISHING.md) §5 的 V1–V4 |
| bridge 路由在真实 web profile 下的行为 | 同上（本机只有 headless 宿主） | 同上 V4 |
| 官方 Actions/工具链的版本漂移 | 需要真实 GitHub Actions 跑一次 | 首次 push 后看 6 组矩阵读数（node 22/24 × ubuntu/windows/macos，见 `.github/workflows/ci.yml:57-59`） |

---

## 相关文档

- [架构设计](ARCHITECTURE.md) —— 双半插件与 driver 分类学
- [场景数据规范](SCENARIO-SPEC.md) —— 这条场景到底怎么写的
- [供应链与合规](SUPPLY-CHAIN.md) —— 依赖锁定、审计、脱敏、发布 provenance
- [发布手册](PUBLISHING.md) —— 活宿主四步验证与发布清单
- [路线图](ROADMAP.md) —— 已经做到哪、还剩什么
