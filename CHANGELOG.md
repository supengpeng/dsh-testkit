# 变更日志

本仓的版本语义：**补丁**只改实现与文档；**次版本**加能力面；**主版本**才会改
`cases/*.yaml` 的既有字段语义（新增可选字段不算破坏性变更，`schema` 保持 `1`）。

> ⚠️ **尚未发布到 npm。** npm 上的 `dsh-testkit` 属于另一个项目（见
> [docs/PUBLISHING.md](docs/PUBLISHING.md)），所以下面 `0.2.0` 的"未发布"是字面意思：
> 这批改动目前只能从本仓/ git 安装，装不出来的不是"依赖没配好"，而是**名字的归属问题**。

---

## 0.2.0（未发布）

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
- 把「本包**没有 `bin`**」这一既有事实变成显式断言：本包是插件 + 库，不是 CLI；
  CI 轨由 `scripts/export-scenarios.mjs` + `export/scenarios.test.mjs` 承担（断言都串在 gate 里）。

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

### 迁移说明

| 变化 | 对既有使用者的影响 | 要不要动手 |
|---|---|---|
| 新字段 `cost` | 不写 = 按参与 driver 的默认表取最高档，**既有 36 条场景行为完全不变** | 只有想让高成本 driver 的离线动作降档时才写（例：`cases/TK-0034.yaml` 标 `cost: none`） |
| 新字段 `budget` | 不写 = 不限 | 可选 |
| 闸门默认值 | `allowModel: false`（`high` 档**默认跳过**）、`allowLowCost: true` | 想跑 `agent` / `compaction` 真压缩时，显式 `--allow-model` |
| 库调用方（直接 `RunRequest`） | `policy` 省略 = **不启用闸门**，既有语义与既有测试不变 | 不需要 |
| 新产物 `runs/<RUN-ID>/junit.xml` | 多一个文件；写失败不抛出 | 不需要 |
| 报告新增字段 | `policy` / `usage` / `failureCategory` / `minimalRepro` / `rounds` / `cost` **只增不改**；`schema` 仍是 `1` | 解析方按可选字段处理 |
| `src/host-facade.ts` 的导入路径 | 内部实现，导出面不变 | 不需要 |

### 已知限界（本次交付的诚实边界）

1. **用量记账是下界。** 语义是「真实调用次数 ≥ 记账值」：1 个高成本 `act` 记 1 次调用，
   driver 不主动上报 token 就记 0。因此 `budget.maxModelCalls` 是**保守闸门**
   （超了必拦，但别拿它当账单），`maxTokens` 只在 driver 真的上报 token 时才真正强制。
   宁可如实说"没上报"，也不编一个看起来精确的数字。
2. **「默认只读沙箱」本次是显式开关，不是默认行为。** 默认值只把**花钱**关掉
   （`allowModel: false`）；沙箱收紧（`sandbox.allowShell` / `allowFileWrite` /
   `denyWriteCommands`）默认保持放行，需显式打开。原因是本仓既有场景里有若干
   `shell` / `fs` 类**本来就会写目录**，默认收紧会让既有基线平白多出一片 skipped——
   那是自己制造的假红，会把真正的失败淹掉。**这是取舍，不是遗漏。**
3. **输出脱敏（`--redact`）尚未实现。** 数据边界与约定见 [SECURITY.md](SECURITY.md)，
   但"约定"目前靠使用纪律而不是机器强制——那一步是待实现项，不在本版。
4. 模型相关的两个 driver（`agent` / `compaction` 真压缩）**未在本版做 CI 覆盖**：
   它们要么花钱、要么留痕，只按 id 单跑；这是成本闸门存在的直接后果，不是覆盖率疏漏。

### 明确推迟的项（连同理由与前置条件）

| 推迟项 | 为什么现在不做 | 解除前置条件 |
|---|---|---|
| **npm scoped rename** | `dsh-testkit` 这个 npm 名**已被他人占用**（实测 registry `200`，maintainer `iiwish`，latest `0.4.4`），`npm publish dsh-testkit` 从物理上就不可能成功；而改名会改变 client bundle 的 module id，**必须**在活宿主里验证"标签仍然渲染、`__ModuleLoader__.load` 的 id 匹配"，本会话做不到 | ① 活宿主（web profile）验证 client 模块 id 与「测试」标签渲染；② 定下新名（scoped 或新名）并跑通 [docs/PUBLISHING.md](docs/PUBLISHING.md) 的全量引用清单 |
| **独立 CLI** | 本包**刻意没有 `bin`**（见「三」）：先证明"导出的 CI 用例能在真实 CI 里跑通"，再决定 CLI 该长什么样；反过来做会得到一套与场景数据重复的命令面 | ① 导出轨在至少一个真实仓库的 CI 上跑通；② 明确 CLI 只做 `run` / `list` 两个子命令（不做第二套引擎） |
| **step registry + 参数化模板** | 现在只有 36 条场景，且没有出现"同一判据重复三遍、只有参数不同"的实例。此时抽象出来的模板是**猜的**，会把未来的场景塞进错误的形状里 | ① 出现 2–3 组真实的"同构不同参"场景；② 先写清模板与 `kind` 的关系（模板不能变成第 13 个 kind） |
| **touchstone 适配器（方案里分三阶段：只读导入 → 双向同步 → 作为运行源）** | 跨项目的判据交换需要先有**数据流向与隐私约定**（见 [SECURITY.md](SECURITY.md)），且对方契约还在动；先接进来只会把不稳定的形状固化成本仓的接口 | ① touchstone 侧 schema 与版本策略稳定；② 数据流向 / 脱敏 / 保留策略定稿；③ 阶段一（只读导入）单独可验收 |

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
