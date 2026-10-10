# 贡献指南（Contributing）

> 本仓是一套**把 issue 变成可复现场景资产**的测试插件。因此这里的贡献规则只有一条主线：
> **凡是新加的东西，都要能被一条命令复跑出对错**——判据、守卫、报告，三者缺一不可。

---

## 0. 先读什么（别从代码开始）

| 想做的事 | 先读 |
|---|---|
| 把它跑起来 | [README](README.md) 的「安装」「快速上手」＋[开发文档 §1–§2](docs/DEVELOPMENT.md) |
| 加一条**场景**（`cases/*.yaml`） | [场景数据规范](docs/SCENARIO-SPEC.md) ＋[issue 提炼流程](docs/ISSUE-PIPELINE.md) |
| 加一个 **driver**（新 kind） | [架构设计 §7 分类学](docs/ARCHITECTURE.md) ＋[§10 扩展点速查](docs/ARCHITECTURE.md) **＋本文件 §4** |
| 改**执行引擎 / 闸门 / 报告** | [架构设计 §5](docs/ARCHITECTURE.md) ＋[功能清单](docs/FEATURES.md) |
| 提 issue / PR / 安全报告 | [PR 模板](.github/PULL_REQUEST_TEMPLATE.md) ＋[安全策略](SECURITY.md) ＋[行为准则](CODE_OF_CONDUCT.md) |
| 想知道"为什么这么设计" | [优化执行报告](docs/OPTIMIZATION-REVIEW-2026-10.md)（含被证伪的论断与抓到的真 bug） |

## 1. 环境

| 项 | 说明 |
|---|---|
| Node | **≥ 22.19**（`package.json` 的 `engines`）；本机 `node` 不在 PATH，用绝对路径，见[开发文档 §1](docs/DEVELOPMENT.md) |
| 包管理器 | `pnpm`（锁文件 `pnpm-lock.yaml` 必须一起提交） |
| 依赖 | **能不加就不加**。当前运行时依赖只有 `yaml`；新增依赖需要在 PR 里说明理由，并走 [RFC](docs/rfc/README.md) |
| 构建产物 | `lib/`（host 半 `tsc` + client 半 `esbuild`），**不入库**（`.gitignore`） |

```powershell
# 一次性
& $NODE $PNPM install
& $NODE $PNPM run build:all

# 质量门（提交前必须绿；CI 跑的就是同一条）
& $NODE $PNPM run gate
```

### ⚠️ 编译一律走 `node scripts/build-lock.mjs`，**不要**直接跑 `tsc`

`lib/` 是**全仓共用的一份产物**。两个并发 `tsc` 会互踩（一个清目录、另一个正在写文件），
表现为**随机出现的「找不到模块」**，而且几乎无法归因到"是并发编译"。

- 什么时候必须用它：任何需要编译产物的动作之前（跑测试、导出、跑 CLI）。
- 它做了什么：用 `wx` 独占创建一个锁文件 → 已占用就等待轮询 → 锁文件比 5 分钟更老视为残留锁并抢占。
- 直接后果：多人（含 AI 协作）并行时，编译变成**串行**，但每个人拿到的都是完整产物。

> **本轮实际踩过的坑**：一行拼错的 import 让全队的 `tsc` 一起红，`lib/` 停在上一次成功编译的产物上，
> 其他人连"我的改动有没有回归"都测不出来。
> **纪律**：每次改动后立刻 `node scripts/build-lock.mjs`，**让树始终可编译**；改一小步 → 编译绿 → 再改。

## 2. 你能贡献什么

| 类型 | 入口 | 说明 |
|---|---|---|
| **场景**（最有价值） | `cases/TK-XXXX.yaml` | 把一个说不清的 issue 变成**可复跑、可断言、可回归**的判据 |
| **driver**（新 kind） | `src/kinds/*.ts` | 只有"现有 12 类干预点都装不下"时才做，见 §4 |
| **守卫 / 工具** | `scripts/*.mjs`、`src/**` | 把"人记得要做的事"变成"机器判得出的事" |
| **文档** | `docs/*.md` | 本仓文档是说明书性质；**与实现漂移比没写更糟** |
| **外部对象巡检** | `fixtures/`、`cases` 的 `fixture` 标签 | 用真实制品验证第三方包，见[开发文档 §5.2.2](docs/DEVELOPMENT.md) |

## 3. 怎么加一条场景

### 3.1 走闸门（推荐；由 issue 驱动）

要不要提炼、要不要落地，**由人按批决定**。完整流程见 [issue 提炼流程](docs/ISSUE-PIPELINE.md)；
闸门的形态是：人开批次 → 模型/贡献者只提交提案（`pipeline/proposals/`）→ 人批准才进 `cases/`。

> 模型的工具面**没有** `approve`——落地权只在人类命令面 `/testkit issue approve`。
> 用工具绕过闸门是**不允许**的（CLI 的 `import` 也只产草稿）。

### 3.2 手写（维护者 / 明确的小修）

1. 抄一条最接近的既有场景（在 `cases/` 里按 kind 找；每条场景的头注都写了"它守的是什么"）。
2. 字段规范见[场景数据规范](docs/SCENARIO-SPEC.md)；`id` 由 `cases/index.yaml` 的 `nextId` 决定，
   **不要手改 `index.yaml`**（它是守卫维护的生成物）。
3. 判据必须是**可判定**的：
   - ✅ `expect: [{ ref: fx.callCount, is: 1 }]`
   - ❌ "看起来应该没问题"——没有断言词的场景等于没测。
4. 高成本动作要显式声明 `cost`（缺省按 `src/kinds/index.ts` 的 `DRIVER_COST` 取最高档）；
   `agent` / `compaction` 这类会真调模型的场景默认会被闸门记为 **skipped**。
5. 本地验证：

```powershell
& $NODE $PNPM run verify:cases        # 架构一致性：kind 有 driver、索引自洽、setup 键合法
& $NODE $PNPM run test                # 内置套件
& $NODE $PNPM run export:ci           # 确认它能进 CI 轨（fixture 标签的场景默认不导出）
```

> **判据纪律**：草稿里的 `expect` 全是显式 TODO——**判据必须人来定**。
> 机器猜出来的判据只会制造"看起来在测、其实没测"的假象。

## 4. 怎么加一个 driver（**先读 §4.1，再动手**）

### 4.1 铁律：先问"这能不能落进现有 12 个 kind"

本仓有 **12 个 kind**，依据是 **DSH 的干预点**，不是业务领域
（分类学与归类决策树见[架构设计 §7](docs/ARCHITECTURE.md)）。现在的 12 类是：
`llm` `tool` `prompt` `interaction` `session` `resource` `agent` `ui` `shell` `file` `fs` `compaction`。

**加第 13 个之前，必须回答这三个问题**（写在 issue 或 RFC 里）：

1. **它能落进现有某一类吗？** 用[归类决策树](docs/ARCHITECTURE.md)走一遍。
   - 只是"某个 kind 缺一个参数/动作" → **扩那个 driver**，不要新建（[§10 扩展点速查](docs/ARCHITECTURE.md)）。
   - 只是"端到端结果不对、根因还不清楚" → 先归 `agent`（黑盒），**根因清楚后下沉**成精确 kind。
2. **它的干预点是 DSH 的哪个扩展点？** 必须能在 DSH 发行体里指到具体实现
   （函数 / waterfall / 服务名），并且**先读源码再实现**。
   > 反例代价：`llm` driver 若按事件目录的签名"想当然"写，会得到
   > `next: () => Promise<...>` 的错误拦截器，失效方式恰恰是最难查的那种：
   > **注册成功、静默产出空流**（见 [场景数据规范 §3.2.1](docs/SCENARIO-SPEC.md)）。
3. **它的成本档是什么？** 纯离线 = `none`；起进程 / 写文件 = `low`；真调模型 = `high`。
   档位决定它在默认闸门下会不会被跳过——**报错保守，不要报乐观**。

**为什么这么严？** 12 类能覆盖"新 issue 该归到哪一类"这个问题的确定答案；
一旦允许"说不清就新建一类"，分类学会迅速退化成**垃圾桶**：
每类都只有一两条场景，归类决策树也就不再有人用。这也是执行报告里把
"不加第 13 个 driver"列为**反面清单**的原因（见[优化执行报告 §2](docs/OPTIMIZATION-REVIEW-2026-10.md)）。

> **注意**：`tests/self-bootstrap.test.mjs` 会把"`SCENARIO_KINDS` 与 `createDriverRegistry()`
> 同集（不多不少）"钉成契约。所以**漏注册**或**注册了没登记**都会红——
> 这是刻意的：前者让合法场景跑不了，后者让 driver 永远跑不到。

### 4.2 真的需要新 kind 时的步骤清单

| # | 改哪里 | 具体内容 |
|---|---|---|
| 1 | `src/kinds/<kind>.ts`（新） | 导出 driver：`kind` / `description`（非空，会进列表与报告）/ `requires`（宿主能力）/ `setup`（造条件，注册一律经 `Fixture.add()`）/ `act`（可选）/ `teardown`（可选）/ `cost?()` |
| 2 | `src/cases/types.ts` | 把新 kind 加进 `SCENARIO_KINDS`（**类型层真源**；`setup` 键校验、runner 的 setup 顺序都从它推导） |
| 3 | `src/kinds/index.ts` | `createDriverRegistry()` 里注册；`DRIVER_COST` 补上新 kind 的档位 |
| 4 | `docs/SCENARIO-SPEC.md` | 加 §3.x 一节：`setup` 字段表 + 一个可抄的例子 + 取证字段表 |
| 5 | `docs/ARCHITECTURE.md` §7 | 分类学表加一行（干预点 + 典型 issue 场景） |
| 6 | `docs/FEATURES.md` | kind 表加一行（`requires` + 干什么） |
| 7 | `tests/<kind>-driver.test.mjs`（新） | 三层：**纯函数**（不碰宿主）/ **driver 契约**（setup 注册、act 取证）/ **真实性或负向**（断言"不该发生的事"没发生，例如别人的实现被误触） |
| 8 | `cases/TK-XXXX.yaml`（新） | 一条 **smoke 自检**场景：driver 挂掉时，能分清"被测对象有问题"还是"驱动器没工作" |
| 9 | 连带面 | `--kind` 的校验（工具 / 命令 / CLI）会自动接受新 kind；但**数量表述**（README / FEATURES 的"12 个 kind"）与 `DRIVER_COST` 覆盖要一起改 |
| 10 | 验证 | `node scripts/build-lock.mjs` → `node scripts/verify-cases.mjs` → `pnpm run gate` |

## 5. 质量门：提交前必须跑

```powershell
& $NODE $PNPM run gate
```

`gate` 是一条**串联**的链（任何一环失败即红）：

```
编译 host 半 → 构建 client 半 → verify:cases → verify:docs → verify:adapter →
verify:pack → verify:git-install → verify:fixtures → verify:registry → verify:secrets →
verify:lock（依赖逐项对锁）→ verify:ci（CI 加固）→
契约轨 → 内置套件 → 导出 CI 用例并跑一遍 → client 半 typecheck
```

> **唯一真源是 `package.json` 里的 `gate` 脚本**——上面这行只是概览，
> 看完请以那条命令为准（它会随时长出新的一环）。

几个容易踩的点：

- **`verify:docs`**：文档里写的 `fx.<字段>` 必须真实存在、`pnpm run <script>` 必须存在、
  `scripts/*.mjs` 必须存在、markdown 链接必须指向真实文件。
  改文档时顺手跑一次，比在 PR 里被打回便宜。
- **新增守卫要接进 `gate`**：没接进链的守卫等于没写（它会只躺在 `scripts/` 里）。
  接链需要改 `package.json`，属于[归属人](CODEOWNERS)范围——在 PR 里说明即可。
- **不要为了变绿而放宽断言**。断言红了先分三类：产品缺陷 / 用例判据写错 / 环境不足（flaky）。
  第三类才允许放宽，并且要**写明容差理由**（例如定时器精度：实测 39ms vs 名义 40ms）。

## 6. 提交与 PR 约定

- **提交信息**：中文，第一行说明"改了什么 + 为什么"，需要时补一段验证读数。
- **一个 PR 一件事**：顺手重构请单独提——本仓的守卫对"混合改动"很敏感。
- **PR 模板**要点：gate 读数、是否动了**注册面**（工具数 / kind 数 / 路由数）、
  是否动**形态**（`bin` / 包名 / client 模块 id / `files`）、是否动依赖与锁、CHANGELOG 是否更新。
- **改形态（包名 / bin / client 模块 id）必须附活宿主验证**：
  步骤见[发布手册 §5](docs/PUBLISHING.md)——那是**静默失效**最容易发生的地方
  （host 半一切正常、界面里标签就是不见了）。
- **CHANGELOG**：在 `CHANGELOG.md` 的对应版本段加一行，**引用**而不是复制其他文档的正文。

## 7. 不要做的事

| 不做 | 原因 |
|---|---|
| 造**通用 DSL / 表达式引擎** | 场景是数据，不是编程语言；可判定性来自断言词表，不来自图灵完备。规范里已写明禁止 YAML 控制流（`if`/`for`/`while`） |
| **场景级 `include` / `extends`** | 组合系统走 `use:` + `with`（显式、无环、可一键展开）。include 会让"这条场景到底跑什么"变成需要递归阅读的问题 |
| 把**真实模型调用**塞进 CI | 闸门默认拒绝 `high` 档；CI 轨还要在结构上不可能烧钱（导出的用例显式带默认闸门） |
| 把 `testkit_run` 的参数当**提权**入口 | 工具面（模型可调）只能收紧；放权只在**人**的入口（`/testkit run --allow-model`、CLI `run --allow-model`） |
| 与 npm 上的同名项目**硬碰**（同名发布 / 复刻其 CLI 形态） | 那个名字已被他人占用；发布前必须改名，见[发布手册 §1](docs/PUBLISHING.md) |
| 改**别人的活宿主 profile** 来"顺便验证" | 真实验证一律用独立的临时 profile（见[开发文档 §5.3](docs/DEVELOPMENT.md)） |
| 用 PowerShell 做**文本替换写回文件** | 实测会把中文写坏；改文件用编辑器/工具，核对用只读读取（见[开发文档 §8.1](docs/DEVELOPMENT.md)） |
| 直接 `tsc` / 并发编译 | 见 §1 的 `scripts/build-lock.mjs` |

## 8. 协作约定（多人 / AI 协作时）

1. **写域互不重叠**：一块文件同一时间只有一个写者；跨域改动先对齐，再动手。
2. **接口冻结**：跨域依赖的函数签名（例如 `resolvePolicy` / `applyDxFilter` / `appendRunLog`）
   一旦被点名，不得单方面改名。
3. **每一步让树可编译**：见 §1 的纪律——编译红了，别人的验收就全被堵死。
4. **守卫与测试一起进**：新能力要配一条"**它坏了会红**"的用例（负向证明），
   只有正向证明的能力等于没有守卫。
5. **汇报要带读数**：命令 + 退出码 + pass/fail 数。本仓所有结论都要求可复跑。

## 9. 相关文档

- [行为准则](CODE_OF_CONDUCT.md) —— 参与即代表你同意它
- [治理](docs/GOVERNANCE.md) —— 版本语义、弃用策略、RFC 流程、release cadence、good first issues
- [RFC 流程](docs/rfc/README.md) —— 什么改动需要先写 RFC
- [开发文档](docs/DEVELOPMENT.md) —— 环境、构建、调试、真实验证、代码约定
- [发布手册](docs/PUBLISHING.md) —— 发布清单、改名清单、活宿主验证步骤
- [安全策略](SECURITY.md) —— 漏洞报告渠道、数据隐私与保留策略
- [迁移指南](docs/MIGRATION.md) —— 0.1.0 → 0.2.0 你要做什么
