---
domain: engine
module: policy
revision: 1

atomics:
  - id: BEH-ENGINE-POLICY-001
    title: policy-evaluate —— 成本闸门判定：三档成本 × 允许位 × 预算收紧
    atomic: policy-evaluate
    status: active
    source:
      file: src/executor/policy.ts
      lines: "126-371"
      symbols:
        - ExecutionPolicy
        - PolicyOptions
        - DEFAULT_POLICY
        - resolvePolicy
        - policySnapshot
        - COST_LABEL
        - COST_RANK
        - maxCost
        - tightenLimit
        - evaluateScenario
      tests:
        - tests/policy-gate.test.mjs::判定表：none 永远放行，high 默认拒，low 看 allowLowCost
        - tests/policy-gate.test.mjs::判定表：场景显式 cost 覆盖 driver 默认，source 如实标注
        - tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络
        - tests/policy-gate.test.mjs::预算上限：场景 budget 只能比策略更紧，0 = 不限
        - tests/policy-gate.test.mjs::runScenarios：high 档被拒 → skipped + skipReason + policy，且不是 failed
        - tests/policy-gate.test.mjs::runScenarios：放行写 policy.allowed=true 与 usage；不传 policy 则完全不启用闸门
        - tests/policy-gate.test.mjs::工具面：testkit_run 总是带闸门，且工具参数只能收紧（模型不能给自己开模型权限）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "默认策略（DEFAULT_POLICY）"
        when: "读默认值"
        then: "cost.allowModel=false（默认不真调模型，P0 落点）；allowLowCost=true（本地副作用默认放行，避免既有基线平白多出一片 skipped）；maxModelCalls=0 / maxTokens=0（不限）；recordReplay=true；approval.requireHumanApproval=false"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "152-193" }
      - given: "resolvePolicy 的合并语义"
        when: "resolvePolicy(options)"
        then: "逐项用 `??` 取默认（**不是 `||`**：0 是合法值 = 不限，不能被当成「没给」）；allowedCommands / allowedPaths / denyWriteCommands / approvers 每次都**拷贝新数组**，调用方共享可变态不影响已建策略"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "195-230" }
      - given: "policySnapshot 的解耦"
        when: "policySnapshot(policy) 后改动原策略对象"
        then: "快照不变（sandbox 内的三个数组是拷贝）——报告要回答的是「当时为什么这么判」，引用会让历史报告被污染"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "232-249" }
      - given: "cost 档位解析"
        when: "evaluateScenario({scenarioCost, driverCost})"
        then: "最终 cost = scenarioCost ?? driverCost（场景显式声明优先）；source = scenarioCost 为 undefined 时 'driver'，否则 'scenario'；`default` 由 runner 在「参与 driver 未声明 cost()」时补记，本纯函数**不会**返回它"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::判定表：场景显式 cost 覆盖 driver 默认，source 如实标注"]
        source: { file: "src/executor/policy.ts", lines: "292-303" }
      - given: "cost === 'none'"
        when: "evaluateScenario"
        then: "**永远放行**（allowed=true），reason 含「纯离线，任何配置下都允许」"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::判定表：none 永远放行，high 默认拒，low 看 allowLowCost"]
        source: { file: "src/executor/policy.ts", lines: "310-320" }
      - given: "cost === 'low' 且 policy.cost.allowLowCost 为 true"
        when: "evaluateScenario"
        then: "放行；reason 含「本地副作用已允许（cost.allowLowCost=true）」"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::判定表：none 永远放行，high 默认拒，low 看 allowLowCost"]
        source: { file: "src/executor/policy.ts", lines: "322-333" }
      - given: "cost === 'low' 且 policy.cost.allowLowCost 为 false"
        when: "evaluateScenario"
        then: "**拒绝**（allowed=false）；reason 含 cost.allowLowCost=false 与放权方式 `--allow-low-cost`（或工具参数 allowLowCost）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::判定表：none 永远放行，high 默认拒，low 看 allowLowCost"]
        source: { file: "src/executor/policy.ts", lines: "334-344" }
      - given: "cost === 'high' 且 policy.cost.allowModel 为 true"
        when: "evaluateScenario"
        then: "放行；reason 含「真实模型调用已显式允许（cost.allowModel=true）」"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::判定表：none 永远放行，high 默认拒，low 看 allowLowCost"]
        source: { file: "src/executor/policy.ts", lines: "347-358" }
      - given: "cost === 'high' 且 policy.cost.allowModel 为 false（默认）"
        when: "evaluateScenario"
        then: "**拒绝**；reason 含 cost.allowModel=false（默认）与放权方式 `--allow-model`，并声明「这不是失败，是没跑」"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::判定表：none 永远放行，high 默认拒，low 看 allowLowCost", "tests/policy-gate.test.mjs::runScenarios：high 档被拒 → skipped + skipReason + policy，且不是 failed"]
        source: { file: "src/executor/policy.ts", lines: "360-370" }
      - given: "上限收紧"
        when: "tightenLimit(policy 上限, 场景 budget 上限)"
        then: "0 = 不限；两边都给正数时取 **min**；上界 <=0 返回 requested，requested <=0 返回上界。即「场景自带的 budget 只能比策略更紧，不能放宽」"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::预算上限：场景 budget 只能比策略更紧，0 = 不限"]
        source: { file: "src/executor/policy.ts", lines: "267-277, 305-308" }
      - given: "档位取最高"
        when: "maxCost(a, b)"
        then: "按 none(0) < low(1) < high(2) 取更贵的一档"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "259-265" }
      - given: "闸门省略时的库语义"
        when: "runScenarios 未传 policy"
        then: "**完全不启用闸门**：不判定、不记账、不写 policySnapshot；插件面（testkit_run / client bridge / /testkit run）则一律显式构造并传入"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::runScenarios：放行写 policy.allowed=true 与 usage；不传 policy 则完全不启用闸门", "tests/policy-gate.test.mjs::工具面：testkit_run 总是带闸门，且工具参数只能收紧（模型不能给自己开模型权限）"]
        source: { file: "src/executor/policy.ts", lines: "126-143" }
    cleanup: none
    nonDeterministic:
      - field: "PolicyDecision.reason"
        reason: "文本内嵌档位标签与来源标注；同一 policy 配置下稳定，但随配置变化"
        reconcile: exact
      - field: "PolicySnapshot.sandbox.timeoutMs"
        reason: "配置值（缺省 30000），不是挂钟测量值"
        reconcile: exact
    equivalence:
      allowed: exact
      cost: exact
      source: exact
      limits: exact
      policySnapshot: exact

  - id: BEH-ENGINE-POLICY-002
    title: policy-budget —— 用量记账（下界语义）与预算对账
    atomic: policy-budget
    status: active
    source:
      file: src/executor/policy.ts
      lines: "373-433"
      symbols:
        - UsageMeter
        - BudgetExceeded
        - checkBudget
        - recordModelCall
        - recordTokens
        - snapshot
      tests:
        - tests/policy-gate.test.mjs::checkBudget：0 = 不限；超限抛 BudgetExceeded，消息带"上限 N，已用 M"
        - tests/policy-gate.test.mjs::runScenarios：预算超限 → failed，error 带 BudgetExceeded 信息并保留已跑步骤
        - tests/policy-gate.test.mjs::注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "记一次模型调用"
        when: "meter.recordModelCall(n = 1)"
        then: "modelCalls += n；非有限数或 n <= 0 一律忽略（不静默污染账本）；支持一次记 n 次"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::checkBudget：0 = 不限；超限抛 BudgetExceeded，消息带「上限 N，已用 M」"]
        source: { file: "src/executor/policy.ts", lines: "389-393" }
      - given: "记 token 用量"
        when: "meter.recordTokens(n)"
        then: "tokens += n；非法值忽略；driver 拿不到 token 数时**不要调用**（调用即声明「我知道数量」）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "395-399" }
      - given: "取快照"
        when: "meter.snapshot()"
        then: "返回新对象 { modelCalls, tokens }（进 CaseOutcome.usage）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "401-405" }
      - given: "记账的精确度声明"
        when: "driver 通过 DriverContext.usage 上报"
        then: "语义是**下界**（真实调用次数 >= 记账值），所以 maxModelCalls 是**保守闸门**：不会漏掉狂奔的用量，但不能当账单；token 不猜（不主动上报就记 0）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记"]
        source: { file: "src/executor/policy.ts", lines: "375-384" }
      - given: "预算对账——未越限"
        when: "checkBudget(usage, {maxModelCalls, maxTokens})"
        then: "上限 <= 0 视为不限，不抛；**恰好等于上限不算超限**（判据是 `>`）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::checkBudget：0 = 不限；超限抛 BudgetExceeded，消息带「上限 N，已用 M」"]
        source: { file: "src/executor/policy.ts", lines: "421-433" }
      - given: "预算对账——模型调用超限"
        when: "usage.modelCalls > maxModelCalls > 0"
        then: "抛 BudgetExceeded，message 固定前缀「预算超限：」+ `模型调用次数上限 <N> 次，已用 <M> 次`"
        verdict: fail
        tests: ["tests/policy-gate.test.mjs::checkBudget：0 = 不限；超限抛 BudgetExceeded，消息带「上限 N，已用 M」"]
        source: { file: "src/executor/policy.ts", lines: "425-429" }
      - given: "预算对账——token 超限"
        when: "usage.tokens > maxTokens > 0"
        then: "抛 BudgetExceeded，message 为 `预算超限：token 上限 <N>，已用 <M>`；检查顺序在 modelCalls 之后（两个都超时先报 modelCalls）"
        verdict: fail
        tests: []
        source: { file: "src/executor/policy.ts", lines: "430-432" }
      - given: "BudgetExceeded 的形态"
        when: "new BudgetExceeded(msg)"
        then: "name = 'BudgetExceeded'（报告与归因靠它识别）；message 原样进报告，必须能独立读懂"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "407-413" }
      - given: "预算超限在 runner 里的处置"
        when: "每步之后 checkBudget 抛 BudgetExceeded"
        then: "runSteps 立刻 return { steps: 已跑步骤, budgetError }（不吞现场证据）；runOne 记 verdict=failed + error 带 name:message；继续跑只是把账单做大，故 break"
        verdict: fail
        tests: ["tests/policy-gate.test.mjs::runScenarios：预算超限 → failed，error 带 BudgetExceeded 信息并保留已跑步骤"]
        source: { file: "src/runtime/runner.ts", lines: "455-458, 464-466, 779-788" }
    cleanup: none
    nonDeterministic:
      - field: "UsageRecord.modelCalls / tokens"
        reason: "driver 上报值，语义是下界；不可复现"
        reconcile: lower-bound
      - field: "BudgetExceeded.message"
        reason: "内嵌上限与已用数值"
        reconcile: exact
    equivalence:
      usage: lower-bound
      budgetError: normalize-path

  - id: BEH-ENGINE-POLICY-003
    title: policy-sandbox —— 沙箱策略判定：shell / resource / fs / file 四类动作的全分支
    atomic: policy-sandbox
    status: active
    source:
      file: src/executor/policy.ts
      lines: "45-556"
      symbols:
        - SandboxPolicy
        - READ_ONLY_DENY_COMMANDS
        - READ_ONLY_HINT
        - checkSandboxAction
        - readPathOf
        - commandName
        - isUnderAny
        - isUnder
        - normalizeKey
      tests:
        - tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络
        - tests/policy-gate.test.mjs::沙箱：allowShell / denyWriteCommands / allowFileWrite 是显式开关，命中即整条 skipped
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "shell 动作 + sandbox.allowShell=false"
        when: "checkSandboxAction({shell:{argv:['git','status']}}, sandbox)"
        then: "拒绝，原因 `沙箱策略拒绝：本次运行不允许 shell 动作（sandbox.allowShell=false）`"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::沙箱：allowShell / denyWriteCommands / allowFileWrite 是显式开关，命中即整条 skipped"]
        source: { file: "src/executor/policy.ts", lines: "459-462" }
      - given: "shell 动作 + argv[0] 为空"
        when: "checkSandboxAction"
        then: "拒绝，原因 `沙箱策略拒绝：shell 动作没有给出可识别的命令名（argv[0] 为空）`"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "463-467" }
      - given: "shell 命令名命中 denyWriteCommands（默认只读清单，含解释器）"
        when: "checkSandboxAction"
        then: "拒绝，原因带命中的命令名、`（默认只读清单，含解释器）` 与 READ_ONLY_HINT；命中判定对**归一化后的命令名**做"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "468-471" }
      - given: "allowedCommands 非空白名单"
        when: "命令名不在白名单（空名字项被过滤）"
        then: "拒绝，原因列出白名单内容"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "472-475" }
      - given: "shell 的 cwd 是绝对路径且不在 allowedPaths 下"
        when: "checkSandboxAction"
        then: "拒绝，原因 `shell 的 cwd=<cwd> 不在 allowedPaths 允许的路径根下`"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "476-479" }
      - given: "resource 动作 + allowNetwork=false 且未注册假 provider"
        when: "checkSandboxAction(action, sandbox, {})"
        then: "拒绝，原因要求改用假 provider 或显式允许网络（文档 §7.1「禁止场景执行任意网络请求」）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "483-493" }
      - given: "resource 动作 + networkIntercepted=true（场景自带 setup.resource 假 provider）"
        when: "checkSandboxAction(action, sandbox, {networkIntercepted:true})"
        then: "放行（网络已被替身接管，不需要真网）——runner 的 sandboxViolation 会传这个标记"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "484-492" }
      - given: "fs 动作的 write / edit + allowFileWrite=false"
        when: "checkSandboxAction"
        then: "拒绝，原因 `fs.<kind> 需要写文件权限，但 sandbox.allowFileWrite=false`；非 write/edit 不因此拒绝"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "495-500" }
      - given: "fs 动作的绝对 path 不在 allowedPaths 下"
        when: "checkSandboxAction"
        then: "拒绝，原因 `<path> 不在 allowedPaths 允许的路径根下`；path 缺省或空串时不判（readPathOf 返回 undefined）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "501-505, 520-524" }
      - given: "file 动作的绝对 read 路径不在 allowedPaths 下"
        when: "checkSandboxAction"
        then: "拒绝，原因 `读取 <path> 不在 allowedPaths 允许的路径根下`（纯离线读同样受路径白名单约束）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "508-515" }
      - given: "其它动作（tool / prompt / llm / interaction / session / agent / ui / compaction / wait / emit）"
        when: "checkSandboxAction"
        then: "返回 undefined（不限制）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "517" }
      - given: "路径白名单只对绝对路径生效"
        when: "相对 path / 相对 cwd"
        then: "不判（相对路径的根由宿主的 workspace 决定，闸门不替宿主猜——猜错会拒掉合法的相对访问）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "446-450" }
      - given: "命令名归一化"
        when: "commandName('C:\\\\Windows\\\\System32\\\\rm.exe') / '/usr/bin/rm' / 'RM'"
        then: "取 basename、去掉 .exe|.cmd|.bat|.com 后缀、转小写 → 都是 `rm`（否则拒绝清单会被路径写法绕过）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "526-537" }
      - given: "路径归属判断"
        when: "isUnderAny(path, roots) / isUnder(path, root)"
        then: "roots 为空 = 不限制（true）；否则 path 落在任一 root 下；isUnder 先 resolve 两侧，相等或 target 以 `base + sep` 开头即算；Windows 下比较前统一小写（大小写不敏感）"
        verdict: pass
        tests: []
        source: { file: "src/executor/policy.ts", lines: "539-556" }
      - given: "默认只读清单的内容"
        when: "READ_ONLY_DENY_COMMANDS"
        then: "两类：① 会写/删/改的命令（rm rmdir rd del erase deltree mv move cp copy xcopy robocopy dd mkfs chmod chown truncate tee format shred diskpart reg sc taskkill setx npm）② **解释器**（sh bash zsh fish dash cmd powershell pwsh wsl）——解释器无法静态判定会写什么，放行等于把只读默认值作废"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::默认策略：默认不真调模型；shell 默认只读；禁止任意网络"]
        source: { file: "src/executor/policy.ts", lines: "71-120" }
      - given: "沙箱预检的 runner 侧接线"
        when: "sandboxViolation 扫描 scenario.steps 的 act"
        then: "任一动作被拒 → 整条 case 预检即 skipped（不留部分副作用 + 半份证据）；reason 带第 N 步与步骤名；setup 含 resource 时 networkIntercepted=true"
        verdict: skip
        tests: ["tests/policy-gate.test.mjs::沙箱：allowShell / denyWriteCommands / allowFileWrite 是显式开关，命中即整条 skipped"]
        source: { file: "src/runtime/runner.ts", lines: "324-329, 632-646" }
    cleanup: none
    nonDeterministic:
      - field: "checkSandboxAction 返回的拒绝原因"
        reason: "内嵌命中的命令名、绝对路径或白名单内容（路径随环境变化）"
        reconcile: normalize-path
    equivalence:
      decision: exact
      reason: normalize-path

  - id: BEH-ENGINE-POLICY-004
    title: policy-driver-cost —— kind 默认成本档位表与注册处记账注入
    atomic: policy-driver-cost
    status: active
    source:
      file: src/kinds/index.ts
      lines: "31-113"
      symbols:
        - DRIVER_COST
        - withDriverCost
        - createDriverRegistry
      tests:
        - tests/policy-gate.test.mjs::DRIVER_COST：覆盖全部 SCENARIO_KINDS，并由注册处注入到每个 driver
        - tests/policy-gate.test.mjs::注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记
        - tests/self-bootstrap.test.mjs::自举契约：SCENARIO_KINDS 与注册表同集（不多不少）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "档位表的覆盖度"
        when: "Object.keys(DRIVER_COST)"
        then: "恰好覆盖 SCENARIO_KINDS 的 12 个 kind（不多不少）：llm / tool / prompt / interaction / session / resource / ui / file = none；shell / fs = low；compaction / agent = high。漏一个 kind 会让它走保守默认（静默变严）"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::DRIVER_COST：覆盖全部 SCENARIO_KINDS，并由注册处注入到每个 driver"]
        source: { file: "src/kinds/index.ts", lines: "51-64" }
      - given: "注册集合与顺序"
        when: "createDriverRegistry()"
        then: "返回 DriverRegistry，按**固定顺序**注册 12 个 driver（tool → prompt → llm → interaction → session → resource → agent → ui → shell → file → fs → compaction）；get(kind) 对每个 kind 都能拿到 driver"
        verdict: pass
        tests: ["tests/self-bootstrap.test.mjs::自举契约：SCENARIO_KINDS 与注册表同集（不多不少）"]
        source: { file: "src/kinds/index.ts", lines: "95-113" }
      - given: "driver 自己声明了 cost()"
        when: "withDriverCost(driver)"
        then: "沿用 driver.cost（表只用于缺省）"
        verdict: pass
        tests: []
        source: { file: "src/kinds/index.ts", lines: "77-81" }
      - given: "driver 没有声明 cost()"
        when: "withDriverCost(driver)"
        then: "注入 `() => DRIVER_COST[driver.kind]`——表是唯一真源，故 driver.cost?.() 必须等于 DRIVER_COST[kind]"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::DRIVER_COST：覆盖全部 SCENARIO_KINDS，并由注册处注入到每个 driver"]
        source: { file: "src/kinds/index.ts", lines: "78-79" }
      - given: "档位是 high 且 driver 有 act"
        when: "注册后的 driver.act 被调用"
        then: "包一层记账：若 `(ctx.scenario.cost ?? declared) === 'high'` 则 `ctx.usage?.recordModelCall()`；**先记账再执行**（宁多记一次，不漏记）；闸门未启用时 usage 为 undefined → 不记账"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记"]
        source: { file: "src/kinds/index.ts", lines: "83-92" }
      - given: "场景显式 cost: none（降档，例如 compaction 的只读 inspect）"
        when: "high 档 driver 的 act 被调用"
        then: "不记账（modelCalls 不变）——这正是 Scenario.cost 字段的既定用途"
        verdict: pass
        tests: ["tests/policy-gate.test.mjs::注册处记账：high 档 driver 每个 act 记一次（下界），场景 cost:none 降档时不记"]
        source: { file: "src/kinds/index.ts", lines: "87-89" }
      - given: "档位不是 high，或 driver 没有 act"
        when: "withDriverCost"
        then: "返回 { ...driver, cost }，**不包 act**（没有模型调用要记）"
        verdict: pass
        tests: []
        source: { file: "src/kinds/index.ts", lines: "81" }
    cleanup: none
    nonDeterministic:
      - field: "DriverContext.usage.modelCalls（注册处记账）"
        reason: "记账是下界（真实调用次数 >= 记账值）；token 不猜，driver 未上报时记 0"
        reconcile: lower-bound
    equivalence:
      DRIVER_COST: exact
      driver-cost: exact
---

# policy —— 成本闸门与沙箱判定

> **本模块留在 TypeScript，阶段 1 不迁往 Rust。**
> 设计 [REWRITE-DESIGN.md §1.2](../../../../docs/REWRITE-DESIGN.md) line 58 明确规定：
> `executor/policy.ts`（22,310 字节，成本闸门）→「**留在 TS**」，迁移性质是「**沿用**
> （它是安全边界，见 SECURITY.md）」；§1.3 line 85 的仓库结构里同样标注
> `executor/policy.ts  # 沿用（安全边界）`。
> 因此本文件的条目是**行为契约**（必须保持），不是迁移源——阶段 2 的对拍对象是"策略判定结果
> 与既有实现逐条一致"，而不是"把它翻成 Rust"。

命名依据（engine 域无设计硬约束，按源码事实定）：源码里四个可独立 pass/fail 的面——
**判定**（`evaluateScenario` / `resolvePolicy` / 策略快照）、**记账与对账**（`UsageMeter` /
`checkBudget`）、**沙箱**（`checkSandboxAction` 及其命令名/路径工具）、**档位真源**
（`src/kinds/index.ts` 的 `DRIVER_COST` 与注册处记账注入），故拆成四个原子。

## policy-evaluate

三档成本（policy.ts:11-21）：

```text
none —— 纯离线：不调模型、不起外部进程、不写文件   → 永远放行
low  —— 本地副作用：起进程 / 写文件，无模型成本     → 需要 cost.allowLowCost
high —— 真实模型调用                              → 需要 cost.allowModel（默认拒绝）
```

### 全分支覆盖表（验收要求）

| # | 条件 | 结果 | 代码位置 | 测试 |
|---|---|---|---|---|
| 1 | cost=none（任意配置） | 放行 | policy.ts:310-320 | policy-gate.test.mjs:107 |
| 2 | cost=low + allowLowCost=true | 放行 | policy.ts:322-333 | policy-gate.test.mjs:107 |
| 3 | cost=low + allowLowCost=false | 拒绝（含放权方式） | policy.ts:334-344 | policy-gate.test.mjs:107 |
| 4 | cost=high + allowModel=true | 放行 | policy.ts:347-358 | policy-gate.test.mjs:107 |
| 5 | cost=high + allowModel=false | 拒绝（默认，含 `--allow-model`） | policy.ts:360-370 | policy-gate.test.mjs:107, 275 |
| 6 | scenarioCost 已给 | source='scenario'，cost 取场景值 | policy.ts:300-302 | policy-gate.test.mjs:139 |
| 7 | scenarioCost 未给 | source='driver'，cost 取 driver 值 | policy.ts:300-302 | policy-gate.test.mjs:139 |
| 8 | 参与 driver 未声明 cost() | runner 补 source='default' + 按 high | runner.ts:316-317, 595-624 | — |
| 9 | budget 比策略更紧 | limits 取更小值 | policy.ts:305-308, 273-277 | policy-gate.test.mjs:215 |
| 10 | budget 比策略更松 | limits 取策略值（不能放宽） | policy.ts:273-277 | policy-gate.test.mjs:215 |
| 11 | 两边都是 0 | limits = 0（不限） | policy.ts:273-277 | policy-gate.test.mjs:215 |

### 边界与已知缺陷

- **`recordReplay` 是预留位**：`ExecutionPolicy.cost.recordReplay` 进配置与快照，但
  **runner 不消费它**（policy.ts:137-138 明说"当前 runner 不消费"）。spec 记录为"声明存在、
  行为未接线"，阶段 1 不能假装它有效。
- **`approval` 面同理是预留位**（policy.ts:141-142）：`requireHumanApproval` / `approvers`
  当前由命令面的人工开关承担，判定层不读。B5（审批路径覆盖）的清单在 `contracts/approval-paths.yaml`，
  不在本模块。
- **`sandbox.timeoutMs` 也是预留位**（policy.ts:60-61）：runner 的单次动作超时仍以
  `runtime.timeoutMs` 为准。
- **默认值取舍有据**（policy.ts:152-174）：`allowLowCost=true` 与 `allowFileWrite=true` 是
  **刻意保留**，理由是"默认收紧会让既有基线平白多出一片 skipped（自己制造的假红）"。
  这是 spec 必须记录的**决策理由**，不是遗漏。

## policy-budget

用量记账的精确度声明（policy.ts:375-384）是验收的一部分：

1. 语义是**下界**：真实调用次数 >= 记账值；所以 `maxModelCalls` 是保守闸门（超了必拦），
   **不能当账单**。
2. **token 不猜**：driver 不主动上报就记 0，`maxTokens` 因此只在有上报时才真正强制。
3. driver 通过 `DriverContext.usage` 拿到它，**每个 act 记一次**，不要每 step 记一次
   （注册处记账的纪律，见 `tests/policy-gate.test.mjs::注册处记账`）。

### 边界与已知缺陷

- **超限判据是 `>` 而不是 `>=`**（policy.ts:425, 430）：恰好等于上限不算超限。这是刻意的
  （"上限 1 次" 就该允许跑 1 次），对拍时必须保持。
- **两个上限都超时只报 modelCalls**：检查顺序固定（policy.ts:425 在 430 之前），
  报告里只会看到一条 BudgetExceeded。
- **`maxTokens` 默认 0 = 不限**：由于 token 常不上报，默认配置下这条闸门基本不生效——
  这是"不猜"纪律的直接后果，不是 bug。

## policy-sandbox

四类动作的判定规则（policy.ts:440-446 的头注是权威摘要）：

```text
shell: allowShell=false → 拒；命令名命中 denyWriteCommands → 拒；
       allowedCommands 非空且不在白名单 → 拒；cwd 绝对路径不在 allowedPaths 下 → 拒
resource: allowNetwork=false 且未注册假 provider → 拒
fs:     write/edit 且 allowFileWrite=false → 拒；绝对 path 不在 allowedPaths 下 → 拒
file:   绝对 read 路径不在 allowedPaths 下 → 拒
其余:   不限制
```

**「shell 默认只读」的实现是命令名黑名单**（policy.ts:63-80）：本仓 shell 动作是 **argv 数组**
（不经 shell 解析，没有重定向/管道），所以"命令名"就是可判定的边界。

### 边界与已知缺陷

- **`allowedPaths` 只对绝对路径生效**（policy.ts:446-450）：相对路径的边界交给宿主自己的沙箱
  （例如 `fs` 动作里的 `sandbox.mode`）。这是刻意的（不替宿主猜），但意味着**相对路径写入
  不受闸门约束**——安全边界上的一个已知豁口。
- **`denyWriteCommands` 是黑名单而非白名单**：任何不在清单里的命令默认放行（含未知第三方可执行文件）。
  `allowShell=false` 才是真正的关闭开关。
- **`npm` 被整条列入拒绝清单**（policy.ts:109）：`npm test` 这类只读用法也会被拦，
  需要显式放宽。这是一刀切，报告里表现为 skipped（不是 failed）。
- **预检只扫字面 `step.act`**（runner.ts:632-646）：`use:` 片段若在 runner 之外未展开，则扫不到
  （与 runner.md 的缺陷 R-2 同源）。

## policy-driver-cost

`src/kinds/index.ts` 是**成本档位的唯一真源**（`index.ts:32-50` 的注释解释了为什么集中一处：
12 个文件各写一遍必然漂移，而"某类场景悄悄被放行去调模型"是最难察觉的一类缺陷）。

> **归类说明（与 design-scope 的分母有关）**：`baseline/design-scope.json` 用
> `prefix: src/kinds` + `suffix: .ts` 把 `src/kinds/index.ts` 收进 §1.2 line 44 的
> `kinds/*.ts`（12 个 driver）那一行。但按 §1.2 / §1.3 的语义，这一行指的是**12 个 driver 文件**；
> `index.ts` 是**注册面**，而目标架构里 driver 仍是 **TS `BaseTool` 实现**（§2.2 表头、
> §1.3 `kinds/  # 收缩`），注册面留在 TS。本条目把它按**政策域的成本档位真源**记录：
> 它确实是可观察行为（被两条测试守着），但若判定 `src/kinds/index.ts` 应从「变更」分母移出，
> 则本条目是**额外覆盖**而非必需。

### 边界与已知缺陷

- **记账是"先记账再执行"**（`index.ts:86-91`）：act 抛错时仍然留下 1 次记账
  （`tests/policy-gate.test.mjs::注册处记账` 正是用"headless 没有 subagents 服务 → act 抛错"
  来验证这一点的）。对拍时"act 失败但 usage=1"是预期，不是双计。
- **两个记账点并存**：注册处包装（high 档每 act 1 次）与 driver 内部通过
  `DriverContext.usage` 上报。`index.ts:74-75` 的注释说明"本次不改 agent.ts / compaction.ts，
  避免双计"——即当前只有注册处这一处记账；阶段 1 若在 driver 内也记账，必须重新核对上限口径。
- **`DRIVER_COST` 是 `Readonly<Record<ScenarioKind, CostClass>>`**：类型层保证 12 个 kind
  全部有值（漏一个编译期就报错），运行期测试（`DRIVER_COST：覆盖全部 SCENARIO_KINDS`）
  再核一次——双保险。
- **`index.ts` 还有 80 行纯 re-export**（`:115-194`）：它们只是模块门面，没有可观察行为，
  故不落原子条目（spec/README §6 禁止空条目）。
