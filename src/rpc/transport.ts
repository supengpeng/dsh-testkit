/**
 * 传输抽象：把"帧怎么送达对端"与"协议怎么对话"分开。
 *
 * 这样做的**唯一**目的是可测性：协议逻辑（[`RpcClient`](RpcClient.js)、`StubCore`）
 * 必须能跑在
 *
 * 1. **内存对**（[`createMemoryTransportPair`]）—— 快速、可控、能精确制造
 *    "响应乱序""在途请求挂起""对端无应答"这些真实管道里偶发的形态；
 * 2. **stdio 子进程**（[`createStdioTransport`](Stdio.js)）—— 真管道、真换行分隔。
 *
 * 否则"提交不阻塞""写后必须 flush"这类断言只能在慢进程上碰运气。
 *
 * # `writeLine` 的语义（重要）
 *
 * 它写的是**一帧**：实现负责补上且只补一个 `\n`（NDJSON 的"行"由传输层定义，
 * 不由协议层拼字符串）。协议层交给它的文本**必须不含换行** ——
 * "一帧必须恰好一行"是 `frame.rs` 已有的性质，这里用类型（`writeLine(line)` 只收一帧）
 * 而不是用约定来维持。
 */

/** 一行一帧的双向传输。 */
export interface RpcTransport {
  /**
   * 写出一帧（不含换行；实现负责补 `\n` 并**立即**送出）。
   *
   * "立即"是可验收的约束，不是愿望：stdio 实现写成一句 `stdin.write()`，
   * **不**套任何用户态缓冲（"忘了 flush" 在 Node 里的真实形态就是自己攒了一个数组
   * 却在等更多数据 —— 那会让对端等到超时，而超时会被误诊成"执行慢"）。
   */
  writeLine(line: string): void;

  /** 注册帧到达回调；返回取消注册的函数。 */
  onLine(handler: (line: string) => void): () => void;

  /** 注册关闭回调；返回取消注册的函数。 */
  onClose(handler: (reason: string) => void): () => void;

  /** 是否已关闭。 */
  readonly closed: boolean;

  /** 关闭（幂等）。 */
  close(): void;
}

interface SideState {
  readonly lineHandlers: Set<(line: string) => void>;
  readonly closeHandlers: Set<(reason: string) => void>;
  closed: boolean;
  closeReason: string;
}

function makeSide(state: SideState, peer: SideState, sideName: string): RpcTransport {
  const deliver = (action: () => void): void => {
    // 异步投递：真实管道从不是同步重入的。同步投递会让"客户端在一个回调里
    // 继续写帧"这类重入问题在测试里消失，而在真实 stdio 上出现。
    queueMicrotask(action);
  };
  return {
    writeLine(line: string): void {
      if (state.closed) {
        throw new Error(`传输已关闭（${sideName}），不能再写帧`);
      }
      if (line.includes('\n')) {
        throw new Error('writeLine 只接受一帧：文本里不得含换行（换行由传输层补）');
      }
      deliver(() => {
        if (peer.closed) return;
        for (const handler of [...peer.lineHandlers]) handler(line);
      });
    },
    onLine(handler: (line: string) => void): () => void {
      state.lineHandlers.add(handler);
      return () => state.lineHandlers.delete(handler);
    },
    onClose(handler: (reason: string) => void): () => void {
      if (state.closed) {
        deliver(() => handler(state.closeReason));
      } else {
        state.closeHandlers.add(handler);
      }
      return () => state.closeHandlers.delete(handler);
    },
    get closed(): boolean {
      return state.closed;
    },
    close(): void {
      if (state.closed) return;
      state.closed = true;
      state.closeReason = `本端（${sideName}）主动关闭`;
      const reason = `对端（${sideName}）已关闭`;
      deliver(() => {
        if (peer.closed) return;
        peer.closed = true;
        peer.closeReason = reason;
        for (const handler of [...peer.closeHandlers]) handler(reason);
      });
    },
  };
}

/** 内存传输对：一端给客户端，一端给（桩）服务端。 */
export interface MemoryTransportPair {
  /** 客户端一端。 */
  readonly client: RpcTransport;
  /** 服务端一端。 */
  readonly server: RpcTransport;
  /** 是否任一端已关闭（测试断言用）。 */
  isClosed(): boolean;
}

/**
 * 造一对内存传输。
 *
 * 投递走 `queueMicrotask`（异步但**保序**）：既能暴露重入问题，
 * 又不需要靠 sleep 让测试"看起来通过"。
 */
export function createMemoryTransportPair(): MemoryTransportPair {
  const clientState: SideState = {
    lineHandlers: new Set(),
    closeHandlers: new Set(),
    closed: false,
    closeReason: '',
  };
  const serverState: SideState = {
    lineHandlers: new Set(),
    closeHandlers: new Set(),
    closed: false,
    closeReason: '',
  };
  const client = makeSide(clientState, serverState, '客户端');
  const server = makeSide(serverState, clientState, '服务端');
  return {
    client,
    server,
    isClosed: () => clientState.closed || serverState.closed,
  };
}

/** 让当前微任务队列清空（测试里等一帧投递到位用）。 */
export function drainMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
