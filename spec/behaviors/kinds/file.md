---
domain: kinds
module: file
revision: 1

atomics:
  - id: BEH-KIND-FILE-001
    title: read-file —— 读一个文件并取证内容、行数与换行风格（纯离线）
    atomic: read-file
    status: active

    source:
      file: src/kinds/file.ts
      lines: "276-322"
      symbols:
        - "fileDriver"
        - "FileSetup"
        - "expandPathTokens"
        - "fileConfigs"
        - "describe"
      tests:
        - "tests/file-driver.test.mjs::act：读文件取证内容、行数与大小"
        - "tests/file-driver.test.mjs::act：文件不存在时记 fileExists=false 而不是抛错"
        - "tests/file-driver.test.mjs::act：CRLF 换行会被取证到（跨平台真实故障源）"
        - "tests/file-driver.test.mjs::act：目标是目录时如实说明"
        - "tests/file-driver.test.mjs::act：动作既没 read 也没 glob 时报错（不静默）"
        - "tests/file-driver.test.mjs::act：非 file 动作直接报错"
        - "tests/file-driver.test.mjs::act：search 的非法正则明确报错（不静默）"

    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.file = { root: '$PKG' }，<root>/a.txt 存在且内容为 'hello\\nworld'"
        when: "act: { kind: file, file: { read: 'a.txt' } }"
        then: "fx.fileExists is true；fx.fileIsDirectory is false；fx.fileText is 'hello\\nworld'；fx.fileLineCount is 2；fx.fileBytes atLeast 11；fx.fileError exists 为 false"
        verdict: pass
      - given: "目标路径不存在"
        when: "act: { kind: file, file: { read: 'nope.txt' } }"
        then: "fx.fileExists is false；fx.fileBytes is 0；fx.fileText exists 为 false；场景不失败（不抛）"
        verdict: fail
      - given: "目标路径是目录"
        when: "act: { kind: file, file: { read: '.' } }"
        then: "fx.fileExists is true；fx.fileIsDirectory is true；fx.fileError is '目标是目录，不是文件'"
        verdict: fail
      - given: "文件大于 setup.file.maxChars"
        when: "act read"
        then: "fx.fileTruncated is true；fx.fileText 的 length is maxChars"
        verdict: fail
      - given: "文件含 CRLF 换行"
        when: "act read"
        then: "fx.fileHasCRLF is true（跨平台真实故障源）"
        verdict: pass
      - given: "setup.file.root 指向不存在的目录"
        when: "setup 阶段"
        then: "case 被标为 skipped（SkipCase），不是 failed（环境没准备好不该报成被测对象坏了）"
        verdict: skip
      - given: "动作既没有 read 也没有 glob / search"
        when: "act: { kind: file, file: {} }"
        then: "throws 为 true，错误信息 contains 'file 动作需要 `read`'"
        verdict: fail
      - given: "act 收到非 file 动作"
        when: "把非 file 的 StepAction 交给 file driver"
        then: "throws 为 true，错误信息 contains 'file driver 只支持'"
        verdict: fail

    cleanup: none

    nonDeterministic:
      - field: "fx.filePath / fx.fileRoot / fx.fileRelative"
        reason: "绝对路径取决于安装位置与运行目录；fileRelative 依 root 而定"
        reconcile: "normalize:normalize-path"
      - field: "fx.fileBytes"
        reason: "文件字节数随外部 fixture 的下载版本变化"
        reconcile: "atLeast"
      - field: "fx.fileError 文本（读异常时）"
        reason: "错误消息由 node:fs 抛出，含平台相关文本"
        reconcile: "normalize:normalize-message"

    equivalence:
      verdict: exact
      error: normalize-message
      path: normalize-path
      bytes: atLeast

  - id: BEH-KIND-FILE-002
    title: glob-file —— 递归列出匹配的文件并区分"没匹配"与"匹配很多但被截断"
    atomic: glob-file
    status: active

    source:
      file: src/kinds/file.ts
      lines: "190-212"
      symbols:
        - "fileDriver"
        - "FileSetup"
        - "matchGlob"
        - "walkFiles"
        - "expandPathTokens"
      tests:
        - "tests/file-driver.test.mjs::matchGlob：单层 `*` 不跨目录"
        - "tests/file-driver.test.mjs::matchGlob：`**` 跨任意层，且 `**/x` 也匹配根下的 x"
        - "tests/file-driver.test.mjs::matchGlob：`?` 匹配单个非斜杠字符"
        - "tests/file-driver.test.mjs::matchGlob：正则特殊字符被转义（不会被当成模式）"
        - "tests/file-driver.test.mjs::matchGlob：反斜杠路径先归一化"
        - "tests/file-driver.test.mjs::act：glob 列出匹配文件（递归 + 排序 + 跳过 node_modules）"

    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.file = { root: '$PKG' }，目录下有若干 .ts 文件"
        when: "act: { kind: file, file: { glob: 'src/kinds/*.ts' } }"
        then: "fx.globMatches 是按字典序排序的数组且每个元素 contains 'kinds/'；fx.globCount is fx.globMatches length；fx.globPattern is 'src/kinds/*.ts'"
        verdict: pass
      - given: "模式 `**/*.test.mjs`"
        when: "act glob"
        then: "fx.globMatches 含各层目录下的 .test.mjs，且不含 node_modules / .git 下的文件"
        verdict: pass
      - given: "匹配数超过 setup.file.maxGlob"
        when: "act glob"
        then: "fx.globCount is maxGlob；fx.globTruncated is true；fx.globTotal atLeast fx.globCount"
        verdict: fail
      - given: "模式没有任何匹配"
        when: "act glob"
        then: "fx.globCount is 0；fx.globTruncated is false"
        verdict: fail
      - given: "扫描目录树"
        when: "act glob"
        then: "fx.globScanned 是扫到的文件总数（用于判断扫描是否完整）"
        verdict: pass

    cleanup: none

    nonDeterministic:
      - field: "fx.globScanned / fx.globTotal"
        reason: "取决于工作区里实际存在多少文件（含外部 fixture 与构建产物）"
        reconcile: "atLeast"
      - field: "fx.globMatches 的元素顺序（跨平台）"
        reason: "源码显式 sort，但排序基准是相对路径字符串，大小写与分隔符已归一"
        reconcile: "exact（源码已排序，故顺序应稳定）"

    equivalence:
      verdict: exact
      matches: exact
      scanned: atLeast

  - id: BEH-KIND-FILE-003
    title: search-file —— 在文件内容里搜正则并给出文件/行号/文本（对应 grep）
    atomic: search-file
    status: active

    source:
      file: src/kinds/file.ts
      lines: "214-274"
      symbols:
        - "fileDriver"
        - "matchGlob"
        - "walkFiles"
        - "describe"
      tests:
        - "tests/file-driver.test.mjs::act：search 命中并给出文件/行号/文本"
        - "tests/file-driver.test.mjs::act：search 不带 glob 时搜全部文件"
        - "tests/file-driver.test.mjs::act：search 支持 flags（大小写不敏感）"
        - "tests/file-driver.test.mjs::act：search 的 maxResults 生效"
        - "tests/file-driver.test.mjs::act：search 的非法正则明确报错（不静默）"
        - "tests/file-driver.test.mjs::act：search 缺 pattern 时报错"

    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive

    observable:
      - given: "setup.file.root 下有文件含 'compact_access'"
        when: "act: { kind: file, file: { search: { pattern: 'compact_access', glob: '**/*.ts' } } }"
        then: "fx.searchCount atLeast 1；fx.searchMatches[0].file/file的 line 与 text 均 exists；fx.searchText contains 'compact_access'"
        verdict: pass
      - given: "search 不带 glob（限定范围）"
        when: "act: { kind: file, file: { search: { pattern: 'x' } } }"
        then: "fx.searchGlob exists 为 false（搜全部文件）"
        verdict: pass
      - given: "flags = 'i'"
        when: "act search 搜大小写不同的同一词"
        then: "fx.searchCount 覆盖大小写两种写法（命中数不少于区分大小写时）"
        verdict: pass
      - given: "maxResults = 2 且命中更多"
        when: "act search"
        then: "fx.searchCount is 2"
        verdict: fail
      - given: "pattern 不是合法正则（例如 '['）"
        when: "act search"
        then: "throws 为 true，错误信息 contains '不是合法正则'"
        verdict: fail
      - given: "search 缺 pattern"
        when: "act: { kind: file, file: { search: { pattern: '' } } }"
        then: "throws 为 true，错误信息 contains 'file.search 需要 `pattern`'"
        verdict: fail
      - given: "命中分布在多个文件"
        when: "act search"
        then: "fx.searchFiles 是去重后的文件列表（已排序）；fx.searchFileCount is fx.searchFiles length；fx.searchScannedFiles atLeast fx.searchFileCount"
        verdict: pass

    cleanup: none

    nonDeterministic:
      - field: "fx.searchScannedFiles"
        reason: "取决于工作区文件数与 maxChars*4 的跳过阈值"
        reconcile: "atLeast"
      - field: "fx.searchMatches[].text"
        reason: "截取自源文件当前内容，随被搜文件变化"
        reconcile: "exact（同一输入下确定）"

    equivalence:
      verdict: exact
      count: exact
      scanned: atLeast
---

## read-file

**为什么需要这个 kind（来自能力缺口分析）**：对 `dsh-memory` / `lingshu` 的 238 条可回归候选做形态分类后，
**97 条（41%）** 属于 `file-inspect`——判据是"某个文件里有没有某段内容"、"清单里有没有这一项"、
"frontmatter 里有没有这个字段"。用 `kind: shell` 也能凑（`grep` / `cat`），但依赖外部命令可用性
（Windows 上 `grep` 未必有），且输出要再做文本解析——所以值得有直说的 kind。

**它是纯离线的**：用 `node:fs` 直接读，不需要宿主提供任何服务，`requires: []`，任何宿主（含 CI 轨）都能跑。

**`setup.root` 不存在的判定位置很关键**（源码 147-159 行的注释）：runner 把 **setup** 阶段抛出的 `SkipCase`
当"整条场景跳过"，而动作阶段抛出的会被记成"这一步失败"。早先这个判断只在 `act` 里，于是"外部 fixture 没下载"
在本地（`.fixtures` 在）绿、在全新检出（CI）红——环境没准备好被报成了被测对象坏了。现在 setup 与 act 双处检查。

**令牌**：`$PKG` / `$PKG/<子路径>` / `$FIXTURES` / `$FIXTURES/<name>`（`expandPathTokens`）。

### 边界与已知缺陷

1. **"文件不存在"时 `fx.fileError` 被记成 `undefined`**（源码 293 行），而"目标是目录"与"读异常"都写 `fileError`。
   于是 `fx.fileError exists: false` 在**文件根本不存在**时也成立——容易被读成"读取没有错误"。
   `fileError` 的真实语义是"读取过程异常"，不是"一切正常"；这条区分只写在源码注释里，spec 与场景作者都容易误用。
2. **文件不存在时不写 `fx.fileIsDirectory`**（对比 289-294 与 299-303）：断言"不是目录"只能靠 `fx.fileExists is false`
   间接推，而该键在两条路径上语义不同（"不存在"与"目录"都会走到不同分支）。
3. **`fileLines` 与 `fileText` 重复取证**：完整文本与按 `\n` 拆分的行数组都会进报告，
   缺省 `maxChars` 为 512 KiB → 单条 read 取证可能超过 1 MiB。报告体积风险由场景内容直接放大。
4. **`maxChars` 在两个分支里含义不同**：read 分支是"最多读多少字符"（176 行），
   search 分支是"跳过阈值 = `maxChars * 4`"（245 行）。同一字段两种口径：为了让 read 的截断可测而调小 `maxChars`，
   会**同时**改变 search 会跳过哪些文件。
5. **`fileTruncated` 只反映 `maxChars` 截断**：若 `readFileSync` 因其它原因返回不完整内容（编码问题），
   没有独立的取证位；`fx.fileBytes`（stat 大小）与 `fx.fileText` 长度之差是唯一线索。

## glob-file

**极简 glob，刻意不引第三方**（源码 79-84 行）：判据要能在任何环境下复现，而这个小实现的行为是**完全确定**的、可单测的。
支持 `**`（任意层）、`*`（单层内任意）、`?`（单个非斜杠字符），`**/x` 与 `x` 都匹配根下的 `x`。

**扫描上限必须远大于返回上限**（源码 193-196 行的真实事故记录）：早先两者混用（都用 `cap`），
于是深度优先扫到 `cap` 就停了——`lib/` 下文件多时 `cases/` 根本没轮到，glob 结果恒为空。现在
`scanCap = max(cap * 50, 20000)`。**这是旧实现里被真实踩过的缺陷**，spec 保留它作为行为事实。

`walkFiles` 跳过 `node_modules` 与 `.git`；结果按相对路径字典序排序，分隔符归一为 `/`。

### 边界与已知缺陷

1. **扫描不完整不可见**：`walkFiles` 的 `readdirSync` / `statSync` 异常被静默 `continue`（117-121、127-131），
   `fx.globScanned` 只反映"成功读到的条目"。无权限目录、损坏的符号链接会**静默**缩小结果集，
   而 `globTruncated` 仍是 `false`。
2. **`fx.globTotal` 不是真值**：它是"`scanCap` 范围内扫到的文件里的匹配数"。若目录树超过 `scanCap`，
   `globTotal` 也会偏小，而没有任何字段说明"扫描因 `scanCap` 提前停止"（`globScanned` 顶到 `scanCap` 是唯一线索，
   但 spec 没有把它写成判定规则）。
3. **`globMatches` 的截断是"排序后取前 N"**：`matchedAll.sort().slice(0, cap)`。
   所以截断结果偏向字典序靠前的路径，不是"随机样本"——断言 `contains` 一个靠后的文件时，
   在大仓库里可能因截断而不命中。

## search-file

**逐行扫描、正则匹配**：对每个候选文件 `readFileSync` 后 `split('\n')`，逐行 `re.test(line)`，
命中记 `{ file, line: index+1, text: line.trim().slice(0, 400) }`。候选集由可选 `glob` 限定。
`re.lastIndex = 0` 是为带 `g` 标志的正则跨行复用准备的（源码 254 行的注释）。

**结果面**：`fx.searchMatches`（命中的结构化数组）、`fx.searchCount`、`fx.searchFiles`（去重排序）、
`fx.searchFileCount`、`fx.searchScannedFiles`、`fx.searchText`（所有命中行拼接成 `<file>:<line>: <text>`，
便于用 `contains` 写断言——对对象数组写断言很别扭）。

### 边界与已知缺陷

1. **不支持跨行匹配**：`re.test(line)` 只在单行内匹配。含多行结构的 pattern（例如完整的多行函数签名）
   **永远不命中**，而错误形态是"searchCount is 0"——看起来像"代码里没有"，而不是"这个引擎搜不了"。
2. **命中的 `text` 被硬截断到 400 字符且无取证**（258 行）：对超长行断言 `contains` 一个靠后的片段会误判为"没命中"。
3. **超大文件被静默跳过**：`statSync(full).size > maxChars * 4` 时 `continue`（245 行），
   既不计入 `searchScannedFiles` 也不报错。于是"文件太大所以没搜"与"文件里真的没有"不可区分。
4. **`fx.searchScannedFiles` 只是计数**：没有"被跳过的文件列表"，排查"为什么没命中"时信息不足。
5. **`text` 的 `trim()` 丢失缩进**：命中行的前导空白被去掉（258 行）。对"缩进层级"本身就是判据的场景
   （例如 `requirements` 的嵌套），断言 `contains` 会失效。

## 测试覆盖

`tests/file-driver.test.mjs`（19 个用例）覆盖 `matchGlob` 五组边界、read 的内容/缺失/目录/CRLF、
glob 的递归排序与截断、search 的命中/范围/flags/maxResults/非法正则/缺 pattern。
**三个原子都有既有测试覆盖**，无缺口。
