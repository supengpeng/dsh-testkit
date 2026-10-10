# 治理（Governance）

> 这份文件回答"**谁决定、怎么变、什么时候算发布、新人从哪上手**"。
> 它不是公司章程式的装饰：每一条后面都跟着一个**可执行的动作或判据**。
>
> 现状诚实声明：本仓目前**只有一位维护者**（`@supengpeng`，见 [CODEOWNERS](../CODEOWNERS)）。
> 所以"多人裁决"这类机制现在**不存在**，本文只把未来的挂载点写清楚，不假装已经具备。

---

## 1. 角色与决定权

| 角色 | 谁 | 能做什么 |
|---|---|---|
| **维护者** | `@supengpeng` | 合并 PR、裁决 RFC、发布版本、定义 `cases/` 的判据标准、处理行为准则事件 |
| **贡献者** | 任何提 PR / issue 的人 | 提场景与 driver、提守卫与修复、参与 RFC 讨论 |
| **使用者** | 装本插件的人 | 报 bug（带最小复现）、提需求；其 `run.json` 是趋势与覆盖数据的来源 |

**决定权的现实**：单人维护的项目里，所有裁决事实上由维护者作出。我们不为此发明一套
"看似多方"的流程——那只会让责任变模糊。可以期待的是：

- **技术分歧**用证据解决：能复跑的命令 > 文档里的说法 > 个人偏好。
- **否决必须写理由**，并且理由要能落到文档或守卫里（否则下次还会吵同一件事）。
- **接口冻结**：被点名冻结的签名（例如 `resolvePolicy`、`applyDxFilter`）不得单方面改名——
  跨域依赖它们。

加入第二位维护者时要做的事：更新 [CODEOWNERS](../CODEOWNERS)、本节表格、
[行为准则](../CODE_OF_CONDUCT.md) 的执行方式（改为双人裁决）。

## 2. 版本语义

本仓有**三个独立的版本概念**，别混：

| 概念 | 在哪 | 语义 |
|---|---|---|
| 包版本 | `package.json` 的 `version` | 对外承诺的语义化版本（见下） |
| 场景 schema 版本 | 每个 `cases/*.yaml` 的 `schema: 1` | 场景数据的结构契约；**新增可选字段不升版** |
| step registry 版本 | `registry/registry.yaml` 的 `version` | 片段语义版本；语义变化才 +1，用 `use:` 的场景必须锁它 |

**包版本的升级判据**：

| 变更 | 版本位 |
|---|---|
| 修 bug、改文档、加测试、加守卫 | patch |
| 加能力：新 kind？不——**新字段、新子命令、新工具、新产物、新退出码语义** | minor |
| 改 `RunSummary`/`run.json` 的既有字段语义、删除 `exports` 路径、删场景字段、**改冻结退出码** | major |
| 改包名 / `bin` 名 / client 模块 id | major（且必须附活宿主验证，见[发布手册 §5](PUBLISHING.md)） |

**关于「加 kind」**：新 kind 属于 minor，但它的**前置门槛**在
[贡献指南 §4.1](../CONTRIBUTING.md)（先证明确实落不进现有 12 类）。门槛是流程的一部分，不是礼貌。

## 3. 弃用策略

任何**对外可见**的东西要消失，走同一条三步路（短期先标注，长期才删）：

| 步 | 做什么 | 判据 |
|---|---|---|
| ① 标注 | 在文档、代码头注与[变更日志](../CHANGELOG.md)里写明"已弃用 + 替代方案 + 何时移除"；能加运行期警告的加警告 | 使用者按文档操作**不会**踩坑 |
| ② 保留 | 至少保留**一个 minor** 的可用期（同一 major 内） | 旧写法在这一 minor 内仍然工作 |
| ③ 移除 | 在下一个 major 移除，并在[迁移指南](MIGRATION.md)里给出"我要做什么" | 迁移指南有对应条目 |

本仓已有的弃用机制，可以直接用：

- **场景**用 `status: retired` 退出默认运行集（**文件与历史保留**，不删）。
  这比删文件好：历史报告里的 case id 还能被查到。
- **step 片段**：删片段会让用了它的场景在展开期明确报错（不静默），并且要 **registry 版本 +1**。
- **字段**：新增可选字段不算破坏性变更；改名/删除按上表走 major。

## 4. 什么时候需要 RFC

RFC 不是"大改动才要走的仪式"，而是**在有多个合理选项时把选择过程固定下来**。
以下变更**必须先有 accepted 的 RFC**（流程见 [RFC 目录](rfc/README.md)）：

- 新增 kind（第 13 类），或改变 kind 分类学的依据；
- 改 `cases/*.yaml` 的 **schema 语义**（删/改字段，而非新增可选字段）；
- 改**冻结的退出码**、`run.json` 的既有字段语义、`exports` 的既有路径；
- 改**形态**：包名、`bin` 名、client 模块 id、`dsh` 清单结构；
- 新增**运行时依赖**；
- 改**默认闸门/沙箱语义**（属于安全边界，见 [SECURITY.md](../SECURITY.md)）；
- 引入与外部项目的数据交换（例如新的适配器通道）。

不需要 RFC 的：修 bug、加测试/守卫、加文档、加**可选**字段、加一条场景。
**拿不准就问**——一次 10 分钟的对齐比一个月的返工便宜。

## 5. 发布节奏（release cadence）

**没有固定日期，也不承诺日期。** 本仓的发布由"条件满足"触发，而不是由日历触发：

```
gate 全链绿（本机 + CI 9 组合）  +  活宿主验证过  +  发布清单全过  →  可以发
```

- 发布清单与执行顺序：[发布手册 §2 / §6](PUBLISHING.md)（**那里是唯一真源，别在这里复制**）。
- 版本号由 §2 的判据决定，不由"攒够多少条"决定。
- 公告渠道：GitHub Release（附[变更日志](../CHANGELOG.md) 的对应段落）。
- **当前状态：不可发布**——npm 同名包属于他人，改名是硬前提（[发布手册 §1](PUBLISHING.md)）。

> 为什么这么设计：本仓的每一条结论都要求可复跑；一个"到日子就发"的节奏会逼着人
> 在红着的 gate 上找理由，而那正是"假绿"的来源。

## 6. Roadmap 的公开方式

| 文件 | 它是什么 | 谁改 |
|---|---|---|
| [迭代计划](ROADMAP.md) | **唯一真源**：每个 Phase 的目标、交付物、验收与"未做/推迟（含**前置条件**）" | 维护者 |
| [优化执行报告](OPTIMIZATION-REVIEW-2026-10.md) | 执行记录：对照方案的状态、**被证伪的论断**、抓到的真 bug、实测读数 | 维护者 |
| [功能清单](FEATURES.md) | 只列**已实现并实测**的能力（没有"计划中"） | 任何人（与实现对齐） |

三条纪律：

1. **推迟必须写给前置条件**，不写"没时间"——这样下一个人能判断条件是否已满足。
2. **不对未承诺的日期做承诺**；优先写"什么条件下会做"。
3. **被证伪的论断要留在记录里**（执行报告的 §3 就是这么用的）：删掉它们等于让后来者重踩。

## 7. 问题分诊（triage）

维护者对 issue 的处理顺序：**能不能复跑 → 是不是"宿主缺能力导致的 skipped" → 归类 → 打标签 → 排期**。

| 标签 | 含义 | 处理 |
|---|---|---|
| `bug` | 可复现的行为错误 | 有最小复现的优先 |
| `enhancement` | 新能力 / 新入口 | 触及 §4 清单的 → 先要 RFC |
| `documentation` | 文档漂移或缺失 | 通常适合作为第一次贡献 |
| `good first issue` | **边界清晰、判据可跑、不需要全局架构认知**（候选见 §8） | 期望在 PR 里带上验证命令 |
| `help wanted` | 维护者确认要做，但时间不确定 | 欢迎认领，先在此评论 |
| `wontfix` | 明确不做 | **必须写理由**，并（若适用）记进 ROADMAP 的「明确不做」 |
| `duplicate` | 已有同类 | 指回原 issue |

## 8. Good first issues

**标签**：`good first issue`。**候选清单**（每条都可以独立完成，且都有可执行的验证命令）：

### GFI-1 · 把「注册面」的三处说法对齐（工具清单）

- **从哪读起**：`src/tools.ts`（**唯一真源**：实际注册了哪些工具）；
  `tests/host-apply.test.mjs`（精确断言工具名与数量）；`docs/FEATURES.md` 的「模型工具」一节。
- **改哪个文件**：`tests/host-apply.test.mjs`（把断言对齐到实际注册集）+
  `docs/FEATURES.md`（工具表与数量）；想加防漂移守卫就再加一条测试（接进 `gate` 需维护者改 `package.json`）。
- **怎么验证**：`node --test tests/host-apply.test.mjs` **从红变绿**；`node scripts/verify-docs.mjs`（exit 0）。
- **现状证据（写这条时的读数）**：实现注册 **13** 个工具
  （`list/run/report/export/expand/trace/trend/coverage/search/triage/doctor/propose/pipeline`），
  但 `docs/FEATURES.md` 还写着 6 个，`tests/host-apply.test.mjs` 断言的是 11 个 —— 三处互不一致，
  而那条断言现在是**红的**。
- **为什么适合第一次**：判据就是"跑那条测试"，而且**顺带修一条红测试**——
  第一次贡献最怕"改完也不知道对不对"，这里不会。
- **注意**：若你接手时三处已经对齐（测试是绿的、文档对得上），那这条已经做完，
  请直接关掉它——**以命令的实际输出为准，不以本文档的描述为准**。

### GFI-2 · 给 CLI 的 `--watch` 补一条自动化用例

- **从哪读起**：`src/cli/commands/run.ts` 的 `runWatch`（首次跑完 → 监听场景目录 → 变化重跑 → SIGINT 后返回最后一次退出码）；
  监听实现来自 `src/dx/watch.ts`；测试里的 `runCli()` 辅助函数在 `tests/cli.test.mjs`。
- **改哪个文件**：`tests/cli.test.mjs`（用 `spawn` + 优雅 `SIGINT` + 超时保护；**不要引新依赖**）。
- **怎么验证**：`node --test tests/cli.test.mjs`；新用例必须在"watch 不重跑"时**变红**。
- **为什么适合第一次**：一个明确的失败模式（长驻进程），需要认真处理超时与清理——是很典型的 CLI 测试练习。

### GFI-3 · 加一条「时序断言必须留容差」的守卫

- **从哪读起**：[优化执行报告 §4](OPTIMIZATION-REVIEW-2026-10.md) 的第 4 条（真实踩过的假红：
  `duration >= 40` 实测 39）；正确的写法在 `tests/agent-team.test.mjs` 与 `tests/session-goal.test.mjs`
  的 `TIMER_TOLERANCE_MS`。
- **改哪个文件**：新增 `tests/timing-discipline.test.mjs`——扫 `tests/**/*.test.mjs`，
  找出"与名义毫秒数比较且没有容差"的断言。写成测试即可自动进 `gate`，**不需要**改 `package.json`。
- **怎么验证**：先在当前代码上跑绿；再故意写一条无容差断言 → 必须红（负向证明；
  负向证明的写法可抄 `tests/ci-hardening.test.mjs`）。
- **为什么适合第一次**：纯文本分析、离线、判据明确；且它保护的是"CI 随机红"这类最费时间的故障。

### GFI-4 · 给脱敏加「URL 内嵌凭据」规则

- **从哪读起**：`src/report/redact.ts` 的 `SECRET_PATTERNS` 与头注；用例在 `tests/report-standard.test.mjs`。
- **改哪个文件**：`src/report/redact.ts` + 对应测试。
- **怎么验证**：`node --test tests/report-standard.test.mjs`；`node scripts/check-secrets.mjs` exit 0。
- **现状证据（已实测）**：`scheme://user:password@host` 形态**没有专门规则**——宿主是 IP、
  无点的内网名、或占位域名时**完全不脱敏**（例如 `https://user:tok3n@example.com/x` 里的密码会原样留下）；
  偶尔会被 `email` 规则"顺手"抹掉，但类型标错（例如把它标成 `email`）。
- **为什么适合第一次**：改动集中在一个正则表 + 一组用例；能完整走一遍"加规则 → 加正/负例 → 跑守卫"。

### GFI-5 · 给 `check-pack-files` 补一条负向证明

- **从哪读起**：`scripts/check-pack-files.mjs`（必需路径由 `main`/`types`/`exports`/`bin`/`dsh.bundle.patch` 推导）。
- **改哪个文件**：新增 `tests/pack-files.test.mjs`——在 `mkdtemp` 里造一个"入口声明了某文件、
  但 `files` 白名单漏了它"的假包，断言脚本 **exit 1** 且点名那个文件。
- **怎么验证**：`node --test tests/pack-files.test.mjs`。
- **为什么适合第一次**：完全离线、不碰运行时；可抄 `tests/ci-hardening.test.mjs`
  或 `tests/adapter-boundary.test.mjs` 的结构（"跑真实脚本 + 正/负向用例"）。

### GFI-6 · 新增第 4 份 fixture，并用它写一条新场景

- **从哪读起**：`fixtures/`（现有 3 份，覆盖 `llm` 与 `tool`）；规范见[开发文档 §5.2.2](DEVELOPMENT.md)
  与[场景数据规范 §2.2.4](SCENARIO-SPEC.md)；校验规则在 `src/fixtures/schema.ts`。
- **改哪个文件**：`fixtures/<kind>/<name>.yaml`（新）+ `cases/TK-XXXX.yaml`（新场景，
  **TK 号要走提炼闸门拿**，不要手改 `cases/index.yaml`）。
- **怎么验证**：`pnpm run verify:fixtures`（exit 0）+ `pnpm run gate`（全绿）；
  场景要能在 headless 轨被 runner 选中并给出确定性结论。
- **为什么适合第一次**：条件与判据都写在数据里，不需要读引擎代码；能学到"夹具带版本范围"的设计。

### GFI-7 · 给 step registry 加一份片段

- **从哪读起**：`registry/steps/`（现有 9 份，分 `setup/` / `invoke/` / `assert/` 三域）；
  校验规则在 `src/registry/loader.ts`（命名 `<域>/<名>`、**片段内禁止 `use`**、禁止 YAML 控制流、参数 schema 形状）。
- **改哪个文件**：`registry/steps/<域>/<name>.yaml`（新），并确认 `registry/registry.yaml` 的版本**不需要**变
  （只有语义变化才 +1）。
- **怎么验证**：`node scripts/verify-registry.mjs`（exit 0）+ `node --test tests/registry.test.mjs`。
- **为什么适合第一次**：格式有既有 9 份可以照抄，且守卫会把写错的地方点到行。

### GFI-8 · 给 CLI 的 `run` 加 `--timeout <ms>`

- **从哪读起**：`src/cli/commands/run.ts` 的选项表与 `runOnce`（`runScenarios` 接受 `defaultTimeoutMs`）；
  现状是场景自己的 `runtime.timeoutMs` 生效，命令行层**没有**总超时开关。
- **改哪个文件**：`src/cli/commands/run.ts`（选项 + 校验 + 传给 runner）+ `tests/cli.test.mjs`（正/负例）。
- **怎么验证**：`node --test tests/cli.test.mjs`；负例要覆盖"非整数 / <= 0 → 退出码 2 并说明用法"。
- **为什么适合第一次**：一个参数从解析到接线的完整小闭环，且不碰引擎。

> **这些不是"没人要做的杂活"**：每一条都写明"从哪读起、改哪里、怎么验证"——
> 因为它们要能靠一份指南独立完成，而不是靠问维护者。认领时请直接在 issue 里说明你要做哪条。

## 9. 相关文档

- [贡献指南](../CONTRIBUTING.md) —— 环境、加场景、加 driver（含 12 kind 纪律）、质量门
- [RFC 流程](rfc/README.md) —— 什么时候需要 RFC、编号与状态机、模板
- [行为准则](../CODE_OF_CONDUCT.md) —— 参与即代表你同意它
- [迭代计划](ROADMAP.md) —— 各 Phase 的验收与推迟项的**前置条件**
- [发布手册](PUBLISHING.md) —— 发布清单、改名清单、活宿主验证
- [安全策略](../SECURITY.md) —— 漏洞报告、放权边界、数据隐私
