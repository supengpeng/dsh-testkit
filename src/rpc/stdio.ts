/**
 * stdio 传输：启动 Rust 核心子进程，用 NDJSON 走它的 stdin/stdout（设计 §4.1）。
 *
 * # 三条纪律（都是踩过的坑，不是风格）
 *
 * 1. **协议帧只走 stdout，日志只走 stderr。** 所以默认把子进程的 stderr
 *    `inherit`（直接进本进程的 stderr），而不是 `pipe`：一旦有人把日志写到 stdout，
 *    那一行就会被读成"帧"并触发协议错误 —— 这是**正确**的失败方式（响亮），
 *    但把 stderr 分开能让日志与帧各自可读。
 * 2. **写一帧就是一次 `stdin.write()`。** Node 的 `Writable` 对管道是直通的：
 *    不存在需要手动 flush 的用户态缓冲。真正的 flush 事故形态是"自己在数组里攒帧"，
 *    所以本实现**不攒**（见 `transport.ts` 的 `writeLine` 语义）。
 * 3. **关闭是幂等的，且一定会通知等待者。** 子进程可能先退出（崩溃、被 kill），
 *    这时在途请求必须立刻收到"关闭"而不是等到超时 ——
 *    "等超时"会把"进程没了"误诊成"执行慢"。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type { RpcTransport } from './transport.js';

/** [`createStdioTransport`] 的选项。 */
export interface StdioTransportOptions {
  /** 可执行文件（通常是 `cargo run` 产物或已构建的 Rust 二进制）。 */
  command: string;
  /** 参数。 */
  args?: readonly string[];
  /** 工作目录。 */
  cwd?: string;
  /** 环境变量（缺省继承本进程）。 */
  env?: NodeJS.ProcessEnv;
  /**
   * 子进程 stderr 的处置。
   *
   * `'inherit'`（缺省）把它接到本进程 stderr —— 帧与日志分离，两边都读得懂。
   * `'pipe'` 时会被读取并交给 `onStderr`；`'ignore'` 直接丢弃。
   */
  stderr?: 'inherit' | 'ignore' | 'pipe';
  /** `stderr: 'pipe'` 时，每收到一行 stderr 回调一次（诊断用）。 */
  onStderr?: (line: string) => void;
}

/** 子进程起不来时抛的错误（归 `transport_error`，退出码 `3`）。 */
export class StdioSpawnError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StdioSpawnError';
  }
}

/**
 * 启动子进程并返回它的传输。
 *
 * 进程启动失败（命令不存在等）是**异步**报出来的：`spawn` 不抛，而是发 `error` 事件。
 * 本实现把它转成关闭通知（而不是让调用方等到超时）——
 * 这是"如实告知"在传输层的落点。
 */
export function createStdioTransport(options: StdioTransportOptions): RpcTransport {
  const {
    command,
    args = [],
    cwd,
    env,
    stderr = 'inherit',
    onStderr,
  } = options;

  let child: ChildProcess;
  try {
    child = spawn(command, [...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', stderr],
      windowsHide: true,
    });
  } catch (cause) {
    throw new StdioSpawnError(`无法启动子进程 ${command}`, { cause });
  }

  const lineHandlers = new Set<(line: string) => void>();
  const closeHandlers = new Set<(reason: string) => void>();
  let closed = false;
  let closeReason = '';

  const notifyClose = (reason: string): void => {
    if (closed) return;
    closed = true;
    closeReason = reason;
    for (const handler of [...closeHandlers]) handler(reason);
  };

  let reader: Interface | undefined;
  if (child.stdout) {
    reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line: string) => {
      // 空行是帧之间的自然噪声（`frame.rs::read_frame` 同样跳过它）。
      if (line.trim().length === 0) return;
      for (const handler of [...lineHandlers]) handler(line);
    });
  } else {
    notifyClose('子进程没有 stdout 管道');
  }

  if (stderr === 'pipe' && child.stderr) {
    const stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity });
    stderrReader.on('line', (line: string) => onStderr?.(line));
  }

  child.on('error', (error: Error) => {
    notifyClose(`子进程错误：${error.message}`);
  });
  child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    notifyClose(`子进程退出：code=${String(code)} signal=${String(signal)}`);
  });

  return {
    writeLine(line: string): void {
      if (closed) throw new Error(`传输已关闭（${closeReason}），不能再写帧`);
      if (line.includes('\n')) {
        throw new Error('writeLine 只接受一帧：文本里不得含换行（换行由传输层补）');
      }
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        notifyClose('子进程 stdin 不可写');
        throw new Error('子进程 stdin 不可写');
      }
      // 一帧一次 write：这就是 Node 里"flush"的等价物（管道直通，无用户态缓冲）。
      stdin.write(`${line}\n`);
    },
    onLine(handler: (line: string) => void): () => void {
      lineHandlers.add(handler);
      return () => lineHandlers.delete(handler);
    },
    onClose(handler: (reason: string) => void): () => void {
      if (closed) {
        queueMicrotask(() => handler(closeReason));
      } else {
        closeHandlers.add(handler);
      }
      return () => closeHandlers.delete(handler);
    },
    get closed(): boolean {
      return closed;
    },
    close(): void {
      if (closed) return;
      reader?.close();
      try {
        child.stdin?.end();
      } catch {
        // stdin 可能已经坏了；关闭路径不允许因为"已经坏了"而抛。
      }
      // 先记关闭原因，再 kill：kill 会触发 exit 事件，那时 notifyClose 已是幂等 no-op。
      notifyClose('本端主动关闭');
      try {
        child.kill();
      } catch {
        // 同上：进程可能已经不在了。
      }
    },
  };
}
