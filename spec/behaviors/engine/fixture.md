---
domain: engine
module: fixture
revision: 1

atomics:
  - id: BEH-ENGINE-FIXTURE-001
    title: fixture-registry —— 干预登记与运行期取证（add / note / noteAppend / snapshot）
    atomic: fixture-registry
    status: active
    source:
      file: src/runtime/fixture.ts
      lines: "8-58"
      symbols:
        - DisposeEntry
        - Fixture
        - notesMap
        - add
        - note
        - noteAppend
        - getNote
        - snapshot
      tests:
        - tests/fixture.test.mjs::note / noteAppend / snapshot
        - tests/fixture.test.mjs::释放后再登记会立即执行 dispose（防泄漏）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "Fixture 尚未 release"
        when: "fixture.add('label', dispose)"
        then: "把 { label, dispose } 压进内部 disposers 栈；此时**不执行** dispose（延迟到 release）"
        verdict: pass
        tests: []
        source: { file: "src/runtime/fixture.ts", lines: "23-31" }
      - given: "Fixture 已经 release"
        when: "再次 fixture.add('late', dispose)"
        then: "立即执行 dispose（Promise.resolve 包裹），并 catch 吞掉失败——释放后再登记说明 driver 时序有问题，防的是泄漏，不是报错"
        verdict: pass
        tests: ["tests/fixture.test.mjs::释放后再登记会立即执行 dispose（防泄漏）"]
        source: { file: "src/runtime/fixture.ts", lines: "24-30" }
      - given: "任意 key 与 value"
        when: "fixture.note('k', v)"
        then: "notesMap.set(key, value)；同名再写直接覆盖（case 层 notes 只保留最终值）"
        verdict: pass
        tests: ["tests/fixture.test.mjs::note / noteAppend / snapshot"]
        source: { file: "src/runtime/fixture.ts", lines: "33-36" }
      - given: "noteAppend 累积语义"
        when: "fixture.noteAppend('reqs', x) 连续调用"
        then: "当前值是数组则 push；否则新建 [value]；同名多次即累积成列表"
        verdict: pass
        tests: ["tests/fixture.test.mjs::note / noteAppend / snapshot"]
        source: { file: "src/runtime/fixture.ts", lines: "38-43" }
      - given: "读取未登记过的 key"
        when: "fixture.getNote('never')"
        then: "返回 undefined（不抛）；这正是 ref 的 fx 前缀能表达 exists:false 的前提"
        verdict: pass
        tests: []
        source: { file: "src/runtime/fixture.ts", lines: "45-48" }
      - given: "取全部取证"
        when: "fixture.notes"
        then: "返回内部 Map 本身（类型标注 ReadonlyMap）；注意这是**同一个对象**，不是拷贝"
        verdict: pass
        tests: []
        source: { file: "src/runtime/fixture.ts", lines: "50-53" }
      - given: "序列化进报告前的快照"
        when: "fixture.snapshot()"
        then: "返回 Object.fromEntries(notesMap) 的普通对象浅拷贝（每次调用新建对象）"
        verdict: pass
        tests: ["tests/fixture.test.mjs::note / noteAppend / snapshot"]
        source: { file: "src/runtime/fixture.ts", lines: "55-58" }
    cleanup: registered
    nonDeterministic:
      - field: "Fixture.snapshot() 的路径类键"
        reason: "driver 写入的 tmpdir / 绝对路径随运行变化"
        reconcile: normalize-path
    equivalence:
      notes: sorted-set

  - id: BEH-ENGINE-FIXTURE-002
    title: fixture-release —— 逆序释放、失败不阻断、幂等
    atomic: fixture-release
    status: active
    source:
      file: src/runtime/fixture.ts
      lines: "13-88"
      symbols:
        - ReleaseReport
        - release
        - disposers
        - released
        - describeError
      tests:
        - tests/fixture.test.mjs::逆序释放
        - tests/fixture.test.mjs::单个释放失败不阻断其余释放
        - tests/fixture.test.mjs::release 幂等
        - tests/fixture.test.mjs::异步 disposer 也会被 await
        - tests/isolation.test.mjs::releaseStepNotes：释放其一，另一个仍由夹具兜底释放（且不重复释放）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "登记了 a、b、c 三个 disposer"
        when: "fixture.release()"
        then: "按登记顺序的**逆序**执行（c → b → a）；released 数组按实际执行顺序记 label"
        verdict: pass
        tests: ["tests/fixture.test.mjs::逆序释放"]
        source: { file: "src/runtime/fixture.ts", lines: "71-79" }
      - given: "某个 disposer 抛错"
        when: "release 执行到它"
        then: "该失败进 failures.push({ label, error: describeError(error) })，**不阻断**其余释放（继续跑完整个栈）"
        verdict: pass
        tests: ["tests/fixture.test.mjs::单个释放失败不阻断其余释放"]
        source: { file: "src/runtime/fixture.ts", lines: "73-78" }
      - given: "释放失败的错误描述"
        when: "dispose 抛 Error 实例 / 抛其它值"
        then: "Error → `<name>: <message>`；其它 → String(error)"
        verdict: pass
        tests: []
        source: { file: "src/runtime/fixture.ts", lines: "85-88" }
      - given: "release 幂等"
        when: "对同一个 Fixture 再调 release()"
        then: "released 标记已置 → 直接返回空 report { released: [], failures: [] }，不重复执行任何 dispose"
        verdict: pass
        tests: ["tests/fixture.test.mjs::release 幂等", "tests/isolation.test.mjs::releaseStepNotes：释放其一，另一个仍由夹具兜底释放（且不重复释放）"]
        source: { file: "src/runtime/fixture.ts", lines: "66-69" }
      - given: "释放完成后的栈状态"
        when: "release 跑完一轮"
        then: "disposers.length 置 0（栈清空）；再次 release 已由幂等短路"
        verdict: pass
        tests: []
        source: { file: "src/runtime/fixture.ts", lines: "80" }
      - given: "异步 disposer"
        when: "dispose 返回 Promise"
        then: "await entry.dispose()——必须真的等到完成才继续下一个（否则退回「没拆掉」）"
        verdict: pass
        tests: ["tests/fixture.test.mjs::异步 disposer 也会被 await"]
        source: { file: "src/runtime/fixture.ts", lines: "74" }
      - given: "release 的返回结构"
        when: "成功 / 有失败"
        then: "ReleaseReport = { released: string[], failures: Array<{label,error}> }；两者都不含时间或路径字段"
        verdict: pass
        tests: []
        source: { file: "src/runtime/fixture.ts", lines: "13-16, 67" }
    cleanup: registered
    nonDeterministic:
      - field: "ReleaseReport.failures[].error"
        reason: "disposer 抛出的错误原文（可能内嵌绝对路径）"
        reconcile: normalize-path
    equivalence:
      released: exact-order
      failures: sorted-set
---

# fixture —— 夹具容器（可回滚纪律的落点）

`src/runtime/fixture.ts` 是 [REWRITE-DESIGN.md §6.2](../../../../docs/REWRITE-DESIGN.md)
「隔离与回滚」在旧实现里的**登记入口**：所有对活宿主的干预（工具 / 命令 / 事件监听 /
假 provider）都必须经 `Fixture.add()` 登记，场景结束时由 `release()` **逆序**释放
（文件头注 line 3-5）。设计 §1.2 line 57 给它的去向是「Rust `FixtureScope` + TS 注册面」，
迁移性质是**变更（保留逆序释放语义）**。

命名依据：源码只有两个可独立 pass/fail 的单元——**登记/取证**（`add` / `note*` / `snapshot`）
与**释放**（`release`）。前者决定"报告里能看到什么"，后者决定"跑完能不能回到干净状态"，
两者能各自失败（取证缺失 vs 释放泄漏），故拆成 `fixture-registry` 与 `fixture-release`。

## fixture-registry

一条核心纪律：**登记不等于执行**。`add()` 只压栈，真正执行在 `release()`。
唯一的例外是"释放后再登记"——那时立即执行 dispose 并吞掉失败（防泄漏优先于报错）。

## fixture-release

设计 §6.2 的五条纪律里，本原子承担第 1、2 条（登记进释放栈、逆序执行、失败不静默）。
`released` / `leftovers` 这对字段里，**`released` 的夹具级形态是 `ReleaseReport.released`**；
`leftovers` 属于 `CleanupRecord`（`src/runtime/runlog.ts:49-54`），由 isolation 侧填充——见
`isolation.md` 的 `isolation-probe`。

### 边界与已知缺陷

- **没有"按 label 单独释放"入口**：`Fixture` 只暴露 `add(label, dispose)` 与整份 `release()`，
  不允许从外部摘下已登记条目。步骤级清理因此另造了一套句柄（`src/isolation/cleanup.ts:12-25`
  的注释明确记了这件事）。阶段 1 的 `FixtureScope` 若要支持按标签释放，是**新增能力**，
  不是既有行为。
- **`notes` getter 返回内部 Map 本体**（`fixture.ts:51-53`）：类型是 `ReadonlyMap`，
  运行期仍可由持有者改写内部状态（TS 只读修饰不产生运行时拷贝）。`snapshot()` 才是不共享的浅拷贝。
- **`release()` 失败只记不抛**：这保证了 `finally` 里的兜底释放不会盖掉真正的失败结论
  （`runner.ts:499-501` 依赖这一点），但也意味着"释放失败"永远只出现在
  `releaseFailures`，不会把 case 变成 errored。
- **`released` 记录的是"尝试过且未抛错"的 label**：抛错的 label 只出现在 `failures`，
  不出现在 `released`（同一项不会两处都有）。
