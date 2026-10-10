# spec/ —— 行为规格（重构期唯一历史）

> **状态**：阶段 0（行为提取）的产物目录。依据 [RFC 0001](../docs/rfc/0001-rust-core-full-rewrite.md) 决定 4、
> [REWRITE-DESIGN.md](../docs/REWRITE-DESIGN.md) §1.3、[REWRITE-METRICS.md](../docs/REWRITE-METRICS.md) §3。
>
> **本目录不含实现代码。** 它是"旧实现的可观察行为"的**声明式记录**，是新实现的行为依据与阶段 2 对拍的输入。

---

## 1. 为什么需要它

完全重构（RFC 决定 4）的终点是**删除旧实现**（`src/**` 27,946 行）。
删除的前提是"旧行为的全部可观察部分已被记录"。**spec 就是那份记录**——阶段 3 之后，它是唯一还能回答
"这一版为什么这样判"的东西。

因此有一条硬纪律：

> **凡是新实现要保留的行为，必须先在 spec 里有条目；spec 里没有的行为，不承诺保留。**

## 2. 目录布局

```text
spec/
  README.md                   # 本文件：格式与纪律（Lead 持有，不并行修改）
  behaviors/
    kinds/<kind>.md           # 12 份：一个 kind 一份，front-matter 内 atoms 数组承载该 kind 的全部原子
    engine/<module>.md        # 7 份：runner / assert / fixture / isolation / report / policy / surfaces
  contracts/
    exit-codes.yaml           # 退出码 0–8 的语义与来源（RFC §3.3）
    surfaces.yaml             # 工具 / CLI / kind / HTTP 路由的注册面计数（设计 §10.8 的"真源"）
    reconcile-fields.yaml     # run.json 逐字段等价关系（设计 §9.3）—— 指标 A3 的分母
    capabilities.yaml         # HostCapability 枚举（指标 B2）
    versions.yaml             # DSH 版本覆盖（B3）
    environments.yaml         # 环境组合覆盖（B4）
    approval-paths.yaml       # 交互/审批路径覆盖（B5）
  metrics/
    baseline.md               # D1–D3 冻结基线的复跑步骤、读数与环境指纹（指标 D1–D3、§5）
    coverage.md               # B1 旧代码分支覆盖率的测量方式与读数
  schema/
    behavior.schema.json      # front-matter 的机器校验格式（格式真源）
    validate-spec.mjs         # 守卫：校验 front-matter + 追溯可落地 + 与设计 §2.2 逐项对齐
  vectors/
    jcs/*.json                # JCS（RFC 8785）测试向量：输入 + 期望规范化字节（Q10）
```

## 3. 行为规格的格式（`behaviors/**/*.md`）

**切分纪律：文件 = 模块，条目 = 原子行为（BaseTool 级）。**

- 一份文件对应**一个模块**（一个 kind，或一个 engine 模块）。
- 该模块的全部**原子行为**放在 front-matter 的 `atomics` 数组里，每个元素是一条独立条目。
- 正文承载人读内容，按 `## <atomic>` 分节展开。

> 为什么不是"每条原子一份文件"或"一份文件多个 front-matter 块"：
> 前者会让 12 个 kind 碎成 28 份文件、engine 侧再碎一层，模块级信息（能力、上下文、成本档）重复 28 次；
> 后者不是合法 Markdown front-matter（解析器只认第一块）。**模块级信息放文件级，原子级信息放条目级**，两处不重复。

```markdown
---
# ---- 文件级（模块）----
domain: kinds                      # kinds | engine
module: file                       # kind 名 或 engine 模块名
revision: 1                         # 本文件的行为规格版本；行为变了才 +1

# ---- 原子级（BaseTool）----
atomics:
  - id: BEH-KIND-FILE-001          # 全局唯一；BEH-<KIND|ENGINE>-<模块>-<三位序号>
    title: read-file 读取已存在的文件  # 一句话
    atomic: read-file              # BaseTool 原子名，对齐 REWRITE-DESIGN §2.2
    status: draft                  # draft | active | unsupported

    source:                        # 追溯（必填，不允许猜）
      file: src/kinds/file.ts
      lines: "120-168"
      symbols: ["runFileRead"]     # 必须能在 source.file 中检索到
      tests: ["tests/file-driver.test.mjs"]   # 找不到就写 [] 并在正文说明

    capabilities: []               # 需要的 HostCapability；[] = 无要求
    availableIn: Any               # Any | RequiresAgentContext | IsolatedSessionOnly | [多个]
    costTier: none                 # none | low | high
    parallel: exclusive            # safe | exclusive

    observable:                    # 可判定；then 必须能用既有 17 个断言词表达
      - given: "文件存在且可读"
        when: "act: {kind: file, op: read, path: <tmp>/a.txt}"
        then: "返回值含 { content, bytes }，content 逐字等于文件内容"
        verdict: pass
      - given: "文件不存在"
        when: "同上"
        then: "抛 FsError(ENOENT)，errno=ENOENT"
        verdict: fail

    cleanup: none                  # none | registered（登记 disposer，逆序释放）

    nonDeterministic:              # 指标 C3：必须显式，否则阶段 2 对拍失败无法归因
      - field: "durationMs"
        reason: "挂钟时间"
        reconcile: ignore          # ignore | normalize:<规则名> | tolerance:1e-9

    equivalence:                   # 键引用 contracts/reconcile-fields.yaml 的规则名
      verdict: exact
      error: normalize-path
---

## read-file

（人读：这条行为到底做什么，边界在哪，为什么这样。）

### 边界与已知缺陷

（旧实现里已知的、**不打算保留**的行为必须写在这里，并标 `status: unsupported` 或另起条目。）
```

### 3.1 六条填写纪律

1. **追溯必填且不可猜。** `source.file` 必须真实存在，`symbols` 必须能在其中检索到；`tests` 引用必须能落到真实文件。
   找不到对应测试时写 `tests: []` 并在正文说明"无既有测试覆盖"——**这本身就是阶段 0 的重要发现**。
2. **原子性。** 一条 `atomic` 对应一个 BaseTool，不可再分。若一条行为能独立 pass/fail，它就是一条独立条目。
   同一 kind 的原子集合必须与 [REWRITE-DESIGN.md](../docs/REWRITE-DESIGN.md) §2.2 的映射表**逐项相等**（不多不少，由 `validate-spec.mjs` 机械校验）。
3. **`observable` 必须可判定。** `then` 里的判定必须能被 17 个既有断言词（`is`/`isNot`/`contains`/`matches`/
   `atLeast`/`throws`…，见 [SCENARIO-SPEC.md](../docs/SCENARIO-SPEC.md)）表达。不能表达的，说明它还不是可观察行为。
4. **非确定性必须显式。** 任何表里没写的非确定字段，都会在阶段 2 表现为"对拍失败但归因不明"。
5. **不复制实现。** 正文描述**行为**，不粘贴旧代码实现（那是阶段 2 的对照物，不是 spec 的职责）。
6. **发现即记录。** 提取过程中发现的旧实现缺陷、无测试覆盖的原子、与设计文档矛盾的事实，
   必须写进对应条目的正文或「边界与已知缺陷」节，并汇总到交付报告——**阶段 0 的价值一半在这里**。
7. **`id` 一经分配即稳定**：不随语义顺序重排、不复用空号、不因新增条目而改号。
   条目在容器里的**顺序由 `atomics` 数组的元素顺序表达**，不由 id 表达。若某条内容被证伪（例如设计文档勘误后指控不再成立），
   把它改写为**「沿革记录」**并保留证据行号，而不是删除——"这个清单曾经与源码不一致"本身是重构资产。

## 4. 覆盖维度与指标对应

| 指标（REWRITE-METRICS） | 门槛 | 由谁提供 |
|---|---|---|
| B1 旧代码分支覆盖率 | ≥ 90% | `metrics/coverage.md` + 覆盖率读数 |
| B2 能力覆盖 | 100% | `contracts/capabilities.yaml` |
| B3 版本覆盖 | 100% | `contracts/versions.yaml` |
| B4 环境覆盖 | 100% | `contracts/environments.yaml` |
| B5 审批路径覆盖 | 100% | `contracts/approval-paths.yaml` |
| A3 对拍字段覆盖率 | 100% | `contracts/reconcile-fields.yaml`（分母 = run-report schema 叶子字段） |
| D1–D3 冻结基线 | 冻结数值 | `metrics/baseline.md` + `baseline/perf-baseline.json` + `baseline/env.json` |
| C3 非确定性字段清单 | 100% | 各原子条目的 `nonDeterministic` |

## 5. 阶段 0 的退出条件

1. 12 个 kind 全部有条目，且每个 kind 的 `atomics` 与 [REWRITE-DESIGN.md](../docs/REWRITE-DESIGN.md) §2.2 的映射表**逐项相等**。
2. 7 个 engine 模块（runner / assert / fixture / isolation / report / policy / surfaces）全部有条目。
3. `contracts/` 六个清单齐备，且**每个清单都能机械复算**（有对应的枚举脚本或可复跑命令）。
4. `metrics/baseline.md` 的读数**可复跑**，`baseline/env.json` 记录环境指纹。
5. `node spec/schema/validate-spec.mjs` 退出码 0（错误 0 条；警告允许存在但必须被看见）。
6. `pnpm run verify:docs` 与既有 `pnpm run gate` **不因新增 spec/ 而变红**（spec 只增不改既有资产）。

## 6. 禁止事项

- ❌ 在 spec/ 里写实现代码、改 `src/**`、改 `cases/**`。
- ❌ 把"我推测的行为"写成 `status: active`——没有源码/测试支撑的一律 `draft` 并在正文标注推测依据。
- ❌ 为了凑覆盖率而写空条目；空条目按"未覆盖"计。
- ❌ 各写各的字段名。字段名以 `schema/behavior.schema.json` 为唯一真源，`validate-spec.mjs` 会据此判错。
