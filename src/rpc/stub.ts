/**
 * **内存桩服务端**：纯 TS 实现的"假 Rust 核心"，用来把客户端的契约行为变成可判定的测试。
 *
 * 它**不是**生产代码：真实服务端在 Rust 侧（`crates/protocol` 是它的契约层）。
 * 放在 `src/` 而不是 `tests/` 的理由有两条，都是硬的：
 *
 * 1. **类型检查**：`tests/**` 是 `.mjs`，不进 `tsc`；桩要与 `src/contracts/generated/`
 *    的生成类型逐字段对齐，必须被编译器检查（否则它会成为"看起来对的"假契约）。
 * 2. **跨进程复用**：`stub-stdio.ts` 把同一个桩挂到真实 stdin/stdout 上，
 *    于是"写后必须 flush"这类断言可以跑在**真管道**上（见 `tests/rpc.test.mjs`）。
 *
 * # 它按哪一侧的规则行事
 *
 * 桩扮演**服务端**，所以它实现的是设计 §4.4 的握手四步、§4.3 的方法表、§4.5 的错误码：
 * - 握手前收到其它帧 ⇒ 回 `-32001` 并**关闭连接**（§4.4 第 4 条，不静默忽略）；
 * - 版本兼容按 `handshake.rs::is_version_compatible()`（主版本相同 + 服务端次版本 ≥ 客户端）；
 * - `submit` 立即回句柄（**不等结果**），结果在 `resultDelayMs` 之后才产出；
 * - `cancel` / `shutdown` 幂等；`register_*` **不**幂等（重名报错）。
 *
 * # 一处诚实标注
 *
 * `register_assertion` / `register_capability` 重名时，§4.5 的错误表**没有**专属码
 * （六个自定义码里最接近的是 `-32003 task_exists`，但它说的是**任务**，
 * 拿它去表达"这个断言词名字已被注册"会把两件事混成一个数字）。
 * 桩用标准码 `-32602 invalid_params`，理由写在 `#duplicateNameError()` 上 ——
 * 这是"契约缺一格"的**显式**记录，不是随手选的。
 */

import type { HandshakeAck } from '../contracts/generated/HandshakeAck.js';
import type { RpcError } from '../contracts/generated/RpcError.js';
import type { TaskHandle } from '../contracts/generated/TaskHandle.js';
import type { TaskResult } from '../contracts/generated/TaskResult.js';
import type { TaskState } from '../contracts/generated/TaskState.js';
import type { TaskStatus } from '../contracts/generated/TaskStatus.js';
import type { Version } from '../contracts/generated/Version.js';
import {
  encodeErrorFrame,
  encodeHandshakeAckFrame,
  encodeNotificationFrame,
  encodeResultFrame,
} from './frames.js';
import { RPC_ERROR_CODE_BY_NAME } from './errors.js';
import { describeIncompatibility, isVersionCompatible, localVersion } from './version.js';

/** 桩收到的请求帧（原样记录，供测试断言"请求里到底有什么"）。 */
export interface StubRequestFrame {
  /** `type` tag（= 方法名）。 */
  readonly type: string;
  /** 请求 id（今天的 Rust 写入器还不带它，所以可缺省）。 */
  readonly id: number | undefined;
  /** 原始对象。 */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** 桩内部的任务快照。 */
export interface StubTaskSnapshot {
  /** 任务 id。 */
  readonly taskId: string;
  /** 当前状态。 */
  readonly state: TaskState;
  /** 返回给客户端的句柄。 */
  readonly handle: TaskHandle;
  /** 已产出的结果（未产出时为 `undefined`）。 */
  readonly result: TaskResult | undefined;
}

/** [`StubCore`] 的选项。 */
export interface StubCoreOptions {
  /** 要写出的帧（由调用方接到传输上）。**必须同步**调用。 */
  emit: (line: string) => void;
  /** 服务端版本；缺省等于 [`localVersion`]（即与客户端同版本）。 */
  serverVersion?: Version;
  /**
   * **测试钩子**：让 `handshake_ack.server_version` 报告一个**与兼容判定无关**的版本。
   *
   * 存在的理由只有一个：证明客户端的**本地复核**真的会红（否则"不兼容检出率"完全依赖
   * 对端诚实，那时 H2 量的是对端而不是客户端）。正常实现**不要**设它。
   */
  handshakeAckVersion?: Version;
  /** `submit` 之后多久产出结果（毫秒）；缺省 `200`。 */
  resultDelayMs?: number;
  /** 已知能力名（`handshake_ack.known_capabilities`）。 */
  knownCapabilities?: readonly string[];
  /** `submit` 成功后是否补发一条 `progress` 通知；缺省 `true`。 */
  emitProgress?: boolean;
  /** 是否执行 §4.4 第 4 条（握手前帧 ⇒ `-32001` + 关闭）；缺省 `true`。 */
  requireHandshakeFirst?: boolean;
  /** 时钟（测试可注入假时钟）；缺省 `Date.now`。 */
  now?: () => number;
}

function invalidParams(message: string): RpcError {
  return { code: -32602, message };
}

function clientError(code: number, message: string): RpcError {
  return { code, message };
}

interface Waiter {
  readonly taskId: string;
  readonly requestId: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * 桩服务端内核：纯逻辑，不碰 IO。
 *
 * 输入是一行（`handleLine`），输出经构造时传入的 `emit` 回调。
 * 异步产出（结果延迟、`wait` 挂起到期）也走同一个 `emit`，所以调用方只需要接一次线。
 */
export class StubCore {
  readonly #emit: (line: string) => void;
  readonly #serverVersion: Version;
  readonly #ackVersion: Version;
  readonly #resultDelayMs: number;
  readonly #knownCapabilities: readonly string[];
  readonly #emitProgress: boolean;
  readonly #requireHandshakeFirst: boolean;
  readonly #now: () => number;

  #handshake: 'awaiting' | 'established' = 'awaiting';
  #violated = false;
  readonly #tasks = new Map<string, StubTaskSnapshot & { readonly createdAt: number }>();
  readonly #registeredAssertions = new Set<string>();
  readonly #registeredCapabilities = new Set<string>();
  readonly #received: StubRequestFrame[] = [];
  readonly #waiters: Waiter[] = [];
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();
  #shutdownCount = 0;

  constructor(options: StubCoreOptions) {
    this.#emit = options.emit;
    this.#serverVersion = options.serverVersion ?? localVersion();
    this.#ackVersion = options.handshakeAckVersion ?? this.#serverVersion;
    this.#resultDelayMs = options.resultDelayMs ?? 200;
    this.#knownCapabilities = options.knownCapabilities ?? [];
    this.#emitProgress = options.emitProgress ?? true;
    this.#requireHandshakeFirst = options.requireHandshakeFirst ?? true;
    this.#now = options.now ?? Date.now;
  }

  /** 已收到的请求帧（按到达序）。 */
  get received(): readonly StubRequestFrame[] {
    return this.#received;
  }

  /** 握手状态。 */
  get handshakeState(): 'awaiting' | 'established' {
    return this.#handshake;
  }

  /** 是否因违反握手前置而被关闭（§4.4 第 4 条）。 */
  get violated(): boolean {
    return this.#violated;
  }

  /** `shutdown` 被调用的次数（测"可重复"）。 */
  get shutdownCount(): number {
    return this.#shutdownCount;
  }

  /** 当前挂起中的 `wait`（测"服务端确实没有立刻回答案"）。 */
  get pendingWaiters(): number {
    return this.#waiters.length;
  }

  /** 任务快照（按提交序）。 */
  get tasks(): readonly StubTaskSnapshot[] {
    return [...this.#tasks.values()];
  }

  /** 取某个任务的快照。 */
  task(taskId: string): StubTaskSnapshot | undefined {
    return this.#tasks.get(taskId);
  }

  /** 停掉所有挂起的定时器（测试收尾；避免测试进程被定时器拖住）。 */
  dispose(): void {
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    this.#waiters.length = 0;
  }

  /**
   * 处理一行。
   *
   * 空行跳过（与 `frame.rs::read_frame` 一致）；非法 JSON 回 `-32700`；
   * 合法 JSON 但没有字符串 `type` 回 `-32600`。
   */
  handleLine(line: string): void {
    const text = line.trim();
    if (text.length === 0) return;
    if (this.#violated) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      this.#emit(
        encodeErrorFrame(
          clientError(-32700, `解析失败：${cause instanceof Error ? cause.message : String(cause)}`),
        ),
      );
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      this.#emit(encodeErrorFrame(clientError(-32600, '请求必须是 JSON 对象')));
      return;
    }
    const raw = parsed as Record<string, unknown>;
    const type = raw['type'];
    if (typeof type !== 'string') {
      this.#emit(encodeErrorFrame(clientError(-32600, '请求缺少字符串字段 `type`')));
      return;
    }
    const id = typeof raw['id'] === 'number' && Number.isInteger(raw['id']) ? raw['id'] : undefined;
    this.#received.push({ type, id, raw });

    if (this.#requireHandshakeFirst && this.#handshake === 'awaiting' && type !== 'handshake') {
      // 设计 §4.4 第 4 条：回 -32001 **并关闭连接**（不静默忽略 ——
      // 静默会让"协议不匹配"表现为"方法找不到"）。
      this.#violated = true;
      this.#emit(
        encodeErrorFrame(
          clientError(
            RPC_ERROR_CODE_BY_NAME.version_mismatch,
            '握手前不接受其它方法：第一帧必须是 handshake',
          ),
          id,
        ),
      );
      return;
    }

    switch (type) {
      case 'handshake':
        this.#handleHandshake(raw, id);
        return;
      case 'submit':
        this.#handleSubmit(raw, id);
        return;
      case 'wait':
        this.#handleWait(raw, id);
        return;
      case 'cancel':
        this.#handleCancel(raw, id);
        return;
      case 'query':
        this.#handleQuery(raw, id);
        return;
      case 'register_assertion':
        this.#handleRegister(raw, id, this.#registeredAssertions, '断言词');
        return;
      case 'register_capability':
        this.#handleRegister(raw, id, this.#registeredCapabilities, '能力');
        return;
      case 'refresh_capabilities': {
        const map: Record<string, string> = {};
        for (const capability of this.#knownCapabilities) map[capability] = 'available';
        this.#respond(id, map);
        return;
      }
      case 'shutdown':
        this.#shutdownCount += 1;
        this.#respond(id, null);
        return;
      default:
        this.#emit(
          encodeErrorFrame(
            clientError(-32601, `方法不存在：${type}（设计 §4.3 的方法表是九行）`),
            id,
          ),
        );
    }
  }

  // ---------------------------------------------------------------- 各方法

  #handleHandshake(raw: Record<string, unknown>, id: number | undefined): void {
    const clientVersion = readVersion(raw['client_version']);
    if (clientVersion === undefined) {
      this.#emit(encodeErrorFrame(invalidParams('handshake 缺 `client_version`（或不是 Version）'), id));
      return;
    }
    if (!isVersionCompatible(clientVersion, this.#serverVersion)) {
      this.#violated = true;
      this.#emit(
        encodeErrorFrame(
          clientError(
            RPC_ERROR_CODE_BY_NAME.version_mismatch,
            describeIncompatibility(clientVersion, this.#serverVersion),
          ),
          id,
        ),
      );
      return;
    }
    this.#handshake = 'established';
    const ack: HandshakeAck = {
      server_version: this.#ackVersion,
      supported_major: this.#serverVersion.major,
      supported_minor: this.#serverVersion.minor,
      known_capabilities: [...this.#knownCapabilities],
    };
    // 握手应答是**既有 tag**（§4.6 画的就是 handshake_ack），不带 id。
    this.#emit(encodeHandshakeAckFrame(ack));
  }

  #handleSubmit(raw: Record<string, unknown>, id: number | undefined): void {
    const taskId = raw['task_id'];
    const plan = raw['plan'];
    if (typeof taskId !== 'string' || taskId.length === 0) {
      this.#emit(encodeErrorFrame(invalidParams('submit 缺 `task_id`（字符串）'), id));
      return;
    }
    if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
      this.#emit(encodeErrorFrame(invalidParams('submit 缺 `plan`（ExecutionPlan 对象）'), id));
      return;
    }
    if (this.#tasks.has(taskId)) {
      this.#emit(
        encodeErrorFrame(clientError(RPC_ERROR_CODE_BY_NAME.task_exists, `任务已存在：${taskId}`), id),
      );
      return;
    }
    const handle: TaskHandle = { task_id: taskId, state: 'pending' };
    this.#tasks.set(taskId, {
      taskId,
      state: 'pending',
      handle,
      result: undefined,
      createdAt: this.#now(),
    });
    // 立即回句柄 —— **不等结果**（§4.3 的修正点：原稿让 submit 同步返回结果）。
    this.#respond(id, handle);
    if (this.#emitProgress) {
      this.#emit(
        encodeNotificationFrame({
          type: 'progress',
          payload: { task_id: taskId, phase: 'queued', message: `任务 ${taskId} 已入队` },
        }),
      );
    }
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      const task = this.#tasks.get(taskId);
      if (task === undefined || task.result !== undefined) return;
      const result: TaskResult = {
        task_id: taskId,
        outcome: task.state === 'cancelled' ? 'cancelled' : 'passed',
        duration_ms: this.#now() - task.createdAt,
        detail: { stubbed: true },
      };
      this.#tasks.set(taskId, { ...task, state: 'finished', result });
      this.#flushWaiters(taskId);
    }, this.#resultDelayMs);
    this.#timers.add(timer);
  }

  #handleWait(raw: Record<string, unknown>, id: number | undefined): void {
    if (id === undefined) {
      this.#emit(
        encodeErrorFrame(invalidParams('wait 必须带请求 id（并发在途时按 id 配对）')),
      );
      return;
    }
    const taskId = readTaskId(raw['handle']);
    if (taskId === undefined) {
      this.#emit(encodeErrorFrame(invalidParams('wait 缺 `handle.task_id`'), id));
      return;
    }
    const timeoutMs = raw['timeout_ms'];
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 0) {
      this.#emit(encodeErrorFrame(invalidParams('wait 缺 `timeout_ms`（非负整数，0 = 不等待）'), id));
      return;
    }
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      this.#emit(
        encodeErrorFrame(clientError(RPC_ERROR_CODE_BY_NAME.task_not_exists, `任务不存在：${taskId}`), id),
      );
      return;
    }
    if (task.result !== undefined) {
      this.#respond(id, task.result);
      return;
    }
    if (timeoutMs === 0) {
      // 契约未定义"到点还没好"该回什么；本桩的读法是 `result: null`（见 RpcClient.wait 的 TSDoc）。
      this.#respond(id, null);
      return;
    }
    const waiter: Waiter = {
      taskId,
      requestId: id,
      timer: setTimeout(() => {
        this.#timers.delete(waiter.timer);
        const index = this.#waiters.indexOf(waiter);
        if (index >= 0) this.#waiters.splice(index, 1);
        this.#respond(waiter.requestId, null);
      }, timeoutMs),
    };
    this.#timers.add(waiter.timer);
    this.#waiters.push(waiter);
  }

  #handleCancel(raw: Record<string, unknown>, id: number | undefined): void {
    const taskId = readTaskId(raw['handle']);
    if (taskId === undefined) {
      this.#emit(encodeErrorFrame(invalidParams('cancel 缺 `handle.task_id`'), id));
      return;
    }
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      this.#emit(
        encodeErrorFrame(clientError(RPC_ERROR_CODE_BY_NAME.task_not_exists, `任务不存在：${taskId}`), id),
      );
      return;
    }
    // 幂等：已取消/已终结的任务再取消一次仍然是 Ok（§3.2 第 3 条）。
    if (task.result === undefined) {
      this.#tasks.set(taskId, {
        ...task,
        state: 'cancelled',
        result: {
          task_id: taskId,
          outcome: 'cancelled',
          duration_ms: this.#now() - task.createdAt,
          detail: { reason: 'stub：收到 cancel' },
        },
      });
      this.#flushWaiters(taskId);
    }
    this.#respond(id, null);
  }

  #handleQuery(raw: Record<string, unknown>, id: number | undefined): void {
    const taskId = readTaskId(raw['handle']);
    if (taskId === undefined) {
      this.#emit(encodeErrorFrame(invalidParams('query 缺 `handle.task_id`'), id));
      return;
    }
    const task = this.#tasks.get(taskId);
    if (task === undefined) {
      this.#emit(
        encodeErrorFrame(clientError(RPC_ERROR_CODE_BY_NAME.task_not_exists, `任务不存在：${taskId}`), id),
      );
      return;
    }
    const status: TaskStatus = { task_id: taskId, state: task.state, phase: 'stub' };
    this.#respond(id, status);
  }

  #handleRegister(
    raw: Record<string, unknown>,
    id: number | undefined,
    registry: Set<string>,
    what: string,
  ): void {
    const key = what === '断言词' ? raw['name'] : raw['capability'];
    if (typeof key !== 'string' || key.length === 0) {
      this.#emit(encodeErrorFrame(invalidParams(`register 缺名字（${what}）`), id));
      return;
    }
    if (registry.has(key)) {
      // §4.5 的自定义码里没有"名字已注册"这一格：`-32003 task_exists` 说的是**任务**，
      // 拿它表达"断言词重名"会把两件事混成一个数字。所以用标准码 `-32602 invalid_params`，
      // 并在这里显式记下这是**契约缺一格**。
      this.#emit(
        encodeErrorFrame(
          invalidParams(`${what}名字已被注册：${key}（重名必须报错，不静默覆盖）`),
          id,
        ),
      );
      return;
    }
    registry.add(key);
    this.#respond(id, null);
  }

  // ---------------------------------------------------------------- 输出

  #respond(id: number | undefined, result: unknown): void {
    if (id === undefined) {
      // 带 id 的应答是协议的一部分（§4.6 允许"先 submit N 个再一起等"）：
      // 没有 id 就没法配对，所以这里**如实**报成内部错误，而不是猜一个请求。
      this.#emit(encodeErrorFrame(clientError(-32603, '请求缺少 id，无法作为应答配对')));
      return;
    }
    this.#emit(encodeResultFrame(id, result));
  }

  #flushWaiters(taskId: string): void {
    const task = this.#tasks.get(taskId);
    if (task?.result === undefined) return;
    const remaining: Waiter[] = [];
    for (const waiter of this.#waiters) {
      if (waiter.taskId !== taskId) {
        remaining.push(waiter);
        continue;
      }
      clearTimeout(waiter.timer);
      this.#timers.delete(waiter.timer);
      this.#respond(waiter.requestId, task.result);
    }
    this.#waiters.length = 0;
    this.#waiters.push(...remaining);
  }
}

function readVersion(value: unknown): Version | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { major, minor, patch } = record;
  if (typeof major !== 'number' || typeof minor !== 'number' || typeof patch !== 'number') {
    return undefined;
  }
  return { major, minor, patch };
}

function readTaskId(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const taskId = (value as Record<string, unknown>)['task_id'];
  return typeof taskId === 'string' ? taskId : undefined;
}
