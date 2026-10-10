---
domain: engine
module: runner
revision: 1

atomics:
  - id: BEH-ENGINE-RUNNER-001
    title: runner-execute —— 批量编排：选场景、串并分组、进度、汇总
    atomic: runner-execute
    status: active
    source:
      file: src/runtime/runner.ts
      lines: "73-210"
      symbols:
        - RunRequest
        - RunProgress
        - runScenarios
        - makeRunId
        - DEFAULT_TIMEOUT_MS
      tests:
        - tests/scenario-run.test.mjs::端到端：cases/ 下的全部场景在 headless 宿主里按要求通过或跳过
        - tests/scenario-run.test.mjs::端到端：场景互不污染（逐条跑与批量跑结果一致）
        - tests/isolation.test.mjs::并发 vs 串行：safe 场景逐条 verdict 与断言 ok 完全一致（真实 driver）
        - tests/isolation.test.mjs::并发 vs 串行：exclusive 场景被夹在并发组之间时，顺序与结论都不变
        - tests/policy-gate.test.mjs::runScenarios：放行写 policy.allowed=true 与 usage；不传 policy 则完全不启用闸门
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "未给 filter"
        when: "registry 里混有 active / draft / retired 场景"
        then: "默认只选 status 为 active 的（filter 缺省 = {status:['active']}），并额外剔除 status==='retired' 的；选中集合保持 registry 顺序"
        verdict: pass
        tests: ["tests/scenario-run.test.mjs::端到端：按 kind 选择器也能选中对应场景"]
        source: { file: "src/runtime/runner.ts", lines: "131-133" }
      - given: "runId 生成"
        when: "makeRunId(new Date('2026-10-09T23:36:22Z'))"
        then: "形如 2026-10-09T23-36-22_ab12：ISO 串去掉毫秒与 Z、冒号换短横、尾接 4 位 base36 随机"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "118-123" }
      - given: "默认并发度"
        when: "未传 parallelLimit"
        then: "parallelLimit = max(1, floor(1)) = 1 → 全串行，按选中顺序逐个 await"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "129, 164-168, 175-180" }
      - given: "parallelLimit > 1 且场景声明 parallel: safe"
        when: "连续 safe 段按 limit 切组"
        then: "safe 组内 Promise.all 并发但**保序**（结果顺序 = 选中顺序）；exclusive 永远单独成 serial 组"
        verdict: pass
        tests: ["tests/isolation.test.mjs::并发 vs 串行：safe 场景逐条 verdict 与断言 ok 完全一致（真实 driver）"]
        source: { file: "src/runtime/runner.ts", lines: "164-181" }
      - given: "外部取消信号在批次中途 abort"
        when: "signal.aborted === true"
        then: "跳出剩余组/剩余场景，**已完成的 outcomes 原样保留**（不补空、不报错）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "171, 177" }
      - given: "进度回调 onProgress 已提供"
        when: "批次开始 / 单条开始 / 单条结束 / 批次结束"
        then: "依次发 run-start{total}、case-start{caseId,index,total}、case-end{caseId,verdict,index,total}、run-end{totals}；index 是**选中序列里的位置**（并发时不是完成序）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "110-114, 136-162, 208" }
      - given: "totals 汇总"
        when: "outcomes 非空 / 为空"
        then: "非空时 tallyTotals(outcomes)（五个计数按 verdict 累加，total=cases.length）；为空时 emptyTotals() 全 0"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "198" }
      - given: "省略 RunRequest.policy"
        when: "runScenarios 汇总"
        then: "不写 policySnapshot（库语义：省略闸门不改变既有行为，386 条既有测试不受影响）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::runScenarios：放行写 policy.allowed=true 与 usage；不传 policy 则完全不启用闸门"]
        source: { file: "src/runtime/runner.ts", lines: "200-201" }
      - given: "传入 policy"
        when: "runScenarios 汇总"
        then: "policySnapshot(policy) 落进 summary（allowModel / allowLowCost / sandbox 深拷贝快照，策略对象后续可变但不污染历史报告）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/runtime/runner.ts", lines: "200-201" }
      - given: "selection 取证"
        when: "入口算好 SelectionRecord 并传入"
        then: "原样落进 summary.selection（runner 只负责落盘，不自算）；未传则不写该字段"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "106-107, 202-203" }
      - given: "execution 取证"
        when: "parallelLimit > 1"
        then: "写 execution = { parallel: 'limited' | 'off', limit, safe: 声明 safe 的场景数, exclusive: 其余 }；parallel 为 'off' 的条件是 safeCount===0"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "183-189, 205" }
    cleanup: none
    nonDeterministic:
      - field: "RunSummary.runId"
        reason: "生成时含挂钟时间与 Math.random 后缀"
        reconcile: "normalize:<RUNID>"
      - field: "RunSummary.startedAt / finishedAt"
        reason: "挂钟时间（ISO 串）"
        reconcile: "normalize:<TS>"
      - field: "RunSummary.cases[].durationMs"
        reason: "挂钟时间"
        reconcile: "interval"
      - field: "RunSummary.casesDir"
        reason: "绝对路径（随检出位置变化）"
        reconcile: "normalize:<CASESDIR>"
    equivalence:
      totals: exact
      cases[].id: exact
      cases[].verdict: exact
      execution: exact
      selection: exact
      policySnapshot: exact

  - id: BEH-ENGINE-RUNNER-002
    title: runner-run-case —— 单条场景的生命周期与 verdict 判定顺序
    atomic: runner-run-case
    status: active
    source:
      file: src/runtime/runner.ts
      lines: "212-575"
      symbols:
        - runOne
        - RunOneDeps
        - hasHardFailure
        - firstFailingStep
        - involvedDriverCosts
        - sandboxViolation
        - setupKindsOf
        - mergeSteps
      tests:
        - tests/skip-semantics.test.mjs::setup 阶段缺前置条件 → skipped（外部 fixture 没下载不是失败）
        - tests/skip-semantics.test.mjs::act 阶段的 SkipCase → 同样 skipped，且已跑过的取证保留
        - tests/skip-semantics.test.mjs::负向对照：act 抛普通异常仍然是 failed（修复不是「什么都跳过」）
        - tests/policy-gate.test.mjs::runScenarios：high 档被拒 → skipped + skipReason + policy，且不是 failed
        - tests/policy-gate.test.mjs::runScenarios：预算超限 → failed，error 带 BudgetExceeded 信息并保留已跑步骤
        - tests/policy-gate.test.mjs::runScenarios：repeat 抖动 → rounds=[true,false] 且 failureCategory=flaky
        - tests/policy-gate.test.mjs::沙箱：allowShell / denyWriteCommands / allowFileWrite 是显式开关，命中即整条 skipped
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "scenario.fixtures 非空且 RunRequest.fixtures 已给"
        when: "runOne 开始"
        then: "先 applyScenarioFixtures（**在所有判定之前**）；夹具缺失 / 版本不匹配 → skipped + skipReason + fixtures 引用清单，绝不用错夹具硬跑"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "247-267" }
      - given: "scenario.kind 没有对应 driver"
        when: "runOne 判定"
        then: "verdict=errored，error 说明 kind=<kind> 的 driver 尚未实现；steps=[]"
        verdict: fail
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "277-281" }
      - given: "setup 里出现某个 kind 键但没有对应 driver"
        when: "setupKindsOf 收集参与 driver"
        then: "verdict=errored（组合场景缺 driver 不能静默降级）；参与集合 = 主 kind ∪ setup 的 kind 键，按 SCENARIO_KINDS 固定顺序"
        verdict: fail
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "283-296, 847-853" }
      - given: "闸门启用（policy 已传）且场景被拒"
        when: "evaluateScenario 返回 allowed=false"
        then: "verdict=skipped + skipReason=decision.reason + policy=decision（「没跑」≠「跑挂了」）；判定顺序在能力判定**之前**"
        verdict: skip
        tests: ["tests/policy-gate.test.mjs::runScenarios：high 档被拒 → skipped + skipReason + policy，且不是 failed"]
        source: { file: "src/runtime/runner.ts", lines: "298-322" }
      - given: "参与 driver 没有声明 cost()"
        when: "involvedDriverCosts 汇总"
        then: "按保守默认档 high 处理，并把 decision.source 改成 'default'；缺 driver 的 kind 直接跳过（留给运行时报 engine 错，不伪装成成本问题）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "316-317, 599-624" }
      - given: "沙箱预检命中任一步动作"
        when: "sandboxViolation 扫描 scenario.steps 的 act"
        then: "整条 case 预检即 skipped（不留「部分副作用 + 半份证据」）；reason 含第 N 步与步骤名；setup.resource 存在时 networkIntercepted=true 放行 resource 动作"
        verdict: skip
        tests: ["tests/policy-gate.test.mjs::沙箱：allowShell / denyWriteCommands / allowFileWrite 是显式开关，命中即整条 skipped"]
        source: { file: "src/runtime/runner.ts", lines: "324-329, 632-646" }
      - given: "参与 driver 的 requires ∪ scenario.runtime.requires 里有宿主缺失的能力"
        when: "能力判定"
        then: "verdict=skipped + skipReason 为 宿主缺少能力：<列表>（多个用逗号连接）；policy 字段若已有判定则一并带上"
        verdict: skip
        tests: ["tests/scenario-run.test.mjs::端到端：cases/ 下的全部场景在 headless 宿主里按要求通过或跳过"]
        source: { file: "src/runtime/runner.ts", lines: "332-343" }
      - given: "隔离上下文创建抛错"
        when: "createIsolationContext 失败"
        then: "note('isolationError', ...) 留痕；**不改变 verdict**（既不是授权问题也不是产品问题）；isolation 保持 undefined，残留检测跳过"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "350-362, 516-519" }
      - given: "per-case 超时"
        when: "deps.timeoutMs 到期"
        then: "timedOut=true 且 abort；最终 verdict=failed + error 为 超时（> <N>ms）——**超时记 failed，区别于 errored**；默认超时 30000ms，可被 scenario.runtime.timeoutMs 覆盖"
        verdict: fail
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "116, 150, 369-372, 467-469" }
      - given: "verdict 判定顺序（正常返回路径）"
        when: "跳过 / 预算超限 / 超时 / 有硬失败断言 同时可能为真"
        then: "顺序固定：已 skipped 的最高优先（不被后续取证覆盖）→ budgetError 记 failed → timedOut 记 failed → hasHardFailure 记 failed → 否则保持 passed"
        verdict: pass
        tests: ["tests/skip-semantics.test.mjs::act 阶段的 SkipCase → 同样 skipped，且已跑过的取证保留"]
        source: { file: "src/runtime/runner.ts", lines: "461-472" }
      - given: "catch 分支"
        when: "抛出 SkipCase / BudgetExceeded / 其它异常（含超时）"
        then: "SkipCase → skipped + skipReason；BudgetExceeded → failed + error 带 name:message；timedOut → failed + 超时消息；其它 → errored + <name>: <message>"
        verdict: fail
        tests: ["tests/skip-semantics.test.mjs::负向对照：act 抛普通异常仍然是 failed（修复不是「什么都跳过」）"]
        source: { file: "src/runtime/runner.ts", lines: "473-486" }
      - given: "runtime.repeat > 1"
        when: "多轮执行"
        then: "每轮独立记 rounds.push(!timedOut && !hasHardFailure)；SkipCase 的那一轮从 rounds 弹出（跳过不是「这一轮没通过」，避免 flaky 误判）；未跑完的轮补 false（verdict≠skipped 且已跑过至少一轮时）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::runScenarios：repeat 抖动 → rounds=[true,false] 且 failureCategory=flaky"]
        source: { file: "src/runtime/runner.ts", lines: "269, 389-390, 438-448, 487-492" }
      - given: "多轮断言合并"
        when: "round > 1"
        then: "mergeSteps 把同名步骤的断言 push 到一起、durationMs 累加，保留全部轮次判定；rounds 字段只在 length>1 时写"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "439, 548, 902-915" }
      - given: "每轮结束"
        when: "round 循环尾部"
        then: "fixture.release() 即拆夹具（保证下一轮环境干净）；failures 累加进 releaseFailures；budgetError 出现即 break（继续跑只把账单做大）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "450-458" }
      - given: "finally 收尾（无论成败）"
        when: "runOne 退出前"
        then: "① clearTimeout + 摘掉外部 abort 监听；② 兜底 fixture.release()（幂等）；③ teardown **逆序**调用 setupDrivers（单个失败忽略、不覆盖既有判定）；④ 残留检测 detectLeftovers(isolation) **在 dispose 之前**（先删再查会永远「没有残留」）；⑤ 记录 cleanup 跨度"
        verdict: pass
        tests: ["tests/isolation.test.mjs::detectLeftovers：干净的隔离上下文没有任何残留"]
        source: { file: "src/runtime/runner.ts", lines: "493-522" }
      - given: "usage 记账"
        when: "闸门启用（policy 已传）"
        then: "usage = new UsageMeter()，传给 DriverContext；outcome.usage = usage.snapshot()；**闸门未启用时 usage 为 undefined（不许悄悄记账）**"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记"]
        source: { file: "src/runtime/runner.ts", lines: "374-382, 551" }
      - given: "cleanup 取证写出条件"
        when: "releasedNotes 非空 或 leftovers 非空"
        then: "写 CaseOutcome.cleanup = { released: [...new Set(releasedNotes)], leftovers }；两者都空时**不写该字段**（避免每份报告被空记录淹没）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "552-560" }
      - given: "失败归因与最小复现"
        when: "outcome 最终对象构造完成"
        then: "classifyCase(outcome) 在**最终对象**上算（要读 rounds/policy/releaseFailures），非 undefined 才写 failureCategory；minimalRepro 只写给 failed / errored（通过的不需要，跳过的原因已在 skipReason）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：判定表 11 条路径逐条覆盖"]
        source: { file: "src/runtime/runner.ts", lines: "563-572" }
      - given: "trace 跨度"
        when: "runOne 任何路径结束"
        then: "spans 记录 setup/act/assert/cleanup 阶段（偏移相对 case 起点），并**无条件**补一条 phase:'case' 的整条跨度；因此每个 CaseOutcome 的 trace 至少 1 条 → 该字段几乎恒存在（见缺陷 R-1）"
        verdict: pass
        tests: ["tests/trace.test.mjs::renderTraceJson：live —— 形态与冻结契合一字不差"]
        source: { file: "src/runtime/runner.ts", lines: "402-411, 521-532, 549" }
      - given: "hasHardFailure 的软断言语义"
        when: "步骤里有 ok=false 且 soft=true 的断言"
        then: "不算硬失败（!a.ok && !a.soft），不改变 verdict；firstFailingStep 同样只认硬失败"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：软断言失败不算硬失败（不改变 verdict 的证据）"]
        source: { file: "src/runtime/runner.ts", lines: "577-586" }
    cleanup: registered
    nonDeterministic:
      - field: "CaseOutcome.durationMs"
        reason: "挂钟时间"
        reconcile: "interval"
      - field: "CaseOutcome.trace[].startMs / durationMs"
        reason: "挂钟时间（相对 case 起点的偏移）"
        reconcile: "interval"
      - field: "CaseOutcome.error / skipReason / releaseFailures[].error"
        reason: "内嵌绝对路径、临时目录名与错误原文"
        reconcile: normalize-path
      - field: "CaseOutcome.notes 的路径类键"
        reason: "driver 写入的 tmpdir / 绝对路径随运行变化"
        reconcile: normalize-path
    equivalence:
      verdict: exact
      rounds: exact
      failureCategory: exact
      policy: exact
      usage: lower-bound
      cleanup: sorted-set
      trace: interval

  - id: BEH-ENGINE-RUNNER-003
    title: runner-run-steps —— 步骤执行、动作分派与取证增量
    atomic: runner-run-steps
    status: active
    source:
      file: src/runtime/runner.ts
      lines: "648-933"
      symbols:
        - runSteps
        - RoundSteps
        - BudgetGuard
        - performAction
        - actionOwnerKind
        - actionKind
        - sleep
      tests:
        - tests/step-notes.test.mjs::每一步都有自己的取证增量（早期步骤不被后续覆盖）
        - tests/step-notes.test.mjs::增量是「差异」而不是整份快照（否则 run.json 会随步骤膨胀）
        - tests/scenario-run.test.mjs::端到端：TK-0003 的 guard 真的拦下了执行（工具本体未运行）
        - tests/isolation.test.mjs::releaseStepNotes：异步 disposer 会被 await（不会退回「步骤结束没拆掉」）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "步骤执行顺序与命名"
        when: "ctx.scenario.steps 逐条执行"
        then: "按书写顺序执行；step.name 缺省时显示为 step <i+1>"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "691-697" }
      - given: "步骤先入列再执行"
        when: "步骤一开始"
        then: "outcome 对象先 push 进 steps，之后被就地改写（断言 / notes / 耗时）；中途 SkipCase 跳出时**已跑过的证据不丢**"
        verdict: pass
        tests: ["tests/skip-semantics.test.mjs::act 阶段的 SkipCase → 同样 skipped，且已跑过的取证保留"]
        source: { file: "src/runtime/runner.ts", lines: "702-704" }
      - given: "步骤有 act 且执行成功"
        when: "performAction 正常返回"
        then: "写 action = { kind: <标签>, ok: true }；并记一条 phase:'act' 且 ok=true 的跨度"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "706-726" }
      - given: "步骤 act 抛错"
        when: "performAction 抛异常"
        then: "写 action = { kind, ok:false, detail: <name>: <message> }；普通异常继续走断言阶段（该步最终是 failed）；**SkipCase 例外**——记下 action.ok=false 取证后 return { steps, skip }，整条场景判 skipped"
        verdict: fail
        tests: ["tests/skip-semantics.test.mjs::act 阶段的 SkipCase → 同样 skipped，且已跑过的取证保留", "tests/skip-semantics.test.mjs::负向对照：act 抛普通异常仍然是 failed（修复不是「什么都跳过」）"]
        source: { file: "src/runtime/runner.ts", lines: "711-726" }
      - given: "断言循环"
        when: "step.expect 逐条求值"
        then: "resolveRef（fx/case/env）→ evaluateAssertion → AssertionOutcome{ assertion, ok: evaluated.ok && found, actual, message: found ? evaluated.message : reason, soft }；**顺序即书写顺序**（不排序）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "728-744" }
      - given: "断言跨度记录条件"
        when: "step.expect 非空"
        then: "记一条 phase:'assert' 跨度，ok = 该步无硬失败；空 expect 的步骤**不记** 0ms 假跨度"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "745-754" }
      - given: "步骤取证增量"
        when: "本步执行前后比较 fixture.snapshot()"
        then: "只记**新出现或值变化**（Object.is 不等）的 key 到 step.notes；无变化则不写 notes 字段；case 层 notes 仍保留最终值"
        verdict: pass
        tests: ["tests/step-notes.test.mjs::每一步都有自己的取证增量（早期步骤不被后续覆盖）", "tests/step-notes.test.mjs::增量是「差异」而不是整份快照（否则 run.json 会随步骤膨胀）"]
        source: { file: "src/runtime/runner.ts", lines: "699-700, 756-764" }
      - given: "步骤级 cleanup（releaseNotes）"
        when: "本步断言与取证完成后"
        then: "releaseStepNotes(fixture, releaseNotes) 幂等、不抛穿；实际释放成功的键累加进 cleanupSink（去重后进 CaseOutcome.cleanup.released）；整条场景结束的兜底释放不受影响"
        verdict: pass
        tests: ["tests/isolation.test.mjs::releaseStepNotes：异步 disposer 会被 await（不会退回「步骤结束没拆掉」）"]
        source: { file: "src/runtime/runner.ts", lines: "768-777" }
      - given: "每步之后的预算对账"
        when: "budget guard 已启用"
        then: "checkBudget 超限即 return { steps: 已跑步骤, budgetError }（**不吞现场证据**）；其它异常继续抛"
        verdict: fail
        tests: ["tests/policy-gate.test.mjs::runScenarios：预算超限 → failed，error 带 BudgetExceeded 信息并保留已跑步骤"]
        source: { file: "src/runtime/runner.ts", lines: "779-788" }
      - given: "performAction 对 wait 动作"
        when: "action 含 wait"
        then: "await sleep(ms, ctx.signal)；signal 已 abort 或 sleep 中 abort 则 reject(new Error('aborted'))"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "806-809, 917-933" }
      - given: "performAction 对 emit 动作"
        when: "action 含 emit 且无 driver 声明 act"
        then: "只 host.log('debug', ...) 记录，不报错（事件注入是 Phase 2 能力）；有 driver 则调 d.act"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "814-822" }
      - given: "performAction 的三种失败"
        when: "owner 未定义 / 无对应 driver / driver 未实现 act"
        then: "分别抛 无法判断动作属于哪个 kind：<标签> / 动作 <标签> 需要 kind=<owner> 的 driver，但它尚未实现 / kind=<owner> 的 driver 未实现 act，无法执行 <标签>"
        verdict: fail
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "824-833" }
      - given: "动作归属与标签"
        when: "actionOwnerKind / actionKind"
        then: "owner 用于注册表键（tool/prompt/llm/interaction/session/resource/agent/ui/shell/file/fs/compaction）；标签给人看（tool:<name>、shell:<argv0>、file:read:<path>、fs:<首个键>、compaction:<首个键>、wait:<ms>ms、emit:<event>）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "861-900" }
    cleanup: registered
    nonDeterministic:
      - field: "StepOutcome.durationMs"
        reason: "挂钟时间"
        reconcile: "interval"
      - field: "StepOutcome.action.detail / AssertionOutcome.message"
        reason: "内嵌路径与错误原文"
        reconcile: normalize-path
      - field: "StepOutcome.notes 的路径类键"
        reason: "driver 写入的临时目录 / 绝对路径"
        reconcile: normalize-path
    equivalence:
      steps[].name: exact
      steps[].action: exact
      steps[].assertions: exact
      steps[].notes: sorted-set
---

# runner —— 执行引擎（编排、单条生命周期、步骤）

本文件覆盖旧实现最大的文件 `src/runtime/runner.ts`（35,876 字节 / 933 行）。按
[REWRITE-DESIGN.md §1.2](../../../../docs/REWRITE-DESIGN.md) line 55，它的去向是
「Rust `TestExecutor` + TS 编排」，迁移性质是**变更（拆开）**。本 spec 按源码事实把它拆成三个
原子，命名依据如下：

| atomic | 源码承担物 | 为什么它是独立原子 |
|---|---|---|
| `runner-execute` | `runScenarios` + `RunRequest` | 批次级：选场景 / 并发分组 / 进度 / 汇总。可独立 pass/fail（"这批跑了哪些、怎么排"） |
| `runner-run-case` | `runOne` | 单条级：闸门 → 能力 → 隔离 → 步骤 → verdict → 回收。可独立 pass/fail（"这条为什么是这个 verdict"） |
| `runner-run-steps` | `runSteps` + `performAction` | 步骤级：动作分派 / 断言循环 / 取证增量 / 步骤级清理。可独立 pass/fail（"这一步做了什么"） |

设计 §3.2 的 `TestScheduler`（submit / wait / cancel / status / shutdown）在既有实现里**没有对应物**：
`runScenarios` 是"一次调用跑完一批"的整体函数，没有句柄、没有 cancel 语义（只有外部 `AbortSignal`）。
按 spec 纪律，不为不存在的行为落条目；阶段 1 的句柄/取消面由设计文档承担。

## runner-execute

批次编排。**默认串行**（活宿主状态共享，串行结果最可预测——文件头注 line 6-7），
只有显式 `parallel: safe` 的场景才并发；`limit <= 1` 时全串行（等于关掉并发）。

并发语义的完整规矩在 `src/isolation/pool.ts`（见 `isolation.md` 的 `isolation-pool`）：
组内并发但 Promise.all **保序**，所以"并发跑出的结果"与"串行跑出的结果"逐条对齐；
exclusive（含缺省）永远独占。

### 边界与已知缺陷

- **runId 含随机后缀**：同一毫秒内两次调用也会不同（`makeRunId` 的 4 位随机）。
- **开始/结束时间在 `runScenarios` 入口与末尾各取一次**（line 135, 194），不是各 case 的累加。
- **`signal.aborted` 只检查组边界与场景边界**（line 171, 177）：已进入 `runOne` 的场景靠
  `deps.signal` 的 abort 监听传导（`runner.ts:366-367`），不会被硬杀。

## runner-run-case

单条场景的完整生命周期。**判定顺序是行为的一部分**，重构时必须逐字保持：

```text
夹具应用 → 缺 driver? errored → 成本闸门? skipped → 沙箱预检? skipped
        → 能力判定? skipped → 建隔离上下文 → setup → steps
        → verdict 判定（skipped > budgetError(failed) > timedOut(failed) > hardFailure(failed) > passed）
        → finally：兜底 release → teardown 逆序 → 残留检测（在 dispose 之前）→ dispose
```

三条"顺序即语义"的注释在源码里写得很明确，重构时不能调换：

1. **夹具应用放在所有判定之前**（line 247-251）——否则"按 A 判定、按 B 执行"。
2. **成本闸门放在能力判定之前**（line 300-301）——能力缺失只是"这台宿主跑不了"，
   成本拒绝是"这次运行没被授权"，后者更根本。
3. **残留检测放在 dispose 之前**（line 512-515）——dispose 是兜底删除不是检测手段；
   先删再查会永远「没有残留」，检查就成了装饰。

### 边界与已知缺陷

**缺陷 R-1（跨模块，与 report 同源）：`CaseOutcome.trace` 不在 run-report schema 里。**
`runOne` 结尾**无条件** push 一条 `phase:'case'` 跨度（line 526-532），所以
`spans.length >= 1`，`...(spans.length === 0 ? {} : { trace: spans })`（line 549）对
**每一条** case 都会写 `trace`。而 `schemas/run-report.schema.json` 的 `caseOutcome` 是
`additionalProperties: false`，其 properties 列表（line 98-173）**没有 `trace`**。
后果：任何**跑到底**（非早退）的 case 都会在 `run.json` 里带 `trace`，被自己的 schema 判为「不允许多余字段 trace」。
**实证（2026-10-11 本机）**：跑 `tests/scenario-run.test.mjs` 后生成的
`runs/2026-10-10T16-04-27_vjd7/run.json` 中 `cases[0]`（TK-0001，verdict=passed）含 6 条
`trace` 跨度（5 条阶段跨度 + 1 条 `phase:'case'`），而 schema 的 `caseOutcome` 是
`additionalProperties:false` 且 properties 无 `trace`。
现有测试没抓到，因为 `tests/report-standard.test.mjs` 用手写 `SUMMARY` 夹具且**不含 trace**。
早退路径（夹具 skip / 缺 driver / 闸门拒绝 / 沙箱拒绝 / 能力缺失）直接 `return finishing(...)`，
不经过 line 526 的 case 跨度 push，故那些 case 没有 `trace`。
详见 `report.md` 的缺陷 RP-1。

**缺陷 R-2：`sandboxViolation` 只扫字面 `step.act`，不扫 `use:` 片段展开后的动作。**
`runner.ts:632-646` 遍历 `scenario.steps` 的 `step.act`；若场景用 `use:` 片段，预检时
`step.act` 为 undefined → 跳过检查。片段是否在进 runner 前已展开，取决于入口
（`registry/loader.ts` 的展开时机）——本条目只记录事实：**runner 自身不做展开**。

**缺陷 R-3：`setup` 失败后的 rounds 补齐条件有限。**
`while (rounds.length < repeat) rounds.push(false)`（line 490-492）只在
`verdict !== 'skipped' && rounds.length > 0` 时执行；若第 1 轮在 setup 阶段抛普通异常，
`rounds` 仍为空数组，不补 false → `rounds` 字段不写（line 548 `length > 1` 才写）。这是
"第 1 轮就炸"与"第 2 轮才炸"在报告里的形态差异，对拍时要注意。

**边界：`repeat` 与 `cleanup` 的交互。** 每轮结束即 `fixture.release()`（line 451），
所以 `repeat > 1` 时夹具是**每轮重建**的；步骤级 `releaseNotes`（line 773-777）也在每轮内生效。

## runner-run-steps

步骤执行与动作分派。两条容易忽略的纪律：

1. **动作的 driver 按"动作形状"分派，不按 `scenario.kind`**（line 794-798）。
   组合场景里 setup 的 kind 与 act 的 kind 可以不同（例如 `kind: tool` 但某步 `act: {shell: ...}`）。
2. **先入列再执行**（line 702-704）：`outcome` 提前 push，中途 `SkipCase` 跳出时已跑证据不丢。

### 边界与已知缺陷

- **动作阶段异常不改变 action 的"取证"性质**：`action.ok=false` 只是证据；整条 verdict 由
  `hasHardFailure` / 超时 / SkipCase 决定（line 461-472）。所以"动作失败但断言全过"的步骤
  最终仍可能 passed——这是刻意的（动作失败通常已由断言表达）。
- **`actionKind` 对 `file` 动作的分支**：`runner.ts:887-894` 判 `'read' in spec` 而非
  `'read' in action`（注释 line 888-889 记：写成后者会永远 false，报告里显示
  `file:glob:undefined`，"真踩过"）——这是已修缺陷，spec 只记当前语义。
- **`emit` 无 driver 时静默降级为日志**（line 819-821）：报告里不会有 action 记录，
  只能从 host log 看到。对拍时该步的 `steps[].action` 缺失属预期。
- **`sleep` 的 abort 语义**：abort 监听在 resolve 分支里移除（line 928），reject 分支里
  不移除（line 924 的 `onAbort` 不 removeEventListener），一次 abort 后监听器仍挂着——
  单次 case 内无实际影响（`{once:true}`），但这是泄漏形式上的瑕疵。
