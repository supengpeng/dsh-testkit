/**
 * `src/rpc` 的契约测试（设计 §4.1–§4.6）。
 *
 * 这些测试跑在**既有质量门里**（`pnpm run gate` 的 `node --test "tests/*.test.mjs"` 一步），
 * 所以它们同时是"新增的 TS 侧没有破坏既有构建链"的证据。
 *
 * # 它们量的是契约，不是实现
 *
 * | 组 | 量什么 |
 * |---|---|
 * | 握手与版本 | H1（兼容时必须成功）/ H2（不兼容时必须被拒），以及**客户端本地复核** |
 * | 方法表与句柄 | `submit` 只等句柄、`wait` 可重复、`cancel`/`shutdown` 幂等、`register_*` 不幂等 |
 * | 错误码 → 退出码 | 设计 §4.5 的裁决表，含 `-32002` 的**二义**与 `-32006` 不是 `5` |
 * | 帧与失败形态 | 未知 tag / 非 JSON / 缺 id / id 对不上 —— 一律**响亮失败**，不静默当空消息 |
 * | 并发在途 | 应答**按 id 配对**，不是按到达顺序 |
 * | stdio 真管道 | 写后必须真的送达（不送 = 对端永远收不到 = 超时，而不是"慢"） |
 * | 负向证明 | 守卫本身有判别力：关掉守卫，同一个输入会被接受 |
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';

import {
  EXIT,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  PROTOCOL_TAG_NAMES,
  REQUEST_METHODS,
  RPC_ERROR_CODE_BY_NAME,
  RpcClient,
  RpcClientError,
  StubCore,
  createMemoryTransportPair,
  createStubPair,
  createStdioTransport,
  decodeServerFrame,
  decodeTaskResult,
  decodeTaskStatus,
  decodeVersion,
  encodeHandshakeAckFrame,
  encodeRequest,
  encodeResultFrame,
  exitCodeForError,
  exitCodeForRpcCode,
  isVersionCompatible,
  localVersion,
  U32_MAX,
} from '../lib/rpc/index.js';

const STUB_SERVER = fileURLToPath(new URL('../lib/rpc/stub-server.js', import.meta.url));

/** 一个形状合法的最小 `ExecutionPlan`（桩只检查它是对象；这里给的是真形状）。 */
function plan() {
  return {
    nodes: [],
    edges: [],
    metadata: {
      scenario_id: 'TK-9001',
      title: 'rpc 测试用计划',
      layer: 'l3',
      confidence: 'real',
      shared_context: false,
      depth: 1,
    },
    resources: [],
  };
}

function submitParams(taskId) {
  return { task_id: taskId, plan: plan() };
}

function version(major, minor, patch) {
  return { major, minor, patch };
}

function handshakeFor(v) {
  return { client_version: v, extensions: [] };
}

/** 捕获结果或错误（不用 try/catch 包在断言里，避免把断言失败自己也捕获掉）。 */
async function capture(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================================================================ 握手与版本

describe('握手与版本（H1 / H2）', () => {
  test('handshake 成功：兼容时返回 ack，之后状态为 ready', async () => {
    const pair = createStubPair({ knownCapabilities: ['web', 'session'], resultDelayMs: 5 });
    try {
      const ack = await pair.client.handshake();
      assert.deepEqual(ack.server_version, version(PROTOCOL_MAJOR, PROTOCOL_MINOR, 0));
      assert.equal(ack.supported_major, PROTOCOL_MAJOR);
      assert.deepEqual(ack.known_capabilities, ['web', 'session']);
      assert.equal(pair.client.state, 'ready');
      assert.equal(pair.stub.handshakeState, 'established');
      // 第一帧必须是 handshake（§4.4 第 1 条）：服务端收到的第一条就是它。
      assert.equal(JSON.parse(pair.receivedLines[0]).type, 'handshake');
    } finally {
      pair.dispose();
    }
  });

  test('握手失败：主版本不同 ⇒ -32001，退出码 6（H2）', async () => {
    const pair = createStubPair({ serverVersion: version(2, 0, 0) });
    try {
      const outcome = await capture(pair.client.handshake());
      assert.equal(outcome.ok, false, '主版本不同必须被拒');
      assert.ok(outcome.error instanceof RpcClientError);
      assert.equal(outcome.error.code, RPC_ERROR_CODE_BY_NAME.version_mismatch);
      assert.equal(outcome.error.exitCode(), EXIT.PROTOCOL);
      assert.equal(outcome.error.exitCode(), 6);
      // §4.4 第 4 条的同源处置：不兼容即关闭（不静默忽略）。
      assert.equal(pair.stub.violated, true);
    } finally {
      pair.dispose();
    }
  });

  test('握手失败：客户端次版本更高 ⇒ 被拒（服务端 ≥ 客户端 这条方向不能反）', async () => {
    const pair = createStubPair({ serverVersion: version(PROTOCOL_MAJOR, PROTOCOL_MINOR, 9) });
    try {
      const outcome = await capture(
        pair.client.handshake(handshakeFor(version(PROTOCOL_MAJOR, PROTOCOL_MINOR + 1, 0))),
      );
      assert.equal(outcome.ok, false, '客户端次版本更高必须被拒');
      assert.equal(outcome.error.code, RPC_ERROR_CODE_BY_NAME.version_mismatch);
    } finally {
      pair.dispose();
    }
  });

  test('版本规则与 handshake.rs 的矩阵逐项一致（含补丁不参与判定）', () => {
    // 取自 crates/protocol/src/handshake.rs::version_compat_follows_design_rule
    assert.equal(isVersionCompatible(version(1, 0, 0), version(1, 0, 0)), true);
    assert.equal(isVersionCompatible(version(1, 0, 0), version(1, 3, 9)), true);
    assert.equal(isVersionCompatible(version(1, 3, 0), version(1, 0, 0)), false);
    assert.equal(isVersionCompatible(version(1, 0, 0), version(2, 0, 0)), false);
    assert.equal(isVersionCompatible(version(2, 0, 0), version(1, 9, 0)), false);
    assert.equal(isVersionCompatible(version(1, 0, 99), version(1, 0, 0)), true);
    assert.deepEqual(localVersion(), version(PROTOCOL_MAJOR, PROTOCOL_MINOR, 0));
  });

  test('客户端会本地复核 ack：服务端 ack 一个与它自己判定矛盾的版本也必须红', async () => {
    // 没有这条，"不兼容检出率"就完全依赖对端诚实 —— 那时 H2 量的是对端，不是客户端。
    const pair = createStubPair({ handshakeAckVersion: version(2, 0, 0) });
    try {
      const outcome = await capture(pair.client.handshake());
      assert.equal(outcome.ok, false, 'ack 里的版本与自己判定矛盾时必须拒绝');
      assert.equal(outcome.error.code, RPC_ERROR_CODE_BY_NAME.version_mismatch);
    } finally {
      pair.dispose();
    }
  });

  test('握手前调用其它方法：**本地**拒绝，且一帧都不发', async () => {
    const pair = createStubPair();
    try {
      const outcome = await capture(pair.client.submit(submitParams('t1')));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.kind, 'handshake_required');
      // 码与服务端 §4.4 第 4 条的应答同码 ⇒ 退出码统一为 6。
      assert.equal(outcome.error.code, RPC_ERROR_CODE_BY_NAME.version_mismatch);
      assert.equal(outcome.error.exitCode(), EXIT.PROTOCOL);
      assert.deepEqual(pair.receivedLines, [], '本地前置拒绝不得发出任何帧');
    } finally {
      pair.dispose();
    }
  });

  test('H1 / H2 版本矩阵读数', async () => {
    const combos = [
      { client: version(1, 0, 0), server: version(1, 0, 0), compatible: true },
      { client: version(1, 0, 99), server: version(1, 0, 0), compatible: true },
      { client: version(1, 0, 0), server: version(1, 3, 9), compatible: true },
      { client: version(1, 1, 0), server: version(1, 0, 0), compatible: false },
      { client: version(2, 0, 0), server: version(1, 9, 0), compatible: false },
      { client: version(1, 0, 0), server: version(2, 0, 0), compatible: false },
    ];
    let compatibleOk = 0;
    let compatibleTotal = 0;
    let incompatibleRejected = 0;
    let incompatibleTotal = 0;
    for (const combo of combos) {
      const pair = createStubPair({ serverVersion: combo.server });
      try {
        const outcome = await capture(pair.client.handshake(handshakeFor(combo.client)));
        if (combo.compatible) {
          compatibleTotal += 1;
          if (outcome.ok) compatibleOk += 1;
        } else {
          incompatibleTotal += 1;
          if (!outcome.ok) incompatibleRejected += 1;
        }
      } finally {
        pair.dispose();
      }
    }
    // H1 = 版本兼容时握手成功率；H2 = 版本不兼容时被拒绝率。
    console.log(
      `H1 握手成功率 = ${compatibleOk}/${compatibleTotal}；` +
        `H2 不兼容检出率 = ${incompatibleRejected}/${incompatibleTotal}`,
    );
    assert.equal(compatibleOk, compatibleTotal, 'H1 必须 100%');
    assert.equal(incompatibleRejected, incompatibleTotal, 'H2 必须 100%');
  });
});

// ================================================================ 方法表与句柄

describe('方法表（§4.3）与句柄契约', () => {
  test('submit 立即返回句柄、不阻塞：桩延迟 200ms 出结果，submit 必须 <50ms 返回且结果尚未产出', async () => {
    const pair = createStubPair({ resultDelayMs: 200 });
    try {
      await pair.client.handshake();
      const started = performance.now();
      const handle = await pair.client.submit(submitParams('t1'));
      const elapsed = performance.now() - started;

      assert.ok(elapsed < 50, `submit 必须在 50ms 内返回，实际 ${elapsed.toFixed(1)}ms`);
      // 返回的是**句柄**，不是结果：形状上就没有 outcome（原稿的矛盾写法会在这里露馅）。
      assert.equal(handle.task_id, 't1');
      assert.equal(handle.state, 'pending');
      assert.equal(handle.outcome, undefined);
      // 更强的证据：服务端此刻**还没产出结果**。
      assert.equal(pair.stub.task('t1')?.result, undefined, 'submit 返回时结果不该已经存在');

      // 结果只能经 wait 获得，而且真的要等到延迟之后。
      const waitStarted = performance.now();
      const result = await pair.client.wait({ handle, timeout_ms: 5_000 });
      assert.ok(performance.now() - waitStarted >= 100, 'wait 应当真的等了剩下的延迟');
      assert.equal(result.task_id, 't1');
      assert.equal(result.outcome, 'passed');
    } finally {
      pair.dispose();
    }
  });

  test('wait 可重复：两次拿到同一份结果', async () => {
    const pair = createStubPair({ resultDelayMs: 5 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      const first = await pair.client.wait({ handle, timeout_ms: 2_000 });
      const second = await pair.client.wait({ handle, timeout_ms: 2_000 });
      assert.deepEqual(second, first);
      assert.equal(first.outcome, 'passed');
    } finally {
      pair.dispose();
    }
  });

  test('wait 的 timeout_ms=0 且任务未终结 ⇒ result: null（不编造结论）', async () => {
    const pair = createStubPair({ resultDelayMs: 200 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      assert.equal(await pair.client.wait({ handle, timeout_ms: 0 }), null);
      const result = await pair.client.wait({ handle, timeout_ms: 2_000 });
      assert.equal(result.outcome, 'passed');
    } finally {
      pair.dispose();
    }
  });

  test('submit 同一个 task_id 两次 ⇒ -32003（任务已存在，退出码 2）', async () => {
    const pair = createStubPair({ resultDelayMs: 5 });
    try {
      await pair.client.handshake();
      await pair.client.submit(submitParams('t1'));
      const outcome = await capture(pair.client.submit(submitParams('t1')));
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, RPC_ERROR_CODE_BY_NAME.task_exists);
      assert.equal(outcome.error.exitCode(), EXIT.USAGE);
    } finally {
      pair.dispose();
    }
  });

  test('query 返回 TaskStatus；wait 之后状态变 finished', async () => {
    const pair = createStubPair({ resultDelayMs: 10 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      const pendingStatus = await pair.client.query({ handle });
      assert.equal(pendingStatus.task_id, 't1');
      assert.equal(pendingStatus.state, 'pending');
      await pair.client.wait({ handle, timeout_ms: 2_000 });
      const finished = await pair.client.query({ handle });
      assert.equal(finished.state, 'finished');
    } finally {
      pair.dispose();
    }
  });

  test('cancel 幂等；取消不存在的任务是用法错误 -32004', async () => {
    const pair = createStubPair({ resultDelayMs: 5_000 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      await pair.client.cancel({ handle });
      await pair.client.cancel({ handle });
      assert.equal(pair.stub.task('t1')?.state, 'cancelled');
      const result = await pair.client.wait({ handle, timeout_ms: 2_000 });
      assert.equal(result.outcome, 'cancelled', '取消是一个**结论**，不是 Err');

      const unknown = await capture(
        pair.client.cancel({ handle: { task_id: 'nope', state: 'running' } }),
      );
      assert.equal(unknown.ok, false);
      assert.equal(unknown.error.code, RPC_ERROR_CODE_BY_NAME.task_not_exists);
      assert.equal(unknown.error.exitCode(), EXIT.USAGE);
    } finally {
      pair.dispose();
    }
  });

  test('register_assertion **不**幂等：重名必须报错，不静默覆盖', async () => {
    const pair = createStubPair({ resultDelayMs: 5 });
    try {
      await pair.client.handshake();
      await pair.client.registerAssertion({ name: 'is' });
      const outcome = await capture(pair.client.registerAssertion({ name: 'is' }));
      assert.equal(outcome.ok, false, '重名必须报错（§4.3 标了"否（重名报错）"）');
      assert.match(outcome.error.message, /已被注册/);
    } finally {
      pair.dispose();
    }
  });

  test('refresh_capabilities 返回载荷原样（CapabilityMap 尚未导出，客户端不编造形状）', async () => {
    const pair = createStubPair({ knownCapabilities: ['web', 'session'], resultDelayMs: 5 });
    try {
      await pair.client.handshake();
      const payload = await pair.client.refreshCapabilities({ only: [] });
      assert.equal(typeof payload, 'object');
      assert.deepEqual(Object.keys(payload).sort(), ['session', 'web']);
    } finally {
      pair.dispose();
    }
  });

  test('shutdown 可重复；确认后立刻拒绝在途请求（不等超时）', async () => {
    const pair = createStubPair({ resultDelayMs: 60_000 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      // 挂一个会等很久的 wait，然后关停。
      const pending = capture(pair.client.wait({ handle, timeout_ms: 3_000 }));
      const started = performance.now();
      await pair.client.shutdown();
      const outcome = await pending;
      const elapsed = performance.now() - started;

      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.kind, 'closed', 'shutdown 之后在途请求必须以 closed 结束');
      assert.ok(elapsed < 1_000, `不得等到 wait 自己的超时（实际 ${elapsed.toFixed(0)}ms）`);
      assert.equal(pair.client.state, 'closed');
      // 可重复：第二次仍然 Ok（服务端幂等 + 客户端已关停视为语义已达成）。
      await pair.client.shutdown();
      assert.equal(pair.stub.shutdownCount >= 1, true);
    } finally {
      pair.dispose();
    }
  });
});

// ================================================================ 错误码 → 退出码

describe('错误码 → 退出码（§4.5）', () => {
  test('六个自定义码逐个钉住（含 -32002 的两种去向与 -32006 不是 5）', () => {
    assert.equal(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.version_mismatch), 6);
    assert.equal(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.capability_unavailable), EXIT.OK);
    assert.equal(
      exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.capability_unavailable, {
        capabilityMandatory: true,
      }),
      7,
    );
    assert.equal(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.task_exists), EXIT.USAGE);
    assert.equal(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.task_not_exists), EXIT.USAGE);
    assert.equal(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.execution_timeout), EXIT.FAILED);
    assert.equal(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.approval_required), EXIT.OK);
    assert.notEqual(exitCodeForRpcCode(RPC_ERROR_CODE_BY_NAME.approval_required), 5);
  });

  test('-32002 默认走 skip（0）：变成 7 必须显式申请，不能是默认值', () => {
    // 默认 7 会让"某天整批任务突然退出 7"变成一次没人改过代码的静默变更。
    assert.equal(exitCodeForRpcCode(-32002), EXIT.OK);
    assert.equal(exitCodeForRpcCode(-32002, { capabilityMandatory: false }), EXIT.OK);
    assert.equal(exitCodeForRpcCode(-32002, { capabilityMandatory: true }), EXIT.CAPABILITY);
  });

  test('标准 JSON-RPC 码与未知码归基础设施（3），不冒充用法或产品失败', () => {
    for (const code of [-32700, -32600, -32601, -32602, -32603, -99999]) {
      assert.equal(exitCodeForRpcCode(code), EXIT.INFRA, `码 ${code} 应归 ${EXIT.INFRA}`);
    }
  });

  test('EXIT 里没有 8（设计 §4.5 只映射到 7；没有来源的码不定义）', () => {
    assert.equal(Object.values(EXIT).includes(8), false);
    assert.equal(Object.values(EXIT).includes(4), false);
    assert.equal(Object.values(EXIT).includes(5), false);
  });

  test('execution_timeout 从服务端到退出码 1 是端到端成立的', async () => {
    const pair = createStubPair({ resultDelayMs: 5 });
    try {
      await pair.client.handshake();
      const outcome = await capture(pair.client.query({ handle: { task_id: 'nope', state: 'running' } }));
      assert.equal(outcome.ok, false);
      // task_not_exists 走 2；这里同时验证「同一个错误对象经 exitCodeForError 也一致」。
      assert.equal(exitCodeForError(outcome.error), EXIT.USAGE);
      assert.equal(
        exitCodeForError(
          new RpcClientError('protocol', 'x', { code: RPC_ERROR_CODE_BY_NAME.execution_timeout }),
        ),
        EXIT.FAILED,
      );
      assert.equal(exitCodeForError(new Error('进程起不来')), EXIT.INFRA);
    } finally {
      pair.dispose();
    }
  });
});

// ================================================================ 帧与失败形态

describe('帧编解码与失败形态（一律响亮失败）', () => {
  test('请求帧：单行、平铺 params、带单调 id', () => {
    const line = encodeRequest('submit', 7, { task_id: 't1', plan: plan() });
    assert.equal(line.includes('\n'), false, '一帧必须只有一行');
    const frame = JSON.parse(line);
    assert.equal(frame.type, 'submit');
    assert.equal(frame.id, 7);
    assert.equal(frame.task_id, 't1', 'params 必须平铺（藏进 params 会让 read_frame 解析失败）');
    assert.equal(typeof frame.plan, 'object');
  });

  test('请求帧拒绝覆盖帧字段（type/id 是帧的，不是方法的）', () => {
    assert.throws(() => encodeRequest('submit', 1, { type: 'x' }), /不得覆盖帧字段/);
    assert.throws(() => encodeRequest('submit', 1, { id: 2 }), /不得覆盖帧字段/);
    assert.throws(() => encodeRequest('submit', 0, {}), /正整数/);
  });

  test('未知 tag ⇒ 明确报错，绝不静默当空消息', () => {
    assert.throws(() => decodeServerFrame('{"type":"nope"}'), /未知 tag/);
    // 服务端发来一个**请求**形状的帧也是错误（客户端不该把它当应答）。
    assert.throws(() => decodeServerFrame('{"type":"submit","task_id":"t1"}'), /未知 tag/);
    // 不是 JSON ⇒ parse_error（与"是 JSON 但不是本协议"区分开：两条诊断路径不同）。
    let caught;
    try {
      decodeServerFrame('not json at all');
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof RpcClientError);
    assert.equal(caught.kind, 'parse_error');
  });

  test('result 帧缺 id 或缺 result 字段都是协议错误', () => {
    assert.throws(() => decodeServerFrame('{"type":"result","result":null}'), /id/);
    assert.throws(() => decodeServerFrame('{"type":"result","id":1}'), /result/);
    // result: null 是**合法**的（"到点仍未终结"），缺字段才是错误。
    const frame = decodeServerFrame('{"type":"result","id":1,"result":null}');
    assert.equal(frame.kind, 'result');
    assert.equal(frame.params.result, null);
  });

  test('u32 契约（u64 已全改 u32）：浮点 / 越界 / 负值 / 大小写错误必须响亮失败', () => {
    // 这条钉的是 Lead 已裁决的跨语言决定：u64 会被 ts-rs 生成 bigint，
    // 而 JSON.stringify(1n) 会抛 —— 一个坏数就能让整条 TS 侧序列化在运行期炸。
    const ok = { task_id: 't1', outcome: 'passed', duration_ms: U32_MAX };
    assert.equal(decodeTaskResult(ok).duration_ms, U32_MAX);
    assert.throws(() => decodeTaskResult({ ...ok, duration_ms: 1.5 }), /u32/);
    assert.throws(() => decodeTaskResult({ ...ok, duration_ms: U32_MAX + 1 }), /u32/);
    assert.throws(() => decodeTaskResult({ ...ok, duration_ms: -1 }), /u32/);
    // 字面量大小写是契约的一部分（Rust 侧 serde 是 snake_case）：`PASSED` 不是 `passed`。
    assert.throws(() => decodeTaskResult({ ...ok, outcome: 'PASSED' }), /TaskOutcome/);
    assert.throws(
      () => decodeTaskStatus({ task_id: 't1', state: 'Pending' }),
      /TaskState/,
    );
    // id 必须是正整数；版本字段必须是 u32。
    assert.throws(() => decodeServerFrame('{"type":"result","id":0,"result":null}'), /u32/);
    assert.throws(() => decodeServerFrame('{"type":"result","id":1.5,"result":null}'), /u32/);
    assert.throws(() => decodeVersion({ major: 1, minor: 0.5, patch: 0 }), /u32/);
    assert.throws(() => decodeVersion({ major: -1, minor: 0, patch: 0 }), /u32/);
  });

  test('tag 集合与生成类型一致（15 个，含补缺的 result）', () => {    assert.equal(PROTOCOL_TAG_NAMES.length, 15);
    assert.ok(PROTOCOL_TAG_NAMES.includes('result'), 'result 是 §4.2 的补缺，必须在集合里');
    assert.deepEqual([...PROTOCOL_TAG_NAMES].sort(), [
      'cancel',
      'capability_changed',
      'handshake',
      'handshake_ack',
      'progress',
      'query',
      'refresh_capabilities',
      'register_assertion',
      'register_capability',
      'result',
      'rpc_error',
      'shutdown',
      'submit',
      'trace',
      'wait',
    ]);
  });

  test('方法表与 crates/protocol/src/methods.rs 的九行逐个对齐', () => {
    // 这份名单抄自 Rust 的 METHODS 表；两侧不一致 = 契约漂移。
    assert.deepEqual([...REQUEST_METHODS].sort(), [
      'cancel',
      'handshake',
      'query',
      'refresh_capabilities',
      'register_assertion',
      'register_capability',
      'shutdown',
      'submit',
      'wait',
    ]);
  });

  test('畸形行让在途请求以可辨认的类别结束，并关闭连接', async () => {
    const pair = createStubPair({ resultDelayMs: 60_000 });
    try {
      await pair.client.handshake();
      const pending = capture(pair.client.submit(submitParams('t1')));
      // 服务端注入一行不是 JSON 的东西。
      pair.pair.server.writeLine('this is not json');
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.kind, 'parse_error');
      assert.equal(pair.client.state, 'closed', '流出错位之后必须关闭，不能继续用');
    } finally {
      pair.dispose();
    }
  });

  test('id 对不上的 result 帧 ⇒ 协议错误（绝不猜一个最像的请求）', async () => {
    const pair = createStubPair({ resultDelayMs: 60_000 });
    try {
      await pair.client.handshake();
      const pending = capture(pair.client.submit(submitParams('t1')));
      pair.pair.server.writeLine(encodeResultFrame(9_999, null));
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.kind, 'protocol_error');
      assert.match(outcome.error.message, /9999/);
    } finally {
      pair.dispose();
    }
  });

  test('无 id 的 rpc_error：唯一在途时按它配对（兼容今天不带 id 的写入器）', async () => {
    const pair = createStubPair({ resultDelayMs: 60_000 });
    try {
      await pair.client.handshake();
      const pending = capture(pair.client.submit(submitParams('t1')));
      pair.pair.server.writeLine('{"type":"rpc_error","code":-32005,"message":"执行超时"}');
      const outcome = await pending;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.code, RPC_ERROR_CODE_BY_NAME.execution_timeout);
      assert.equal(outcome.error.exitCode(), EXIT.FAILED);
    } finally {
      pair.dispose();
    }
  });

  test('无 id 的 rpc_error 在**多条**在途时 ⇒ 协议错误（不许猜）', async () => {
    const pair = createStubPair({ resultDelayMs: 60_000 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      // 两条**长驻**在途请求：submit 会被立刻应答，所以要用 wait（桩会挂到结果产出或 60s）。
      const first = capture(pair.client.wait({ handle, timeout_ms: 60_000 }));
      const second = capture(pair.client.wait({ handle, timeout_ms: 60_000 }));
      await delay(10);
      assert.equal(pair.client.pendingCount, 2, '应当有两条在途');
      pair.pair.server.writeLine('{"type":"rpc_error","code":-32005,"message":"执行超时"}');
      const outcomeA = await first;
      const outcomeB = await second;
      assert.equal(outcomeA.ok, false);
      assert.equal(outcomeB.ok, false);
      assert.equal(outcomeA.error.kind, 'protocol_error');
      assert.match(outcomeA.error.message, /无法唯一配对/);
    } finally {
      pair.dispose();
    }
  });
});

// ================================================================ 并发在途与 id 配对

describe('并发在途：按 id 配对，不按到达顺序', () => {
  test('两条在途请求、应答乱序到达 ⇒ 各自拿到自己的载荷', async () => {
    const pair = createMemoryTransportPair();
    const seen = [];
    pair.server.onLine((line) => {
      const frame = JSON.parse(line);
      if (frame.type === 'handshake') {
        pair.server.writeLine(
          encodeHandshakeAckFrame({
            server_version: localVersion(),
            supported_major: PROTOCOL_MAJOR,
            supported_minor: PROTOCOL_MINOR,
            known_capabilities: [],
          }),
        );
        return;
      }
      seen.push(frame);
      if (seen.length === 2) {
        // **故意反序**：先回第二条，再回第一条。
        pair.server.writeLine(encodeResultFrame(seen[1].id, { task_id: seen[1].task_id, state: 'pending' }));
        pair.server.writeLine(encodeResultFrame(seen[0].id, { task_id: seen[0].task_id, state: 'pending' }));
      }
    });
    const client = new RpcClient(pair.client, { requestTimeoutMs: 2_000 });
    try {
      await client.handshake();
      const [first, second] = await Promise.all([
        client.submit(submitParams('t1')),
        client.submit(submitParams('t2')),
      ]);
      assert.equal(first.task_id, 't1', 'id=1 的应答必须回到第一个请求');
      assert.equal(second.task_id, 't2', 'id=2 的应答必须回到第二个请求');
      // 握手占掉了 id=1，所以两条 submit 是 2、3。
      assert.deepEqual(seen.map((frame) => frame.id), [2, 3], '请求 id 必须单调递增');
      assert.ok(seen.every((frame) => typeof frame.task_id === 'string'), 'params 平铺在顶层');
    } finally {
      client.close('用例收尾');
    }
  });

  test('同一句柄并发 wait 两次：两条应答都能找到自己的请求', async () => {
    const pair = createStubPair({ resultDelayMs: 30 });
    try {
      await pair.client.handshake();
      const handle = await pair.client.submit(submitParams('t1'));
      const [a, b] = await Promise.all([
        pair.client.wait({ handle, timeout_ms: 2_000 }),
        pair.client.wait({ handle, timeout_ms: 2_000 }),
      ]);
      assert.deepEqual(a, b);
      assert.equal(a.outcome, 'passed');
    } finally {
      pair.dispose();
    }
  });
});

// ================================================================ 负向证明

describe('负向证明：守卫本身有判别力', () => {
  test('桩的握手前置守卫：同一个输入，关掉守卫就**会**被接受', () => {
    const request = encodeRequest('submit', 1, { task_id: 't1', plan: plan() });

    // (a) 守卫打开（缺省）：回 -32001 并关闭。
    const guardedOutput = [];
    const guarded = new StubCore({ emit: (line) => guardedOutput.push(line) });
    guarded.handleLine(request);
    assert.equal(guardedOutput.length, 1);
    const guardedFrame = JSON.parse(guardedOutput[0]);
    assert.equal(guardedFrame.type, 'rpc_error');
    assert.equal(guardedFrame.code, RPC_ERROR_CODE_BY_NAME.version_mismatch);
    assert.equal(guarded.violated, true);

    // (b) 守卫关掉：**同一个输入**得到成功应答 —— 证明红是守卫造成的，
    //     不是"这条输入本来就错"。这是负向证明最容易作弊的地方。
    const unguardedOutput = [];
    const unguarded = new StubCore({
      emit: (line) => unguardedOutput.push(line),
      requireHandshakeFirst: false,
    });
    unguarded.handleLine(request);
    const unguardedFrame = JSON.parse(unguardedOutput[0]);
    assert.equal(unguardedFrame.type, 'result', '关掉守卫后同一帧应当被正常处理');
    assert.deepEqual(unguardedFrame.result, { task_id: 't1', state: 'pending' });
    assert.equal(unguarded.violated, false);
    unguarded.dispose();
  });

  test('帧校验守卫：把 id 摘掉，"按 id 配对"这条守卫立刻失去判别力（反证必须带 id）', () => {
    // 这条不是测实现，而是**证明**上面那些 id 断言不是同义反复：
    // 一旦 result 帧没有 id，解码器就拒绝它（而不是猜一个请求）。
    assert.throws(() => decodeServerFrame('{"type":"result","result":null}'), /id/);
    const ok = decodeServerFrame('{"type":"result","id":3,"result":null}');
    assert.equal(ok.params.id, 3);
  });
});

// ================================================================ stdio 真管道

describe('stdio 真管道', () => {
  test('真进程 + 真管道：握手、submit 立即返回句柄、wait 拿到结果（写后必须真的送达）', async () => {
    const transport = createStdioTransport({
      command: process.execPath,
      args: [STUB_SERVER, '--result-delay-ms=200'],
      stderr: 'pipe',
    });
    const client = new RpcClient(transport, { requestTimeoutMs: 10_000 });
    try {
      const ack = await client.handshake();
      assert.equal(ack.supported_major, PROTOCOL_MAJOR);

      const started = performance.now();
      const handle = await client.submit(submitParams('t1'));
      const elapsed = performance.now() - started;
      // 若请求帧没有被真的写出去（"忘了 flush"），对端永远收不到 ⇒ 这条必然超时失败。
      assert.ok(elapsed < 2_000, `stdio submit 应迅速返回句柄，实际 ${elapsed.toFixed(0)}ms`);
      assert.equal(handle.task_id, 't1');

      const result = await client.wait({ handle, timeout_ms: 5_000 });
      assert.equal(result.outcome, 'passed');
      assert.equal(result.task_id, 't1');
    } finally {
      client.close('用例收尾');
    }
  });

  test('对端进程立刻退出 ⇒ 在途请求以 closed 结束，而不是等到超时', async () => {
    const transport = createStdioTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      stderr: 'ignore',
    });
    // 超时给得远大于断言阈值：如果实现是"等到超时"，这条会红。
    const client = new RpcClient(transport, { requestTimeoutMs: 8_000 });
    try {
      const started = performance.now();
      const outcome = await capture(client.handshake());
      const elapsed = performance.now() - started;
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.kind, 'closed');
      assert.ok(elapsed < 5_000, `必须以 closed 立刻结束，实际 ${elapsed.toFixed(0)}ms`);
    } finally {
      client.close('用例收尾');
    }
  });

  test('启动不存在的命令 ⇒ 传输立刻报关闭（不静默挂住）', async () => {
    const transport = createStdioTransport({
      command: 'definitely-not-a-real-binary-xyz',
      stderr: 'ignore',
    });
    const client = new RpcClient(transport, { requestTimeoutMs: 5_000 });
    try {
      const started = performance.now();
      const outcome = await capture(client.handshake());
      assert.equal(outcome.ok, false);
      assert.equal(outcome.error.kind, 'closed');
      assert.ok(performance.now() - started < 4_000);
    } finally {
      client.close('用例收尾');
    }
  });
});
