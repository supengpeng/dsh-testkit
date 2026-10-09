# 怎么写一条 case

> 完整字段规范见 [`../docs/SCENARIO-SPEC.md`](../docs/SCENARIO-SPEC.md)。
> 从 issue 到这里的步骤见 [`../docs/ISSUE-PIPELINE.md`](../docs/ISSUE-PIPELINE.md)。

## 现有的十六条（可直接照抄）

| ID | kind | 示范什么 |
|---|---|---|
| [TK-0001](TK-0001.yaml) | tool | driver 自检 / smoke 的最小形态 |
| [TK-0002](TK-0002.yaml) | tool | 边界值：用 `generate` 造大值 + **精确**长度断言 |
| [TK-0003](TK-0003.yaml) | tool | 拦截：拒绝理由可断言 + 「工具本体确实没跑」的对照断言 |
| [TK-0004](TK-0004.yaml) | prompt | 注入类场景：**不跑模型**，靠 `assemble()` 直接断言 |
| [TK-0005](TK-0005.yaml) | llm | 接管模型流：把「零上游请求」当成可断言的事实 |
| [TK-0006](TK-0006.yaml) | llm | 失败注入：验证「已产出内容保留 + error 收尾」两个独立要求 |
| [TK-0007](TK-0007.yaml) | interaction | 提问应答：断言到具体选中项，而不是「有答案」 |
| [TK-0008](TK-0008.yaml) | interaction | 审批决策：断言具体值，防止被宽松兜底「蒙混」 |
| [TK-0009](TK-0009.yaml) | interaction | 失败路径：无人应答必须报错，不能静默挂起 |
| [TK-0010](TK-0010.yaml) | session | 人类命令：注册 → 驱动 → 入参与输出都可断言 |
| [TK-0011](TK-0011.yaml) | session | 命令失败（返回型形态）：结果形态与文本都要断言 |
| [TK-0012](TK-0012.yaml) | resource | 假 web provider：接管 + 截断语义 |
| [TK-0013](TK-0013.yaml) | resource | 降级路径：provider 不可用必须报错，不能静默返回空 |
| [TK-0014](TK-0014.yaml) | agent | 端到端：派生真实子 agent（⚠️ 真调模型；无 subagents 能力的宿主里自动跳过） |
| [TK-0015](TK-0015.yaml) | ui | client 半产物契约：bundle 可加载、注册了标签与词典（纯离线，任何宿主都能跑） |
| [TK-0016](TK-0016.yaml) | agent | **组合场景**：假 web provider（resource）+ 真实子 agent，验证替身会穿透到子 agent |

> **组合场景**（`setup` 里写多个 kind）见 [SCENARIO-SPEC §3.9](../docs/SCENARIO-SPEC.md)。

## 三步

```powershell
# 1. 复制样板改内容（文件名必须是 TK-XXXX.yaml，且 id 与之一致）
Copy-Item TK-0001.yaml TK-0017.yaml

# 2. 同步索引
node scripts/verify-cases.mjs --write

# 3. 校验（也会跑在 gate 里）
node scripts/verify-cases.mjs
```

## 硬约定

| 约定 | 原因 |
|---|---|
| 一案一文件，文件名 = `id` | 单文件不冲突、diff 干净、便于持续追踪 |
| ID 只增不复用（`TK-%04d`） | 作废用 `status: retired`，ID 号永不复用 |
| `source.issue` 必填（可 `null`） | 每条场景都要能溯源 |
| `setup` 下的键必须是 kind | 校验器按 kind 查，写错会直接报出来 |
| 断言一行一个判定词 | 一行多词会让失败原因不可读 |
| 断言必须可机器判定 | 否则无法进回归集 |

## 状态怎么用

| status | 含义 |
|---|---|
| `active` | 默认运行集（`/testkit run` 会跑） |
| `draft` | 场景已写好但 driver 还没实现，先落盘不跑 |
| `blocked` | 当前能力测不了，等宿主或 driver 补齐 |
| `retired` | 不再运行，但保留历史与溯源 |

## 写断言的两个纪律

1. **先写「该成功的地方成功」的对照断言**，再写「问题被正确处理」的断言。
   否则你无法区分「修好了」与「根本没跑到」。
2. **边界两侧都标**：越界前 + 越界后各一条，避免「只把阈值挪了」也算通过。
