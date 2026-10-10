/**
 * 协议版本与兼容判定。
 *
 * **真源**：`crates/protocol/src/handshake.rs`（Rust 侧的唯一实现）与
 * `docs/REWRITE-DESIGN.md` §4.4。本文件是它的 **TS 镜像**，规则逐字一致：
 *
 * | 规则 | 出处 |
 * |---|---|
 * | 主版本必须相同 | §4.4 第 2 条 |
 * | 服务端次版本 ≥ 客户端次版本 | §4.4 第 2 条 |
 * | 补丁版本**不参与**判定 | §4.4 第 2 条（它不改变线格式） |
 *
 * **为什么两端各写一份而不共享**：这两端本来就是**两个语言**（TS 编译器 / Rust 核心），
 * 共享不了代码。所以"一致"只能靠两侧的守卫 + 同一份真源来保证 ——
 * 本文件把常量与规则集中在一处，一旦 Rust 侧改了，这里会以**测试红**的方式暴露
 * （`tests/rpc.test.mjs` 里有取自 `handshake.rs` 的版本矩阵）。
 */

import type { Version } from '../contracts/generated/Version.js';

/** 本协议支持的主版本（与 `handshake.rs::PROTOCOL_MAJOR` 一致）。 */
export const PROTOCOL_MAJOR = 1;

/** 本协议支持的次版本（与 `handshake.rs::PROTOCOL_MINOR` 一致）。 */
export const PROTOCOL_MINOR = 0;

/** 本端补丁版本。**不参与**兼容判定，只用于诊断信息。 */
export const PROTOCOL_PATCH = 0;

/**
 * 本端（TS 客户端）版本。
 *
 * 与 `handshake.rs::local_version()` 同构：TS 侧与 Rust 侧在流程上是**对等**的两端，
 * 各自声明自己支持的版本；兼容与否由"主版本相同 + 服务端次版本 ≥ 客户端次版本"决定。
 */
export function localVersion(): Version {
  return { major: PROTOCOL_MAJOR, minor: PROTOCOL_MINOR, patch: PROTOCOL_PATCH };
}

/**
 * 版本兼容判定（设计 §4.4 第 2 条）。
 *
 * 与 `handshake.rs::is_version_compatible()` **逐字对应**：
 * `client.major === server.major && server.minor >= client.minor`。
 *
 * 注意"服务端次版本更高是兼容的"：那是协议的**向前兼容**方向 ——
 * 服务端多认识一些方法，老客户端不用它们也不会错。
 * 反过来（客户端次版本更高）必须拒绝：客户端可能用到服务端不认识的方法，
 * 放过去就会在**运行期**表现为"方法找不到"，而那会被误诊成一个实现漏洞。
 */
export function isVersionCompatible(client: Version, server: Version): boolean {
  return client.major === server.major && server.minor >= client.minor;
}

/** 人类可读的版本串（诊断信息里用，形如 `1.2.3`）。 */
export function describeVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * 不兼容时的说明文案。
 *
 * 刻意与 `handshake.rs::handle_handshake()` 的措辞同构（都点明"要求主版本相同且
 * 服务端次版本 ≥ 客户端"）：诊断信息一致，两侧的日志才能互相对齐。
 */
export function describeIncompatibility(client: Version, server: Version): string {
  return (
    `协议版本不兼容：客户端 ${describeVersion(client)}，服务端 ${describeVersion(server)}` +
    `（要求主版本相同且服务端次版本 ≥ 客户端）`
  );
}
