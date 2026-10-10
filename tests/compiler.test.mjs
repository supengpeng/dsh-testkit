/**
 * 场景编译器测试（设计 §5.2 的四阶段与 §5.1 的硬规则）。
 *
 * 这些测试跑在**既有质量门里**（`pnpm run gate` 的 `node --test "tests/*.test.mjs"` 一步），
 * 所以它们同时也是"新增的 TS 侧没有破坏既有构建链"的证据。
 *
 * 覆盖的是**可判定的行为**，不是实现细节：
 * 边、剪枝可见性、白名单、展开数、环检出、深度上限、以及**同输入同输出**。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DslError,
  dependsOn,
  largeScenario,
  matrix,
  parallel,
  ref,
  retry,
  scenario,
  seq,
  setup,
  when,
} from '../lib/dsl/nodes.js';
import { CompileError, MAX_SCENARIO_DEPTH, compileScenario } from '../lib/compiler/index.js';

/** 一个最小的工具叶子。 */
function tool(name, input = {}, extra = {}) {
  return { node: 'tool', tool: name, input, ...extra };
}

const baseOptions = {
  capabilities: new Set(['tools', 'llm']),
  dshVersion: '0.2.0-rc.2',
  versionRange: '>=0.2.0-rc.2',
};

/** 取 plan 里的节点 id（拓扑序）。 */
function ids(plan) {
  return plan.nodes.map((n) => n.node_id);
}

describe('compose：七个组合器编译成结构', () => {
  test('seq 生成 n_i → n_{i+1} 的链', () => {
    const s = scenario({
      id: 'TK-1000',
      title: 'seq',
      root: seq(tool('a'), tool('b'), tool('c')),
    });
    const { plan } = compileScenario(s, baseOptions);
    assert.deepEqual(ids(plan), ['TK-1000/0', 'TK-1000/1', 'TK-1000/2']);
    assert.deepEqual(plan.edges, [
      { from: 'TK-1000/0', to: 'TK-1000/1' },
      { from: 'TK-1000/1', to: 'TK-1000/2' },
    ]);
  });

  test('parallel 的分支之间没有边（它们是并发启动）', () => {
    const s = scenario({
      id: 'TK-1001',
      title: 'parallel',
      root: seq(parallel(tool('a'), tool('b')), tool('c')),
    });
    const { plan } = compileScenario(s, baseOptions);
    const inner = plan.edges.filter(
      (e) => (e.from === 'TK-1001/0/0' && e.to === 'TK-1001/0/1') || (e.from === 'TK-1001/0/1' && e.to === 'TK-1001/0/0'),
    );
    assert.equal(inner.length, 0, '并发分支之间不该有边');
  });

  test('setup 编排 before → body → after（after 保证执行）', () => {
    const s = scenario({
      id: 'TK-1002',
      title: 'setup',
      root: setup(tool('before'), tool('body'), tool('after')),
    });
    const { plan } = compileScenario(s, baseOptions);
    assert.deepEqual(plan.edges, [
      { from: 'TK-1002/before', to: 'TK-1002/body' },
      { from: 'TK-1002/body', to: 'TK-1002/after' },
    ]);
  });

  test('matrix 展开为 N 个实例，并把变量代入 input', () => {
    const s = scenario({
      id: 'TK-1003',
      title: 'matrix',
      root: matrix(
        [
          { name: 'cn', vars: { lang: 'zh' } },
          { name: 'en', vars: { lang: 'en' } },
        ],
        tool('read-file', { path: '/tmp/${lang}.txt' }),
      ),
    });
    const { plan } = compileScenario(s, baseOptions);
    assert.deepEqual(ids(plan), ['TK-1003/@cn', 'TK-1003/@en']);
    assert.equal(plan.nodes[0].input.path, '/tmp/zh.txt');
    assert.equal(plan.nodes[1].input.path, '/tmp/en.txt');
  });

  test('matrix 的实例名重复 → 构造期就拒绝', () => {
    assert.throws(
      () =>
        matrix(
          [
            { name: 'x', vars: {} },
            { name: 'x', vars: {} },
          ],
          tool('a'),
        ),
      DslError,
    );
  });

  test('dependsOn 按图连边并做拓扑排序', () => {
    const s = scenario({
      id: 'TK-1004',
      title: 'dependsOn',
      root: dependsOn({ a: [], b: ['a'], c: ['a'] }, { a: tool('a'), b: tool('b'), c: tool('c') }),
    });
    const { plan } = compileScenario(s, baseOptions);
    const pairs = plan.edges.map((e) => `${e.from}->${e.to}`).sort();
    assert.deepEqual(pairs, ['TK-1004/a->TK-1004/b', 'TK-1004/a->TK-1004/c']);
    assert.equal(ids(plan)[0], 'TK-1004/a', 'a 必须排在 b/c 之前');
  });

  test('ref 在 normalize 阶段被内联', () => {
    const inner = scenario({ id: 'TK-1005-INNER', title: 'inner', root: tool('inner-tool') });
    const outer = scenario({
      id: 'TK-1005',
      title: 'outer',
      root: seq(tool('pre'), ref('TK-1005-INNER')),
    });
    const { plan } = compileScenario(outer, { ...baseOptions, scenarios: [inner] });
    assert.deepEqual(ids(plan), ['TK-1005/0', 'TK-1005/1']);
    assert.equal(plan.nodes[1].tool_kind, 'inner-tool', '被引场景的 root 内容必须真的进来了');
  });

  test('ref 指向不存在的场景 → 编译期拒绝', () => {
    const s = scenario({ id: 'TK-1006', title: 'bad ref', root: ref('NOPE') });
    assert.throws(() => compileScenario(s, baseOptions), DslError);
  });
});

describe('when：编译期剪枝，且剪枝必须可见', () => {
  test('能力条件为真时剪掉 else 支，并把剪枝记进结果', () => {
    const s = scenario({
      id: 'TK-1010',
      title: 'when-cap',
      root: when({ kind: 'capability', id: 'fs', present: false }, tool('then-tool'), tool('else-tool')),
    });
    const { plan, pruned } = compileScenario(s, baseOptions);
    assert.deepEqual(ids(plan), ['TK-1010/then']);
    assert.equal(pruned.length, 1);
    assert.match(pruned[0].reason, /剪掉 else 支/);
    assert.equal(pruned[0].condition.kind, 'capability');
  });

  test('条件为假且无 else → 整支剪掉（图里不留节点）', () => {
    const s = scenario({
      id: 'TK-1011',
      title: 'when-false',
      root: seq(tool('a'), when({ kind: 'capability', id: 'nope', present: true }, tool('never'))),
    });
    const { plan, pruned } = compileScenario(s, baseOptions);
    assert.deepEqual(ids(plan), ['TK-1011/0']);
    assert.equal(pruned.length, 1);
  });

  test('config 条件用调用方给的宿主配置判定（不是运行期数据）', () => {
    const s = scenario({
      id: 'TK-1012',
      title: 'when-config',
      root: when({ kind: 'config', key: 'sandbox.allowNetwork', equals: false }, tool('offline'), tool('online')),
    });
    const { plan } = compileScenario(s, {
      ...baseOptions,
      config: { 'sandbox.allowNetwork': false },
    });
    assert.deepEqual(ids(plan), ['TK-1012/then']);
  });

  test('剪枝的两支都进图的前提不成立时，pruned 必须给出依据（可审计）', () => {
    const s = scenario({
      id: 'TK-1013',
      title: 'when-audit',
      root: when({ kind: 'version', range: '>=0.2.0-rc.2' }, tool('a'), tool('b')),
    });
    const { pruned } = compileScenario(s, baseOptions);
    assert.equal(pruned.length, 1);
    assert.ok(pruned[0].nodePath.endsWith('/then') || pruned[0].nodePath.endsWith('/else'));
  });
});

describe('retry：白名单由构造期强制', () => {
  test('product_bug 不在白名单 → 构造期抛错（不等到运行期）', () => {
    assert.throws(() => retry(tool('a'), { times: 2, on: ['product_bug'] }), DslError);
  });

  test('inconclusive / env 允许，并透传进 plan 的 retry 声明', () => {
    const s = scenario({
      id: 'TK-1020',
      title: 'retry',
      root: retry(tool('a'), { times: 3, backoffMs: 50, on: ['inconclusive', 'env'] }),
    });
    const { plan } = compileScenario(s, baseOptions);
    const node = plan.nodes[0];
    assert.deepEqual(node.retry, { times: 3, backoff_ms: 50, on: ['inconclusive', 'env'] });
  });

  test('times 必须是 ≥1 的整数', () => {
    assert.throws(() => retry(tool('a'), { times: 0 }), DslError);
    assert.throws(() => retry(tool('a'), { times: 1.5 }), DslError);
  });
});

describe('validate：第 2 层防御拒绝生成 plan', () => {
  test('依赖成环 → CompileError，且点名环上的节点（F4）', () => {
    const s = scenario({
      id: 'TK-1030',
      title: 'cycle',
      root: dependsOn({ a: ['c'], b: ['a'], c: ['b'] }, { a: tool('a'), b: tool('b'), c: tool('c') }),
    });
    try {
      compileScenario(s, baseOptions);
      assert.fail('有环必须拒绝');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      const finding = e.findings.find((f) => f.kind === 'dependency-cycle');
      assert.ok(finding, '必须报出 dependency-cycle');
      assert.match(finding.subject, /->|→/u, '必须点名环上的节点序列，而不是只说"有环"');
    }
  });

  test('parallel 分支内独占同一资源 → CompileError，且点名双方（F3）', () => {
    const s = scenario({
      id: 'TK-1031',
      title: 'resource conflict',
      root: parallel(
        tool('a', {}, { resources: [{ resourceId: 'tmp:x', kind: 'tmpdir', exclusive: true }] }),
        tool('b', {}, { resources: [{ resourceId: 'tmp:x', kind: 'tmpdir', exclusive: true }] }),
      ),
    });
    try {
      compileScenario(s, baseOptions);
      assert.fail('资源冲突必须拒绝');
    } catch (e) {
      assert.ok(e instanceof CompileError);
      const finding = e.findings.find((f) => f.kind === 'resource-conflict');
      assert.ok(finding);
      assert.equal(finding.subject, 'tmp:x');
      // 节点 id 是**路径式**的：parallel 直接作为场景 root 时，两个分支就是
      // `<场景 id>/0` 与 `<场景 id>/1`（不是 `/0/0`——那只有在 parallel 嵌在 seq 里时才成立）。
      assert.match(finding.detail, /TK-1031\/0/);
      assert.match(finding.detail, /TK-1031\/1/);
    }
  });

  test('非独占（shared）资源不构成冲突', () => {
    const s = scenario({
      id: 'TK-1032',
      title: 'shared ok',
      root: parallel(
        tool('a', {}, { resources: [{ resourceId: 'r', kind: 'session', exclusive: false }] }),
        tool('b', {}, { resources: [{ resourceId: 'r', kind: 'session', exclusive: false }] }),
      ),
    });
    const { plan } = compileScenario(s, baseOptions);
    assert.equal(plan.nodes.length, 2);
  });

  test(`嵌套超过 ${MAX_SCENARIO_DEPTH} 层 → 拒绝（硬规则 2）`, () => {
    let node = tool('leaf');
    for (let i = 0; i < MAX_SCENARIO_DEPTH + 1; i += 1) node = seq(node);
    const s = scenario({ id: 'TK-1033', title: 'too deep', root: node });
    assert.throws(() => compileScenario(s, baseOptions), DslError);
  });

  test('缺能力只产生 warning（计划期 skip 的输入），不阻断编译', () => {
    const s = scenario({
      id: 'TK-1034',
      title: 'missing cap',
      root: tool('needs-fs', {}, { requires: ['fs'] }),
    });
    const { plan, findings } = compileScenario(s, baseOptions);
    assert.equal(plan.nodes.length, 1);
    const warn = findings.find((f) => f.kind === 'capability-missing');
    assert.ok(warn, '缺能力必须留下 warning（它是第 3 层决策的输入）');
    assert.equal(warn.level, 'warning');
  });
});

describe('plan：确定性与跨语言契约一致性', () => {
  test('同输入 ⇒ 同 plan（指标 C1 在编译期的对应物）', () => {
    const build = () =>
      scenario({
        id: 'TK-1040',
        title: 'determinism',
        root: dependsOn({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] }, { a: tool('a'), b: tool('b'), c: tool('c'), d: tool('d') }),
      });
    const first = compileScenario(build(), { ...baseOptions, seed: 7 });
    const second = compileScenario(build(), { ...baseOptions, seed: 7 });
    assert.deepEqual(first.plan, second.plan);
    assert.equal(first.plan.metadata.seed, 7);
  });

  test('plan 的 metadata 字段名与 Rust 侧逐字一致（snake_case）', () => {
    const s = scenario({ id: 'TK-1041', title: 'meta', root: tool('a') });
    const { plan } = compileScenario(s, { ...baseOptions, seed: 1 });
    assert.deepEqual(Object.keys(plan.metadata).sort(), [
      'confidence',
      'depth',
      'layer',
      'scenario_id',
      'seed',
      'shared_context',
      'title',
    ]);
    // ts-rs 按 serde snake_case 生成字面量：`Layer::L3` → `"l3"`、`ConfidenceLevel::Real` → `"real"`。
    assert.equal(plan.metadata.layer, 'l3');
    assert.equal(plan.metadata.confidence, 'real');
    assert.equal(plan.metadata.shared_context, false);
  });

  test('工具叶子的 gate 由 requires 推导，缺省 on_missing=skip', () => {
    const s = scenario({
      id: 'TK-1042',
      title: 'gate',
      root: tool('a', {}, { requires: ['tools', 'fs'] }),
    });
    const { plan } = compileScenario(s, baseOptions);
    assert.deepEqual(plan.nodes[0].gate, { requires: ['tools', 'fs'], on_missing: 'skip' });
  });

  test('无 requires 的节点不带 gate 字段（不是 null）', () => {
    const s = scenario({ id: 'TK-1043', title: 'no gate', root: tool('a') });
    const { plan } = compileScenario(s, baseOptions);
    assert.equal('gate' in plan.nodes[0], false, '可选字段必须省略而不是 null');
  });
});

describe('大类场景：包含关系与共享宿主', () => {
  test('largeScenario 必须显式给出 sharedContext', () => {
    const inner = scenario({ id: 'TK-1050-A', title: 'a', root: tool('a') });
    const large = largeScenario({ id: 'TK-1050', title: 'domain', contains: [inner], sharedContext: true });
    assert.equal(large.sharedContext, true);
    assert.equal(large.contains.length, 1);
  });

  test('大类不能为空（包含是组织结构，空包含没有意义）', () => {
    assert.throws(() => largeScenario({ id: 'TK-1051', title: 'empty', contains: [], sharedContext: false }), DslError);
  });

  test('每个小类各自编译成独立 plan，且小类的 shared_context 恒为 false', () => {
    const inner = scenario({ id: 'TK-1052-A', title: 'a', root: tool('a') });
    const { plan } = compileScenario(inner, baseOptions);
    assert.equal(plan.metadata.shared_context, false, '小类不共享宿主（设计 §2.3）');
  });
});
