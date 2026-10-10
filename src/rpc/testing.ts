/**
 * 测试与集成用的组合件：把客户端接在内存桩上，一处收尾。
 *
 * 存在的理由：任何"内存桩 + 客户端"的用例都需要同样的四步接线
 * （造传输对、接桩的输出、记录服务端收到的行、造客户端）。
 * 抄四遍必然漂移，而漂移的形态是"某条测试量的其实是接线而不是协议"。
 */

import { RpcClient, type RpcClientOptions } from './client.js';
import { StubCore, type StubCoreOptions } from './stub.js';
import { createMemoryTransportPair, type MemoryTransportPair } from './transport.js';

/** [`createStubPair`] 的选项：桩的选项（`emit` 由本函数接管）+ 客户端的选项。 */
export type StubPairOptions = Omit<StubCoreOptions, 'emit'> & RpcClientOptions;

/** 一对已接好线的"客户端 ↔ 桩服务端"。 */
export interface StubPair {
  /** 客户端。 */
  readonly client: RpcClient;
  /** 桩服务端内核。 */
  readonly stub: StubCore;
  /** 底层内存传输对（要注入畸形帧时直接用 `pair.server.writeLine`）。 */
  readonly pair: MemoryTransportPair;
  /** 桩收到过的**原始行**（断言"请求里到底有什么"用，例如 `id` 是否在场）。 */
  readonly receivedLines: readonly string[];
  /** 停掉桩的定时器并关闭连接（幂等；每个用例结尾都应调用）。 */
  dispose(): void;
}

/**
 * 造一对已接好线的客户端与桩服务端。
 *
 * 注意：这里**不**自动握手 —— 握手是用例自己要断言的行为
 * （包括"握手前调用其它方法必须被拒"那条负向证明）。
 */
export function createStubPair(options: StubPairOptions = {}): StubPair {
  const pair = createMemoryTransportPair();
  const receivedLines: string[] = [];
  const stub = new StubCore({
    ...options,
    emit: (line: string) => {
      // 客户端可能已经关闭（例如 shutdown 之后）：那时写帧会抛，
      // 而抛在定时器里会变成未捕获异常 —— 所以这里显式挡一次。
      if (!pair.server.closed) pair.server.writeLine(line);
    },
  });
  pair.server.onLine((line: string) => {
    receivedLines.push(line);
    stub.handleLine(line);
  });
  const client = new RpcClient(pair.client, options);
  return {
    client,
    stub,
    pair,
    receivedLines,
    dispose(): void {
      stub.dispose();
      client.close('用例收尾');
    },
  };
}
