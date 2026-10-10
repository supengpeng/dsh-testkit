# 优化执行报告（对照《dsh-testkit 完整优化与生态融合方案》）

> 执行日期：2026-10-10（四批：Lead + 7 名队友按写域分工，共享 `scripts/build-lock.mjs` 串行化编译）
> 基线：[baseline/README.md](../baseline/README.md)（内置套件 **386 passed / 0 failed**；CI 轨 **26 tests：18 pass / 8 skip / 0 fail**）
> 结论读数：**`pnpm run gate` 退出码 0 · 10 个守卫全绿 · 内置套件 705 passed / 0 failed · 契约轨 65/65 · CLI 15 个子命令 · 场景 39 条 · CI 轨 26 tests：18 pass / 8 skip / 0 fail · GitHub Actions 三平台矩阵 6/6 全绿（run #5）**
> 并且每一批都在 **`git worktree` 出来的全新 checkout** 上复跑过（第一批的教训：`.gitignore` 曾把 `src/export/**` 一起忽略，本地绿、新克隆必挂）

---

## 1. 一句话结论

文档里「只做三件事」——**CI + 自举测试、成本闸门、报告标准化**——本次全部落地并各有守卫钉住；
顺序上也照着文档第 0→6 步走（先锁基线，再动内核）。**没有**碰文档明令禁止的项（第 13 个 driver、通用 DSL、场景级 include、和 iiwish 兼容、把真实模型调用塞进 CI）。
用 `gate` 替换"拍脑袋"做验收：所有结论都能用一条命令复跑出来。

---

## 2. 对照文档的执行清单

| 文档位置 | 要求 | 本次状态 | 证据 |
|---|---|---|---|
| 第 0 步 | 锁定基线（跑全量 cases，存报告 + 退出码） | ✅ | [baseline/README.md](../baseline/README.md)；`baseline/*.log` |
| 第 1 步 | 抽 DSH 适配层；`@deepseek-ai/dsh-*` 不出现在 driver | ✅（**升级为可执行守卫**） | `src/adapters/dsh/tools.ts`；`node scripts/check-adapter-boundary.mjs`（52 个 .ts，适配目录下 1 处命中） |
| 第 2 步 | 统一 Driver 接口 | ⚠️ 已存在（`src/kinds/types.ts` 的 `Driver`）；本次只加 `cost?()` / `DriverContext.usage?` | `src/kinds/types.ts` |
| 第 3 步 | Reporter 抽象 + 三格式 | ✅ | `src/report/present.ts`（共用原语）、`junit.ts`（新）、`json.ts`、`markdown.ts`；`schemas/run-report.schema.json` |
| 第 4 步 | 执行器加 Policy 层 | ✅ | `src/executor/policy.ts`；`runner.ts` 接线；`tests/policy-gate.test.mjs`（13 条） |
| 第 6 步 | 自举测试 + CI + 徽章 | ✅ | `.github/workflows/ci.yml`（Node 22/24 × 3 平台）；README 四徽章；`tests/self-bootstrap.test.mjs` |
| 第 7 步 | flaky 治理 + 失败分类 + 最小复现 | ✅ | `src/analysis/classify.ts`（11 条判定表）、`repro.ts`、`rounds` 记账；报告三面都呈现归因 |
| 第 8 步 | 增量测试选择（`--changed` / `--since` / `--affected-by` / `--dsh-version`） | ✅ 第二批 | `src/selection/**` + `tests/selection.test.mjs`（含"非 git / 坏 ref 退回全量"与"改 `tests/` 不影响任何场景"的反例）；加速比见 §7 |
| 第 11 步 | npm 改 scoped name | ✅ 第二批 | 包名 `@supengpeng/dsh-testkit`；client 模块 id 改为**从 `package.json` 读**（不再硬编码）；插件身份保持 `dsh-testkit`；[docs/PUBLISHING.md](PUBLISHING.md) §1–§5（**活宿主渲染仍需人工验一次**） |
| 第 12 步 | SECURITY.md + 隐私声明 + `--redact` | ✅ | [SECURITY.md](../SECURITY.md)；`src/report/redact.ts` + `scripts/check-secrets.mjs`（进 gate，只报位置不打印原文） |
| 第八部分 §8.1 | 成本分级 none/low/high + 预算 | ✅ | `cost`/`budget` 字段（`src/cases/schema.ts` 校验）；`--allow-model` 才放权 |
| 第八部分 §8.2 | `report.md` + `report.json` + `junit.xml` | ✅ | `runs/<RUN-ID>/` 三件产物 |
| 第九部分 | touchstone 三阶段适配器（export / import / webhook + `git worktree` 隔离） | ✅ 第二批 | `src/touchstone/**`；`tests/touchstone.test.mjs`（真起服务 + 真复跑 + 主仓 `git status` 前后为空）；[docs/TOUCHSTONE.md](TOUCHSTONE.md) |
| 第五部分 §5.2–5.5 | 增量选择 / fixture 治理 / 契约测试 / 并发隔离 | ✅ 第二批 | `src/selection/**`、`fixtures/**`、`src/contracts/**`、`src/isolation/**`；`verify:fixtures` 进 gate |
| 第四部分 + 第 5 步 | 组合系统（step registry + 参数化模板 + 一键展开） | ✅ 第二批（**加法式**，保留既有 YAML 形状） | `registry/steps/**`（9 片段）、`templates/**`（2 模板 → 6 draft）、`src/registry/**`、`scripts/verify-registry.mjs`；3 条 `use:` draft + 等价性证明 |
| 第七部分 §7.1 | 禁止任意网络请求 + shell 默认只读 | ✅ 第二批 | `READ_ONLY_DENY_COMMANDS` 成为默认；`sandbox.allowNetwork` 默认 false（场景自带假 provider 例外） |
| 第七部分 §7.1 | 供应链安全（依赖锁定 / 审计 / Actions 硬化 / 发布 provenance） | ✅ 第四批 | `verify:lock` + `verify:ci` 进 gate；`.github/workflows/release.yml`（OIDC，零 secret）；`docs/SUPPLY-CHAIN.md` |
| 第七部分 §7.2 | 发布与治理机制（CHANGELOG / 迁移指南 / RFC / CODEOWNERS / 贡献指南 / 行为准则 / good first issues） | ✅ 第四批 | `CODEOWNERS`、`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`.github/**` 模板、`docs/GOVERNANCE.md`（含 8 条 GFI）、`docs/rfc/**`、`docs/MIGRATION.md` |
| 第七部分 §7.3 | DSH 官方工具链集成 | ✅ 第四批 | `docs/DSH-INTEGRATION.md` + 根目录 `action.yml` + `scripts/action-entry.mjs`；doctor 入口 |
| 第七部分 §7.4 | 幂等 / 可重入 / 清理残留检测 | ✅ 第四批 | `src/isolation/probes.ts`（端口/进程异步探针，探不到标 `unknown`）+ 步骤级 cleanup + 残留检测（dispose 之前） |
| 第七部分 §7.5 | 自动 triage（issue 草稿 / PR 评论 / owner 路由） | ✅ 第四批（生成侧） | `src/triage/**`；`tests/triage.test.mjs`（含"正文不含取证原文"的负向断言）；真发请求需真实仓库与 token |
| 第六部分 §6.1 | trace / 可观测性（步骤级偏移 + 三导出） | ✅ 第三批 | `src/trace/**`；`runs/<id>/trace.json`；`tests/trace.test.mjs`（live/reconstructed 两条路径 + 三格式结构断言） |
| 第六部分 §6.5 | 结果趋势 | ✅ 第三批 | `src/insight/trend.ts`；`tests/trend.test.mjs`（坏产物跳过并计数、样本不足明说、历史逐字节不被改） |
| 第六部分 §6.4 | 场景发现与覆盖矩阵 | ✅ 第三批 | `src/insight/coverage.ts` + `src/insight/search.ts`；`tests/coverage.test.mjs`、`tests/search.test.mjs` |
| 第六部分 §6.3 | 错误消息质量（原因分级） | ✅ 第三批 | `src/analysis/causes.ts`；报告 / 工具 / 命令三处都带上"原因 + 依据 + 下一步" |
| 第六部分 §6.2 | 本地 DX（`--owner` / `--cost` / `--smoke` / `--watch`） | ✅ 第三批 | `src/dx/**`；`tests/dx-select.test.mjs` |
| 第六部分 §6.2 + §8.2 | **独立 CLI**（`bin` + 子命令 + 冻结退出码） | ✅ 第三批（**形态翻转**） | `bin/dsh-testkit.mjs` + `src/cli/**`；`tests/cli.test.mjs`；自举契约改守新形态 |
| 第十一部分 | 反面清单（不加第 13 个 driver 等） | ✅ 未违反 | `SCENARIO_KINDS` 仍为 12；无通用 DSL；无场景级 include/extends |
| （仅剩） | 供应链与治理 / 自动 triage | ⏳ 仍推迟 | 见 §5（前置都是"先完成一次真实发布"） |

---

## 3. 文档里被证伪或已过时的论断（以代码/实测为准）

1. **「12 个 driver 直接 import `@deepseek-ai/dsh-*`」不成立**：全仓只有 `src/host-facade.ts:14` 一处真 import，其余 9 处是注释。
2. **文档那条验收判据本身有缺陷**：`grep -r "@deepseek-ai/dsh-" src/drivers/ | wc -l` 会把注释全部误报（且本仓没有 `src/drivers/`）。本次把它改写成**剥离注释后只认三种依赖形式**的守卫，并把"注释不误报"写成回归用例。
3. **「report.md 是唯一输出，无机器可读格式」过时**：本仓早有 `runs/<RUN-ID>/run.json`；本次真缺的是 `junit.xml`。
4. **「无自举测试」不准确**：变更前已有 386 项测试、多个 driver 都有 fixture 测试；本次补的是**契约级**的 `tests/self-bootstrap.test.mjs`（kind↔driver 同集、llm 零上游请求、无 bin 的事实守卫）。
5. **「npm 包名可能与 iiwish 冲突」是事实**：`registry.npmjs.org/dsh-testkit` 返回 200，maintainer `iiwish`，latest **0.4.4**（2026-08-15 起 16 个版本），定位 "The real-host release gate for DeepSeek Harness plugins"，产物含 `report.json` / `junit.xml` / 两份 schema，有 CI badge 与 GitHub Action。→ 不再是"可能"，而是**同名包已被占据，发布到该名字物理上不可能**。
6. **「16 处引用」偏低**：`git grep --untracked` 实测 46 文件 / 156 处，故 PUBLISHING 交付的是分层清单（A 必改 12 条）。

---

## 4. 本次顺带抓到并修掉的真 bug（都是本地构建看不出来的那一类）

| # | 缺陷 | 为什么危险 | 修法 |
|---|---|---|---|
| 1 | `.gitignore` 第 3 行 `export/`（未锚定）连 `src/export/**` 一起忽略 | CI 轨生成器 `src/export/node-test.ts`、`write.ts` **从未入库**（`git ls-files src/export` 为空）。本地构建一切正常，**新克隆上 `pnpm run gate` 必挂**——刚加的 CI 第一跑就会红 | `.gitignore` 改为锚定的 `/export/`、`/export-all/` 并写明原因 |
| 2 | `package.json` 的 `files` 缺 `schemas` | 新增的 `schemas/run-report.schema.json` 装了会缺件（正是 TK-0019 从 dsh-memory #48 提炼的形态） | `files` 加 `schemas`；`exports` 声明该 schema（`check-pack-files` 的必需路径由入口字段推导，这样它才查得到）；新增 `verify:pack` 进 `gate` |
| 3 | `scripts/check-git-installable.mjs` 默认包根多跳一级 | 不带参数跑必然 exit 1，脚本等于半个残废 | 去掉那一跳；同时发现它报出的**真问题**：入口指向 `lib/` 但没有 `prepare`，git 安装得到的是没有入口的空壳 → 加 `prepare` 构建脚本，并把 `verify:git-install` 接进 `gate` |
| 4 | **两条时序断言在 CI 上会假红**（新检出复跑时实测命中一次） | `assert.ok(duration >= 40)` / `assert.ok(waitedMs >= 30)` 与 `setTimeout` 的名义值**相等**，而 `Date.now()` 起止各取整一次 + 定时器精度会让实测少 1–2ms（实测 39 < 40）。9 个矩阵任务里迟早撞上，表现为随机红 | 两处加 5ms 容差并写明理由（要证的是"确实等了"，不等待时是 0–2ms，差一个量级）；同时这也是"失败归因 `flaky`"这条能力存在的理由 |
| 5 | **CI 导出轨不应用夹具**（第二批把 TK-0006 切纯夹具版时暴露） | 生成物只带 `policy` 不带 `fixtures`：于是"条件来自 `fixtures:`"的场景在 CI 轨**裸跑**——插件里绿、CI 里红（或反过来），正是本仓最怕的那类分叉 | 生成物显式带 `fixtures: { fixturesDir, dshVersion }`；`tests/export-track.test.mjs` 断言这行存在，并按同一套语义批量跑真实 `cases/` |
| 6 | **headless `dispose()` 是静默 no-op**（契约测试揪出） | 它判 `typeof ctx.dispose === 'function'`，但 cordis 4 的 Context 没有 `dispose`（真入口是 `ctx.fiber.dispose()`）→ effect 注册永不回收；而既有"dispose 可重复调用"的测试**因为什么都没做才通过** | 改为真卸载 + 把"effect 确实被清理"写成契约；旧测试改成能失败的形式；配反安慰剂③（退回 no-op 必须红） |
| 7 | **`enum` / `const` 被静默丢弃**（契约测试揪出，`enum` 只保留 `string`） | 参数约束被无声放松：作者写了 `enum`/`const`，运行期却没人校验——"写了但没生效"比没写更危险 | 按 DSH 支持集合（标量 5 类）忠实传递；`const` 用 `Object.hasOwn` 判存在（否则 `false`/`null` 被真值判断丢掉）；配反安慰剂④⑤⑥ |
| 8 | **形态决定翻转后的契约必须跟着翻**（第三批加 CLI 时暴露） | `tests/self-bootstrap.test.mjs` 当时断言"本包不得有 `bin`"——留着旧断言只会逼后来者**删测试**；而 README/CHANGELOG 里同样的表述会变成错的文档 | 断言改守**新形态**（bin 存在、指向真实文件、带 shebang、且在 `files` 白名单里），并在 CHANGELOG 的旧条目上标注"已在十四翻转" |
| 9 | **一行语法错误阻塞全队验证**（第三批实际发生） | `src/cli/commands/run.ts` 两条 import 挤在同一行 → 全员 `tsc` 红、`lib/` 停在上一次成功编译的产物上，其他队友连"我的改动有没有回归"都测不出来 | 拆行修复；并把纪律写进协作约定：**每次改动后立刻 `node scripts/build-lock.mjs`，让树始终可编译**（构建锁本身已能串行化并发 tsc） |
| 10 | **测试自己泄漏临时目录**（第四批由 `doctor` 的残留探测发现） | 三处测试每用例 `mkdtempSync` 却不清理，`%TEMP%` 里累计 **1715 个**陈旧 `dsh-testkit-*` 目录（runs 1481 / report 128 / redact 106）。测试制造的环境垃圾会污染后续排查——`doctor` 的"残留"报告也跟着失真 | 三处补 `TEMP_DIRS` 登记 + 模块级 `after()` 统一删除；复跑完整套件确认**零新增**；把"环境垃圾"纳入 `doctor` 的常规体检项 |
| 11 | **文档里的能力计数会静默过期**（第四批由队友交叉发现） | `docs/FEATURES.md` 仍写"模型工具（6 个）"（实际 13）、"四个检查器"（实际 7）、README 写"8 个质量守卫"（实际 10）。能力增长时**手写计数**没人提醒 | 以真源为准重写（工具数 ← `src/tools.ts`；守卫数 ← `package.json` 的 `verify:*`）；PR 模板里加"注册面核对"一栏，注明每个数字的权威来源 |
| 12 | **假凭据字面量让全队 gate 变红**（第四批） | `tests/triage.test.mjs` 写了字面量假 token，`check-secrets` 扫到就报——守卫没错，是夹具写法错 | 改成运行时拼接（`'ghp_' + 'A'.repeat(36)`)：既不留字面量，又顺带证明"扫描器认的是形态" |
| 13 | **`act` 阶段的 `SkipCase` 被当成"这一步失败"→ 整条场景判 failed**（**首次推送后 CI 6 个矩阵任务全红才暴露**） | 7 条场景依赖下载来的外部 fixture（`$FIXTURES/dsh-memory-0.8.1`，gitignore）。`file` driver 只在 `act` 里校验 root，而 runner 只把 **setup** 阶段的 `SkipCase` 当跳过 → **本地（有 `.fixtures`）绿、全新检出（CI）全红**。这不是被测对象坏了，是"环境没准备好"被报成了失败 | ① runner 统一口径：`act` 阶段的 `SkipCase` 也判 skipped（且不把这一轮记进 `rounds`，否则 flaky 会误判），并**保留已跑过的步骤取证**；② `file` driver 的 root 校验前移到 `setup`（与 shell 的 cwd 同口径）；③ `tests/skip-semantics.test.mjs` 三条用例（两条正例 + 一条"普通异常仍判 failed"的反例），**修复前 2 红 / 修复后 3 绿**已实测 |
| 14 | **本地"全新 checkout"验证被 junction 掩盖**（同一次事故的根因） | 我此前的验证配方把 `.fixtures` junction 进全新工作树——而那正是 CI 缺失的目录。于是"全新 checkout 全绿"这个结论**只在本地成立**，CI 一推就红 | 验证配方改为**不 junction 任何被 gitignore 的目录**；并新增"移走 `.fixtures` 跑完整 gate"这条本地 CI 模拟（`baseline/gate-no-fixtures2.log`，退出码 0） |
| 15 | **`toLibSpecifier` 把 realpath 与非 realpath 混算**（macOS CI：`ERR_MODULE_NOT_FOUND`） | `relative()` 假设两边同一套命名。macOS 的 `os.tmpdir()` 是 `/var/folders/...`、真实路径是 `/private/var/folders/...`；只 realpath 一边，算出的相对路径会解析到一个**不存在的 `private/` 前缀**。同一个逻辑错误在 Windows 上表现为"跨盘符直接报错" | `toLibSpecifier` 改为「realpath 两边 → 算相对 → **往返校验**（解回去必须还是 libDir）」，解不回去退回绝对 `file://` URL；`webhook` 里靠"说明符含没含 `:`"挡跨盘符的旧检查删掉（既漏 macOS，又误伤回退）。**跨盘符从"明确报错"变成"正常工作"** |
| 16 | **`watchCases` 把被监听目录自身当成变更文件**（macOS CI） | macOS 的 FSEvents 会把目录自身的事件报上来（`filename` = 目录名）；调用方拿到它就会去"解析一个目录" | 过滤 `filename === basename(dir)` 与 `..` 开头的条目（事件数照记，只是不进 `files`）；测试断言信息写明这条真踩过 |
| 17 | **缺 `.gitattributes` 导致 Windows runner 上 shebang 变 CRLF**（同时是**真实发包缺陷**） | Git for Windows 默认 `core.autocrlf=true`，checkout 出来的 `bin/dsh-testkit.mjs` 首行是 `...node\r`——在 POSIX 上直接执行会 `bad interpreter`，npm 的 shim 也可能因此不可用。本地从没暴露，因为我们一直用 `node bin/dsh-testkit.mjs` 而不是直接执行它 | 新增 `.gitattributes`（`* text=auto eol=lf` + 二进制显式 `binary`）；测试比较前去掉 `\r`（断言不该依赖 checkout 设置） |
| 18 | **我自己写的断言把"合法形态"当成错误**（ubuntu/macOS CI 双双红） | 修 #15 时顺手加了"必须出现 `file://`"的断言。但 POSIX 上完全不同的绝对树**本来就能**表示成相对路径且解得回去——断言盯的是**形态**，不是**性质** | 改成断言不变量（解出来必须还是 libDir，相对或 `file://` 都行）：Windows 跨盘符仍只会是 `file://`，macOS 的 realpath 不一致仍会被拦下。**教训：断言要盯性质，不要盯实现形态** |

---

## 5. 推迟项与前置条件（不是"没时间"，是"条件不具备"）

| 项 | 为什么还没做 | 前置条件 |
|---|---|---|
| **实际发布 0.2.0**（`npm publish`） | 准备已就绪（provenance 工作流 + 清单断言 + 迁移指南 + 治理文件），但发布前必须在**活宿主**里确认改名后的 client 模块 id 与「测试」标签渲染——在看不到结果的情况下发布等于把静默失败发出去。版本号因此仍是 `0.1.0`（CHANGELOG 的 `0.2.0` 标"未发布"） | 按 [PUBLISHING.md](PUBLISHING.md) §5 跑完 V1–V4，再把版本号提到 `0.2.0` 并打 tag |
| **自动 triage 的"发布侧"**（真开 issue / 真贴评论） | **生成侧已完整**（issue 草稿 / PR 评论 / owner 路由 + `action.yml` 入口）；真发请求需要 `GITHUB_TOKEN` 与真实仓库的 PR 流，本机无网也无此场景 | ① 至少一个真实仓库接了本包的 CI 轨；② 定下"什么条件下自动开 issue"（否则就是刷屏） |
| **产物签名 / SBOM / CODEOWNERS 真正生效** | 签名要签**发布产物**（还没有发布产物）、CODEOWNERS 要托管方与第二位维护者、SBOM 需要额外工具链。`docs/SUPPLY-CHAIN.md` 已写明"我们做不到的" | 完成一次真实发布后再补 |

> **已消掉的推迟项（四批累计）**：npm scoped rename、step registry + 参数化模板、
> touchstone 三阶段、`--redact`、默认只读沙箱、增量测试选择、**独立 CLI**、
> **可观测性与 DX（trace / 趋势 / 覆盖矩阵 / 搜索 / 原因分级）**、
> **供应链与治理（CI 硬化 / 锁文件 / SHA 钉 / provenance / CODEOWNERS / 贡献指南 / 行为准则 /
> RFC / 迁移指南 / good first issues）**、**DSH 官方集成文档与 Action**、
> **端口/进程残留检测与 doctor**、**自动 triage 生成侧**。

---

## 6. 已知限界（诚实边界）

- **模型用量记账是下界**：`1 个高成本 act = 1 次调用`，token 不猜（driver 不上报就记 0）。所以 `budget.maxModelCalls` 是**保守闸门**，`maxTokens` 只在有上报时才真正强制。
- **沙箱默认值（第二批起）**：`shell` **默认只读**（写命令与解释器被拒，记 skipped 并给理由），真实网络**默认禁止**；但 `allowFileWrite` 仍默认 `true`——`fs` driver 的职责就是驱动宿主文件服务、观察宿主自己的沙箱语义，闸门层默认拒绝写入会把该 driver 变成哑巴。
- **工具面只能收紧、不能提权**：`testkit_run` 的 `allowModel: true` 只在配置已允许时才有效；唯一放权入口是人类命令面 `/testkit run --allow-model`。
- **`--redact` 是模式匹配级，不是数据分级**：挡得住"不小心把 token 贴进日志"，挡不住精心构造的泄露。`check-secrets` 是闸门、`--redact` 是兜底，都不是安全认证。
- **增量选择的收益是"少跑"不是"跑得快"**：API 口径改一个 kind 只命中 1–2/26 条；端到端口径被 `node --test` 启动地板（约 1.1s）压住，只有约 2×。
- **残留检测只做 tmpdir 真检测**：Node 无可靠的同步端口探测，端口/进程探针缺省**不探测**（不写假阴性），要真检测需调用方注入。
- **组合系统的参数校验是"简化 JSON Schema"级**：不递归校验嵌套 `properties`；占位符嵌入字符串时要求标量，对象/数组必须整串占位。
- **`enum` / `const` 保真带来了"更早炸"**：类型不匹配的 schema 现在会在 `defineTool` 期抛 `JsonSchemaError`（刻意取舍：宁可响亮也不要静默放宽）。恢复路径见 [CHANGELOG.md](../CHANGELOG.md) 的迁移说明。
- **活宿主仍未验证的部分**：改名后的 client 模块 id 与「测试」标签渲染（[PUBLISHING.md](PUBLISHING.md) §5 的 V1–V4）、client bridge 的活宿主行为、`.github/workflows/ci.yml` **未在真实 GitHub Actions 上跑过**（本会话没有 push）。
- **CI 轨与插件面已对齐夹具链**：生成物显式带 `fixtures: { fixturesDir, dshVersion }`，并由 `tests/export-track.test.mjs` 钉住——不加这条会出现"插件绿、CI 红"的分叉。
- **trace 的"重建"是近似，且被显式标注**：历史 `run.json` 没有 `trace` 时按步骤 `durationMs` 反推，只有累计时长、没有真实间隙与 act/assert 分界；导出的 `generatedFrom: 'reconstructed'` 就是给读者的警告。`trace.json` **只在本次运行真的记了 trace 时才写**。
- **OTLP 导出的绝对时间戳是合成的**：跨进程没有真实 trace 上下文，只有**相对偏移**有意义；头注与文档都写明了这点，别喂给需要真实时序的 APM 后做因果推断。
- **`--smoke` 的耗时是静态估算**（按 kind 量级 + 成本档附加），用于**排序与裁预算**，不是实测；要精确耗时请用 `src/selection/bench.ts` 的实测基准。
- **CLI 走 headless 宿主**：需要 `subprocess` / `fs` / `sessions` 的场景会如实 skip（输出里标注）。CLI 是**同一套引擎的入口**，不重造 runner / 选择器；退出码冻结为 `0/1/2/3`。
- **趋势在样本不足时只给"别据此下结论"**：这不是保守，而是"用 2 次运行画出的趋势线"必然误导。同理缺失数据显示"未知"而不是 0。
- **端口探针只探 `127.0.0.1`（IPv4 回环）**：只绑在别的网卡或纯 IPv6 `::1` 上的占用会返回 `busy: false`。这是刻意收窄（被测服务都在本机回环），但要更严就得同时探 `::1`。
- **进程探针内部是同步 `spawnSync`**（一次 `tasklist` 约 300ms）：对一次性体检可接受，**不要放进每步善后的热路径**。
- **`unknown:` 既不是"干净"也不是"残留"**：探针探不到（权限/超时/端口越界）时如实标 `unknown:`，`doctor` 的 `residue-found` 只统计非 `unknown:` 项，另单列一条 warn。下游若把 `leftovers.length > 0` 直接当"有残留"会误判，要按前缀分流。
- **`doctor` 的 `ok` 只看 error 级**：缺能力（会 skip）与陈旧残留都是 warn 级——否则正常机器常年报红，体检就没人看了。要当门禁请用 `findings.some(f => f.level === 'error')`。
- **CLI 与 `doctor` 都是 headless 轨**：需要 `subprocess` / `fs` / `sessions` 的场景如实 skip；`doctor` 的矩阵是按 `driver.requires` **推导**的，不是实测这一台的每一条。
- **`action.yml` 的"真贴评论"路径没有真跑过**：本机无网、无 `GITHUB_TOKEN`。已干跑验证的是"生成正文 + 无 token 时非 0 且打印正文供人工贴"。
- **治理文件里有占位**：`CODEOWNERS` 只有一位 owner（**不构成评审流程**，文件头注已写明）、行为准则与安全策略的联系邮箱是 `.invalid` 占位——对外前必须替换。
- **Action 的 SHA 钉来自 GitHub API**（3 个 action，已用 `/git/refs/tags` 与 `/commits` 两个端点交叉核对）：升级版本时要重新取，不能凭印象改。
- **外部 fixture 场景在"没下载 fixture"的机器上是 `skipped`（不是 failed）**：`$FIXTURES/<name>` 不存在时 `file`/`shell` driver 在 setup 就抛出 `SkipCase`，理由里给出 `scripts/fetch-fixtures.mjs`。`tests/scenario-run.test.mjs` 因此把"一定跳过"（缺宿主能力）与"视环境而定"（缺夹具）**分成两组**断言。
- **本地复现 CI 时必须按 CI 的文件集**：`.fixtures/`、`cases-draft/`、`runs/`、`export/`、`lib/` 都是 gitignore 的，本地存在不代表 CI 存在。最直接的模拟是 `Rename-Item .fixtures .fixtures-off` 后跑一遍完整 gate。

---

## 7. 各批实测读数（可复跑）

| 项 | 读数 |
|---|---|
| **GitHub Actions 三平台矩阵** | **run #5：6/6 全绿**（Node 22/24 × ubuntu/windows/macos-latest，唯一入口 `pnpm run gate`）。这是本仓**第一次真的在远端 CI 上跑通**——本地绿 ≠ 远端绿，前 4 次运行逐轮暴露出 #13–#18 六类问题 |
| 内置套件 | **705 passed / 0 failed**（第三批 630；第二批 538；第一批 444；基线 386） |
| 守卫 | **10 个全部退出码 0**：`verify:cases` / `docs` / `adapter` / `pack` / `git-install` / `fixtures` / `registry` / `secrets` / `lock` / `ci` |
| 契约轨 | `node --test "tests/contracts/*.test.mjs"` → **65 / 65**（含 6 条反安慰剂） |
| CLI 轨 | `node --test tests/cli.test.mjs` → **22 / 22**（真实子进程 + 冻结退出码） |
| 供应链守卫 | `check-ci-hardening` → 2 份工作流、**6** 个外部 action 全部钉 40 位 SHA；`check-lockfile` → lockfileVersion 9.0、声明依赖 **17** 项逐项比对 |
| 场景 | `cases/` **39 条**（含 3 条 `use:` draft、7 条 `fixture` 标签）；CI 轨 26 条 → 18 passed / 8 skipped / 0 failed |
| 增量加速 | API 口径：改 `src/kinds/llm.ts` → 2/26 条（**140×**）；改 `src/kinds/compaction.ts` → 1/26 条（**2864×**）；端到端口径约 **2×** |
| trace 规模 | 单条普通场景 6 个跨度（setup / act / assert×2 / cleanup / case），全部是**真实偏移** |
| 环境卫生 | 修掉三处测试临时目录泄漏后，跑完整套件 `%TEMP%` 里 `dsh-testkit-*` **零新增**（此前累计 1715 个陈旧目录，实测由 `doctor` 的残留探测发现） |

---

## 8. 复现（一条命令一族）

```bash
# 全链（CI 用的就是它）
pnpm run gate

# 单项（调参时用，省时间）
node scripts/build-lock.mjs            # 串行化编译闸门：多人协作时避免并发 tsc 互踩
node scripts/build-client.mjs          # 改名 / 改 client 半之后**必须**跑（共享产物）
node --test "tests/*.test.mjs"         # 内置套件
node --test "tests/contracts/*.test.mjs"   # 契约轨（先于场景测试）
node scripts/export-scenarios.mjs && node --test export/scenarios.test.mjs
node scripts/verify-fixtures.mjs && node scripts/verify-registry.mjs && node scripts/check-secrets.mjs
```

基线对照方法见 [baseline/README.md](../baseline/README.md)。
