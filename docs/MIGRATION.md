# 迁移指南：0.1.0 → 0.2.0

> **先看这一句**：0.2.0 **尚未发布**（版本号与发布动作见[发布手册](PUBLISHING.md)的清单）。
> 本文只回答一个问题：**如果你已经在用 0.1.0，升级到 0.2.0 时你要做什么。**
>
> 逐条变更的完整列表在[变更日志](../CHANGELOG.md)——**这里不复述它**，只给动作。
> （复制 CHANGELOG 的正文是注定要漂移的做法：两边都要改，总有一边会忘。）

---

## 0. 三十秒版

| 你是 | 要做什么 |
|---|---|
| 插件使用者 | 改安装名（包名变 scoped）→ 刷新一次页面（client 模块 id 变了） |
| 场景作者 | 如果你的场景会**起进程 / 写文件 / 调模型**，它现在可能变 **skipped**；要么给场景写 `cost`，要么在需要时**由人**放权 |
| 库调用方 | 基本不用动：`RunRequest.policy` 省略仍等于「不启用闸门」（库语义没变） |
| 报告消费者 | 新增字段一律可选；多了 `junit.xml`（CI 用）与 `trace.json`（记了 trace 才有） |
| `defineTool` 参数里写了 `enum` / `const` 的人 | 检查值类型与 `type` 是否一致——不一致现在会**更早炸**（§4） |
| CI 集成方 | 可以开始消费 `junit.xml`；其余照旧（`pnpm run gate` 仍是唯一入口） |

---

## 1. 我是「插件使用者」

1. **包名变了**：`dsh-testkit` → `@supengpeng/dsh-testkit`。
   - ⚠️ **npm 上的 `dsh-testkit` 属于另一个项目**，不要以为把依赖写回旧名就能升级
     （依据与出处见[发布手册 §1](PUBLISHING.md)）。
   - 从 git 安装仍可用：仓库带 `prepare` 脚本，装的时候会自动构建。
2. **插件身份没变**：profile roster 里的 id 仍是 `dsh-testkit`，工具名仍是 `testkit_*`，
   人类命令仍是 `/testkit`。所以**你的脚本与提示词不用改**。
3. **client 模块 id 变了**：它现在从 `package.json` 的 `name` 读（不再硬编码 `dsh-testkit`）。
   - 你要做什么：装完**刷新一次页面**。
   - ⚠️ 这条的**活宿主渲染验证仍未人工复核**（改名后标签是否正常渲染），步骤见
     [发布手册 §5](PUBLISHING.md) 的 V1–V4。这是本版最需要你亲自看一眼的地方——
     它坏了**不会报错**，只是界面里标签不见了。
4. **工具面变多了**（6 → 11）：新增 `testkit_expand` / `testkit_trace` / `testkit_trend` /
   `testkit_coverage` / `testkit_search`。你的既有调用不受影响。
5. **装出来的东西更完整**：`files` 白名单补了 `bin`、`schemas`、`fixtures`、`registry`、`templates`。
   以前"本地能跑、装出来缺件"的那类问题，现在由 `pnpm run verify:pack` 在 gate 里守着。
6. **多了一个命令行入口（可选）**：`dsh-testkit <子命令>`（自带 headless 最小宿主，
   不连接真实 DSH）。退出码冻结为 `0/1/2/3`，`dsh-testkit help` 里有全表。
   > 它**不替代**活宿主：需要 `subprocess` / `fs` / `sessions` 的场景在 CLI 里会如实 skip。

---

## 2. 我是「场景作者」

### 2.1 新增的都是**可选**字段（不写 = 行为不变）

| 字段 | 用途 | 规范 |
|---|---|---|
| `cost` | 成本档位（`none` / `low` / `high`） | [SCENARIO-SPEC §2.2.1](SCENARIO-SPEC.md) |
| `budget` | 预算上限（模型调用次数 / token） | [SCENARIO-SPEC §2.2.2](SCENARIO-SPEC.md) |
| `owner` / `parallel` | 归属人 / 并发安全性 | [SCENARIO-SPEC §2.2.3](SCENARIO-SPEC.md) |
| `fixtures` | 引用外部夹具（条件来自夹具而非硬编码） | [SCENARIO-SPEC §2.2.4](SCENARIO-SPEC.md) |
| 步骤 `use` / `with` | 复用 step 片段（组合系统） | [SCENARIO-SPEC §2.4.2](SCENARIO-SPEC.md) |
| 步骤 `cleanup` | 步骤级资源释放 | [SCENARIO-SPEC §2.4.3](SCENARIO-SPEC.md) |

### 2.2 **默认值收紧了**（这是升级后最可能让你看到"红/跳过"的地方）

| 变更 | 你会看到什么 | 你要做什么 |
|---|---|---|
| **shell 默认只读**：写命令与解释器进拒绝清单 | 原来能跑的 `shell` 场景变成 **skipped**，理由里写着命中拒绝清单 | 判据确实不需要写操作 → 改成只读命令；确实需要写 → **由人**为该次运行显式放权（沙箱配置） |
| **真实网络默认禁止**（`allowNetwork: false`） | 需要真网的 `resource` 动作 → skipped | 用 `setup.resource` 注册假 provider（**场景自带假 provider 时网络不算"任意请求"**），或显式允许 |
| **成本闸门默认拒绝 high 档**（`allowModel: false`） | `agent`、`compaction` 的真压缩 → skipped（**不是 failed**） | 需要跑就由**人**放权：`/testkit run --allow-model` 或 CLI `run --allow-model`。模型自己放不了权（工具面只能收紧） |
| 低档默认放行（`allowLowCost: true`） | 起进程 / 写文件默认仍然能跑 | 不用动 |

> **"skipped" 与 "failed" 的区别在 0.2.0 变得更重要**：前者是"这次没被授权 / 宿主没这个能力"，
> 后者才是"跑了但不对"。报告里两者分开计数，请按这个口径读。

### 2.3 成本档位的缺省规则

不写 `cost` 时，按**参与这条场景的 driver**取**最高**档（默认表见 `src/kinds/index.ts` 的 `DRIVER_COST`）。
组合场景（`setup` 里多个 kind）同理：只要含 `agent`，整条就是 `high`。

**逃生舱**：某条场景实际不调模型，但 kind 的默认档是 `high`（典型是 `compaction` 的只读边界），
显式写 `cost: none` 降档——`cases/TK-0034.yaml` 就是这么标的，理由写在该文件头注里。

### 2.4 `fixtures`：条件从数据来，别硬编码

原来你会在场景里写死"模型返回超时"这类条件；现在可以把条件放进 `fixtures/<kind>/<name>.yaml`，
场景只写 `fixtures: [llm/timeout]`。夹具带 `dsh_version` 版本范围：

- 版本不匹配 → 该场景 **skipped 并写明原因**（绝不用错夹具硬跑）；
- CI 导出物**显式带**夹具接线，所以插件里绿、CI 里红（或反过来）这种分叉不会再出现。

### 2.5 组合系统的边界

`use:` 只能引用 **step 片段**（`registry/steps/**`），**不能**引用别的场景；
片段之间也不能互相 `use`（无环是硬约束）。场景若用了 `use:`，必须带 `registry:v<版本>` 标签锁版本。
**没有**场景级 `include` / `extends`，也**没有** YAML 控制流（`if` / `for` / `while`）——这是刻意的。

---

## 3. 我是「库调用方」（直接依赖本包 / fork）

| 事项 | 0.2.0 的语义 | 你要做什么 |
|---|---|---|
| `RunRequest.policy` | **省略 = 不启用闸门**（既有库语义刻意保留）；插件面一律显式构造 | 不用动；想启用闸门就显式传 |
| `RunRequest.fixtures` | 省略 = 不应用夹具 | 声明了 `fixtures:` 的场景，调用方必须传这个选项，否则夹具被无视 |
| 报告写入失败 | `writeRunArtifacts` **不抛**，通过返回值给 `error` / `junitError` | 按返回值判断，别 try/catch 当异常 |
| 导出物 | 生成的自包含用例**显式带**默认闸门与夹具接线 | 不用动 |
| 包名 | scoped（`@supengpeng/dsh-testkit`）；`exports` 新增 `./schemas/run-report.schema.json` | 从 git 安装时改 import 说明符 |
| DSH 依赖边界 | `@deepseek-ai/dsh-*` 只允许出现在 `src/adapters/dsh/` 下（`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 不算） | fork 后若在别处直接依赖内部包，`verify:adapter` 会红 |
| DSH 版本 | `dsh.engines`: `>=0.2.0-rc.2`；兼容矩阵见 `package.json` 的 `dsh.compatibility` | 升级宿主前先看这张表 |

---

## 4. `enum` / `const` 保真带来的「更早炸」与恢复路径

**变化**：`defineTool` 的参数 schema 转换以前会**静默丢弃** `enum`（且只对 `string` 保留）与 `const`，
现在按 DSH 支持集合（标量 5 类）**忠实传递**；类型不匹配的 schema 会在 `defineTool` 期抛
`JsonSchemaError`。

**为什么**：静默丢弃 = 作者写了约束、运行期没人校验。"写了但没生效"比没写更危险。

**你要做什么**：检查 `parameters` 里 `enum` / `const` 的**值类型**与 `type` 是否一致，
例如 `type: string` 却给了一个数字枚举值——这在 0.1.0 会被悄悄忽略，在 0.2.0 会直接报错。

| 恢复路径 | 评价 |
|---|---|
| 修正 schema（让值类型与 `type` 匹配） | ✅ 推荐——这正是保真的目的 |
| 去掉 `enum` / `const` | ⚠️ 能用，但等于放宽校验；请在 PR 里说明为什么必须放宽 |
| 回退到 0.1.0 | ❌ 不推荐（会连带失去闸门与脱敏） |

> 取舍的完整说明与示例见[变更日志](../CHANGELOG.md)的迁移说明（**引用，不复制**）。

---

## 5. 我是「CI 集成方」

1. **新增 `runs/<RUN-ID>/junit.xml`**：按 kind 分 `testsuite`，每条场景一个 `testcase`；
   失败带归因与最小复现。可以直接喂给 CI 的测试报告面板。
2. **`trace.json` 只在本次运行真的记了 trace 时才写**（空 trace 文件比没有更误导）。
3. **退出码**：CLI 冻结为 `0`（全部 passed/skipped）/ `1`（有 failed/errored）/ `2`（用法错误或选中 0 条）/
   `3`（基础设施错误）。**`0` 包含 skipped**——这是刻意的：宿主缺能力不是失败。
4. **别把真实模型调用塞进 CI**：闸门默认拒绝 `high` 档，而且导出的用例**结构上**带默认闸门。
5. **脱敏**：`--redact` 是模式匹配级兜底，`verify:secrets` 是闸门；CI **不上传任何 artifact**
   （保留策略见[安全策略 §4.3](../SECURITY.md)）。
6. **入口没变**：`pnpm run gate` 仍是唯一质量门；CI 只跑它，不另拼一套步骤。

---

## 6. 回滚

- 0.2.0 的新增字段**全是可选的**，所以"不写就没事"。
- 但**反过来不成立**：如果场景里已经写了 `cost` / `budget` / `owner` / `parallel` / `fixtures` /
  `use`，回退到 0.1.0 的 loader 会因未知字段报 schema 错。
  **回滚前先把这些字段去掉**（或者把整份 `cases/` 一起回滚）。
- 包名回滚：改回本地路径 / git 安装（**不能**用 npm 上的旧名——那是别人的包）。

---

## 7. 升级后建议做一次的两件事（诚实边界）

1. `pnpm run gate` —— 确认你的 fork/派生仓全链绿。
2. **活宿主点一次**：装进一个**隔离** profile，看会话视图环里的「测试」标签是否还在，
   并跑一次 `/testkit run TK-0001`。改名后的 client 渲染**尚未人工复核**，
   而它的失效方式是静默的（[发布手册 §5](PUBLISHING.md)）。

---

## 相关文档

- [变更日志](../CHANGELOG.md) —— 逐条变更、迁移说明、明确推迟了什么
- [发布手册](PUBLISHING.md) —— 发布清单、改名清单、活宿主验证 V1–V4
- [场景数据规范](SCENARIO-SPEC.md) —— 字段的权威定义
- [治理](GOVERNANCE.md) —— 版本语义与弃用策略（什么时候会破坏兼容）
- [安全策略](../SECURITY.md) —— 放权边界与数据隐私
