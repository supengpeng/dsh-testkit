/**
 * 协议错误码 → 退出码的**唯一裁决处**（设计 §4.5），以及客户端错误类型。
 *
 * **真源对照**（`crates/protocol/src/error.rs`，逐项）：
 *
 * | 名称 | 数值 | 退出码 | Rust 对应 |
 * |---|---|---|---|
 * | `version_mismatch` | `-32001` | `6` | `RpcErrorCode::VersionMismatch` |
 * | `capability_unavailable` | `-32002` | `0`（skip）或 `7`（必需） | `RpcErrorCode::CapabilityUnavailable` |
 * | `task_exists` | `-32003` | `2` | `RpcErrorCode::TaskExists` |
 * | `task_not_exists` | `-32004` | `2` | `RpcErrorCode::TaskNotExists` |
 * | `execution_timeout` | `-32005` | `1` | `RpcErrorCode::ExecutionTimeout` |
 * | `approval_required` | `-32006` | `0`（skip + 理由） | `RpcErrorCode::ApprovalRequired` |
 * | 标准 JSON-RPC 5 个 | `-32700` … `-32603` | **未映射**（本客户端取 `3`） | `StandardRpcError` |
 *
 * # 两处**刻意的**设计决定（都不是顺手写的）
 *
 * 1. **`-32002` 是二义的，所以"变成 7"必须显式申请。**
 *    Rust 侧同一个裁决是 `exit_code() -> Option<i32>`（返回 `None` 表示二义）。
 *    本文件把 `capabilityMandatory` 做成**必须显式传**的选项：不传就是 `0`（skip）。
 *    理由：默认值就是最保守的那一支；反过来（不传就 7）会让"某天整批任务突然退出 7"
 *    变成一次没人改过任何一行代码的静默变更 —— 那是 CI 里最难查的一类事故。
 * 2. **标准码取 `3`（基础设施）而不是 `2`（用法）。**
 *    `spec/contracts/exit-codes.yaml` 的 `rpc_error_map` 对这 5 个码写的是
 *    `exit_code: null`，也就是**契约没有映射**它们 —— 那是"协议/传输层面出了问题"，
 *    既不是"你用错了"（`2`）也不是"被测对象挂了"（`1`）。取 `3` 让
 *    "谁的问题"在退出码上保持单一含义。
 *
 * 退出码 `4/5` **保留不用**（RFC 决定 3）：它们是同名第三方包的发布语义，
 * **同名不同义是最贵的坑**。`8` **不定义**：设计的裁决表（§4.5）只映射到 `7`，
 * 没有来源的码就是制造歧义。退出码的**唯一真源**是 `src/cli/exit.ts` ——
 * 本文件只消费它的 `EXIT`，不另立一份（第二处定义必然漂移）。
 */

import type { RpcError } from '../contracts/generated/RpcError.js';
import type { RpcErrorCode } from '../contracts/generated/RpcErrorCode.js';
import type { StandardRpcError } from '../contracts/generated/StandardRpcError.js';
import { EXIT, type ExitCode } from '../cli/exit.js';

/**
 * 自定义错误码的**名字 → 数值**表。
 *
 * 类型是 `Record<RpcErrorCode, number>`（`RpcErrorCode` 是 ts-rs 生成的联合类型）：
 * 于是"Rust 侧新增一个码、TS 侧忘了加映射"会变成**编译错误**，
 * 而不是运行期的 `undefined`。这是 H3（类型同步一致率）在 TS 侧的自证方式。
 */
export const RPC_ERROR_CODE_BY_NAME = {
  version_mismatch: -32001,
  capability_unavailable: -32002,
  task_exists: -32003,
  task_not_exists: -32004,
  execution_timeout: -32005,
  approval_required: -32006,
  // 1.0.0 新增：注册名已存在（`register_assertion` / `register_capability` 的重入）。
  // **这个键是被编译器要求加上的**：Rust 侧 `RpcErrorCode` 多一个变体，
  // 上面那个 `satisfies Record<RpcErrorCode, number>` 当场变成编译错误。
  // 也就是说这条跨语言契约的漏项**不靠人记得**，而靠类型系统兜住 —— 这是 H3 在 TS 侧的自证。
  already_registered: -32007,
} as const satisfies Record<RpcErrorCode, number>;

/** 标准 JSON-RPC 错误码的**名字 → 数值**表（同样由生成类型兜住完整性）。 */
export const STANDARD_RPC_ERROR_CODE_BY_NAME = {
  parse: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal: -32603,
} as const satisfies Record<StandardRpcError, number>;

/**
 * 数值码 → 名字的反查表（诊断信息用；未知码如实返回 `undefined`）。
 */
const RPC_ERROR_NAME_BY_CODE: Readonly<Record<number, RpcErrorCode>> = Object.fromEntries(
  Object.entries(RPC_ERROR_CODE_BY_NAME).map(([name, code]) => [code, name as RpcErrorCode]),
);

/**
 * 数值码对应的**规范名**（自定义码才有；标准码与未知码返回 `undefined`）。
 *
 * 用途：日志与报告里写 `version_mismatch` 比写 `-32001` 更容易被人读懂，
 * 而两个方向都能追溯（名字→码在上面的表里，码→名字在这里）。
 */
export function rpcErrorName(code: number): RpcErrorCode | undefined {
  return RPC_ERROR_NAME_BY_CODE[code];
}

/** [`exitCodeForRpcCode`] 的选项。 */
export interface ExitCodeOptions {
  /**
   * 该能力是否为**必需**（严格档下 `requires: mandatory`）。
   *
   * 只影响 `-32002 capability_unavailable`：`true` ⇒ `7`，否则 ⇒ `0`（skip）。
   * 其余码与它无关 —— 传了也不会改变结果（见测试里的逐码断言）。
   */
  capabilityMandatory?: boolean;
}

/**
 * 错误码 → 退出码（设计 §4.5 的裁决表，**唯一实现**）。
 *
 * 各子命令不允许自己判断"这算不算失败"：一旦有两处判断就会有两套口径。
 */
export function exitCodeForRpcCode(code: number, options: ExitCodeOptions = {}): ExitCode {
  switch (code) {
    case RPC_ERROR_CODE_BY_NAME.version_mismatch:
      return EXIT.PROTOCOL;
    case RPC_ERROR_CODE_BY_NAME.capability_unavailable:
      return options.capabilityMandatory === true ? EXIT.CAPABILITY : EXIT.OK;
    case RPC_ERROR_CODE_BY_NAME.task_exists:
    case RPC_ERROR_CODE_BY_NAME.task_not_exists:
      return EXIT.USAGE;
    case RPC_ERROR_CODE_BY_NAME.execution_timeout:
      return EXIT.FAILED;
    case RPC_ERROR_CODE_BY_NAME.approval_required:
      // 刻意不是保留号 5：本仓语义是"未获放权 → 如实 skip"（沿用 --allow-model 纪律）。
      return EXIT.OK;
    default:
      // 标准 JSON-RPC 码与未知码：契约未映射 ⇒ 协议/传输层问题 ⇒ 基础设施。
      return EXIT.INFRA;
  }
}

/**
 * 客户端错误类别。
 *
 * 它们**不是**协议错误码（没有数值码），所以不能混进 `RpcErrorCode` 那一套里。
 */
export type RpcClientFailureKind =
  /** 收到的一行不是合法 JSON（对应标准码 `-32700` 的**客户端侧**镜像）。 */
  | 'parse_error'
  /** 是合法 JSON，但不是本协议的一帧（未知 tag / 缺字段 / 应答与在途请求对不上）。 */
  | 'protocol_error'
  /** 本地前置拒绝：握手成功前调用其它方法（码与服务端一致，见下）。 */
  | 'handshake_required'
  /** 传输已关闭 / 已 `shutdown`。 */
  | 'closed'
  /** 本地等待超时（**不是**服务端的 `-32005 execution_timeout`）。 */
  | 'request_timeout'
  /** 传输层故障（进程起不来、写失败）。 */
  | 'transport_error';

/** 客户端错误。 */
export class RpcClientError extends Error {
  /** 类别。 */
  readonly kind: 'protocol' | RpcClientFailureKind;

  /** 协议数值码（`kind === 'protocol'` 或本地前置拒绝时才有）。 */
  readonly code: number | undefined;

  /** 服务端附带的取证数据（自由形状；**不得**承载凭据，指标 I1）。 */
  readonly data: unknown;

  constructor(
    kind: 'protocol' | RpcClientFailureKind,
    message: string,
    options: { code?: number; data?: unknown; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RpcClientError';
    this.kind = kind;
    this.code = options.code;
    this.data = options.data;
  }

  /** 由服务端的 `rpc_error` 帧构造（`kind === 'protocol'`）。 */
  static fromRpcError(error: RpcError): RpcClientError {
    return new RpcClientError('protocol', `服务端错误：${error.message}`, {
      code: error.code,
      data: error.data,
    });
  }

  /**
   * 本地前置拒绝：握手前的其它方法。
   *
   * **码刻意取 `-32001`**，与设计 §4.4 第 4 条（服务端对握手前帧的应答）一致 ——
   * 这样"本地拦下"与"服务端拦下"在退出码上是同一个语义（`6`），
   * CI 只依赖退出码时不会出现两个数字表达同一件事。
   */
  static handshakeRequired(message: string): RpcClientError {
    return new RpcClientError('handshake_required', message, {
      code: RPC_ERROR_CODE_BY_NAME.version_mismatch,
    });
  }

  /** 该错误的退出码（与 [`exitCodeForRpcCode`] 同一裁决，未知码归 `3`）。 */
  exitCode(options: ExitCodeOptions = {}): ExitCode {
    if (this.code === undefined) return EXIT.INFRA;
    return exitCodeForRpcCode(this.code, options);
  }
}

/**
 * 任意错误 → 退出码（给 CLI 用的一站式入口）。
 *
 * 非 [`RpcClientError`] 的异常（例如子进程 `spawn` 抛的 `Error`）一律归 `3`：
 * 它们都是"基础设施没搭起来"，不是"被测对象失败"。
 */
export function exitCodeForError(error: unknown, options: ExitCodeOptions = {}): ExitCode {
  if (error instanceof RpcClientError) return error.exitCode(options);
  return EXIT.INFRA;
}
