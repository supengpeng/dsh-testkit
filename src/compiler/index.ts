/**
 * 场景编译器：`normalize → compose → validate → plan`（设计 §5.2）。
 *
 * **四层防御里的第 1、2 层落在这里**（设计 §5.3）：
 * - 第 1 层 TS 类型系统：类型错误、资源类型不匹配、生命周期错用 → 编译不过；
 * - 第 2 层本文件的 `validate`：依赖环、能力缺失、场景包含约束、嵌套超三层 → 拒绝生成 plan。
 *
 * 第 3 层（plan 校验）与第 4 层（执行器）在 Rust 侧——因为
 * "这台机器现在有没有 `subprocess` 能力"是**运行期事实**，类型系统看不到它。
 * 这正是 §1.1 "TS 侧不持有判定"与"TS 侧可以拒绝"的分界线：
 * **本文件可以拒绝编译，但不可以决定"这条断言过没过"**（那是 `crates/assertion` 的事）。
 *
 * 编译四阶段的提前收益（设计 §6.1，沿用原稿判断）：缺能力在启动前就 skip、
 * 总算力与审批点可预估、增量执行只跑受影响子图、报告天然按小类/大类聚合。
 */

import type { ConfidenceLevel } from '../contracts/generated/ConfidenceLevel.js';
import type { Edge } from '../contracts/generated/Edge.js';
import type { ExecutionPlan } from '../contracts/generated/ExecutionPlan.js';
import type { GateSpec } from '../contracts/generated/GateSpec.js';
import type { Layer } from '../contracts/generated/Layer.js';
import type { ResourceClaim } from '../contracts/generated/ResourceClaim.js';
import type { RetrySpec as RustRetrySpec } from '../contracts/generated/RetrySpec.js';
import type { ScenarioMetadata } from '../contracts/generated/ScenarioMetadata.js';
import type { ToolNode } from '../contracts/generated/ToolNode.js';
import {
  DslError,
  type Condition,
  type Node,
  type ResourceDecl,
  type Scenario,
  type ToolLeaf,
} from '../dsl/nodes.js';

/** 编译期剪掉的**编译期已知**分支（`when` 的条件在编译期可判定 ⇒ 剪枝可以在计划期完成）。 */
export interface PrunedBranch {
  /** 被剪节点的路径 id。 */
  readonly nodePath: string;
  /** 为什么剪（人类可读）。 */
  readonly reason: string;
  /** 判定依据（条件原文）。 */
  readonly condition: Condition;
}

/** validate 的一条发现。`error` 会拒绝生成 plan；`warning` 只记录。 */
export interface Finding {
  readonly level: 'error' | 'warning';
  /** 机器可读的类别（对应 F1–F5 的注入集）。 */
  readonly kind:
    | 'capability-missing'
    | 'version-incompatible'
    | 'dependency-cycle'
    | 'resource-conflict'
    | 'nesting-too-deep'
    | 'leaf-contains-scenario'
    | 'layer-confidence-mismatch';
  /** 涉及的对象（节点 id / 场景 id / 资源 id）。 */
  readonly subject: string;
  /** 人类可读说明。 */
  readonly detail: string;
}

/** 编译选项：**宿主事实**（能力 / 版本 / 配置）必须由调用方传入——编译器不探测。 */
export interface CompileOptions {
  /** 已探测到的能力集合（成员见 `spec/contracts/capabilities.yaml`）。 */
  readonly capabilities: ReadonlySet<string>;
  /** 宿主 DSH 版本。 */
  readonly dshVersion: string;
  /** 声明的支持范围（真源：`spec/contracts/versions.yaml`）。 */
  readonly versionRange: string;
  /** 已知配置（供 `when` 的 `config` 条件使用）。 */
  readonly config?: Readonly<Record<string, unknown>>;
  /** 随机种子（进 `ScenarioMetadata`；指标 C1 的结构保证）。 */
  readonly seed?: number;
  /** 已知的其它场景（供 `ref()` 内联）。 */
  readonly scenarios?: readonly Scenario[];
}

/** 编译结果。 */
export interface CompileResult {
  /** 生成的执行计划（可直接交给 Rust 核心）。 */
  readonly plan: ExecutionPlan;
  /** 编译期剪掉的分支——**剪枝必须可见**（设计 §5.4 / L3）。 */
  readonly pruned: readonly PrunedBranch[];
  /** validate 的发现。 */
  readonly findings: readonly Finding[];
}

/** 编译失败（第 2 层防御拒绝生成 plan，对应退出码 2「用法错误」）。 */
export class CompileError extends Error {
  public override readonly name = 'CompileError';
  public constructor(
    message: string,
    /** 触发拒绝的发现（全部 error 级）。 */
    public readonly findings: readonly Finding[],
  ) {
    super(message);
  }
}

/** 场景嵌套深度上限（设计 §5.1 硬规则 2）。 */
export const MAX_SCENARIO_DEPTH = 3;

// ---------------------------------------------------------------- normalize

interface Normalized {
  readonly root: Node;
}

/**
 * 第 1 阶段：`normalize`。
 *
 * 做两件事：**内联 `ref()`**、**代入 `matrix` 变量**。
 *
 * **不做**语义推断：设计 §5.2 明确"`use:` 的展开是纯文本替换，不做语义推断"，
 * 那条纪律沿用的是既有 step registry（`src/registry`），本编译器**不重新实现它**——
 * 两者的分工是：本文件处理**结构化引用**（`ref` / `matrix`），
 * registry 处理**文本片段替换**（`use:`）。这条分工必须写清楚，
 * 否则会出现"同一个 `with:` 在两处被展开两次"的双真源问题。
 */
function normalize(node: Node, refs: ReadonlyMap<string, Scenario>, path: string): Normalized {
  switch (node.node) {
    case 'ref': {
      const target = refs.get(node.to);
      if (target === undefined) {
        throw new DslError(`ref('${node.to}') 找不到被引场景（编译期必须可解析）`);
      }
      return { root: normalize(target.root, refs, `${path}->${node.to}`).root };
    }
    case 'seq':
    case 'parallel':
      return {
        root: {
          ...node,
          children: node.children.map((c, i) => normalize(c, refs, `${path}/${i}`).root),
        },
      };
    case 'when': {
      const then = normalize(node.then, refs, `${path}/then`).root;
      if (node.otherwise === undefined) return { root: { ...node, then } };
      return { root: { ...node, then, otherwise: normalize(node.otherwise, refs, `${path}/else`).root } };
    }
    case 'retry':
      return { root: { ...node, child: normalize(node.child, refs, `${path}/retry`).root } };
    case 'matrix':
      return { root: { ...node, child: normalize(node.child, refs, `${path}/matrix`).root } };
    case 'setup':
      return {
        root: {
          ...node,
          before: normalize(node.before, refs, `${path}/before`).root,
          child: normalize(node.child, refs, `${path}/body`).root,
          after: normalize(node.after, refs, `${path}/after`).root,
        },
      };
    case 'dependsOn': {
      const nodes: Record<string, Node> = {};
      for (const [name, n] of Object.entries(node.nodes)) {
        nodes[name] = normalize(n, refs, `${path}/dep/${name}`).root;
      }
      return { root: { ...node, nodes } };
    }
    case 'tool':
      return { root: node };
    default: {
      const never: never = node;
      throw new DslError(`normalize：未知节点 ${JSON.stringify(never)}`);
    }
  }
}

// ------------------------------------------------------------------ compose

interface Composed {
  readonly nodes: ToolNode[];
  readonly edges: Edge[];
  readonly pruned: PrunedBranch[];
  /** 资源声明（`declaredBy` 是节点 id）。 */
  readonly resources: ResourceClaim[];
  /** 实际出现的最大嵌套深度。 */
  maxDepth: number;
  /** 需要的能力（节点 → 能力），供 validate 用。 */
  readonly requiresByNode: Map<string, readonly string[]>;
  /** 每个 `parallel` 分支内的节点集合，供资源冲突检查用。 */
  readonly parallelGroups: string[][];
}

/** 代入 `${name}` 形式的占位符（`matrix` 的参数化）。 */
function substitute(value: unknown, vars: Readonly<Record<string, string | number | boolean>>): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
      const v = vars[name];
      return v === undefined ? whole : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substitute(v, vars);
    }
    return out;
  }
  return value;
}

/** 把 DSL 的 `resources` 转成跨语言的 `ResourceClaim`。 */
function toClaims(decls: readonly ResourceDecl[] | undefined, declaredBy: string): ResourceClaim[] {
  return (decls ?? []).map((d) => ({
    resource_id: d.resourceId,
    kind: d.kind,
    exclusive: d.exclusive,
    declared_by: declaredBy,
  }));
}

function evaluateCondition(
  cond: Condition,
  options: CompileOptions,
): { value: boolean; reason: string } {
  switch (cond.kind) {
    case 'capability': {
      const present = options.capabilities.has(cond.id);
      return {
        value: present === cond.present,
        reason: `能力 '${cond.id}' ${present ? '存在' : '缺失'}（要求 present=${String(cond.present)}）`,
      };
    }
    case 'version': {
      // 版本区间判定沿用既有 `src/fixtures/compat.ts` 的语义（阶段 2 要对拍，
      // 所以这里**不做**第二套实现：只做"是否等于声明范围"的粗判，并把它标出来）。
      const compatible = cond.range === options.versionRange;
      return {
        value: compatible,
        reason: `版本区间 '${cond.range}' ${compatible ? '=' : '≠'} 声明范围 '${options.versionRange}'`,
      };
    }
    case 'config': {
      const actual = options.config?.[cond.key];
      const value = actual === cond.equals;
      return {
        value,
        reason: `配置 '${cond.key}' = ${JSON.stringify(actual)}（要求 ${JSON.stringify(cond.equals)}）`,
      };
    }
    default: {
      const never: never = cond;
      throw new DslError(`未知条件：${JSON.stringify(never)}`);
    }
  }
}

function compose(
  node: Node,
  path: string,
  options: CompileOptions,
  out: Composed,
  depth: number,
  vars: Readonly<Record<string, string | number | boolean>>,
  parallelSink: string[] | null,
): string {
  out.maxDepth = Math.max(out.maxDepth, depth);
  if (depth > MAX_SCENARIO_DEPTH) {
    throw new DslError(`场景嵌套深度 ${depth} 超过上限 ${MAX_SCENARIO_DEPTH}（设计 §5.1 硬规则 2）`);
  }

  switch (node.node) {
    case 'ref':
      // normalize 之后不该有 ref 残留。
      throw new DslError(`compose：发现未内联的 ref('${node.to}')，normalize 阶段漏了`);

    case 'tool': {
      const nodeId = node.id ?? path;
      const input = substitute(node.input, vars) as Record<string, unknown>;
      const gate: GateSpec | undefined =
        node.requires === undefined || node.requires.length === 0
          ? undefined
          : {
              requires: [...node.requires],
              on_missing: node.onMissing ?? 'skip',
              ...(node.fallback === undefined ? {} : { fallback: node.fallback }),
            };
      const retrySpec: RustRetrySpec | undefined =
        node.retry === undefined
          ? undefined
          : {
              times: node.retry.times,
              backoff_ms: node.retry.backoffMs ?? 0,
              // 白名单缺省 = 两类都允许；**`product_bug` 永不在列**（类型层已保证）。
              on: [...(node.retry.on ?? (['inconclusive', 'env'] as const))],
            };
      const tool: ToolNode = {
        node_id: nodeId,
        tool_kind: node.tool,
        input,
        ...(gate === undefined ? {} : { gate }),
        ...(retrySpec === undefined ? {} : { retry: retrySpec }),
        ...(node.timeoutMs === undefined ? {} : { timeout_ms: node.timeoutMs }),
        ...(node.minConfidence === undefined ? {} : { min_confidence: node.minConfidence }),
      };
      out.nodes.push(tool);
      out.requiresByNode.set(nodeId, node.requires ?? []);
      out.resources.push(...toClaims(node.resources, nodeId));
      if (parallelSink !== null) parallelSink.push(nodeId);
      return nodeId;
    }

    case 'seq': {
      const ids = node.children.map((c, i) =>
        compose(c, `${path}/${i}`, options, out, depth + 1, vars, parallelSink),
      );
      for (let i = 0; i + 1 < ids.length; i += 1) {
        out.edges.push({ from: ids[i]!, to: ids[i + 1]! });
      }
      return ids[0] ?? path;
    }

    case 'parallel': {
      const group: string[] = [];
      const ids = node.children.map((c, i) =>
        compose(c, `${path}/${i}`, options, out, depth, vars, group),
      );
      out.parallelGroups.push(group);
      // 并发分支之间没有边（它们并行启动）；汇聚点在 plan 阶段处理。
      return ids[0] ?? path;
    }

    case 'when': {
      const verdict = evaluateCondition(node.cond, options);
      if (verdict.value) {
        if (node.otherwise !== undefined) {
          out.pruned.push({
            nodePath: `${path}/else`,
            reason: `条件为真 ⇒ 剪掉 else 支：${verdict.reason}`,
            condition: node.cond,
          });
        }
        return compose(node.then, `${path}/then`, options, out, depth + 1, vars, parallelSink);
      }
      if (node.otherwise === undefined) {
        out.pruned.push({
          nodePath: `${path}/then`,
          reason: `条件为假且无 else ⇒ 整支剪掉：${verdict.reason}`,
          condition: node.cond,
        });
        return path;
      }
      out.pruned.push({
        nodePath: `${path}/then`,
        reason: `条件为假 ⇒ 剪掉 then 支：${verdict.reason}`,
        condition: node.cond,
      });
      return compose(node.otherwise, `${path}/else`, options, out, depth + 1, vars, parallelSink);
    }

    case 'retry': {
      // 语义差异（设计 §9.1）：`runtime.repeat` 重跑整条，`retry` 重试**单点**。
      // 所以它只能作用于工具叶子——包住复合节点时"重试哪一点"没有定义，
      // 而展开成 N 个节点也不对（会让节点数在报告里虚增，且丢失
      // "这是同一个点的重试"这个事实）。
      if (node.child.node !== 'tool') {
        throw new DslError(
          `retry 只能作用于工具叶子（设计 §9.1：它重试「单点」），实际包住了 '${node.child.node}'`,
        );
      }
      if (node.child.retry !== undefined) {
        throw new DslError(
          `工具 '${node.child.tool}' 同时有内建 retry 与 retry(...) 包装——重试声明只能有一处（不静默覆盖）`,
        );
      }
      const wrapped: ToolLeaf = { ...node.child, retry: node.spec };
      return compose(wrapped, `${path}/retry`, options, out, depth + 1, vars, parallelSink);
    }

    case 'matrix': {
      const ids: string[] = [];
      for (const c of node.cases) {
        const merged = { ...vars, ...c.vars };
        ids.push(compose(node.child, `${path}/@${c.name}`, options, out, depth, merged, parallelSink));
      }
      return ids[0] ?? path;
    }

    case 'setup': {
      const beforeId = compose(node.before, `${path}/before`, options, out, depth + 1, vars, parallelSink);
      const bodyId = compose(node.child, `${path}/body`, options, out, depth + 1, vars, parallelSink);
      const afterId = compose(node.after, `${path}/after`, options, out, depth + 1, vars, parallelSink);
      out.edges.push({ from: beforeId, to: bodyId });
      // `after` **保证执行**（即使 body 失败）⇒ 边存在，且执行器必须把它放进 finally 语义。
      out.edges.push({ from: bodyId, to: afterId });
      return beforeId;
    }

    case 'dependsOn': {
      const idOf = new Map<string, string>();
      for (const [name, n] of Object.entries(node.nodes)) {
        idOf.set(name, compose(n, `${path}/${name}`, options, out, depth + 1, vars, parallelSink));
      }
      for (const [name, deps] of Object.entries(node.graph)) {
        const to = idOf.get(name);
        for (const dep of deps) {
          const from = idOf.get(dep);
          if (from !== undefined && to !== undefined) out.edges.push({ from, to });
        }
      }
      return [...idOf.values()][0] ?? path;
    }

    default: {
      const never: never = node;
      throw new DslError(`compose：未知节点 ${JSON.stringify(never)}`);
    }
  }
}

// ----------------------------------------------------------------- validate

/**
 * 层级 → 允许的可信度（真源：设计 §8.2 的七层表 + §8.1 的四态定义）。
 *
 * | 层级 | 允许 | 依据 |
 * |---|---|---|
 * | `l0` | `static` | L0 无宿主（"本工具不参与"）⇒ 未执行 |
 * | `l1` `l2` | `simulated` | Mock / Mock ⇒ 模拟宿主或模拟能力 |
 * | `l3`–`l6` | `real` \| `degraded` | 真实宿主；`degraded` 是"**真实宿主上的降级态**"，所以**只能**出现在这里 |
 *
 * ⚠️ **同一语义在 Rust 侧还有一处实现**：`crates/executor/src/validate.rs::allowed_confidence_for`。
 * 那一处**不能**被这里替代 —— 设计 §5.4 明确允许"**直接写 `ExecutionPlan` JSON**"的入口，
 * 那条路径绕过编译器，其可信度只能由 executor 在运行期拦。
 * 所以编译期与运行期是**两层**（对应 §5.3 的第 2 层与第 3 层），不是二选一。
 *
 * ⚠️ 但**两处实现必须有同源守卫**，否则 `degraded` 的适用范围（L3–L6）只要有一边改了，
 * 另一边就会**静默漂移**——而这类漂移的表现恰好是"某个层级的标记没被校验"，是最难发现的一种。
 * **目前尚无该守卫**（缺陷台账 D-10），这是本函数引入的已知风险，不是疏漏。
 *
 * 未知层级返回**空集**（不放行任何标记）——与 Rust 侧的 `_` 分支同向：**默认拒绝**。
 * 默认放行会让未来新增的层级**静默通过**，而那种错误只会在很久以后以
 * "某个层级的结果没被校验"的形式浮现。
 */
export function allowedConfidenceFor(layer: Layer): readonly ConfidenceLevel[] {
  switch (layer) {
    case 'l0':
      return ['static'];
    case 'l1':
    case 'l2':
      return ['simulated'];
    case 'l3':
    case 'l4':
    case 'l5':
    case 'l6':
      return ['real', 'degraded'];
    default:
      return [];
  }
}

/** 五项检查（设计 §5.2 / §5.3 第 2 层）。 */
function validate(
  scenario: Scenario,
  composed: Composed,
  options: CompileOptions,
): Finding[] {
  const findings: Finding[] = [];

  // ① 能力
  for (const [nodeId, requires] of composed.requiresByNode) {
    for (const cap of requires) {
      if (!options.capabilities.has(cap)) {
        findings.push({
          level: 'warning',
          kind: 'capability-missing',
          subject: nodeId,
          detail: `节点 '${nodeId}' 需要能力 '${cap}'，当前宿主没有 ⇒ 计划期可判定为 Skip（设计 §5.3 第 3 层在 Rust 侧再确认一次）`,
        });
      }
    }
  }

  // ② 版本
  if (options.versionRange !== '' && !options.capabilities.has('__version_checked__')) {
    // 版本兼容的**真源**是 `src/fixtures/compat.ts`（阶段 2 要对拍）；
    // 这里只做"声明范围非空"的形式检查，真正的判定在 Rust 侧（G2）。
    findings.push({
      level: 'warning',
      kind: 'version-incompatible',
      subject: scenario.id,
      detail: `声明范围 '${options.versionRange}'，宿主 '${options.dshVersion}'：完整判定由 Rust 侧 G2 给出（本处只做形式检查，避免造第二套实现）`,
    });
  }

  // ③ 依赖环（拓扑排序）
  const adjacency = new Map<string, string[]>();
  for (const n of composed.nodes) adjacency.set(n.node_id, []);
  for (const e of composed.edges) {
    adjacency.get(e.from)?.push(e.to);
  }
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cyclePath: string[] = [];
  const dfs = (id: string): boolean => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        const at = stack.indexOf(next);
        cyclePath.push(...stack.slice(at), next);
        return true;
      }
      if (c === WHITE && dfs(next)) return true;
    }
    stack.pop();
    color.set(id, BLACK);
    return false;
  };
  for (const n of composed.nodes) {
    if ((color.get(n.node_id) ?? WHITE) === WHITE && dfs(n.node_id)) break;
  }
  if (cyclePath.length > 0) {
    findings.push({
      level: 'error',
      kind: 'dependency-cycle',
      subject: cyclePath.join(' → '),
      detail: `依赖成环：${cyclePath.join(' → ')}（设计 §5.1 硬规则：dependsOn 禁止成环）`,
    });
  }

  // ④ 资源冲突（F3）：同一个 `parallel` 分支内，两个节点声明同一个**独占**资源
  for (const group of composed.parallelGroups) {
    const seen = new Map<string, string>();
    for (const nodeId of group) {
      for (const claim of composed.resources) {
        if (claim.declared_by !== nodeId || !claim.exclusive) continue;
        const prev = seen.get(claim.resource_id);
        if (prev !== undefined) {
          findings.push({
            level: 'error',
            kind: 'resource-conflict',
            subject: claim.resource_id,
            detail: `parallel 分支内节点 '${prev}' 与 '${nodeId}' 同时独占资源 '${claim.resource_id}'（F3：并发写同一资源）`,
          });
        } else {
          seen.set(claim.resource_id, nodeId);
        }
      }
    }
  }

  // ⑤ 嵌套深度
  if (composed.maxDepth > MAX_SCENARIO_DEPTH) {
    findings.push({
      level: 'error',
      kind: 'nesting-too-deep',
      subject: scenario.id,
      detail: `嵌套深度 ${composed.maxDepth} > ${MAX_SCENARIO_DEPTH}`,
    });
  }

  // ⑥ 层级与可信度自洽（K1 的**编译期**前置；运行期那层在 `crates/executor`，两层都要）
  if (scenario.layer !== undefined || scenario.confidence !== undefined) {
    const layer = scenario.layer ?? 'l3';
    const allowed = allowedConfidenceFor(layer);
    const declared = scenario.confidence;
    if (allowed.length === 0) {
      findings.push({
        level: 'error',
        kind: 'layer-confidence-mismatch',
        subject: scenario.id,
        detail: `未知层级 '${String(layer)}'：不放行任何可信度标记（默认拒绝——默认放行会让新增层级静默通过）`,
      });
    } else if (declared !== undefined && !allowed.includes(declared)) {
      findings.push({
        level: 'error',
        kind: 'layer-confidence-mismatch',
        subject: scenario.id,
        detail:
          `层级 '${layer}' 只允许可信度 ${allowed.join(' / ')}，实际声明 '${declared}'` +
          `（设计 §8.2 七层表 + §8.1 四态；同一判据在 Rust 侧 ${'`crates/executor/src/validate.rs::allowed_confidence_for`'}）`,
      });
    }
  }

  return findings;
}

// --------------------------------------------------------------------- plan

/** 拓扑排序（Kahn）。返回 `null` 表示有环（环已由 validate 报出）。 */
function topoSort(nodes: readonly ToolNode[], edges: readonly Edge[]): ToolNode[] | null {
  const indegree = new Map<string, number>();
  const byId = new Map<string, ToolNode>();
  for (const n of nodes) {
    indegree.set(n.node_id, 0);
    byId.set(n.node_id, n);
  }
  for (const e of edges) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
  }
  // 有序的待选集合：**用排序而不是插入序**，保证同输入 ⇒ 同 plan（C1）。
  const ready = [...indegree.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const out: ToolNode[] = [];
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const list = outgoing.get(e.from) ?? [];
    list.push(e.to);
    outgoing.set(e.from, list);
  }
  while (ready.length > 0) {
    const id = ready.shift()!;
    const node = byId.get(id);
    if (node !== undefined) out.push(node);
    for (const next of outgoing.get(id) ?? []) {
      const d = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, d);
      if (d === 0) {
        ready.push(next);
        ready.sort();
      }
    }
  }
  return out.length === nodes.length ? out : null;
}

// ------------------------------------------------------------------- compile

/**
 * 编译一个场景为 `ExecutionPlan`。
 *
 * 四阶段顺序执行；任一步抛 `DslError` / `CompileError` 即拒绝生成 plan
 * （对应退出码 2「用法错误」——不是"被测对象失败"）。
 */
export function compileScenario(scenario: Scenario, options: CompileOptions): CompileResult {
  const refs = new Map<string, Scenario>((options.scenarios ?? []).map((s) => [s.id, s]));
  refs.set(scenario.id, scenario);

  // ① normalize
  const { root } = normalize(scenario.root, refs, scenario.id);

  // ② compose
  const composed: Composed = {
    nodes: [],
    edges: [],
    pruned: [],
    resources: [],
    maxDepth: 0,
    requiresByNode: new Map(),
    parallelGroups: [],
  };
  compose(root, scenario.id, options, composed, 1, {}, null);

  // ③ validate
  const findings = validate(scenario, composed, options);
  const errors = findings.filter((f) => f.level === 'error');
  if (errors.length > 0) {
    throw new CompileError(
      `场景 '${scenario.id}' 未通过编译期校验（${errors.length} 条 error）：${errors.map((e) => e.kind).join(', ')}`,
      findings,
    );
  }

  // ④ plan
  const sorted = topoSort(composed.nodes, composed.edges);
  if (sorted === null) {
    // 理论上 validate 已经拦下环；这里是"防御性的一致检查"——
    // 如果它触发了，说明 validate 的环检测有漏，而那本身是个 bug。
    throw new CompileError(
      `场景 '${scenario.id}' 的图有环，但 validate 未报出（validate 与 plan 不一致，属实现缺陷）`,
      findings,
    );
  }

  const layer = scenario.layer ?? 'l3';
  const allowed = allowedConfidenceFor(layer);
  // 可信度缺省**由层级推导**（而不是硬编码 `'real'`）：
  // 一个 L0 场景若默认成 `real`，它就成了一条**与层级不自洽的声明** ——
  // 而"默认值本身制造错误"是最不该发生的一类问题。
  const confidence: ConfidenceLevel = scenario.confidence ?? allowed[0] ?? 'real';
  const metadata: ScenarioMetadata = {
    scenario_id: scenario.id,
    title: scenario.title,
    // ts-rs 按 serde 的 snake_case 把 `Layer::L3` 生成为字面量 `"l3"`（不是 `"L3"`）——
    // 跨语言字面量必须逐字对齐，这里写错会在运行期被 Rust 侧反序列化拒绝。
    layer,
    confidence,
    // 小类场景**恒不共享宿主**（设计 §2.3）。注意 `Scenario.sharedContext` 的类型是
    // `false | undefined`，所以这里不能写 `=== true`（那既永远为 false，类型上也不成立）。
    shared_context: false,
    depth: composed.maxDepth,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  };

  return {
    plan: {
      nodes: sorted,
      edges: [...composed.edges].sort((a, b) =>
        a.from === b.from ? (a.to < b.to ? -1 : 1) : a.from < b.from ? -1 : 1,
      ),
      metadata,
      resources: composed.resources,
    },
    pruned: composed.pruned,
    findings,
  };
}
