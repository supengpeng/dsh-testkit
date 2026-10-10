<!--
PR 模板：贴在 PR 描述里，逐条勾选或写明"不适用 + 原因"。
本仓的纪律是"结论必须能复跑"——所以每一栏都要**读数**，不要只写"已测试"。
-->

## 这个 PR 做了什么

<!-- 一段话说清：现象/需求 → 改法 → 为什么这样改。 -->

## 质量门读数（必填）

```
node scripts/build-lock.mjs                     → exit ?
node --test "tests/*.test.mjs"                  → ? pass / ? fail
node --test "tests/contracts/*.test.mjs"        → ? / ?
node scripts/verify-docs.mjs                    → exit ?
pnpm run gate                                   → exit ?
```

- [ ] `pnpm run gate` **全链绿**（不是"局部绿"——`gate` 就是 CI 跑的那条）
- [ ] 新增/修改的行为配了**会因回归而红**的用例（负向证明，不只是正向断言）

## 是否动了「注册面」（对外可见的数量 / 名字）

- [ ] 不动（跳过本节）
- [ ] 动了，且已同步相关断言与文档：

| 面 | 权威来源 | 需要同步的地方 |
|---|---|---|
| 模型工具数量 / 名字 | `tests/host-apply.test.mjs`（精确列表断言） | `docs/FEATURES.md` |
| kind 数量 | `src/cases/types.ts` 的 `SCENARIO_KINDS` | `docs/FEATURES.md`、`docs/ARCHITECTURE.md` §7、`docs/SCENARIO-SPEC.md`、`DRIVER_COST` |
| 桥路由 / 命令面 | `tests/host-apply.test.mjs` | `docs/ARCHITECTURE.md` |
| 断言词 / 取证字段 | `src/runtime/assert.ts`、`src/runtime/refs.ts` | `docs/SCENARIO-SPEC.md`（`verify:docs` 会查 `fx.*` 是否存在） |

## 是否动了「形态」（这些地方坏了会**静默**失效）

- [ ] 不动（跳过本节）
- [ ] 动了 `bin` / 包名 / `exports` / `files` / client 模块 id / `dsh` 清单
  - [ ] 附上**活宿主验证**步骤与结果（见 [docs/PUBLISHING.md](docs/PUBLISHING.md) §5 的 V1–V4）
  - [ ] `npm run verify:pack` 与 `verify:git-install` 都是 exit 0
  - [ ] 说明对**已安装用户**的影响（升级方式 / 回滚方式）

## 依赖与锁

- [ ] 没有新增 / 变更依赖
- [ ] 新增 / 变更了依赖：已在 PR 里说明**为什么不能不加**、维护成本、供应链影响，
      并附 `pnpm-lock.yaml` 的对应变更（锁文件必须一起提交）

## 文档

- [ ] 受影响的文档已更新：`docs/` 下的规范 / 功能 / 开发 / 发布等
- [ ] `CHANGELOG.md` 的对应版本段加了一行（**引用**其他文档，不复制正文）
- [ ] `node scripts/verify-docs.mjs` exit 0（链接 / `fx.*` / `pnpm run <script>` / 场景计数都会查）

## 安全与隐私

- [ ] 新增的日志 / 报告 / 用例里**没有**真实凭据、私有绝对路径、用户数据
      （`pnpm run verify:secrets` 通过；`--redact` 只是兜底，不是许可）
- [ ] 若涉及权限 / 沙箱 / 闸门语义：已说明"只收紧还是也能提权"，并保持
      **工具面只能收紧**这条底线（见 [SECURITY.md](SECURITY.md)）

## 场景类改动（如果动了 `cases/`）

- [ ] 判据是**可判定**的（有断言词，不是"看起来对"）
- [ ] 高成本动作已声明 `cost`（或确认按 `DRIVER_COST` 落到期望档位）
- [ ] 是走提炼闸门落地的（`/testkit issue approve`），不是绕过闸门直接写 `cases/`
- [ ] `cases/index.yaml` **没有手工编辑**（它由守卫维护）

## 备注 / 已知限界

<!-- 明确写出"这次没做什么、为什么"，比留给 reviewer 去猜好得多。 -->
