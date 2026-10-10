# 跨语言类型的生成方式与六个坑

> 阶段 1 的 `crates/protocol` → TS 类型导出。指标 **H3（类型同步一致率 100%）** 的载体。
> 本文件存在的理由：这条链上的六个坑**每一个都以"看起来完全无关"的错误形式出现**
> （TS6059 / TS2835 / TS1005 / `JSON.stringify` 抛 TypeError …），
> 不写下来，下一个人会把它们各查一遍。

## 1. 生成命令与产物位置

```powershell
# 在仓库根跑（cwd 影响 .cargo/config.toml 的发现，见坑 ⑤）
cargo test -p dsh-testkit-protocol
```

ts-rs 的导出是**测试期的副作用**（`#[ts(export)]` 会生成一个隐藏测试），所以：
- `cargo test -p dsh-testkit-protocol` 同时做两件事：跑 66 个测试 + 重新生成 35 个类型文件；
- 生成产物落在 **`src/contracts/generated/`**。

### ⚠️ 与设计 §1.3 的有意偏离

设计写的是 `types/generated/`。实际放在 **`src/contracts/generated/`**，理由是可验证的：

`tsconfig.json` 的 `rootDir` 是 `src`，`include` 是 `src/**/*.ts`。把生成类型放在 `types/` 会导致：
- 要么它们**不在编译图里**（`src/**` 引用不到 → 我写的编译器 import 不到契约类型）；
- 要么把 `types/` 加进 `include`，那 `rootDir` 就得改成仓库根，
  于是 `outDir` 结构变成 `lib/src/...` —— **`package.json` 的 `main: lib/index.js` 直接失效**。

**两层都要付代价时，选不破坏对外接口的那条。** 生成的类型仍是"禁止手改"的，
H3 的守法与目录名无关（重新生成 + `git diff --exit-code`）。

## 2. 六个坑（按被踩到的顺序）

| # | 现象 | 真因 | 处置 |
|---|---|---|---|
| ① | `tsc` 报 `TS2835`：ECMAScript import 需要显式扩展名，35 个文件全红 | ts-rs 生成的 `import ... from "./X"` 无 `.js`，而本仓 `moduleResolution: NodeNext` 要求显式扩展 | 仓库级 `.cargo/config.toml` 的 `[env] TS_RS_IMPORT_EXTENSION = "js"`（ts-rs 会自己补 `.`，所以写 `js` 不是 `.js`） |
| ② | `cargo build` 在 `windows-sys` 处报 `dlltool could not create import library` | GNU target 下引用 Windows API 的 crate 需要 `dlltool`+`as`；本机没有完整 MinGW | 见 [`toolchain.md`](toolchain.md) §7（清华 MSYS2 binutils + 补 Rust 自带的 `libwinpthread-1.dll`） |
| ③ | `error[E0277]: the trait bound Value: TS is not satisfied`（12 处） | `serde_json::Value` 默认不实现 ts-rs 的 `TS` | ts-rs 加 `serde-json-impl` feature；**但**它会让 `Value` 生成一个指向默认 bindings 目录的 `JsonValue` import（见坑 ④） |
| ④ | `tsc` 报 `TS6059`：文件不在 `rootDir` 内，`.../crates/protocol/bindings/serde_json/JsonValue.ts` | 坑 ③ 的代价：ts-rs 把 `Value` 的 import 算到了 crate 内的默认 bindings 目录 | 全部改用 `#[ts(type = "unknown")]` —— 自由形状 JSON 在 TS 侧本来就该是 `unknown`（由消费方收窄），顺带绕开 import |
| ⑤ | `.cargo/config.toml` 的 `[env]` 明明写了却不生效 | cargo 从 **cwd**（不是 `--manifest-path`）向上查找 `.cargo/config.toml`；我用 `--manifest-path` 但从别的目录调用 | CI 与本地都必须**先 `Set-Location <repo>`** 再跑 cargo。这条也解释了"为什么同一个命令在 A 目录过、B 目录不过" |
| ⑥ | `u64` 字段在 TS 侧是 `bigint`，而 `JSON.stringify(1n)` **抛 TypeError** | ts-rs 把 Rust `u64` 映射为 `bigint`（因为 JS `number` 装不下 u64） | **跨语言契约里禁用 `u64`**，全部改 `u32`（毫秒数上限约 49 天、种子 42 亿，都够用）。已落地：`ToolNode.timeout_ms` / `RetrySpec.backoff_ms` / `ScenarioMetadata.seed` / `WaitParams.timeout_ms` / `TaskResult.duration_ms` |

**坑 ⑥ 值得单独强调**：它不会在编译期炸，也不会在单测里炸——
它要等到**真的序列化一条协议消息**时才抛。一个 `u64` 字段足以让 TS 侧整条协议链在运行期失效。
这是一条应当写进「跨语言契约编写规范」的硬约束，而不是一次性修补。

## 3. H3 守卫：`scripts/check-generated-types.mjs`（已落地）

指标 H3 要求"重新生成后与仓库内容逐字节一致"。**声明挡不住手改，diff 挡得住**——所以它是一条可执行的守卫：

```powershell
# 会先跑 cargo test -p dsh-testkit-protocol（ts-rs 的 export 是测试期副作用），再比对
node scripts/check-generated-types.mjs
# 只想比对、不重生成（快速检查）
node scripts/check-generated-types.mjs --no-regen
```

需要 cargo 在 PATH，或设 `CARGO` 环境变量指向它。

### 四条路径都实测过（负向证明链）

| 场景 | 结果 | 说明 |
|---|---|---|
| A 目录整体未入库 | `WARN` + exit 0 | **如实降级**："这不是通过，也不是失败——是守卫还没上线" |
| B 已入库、未改动 | `OK：逐字节一致（H3 = 100%，已跟踪 35 个文件）` + exit 0 | |
| C 手改一个生成文件 | **`FAIL` + exit 1**，并精确报出 `diff --git a/.../Version.ts` | **守卫有牙** |
| D 撤销改动 | 恢复 exit 0 | |

### 判据选择（这里踩过一次，值得记）

第一版用 `git status --porcelain`，结果**把「刚 `git add` 未提交的新增文件」(`A`) 也算成不一致** ——
那是"还没提交"，不是"被改动"。**误报比不报更危险：它会让人开始忽略守卫。**
所以最终判据是两条精确的：

1. `git diff --exit-code -- <path>`（**工作区 vs 索引**）⇒ 生成之后是否被改过；
2. `git ls-files --others --exclude-standard -- <path>` ⇒ 是否有"Rust 侧新增了类型但没提交"。

这个缺陷是在**做负向证明时**发现的——不跑那条链，它会一直留着，并且在最需要它的时刻（有人手改后 `git add`）
给出错误的结论。这是"守卫自身也要被测"（REWRITE-METRICS §18）的一个具体收益。

### ⚠️ 还没接进任何质量门（如实标注）

它**不能**进 `pnpm run gate`：gate 是 node-only 且既有 CI 的 6 个组合**没有装 Rust 工具链**，
把 cargo 步骤塞进去会让既有 CI 变红。正确位置是 **CI 的 Rust job**（RFC §6 的验收命令
`cargo nextest run --workspace` 也在那里），或任何显式调它的地方。

**在此之前，它等于"写好了但没人跑"** —— 这条待办与"CI 增加 Rust 构建"是同一件事，属阶段 1 剩余工作。
