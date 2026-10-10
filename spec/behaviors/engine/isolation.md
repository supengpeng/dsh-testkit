---
domain: engine
module: isolation
revision: 1

atomics:
  - id: BEH-ENGINE-ISOLATION-001
    title: isolation-context —— 场景级命名空间 / 临时目录 / 会话名的创建与幂等释放
    atomic: isolation-context
    status: active
    source:
      file: src/isolation/context.ts
      lines: "36-119"
      symbols:
        - IsolationContext
        - IsolationOptions
        - createIsolationContext
        - disposeIsolationContext
        - slugify
        - sequence
      tests:
        - tests/isolation.test.mjs::createIsolationContext：命名空间 / tmpdir / 端口 / 会话各不相同
        - tests/isolation.test.mjs::disposeIsolationContext：删干净、可重复调、失败不抛
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "为一条场景创建隔离上下文"
        when: "createIsolationContext(scenario, {root, ports})"
        then: "namespace = slugify(id)-pid36-seq36-rand4；tmpdir = <root>/dsh-testkit-<namespace> 且**同步建出**（mkdirSync recursive）；session = dsh-testkit-<namespace>；ports 是入参的**拷贝**"
        verdict: pass
        tests: ["tests/isolation.test.mjs::createIsolationContext：命名空间 / tmpdir / 端口 / 会话各不相同"]
        source: { file: "src/isolation/context.ts", lines: "68-91" }
      - given: "同一场景连续创建两个上下文"
        when: "两次 createIsolationContext"
        then: "pid 相同但进程内递增序号不同 → namespace / tmpdir / session 都不同（repeat 多轮或同批并发不互撞）"
        verdict: pass
        tests: ["tests/isolation.test.mjs::createIsolationContext：命名空间 / tmpdir / 端口 / 会话各不相同"]
        source: { file: "src/isolation/context.ts", lines: "55-56, 72-78" }
      - given: "调用方在创建后复用并改动传入的 ports 数组"
        when: "ports.push(...)"
        then: "已建好的上下文 ports 不受影响（构造时 [...(opts.ports ?? [])] 拷贝）"
        verdict: pass
        tests: ["tests/isolation.test.mjs::createIsolationContext：命名空间 / tmpdir / 端口 / 会话各不相同"]
        source: { file: "src/isolation/context.ts", lines: "87-88" }
      - given: "端口策略"
        when: "未声明 ports"
        then: "ports 为空数组——**只声明不分配**（Node 没有可靠的同步空闲端口 API，猜端口是并发踩踏的经典来源）"
        verdict: pass
        tests: ["tests/isolation.test.mjs::createIsolationContext：命名空间 / tmpdir / 端口 / 会话各不相同"]
        source: { file: "src/isolation/context.ts", lines: "16-22, 88" }
      - given: "释放隔离上下文"
        when: "disposeIsolationContext(ctx)"
        then: "rmSync(tmpdir, { recursive:true, force:true, maxRetries:3 })；**只删 tmpdir 这一层**，父目录（root）绝不碰"
        verdict: pass
        tests: ["tests/isolation.test.mjs::disposeIsolationContext：删干净、可重复调、失败不抛"]
        source: { file: "src/isolation/context.ts", lines: "101-110" }
      - given: "释放的幂等与容错"
        when: "同一对象重复调用 / 目录已被删 / 目录从来没建成功 / 父路径是文件导致删除失败"
        then: "五种情况都不抛：WeakSet disposed 短路重复调用，rmSync(force) 对不存在幂等，catch 吞掉真实失败"
        verdict: pass
        tests: ["tests/isolation.test.mjs::disposeIsolationContext：删干净、可重复调、失败不抛"]
        source: { file: "src/isolation/context.ts", lines: "58-59, 101-109" }
      - given: "slugify 的边界"
        when: "id 含非字母数字（如 TK-0001）/ id 全是符号"
        then: "非 [a-z0-9] 折叠成 '-' 并去首尾短横；结果为空串时回退为 'case'"
        verdict: pass
        tests: []
        source: { file: "src/isolation/context.ts", lines: "112-119" }
    cleanup: registered
    nonDeterministic:
      - field: "IsolationContext.namespace"
        reason: "含 process.pid、进程内递增序号与 Math.random 后缀"
        reconcile: "normalize:<NS>"
      - field: "IsolationContext.tmpdir / session"
        reason: "由 namespace 派生，落在 os.tmpdir()（或注入 root）下"
        reconcile: "normalize:<TMP>"
    equivalence:
      tmpdir: normalize-path
      session: normalize-path
      ports: exact

  - id: BEH-ENGINE-ISOLATION-002
    title: isolation-probe —— 残留检测：探不到标 unknown，绝不标干净
    atomic: isolation-probe
    status: active
    source:
      file: src/isolation/probes.ts
      lines: "12-379"
      symbols:
        - probePort
        - probePorts
        - probeProcesses
        - parseProcessNames
        - detectResidue
        - PortProbeResult
        - ProcessProbeResult
        - CommandRunner
      tests:
        - tests/probes.test.mjs::probePorts：自己 listen 的端口报 busy，空闲端口报 false
        - tests/probes.test.mjs::probePort：探不到的情况标 unknown，绝不当作干净
        - tests/probes.test.mjs::probeProcesses：tasklist CSV 解析 + 子串匹配 + 去重排序
        - tests/probes.test.mjs::probeProcesses：ps 输出解析（取 basename、跳空行）+ 大小写不敏感
        - tests/probes.test.mjs::probeProcesses：命令缺失 / 退出码非 0 / 未给 patterns 都要说明原因
        - "tests/probes.test.mjs::detectResidue：探不到的端口与不可用的进程探针写 unknown: 前缀"
        - tests/probes.test.mjs::detectResidue：tmpdir 残留 + 被占端口，两类都出现
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "端口被自己 listen 占住 / 端口空闲"
        when: "probePort(port)"
        then: "listen 成功 → { busy:false }；EADDRINUSE → { busy:true, detail:'EADDRINUSE（已被占用）' }"
        verdict: pass
        tests: ["tests/probes.test.mjs::probePorts：自己 listen 的端口报 busy，空闲端口报 false"]
        source: { file: "src/isolation/probes.ts", lines: "107-154" }
      - given: "端口号非法（70000 / -1 / 1.5）"
        when: "probePort(bad)"
        then: "**不探测**，直接 { busy:'unknown', detail:'端口号非法：<值>' }"
        verdict: pass
        tests: ["tests/probes.test.mjs::probePort：探不到的情况标 unknown，绝不当作干净"]
        source: { file: "src/isolation/probes.ts", lines: "114-116" }
      - given: "端口探测超时"
        when: "超过 timeoutMs（缺省 2000）仍未 settle"
        then: "{ busy:'unknown', detail:'探测超时（> <n>ms）' }——**超时是 unknown，不是干净**"
        verdict: pass
        tests: ["tests/probes.test.mjs::probePort：探不到的情况标 unknown，绝不当作干净"]
        source: { file: "src/isolation/probes.ts", lines: "139-141" }
      - given: "listen 抛 EADDRINUSE 之外的错误（EACCES / EADDRNOTAVAIL / 同步抛）"
        when: "server 'error' 事件或 listen 同步抛"
        then: "一律 { busy:'unknown', detail:'<code|null>: <message>' }——把它们当「空闲」正是假阴性的来源"
        verdict: pass
        tests: []
        source: { file: "src/isolation/probes.ts", lines: "143-162" }
      - given: "进程探测命令可用且匹配到名字"
        when: "probeProcesses(patterns)"
        then: "{ names: 去重排序后（最多 50 条）, available:true, command }；匹配是不区分大小写的子串"
        verdict: pass
        tests: ["tests/probes.test.mjs::probeProcesses：tasklist CSV 解析 + 子串匹配 + 去重排序", "tests/probes.test.mjs::probeProcesses：ps 输出解析（取 basename、跳空行）+ 大小写不敏感"]
        source: { file: "src/isolation/probes.ts", lines: "224-227, 247" }
      - given: "进程探测**没探成**"
        when: "未给 patterns / 命令 spawn 失败 / 退出码非 0"
        then: "三种情况都 available:false + detail（'未指定 patterns' / '<ENOENT>: ...' / '<cmd> 退出码 N：<stderr 首行>'）；**不要读成「没有孤儿进程」**"
        verdict: fail
        tests: ["tests/probes.test.mjs::probeProcesses：命令缺失 / 退出码非 0 / 未给 patterns 都要说明原因"]
        source: { file: "src/isolation/probes.ts", lines: "182-222" }
      - given: "命令可用但零匹配"
        when: "names.length === 0 且 available"
        then: "available:true 且 detail 带「输出 N 行但未匹配」 + 前 5 行原始样例——把「确实没有」与「输出格式不符预期」分开"
        verdict: pass
        tests: []
        source: { file: "src/isolation/probes.ts", lines: "229-245" }
      - given: "解析进程名输出"
        when: "parseProcessNames(stdout, 'tasklist' | 'ps-lines')"
        then: "tasklist 取 CSV 首个引号字段（文件头 / INFO 行跳过）；ps-lines 每行取 basename；空行跳过；坏行不抛"
        verdict: pass
        tests: ["tests/probes.test.mjs::parseProcessNames：坏行不抛（文件头 / 空行 / INFO 行）"]
        source: { file: "src/isolation/probes.ts", lines: "269-291" }
      - given: "合成残留检测"
        when: "detectResidue(ctx, {ports, patterns})"
        then: "tmpdir 条目复用同步 detectLeftovers；被占端口 → port:<n>；探不到的端口 → unknown:port:<n>（原因）；进程探针不可用 → unknown:proc:<原因>；命中的孤儿进程 → proc:<name>；最后去重"
        verdict: pass
        tests: ["tests/probes.test.mjs::detectResidue：tmpdir 残留 + 被占端口，两类都出现", "tests/probes.test.mjs::detectResidue：探不到的端口与不可用的进程探针写 unknown: 前缀"]
        source: { file: "src/isolation/probes.ts", lines: "330-374" }

    cleanup: none
    nonDeterministic:
      - field: "CleanupRecord.leftovers"
        reason: "真实机器的残留（临时文件 / 端口 / 进程）随环境变化；unknown 条目还带探测错误原文"
        reconcile: sorted-set
      - field: "ProcessProbeResult.detail / PortProbeResult.detail"
        reason: "含命令输出样例、错误码与平台差异"
        reconcile: normalize-path
    equivalence:
      leftovers: sorted-set
      released: exact

  - id: BEH-ENGINE-ISOLATION-003
    title: isolation-pool —— 并发分组：只有显式 safe 才并发，且严格保序
    atomic: isolation-pool
    status: active
    source:
      file: src/isolation/pool.ts
      lines: "23-83"
      symbols:
        - ScenarioGroup
        - GroupOptions
        - isSafeScenario
        - groupScenarios
        - normalizeLimit
      tests:
        - tests/isolation.test.mjs::groupScenarios：limit=1 全串行，且严格保序
        - tests/isolation.test.mjs::groupScenarios：exclusive（含缺省）永远串行
        - tests/isolation.test.mjs::groupScenarios：连续 safe 按 limit 切组，但绝不跨越 exclusive
        - tests/isolation.test.mjs::groupScenarios：拼接后与输入逐元素同序（报告可复盘的前提）
        - tests/isolation.test.mjs::groupScenarios：非法 limit 退化成串行，绝不「猜」一个更大的并发度
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "场景是否允许并发"
        when: "isSafeScenario(scenario)"
        then: "只有 parallel === 'safe' 才算真；缺省（undefined）与 'exclusive' 都是 false——不认识的东西不并发"
        verdict: pass
        tests: ["tests/isolation.test.mjs::groupScenarios：exclusive（含缺省）永远串行"]
        source: { file: "src/isolation/pool.ts", lines: "36-39" }
      - given: "limit <= 1"
        when: "groupScenarios(scenarios, {limit:1})"
        then: "每个场景一个 serial 组，全串行（等于关掉并发，也是配置默认值）"
        verdict: pass
        tests: ["tests/isolation.test.mjs::groupScenarios：limit=1 全串行，且严格保序"]
        source: { file: "src/isolation/pool.ts", lines: "63-68" }
      - given: "连续多个 safe 且 limit > 1"
        when: "groupScenarios"
        then: "连续 safe 攒成 parallel 组，长度达到 limit 即 flush；一个连续 safe 段可能被切成若干组"
        verdict: pass
        tests: ["tests/isolation.test.mjs::groupScenarios：连续 safe 按 limit 切组，但绝不跨越 exclusive"]
        source: { file: "src/isolation/pool.ts", lines: "54-66, 74" }
      - given: "遇到 exclusive 场景"
        when: "groupScenarios 遍历到非 safe"
        then: "先把 pending 的 parallel 组 flush，再单独给该场景一个 serial 组——独占场景必须先把前面的并发段收口"
        verdict: pass
        tests: ["tests/isolation.test.mjs::groupScenarios：exclusive（含缺省）永远串行", "tests/isolation.test.mjs::并发 vs 串行：exclusive 场景被夹在并发组之间时，顺序与结论都不变"]
        source: { file: "src/isolation/pool.ts", lines: "69-72" }
      - given: "保序不变式"
        when: "把各组的 items 依次拼接"
        then: "结果**恰好等于输入数组**（同顺序、同元素）——这是「并发结果与串行结果可逐条对齐」的前提"
        verdict: pass
        tests: ["tests/isolation.test.mjs::groupScenarios：拼接后与输入逐元素同序（报告可复盘的前提）"]
        source: { file: "src/isolation/pool.ts", lines: "12-20, 74-75" }
      - given: "非法 limit（非有限数 / <1）"
        when: "groupScenarios(scenarios, {limit: NaN | 0 | -3})"
        then: "normalizeLimit 一律退回 1（串行），绝不「猜一个大一点的并发度」"
        verdict: pass
        tests: ["tests/isolation.test.mjs::groupScenarios：非法 limit 退化成串行，绝不「猜」一个更大的并发度"]
        source: { file: "src/isolation/pool.ts", lines: "78-83" }
    cleanup: none
    nonDeterministic: []
    equivalence:
      groups[].kind: exact
      groups[].items: exact-order

  - id: BEH-ENGINE-ISOLATION-004
    title: isolation-release —— 步骤级释放：逆序纪律、幂等链与 released/leftovers
    atomic: isolation-release
    status: active
    source:
      file: src/isolation/cleanup.ts
      lines: "36-180"
      symbols:
        - StepResource
        - registerStepDisposer
        - releaseStepNotes
        - stepResourceOf
        - registerFallback
        - anonymousResources
      tests:
        - tests/isolation.test.mjs::releaseStepNotes：释放其一，另一个仍由夹具兜底释放（且不重复释放）
        - tests/isolation.test.mjs::releaseStepNotes：disposer 抛错不抛穿，失败进 Fixture.release() 的 failures
        - tests/isolation.test.mjs::releaseStepNotes：异步 disposer 会被 await（不会退回"步骤结束没拆掉"）
        - tests/isolation.test.mjs::releaseStepNotes：裸函数句柄同样幂等，未点名的仍由夹具释放
        - tests/isolation.test.mjs::并发 vs 串行：safe 场景逐条 verdict 与断言 ok 完全一致（真实 driver）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "driver 登记一个步骤级资源"
        when: "registerStepDisposer(fixture, key, dispose)"
        then: "句柄写进 fixture 取证键（note(key, resource)）并挂一份夹具兜底释放；非函数 dispose 抛 TypeError；返回 StepResource"
        verdict: pass
        tests: []
        source: { file: "src/isolation/cleanup.ts", lines: "60-72" }
      - given: "步骤结束按 releaseNotes 点名释放"
        when: "releaseStepNotes(fixture, ['k1','k2'])"
        then: "只释放键存在且未释放过的资源；返回**实际释放成功**的键列表；键不存在/值不是句柄/已释放 → 跳过不抛"
        verdict: pass
        tests: ["tests/isolation.test.mjs::releaseStepNotes：释放其一，另一个仍由夹具兜底释放（且不重复释放）"]
        source: { file: "src/isolation/cleanup.ts", lines: "87-111" }
      - given: "释放失败"
        when: "dispose 抛错"
        then: "resource.failure 记下描述，**不抛穿**调用方，且该键**不计入**返回值（「返回实际释放了哪些键」要能当真）；失败由夹具兜底 release() 上报进 failures"
        verdict: fail
        tests: ["tests/isolation.test.mjs::releaseStepNotes：disposer 抛错不抛穿，失败进 Fixture.release() 的 failures"]
        source: { file: "src/isolation/cleanup.ts", lines: "101-107, 138-152" }
      - given: "幂等链（本模块的核心不变式）"
        when: "先 releaseStepNotes 释放，再等场景结束 Fixture.release()"
        then: "兜底那份发现 resource.released 已 true → 无失败则 no-op；有失败则抛一次让 failures 收到它。两条路径都不抛穿"
        verdict: pass
        tests: ["tests/isolation.test.mjs::releaseStepNotes：释放其一，另一个仍由夹具兜底释放（且不重复释放）"]
        source: { file: "src/isolation/cleanup.ts", lines: "24-27, 134-152" }
      - given: "先置标记再执行"
        when: "releaseStepNotes 处理一个资源"
        then: "先 resource.released = true 再 await dispose()——dispose 里若再入本函数也不会二次释放"
        verdict: pass
        tests: []
        source: { file: "src/isolation/cleanup.ts", lines: "97-99" }
      - given: "裸函数句柄"
        when: "driver 直接 fixture.note(key, fn)"
        then: "stepResourceOf 用 WeakMap 把同一函数映射到同一句柄（key='(anonymous)'），同样幂等；未点名的仍由夹具兜底释放"
        verdict: pass
        tests: ["tests/isolation.test.mjs::releaseStepNotes：裸函数句柄同样幂等，未点名的仍由夹具释放"]
        source: { file: "src/isolation/cleanup.ts", lines: "51-52, 121-131" }
      - given: "把证据误当资源"
        when: "stepResourceOf(字符串 / 数字 / 普通对象)"
        then: "返回 undefined（不许把证据当资源误释放）"
        verdict: pass
        tests: []
        source: { file: "src/isolation/cleanup.ts", lines: "119, 130, 167-176" }
      - given: "报告里的句柄形状"
        when: "JSON.stringify 含 StepResource 的 notes"
        then: "toJSON() 输出 { kind:'step-resource', key, released }——不是被丢掉的 {}"
        verdict: pass
        tests: []
        source: { file: "src/isolation/cleanup.ts", lines: "28-32, 161-164" }
      - given: "CleanupRecord 的两个字段（released / leftovers）"
        when: "runner 汇总 step 级释放与残留检测"
        then: "released = [...new Set(releasedNotes)]（步骤级 cleanup 实际释放的取证键，去重保序）；leftovers = detectLeftovers 的结果（临时目录 / 端口 / 进程；探不到时带 unknown: 前缀）；两者都空时**不写** cleanup 字段"
        verdict: pass
        tests: ["tests/isolation.test.mjs::并发 vs 串行：safe 场景逐条 verdict 与断言 ok 完全一致（真实 driver）"]
        source: { file: "src/runtime/runner.ts", lines: "552-560" }
      - given: "整体兜底释放的逆序纪律"
        when: "场景结束执行 Fixture.release()"
        then: "登记进夹具的兜底 disposer 按**逆序**执行（后登记的步骤级资源先释放），与 setup/teardown 的相反顺序一致"
        verdict: pass
        tests: ["tests/fixture.test.mjs::逆序释放"]
        source: { file: "src/runtime/fixture.ts", lines: "66-82" }
    cleanup: registered
    nonDeterministic:
      - field: "StepResource.failure"
        reason: "disposer 抛出的错误原文（可能内嵌绝对路径）"
        reconcile: normalize-path
      - field: "CleanupRecord.leftovers"
        reason: "真实残留随环境变化"
        reconcile: sorted-set
    equivalence:
      released: exact
      leftovers: sorted-set

  - id: BEH-ENGINE-ISOLATION-005
    title: isolation-leaks —— 同步残留检测：缺省真检查 tmpdir，条目保序去重
    atomic: isolation-leaks
    status: active
    source:
      file: src/isolation/leaks.ts
      lines: "33-144"
      symbols:
        - detectLeftovers
        - LeakProbes
        - MAX_FS_ENTRIES
        - dedupe
        - defaultFsProbe
        - collect
      tests:
        - tests/isolation.test.mjs::detectLeftovers：干净的隔离上下文没有任何残留
        - tests/isolation.test.mjs::detectLeftovers：缺省探针真的检查 tmpdir（文件与子目录都算残留）
        - tests/isolation.test.mjs::detectLeftovers：三类残留都能被注入的探针抓到（顺序稳定、去重）
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "缺省 probe 集合（不注入 fsProbe / portProbe / procProbe）"
        when: "detectLeftovers(ctx)"
        then: "只真检测 tmpdir：递归列出 ctx.tmpdir 下仍存在的条目（目录本身也算一条），每条前缀 `tmpdir:`；**不产生** port/proc 条目，也**不报「干净」**（不假装它们被探过）"
        verdict: pass
        tests: ["tests/isolation.test.mjs::detectLeftovers：干净的隔离上下文没有任何残留", "tests/isolation.test.mjs::detectLeftovers：缺省探针真的检查 tmpdir（文件与子目录都算残留）"]
        source: { file: "src/isolation/leaks.ts", lines: "20-24, 62-72, 107-112" }
      - given: "注入三类探针"
        when: "detectLeftovers(ctx, {fsProbe, portProbe, procProbe})"
        then: "条目前缀固定：`tmpdir:<相对路径>` / `port:<端口>` / `proc:<进程名>`；顺序恒为 ①fs → ②port → ③proc"
        verdict: pass
        tests: ["tests/isolation.test.mjs::detectLeftovers：三类残留都能被注入的探针抓到（顺序稳定、去重）"]
        source: { file: "src/isolation/leaks.ts", lines: "36-43, 62-97" }
      - given: "某个探针抛错"
        when: "fsProbe / portProbe / procProbe 抛异常"
        then: "记 `probe-error:fs|port|proc:<Name: message>`，**继续跑其余探针**（不把运行带崩）——检测器炸了本身也是风险，如实报"
        verdict: fail
        tests: ["tests/isolation.test.mjs::detectLeftovers：三类残留都能被注入的探针抓到（顺序稳定、去重）"]
        source: { file: "src/isolation/leaks.ts", lines: "70-72, 80-82, 94-96" }
      - given: "条目去重"
        when: "dedupe(leftovers)"
        then: "保序去重：同一类残留出现两次只记一条（否则一个会抛错的端口探针会按端口数乘出 N 条一模一样的噪音）"
        verdict: pass
        tests: ["tests/isolation.test.mjs::detectLeftovers：三类残留都能被注入的探针抓到（顺序稳定、去重）"]
        source: { file: "src/isolation/leaks.ts", lines: "99, 102-105" }
      - given: "目录条目过多"
        when: "递归列出的条目数 > MAX_FS_ENTRIES（200）"
        then: "只取前 200 条，并补一条 `tmpdir:（另有 <n> 项已省略）`；collect 触到上限即停止递归"
        verdict: pass
        tests: []
        source: { file: "src/isolation/leaks.ts", lines: "33-34, 66-69, 131-139" }
      - given: "目录项是符号链接"
        when: "collect 遍历"
        then: "只记 symlink 本身，**不跟进去**（跟进去可能读到目录树外面，也会成环）"
        verdict: pass
        tests: []
        source: { file: "src/isolation/leaks.ts", lines: "135-138" }
      - given: "目录读不了（不存在 / 无权限）"
        when: "readdirSync 抛错"
        then: "catch 后视为**没有残留**并返回（不报错）——理由写在注释里：dispose 之后目录本就该不存在，那是正常路径。见下方边界缺陷"
        verdict: pass
        tests: []
        source: { file: "src/isolation/leaks.ts", lines: "121-129" }
      - given: "返回结构"
        when: "detectLeftovers 返回"
        then: "{ released: [], leftovers }：本函数只「看」不「释放」，`released` **恒为空数组**；释放清单由 runner 合并（见 isolation-release）"
        verdict: pass
        tests: []
        source: { file: "src/isolation/leaks.ts", lines: "45-49, 99" }
    cleanup: none
    nonDeterministic:
      - field: "CleanupRecord.leftovers"
        reason: "真实机器的残留（临时文件）随环境变化；相对路径含随机命名空间的 tmpdir 内容"
        reconcile: sorted-set
    equivalence:
      leftovers: sorted-set
      released: exact
---

# isolation —— 隔离与回滚

覆盖旧实现的五个文件：`context.ts`（隔离落脚点）、`probes.ts`（异步探针）、`leaks.ts`（同步残留
检测）、`pool.ts`（并发分组）、`cleanup.ts`（步骤级释放）。设计
[REWRITE-DESIGN.md §1.2](../../../../docs/REWRITE-DESIGN.md) line 57 给它们的去向是
「Rust `FixtureScope` + TS 注册面」，§6.2 line 511 与 §2.3 line 168 明确**逐条沿用**既有纪律。

命名依据（engine 域无设计硬约束，按源码事实定）：

| atomic | 承担物 | 为什么独立 |
|---|---|---|
| `isolation-context` | `context.ts` | 落脚点（namespace/tmpdir/ports/session）的创建与释放，可独立 pass/fail |
| `isolation-probe` | `probes.ts` | 异步探针（端口 / 进程）与合成残留，**unknown 纪律**的落点，可独立 pass/fail |
| `isolation-leaks` | `leaks.ts` | 同步残留检测（缺省真检查 tmpdir），与探针互补、**不互相替代**，可独立 pass/fail |
| `isolation-pool` | `pool.ts` | 并发分组与保序，纯函数，可独立 pass/fail |
| `isolation-release` | `cleanup.ts`（+ `Fixture.release` 的逆序） | 「拆干净没有」的判定与幂等链，可独立 pass/fail |

## isolation-context

`parallel: safe` 是一条**承诺**（context.ts 头注 line 6）：承诺要能兑现，必须有"互不干扰的
落脚点"。本原子负责造出那三个落脚点（namespace / tmpdir / session）并声明端口。
**端口只声明不分配**是一个刻意的取舍：同步 API 里没有可靠的"拿一个空闲端口"（`listen(0)` 是异步的），
猜一个端口号正是并发踩踏的经典来源。

### 边界与已知缺陷

- **`namespace` 含 `Math.random` 后缀**：同一进程、同一场景、同一序号也不可能撞名，但这也意味着
  `tmpdir` 路径不可复现（对拍必须归一化）。
- **`disposeIsolationContext` 吞掉删除失败**：`context.ts:104-109` 的 catch 不记录任何痕迹。
  设计 §6.2 第 2 条要求"释放失败不静默"，这里靠的是"下一次 `detectLeftovers` 会把目录当真残留
  报出来"来兜底（因为残留检测在 dispose **之前**，见 runner.ts:512-519）。这条间接保证依赖
  调用顺序，阶段 1 应显式化。

## isolation-probe —— 「探不到标 unknown，绝不标干净」

这是设计 §6.2 line 511 点名的纪律，在旧实现里的**逐条落点**：

| 纪律 | 代码位置 | 具体行为 |
|---|---|---|
| 探不到 ⇒ `unknown`，不是干净 | `probes.ts:12-16`（头注第 ① 条） | 端口探测因权限/IPv6/超时失败时写 `busy:'unknown'` |
| 类型层面就禁止把 unknown 当 false | `probes.ts:31-37` | `PortProbeResult.busy: boolean \| 'unknown'`，且 `unknown` 时**必给** `detail` |
| 非 EADDRINUSE 的错误一律 unknown | `probes.ts:143-149` | `EACCES` / `EADDRNOTAVAIL` 等 → `unknown` + 错误码 |
| 探测超时 ⇒ unknown | `probes.ts:139-141` | `探测超时（> nms）` |
| 非法端口 ⇒ unknown | `probes.ts:114-116` | 不做无意义探测 |
| 探针不可用 ⇒ 显式 `available:false` | `probes.ts:47-56, 171-172` | "没探成"与"探成了零匹配"是两回事 |
| 合成残留用 `unknown:` 前缀 | `probes.ts:353-357` | `unknown:port:<n>（原因）` |
| 进程探针不可用 ⇒ `unknown:proc:` | `probes.ts:367-369` | `unknown:proc:<原因>` |
| 缺省探针不假装干净 | `leaks.ts:20-24` | 不注入 portProbe/procProbe 时**不产生**那两类条目，也不报"干净" |
| 探针自己炸了如实报 | `leaks.ts:70-72, 80-82, 94-96` | `probe-error:<fs|port|proc>:<err>` |

条目前缀规范（便于报告里 grep）：`tmpdir:<相对路径>` / `port:<端口>` / `proc:<进程名>` /
`unknown:port:<端口>（原因）` / `unknown:proc:<原因>` / `probe-error:<类>:<错误>`。
条目**保序去重**（`leaks.ts:102-105`）。其中 `tmpdir:` / `probe-error:` / 去重实现都住在
`leaks.ts` —— 它们的原子条目见下面的 `isolation-leaks`（本节的表是跨原子的纪律总览）。

### 边界与已知缺陷

- **端口只探 `127.0.0.1`（IPv4 回环）**（`probes.ts:19-20`）：只绑在别的网卡上的占用探不到，
  这是**已知边界**，不是实现了的保证。
- **进程名最多回 50 条**（`probes.ts:85-86`）；**目录条目最多 200 条**（`leaks.ts:33-34`），
  超出部分只留一条"已省略"计数。
- **`detectLeftovers` 的缺省探针只真检测 tmpdir**（`leaks.ts:27`）：runner 每步善后调同步版
  （快、无 IO），体检与大扫除走 `detectResidue`。两者**不互相替代**。
- **`collect` 把"目录读不了"当作"没有残留"**（`leaks.ts:124-129`）。注释给的理由是
  "dispose 之后目录本就该不存在，那是正常路径"——但这也会把权限问题读成干净。属于
  **与 unknown 纪律相冲突的一处**，阶段 1 需要裁决（本条目如实记录，不调和对立）。

## isolation-leaks

同步残留检测（`leaks.ts`）。它是 `isolation-probe` 的**补集**而不是替代：

| | `isolation-probe`（`probes.ts`） | `isolation-leaks`（`leaks.ts`） |
|---|---|---|
| 端口 | 自己 listen 一次，真探（异步） | 依赖注入的 `portProbe`（同步） |
| 进程 | `tasklist` / `ps`，真探（异步） | 依赖注入的 `procProbe`（同步） |
| tmpdir | 复用本模块的同步检测 | **缺省就真检查**（`readdirSync`） |
| 用途 | 体检 / 大扫除（`detectResidue`） | runner 的每步善后（快、无 IO） |

分工的代码依据：`leaks.ts:6-24` 的头注明说"Node 没有同步的端口是否被占 API，同步 API 里也调不了
`tasklist`/`ps`"，所以同步版缺省只真检测 tmpdir；异步版补上那两类，形状刻意保持一致
（同一个 `CleanupRecord`、同一套前缀）。

### 边界与已知缺陷

- **`collect` 把"目录读不了"当作"没有残留"**（`leaks.ts:121-129`）。注释给的理由是
  "dispose 之后目录本就该不存在，那是正常路径"——但这也会把**权限问题**读成干净，
  与 `unknown` 纪律相冲突。本条目如实记录，不调和对立；阶段 1 需裁决。
- **不注入探针 = 不产生条目，也不报"未探测"**（`leaks.ts:20-24`）：报告里该不该把"未探测"
  单独写出来，代码注释说"由 runner 决定（它知道自己注没注入）"——但**当前 runner 并没有写**
  （`runner.ts:516-519` 只调 `detectLeftovers(isolation)`，不注入任何探针）。所以真实 run.json 的
  `cleanup.leftovers` 只可能含 `tmpdir:` / `probe-error:fs:` 两类。这是**已知缺口**。
- **`MAX_FS_ENTRIES` 的"已省略"条目本身也进 `leftovers`**（`leaks.ts:67-69`）：
  它会被当成一条残留（正确），但对拍时不要把它误读成真实文件。

## isolation-pool

三条语义（`pool.ts:4-11`）：只有显式 `parallel: safe` 才并发；`limit <= 1` 全串行；
连续 safe 组内并发度不超过 limit（可能被切成多组）。**保序**是"报告可复盘"的前提：
组按执行顺序排列，拼起来恰好等于输入数组。

### 边界与已知缺陷

- 本原子是**纯函数**（无 IO、无时间、无随机），故 `nonDeterministic: []` 是确认而非遗漏。
  守卫会对此给出 WARN，属预期。

## isolation-release

步骤级释放解决的现场问题：接管 `llm/stream` 的监听器若一直挂到整条场景结束，后面的步骤
观测到的就是"被前一步改造过的宿主"（`cleanup.ts:4-8`）。`releaseNotes` 让这一步结束就拆。

机制（`cleanup.ts:10-25`）：`Fixture` 只有 `add(label, dispose)` 与整份 `release()`，
**没有按 label 单独释放的入口**；所以这里把"可单独释放的资源"做成句柄对象，用
`Fixture.note(key, handle)` 存进取证键下，并同时挂一份夹具兜底释放。

由此得到两条关键语义：

1. **幂等链**：单独释放过 → 兜底那份变 no-op；没单独释放过 → 兜底那份照常释放。两条路都不抛穿。
2. **逆序纪律**：兜底 disposer 进的是 `Fixture` 的释放栈，按登记逆序执行
   （`fixture.ts:66-82`）；`runner.ts:503-510` 的 driver teardown 也显式逆序。

### 边界与已知缺陷

- **失败上报时机滞后**：`releaseStepNotes` 里的 dispose 失败不会立刻可见，要等
  `Fixture.release()` 才进 `releaseFailures`（`cleanup.ts:104-107, 138-152`）。这是刻意的
  （"一次清理失败不该把整条场景判成 errored"），但报告里"失败出现的位置"与"发生的位置"不同步。
- **`(anonymous)` 键名**：裸函数句柄的 key 固定为 `(anonymous)`，同名多个函数在报告里不可区分
  （`cleanup.ts:126`）——失败上报时用登记时的 label 覆盖（`cleanup.ts:134`）。
- **`anonymousResources` 是进程级 WeakMap**：同一函数在**不同 Fixture** 里复用会拿到同一句柄
  （`cleanup.ts:52, 124-128`），即"释放过一次，另一个 Fixture 兜底就不再释放"。
  这是潜在的跨场景耦合点，阶段 1 需确认是否有意（当前无测试覆盖）。
