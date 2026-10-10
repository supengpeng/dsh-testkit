---
domain: kinds
module: fs
revision: 1

atomics:
  - id: BEH-KIND-FS-001
    title: fs-resolve —— 把路径解析成宿主文件服务的目标（并顺带取 stat 摘要）
    atomic: fs-resolve
    status: active

    source:
      file: src/kinds/fs.ts
      lines: "347-359"
      symbols:
        - "fsDriver"
        - "doResolve"
        - "targetOf"
        - "absolute"
        - "summarizeVersion"
      tests:
        - "tests/fs-driver.test.mjs::setup：宿主没有 fs 能力时跳过"
        - "tests/fs-driver.test.mjs::setup：缺省自建临时工作根，并在释放夹具时删掉"
        - "tests/fs-driver.test.mjs::setup：显式 root 不会被删除（那是调用方的目录）"
        - "tests/fs-driver.test.mjs::act：非 fs 动作直接报错；未知 fs 动作记进 fsError"
        - "tests/fs-driver.test.mjs::act：缺 setup.fs 时明确报错（而不是用错工作根）"

    capabilities: ["fs"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "setup.fs = {}（driver 自建临时工作根），宿主具备 fs 能力"
        when: "act: { kind: fs, fs: { resolve: { path: 'a.txt' } } }"
        then: "fx.fsTargetPath 是非空字符串；fx.fsTargetKeyPresent is true；fx.fsAction is 'resolve'；fx.fsError exists 为 false"
        verdict: pass
      - given: "路径是相对路径"
        when: "act fs resolve"
        then: "解析基准是 setup.fs.root（而不是 process.cwd()）"
        verdict: pass
      - given: "动作给 cwd 覆盖"
        when: "act: { kind: fs, fs: { resolve: { path: 'a.txt', cwd: '<root>/sub' } } }"
        then: "解析结果落在 cwd 之下"
        verdict: pass
      - given: "目标已存在"
        when: "act fs resolve"
        then: "fx.fsExists is true；fx.fsType 是字符串；fx.fsVersion 是版本摘要"
        verdict: pass
      - given: "宿主不具备 fs 能力"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "缺省自建工作根"
        when: "场景结束释放夹具"
        then: "临时目录被删除（fixture disposer 生效）；显式 setup.fs.root 时则**不删**"
        verdict: pass
      - given: "act 收到非 fs 动作"
        when: "把非 fs 的 StepAction 交给 fs driver"
        then: "throws 为 true，错误信息 contains 'fs driver 只支持'"
        verdict: fail
      - given: "fs 动作名不在 resolve / stat / read / list / write / edit 之内"
        when: "act 一个未知的 fs 动作"
        then: "fx.fsError 是非空字符串（contains '未知的 fs 动作'）；不抛"
        verdict: fail
      - given: "setup.fs 未执行（states 里没有工作根）"
        when: "act 任何一个 fs 动作"
        then: "throws 为 true，错误信息 contains 'setup.fs 未执行'"
        verdict: fail

    cleanup: registered

    nonDeterministic:
      - field: "fx.fsRoot / fx.fsWorkspace / fx.fsTargetPath"
        reason: "缺省工作根是 mkdtempSync 生成的随机临时目录；显式 root 也随安装位置变化"
        reconcile: "normalize:normalize-path"
      - field: "fx.fsVersion"
        reason: "版本号由宿主文件服务生成（含时间/随机成分）"
        reconcile: "normalize:fs-version"
      - field: "fx.fsError 文本"
        reason: "错误消息由宿主文件服务抛出"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      path: normalize-path
      version: fs-version
      error: normalize-message

  - id: BEH-KIND-FS-002
    title: fs-stat —— 取目标的存在性、类型、大小与版本
    atomic: fs-stat
    status: active

    source:
      file: src/kinds/fs.ts
      lines: "361-375"
      symbols:
        - "fsDriver"
        - "doStat"
        - "targetOf"
        - "summarizeVersion"
      tests:
        - "tests/fs-driver.test.mjs::act：write → stat → read 的取证与版本跟踪"
        - "tests/fs-driver.test.mjs::summarizeVersion：短版本原样，长版本折叠"

    capabilities: ["fs"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "目标文件存在"
        when: "act: { kind: fs, fs: { stat: { path: 'a.txt' } } }"
        then: "fx.fsExists is true；fx.fsType is 'file'；fx.fsSize atLeast 0；fx.fsVersion is 版本摘要"
        verdict: pass
      - given: "目标不存在"
        when: "act fs stat"
        then: "fx.fsExists is false；fx.fsType exists 为 false（宿主用 undefined 表示不存在）"
        verdict: fail
      - given: "宿主 fs 服务不提供 stat()"
        when: "act fs stat"
        then: "case 被标为 skipped（SkipCase），不是 failed"
        verdict: skip
      - given: "版本字符串超过 20 字符"
        when: "读取 fx.fsVersion"
        then: "fx.fsVersion 形如 `前8字符…后4字符`（折叠后）"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.fsVersion"
        reason: "版本号由宿主生成"
        reconcile: "normalize:fs-version"
      - field: "fx.fsSize"
        reason: "随写入内容长度变化"
        reconcile: "atLeast"

    equivalence:
      verdict: exact
      version: fs-version
      size: atLeast

  - id: BEH-KIND-FS-003
    title: fs-read —— 经宿主文件服务读文本
    atomic: fs-read
    status: active

    source:
      file: src/kinds/fs.ts
      lines: "377-388"
      symbols:
        - "fsDriver"
        - "doRead"
        - "targetOf"
      tests:
        - "tests/fs-driver.test.mjs::act：write → stat → read 的取证与版本跟踪"

    capabilities: ["fs"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "目标文件已写入内容 'hello'"
        when: "act: { kind: fs, fs: { read: { path: 'a.txt' } } }"
        then: "fx.fsText is 'hello'；fx.fsTextLength is 5"
        verdict: pass
      - given: "目标文件不存在"
        when: "act fs read"
        then: "fx.fsError 是非空字符串（宿主读不存在的文件会抛）；不抛到场景外"
        verdict: fail
      - given: "宿主 fs 服务不提供 readText()"
        when: "act fs read"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip

    cleanup: registered

    nonDeterministic:
      - field: "fx.fsText"
        reason: "内容取决于同一场景内此前的写入（含宿主对换行的规范化）"
        reconcile: "exact（同一场景内确定）"
      - field: "fx.fsError 文本"
        reason: "宿主错误消息"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      error: normalize-message

  - id: BEH-KIND-FS-004
    title: fs-list —— 列出目录项（投影成 name / type / size）
    atomic: fs-list
    status: active

    source:
      file: src/kinds/fs.ts
      lines: "390-401"
      symbols:
        - "fsDriver"
        - "doList"
        - "describeEntries"
        - "targetOf"
      tests:
        - "tests/fs-driver.test.mjs::describeEntries：畸形输入不炸"

    capabilities: ["fs"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "目录下有 2 个文件"
        when: "act: { kind: fs, fs: { list: { path: '.' } } }"
        then: "fx.fsEntryCount atLeast 2；fx.fsEntries 是数组，元素含 name 与 type 字段"
        verdict: pass
      - given: "listDir 返回畸形条目（缺 name / type）"
        when: "读取 fx.fsEntries"
        then: "对应字段是 undefined（投影不抛错）"
        verdict: fail
      - given: "宿主 fs 服务不提供 listDir()"
        when: "act fs list"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip

    cleanup: registered

    nonDeterministic:
      - field: "fx.fsEntries 的顺序"
        reason: "宿主 listDir 的返回顺序未在契约里约定（无排序保证）"
        reconcile: "normalize:unordered-array"
      - field: "fx.fsEntryCount"
        reason: "目录里可能有宿主或场景在前序步骤创建的文件"
        reconcile: "atLeast"

    equivalence:
      verdict: exact
      entries: unordered-array
      entryCount: atLeast

  - id: BEH-KIND-FS-005
    title: fs-write —— 按写意图写入并验证版本守卫与沙箱策略
    atomic: fs-write
    status: active

    source:
      file: src/kinds/fs.ts
      lines: "403-443"
      symbols:
        - "fsDriver"
        - "doWrite"
        - "pickVersion"
        - "sandboxPolicy"
        - "remember"
        - "extractFsCode"
        - "targetOf"
      tests:
        - "tests/fs-driver.test.mjs::extractFsCode：code / info.code / message 里的 FS_* 三种形状都认"
        - "tests/fs-driver.test.mjs::act：write → stat → read 的取证与版本跟踪"
        - "tests/fs-driver.test.mjs::act：createIfAbsent 撞上已存在 → 记错误码（不抛）"
        - "tests/fs-driver.test.mjs::act：陈旧版本写入 → FS_STALE_VERSION（并发写的核心保护）"
        - "tests/fs-driver.test.mjs::act：read-only 沙箱拒绝写入，并记下用的模式与根"
        - "tests/fs-driver.test.mjs::act：setup 的 mode 会作用到每一次写（动作级可覆盖）"
        - "tests/fs-driver.test.mjs::act：replaceIfVersion 但从未观测过版本 → 明确报错（而不是瞎猜）"
        - "tests/fs-driver.test.mjs::setup：probeSandbox 被拒时继续，并留下探测证据"
        - "tests/fs-driver.test.mjs::setup：宿主后端忽略沙箱策略时跳过（而不是假红）"

    capabilities: ["fs"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "intent 省略（unconditional）"
        when: "act: { kind: fs, fs: { write: { path: 'a.txt', text: 'x' } } }"
        then: "fx.fsWriteIntent is 'unconditional'；fx.fsOperation 是字符串；fx.fsVersion is 版本摘要；fx.fsError exists 为 false"
        verdict: pass
      - given: "intent = 'createIfAbsent' 且文件已存在"
        when: "act fs write"
        then: "fx.fsErrorCode 是 FS_* 错误码（形如 FS_FILE_EXISTS）；fx.fsError 是非空字符串；不抛"
        verdict: fail
      - given: "intent = 'replaceIfVersion'，此前 write 过一次（state.lastVersion 已记录）"
        when: "用陈旧版本再写一次"
        then: "fx.fsErrorCode is 'FS_STALE_VERSION'（并发写的核心保护）；fx.fsExpectedVersion 是陈旧版本摘要"
        verdict: fail
      - given: "intent = 'replaceIfVersion' 但从未观测到版本"
        when: "act fs write"
        then: "fx.fsError contains 'replaceIfVersion 需要先观测到一个版本'"
        verdict: fail
      - given: "动作级 sandbox = { mode: 'read-only' } 且宿主后端真的实施沙箱"
        when: "act fs write"
        then: "fx.fsSandboxMode is 'read-only'；fx.fsSandboxWorkspace 是根路径；写入被拒（fx.fsErrorCode 是非空 FS_* 码或 sandbox 拒绝错误）"
        verdict: fail
      - given: "setup.fs.probeSandbox = true 且后端实施沙箱"
        when: "setup 阶段探测"
        then: "fx.fsSandboxProbe is 'denied'；fx.fsSandboxProbeCode 是 FS_* 码；继续执行"
        verdict: pass
      - given: "setup.fs.probeSandbox = true 且后端**忽略** sandboxPolicy"
        when: "setup 阶段探测"
        then: "case 被标为 skipped（SkipCase），理由说明 bare backend 会忽略它——**不假红**"
        verdict: skip
      - given: "setup.fs.mode 已声明，动作级不给 sandbox"
        when: "act fs write"
        then: "fx.fsSandboxMode is setup.fs.mode（setup 级作用到每一次写）"
        verdict: pass

    cleanup: registered

    nonDeterministic:
      - field: "fx.fsVersion / fx.fsExpectedVersion"
        reason: "版本号由宿主生成（含时间/随机成分），且被 summarizeVersion 折叠"
        reconcile: "normalize:fs-version"
      - field: "fx.fsBefore / fx.fsAfter"
        reason: "写入前后快照，形状由宿主决定"
        reconcile: "normalize:fs-snapshot"
      - field: "fx.fsError 文本与部分错误码"
        reason: "错误消息由宿主抛出；extractFsCode 只认 FS_* 命名族"
        reconcile: "normalize:normalize-message"
      - field: "fx.fsOperation"
        reason: "操作名由宿主给定（create / replace 等），取值集合未在本 spec 冻结"
        reconcile: "exact"

    equivalence:
      verdict: exact
      version: fs-version
      error: normalize-message

  - id: BEH-KIND-FS-006
    title: fs-edit —— 按 oldString/newString 编辑，并支持版本守卫
    atomic: fs-edit
    status: active

    source:
      file: src/kinds/fs.ts
      lines: "445-486"
      symbols:
        - "fsDriver"
        - "doEdit"
        - "pickVersion"
        - "sandboxPolicy"
        - "remember"
        - "targetOf"
      tests:
        - "tests/fs-driver.test.mjs::act：edit 的版本守卫也走同一条陈旧检查"

    capabilities: ["fs"]
    availableIn: Any
    costTier: low
    parallel: exclusive

    observable:
      - given: "文件内容含 'OLD'，不传 expectedVersion"
        when: "act: { kind: fs, fs: { edit: { path: 'a.txt', oldString: 'OLD', newString: 'NEW' } } }"
        then: "fx.fsBefore contains 'OLD'；fx.fsAfter contains 'NEW'；fx.fsVersion is 版本摘要；fx.fsError exists 为 false"
        verdict: pass
      - given: "replaceAll 省略"
        when: "act fs edit 且文件里 'OLD' 出现两次"
        then: "只替换第一处（replaceAll 传 false）"
        verdict: pass
      - given: "expectedVersion = 'last' 且此前观测过版本，文件已被改动"
        when: "act fs edit"
        then: "fx.fsErrorCode is 'FS_STALE_VERSION'（版本守卫在匹配之前检查）"
        verdict: fail
      - given: "expectedVersion 指定了但从未观测到版本"
        when: "act fs edit"
        then: "fx.fsError contains 'edit 的 expectedVersion 需要先观测到一个版本'"
        verdict: fail
      - given: "oldString 在文件里不存在"
        when: "act fs edit"
        then: "fx.fsError 是非空字符串（宿主报匹配失败）；不抛"
        verdict: fail
      - given: "宿主 fs 服务不提供 editText()"
        when: "act fs edit"
        then: "case 被标为 skipped（SkipCase）"
        verdict: skip

    cleanup: registered

    nonDeterministic:
      - field: "fx.fsVersion"
        reason: "宿主生成，且被折叠"
        reconcile: "normalize:fs-version"
      - field: "fx.fsBefore / fx.fsAfter"
        reason: "形状由宿主决定"
        reconcile: "normalize:fs-snapshot"
      - field: "fx.fsError 文本"
        reason: "宿主错误消息"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      version: fs-version
      error: normalize-message
---

## 共享前提（setup 与 act 分派）

与 `kind: file` 的分工（源码 4-13 行的表）：`file` 用 `node:fs`（进程自己的文件系统），纯离线；
`fs` 用 `ctx.fs`（**宿主的文件服务**），需要 `fs` 能力，能测 `node:fs` **永远测不到**的两类：
**沙箱拒绝**（由宿主 policy 层决定）与**陈旧版本保护**（只在传入 `expected` 守卫时生效）。

`setup`（190-249 行）做四件事：

1. 能力门：无 `fs` 能力 → `SkipCase`；
2. 工作根：缺省 `mkdtempSync(<tmpdir>/testkit-fs-*)` 并在场景结束时 `rmSync` 删除；显式 `setup.root` **不删**；
3. `workspace`：缺省等于 root，否则相对 root 解析；
4. `probeSandbox`（可选）：拿一个一次性文件按 `read-only` 写一次——被拒 ⇒ 记 `fx.fsSandboxProbe: 'denied'`；
   写成功 ⇒ `SkipCase`（明说"宿主 fs 后端不实施 sandboxPolicy（bare backend 会忽略它）"）。
   契约原文是 "a sandboxing backend fences the write by it, **the bare backend ignores it**"，
   所以不探测就断言"必然被拒"会在另一种 profile 上假红。

`act`（251-294 行）先做服务形状门（`resolve` + `writeText` 必须存在，否则 `SkipCase`），再按动作名分派到
`doResolve` / `doStat` / `doRead` / `doList` / `doWrite` / `doEdit`；所有动作的异常被统一吞进
`fx.fsError` + `fx.fsErrorCode`（**不抛到场景外**）。每次 act 开头先把 `fsError` / `fsErrorCode` 置 `undefined`，
避免继承上一步的残值。

### 边界与已知缺陷

1. **`probeSandbox` 把"任何写前错误"都当成"沙箱存在"**：`try { resolve(); writeText(read-only) } catch { 记 denied }`
   （225-240 行）。若 `resolve()` 因路径或服务原因失败，也会落到同一个 catch 并记 `fsSandboxProbe: 'denied'`，
   于是"后端根本不实施沙箱"的检查被绕过，后续"越界被拒"的断言可能在错误前提上通过。**探测本意与实现不完全一致**。
2. **`target: 'current'` 式风险在 fs 侧同样存在（对称缺口）**：`sandboxPolicy` 的 `workspace` 只相对 `root` 解析
   （324 行），而 `setup.root` 若被写成 `/` 或用户主目录，`workspace-write` 的根就落在真实目录上。
   spec 没有"不得把 root 指向工作区外"的约束。
3. **`fs-edit` 不接受动作级沙箱覆盖**：`doEdit` 固定传 `sandboxPolicy(ctx, state, undefined)`（479 行），
   而 `FsAction` 的 `edit` 形状也没有 `sandbox` 字段（`src/cases/types.ts:253-262` 有 `edit` 但只有
   `path/oldString/newString/replaceAll/expectedVersion`）。于是"编辑越界被拒"**无法用场景表达**——
   与 write 的能力不对称。
4. **`extractFsCode` 只认 `FS_*` 命名族**：正则 `\b(FS_[A-Z_]+)\b`（158-161 行）。宿主若用别的码族
   （例如 sandbox 层自己的错误码），`fx.fsErrorCode` 会是 `undefined` 而 `fx.fsError` 有文本——
   断言 `fx.fsErrorCode is '...'` 会假红。`session.extractGoalCode`（`GOAL_/TEAM_`）与
   `compaction.extractCompactionCode`（`COMPACTION_/MANUAL_COMPACT_`）是同一手法，同样受限。
5. **`fx.fsVersion` 是折叠后的摘要**：超过 20 字符时显示成 `前8…后4`（177-181 行），
   而 `replaceIfVersion` 的守卫用的是**完整版本**（存在 driver 内部 state 里）。
   于是"取证里看到的版本"与"判定时用的版本"不是同一个字符串，断言永远不能写 `is` 到完整值。
6. **`fs-list` 的端到端路径没有既有测试**：只有投影函数 `describeEntries` 的单测
   （`tests/fs-driver.test.mjs::describeEntries：畸形输入不炸`）。`doList` 的服务调用、`fsEntryCount`、
   宿主返回顺序都未被覆盖——这是覆盖缺口，不是"已覆盖"。
7. **`fsEntries` 丢弃 `version` 与 `target`**：`describeEntries` 只保留 `name/type/size`（164-174 行），
   而宿主的目录项契约里有 `target` 与 `version`（源码 58-63 行的 `FsDirEntryLike`）。
   "列目录后按版本精确编辑"这类两段式场景因此缺少中间证据。

## 测试覆盖

`tests/fs-driver.test.mjs`（17 个用例）覆盖 setup 的能力门与工作根归属、write 的三条意图与版本守卫、
read-only 沙箱拒绝、`probeSandbox` 两档结论、edit 的版本守卫、以及三个纯函数（`extractFsCode` /
`summarizeVersion` / `describeEntries`）。**六个原子中五个有既有测试覆盖；`fs-list` 只有投影函数单测，
端到端路径无覆盖**（见缺陷 6）。
