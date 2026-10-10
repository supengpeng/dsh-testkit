# touchstone 融合（三阶段适配器）

> 实现：`src/touchstone/{export,import,webhook}.ts`｜回归网：`tests/touchstone.test.mjs`
> 数据流向与隐私约定见 [SECURITY.md](../SECURITY.md) §4.4；场景规范见 [SCENARIO-SPEC.md](SCENARIO-SPEC.md)；
> 提炼闸门见 [ISSUE-PIPELINE.md](ISSUE-PIPELINE.md)。

本文是**接口说明书**：写清楚本仓与 touchstone（Python 项目 `touchstone-dsh`）之间交换什么、
凭什么判定、以及**什么时候停下来改人工**。阅读顺序建议：§1「不做什么」→ §2 协议表 → §6 验收标准。

---

## 1. 不做什么（四条硬边界，先读这个）

| # | 不做 | 为什么 |
|---|---|---|
| ① | **不合并代码库** | 两个项目语言、发布节奏、依赖树都不同。合并意味着对方的每个不兼容改动都变成我们的构建红灯；适配器只交换**文件**，各自独立演进 |
| ② | **不共享数据库** | 我们是文件产物（`runs/`、`bug_report/`、`proposals/`），它是 SQLite。共享库会把"谁能改 schema"变成跨项目的隐式契约 |
| ③ | **不嵌入对方运行时** | 不 import 对方的包、不调它的 Python、不要求它在场。本仓永远可以单独构建与自测 |
| ④ | **不做 API 稳定承诺** | 本产物的**结构**不是公开 API：改字段、改目录名、改 severity 规则都可能发生。跨项目消费方必须容忍字段缺失（读到不认识的东西就忽略），不要据此写死集成 |

推论（容易被忽略的一条）：**本仓的核心面不为它改**。三阶段通道全部落在 `src/touchstone/**`，
不接线到 `src/tools.ts` / `src/commands.ts` / `src/index.ts`——没有真实用户在用的面，不新增。

---

## 2. 三通道协议表

| 通道 | 方向 | 本仓入口 | 触发方式 | 搬运的东西 | 对方需要做的最少动作 |
|---|---|---|---|---|---|
| **输入** | touchstone → 本仓 | `src/touchstone/import.ts` | 人工运行 / 调用 `parseCaseMd` + `proposeCase` | `case.md` → 场景 YAML **草稿** | 提供 `case.md`（标题 / 症状 / 期望 / 实际 / 复现步骤 / 来源链接） |
| **输出** | 本仓 → touchstone | `src/touchstone/export.ts` | 人工运行 / 调用 `exportBugReports` | `runs/<RUN-ID>/run.json` → `bug_report/<CASE-ID>/**` | 读文件即可；不需要装 Node |
| **回环** | 双向 | `src/touchstone/webhook.ts` | `POST /on_fix_complete` | 修复完成事件 → worktree 隔离复跑 → 结果回传 | 发一个 HTTP POST；可选一个 callback URL |

三条通道**互不依赖**：只做输出（阶段一）不需要 import 或 webhook 在场。

### 2.1 输入通道：`case.md` → 草稿

解析是**容错**的（缺段不报错、多出来的段不丢）：

```md
---
title: 保留设备名守卫必须末端直判     # 也可用正文一级标题 `# ...`
kind: shell                          # 可选；必须是本仓已注册的 kind
severity: high                       # 可选
tags: [windows, device-name]         # 可选
owner: "@alice"                      # 可选
source: https://github.com/…/issues/57   # 或正文里第一个 issue 链接
steps: […]                           # 可选：已结构化的步骤 → 原样透传
---
## 症状 / 现象
## 期望
## 实际
## 复现步骤
## 来源
```

映射规则（**结构映射，不做语义推断**）：

| `case.md` 里的东西 | 落到本仓哪个字段 |
|---|---|
| `title` / 一级标题 | `title`（> 60 字截断并留提醒——这是 `validateScenario` 的硬规则） |
| `kind` | `kind`；缺失或非法 → `shell` **占位** + 提醒（干预点必须人工确认） |
| `severity` / `tags` / `owner` | 同名可选字段（非法值忽略并提醒） |
| issue 链接 | `source.issue`（没有链接时闸门会因"不可溯源"直接拦下） |
| 症状 / 期望 / 实际 / 复现步骤 | 拼成 `source.summary`（块标量，给人读） |
| `steps:` / `act` + `expect` | **原样透传** |
| 其它所有内容 | **原样保留成 YAML 注释**（不丢信息，也不假装理解） |

产出的 YAML 恒为 `schema: 1`、`id: TK-0000`（占位）、`status: draft`。

### 2.2 输出通道：`bug_report/` 结构

`outDir` 就是 `bug_report/` 根：

```text
bug_report/<CASE-ID>/report.md            人读：现象 / 期望 vs 实际 / 最小复现 / 判定依据
                   /repro.yaml            可复跑片段（机器读，命令与 report.md 同源）
                   /severity.txt          单行 low|medium|high
                   /evidence/trace.json   该 case 的原始 CaseOutcome
                   /evidence/logs.txt     步骤 / 动作 / 断言 / 释放失败的平铺日志
bug_report/_export-<RUN-ID>.md            本次导出了谁、**没导出谁、为什么**
```

`repro.yaml` 的 `commands` 块**不是**新造的命令：它逐字取自 `src/analysis/repro.ts`
（`CaseOutcome.minimalRepro`，没有时调用同一模块的 `buildMinimalRepro()`）。
一个仓只能有一套复现口径，否则报告里那条命令迟早跑不起来。

### 2.3 回环通道：`POST /on_fix_complete`

请求（`changedFiles` / `caseIds` 至少给一个）：

```json
{
  "changedFiles": ["src/runtime/runner.ts"],
  "caseIds": ["TK-0020"],
  "ref": "HEAD",
  "callbackUrl": "http://127.0.0.1:8899/hook"
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `changedFiles` | 否 | 增量选择的输入（走 `src/selection/**`；不可用则退回全量） |
| `caseIds` | 否 | **本仓扩展**：显式点名要复跑的场景，优先于增量选择 |
| `ref` | 否 | 要检出的 ref，缺省 `HEAD` |
| `callbackUrl` | 否 | 结果回传地址；缺省不回传（结果仍在 HTTP 响应里） |

响应（同步语义：**请求会等到复跑结束**）：

```json
{
  "ok": true,
  "value": {
    "accepted": true,
    "auth": { "mode": "none", "warning": "未配置 token：…只监听 127.0.0.1…" },
    "selection": { "mode": "explicit", "caseIds": ["TK-0020"], "detail": "…" },
    "rerun": {
      "runId": "…", "ref": "HEAD", "worktree": "C:\\…\\tk-xxxx\\wt",
      "worktreeRemoved": true, "nodeModules": "junction",
      "repoStatusBefore": "", "repoStatusAfter": "",
      "totals": { "total": 1, "passed": 1, "failed": 0, "skipped": 0, "errored": 0 },
      "cases": [{ "id": "TK-0020", "verdict": "passed", "durationMs": 517 }],
      "notes": ["已在隔离 worktree 检出 HEAD：…"], "durationMs": 3484
    },
    "callback": { "sent": true, "status": 200 }
  }
}
```

细节与纪律：

* **只监听 `127.0.0.1`**。它不是公网 webhook，也不要当成公网 webhook 用。
* **未配置 `token` 时不鉴权**，但响应里必定带 `auth.mode = "none"` 与警告文案——
  不给 token 却看起来"像是有鉴权"比不鉴权更危险。给了 `token` 则要求
  `Authorization: Bearer <token>` 或 `x-touchstone-token`，否则 401。
* 路由只有 `POST /on_fix_complete`：其它路径 404，非 POST 405，坏 JSON 400。
* 复跑失败返回 **500 + `code: "rerun-failed"` + 原始原因**，且**保证已清理** worktree；
  失败的**下一次请求照常工作**（可重入，有用例钉住）。
* 复跑期间用**默认成本闸门**（`resolvePolicy({})`，`allowModel: false`）：
  回环通道**结构上不可能烧钱**。

---

## 3. severity 规则表（`failureCategory` × 场景 `severity`）

`severity.txt` 只取 `low | medium | high`。判定表：

| failureCategory | 场景 severity | 产出修复任务 | severity.txt | 依据 |
|---|---|---|---|---|
| `product_bug` | high | ✅ | `high` | 被测对象缺陷 × 高严重度 |
| `product_bug` | medium | ✅ | `medium` | 同上 |
| `product_bug` | low | ✅ | `low` | 同上 |
| `product_bug` | 未标注 | ✅ | `medium` | 未知按 medium：既不升级也不忽略 |
| `flaky` | 任意 | ✅ | `low` | 抖动不是确定性缺陷（证据在 `rounds` 里） |
| `env` | 任意 | ❌ | `none` | 换运行条件（预算 / 能力 / 网络）就能得真结论，不是代码修复任务 |
| `case_bug` | 任意 | ❌ | `none` | 是本仓**用例**写错了，动被测代码修不好 |
| `driver_bug` | 任意 | ❌ | `none` | 是本仓**引擎 / 驱动**缺陷，与被测对象无关 |
| 无归因（failed / errored） | high | ✅ | `high` | 保守：没有归因 ≠ 没有缺陷 |
| 无归因（failed / errored） | medium / low / 未标注 | ✅ | 场景值或 `medium` | 同上 |

**导出范围**：只有 `failed` / `errored` 会产出报告。

* `passed` —— 不是 bug，导出等于制造假任务。
* `skipped` —— **没跑过**，不是 bug（原因写在 `skipReason` 里，照抄进索引）。
* 被判 `none` 的 —— **不落目录**（touchstone 拿不到任务就不会去"修"），
  但**必定**出现在 `_export-<RUN-ID>.md` 的「未导出」表里并写明原因。

静默丢弃是被禁止的：看不见的跳过等于假绿。

---

## 4. 停止线（到了就停，别硬做）

| # | 停止线 | 触发后怎么做 | 怎么被守住 |
|---|---|---|---|
| ① | **转换器（`src/touchstone/import.ts`）超过 500 行** | **停止自动转换，改人工转换** | `assertConverterWithinStopLine()` 运行时数源文件行数，超限抛错；用例 `阶段二：转换器 500 行停止线守卫有效` 钉住（它真的拦住过一次本文件自己：548 行 → 压到 469 行） |
| ② | **webhook 调试超过 1 周** | **回退手动触发**：人手动跑复跑（`/testkit run <id>`），回环通道下线 | 无自动守卫，靠这条记录：一周内没打通"修复完成 → 自动复跑 → 结果回传"的闭环，就说明它不值得自动化 |
| ③ | 增量选择模块不可用 | **软失败**：明确写出错误信息 + 退回全量，服务不崩 | 用例 `阶段三：增量选择未就绪时软失败` |
| ④ | `node_modules` 接不进 worktree | 记 `nodeModules: "none" / "failed"` + 说明，**继续跑**（依赖解析仍走主仓 `lib/` 上游） | 响应里的 `nodeModules` 字段 |

停止线①的理由值得写下来：转换器越长，「结构映射」就越滑向「语义推断」，
而推断出来的判据是**猜的判据**。猜错的判据进了回归集会同时制造假红与假绿，
比"这条没进回归集"糟得多。

---

## 5. 阶段三的隔离硬约束（不做这个，阶段三不能上线）

复跑**绝不能**污染场景库（被测主仓）：修复分支里可能带着 agent 中途写坏的临时文件，
直接在主仓跑就会把现场改掉，于是"这条到底修没修好"再也没有可信答案。

每次复跑的动作序列：

1. `git worktree add --detach <scratch>/wt <ref>`（默认 `HEAD`）——干净检出
2. 把主仓 `node_modules` 以 **junction** 接进 worktree
   （Windows：`cmd /c mklink /J`，不需要管理员权限；非 Windows：`symlinkSync`；失败则跳过并说明）
   —— **不在临时目录里重新装依赖**（几分钟 + 版本漂移）
3. 用本仓的 headless 宿主 + runner 跑指定场景：`cwd` 指向 worktree，
   场景数据取 **worktree 里的 `cases/`**
4. **无论成败**都 `git worktree remove --force` + 清掉临时目录（`finally`）

取证：`RerunResult.repoStatusBefore / repoStatusAfter` 就是被测主仓的 `git status --porcelain`。
端到端用例用的是**临时克隆**出来的干净检出，所以判据是"复跑前后都**真的为空**"，
而不是"零新增"；同时额外断言共享主仓里没有留下 `.touchstone-worktrees` 之类的临时目录。

---

## 6. 验收标准（三阶段各自可单独验收）

| 阶段 | 验收 | 命令 / 用例 |
|---|---|---|
| 一 · 输出 | `bug_report/<CASE-ID>/{report.md, repro.yaml, severity.txt, evidence/trace.json, evidence/logs.txt}` 结构完整、可被解析；severity 与规则表逐格一致；未导出的逐条有原因；**不改 touchstone 任何代码** | `阶段一：*`（3 条） |
| 二 · 输入 | 一个 `case.md` 能转成**合法 YAML**（过 `validateScenario`）；`status: draft`、`id: TK-0000`；判据不猜（草稿过不了闸门）；只有人补完判据后才可能落进 `proposals/`，`cases/` 一个字节都不动；500 行守卫有效 | `阶段二：*`（4 条） |
| 三 · 回环 | 端到端：起服务 → 假调用方 POST → **真**在 worktree 里复跑 → 结果回传 → worktree 已清理 → **被测主仓 `git status --porcelain` 为空**；坏 ref 失败后仍可重入；token / 路由 / 方法严格 | `阶段三：*`（6 条） |

一条命令复跑三阶段：

```bash
node scripts/build-lock.mjs            # 串行化编译（多人协作时避免并发 tsc 互踩）
node --test tests/touchstone.test.mjs
node --test "tests/*.test.mjs"         # 全量回归
```

---

## 7. 已知限界（诚实边界）

* **复跑的"被测对象"是场景数据 + 主仓 runner 产物**：worktree 提供干净检出与 `cases/`，
  runner 仍来自主仓 `lib/`（worktree 里没有构建产物，也不该在临时目录里重新编译）。
  所以它验证的是"这批场景现在过不过"，不是"修复分支自己能不能构建"。
* **`repoStatusBefore/After` 是快照，不是锁**：并行有人在写主仓时，两者差异不能全归因给复跑。
  端到端用例因此用干净克隆做判据，对共享主仓只断言"本任务相关条目零新增"。
* **回环通道不隐式触发阶段一导出**：要 `bug_report/` 就把 `run.json` 交给 `exportBugReports`。
  三条通道保持独立，避免隐式耦合（也避免往主仓里写产物污染工作区）。
* **同步语义**：请求会阻塞到复跑结束（本机单通道够用）。并发多请求要靠调用方自己错开。
* **`case.md` 的格式是"容错假设"，不是对方 schema 的镜像**：对方契约还在动，
  所以我们只认上面那几类结构词根；认不出来的内容一律进注释，宁可要人工看一遍。
  这也正是 §1④「不做 API 稳定承诺」的由来。
* **转换器只到"结构合法"为止**：草稿一定过不了闸门的质量预检——那是**设计**，不是缺陷。
