# 已知缺陷台账（阶段 1 期间发现、尚未修复）

> **为什么单独立一份**：这些缺陷都是**在验证别人工作成果的过程中发现的**——它们不在任何人的任务书里，
> 也没有任何测试会红。**如果不记下来，它们会随着对话结束而消失**，然后下一个人重新踩一遍。
>
> 每条必须写清：**证据（可复核的行号/命令）、为什么没有测试发现它、修法、以及它算谁的**。
> 状态：`open`（待修）/ `scheduled`（已排期）/ `fixed`（已修，留档）。

---

## D-1 `step.cleanup.releaseNotes` 对全部 12 个 driver 都是空转（**最严重**）

- **状态**：`open`（属阶段 2 输入）
- **发现者**：`spec-kinds`（task-19，为了判定 `DP-07` 是否可达而去核实现）
- **症状**：`docs/SCENARIO-SPEC.md:342-356` 向场景作者**承诺** `step.cleanup.releaseNotes` 会"在本步结束后释放对应 disposer"，
  但实现里**没有任何 driver 登记过可释放的句柄**，所以它恒为 no-op。
- **证据**：
  1. 正规登记入口 `registerStepDisposer`（`src/isolation/cleanup.ts:60`）**全仓库零调用**——只有它自己定义、`runner.ts:19,775` 消费；
  2. 兼容的裸函数路径（`fixture.note(key, fn)`）在 `src/**` 也零使用（唯二正则命中是 `resource.ts:232,247` 的括号表达式误报）；
  3. 于是 `releaseStepNotes` 永远取不到句柄，而 `cleanup.ts:58` 的语义是"**找不到不报错，只是这一步拆不掉，等场景结束**"——**静默**。
- **为什么没有测试发现它**：因为它是"**承诺了但没人用**"，不是"用了但坏了"。
  12 个 driver 都各自用 `fixture.add(label, value)` 登记资源，从不调 `registerStepDisposer`；
  而 releaseNotes 的静默跳过让**没有任何断言会失败**。`DP-07`（B5 里被判"场景不可达"的那条）只是它的**第一个受害者**。
- **修法（两条，择一或并用）**：
  - (a) 各 driver 的资源登记改走 `registerStepDisposer`，让 `releaseNotes` 真正拿到句柄；
  - (b) `cleanup.ts` 的"找不到就不报错"改成**可观测**（至少进 `releaseNotes` 的诊断输出）——**静默的 no-op 是这条缺陷能藏这么久的根本原因**。
- **归属**：`src/isolation/cleanup.ts` 或 `src/kinds/**` 的登记面。**不在阶段 1 的 Rust 核心范围内**，属阶段 2（driver 侧对拍）输入。

---

## D-2 `pnpm run gate` 不可并发（多 Agent 共享工作目录时的**假红制造机**）

- **状态**：`scheduled`（Lead 将修：检测到并发就显式报错退出）
- **发现者**：`rust-scheduler`（task-18，被假红误导后自行取证）
- **症状**：两个 `pnpm run gate` 并发时，半个测试树报 `ERR_MODULE_NOT_FOUND: lib/...`，
  **错误全部指向别人的测试文件**（`triage` / `ui-driver` / `policy-gate` / `probe`），让人以为"整棵树被谁改坏了"。
- **证据**：
  1. gate 第一步是 `rm -rf lib && tsc -p tsconfig.json`；
  2. 后启动的 gate 会删掉先启动那个**正在被测试读取**的 `lib/`；
  3. `rust-scheduler` 抓到了 PID 7848（01:52:33）与 716（01:54:21）两个并发实例；Lead 自己也抓到过 PID 12748；
  4. **决定性反证**：同一时刻单独跑 `node --test tests/rpc.test.mjs` → **39/39 全绿**、`tsc --noEmit` → **exit 0**，
     即"gate 红"与"代码红"在那段时间是两个不相干的读数。
- **性质（关键）**：**间歇性**，不是必然性——Lead 有一次与 PID 12748 并发却拿到了 `GATE_EXIT=0`。
  **间歇性比必然性危险得多**：必然失败会被立刻修掉；间歇失败会让人**去改本来正确的代码**。
- **修法**：检测到并发就**显式报错退出**（`fail loud`），而不是加锁排队——
  **排队会把"两个人在同时验收"藏起来**，而显式报错让"工作区不支持并发验收"成为当场必须处理的事实。
- **归属**：`package.json` 的 `gate` 脚本 + 新增 `scripts/gate-guard.mjs`。

---

## D-3 测试**硬编码真源**（已修，留档作为教训）

- **状态**：`fixed`（Lead 于 2026-10-11 修）
- **症状**：`cargo test --workspace` 报 2 个失败，**且与当时的 `cargo fmt` 无关**（这一点很容易误判）：
  `crates/reconciler/tests/a3_closure.rs` 钉死了「allowlist 恰好是 `cases[].usage.tokens`」，
  而 task-17 按 Lead 裁决合法地加了 `cases[].trace[]`。
- **根因**：**两条并行工作线，一边改真源（`reconcile-fields.yaml`）、一边钉死真源（测试断言）**。
  更细一层：真源在 YAML 里，测试**复制**了它——**第二处真源必然漂移**。
- **修法**：断言改为**从真源派生**——"not-compared 的集合受 `allowlist_violations()` 约束"（子集），
  而不是"恰好等于某个字面量"；差集断言从 `== STAGE1_SCHEMA_ADDITIONS` 收紧为 `is_empty()`，
  并**保留** `STAGE1_SCHEMA_ADDITIONS` 作为沿革记录（它记着"schema 先变、声明后补"这个真实顺序）。
- **教训（已写进 task-20 的任务书）**：**测试的期望值应从真源读，不要硬编码。** 同一个坑不要踩第二次。

---

## D-4 设计文档 §4.2 的消息集**不闭合**（已修，留档作为"照抄文档"的代价）

- **状态**：`fixed`（Lead 于 2026-10-11 修）
- **两个缺口**：
  - (c) **方法表里有 `wait`，消息集里没有 `Wait` 变体**（Lead 实现 `crates/protocol` 时补了实现、没回填文档）；
  - (d) **消息集里没有任何成功应答（result）变体**，而方法表承诺 9 个方法有返回
    ⇒ 服务端**物理上回不出** `TaskHandle` / `TaskResult` / `TaskStatus`（`frame::write_frame` 只接受 `ProtocolMessage`）。
- **发现者**：(d) 由 `rust-scheduler` 在做 TS 客户端时发现，**其证据链的最后一环把它变成了编译期事实**。
- **为什么值得留档**：Lead 是**照抄设计 §4.2 的那张表**实现的——**文档写错了，实现就跟着错**，
  而"实现能编译"并不构成"契约闭合"的证据。**契约要能被两端同时实现才算闭合。**
- **修法**：`ProtocolMessage` 加 `Result(ResultParams)`、`RpcError` 加可选 `id`；tag 数 14 → **15**（契约测试同步钉住）；
  设计 §4.2 补两处缺口并写明是"实现时暴露的，不是纸面推演"。
- **同类的第三处（`-32007`，已修）**：`register_assertion` / `register_capability` 的**重入必须报错**，
  而 `crates/assertion` 与 `crates/capability` **都已经返回** `AlreadyRegistered`——§4.5 的错误表里
  却没有任何一格对得上：`-32602` 说"参数格式错"、`-32003` 说"**任务**已存在"。已补 `-32007`。
  **落地过程本身是个证据**：加完 Rust 侧变体后，TS 侧 `src/rpc/errors.ts` 的
  `satisfies Record<RpcErrorCode, number>` **当场变成编译错误**——跨语言契约的漏项**不靠人记得**。

---

## D-5 `crates/capability` 的原子性测试是 flaky 的（9 跑 6 红）

- **状态**：`open`（已派回 `rust-capability` 修复中）
- **发现者**：`rust-attest`（task-21，写 CI job 时跑 `cargo test --workspace` 撞到）
- **症状**：`refresh_is_an_atomic_swap_and_never_exposes_a_half_new_snapshot` 失败，断言
  `一次 probe_all 必须拿到全部能力的代次，实际 [1, 1, 1, ...]` —— **刷新尚未可见时就 probe 了**。
- **证据**：9 次运行 **6 次失败**，**含 2 次 `--test-threads=1`** ⇒ 不是同二进制内并发导致，是测试自身的时序假设。
- **为什么比"没测试"更严重**：**它给"原子性已验证"一个假信心。** Lead 在阶段 1 跑 `cargo test --workspace`
  拿到 **375 通过 / 0 失败**并据此判断原子性没问题——**那次很可能是恰好避开了它**。
  而 CI 会因此间歇红，让人去查一个不存在的 bug（与 D-2 的 gate 并发是**同一类伤害**）。
- **修法**：先复现拿失败率（**修之前的数据才是证据**），再判定是 (a) 测试缺同步点（测试的问题）
  还是 (b) `refresh` 的可见性语义在多线程下确实不保证（实现的问题）—— **两者结论完全不同**。
  **不许**用重试/放大超时把 flaky 压下去。
- **归属**：`crates/capability/**`。

---

## D-6 负向证明的"篡改后恢复"会在**共享文件**上留下 BOM

- **状态**：`fixed`（Lead 已修 `src/contracts/generated/Version.ts`；全仓 919 文件复验无 BOM）
- **发现者**：`rust-scheduler`（task-18，看到 gate/`check-encoding` 报 `Version.ts` 有 BOM + 注释乱码）
- **根因**：Lead 做 H3 守卫的负向证明时用"篡改仓库里的生成文件 → 跑守卫证明它会红 → 再恢复"，
  而恢复那一步的 `Set-Content -Encoding utf8` **留下了 BOM**。于是那段时间 `check-encoding` 会红。
- **教训（比缺陷本身重要）**：**负向证明应该在临时副本上做，而不是"篡改真文件再恢复"。**
  "恢复"永远可能不完美，**而真文件是共享的**——在多 Agent 共享工作目录中，一次不完美的恢复
  会让别人看到一次他们无法归因的失败。**能被别人看到的中间态，本身就是一种污染。**
- **归属**：一切"验证脚本"的写法纪律（`scripts/**`）。

---

## D-7 "分开跑都绿"≠"一起跑绿"（Lead 的验收疏漏，已暴露）

- **状态**：`open`（3 条 lint 在 `crates/attest`，已批准修复）
- **发现者**：`rust-attest`（task-21，为了写 CI job 第一次跑 `cargo clippy --workspace --all-targets -- -D warnings`）
- **症状**：`exit 101`，3 条 clippy **全在 `crates/attest`**：
  `jcs.rs:197 unnecessary >= y + 1`、`hex.rs:40 manual is_multiple_of`、`merkle.rs:210 loop index`。
- **根因**：Lead 此前只跑 `-p <crate>` 与 `--no-deps` 的 clippy，**从未跑过 workspace 级**。
  `--no-deps` 区分"我改的"与"依赖的"是**有用的**（它让归属清楚），但它**不能替代一次真正的全量检查**。
- **修法**：两者都要有——**`-p` 看归属、`--workspace --all-targets` 看全树**。
  CI 的 `rust` job（task-21）已把 workspace 级 clippy 固定为必跑步骤。
- **修的过程又暴露了同一规律的第二层**（`rust-attest` 修完后观察到的）：批准了 3 条，实际是 **6 条**——
  因为 **clippy 按编译单元 fail-fast**：第 1 轮只看到 `lib` / `lib test` 的 3 条，**集成测试目标根本没被 lint 到**；
  修完才暴露 `anchor_e4.rs` / `leak_scan.rs`，再修完才暴露 `signature_bound.rs`。
  > **"第一次跑看到的条数"不是全部，而是"第一个失败单元里的条数"。**
  两层同源：**crate 之间**（`-p` vs `--workspace`）与**同一 crate 的编译单元之间**（lib / 各集成目标）。
  **要一次看到全部，得先让所有单元都能编译过。**
- **归属**：验收流程本身。

---

## D-8 `cargo llvm-cov` 复用旧 profile ⇒ 覆盖率**假读数**

- **状态**：`documented`（已在 `stage1-readings.md` 标注）
- **发现者**：`rust-capability`（task-23 的副产物）
- **症状**：`cargo llvm-cov -p dsh-testkit-capability --summary-only` 给出 **gate.rs 59.03% / 总行 76.59%**，
  与 Lead 早先那次 `--workspace` 的 90.12% **差 14 个百分点**。
- **判定证据（关键）**：`outcomes()` **只被集成测试调用**，却在那一跑里显示 **0 覆盖** ⇒
  说明该 profile 集**并不包含这轮的全部测试二进制**——它复用了 `target/llvm-cov-target` 里的陈旧/混杂 profraw。
- **修法**：用**独立 `CARGO_TARGET_DIR`** 重跑（干净、无复用），或跑前 `cargo llvm-cov clean`、或固定 `--workspace`。
  重跑后的真值：**行 91.22% / 函数 85.94% / 区域 90.51%**（与 90.12% 同量级、方向一致）。
- **教训**：这是"**读数的树必须冻结**"（D-5 旁边那条）的**后半句** ——
  > **读数还必须绑定"一跑完整产生的 profile 集"。**
  一个"某处显示 0 覆盖"的异常值，往往不是在说代码没测，而是在说**这次的测量本身不成立**。
- **归属**：覆盖率测量流程（J1）。

---

## D-9 `cargo llvm-cov --summary-only` 的**列序**被读错 ⇒ 指标值报错（Lead 的错）

- **状态**：`fixed`（`stage1-readings.md` 已按正确列序改写）
- **发现者**：Lead 自己（在核 `rust-capability` 的复现结果时发现对不上）
- **症状**：Lead 把 J1 报成"**行 89.80% / 分支 86.72% / 函数 88.14%**"。
- **真因**：`--summary-only` 的列序是 `Regions / Functions / Lines / Branches`，而 Lead **把第一列（Regions）当成了行**。
  正确映射是 **区域 89.80% / 函数 86.72% / 行 88.14%**。
- **更严重的连带**：最后一列（Branches）是 `0 0 -` —— **分支覆盖率根本没测**。
  `cargo llvm-cov --branch` 在 stable 上直接报 `the option Z is only accepted on the nightly compiler`。
  也就是说 Lead 当时报出的"分支 86.72% 达标"是**把函数列读成了分支列**，而真实的分支门槛 **80% 从未被验证过**。
- **教训**：**列序是契约的一部分。** 一张表的前三列恰好都是"百分比"，就足以让一个不小心的读者
  把三个不同的指标混成一个 —— 而**错误的读数比没有读数更糟**，因为它会让人相信一个未经验证的门槛已经达标。
  **报读数时应该连列名一起报，而不是只报数字。**
- **归属**：验收流程（读数表纪律）。

---

## D-10 「层级 → 可信度」有**两处实现**，且没有同源守卫

- **状态**：`open`（Lead 把 K1 前移到编译期时**引入**的，先记下来）
- **两处**：
  - **TS**：`src/compiler/index.ts::allowedConfidenceFor` —— **编译期**（§5.3 第 2 层防御）
  - **Rust**：`crates/executor/src/validate.rs::allowed_confidence_for` —— **运行期**（§5.3 第 3 层防御）
- **为什么两处都必须存在**：设计 §5.4 明确允许"**直接写 `ExecutionPlan` JSON**"的入口，
  那条路径**绕过编译器** ⇒ 只有运行期拦得住。**这不是重复实现，是两层防御**（`spec-engine` 在我做前移时专门提醒了这一点）。
- **风险是**：**静默漂移**。`degraded` 的适用范围（L3–L6）只要有一边改了，另一边**不会报错** ——
  它只会让"某个层级的标记没被校验"，而这类缺失只在很久以后以"某层结果没被检查"的形式浮现。
  这与 D-3（测试硬编码真源）、D-9（列序读错）同族：**都是"同一件事有两份说法"**。
- **现状的缓解（不完整）**：TS 侧有逐层断言（`tests/compiler-k1.test.mjs`，7 个测试，含"每层非空"与"未知层默认拒绝"），
  Rust 侧也有自己的测试。但**没有任何东西会因"两侧不一致"而红** —— 只能发现**单侧**漂移。
- **修法**：抽成**单一真源**（例如 `spec/contracts/layer-confidence.json`），两侧都从它读
  （TS 用 JSON import、Rust 用 `include_str!` + `serde_json`）；或加一条**逐项对拍**测试。
- **归属**：跨 `crates/executor` 与 `src/compiler` 两侧，需要协调后一次改完。

---

## D-11 stable 与 nightly 的覆盖率读数**不可比**（同一棵树差 11 个百分点）

- **状态**：`open`（J1 因此被判**不达标**）
- **现象**：**同一棵树**，两个口径：
  | 口径 | Regions | Functions | **Lines** | Branches |
  |---|---|---|---|---|
  | stable（无 `--branch`） | 89.80% | 86.72% | **88.14%** | `0 0 -`（**没测**） |
  | nightly + `--branch` | 59.68% | 78.95% | **76.80%** | **75.33%** |
- **关键数字**：`Lines` 分母 **8804 → 10019**（+1215）。**branch instrumentation 改变了行的划分**，
  于是"哪些行算覆盖"这件事本身就变了 —— 两次读数**不能互相替换，也不能取好看的那个**。
- **为什么必须用 nightly 的那个**：门槛是"行 ≥85% / **分支 ≥80%**"，而**分支只有 nightly 能测**
  （stable 上 `--branch` 直接报 `the option Z is only accepted on the nightly compiler`）。
  **用一个测不出分支的口径去宣称达标，等于把门槛的一半换成没测。**
- **结论**：**J1 = 行 76.80% / 分支 75.33%，两项都不达标（门槛 85/80）**。
  主因是 `scheduler`：`error.rs` **0%**、`observation.rs` 42%、`scheduler.rs` 49% regions、`event.rs` 51%。
- **教训**：这条与 D-9（列序读错）是**同一类错误的两个阶段** ——
  D-9 是"把三个百分比读混了"，D-11 是"**用了一个与门槛不匹配的测量口径**"。
  后者的危害更大：它不是读错一个数，而是**让一个未验证的门槛看起来已经达标**。
  **判据是"门槛要求什么"，不是"我手上有什么工具能测什么"。**
- **归属**：`crates/scheduler`（主因）+ 覆盖率测量口径（J1）。

- **补充（同日，第三次修正）**：`rust-scheduler` 复核时指出我那张表的 **Branches 75.33% 与它"补之前"的读数精确相同**（逐文件也相同），
  但 **Regions 59.68% / Lines 76.80%（分母 10019）** 与它对不上（`reconciler/table.rs`：我 59.35%/88.48% vs 它 93.22%/92.41%）。
  **真因**：我那次用的是**默认 `target/llvm-cov-target`**，profile 里**混入了别人的残留** ⇒ 分母虚高 1287 行。
  换成**独立 `CARGO_TARGET_DIR`** 后分母 **8732**、行 **88.12%** —— **与它完全一致**。
  ⇒ **行门槛其实早就达标，真正的缺口只有分支（差 36 条 / 3.28pp）**。
- **一句话**：D-8 是别人踩的坑，**我在同一件事上又踩了一次**（而且是在我刚把它写进台账之后）。
  **"写进台账"不等于"不会再犯"**——唯一能防止它的是**把正确做法写进命令本身**（本表已改成必须带 `CARGO_TARGET_DIR`）。

---

## D-12 LLVM 的「分侧归因」会产生**点不亮的伪缺口**

- **状态**：`documented`
- **发现者**：`spec-engine`（task-25，逐块判定 `reconciler/normalize.rs` 的未覆盖分支时）
- **现象**：某些分支 `exec > 0`，但 **`true == 0 && false == 0`** —— 两侧计数都是 0。
- **可操作判据**（它给的，可直接复用）：
  | 形态 | 含义 | 处置 |
  |---|---|---|
  | `exec == 0` | 该分支点**从未执行到** | **真缺口**，值得补测试 |
  | `exec > 0` 且 `true == 0 && false == 0` | **归因产物**（工具没法分侧记账） | 补测试**不会让它变绿** |
  | `exec > 0` 且只有一侧为 0 | 那一侧确实没走过（多数） | 真实缺口，可补 |
- **为什么值得记**：它解释了一类会让人**陷入困惑**的读数 —— "我明明补了测试，这个分支怎么还是红的？"
  答案是**它不是分支，是记账产物**。与 D-11（口径不可比）同族：
  **读数需要解释，而解释需要知道工具是怎么记账的。**
- **附带（值得搬进 `baseline/`）**：分类脚本在 `%TEMP%\parse-cov2.mjs`（输入 = `cargo +nightly llvm-cov --branch --json` 的产物，输出 real / attr 两类行号）。

---

## D-13 「归因诚实」的可复制做法（不是靠自觉）

- **状态**：`documented`（`spec-engine` 在 task-25 提出，Lead 采纳为本仓做法）
- **背景**：多 Agent 共享一个 workspace 时，TOTAL 指标的变化**混着多个 owner 的工作**。
  task-25 里 `TOTAL Branches` 从 250 miss 掉到 192（-58），而**可归因于该 owner 的只有 29 条**。
- **做法**（三步，可机械执行）：
  1. **先把自己这次改动过的文件集合钉下来**（`git status` + 明确知道自己只新增了哪些文件）；
  2. **TOTAL 的每一个变化，凡不能由这个集合解释的，默认不属于自己** —— 直到有人能证明它属于；
  3. **用分母自证把"变化来自 tests 而非 src"变成机械事实**（只加 `tests/*.rs` 时分母逐字不变）。
- **为什么这是硬做法而不是态度**：第 3 步让归因**不需要靠口头保证**。
  一个"变化来自哪里"的判断，如果能被"分母是否变动"这样的机械事实支撑，它就不再是一个人的诚实度问题。
- **反面（本仓已出现过）**：task-17 那次"测试硬编码真源"（D-3）—— 一边改真源、一边钉死真源，
  两条并行线各自都"绿"，撞在一起才红。**归因不清就会演变成互相指责，而 D-13 把它变成一次文件集合的比对。**