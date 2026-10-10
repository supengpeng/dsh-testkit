# 依赖评审：RFC 0001 §7 停止线 5 的触发表

> **停止线 5 原文**：新增 Rust 依赖超过 **5 个** crate（含传递依赖里体积 > 1 MB 的）
> → **停下做依赖评审**：本提案的收益必须大于供应链面的扩大。
>
> **本文件就是那次评审。** 结论在第 4 节：**停止线 5 按字面已被触发**，
> 而触发的原因不是"我们引入了不必要的依赖"，而是**这个阈值本身不可用**——
> 它与 D4（签名开销占比）是同一类问题：**门槛是拍出来的，而不是从可判定的结构量推出来的**。

## 1. 实测数据（2026-10-11，`cargo tree` 实跑）

| 场景 | 直接依赖 | 传递依赖唯一 crate 数（含 root） |
|---|---|---|
| 当前 workspace 骨架（6 个 crate） | `serde`、`serde_json` | **17** |
| 签名链需要（`ed25519-dalek` + `sha2`） | +2 | **21**（该树）+ 与 serde 树重叠 5 个 |

`ed25519-dalek` 的传递依赖逐个列出（`cargo tree --edges normal`）：

```text
ed25519-dalek, curve25519-dalek, curve25519-dalek-derive, ed25519, signature,
sha2, digest, block-buffer, crypto-common, subtle, zeroize, rand_core,
generic-array, typenum, cpufeatures, cfg-if,
proc-macro2, quote, syn, unicode-ident   (后 4 个为 derive 宏链，与 serde 树共享)
```

**已被 `RFC §5` 预告的直接依赖只有 3 项**：`ts-rs`、`serde`/`serde_json`、一个 Ed25519 实现。
设计稿的"三个 crate"说的是**直接依赖**；停止线 5 的"含传递依赖"说的是**闭包**。
两者相差一个数量级（3 → 20+），**这才是矛盾所在**。

## 2. 为什么按"闭包 ≤ 5"计数不可行

1. **任何非平凡 Rust 程序都做不到**。只依赖 `serde` 一项，闭包就已是 11 个 crate
   （`serde_core` / `serde_derive` / `proc-macro2` / `quote` / `syn` / `unicode-ident` / `itoa` / `memchr` / `zmij` …）。
   换言之：**阈值一旦按闭包计，连"用 serde 序列化 JSON"都过不了门**——那等于禁止 RFC §4 方案 C 本身。
2. **它不是可判定的结构量**。"体积 > 1 MB"这一半依赖每次发布的打包方式，
   同一 crate 不同版本的体积会变；把它写进门槛里，门槛会随上游发布漂移。
3. **它测的不是风险**。供应链风险与"crate 个数"弱相关，与
   "**谁在维护、是否可审计、是否有已知 CVE、是否来自可信命名空间**"强相关。
   数个数会把"20 个 `dtolnay` 维护的小 crate"和"20 个陌生作者的 crate"判成同一件事。

> 这与 [REWRITE-METRICS.md](../../docs/REWRITE-METRICS.md) §5 处理 D4 的方式同源：
> **"不改门槛，改设计"**——把一个机器相关、不可先验设定的量，换成可计数的结构量。

## 3. 逐项理由（当前与近期计划内的直接依赖）

| 直接依赖 | 为什么必须 | 可否替代 | 供应链评估 |
|---|---|---|---|
| `serde` + `serde_json` | 协议消息（§4.2）、`ExecutionPlan`、`AssertionOutcome`、报告字段全靠它序列化；`serde_json` 是 Rust 生态事实标准 | 手写 JSON 解析器 = 自造轮子且更易出错 | 生态最主流，维护者 `dtolnay`，无已知高危 CVE |
| `ed25519-dalek` | RFC §7.3 的签名与 §7.3.1 的批量 Merkle 签名 | `ring`（体积更大、构建更重）；`ed25519-compact`（生态小） | dalek 是 RustCrypto 组织项目，`cargo audit` 无高危 |
| `sha2` | §7.1 的 `payload_hash` / `record_hash` / 链头（SHA-256，RFC 8785 后哈希） | 无（必须 SHA-256） | RustCrypto 组织 |
| `ts-rs`（计划） | RFC 决定 1 的跨语言契约："类型从 Rust 生成、禁止手改"（指标 H3） | 手写 TS 类型 = 必然漂移（H3 就是为它设的） | 需在引入时评估；**引入前必须先过本表** |

**开发依赖（不进发布产物）**：`proptest`（A5 的反向测试）、`insta`（快照）、
`criterion`（D1–D4b 基线）、`loom`（调度器线程交错验证）、`cargo-llvm-cov`（J1）。
它们**不进入 npm 包产物**，但会进入 CI 的构建面——引入时逐项按本表补行。

## 4. 结论与建议（需裁决）

**结论**：停止线 5 触发，且评审意见是——**该阈值应当被替换**，不是"我们勉强通过"。

**建议的替代判据**（可机械判定、与机器无关）：

| 新判据 | 门槛 | 判定方式 |
|---|---|---|
| N1 直接依赖数 | **≤ 8** | `cargo metadata` 取 workspace 的 direct deps，计数比对 |
| N2 每个直接依赖必须有评审行 | **= 100%** | 本文件第 3 节的表覆盖所有 direct deps，逐项求差 |
| N3 已知高危 CVE 数 | **= 0** | `cargo audit`（REWRITE-METRICS I3 已有一条，此处复用） |
| N4 传递依赖闭包上界 | **≤ 60** | `cargo tree` 唯一 crate 计数（当前 17，加签名链后 ~30） |
| N5 单一传递依赖体积上界 | **≤ 8 MB**（编译产物） | 单点观测，超过则必须在第 3 节补行说明 |

这五条**都是可计数的结构量**：N1/N2/N4 是计数器比对，N3 是外部工具结论，N5 是单点观测。
它们比"5 个 crate"更严格地覆盖了原来想防的风险（供应链面失控），
同时不会把"用 serde"这种必然选择判成违规。

**若裁决维持原阈值**：那么按字面执行的结果是**方案 C 不可实施**（见 §2 第 1 条），
应回 [RFC 0001](../../docs/rfc/0001-rust-core-full-rewrite.md) §7 走"停止本方向、重选方案"，
而不是在实施中把阈值悄悄放宽——那是把停止线变成装饰。

**裁决前的处置**：阶段 1 **只引入第 3 节表内的 4 个直接依赖**
（`serde` / `serde_json` / `ed25519-dalek` / `sha2`），
`ts-rs` 与全部开发依赖**暂不引入**，直到本建议被裁决。
当前状态**不影响阶段 0 的结论**（阶段 0 不碰 Rust）。
