# 基线（优化前）

> 对应《dsh-testkit 完整优化与生态融合方案》**第 0 步：锁定基线**。
> 记录时间：2026-10-10（本次优化开始前，工作树干净：`git status` 无输出）。

## 环境

| 项 | 值 |
|---|---|
| Node | v24.21.0 |
| pnpm | 11.7.0 |
| DSH（报告里记的版本） | `unknown`（插件解析不到宿主版本，见 `src/index.ts` 的说明） |
| 平台 | win32 |
| 场景 | `cases/` 可用 36 条；导出轨选中 26 条（排除 7 条 `fixture` 标签，1 条非 active） |

## 结果

| 轨 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 内置测试套件 | `node --test tests/*.test.mjs` | **386 passed / 0 failed / 0 skipped**（12.98s） | 0 |
| 场景导出 | `node scripts/export-scenarios.mjs` | 已导出 26 条（可用 36，跳过 7 条 fixture） | 0 |
| 场景执行（CI 轨） | `node --test export/scenarios.test.mjs` | **26 tests：18 passed / 8 skipped / 0 failed**（0.97s） | 0 |

8 条 skipped 全部是「宿主缺少能力」的**如实降级**（`fs` / `sessions` / `compaction`），
不是失败：`TK-0030` `TK-0031` `TK-0032` `TK-0034` 等。

## 原始日志（本地产物）

`baseline/*.log` 是完整输出，但被 `.gitignore` 的 `*.log` 规则排除，不入库。
数字与结论已抄进本文件，作为可比较的基线。

## 优化后的比较方法

```bash
node scripts/build-lock.mjs                 # 编译（串行化，见 scripts/build-lock.mjs）
node --test tests/*.test.mjs                # 内置套件：必须 >= 386 passed、0 failed
node scripts/export-scenarios.mjs
node --test export/scenarios.test.mjs       # CI 轨：必须 0 failed
```

**判定规则**：`passed` 数只增不减；`failed` 必须为 0；skipped 的变化必须能逐条说出原因
（新增的成本闸门跳过属于**预期变化**，但必须在报告里显式列出，不能"静默变少"）。
