/**
 * K1 层级可信度 —— **编译期那一半**（运行期那一半在 `crates/executor`）。
 *
 * ## 为什么是"那一半"
 *
 * K1 = "层级标记的可信度**与实际执行一致**的比例"。它天然分两段：
 * - **声明是否自洽**（层级 → 可信度）—— 可以在**编译期**拦，就是本文件；
 * - **实际执行是否相符** —— 必须**运行期**拦（`crates/executor` 的 `LayerConfidenceMismatch`
 *   与 `confidence_violations`）。
 *
 * **两层都要，不是二选一**：设计 §5.4 明确允许"直接写 `ExecutionPlan` JSON"的入口，
 * 那条路径**绕过编译器**，只有运行期拦得住。（这本仓的"四层防御"结构就是这么分的。）
 *
 * ## ⚠️ 已知风险：同一语义有两处实现
 *
 * `allowedConfidenceFor`（本仓 TS 侧）与 `crates/executor/src/validate.rs::allowed_confidence_for`
 * （Rust 侧）是**同一张表的两份实现**，而**目前没有同源守卫**（缺陷台账 D-10）。
 * 风险不是"两边写法不同"，而是**静默漂移**：`degraded` 的适用范围（L3–L6）只要有一边改了，
 * 另一边不会报错，只会让"某个层级的标记没被校验"——最难发现的那种。
 *
 * 本文件里的**逐层断言**是同源守卫的**一半**：TS 侧一旦漂移，它会红。
 *
 * ## 为什么"编译期真的会拦"这条证明不在这里
 *
 * 它由 **F1 的注入集**承担（`tests/compiler-f1.test.mjs` 的 `F1-21`）——
 * 那里有一套统一的"注入 → 必须被拦 → 必须点名被哪一层拦下"的机器。
 * 本文件只断言**映射本身**。把两件事混在一起，会让"F1 拦截率"这个指标的口径变模糊。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { scenario, seq } from '../lib/dsl/nodes.js';
import { CompileError, allowedConfidenceFor, compileScenario } from '../lib/compiler/index.js';

const baseOptions = {
  capabilities: new Set(['tools', 'llm']),
  dshVersion: '0.2.0-rc.2',
  versionRange: '>=0.2.0-rc.2',
};

const tool = (name) => ({ node: 'tool', tool: name, input: {} });

/** 设计 §8.2 的七层表。 */
const LAYERS = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6'];

describe('K1（编译期）：层级 → 可信度的映射', () => {
  test('映射表逐层钉住 —— 这是同源守卫在 TS 侧的那一半', () => {
    assert.deepEqual(allowedConfidenceFor('l0'), ['static'], 'L0 无宿主 ⇒ 未执行 ⇒ static');
    assert.deepEqual(allowedConfidenceFor('l1'), ['simulated']);
    assert.deepEqual(allowedConfidenceFor('l2'), ['simulated']);
    for (const layer of ['l3', 'l4', 'l5', 'l6']) {
      assert.deepEqual(
        allowedConfidenceFor(layer),
        ['real', 'degraded'],
        `${layer} 是真实宿主；degraded 是"真实宿主上的降级态"，只能出现在这里`,
      );
    }
  });

  test('七层全部非空 —— 否则那一层会被"默认拒绝"误伤', () => {
    for (const layer of LAYERS) {
      assert.ok(
        allowedConfidenceFor(layer).length > 0,
        `${layer} 必须有允许的标记（空集 = 该层的任何声明都会被拒）`,
      );
    }
  });

  test('未知层级不放行任何标记（默认拒绝，而非默认放行）', () => {
    // 与 Rust 侧 `_` 分支同向。默认放行会让**未来新增的层级静默通过**，
    // 而那种错误只在很久以后以"某个层级的结果没被校验"的形式浮现。
    assert.deepEqual(allowedConfidenceFor('l99'), []);
  });

  test('不自洽的声明在编译期被拒（L0 + real）', () => {
    const bad = scenario({
      id: 'K1-BAD',
      title: 'x',
      layer: 'l0',
      confidence: 'real',
      root: seq(tool('a')),
    });
    try {
      compileScenario(bad, baseOptions);
      assert.fail('L0 声明 real 必须被拒');
    } catch (e) {
      assert.ok(e instanceof CompileError, `期望 CompileError，实际 ${String(e)}`);
      const finding = e.findings.find((f) => f.kind === 'layer-confidence-mismatch');
      assert.ok(finding, '必须报出 layer-confidence-mismatch');
      assert.equal(finding.level, 'error', '它必须阻断（error），不是 warning');
    }
  });

  test('每一层的非法组合都被拒（逐层遍历四态）', () => {
    const all = ['real', 'simulated', 'degraded', 'static'];
    let checked = 0;
    for (const layer of LAYERS) {
      const allowed = allowedConfidenceFor(layer);
      for (const confidence of all) {
        if (allowed.includes(confidence)) continue;
        checked += 1;
        const bad = scenario({
          id: `K1-${layer}-${confidence}`,
          title: 'x',
          layer,
          confidence,
          root: seq(tool('a')),
        });
        assert.throws(
          () => compileScenario(bad, baseOptions),
          CompileError,
          `${layer} + ${confidence} 应当被拒`,
        );
      }
    }
    // 防"空转"：如果映射变成了"什么都允许"，上面一条都不会被检查。
    assert.ok(checked > 0, '必须至少检查到一个非法组合，否则这条证明没有判别力');
  });

  test('自洽的声明逐层通过，且标记原样进 plan', () => {
    const cases = [
      ['l0', 'static'],
      ['l1', 'simulated'],
      ['l2', 'simulated'],
      ['l3', 'real'],
      ['l3', 'degraded'],
      ['l4', 'real'],
      ['l5', 'degraded'],
      ['l6', 'real'],
    ];
    for (const [layer, confidence] of cases) {
      const s = scenario({
        id: `K1-OK-${layer}-${confidence}`,
        title: 'x',
        layer,
        confidence,
        root: seq(tool('a')),
      });
      const { plan } = compileScenario(s, baseOptions);
      assert.equal(plan.metadata.layer, layer);
      assert.equal(plan.metadata.confidence, confidence, '标记必须原样进 plan，不被改写');
    }
  });

  test('可信度缺省**由层级推导**（L0 不该默认成 real）', () => {
    // 这条防的是"默认值本身制造错误"：若缺省硬编码成 'real'，
    // 一个什么都没声明的 L0 场景会立刻变成一条不自洽的声明。
    const l0 = scenario({ id: 'K1-DEF-L0', title: 'x', layer: 'l0', root: seq(tool('a')) });
    assert.equal(compileScenario(l0, baseOptions).plan.metadata.confidence, 'static');

    const l1 = scenario({ id: 'K1-DEF-L1', title: 'x', layer: 'l1', root: seq(tool('a')) });
    assert.equal(compileScenario(l1, baseOptions).plan.metadata.confidence, 'simulated');

    const l5 = scenario({ id: 'K1-DEF-L5', title: 'x', layer: 'l5', root: seq(tool('a')) });
    assert.equal(compileScenario(l5, baseOptions).plan.metadata.confidence, 'real');
  });
});
