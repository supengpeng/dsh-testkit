# D1–D3 冻结基线（阶段 0 实测）

> **状态**：**已冻结**（`degraded = false`）。冻结时间 **2026-10-11**（本机时区 UTC+08:00），由阶段 0-D 的 `baseline-freezer` 采集。
>
> **权威依据**：[REWRITE-METRICS.md §5](../../docs/REWRITE-METRICS.md)（D 类：性能，基线冻结）与 §15（阶段 0 退出条件：`baseline/perf-baseline.json` 与 `env.json` 已落盘）。
>
> **为什么必须有这份文件**：原稿把 D1/D2 的分母定义为「旧实现」，而 RFC 0001 决定 4 的终点就是**删除旧实现**。基线若不落成数值，阶段 3 之后 D1–D3 会**永久失去分母**。本目录里的 JSON 就是这个分母。

## 0. 三分钟版

| 指标 | 冻结值 | 单位 | 样本 | 口径一句话 |
|---|---:|---|---:|---|
| **D1** 单用例执行时间 | **453.935** | ms | N=7（取中位数） | `TK-0001` 端到端墙钟，**全新进程、含冷启动、无预热** |
| **D2** 全套执行时间 | **80.497** | s | 3 次独立读数（80.497 / 72.807 / 144.399） | `pnpm run gate` 完整 20 段链条的墙钟；冻结值恰好也是三次的中位数 |
| **D3** 内存峰值 | **252.566** | MiB | 469 次采样 | 契约轨 + 主套件在**单进程**里跑完的 RSS 峰值 |

- 环境指纹 `sha256 = 8a2a74f575fad17d4bd71307516935fb92cd802158f15cd9e95c40ad8d6d4899`
- 冻结时的质量门：`pnpm run gate` **退出码 0**，契约轨 65/65、主套件 733/733、导出轨 26 条（18 通过 / 8 如实跳过 / 0 失败）
- 机器可读版本：[`baseline/perf-baseline.json`](../../baseline/perf-baseline.json)、[`baseline/env.json`](../../baseline/env.json)
- **B1（旧代码分支覆盖率）不在本文件**，在 [coverage.md](coverage.md)。按 Lead 裁决（分母 = 设计 §1.2 的「变更」模块 ∪ 归属表显式加入者 − 显式移出者）：
  **最终变更清单口径 = 31 个文件，分支 6 次读数 81.14 / 81.25 / 81.33 / 81.33 / 81.36 / 81.40 %（中位数 81.33%，最弱一次仍高门槛 1.14pp）→ 阶段 0 的「B1 ≥ 80%」达成**；
  另如实保留：补全前 **83.87%**（30）、含 `kinds/types.ts` **81.46%**（32）、**已撤销的裁决五口径 81.21%**（32，标 superseded）、含 `cli/**` 敏感度 **77.11%**（41）、全旧代码 **78.03%**（107）、变更+未列 **79.84%**（90）。
  引用覆盖率：**31/31 = 100%**（分子口径 = 只算 `status: active` 且 `source.file` 指向旧代码的条目；`unsupported`/`draft` 一律不计入，被排除的 2 条目标态条目在 `spec-source-map.json` 里留见证）。详见 coverage.md §5.2/§5.3。

## 1. §5 的三条纪律（原文，以及本文件怎么落地）

| # | 纪律（REWRITE-METRICS §5） | 本文件的落地形式 |
|---|---|---|
| 1 | 只有 `env.json` **完全匹配**时才比较数值；环境变了必须重采基线并标注（否则「回归」其实是换机器了） | 指纹哈希 + [`baseline/check-env.mjs`](../../baseline/check-env.mjs)。它重采当前环境事实、与 `env.json` 的 `comparability.must_match` 逐项比对并重算哈希：**退出码 0 才允许相除**。`commit` 故意只作 provenance（见 §2 的口径选择） |
| 2 | 基线重采必须**由人发起并记录原因**（不允许 CI 自动重采——那等于自动抹平回归） | 本仓库没有任何脚本会自动改写 `perf-baseline.json` / `env.json`；重采必须在 `baseline/` 里追加一条「重采记录」（时间、原因、旧值→新值、指纹差异） |
| 3 | 阶段 3 删旧实现**之前**必须完成冻结；冻结缺失则 D1–D3 降级为「仅记录，不阻断」并在报告里标 `degraded` | **本次已完成冻结**（阶段 0，早于阶段 3），故 `perf-baseline.json` 里 `degraded: false`。若这两份 JSON 在阶段 3 前丢失/未落盘，消费方必须把 D1–D3 标 `degraded` 并停止阻断 |

## 2. 环境指纹摘要

| 项 | 值 |
|---|---|
| OS | Microsoft Windows 11 专业版 · 10.0.26200（build 26200）· 64 位 |
| 平台 / 架构 | `win32` / `x64` |
| CPU | Intel(R) Core(TM) i7-7500U @ 2.70GHz（**2 物理核 / 4 逻辑核**，单路） |
| 内存 | 21,370,212,352 字节（19.9 GiB，物理总量） |
| Node | **v24.21.0**（V8 13.6.233.17-node.53） |
| pnpm | 11.7.0 |
| 时区 | `China Standard Time`（UTC+08:00） |
| 仓库 | `main` @ `157c35fa72303d7c561243415c9c40a137749644` |
| 运行时可执行文件 | 本机**没有全局 node/pnpm**，必须用 DSH 内置运行时（绝对路径见 `env.json.runtime`） |
| 宿主版本（报告里记的） | `unknown`（插件解析不到宿主版本，与既有 `baseline/README.md` 的记载一致） |

**指纹哈希**：`sha256 = 8a2a74f575fad17d4bd71307516935fb92cd802158f15cd9e95c40ad8d6d4899`，算法与规范化方式写在 `env.json.fingerprint`，可由文件里的 `canonical` 对象逐字节重算（已实测重算一致）。

**一处必须写明口径选择**：`commit` **不**参与 `must_match`。D1–D3 比的是机器与运行时；若要求 commit 相同，则每提交一次基线就作废，指标会永久 `degraded`。commit 只作**出处**记录。反之，OS build、CPU 型号与核数、内存容量、Node/pnpm/V8 版本、时区**必须**一致——它们会直接改变墙钟与 RSS。

## 3. 复跑步骤（逐条可复制）

设：

```powershell
$REPO = 'C:\Users\19059\Documents\deepseek-harness\default-workspace\dsh-testkit'
$NODE = 'C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$PNPM = 'C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
Set-Location $REPO
```

### 3.0 前置：把 node 放回 PATH（否则 gate 必红，且是环境红不是仓库红）

```powershell
$env:PATH = (Split-Path $NODE) + ';' + $env:PATH
```

> 实测：不设 PATH 时 `pnpm run gate` 在 2.005s 处退出码 1，原因是脚本里的 `node -e` 报
> `'node' is not recognized`。原始日志：`baseline/gate-attempt1-node-not-on-path.log`。

### 3.1 先判指纹（这一步不通过就不要看数值）

```powershell
& $NODE baseline/check-env.mjs      # 退出码 0 = 可比；1 = 必须重采基线
```

### 3.2 D2：官方全套读数（落原始日志）

```powershell
& cmd.exe /c "`"$NODE`" `"$PNPM`" run gate >> baseline/gate-rewrite-stage0.log 2>&1"
$LASTEXITCODE
```

> 交付物全部落盘后，用**同一条命令**再跑一次做确认（证明新增 `baseline/**` 与 `spec/metrics/**` 不会让 gate 变红）：
> ```powershell
> & cmd.exe /c "`"$NODE`" `"$PNPM`" run gate >> baseline/gate-rewrite-stage0-confirm.log 2>&1"
> ```
> 确认运行：**退出码 0**，墙钟 **144.399s**，通过数与首轮完全一致（65/65、733/733、18+8/26）。
> 它比首轮慢 1.98 倍，原因是**并发争用**——这正是 D2 离散度的来源，见 §4 与 §7。

### 3.3 D2 分解：逐阶段墙钟（解析 `package.json#scripts.gate` 真源，不复制链条）

```powershell
& $NODE baseline/run-gate-stages.mjs     # → baseline/gate-stages.json / gate-stages.log
```

### 3.4 D1：单用例执行时间（N=7 取中位数）

```powershell
& $NODE baseline/measure-d1.mjs 7        # → baseline/d1-samples.json / d1-samples.log
# 单条原始命令（就是被测命令本身）：
& $NODE bin/dsh-testkit.mjs run --only TK-0001 --json
```

### 3.5 D3：进程级 RSS 采样（两个工作负载 + 一个补充读数）

```powershell
# 主读数：契约轨 + 主套件在单进程里跑完
& powershell -NoProfile -ExecutionPolicy Bypass -Command "& '$REPO\baseline\sample-rss.ps1' -NodePath '$NODE' -RepoRoot '$REPO' -Label main-suite -OutJson 'baseline/rss-main-suite.json' -TargetArgs @('--test','--test-isolation=none','--test-concurrency=1','tests/contracts/*.test.mjs','tests/*.test.mjs') -IntervalMs 100"

# 补充：单用例 / 全量导出场景
& powershell -NoProfile -ExecutionPolicy Bypass -Command "& '$REPO\baseline\sample-rss.ps1' -NodePath '$NODE' -RepoRoot '$REPO' -Label single-case-tk0001 -OutJson 'baseline/rss-single-case.json' -TargetArgs @('bin/dsh-testkit.mjs','run','--only','TK-0001','--json') -IntervalMs 100"
& powershell -NoProfile -ExecutionPolicy Bypass -Command "& '$REPO\baseline\sample-rss.ps1' -NodePath '$NODE' -RepoRoot '$REPO' -Label scenario-suite -OutJson 'baseline/rss-scenario-suite.json' -TargetArgs @('--test','--test-isolation=none','export/scenarios.test.mjs') -IntervalMs 100"
```

> `sample-rss.ps1` 是**纯 ASCII** 的，这是刻意的：本机 harness 是 PowerShell **5.1**（ACP=936），
> 无 BOM 的 `.ps1` 里写中文会被按 ANSI 解码成乱码，而本仓编码守卫又禁止给脚本加 BOM
> （见 [WINDOWS-ENCODING.md](../../docs/WINDOWS-ENCODING.md)）。中文说明留在本文件里。

### 3.6 B1：旧代码分支覆盖率

见 [coverage.md](coverage.md)（复跑命令与真实读数都在那里）。

## 4. 读数表

### D1 — 单用例执行时间（`TK-0001`，`kind=tool`，`cost=none`）

| 项 | 值 |
|---|---|
| 中位数（**冻结值**） | **453.935 ms** |
| 均值 | 475.333 ms |
| 最小 / 最大 | 400.333 ms / 679.333 ms |
| 样本数 | 7 |
| 预热 | 无 |
| 含冷启动 | 是（每条都是全新进程） |
| 7 次原始读数 | 679.333 · 400.333 · 409.353 · 497.229 · 470.493 · 453.935 · 416.652 ms |
| 7 次是否都 passed=1 | 是（每次解析 `--json` 的 `totals` 确认） |
| 离散度 | max/min = 1.697；第 1 次偏高是首轮冷启动形态 |

### D2 — 全套执行时间（`pnpm run gate`）

| 读数 | 值 | 口径差别 |
|---|---:|---|
| **官方全程（冻结值）** | **80.497 s** | 单次 `pnpm run gate`，退出码 0，含 pnpm/壳开销 |
| 逐阶段独立 spawn 求和 | 72.807 s | 同一条链条按 ` && ` 切段后逐段计时求和（20/20 段 exit=0） |
| 确认运行（交付物全部落盘后） | 144.399 s | 同一口径的第三次；退出码 0，通过数与首轮**完全一致** |
| **极差（max/min）** | **1.9834** | 144.399 / 72.807 |
| 三次的中位数 | **80.497 s** | 即冻结值 |

> ⚠️ **这是本文件最重要的一条警告**：三次「全套」读数的极差是 **1.98 倍**，而 D2 的门槛是 ≤1.15。
> 它**不是普通的测量噪声，是 CPU 争用**：本机只有 2 物理核 / 4 逻辑核，第三轮运行时阶段 0 的其他成员
> 正在并发跑自己的 node 进程。证据是**三次的通过数完全一致**（733/733、65/65、18+8/26），
> 变的只有墙钟——即「结果没变，只是被抢了 CPU」。
>
> 后果：**在负载不受控的环境下，同一份代码会被判成 1.98 倍回归。** 因此冻结值取 80.497s（它同时是三次的中位数），
> 但阶段 1 之后要用 D2 守 15%，必须先定义「**空载 + 同口径 + N≥3 取中位数**」的采集协议。

### D3 — 内存峰值（进程级 RSS 采样）

| 读数 | 峰值 | 采样点 | 工作负载 | 退出码 |
|---|---:|---:|---|---|
| **主读数（冻结值）** | **252.566 MiB** | 469 | 契约轨 + 主套件**单进程**跑完（798 tests / 798 pass / 0 fail，53.913s） | 0 |
| 单用例 `TK-0001` | 75.426 MiB | 5 | 与 D1 完全相同的命令（全新进程） | 0 |
| 全量导出场景 | 70.645 MiB | 6 | 26 条（18 通过 / 8 跳过），单进程 | 0 |

## 5. 冻结时的质量门（gate）与各阶段耗时

`pnpm run gate` **退出码 0**（2026-10-11 00:02:12 结束，墙钟 80.497s）。原始日志：[`baseline/gate-rewrite-stage0.log`](../../baseline/gate-rewrite-stage0.log)。

| 轨 | 结果 |
|---|---|
| 契约轨 `tests/contracts/*.test.mjs` | **65 tests / 65 pass / 0 fail / 0 skip**（1474.33ms） |
| 主套件 `tests/*.test.mjs` | **733 tests / 733 pass / 0 fail / 0 skip**（57,718.00ms） |
| 导出轨 `export/scenarios.test.mjs` | **26 tests / 18 pass / 8 skip / 0 fail**（1502.69ms） |
| 场景导出 | 可用 39 条 → 导出 26 条（7 条 `fixture` 场景由 gate 默认排除） |
| 守卫 | 12 个全绿（编码守卫扫 309 个文本文件） |

> 8 条 skipped 全部是**「宿主缺少能力」的如实降级**（`subprocess` / `fs` / `sessions` / `compaction`），
> 与既有 `baseline/README.md` 的记载一致，**不是失败**。

**确认运行（本次交付物全部落盘之后）**：`pnpm run gate` 再次**退出码 0**，日志
[`baseline/gate-rewrite-stage0-confirm.log`](../../baseline/gate-rewrite-stage0-confirm.log)。
它证明本次新增的 `baseline/**`（含 `.json` / `.mjs` / `.ps1` / `.txt`）与 `spec/metrics/**`（`.md`）
**不会让既有 gate 变红**：编码守卫（扫全部文本文件、要求 UTF-8 无 BOM）、文档守卫、12 个静态守卫、
契约轨、主套件、导出轨全部通过，通过数与首轮逐项一致。唯一变的是墙钟（80.497s → 144.399s，
主套件 `duration_ms` 57,718 → 114,080），原因见 §4 的争用分析。

逐阶段墙钟（来自 `baseline/gate-stages.json`，同一条链条的第二次独立执行）：

| # | 阶段 | 墙钟 ms | 退出码 |
|---:|---|---:|---:|
| 01 | 清 `lib/` | 213 | 0 |
| 02 | `tsc -p tsconfig.json` | 5,913 | 0 |
| 03 | `scripts/build-client.mjs` | 149 | 0 |
| 04 | `verify-cases` | 467 | 0 |
| 05 | `verify-docs` | 235 | 0 |
| 06 | `check-encoding` | 197 | 0 |
| 07 | `check-adapter-boundary` | 217 | 0 |
| 08 | `check-pack-files` | 94 | 0 |
| 09 | `check-git-installable` | 96 | 0 |
| 10 | `verify-fixtures` | 345 | 0 |
| 11 | `verify-registry` | 561 | 0 |
| 12 | `check-bundle-patch` | 236 | 0 |
| 13 | `check-secrets` | 695 | 0 |
| 14 | `check-lockfile` | 241 | 0 |
| 15 | `check-ci-hardening` | 181 | 0 |
| 16 | 契约轨 | 1,212 | 0 |
| 17 | 主套件 | 58,568 | 0 |
| 18 | `export-scenarios` | 324 | 0 |
| 19 | 导出轨 | 901 | 0 |
| 20 | `tsc -p tsconfig.client.json --noEmit` | 1,940 | 0 |
| | **合计** | **72,807** | **0** |

主套件占全套的 **80%**（58.6s / 72.8s）——D2 的回归几乎只可能来自测试套件本身，而不是守卫。

## 6. 采样口径与假设（Surface Assumptions）

这些假设**改变了数值本身**，消费方必须知道：

1. **D1 的代表用例是人选的，不是抽样的。** 选 `TK-0001` 的理由：它覆盖最核心的 `tool` driver → 断言 → 取证链路，`cost=none`、纯离线、无外部依赖、确定性最高。**它不是随机样本**，因此 D1 衡量的是「一条代表性用例的成本」，不是「平均用例成本」。
2. **每条 D1 运行都是全新进程，含冷启动，且不预热。** 预热会把冷启动藏起来，而冷启动正是单用例成本的一部分。若阶段 1 改用常驻进程基准（如 criterion），**口径必须显式声明并重采**。
3. **D1 只取中位数。** 7 个样本对「比例」类判断的分辨率上限是 1/7 ≈ 14%；对「中位数」这类位置统计量好得多，但仍不能用来守 1% 级的变化。
4. **D2 的「全套」= `package.json#scripts.gate` 的完整链条**，也就是 README 自述的唯一质量门入口。它包含 tsc、12 个守卫、契约轨、主套件、export 与 client typecheck——因此 D2 是**构建 + 静态守卫 + 测试**的混合时间，不是纯场景执行时间。
5. **D3 的工作负载必须先钉住。** 同一个 Node 进程在单用例与全套之间峰值差 **3.5 倍**（75.4 vs 252.6 MiB）。本文件把主读数定为 `main_suite_single_process`。
6. **D3 用了 `--test-isolation=none`。** Node 测试运行器默认把每个测试文件派到子进程，父进程 RSS 不代表工作负载；`none` 让工作真正落在被测进程里。代价是：它与 gate 的执行模型**不同**，这是为得到「单进程 RSS」这个可定义量而做的显式取舍。
7. **约 70 MiB 是 Node 运行时地板。** 单用例（75.4）与场景套件（70.6）都贴着地板，对实现变化几乎没有判别力——只有主读数真正反映分配量。
8. **全部读数是墙钟，不是 CPU 时间。** 本机只有 2 物理核 / 4 逻辑核，且 harness 本身在跑；tsc 与 `node --test` 阶段对系统负载敏感。
9. **`PeakWorkingSet64`（内核记账）只在轮询点被观测到**，退出前最后 <100ms 的峰值不可见。本次采样值与内核峰值（取 max 后）一致，但这不保证下次也一致。

## 7. 已知限制与给后续阶段的建议

1. **D2 的三次读数极差 1.98 倍**（80.497 / 72.807 / 144.399），主因是**CPU 争用**而不是测量噪声（三次通过数完全一致）。要守住 15% 门槛，必须先定「空载 + 同口径 + N≥3 取中位数」的协议，否则 D2 会周期性假红/假绿——同一份代码已经实测被判成 1.98 倍。
2. **D3 换工具必须重采。** 若 Rust 侧改用 `dhat`（堆分配口径），**不能**直接与本文的 RSS 相除——RSS 含运行时与内存映射，`dhat` 只记堆。REWRITE-METRICS §5 允许 `dhat` 或 RSS 采样，但**两者之间不可换算**。
3. **绝对数值不可移植。** 只有「同指纹下的比值」有意义；换机器必须重采并记录原因（纪律 2）。
4. **采集过程本身要留痕。** 本次有两条环境事故（PATH 缺 node、采集脚本自己写出 BOM 文件），都如实留在 `perf-baseline.json.gate_run_at_freeze.environment_incidents` 与对应日志里——第二条恰好是编码守卫的一次真实负向证明。
5. `baseline/*.log` 被 `.gitignore` 的 `*.log` 规则排除，**不入库**（与既有 `baseline/README.md` 的记载一致）；入库的是 `*.json` 与 `*.md`。数字与结论都已抄进本文件与 JSON。

## 8. 本次产出的文件清单

| 文件 | 内容 | 入库 |
|---|---|---|
| `baseline/perf-baseline.json` | D1/D2/D3 冻结值、方法、样本数、可复跑命令、门槛、离散度分析 | ✅ |
| `baseline/env.json` | 环境指纹 + 可比性规则 + 指纹哈希 | ✅ |
| `spec/metrics/baseline.md` | 本文件：复跑步骤、读数表、口径与纪律 | ✅ |
| `spec/metrics/coverage.md` | B1 旧代码分支覆盖率：三个口径的读数、覆盖映射、阶段 0 判定与两条路径 | ✅ |
| `baseline/gate-rewrite-stage0.log` | gate 原始输出（退出码 0，墙钟 80.497s） | ❌ `*.log` 忽略 |
| `baseline/gate-rewrite-stage0-confirm.log` | 交付物全部落盘后的确认运行（退出码 0，墙钟 144.399s，证明新增文件不破坏 gate） | ❌ |
| `baseline/gate-attempt1-node-not-on-path.log` | 第 1 次失败（环境：node 不在 PATH） | ❌ |
| `baseline/gate-stages.json` / `.log` | 逐阶段墙钟分解（20 段，全部 exit 0） | ✅ / ❌ |
| `baseline/d1-samples.json` / `.log` | D1 逐次原始读数（7 次） | ✅ / ❌ |
| `baseline/rss-main-suite.json` / `rss-single-case.json` / `rss-scenario-suite.json` | D3 三个工作负载的读数 | ✅ |
| `baseline/rss-*.log` / `rss-*.err.log` | D3 被测进程的原始输出（可核对 798 / 26 / 1 的通过数） | ❌ |
| `baseline/coverage-stage0-src-ts-only.log` | B1 全旧代码口径原始报告（**修正前**，缺陷见 coverage.md §4.5） | ❌ |
| `baseline/coverage-stage0-all-src-fixed.log` | B1 全旧代码口径（**修正后**，107 行） | ❌ |
| `baseline/coverage-stage0-change-final.log` | B1 **最终判定口径**原始报告（31 行） | ❌ |
| `baseline/coverage-stage0-change-1-2-only.log` / `-change-without-ruling3.log` / `-change-final-plus-cli.log` | B1 补全前 / 含 types.ts / 含 cli 三个口径 | ❌ |
| `baseline/coverage-change-scope-run1.log` / `-run2.log` | 最终数字两次运行的完整 stdout（81.33 / 81.36） | ❌ |
| `baseline/coverage-stage0-change-scope.log` / `change-plus-unlisted.log` | B1 变更模块口径（30 行）与敏感性口径（90 行） | ❌ |
| `baseline/coverage-stage0-combined.log` / `coverage-stage0-spec-scope.log` | B1 对照口径（含 esbuild 产物）与 spec 声明口径 | ❌ |
| `baseline/coverage-stage0-src-only.log` | 空集合却报 100% 的现场（**负向证据**） | ❌ |
| `baseline/coverage-summary.json` | 早期三份报告的解析结果（含标为 `valid:false` 的无效 run） | ✅ |
| `baseline/coverage-change-scope.json` | B1 七个口径（含已撤销的裁决五口径）的读数与逐文件 | ✅ |
| `baseline/coverage-final-summary.json` | B1 判定口径的 6 次读数、中位数、极差与逐次门槛判定 | ✅ |
| `baseline/coverage-final-repeat.json` | `--repeat-final` 复采记录 | ✅ |
| `baseline/coverage-change-scope-run1..4.log` | 四次完整运行的 stdout（判定口径读数的原始证据） | ❌ |
| `baseline/design-scope.json` | `REWRITE-DESIGN.md` §1.2 逐行解析 + change/keep/unlisted 三分类 | ✅ |
| `baseline/coverage-spec-scope.json` | spec 声明口径读数 + 逐文件 | ✅ |
| `baseline/spec-source-map.json` | spec 快照（18 文件 / 48 条目）+ `source.file` 直方图 | ✅ |
| `baseline/spec-vs-design.json` | 引用覆盖率（按三分类）+ 缺条目的变更模块点名 + 15 弱文件×分类 | ✅ |
| `baseline/coverage-weakest.md` | 分支最低的 15 个 src 文件（表） | ✅ |
| `baseline/run-gate-stages.mjs` | 逐阶段计时（解析 `package.json#scripts.gate` 真源） | ✅ |
| `baseline/measure-d1.mjs` | D1 测量（N≥5 取中位数 + 每次校验 passed=1） | ✅ |
| `baseline/sample-rss.ps1` | D3 进程级 RSS 采样器（**纯 ASCII**，PS 5.1 安全） | ✅ |
| `baseline/parse-coverage.mjs` | 覆盖率报告解析器（含**空集合守卫**：`files: []` ⇒ 退出 1） | ✅ |
| `baseline/selftest-parse-coverage.mjs` | 解析器的负向证明 + 正向对照 | ✅ |
| `baseline/spec-source-map.mjs` | spec ↔ 旧代码覆盖映射工具 | ✅ |
| `baseline/coverage-spec-scope.mjs` | spec 声明口径测量工具（排除项自动推导） | ✅ |
| `baseline/coverage-change-scope.mjs` | §1.2 变更模块口径测量工具（逐行解析真源 + 分类自检） | ✅ |
| `baseline/spec-vs-design.mjs` | spec × 设计分类求交工具（引用覆盖率 + 点名） | ✅ |
| `baseline/check-env.mjs` | 环境指纹比对器（`must_match` + 哈希；0 = 可比较） | ✅ |
| `baseline/git-status-before.txt` | 采集开始前的 `git status` 快照（只读性证明） | ✅ |
