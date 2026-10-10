# 工具链：Rust 核心的落地方式与复现记录

> 阶段 1 的物理前提。RFC 0001 决定 1 要求"Rust 承担判定、调度、能力门控、对拍"，
> 而本机**没有任何 C 工具链**（无 MSVC / MinGW / clang，也无 VS Build Tools）。
> 本文件记录最终可用的组合、证据与四条失败路径的原因链——**后者是复现知识，
> 不是抱怨**：下一个人在另一台 Windows 上会踩同样的坑。

## 1. 结论（可直接复现）

| 项 | 值 |
|---|---|
| rustup | 1.29.1，**MSVC host**（`x86_64-pc-windows-msvc`） |
| 目标 toolchain | **`stable-x86_64-pc-windows-gnu`**（rustc 1.99.0, b940084d7 2026-09-28） |
| 外部 C 工具链 | **不需要**（无 MSVC、无 MinGW、无 `-Clink-self-contained` 覆盖） |
| crates 源 | `sparse+https://rsproxy.cn/index/`（本机 `index.crates.io` 不可达） |
| 安装位置 | `C:\toolchains\{cargo,rustup}`（`CARGO_HOME` / `RUSTUP_HOME`） |

**关键洞察**：`rustup` 自身与"它管理的 toolchain"是**两件事**。
rustup 用 MSVC host（自包含、不需要外部 DLL），而它管理的目标 toolchain 选 GNU
（不需要 MSVC 链接器）。两者组合起来，在"零 C 工具链"的 Windows 上完全可用。

## 2. 证据（实跑输出）

```text
# 工具链
$ rustup show
Default host: x86_64-pc-windows-msvc
installed toolchains: stable-x86_64-pc-windows-gnu (active, default)
installed targets:    x86_64-pc-windows-gnu

# 默认链接可用（不需要任何额外配置）
$ cargo new hello && cargo build     # exit 0，Finished dev profile in 2.35s
$ ./target/debug/hello.exe           # exit 0

# 真实依赖冒烟
$ cargo build   # crate: serde = { version = "1", features = ["derive"] }, serde_json = "1"
Downloaded serde v1.0.229 / serde_json v1.0.151 (registry `rsproxy-sparse`)  → exit 0

# 签名链依赖（RFC §7）
$ cargo build   # crate: ed25519-dalek = { version = "2", features = ["rand_core"] }, sha2 = "0.10"
Compiling curve25519-dalek v4.1.3 / ed25519-dalek v2.2.0 / sha2 v0.10.9  → exit 0

# workspace 骨架（crates/ 六个 crate）
$ cargo build --workspace   # exit 0
$ cargo test  --workspace   # exit 0，12 passed / 0 failed
```

## 3. 四条失败路径（原因链，供他人省时）

| # | 尝试 | 现象 | 真因 |
|---|---|---|---|
| 1 | winget 装 `BrechtSanders.WinLibs.POSIX.UCRT`（MinGW） | winget 进程 20 分钟 CPU 0.8s，下载文件 0 字节 | 该包的下载源是 GitHub releases，本机到 GitHub 的下载停滞（这不是 winget 的问题） |
| 2 | 用 w64devkit（GitHub）作 C 工具链 | `api.github.com` 报 `API rate limit exceeded`（未认证） | 改用直链后才发现：**真正的问题是下载源可达性，不是 API 限制**——直链同样不可用 |
| 3 | `x86_64-pc-windows-gnu` host 的 `rustup-init.exe` | 进程启动即崩，退出码 **`-1073741819` = `0xC0000005`（ACCESS_VIOLATION）**，所有 step 日志 0 字节 | GNU host 的 rustup-init **动态依赖 MinGW 运行库**（`libgcc_s_seh-1.dll` / `libwinpthread-1.dll`），本机没有 |
| 4 | PowerShell 执行安装脚本 | `TerminatorExpectedAtEndOfString` / 表达式意外标记 | 两层：① native 命令写 stderr 时 `$ErrorActionPreference='Stop'` 把它当终止错误；② **脚本文件里的非 ASCII 文本被按本地代码页解码**，吞掉了单引号字符串的收尾引号 |

**第 4 条的第二层值得单列**：同一份 UTF-8 脚本，`Parser::ParseFile` 报 "syntax OK"，
而实际执行时解析失败——**编码路径不一致**。最终做法：**安装脚本全 ASCII**。

## 4. 复现命令（完整）

```powershell
# 1) 下载 MSVC host 的 rustup-init（自包含，可运行）
Invoke-WebRequest -Uri 'https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe' `
  -OutFile 'C:\toolchains\rustup-init-msvc.exe' -UseBasicParsing

# 2) 装 rustup，但不装默认 toolchain（避免它去装 MSVC 目标）
$env:CARGO_HOME='C:\toolchains\cargo'; $env:RUSTUP_HOME='C:\toolchains\rustup'
& 'C:\toolchains\rustup-init-msvc.exe' -y --no-modify-path --profile minimal --default-toolchain none

# 3) 显式装 GNU toolchain（host 与 toolchain 是两件事）
& "$env:CARGO_HOME\bin\rustup.exe" toolchain install stable-x86_64-pc-windows-gnu --profile minimal
& "$env:CARGO_HOME\bin\rustup.exe" default stable-x86_64-pc-windows-gnu

# 4) crates 镜像（本机 index.crates.io 不可达；这是**环境级**配置，不入仓）
#    $env:CARGO_HOME\config.toml:
#      [source.crates-io]
#      replace-with = "rsproxy-sparse"
#      [source.rsproxy-sparse]
#      registry = "sparse+https://rsproxy.cn/index/"
```

仓库侧的固定版本写在 [`rust-toolchain.toml`](../../rust-toolchain.toml)（REWRITE-METRICS §11 的 J5 前置之一）。

## 5. 与指标的关系

| 指标 | 本文件的作用 |
|---|---|
| J1 Rust 覆盖率 | 前置：`cargo llvm-cov` 需要可用的工具链（未验证，见下方"未做"） |
| J5 构建可复现性 | 前置 4 条中的"固定工具链版本"已由 `rust-toolchain.toml` 落地；另 3 条（`--remap-path-prefix` / `SOURCE_DATE_EPOCH` / 关增量与并行 codegen）**尚未做**，故 J5 状态仍为 `pending`，不参与 `overall` 判定（符合 REWRITE-METRICS §11 的实施前置） |
| D4b 单次签名耗时 | 前置：ed25519-dalek 可编译（已验证） |

## 6. 未做与边界（不假装完成）

- **`cargo llvm-cov` 未验证**：需要 `llvm-tools-preview` 组件与 `cargo-llvm-cov`（额外下载），
  本阶段未安装。J1 的读数因此在阶段 1 时才能给出。
- **`cargo nextest` / `loom` / `proptest` / `insta` / `criterion` 未引入**：它们都是**开发依赖**，
  会显著扩大依赖面，须先过 [`dependency-review.md`](dependency-review.md) 的门槛（RFC §7 停止线 5）。
- **镜像配置不入仓**：`rsproxy` 是环境选择，写进仓库会强制所有贡献者使用同一镜像。
  仓库只固定 toolchain 版本，不固定 registry。
- **本机未装 Node 全局环境**：`node`/`pnpm` 走 DSH 内置运行时，绝对路径见 `baseline/perf-baseline.json`
  的 `runtime_prefix`。这是阶段 0 已记录的既有事实。

---

## 7. 阶段 1 追加：MinGW binutils 与工具组件（2026-10-11）

阶段 1 引入 `ts-rs` 后暴露了一个**此前不可见的环境依赖**：

> `ts-rs` → `ts-rs-macros` → `termcolor` → `winapi-util` → **`windows-sys`**

`windows-sys` 引用 Windows API，在 `x86_64-pc-windows-gnu` 下 rustc 会调用 **`dlltool` 生成 import library**，
而 `dlltool` 需要 **`as`**（汇编器）。Rust 自带的 `self-contained/` 只有 `ld`/`dlltool`/`gcc`，**没有 `as`**；
而 MSYS2 的 `as.exe`/`dlltool.exe` 又依赖 MSYS2 运行时 DLL。

### 7.1 已落地的补法

| 项 | 来源 | 说明 |
|---|---|---|
| `as` / `ar` / `dlltool` / `ld` / `nm` / `objdump` / `ranlib` | 清华 MSYS2 镜像 `mingw-w64-x86_64-binutils-2.43.1-1` | 解压到 `C:\toolchains\msys-binutils\mingw64\bin` |
| `libwinpthread-1.dll` | **Rust 自带的 `self-contained/`** | 缺它时 `as`/`dlltool` 报 `0xC0000135`（DLL not found）——**本次最难定位的一环** |
| `clippy` 组件 | `rustup component add clippy` | 阶段 1-B 的 `clippy::disallowed_types`（禁 `HashMap`）需要它；实测 `clippy 0.1.99` |
| `llvm-tools-preview` 组件 | `rustup component add llvm-tools-preview` | 提供 `llvm-cov` / `llvm-profdata`（J1 覆盖率读数用，**不需要**另装 `cargo-llvm-cov`） |

### 7.2 复现命令

```powershell
# 1) MSYS2 binutils（清华镜像；从目录列表取 mingw-w64-x86_64-binutils-<版本>-any.pkg.tar.zst）
tar -xf mingw-w64-x86_64-binutils-2.43.1-1-any.pkg.tar.zst -C C:\toolchains\msys-binutils

# 2) 补缺失的运行时 DLL（关键一步；来源是 Rust 自带的 self-contained 目录）
Copy-Item "$env:RUSTUP_HOME\toolchains\stable-x86_64-pc-windows-gnu\lib\rustlib\x86_64-pc-windows-gnu\bin\self-contained\libwinpthread-1.dll" `
  C:\toolchains\msys-binutils\mingw64\bin\

# 3) 工具组件
rustup component add clippy --toolchain stable-x86_64-pc-windows-gnu
rustup component add llvm-tools-preview --toolchain stable-x86_64-pc-windows-gnu
```

### 7.3 每次构建必须的 PATH 前缀

```powershell
$env:CARGO_HOME='C:\toolchains\cargo'; $env:RUSTUP_HOME='C:\toolchains\rustup'
$env:PATH="C:\toolchains\msys-binutils\mingw64\bin;C:\toolchains\cargo\bin;$env:PATH"
```

**只有引用 Windows API 的 crate 才需要它**：`serde` / `serde_json` / `sha2` / `ed25519-dalek` 不需要；
`ts-rs`（经 `windows-sys`）需要 ⇒ `cargo test -p dsh-testkit-protocol` 必须带上它。
这也是阶段 2 的 CI 必须知道的事——**否则"本地能过、CI 报 dlltool not found"会重演**。

### 7.4 为什么不用"更简单"的三条路（都试过，都失败）

| 路 | 结果 |
|---|---|
| `winget install` WinLibs(MinGW) | 下载源是 GitHub，**20 分钟停滞**（CPU 0.8s、下载文件 0 字节） |
| GitHub 直链 w64devkit | 同样停滞（API 还先撞了未认证限流） |
| 只解压 MSYS2 binutils 而不补 DLL | `as`/`dlltool` 报 `0xC0000135` —— **看起来像"工具坏了"，其实是缺 DLL**；这一步花了最多时间 |

> **教训（值得写下来）**：`0xC0000135` 出现在一个"刚下载的工具"上时，第一反应应该是**查它缺哪个 DLL**，
> 而不是怀疑工具本身或 PATH。本次的真凶是一个**不在任何下载包里**的 DLL——它在 Rust 自己的
> `self-contained/` 目录里躺着。
