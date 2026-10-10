/**
 * `src/rpc` —— JSON-RPC 客户端（设计 §4.1 的**协议另一端**）。
 *
 * Rust 核心那一端的契约在 `crates/protocol`（跨语言类型由 ts-rs 导出到
 * `src/contracts/generated/`，**禁止手改**）。本目录只消费那些生成类型，不另立消息形状。
 *
 * # 模块地图
 *
 * | 模块 | 职责 |
 * |---|---|
 * | [`client`] | [`RpcClient`]：握手、九个方法、按 `id` 配对、通知队列、错误映射 |
 * | [`frames`] | NDJSON 帧编解码 + 严格校验（未知 tag 显式失败） |
 * | [`version`] | 版本兼容判定（与 `crates/protocol/src/handshake.rs` 逐字一致） |
 * | [`errors`] | 错误类别 + **错误码 → 退出码**的唯一裁决（消费 `src/cli/exit.ts`） |
 * | [`transport`] | 传输抽象 + 内存传输对（可测性的接缝） |
 * | [`stdio`] | stdio 子进程传输（真管道；一帧一次 write） |
 * | [`stub`] | 内存桩**服务端**（纯 TS，复用生成类型；`tests/` 与集成方共用） |
 * | [`stub-server`] | 把桩挂到真实 stdin/stdout 的命令行入口 |
 * | [`testing`] | 把客户端与桩接在一起的组合件 |
 *
 * # 一条必须先读的说明
 *
 * 设计 §4.2 的消息集**没有成功应答变体**（§4.3 却承诺 9 个方法有返回），
 * 那一格由 `crates/protocol` 的 `ResultParams` 补上；本目录按它的 wire 形态
 * （`{"type":"result","id":N,"result":…}`）实现。**"为什么只能这样"的证据链**写在
 * [`frames`] 的模块文档里（params 必须平铺、`id` 是唯一可加字段、成功应答必须带 `id`）。
 */

export {
  RpcClient,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type RpcClientOptions,
  type RpcClientState,
} from './client.js';

export {
  RPC_ERROR_CODE_BY_NAME,
  STANDARD_RPC_ERROR_CODE_BY_NAME,
  RpcClientError,
  exitCodeForError,
  exitCodeForRpcCode,
  rpcErrorName,
  type ExitCodeOptions,
  type RpcClientFailureKind,
} from './errors.js';

export {
  PROTOCOL_TAG_NAMES,
  REQUEST_METHODS,
  U32_MAX,
  decodeHandshakeAck,
  decodeServerFrame,
  decodeTaskHandle,
  decodeTaskResult,
  decodeTaskStatus,
  decodeVersion,
  encodeErrorFrame,
  encodeHandshakeAckFrame,
  encodeNotificationFrame,
  encodeRequest,
  encodeResultFrame,
  handshakePayload,
  type RequestMethod,
  type ServerFrame,
  type ServerNotification,
} from './frames.js';

export {
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  PROTOCOL_PATCH,
  describeIncompatibility,
  describeVersion,
  isVersionCompatible,
  localVersion,
} from './version.js';

export {
  createMemoryTransportPair,
  drainMicrotasks,
  type MemoryTransportPair,
  type RpcTransport,
} from './transport.js';

export {
  StdioSpawnError,
  createStdioTransport,
  type StdioTransportOptions,
} from './stdio.js';

export {
  StubCore,
  type StubCoreOptions,
  type StubRequestFrame,
  type StubTaskSnapshot,
} from './stub.js';

export {
  parseStubServerArgs,
  runStubServerOnStdio,
  type StubServerOptions,
} from './stub-server.js';

export { createStubPair, type StubPair, type StubPairOptions } from './testing.js';

export { EXIT, type ExitCode } from '../cli/exit.js';
