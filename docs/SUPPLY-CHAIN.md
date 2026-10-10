# 供应链与发布安全

本文回答一个问题：**这个仓库里"能被别人利用"的东西，各自被哪条机器判据守着。**
不写"我们很重视安全"这种句子，只写判据、位置与**做不到的事**。

> 相关文档：[PUBLISHING.md](PUBLISHING.md)（发布清单与活宿主验证）、
> [../SECURITY.md](../SECURITY.md)（漏洞报告渠道与范围）、
> [../CHANGELOG.md](../CHANGELOG.md)（迁移说明）。

## 一页总览

| 面 | 判据（离线可跑） | 在哪跑 |
| --- | --- | --- |
| 依赖锁定（package.json ↔ pnpm-lock.yaml） | `node scripts/check-lockfile.mjs`（`pnpm run verify:lock`） | `pnpm run gate` |
| CI 工作流硬化（权限 / SHA 钉 / 禁危险触发器） | `node scripts/check-ci-hardening.mjs`（`pnpm run verify:ci`） | `pnpm run gate` |
| 敏感数据不落盘 | `node scripts/check-secrets.mjs`（`pnpm run verify:secrets`） | `pnpm run gate` |
| 发布物缺件 | `node scripts/check-pack-files.mjs`（`pnpm run verify:pack`）+ release 工作流里的 `npm pack` 清单断言 | gate / 发布流 |
| 依赖漏洞公告 | `pnpm audit --prod --audit-level=high` | 只在 CI 里**独立一步**（见下） |
| 发布来源可追溯 | `npm publish --provenance` + GitHub OIDC | [../.github/workflows/release.yml](../.github/workflows/release.yml) |

## 依赖锁定与审计

**锁定**：`pnpm-lock.yaml` 入库，CI 与发布都只跑 `pnpm install --frozen-lockfile`
（lockfile 与 `package.json` 不一致时直接失败，而不是在 CI 上偷偷改写依赖树）。
"本仓不加新依赖"是硬约束，`--frozen-lockfile` 是它的机器化身。

`pnpm run verify:lock`（`scripts/check-lockfile.mjs`）在两份文件之间做**离线**比对：

- `dependencies` / `devDependencies` 的每一项都要在 lockfile 根 importer 里找得到，
  且 `specifier` 与声明范围一致；
- `peerDependencies` 必须能被 lockfile 解析到（importer 任一分组或 `packages:` 里出现）；
  **非 optional** 的 peer 还必须真的进 importer——否则"本地能跑、装出来报 missing peer"；
- `packageManager` 必须存在、必须是 pnpm、必须与 lockfileVersion 兼容，
  **并与工作流里 `pnpm/action-setup` 的 `version` 完全相同**（跨文件比对才是真价值：
  CI 用 pnpm 11 而本地声明 pnpm 9 时，lockfile 会被改写成别人看不懂的样子）；
- 若存在 `node_modules/.modules.yaml`，其中记录的 `packageManager` 也要与声明一致
  （那是"实际装出来的"事实）。

**审计**：`pnpm audit --prod --audit-level=high` 在 CI 里**单独一步**，**不进 gate**。
分工是刻意的：`pnpm run gate` 是确定性质量门，**必须能在离线机器上跑通**；
audit 要访问 registry，还会随"上游今天有没有发漏洞公告"而变。
把它塞进 gate，等于让断网或一条新 advisory 把整个仓库判红。

## 场景禁网

测试场景**默认不允许真实网络**：`allowNetwork` 默认 `false`
（见 `src/executor/policy.ts` 的沙箱策略与 `src/config.ts` 的 `sandboxAllowNetwork`）。
需要外部资源的场景走两条路之一：

- 声明式夹具（`fixtures/`）——被测对象的行为被写成数据，可审阅、可 diff；
- 场景自带假 provider（例如 `setup.resource`），网络已被替身接管。

这条不只是"省钱"：它同时把"场景里偷偷把数据发到外面"变成一个**结构上不可能**的形态。

## 敏感数据不落盘

`node scripts/check-secrets.mjs` 扫会入库或会进产物的文件（`src/`、`tests/`、
`cases/`、`fixtures/`、`registry/`、`templates/`、`docs/`、`schemas/`、
`.github/`、README/SECURITY/CHANGELOG/package.json），命中疑似凭据即非 0 退出。

两条纪律：

1. **只输出位置与类型，绝不输出命中的原文**——否则这个脚本自己就成了泄露渠道；
2. 误报用注释标记 `secrets-ok` 或补占位域（`src/report/redact.ts`），
   **不要**为了让它变绿而删检查项。

报告侧另有 `--redact`（默认关闭，见 `src/report/redact.ts`）：打开后三份产物
（`run.json` / `report.md` / `junit.xml`）渲染同一份已脱敏的 summary。

## Actions 权限最小化与 SHA 钉

工作流是仓库里**唯一能直接执行代码、并持有仓库权限与 OIDC 身份**的文件，
所以它有独立的守卫：`node scripts/check-ci-hardening.mjs`（`pnpm run verify:ci`）。

判据（全部离线可判）：

- 每份工作流必须有**显式顶层 `permissions:`**，且非发布流不得含任何 `write`；
- 发布流（文件名以 `release` 开头）只允许 `contents: read` + `id-token: write`；
- 禁 `pull_request_target`；禁 `secrets.` 引用；禁 `continue-on-error: true`；
- 每个 `uses:` 必须钉到 **40 位 commit SHA**，并带 `# <ref>` 注释说明它对应哪个版本
  （本地 composite action `./…` 与 `docker://` 例外，后者没有 commit SHA 可钉）；
- 安装命令必须带 `--frozen-lockfile`；CI 里不得出现改动依赖树的命令。

为什么必须钉 SHA：标签（`@v4`）可以被上游重新指向，钉标签等于把
"在 CI 里执行任意代码"的权限交给第三方。为什么必须写 `# <ref>`：
半年后没人能从一个裸 SHA 看出它是 v4 还是 v4.2.2。

升级某个 action 的流程：用 GitHub API 取标签指向的 commit SHA
（annotated tag 要再取一次 `git/tags/<sha>`），改工作流里的 SHA 与注释，
跑一次 `pnpm run verify:ci`。

## 发布 provenance

发布走 [../.github/workflows/release.yml](../.github/workflows/release.yml)：

1. 触发条件是 `push` 一个 `v*` 标签——**打 tag 即发布**，没有人工确认环节；
2. `pnpm install --frozen-lockfile` → `pnpm run gate`（发布物必须至少通过它自己声明的全部判据）；
3. 断言 tag 与 `package.json` 的 `version` 一致（防"打完 tag 才发现忘了改版本号"）；
4. 断言 `npm pack --dry-run` 的真实清单含 `bin/`、`lib/cli/`、`schemas/`、`cases/`、
   `fixtures/`、`registry/`、`templates/`、`dsh/`——缺件在这里红，而不是等用户装上才报错；
5. `npm publish --provenance --access public`。

**不需要任何 secret**：用 GitHub OIDC 的 trusted publishing
（工作流申请 `id-token: write`，npm 侧配置仓库 + 工作流文件名，发布时换取短期凭据）。
长期 `NPM_TOKEN` 会随仓库权限漂移、且无法自动轮换，能不用就不用。

配套细节：`actions/setup-node` **故意不写 `registry-url`**——写了它会往 `.npmrc` 注入
`_authToken=${NODE_AUTH_TOKEN}`，而我们恰恰没有这个环境变量，npm 会因"环境变量替换失败"
报错，反而逼人加回一个 secret。

发布前的**活宿主验证**清单见 [PUBLISHING.md](PUBLISHING.md)：headless 宿主是测试替身，
"headless 绿"不等于"在真实 DSH 里能用"。

## GitHub Action（本仓也是被消费方）

根目录 [../action.yml](../action.yml) 是一个 composite action：读 `run.json`，
用 `src/triage` 的 `buildPrComment` 渲染正文，写入 `$GITHUB_STEP_SUMMARY` 与 stdout；
`comment: true` 且给了 token 时才 POST 到 PR。

纪律：

- 渲染**全部**委托给 `src/triage`（长度上限、脱敏、"不贴取证原文"都在那一层），
  action 只做 I/O 编排——两处各写一遍必然漂移，而漂移的表现是"PR 里贴出了不该贴的东西"；
- `comment: true` 但没给 token，或 POST 失败：**绝不静默**，打印错误与**完整正文**，
  以非 0 退出，让人能直接手工贴到 PR；
- 本地干跑：`node scripts/action-entry.mjs --report=runs/<RUN-ID>/run.json`。

## 我们做不到的（写在明处）

- **不签二进制**：本包是纯 JS/TS，没有需要签名的可执行产物。发布完整性依赖
  npm 的 provenance attestation + registry 的 integrity（`pnpm-lock.yaml` 里逐条固定）。
- **不承诺 SBOM**：没有生成/维护 SBOM，也没有对上游传递依赖做许可证合规扫描。
  当前依赖面很小（运行时只有 `yaml`），这是"暂时可以不做"的理由，不是"不需要"。
- **Docker 隔离不适用本仓**：场景分档（`none` / `low` / `high`）靠成本闸门与沙箱策略
  （命令白名单、写路径限制、禁网），而不是容器。真要在不可信代码上跑，
  请在容器里跑 CI，而不是指望本包的沙箱是安全边界。
- **`pnpm audit` 只在 CI 跑**：离线机器上不会有漏洞信号；这是"离线可跑"的代价，
  不是遗漏。
