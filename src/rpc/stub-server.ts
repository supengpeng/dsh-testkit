/**
 * 把 [`StubCore`](StubCore.js) 挂到**真实** stdin/stdout 上的最小服务端（NDJSON）。
 *
 * # 它为什么存在
 *
 * 内存桩能测协议逻辑，但**测不了管道**：`writeLine` 到底有没有把那一帧真的推出去、
 * 换行分隔对不对、对端关闭后在途请求会不会立刻收到关闭 ——
 * 这些只有跑在真进程 + 真管道上才是可判定的（`tests/rpc.test.mjs` 用它做 stdio 验收）。
 *
 * 用法（测试与集成方都用这一条命令）：
 * ```text
 * node lib/rpc/stub-server.js [--result-delay-ms=200] [--minor=0] [--major=1]
 *                            [--ack-version=2.0.0] [--capabilities=a,b]
 * ```
 *
 * 纪律：**协议帧只走 stdout，日志只走 stderr**（设计 §4.1 的 stdio 布置）。
 * 这里的实现从来不往 stdout 写非帧内容 —— 否则对端会把日志读成帧。
 */

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import type { Version } from '../contracts/generated/Version.js';
import { StubCore, type StubCoreOptions } from './stub.js';

/** [`runStubServerOnStdio`] 的选项（= [`StubCoreOptions`] 去掉 `emit`）。 */
export type StubServerOptions = Omit<StubCoreOptions, 'emit'>;

/**
 * 跑一个 stdio 桩服务端，直到 stdin 结束。
 *
 * 返回创建好的 [`StubCore`]（测试里可忽略；命令行入口用不到）。
 */
export function runStubServerOnStdio(options: StubServerOptions = {}): StubCore {
  const core = new StubCore({
    ...options,
    emit: (line: string) => {
      // 一帧一次 write：这就是 Node 里 "flush" 的等价物（管道直通，无用户态缓冲）。
      process.stdout.write(`${line}\n`);
    },
  });

  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
  reader.on('line', (line: string) => {
    core.handleLine(line);
    if (core.violated) {
      // 设计 §4.4 第 4 条：回错误并**关闭连接**（不静默忽略）。
      // 这里先停止读入；真正的退出发生在对端关掉 stdin 之后，
      // 这样刚写出的那一条错误帧**一定**已经交给操作系统（不会被 exit 吞掉）。
      reader.close();
      process.stdin.pause();
    }
  });
  reader.on('close', () => {
    core.dispose();
  });
  process.stdin.on('end', () => {
    core.dispose();
  });
  return core;
}

/** 解析命令行参数（未知参数**报错**，不静默忽略 —— 打错字必须看得见）。 */
export function parseStubServerArgs(argv: readonly string[]): StubServerOptions {
  const options: StubServerOptions = {};
  let serverVersion: Version | undefined;
  let ackVersion: Version | undefined;
  for (const arg of argv) {
    const [flag, rawValue] = splitFlag(arg);
    switch (flag) {
      case '--result-delay-ms':
        options.resultDelayMs = requireInteger(flag, rawValue);
        break;
      case '--major':
        serverVersion = withPart(serverVersion, 'major', requireInteger(flag, rawValue));
        break;
      case '--minor':
        serverVersion = withPart(serverVersion, 'minor', requireInteger(flag, rawValue));
        break;
      case '--patch':
        serverVersion = withPart(serverVersion, 'patch', requireInteger(flag, rawValue));
        break;
      case '--ack-version':
        ackVersion = parseVersion(rawValue);
        break;
      case '--capabilities':
        options.knownCapabilities = rawValue === '' ? [] : rawValue.split(',').filter((x) => x !== '');
        break;
      case '--no-progress':
        options.emitProgress = false;
        break;
      default:
        throw new Error(`未知参数：${arg}（见 src/rpc/stub-server.ts 的用法说明）`);
    }
  }
  if (serverVersion !== undefined) options.serverVersion = serverVersion;
  if (ackVersion !== undefined) options.handshakeAckVersion = ackVersion;
  return options;
}

function splitFlag(arg: string): [string, string] {
  const index = arg.indexOf('=');
  if (index < 0) return [arg, ''];
  return [arg.slice(0, index), arg.slice(index + 1)];
}

function requireInteger(flag: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${flag} 需要一个整数，实际是 ${JSON.stringify(raw)}`);
  return value;
}

function withPart(
  version: Version | undefined,
  part: 'major' | 'minor' | 'patch',
  value: number,
): Version {
  const base: Version = version ?? { major: 1, minor: 0, patch: 0 };
  return { ...base, [part]: value };
}

function parseVersion(raw: string): Version {
  const parts = raw.split('.');
  if (parts.length !== 3) throw new Error(`--ack-version 需要 \`主.次.补\` 三段，实际是 ${JSON.stringify(raw)}`);
  const [major, minor, patch] = parts;
  return {
    major: requireInteger('--ack-version', major ?? ''),
    minor: requireInteger('--ack-version', minor ?? ''),
    patch: requireInteger('--ack-version', patch ?? ''),
  };
}

// 直接以本文件为入口运行时才启动（被 import 时**不**碰 stdin）。
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  try {
    runStubServerOnStdio(parseStubServerArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[stub-server] 启动失败：${String(error)}\n`);
    process.exitCode = 2;
  }
}
