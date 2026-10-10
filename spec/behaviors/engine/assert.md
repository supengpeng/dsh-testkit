---
domain: engine
module: assert
revision: 1

atomics:
  - id: BEH-ENGINE-ASSERT-001
    title: assert-evaluate —— 单个 Assertion 的判定求值（14 判定词 + soft + 多词 AND）
    atomic: assert-evaluate
    status: active
    source:
      file: src/runtime/assert.ts
      lines: "22-241"
      symbols:
        - ASSERTION_KEYS
        - evaluateAssertion
        - deepEqual
        - parseRegexLiteral
        - lengthOf
      tests:
        - tests/assert.test.mjs::is 走深比较
        - tests/assert.test.mjs::exists / notExists 区分 undefined 与 null
        - tests/assert.test.mjs::数值与长度判定
        - tests/assert.test.mjs::contains 支持字符串与数组
        - tests/assert.test.mjs::matches 支持 /pattern/flags 字面量
        - tests/assert.test.mjs::多个判定词必须同时成立（AND）
        - tests/assert.test.mjs::缺少判定词视为失败
        - tests/assert.test.mjs::deepEqual 与 parseRegexLiteral 的边界
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "判定词 is，actual 与 expected 为同形对象或同类型标量"
        when: "evaluateAssertion({ref:'fx.a', is:{x:[1,2]}}, {x:[1,2]})"
        then: "ok=true；数组长度相同且逐元素 deepEqual；对象键集相同且逐键 deepEqual；a===b 走快路径"
        verdict: pass
        tests: ["tests/assert.test.mjs::is 走深比较"]
        source: { file: "src/runtime/assert.ts", lines: "42-60, 125-128" }
      - given: "判定词 is，actual 与 expected 类型不同（1 与 '1'）或数组顺序不同（[1,2] 与 [2,1]）"
        when: "evaluateAssertion({ref:'fx.a', is:1}, '1')"
        then: "ok=false；message 形如 期望 is 1，实际 \"1\""
        verdict: fail
        tests: ["tests/assert.test.mjs::is 走深比较"]
        source: { file: "src/runtime/assert.ts", lines: "44, 125-128" }
      - given: "判定词 isNot"
        when: "evaluateAssertion({ref:'fx.a', isNot:1}, 2)"
        then: "ok=true；两者 deepEqual 时 ok=false，message 为 期望不等于 1，但相等"
        verdict: pass
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "130-134" }
      - given: "判定词 notIs"
        when: "evaluateAssertion({ref:'fx.a', notIs:1}, 2)"
        then: "与 isNot 共用同一 case 分支、同语义：!deepEqual → ok=true，失败消息同 isNot"
        verdict: pass
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "130-134" }
      - given: "判定词 exists，actual 为 undefined 或 null"
        when: "evaluateAssertion({ref:'fx.a', exists:true}, undefined)"
        then: "ok=false（undefined 与 null 都算不存在）；actual=0 / '' / false 都算存在 → ok=true"
        verdict: pass
        tests: ["tests/assert.test.mjs::exists / notExists 区分 undefined 与 null"]
        source: { file: "src/runtime/assert.ts", lines: "136-139" }
      - given: "判定词 exists 的期望值写成 false（反向表达）"
        when: "evaluateAssertion({ref:'fx.a', exists:false}, undefined)"
        then: "ok=true；实现比较 Boolean(expected) 与 存在性 是否相等，所以 exists:false 合法且常用"
        verdict: pass
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "137" }
      - given: "判定词 notExists"
        when: "evaluateAssertion({ref:'fx.a', notExists:true}, undefined)"
        then: "ok=true；actual 非 null/undefined 时 ok=false（0 / '' / false 仍算存在）"
        verdict: pass
        tests: ["tests/assert.test.mjs::exists / notExists 区分 undefined 与 null"]
        source: { file: "src/runtime/assert.ts", lines: "141-144" }
      - given: "判定词 contains，actual 为字符串"
        when: "evaluateAssertion({ref:'fx.s', contains:'abc'}, 'xxabcxx')"
        then: "ok=true；expected 经 String() 转换后做 includes 子串判断"
        verdict: pass
        tests: ["tests/assert.test.mjs::contains 支持字符串与数组"]
        source: { file: "src/runtime/assert.ts", lines: "146-151" }
      - given: "判定词 contains，actual 为数组"
        when: "evaluateAssertion({ref:'fx.a', contains:{x:1}}, [{x:1}])"
        then: "ok=true；逐元素走 deepEqual（对象元素按结构比较，不是引用比较）"
        verdict: pass
        tests: ["tests/assert.test.mjs::contains 支持字符串与数组"]
        source: { file: "src/runtime/assert.ts", lines: "152-156" }
      - given: "判定词 contains，actual 既不是字符串也不是数组（number / null / object）"
        when: "evaluateAssertion({ref:'fx.n', contains:1}, 5)"
        then: "ok=false；message 为 contains 不适用于 number（类型不匹配判失败，不 throw）"
        verdict: fail
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "157" }
      - given: "判定词 notContains（字符串与数组两个分支）"
        when: "evaluateAssertion({ref:'fx.a', notContains:9}, [1,2,3])"
        then: "ok=true；命中则 ok=false；类型不匹配时 ok=false 且 message 为 notContains 不适用于 <type>"
        verdict: pass
        tests: ["tests/assert.test.mjs::contains 支持字符串与数组"]
        source: { file: "src/runtime/assert.ts", lines: "160-172" }
      - given: "判定词 matches，actual 为字符串、expected 为 /pattern/flags 字面量"
        when: "evaluateAssertion({ref:'fx.s', matches:'/ABC/i'}, 'xxabc')"
        then: "ok=true；解析出 flags；非法字面量（RegExp 构造抛错）时落回 new RegExp(整串)，即按普通字符串模式匹配"
        verdict: pass
        tests: ["tests/assert.test.mjs::matches 支持 /pattern/flags 字面量"]
        source: { file: "src/runtime/assert.ts", lines: "70-80, 174-177" }
      - given: "判定词 matches，actual 不是字符串"
        when: "evaluateAssertion({ref:'fx.n', matches:'/x/'}, 123)"
        then: "ok=false；message 为 matches 需要字符串，实际 number（不 throw）"
        verdict: fail
        tests: ["tests/assert.test.mjs::matches 支持 /pattern/flags 字面量"]
        source: { file: "src/runtime/assert.ts", lines: "175" }
      - given: "判定词 matches，expected 是会让 RegExp 构造抛错的非法模式"
        when: "evaluateAssertion({ref:'fx.s', matches:'/[/'}, 'x')"
        then: "parseRegexLiteral 内部 catch 后仍可能抛 SyntaxError；该异常不被本模块捕获，会冒泡出断言循环（见边界 6）"
        verdict: fail
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "70-80, 176" }
      - given: "判定词 atLeast"
        when: "evaluateAssertion({ref:'fx.n', atLeast:3}, 3)"
        then: "ok=true；actual 必须 typeof number（'3' 字符串判 ok=false）；expected 走 Number()；等于边界 ok=true"
        verdict: pass
        tests: ["tests/assert.test.mjs::数值与长度判定"]
        source: { file: "src/runtime/assert.ts", lines: "180-183" }
      - given: "判定词 atMost"
        when: "evaluateAssertion({ref:'fx.n', atMost:10}, 11)"
        then: "ok=false；等于上限时 ok=true（<=）；actual 非 number 一律 ok=false"
        verdict: pass
        tests: ["tests/assert.test.mjs::数值与长度判定"]
        source: { file: "src/runtime/assert.ts", lines: "185-188" }
      - given: "判定词 length，actual 为字符串 / 数组 / Map / Set"
        when: "evaluateAssertion({ref:'fx.s', length:3}, 'abc')"
        then: "ok=true；字符串与数组取 .length，Map 与 Set 取 .size；其它类型 lengthOf 返回 undefined → ok=false，message 为 length 需要可长度对象，实际 <type>"
        verdict: pass
        tests: ["tests/assert.test.mjs::数值与长度判定"]
        source: { file: "src/runtime/assert.ts", lines: "63-67, 190-196" }
      - given: "判定词 lengthAtLeast"
        when: "evaluateAssertion({ref:'fx.s', lengthAtLeast:2}, 'abc')"
        then: "ok=true（len >= want）；不可长度对象 → ok=false 且 message 同 length"
        verdict: pass
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "197" }
      - given: "判定词 lengthAtMost"
        when: "evaluateAssertion({ref:'fx.s', lengthAtMost:2}, 'abc')"
        then: "ok=false（3 > 2）；不可长度对象 → ok=false 且 message 同 length"
        verdict: pass
        tests: ["tests/assert.test.mjs::数值与长度判定"]
        source: { file: "src/runtime/assert.ts", lines: "198" }
      - given: "判定词 throws"
        when: "evaluateAssertion({ref:'fx.err', throws:true}, <任意 actual>)"
        then: "ok 只由 Boolean(expected) 决定：throws:true 恒 ok=false（消息 期望抛错，但取值成功），throws:false 恒 ok=true；actual 参数完全不被读取"
        verdict: fail
        tests: []
        source: { file: "src/runtime/assert.ts", lines: "201-202" }
      - given: "soft 修饰符（不是判定词，不参与 check 分支）"
        when: "assertion 带 soft:true 且判定 ok=false"
        then: "runner 记为 AssertionOutcome{ok:false, soft:true}；hasHardFailure 与 present.failingAssertions 都排除 soft，故不改变 case verdict；report.md 渲染为 ⚠️(soft)"
        verdict: pass
        tests: ["tests/report-standard.test.mjs::classifyCase：软断言失败不算硬失败（不改变 verdict 的证据）"]
        source: { file: "src/runtime/runner.ts", lines: "578-580, 741, 752" }
      - given: "一个 Assertion 对象里出现多个判定词"
        when: "evaluateAssertion({ref:'fx.n', atLeast:1, atMost:5}, 3)"
        then: "全部判定词都必须通过（AND）；任一失败返回该条 message；全过时 message 为 <ref> 满足 <词1 + 词2>，词序由 ASSERTION_KEYS 固定"
        verdict: pass
        tests: ["tests/assert.test.mjs::多个判定词必须同时成立（AND）"]
        source: { file: "src/runtime/assert.ts", lines: "96-121" }
      - given: "一个 Assertion 对象没有任何判定词（只给 ref，或只给 soft）"
        when: "evaluateAssertion({ref:'fx.a'}, 1)"
        then: "ok=false；message 为 断言缺少判定词（fx.a 只给了 ref）"
        verdict: fail
        tests: ["tests/assert.test.mjs::缺少判定词视为失败"]
        source: { file: "src/runtime/assert.ts", lines: "97-106" }
      - given: "设计 §3.3 要求 AssertionOutcome 四态 Passed/Failed/Skipped/Inconclusive"
        when: "对照既有 src/** 与 tests/** 的全部实现与用例"
        then: "既有实现只有 ok:boolean 两态（AssertionResult.ok）；Skipped 是场景级语义（SkipCase → CaseVerdict='skipped'），断言级不存在；Inconclusive 全仓零命中，是阶段 1 新增；RunTotals 也没有 inconclusive 计数"
        verdict: skip
        tests: []
        source: { file: "src/runtime/runlog.ts", lines: "9, 56-62, 125-131" }
    cleanup: none
    nonDeterministic:
      - field: "AssertionResult.actual / AssertionOutcome.actual"
        reason: "取值来自 driver 取证，可能含绝对路径、临时目录名、浮点数与平台相关输出；deepEqual 不做容差"
        reconcile: normalize-path
      - field: "AssertionResult.message / AssertionOutcome.message"
        reason: "失败消息内嵌 describe(actual) 的 JSON 形态，随被测数据变化；成功消息含固定词序"
        reconcile: normalize-path
    equivalence:
      verdict: exact
      soft: exact
      actual: by-type
      message: normalize-path

  - id: BEH-ENGINE-ASSERT-002
    title: assert-resolve-ref —— ref 取值路径的前缀语义与 fx 容器纪律
    atomic: assert-resolve-ref
    status: active
    source:
      file: src/runtime/refs.ts
      lines: "14-55"
      symbols:
        - resolveRef
        - RefSources
        - RefResolution
      tests:
        - tests/scenario-run.test.mjs::端到端：cases/ 下的全部场景在 headless 宿主里按要求通过或跳过
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "ref 以 fx. 开头"
        when: "resolveRef('fx.a.b', sources)"
        then: "found=true；值 = resolvePath(fixture.snapshot(), 'a.b')；未记过的键取到 undefined 而不是取值失败（fx 是存在的容器）"
        verdict: pass
        tests: ["tests/scenario-run.test.mjs::端到端：cases/ 下的全部场景在 headless 宿主里按要求通过或跳过"]
        source: { file: "src/runtime/refs.ts", lines: "43-47" }
      - given: "ref 以 case. 开头"
        when: "resolveRef('case.title', sources)"
        then: "found=true；值 = resolvePath(scenario, 'title')"
        verdict: pass
        tests: []
        source: { file: "src/runtime/refs.ts", lines: "48-49" }
      - given: "ref 以 env. 开头"
        when: "resolveRef('env.dshVersion', sources)"
        then: "found=true；值 = resolvePath(env, 'dshVersion')（env 含 dshVersion / platform / nodeVersion）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/refs.ts", lines: "14-19, 50-51" }
      - given: "ref 的前缀不属于 fx / case / env"
        when: "resolveRef('bogus.x', sources)"
        then: "found=false；value=undefined；reason 为 未知 ref 前缀：bogus（只有未知前缀才算取值失败）"
        verdict: fail
        tests: []
        source: { file: "src/runtime/refs.ts", lines: "52-53" }
      - given: "ref 不含点号（无论写成什么）"
        when: "resolveRef('fx', sources)"
        then: "found=false；reason 为 ref 缺少前缀：fx"
        verdict: fail
        tests: []
        source: { file: "src/runtime/refs.ts", lines: "36-37" }
      - given: "ref 路径解析的语法边界"
        when: "resolvePath(root, 'a.b[0].c') / 'a.missing' / '' / 下标作用在非数组上"
        then: "支持点分段与 [n] 下标；中途遇 undefined/null 或非对象返回 undefined；空路径返回 root 本身；下标落在非数组上返回 undefined"
        verdict: pass
        tests: ["tests/assert.test.mjs::resolvePath 支持点路径与下标"]
        source: { file: "src/runtime/assert.ts", lines: "219-241" }
      - given: "resolveRef 返回 found=false 时 runner 合成断言结论"
        when: "runner 的断言循环拿到 { found:false, reason }"
        then: "AssertionOutcome.ok = evaluated.ok && resolved.found 恒为 false；message 取 resolved.reason（或 取值失败）；actual 写 resolved.value（undefined）"
        verdict: fail
        tests: []
        source: { file: "src/runtime/runner.ts", lines: "730-743" }
    cleanup: none
    nonDeterministic:
      - field: "RefResolution.reason"
        reason: "未知前缀时拼入触发方给的 ref 文本，随场景数据变化"
        reconcile: normalize-path
    equivalence:
      found: exact
      value: by-type
      reason: normalize-path
---

# assert —— 断言求值模块

本文件覆盖旧实现 `src/runtime/assert.ts`（断言求值）与 `src/runtime/refs.ts`（取值路径解析）
两个文件的可观察行为，以及它们与 `src/runtime/runner.ts` 断言循环的接口契约。

分工（重构时必须保持的边界）：

```text
Assertion.ref ──resolveRef()──► { found, value }            refs.ts:35-54
                    │
Assertion ──evaluateAssertion(assertion, value)──► { ok, actual, message }   assert.ts:96-121
                    │
        runner 合成 AssertionOutcome{ ok: ok && found, soft }   runner.ts:736-742
```

**命名依据（engine 域没有设计文档硬约束，按源码事实定）**：设计
[REWRITE-DESIGN.md §3.3](../../../../docs/REWRITE-DESIGN.md) 的 `AssertionEngine` 有四个方法
（`assert` / `assert_all` / `register` / `registered_names`）。既有实现里：

- `assert` / `assert_all` 对应 `evaluateAssertion` → 落 `assert-evaluate`（唯一有既有实现的求值原子）；
- `register` / `registered_names` 在 `src/**` **完全不存在**（没有可插拔断言求值器、没有注册表），
  所以**不为它落条目**——spec 只记旧实现的可观察行为，阶段 1 新增面由设计文档承担；
- `ref` 的取值路径解析住在独立文件 `src/runtime/refs.ts`，能独立 pass/fail，落 `assert-resolve-ref`。

## assert-evaluate

对**一个** `Assertion` 对象求值：先从 `ASSERTION_KEYS` 里挑出实际出现的判定词
（`assertion[k] !== undefined`），再逐个走 `check()`；任一失败立即返回该条的 message，
全过返回 `{ ok:true, message: "<ref> 满足 <词1 + 词2>" }`。

### 断言词清单：文档说 17 个，源码四处都是 16 项（**计数矛盾，如实记录**）

设计 §3.3（line 236）写「沿用今天的 **17** 个」，随后列出的清单是
`is` / `isNot` / `notIs` / `exists` / `notExists` / `contains` / `notContains` / `matches` /
`atLeast` / `atMost` / `length` / `lengthAtLeast` / `lengthAtMost` / `throws` / `soft` + `ref`
—— **14 + 2 = 16 项**。逐真源核对（Verify, Don't Assume）：

| 真源 | 位置 | 词数 |
|---|---|---|
| `ASSERTION_KEYS`（求值实现） | `src/runtime/assert.ts:22-37` | **14** |
| `ASSERTION_WORDS`（case 校验） | `src/cases/schema.ts:50-65` | **14** |
| `ASSERTION_WORDS`（片段校验） | `src/registry/loader.ts:91-106` | **14** |
| `ASSERTION_WORDS`（归因依据） | `src/analysis/causes.ts:89-104` | **14** |
| `Assertion` 接口 | `src/cases/types.ts:107-128` | 14 + `soft` |
| run-report schema 的 `assertion` | `schemas/run-report.schema.json:238-286` | 14 + `soft` |
| SCENARIO-SPEC §2.5 表 | `docs/SCENARIO-SPEC.md:375-393` | 14（`ref` 表外，`soft` 在 line 392） |

**结论**：14 个判定词 + `soft`（修饰符）+ `ref`（取值路径）= **16 项**；四份源码数组完全一致，
无漂移；**不存在第 17 个词**（无 `notMatches` / `in` / `near` 之类）。这是设计文档的**计数缺陷**，
不是实现漏词。阶段 1 若写「沿用 17 个」必须先裁决：按 16 项清单，还是新增第 17 个（那要改
cases schema 语义，需另立 RFC）。

### 逐词覆盖（16/16，每词至少一条 observable）

`is` / `isNot` / `notIs` / `exists` / `notExists` / `contains` / `notContains` / `matches` /
`atLeast` / `atMost` / `length` / `lengthAtLeast` / `lengthAtMost` / `throws` /
`soft`（见本条目 observable 表）；`ref` 见 `assert-resolve-ref`。

### 四态判定：既有实现只有两态，`Inconclusive` 不存在

设计 §3.3（line 222-234）要求 `AssertionOutcome` 四态：

| 设计四态 | 既有对应物 | 位置 | 结论 |
|---|---|---|---|
| `Passed` | `AssertionResult.ok === true` → `AssertionOutcome.ok === true` | `assert.ts:115-121`；`runner.ts:736-742` | 有对应（布尔，无细节） |
| `Failed` | `AssertionResult.ok === false` → `AssertionOutcome.ok === false` | `assert.ts:100-113`；`runner.ts:738` | 有对应（布尔） |
| `Skipped{reason}` | **断言级没有**；最接近的是场景级 `SkipCase` → `CaseVerdict='skipped'` + `CaseOutcome.skipReason` | `runner.ts:443-448, 473-476, 718-723`；`runlog.ts:9, 88-89` | **层级不同**（跳的是一条 case） |
| `Inconclusive{reason}` | **不存在**（全仓 grep 只在 `docs/` 命中） | `runlog.ts:125-131` 的 RunTotals 也无 `inconclusive` 计数 | **阶段 1 新增** |

设计 §8.1（line 711）明确「`Inconclusive` 是断言结果，不是可信度」，§8.4（line 745-746）规定
它在 `freeze`/`release` 档视为失败、连续 3 次升级为失败——这些**在既有实现与既有测试中都不存在**。
另外 §3.3（line 230）要求「必须计入报告的 `inconclusive` 计数」，而
`schemas/run-report.schema.json:60-82` 的 `totals` 只有 total/passed/failed/skipped/errored
——阶段 1 需同时扩 `RunTotals` 与 report schema。

> 纪律：不为对齐设计文档而**编造**既有实现有 `Inconclusive` 分支。

### 边界与已知缺陷

**缺陷 1（必须裁决）：`throws` 是空实现，且零测试覆盖。**
`src/runtime/assert.ts:201-202` 只读 `expected`，`actual` 完全没被使用：
`throws:true` 恒 `ok=false`，`throws:false` 恒 `ok=true`。它**无法表达** SCENARIO-SPEC
line 388 的「求值过程应抛错」。全仓 grep（作为断言词的）`throws:` 在 `tests/**` 与
`cases/**` 零命中 —— 没有用例覆盖它。阶段 1 必须二选一：删词（改 schema 语义需 RFC），
或补齐「把抛错折成 actual 标记」的取值链。

**缺陷 2：`notIs` 是 `isNot` 的别名。** `assert.ts:130-131` 同分支。SCENARIO-SPEC line 390
措辞是「任何断言词前加 `not`」，但实现只给了 `isNot`+`notIs` / `notContains` / `notExists`
三种否定变体，**没有** `notMatches`。文档口径宽于实现。

**缺陷 3：`isNot` 的失败消息与词名不一致。** `assert.ts:134` 两个词共用
「期望不等于 X，但相等」，报告里看不出用的是哪个词（成功 message 才含 `present.join`）。

**边界 4（有意行为，应保留）：多词 AND。** `assert.ts:108-113` 让全部出现的判定词都要过；
但 `src/cases/schema.ts:305-310` 在**校验期**就禁止一行多词（`一行只允许一个判定词`）。
求值层的 AND 是兜底，不是合法输入。两条都要保留。

**边界 5：类型不匹配不抛错。** `contains`/`notContains`/`matches`/`length*`/`atLeast`/`atMost`
遇到不适用类型一律返回 `ok=false` + 说明性 message（"断言失败不是异常"纪律）。

**边界 6（应显式裁决）：非法正则可能炸整条 case。**
`parseRegexLiteral`（`assert.ts:70-80`）在 `new RegExp` 抛错时落回整串构造；若整串**也**非法
（如 `matches: '/[/'`），`new RegExp` 仍会抛 `SyntaxError`。runner 的断言循环
（`runner.ts:729-744`）**没有 try/catch**，异常会冒泡到 `runOne` 的 catch，使整条 case 变
`errored`（而非 failed）。当前无测试覆盖。

**边界 7：`fx` 容器语义是已修正的缺陷。** `refs.ts:43-47` 注释记：缺失键曾被判为取值失败，
导致 `exists:false` 永远无法表达，由 `cases/TK-0001.yaml` 暴露后修正。spec 只记当前语义。

### 测试覆盖缺口（阶段 0 的有效发现）

| 无覆盖 | 说明 |
|---|---|
| `isNot` / `notIs` | `tests/assert.test.mjs` 未直接覆盖 |
| `throws` | 全仓零覆盖，且实现是空壳（缺陷 1） |
| `lengthAtLeast` | 未覆盖（`length` / `lengthAtMost` 有） |
| `contains` 类型不匹配分支 | 未覆盖 |
| `exists:false` 反向表达 | 单元层未覆盖；端到端由 30+ 条 `cases/TK-*.yaml` 覆盖 |
| 非法正则冒泡 → errored | 未覆盖 |
| 断言级 `Skipped` / `Inconclusive` | 既有实现不存在，自然无覆盖 |

## assert-resolve-ref

把 `Assertion.ref` 解析成实际值。前缀只有三种（`src/cases/schema.ts:301-303` 在**校验期**
用 `/^(fx|case|env)\./` 把其它前缀挡在门外）：`fx.*`（Fixture 取证）、`case.*`（场景自身字段）、
`env.*`（dshVersion / platform / nodeVersion）。

**`fx` 的容器语义（关键纪律）**：Fixture 的 notes 是**存在的容器**，没有记过的 key 就是
`undefined`，**不是取值失败**。只有未知前缀才算 `found=false`。这条语义让
`exists:false`（断言"这件事没有发生"）成为合法表达，是本仓最常用的断言形态之一。

### 边界与已知缺陷

- **无单元测试**：`tests/**` 直接 grep `resolveRef` 零命中（`report-standard.test.mjs:312`
  里那个 `resolveRef` 是该测试文件自己的 JSON Schema `$ref` 解析函数，同名不同物）。
  现有覆盖只有端到端：`tests/scenario-run.test.mjs` 跑全部 `cases/**`，其中 40+ 处
  `exists:false` 依赖本语义。阶段 1 迁移后应补 `resolveRef` 的单元用例。
- **未知前缀与缺前缀都 `found=false`，但 `reason` 措辞不同**（`未知 ref 前缀：<p>` /
  `ref 缺少前缀：<ref>`）；对拍按 `normalize-path` 处理。
- **`case.*` 的读取面是整条 `Scenario` 对象**（`refs.ts:49`），包括 `setup` / `steps` 等
  大字段——`case.steps[0]...` 这类路径理论可达，但 SCENARIO-SPEC line 365 注明「用于自检，少用」。
