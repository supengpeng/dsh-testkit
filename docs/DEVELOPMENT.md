# 开发文档（Development）

> 目标读者：本项目的开发者（含 AI 协作）。
> 所有命令以 **Windows + PowerShell** 为准，路径按本机实测值填写。

---

## 1. 环境事实（本机实测）

| 项 | 值 |
|---|---|
| 工作区 | `C:\Users\19059\Documents\deepseek-harness\default-workspace` |
| 本插件目录 | `<工作区>\dsh-testkit` |
| DSH 版本 | `0.2.0-rc.2` |
| DSH CLI | `D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd` |
| Node | `C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe` |
| pnpm | `C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs` |
| DSH profile | `desktop`（`C:\Users\19059\.dsh\profiles\desktop`） |
| Web GUI | `http://127.0.0.1:19387` |

因为 `node` 不在 PATH，所有命令显式使用绝对路径。建议先设别名：

```powershell
$NODE = 'C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
$PNPM = 'C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$DSH  = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
```

---

## 2. 首次搭建

```powershell
cd C:\Users\19059\Documents\deepseek-harness\default-workspace\dsh-testkit

# 安装依赖（含 dev）
& $NODE $PNPM install

# 构建：host 半（tsc → lib/）+ client 半（esbuild → lib/client.js）
& $NODE $PNPM run build:all

# 安装进 desktop profile
& $DSH plugin --profile desktop add .

# 验证已进入组合后的插件树
& $DSH --profile desktop --dump-config | Select-String testkit
```

**安装纪律**（来自 `dsh-streamfold` 的实测注释）：

- 必须走 `dsh plugin ... add <路径>`，**不要**裸 `npm install` 到 profile 目录
- 安装后 bundle patch 会自动并入 profile，**不要**再往
  `~/.dsh/profiles/desktop/cordis.patch.yml` 手动 `insert` 同一个 id
  —— 重复 id 会让加载器报错起不来

---

## 3. 构建

| 产物 | 命令 | 说明 |
|---|---|---|
| `lib/*.js` + `*.d.ts` | `pnpm run build` | host 半，`tsc -p tsconfig.json` |
| `lib/client.js` | `pnpm run build:client` | client 半，`scripts/build-client.mjs`（esbuild + wrapper） |
| 两者 | `pnpm run build:all` | |

> ⚠️ **`build` 会先删除整个 `lib/`**，所以它**不会**保留 `lib/client.js`。
> 只要 host 半就需要重建 client 半时，用 `build:all`；`gate` 也已经包含 `build:client`。
>
> 这个坑真实踩过：跑完 `gate` 后 `lib/client.js` 消失，表现为
> **GUI 里「测试」标签凭空不见**（client 半 404），而 host 半一切正常。
> `dsh-client-modules` 的文档其实写了"缺失 `lib/client.js` 会明确导致激活失败"——
> 但那个失败提示在浏览器控制台里，很容易被 DSH 自身的日志淹没。

### client 半产物的形态约束

`lib/client.js` **必须**是 DSH 模块加载器的入口形态，而不是普通 ESM：

```js
window.__ModuleLoader__.load({
  id: 'dsh-testkit',
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    /* bundle */
    return module.exports;   // → { name, inject, apply }
  }
});
```

该 wrapper 由 `scripts/build-client.mjs` 的 `banner`/`footer` 生成，
`react` / `react/jsx-runtime` / `@deepseek-ai/*` 全部 **external**（由宿主模块表提供）。

> 对照参考：`dsh-context/lib/client.js` 尾部有完整的产物形态注释
> （`//#region src/client/index.ts` → `module.exports = { name, inject, apply }`）。

---

## 4. 开发循环

### 4.1 host 半的循环（快）

```
改 src/*.ts → pnpm run build → 重启 DSH（或触发重载）→ 验证
```

profile 的 `patchReload` 默认为 `startup`，**改了插件代码/配置需要重启才生效**。

### 4.2 client 半的循环

client 半产物是 `lib/client.js`，改完之后**只需两步**：

1. `pnpm run build:client`
2. 刷新浏览器页面（必要时硬刷新）

**不需要**重建 DSH 的 Web 产物：`dsh-client-modules` 的 revision 由入口文件的
`mtimeMs` / `ctimeMs` / 大小派生（不对内容求哈希），重建后元数据变化即被识别为新 revision。

例外：改了 `package.json` 的 `dsh.client` 声明（例如新增 `external`）**需要重启 DSH**，
因为 Loader 条目声明在启动期读取。

> 系统提示里提到「client-plugin HMR 需同时运行 DSH checkout 的 `pnpm run dev:web`」，
> 那是**从 DSH 源码 checkout 开发**时的链路。本插件是外装包，靠「重建 + 刷新」迭代。

### 4.3 客户端与 host 半怎么通信

**没有 `host.call`。** 静态插件包走自建 HTTP bridge：

| 侧 | 文件 | 形态 |
|---|---|---|
| host | [`src/http.ts`](../src/http.ts) | `ctx.webServer.register({ kind: 'exact', path: '/api/dsh-testkit/<m>', handler(req,res) })` |
| client | [`src/client/bridge.ts`](../src/client/bridge.ts) | `fetch(BRIDGE_PREFIX + '/' + m, { method: 'POST', body: JSON.stringify(args) })` |

响应统一信封：`{ ok: true, value }` 或 `{ ok: false, code, message }`。

调试方法：浏览器 DevTools → Network，过滤 `dsh-testkit`；或在终端直接打端点：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:19387/api/dsh-testkit/list -Method POST -Body '{}' -ContentType 'application/json'
```

**为什么要这样写**（结论不可动摇，改代码前先读）：见 [ARCHITECTURE.md §6.3](ARCHITECTURE.md)。

### 4.4 应用失败时怎么查

`apply()` 抛错会让插件静默不激活。沿用 `dsh-memory` 的做法，本插件在
`src/index.ts` 里写了**独立探针**，把失败写到 DSH 日志系统之外：

```
C:\Users\19059\.dsh\logs\dsh-testkit-apply-error.log
```

排查顺序：

1. 看这个探针文件（有没有、时间戳对不对）
2. 看 DSH 主日志
3. `dsh --profile desktop --dump-config` 确认条目确实进了树
4. 检查 `inject` 声明的服务是否真的存在（缺服务会 PENDING 不激活）

---

## 5. 测试与校验

```powershell
& $NODE $PNPM run typecheck:host      # host 半类型检查
& $NODE $PNPM run typecheck:client    # client 半类型检查
& $NODE $PNPM run verify:cases        # 校验 cases/*.yaml 与 index.yaml 一致性
& $NODE $PNPM test                    # 全部单元 + 集成测试
& $NODE $PNPM run gate                # 以上全链路（推荐）
```

### 测试分层

| 层 | 文件 | 证明什么 |
|---|---|---|
| 纯逻辑 | `assert` / `fixture` / `schema` | 函数算得对：断言词、夹具逆序释放、YAML 校验规则 |
| 通道 | `http.test.mjs` | bridge 信封约定、`405`/`400`/`500` 分类、空 body 语义 |
| **装配** | `host-apply.test.mjs` | **插件能被宿主正确装载**：`inject` 门控、能力探测、`defineTool` 转换、注册面 |
| **headless 宿主** | `headless.test.mjs` | 替身的**契约一致性**：能力取舍、guard 顺序、web 选择规则、`arguments` 校验 |
| 各 driver | `*-driver.test.mjs` | driver 契约（注册 / 取证 / 边界），配"对照组"用例 |
| **CI 导出** | `export.test.mjs` | 生成物结构；**可执行性**由 gate 端到端验证 |
| **场景端到端** | `scenario-run.test.mjs` | 13 条场景在 headless 宿主里逐条与批量均通过 |

### 5.1 架构一致性守卫（`verify:cases` 的一部分）

`verify-cases.mjs` 除了校验 YAML，还会检查三处 **kind 列表**是否自洽：

| 检查 | 性质 |
|---|---|
| 场景用了没有 driver 的 kind | **错误**——这条场景永远跑不过 |
| 实现了却没登记进 `SCENARIO_KINDS` | **错误**——用户写出的合法场景会被 schema 拒绝 |
| 声明了但还没实现 driver | 警告（提示进度，如当前的 `agent` / `ui`） |
| 有 driver 但无 active 场景 | 警告（建议补一条自检场景） |

**为什么值得单独守**：`SCENARIO_KINDS`（`cases/types.ts`）是**类型层**常量，
`createDriverRegistry()`（`kinds/index.ts`）是**运行时**真源——两者目前靠人肉同步，
是这套代码里最容易漂移的一处。守卫把它变成机器检查。

### 5.2 CI 导出（双轨的另一条腿）

`testkit_export` 工具与 `/testkit export` 命令**共用** `export/write.ts` 里的
`exportScenariosToFile()`——两条入口共用一份实现是刻意的，否则它们迟早会漂移
（工具面导出的文件与命令面导出的不一样，是最难查的一类不一致）。

```powershell
& $NODE $PNPM run export:ci                    # 导出 → export/scenarios.test.mjs
& $NODE --test export/scenarios.test.mjs       # 跑导出的用例（不需要 DSH）
```

`gate` **每次都会做这两步**——所以 CI 轨不是"写了但没人跑"，而是每次都被验证。

导出的文件**自包含**：它 import 本包 `lib/` 里的 `createHeadlessHost()` 自己组宿主，
所以在没有 DSH、没有 GUI 的机器上也能跑（前提是本包依赖含 cordis peer 可用）。

> 改 `export/node-test.ts` 的生成模板时，同步看 `tests/export.test.mjs` 的结构断言
> ——它守的是"生成物里该有什么"。
>
> 也别把 CI 轨当成活宿主验证的替代：它证明的是"场景数据 + driver 逻辑 + 断言可判定"，
> **不证明**与真实 DSH 的交互一致（作用域 / 生命周期 / 真实配置）。

#### 5.2.1 `fixture` 标签：把"被测对象的健康"与"插件的质量"分开

导出时**默认排除**带 `fixture` 标签的场景（`selectExportable()`，见 `scripts/export-scenarios.mjs`）。

**为什么**：这类场景测的是**外部被测对象**（下载来的包）。被测对象自身有 bug 时它们会如实失败——
例如 `TK-0026` 抓到了 `dsh-memory` 0.8.1 里一个真实的 import 笔误。
如果它进 gate，**被测对象的缺陷就会把插件的质量门染红**，那是错的。

| 想回答的问题 | 跑什么 |
|---|---|
| 插件本身健康吗？ | `pnpm run gate`（默认，不含 `fixture`） |
| 外部被测对象健康吗？ | `node scripts/export-scenarios.mjs --include-fixture --out export-all` 然后跑它 |

`selectExportable()` 有 7 项单测（`tests/export-select.test.mjs`）——它是质量门的关键机制。

### 5.2.2 外部 fixture（被测对象）

有些场景要测**别人发布的包**。这类对象不适合进仓库（40 MB+），但场景需要一个稳定、可复现的引用方式：

```powershell
& $NODE scripts/fetch-fixtures.mjs --list                    # 看清单
& $NODE scripts/fetch-fixtures.mjs dsh-memory-0.8.1          # 准备某一个
& $NODE scripts/fetch-fixtures.mjs                           # 全部
```

约定：fixture 解到 `<包根>/.fixtures/<name>`（**git 忽略**），场景里用 `$FIXTURES/<name>` 引用。
下载走 npm registry 直链——**不需要 npm/pnpm 在场**，也不写 `package.json`，
因此不会碰到任何 profile 或全局状态。

**缺失时不会让场景假装通过**：`file` / `shell` driver 在显式给出了 `root` / `cwd` 却不存在时，
会 **SkipCase 并说明**（提示"见 scripts/fetch-fixtures.mjs"）。

加一个新的被测对象：在 `scripts/fetch-fixtures.mjs` 的 `FIXTURES` 数组里加一条即可。

### 5.3 真实验证（独立 profile + headless 模式）

**这是唯一能在不碰 desktop profile、也不中断当前会话的前提下做真实验证的方法。**
（装进 desktop profile 需要重启 DSH，而重启会中断正在进行的会话。）

```powershell
$DSH  = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
$PKG  = '<本仓绝对路径>'

# ① 从 headless 模板创建独立 profile（只需一次；`--help` 只为初始化后立刻退出）
& $DSH tk --from-default-profile headless --help

# ② 装上本插件（link 方式，改动可逆）
& $DSH plugin --profile tk add $PKG

# ③ 让它复用账号登录态（headless 默认走 deepseek-official，需要 API key）
#    编辑 ~/.dsh/profiles/tk/cordis.patch.yml：
#      - id: agent-default-model
#        config:
#          provider: deepseek-account
#          model: deepseek-flash

# ④ 跑任务并退出（headless 模式：答一个任务、打印结果、退出）
& $DSH tk "调用 testkit_list 工具，报告场景数量与 kind 分布"
& $DSH tk "调用 testkit_run 工具、不传参数，报告通过/失败/跳过/错误的数字与失败原因"
```

**headless profile 的已知能力缺口**（实测，不是推测）：

| 服务 | 可用 | 影响 |
|---|---|---|
| `tools` / `commands` / `systemPrompt` / `web` / `llm` / `approval` | ✅ | 大多数场景可在真实宿主验证 |
| `webServer` | ❌ | HTTP bridge 不注册 → client 半通道走降级路径 |
| `userQuestions` | ❌ | `interaction` 的 question 分支会被**跳过**（并说明原因） |

> 所以 **client 半与 question 分支仍需在带 GUI 的 profile（web / desktop）上验证**。
> `headless` 覆盖不到这两块——这是它的边界，不是缺陷。

### 5.4 client 半验证（web profile）

client 半在 `headless` 下**验证不了**：那边没有 `webServer`，也没有 slot 系统。
另建一个从 `web` 模板派生的 profile，用**独立端口**起服务（不碰 desktop 的 19387）：

```powershell
$DSH = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'

& $DSH tkweb --from-default-profile web --help     # ① 建 profile（一次）
& $DSH plugin --profile tkweb add $PKG             # ② 装插件（provider/dshVersion 同 §5.3）
& $DSH tkweb --port 19488 --no-open                # ③ 起服务；日志会打印带 token 的 URL
```

然后验证三件事：

| 验什么 | 怎么做 |
|---|---|
| **bridge 通道** | `POST http://127.0.0.1:19488/api/dsh-testkit/list`，body `{}` → 期望 200 + 14 条场景 |
| **bundle 被组合** | 取 index.html（带 token），搜 `dsh-testkit/client.js` 是否在 combo URL 里 |
| **控制台渲染** | 浏览器打开 → 会话视图环应出现「测试」标签 → 点开看到 14 行表格 |

**两个必须知道的坑**（都真实踩过）：

1. **`lib/client.js` 必须存在。** `build` 会先删掉整个 `lib/`，所以跑 `gate`
   或 `build:all` 才有它。缺了它，「测试」标签会**凭空不见**，而 host 半一切正常
   （浏览器控制台里那条提示会被 DSH 自身日志淹没）。
2. **恢复 desktop 的旧会话时，整个会话视图是坏的**
   （控制台报 `uiConversation.binding: unknown session ...`），那时同样看不到「测试」标签。
   **新建一个会话**再验证。

> host 半的 bridge 路由用 `ctx.inject(['webServer'], cb)` 注册——**这是必须的**，
> 因为 `apply()` 执行时 `webServer` 往往还没就绪。详见
> [ARCHITECTURE.md 教训四](ARCHITECTURE.md)。

**顺带验热重载**（服务保持运行，不要重启）：

```powershell
# ① 记下当前 title
POST /api/dsh-testkit/list  →  TK-0001.title

# ② 改 cases/TK-0001.yaml 的 title

# ③ 等 2-3 秒后再查（不重启服务）
POST /api/dsh-testkit/list  →  title 应已变成新值
```

这就是 R6 的验证方式——**热监听在真实 profile 下确实工作**，改完即生效。

### 集成测试怎么跑（不需要装进 profile）

`tests/host-apply.test.mjs` 用 `@deepseek-ai/cordis` 直接组装一个最小宿主：

```js
import { Context } from '@deepseek-ai/cordis'
const ctx = new Context()
ctx.provide('tools', { register(def) { /* 记录注册 */ return () => {} } })
await ctx.plugin(pluginModule, config)
```

这是本项目的**主力验证手段**：零环境风险、不需要重启 DSH、不碰用户 profile，
却能把「插件能否被装载」这件事测到底。它同时是架构文档 R8 的答案。

`verify:cases` 的检查项见 [SCENARIO-SPEC.md §5](SCENARIO-SPEC.md)。

---

## 6. 日常作业：处理一批 issue

完整流程见 [ISSUE-PIPELINE.md](ISSUE-PIPELINE.md)，落到命令上是：

```
① 拿到 issue 数据（items.jsonl）
② 先跑一次能力缺口分析：node scripts/from-issue-data.mjs <数据目录>
   → cases-draft/ 下得到逐条草稿 + 一份「按形态分组的缺口报告」
   ⚠️ 草稿的 expect 全是显式 TODO——判据必须人来定，机器猜出来的判据只会制造
      "看起来在测、其实没测"的假象
③ 挑形态清晰的，归类 kind（决策树见 ISSUE-PIPELINE.md）
④ 写 cases/TK-XXXX.yaml（必须带 source.issue 溯源）
⑤ 更新 cases/index.yaml
⑥ pnpm run verify:cases          ← 数据合法性
⑦ 在 DSH 里跑 /testkit run TK-XXXX
⑧ 看 runs/<RUN-ID>/report.md
⑨ 需要时扩 src/kinds/*.ts → 回到 ⑥
```

**判据不可机器判定时，不要硬凑场景。** 例：`dsh-memory#37` 的核心是"`valid` 字段名
与实际语义不符"——这要读懂代码才判得了。正确做法是明确记录"这条要人判"，
而不是编一条看起来在测的场景。同一 issue 里往往混着可判定与不可判定的部分
（`#37` 的另一项"`compact_access` 无调用点"就是可判定的，落成了 `TK-0023`）。

### 脚本清单

| 脚本 | 作用 | 何时跑 |
|---|---|---|
| `build-client.mjs` | esbuild 打包 client 半 | `build` 内 |
| `verify-cases.mjs` | 场景数据合法性 + **架构一致性守卫**（kind 必须有 driver、索引自洽…） | `gate` 内 |
| `verify-docs.mjs` | **文档漂移守卫**（链接存在、`fx.*` 存在、脚本存在、场景计数） | `gate` 内 |
| `export-scenarios.mjs` | 导出 CI 用例（默认排除 `fixture`） | `gate` 内 |
| `check-pack-files.mjs` | 发包面：`files` 白名单必须覆盖入口（源自 #48） | 场景调用 |
| `check-python-topimports.mjs` | 隐式顶层导入是否被打进包（源自 #12/#48） | 场景调用 |
| `check-git-installable.mjs` | 从 git 安装会不会装出空壳（源自 #2） | 场景调用 |
| `from-issue-data.mjs` | 提炼：issue 数据 → 草稿 + 能力缺口报告 | 按需 |
| `fetch-fixtures.mjs` | 下载外部被测对象到 `.fixtures/` | 按需 |

---

## 7. 风险与排障

### 已结案（实测确认，勿再当假设）

| # | 问题 | 结论 |
|---|---|---|
| R1 | 双半通信通道 | **自建 HTTP bridge**。静态插件包没有 `host.call`（那是动态包沙箱专属） |
| R2 | `dsh.client` 与 external 语义 | 基座（React / Cordis / 静态 UI 库）无需声明；只有基座之外的请求进 `dsh.client.external` |
| R3 | client 产物格式 | `window.__ModuleLoader__.load({ id, factory })`，导出 `{ name, inject, apply }`，须为自包含单文件 |
| R4 | client 产物改动后是否要重建 Web | **不需要**；revision 由 mtime/ctime/大小派生，重建 + 刷新即生效 |
| R5 | 缺 `lib/client.js` 的后果 | 明确激活失败并列出包名与路径（不是静默） |
| R8 | 能否起 headless 最小宿主 | **可以**：`new Context()` + `ctx.provide(...)`，已用于 `tests/host-apply.test.mjs` |
| — | 能力探测该用哪种写法 | 只用 `ctx.get(name)`。`ctx.someService` 在未 `inject` 时会**抛错**（已由回归测试守住） |

详版含依据见 [ARCHITECTURE.md §9.1](ARCHITECTURE.md)。

### 待验证项（Phase 0 收尾）

| # | 项 | 现象如果不对 | 降级方案 |
|---|---|---|---|
| R6 | `casesDir` 热监听在 profile 下可用性 | 改了 YAML 不生效 | 手动 `/testkit reload`（已实现） |
| R7 | `dsh.client.inject` 最小集合 | Web 端白屏 / 报模块缺失 | 逐个删减实测，取最小可用集 |

### 常见故障对照表

| 症状 | 可能原因 | 处理 |
|---|---|---|
| 插件根本没出现 | `apply` 抛错 / `inject` 缺服务 | 看 `~/.dsh/logs/dsh-testkit-apply-error.log` |
| 加载器报重复 id | 手动往 profile patch 又写了一遍 insert | 删掉手写那一行 |
| 工具不出现 | `tools` 服务不可用 / 注册被作用域限制 | 启动日志里找 `已注册 N 个工具` |
| 界面没有「测试」标签 | client 半未装载 / `dsh.client` 声明有误 | 浏览器控制台；确认 `lib/client.js` 已构建 |
| 面板报「无法连接 host 半」 | 宿主无 `webServer` 能力，或路由未注册 | 启动日志找 `已注册 N 条 client 通道`；`curl` 试端点 |
| bridge 端点返回 404 | 同上（路由没注册上） | 核对 `BRIDGE_PREFIX` 两侧一致 |
| 场景列表为空 | `casesDir` 指错 / YAML 校验全失败 | `/testkit list` 看 invalid 原因 |
| 跑完污染了后续 case | driver 违反 Fixture 纪律（裸注册） | 审查该 driver 的注册是否都经 `Fixture.add` |

---

## 8. 代码约定

### 8.1 ⚠️ 绝不用 PowerShell 做文本替换写回文件（实测踩过）

**这个坑真实发生过，代价是两个文档报废**：

```powershell
# ❌ 这样写会把 UTF-8 中文全部毁掉
$orig = Get-Content README.md -Raw            # PowerShell 5.1 默认按 GBK 读！
Set-Content README.md -Value ($orig -replace 'a','b') -Encoding UTF8
```

损坏机理：`Get-Content -Raw` 用系统默认编码（本机是 GB18030）去解读 UTF-8 字节 →
得到乱码字符串 → 再按 UTF-8 写回 → **双重编码，信息不可逆丢失**
（`README.md` 一次损坏丢了 360 个字符）。

**正确做法**：

| 场景 | 用什么 |
|---|---|
| 改文件内容 | **`edit` / `write` 工具**（正确处理 UTF-8） |
| 一定要用脚本改 | `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)` + `WriteAllText` **显式指定 UTF-8** |
| 只是想看内容 | 只读，不要 `-replace` 后写回 |

**万一损坏了**：如果只是"UTF-8 读成 GB18030 再写回"，可以逆转：

```powershell
$broken = [IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)
$restored = [Text.Encoding]::UTF8.GetString([Text.Encoding]::GetEncoding('GB18030').GetBytes($broken))
```

但**遇到无效字节序列时会丢字符**（变成 U+FFFD），所以这只能救回一部分。

> **教训**：用工具做文本编辑，不要用 shell 的重定向。
> shell 重定向的编码行为依赖系统区域设置，而它对 UTF-8 中文是**静默破坏**。

### 8.2 文档守卫（`npm run verify:docs`）

`scripts/verify-docs.mjs` 检查文档与实现是否漂移：

| 检查 | 例子 |
|---|---|
| markdown 链接指向的仓库内文件存在 | 指向`已删除或改名`的文件 |
| 文档里的 `fx.<name>` 在 `src/` 里有对应的 `note('<name>')` | `fx.questionCount` |
| 文档里的 `pnpm run <script>` 在 `package.json` 里存在 | `pnpm run gate` |
| README 声称的场景数与 `cases/` 实际一致 | `16 条场景` |

已接进 `gate`。它第一次运行就抓到了真实漂移（ROADMAP 里过时的场景数）。
**代码围栏内的内容会被跳过**，所以示例里的路径不会被误判。

> 改文档时若守卫报错，**先确认是真漂移还是守卫的误报**——
> 它有两处已知豁免：`fx.notes`（容器引用）与 `pnpm run dev:web`（DSH 自身的命令）。

- **host 半**：TypeScript，`NodeNext` 模块解析，import 带 `.js` 后缀（ESM 直出约定）
- **client 半**：TypeScript + JSX（`react-jsx`），产物由 esbuild 打包
- **测试文件（`tests/*.test.mjs`）是纯 JavaScript**——写 TS 的类型标注会直接
  `SyntaxError`（已踩过一次：`const f = (): X => ...`）。`node --test` 会捕获，
  但报的是**文件级**失败，定位信息不直观，改测试时留意。
- **driver 必须写明自己的边界**：例如 `session` driver 测命令 handler 的行为、
  **不测** DSH 的分发逻辑。边界不写下来，后来者会误以为"这块测过了"。
- **注释**：中文（跟随本项目既有风格）
- **不引入重量级依赖**：YAML 用 `yaml`，校验自写（不引 zod/ajv），降低宿主侧冲突风险
- **一切注册可回滚**：见 [ARCHITECTURE.md §5.4](ARCHITECTURE.md)

---

## 9. 发布（预留，当前不启用）

`package.json` 已按可发布写好（`files` / `exports` / `dsh.bundle` / `dsh.client`）。
将来若要发布：

```powershell
& $NODE $PNPM run gate     # 先过闸门
& $NODE $PNPM publish --access public
& $DSH plugin --profile desktop add dsh-testkit   # 从 registry 装
```

当前阶段性选择：**本地路径安装**，便于快速迭代。

---

## 相关文档

- [架构设计](ARCHITECTURE.md)
- [场景数据规范](SCENARIO-SPEC.md)
- [issue 提炼流程](ISSUE-PIPELINE.md)
- [迭代计划](ROADMAP.md)
