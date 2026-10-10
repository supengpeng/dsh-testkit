---
domain: kinds
module: shell
revision: 1

atomics:
  - id: BEH-KIND-SHELL-001
    title: run-argv —— 跑一条外部命令（argv 数组）并取证输出与退出码
    atomic: run-argv
    status: active

    source:
      file: src/kinds/shell.ts
      lines: "181-286"
      symbols:
        - "shellDriver"
        - "ShellSetup"
        - "findPython"
        - "expandTokens"
        - "expandArgvTokens"
        - "readAll"
        - "shellConfigs"
        - "describe"
      tests:
        - "tests/shell-driver.test.mjs::readAll：按偏移读干净并拼接"
        - "tests/shell-driver.test.mjs::readAll：reader 缺失时返回空而不是抛错"
        - "tests/shell-driver.test.mjs::readAll：lossy 会被如实带出（截断可被发现）"
        - "tests/shell-driver.test.mjs::readAll：offset 不前进时立即停止（防实现有 bug 时死循环）"
        - "tests/shell-driver.test.mjs::act：成功路径把退出码与输出写进取证"
        - "tests/shell-driver.test.mjs::act：spawn 抛错如实记账（不崩）"
        - "tests/shell-driver.test.mjs::act：resolveExecutable 失败也记账（这是常见真实故障）"
        - "tests/shell-driver.test.mjs::act：done reject 时记账但不崩"
        - "tests/shell-driver.test.mjs::act：宿主没有 subprocess 时跳过"
        - "tests/shell-driver.test.mjs::act：setup 的 cwd/env 会被带入 spawn 规格"
        - "tests/shell-driver.test.mjs::act：动作里的 cwd/env 覆盖 setup"
        - "tests/shell-driver.test.mjs::act：显式 cwd 不存在时跳过并说明（依赖未准备的 fixture）"
        - "tests/shell-driver.test.mjs::act：stdin 省略时是 ignore，给了就喂数据"
        - "tests/shell-driver.test.mjs::act：argv 为空时报错（不静默）"
        - "tests/shell-driver.test.mjs::act：非 shell 动作直接报错"
        - "tests/shell-driver.test.mjs::findPython：显式环境变量优先（且必须是真实存在的文件）"
        - "tests/shell-driver.test.mjs::findPython：推不出自带 Python 时回退成裸名（交给 resolveExecutable）"
        - "tests/shell-driver.test.mjs::driver 元信息：kind=shell 且 requires 声明 subprocess"

    capabilities: ["subprocess"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "setup.shell = {}，宿主有 subprocess 服务"
        when: "act: { kind: shell, shell: { argv: ['$NODE', '-e', 'process.stdout.write(String(process.pid))'] } }"
        then: "fx.exitCode is 0；fx.stdout atLeast 1 个字符；fx.stderr is ''；fx.spawnError exists 为 false；fx.durationMs atLeast 0"
        verdict: pass
      - given: "命令以非零码退出"
        when: "act shell 跑该命令"
        then: "fx.exitCode is 1；场景仍判通过（**非零退出码不是失败**）"
        verdict: pass
      - given: "shell.argv 不是非空数组"
        when: "act: { kind: shell, shell: { argv: [] } }"
        then: "throws 为 true，错误信息 contains 'shell.argv 必须是非空数组'"
        verdict: fail
      - given: "setup.shell.cwd 或动作里的 cwd 指向不存在的目录"
        when: "act shell"
        then: "case 被标为 skipped（SkipCase），不是 failed，且说明指向外部 fixture 的准备脚本"
        verdict: skip
      - given: "宿主没有 subprocess 服务（或拿不到 spawn）"
        when: "act shell"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "宿主提供 resolveExecutable 且解析失败"
        when: "act shell"
        then: "fx.spawnError contains '解析可执行文件失败'；fx.exitCode exists 为 false；不抛"
        verdict: fail
      - given: "subprocess.spawn 同步抛错"
        when: "act shell"
        then: "fx.spawnError 是非空字符串；fx.durationMs exists 为 true；不抛"
        verdict: fail
      - given: "handle.done reject"
        when: "act shell"
        then: "fx.runError 是非空字符串；不抛"
        verdict: fail
      - given: "setup.shell.env = { A: '1' }，动作 env = { A: '2', B: '3' }"
        when: "act shell"
        then: "进程看到的 A is '2'、B is '3'（动作级覆盖 setup 级，浅合并）"
        verdict: pass
      - given: "动作给 stdin: 'hello'；另一条不给 stdin"
        when: "分别 act shell"
        then: "给了的以 { data: 'hello' } 喂入；没给的以 'ignore' 关闭 stdin"
        verdict: pass
      - given: "输出超过 setup.shell.maxBytes（缺省 256 KiB）"
        when: "act shell"
        then: "fx.stdoutTruncated is true 或 fx.stderrTruncated is true（截断可被发现）"
        verdict: fail
      - given: "argv 含 $NODE / $PYTHON / $PKG / $FIXTURES 令牌"
        when: "act shell"
        then: "fx.shellArgv 里对应实参已被替换成真实路径（整段令牌，或 `$PKG/...` 前缀形式）"
        verdict: pass
      - given: "act 收到非 shell 动作"
        when: "把非 shell 的 StepAction 交给 shell driver"
        then: "throws 为 true，错误信息 contains 'shell driver 只支持'"
        verdict: fail

    cleanup: none

    nonDeterministic:
      - field: "fx.durationMs"
        reason: "挂钟时间差，含进程启动与调度抖动"
        reconcile: "ignore"
      - field: "fx.stdout / fx.stderr"
        reason: "输出内容取决于宿主运行时环境（node 版本号、进程 id、locale 等）"
        reconcile: "normalize:shell-output"
      - field: "fx.shellResolvedArgv0"
        reason: "由宿主 resolveExecutable 解析出的绝对路径，随安装位置变化"
        reconcile: "normalize:normalize-path"
      - field: "fx.shellCwd"
        reason: "缺省 process.cwd()，取决于调用时的运行目录"
        reconcile: "normalize:normalize-path"

    equivalence:
      verdict: exact
      exitCode: exact
      stdout: shell-output
      durationMs: ignore
---

## run-argv

**这个 driver 是被真实数据驱动出来的**：绝大多数「可回归候选」的判据都是同一形态——跑一条命令，看输出或退出码
（例如 `python -m md_cg.mcp_server` → 期望 `ModuleNotFoundError`；`git apply --check` → 期望退出 0）。
没有这个 kind 时这类 issue 只能"人工跑一遍看看"。

**两个刻意的设计**：

1. **`argv` 是数组**，与 DSH `subprocess.spawn` 一致——不经 shell 解析，所以没有引号/管道/重定向，也就没有注入面。
   要 shell 特性就显式调 `sh -c`。
2. **非零退出码不是失败**：命令"跑完了"本身就是结果，判由场景的断言决定；很多被测行为恰恰是"应该报错"。

**令牌替换（`expandTokens` / `expandArgvTokens`）**：

| 令牌 | 替换成 | 为什么需要 |
|---|---|---|
| `$NODE` | `process.execPath` | 本机 `node` 不在 PATH 上，写 `['node', ...]` 会 spawn 失败；而 DSH 自己就是 node 进程 |
| `$PYTHON` | 探测到的 Python 解释器 | DSH 桌面端自带 Python，但不在 PATH、无约定启动器 |
| `$PKG` | 本插件包根 | 场景不该硬编码绝对路径，但"跑包内脚本"需要知道包在哪 |
| `$FIXTURES` | 外部 fixture 根 | 被测对象（下载来的包）放在这里 |

只替换**整段**等于令牌的实参（不做子串替换），避免误伤正常路径；`$PKG/...` / `$FIXTURES/...` 前缀形式会被拼接
（后者委托给 `file.ts` 的 `expandPathTokens`）。

**输出读取（`readAll`）** 按 `nextOffset` 前进直到不再有新增——契约说读取是**非消费式**的（独立 reader 不互相吞输出）；
同时设 200 轮上限防止实现有 bug 时死循环。`lossy` 由 reader 如实带出。

### 边界与已知缺陷

1. **`findPython` 的"找不到"不可表达，`?? '$PYTHON'` 是死分支**：注释（96 行）承诺"全都没有时返回 undefined，
   调用方据此 SkipCase 并说明"，但实现最后无条件 `return 'python3'`（122 行）。于是 `expandTokens` 里的
   `findPython() ?? '$PYTHON'`（140 行）永远不会命中——机器上真没有 Python 时，产生的不是一句可读的 skip 原因，
   而是 `spawn` 阶段的宿主解析错误。**注释与实现矛盾，且失败信息质量下降**。
2. **200 轮上限触发的截断没有取证**：`readAll` 达到 200 轮就 break，但 `lossy` 只由 reader 自己报（172 行）。
   若输出批次超过 200，`fx.stdout` 会不完整而 `fx.stdoutTruncated` 仍为 `false`——"被我们截断"与"真的就这么长"不可区分。
3. **`fx.exitCode` 把 `null` 归一成 `undefined`**：`outcome?.exitCode ?? undefined`（268 行）。被信号杀死（`exitCode: null`）
   与"宿主没给 exitCode 字段"在 `fx.exitCode` 上相同，只能靠 `fx.signal` 补判——而 spec 没有写明这条组合纪律。
4. **`stdout` / `stderr` 整段进 notes**：缺省上限 256 KiB × 2，两个字符串会原样进报告，报告体积随输出线性增长；
   而 `stdoutLength` 与 `stdoutTruncated` 已经提供了摘要。属于重复且可能过量的取证。
5. **两条失败通道的分工不清晰**：`spawnError` 同时被"resolveExecutable 失败"（234 行）与"spawn 同步抛错"（259 行）写入，
   `runError` 只在 `done` reject 时写（272 行）。同一个"起不来"可能只留下 `spawnError`，场景要同时断言两个键才不漏判。
6. **`env` 只做浅合并、无法删除变量**：`{ ...setup.env, ...spec.env }`（220 行）只能新增或覆盖，
   无法表达"让这个环境变量不存在"——而"环境变量缺失时的降级行为"是一类常见被测行为。
7. **`stdin` 无法表达"pipe 但不喂数据"**：省略即 `'ignore'`，给了就 `{ data }`（242 行）。
   "子进程等 stdin 而挂住"这类场景只能靠场景超时兜底，不能在 driver 层构造。

## 测试覆盖

`tests/shell-driver.test.mjs`（18 个用例）覆盖 `readAll` 四个边界、成功/失败三条记账路径、
cwd/env 的 setup 与动作级合并、stdin 两种形态、`findPython` 两档回退与 capability 声明。
**单个原子有既有测试覆盖**，无缺口（但缺陷 1 说明 `findPython` 的"全都没有"分支被测的不是注释描述的那条行为）。
