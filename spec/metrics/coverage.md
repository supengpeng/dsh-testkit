# B1 旧代码分支覆盖率（阶段 0 最终读数）

> **权威依据**：[REWRITE-METRICS.md §3](../../docs/REWRITE-METRICS.md)（B 类；B1 的工具选择说明）、[§15](../../docs/REWRITE-METRICS.md)（阶段 0 退出条件：B1 ≥ 80%；阶段 3：B1 ≥ 90%）、[§17](../../docs/REWRITE-METRICS.md)（未达标处理）、[§18](../../docs/REWRITE-METRICS.md)（测量工具自身验证）、[REWRITE-DESIGN.md §1.2](../../docs/REWRITE-DESIGN.md)（变更 / 沿用的迁移性质）、[RFC 0001 §5.1](../../docs/rfc/0001-rust-core-full-rewrite.md)（注册面数量变化）。
>
> **测量时间**：2026-10-11（本机时区 UTC+08:00），环境指纹见 [baseline.md](baseline.md) §2 与 [`baseline/env.json`](../../baseline/env.json)。
>
> **修订记录**
> - **修订 1**（Lead 复核）：空集合读数标为**无效**并修好工具（附负向证明）；新增 spec ↔ 旧代码映射；写出判定句与两条路径。
> - **修订 2**（裁决一 / 二）：采纳路径 2；分母改为「设计 §1.2 的**变更**模块」，保留全旧代码口径；**自己发现并更正一处测量缺陷**（§4.5）；补引用覆盖率并点名缺条目的模块。
> - **修订 3**（裁决三 / 四 + task-7）：`kinds/types.ts` 移出分母、`tools.ts`/`commands.ts` 加入；引用覆盖率刷新。
> - **修订 4（最终）**：**撤销裁决五**（`cli/index.ts` 判回 keep）并留痕（§1.4）；**写死引用覆盖率的分子口径**——只算 `status: active` 且 `source.file` 指向旧代码的条目（§5.2）；判定口径的全部历史读数从日志汇总为 6 次并给中位数（§4.6）。

---

## 0. 结论先行

### 0.1 最终判定句

> **阶段 0 的退出条件「B1 旧代码分支覆盖率 ≥ 80%」判定为：达成。**
>
> 依据：**最终变更清单口径**（分母 = 设计 §1.2 的「变更」模块 ∪ 归属表显式加入的 `src/tools.ts`/`src/commands.ts` − 显式移出的 `src/kinds/types.ts` = **31 个源文件**）的分支覆盖率 —— **6 次独立读数全部 ≥ 80%：81.14 / 81.25 / 81.33 / 81.33 / 81.36 / 81.40 %，中位数 81.33%，极差 0.26pp，最弱一次仍高于门槛 1.14pp**。

**另外三条必须一起读的话**：

> ① 提交的 [`coverage-change-scope.json`](../../baseline/coverage-change-scope.json) 里那**单次**读数是 **81.25%**；Lead 先前引用的 **81.36%** 是这六次里的其中一次（最高的一次）。**摘要统计量取中位数 81.33%**，单次值、区间、逐次来源全部可查（[`coverage-final-summary.json`](../../baseline/coverage-final-summary.json)）。
>
> ② **全旧代码口径（107 个可测源文件）分支 78.03%，低于 80%。** 按裁决它不是 B1 的定义（§1），故不构成阶段 0 的阻断——数字如实保留。
>
> ③ **最新 spec 快照下，变更清单的引用覆盖率 = 31/31 = 100%**（`src/tools.ts`/`src/commands.ts` 由 `spec/behaviors/engine/surfaces.md` 的 **active** 条目 `model-tools` / `plugin-command` 覆盖）。**这个 100% 只在"分子只算 active"的口径下成立**——见 §5.2 的口径与见证。

### 0.2 全部口径的读数（七个，一个都不删）

| # | 口径 | 分母（文件数） | 行 % | **分支 %** | 函数 % | 状态 |
|---|---|---:|---:|---:|---:|---|
| **F** | **最终变更清单** — **B1 的判定口径** | **31** | 88.65 | **81.25**（6 次中位数 **81.33**） | 86.27 | ✅ **判定口径** |
| B0 | 变更（**补全前**，仅 §1.2 逐行解析） | 30 | 96.52 | 83.87 | 93.80 | ✅ 保留 |
| B1 | 变更（补全后，**含** `kinds/types.ts`，适用裁决三之前） | 32 | 88.87 | 81.46 | 86.45 | ✅ 保留（展示裁决三影响） |
| B2 | **已撤销的裁决五口径**（最终清单 + `cli/index.ts`） | 32 | 88.80 | **81.21** | 86.60 | ⚠️ `superseded_by: Lead 2026-10-11 撤销裁决五` |
| S1 | 最终清单 **+ 整个 `cli/**`** | 41 | 87.05 | **77.11** | 84.28 | ⚠️ 低于 80%（敏感度，分母过宽） |
| A | **全旧代码**（全部可测 `src/**`） | 107 | 90.62 | **78.03** | 88.09 | ✅ 对照口径（保留） |
| C | 变更（补全前）+ §1.2 **未列** | 90 | 91.44 | **79.84** | 88.93 | ⚠️ 低于 80%（敏感度） |
| E | ~~`--test-coverage-exclude=**/lib/**`~~ | **0** | — | — | — | ❌ **无效**（§4.4） |
| A0 | 全旧代码（**修正前**，含 §4.5 的缺陷） | 105 | 90.53 | 77.96 | 88.01 | ⚠️ 已作废 |

- 数字取自**当前提交的** `baseline/coverage-change-scope.json`（第 4 次完整运行）；判定口径的**全部 6 次读数**见 §4.6。
- 所有有效读数都来自 **824 tests / 816 pass / 0 fail / 8 skipped**（8 条 skipped 全是宿主缺 `subprocess` / `fs` / `sessions` / `compaction` 的如实降级）——**覆盖率是在全绿前提下测的**。
- 门槛对照：阶段 0 **≥80%** → F **达成**（最弱一次 +1.14pp）；阶段 3 **≥90%** → F 差 **8.67pp**、A 差 **11.97pp**，都未达。
- 同一批数字在 J2 上是另一种颜色：行 90.62% 过了 J2 行门槛（≥80%），分支 78.03% 过了 J2 分支门槛（≥75%）、未达 J2 分支目标（≥85%）。**B1 与 J2 的阈值不同，不能互相替代。**

### 0.3 两条更正声明（都是"数字变好"时仍然报）

**(a) 测量缺陷**：修订 1 报的 **77.96%**（全旧代码口径）有一处缺陷——排除项里的 export 目录通配**误伤** `src/export/node-test.ts` 与 `src/export/write.ts`。修正后全旧代码口径 = **78.03%**（105 → **107** 个文件行），**升高**。根因与修法见 §4.5。

**(b) 裁决撤销**：Lead 于 2026-10-11 **撤销裁决五**（曾把 `cli/index.ts` 计入变更）。按 32 文件的读数（**81.21%**）**仍 ≥ 80%**，但它是**错的分母**，因此标 `superseded` 保留为敏感性对照，不参与判定。撤销理由留痕见 §1.4 —— **撤销也必须可追溯**，否则下一个人会看到两条互相矛盾的裁决而不知道哪条生效。

---

## 1. 分母的判定规则（可复算，下一个人不需要重新推）

### 1.1 为什么分母不是"全部旧代码"

B1 的目的是「确认**将要被替换的行为**已被 spec 提取」。一个「沿用」（原样保留、不重写）的模块**根本不会被替换**，它的分支覆盖对这个目的没有信息量。**判断标准（Lead 给出）**：这不是"为了过门槛而换分母"——**如果修正后数字变低也接受**。事实检验：裁决四把 `tools.ts`（38.46%）与 `commands.ts`（54.55%）加进分母，读数从 83.87% 掉到 **81.25%**（**−2.62pp**，照报）；裁决三把 `kinds/types.ts` 移出分母，读数**再降**（移出的是 100% 分支文件，减少的是分母里的满分项，照报）。

### 1.2 规则本身（三步，全部机械化）

```text
① 变更清单 := §1.2 逐行解析出的「变更」模块        （工具读 docs/REWRITE-DESIGN.md，不凭印象）
②            ∪ 归属表里显式点名「变更」的未列模块      （当前：src/tools.ts、src/commands.ts）
③            − 归属表里显式点名「移出」的模块          （当前：src/kinds/types.ts）
   其余未列模块 → 沿用    依据：「没有被要求重写就是沿用」
```

规则写成**数据**放在 [`baseline/coverage-change-scope.mjs`](../../baseline/coverage-change-scope.mjs) 的 `RULING` 里（含逐条依据与出处、以及**已撤销裁决**的留痕），解析结果原样落进 [`baseline/design-scope.json`](../../baseline/design-scope.json)。

**§1.2 解析读数**：§1.2 表格 **10 行 → 12 条路径匹配器**（`runtime/fixture.ts + isolation/**` 一行贡献 2 个模式）。解析器带**自检**：21 个"人可复核"的期望分类必须逐个一致，否则**立刻变红、拒绝继续**。这次自检真的抓到了我第一版解析器的三个 bug（剥掉 `*` 丢了 glob、括号注释粘在路径上、前缀匹配多一个斜杠）。

### 1.3 §1.2 未列模块的归属表（裁决，逐类给依据）

| 未列模块 | 归属 | 依据 |
|---|---|---|
| `src/tools.ts`、`src/commands.ts` | **变更** | [RFC 0001 §5.1](../../docs/rfc/0001-rust-core-full-rewrite.md)：「**工具 13 → 15**」（+`testkit_collect` / `testkit_refine`）、「**CLI 子命令 16 → 18**」（+`collect` / `refine`）；设计 §1.2 漏列 |
| `src/kinds/types.ts` | **移出（沿用）** | **裁决三**（采纳 spec-engine 的源码核对）：① 8 项里 6 项是纯类型（编译期消失）；② 剩下 2 个值类型的行为已被现有 spec 覆盖（`SkipCase` → `runner.md` 的 `runner-run-case`；`DriverRegistry` 只作宿主构造工具）；③ 它进分母是 matcher 机械展开 `kinds/*.ts` 的产物——**"分母错"，不是"分子缺"** |
| `surface/**`、`headless/**`、`touchstone/**`、`doctor/**`、`dx/**`、`insight/**`、`pipeline/**`、`registry/**`、`selection/**`、`trace/**`、`triage/**`、`config.ts`、`host-facade.ts`、`index.ts`、`contracts/**` | **沿用** | Lead 裁决：设计 §5.1 的资产处置只要求重写 host 半的**执行引擎**部分；这些模块不在其列。「没有被要求重写」就是沿用，不是「没判断」 |
| **`src/fixtures/**`（5 个文件）** | **沿用** | **显式理由（裁决 3）**：设计 **§9.1 明确「复用既有 `fixtures` 的 `dshVersion` 兼容机制，不新造第二套」**——这不是"文档没提"，而是**设计明确要求复用** |
| `adapters/dsh/tools.ts`、`export/node-test.ts`、`export/write.ts`、`runtime/refs.ts`、`runtime/runlog.ts` | **沿用** | 未被 §1.2 或归属表逐条点名，按默认规则归沿用；`runtime/runlog.ts` 另有旁证：[REWRITE-METRICS §2](../../docs/REWRITE-METRICS.md) A4 写「**沿用**既有 `src/runtime/runlog.ts` 的枚举」 |

### 1.4 撤销留痕：裁决五（`cli/index.ts`）

| 项 | 内容 |
|---|---|
| 原裁决 | **裁决五**（2026-10-11，Lead）：`cli/**` 整体不算变更，但 **`cli/index.ts`（子命令注册表）算变更**；依据是 RFC §5.1 的「16 → 18」物理上只能发生在这张表里 |
| **撤销** | **2026-10-11，Lead 撤销裁决五**，`src/cli/index.ts` **判回 keep**，最终变更清单仍是 **31 个文件** |
| 撤销理由（Lead 原话要旨） | **B1 度量的是「将被替换的行为」，而「16 → 18」是新增两个子命令，不是替换两个**：既有的 16 个子命令分派逻辑逐字不变（设计 §1.2 判 `cli/**` 沿用，理由「退出码见 §9.4」；RFC §3.3 要求「既有 CI 脚本零改动」）。裁决五的依据「16→18 物理上只能发生在 `cli/index.ts`」本身没错，**错在由此推出「所以它算变更」——「一个文件会被改动」与「它承载的行为会被替换」是两件事** |
| 处置 | 该文件判回 keep；按 32 文件跑出的读数（**81.21%**，2 次：81.21 / 81.24）作为**敏感性对照**保留，变体 `change_superseded_ruling5`，并在 `design-scope.json` 的 `ruling.retracted` 里留下结构化留痕（`was: change → now: keep` + 原因 + 后果） |
| 为什么值得留痕 | 否则下一个人会看到两条互相矛盾的裁决，而不知道哪条最终生效。**撤销的可追溯性与裁决本身同等重要** |

> **这条撤销要传达的口径纪律**：**「新增扩展」不等于「替换」**。B1 只度量后者。一个新文件（或一段新逻辑）无论指向哪个旧文件，都不进"旧代码分支"的分母；反之，一个"会被改动"的旧文件若其行为不被替换，也不进分母。

### 1.5 最终变更清单（31 个文件）

`analysis/{causes,classify,repro}.ts`（3）、`isolation/{cleanup,context,leaks,pool,probes}.ts`（5）、`kinds/*.ts`（13：12 个 driver + `index.ts`；**不含** `types.ts`）、`report/{json,junit,markdown,present,redact}.ts`（5）、`runtime/{runner,assert,fixture}.ts`（3）、`tools.ts`、`commands.ts`（共 **31**）。

`keep_final` = **78** 个文件。`src/client.ts` 与 `lib/client.js`（esbuild 产物）不进任何口径：它的编译产物被 client 半产物覆盖，无法按 TS 逐文件测量。

---

## 2. 工具选择：为什么**不**是 `cargo-llvm-cov`

REWRITE-METRICS §3 的原话：

> 原稿用 `cargo-llvm-cov` 测「旧代码分支覆盖率」。旧代码是 TypeScript，`cargo-llvm-cov` 测不到它——这是一处**纯工具错配**。正确做法是 Node 侧覆盖率（V8 内建或 c8）。Rust 侧覆盖率是**另一个指标**（J1）。

本轮实际采用：**Node 内置测试覆盖率**（`node --test --experimental-test-coverage`，底层 V8），**零新增依赖**（没有引入 c8，没有改 `package.json`）。旧代码是 `src/**/*.ts`，`tsc` 编译到 `lib/**/*.js` 且 `sourceMap: true` → 加 `--enable-source-maps` 后报告文件名**回映到 `src/*.ts`**。**已用最小样例验证**：同一文件回映前报 `s.js`（line 90 / branch 66.67），回映后报 `s.ts`（line 75 / branch 66.67）。

---

## 3. 实际执行的命令

设 `$NODE = 'C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'`，工作目录 = 仓库根，且 `lib/` 已由 gate 构建。**区分两类来源**：

- **【官方】** = 本目录工具产出，**会写 `baseline/**`**；
- **【只读复算】** = `spec-engine` 自写脚本、跑完即删，**不写 `baseline/**`**（它守住了写权限边界）。

### 3.1 【官方】七个变体一次跑完

```powershell
& $NODE baseline/coverage-change-scope.mjs
# 复采判定口径（可反复跑，读追加进 coverage-final-repeat.json）：
& $NODE baseline/coverage-change-scope.mjs --repeat-final
# 把判定口径的全部历史读数从日志汇总（不手抄）：
& $NODE baseline/coverage-final-summary.mjs
```

基础排除项（所有变体共用）：

```text
--test-coverage-exclude=**/node_modules/**
--test-coverage-exclude=**/tests/**
--test-coverage-exclude=**/scripts/**
--test-coverage-exclude=**/bin/**
--test-coverage-exclude=**/export/scenarios.test.mjs      ← 只匹配那一个生成文件（不能写目录通配，§4.5）
--test-coverage-exclude=**/lib/client.js
```

### 3.2 【官方】spec 快照 + 引用覆盖率（含分子口径）

```powershell
& $NODE spec/schema/validate-spec.mjs --json     # 真源自报：20 文件 / 57 条目 / 0 error / 1 warning
& $NODE baseline/spec-source-map.mjs             # 按 status 分流，给出 active-only 的分子集合
& $NODE baseline/spec-vs-design.mjs              # × 设计分类求交 → 引用覆盖率 + 见证 + 点名
```

原样输出（`spec-vs-design.mjs`）：

```text
变更清单 31 个中，spec 的 **active** 条目覆盖了 31 个（100%），**未覆盖 0 个**

【分子口径】只算 `status: active` 且 `source.file` 指向旧代码（src/**）的条目；`unsupported` / `draft` 一律不计入（无论它们指向哪里）
status 分布：{"active":55,"unsupported":2}；被排除的非 active 条目 2 条；按 status 过滤是否改变结果：false
  change_final     共 31 个，active 引用 31 个（100%），未引用 0；状态无关口径 100%
  keep_final       共 78 个，active 引用  2 个（2.6%），未引用 76；状态无关口径 2.6%
  unlisted_by_1_2  共 62 个，active 引用  3 个（4.8%），未引用 59；状态无关口径 4.8%
=== 被排除的非 active 条目（见证）===
  - BEH-ENGINE-SURFACES-003（status=unsupported，source.file=src/tools.ts）
  - BEH-ENGINE-SURFACES-004（status=unsupported，source.file=src/commands.ts）
```

### 3.3 口径 E（无效，保留为负向证据）

```powershell
... --test-coverage-exclude=**/lib/** tests/contracts/*.test.mjs tests/*.test.mjs export/scenarios.test.mjs
```

### 3.4 为什么三套测试要在**同一个** `node --test` 进程里跑

覆盖率分母是"旧代码总分支数"，最好的近似是**所有既有测试合起来的到达集**：分三次跑只能拿到三份各自的百分比，无法并成并集（缺每文件的分支权重）。合并运行顺便给出自洽性对照：`tests 824 = 65（契约轨）+ 733（主套件）+ 26（导出轨）`，与 gate 的三段之和完全一致。

### 3.5 【官方】解析早期报告（不手抄数字）

```powershell
& $NODE baseline/parse-coverage.mjs baseline/coverage-stage0-combined.log baseline/coverage-stage0-src-only.log baseline/coverage-stage0-src-ts-only.log baseline/coverage-stage0-all-src-fixed.log
# 该命令**按设计退出 1**（输入含口径 E 那条无效 run，§4.4）；coverage-weakest.md 取自最后一次有效 run
```

---

## 4. 读数、清单与陷阱

### 4.1 门槛对照

| 口径 | 分支 % | 对阶段 0（≥80%） | 对阶段 3（≥90%） | 对目标（≥95%） |
|---|---:|---|---|---|
| **F 最终清单（判定，31）** | **81.25**（中位数 81.33） | **达成（最弱一次 +1.14pp）** | 差 8.67pp | 差 13.67pp |
| B0 补全前（30） | 83.87 | 达成（+3.87pp） | 差 6.13pp | 差 11.13pp |
| B1 补全后含 types.ts（32） | 81.46 | 达成（+1.46pp） | 差 8.54pp | 差 13.54pp |
| B2 **已撤销**口径含 `cli/index.ts`（32） | 81.21 | 达成（+1.21pp，但**分母已作废**） | 差 8.79pp | 差 13.79pp |
| S1 最终清单 + 整个 `cli/**`（41） | 77.11 | **未达（−2.89pp）** | 差 12.89pp | 差 17.89pp |
| A 全旧代码（107） | 78.03 | 未达（−1.97pp） | 差 11.97pp | 差 16.97pp |
| C 补全前 + 未列（90） | 79.84 | 未达（−0.16pp） | 差 10.16pp | 差 15.16pp |

**C 只差 0.16pp、S1 差 2.89pp**——两个敏感度都在门槛附近或以下，是 §6.4 的裁决输入。

### 4.2 判定口径（F，31 个文件）的逐文件读数

分支 **< 80% 的有 7 个**，另有 1 个正好压在 80.00%：

| 文件 | 分支 % | 行 % | 归属依据 |
|---|---:|---:|---|
| `src/tools.ts` | **38.46** | 62.92 | 裁决四加入（RFC §5.1 工具 13→15） |
| `src/commands.ts` | **54.55** | 38.68 | 裁决四加入（RFC §5.1 CLI 16→18） |
| `src/report/redact.ts` | 62.07 | 97.80 | §1.2 `report/**` |
| `src/report/present.ts` | 72.41 | 98.13 | §1.2 `report/**` |
| `src/isolation/probes.ts` | 73.68 | 91.82 | §1.2 `isolation/**` |
| `src/kinds/compaction.ts` | 74.79 | 96.73 | §1.2 `kinds/*.ts` |
| `src/kinds/resource.ts` | 77.97 | 97.34 | §1.2 `kinds/*.ts` |
| `src/isolation/context.ts` | **80.00** | 98.32 | §1.2（**正好在门槛上**，§4.6） |

再往上：`kinds/session.ts` 80.24、`runtime/runner.ts` 81.37、`kinds/fs.ts` 81.40、`kinds/agent.ts` 83.33、`kinds/shell.ts` 83.33、`kinds/file.ts` 84.62、`kinds/interaction.ts` 85.11（共 7 个落在 80–86%），**其余 16 个 ≥ 86%**。全部 31 个的逐文件数字在 [`baseline/coverage-change-scope.json`](../../baseline/coverage-change-scope.json) 的 `variants.change_final.files`。

> ⚠️ **单文件读数跨运行不稳定**（实测最大漂移 ~2.9pp，§4.6）——上表只是某一次运行的读数，`< 80%` 这个集合本身也可能 ±1 个文件。**判定用聚合值，不要用单文件数字当门槛。**
>
> 两个新加入的文件为什么这么低：`src/tools.ts`（13 个模型工具的定义）与 `src/commands.ts`（16 个人类命令）是**注册面**——既有测试大多直接 `import` 引擎函数而很少走注册/派发路径。它们的**行为**（被委托到引擎）在 spec 里有 active 条目，注册面本身也已由 `surfaces.md` 的 active 条目覆盖（§5.3）。

### 4.3 被排除的文件与排除理由

| 被排除的模块 | 文件数 | 依据 |
|---|---:|---|
| `cases/**` | 5 | §1.2「**留在 TS**」/「**沿用**（`schema: 1` 不变）」 |
| `cli/**`（含注册表 `cli/index.ts`） | 10 | §1.2「**沿用**（退出码见 §9.4）」+ **裁决五已撤销**（§1.4）：新增扩展 ≠ 替换 |
| `executor/policy.ts` | 1 | §1.2「**留在 TS**」/「**沿用**（它是安全边界）」 |
| `http.ts` + `client/**` | 1（`http.ts`） | §1.2「**留在 TS**」/「**沿用**（HTTP bridge 已实测结案，不动）」 |
| `src/kinds/types.ts` | 1 | **裁决三**（分母错，不是分子缺） |
| `src/fixtures/**` | 5 | **裁决 3**：设计 §9.1 明确复用既有兼容机制 |
| §1.2 未列模块（其余） | 55 | 默认归「沿用」（规则见 §1.2） |
| **合计 `keep_final`** | **78** | — |

### 4.4 陷阱 ①：`files: []` 却报 100%（口径 E 为何无效）

口径 E 排除 `**/lib/**` 后：报告的**文件行数 = 0**，但 `all files` 行显示 `100.00 | 100.00 | 100.00`。原因是 **`--test-coverage-exclude` 匹配的是 source map 回映前的 `lib/...` 路径**：所有 `src/**` 读数都来自 `lib/**/*.js`，一句 `**/lib/**` 全排掉了。

| 项 | 处置 |
|---|---|
| 该 run 的记录 | `baseline/coverage-summary.json` 里标 `valid: false` + `invalid_reason`；Node 报的 100% 挪到 `aggregate_reported_by_node`（留证据）；可消费的 `aggregate` 置 **`null`** |
| 解析器 | `parse-coverage.mjs` 加**空集合守卫**：`files` 为空即标无效并**退出码 1**（修的是测量工具自身的缺陷，依据 §18） |
| 负向证明 | [`baseline/selftest-parse-coverage.mjs`](../../baseline/selftest-parse-coverage.mjs)：合成空集合日志 → 必须退出 1 且 `valid:false`；**正向对照**有文件行 → 必须退出 0 且 `branch=66.67`。实测两侧都符合 |
| 是否重跑 | **不重跑，明确放弃**：它要问的问题由口径 A 更正确地回答。口径 E 只作负向证据 |

**同类陷阱**：`--test-coverage-include` 在本机 Node v24.21.0 上**匹配不到任何文件**（试过 8 种 glob 全是空表，同样伪装成 `all files 100%`）。**结论：只用 exclude，不用 include。**

### 4.5 陷阱 ②：我自己踩到的测量缺陷（export 目录通配误伤）→ 更正

| 项 | 内容 |
|---|---|
| 现象 | 全旧代码口径报 **105** 个文件行，比磁盘上的 `lib/**/*.js`（110 个）少了 5 个 |
| 根因 | 基础排除项用了"export 目录通配"。它匹配**路径里含 `/export/`** 的一切，于是把 `lib/export/node-test.js`、`lib/export/write.js` 也排掉了——这两个是**真实源码**的产物，而且**有测试覆盖** |
| 修法 | 改成**只匹配那一个生成文件**（`**/export/scenarios.test.mjs`）。已在三个工具里修正并加注释 |
| 影响 | 全旧代码口径：105 → **107** 个文件行，分支 77.96% → **78.03%**（**升高**）。对判定口径**无影响**：其保留集合里没有 `src/export/*` |

**另外 3 个文件为什么不在报告里**（不是缺陷，是两类已知边界）：`src/client.ts`（产物被 esbuild bundle 覆盖，无法按 TS 测量）；`src/contracts/types.ts`、`src/doctor/types.ts`（**type-only 模块，从未被任何测试加载**——Node 覆盖率只报"被加载过"的文件，所以本文件的数字是**上界**）。

### 4.6 运行间波动：判定口径 6 次读数，极差 **0.26pp**

判定口径（31 文件）的**全部历史读数**（机器汇总，来源：[`coverage-final-summary.json`](../../baseline/coverage-final-summary.json)）：

| 读数 | 来源 | 说明 |
|---:|---|---|
| 81.14 | `coverage-final-repeat.json` | `--repeat-final` 复采 |
| 81.25 | `coverage-change-scope-run4.log` | 提交 JSON 里的**单次值** |
| 81.33 | `coverage-change-scope-run1.log` | 撤销五之前（同为 31 文件） |
| 81.33 | `coverage-change-scope-run3.log` | 该次标签为 `change_without_ruling5` |
| 81.36 | `coverage-change-scope-run2.log` | 修订 3 提交值（Lead 引用过的那一次） |
| 81.40 | `coverage-final-repeat.json` | `--repeat-final` 复采 |

**min 81.14 · median 81.33 · max 81.40 · 极差 0.26pp；6 次全部 ≥ 80%，最弱一次仍高 1.14pp。**

其他口径的重复运行极差：A 全旧代码 0.02–0.07pp、B0 补全前 0.08pp、C 0.05pp。

**单文件波动更大**：

| 文件 | 运行 1 | 运行 2 | 差 | 原因线索 |
|---|---:|---:|---:|---|
| `src/isolation/probes.ts` | 72.22 | 73.68 | **1.46pp** | **分支总数本身变了**：72.22% = 13/18，73.68% = 14/19 |
| `src/report/json.ts` | 86.21 | 83.33 | **2.88pp** | 同型：分母（分支结构计数）两次不同 |

**四条硬纪律**：

1. B1 的**聚合**读数只应报到 ~0.1pp 精度；**单文件百分比不要做跨运行比较**。
2. 若某次读数落在门槛 ±0.1pp 内，**必须重采并报两次**（本判定口径已采 6 次）。仍落在该区间的有：口径 **C = 79.84%**（差 0.16pp）、**S1 = 77.11%**（差 2.89pp）、`src/isolation/context.ts` **正好 80.00%**。
3. 「< 80% 的文件」这个**集合**也在 ±1 个文件的噪声内——**它是改进目标清单，不是判定**。
4. ⚠️ **一处必须上报的对照**：REWRITE-METRICS §18 给覆盖率工具的误差门槛是 **≤0.1%**，而本判定口径 6 次读数的聚合极差已达 **0.26pp**——**超过了该门槛**。这是"读数必须多次重采后才可下判定"的直接证据，也是给裁决者的输入（**不代为裁定**：要么把 §18 的 0.1% 明确解释为"测量错误率"而非"运行间波动"，要么给 B1 定一个"重复运行取中位数"的采集协议）。

---

## 5. spec ↔ 旧代码：引用覆盖率与逐文件归因

### 5.1 spec 侧快照（数据源）

| 项 | 值（**最终刷新**） |
|---|---|
| spec 行为文件 | **20** 个（12 kinds + **7** engine 模块：runner / assert / fixture / isolation / report / policy / **surfaces**） |
| 原子条目 | **57** 条（唯一 id 57）；`status` 分布 = **active 55 / unsupported 2** |
| `spec/schema/validate-spec.mjs --json`【官方】 | **errors 0 / warnings 1** |
| active 条目引用的 `source.file` | **33** 个，全部在 `src/` 下 |
| ⚠️ 状态 | spec 树**仍在生长**：快照的文件清单、字节数、mtime 记在 [`baseline/spec-source-map.json`](../../baseline/spec-source-map.json) 的 `spec_snapshot.files_snapshot`；结论**只对本快照成立** |

### 5.2 引用覆盖率的**分子口径**（写死，可复算）

> **分子只算 `status: active` 且 `source.file` 指向旧代码（`src/**`）的条目；`unsupported` / `draft` 一律不计入（无论它们指向哪里）。**

**为什么必须写死**（Lead 补充口径的要旨）：目标态条目（如 `surfaces.md` 的 `collect-refine-tools` / `collect-refine-command`，`status: unsupported`）**不是旧代码分母的一部分**——旧代码里根本不存在那两个名字；它们的作用是**阶段 1 的落点声明**。**这条口径是可被滥用的**：如果有一天有人为了让引用覆盖率达到 100%，给一个"还没实现的目标态"写 active 条目、把 `source.file` 指向某个旧文件，机械统计就会把它当成"已覆盖"。所以：**统计时按 status 过滤，并把被排除的条目原样列出来做见证。**

**见证机制**（`spec-source-map.json.excluded_non_active_atoms`，每次刷新都会重算）：

```text
- BEH-ENGINE-SURFACES-003（status=unsupported，source.file=src/tools.ts）
- BEH-ENGINE-SURFACES-004（status=unsupported，source.file=src/commands.ts）
```

**这两条正是"滥用路径"的真实样本**：它们**确实**把 `source.file` 指向了旧文件（`tools.ts` / `commands.ts`）。本次"按 status 过滤是否改变结果 = false"，是因为这两个文件**同时**被 active 条目 `model-tools` / `plugin-command` 覆盖——**一旦那两条 active 条目缺失或失效，过滤就会改变结果**。口径与见证合起来，让"没实现的东西被算成已覆盖"这件事**不可能悄悄发生**。

**可复算**：`status_histogram`、`excluded_non_active_atoms`、`source_file_histogram_active_only`、`by_class_status_blind` 都在 JSON 里；跑 §7 的第 4 条命令即可复得。

### 5.3 引用覆盖率的最终读数（【官方】与【只读复算】分开标注）

| 口径 | 【官方】（本目录工具，写 `baseline/**`） | 【只读复算】（`spec-engine`，不写 `baseline/**`） | 是否一致 |
|---|---|---|---|
| **变更清单（31 个）** | **31 / 31 = 100%** | 与 `surfaces.yaml` **行号级一致、无差异**（spec-engine 自核 13 工具 / 17 顶层命令 / 7 issue 嵌套 / 16 CLI 子命令 / 4 路由） | ✅ 一致 |
| 变更（补全前 30 个，修订 3 时） | 29 / 30 = 96.7% | 96.7%（29/30） | ✅ 一致（历史对照） |
| 状态无关口径（不过滤 status） | 31 / 31 = 100%（与 active 口径相同） | — | — |
| 沿用（`keep_final`，78 个） | 2 / 78 = 2.6% | — | — |
| §1.2 未列（62 个） | 3 / 62 = 4.8% | — | — |

> **两个来源不一致时的处理**：**不取平均、不互相替代**。本次在可比口径上**没有不一致**；若将来不一致，那本身就是要报告的发现（本表就是为这种对照留下的位置）。

**未引用的文件名单：空。**（`conclusion.missing_change_files = []`）—— 修订 3 时点名的 `analysis/**`（3 个）、`isolation/leaks.ts`、`kinds/index.ts` 已被 task-7 覆盖；`tools.ts` / `commands.ts` 由 task-8 的 `surfaces.md` 覆盖；`kinds/types.ts` 已按裁决三移出分母。

**整体引用覆盖率**（active 条目引用的 33 个文件 ÷ 全部可测源文件 107）：**30.8%**。

### 5.4 分支最低的 15 个文件 × 最终分类（机器推导）

来源：`coverage-change-scope.json#variants.all_src_fixed`（修正口径）+ 最终分类。**按分类计数：变更 3 / 沿用 12。**

| # | 文件（分支 %） | 分类 | active 条目数 |
|---:|---|---|---:|
| 1 | `src/cli/commands/transfer.ts`（19.05） | keep | 0 |
| 2 | `src/surface/selection-args.ts`（20.00） | keep | 0 |
| 3 | `src/cli/commands/insight.ts`（22.22） | keep | 0 |
| 4 | `src/runtime/refs.ts`（33.33） | keep | 1 |
| 5 | `src/cli/commands/run.ts`（34.94） | keep | 0 |
| 6 | **`src/tools.ts`（38.46）** | **change** | **1**（`surfaces.md::model-tools`） |
| 7 | `src/doctor/residue.ts`（42.11） | keep | 0 |
| 8 | `src/cli/commands/inspect.ts`（47.89） | keep | 0 |
| 9 | `src/surface/runs.ts`（50.00） | keep | 0 |
| 10 | `src/touchstone/export.ts`（52.73） | keep | 0 |
| 11 | **`src/commands.ts`（54.55）** | **change** | **1**（`surfaces.md::plugin-command`） |
| 12 | `src/cases/index-file.ts`（58.33） | keep | 0 |
| 13 | **`src/report/redact.ts`（62.07）** | **change** | **1**（`BEH-ENGINE-REPORT-004`） |
| 14 | `src/fixtures/load.ts`（62.16） | keep | 0 |
| 15 | `src/touchstone/webhook.ts`（62.37） | keep | 0 |

**直接回答"为什么这些分支没被测试覆盖"**：既有测试**没有一条**走完整的 CLI argv 路径——`tests/cli.test.mjs` 只断言 `package.json` 的 `bin` 指向 `./bin/dsh-testkit.mjs`，其余 CLI 测试都直接 `import` 命令函数。证据形态也对得上：未覆盖区间是**大段连续的整函数**（`selection-args.ts` 的 `58-129`、`transfer.ts` 的 `201-242`），不是零散的分支边角——`tools.ts` / `commands.ts`（同样走注册/派发路径）覆盖率低是同一个原因。

### 5.5 两条仍然成立的发现

**发现一：判定口径内部也有深分支缺口（B1 真正的改进空间）。**
F 口径里分支 < 80% 的 7 个文件（§4.2 前 7 行）分两类：`tools.ts`/`commands.ts` 是**整块注册路径没被执行**（行覆盖 38–63%，现在它们有 active 条目、缺口在测试侧）；其余 5 个是**深分支穷不尽**（行覆盖 92–98%）。**两类补法不同**。

**发现二：`fixture` engine 模块的覆盖面比模块名窄（已裁决归沿用，不影响 B1）。**
spec 的 `fixture` 模块只有 **2 条原子**，全部落在 `src/runtime/fixture.ts`；`src/fixtures/**` 5 个文件没有原子条目。按裁决 3 它们**归沿用**（设计 §9.1 明确复用既有兼容机制），所以**不影响 B1**；但"fixture 模块的原子是否该覆盖 `src/fixtures/**`"仍是**待裁定的边界**。

---

## 6. 判定

### 6.1 判定句

> **阶段 0 的「B1 ≥ 80%」判定为：达成。** 判定口径 = 最终变更清单（31 个文件）；**6 次独立读数 81.14 / 81.25 / 81.33 / 81.33 / 81.36 / 81.40 %，中位数 81.33%，最弱一次仍高出门槛 1.14pp**。
>
> **同时如实保留全部其他口径**：补全前 83.87%（30）、含 types.ts 81.46%（32）、**已撤销的裁决五口径 81.21%（32，标 superseded）**、含 `cli/**` 敏感度 77.11%（41）、全旧代码 78.03%（107）、变更+未列 79.84%（90）。按裁决，只有第一个是判定口径。

### 6.2 余量（**很薄，必须说清**）

判定口径的余量 = **+1.14pp（最弱一次）～ +1.40pp（最强一次）**，而聚合波动本身可达 **0.26pp**、单文件波动可达 ~2.9pp。也就是说：**判定稳（6/6 次都过），但结论脆**——门槛内外的差别已经取决于"哪几个文件算变更"这类定义问题，而不取决于测试质量。

### 6.3 为什么不需要 §17 的例外记录

判定口径**已达成 80%**，所以**不写例外记录**。理由：例外记录的作用是**让门槛的让步可见**；这里**没有让步**——门槛没动（仍是 ≥80%），动的是**分母的定义**，而定义变更由裁决者依据设计 §1.2 与 RFC §5.1 做出，并且**七个口径的读数全部留在本文件里**（§0.2 / §4.1），读者可以自己换口径重算。

**"数字变低也接受"的检验（三条，都是实际发生的）**：
1. 裁决四把 `tools.ts`（38.46%）与 `commands.ts`（54.55%）**加进分母** → 83.87% → **81.25%**（**−2.62pp**），照报。
2. 裁决三把 `kinds/types.ts` 移出 → 又降（移出的是满分项），照报。
3. **裁决五（把 `cli/index.ts` 加进分母）被 Lead 撤销** → 按撤销后的口径重算，判定维持；按 32 文件的那次（81.21%）保留为敏感性，**不参与判定**。

### 6.4 敏感性与待裁定（比数字更重要）

| # | 事项 | 影响 | 状态 |
|---:|---|---|---|
| 1 | **`cli/**` 算不算变更？** | 算（S1）→ **77.11%（未达）**；不算（判定口径）→ 81.25%（达成） | ✅ **已裁决并撤销裁决五**：`cli/**` 整体算沿用；「新增扩展 ≠ 替换」（§1.4） |
| 2 | **§1.2 未列模块算不算变更？** | 算（C）→ **79.84%（未达，差 0.16pp）**；不算 → 判定口径维持 | ✅ 已裁决：未列默认沿用（§1.3） |
| 3 | **注册面的引用覆盖率** | 已由 `surfaces.md` 的 active 条目补齐 → **31/31 = 100%** | ✅ 已完成（task-8） |
| 4 | **`src/fixtures/**` 的原子归属** | 不影响 B1（已归沿用）；影响"行为提取"完整性 | ⏳ 待裁定 |
| 5 | **§18 的 ≤0.1% 与实测 0.26pp 的关系** | 决定 B1 是否需要"重复运行取中位数"的固定采集协议 | ⏳ 待裁定（§4.6 第 4 条） |

---

## 7. 复跑命令汇总

```powershell
$REPO = 'C:\Users\19059\Documents\deepseek-harness\default-workspace\dsh-testkit'
$NODE = 'C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
Set-Location $REPO

# 0) 环境指纹必须匹配（B1 与 D1–D3 同一台机器）
& $NODE baseline/check-env.mjs

# 1) 【官方】七个口径一次跑完（§1.2 逐行解析 + 归属表 + 撤销留痕 + 分类自检 + 空集合守卫）
& $NODE baseline/coverage-change-scope.mjs

# 2) 【官方】判定口径复采（可反复跑；读追加进 coverage-final-repeat.json）
& $NODE baseline/coverage-change-scope.mjs --repeat-final

# 3) 【官方】把判定口径的全部历史读数从日志汇总（不手抄）
& $NODE baseline/coverage-final-summary.mjs

# 4) 【官方】spec 快照 + 引用覆盖率（含"分子只算 active"的口径与见证）
& $NODE spec/schema/validate-spec.mjs --json
& $NODE baseline/spec-source-map.mjs
& $NODE baseline/spec-vs-design.mjs

# 5) 【官方】解析早期报告（会因含无效 run 而退出 1 —— 设计行为，§4.4）
& $NODE baseline/parse-coverage.mjs baseline/coverage-stage0-combined.log baseline/coverage-stage0-src-only.log baseline/coverage-stage0-src-ts-only.log baseline/coverage-stage0-all-src-fixed.log

# 6) 【官方】解析器的负向证明（空集合必须变红 / 有文件行必须变绿）
& $NODE baseline/selftest-parse-coverage.mjs
```

**判定顺序建议**：先 `check-env.mjs` → 再 `coverage-change-scope.mjs`（含分类自检）→ 再 `spec-vs-design.mjs` → 再 `coverage-final-summary.mjs`（拿中位数与极差）→ **最后才下判定**，并先确认 `design-scope.json` 的 `change_final` 与 `ruling.retracted` 是你认可的那一份。

---

## 8. 产物清单

| 文件 | 内容 | 入库 |
|---|---|---|
| `baseline/coverage-change-scope.json` | **七个口径**的读数 + 逐文件 + 判定规则 + 撤销留痕 | ✅ |
| `baseline/coverage-final-summary.json` | 判定口径的 **6 次读数**、min/median/max/极差、逐次门槛判定与来源 | ✅ |
| `baseline/coverage-final-repeat.json` | `--repeat-final` 的复采记录 | ✅ |
| `baseline/design-scope.json` | 判定规则（§1.2 解析 + 归属表 + `ruling.retracted`）+ 最终三分类清单 | ✅ |
| `baseline/spec-source-map.json` | spec 快照（20 文件 / 57 条目）+ status 分布 + **active-only 分子集合** + 被排除条目见证 | ✅ |
| `baseline/spec-vs-design.json` | 引用覆盖率（active 口径 + 状态无关对照）+ 见证 + 15 弱文件×分类 | ✅ |
| `baseline/coverage-change-scope-run1..4.log` | 四次完整运行的 stdout（判定口径读数的原始证据） | ❌ `*.log` 忽略 |
| `baseline/coverage-stage0-change-final.log` | 判定口径原始覆盖率报告（31 行） | ❌ |
| `baseline/coverage-stage0-change-superseded-ruling5.log` | **已撤销**口径的原始报告（32 行，留作敏感性） | ❌ |
| `baseline/coverage-stage0-change-1-2-only.log` / `-change-without-ruling3.log` / `-change-final-plus-cli.log` | 补全前 / 含 types.ts / 含 cli 三个口径 | ❌ |
| `baseline/coverage-stage0-all-src-fixed.log` | 全旧代码口径（修正后，107 行） | ❌ |
| `baseline/coverage-stage0-change-plus-unlisted.log` | 变更（补全前）+ §1.2 未列（90 行） | ❌ |
| `baseline/coverage-stage0-spec-scope.log` | spec 声明文件口径 | ❌ |
| `baseline/coverage-stage0-src-only.log` | 口径 E：空集合却报 100%（**负向证据**） | ❌ |
| `baseline/coverage-stage0-src-ts-only.log` / `-combined.log` | **修正前**的报告（缺陷现场，§4.5） | ❌ |
| `baseline/coverage-summary.json` | 早期报告的解析结果（含标为 `valid:false` 的无效 run） | ✅ |
| `baseline/coverage-weakest.md` | 分支最低的 15 个 src 文件（表） | ✅ |
| `baseline/parse-coverage.mjs` | 解析器（含**空集合守卫**） | ✅ |
| `baseline/selftest-parse-coverage.mjs` | 解析器的负向证明 + 正向对照 | ✅ |
| `baseline/coverage-change-scope.mjs` | 七口径测量工具（§1.2 逐行解析 + 归属表 + 撤销留痕 + 分类自检 + `--repeat-final`） | ✅ |
| `baseline/coverage-final-summary.mjs` | 判定口径历史读数汇总工具 | ✅ |
| `baseline/spec-source-map.mjs` | spec ↔ 旧代码映射工具（含 active-only 分子口径） | ✅ |
| `baseline/spec-vs-design.mjs` | spec × 设计分类求交工具（含见证与状态无关对照） | ✅ |
| `baseline/coverage-spec-scope.mjs` | spec 声明文件口径测量工具 | ✅ |
