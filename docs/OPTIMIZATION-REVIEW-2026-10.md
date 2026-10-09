# 优化执行报告（对照《dsh-testkit 完整优化与生态融合方案》）

> 执行日期：2026-10-10
> 执行方式：Agent Teams（Lead + 3 名队友：`policy-gate` / `report-standard` / `release-ci`，写域互不重叠）
> 基线：[baseline/README.md](../baseline/README.md)（内置套件 **386 passed / 0 failed**；CI 轨 **26 tests：18 pass / 8 skip / 0 fail**）
> 结论读数：**`pnpm run gate` 退出码 0 · 内置套件 444 passed / 0 failed · CI 轨 26 tests：18 pass / 8 skip / 0 fail**

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
| 第 8 步 | 增量测试选择（`--changed` / `--since` / `--affected-by`） | ⏳ 推迟 | 见 §5；文档自己的停止线也写了「场景数长期 < 50 → 增量测试不需要」 |
| 第 11 步 | npm 改 scoped name | ⏳ 推迟（**升级为发布硬前提**） | [docs/PUBLISHING.md](PUBLISHING.md) §1–§5；registry 实测见 §4 |
| 第 12 步 | SECURITY.md + 隐私声明 | ✅（`--redact` 如实标"待实现"） | [SECURITY.md](../SECURITY.md) |
| 第八部分 §8.1 | 成本分级 none/low/high + 预算 | ✅ | `cost`/`budget` 字段（`src/cases/schema.ts` 校验）；`--allow-model` 才放权 |
| 第八部分 §8.2 | `report.md` + `report.json` + `junit.xml` | ✅ | `runs/<RUN-ID>/` 三件产物 |
| 第九部分 | touchstone 三阶段适配器 | ⏳ 推迟 | 见 §5（前置条件：真实用户里有人在用 touchstone） |
| 第十一部分 | 反面清单（不加第 13 个 driver 等） | ✅ 未违反 | 本次 `SCENARIO_KINDS` 仍为 12；无 DSL；无场景级 include |

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

---

## 5. 推迟项与前置条件（不是"没时间"，是"条件不具备"）

| 项 | 为什么本次不做 | 前置条件 |
|---|---|---|
| npm 改 scoped name | `scripts/build-client.mjs` 的 `PKG_ID` 必须与 `package.json.name` 一致，改名会改掉 **client bundle 的 module id**；本仓自己记录过"注册名变化会导致加载静默失败"。本会话无法在活宿主（web profile）验证 | 按 [docs/PUBLISHING.md](PUBLISHING.md) §5 的 V1–V4 在活宿主验：标签渲染 / combo URL / `__ModuleLoader__.load` 的 id / bridge |
| 独立 CLI（`bin`） | 本包刻意无 `bin`：命令行能力由 `/testkit` 与导出轨承担；先加 CLI 等于在没有真实用户的前提下加新面 | 真实有人在 CI 外需要它；且先确定只做 `run` / `list` 两个子命令 |
| 组合系统（step registry + 参数化模板） | 文档第四部分的设计（步骤级 + 参数化、禁场景级 include）成本高，且与"场景数长期 < 50"的现实不匹配；文档自己的停止线也支持推迟 | 场景数上量、或确实出现"一堆同构场景" |
| touchstone 三阶段（export/import/webhook） | 文档第十二部分写明风险：可能"用户群不重叠"，花 5 周集成没有收益 | 有真实用户在用 touchstone 且需要一个确定性回归网 |
| 增量测试选择（`--changed` 等） | 12 步优先级的第 8 位；文档停止线："场景数长期 < 50 → 增量测试、发现检索、趋势全不需要" | 场景数上量到几十条以上、全量跑开始慢 |
| `--redact` / 脱敏扫描 | 本会话没做，**文档里如实写"待实现"**，不虚报 | 有真实 report 需要对外分享的场景 |

---

## 6. 已知限界（诚实边界）

- **模型用量记账是下界**：`1 个高成本 act = 1 次调用`，token 不猜（driver 不上报就记 0）。所以 `budget.maxModelCalls` 是**保守闸门**，`maxTokens` 只在有上报时才真正强制。
- **「默认只读沙箱」是显式开关，不是默认行为**：本次只把**花钱**默认关掉（`allowModel: false`），沙箱收紧留给配置项 / 工具参数——否则既有 26 条场景里那几条写目录的 shell 场景会平白变成 skipped，噪音会淹没真失败。取舍写在 `src/executor/policy.ts` 的 `DEFAULT_POLICY` 注释里。
- **工具面只能收紧、不能提权**：`testkit_run` 的 `allowModel: true` 只在配置已允许时才有效；唯一放权入口是人类命令面 `/testkit run --allow-model`。
- **CI 轨的跳过原因变了**（数量未变，仍 8 条）：`TK-0014` / `TK-0016` 现在因**成本闸门**跳过，而不是"宿主缺少能力"。这是刻意的：把"不烧钱"从"眼下恰好没烧"升级为"结构上不可能烧"。
- `.github/workflows/ci.yml` 只验证了「YAML 可解析 + 矩阵/步骤/权限断言」，**未在真实 GitHub Actions 上跑过**（本会话没有 push）。
- client 半、改名后的 module id、bridge 的活宿主行为：本会话均不可验证。

---

## 7. 复现（一条命令一族）

```bash
# 全链（CI 用的就是它）
pnpm run gate

# 单项（调参时用，省时间）
node scripts/build-lock.mjs            # 串行化编译闸门：多人协作时避免并发 tsc 互踩
node --test "tests/*.test.mjs"         # 内置套件
node scripts/export-scenarios.mjs && node --test export/scenarios.test.mjs
node scripts/check-adapter-boundary.mjs
node scripts/check-pack-files.mjs
node scripts/check-git-installable.mjs
```

基线对照方法见 [baseline/README.md](../baseline/README.md)。
