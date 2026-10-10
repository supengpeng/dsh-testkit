---
domain: engine
module: surfaces
revision: 1

atomics:
  - id: BEH-ENGINE-SURFACES-001
    title: surfaces-tools —— 模型工具注册面：13 个工具、定义形状与「只能收紧」的闸门纪律
    atomic: model-tools
    status: active
    source:
      file: src/tools.ts
      lines: "51-871"
      symbols:
        - ToolDeps
        - defineTestkitTools
        - asStringArray
        - buildPolicy
        - describePolicy
        - describeFilter
      tests:
        - tests/host-apply.test.mjs::在真实 cordis 容器里装配：注册面完整
        - tests/host-apply.test.mjs::注册出来的工具是 defineTool 的产物，不是裸对象
        - tests/host-apply.test.mjs::能力探测：宿主只有 tools 时，命令与路由都不注册（且 apply 不抛错）
        - tests/tools-filter.test.mjs::testkit_run：省略选择器 → 只跑 active
        - tests/pipeline-surface.test.mjs::工具面：只读的 testkit_pipeline 能报台账，且没有 approve 这类入口
    capabilities:
      - tools
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "调用 defineTestkitTools(deps)"
        when: "读返回数组的每一项 name"
        then: "恰好 13 项，且顺序固定：testkit_list / testkit_run / testkit_report / testkit_export / testkit_expand / testkit_trace / testkit_trend / testkit_coverage / testkit_search / testkit_triage / testkit_doctor / testkit_propose / testkit_pipeline（运行时真源断言同顺序）"
        verdict: pass
        tests: ["tests/host-apply.test.mjs::在真实 cordis 容器里装配：注册面完整"]
        source: { file: "src/tools.ts", lines: "87, 97-816" }
      - given: "逐个工具定义的名字与源码行"
        when: "grep `name: 'testkit_` 于 src/tools.ts"
        then: "13 处命中，行号 99 / 163 / 363 / 399 / 496 / 536 / 581 / 619 / 627 / 660 / 702 / 739 / 793——与上一条的 13 个名字一一对应（名字与行号都可复算）"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "97-816" }
      - given: "单个工具定义的形状"
        when: "读任一项"
        then: "含 name / description / parameters / execute 四个字段（类型是 kinds/types.ts 的 ToolDefinition）；execute 是函数；注册进宿主后由 defineTool 产出 execute / isConcurrencySafe / timeoutMs / parameters / output，且 isConcurrencySafe() === false（测试类工具改宿主状态，一律按写操作串行）"
        verdict: pass
        tests: ["tests/host-apply.test.mjs::注册出来的工具是 defineTool 的产物，不是裸对象"]
        source: { file: "src/tools.ts", lines: "98-115" }
      - given: "工具参数的 schema 形态"
        when: "读 testkit_list 的 parameters"
        then: "根是 `{ type:'object', properties:{...}, additionalProperties:false }`——未知参数被 schema 层拒绝，不靠 execute 兜"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "102-111" }
      - given: "数组类参数的类型不符"
        when: "asStringArray(非数组) / asStringArray([1,'a']) / asStringArray([])"
        then: "非数组 → undefined；数组内非字符串被过滤；过滤后为空 → undefined。即**静默归一化**，不抛错——非法输入退化成「没给」"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "819-823" }
      - given: "闸门纪律①：工具面总是构造并传入 policy"
        when: "testkit_run 的 execute"
        then: "`const policy = buildPolicy(deps, args)` 后**总是**把 policy 传给 runScenarios（省略 policy 在 runner 层等于「不启用闸门」，工具面绝不走那条路）"
        verdict: pass
        tests: ["tests/tools-filter.test.mjs::testkit_run：省略选择器 → 只跑 active"]
        source: { file: "src/tools.ts", lines: "269-278, 834-852" }
      - given: "闸门纪律②：工具参数只能收紧，不能提权"
        when: "buildPolicy(deps, args)"
        then: "`args.allowModel === false` 才写 false（true 不写任何东西）；`allowLowCost === false` 同理；`maxModelCalls` 走 `tightenLimit(配置值, 入参)`（0 = 不限，只能更严）；`allowFileWrite === false` 同理。**放权入口不在这里**——模型无法给自己开模型权限"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "825-852" }
      - given: "提炼闸门的落地权不在工具面"
        when: "读 ToolDeps.pipeline 的用法"
        then: "工具面只用到提案侧（testkit_propose 写提案、testkit_pipeline 只读台账）；`issue approve/reject`（落地裁决）只挂在命令面，模型够不到——这是闸门成立的前提"
        verdict: pass
        tests: ["tests/pipeline-surface.test.mjs::工具面：只读的 testkit_pipeline 能报台账，且没有 approve 这类入口"]
        source: { file: "src/tools.ts", lines: "68-74" }
      - given: "工具输出的自证行"
        when: "testkit_run 渲染输出"
        then: "describePolicy 把生效闸门渲染成一行（allowModel / allowLowCost / shell / fileWrite）；describeFilter 把选择器渲染成一行——「合计 0」不用靠猜"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "854-871" }
      - given: "能力门"
        when: "宿主只具备 tools 能力时装配插件"
        then: "13 个工具照常注册；命令与路由**都不注册**且 apply 不抛错（命令需要 commands 能力，路由需要 webServer——见 surfaces-plugin-command）"
        verdict: pass
        tests: ["tests/host-apply.test.mjs::能力探测：宿主只有 tools 时，命令与路由都不注册（且 apply 不抛错）"]
        source: { file: "src/tools.ts", lines: "51-82" }
    cleanup: none
    nonDeterministic:
      - field: "工具返回文本里的 Run ID / 耗时 / 路径"
        reason: "来自 RunSummary（runId 含时间与随机后缀、durationMs 为挂钟、casesDir 为绝对路径）"
        reconcile: "normalize-path"
      - field: "testkit_run 的进度行（✅/⏭️/❌/💥 <caseId>）"
        reason: "按实际完成顺序累积，顺序随驱动过程变化；断言应按集合比较"
        reconcile: "sorted-set"
    equivalence:
      tool-names: exact
      tool-count: exact
      policy-deny-only: exact

  - id: BEH-ENGINE-SURFACES-002
    title: surfaces-plugin-command —— /testkit 插件命令面：1 命令 / 17 顶层 / 7 issue 嵌套
    atomic: plugin-command
    status: active
    source:
      file: src/commands.ts
      lines: "66-879"
      symbols:
        - defineTestkitCommands
        - USAGE
        - ISSUE_USAGE
        - handleIssue
        - renderList
        - parseSelection
        - withCommandOverrides
      tests:
        - tests/host-apply.test.mjs::在真实 cordis 容器里装配：注册面完整
        - tests/host-apply.test.mjs::能力探测：宿主只有 tools 时，命令与路由都不注册（且 apply 不抛错）
        - tests/pipeline-surface.test.mjs::命令面：approve 缺目标 / 未知动作 / 空范围都有明确报错，不会静默
        - tests/pipeline-surface.test.mjs::命令面：open → 工具提案 → approve 落地，全链路走通
    capabilities:
      - commands
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "调用 defineTestkitCommands(deps)"
        when: "读返回数组"
        then: "恰好 1 项，name = 'testkit'，含 description / inputHint / execute（运行时真源断言注册 1 个命令）"
        verdict: pass
        tests: ["tests/host-apply.test.mjs::在真实 cordis 容器里装配：注册面完整"]
        source: { file: "src/commands.ts", lines: "123-137" }
      - given: "顶层子命令清单"
        when: "grep `case '<name>':` 于 src/commands.ts 的主 switch（:135-530）"
        then: "恰好 17 个：list / run / report / expand / registry / fixtures / import / export / trace / trend / coverage / triage / doctor / search / reload / issue / help"
        verdict: pass
        tests: []
        source: { file: "src/commands.ts", lines: "123-533" }
      - given: "子命令缺省值"
        when: "execute 收到空输入"
        then: "`const sub = argv.shift() ?? 'list'`——`/testkit` 不带参数等价于 `/testkit list`（返回 renderList 的文本）"
        verdict: pass
        tests: []
        source: { file: "src/commands.ts", lines: "131-136" }
      - given: "未知子命令"
        when: "sub 不在 17 个 case 中"
        then: "落入 `case 'help': default:`，返回 `{ kind:'success', text: USAGE }`——**不是错误**、不抛错；插件命令面没有退出码概念（CommandResultLike 只有 success / error 两种，都只带 text）"
        verdict: pass
        tests: []
        source: { file: "src/commands.ts", lines: "530-533" }
      - given: "issue 的嵌套子命令"
        when: "grep issue 子 switch（handleIssue，:541-623）的 case"
        then: "恰好 7 个：status / list（同分支）/ open / show / approve / reject / close；缺省动作是 'status'（`argv.shift() ?? 'status'`）"
        verdict: pass
        tests: ["tests/pipeline-surface.test.mjs::命令面：open → 工具提案 → approve 落地，全链路走通"]
        source: { file: "src/commands.ts", lines: "541-547" }
      - given: "issue 的参数错误"
        when: "`/testkit issue open` 空范围 / 未知动作 / approve 缺目标"
        then: "返回 `{ kind:'error', text: <明确原因 + 用法> }`（例如「开启提炼必须写明范围。用法：/testkit issue open <范围说明>」）——**绝不静默**"
        verdict: fail
        tests: ["tests/pipeline-surface.test.mjs::命令面：approve 缺目标 / 未知动作 / 空范围都有明确报错，不会静默"]
        source: { file: "src/commands.ts", lines: "550-554" }
      - given: "命令面是唯一的放权入口"
        when: "`/testkit run --allow-model`"
        then: "run 分支用 `withCommandOverrides(deps.policyDefaults?.() ?? {}, selection.overrides)` 合并覆盖——命令由**人**发起，所以 `--allow-model` / `--allow-low-cost` 可以显式放权；工具面只能收紧（surfaces-tools 的纪律②）"
        verdict: pass
        tests: []
        source: { file: "src/commands.ts", lines: "142-146, 838-879" }
      - given: "两条输出通道的形态差异"
        when: "对比命令面与 CLI 面"
        then: "**命令面**：`/testkit` 返回 CommandResultLike（success/error + text），渲染由 DSH UI 决定，**无退出码**；**CLI 面**：`src/cli/index.ts` 的 16 个子命令走 stdout/`--json` 两条通道并**返回退出码**（未知子命令与未知选项都是 2，见 src/cli/index.ts:232,239）。两套面共用同一套引擎，但注册与错误处置是两套"
        verdict: pass
        tests: ["tests/cli.test.mjs::未知子命令 / 未知选项一律退出码 2（绝不静默忽略）"]
        source: { file: "src/commands.ts", lines: "1-9, 123-137" }
    cleanup: none
    nonDeterministic:
      - field: "命令返回文本里的 Run ID / 耗时 / 路径"
        reason: "来自 RunSummary；renderList 还会带 cases 目录的绝对路径"
        reconcile: "normalize-path"
      - field: "USAGE / ISSUE_USAGE 文本"
        reason: "固定多行文案，逐字稳定（改动要同步 docs/FEATURES.md 的常用集）"
        reconcile: exact
    equivalence:
      command-count: exact
      subcommand-names: exact
      unknown-subcommand-behavior: exact

  - id: BEH-ENGINE-SURFACES-003
    title: surfaces-target-tools —— 目标态差额：testkit_collect / testkit_refine（当前不存在）
    atomic: collect-refine-tools
    status: unsupported
    source:
      file: src/tools.ts
      lines: "87-816"
      symbols:
        - defineTestkitTools
      tests: []
    capabilities:
      - tools
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "RFC §5 与设计 §10.8 承诺的两个新模型工具"
        when: "在 src/tools.ts 中检索 `testkit_collect` / `testkit_refine`"
        then: "**零命中**——两者都不在 13 个注册名中，当前实现不支持"
        verdict: fail
        tests: []
        source: { file: "src/tools.ts", lines: "87-816" }
      - given: "testkit_collect 的目标形态"
        when: "读设计 §10.8 的注册面表"
        then: "模型工具；**幂等**；扫描根目录 → 资产清单（只读）。落地后工具数 13 → 15"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "87-816" }
      - given: "testkit_refine 的目标形态"
        when: "读设计 §10.8 的注册面表"
        then: "模型工具；**非幂等**；只写 `pipeline/proposals/`。与 collect 合计 +2，故目标工具数 = 15"
        verdict: pass
        tests: []
        source: { file: "src/tools.ts", lines: "87-816" }
    cleanup: none
    nonDeterministic: []
    equivalence:
      note: "目标态条目：阶段 1 落地后应转 status: active 并补 actual 的对拍等价关系"

  - id: BEH-ENGINE-SURFACES-004
    title: surfaces-target-command —— 目标态差额：collect / refine 子命令（当前不存在）
    atomic: collect-refine-command
    status: unsupported
    source:
      file: src/commands.ts
      lines: "123-533"
      symbols:
        - defineTestkitCommands
        - USAGE
      tests: []
    capabilities:
      - commands
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "RFC §5 与设计 §10.8 承诺的两个新子命令"
        when: "在 src/commands.ts 中检索 `case 'collect':` / `case 'refine':`"
        then: "**零命中**——两者都不在 17 个顶层 case 中，当前实现不支持"
        verdict: fail
        tests: []
        source: { file: "src/commands.ts", lines: "123-533" }
      - given: "目标态计数"
        when: "读 RFC §5 与设计 §10.8"
        then: "CLI 子命令 16 → 18（+collect / +refine），形态是「与工具共用同一套引擎」"
        verdict: pass
        tests: []
        source: { file: "src/commands.ts", lines: "123-533" }
      - given: "口径缺口：插件命令面是否也 +2"
        when: "对比「CLI 子命令 16 → 18」与 `/testkit` 的 17 个顶层 case"
        then: "设计只写了 CLI 面的 16 → 18，**没有**说 `/testkit` 插件命令面是否同步 +2（若同步则是 17 → 19）。两套面按设计共用同一套引擎，阶段 1 必须裁决这个差额；否则「18」对不上任何一套面的实际清点"
        verdict: fail
        tests: []
        source: { file: "src/commands.ts", lines: "123-533" }
    cleanup: none
    nonDeterministic: []
    equivalence:
      note: "目标态条目：阶段 1 落地后应转 status: active 并补 actual 的对拍等价关系"
---

# surfaces —— 注册面（模型工具 / 插件命令 / CLI / HTTP 路由）

> 本模块是 `spec/README.md` §2 里 engine 的第 7 个模块（Lead 2026-10-11 同步）。
> 它只记录**注册面**（有哪些工具 / 子命令、怎么注册、未知输入怎么处置），
> **不重复** 12 个 kind 各自的业务语义——那些分属 `spec/behaviors/kinds/*.md`。

登记范围与理由：

| 面 | 源文件 | design-scope 分类 | 本文件是否落 atomic | 理由 |
|---|---|---|---|---|
| 模型工具（13） | `src/tools.ts` | **unlisted**（§1.2 未提），Lead 人工裁决为变更 | ✅ `model-tools` | RFC §5 承诺 13 → 15，属变更面 |
| 插件命令 `/testkit`（17 顶层 + 7 嵌套） | `src/commands.ts` | **unlisted**（§1.2 未提），Lead 人工裁决为变更 | ✅ `plugin-command` | 与工具共用引擎；RFC 承诺 CLI 面扩容会牵动它 |
| CLI 子命令（16） | `src/cli/index.ts` | **keep**（§1.2 line 63「沿用」） | ❌ 不落 | 沿用模块；16 个名字 + available 标记已在 `spec/contracts/surfaces.yaml` 的 `cli:` 节点逐个列名 |
| HTTP 路由（4） | `src/http.ts` | **keep**（§1.2 line 64「沿用，不动」） | ❌ 不落 | 沿用模块；4 条路由的路径 / 方法 / 前缀 / body 上限已在 `surfaces.yaml` 的 `http:` 节点列名，且 `tests/host-apply.test.mjs:116-125` 守着 |
| kind（12） | `src/kinds/index.ts` | change | ❌ 本文件不落 | 已在 `engine/policy.md` 的 `policy-driver-cost` 与 `kinds/*.md` 覆盖 |

**我核源码得到的实际清点**（与 `spec/contracts/surfaces.yaml` 对照）：

| 面 | 我的清点 | surfaces.yaml | 一致？ |
|---|---|---|---|
| 工具 | **13**（`grep "name: 'testkit_"` = 13 处，行号 99/163/363/399/496/536/581/619/627/660/702/739/793） | 13，同 13 个行号 | ✅ **逐行号一致** |
| 插件命令顶层 | **17**（主 switch 的 case：135/138/221/242/264/279/294/344/407/435/452/455/491/514/524/527/530） | 17，行区间 126-530 | ✅ 一致 |
| 插件 issue 嵌套 | **7**（546/547/550/570/577/603/623） | 7 | ✅ 一致 |
| CLI 子命令 | **16**（`src/cli/index.ts:80-95` 的 COMMANDS 数组） | 16 | ✅ 一致（`HELP_OPTIONS` 的 `{name:'json'}` 不是子命令——surfaces.yaml 的 counting_note 已澄清） |
| HTTP 路由 | **4**（list/run/report/reload，`http.ts:75/98/152/171`；`BRIDGE_PREFIX` 在 `:38`） | 4 | ✅ 一致 |

→ **本轮没有发现 surfaces.yaml 的读数错误**；下面列的是它**未覆盖的语义**（那是行为规格的职责，不是它的）。

## model-tools

`defineTestkitTools(deps)`（`tools.ts:87`）返回 13 个 `ToolDefinition`，顺序固定。
三条最容易在重构中丢掉的纪律：

1. **工具参数只能收紧**（`tools.ts:825-852`）：`allowModel:true` **不写**任何东西（只有 `false` 生效）。
   放权只能走命令面 `/testkit run --allow-model`——"模型自己给自己开模型权限"这条路是堵死的。
2. **总是构造 policy**（`tools.ts:269-278`）：省略 `policy` 在 runner 层等于"不启用闸门"，
   工具面绝不依赖"忘了传"的缺省。
3. **落地权不在工具面**（`tools.ts:68-74`）：工具只见 `propose` / `statusText`，
   `issue approve|reject` 只挂命令面（闸门成立的前提）。

### 边界与已知缺陷

- **非法输入静默归一化**（`asStringArray`，`tools.ts:819-823`）：类型不符 / 空数组都退化成
  `undefined`（= 没给）。**这与 CLI 面"未知选项一律退出码 2、绝不静默忽略"（`cli/index.ts:245-258`）是相反的口径**。
  两者都有理由（工具面要容错，CLI 面怕人以为开关生效），但阶段 1 必须**保留这个差异**，
  不要顺手统一成一种。
- **13 个工具的业务语义不在这里**：清单只到名字与注册形状。每个工具的参数 / 返回值
  若属某个 kind 的干预面，去 `kinds/*.md`；若是纯查询面（coverage/search/trend），
  §1.2 未列、属 unlisted。
- **`NO_ARGS` 常量当前是死代码**（`tools.ts:84-85`，注释写"Phase 4 的 export 工具会用"，
  而 `testkit_export` 已在 `:399` 注册且未用它）。属声明与实现不同步，如实记录。

## plugin-command

`defineTestkitCommands(deps)`（`commands.ts:123`）只返回 **1** 个命令 `testkit`，
其 `execute` 是一个 17 分支的 switch（顶层）+ 一个 7 分支的 issue 子 switch。

**未知子命令不是错误**：落到 `case 'help': default:` 返回 `{kind:'success', text: USAGE}`
（`commands.ts:530-533`）。这是命令面（UI）与 CLI 面（退出码）的**处置差异**。

### 边界与已知缺陷

- **`/testkit` 没有退出码**：`CommandResultLike` 只有 `success` / `error` 两种，都只带 `text`
  （`kinds/types.ts:29-31`）。所以 task-8 描述里"未知子命令的处置（退出码 2）"**是串了面**：
  退出码 2 属于 CLI（`src/cli/index.ts:239` 的未知子命令 / `:232` 的未知选项 → `EXIT.USAGE`，
  见 `spec/contracts/exit-codes.yaml` code 2 的 `assigned_in`）。**本条目按源码落**。
- **顶层 17 与 CLI 16 是两套面**：`surfaces.yaml` 的 `cli.separate_surface` 已注明不可混用；
  本文件把这一点写进 observable（"两条输出通道的形态差异"）。
- **USAGE 文本与 `docs/FEATURES.md:33-37` 的"常用集"（14 个名字，缺 registry/fixtures/help）**
  是子集关系，不是完整清单——改 USAGE 时 FEATURES 不必同步，但若 FEATURES 自称完整清单就会漂。

## 目标态差额（RFC §5 / 设计 §10.8）

RFC §5（`docs/rfc/0001-rust-core-full-rewrite.md:190`）与设计 §10.8
（`docs/REWRITE-DESIGN.md:937-943`）承诺：

| 新增 | 形态 | 幂等 | 现状 |
|---|---|---|---|
| `testkit_collect` | 模型工具 | **是** | ❌ 不存在（本文件 `collect-refine-tools`，`status: unsupported`） |
| `testkit_refine` | 模型工具 | **否** | ❌ 不存在（同上） |
| `dsh-testkit collect` / `refine` | CLI 子命令 | 同上 | ❌ 不存在（本文件 `collect-refine-command`，`status: unsupported`） |

落地后：工具 **13 → 15**、CLI 子命令 **16 → 18**（kind 仍 12、HTTP 路由数不变）。

### 边界与已知缺陷（目标态的口径缺口，阶段 1 必须裁决）

1. **RFC 自身的一处矛盾**：§5 的"要改的文件"行（`:189`）写「新增**一个**子命令」，
   而同节"注册面数量"行（`:190`）写 CLI「16 → 18」（即 **+2**）。
   按设计 §10.8 的表，`collect` 与 `refine` 是两个 —— 以 `:190` 与 §10.8 为准，**+2 才自洽**。
2. **插件命令面是否同步 +2 未定义**：设计只写 CLI 面 16 → 18，没说 `/testkit` 的 17 个顶层
   是否也加 `collect` / `refine`（若加则是 17 → 19）。两套面按设计"共用同一套引擎"，
   阶段 1 不裁决这条，就会出现"18 对不上任何一套面的实际清点"（见
   `collect-refine-command` 的第 3 条 observable）。
3. **README / FEATURES 的同步点**：落地时 `README.md:94,99,100`、`docs/FEATURES.md:8,42,51`
   的计数必须一起改（`surfaces.yaml` 的 DRIFT-SURF-1 已登记）。
