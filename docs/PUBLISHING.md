# 发布手册（Publishing）

> **现状（2026-10-10 更新）：包名已改为 `@supengpeng/dsh-testkit`。**
> 改名的原因不可回避：`dsh-testkit` 这个 npm 名**不属于我们**（见 §1），
> 发布到那个名字从物理上就不可能成功。
>
> 已落地的部分：`package.json` 的 `name`、client 模块 id（`scripts/build-client.mjs`
> 改为**从 package.json 读**，不再硬编码）、`cases/TK-0015` 与 `tests/ui-driver.test.mjs`
> 的期望值、README/CHANGELOG 里的安装说明。
>
> **唯一还差的一步**：在活宿主（web profile）里确认「测试」标签仍然渲染 ——
> 本机无法自动验证 GUI。验证步骤见 §5，回滚点见 §6。
> **在那之前不要执行 `npm publish`。**

---

## 1. 为什么不能发布到 `dsh-testkit`

`dsh-testkit` 这个 npm 名已被另一个项目占用，实测（2026-10-10）：

| 事实 | 值 | 来源 |
|---|---|---|
| registry 记录 | **HTTP 200**（名字已存在） | <https://registry.npmjs.org/dsh-testkit> |
| maintainer | `iiwish`（npm 包页公开的维护者账号） | 同上 |
| latest | **`0.4.4`**，2026-09-10 发布 | 同上 / <https://www.npmjs.com/package/dsh-testkit> |
| 版本数 | 16 个版本，首版 2026-08-15 | 同上 |
| 仓库 | <https://github.com/iiwish/dsh-testkit> | 同上 |
| 定位 | "The real-host release gate for DeepSeek Harness plugins." | 同上 |
| 形态 | `bin: dsh-test` CLI + Docker 跑真实宿主生命周期；产物 **`report.json` + `junit.xml` + `report.md` + `schemas/report-v1.json` + `schemas/scenario-v1.json`**；有 CI badge 与 GitHub Action；宣称**全程不调模型、不需要 API Key** | 同上 / 其 README |

两点值得写下来（不是八卦，是决策依据）：

1. **名字冲突是硬冲突，不是风格冲突。** npm 的发布权限按包名归属，同名 `publish` 会被 registry 拒绝
   （403）。任何"先发上去再说"的打算都不成立。
2. **它的目标 DSH 线与我们不同。** 它的 peerDependencies 是
   `@deepseek-ai/dsh-tools >=0.1.0-rc.6 <0.2.0`，而本仓对齐的是 **`0.2.0-rc.2`**
   （见 `package.json` 的 `dsh.engines`）。也就是说它占的是另一条版本线，
   但**包名只有一个**——冲突不会因为目标版本不同而消失。

> 顺带修正一条文档级的说法：早先的方案文档把"npm scoped rename"列为**可选优化**。
> 依据上面这张表，它已经升级为**发布前必须完成的前置条件**。

## 2. 0.2.0 发布清单

| # | 步骤 | 状态 |
|---|---|---|
| 1 | **改名**（scoped 或新名）并跑通 §4 的全量清单 | ✅ **已改名**（`@supengpeng/dsh-testkit`）且 **§5 四步已验完**（见 §5.1）——验证当场抓到 A6 的漏改（patch 的 `name` 写旧名 → client 半静默不进启动图），已修并加守卫 `verify:bundle` |
| 2 | 版本号 `0.1.0` → `0.2.0`，`CHANGELOG.md` 里去掉「未发布」 | ✅ 已做（2026-10-10，随 `v0.2.0` tag 发布） |
| 3 | 本机 `pnpm run gate` 全绿 | ✅ 每次改动都在跑（当前 **710 单测** + 契约轨 65 + CI 轨 26 条场景 + **11 个守卫**） |
| 4 | CI 组合全绿（`.github/workflows/ci.yml`） | ✅ **6/6 全绿**（Node 22/24 × ubuntu/windows/macos，实测 run #5/#6） |
| 5 | `npm run verify:pack` 退出码 0（`files` 白名单覆盖全部入口声明的路径） | ✅ 已接进 gate（`scripts/check-pack-files.mjs`） |
| 6 | `npm pack --dry-run` 人工核一遍清单（尤其 `bin/`、`lib/cli/`、`schemas/`、`cases/`、`fixtures/`、`registry/`、`templates/`、`dsh/`） | ⏳ 待做（本机运行时没有 npm；`verify:pack` 已把 `bin` 纳入必需路径推导，但 tarball 最终形态仍需人工核一眼） |
| 7 | `SECURITY.md` 里的邮箱占位换成真实可达地址 | ⏳ 待做（现在是 `security@dsh-testkit.invalid`） |
| 8 | README 的 npm badge 指向自己的包名 | ✅ 已指向 `@supengpeng/dsh-testkit`（该包尚未发布，badge 会显示 not found，属预期） |
| 9 | 从 registry 装进一个**隔离 profile** 做安装验证（`dsh plugin --profile tk add @supengpeng/dsh-testkit` → `/testkit list` 有输出） | ⏳ 待做（**发布成功后**才有意义；**发布前**已用 `link:` 形式在隔离 profile 上做完 §5 四步，覆盖 V1/V4） |
| 10 | 打 tag + GitHub Release（附 `CHANGELOG` 段落与 `junit.xml` 样例） | ⏳ 待做 |
| 11 | 带 provenance 发布（`npm publish --provenance`，由 GitHub Actions 的 OIDC 身份签发） | ✅ 工作流已就绪（`release.yml`：tag → gate → 清单断言 → `npm publish --provenance --access public`，**不需要任何 secret**）。⚠️ **npm 侧的 trusted publisher 必须先配好**（package settings → Trusted Publisher：仓库 + 工作流文件名）；首次发布若报 `ENEEDAUTH/404`，就是这个没配 |

> **改名后必须重建 client 产物**：`lib/client.js` 是共享构建产物，源码改名而产物没重建会留下
> "旧 module id"的分叉（本轮实测踩过一次，表现为 `TK-0015` / `ui-driver` 突然变红）。
> `gate` 已保证 `build-client` 先跑；手工改完包名请补一条 `node scripts/build-client.mjs`。

> 第 11 条的取舍：发布工作流要单独加、要写权限、要 trusted publisher 配置。
> 在名字还没定下来之前配它没有意义（配置里到处是包名）。

## 3. 耦合点：为什么改名不是"查找替换"

`scripts/build-client.mjs` 里写着一行断言性注释：

```js
/** 必须与 package.json 的 name 一致：DSH 的 client 模块表按它索引。 */
const PKG_ID = 'dsh-testkit'
```

它产出的 bundle 头部长这样（`lib/client.js`）：

```js
window.__ModuleLoader__.load({ id: "dsh-testkit", factory: (require) => { ... } })
```

于是形成一条**跨三个文件、两个进程**的隐式契约：

```
package.json.name  ──必须相等──▶  build-client.mjs 的 PKG_ID
                                          │ 写入 banner
                                          ▼
                       lib/client.js  __ModuleLoader__.load({ id })
                                          │ 被宿主按 id 索引
                                          ▼
              src/client/index.ts 的 name / dict.ts 的 NS / dsh.client 清单
```

**失效方式是静默的。** 本仓的文档自己记过这条教训（`docs/ROADMAP.md` Phase 6）：

> bundle 的导出面或**注册名变化会静默失败**（标签不出现、控制台空白，
> 但 host 半一切正常、日志无错）。

这类失败**不报错**——只是"标签不见了"。所以改名前必须按 §5 在活宿主里验，不能靠
"本地 gate 全绿"来推断（gate 里的 `ui` kind 用的是 `tests/ui-driver.test.mjs` 自己喂的
bundle id，它**跟着测试改就永远绿**，正是最危险的假绿）。

## 4. npm scoped rename：全量引用清单

**以实际 grep 为准**（方案文档里的"16 处"是当时一次较窄的 grep 结果，未含 `docs/`、`cases/`
与测试里的临时目录名）。复现命令（`--untracked` 是为了把未提交的新文件也算上）：

```powershell
git grep --untracked -c "dsh-testkit" -- . ':(exclude)lib' ':(exclude)export' \
  ':(exclude)runs' ':(exclude)node_modules' ':(exclude).fixtures' ':(exclude)baseline'
```

**实测（2026-10-10）：46 个文件、156 处命中**（只算已跟踪文件是 35 个文件 / 116 处）。
两个提醒：

- 这个数字**会自己长大**——本文件（`docs/PUBLISHING.md`）自身就命中 21 处。
  所以交付物是**下面这张分层清单**，不是那个计数。
- 计数里混着三类完全不同的东西：**会坏的**（A）、**只是名字不一致的**（B）、
  **纯临时目录前缀**（C）。改名时要按层处理，别一把梭。

### A 类 · 必须改（不改就加载不到 / 通不了）

| # | 位置 | 内容 | 为什么必须 |
|---|---|---|---|
| A1 | `package.json:2` | `"name": "dsh-testkit"` | npm 名 + 全仓名字的锚点 |
| A2 | `scripts/build-client.mjs:22` | `const PKG_ID = 'dsh-testkit'` | **必须与 A1 相等**，写进 bundle 的 `id` |
| A3 | `src/index.ts:26` | `export const name = 'dsh-testkit'` | host 半插件注册名 |
| A4 | `src/client/index.ts:17` | `export const name = 'dsh-testkit'` | client 半插件注册名 |
| A5 | `src/client/dict.ts:5` | `export const NS = 'dsh-testkit'` | locale 命名空间（词典按它挂载） |
| A6 | `dsh/cordis.patch.yml` | `- id: dsh-testkit`（**不变**，插件身份）/ `name:`（**必须**改成 A1 的包名） | ⚠️ **这条真的漏过一次**：文件里曾留着 `name: dsh-testkit` 且注释还写着"不用跟着改"。活宿主实测（§5）证明：`name` 是 **Node 模块说明符**，写旧名不会报错，但 **client 半静默不进启动图**（「测试」标签不出现、控制台无异常） |
| A7 | `src/http.ts:38` | `BRIDGE_PREFIX = '/api/dsh-testkit'` | host 侧路由前缀 |
| A8 | `src/client/bridge.ts:18` | `BRIDGE_PREFIX = '/api/dsh-testkit'` | client 侧**必须与 A7 逐字符一致**，否则 bridge 全 404 |
| A9 | `cases/TK-0015.yaml:26,35,40,48` | `expectLocaleNamespaces` / `fx.uiModuleId` / `fx.uiName` 期望值 | ui 场景的**判据**就是这些名字；不改则场景红 |
| A10 | `tests/ui-driver.test.mjs`（8 处：20,25,48,49,59,146,147,154） | bundle `id` / `name` / locale NS 的断言 | 同上 |
| A11 | `tests/host-apply.test.mjs:109-112` | 4 条 bridge 路由 path 断言 | 跟随 A7 |
| A12 | `tests/export.test.mjs:59,65` | `@scope/dsh-testkit/lib/` 示例 specifier | 导出物的 lib specifier 命名 |
| A13 | **已安装的 profile**（如 `~/.dsh/profiles/tkweb`） | `package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都写着包名 | 改名后必须重装：`dsh plugin --profile <p> remove <旧名>` + `add <本目录>`。只改本仓不会让旧 profile 跟着变（实测：旧 profile 里 `bundles` 仍是旧名，宿主按旧名解析） |

### B 类 · 应该改（不改不会坏，但会长期留着两个名字）

| 位置 | 内容 |
|---|---|
| `README.md:1,3,4,8,9,38,41,43,201` | 标题、badge、npm 归属警告、安装段（git 地址 / `npm install -D`）、目录树 |
| `src/report/markdown.ts:34` | 报告标题 `# dsh-testkit 运行报告`（连带 `tests/scenario-run.test.mjs:274` 的断言） |
| `src/tools.ts:54`、`src/commands.ts:75` | `testkit_list` / `/testkit` 的描述文案 |
| `src/index.ts:43,49,53` | 本机日志路径 `~/.dsh/logs/dsh-testkit-*.log`（改不改都能跑；改了等于放弃旧日志） |
| `src/index.ts:148,175,221,302,310` | `ctx.effect` 标签与日志前缀（诊断用） |
| `src/client/index.ts:2,23,41`、`src/client/dict.ts:9,25` | client 半的注释、effect 标签、词典里的展示名（`dsh-testkit 测试控制台` / `… console`） |
| `src/kinds/agent.ts:497,576`、`session.ts:101`、`tool.ts:259,300,335,385` | driver 给临时对象起的**默认名字/描述**（会出现在报告与 roster 里） |
| `docs/ARCHITECTURE.md`（15）、`docs/DEVELOPMENT.md`（14）、`docs/ROADMAP.md`（5）、`docs/SCENARIO-SPEC.md`（2）、`docs/FEATURES.md`（1）、`docs/ISSUE-PIPELINE.md`（1） | 文档正文 |
| `docs/PUBLISHING.md`（21）、`CHANGELOG.md`、`SECURITY.md`、`.github/workflows/ci.yml` | 本版新增的文档与工作流（它们也写着包名） |
| `cases/TK-0016.yaml:55`、`TK-0020.yaml:32`、`TK-0027.yaml:57`、`TK-0033.yaml:55,64` | 场景里的**字符串内容**（假搜索内容、目标文案）与断言；属于"文案随名字走" |
| `tests/session-driver.test.mjs:31`、`step-notes.test.mjs:59` | 默认描述的断言 |
| `tests/policy-gate.test.mjs`、`tests/report-standard.test.mjs`、`tests/export-track.test.mjs` | 本版新增测试里的名字引用 |

### C 类 · 不必改（名字只当"临时前缀"用）

`tests/cross-kind.test.mjs:31`、`tests/file-driver.test.mjs:79`、`tests/export.test.mjs:141,164,180`、
`tests/scenario-run.test.mjs:46`、`tests/shell-driver.test.mjs:202`：
这些是 `mkdtempSync` 的临时目录前缀，改了只是让临时目录换个名字，与包名无关。

> 建议的实际做法：**A 类手动逐条改**（每一条都对应一个"会坏"的机制），
> B/C 类用一次带 review 的批量替换。不要先全仓替换再回头找 A 类——
> 那样会把 A2 与 A1 的"必须相等"这条约束淹没在噪音里。

## 5. 改名前必须在活宿主（web profile）做的验证

**前提**：需要一个带 GUI 的 web profile（`headless` 没有 `webServer`，验不了 client 半）。
不要动日常使用的 `desktop` profile。

```powershell
$DSH = 'D:\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
& $DSH tkweb --from-default-profile web            # 建隔离 profile（一次）
& $DSH plugin --profile tkweb add <本仓绝对路径>     # 装（可逆）
& $DSH plugin --profile tkweb list                  # 确认插件在册
```

按顺序验这四件（**缺一件就不许改名**）：

| # | 验什么 | 怎么验 | 通过的样子 |
|---|---|---|---|
| V1 | **标签是否渲染** | 打开该 profile 的页面，看会话视图环 | 「测试」标签出现在「对话 / 轨迹」旁 |
| V2 | **bundle 是否被组合进启动图** | DevTools → Network 过滤旧名/新名，看 `index.html` | **combo URL 里出现 `<新名>/client.js`**（旧名消失） |
| V3 | **`__ModuleLoader__.load` 的 id 是否匹配** | 直接取 bundle（带 token）搜 `__ModuleLoader__.load` | `id: "<新名>"`，且与 V2 的 combo 名一致 |
| V4 | **bridge 是否通** | `Invoke-RestMethod -Uri http://127.0.0.1:<port>/api/dsh-testkit/list -Method POST -Body '{}'` | 200 + 场景列表；页面控制台也真的渲染出表格 |

> V4 的路径是**固定常量** `/api/dsh-testkit`（`src/http.ts` 的 `BRIDGE_PREFIX`，client 侧同一常量），
> **不随包名变**——写成 `/api/@supengpeng/dsh-testkit/list` 会 401（scope 里的 `/` 会被当成路径分隔）。

### 5.1 实测结果（2026-10-10，隔离 profile `tkweb`）

```powershell
& $DSH plugin --profile tkweb remove dsh-testkit            # 旧名条目先摘掉
& $DSH plugin --profile tkweb add <本仓绝对路径>            # 按新名重装（link:）
& $DSH --profile tkweb --port 19403 --no-open               # 独立端口，不动 desktop(19387)
```

| # | 结论 | 证据 |
|---|---|---|
| V1 | ✅ **可得的最强证据**（真 bundle 跑进真实 slot 系统） | `TK-0015`（`ui` driver）在隔离 vm 里加载**产物** `lib/client.js`（11916 B）：`uiLoadCalls=1`、`uiModuleId=@supengpeng/dsh-testkit`、`uiHasApply=true`、`uiInjectedSlots=[conversation.view]`、`uiRegisteredSlotNames=[conversation.view]`、`uiRendererProvided=true`、`uiLocaleNamespaces=[dsh-testkit]` → **verdict passed**。⚠️ **真实浏览器里的视觉渲染仍需人眼确认**（见下方"没做到的那一步"） |
| V2 | ✅ | 首页（`/?token=…`）里出现 `plugins/??…,@supengpeng/dsh-testkit/client.js&amp;rev=f4aeacfac0d0`，且**全页搜不到**裸名 `dsh-testkit/client.js` |
| V3 | ✅ | 取该 combo（401547 B）→ `__ModuleLoader__.load({ id: "@supengpeng/dsh-testkit" })`，与 V2 的 combo 名**逐字符一致**；bundle 内含 `conversation.view` 与 `dsh-testkit` 词典命名空间 |
| V4 | ✅ | `POST /api/dsh-testkit/list` → **200**（6463 B 场景列表）；再 `POST /api/dsh-testkit/run {"ids":["TK-0001"]}` → **200**、`total=1 passed=1`、`runId=2026-10-10T02-07-24_9nj1`、报告落盘 |

**这一步真的抓到了东西**：修复前，首页里**完全没有** `dsh-testkit` 的 client 模块——
`dsh/cordis.patch.yml` 的 `name` 还写着旧名（`dsh-testkit`），宿主半照常加载
（bridge 一直通），但 client 半**静默地不进启动图**。
改成 `name: "@supengpeng/dsh-testkit"` 后，V2/V3 立刻通过。
这条已固化成 `scripts/check-bundle-patch.mjs`（gate 内的 `verify:bundle`，
带 5 条回归测试，含"旧名 / 空 insert / 重复 id"三条负向）。

**没做到的那一步（如实声明）**：V1 的"打开页面看「测试」标签出现"需要一个**开着 GUI 的浏览器**。
本会话能拿到的是"产物被真实宿主加载 + slot/词典真的注册了 + combo 与模块 id 一致"，
**看不到像素**。所以最后一步请你在浏览器里确认一次：
打开 `http://127.0.0.1:<port>/?token=<启动日志里的 token>`，会话视图环里应出现「测试」标签。

> V2 与 V3 是**两条独立的证据**：combo URL 对了只能说明静态清单改了，
> bundle 内的 `id` 才是宿主模块表查表用的键——两者不一致时，页面**不报错**，只是没反应。

**回滚**：任何一步不过，就改回 `package.json` 的 `name`（以及 A2 的 `PKG_ID`）、
重建 client 半（`pnpm run build:client`）、刷新页面；不要留在"改了一半"的状态。

**为什么这一步不能在本会话做**：改名必须在一台**跑着 GUI web profile** 的机器上，
按上表逐步核对，且要能刷新页面看渲染结果。本会话改的只是文件与静态守卫，
没有任何手段能观察到"标签渲染 / 模块表查表"这两件事——
**在看不到结果的情况下改名，等于把"静默失败"直接发出去。**

## 6. 发布当天的顺序（改名确认之后）

1. A 类逐条改 → `pnpm run gate` 全绿 → §5 四步全过
2. `CHANGELOG.md` 去掉「未发布」；`package.json` 版本改 `0.2.0`
3. `npm run verify:pack` + `npm pack --dry-run`：确认 `lib/`、`cases/`、`dsh/`、`docs/`、
   `schemas/`、`src/` 都在清单里（**`schemas/` 曾经漏过**——它由 `exports` 里那条
   `./schemas/run-report.schema.json` 推导出来，所以那条 exports 不能删）
4. push → 等 CI 9 个组合全绿
5. `npm publish --provenance` → 打 tag → GitHub Release
6. 在一个**全新**的隔离 profile 里从 registry 装一次并跑 `/testkit list`
   （第 9 条清单项：这一步是唯一能证明"发出去的东西真的能用"的动作）

---

## 相关文档

- [变更日志](../CHANGELOG.md) —— 0.2.0 改了什么、明确推迟了什么
- [安全策略](../SECURITY.md) —— 漏洞报告渠道、数据隐私与保留策略
- [迭代计划](ROADMAP.md) —— Phase 11 的验收与推迟项的**前置条件**
- [开发文档](DEVELOPMENT.md) —— 构建、装进 profile、真实验证流程
