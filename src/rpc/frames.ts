/**
 * NDJSON 帧编解码（设计 §4.1 的传输层，以及 §4.2 的**应答闭合**）。
 *
 * # 这个文件为什么存在（它补的是契约缺口，不是"顺手封装"）
 *
 * §4.1 说传输是"`stdio` + JSON-RPC 2.0，NDJSON 帧"，§4.2 给出的消息集是
 * `ProtocolMessage`（14 个 `type` tag）—— 但那一集里 **没有任何"成功应答"变体**：
 * S→C 只有 `handshake_ack` / `progress` / `capability_changed` / `trace` / `rpc_error`。
 * 而 §4.3 的方法表承诺 `submit → TaskHandle`、`wait → TaskResult`、`query → TaskStatus`。
 * 也就是说服务端**今天物理上无法**回出这三样（`frame.rs::write_frame` 只接受 `ProtocolMessage`）。
 *
 * 本文件是那个缺口的**最小闭合**，形状如下（每个字段都能追溯到真源）：
 *
 * ```text
 * C→S 请求   {"type":"<method>", "id":N, ...params}
 * S→C 成功   {"type":"result",   "id":N, "result":<payload>|null}
 * S→C 失败   {"type":"rpc_error","code":..,"message":..,"data"?:.., "id"?:N}
 * S→C 通知   {"type":"progress"|"capability_changed"|"trace", ...}
 * 握手应答   {"type":"handshake_ack", ...}
 * ```
 *
 * # 三条**可验证**的约束（决定了上面这个形状，而不是别的形状）
 *
 * 1. **params 必须平铺在顶层，不能嵌在 `params:` 键下。**
 *    现有 Rust 读取器走 `read_frame` → `serde_json::from_value::<ProtocolMessage>`；
 *    把 `task_id` 藏进 `params` 会让 `SubmitParams` 解析失败
 *    （`crates/protocol/src/message.rs` 里 `SubmitParams.task_id` 是必需字段）。
 * 2. **请求里带 `id` 不会破坏现有 Rust 读取器。**
 *    我 grep 过整个 `crates/protocol`：**没有一处 `deny_unknown_fields`**，
 *    serde 的默认行为是忽略未知字段 ⇒ 多一个 `id` 仍然解析成 `SubmitParams`。
 *    （这也是"`id` 只能**加**在既有帧上、不能改既有字段"这条纪律的由来。）
 * 3. **成功应答必须带 `id`。** 因为 §4.6 允许"先 submit N 个再一起等"，
 *    并发在途请求需要**按 id 配对**；缺 id 的 `result` 帧一律判协议错误，
 *    绝不"猜一个最像的请求"。
 *
 * 纪律（与设计 §3.1、`frame.rs` 一致）：**未知 tag 显式失败**，不静默降级成空消息；
 * 空行跳过（它是帧之间的自然噪声）；单帧就是单行。
 */

import type { CapabilityChangedNotification } from '../contracts/generated/CapabilityChangedNotification.js';
import type { HandshakeAck } from '../contracts/generated/HandshakeAck.js';
import type { ProgressNotification } from '../contracts/generated/ProgressNotification.js';
import type { ProtocolHandshake } from '../contracts/generated/ProtocolHandshake.js';
import type { ProtocolMessage } from '../contracts/generated/ProtocolMessage.js';
import type { ResultParams } from '../contracts/generated/ResultParams.js';
import type { RpcError } from '../contracts/generated/RpcError.js';
import type { TaskHandle } from '../contracts/generated/TaskHandle.js';
import type { TaskOutcome } from '../contracts/generated/TaskOutcome.js';
import type { TaskResult } from '../contracts/generated/TaskResult.js';
import type { TaskState } from '../contracts/generated/TaskState.js';
import type { TaskStatus } from '../contracts/generated/TaskStatus.js';
import type { TraceNotification } from '../contracts/generated/TraceNotification.js';
import type { Version } from '../contracts/generated/Version.js';
import { RpcClientError } from './errors.js';

/** 客户端能发的方法（设计 §4.3 方法表的 C→S 九行）。 */
export type RequestMethod =
  | 'handshake'
  | 'submit'
  | 'wait'
  | 'cancel'
  | 'query'
  | 'register_assertion'
  | 'register_capability'
  | 'refresh_capabilities'
  | 'shutdown';

/** 全部方法名（运行期可枚举；守卫会拿它与 `methods.rs` 的九行比对）。 */
export const REQUEST_METHODS: readonly RequestMethod[] = [
  'handshake',
  'submit',
  'wait',
  'cancel',
  'query',
  'register_assertion',
  'register_capability',
  'refresh_capabilities',
  'shutdown',
];

/**
 * **全部**协议 tag 的运行期集合（设计 §4.2 的 15 个）。
 *
 * 类型是 `Record<ProtocolMessage['type'], true>`：**Rust 侧新增一个 tag 而这里没跟上 =
 * 编译错误**。这就是"未知 tag 显式失败"这条纪律在 TS 侧的自证 ——
 * 也是它比"写个数组然后指望有人记得改"强的地方。
 */
const PROTOCOL_TAGS = {
  handshake: true,
  handshake_ack: true,
  submit: true,
  cancel: true,
  wait: true,
  query: true,
  register_assertion: true,
  register_capability: true,
  refresh_capabilities: true,
  shutdown: true,
  progress: true,
  capability_changed: true,
  trace: true,
  result: true,
  rpc_error: true,
} as const satisfies Record<ProtocolMessage['type'], true>;

/** 全部 tag 的名字（`未知 tag` 的诊断信息里用；顺序与枚举一致）。 */
export const PROTOCOL_TAG_NAMES: readonly string[] = Object.keys(PROTOCOL_TAGS);

/** 服务端→客户端的**通知**（设计 §4.2 的三条 S→C 非应答消息）。 */
export type ServerNotification =
  | { readonly type: 'progress'; readonly payload: ProgressNotification }
  | { readonly type: 'capability_changed'; readonly payload: CapabilityChangedNotification }
  | { readonly type: 'trace'; readonly payload: TraceNotification };

/** 解码后的服务端帧。 */
export type ServerFrame =
  | { readonly kind: 'handshake_ack'; readonly ack: HandshakeAck }
  /** 成功应答：载荷类型直接绑定生成类型 [`ResultParams`]（`id` + `result`）。 */
  | { readonly kind: 'result'; readonly params: ResultParams }
  | { readonly kind: 'error'; readonly id: number | undefined; readonly error: RpcError }
  | { readonly kind: 'notification'; readonly notification: ServerNotification };

// ---------------------------------------------------------------- 校验工具

function protocolError(message: string): RpcClientError {
  return new RpcClientError('protocol_error', message);
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError(`${context}：必须是 JSON 对象，实际是 ${describeType(value)}`);
  }
  return value as Record<string, unknown>;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function requireNumber(record: Record<string, unknown>, key: string, context: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw protocolError(`${context}：字段 \`${key}\` 必须是有限数值，实际是 ${describeType(value)}`);
  }
  return value;
}

/**
 * `u32` 上限。
 *
 * **跨语言契约里所有毫秒 / id / 版本字段都是 `u32`**（RFC 决定：`u64` 会被 ts-rs 生成
 * `bigint`，而 `JSON.stringify(1n)` 会**抛异常** —— 一个 u64 字段就能让整条 TS 侧序列化
 * 在**运行期**炸，编译期与单测都发现不了）。所以这里把这条钉在解码层：
 * 对端一旦给出浮点、负数或超界整数，必须**响亮失败**，而不是让一个坏数悄悄进判定。
 */
export const U32_MAX = 4_294_967_295;

/** 必须是非负整数且 ≤ [`U32_MAX`]。 */
function requireU32(
  record: Record<string, unknown>,
  key: string,
  context: string,
  minimum = 0,
): number {
  const value = requireNumber(record, key, context);
  if (!Number.isInteger(value) || value < minimum || value > U32_MAX) {
    throw protocolError(
      `${context}：字段 \`${key}\` 必须是 [${minimum}, ${U32_MAX}] 内的整数（跨语言契约是 u32），实际 ${String(value)}`,
    );
  }
  return value;
}

/** 必须是整数（允许负值；错误码是负数）。 */
function requireInteger(record: Record<string, unknown>, key: string, context: string): number {
  const value = requireNumber(record, key, context);
  if (!Number.isInteger(value)) {
    throw protocolError(`${context}：字段 \`${key}\` 必须是整数，实际 ${String(value)}`);
  }
  return value;
}

function requireString(record: Record<string, unknown>, key: string, context: string): string {
  const value = record[key];
  if (typeof value !== 'string') {
    throw protocolError(`${context}：字段 \`${key}\` 必须是字符串，实际是 ${describeType(value)}`);
  }
  return value;
}

function requireArray(record: Record<string, unknown>, key: string, context: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) {
    throw protocolError(`${context}：字段 \`${key}\` 必须是数组，实际是 ${describeType(value)}`);
  }
  return value;
}

/** 可缺省的**正整数**（应答 id；缺省表示"今天的写入器还带不了 id"）。 */
function optionalId(
  record: Record<string, unknown>,
  key: string,
  context: string,
): number | undefined {
  if (!(key in record)) return undefined;
  return requireU32(record, key, context, 1);
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string[] {
  return requireArray(record, key, context).map((item, index) => {
    if (typeof item !== 'string') {
      throw protocolError(`${context}：字段 \`${key}[${index}]\` 必须是字符串`);
    }
    return item;
  });
}

// ---------------------------------------------------------------- 生成联合的运行期集合

/**
 * `TaskOutcome` 的六个取值的运行期集合。
 *
 * 类型是 `Record<TaskOutcome, true>`：**Rust 侧新增一个取值而这里没跟上 = 编译错误**
 * （这就是 H3 在 TS 侧的自证方式，比"写个数组然后指望有人记得改"强）。
 */
const TASK_OUTCOME_SET = {
  passed: true,
  failed: true,
  skipped: true,
  errored: true,
  inconclusive: true,
  cancelled: true,
} as const satisfies Record<TaskOutcome, true>;

/** `TaskState` 的四个取值的运行期集合（含 `cancelled`：取消是**结论**，不是错误）。 */
const TASK_STATE_SET = {
  pending: true,
  running: true,
  finished: true,
  cancelled: true,
} as const satisfies Record<TaskState, true>;

function requireTaskOutcome(record: Record<string, unknown>, key: string, context: string): TaskOutcome {
  const value = record[key];
  if (typeof value !== 'string' || !(value in TASK_OUTCOME_SET)) {
    throw protocolError(
      `${context}：字段 \`${key}\` 不是合法的 TaskOutcome（实际 ${JSON.stringify(value)}）`,
    );
  }
  return value as TaskOutcome;
}

function requireTaskState(record: Record<string, unknown>, key: string, context: string): TaskState {
  const value = record[key];
  if (typeof value !== 'string' || !(value in TASK_STATE_SET)) {
    throw protocolError(
      `${context}：字段 \`${key}\` 不是合法的 TaskState（实际 ${JSON.stringify(value)}）`,
    );
  }
  return value as TaskState;
}

// ---------------------------------------------------------------- 应答载荷解码

/** 解码 `Version`（缺字段即协议错误；不校验多余字段，向前兼容）。 */
export function decodeVersion(value: unknown, context = 'Version'): Version {
  const record = asObject(value, context);
  return {
    major: requireU32(record, 'major', context),
    minor: requireU32(record, 'minor', context),
    patch: requireU32(record, 'patch', context),
  };
}

/** 解码 `HandshakeAck`。 */
export function decodeHandshakeAck(value: unknown): HandshakeAck {
  const context = 'handshake_ack';
  const record = asObject(value, context);
  return {
    server_version: decodeVersion(record['server_version'], `${context}.server_version`),
    supported_major: requireU32(record, 'supported_major', context),
    supported_minor: requireU32(record, 'supported_minor', context),
    // Rust 侧 `#[serde(default)]`：缺省即空数组，不是错误。
    known_capabilities:
      'known_capabilities' in record ? requireStringArray(record, 'known_capabilities', context) : [],
  };
}

/** 解码 `TaskHandle`（`submit` 的返回，设计 §4.3）。 */
export function decodeTaskHandle(value: unknown): TaskHandle {
  const context = 'submit 的返回（TaskHandle）';
  const record = asObject(value, context);
  return {
    task_id: requireString(record, 'task_id', context),
    state: requireTaskState(record, 'state', context),
  };
}

/** 解码 `TaskResult`（`wait` 的返回，设计 §4.3）。 */
export function decodeTaskResult(value: unknown): TaskResult {
  const context = 'wait 的返回（TaskResult）';
  const record = asObject(value, context);
  const result: TaskResult = {
    task_id: requireString(record, 'task_id', context),
    outcome: requireTaskOutcome(record, 'outcome', context),
    duration_ms: requireU32(record, 'duration_ms', context),
  };
  if ('detail' in record) result.detail = record['detail'];
  return result;
}

/** 解码 `TaskStatus`（`query` 的返回，设计 §4.3）。 */
export function decodeTaskStatus(value: unknown): TaskStatus {
  const context = 'query 的返回（TaskStatus）';
  const record = asObject(value, context);
  const status: TaskStatus = {
    task_id: requireString(record, 'task_id', context),
    state: requireTaskState(record, 'state', context),
  };
  if ('phase' in record) {
    const phase = record['phase'];
    if (typeof phase !== 'string') throw protocolError(`${context}：字段 \`phase\` 必须是字符串`);
    status.phase = phase;
  }
  return status;
}

// ---------------------------------------------------------------- 解码

function decodeNotification(
  type: string,
  record: Record<string, unknown>,
): ServerNotification | undefined {
  switch (type) {
    case 'progress': {
      const context = 'progress 通知';
      const payload: ProgressNotification = {
        task_id: requireString(record, 'task_id', context),
        phase: requireString(record, 'phase', context),
        message: requireString(record, 'message', context),
      };
      return { type: 'progress', payload };
    }
    case 'capability_changed': {
      const context = 'capability_changed 通知';
      const payload: CapabilityChangedNotification = {
        capability: requireString(record, 'capability', context),
        state: requireString(record, 'state', context),
      };
      return { type: 'capability_changed', payload };
    }
    case 'trace': {
      const context = 'trace 通知';
      if (!('trace' in record)) throw protocolError(`${context}：缺字段 \`trace\``);
      const payload: TraceNotification = {
        task_id: requireString(record, 'task_id', context),
        trace: record['trace'],
      };
      return { type: 'trace', payload };
    }
    default:
      return undefined;
  }
}

/**
 * 解码一行服务端帧。
 *
 * 失败一律抛 [`RpcClientError`]，且**带得上可辨认的类别**：
 * - 不是 JSON ⇒ `parse_error`
 * - 是 JSON 但不是本协议的一帧（未知 tag / 缺必需字段 / `result` 缺 `id`）⇒ `protocol_error`
 *
 * 绝**不**返回"空消息"：设计 §3.1 的序列化纪律在这里的镜像 ——
 * 静默降级会让"协议不匹配"表现为"方法不存在"，把版本问题误诊成实现漏洞。
 */
export function decodeServerFrame(line: string): ServerFrame {
  const text = line.trim();
  if (text.length === 0) {
    throw new RpcClientError('parse_error', '收到空行：空行不是帧（读循环应跳过它）');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new RpcClientError('parse_error', `不是合法 JSON：${text.slice(0, 200)}`, { cause });
  }

  const record = asObject(parsed, '帧');
  const type = record['type'];
  if (typeof type !== 'string') {
    throw protocolError('帧缺少字符串字段 `type`');
  }

  const notification = decodeNotification(type, record);
  if (notification !== undefined) return { kind: 'notification', notification };

  switch (type) {
    case 'handshake_ack':
      return { kind: 'handshake_ack', ack: decodeHandshakeAck(record) };
    case 'result': {
      const context = 'result 帧';
      const id = requireU32(record, 'id', context, 1);
      if (!('result' in record)) {
        throw protocolError(
          'result 帧缺字段 `result`：`null` 是有含义的（“到点仍未终结”），缺字段则是协议错误',
        );
      }
      const params: ResultParams = { id, result: record['result'] };
      return { kind: 'result', params };
    }
    case 'rpc_error': {
      const context = 'rpc_error 帧';
      const error: RpcError = {
        code: requireInteger(record, 'code', context),
        message: requireString(record, 'message', context),
      };
      if ('data' in record) error.data = record['data'];
      return { kind: 'error', id: optionalId(record, 'id', context), error };
    }
    default:
      throw protocolError(
        `未知 tag \`${type}\`：本协议的 tag 集是 ${PROTOCOL_TAG_NAMES.join(', ')}`,
      );
  }
}

// ---------------------------------------------------------------- 编码

/**
 * 编码一个请求帧（不含换行；换行由传输层加，见 [`RpcTransport.writeLine`](RpcTransport)）。
 *
 * `payload` 平铺在顶层 —— 这是 wire 兼容的**唯一**选择（见文件头第 1 条约束）。
 * `id` 是唯一新增字段（第 2 条约束：既有读取器忽略未知字段）。
 */
export function encodeRequest(
  method: RequestMethod,
  id: number,
  payload: Record<string, unknown> = {},
): string {
  if (!Number.isInteger(id) || id <= 0) {
    throw new RpcClientError('protocol_error', `请求 id 必须是正整数，实际 ${String(id)}`);
  }
  for (const key of Object.keys(payload)) {
    if (key === 'type' || key === 'id') {
      throw new RpcClientError(
        'protocol_error',
        `请求载荷不得覆盖帧字段 \`${key}\`（那是帧的，不是方法的）`,
      );
    }
  }
  return JSON.stringify({ type: method, id, ...payload });
}

/** 编码握手请求载荷（设计 §4.4 的第一帧）。 */
export function handshakePayload(
  handshake: ProtocolHandshake = { client_version: { major: 1, minor: 0, patch: 0 }, extensions: [] },
): Record<string, unknown> {
  return {
    client_version: handshake.client_version,
    extensions: [...handshake.extensions],
  };
}

/** 编码成功应答帧（**服务端桩**用；载荷与生成类型 [`ResultParams`] 绑定）。 */
export function encodeResultFrame(id: number, result: unknown): string {
  const params: ResultParams = { id, result: result === undefined ? null : result };
  return JSON.stringify({ type: 'result', ...params });
}

/** 编码错误应答帧（**服务端桩**用）。`id` 可缺省（今天的 Rust 写入器还不带它）。 */
export function encodeErrorFrame(
  error: RpcError,
  id?: number,
): string {
  const frame: Record<string, unknown> = {
    type: 'rpc_error',
    code: error.code,
    message: error.message,
  };
  if (error.data !== undefined) frame['data'] = error.data;
  if (id !== undefined) frame['id'] = id;
  return JSON.stringify(frame);
}

/** 编码握手应答帧（**服务端桩**用）。 */
export function encodeHandshakeAckFrame(ack: HandshakeAck): string {
  return JSON.stringify({
    type: 'handshake_ack',
    server_version: ack.server_version,
    supported_major: ack.supported_major,
    supported_minor: ack.supported_minor,
    known_capabilities: [...ack.known_capabilities],
  });
}

/** 编码通知帧（**服务端桩**用）。 */
export function encodeNotificationFrame(notification: ServerNotification): string {
  return JSON.stringify({ type: notification.type, ...notification.payload });
}
