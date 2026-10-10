/**
 * 场景 DSL 的节点模型与七个组合器（设计 §5.1）。
 *
 * **为什么要有这层**：设计决定 5 推翻了既有的 D4（"Driver 与数据分离，避免自造 DSL"）。
 * 推翻的理由不是"DSL 好看"，而是**组合覆盖必须可度量**——在 `setup` 里手工堆 kind
 * 表达不了 3-wise 组合，于是 [GOVERNANCE.md](../../docs/GOVERNANCE.md) 的覆盖矩阵
 * 只能看到"某 kind 有没有场景"，看不到"组合到第几层"。
 *
 * **硬规则（编译器强制，不只是文档约定）**：
 * 1. 工具是**叶子**，场景是**复合**节点——叶子不可包含场景；
 * 2. 场景嵌套**不超过三层**；
 * 3. 小类场景**不共享宿主**；要共享必须在 `LargeScenario` 里显式声明；
 * 4. 组合器**只描述结构，不执行**——它们编译成 `ExecutionPlan` 的 `nodes` 与 `edges`，没有副作用。
 *
 * 本文件只做第 4 条：**构造数据结构**。校验在 `src/compiler` 的 `validate` 阶段。
 */

// 跨语言类型来自 Rust（`crates/protocol` 的 ts-rs 导出）。**禁止手改**那个目录，
// 它由 `cargo test -p dsh-testkit-protocol` 重新生成，H3 用 git diff 守它。
import type { ConfidenceLevel } from '../contracts/generated/ConfidenceLevel.js';
import type { Layer } from '../contracts/generated/Layer.js';

/** 能力缺失时的声明式意图（与 `crates/protocol/src/plan.rs` 的 `OnMissing` 逐字对应）。 */
export type OnMissing = 'proceed' | 'skip' | 'fail' | 'degrade';

/** 声明式资源（设计 §5.4）：会话 / 临时目录 / 端口 / 全局注册表。 */
export interface ResourceDecl {
  /** 资源标识（同一 id = 同一资源）。 */
  readonly resourceId: string;
  /** 资源种类，用于跨进程冲突判定。 */
  readonly kind: string;
  /** 是否独占。 */
  readonly exclusive: boolean;
}

/** 工具叶子：最小的可复用干预 + 取证单元，**原子、不可再分**（设计 §2.1）。 */
export interface ToolLeaf {
  readonly node: 'tool';
  /** 节点 id；缺省由编译器按路径生成（保证稳定，见 compose）。 */
  readonly id?: string;
  /** BaseTool 原子名（对齐 `docs/REWRITE-DESIGN.md` §2.2）。 */
  readonly tool: string;
  /** 节点输入（自由形状，语义由具体 BaseTool 定义）。 */
  readonly input: Readonly<Record<string, unknown>>;
  /** 需要的能力（成员来自 `spec/contracts/capabilities.yaml` 的 20 个）。 */
  readonly requires?: readonly string[];
  /** 能力缺失时的意图；最终决策仍由 `crates/capability` 的裁决表给出。 */
  readonly onMissing?: OnMissing;
  /** `degrade` 时的 fallback 路径名。 */
  readonly fallback?: string;
  /** 超时（毫秒）。 */
  readonly timeoutMs?: number;
  /** 该节点要求的可信度下限。 */
  readonly minConfidence?: ConfidenceLevel;
  /** 本节点声明的资源。 */
  readonly resources?: readonly ResourceDecl[];
  /** 失败重试声明。 */
  readonly retry?: RetrySpec;
  /** 是否登记 disposer（逆序释放，设计 §6.2）。 */
  readonly cleanup?: boolean;
}

/** 重试声明。**只对 `inconclusive` 与 `env` 归因重试，`product_bug` 不重试**（设计 §5.1）。 */
export interface RetrySpec {
  readonly times: number;
  /** 退避（毫秒），缺省 0。 */
  readonly backoffMs?: number;
  /** 允许重试的归因类别白名单。 */
  readonly on?: readonly ('inconclusive' | 'env')[];
}

/** 编译期可判定的条件（设计 §5.1：`when` 的 `cond` **不接受运行期随机**）。 */
export type Condition =
  | { readonly kind: 'capability'; readonly id: string; readonly present: boolean }
  | { readonly kind: 'version'; readonly range: string }
  | { readonly kind: 'config'; readonly key: string; readonly equals: unknown };

/** `seq(...nodes)`：顺序执行，前一个完成后启动下一个。 */
export interface SeqNode {
  readonly node: 'seq';
  readonly children: readonly Node[];
}

/** `parallel(...nodes)`：并发启动，**全部完成**才继续。 */
export interface ParallelNode {
  readonly node: 'parallel';
  readonly children: readonly Node[];
}

/** `when(cond, then, else?)`：按编译期可判定的条件选一支；两支都进图，运行期剪一支。 */
export interface WhenNode {
  readonly node: 'when';
  readonly cond: Condition;
  readonly then: Node;
  readonly otherwise?: Node;
}

/** `retry(node, spec)`：失败重试至多次，**只对 `inconclusive` / `env` 归因重试**。 */
export interface RetryNode {
  readonly node: 'retry';
  readonly child: Node;
  readonly spec: RetrySpec;
}

/** `matrix(cases, node)`：参数化展开为 `cases` 个实例。 */
export interface MatrixNode {
  readonly node: 'matrix';
  readonly cases: readonly MatrixCase[];
  readonly child: Node;
}

/** 一个参数化实例。 */
export interface MatrixCase {
  /** 实例名（用于节点 id 与报告聚合）。 */
  readonly name: string;
  /** 代入 `child` 中 `${...}` 占位符的变量。 */
  readonly vars: Readonly<Record<string, string | number | boolean>>;
}

/** `setup(before, node, after)`：前置/后置；`after` **保证执行**（即使 `node` 失败）。 */
export interface SetupNode {
  readonly node: 'setup';
  readonly before: Node;
  readonly child: Node;
  readonly after: Node;
}

/** `dependsOn(graph)`：显式依赖图；**禁止成环**（编译期报错）。 */
export interface DependsOnNode {
  readonly node: 'dependsOn';
  /** 节点名 → 它依赖的节点名。 */
  readonly graph: Readonly<Record<string, readonly string[]>>;
  /** 节点名 → 实际节点。 */
  readonly nodes: Readonly<Record<string, Node>>;
}

/** 场景引用（`normalize` 阶段会内联成被引场景的 root）。 */
export interface ScenarioRef {
  readonly node: 'ref';
  /** 被引场景 id。 */
  readonly to: string;
}

/** 任一节点。 */
export type Node =
  | ToolLeaf
  | SeqNode
  | ParallelNode
  | WhenNode
  | RetryNode
  | MatrixNode
  | SetupNode
  | DependsOnNode
  | ScenarioRef;

/** 小类场景：一个测试点，可独立 pass/fail/skip。 */
export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly layer?: Layer;
  readonly confidence?: ConfidenceLevel;
  /** 小类**不共享宿主**（设计 §2.3 沿用既有纪律：`parallel` 缺省 `exclusive`）。 */
  readonly sharedContext?: false;
  readonly resources?: readonly ResourceDecl[];
  readonly root: Node;
  readonly seed?: number;
}

/** 大类场景：一个测试域，包含若干小类，**可选共享宿主**。 */
export interface LargeScenario {
  readonly id: string;
  readonly title: string;
  readonly layer?: Layer;
  readonly confidence?: ConfidenceLevel;
  /** 大类可选共享宿主；**必须在报告里标 `sharedContext`**，否则"这条失败是不是上一条污染的"无法判定。 */
  readonly sharedContext: boolean;
  readonly resources?: readonly ResourceDecl[];
  /** 包含的小类（**包含**是组织结构，不是组合——它不影响执行顺序，只影响报告聚合）。 */
  readonly contains: readonly Scenario[];
  readonly seed?: number;
}

// ---------------------------------------------------------------- 组合器构造

/**
 * 构造期校验：节点参数必须是一个真实节点。
 *
 * **为什么每个接受 `Node` 的构造器都要过它**：这些构造器的语义里都有"没有它就不成立"的部分——
 * `setup` 的 `after`（**保证执行**）、`retry` 的子节点（重试对象）、`when` 的 `then`（分支）。
 * 缺了它们，构造函数**仍会返回一个形状正确的对象**，而错误会推迟到 `compose` 里
 * 以一个 `TypeError: Cannot read properties of undefined` 炸出来。
 *
 * 那个延迟的失败有两个问题：它既不是"用法错误"（退出码 2）也不是"实现缺陷"（退出码 1），
 * 而是一个**本该在构造期就说清的事**；而且它离犯错的地方很远——
 * 调用方看到的是编译器内部崩了，不是"我少传了一个参数"。
 */
function assertNode(value: unknown, what: string): void {
  if (value === undefined || value === null) {
    throw new DslError(`${what} 不能为空`);
  }
}

/** `seq(...nodes)`：顺序执行。边：`n_i → n_{i+1}`。 */
export function seq(...children: Node[]): SeqNode {
  if (children.length === 0) {
    throw new DslError('seq(...) 至少需要一个子节点');
  }
  children.forEach((c, i) => {
    assertNode(c, `seq 的第 ${String(i)} 个子节点`);
  });
  return { node: 'seq', children };
}

/** `parallel(...nodes)`：并发启动、全部完成才继续。需资源锁校验（F3）。 */
export function parallel(...children: Node[]): ParallelNode {
  if (children.length === 0) {
    throw new DslError('parallel(...) 至少需要一个子节点');
  }
  children.forEach((c, i) => {
    assertNode(c, `parallel 的第 ${String(i)} 个子节点`);
  });
  return { node: 'parallel', children };
}

/** `when(cond, then, otherwise?)`：条件必须是**编译期可判定**的（能力/版本/配置）。 */
export function when(cond: Condition, then: Node, otherwise?: Node): WhenNode {
  assertCompileTimeDecidable(cond);
  assertNode(then, 'when 的 then 分支');
  if (otherwise !== undefined) {
    assertNode(otherwise, 'when 的 otherwise 分支');
  }
  return otherwise === undefined
    ? { node: 'when', cond, then }
    : { node: 'when', cond, then, otherwise };
}

/** `retry(child, spec)`：只对 `inconclusive` / `env` 重试。 */
export function retry(child: Node, spec: RetrySpec): RetryNode {
  assertNode(child, 'retry 的子节点');
  if (!Number.isInteger(spec.times) || spec.times < 1) {
    throw new DslError(`retry 的 times 必须是 ≥1 的整数，实际 ${String(spec.times)}`);
  }
  for (const on of spec.on ?? []) {
    if (on !== 'inconclusive' && on !== 'env') {
      // `product_bug` 是确定性的产品缺陷，重试只是把同一件事再做一遍。
      // 这条在 Rust 侧由 `RetryOn` 枚举的类型保证；TS 侧由这里保证。
      throw new DslError(`retry 的 on 只允许 'inconclusive' | 'env'，实际 '${String(on)}'`);
    }
  }
  return { node: 'retry', child, spec };
}

/** `matrix(cases, child)`：参数化展开。 */
export function matrix(cases: readonly MatrixCase[], child: Node): MatrixNode {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new DslError('matrix(cases, ...) 的 cases 不能为空');
  }
  assertNode(child, 'matrix 的子节点');
  const names = new Set<string>();
  for (const c of cases) {
    if (names.has(c.name)) {
      throw new DslError(`matrix 的实例名 '${c.name}' 重复（名字进节点 id，必须唯一）`);
    }
    names.add(c.name);
  }
  return { node: 'matrix', cases, child };
}

/**
 * `setup(before, child, after)`：`after` **保证执行**。
 *
 * 三个参数**都不能缺**——尤其 `after`：它是这个组合器存在的理由（设计 §5.1 把它列为
 * "与既有 `setup` + `cleanup` 等同"）。缺了它，`setup` 就退化成一个普通的 `seq`，
 * **而调用方会以为清理一定会跑**——那是最危险的一类静默退化。
 */
export function setup(before: Node, child: Node, after: Node): SetupNode {
  assertNode(before, "setup 的 before（前置）");
  assertNode(child, "setup 的 child（主体）");
  assertNode(after, "setup 的 after（后置，保证执行）");
  return { node: 'setup', before, child, after };
}

/** `dependsOn(graph, nodes)`：显式依赖图；环在 `validate` 期检出。 */
export function dependsOn(
  graph: Readonly<Record<string, readonly string[]>>,
  nodes: Readonly<Record<string, Node>>,
): DependsOnNode {
  for (const [name, deps] of Object.entries(graph)) {
    if (!(name in nodes)) {
      throw new DslError(`dependsOn 的图里有节点 '${name}'，但 nodes 里没有它`);
    }
    for (const dep of deps) {
      if (!(dep in nodes)) {
        throw new DslError(`节点 '${name}' 依赖 '${dep}'，但 nodes 里没有它`);
      }
    }
  }
  for (const [name, n] of Object.entries(nodes)) {
    assertNode(n, `dependsOn 的节点 '${name}'`);
  }
  return { node: 'dependsOn', graph, nodes };
}

/** 引用另一个场景（`normalize` 会内联它）。 */
export function ref(to: string): ScenarioRef {
  if (typeof to !== 'string' || to === '') {
    throw new DslError('ref(to) 的 to 必须是非空字符串');
  }
  return { node: 'ref', to };
}

// ------------------------------------------------------------------- 场景构造

/** 小类场景。 */
export function scenario(spec: {
  id: string;
  title: string;
  root: Node;
  layer?: Layer;
  confidence?: ConfidenceLevel;
  resources?: readonly ResourceDecl[];
  seed?: number;
}): Scenario {
  if (!spec.id) throw new DslError('场景 id 不能为空（报告与对拍都以它为主键）');
  return {
    id: spec.id,
    title: spec.title,
    root: spec.root,
    ...(spec.layer === undefined ? {} : { layer: spec.layer }),
    ...(spec.confidence === undefined ? {} : { confidence: spec.confidence }),
    ...(spec.resources === undefined ? {} : { resources: spec.resources }),
    ...(spec.seed === undefined ? {} : { seed: spec.seed }),
  };
}

/**
 * 大类场景（测试域）。
 *
 * `sharedContext` 必须**显式给出**（没有缺省）：设计 §2.3 要求报告里能区分
 * "这条失败是不是上一条污染的"，而那个判断的前提是"共享与否是被声明的"。
 */
export function largeScenario(spec: {
  id: string;
  title: string;
  contains: readonly Scenario[];
  sharedContext: boolean;
  layer?: Layer;
  confidence?: ConfidenceLevel;
  resources?: readonly ResourceDecl[];
  seed?: number;
}): LargeScenario {
  if (!spec.id) throw new DslError('大类场景 id 不能为空');
  if (spec.contains.length === 0) throw new DslError('大类场景至少要包含一个小类');
  return {
    id: spec.id,
    title: spec.title,
    contains: spec.contains,
    sharedContext: spec.sharedContext,
    ...(spec.layer === undefined ? {} : { layer: spec.layer }),
    ...(spec.confidence === undefined ? {} : { confidence: spec.confidence }),
    ...(spec.resources === undefined ? {} : { resources: spec.resources }),
    ...(spec.seed === undefined ? {} : { seed: spec.seed }),
  };
}

// ---------------------------------------------------------------------- 辅助

/** DSL 层面的用法错误（**编译期**拒绝，对应退出码 2「用法错误」）。 */
export class DslError extends Error {
  public override readonly name = 'DslError';
}

/**
 * 条件必须是编译期可判定的。
 *
 * 这条不是形式检查：`when` 的语义是"两支都进图，运行期剪一支"。
 * 如果条件依赖运行期数据（例如"上一步的输出是否为真"），
 * 那么**剪枝在编译期就做不了**，而 §5.1 明确要求"条件必须是编译期可判定的"——
 * 否则覆盖矩阵看到的图与实际执行的图不一致，L3（子图剪枝正确性）无从谈起。
 */
function assertCompileTimeDecidable(cond: Condition): void {
  switch (cond.kind) {
    case 'capability':
    case 'version':
    case 'config':
      return;
    default: {
      const never: never = cond;
      throw new DslError(`未知的条件种类：${JSON.stringify(never)}`);
    }
  }
}
