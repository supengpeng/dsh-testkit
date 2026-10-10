---
domain: engine
module: report
revision: 1

atomics:
  - id: BEH-ENGINE-REPORT-001
    title: report-json —— run.json 序列化与三份产物落地
    atomic: report-json
    status: active
    source:
      file: src/report/json.ts
      lines: "31-127"
      symbols:
        - RunArtifacts
        - WriteArtifactsOptions
        - renderJson
        - writeRunArtifacts
      tests:
        - tests/report-standard.test.mjs::run.json 满足 schemas/run-report.schema.json
        - tests/report-standard.test.mjs::writeRunArtifacts：写出 run.json / report.md / junit.xml，且不抛出
        - tests/report-standard.test.mjs::writeRunArtifacts：写入失败只回报 error，不抛出
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "序列化整份运行记录"
        when: "renderJson(summary)"
        then: "JSON.stringify(summary, null, 2) + 结尾换行（固定两空格缩进，便于 diff）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::run.json 满足 schemas/run-report.schema.json"]
        source: { file: "src/report/json.ts", lines: "43-46" }
      - given: "三份产物落地"
        when: "writeRunArtifacts(summary, runsDir)"
        then: "写入 runsDir/<runId>/ 下 run.json、report.md、junit.xml（mkdir recursive）；trace.json 只在**这次运行真的记了 trace** 时写"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::writeRunArtifacts：写出 run.json / report.md / junit.xml，且不抛出"]
        source: { file: "src/report/json.ts", lines: "70-105" }
      - given: "run.json / report.md 与 junit.xml 的失败隔离"
        when: "junit.xml 写失败 / trace.json 写失败"
        then: "各自单独 try：junitError / traceError 通过返回值回报，**不把已经写好的 json/md 作废**（三份是并列产物，不是一份的中间状态）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::writeRunArtifacts：写入失败只回报 error，不抛出"]
        source: { file: "src/report/json.ts", lines: "54-57, 84-91, 96-105" }
      - given: "整体写入失败（目录建不出来等）"
        when: "外层 catch"
        then: "返回 { error } 而不是抛出——报告失败不该让一次已经跑完的测试变成失败"
        verdict: fail
        tests: ["tests/report-standard.test.mjs::writeRunArtifacts：写入失败只回报 error，不抛出"]
        source: { file: "src/report/json.ts", lines: "121-123" }
      - given: "redact 选项"
        when: "writeRunArtifacts(summary, dir, {redact:true})"
        then: "先用 redactSummary(summary) 得到已脱敏 summary，三份产物（json/md/junit）渲染**同一份**已脱敏 summary；findings 非空时返回 redaction"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::writeRunArtifacts：写出 run.json / report.md / junit.xml，且不抛出"]
        source: { file: "src/report/json.ts", lines: "74-75, 107-119" }
      - given: "redact 的缺省值"
        when: "未传 redact"
        then: "默认 **false**：脱敏会改写取证原文，不该在没人要求时悄悄发生"
        verdict: pass
        tests: []
        source: { file: "src/report/json.ts", lines: "32-41, 74" }
      - given: "trace.json 的写出条件"
        when: "effective.cases 里任一 case 的 trace 长度 > 0"
        then: "才写 trace.json（给没记 trace 的运行写一份重建文件，会让读者分不清实测偏移与近似）"
        verdict: pass
        tests: []
        source: { file: "src/report/json.ts", lines: "93-105" }
    cleanup: none
    nonDeterministic:
      - field: "run.json 里的 RunSummary.runId / startedAt / finishedAt / durationMs"
        reason: "由 runner 生成，含挂钟时间与随机后缀"
        reconcile: "normalize:<RUNID>"
      - field: "产物路径 runs/<runId>/"
        reason: "runId 非确定"
        reconcile: "normalize-path"
    equivalence:
      runId: "normalize:<RUNID>"
      startedAt: "normalize:<TS>"
      cases[].durationMs: interval

  - id: BEH-ENGINE-REPORT-002
    title: report-junit —— CI 消费面：计数现算、转义顺序、非法控制字符剔除
    atomic: report-junit
    status: active
    source:
      file: src/report/junit.ts
      lines: "27-179"
      symbols:
        - escapeXmlText
        - escapeXmlAttr
        - stripIllegalXml
        - renderJUnit
        - groupByKind
        - renderTestCase
        - diagnosisSummary
        - renderDiagnosis
      tests:
        - tests/report-standard.test.mjs::junit：testcase 数 = cases 数，根/套件计数与 tally 一致
        - tests/report-standard.test.mjs::junit：failure/error 的 type 取 failureCategory，正文带失败明细与最小复现
        - tests/report-standard.test.mjs::junit：skipped 带 message，passed 自闭合且无子标签
        - tests/report-standard.test.mjs::junit：标题 / 消息里的 < & " 正确转义，非法控制字符被剔除
        - tests/report-standard.test.mjs::XML 转义函数：转义顺序与合法控制字符保留
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "根 testsuites 与各 testsuite 的计数与耗时"
        when: "renderJUnit(summary)"
        then: "计数**由 cases 现算**（不抄 totals）：failures/errors/skipped 分别数 verdict；time = sum(durationMs)/1000 固定三位小数"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::junit：testcase 数 = cases 数，根/套件计数与 tally 一致"]
        source: { file: "src/report/junit.ts", lines: "66-89, 102-113" }
      - given: "套件分组"
        when: "groupByKind(summary.cases)"
        then: "按 kind 分组，保持 kind **首次出现**的顺序（报告顺序稳定，便于 diff）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::三面同源：md「需要关注」的 case 集合 = junit 的 failure/error/skipped 集合"]
        source: { file: "src/report/junit.ts", lines: "91-100" }
      - given: "verdict 与子标签的映射"
        when: "renderTestCase"
        then: "passed → 自闭合无子标签；skipped → <skipped message=...>；failed → <failure>；errored → <error>；type 取 failureCategory ?? verdict"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::junit：skipped 带 message，passed 自闭合且无子标签", "tests/report-standard.test.mjs::junit：failure/error 的 type 取 failureCategory，正文带失败明细与最小复现"]
        source: { file: "src/report/junit.ts", lines: "115-135" }
      - given: "失败正文"
        when: "renderDiagnosis"
        then: "顺序：错误 → 失败断言（硬失败，走 present.failingAssertions 的唯一实现）→ 夹具释放失败 → 最小复现；全空时写 `<id> <verdict>（无更多现场）`"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::junit：failure/error 的 type 取 failureCategory，正文带失败明细与最小复现"]
        source: { file: "src/report/junit.ts", lines: "150-179" }
      - given: "一句话摘要"
        when: "diagnosisSummary"
        then: "优先 item.error 首行；否则首条失败断言 message 首行；否则 `<n> 条断言失败`；否则 verdict"
        verdict: pass
        tests: []
        source: { file: "src/report/junit.ts", lines: "137-148" }
      - given: "XML 文本转义"
        when: "escapeXmlText"
        then: "先剔除 XML 1.0 非法控制字符，再按 & → < → > 的顺序替换（& 必须最先，否则会二次转义）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::XML 转义函数：转义顺序与合法控制字符保留"]
        source: { file: "src/report/junit.ts", lines: "31-36" }
      - given: "XML 属性转义"
        when: "escapeXmlAttr"
        then: "文本转义 + 引号（&quot;/&apos;）+ 把 \\t\\n\\r 折成空格（解析器本就会规范化，显式折平避免谜案）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::XML 转义函数：转义顺序与合法控制字符保留"]
        source: { file: "src/report/junit.ts", lines: "44-52" }
      - given: "非法控制字符"
        when: "文本含 U+0000-U+0008 / U+000B / U+000C / U+000E-U+001F"
        then: "一律剔除；\\t \\n \\r 是合法字符，文本里保留、属性里折空格"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::junit：标题 / 消息里的 < & \" 正确转义，非法控制字符被剔除"]
        source: { file: "src/report/junit.ts", lines: "27-28, 54-56" }
    cleanup: none
    nonDeterministic:
      - field: "testsuites/@time 与 testcase/@time"
        reason: "来自 cases[].durationMs（挂钟）"
        reconcile: interval
      - field: "failure/error 正文里的路径与错误原文"
        reason: "内嵌绝对路径、临时目录名"
        reconcile: normalize-path
    equivalence:
      xml-shape: exact
      counts: exact
      time: interval

  - id: BEH-ENGINE-REPORT-003
    title: report-markdown —— 人读报告：概览表、需要关注、逐条详情
    atomic: report-markdown
    status: active
    source:
      file: src/report/markdown.ts
      lines: "24-181"
      symbols:
        - VERDICT_BADGE
        - renderMarkdown
        - renderCase
        - renderStep
        - renderAssertion
      tests:
        - tests/report-standard.test.mjs::三面同源：md「需要关注」的 case 集合 = junit 的 failure/error/skipped 集合
        - tests/report-standard.test.mjs::markdown：归因列 / 归因标签 / rounds / 闸门 / 用量 / 最小复现 / 闸门快照
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "报告头部"
        when: "renderMarkdown(summary)"
        then: "依次写 Run ID / 开始 / 结束 / DSH（版本 · 平台）/ casesDir；有 policySnapshot 时补闸门快照行；有 redaction 时补已脱敏行（含处数与类型，并声明 findings 只记位置与类型）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::markdown：归因列 / 归因标签 / rounds / 闸门 / 用量 / 最小复现 / 闸门快照"]
        source: { file: "src/report/markdown.ts", lines: "31-56" }
      - given: "合计行"
        when: "totals"
        then: "`**合计**：N 条 — ✅ passed · ❌ failed · ⏭️ skipped · 💥 errored`"
        verdict: pass
        tests: []
        source: { file: "src/report/markdown.ts", lines: "54-57" }
      - given: "概览表"
        when: "逐 case 一行"
        then: "7 列：Case / Kind / 结果（徽章）/ 归因（FAILURE_CATEGORY_LABEL 或 —）/ 耗时 / 标题 / 来源；单元格里的裸 | 转义成 \\|"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::markdown：归因列 / 归因标签 / rounds / 闸门 / 用量 / 最小复现 / 闸门快照"]
        source: { file: "src/report/markdown.ts", lines: "59-72, 178-181" }
      - given: "章节划分"
        when: "cases 里含非 passed"
        then: "写「## 需要关注」并逐条 renderCase；passed 的 case 单独折叠成「## 已通过」清单（不膨胀）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::三面同源：md「需要关注」的 case 集合 = junit 的 failure/error/skipped 集合"]
        source: { file: "src/report/markdown.ts", lines: "74-93" }
      - given: "逐条详情（renderCase）"
        when: "非 passed 的 case"
        then: "结果 / kind / 来源 / 归因（标签 + 原始枚举值）/ repeat（formatRounds）/ 成本闸门（formatPolicy）/ 用量（formatUsage）/ 跳过原因 / 错误；失败或 errored 时附 probableCauses 的「可能原因」（**没有依据就什么都不写**）；releaseFailures 逐条列出"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::markdown：归因列 / 归因标签 / rounds / 闸门 / 用量 / 最小复现 / 闸门快照"]
        source: { file: "src/report/markdown.ts", lines: "98-131" }
      - given: "最小复现块"
        when: "case.minimalRepro 存在"
        then: "写 `**最小复现**` + ```bash 代码块"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::markdown：归因列 / 归因标签 / rounds / 闸门 / 用量 / 最小复现 / 闸门快照"]
        source: { file: "src/report/markdown.ts", lines: "133-140" }
      - given: "步骤渲染"
        when: "renderStep"
        then: "标题前的记号由**硬失败**决定（failed 非空 → ❌，否则 ✅）；有 action 时写 `act <kind> → ok|err[：detail]`；逐条 renderAssertion"
        verdict: pass
        tests: []
        source: { file: "src/report/markdown.ts", lines: "149-164" }
      - given: "断言渲染"
        when: "renderAssertion"
        then: "记号：ok → ✅ / soft 且失败 → ⚠️(soft) / 硬失败 → ❌；文本为 `\\`ref\\` word expected — 实际 \\`actual\\``，失败时追加 message；actual 截断到 160 字符"
        verdict: pass
        tests: []
        source: { file: "src/report/markdown.ts", lines: "166-172" }
    cleanup: none
    nonDeterministic:
      - field: "耗时列 / 报告里的时间戳"
        reason: "来自 durationMs / startedAt / finishedAt"
        reconcile: interval
      - field: "错误、跳过原因、断言 message 里的路径"
        reason: "内嵌绝对路径与临时目录名"
        reconcile: normalize-path
    equivalence:
      markdown-structure: exact
      counts: exact

  - id: BEH-ENGINE-REPORT-004
    title: report-redact —— 脱敏：默认关闭、只记位置不记内容、模式表有序
    atomic: report-redact
    status: active
    source:
      file: src/report/redact.ts
      lines: "27-227"
      symbols:
        - RedactionFinding
        - SECRET_PATTERNS
        - PLACEHOLDER_RE
        - redactText
        - scanFindings
        - redactValue
        - summarizeFindings
        - redactSummary
      tests:
        - tests/redact.test.mjs
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "敏感模式表"
        when: "SECRET_PATTERNS 逐项匹配"
        then: "顺序有意义：**具体模式在前、宽泛模式在后**（private-key / github-token / openai-key / aws-key-id / bearer-token / jwt / assigned-secret / email / home-path）；命中替换成 `[已脱敏:<kind>]`"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "34-54, 60-62" }
      - given: "占位样本"
        when: "命中文本含 example.com / invalid / localhost / 127.0.0.1 / your- / <...> / git@..."
        then: "PLACEHOLDER_RE 命中则**不脱敏**（否则文档里的示例邮箱会天天红）"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "56-58, 85" }
      - given: "home-path 的特殊处理"
        when: "命中 C:\\Users\\alice 或 /home/alice"
        then: "只把**用户目录名**换成 <user>（`C:\\Users\\<user>`）——项目路径常常是理解问题必需的上下文，整段抹掉报告就没法用"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "64-69, 76-82" }
      - given: "findings 的内容纪律"
        when: "redactText / redactValue 收集命中"
        then: "findings 只含 { path, kind }，**绝不保留命中的原文**——否则报告本身又变成泄露源"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "11-16, 79, 86, 109" }
      - given: "递归脱敏任意值"
        when: "redactValue(value, path)"
        then: "字符串脱敏；数组逐元素（path 带 [i]）；对象逐键（path 用点连接）；其它类型原样返回"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "99-124" }
      - given: "findings 去重与排序"
        when: "summarizeFindings(findings)"
        then: "按 (path, kind) 去重（NUL 分隔键）后排序：先 path 再 kind——报告要稳定可 diff"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "126-137" }
      - given: "整份运行记录脱敏"
        when: "redactSummary(summary)"
        then: "只动**取证内容**（cases[].notes / 断言 actual 与 message / step.notes / action.detail / error / skipReason / minimalRepro / releaseFailures[].error），**不动结构字段**（id / verdict / 时间）；findings 非空时写 summary.redaction"
        verdict: pass
        tests: ["tests/redact.test.mjs"]
        source: { file: "src/report/redact.ts", lines: "139-227" }
      - given: "扫描不脱敏的入口"
        when: "scanFindings(text, path)"
        then: "返回 redactText 的 findings 并把空 path 填成入参 path（给 scripts/check-secrets.mjs 与 CI 闸门用）"
        verdict: pass
        tests: []
        source: { file: "src/report/redact.ts", lines: "94-97" }
    cleanup: none
    nonDeterministic:
      - field: "redaction.findings[].path"
        reason: "路径含数组下标（cases[i].steps[j]），随报告结构变化；排序后仍稳定"
        reconcile: sorted-set
    equivalence:
      redaction.count: exact
      redaction.findings: "sorted-set（按 path，只比位置与类型）"

  - id: BEH-ENGINE-REPORT-005
    title: report-present —— 三面同源的呈现原语（哪条断言算失败只有一份实现）
    atomic: report-present
    status: active
    source:
      file: src/report/present.ts
      lines: "22-107"
      symbols:
        - assertionWord
        - assertionExpected
        - FailureLine
        - failingAssertions
        - renderFailureLine
        - formatRounds
        - formatPolicy
        - formatUsage
        - formatPolicySnapshot
        - firstLine
        - safeStringify
        - truncate
      tests:
        - tests/report-standard.test.mjs::三面同源：md「需要关注」的 case 集合 = junit 的 failure/error/skipped 集合
        - tests/report-standard.test.mjs::junit：failure/error 的 type 取 failureCategory，正文带失败明细与最小复现
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "取断言词"
        when: "assertionWord(outcome)"
        then: "取 assertion 对象里除 ref / soft 外的**第一个**非 undefined 键（Schema 保证一行只有一个判定词）"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "22-28" }
      - given: "取期望值文本"
        when: "assertionExpected(outcome)"
        then: "assertion[word] 的 safeStringify；认不出断言词时返回 `?`"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "30-36" }
      - given: "「哪条断言算失败」的唯一实现"
        when: "failingAssertions(caseOutcome)"
        then: "遍历 steps[].assertions，`!ok && !soft` 才算硬失败，返回带 stepName 的行；md 与 junit 都从这里取（避免 md 说 N 条、junit 说 M 条）"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::三面同源：md「需要关注」的 case 集合 = junit 的 failure/error/skipped 集合"]
        source: { file: "src/report/present.ts", lines: "38-57" }
      - given: "失败断言单行文本"
        when: "renderFailureLine(line)"
        then: "`[stepName] ref word expected — 实际 <actual> · <message>`；actual 截断到 300 字符"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::junit：failure/error 的 type 取 failureCategory，正文带失败明细与最小复现"]
        source: { file: "src/report/present.ts", lines: "59-64" }
      - given: "repeat 轮次呈现"
        when: "formatRounds(rounds)"
        then: "`<passed>/<total> 轮通过`"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "66-70" }
      - given: "闸门判定呈现"
        when: "formatPolicy(policy)"
        then: "`跑|未跑 —— <reason>（成本档 <cost>，来源 <source>）`"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "72-76" }
      - given: "用量呈现"
        when: "formatUsage(usage)"
        then: "`模型调用 <n> 次 · <tokens> tokens`"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "78-81" }
      - given: "闸门快照呈现"
        when: "formatPolicySnapshot(snapshot)"
        then: "`模型调用允许|禁止 · 低成本允许|禁止 · 沙箱 <safeStringify(sandbox)>`"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "83-88" }
      - given: "通用文本工具"
        when: "firstLine / safeStringify / truncate"
        then: "firstLine 取首行去空白（属性值只能单行）；safeStringify 吞掉 JSON.stringify 异常（循环引用 / BigInt 不该炸报告）；truncate 超长时附总长度（`…(N)`）"
        verdict: pass
        tests: []
        source: { file: "src/report/present.ts", lines: "90-107" }
    cleanup: none
    nonDeterministic:
      - field: "renderFailureLine / assertionExpected 的输出"
        reason: "内嵌 actual 与 message 的文本形态，可能含路径"
        reconcile: normalize-path
    equivalence:
      failingAssertions: exact
      truncate: exact
---

# report —— 报告渲染

覆盖旧实现的五个文件：`json.ts`（落地）、`junit.ts`（CI 面）、`markdown.ts`（人读面）、
`redact.ts`（脱敏）、`present.ts`（三面共用的呈现原语）。设计
[REWRITE-DESIGN.md §1.2](../../../../docs/REWRITE-DESIGN.md) line 61 给它们的去向是
「TS 报告渲染 + Rust 签名」，迁移性质是**变更**。

命名依据（engine 域无设计硬约束，按源码事实定）：五个文件各自承担一个可独立 pass/fail 的面
（序列化落地 / XML / Markdown / 脱敏 / 呈现原语），故拆成五个原子。

## 三面同源（最重要的跨原子不变式）

`run.json`（机器看）、`report.md`（人看）、`junit.xml`（CI 看）**只读同一份 `RunSummary`**，
且「哪条断言算失败」只有一份实现（`present.failingAssertions`，present.ts:44-57）。
`tests/report-standard.test.mjs` 用"md 的「需要关注」集合 = junit 的 failure/error/skipped
集合"守着这条不变式。

## run-report.schema.json 逐字段来源与确定性（验收要求，供 A3/C3 使用）

`schemas/run-report.schema.json` 是 `additionalProperties: false`，可完全枚举（461 行）。
下表逐字段给出**来源**与**确定性**；`reconcile` 一列引用 §9.3 的规则名。

### 文件级（RunSummary）

| 字段路径 | 来源（代码位置） | 确定性 | reconcile |
|---|---|---|---|
| `runId` | `makeRunId`（runner.ts:119-123） | **非确定**（时间 + 4 位随机） | `normalize:<RUNID>` |
| `startedAt` / `finishedAt` | `runScenarios`（runner.ts:135, 194） | **非确定**（挂钟 ISO 串） | `normalize:<TS>` |
| `casesDir` | `registry.dir`（runner.ts:195） | **非确定**（绝对路径） | `normalize:<CASESDIR>` |
| `dshVersion` | `host.env.dshVersion`（runner.ts:196） | 确定（版本不同不算对拍） | `exact` |
| `platform` | `host.env.platform`（runner.ts:197） | 确定（跨平台需另立规则） | `exact` |
| `totals.{total,passed,failed,skipped,errored}` | `tallyTotals` / `emptyTotals`（runlog.ts:213-222） | 确定 | `exact` |
| `policySnapshot.{allowModel,allowLowCost,sandbox}` | `policySnapshot`（policy.ts:238-249；runner.ts:201） | 确定（深拷贝快照） | `exact` |
| `selection.{mode,detail,matched}` | 入口传入（runner.ts:202-203） | 确定（matched 按 §9.3 排序后比） | `exact` |
| `execution.{parallel,limit,safe,exclusive}` | `runScenarios`（runner.ts:183-189, 205） | 确定 | `exact` |
| `redaction.{count,findings[]}` | `redactSummary`（redact.ts:212-224） | 确定（findings 去重排序） | `exact` / `sorted-set` |

### CaseOutcome（`cases[]`）

| 字段路径 | 来源 | 确定性 | reconcile |
|---|---|---|---|
| `id` / `title` / `kind` | scenario（runner.ts:535-537） | 确定 | `exact`（按 id 排序后比） |
| `verdict` | runOne 判定（runner.ts:461-486） | 确定 | `exact` |
| `durationMs` | `Date.now() - t0`（runner.ts:225, 539） | **非确定** | `interval` |
| `skipReason` | 闸门 / 能力 / 夹具 / SkipCase（runner.ts:262, 321, 340, 446, 476） | 归一化后确定 | `normalize-path` |
| `error` | runner（runner.ts:466, 469, 479, 485） | 归一化后确定 | `normalize-path` |
| `steps[]` | runSteps（runner.ts:384, 542） | 见下 | `exact`（结构） |
| `notes` | `fixture.snapshot()`（runner.ts:543） | **集合**（键集由场景自由决定） | `sorted-set` + `normalize-path` |
| `releaseFailures[]` | `fixture.release()`（runner.ts:500-501, 544） | `label` 确定；`error` 归一化 | `sorted-set`（按 label） |
| `sourceIssue` | `scenario.source.issue`（runner.ts:545） | 确定 | `exact` |
| `rounds[]` | repeat（runner.ts:438, 548） | 确定（布尔序列） | `exact` |
| `failureCategory` | `classifyCase`（runner.ts:565-566） | 确定（枚举） | `exact` |
| `policy` | `evaluateScenario`（runner.ts:550） | 确定 | `exact` |
| `usage.{modelCalls,tokens}` | `UsageMeter.snapshot()`（runner.ts:551） | **下界**（"不猜"纪律） | `lower-bound`（只比 modelCalls 区间） |
| `minimalRepro` | `buildMinimalReproForScenario`（runner.ts:571） | 归一化后确定 | `normalize-path` |
| `owner` | `scenario.owner`（runner.ts:546） | 确定 | `exact` |
| `fixtures[]` | `applyScenarioFixtures`（runner.ts:547） | 排序集合 | `sorted-set` |
| `cleanup.{released,leftovers}` | runner（runner.ts:552-560） | 排序集合（leftovers 含 unknown 条目） | `sorted-set` |
| `trace[]` | runner spans（runner.ts:549） | **非确定**（挂钟偏移） | `interval` |

> **⚠️ `cases[].trace` 不在 schema 里** —— 见下面缺陷 RP-1。

### StepOutcome（`steps[]`）

| 字段路径 | 来源 | 确定性 | reconcile |
|---|---|---|---|
| `name` | `step.name ?? 'step N'`（runner.ts:694） | 确定 | `exact` |
| `action.{kind,ok,detail}` | runSteps（runner.ts:710-716） | `kind`/`ok` 确定；`detail` 归一化 | `exact` / `normalize-path` |
| `assertions[]` | 断言循环（runner.ts:736-743） | 见下 | `exact` |
| `durationMs` | 挂钟（runner.ts:692, 766） | **非确定** | `interval` |
| `notes` | 步骤增量（runner.ts:756-764） | 集合 | `sorted-set` + `normalize-path` |

### AssertionOutcome（`steps[].assertions[]`）

| 字段路径 | 来源 | 确定性 | reconcile |
|---|---|---|---|
| `assertion` | 场景原文（`step.expect`） | 确定 | `exact` |
| `ok` | `evaluated.ok && resolved.found`（runner.ts:738） | 确定 | `exact` |
| `actual` | `resolveRef` 的取值（runner.ts:739） | **按类型** | 字符串精确 / 数字 `tolerance:1e-9` / 数组对象排序后 / 路径归一化 |
| `message` | 断言消息或取值失败原因（runner.ts:740） | 归一化后确定 | `normalize-path` |
| `soft` | `assertion.soft === true`（runner.ts:741） | 确定 | `exact` |

### 子结构

| 字段路径 | 来源 | 确定性 | reconcile |
|---|---|---|---|
| `policyDecision.{allowed,reason,cost,source}` | `evaluateScenario`（policy.ts:292-371） | 确定 | `exact` |
| `usageRecord.{modelCalls,tokens}` | `UsageMeter`（policy.ts:385-405） | **下界** | `lower-bound` |
| `fixtureRef.{name,source,dshVersion?,reason?}` | `applyScenarioFixtures` | 确定 | `exact` |
| `cleanupRecord.{released,leftovers}` | runner | 排序集合 | `sorted-set` |
| `redactionRecord.findings[].{path,kind}` | `redactSummary` | 确定（排序、只含位置与类型） | `sorted-set` |

### 不在 schema、但实际会出现在 run.json 里的字段

| 字段 | 为什么会出现 | 处置 |
|---|---|---|
| `cases[].trace` | `runOne` 结尾无条件 push 一条 `phase:'case'` 跨度（runner.ts:526-532, 549） | **缺陷 RP-1**；schema 与 §9.3 都缺这个字段 |
| （无其它） | — | — |

## report-json

`run.json` / `report.md` / `junit.xml` 三份是**并列产物**：junit 单独失败不把另外两份作废
（`json.ts:54-57`）。写入失败也不抛（`json.ts:121-123`）——报告失败不该让一次已经跑完的测试
变成失败。`trace.json` 只在这次运行真的记了 trace 时才写（`json.ts:93-95`）。

### 边界与已知缺陷

**缺陷 RP-1（与 runner 的 R-1 同源）：`cases[].trace` 违反 run-report schema。**
- `run-report.schema.json` 的 `caseOutcome` 是 `additionalProperties: false`（line 97），
  properties（line 98-173）**没有 `trace`**；
- 但 `runner.ts:526-532` 无条件 push 一条 `phase:'case'` 跨度，`runner.ts:549` 因此对
  **每一条** case 写 `trace`；
- 结论：任何**跑到底**的 case 写的 `run.json` 都会被自己的 schema 判为「不允许多余字段 trace」。
- **实证（2026-10-11 本机）**：跑 `tests/scenario-run.test.mjs`（8/8 通过）后生成的
  `runs/2026-10-10T16-04-27_vjd7/run.json` 中 `cases[0]`（TK-0001）含 `trace` 数组（6 条跨度，
  末条 `phase:'case'`）；schema 的 `caseOutcome` 是 `additionalProperties:false` 且无 `trace`。
- 现有测试没抓到：`tests/report-standard.test.mjs` 的 `SUMMARY` 是手写夹具且不含 trace
  （该文件 line 44-174）；没有别的测试对**真实** run.json 跑 schema 校验。
- 注意早退路径（夹具 skip / 缺 driver / 闸门拒绝 / 沙箱拒绝 / 能力缺失）直接
  `return finishing(...)`，不写 `trace`——所以缺陷只在"真正跑起来"的 case 上暴露。
- §9.3 的等价关系表（REWRITE-DESIGN.md:783-811）里也没有 `cases[].trace` —— 即"没比"的字段
  既没进 `uncompared_fields` 也没进表，违反 §9.3 第 1 条纪律。

**缺陷 RP-2：`degrade` 的措辞。** `report.md` 写"已脱敏：过滤 N 处"，而
`redaction.count` 是**去重后**的 (path,kind) 对数（redact.ts:212），不是"命中次数"。
同一路径同一类型命中两次只记 1。文案与数值口径不同，读者容易误读。

## report-junit

CI（GitHub Actions / Jenkins / GitLab / dorny/test-reporter）只认 JUnit XML。两个必须守住的
细节：**转义顺序**（`&` 最先，否则 `&` → `&amp;` → `&amp;amp;`）与**XML 1.0 非法控制字符
剔除**（一个裸控制字符就整份拒绝解析）。根/套件计数**现算不抄 totals**，让
"属性声明数 = 子节点数"这条不变量在结构上不可能被破坏。

### 边界与已知缺陷

- **`time` 是三位小数的秒**：`(max(0,ms)/1000).toFixed(3)`（junit.ts:110-113），
  负数被夹到 0；对拍按 `interval`。
- **`<failure>` 的 `type`**：`failureCategory ?? verdict`（junit.ts:128）——errored 且无归因时
  type 是 `errored` 而非 `error`，与标签名不同，这是刻意的（保留原始枚举值便于 grep）。

## report-markdown

按"需要关注"与"已通过"分节，让失败不会被通过的清单淹没。归因是**分流建议不是判决**，
所以标签后面保留原始枚举值（markdown.ts:105-108）。「可能原因」只有
`probableCauses` 给出依据时才写（markdown.ts:114-126）。

### 边界与已知缺陷

- **概览表用 `shorten(sourceIssue, 40)` 截断来源 URL**（markdown.ts:66）——长 issue 链接在表里不可点全。
- **`escapeCell` 只转义 `|`**（markdown.ts:178-181）：标题里若有换行或反引号，表格会破形。
  未加防护，属已知边界。

## report-redact

两条纪律（redact.ts:11-16）：**默认不脱敏**；**只记位置不记内容**。模式表顺序有意义
（具体模式在前，否则 `token=xxx` 会先被宽泛模式吃掉，findings 的类型就读不懂）。
`home-path` 只替换用户目录名，保留项目路径上下文。

### 边界与已知缺陷

- **这是模式匹配，不是数据分级**（redact.ts:18-22）：挡得住"不小心把 token 贴进日志"，
  挡不住精心构造的泄露（把密钥拆成两半拼接）。
- **`redactValue` 会重建对象**（redact.ts:113-119）：`Object.entries` 会丢掉非可枚举属性与
  prototype，且对 Map/Set/Date 只当普通对象处理。报告内的数据都是 JSON 形状，当前影响有限。
- **`redactText` 每次新建 RegExp**（`new RegExp(re.source, re.flags)`，redact.ts:75）：
  因为原正则带 `g` 标志，复用会有 `lastIndex` 状态。这条是正确的写法，spec 记录以免重构时"优化"掉。

## report-present

抽这一层的理由（present.ts:4-11）：三面外壳必然不同，但"看到的事实"必须来自同一批字段；
若把「哪条断言算失败」各写一遍，迟早出现"md 说 2 条、junit 说 3 条"的漂移。

### 边界与已知缺陷

- `assertionWord` 依赖"Schema 保证一行只有一个判定词"（present.ts:22, 25-27）；但
  `assert.ts:96-121` 的求值层**允许多词 AND**，而 `cases/schema.ts:305-310` 才禁止一行多词。
  若校验被绕过，报告只会显示**第一个**判定词、期望值也只有第一个——信息静默丢失。
- `truncate` 的截断标记是 `…(N)`（含原长度），不是 `…`（present.ts:104-107）——对拍时这是
  确定性文本，不要当成随机。
