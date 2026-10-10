# `spec/vectors/` —— 防篡改报告的测试向量

> **一句话边界（必须随向量一起被读到）**
> 哈希链是 **tamper-evident（可发现篡改）**，不是 **tamper-proof（防篡改）**：
> 持有私钥的人可以重写整条链并用同一个私钥重新签名，同时改掉报告与锚定目录——
> 那时所有签名都自洽，本机制**检不出**（[REWRITE-DESIGN.md §7.5](../../docs/REWRITE-DESIGN.md)）。
> 本机制保证的是"**篡改可被验证者发现**"，不保证"篡改不可能发生"。
> **任何把它表述为"防篡改"的说法都是过度承诺。**

真源：`docs/REWRITE-DESIGN.md` §7（全节）、`docs/REWRITE-METRICS.md` §5（D4a）/ §6（E1–E5）/ §10（I1）、
RFC 0001 §8 Q2 / Q4 / Q10。

```text
spec/vectors/
  jcs/*.json        JCS（RFC 8785）向量：输入 + 期望规范化字节（hex）
  attest/corpus.json 篡改语料：基准链 + 注入操作 + **预先写下的**期望结论
```

## 1. `jcs/*.json`：为什么必须"两侧都过"

设计 §7.2 的原话是：**只靠一侧实现，另一侧的"独立验证"就不是独立的——那等于用同一个实现自证。**
所以向量是两侧的**共同契约**：

| 侧 | 跑法 | 现状 |
|---|---|---|
| Rust | `cargo test -p dsh-testkit-attest --test jcs_vectors` | 65 / 65 通过 |
| TS | `node --test src/attest/jcs-vectors.test.mjs` | 65 / 65 通过 |
| 跨实现随机对拍 | Rust 落盘 → TS 重算比对（见 §3） | 200 / 200 逐字节一致 |

### 向量文件格式

```json
{
  "domain": "jcs",
  "covers": ["number"],
  "note": "数字规范化：ECMAScript Number::toString（RFC 8785 §3.2.2.3）",
  "source": "src/attest/tools/make-jcs-vectors.mjs（oracle = …）",
  "cases": [
    {
      "id": "number-01",
      "covers": "number",
      "note": "1.0 规范化成 1（整数不带小数点）",
      "input_json": "1.0",
      "expected_hex": "31",
      "expected_text": "1"
    }
  ]
}
```

- `input_json` 是**JSON 文本**（不是已解析的值）：这样才能把 `1.0` / `\u00e9` 这类**字面形态**
  真的喂进两侧的解析器，而不是让宿主语言先把差异抹平。
- `expected_hex` 是规范化结果的 **UTF-8 字节**的 hex：字节级契约，不留"文本看起来一样"的余地。
- `covers` 取值只允许六个：`key_order` / `number` / `unicode` / `escape` / `nested` / `empty`。

### 期望值是怎么来的（可复核）

`src/attest/tools/make-jcs-vectors.mjs` 用一套**独立于本仓 JCS 实现**的 oracle 生成：

- 数字：`String(x)`——RFC 8785 §3.2.2.3 把数字形态**直接定义**为 ECMAScript `Number::toString`，
  所以在 JS 里这就是规范本身，不是取巧；
- 字符串：`JSON.stringify`（ES2019 起只逃逸强制集）；
- 键序：`Object.keys(...).sort()`（JS 字符串默认比较就是 UTF-16 码元序）；
- 结构：递归拼接，不加空白。

也就是说：**oracle 是宿主语言 JSON 语义的直接产物**，两侧实现是各自写的。三方（oracle / Rust / TS）
在 65 条向量上必须一致；不一致就是真问题，不许改期望迁就实现。

重新生成：`node src/attest/tools/make-jcs-vectors.mjs`

## 2. `attest/corpus.json`：篡改语料

由 `cargo run -p dsh-testkit-attest --example generate_corpus` 生成，
`crates/attest/tests/corpus_freshness.rs` 每次 `cargo test` 都重算并与提交内容**逐字节比对**
（与指标 H3 的 `git diff` 同一套纪律：**声明挡不住手改，diff 挡得住**）。

```json
{
  "version": 1,
  "note": "……边界声明……",
  "key": { "derivation": "seed = SHA-256(utf8(label))", "label": "…", "public_key": "…" },
  "batch_size": 4096,
  "bases": [ { "id": "base_batch", "mode": "batch", "chain": { … } } ],
  "cases": [
    {
      "id": "field-03-verdict-failed-to-passed",
      "class": "field",
      "base": "base_batch",
      "note": "**最常见的篡改形态**：把失败改成通过",
      "context": { "expected_chain_head": null, "anchor_head": null },
      "ops": [ { "op": "set_payload_field", "seq": 3, "path": ["verdict"], "value": "passed" } ],
      "expected": { "chainOk": false, "firstBadSeq": 3, "verifiedRecords": 2, "errors": ["payload_hash_mismatch"] }
    }
  ],
  "boundary_cases": [ … 期望 `chainOk: true`——即"检不出"的诚实证据 … ]
}
```

### 三条约定

1. **期望结论先于检出实现写下**：每个 `expected` 都从设计 §7.3 的机制表推出，
   生成器在写文件前会先跑一遍验证器并**核对**；不一致就直接失败，不允许"把期望改成实测"。
2. **`context` 的取值规则**（两侧一致）：
   - 缺省 / `null` = **原始运行**的链头（`run.json` 与锚定目录都还是干净那一次的值）；
   - `"self"` = 用**被改后**的链自己的链头，模拟"报告与锚定一起被改写"——这正是
     `boundary_cases` 表达"检不出"的方式。
3. **注入器两侧各有一份**：Rust 在 `crates/attest/tests/support/mod.rs` 的 `Op`，
   TS 在 `src/attest/tamper.mjs`，逐字对应。如果 TS 侧只是复读 Rust 的结果，
   那"两侧结论一致"就没有意义。

### 注入操作（`ops[]`）

| `op` | 语义 |
|---|---|
| `set_payload_field` | 改/加载荷字段（**不动** `payload_hash` / `record_hash`） |
| `delete_record` / `swap_records` / `duplicate_record` | 删 / 重排 / 复制插入 |
| `flip_payload_hash` / `flip_record_hash` / `bump_ts` | 改哈希字段或逻辑刻度 |
| `flip_sig` / `flip_batch_sig` / `flip_head_sig` | 改三种签名 |
| `flip_proof` / `drop_proof` / `remove_leaf` | 改 Merkle 证据 / 漏签 |
| `stale_head_chain_head` | 单独改链文件里的链头摘要 |
| `noncanonical_payload` | 把载荷写成**语义相同、形态不同**的字节（缩进），配合下面的重算重签使用 |
| `recompute_chain_hashes` / `recompute_head` / `recompute_batches` / `recompute_head_signature` | **精修型攻击**：把链重算/重签成自洽 |
| `append_record` | 追加一条"prev_hash 与自身哈希都算对"的记录 |

`recompute_*` 这批操作存在的意义：它们让"**有私钥的人能做到什么**"变成可执行的用例。
`cases` 里它们被用来构造"报告没跟着改 → 检出"；`boundary_cases` 里则把三份见证也一起改，
于是**检不出**——两条都要在，否则边界就是嘴上说说。

### 载荷的"前提校验"（`payload_not_canonical`）

设计 §7.2 把"同样的语义 ⇒ 同样的字节"当作签名的**前提**。既然是前提，验证器就检验它：
把 `payload_jcs` 解析回 JSON 值再规范化一次，逐字节比对，不一致即 `payload_not_canonical`。
`extra-06-noncanonical-payload` 就是这条的专用用例——载荷被写成缩进形态、整条链被重算重签成
**完全自洽**（哈希、批量签名、链头签名全都对得上），此时**只有**这条前提校验能抓住它。
这也是两侧都必须实现 JCS 的第二个理由：验证器不能假设"生产端一定遵守了规范化约定"。

### 测试密钥（**仓库里没有任何私钥材料**）

`seed = SHA-256(utf8("dsh-testkit/attest/test-vector-key/v1"))`。
标签是公开的，任何人都能重算出同一把密钥，所以它**不是秘密**，只是测试向量；
好处是链文件、语料、仓库里都不出现私钥字节（I1 的"不落盘"从源头成立），而两侧仍能独立算出同一把密钥。

## 3. 跨实现随机对拍（设计 §7.2 的 proptest 一格）

本仓不能引入 `proptest`（开发依赖要过 RFC §7 停止线 5），所以用**确定性 LCG**在两侧生成同一批随机 JSON：

```text
state₀ = (0x9e3779b9 + (i × 2654435761 mod 2³²)) mod 2³²          i = 文档序号
next() : state = (state × 1103515245 + 12345) mod 2³²            （u32 回绕）
roll   = next() mod 12
  roll ≤ 2  → 数字 token（NUM_TOKENS，含 "1.0" / "1e2" / "-0" / "9007199254740993"）
  roll ≤ 5  → 字符串 token（STR_TOKENS，含 "\u00e9" / "😀" / "\u0000" / "\u007f" / "\u2028"）
  roll = 6  → true / false / null
  roll = 7  → {} / []
  roll ≤ 10 → 数组：count = next() mod 4，逐元素递归
  roll = 11 → 对象：count = next() mod 4，base = next() mod 11，键取 KEY_TOKENS[(base+k) mod 11]
深度 ≥ 3 时退化为标量。两侧 token 表逐字相同（Rust `NUM_TOKENS` / TS `NUM_TOKENS`）。
```

Rust 侧把 `<输入文本>\t<规范化字节 hex>` 写进 `target/attest/jcs-random.txt`
（`cargo test -p dsh-testkit-attest --test jcs_cross`），TS 侧
（`node --test src/attest/jcs-cross.test.mjs`）重算输入与字节并逐行比对。
文件不存在时 TS 侧**显式 skip**（可见地跳过，不是静默通过）。

## 4. 跑一遍（两侧）

```powershell
$env:CARGO_HOME='C:\toolchains\cargo'; $env:RUSTUP_HOME='C:\toolchains\rustup'
$env:PATH="C:\toolchains\cargo\bin;$env:PATH"
$repo='C:\Users\19059\Documents\deepseek-harness\default-workspace\dsh-testkit'

# Rust 侧（会顺带生成 target/attest/ 下的两份对拍产物）
& cargo test -p dsh-testkit-attest --manifest-path "$repo\Cargo.toml"

# TS 侧（零依赖验证器）
$node='C:\Users\19059\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node --test src/attest/*.test.mjs
```

**顺序有依赖（必须说清）**：TS 侧的两条测试（`jcs-cross` / `cross-check`）读的是 Rust 侧生成的
`target/attest/jcs-random.txt` 与 `target/attest/rust-verdicts.json`。
先跑 Rust、再跑 TS，两边都是全绿；只跑 TS 时那两条会**显式 skip** 并说明要先跑什么。

## 5. 复现语料与向量

```powershell
# 重新生成 JCS 向量（oracle 在工具里，会写 spec/vectors/jcs/）
& $node src/attest/tools/make-jcs-vectors.mjs

# 重新生成篡改语料（生成前会先核对"预先写下的期望"）
& cargo run -p dsh-testkit-attest --example generate_corpus
```

改了生成器却不重新生成，`corpus_freshness` 会红——这是刻意的。
