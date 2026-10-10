# 阶段 1 指标读数汇总（2026-10-11）

> **一页看全**：阶段 0 与阶段 1 的每个指标，门槛、读数、来源、复算命令。
> **纪律**：**未测的写"未测"**，不写 0、不写"待补"含糊过去——读数表最常见的撒谎方式是"把没测的格子留空"。
>
> 这份表是**验收证据**，不是宣传材料：每行都能被独立复算，**复算不出来的一律标出来**。

## 一、阶段 0（行为提取与基线冻结）

| 指标 | 门槛 | 读数 | 状态 | 来源 |
|---|---|---|---|---|
| **A2** 对拍字段覆盖完整度 | 100% | **78/78 = 100.00%** | ✅ | `crates/reconciler` 的 `compared_count()`；`tests/a2_coverage.rs` |
| **A3** 没比必须可见 | 100% | **80/80 = 100.00%** | ✅ | `spec/contracts/reconcile-fields.yaml`；`verify-reconcile.mjs` |
| **B1** 既有行为提取覆盖率 | ≥80% | **81.33%**（6 次读数中位数，区间 81.14–81.40） | ✅ | `spec/behaviors/kinds/*.md` |
| **B2** 能力面清单 | 16/16 + 4/4 | **16/16 + 4 declared-only** | ✅ | `spec/contracts/capabilities.yaml` |
| **B3** 工具面 | 1/1 | **1/1** | ✅ | `spec/contracts/registry.yaml` |
| **B4** 环境覆盖 | 100% | **机器轴 6/6 = 100%；全轴 6/8 = 75%** | ⚠️ | 见下"未达标项" |
| **B5** 审批路径覆盖 | 100% | **17/19 ≈ 89.5%**（辅助：单测 15/19；可表达性 17/19） | ⚠️ | 见下"未达标项" |
| **D1–D3** 基线冻结 | 冻结 | D1 453.935ms / D2 80.497s / D3 252.566 MiB | ✅ | `baseline/` |

## 二、阶段 1（Rust 核心 + TS 架构地基）

### TS 侧（编译器与协议）

| 指标 | 门槛 | 读数 | 状态 | 复算 |
|---|---|---|---|---|
| **F1** 编译期拦截率 | ≥95% | **21/21 = 100.0%**（validate 6 / construct 15） | ✅ | `node --test tests/compiler-f1.test.mjs` |
| **F2** plan 校验拦截率 | ≥95% | **100%（11/11）** | ✅ | `cargo test -p dsh-testkit-executor` |
| **F3** 资源冲突检出率 | 100% | **100%（3/3）**，点名到节点 id | ✅ | 同上 |
| **F4** 依赖环检出率 | 100% | **100%（5/5）**，含两个不相交的环 | ✅ | `cargo test -p dsh-testkit-reconciler` |
| **A5** 归一化反向测试 | 通过 | **差异检出 8/8 + 三类负向用例** | ✅ | 同上 |
| **H1** 握手成功率 | 100% | **3/3** | ✅ | `node --test tests/rpc.test.mjs` |
| **H2** 不兼容检出率 | 100% | **3/3**（另有一条"对端 ack 自相矛盾 ⇒ 客户端本地复核会红"） | ✅ | 同上 |
| **H3** 类型同步一致率 | 100% | 守卫已落地（`scripts/check-generated-types.mjs`，四态实测） | ✅ | 见 §三 |
| **C1** 同种子确定性 | 恒定 | 12 次同种子 → 哈希 `23d7b1f705f8ed2a` **跨进程恒定**；16 种子 → 11 种出队顺序 | ✅ | `cargo test -p dsh-testkit-scheduler` |

### Rust 侧（防篡改与能力门控）

| 指标 | 门槛 | 读数 | 状态 |
|---|---|---|---|
| **E1** 签名验证通过率 | 100% | 两侧各自实现、65/65 JCS 向量 | ✅ |
| **E2** 篡改检出率 | 100%（5 类各 ≥10 例） | **77/77 = 100%**（field 20 / delete 14 / reorder 12 / insert 16 / signature 15）+ extras 6/6 | ✅ |
| **E3** 链完整性 | 100% | 两侧结论逐字段相同（85 用例 + 2 基准链） | ✅ |
| **E4** 本地锚定成功率 | ≥99% | **100/100（100.00%）**，标 `degraded`（沙箱禁止写仓库外路径） | ✅ |
| **E5** 独立验证器零依赖 | = 0 | 13 模块第三方说明符 **0**；运行期闭包 4 模块外部依赖 **0**；带负向证明 | ✅ |
| **I1** 私钥不出进程 | 100% | Rust 6 份产物 / TS 96 份产物 → **0 命中**，带负向证明 | ✅ |
| **G1/G2/G3** 能力矩阵 | 逐格一致 | G1 20 行 / G3 18 格逐格对齐；`ProbeOutcome` 四态 | ✅ |
| **D4a** 签名次数上界 | ≤ ceil(N/B)+2 | 实测 `ceil(N/B)+1`，恒 ≤ 上界（N=0→1、20000→6） | ✅ |
| **两个边界用例** | **必须检不出** | `boundary-01/02` 两侧都 `chainOk=true`（设计 §7.5 的**实证**，非漏检） | ✅ |

## 三、未达标 / 未测（**不许留空**）

| 项 | 状态 | 原因 | 处置 |
|---|---|---|---|
| **B4 宿主轴**（1/8） | ⚠️ 长期 `manual` | 真实 desktop / web profile 需要宿主二进制，CI 无法覆盖 | **不修**：把它塞进 CI 会让 CI 依赖 GUI 宿主。如实标注 |
| **B4 夹具轴**（1/8） | 📅 **CI job 已加，待首次 push 验证** | CI 上夹具必然 skip（`.fixtures/` 被 gitignore），"CI 绿"从未覆盖这条轴。**已加 `fixtures` job**（单平台 + 单 Node：夹具 40MB，只影响那 7 条**与平台无关**的场景，在 6 个组合上各下一遍是 6 倍下载换 0 倍判别力）。job 里 fetch 之后**先独立跑一次 `verify-fixtures`** —— 因为顺序反了的话"第 7 次 gate 会绿，但什么都没证明"（这正是这条轴此前没被发现的原因） | 待首次 push 验证 ⇒ B4 变 **7/8 = 87.5%**；**验证前不改成 7/8** |
| **B5 余 2 条**（`QP-07`/`DP-07`） | ⚠️ **补不了** | 场景面**不可达**（源码行号级证据见 `approval-paths.yaml` 的 `unreachable_paths`） | 保留在分母 + `expressible: false`。**必须报"2 条不可达"，不许报"还差 2 条没补"** |
| **J2** TS 覆盖率 | ✅ **行 87.05% / 分支 77.74% / 函数 86.99%** | **不需要 c8/nyc**：Node 24 的内建 `--experimental-test-coverage` 就够 | `node --test --experimental-test-coverage --test-coverage-include="lib/**" "tests/*.test.mjs"`（802 测试全绿） |
| **J1** Rust 覆盖率 | ✅ **行 89.84% / 分支 82.12%**（门槛 85/80） | 分支由 `reconciler` 补 29 条达成（`normalize.rs` miss 44 → 15）。⚠️ **这份读数我报了三次才对**（D-9 → D-11 → 其补充）：① 把 `--summary-only` 的 **Regions 列读成了 Lines**；② 用 **stable 口径**（**测不出分支**）宣称达标；③ **用默认 `target/llvm-cov-target`**（profile 混入别人残留 ⇒ 分母虚高到 **10019**、行被算成 76.80%）。**正确命令必须带独立 `CARGO_TARGET_DIR`**（分母 8732） | `CARGO_TARGET_DIR=<独立目录> cargo +nightly llvm-cov --workspace --branch --summary-only`。⚠️ 待 `attest` 的 task-26 完成后**复核一次** |
| **K1** 层级可信度正确率 | ✅ **7/7 = 100.00%**（阶段 1 的**最强形式**，边界见右） | 分两半：**编译期**（`allowedConfidenceFor`，Lead 做的前移，7 个测试 + F1-21 注入项）拦"声明是否自洽"；**运行期**（`LayerConfidenceMismatch` + `confidence_violations`）拦"实际执行是否相符"——**两层都要**，因为设计 §5.4 允许"直接写 ExecutionPlan JSON"的入口绕过编译器。两条负向证明（错误标记 17/17、执行不一致 21/21，均点名到节点 id）+ 零假阳性（11 合法组合）。⚠️ **边界**：阶段 1 的"实际执行"是 `NodeRunner` **注入替身**，不是端到端真跑的 Rust 服务端（设计 §4 的服务端可执行文件在阶段 1 不存在）⇒ **"真实宿主端到端"那一环留待阶段 2 复测**。这条边界写在测试文件的**文件头**（`k1_layer_confidence.rs`），不只在本表 | `cargo test -p dsh-testkit-executor`（29 通过）；`node --test tests/compiler-k1.test.mjs`（7 通过）。⚠️ 两处实现缺同源守卫，见 D-10 |
| **`collect` / `refine`** | ⏸️ **不在阶段 1 的核心范围内**（属独立线） | 它们是设计 **§10「输入源扩展（决定 10）」**这条**独立线**：有自己的退出条件（METRICS：M1 资产清单召回率 ≥90% / M2 提案信噪比 ≥50% / M6 只读性 **100%** / M3 边界清单覆盖率 ≥60%），也有一张 §10.7 的"**什么时候停**"表（信噪比 <50% ⇒ `collect` 保留、`extract` 下架；去重误合并 ⇒ `refine` 降级为"只出建议"）。§10.8 只给了三行**注册面**（`testkit_collect` / `testkit_refine` / 两个 CLI 子命令），**没有行为规格** | 当**独立线**排期；**不要**混进阶段 1 的"架构地基"计数 |
| **`package.json` 的 `files` / `engines`** | ⏸️ **未更新（依赖一个未决）** | RFC §188 把"`package.json` 的 `files` / `scripts` / `engines` 更新"列为重构要改的文件。**`scripts` 已加 `verify:types`**（H3 守卫，**刻意不进 `gate`**——它需要 cargo，而既有 CI 的 6 个组合都没装 Rust）。但 `files` 里要列什么，取决于"**Rust 产物如何分发**"（静态二进制？`.node` 原生模块？随包发布？）—— 而**设计 §1.3 的 crate 列表里没有 bin crate**，所以这条**在设计里是未决的** | 先定分发形态，再改 `files`/`engines` |

## 四、工程守卫（不是设计指标，但决定"下次还绿不绿"）

> **下面的读数取自同一棵冻结的树**（所有成员 idle 时跑；跑之前先确认没有别人在构建）。
> 冻结是必要的：D-2（gate 并发）、D-8（profile 复用）、D-11（口径不可比）三条缺陷都证明
> **读数绑定的是"某棵特定的树 + 某个特定的口径"，不是代码本身**。

| 守卫 | 读数 | 说明 |
|---|---|---|
| `pnpm run gate` | **exit 0**（65 + **809** + 18 全绿） | 两端已加**并发守卫**（`gate-guard.mjs`，四态实测）。⚠️ 收口前它红过一次，原因是**我加了 `verify:types` 后 README/PUBLISHING 的"12 个守卫"变成 13** —— **那是 `verify-docs` 在正常工作**（文档与实现漂移是它的本职），已修 |
| `cargo test --workspace` | **439 通过 / 0 失败** | |
| `cargo clippy --workspace --all-targets -- -D warnings` | **exit 0** | |
| `cargo fmt --all --check` | **exit 0** | |
| `check-encoding` | **919 文件 OK（UTF-8 无 BOM）** | 曾因一次负向证明的"篡改后恢复"留下 BOM（D-6） |
| `check-secrets` / `verify-docs` / `check-lockfile` / `check-ci-hardening` / `verify-registry` / `verify-fixtures` / `check-pack-files` / `check-adapter-boundary` / `check-bundle-patch` / `check-git-installable` | 全部 OK | 新增代码未破坏任何既有守卫 |
| `check-generated-types.mjs`（H3） | WARN（目录尚未入库） | 首次提交后自动生效；**当前是"守卫还没上线"，不是通过** |
| `verify:types`（新增的 13 号守卫） | 已接入 `package.json`，**刻意不进 `gate`** | 它需要 cargo；在 CI 的 `rust` job 里跑 |
