# Windows 中文与编码：诊断与处置

> 这份文档回答一个具体问题：**在 Windows 的 PowerShell / cmd 里，中文为什么乱码、怎么修。**
>
> **结论先行**：乱码**不在 Node 侧**——Node 写出的字节始终是 UTF-8。乱码发生在"**谁用哪个编码去解读它**"。

---

## 1. 实测诊断（本机，2026-10-10）

| 项 | 实测值 | 说明 |
|---|---|---|
| PowerShell 版本 | **5.1**.26100.9444 | ⚠️ **不是 PowerShell 7**。下面许多差异源于此 |
| `[Console]::OutputEncoding` | `utf-8` / CP65001 | PowerShell 侧**认为**输出是 UTF-8 |
| 控制台活动代码页（`chcp`） | **936**（GBK） | ⚠️ 与上一行**不一致**——这是乱码的总根源 |
| 仓库文件编码 | UTF-8 **无 BOM**（首字节 `23 20 64`） | 文件本身没问题 |
| Node 写 stdout（重定向到文件） | `E4 B8 AD E6 96 87 4F 4B` | 正是"中文OK"的正确 UTF-8 字节，Node 侧没问题 |

**一个决定性对照**（同一文件、同一进程，只差一个参数）：

```text
PS> Get-Content README.md                  →  > **鍖呭悕宸叉敼涓?`@supengpeng/dsh-testkit`**   ← 乱码
PS> Get-Content README.md -Encoding UTF8   →  > **包名已改为 `@supengpeng/dsh-testkit`**      ← 正常
```

---

## 2. 三个真实根因（都不是"文件坏了"）

| # | 现象 | 根因 | 谁的问题 |
|---|---|---|---|
| ① | PS 5.1 `Get-Content <UTF-8 文件>` 乱码 | PS 5.1 默认按 **ANSI(CP936)** 解码**无 BOM** 的 UTF-8 文件 | PowerShell 5.1 的默认值 |
| ② | cmd 里 `type 文件.md` 乱码 | 控制台代码页是 936，而文件是 UTF-8 | 控制台代码页 |
| ③ | 管道 / 重定向之后乱码 | 进程声明的编码（UTF-8）与控制台代码页（936）**不一致** | 环境配置 |

> 三条的共同点：**文件是 UTF-8，输出也是 UTF-8；错的是读者用了另一个编码去读。**

---

## 3. 立刻可用（按 shell 分）

### PowerShell 5.1（本机默认）

```powershell
# 读文件：永远显式指定编码
Get-Content .\docs\FEATURES.md -Encoding UTF8

# 或走 .NET（无 BOM 时按 UTF-8 解码，最省心）
[System.IO.File]::ReadAllText('.\docs\FEATURES.md')

# 对管道 / 显示都生效（会话级）
chcp 65001 > $null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
```

> `chcp 65001` 只影响**当前控制台会话**；新开的窗口会回到 936。

### PowerShell 7+

```powershell
$PSDefaultParameterValues['*:Encoding'] = 'utf8NoBOM'   # 7.x 才有 utf8NoBOM
```

### cmd

```cmd
chcp 65001
```

> 更彻底的做法是用 **Windows Terminal**——它的默认代码页就是 UTF-8。

### 让它持久（可选）

在 PowerShell profile（`notepad $PROFILE`）里加一行：

```powershell
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
```

---

## 4. 写文件（经常被忽略的反方向）

| 工具 | 默认落在盘上的编码 | 建议 |
|---|---|---|
| PS 5.1 `Out-File` | UTF-16LE（`Unicode`） | 显式 `-Encoding utf8`（⚠️ 5.1 的 `utf8` **带 BOM**） |
| PS 5.1 `Set-Content` | ANSI（CP936） | 显式 `-Encoding utf8`，或用 `[System.IO.File]::WriteAllText` |
| PS 7 `Out-File` / `Set-Content` | `utf8NoBOM` | 默认即可 |
| Node `fs.writeFileSync` | UTF-8 无 BOM | 本仓约定 |

**本仓约定：所有文本文件 UTF-8 无 BOM**，由 `pnpm run verify:encoding` 守住（§6）。

---

## 5. 与本仓的关系

- `run.json` / `report.md` / `junit.xml` 都是 UTF-8 **无 BOM**：用 PS 5.1 直接 `Get-Content` 会乱码，加 `-Encoding UTF8` 即正常。
- 本仓源码与文档**全部** UTF-8 无 BOM。
- CI（ubuntu / windows / macos）不受影响——Node 与 runner 默认 UTF-8。
- ⚠️ **本机的 harness 实际使用 PowerShell 5.1**。`pwsh` 这个名字**不等于** PowerShell 7，所以在本机跑脚本时尤其要显式指定编码。
- ⚠️ **本仓历史上真有一个 UTF-16 文件**：`baseline/exit-before.txt`（18 字节 = BOM + `EXIT=0\r\n`），来自 PowerShell `Out-File` 的默认编码。本守卫第一次运行时把它抓了出来，已转正为 UTF-8 无 BOM（内容不变，8 字节）。**这就是"静默污染"的真实样本**——它一直躺在仓库里，没有任何东西报错。

---

## 6. 本仓的机械化保障

`pnpm run verify:encoding`（对应 `scripts/check-encoding.mjs`）检查仓库内所有文本文件：

1. **无 BOM**（头 3 字节不是 `EF BB BF`）；
2. **无 UTF-16 BOM**（`FF FE` / `FE FF`）；
3. **可按严格 UTF-8 解码**（不产生 `U+FFFD` 替换字符——它通常意味着"曾被错误解码后又存了回去"）。

**负向证明**：把一个文件存成 GBK 或 UTF-8 带 BOM，该守卫必须变红。这条是守卫不是安慰剂的标准（见[治理](GOVERNANCE.md) §4 与 [RFC 模板](rfc/0000-template.md) §6）。

---

## 7. 速查表

| 我想…… | 怎么做 |
|---|---|
| 在 PS 5.1 里读中文文件 | `Get-Content X -Encoding UTF8` |
| 在 PS 里省掉记参数 | `[System.IO.File]::ReadAllText('X')` |
| 修 cmd 的显示 | `chcp 65001` |
| 一劳永逸 | Windows Terminal + profile 里设 `OutputEncoding` |
| 判断文件有没有 BOM | 看头 3 字节是否 `EF BB BF` |
| 确认字节到底对不对 | `[System.IO.File]::ReadAllBytes('X')` 看十六进制 |

---

## 相关文档

- [开发文档](DEVELOPMENT.md) —— 环境与质量门
- [场景数据规范](SCENARIO-SPEC.md) —— `cases/*.yaml` 的编码约定
