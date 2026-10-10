/**
 * F1 —— 编译期拦截率（REWRITE-METRICS §7：门槛 ≥ 95%）。
 *
 * **F1 问的问题**：把一个"非法场景"喂进 TS 侧，它会被**拦下**吗？
 * 这是四层防御的第 1、2 层（设计 §5.3）：
 *   - 第 1 层 TS 类型系统 + 构造期校验（`src/dsl/nodes.ts` 的构造器）；
 *   - 第 2 层编译器 `validate`（`src/compiler/index.ts`，拒绝生成 plan）。
 *
 * **为什么要有这个文件**：`compiler.test.mjs` 是逐条验证"某个规则对"，但没有任何东西
 * 回答"**该拦的一共有多少类、拦住了几类**"。前者是单元测试，后者是**指标**。
 * 一个只在"我记得测的那几条"上绿的守卫，无法给出拦截率。
 *
 * 判据：每个注入项都必须让 TS 侧抛错（`DslError` 或 `CompileError`）。
 * **拦截率 = 抛错项数 / 注入项数**。
 *
 * 注意这**不是**"跑一次看看"式的软指标：注入集是**枚举的**，每一项要么被拦要么不被拦。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
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
import { CompileError, compileScenario } from '../lib/compiler/index.js';

const baseOptions = {
  capabilities: new Set(['tools', 'llm']),
  dshVersion: '0.2.0-rc.2',
  versionRange: '>=0.2.0-rc.2',
};

/** 工具叶子。 */
const tool = (name, input = {}, extra = {}) => ({ node: 'tool', tool: name, input, ...extra });

/**
 * 注入集：每一项都是一个**应当被拦下**的非法场景。
 *
 * `layer` 标出它被哪一层拦下（构造期 = 第 1 层的运行时补充；编译期 = 第 2 层 `validate`）。
 * 这个标注本身有价值：**如果所有项都由同一层拦下，说明另一层是空的**。
 */
const INJECTIONS = [
  {
    id: 'F1-01',
    what: '依赖环（二元）：a→b→a',
    layer: 'validate',
    build: () => scenario({ id: 'F1-01', title: 'x', root: dependsOn({ a: ['b'], b: ['a'] }, { a: tool('a'), b: tool('b') }) }),
  },
  {
    id: 'F1-02',
    what: '依赖环（三元）：a→b→c→a',
    layer: 'validate',
    build: () =>
      scenario({ id: 'F1-02', title: 'x', root: dependsOn({ a: ['c'], b: ['a'], c: ['b'] }, { a: tool('a'), b: tool('b'), c: tool('c') }) }),
  },
  {
    id: 'F1-03',
    what: '自环：a→a',
    layer: 'validate',
    build: () => scenario({ id: 'F1-03', title: 'x', root: dependsOn({ a: ['a'] }, { a: tool('a') }) }),
  },
  {
    id: 'F1-04',
    what: '两个不相交的环（不能只报第一条）',
    layer: 'validate',
    build: () =>
      scenario({
        id: 'F1-04',
        title: 'x',
        root: dependsOn(
          { a: ['b'], b: ['a'], c: ['d'], d: ['c'] },
          { a: tool('a'), b: tool('b'), c: tool('c'), d: tool('d') },
        ),
      }),
  },
  {
    id: 'F1-05',
    what: 'parallel 分支内两个节点独占同一资源（F3）',
    layer: 'validate',
    build: () =>
      scenario({
        id: 'F1-05',
        title: 'x',
        root: parallel(
          tool('a', {}, { resources: [{ resourceId: 'r', kind: 'tmpdir', exclusive: true }] }),
          tool('b', {}, { resources: [{ resourceId: 'r', kind: 'tmpdir', exclusive: true }] }),
        ),
      }),
  },
  {
    id: 'F1-06',
    what: '场景嵌套超过三层',
    layer: 'validate',
    build: () => {
      let n = tool('leaf');
      for (let i = 0; i < 4; i += 1) n = seq(n);
      return scenario({ id: 'F1-06', title: 'x', root: n });
    },
  },
  {
    id: 'F1-07',
    what: 'ref 指向不存在的场景',
    layer: 'validate',
    build: () => scenario({ id: 'F1-07', title: 'x', root: ref('NOPE') }),
  },
  {
    id: 'F1-08',
    what: 'dependsOn 的图引用了 nodes 里没有的节点',
    layer: 'construct',
    build: () => dependsOn({ a: ['ghost'] }, { a: tool('a') }),
  },
  {
    id: 'F1-09',
    what: 'retry 白名单含 product_bug（确定性缺陷不该重试）',
    layer: 'construct',
    build: () => retry(tool('a'), { times: 2, on: ['product_bug'] }),
  },
  {
    id: 'F1-10',
    what: 'retry 的 times = 0',
    layer: 'construct',
    build: () => retry(tool('a'), { times: 0 }),
  },
  {
    id: 'F1-11',
    what: 'retry 包住复合节点（它只重试"单点"）',
    layer: 'validate',
    build: () => scenario({ id: 'F1-11', title: 'x', root: retry(seq(tool('a'), tool('b')), { times: 2 }) }),
  },
  {
    id: 'F1-12',
    what: '同一工具同时有内建 retry 与 retry(...) 包装（不静默覆盖）',
    layer: 'validate',
    build: () =>
      scenario({ id: 'F1-12', title: 'x', root: retry(tool('a', {}, { retry: { times: 1 } }), { times: 2 }) }),
  },
  {
    id: 'F1-13',
    what: 'matrix 实例名重复',
    layer: 'construct',
    build: () =>
      matrix(
        [
          { name: '同', vars: {} },
          { name: '同', vars: {} },
        ],
        tool('a'),
      ),
  },
  {
    id: 'F1-14',
    what: 'matrix 的 cases 为空',
    layer: 'construct',
    build: () => matrix([], tool('a')),
  },
  {
    id: 'F1-15',
    what: 'seq(...) 无子节点',
    layer: 'construct',
    build: () => seq(),
  },
  {
    id: 'F1-16',
    what: 'parallel(...) 无子节点',
    layer: 'construct',
    build: () => parallel(),
  },
  {
    id: 'F1-17',
    what: '场景 id 为空（报告与对拍都以它为主键）',
    layer: 'construct',
    build: () => scenario({ id: '', title: 'x', root: tool('a') }),
  },
  {
    id: 'F1-18',
    what: '大类场景不包含任何小类',
    layer: 'construct',
    build: () => largeScenario({ id: 'F1-18', title: 'x', contains: [], sharedContext: false }),
  },
  {
    id: 'F1-19',
    what: 'when 的条件在编译期不可判定（例如依赖运行期数据）',
    layer: 'construct',
    build: () => when({ kind: 'runtime-value', key: 'x' }, tool('a')),
  },
  {
    id: 'F1-20',
    what: 'setup 的 after 缺失（保证执行的语义必须有它）',
    layer: 'construct',
    build: () => setup(tool('a'), tool('b'), undefined),
  },
  {
    id: 'F1-21',
    what: '层级与可信度不自洽（L0 + real）：K1 的编译期那一半',
    layer: 'validate',
    // 这条注入的**判据来源**是 `allowedConfidenceFor`（设计 §8.2 七层表）。
    // 它同时也是一条"映射表变空/被放宽"的探测器：若映射被改成"什么都允许"，
    // 这条注入就拦不住了，F1 会从 21/21 掉下来。
    build: () =>
      scenario({ id: 'F1-21', title: 'x', layer: 'l0', confidence: 'real', root: tool('a') }),
  },
];

/** 跑一个注入项，返回"是否被拦下"与"被哪一层拦下"。 */
function probe(injection) {
  try {
    const built = injection.build();
    // 构造期没拦下 ⇒ 交给编译器（第 2 层）。
    if (built === undefined || built === null) {
      return { caught: true, by: 'construct' };
    }
    if (built.node !== undefined && built.root === undefined && built.contains === undefined) {
      // 构造器返回的是一个节点而不是场景（例如 dependsOn/retry/matrix 的注入）——
      // 这类注入的"拦截"发生在构造期，走到这里说明它没被拦。
      return { caught: false, by: null };
    }
    compileScenario(built, baseOptions);
    return { caught: false, by: null };
  } catch (e) {
    if (e instanceof CompileError) return { caught: true, by: 'validate' };
    if (e instanceof Error && e.name === 'DslError') return { caught: true, by: 'construct' };
    // 其它异常也算被拦（但类型要看清——它可能是我们没预期的错）。
    return { caught: true, by: `other:${e?.name ?? 'unknown'}` };
  }
}

describe('F1 编译期拦截率', () => {
  test('注入集覆盖到"构造期"与"编译期"两层（否则某一层是空的）', () => {
    const byLayer = new Map();
    for (const inj of INJECTIONS) {
      const r = probe(inj);
      byLayer.set(r.by, (byLayer.get(r.by) ?? 0) + 1);
    }
    // 这条断言防的是"所有注入都被同一层拦下，另一层从没被验证过"。
    assert.ok(
      (byLayer.get('construct') ?? 0) > 0,
      `注入集中没有任何一项由构造期拦下（分布：${JSON.stringify([...byLayer])}）`,
    );
    assert.ok(
      (byLayer.get('validate') ?? 0) > 0,
      `注入集中没有任何一项由编译器 validate 拦下（分布：${JSON.stringify([...byLayer])}）——第 2 层是空的`,
    );
  });

  test('F1 = 被拦下的注入项 / 全部注入项（门槛 ≥ 95%）', () => {
    const results = INJECTIONS.map((inj) => ({ inj, r: probe(inj) }));
    const caught = results.filter((x) => x.r.caught);
    const missed = results.filter((x) => !x.r.caught);

    const byLayer = {};
    for (const { r } of results) {
      if (r.caught) byLayer[r.by] = (byLayer[r.by] ?? 0) + 1;
    }

    const rate = (caught.length / INJECTIONS.length) * 100;
    console.log(
      `  F1 编译期拦截率 = ${caught.length}/${INJECTIONS.length} = ${rate.toFixed(1)}%（门槛 ≥ 95%）`,
    );
    console.log(`  分层：${JSON.stringify(byLayer)}`);
    if (missed.length > 0) {
      console.log('  未被拦下：');
      for (const { inj } of missed) console.log(`    ${inj.id} (${inj.layer}) ${inj.what}`);
    }

    assert.ok(rate >= 95, `F1 = ${rate.toFixed(1)}% < 95%：${missed.map((x) => x.inj.id).join(', ')}`);
  });

  test('每一项都在汇报里可点名（不留"未知失败"）', () => {
    // 这条防的是"某个注入抛了一个我们没预期的异常，却被算作'被拦下'"。
    const weird = INJECTIONS.map((inj) => ({ inj, r: probe(inj) })).filter(
      (x) => x.r.by !== null && x.r.by !== 'construct' && x.r.by !== 'validate',
    );
    assert.deepEqual(
      weird.map((x) => `${x.inj.id}:${x.r.by}`),
      [],
      '存在不是由 construct/validate 两层拦下的项——它可能抛了非预期异常',
    );
  });
});
