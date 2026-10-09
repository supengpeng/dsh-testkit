# pipeline/ —— 提炼闸门的落地目录

这个目录回答两个问题：**这一轮要不要提炼**、**提案有没有被批准落地**。

| 路径 | 是什么 |
|---|---|
| `ledger.json` | 批次台账（唯一真源）：谁在何时开了哪一批、每条提案的裁决、落地成的 `TK-` 号 |
| `proposals/<BATCH-ID>/<P-xxxx-slug>.yaml` | 提案正文：**合法 case YAML**，`id` 是占位 `TK-0000` |

## 纪律

1. **提案不是场景**：`cases/` 只有人批准（`/testkit issue approve`）才会新增文件。
2. **一次一批**：同一时间只允许一个 open 批次；上一批没结案就开不了下一批。
3. **质量前置**：质量预检不过的提案**不会落盘**——所以这里看不到半成品。
4. **留痕**：被拒绝的提案保留在本目录，只在台账里标记 `rejected`。

## 怎么用

```powershell
/testkit issue open dsh-memory 发包面 2 条      # 人开启本轮
# 模型：testkit_propose（只写本目录，永远不碰 cases/）
/testkit issue show P-0001                     # 人看正文与预检明细
/testkit issue approve --all                   # 人批准 → 写 cases/ + 重建索引
```

完整流程见 [`../docs/ISSUE-PIPELINE.md`](../docs/ISSUE-PIPELINE.md) §0「提炼闸门」。
