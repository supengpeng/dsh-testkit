---
domain: engine
module: analysis
revision: 1

atomics:
  - id: BEH-ENGINE-ANALYSIS-001
    title: analysis-classify —— 失败归因判定表（5 类穷尽互斥，unknown 不是类别）
    atomic: analysis-classify
    status: active
    source:
      file: src/analysis/classify.ts
      lines: "44-136"
      symbols:
        - classifyCase
        - ENV_PATTERNS
        - DRIVER_PATTERNS
        - REF_PATTERNS
        - collectText
        - FAILURE_CATEGORY_LABEL
      tests:
        - tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖
        - tests/report-standard.test.mjs::classifyCase：软断言失败不算硬失败（不改变 verdict 的证据）
        - tests/report-standard.test.mjs::FAILURE_CATEGORY_LABEL：5 类枚举齐全且非空
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "verdict 是 passed 或 skipped"
        when: "classifyCase(outcome)"
        then: "返回 undefined（**不写 failureCategory**）；跳过不是失败，没有归因可谈"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "101" }
      - given: "rounds 存在、长度 > 1、且既有 true 又有 false"
        when: "classifyCase 第 2 步"
        then: "返回 flaky（判定先于一切 verdict 分支——多轮不一致优先于单轮的错误文本特征）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "104-107" }
      - given: "verdict=errored 且匹配文本命中 driver 特征"
        when: "DRIVER_PATTERNS 任一命中"
        then: "返回 driver_bug；特征表 6 条：driver 尚未实现 / driver 未实现 / 没有对应 driver / 无法判断动作属于哪个 kind / setup 里出现了 kind / 夹具"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "67-74, 112" }
      - given: "verdict=errored 且匹配文本命中环境特征"
        when: "ENV_PATTERNS 任一命中"
        then: "返回 env；特征表 15 条：超时（>、ETIMEDOUT、ENOENT、EACCES、EPERM、ECONNREFUSED、EADDRINUSE、ENOSPC、EBUSY、宿主缺少能力、aborted、沙箱、node_modules、预算超限、BudgetExceeded"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "47-64, 113" }
      - given: "verdict=errored 且两个特征表都没命中"
        when: "errored 兜底"
        then: "返回 driver_bug（不是 unknown、不是抛错）——errored 的默认责任方是引擎/驱动"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "114" }
      - given: "verdict=failed 且 releaseFailures 非空"
        when: "classifyCase failed 分支第 1 步"
        then: "返回 driver_bug（夹具释放失败=有泄漏风险，判定顺序在环境特征之前）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "118" }
      - given: "verdict=failed 且匹配文本命中环境特征（含预算超限）"
        when: "ENV_PATTERNS 任一命中"
        then: "返回 env；**预算超限走这里**（BUDGET 并入 env：它是「本次运行的条件不足」，不新增第 6 类）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "119, 61-63" }
      - given: "verdict=failed 且没有任何硬失败断言"
        when: "failing.length === 0"
        then: "返回 driver_bug（失败但断言全过 → 责任在引擎侧）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "121-124" }
      - given: "verdict=failed 且**全部**硬失败断言的 message 命中取值失败特征"
        when: "failing.every(REF_PATTERNS)"
        then: "返回 case_bug；REF_PATTERNS 3 条：取值失败 / 未知 ref 前缀 / ref 缺少前缀。**只认结构性信号**——「断言写错了但取到值」与「被测对象真的错了」运行期不可区分，故不判 case_bug"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "76-81, 125" }
      - given: "verdict=failed 且以上都不命中"
        when: "failed 兜底"
        then: "返回 product_bug（期望≠实际 → 默认判被测对象）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "126" }
      - given: "软断言（soft=true）失败"
        when: "构造 failing 列表"
        then: "`!ok && !soft` 才算硬失败 → 软断言失败**不参与** case_bug/product_bug 判定（与 runner 的 hasHardFailure 同口径）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：软断言失败不算硬失败（不改变 verdict 的证据）"]
        source: { file: "src/analysis/classify.ts", lines: "121-123" }
      - given: "匹配文本的拼装"
        when: "collectText(outcome)"
        then: "依次拼：outcome.error（若有）+ outcome.skipReason（若有）+ 每个 step.action.detail（若有）+ 每个 releaseFailures[].error，用换行连接；**不含 notes、不含断言 message**（除 REF_PATTERNS 在 failed 分支单独读断言 message）"
        verdict: pass
        tests: []
        source: { file: "src/analysis/classify.ts", lines: "83-93" }
      - given: "归因类别的穷尽性与互斥性（unknown 不是类别）"
        when: "FailureCategory 枚举 + classifyCase 的返回值 + run-report schema"
        then: "类别恰好 5 个（product_bug / case_bug / driver_bug / env / flaky），**没有 unknown**；判定自上而下命中即返回（互斥）；errored 兜底 driver_bug、failed 兜底 product_bug，故 failed/errored **必然**落进 5 类之一；passed/skipped 返回 undefined"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/analysis/classify.ts", lines: "100-127" }
      - given: "类别的中文标签"
        when: "FAILURE_CATEGORY_LABEL[category]"
        then: "5 项齐全且非空：product_bug=被测对象缺陷 / case_bug=用例缺陷 / driver_bug=引擎/驱动缺陷 / env=环境问题 / flaky=不稳定（抖动）；md 与工具输出共用同一份，避免两处漂移"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::FAILURE_CATEGORY_LABEL：5 类枚举齐全且非空"]
        source: { file: "src/analysis/classify.ts", lines: "129-136" }
    cleanup: none
    nonDeterministic:
      - field: "classifyCase 的返回值"
        reason: "由 outcome 决定，是纯函数；但 outcome 里的 error/message 可能含绝对路径与临时目录名"
        reconcile: exact
      - field: "匹配文本（error / action.detail / releaseFailures[].error）"
        reason: "内嵌路径与错误原文；正则只做子串匹配，路径不影响多数特征的命中"
        reconcile: normalize-path
    equivalence:
      failureCategory: exact
      category-set: exact

  - id: BEH-ENGINE-ANALYSIS-002
    title: analysis-causes —— 可能原因推断（有据才猜、按可能性排序、最多 3 条）
    atomic: analysis-causes
    status: active
    source:
      file: src/analysis/causes.ts
      lines: "36-373"
      symbols:
        - probableCauses
        - ProbableCause
        - LIKELIHOOD_LABEL
        - renderCauses
        - MAX_CAUSES
        - MAX_FIELD
        - LIKELIHOOD_WEIGHT
        - clip
        - evidenceText
        - failingAssertions
        - describeExpectation
        - hasKnownRefPrefix
      tests:
        - tests/causes.test.mjs::causes：case_bug —— 断言引用的取证路径取不到值
        - tests/causes.test.mjs::causes：ref 前缀非法（结构性信号）也能识别，不依赖 failureCategory
        - tests/causes.test.mjs::causes：env + 超时 —— 阈值偏紧 / 宿主慢 / 真的卡住
        - tests/causes.test.mjs::causes：env + 预算超限 —— 本次运行的条件不足，不是结论
        - tests/causes.test.mjs::causes：driver_bug + action.ok=false —— 动作没跑通（driver 与宿主契约不符）
        - tests/causes.test.mjs::causes：夹具释放失败 —— 有泄漏风险，后续结论不可信
        - tests/causes.test.mjs::causes：errored + 没有对应 driver —— 装配问题
        - tests/causes.test.mjs::causes：宿主条件不满足（能力 / 沙箱）
        - tests/causes.test.mjs::causes：product_bug + 期望/实际都在 —— medium（不冒充结论）
        - tests/causes.test.mjs::causes：product_bug 但实际值是 undefined —— low（两个方向都说得通）
        - tests/causes.test.mjs::causes：flaky（多轮不一致）—— 先怀疑时序 / 隔离
        - tests/causes.test.mjs::causes：按可能性排序、最多 3 条、rank 连续
        - tests/causes.test.mjs::causes：medium 排在 high 之后
        - tests/causes.test.mjs::causes：不编 —— 没有依据时返回空数组
        - tests/causes.test.mjs::causes：case_bug 但找不到取值失败明细时如实说明，不编明细
        - tests/causes.test.mjs::causes：软断言失败不算证据（与 runner 的硬失败判定一致）
        - tests/causes.test.mjs::causes：证据超长要截断（报告里一条原因不该占满一屏）
        - tests/causes.test.mjs::renderCauses：固定格式含"可能性/依据/下一步"
        - tests/causes.test.mjs::renderCauses：空集要如实说"不做推断"，不装样子
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "verdict=passed 或 skipped"
        when: "probableCauses(outcome)"
        then: "返回 []（通过没有「原因」；跳过已由 skipReason 说清，再说一遍是噪声）"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：不编 —— 没有依据时返回空数组"]
        source: { file: "src/analysis/causes.ts", lines: "118-122" }
      - given: "证据文本命中预算超限特征（预算超限 / BudgetExceeded）"
        when: "规则 ①"
        then: "给一条 high：cause 为「被本次运行的预算上限截断，不是结论上失败」；evidence 含错误文本与用量（模型调用 N 次 / token N，usage 存在时）；nextStep 要求提高 budget 上限后重跑、**拿到完整结论前不要改断言**"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：env + 预算超限 —— 本次运行的条件不足，不是结论"]
        source: { file: "src/analysis/causes.ts", lines: "76, 128-142" }
      - given: "rounds 存在、长度 > 1、既有 true 又有 false"
        when: "规则 ②"
        then: "给一条 high：cause 为抖动（先怀疑时序 / 共享状态 / 夹具隔离）；evidence 列出各轮 通过/失败 与轮数；nextStep 要求连跑 5~10 次或调大 repeat 并核对 parallel 声明"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：flaky（多轮不一致）—— 先怀疑时序 / 隔离"]
        source: { file: "src/analysis/causes.ts", lines: "144-157" }
      - given: "outcome.error 命中 /超时/"
        when: "规则 ③"
        then: "给一条 high；evidence 含错误文本与本 case 耗时 durationMs；nextStep 要求先单跑一次看是否稳定复现"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：env + 超时 —— 阈值偏紧 / 宿主慢 / 真的卡住"]
        source: { file: "src/analysis/causes.ts", lines: "77, 159-169" }
      - given: "匹配文本命中无 driver 特征"
        when: "规则 ④"
        then: "给一条 high：问题在场景/装配，不在被测对象；nextStep 指向 createDriverRegistry() 与 testkit_list"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：errored + 没有对应 driver —— 装配问题"]
        source: { file: "src/analysis/causes.ts", lines: "79-80, 171-181" }
      - given: "steps 里存在 action.ok=false 的步骤"
        when: "规则 ⑤（取**第一个**失败动作）"
        then: "给一条 high：失败在动作阶段而非断言阶段；evidence 含步骤名、action.kind 与 detail；nextStep 要求对照适配边界并区分 driver 写错与宿主没接上"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：driver_bug + action.ok=false —— 动作没跑通（driver 与宿主契约不符）"]
        source: { file: "src/analysis/causes.ts", lines: "183-196" }
      - given: "releaseFailures 非空"
        when: "规则 ⑥"
        then: "给一条 high：有资源泄漏风险、后续场景可能被污染；evidence 含失败项数与首项 label→error；nextStep 要求修好后**重跑整批**而不是只重跑这一条"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：夹具释放失败 —— 有泄漏风险，后续结论不可信"]
        source: { file: "src/analysis/causes.ts", lines: "198-211" }
      - given: "匹配文本命中宿主条件特征（宿主缺少能力 / 沙箱）"
        when: "规则 ⑦"
        then: "给一条 high：这是「这台机器跑不了」；nextStep 指向换宿主或调整 sandbox.allowShell / allowFileWrite / allowedPaths"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：宿主条件不满足（能力 / 沙箱）"]
        source: { file: "src/analysis/causes.ts", lines: "78, 213-222" }
      - given: "failureCategory=case_bug，或某条硬失败断言取值失败 / ref 前缀非法"
        when: "规则 ⑧"
        then: "给一条 high：多半是用例写错 ref；evidence 含失败条数与首个 ref→message；两者都没有时如实写「归因标记为 case_bug 但没有取值失败明细」而**不编明细**"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：case_bug —— 断言引用的取证路径取不到值", "tests/causes.test.mjs::causes：ref 前缀非法（结构性信号）也能识别，不依赖 failureCategory", "tests/causes.test.mjs::causes：case_bug 但找不到取值失败明细时如实说明，不编明细"]
        source: { file: "src/analysis/causes.ts", lines: "82-86, 224-246, 338-345" }
      - given: "failureCategory=product_bug 且至少一条硬失败断言的 actual !== undefined"
        when: "规则 ⑨"
        then: "给一条 **medium**（不冒充结论）：cause 明说「断言写错了但取到值」长得一模一样、需人看一眼；evidence 含首个 ref 期望词与值 + 实际值；nextStep 按有无 minimalRepro 分两种"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：product_bug + 期望/实际都在 —— medium（不冒充结论）"]
        source: { file: "src/analysis/causes.ts", lines: "248-261, 347-357" }
      - given: "failureCategory=product_bug 且失败断言的 actual 都是 undefined"
        when: "规则 ⑩"
        then: "给一条 **low**：既可能是取证没产出，也可能是被测对象没写；nextStep 要求先看 steps[].notes 里有没有这个键"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：product_bug 但实际值是 undefined —— low（两个方向都说得通）"]
        source: { file: "src/analysis/causes.ts", lines: "262-273" }
      - given: "排序、封顶与 rank"
        when: "对候选列表排序"
        then: "按 likelihood 权重 high(0) < medium(1) < low(2) 升序；**同权重保持规则顺序**（稳定排序，规则顺序本身就是依据强弱）；slice(0, MAX_CAUSES=3)；rank 从 1 连续编号"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：按可能性排序、最多 3 条、rank 连续", "tests/causes.test.mjs::causes：medium 排在 high 之后"]
        source: { file: "src/analysis/causes.ts", lines: "59-65, 275-296" }
      - given: "证据文本来源"
        when: "evidenceText(outcome)"
        then: "拼 error（非空时）+ 每个**失败**动作的 detail + 每个 releaseFailures[].error；不含 notes、不含断言 message（断言 message 由规则 ⑧ 单独读）"
        verdict: pass
        tests: []
        source: { file: "src/analysis/causes.ts", lines: "325-336" }
      - given: "硬失败断言的判定"
        when: "failingAssertions(outcome)"
        then: "`!ok && !soft`——软断言失败**不算证据**（与 runner 的硬失败判定一致）"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：软断言失败不算证据（与 runner 的硬失败判定一致）"]
        source: { file: "src/analysis/causes.ts", lines: "320-323" }
      - given: "证据字段超长"
        when: "clip(text, MAX_FIELD=200)"
        then: "先把空白折成单空格再 trim；超过 200 字符时截到 199 + `…`（报告里一条原因不该占满一屏）"
        verdict: pass
        tests: ["tests/causes.test.mjs::causes：证据超长要截断（报告里一条原因不该占满一屏）"]
        source: { file: "src/analysis/causes.ts", lines: "67-68, 369-373" }
      - given: "渲染为文本"
        when: "renderCauses(causes)"
        then: "空数组 → `可能原因：无（证据不足，不做推断——宁可不猜，也不拿猜测当噪声）`；非空 → 首行 `可能原因（按可能性排序）：`，每条 4 行（原因 / 可能性 / 依据 / 下一步）"
        verdict: pass
        tests: ['tests/causes.test.mjs::renderCauses：固定格式含"可能性/依据/下一步"', 'tests/causes.test.mjs::renderCauses：空集要如实说"不做推断"，不装样子']
        source: { file: "src/analysis/causes.ts", lines: "298-316" }
      - given: "可能性的中文标签"
        when: "LIKELIHOOD_LABEL"
        then: "high=高 / medium=中 / low=低（工具输出与报告共用）"
        verdict: pass
        tests: []
        source: { file: "src/analysis/causes.ts", lines: "52-57" }
    cleanup: none
    nonDeterministic:
      - field: "ProbableCause.evidence"
        reason: "内嵌 error / action.detail / 实际值，可能含绝对路径与临时目录名"
        reconcile: normalize-path
      - field: "ProbableCause.cause / nextStep"
        reason: "固定文案（不含时间与随机），同一证据下逐字稳定"
        reconcile: exact
    equivalence:
      rank: exact
      likelihood: exact
      cause: exact
      evidence: normalize-path
      nextStep: exact

  - id: BEH-ENGINE-ANALYSIS-003
    title: analysis-repro —— 最小复现指引（只写本仓真能跑的命令）
    atomic: analysis-repro
    status: active
    source:
      file: src/analysis/repro.ts
      lines: "13-54"
      symbols:
        - MinimalReproInput
        - buildMinimalRepro
        - buildMinimalReproForScenario
      tests:
        - tests/report-standard.test.mjs::buildMinimalRepro：不带失败步骤下标（只给整条场景复现）
        - tests/report-standard.test.mjs::buildMinimalRepro：带失败步骤下标（点出第几步 + 步骤名）
        - tests/report-standard.test.mjs::buildMinimalReproForScenario：从场景取步骤名，越界下标不炸
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "任意 caseId"
        when: "buildMinimalRepro({caseId})"
        then: "固定输出 4 行：`# 活宿主（单跑这一条）` + `testkit_run { \"ids\": [\"<caseId>\"] }    # 或 /testkit run <caseId>` + `# CI 轨（同样的场景数据，脱离活宿主）` + `node scripts/export-scenarios.mjs && node --test export/scenarios.test.mjs --test-name-pattern <caseId>`"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::buildMinimalRepro：不带失败步骤下标（只给整条场景复现）"]
        source: { file: "src/analysis/repro.ts", lines: "24-30" }
      - given: "给了 failingStepIndex"
        when: "buildMinimalRepro({caseId, failingStepIndex, failingStepName})"
        then: "额外追加一行 `# 失败步骤：第 <index+1> 步「<name>」（报告的「需要关注」段有它的期望 / 实际）`；failingStepName 缺省时空（不写「」）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::buildMinimalRepro：带失败步骤下标（点出第几步 + 步骤名）"]
        source: { file: "src/analysis/repro.ts", lines: "31-35" }
      - given: "从场景生成"
        when: "buildMinimalReproForScenario(scenario, failingStepIndex)"
        then: "caseId=scenario.id；failingStepIndex 有值时取 scenario.steps[index] 的名字（undefined 则不带 name）；**下标越界不炸**——step 为 undefined，name 字段整体不写"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::buildMinimalReproForScenario：从场景取步骤名，越界下标不炸"]
        source: { file: "src/analysis/repro.ts", lines: "44-53" }
      - given: "指引里不得出现本仓跑不起来的命令"
        when: "阅读输出"
        then: "只出现两条真通道（testkit_run / 或 /testkit run；scripts/export-scenarios.mjs + node --test --test-name-pattern）；**不写** `dsh-testkit run <id>` 之类本包没有 bin 的命令"
        verdict: pass
        tests: []
        source: { file: "src/analysis/repro.ts", lines: "1-11" }
    cleanup: none
    nonDeterministic:
      - field: "buildMinimalRepro 的输出"
        reason: "纯字符串拼接，只依赖入参 caseId / 下标 / 步骤名；无时间与随机"
        reconcile: exact
    equivalence:
      minimalRepro: "normalize-path（唯一变量是 caseId）"
---

# analysis —— 归因引擎（classify / causes / repro）

> **本模块是设计 §1.2 判定的「变更」**（`docs/REWRITE-DESIGN.md:62`）：
> `analysis/**`（causes / classify / repro）→ 目标「**Rust 归因引擎**」。
> 也就是说它要被**移出 TS**；而它在阶段 0 一度**一条 spec 都没有**。本文件补上这个缺口——
> 阶段 1 照 spec 写 Rust 归因引擎时，行为依据在这里。

命名依据：三个文件是三个可独立 pass/fail 的单元——**判定类别**（classify）、
**推断原因**（causes）、**生成复现指引**（repro）。它们在运行时各有独立消费者
（runner 用 classify；markdown 用 causes；runner 用 repro），故写成同一文件里的三个 atomic，
而不是三个文件（模块级信息 domain/module/revision 只需一份，且三者共用 5 类归因契约）。

## 类别数：任务书写「四个」，源码是 **5 类**（与 assert 的 17→16 同构，如实记录）

- `src/runtime/runlog.ts:17` 的枚举是 **5 个**：
  `FailureCategory = 'product_bug' | 'case_bug' | 'driver_bug' | 'env' | 'flaky'`。
- `schemas/run-report.schema.json:148` 的 `failureCategory` 枚举同样是这 5 个。
- `FAILURE_CATEGORY_LABEL`（`classify.ts:130-136`）给了 5 个中文标签。
- `tests/report-standard.test.mjs::FAILURE_CATEGORY_LABEL：5 类枚举齐全且非空` 守着"5 类"。
- 任务书/task-7 描述里写的 `product_bug / case_bug / env / flaky` **漏了 `driver_bug`**——
  这与 assert 的「文档说 17、实际 16」是同一类计数缺陷：**以源码为准，5 类**。

## `unknown` 为什么不是一个类别（REWRITE-METRICS A4）

A4 要求 `unknown` 占比 = 0（"分不出来不是一个类别，是一条缺陷"）。既有实现从**结构上**保证这一点：

1. 返回类型是 `FailureCategory | undefined`——`unknown` 根本不在类型里，写不出来；
2. 互斥且穷尽的判定表（`classify.ts:100-127`）：自上而下命中即 `return`，
   `errored` 的兜底是 `driver_bug`（`:114`）、`failed` 的兜底是 `product_bug`（`:126`），
   所以 **failed / errored 必然落进 5 类之一**，不存在"分不出来"的出口；
3. `undefined` 只用于 passed / skipped（`:101`）——那是"没有失败可归因"，
   不是"归因不出来"；报告侧也只在非 undefined 时写该字段（`runner.ts:565-566`）；
4. report schema 的枚举只列 5 类（`additionalProperties:false` 的那个对象里），
   写 `unknown` 会被 schema 拒绝。

> 因此"A4 的 unknown 占比 = 0"在既有实现里是**类型 + 兜底分支 + schema** 三重保证的，
> 不是靠约定。阶段 1 的 Rust 实现必须保留这三重保证（尤其是两个兜底分支）。

## analysis-classify

判定表（`classify.ts:4-18` 的头注是权威摘要，逐条对应实现在 observable 里）。

**两条刻意的边界**（正文必须保留，否则阶段 1 会把"能猜的"当成"能判的"）：

- **case_bug 只认结构性信号**（`:33-38`）：`ref` 前缀非法 / 取值失败。因为
  「断言写错了但能取到值」与「被测对象真的错了」在运行期**不可区分**，其余一律
  `product_bug`。归因是**分流建议**，不是判决。
- **预算超限并入 env**（`:20-31`）：BudgetExceeded 是"本次运行的条件不足"，
  既不是 product_bug 也不是 case_bug；按默认路径会掉进"没有失败断言 → driver_bug"，
  语义不对。分类契约是文档定死的 5 类，不为一个运行条件单开一档。

### 边界与已知缺陷

- **`ENV_PATTERNS` 含 `/node_modules/` 与 `/沙箱/`**（`classify.ts:59-60`）：很宽的正则，
  错误文本里只要出现这两个词就被判 `env`。误判方向是"把产品 bug 说成环境问题"。
- **`DRIVER_PATTERNS` 含 `/夹具/`**（`:73`）：夹具相关文本（含"夹具释放失败"）会被
  failed 分支的 `releaseFailures`（`:118`）先拦下，所以这条主要作用于 errored。
- **判定顺序敏感**：`flaky` 先于一切（`:105`），`releaseFailures` 先于环境特征（`:118`）。
  阶段 1 若调换顺序，同一 outcome 会得到不同类别——这是**行为等价性**要求的一部分。
- **判定表头注与实现的条数不完全一致**：头注列了 11 条（把"预算超限→env"单列），
  实现里它是 `ENV_PATTERNS` 的一条（`:61-63`），所以实际 return 点是 10 个。
  spec 以**实现**为准，头注的 11 条按"语义路径"理解。

## analysis-causes

纪律：**不编**（`causes.ts:13-23`）——只有能指回 outcome 具体证据的才给原因，
指不回去的一律不写。因此 passed / skipped / "失败但没有任何认得的证据"都返回 `[]`。

可能性（likelihood）的标定（`causes.ts:25-34`）：

| 档 | 含义 | 例子 |
|---|---|---|
| `high` | 证据直接就是原因本身 | 超时消息 / 预算超限 / 动作没跑通 / 多轮不一致 / ref 取不到值 |
| `medium` | 证据是事实，但到原因还需一步判断 | product_bug 的"期望 ≠ 实际"（不可与写错断言区分） |
| `low` | 至少两个方向都说得通，只能当排查起点 | actual 为 undefined（取证没产出 vs 被测对象没写） |

### 边界与已知缺陷

- **规则 ⑨ 与 ⑩ 互斥但不穷尽**：两条都以 `failureCategory === 'product_bug'` 为前提；
  若某 outcome 的 failureCategory 不是 product_bug 且不命中其它规则（例如手工构造的
  outcome），规则 ⑨/⑩ 都不触发 → 返回 `[]`。这是"不编"的正确表现，但对拍时不能把
  "空数组"当成 bug。
- **`describeExpectation` 依赖 `ASSERTION_WORDS` 的**副本**（`causes.ts:88-104`）**：
  它与 `classify.ts` / `cases/schema.ts` / `assert.ts` 的四个数组内容一致（都是 14 词），
  但是**各自独立维护**的副本。新增断言词时四处要同步——这是脆弱的重复真源，阶段 1 应收敛。
- **`hasKnownRefPrefix` 的前缀集合是硬编码的**（`causes.ts:86`：fx/case/env），
  与 `refs.ts` 的真源重复；注释已标注"真源在 src/runtime/refs.ts"。
- **规则 ⑧ 的证据行有"理论上走不到"的分支**（`:232-234`）：手工构造的 outcome
  可能出现 case_bug 但没有取值失败明细，此时如实说明而非编明细。

## analysis-repro

纪律：**只写本仓真的能执行的命令**（`repro.ts:4-6`）。本仓有两条真通道：
① 活宿主 `testkit_run` / `/testkit run <id>`；② CI 轨
`scripts/export-scenarios.mjs` → `node --test --test-name-pattern <id>`。

### 边界与已知缺陷

- **指引不含"怎么拿到失败步骤的期望 / 实际"**：它只说"报告的「需要关注」段有"，
  靠读者自己翻报告（`:34`）。对拍时这是确定性文本。
- **只支持单条场景**（入参是 caseId）：批次级复现（"这次跑了 12 条，帮我重跑这 12 条"）
  不在本模块；那属于 selection 面（`src/selection/**`，§1.2 未列 = unlisted）。
