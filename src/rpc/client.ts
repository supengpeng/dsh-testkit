/**
 * JSON-RPC 客户端（设计 §4.1 的协议**另一端**；Rust 核心那一端是 `crates/protocol`）。
 *
 * # 它做什么
 *
 * 1. 启动/接管一条 [`RpcTransport`]，跑一个**读循环**；
 * 2. 第一帧发 `handshake`，按 §4.4 的规则判定兼容（本地**复核**服务端的 ack）；
 * 3. 提供 §4.3 方法表的九个方法；**`submit` 只等到句柄，绝不等到结果**；
 * 4. 按**请求 id** 配对（§4.6 允许"先 submit N 个再一起等"，所以必须支持并发在途）；
 * 5. 把服务端的通知（`progress` / `capability_changed` / `trace`）收进队列，不打断请求。
 *
 * # 四条"选一种并写清"的边界（都是本客户端**决定**的语义）
 *
 * | 情形 | 本客户端的行为 |
 * |---|---|
 * | 握手成功前调用其它方法 | **本地**拒绝，`kind: 'handshake_required'`，码 `-32001`（与服务端 §4.4 第 4 条的应答同码，退出码统一为 `6`） |
 * | `shutdown` 之后仍有在途请求 | **立刻**以 `kind: 'closed'` 拒绝（不等超时——"等到超时"会把"服务端已宣告收工"误诊成"走得慢"） |
 * | 收不到应答 | 本地超时（`kind: 'request_timeout'`，默认 30s，可关）。它与服务端的 `-32005 execution_timeout` **不是一回事**：前者是"对面没回话"，后者是"被测对象超时" |
 * | 应答与在途请求对不上（id 未知 / `result` 帧缺 id / 未知 tag / 一行不是 JSON） | **一律响亮失败**：`protocol_error` / `parse_error`，并关闭连接。流出错位之后没有什么还能被信任 |
 *
 * # `wait` 的返回为什么是 `TaskResult | null`
 *
 * `WaitParams.timeout_ms` 的语义是"`0` = 不等待、立即返回当前状态"（见
 * `crates/protocol/src/message.rs`），但 §4.3 只承诺返回 `TaskResult`，而
 * **`TaskResult` 没有"还没好"这一态**。这是契约未定义处，本客户端的读法是
 * `result: null` ⇒ `null`（"到点仍未终结"），并且**不**把它伪装成
 * `Cancelled`/`Skipped` 之类的结论 —— 编造一个结论比返回 `null` 危险得多。
 */

import type { CancelParams } from '../contracts/generated/CancelParams.js';
import type { HandshakeAck } from '../contracts/generated/HandshakeAck.js';
import type { ProtocolHandshake } from '../contracts/generated/ProtocolHandshake.js';
import type { QueryParams } from '../contracts/generated/QueryParams.js';
import type { RefreshParams } from '../contracts/generated/RefreshParams.js';
import type { RegisterAssertionParams } from '../contracts/generated/RegisterAssertionParams.js';
import type { RegisterCapabilityParams } from '../contracts/generated/RegisterCapabilityParams.js';
import type { ShutdownParams } from '../contracts/generated/ShutdownParams.js';
import type { SubmitParams } from '../contracts/generated/SubmitParams.js';
import type { TaskHandle } from '../contracts/generated/TaskHandle.js';
import type { TaskResult } from '../contracts/generated/TaskResult.js';
import type { TaskStatus } from '../contracts/generated/TaskStatus.js';
import type { WaitParams } from '../contracts/generated/WaitParams.js';
import { RPC_ERROR_CODE_BY_NAME, RpcClientError } from './errors.js';
import {
  decodeHandshakeAck,
  decodeServerFrame,
  decodeTaskHandle,
  decodeTaskResult,
  decodeTaskStatus,
  encodeRequest,
  handshakePayload,
  type RequestMethod,
  type ServerFrame,
  type ServerNotification,
} from './frames.js';
import type { RpcTransport } from './transport.js';
import { describeIncompatibility, isVersionCompatible, localVersion } from './version.js';

/** 客户端生命周期。 */
export type RpcClientState =
  /** 还没握手。 */
  | 'idle'
  /** 已发出 handshake，等 ack。 */
  | 'handshaking'
  /** 握手成功，可调用方法。 */
  | 'ready'
  /** 已关闭（shutdown / 对端关闭 / 硬关闭）。 */
  | 'closed';

/** [`RpcClient`] 的选项。 */
export interface RpcClientOptions {
  /** 握手帧的版本与扩展；缺省用 [`localVersion`] 与空扩展。 */
  handshake?: ProtocolHandshake;
  /**
   * 单请求的**传输层**超时（毫秒）；`0` 表示不设超时。缺省 `30_000`。
   *
   * 它与协议里的 `WaitParams.timeout_ms` 不同（见类型文档的表）。
   */
  requestTimeoutMs?: number;
  /** 通知到达时回调（可选；无论如何都会进 [`RpcClient.notifications`]）。 */
  onNotification?: (notification: ServerNotification) => void;
  /** 连接关闭时回调。 */
  onClose?: (reason: string) => void;
}

interface PendingRequest {
  readonly id: number;
  readonly method: RequestMethod;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 默认单请求传输超时（毫秒）。
 *
 * 有值而不是无限等：无限等会把"对面崩了/没实现"表现成"整个测试套件挂住"，
 * 而挂住是最难归因的失败形态。30s 远大于任何真实方法调用。
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** 客户端。 */
export class RpcClient {
  readonly #transport: RpcTransport;
  readonly #handshake: ProtocolHandshake;
  readonly #requestTimeoutMs: number;
  readonly #onNotification: ((notification: ServerNotification) => void) | undefined;
  readonly #onClose: ((reason: string) => void) | undefined;
  readonly #unsubscribeLine: () => void;
  readonly #unsubscribeClose: () => void;

  #state: RpcClientState = 'idle';
  #nextId = 0;
  #closeReason: string | undefined;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #notifications: ServerNotification[] = [];

  constructor(transport: RpcTransport, options: RpcClientOptions = {}) {
    this.#transport = transport;
    this.#handshake = options.handshake ?? { client_version: localVersion(), extensions: [] };
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#onNotification = options.onNotification;
    this.#onClose = options.onClose;
    this.#unsubscribeLine = transport.onLine((line) => {
      this.#onLine(line);
    });
    this.#unsubscribeClose = transport.onClose((reason) => {
      this.#closeWith(reason);
    });
  }

  /** 当前生命周期。 */
  get state(): RpcClientState {
    return this.#state;
  }

  /** 关闭原因（未关闭时为 `undefined`）。 */
  get closeReason(): string | undefined {
    return this.#closeReason;
  }

  /** 在途请求数（诊断与断言用）。 */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** 已收到的通知（按到达序）。 */
  notifications(): readonly ServerNotification[] {
    return this.#notifications;
  }

  /**
   * 握手（第一帧，设计 §4.4）。
   *
   * 除了服务端的判定，本方法还会**本地复核** `ack.server_version`：
   * 服务端 ack 了一个与自己判定矛盾的版本时，这里必须红 ——
   * 否则"不兼容检出率"就完全依赖对端诚实（H2 的读数会变成对端的读数）。
   */
  async handshake(handshake?: ProtocolHandshake): Promise<HandshakeAck> {
    const frame = handshake ?? this.#handshake;
    const payload = handshakePayload(frame);
    const ack = await this.#request('handshake', payload, (value) => decodeHandshakeAck(value));
    if (!isVersionCompatible(frame.client_version, ack.server_version)) {
      throw new RpcClientError(
        'protocol',
        `服务端 ack 的版本与它自己的兼容判定矛盾：${describeIncompatibility(
          frame.client_version,
          ack.server_version,
        )}`,
        { code: RPC_ERROR_CODE_BY_NAME.version_mismatch },
      );
    }
    return ack;
  }

  /**
   * 提交任务，**立即**返回句柄（设计 §4.3 的修正点）。
   *
   * 它只等到 `{"type":"result","result":<TaskHandle>}`，**绝不**等到 `TaskResult`；
   * 要结果必须显式调 [`RpcClient.wait`]（或先批量 submit 再一起 wait）。
   */
  submit(params: SubmitParams): Promise<TaskHandle> {
    return this.#request('submit', { task_id: params.task_id, plan: params.plan }, (value) =>
      decodeTaskHandle(value),
    );
  }

  /**
   * 等待任务终结（设计 §4.3 的 `wait`，**新增的必需方法**）。
   *
   * 返回 `null` 表示"到点仍未终结"（见类型文档；这是契约未定义处，本客户端不编造结论）。
   * 同一个句柄可以**多次** `wait`（服务端对已终结任务是幂等的）。
   */
  wait(params: WaitParams): Promise<TaskResult | null> {
    return this.#request(
      'wait',
      { handle: params.handle, timeout_ms: params.timeout_ms },
      (value) => (value === null ? null : decodeTaskResult(value)),
      // 协议侧的等待可能比传输侧的默认超时长：把两者相加，避免"服务端还在按
      // timeout_ms 等，客户端却先按传输超时把它判死"。
      this.#requestTimeoutMs === 0 ? 0 : this.#requestTimeoutMs + Math.max(0, params.timeout_ms),
    );
  }

  /** 取消任务（幂等；设计 §4.3）。 */
  async cancel(params: CancelParams): Promise<void> {
    await this.#request('cancel', { handle: params.handle }, (value) => this.#expectNull('cancel', value));
  }

  /** 查询状态（幂等；设计 §4.3）。 */
  query(params: QueryParams): Promise<TaskStatus> {
    return this.#request('query', { handle: params.handle }, (value) => decodeTaskStatus(value));
  }

  /** 注册断言词（**不幂等**：重名必须报错，设计 §4.3）。 */
  async registerAssertion(params: RegisterAssertionParams): Promise<void> {
    await this.#request('register_assertion', { name: params.name }, (value) =>
      this.#expectNull('register_assertion', value),
    );
  }

  /** 注册能力探测器（**不幂等**：重名必须报错，设计 §4.3）。 */
  async registerCapability(params: RegisterCapabilityParams): Promise<void> {
    await this.#request('register_capability', { capability: params.capability }, (value) =>
      this.#expectNull('register_capability', value),
    );
  }

  /**
   * 刷新技术能力（幂等；设计 §4.3）。
   *
   * 返回类型是 `unknown` 而**不是**一个编造的形状：§4.3 说它返回 `CapabilityMap`，
   * 但那个类型住在 `crates/capability`，**不在** `src/contracts/generated/` 的
   * 35 个跨语言类型里。TS 侧不该凭空定义它（那会成为第二份真源）。
   */
  refreshCapabilities(params: RefreshParams = { only: [] }): Promise<unknown> {
    return this.#request('refresh_capabilities', { only: [...params.only] }, (value) => value);
  }

  /**
   * 关停服务端（**可重复**；设计 §4.2/§4.3）。
   *
   * 服务端确认之后，本客户端**立刻**关闭：仍在途的请求以 `kind: 'closed'`
   * 拒绝（而不是等各自的超时）—— "服务端已宣告收工"与"走得慢"必须能被区分开。
   * 重复调用返回 `Ok`：第二次仍会发一帧（服务端幂等），但若连接已关闭则直接成功，
   * 因为"关停一个已关停的客户端"在语义上已经是真的。
   */
  async shutdown(params: ShutdownParams = { force: false }): Promise<void> {
    if (this.#state === 'closed') return;
    await this.#request('shutdown', { force: params.force }, (value) =>
      this.#expectNull('shutdown', value),
    );
    this.#closeWith('shutdown 已被服务端确认');
  }

  /** 硬关闭：立刻拒绝所有在途请求并关闭传输（幂等）。 */
  close(reason = '本端主动关闭'): void {
    this.#closeWith(reason);
  }

  // ---------------------------------------------------------------- 内部

  #expectNull(method: RequestMethod, value: unknown): void {
    if (value !== null) {
      throw new RpcClientError(
        'protocol_error',
        `${method} 的返回应为 null（设计 §4.3 的返回是 \`()\`），实际 ${String(
          JSON.stringify(value),
        ).slice(0, 120)}`,
      );
    }
  }

  #request<T>(
    method: RequestMethod,
    payload: Record<string, unknown>,
    decode: (value: unknown) => T,
    timeoutMs: number = this.#requestTimeoutMs,
  ): Promise<T> {
    if (this.#state === 'closed') {
      return Promise.reject(
        new RpcClientError('closed', `连接已关闭：${this.#closeReason ?? '原因未知'}`),
      );
    }
    if (method !== 'handshake' && this.#state !== 'ready') {
      return Promise.reject(
        RpcClientError.handshakeRequired(
          `握手成功前不得调用 \`${method}\`（设计 §4.4 第 4 条：第一帧必须是 handshake）`,
        ),
      );
    }
    if (method === 'handshake' && this.#state !== 'idle') {
      return Promise.reject(
        new RpcClientError('protocol_error', 'handshake 只能进行一次（§4.4 第一帧）'),
      );
    }

    this.#nextId += 1;
    const id = this.#nextId;
    const line = encodeRequest(method, id, payload);

    const promise = new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.#pending.delete(id)) return;
              reject(
                new RpcClientError(
                  'request_timeout',
                  `\`${method}\` 在 ${timeoutMs}ms 内没有应答（传输层超时；不是服务端的 execution_timeout）`,
                ),
              );
            }, timeoutMs)
          : undefined;
      // **先登记再写**：写出去之后应答随时可能到（stdio 下尤其），
      // 先写后登记会丢掉一条合法应答，而那会表现成"偶发超时"。
      this.#pending.set(id, { id, method, resolve, reject, timer });
    });

    if (method === 'handshake') this.#state = 'handshaking';
    try {
      this.#transport.writeLine(line);
    } catch (cause) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        if (pending.timer !== undefined) clearTimeout(pending.timer);
        if (method === 'handshake') this.#state = 'idle';
        pending.reject(
          new RpcClientError('transport_error', `写帧失败：${String(cause)}`, { cause }),
        );
      }
    }

    return promise.then(decode);
  }

  #onLine(line: string): void {
    let frame: ServerFrame;
    try {
      frame = decodeServerFrame(line);
    } catch (error) {
      this.#protocolViolation(error);
      return;
    }

    switch (frame.kind) {
      case 'notification': {
        this.#notifications.push(frame.notification);
        this.#onNotification?.(frame.notification);
        return;
      }
      case 'handshake_ack': {
        const pending = this.#takeById(
          this.#findId((candidate) => candidate.method === 'handshake'),
        );
        if (pending === undefined) {
          this.#protocolViolation(
            new RpcClientError('protocol_error', '收到 handshake_ack，但在途没有 handshake 请求'),
          );
          return;
        }
        this.#state = 'ready';
        this.#settle(pending, frame.ack);
        return;
      }
      case 'result': {
        // 成功应答**必须**按 id 配对：§4.6 允许并发在途，缺 id 就没法唯一确定是谁的答案。
        const pending = this.#takeById(frame.params.id);
        if (pending === undefined) {
          this.#protocolViolation(
            new RpcClientError(
              'protocol_error',
              `收到 result id=${frame.params.id}，但没有对应的在途请求（流出错位）`,
            ),
          );
          return;
        }
        this.#settle(pending, frame.params.result);
        return;
      }
      case 'error': {
        const pending =
          frame.id !== undefined
            ? this.#takeById(frame.id)
            : this.#takeOnlyPending();
        if (pending === undefined) {
          this.#protocolViolation(
            new RpcClientError(
              'protocol_error',
              frame.id === undefined
                ? '收到无 id 的 rpc_error，但有多个在途请求：无法唯一配对'
                : `收到 rpc_error id=${frame.id}，但没有对应的在途请求`,
            ),
          );
          return;
        }
        this.#settleError(pending, RpcClientError.fromRpcError(frame.error));
        return;
      }
    }
  }

  #findId(predicate: (pending: PendingRequest) => boolean): number | undefined {
    for (const [id, pending] of this.#pending) {
      if (predicate(pending)) return id;
    }
    return undefined;
  }

  /**
   * 只有**唯一**一个在途请求时才允许按"最老在途"配对无 id 的帧（并把它取走）。
   *
   * 这条兼容规则存在是因为今天的 Rust 写入器（`frame.rs::write_frame`）写不出 `id`；
   * 但它**只在无歧义时**生效：多条在途 + 无 id ⇒ 判协议错误，绝不猜。
   */
  #takeOnlyPending(): PendingRequest | undefined {
    if (this.#pending.size !== 1) return undefined;
    for (const pending of this.#pending.values()) {
      this.#pending.delete(pending.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      return pending;
    }
    /* c8 ignore next */
    return undefined;
  }

  #takeById(id: number | undefined): PendingRequest | undefined {
    if (id === undefined) return undefined;
    const pending = this.#pending.get(id);
    if (pending === undefined) return undefined;
    this.#pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    return pending;
  }

  #settle(pending: PendingRequest, value: unknown): void {
    pending.resolve(value);
  }

  #settleError(pending: PendingRequest, error: Error): void {
    pending.reject(error);
  }

  #protocolViolation(error: unknown): void {
    const wrapped =
      error instanceof RpcClientError
        ? error
        : new RpcClientError('protocol_error', `帧处理失败：${String(error)}`, { cause: error });
    this.#closeWith(`协议错误：${wrapped.message}`, wrapped);
  }

  #closeWith(reason: string, cause?: Error): void {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    this.#closeReason = reason;
    const error = cause ?? new RpcClientError('closed', reason);
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#unsubscribeLine();
    this.#unsubscribeClose();
    if (!this.#transport.closed) this.#transport.close();
    this.#onClose?.(reason);
  }
}
