/**
 * step registry 的加载与校验（`registry/`）。
 *
 * ## 这是什么
 *
 * 一组**参数化的步骤片段**（`registry/steps/**\/*.yaml`）。场景在步骤上写
 * `use: 'invoke/tool'` + `with: { tool: read_file, args: {...} }`，由
 * `expand.ts` 把片段里的占位符替换成 `with` 的值，得到可以**一键展平**的字面步骤。
 *
 * ## 展开语义（唯一约定，别发明别的）
 *
 *   1. **只做替换，不做语义推断**：`{name}` / `{a.b}` 按占位符替换成 `with` 的值；
 *      整串占位保留原类型（数组/对象/数字原样传），嵌入字符串的占位要求标量。
 *   2. `with` 里给了片段**没声明**的参数 → problem（挡住拼写错误）。
 *   3. 片段声明了**必填**参数而 `with` 没给 → problem。
 *   4. 展开结果不残留 `use` / `with`。
 *
 * ## 硬约束（本文件 + expand.ts + checkRegistry 一起守）
 *
 *   · **无环**：step 片段**不得 use 别的 step**（只有场景能 use 片段）；
 *     `dependencies` 只用于校验（存在性 + 无环），不产生隐式调用。
 *   · **无隐式状态**：跨步数据必须由场景在 `act` / `expect` 里显式用 `fx.` 引用。
 *   · **禁止 YAML 控制流**：`if` / `for` / `while` / `include` / `extends` 一律报错。
 *   · **场景锁版本**：用 `use:` 的场景必须带 `registry:v<version>` 标签（在 expand.ts 里判）。
 *
 * ## 职责切分
 *
 *   · `loadRegistry`：扫描 / 解析 / 形状校验（含"片段里出现 use"与未知键）/ 重名，
 *     问题都带**文件路径**，便于逐条点名。
 *   · `checkRegistry`：参数 schema、依赖存在性、依赖成环；并叠加 load 阶段的问题。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { Assertion, StepAction } from '../cases/types.js'

/** 片段成本档位（与 `CostClass` 同词汇，这里不复用是为了让 registry 可独立编译）。 */
export type StepCost = 'none' | 'low' | 'high'

/** 一个步骤片段。字段名是**冻结 API**，工具面/命令面会直接读它。 */
export interface StepFragment {
  /** 片段名，形如 `invoke/tool`（`<域>/<名>`）。 */
  name: string
  /** 片段版本（语义变化才 +1）。 */
  version: string
  /** 一句话说明这个片段做什么。 */
  description: string
  /** 参数描述（简化 JSON Schema 的 object 形状）。 */
  params?: Record<string, unknown>
  /** 依赖的其它 step 名；**只用于校验**（存在性 + 无环），不允许 use。 */
  dependencies: string[]
  /** 成本档位（保守声明；真实判定在 executor/policy.ts）。 */
  cost?: StepCost
  /** 沙箱需求声明。 */
  sandbox?: Record<string, unknown>
  /** 字面动作模板（占位符形式）。 */
  act?: StepAction
  /** 字面断言模板（占位符形式）。 */
  expect?: Assertion[]
}

/** 加载结果。字段名是**冻结 API**。 */
export interface LoadedRegistry {
  /** 清单 `registry/registry.yaml` 里声明的版本。 */
  version: string
  /** 片段名 → 片段。 */
  steps: Map<string, StepFragment>
  /** 加载阶段的问题（带文件路径）。 */
  problems: string[]
}

const STEP_NAME_RE = /^[a-z][a-z0-9-]*(?:\/[a-z0-9-]+)+$/
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array'])
const COSTS = new Set(['none', 'low', 'high'])
const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access'])
const FORBIDDEN_KEYS = new Set(['if', 'for', 'while', 'include', 'extends'])
const FRAGMENT_KEYS = new Set([
  'name',
  'version',
  'description',
  'params',
  'dependencies',
  'cost',
  'sandbox',
  'act',
  'expect',
])
const PARAM_ROOT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'description'])
const ASSERTION_WORDS = [
  'is',
  'isNot',
  'notIs',
  'exists',
  'notExists',
  'contains',
  'notContains',
  'matches',
  'atLeast',
  'atMost',
  'length',
  'lengthAtLeast',
  'lengthAtMost',
  'throws',
] as const

/** 占位符：`{name}` 或 `{a.b.c}`。`{2,3}` 这类正则量词不会命中（要求以字母/下划线开头）。 */
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/g

/** 片段里允许出现的占位符根名字（即 `params.properties` 的键）。 */
export function declaredParamNames(fragment: StepFragment): string[] {
  const params = fragment.params
  if (params === undefined) return []
  const properties = params['properties']
  if (properties === null || typeof properties !== 'object' || Array.isArray(properties)) return []
  return Object.keys(properties as Record<string, unknown>)
}

/** 参数默认值表；无默认值的参数返回 undefined。 */
export function paramDefaults(fragment: StepFragment): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const params = fragment.params
  const properties =
    params !== undefined && params['properties'] !== null && typeof params['properties'] === 'object'
      ? (params['properties'] as Record<string, unknown>)
      : {}
  for (const [key, spec] of Object.entries(properties)) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) continue
    const record = spec as Record<string, unknown>
    if ('default' in record) out.set(key, record['default'])
  }
  return out
}

/** 必填参数名。 */
export function requiredParamNames(fragment: StepFragment): string[] {
  const params = fragment.params
  if (params === undefined) return []
  const required = params['required']
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === 'string') : []
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 递归找被禁的控制流键（只看键名，不看字符串内容）。 */
function findForbiddenKeys(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${path}[${index}]`, out))
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) out.push(`${path}.${key}`)
    findForbiddenKeys(child, `${path}.${key}`, out)
  }
}

/** 递归收集字符串里的占位符根名。 */
function collectPlaceholders(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
      const root = (match[1] ?? '').split('.')[0]
      if (root) out.add(root)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPlaceholders(item, out)
    return
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectPlaceholders(child, out)
  }
}

/** 递归列出目录下所有 YAML 文件（排序，保证可复现）。 */
function walkYaml(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    if (entry === 'registry.yaml' || entry === 'index.yaml') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walkYaml(full))
    else if (/\.ya?ml$/i.test(entry)) out.push(full)
  }
  return out
}

function describePath(root: string, file: string): string {
  return relative(root, file).split('\\').join('/')
}

/**
 * 扫描 `registryDir`（清单 `registry.yaml` + `steps/**\/*.yaml`）并做形状校验。
 *
 * 单个文件坏掉**不阻断**加载：坏件记进 `problems`，其余片段照常可用。
 */
export function loadRegistry(opts: { registryDir: string }): LoadedRegistry {
  const registryDir = opts.registryDir
  const problems: string[] = []
  const steps = new Map<string, StepFragment>()
  let version = '0'

  if (!existsSync(registryDir) || !statSync(registryDir).isDirectory()) {
    return { version, steps, problems: [`registry 目录不存在或不是目录：${registryDir}`] }
  }

  // ---- 清单：版本号是"场景锁注册表版本"的比对基准 ----
  const manifestPath = join(registryDir, 'registry.yaml')
  if (!existsSync(manifestPath)) {
    problems.push('registry.yaml（清单）缺失——无法确定注册表版本，场景的版本锁会失去基准')
  } else {
    try {
      const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as unknown
      if (!isPlainObject(manifest)) {
        problems.push('registry.yaml: 顶层必须是对象')
      } else if (typeof manifest['version'] !== 'string' || manifest['version'].trim() === '') {
        problems.push('registry.yaml: version 必须是非空字符串')
      } else {
        version = manifest['version']
      }
    } catch (error) {
      problems.push(`registry.yaml: 解析失败：${String(error)}`)
    }
  }

  const stepsDir = join(registryDir, 'steps')
  const scanRoot = existsSync(stepsDir) && statSync(stepsDir).isDirectory() ? stepsDir : registryDir
  const files = walkYaml(scanRoot)

  if (files.length === 0) problems.push(`registry 里没有任何 step 片段（扫描 ${scanRoot}）`)

  for (const file of files) {
    const at = describePath(registryDir, file)
    let raw: unknown
    try {
      raw = parseYaml(readFileSync(file, 'utf8'))
    } catch (error) {
      problems.push(`${at}: YAML 解析失败：${String(error)}`)
      continue
    }
    if (!isPlainObject(raw)) {
      problems.push(`${at}: 顶层必须是对象`)
      continue
    }

    // 禁止 YAML 控制流（连键名都不允许出现）
    const forbidden: string[] = []
    findForbiddenKeys(raw, at, forbidden)
    for (const hit of forbidden) problems.push(`${hit}: 禁止 YAML 控制流（if / for / while / include / extends）`)

    // 未知键：拼错 `descriptoin` 这类必须报错，而不是静默忽略
    for (const key of Object.keys(raw)) {
      if (!FRAGMENT_KEYS.has(key)) {
        problems.push(`${at}: 未知字段 ${key}（片段只允许 ${[...FRAGMENT_KEYS].join(' / ')}）`)
      }
    }

    // 片段**不得 use 别的 step**：只有场景能 use 片段（无环硬约束）
    if ('use' in raw) {
      problems.push(`${at}: step 片段里不得出现 use（只有场景能 use 片段；依赖请写 dependencies，且它不产生调用）`)
    }

    const name = raw['name']
    if (typeof name !== 'string' || !STEP_NAME_RE.test(name)) {
      problems.push(`${at}: name 必须是 <域>/<名> 形状的小写标识符（例如 invoke/tool），实际 ${JSON.stringify(name)}`)
      continue
    }
    if (steps.has(name)) {
      problems.push(`${at}: 片段名重复（${name} 已在别的文件里定义）`)
      continue
    }
    if (typeof raw['version'] !== 'string' || raw['version'].trim() === '') {
      problems.push(`${at}: version 必须是非空字符串`)
    }
    if (typeof raw['description'] !== 'string' || raw['description'].trim() === '') {
      problems.push(`${at}: description 必须是非空字符串`)
    }

    // act / expect 至少要有一个，否则这个片段展开出来是个空步骤
    const hasAct = raw['act'] !== undefined
    const hasExpect = Array.isArray(raw['expect']) && raw['expect'].length > 0
    if (!hasAct && !hasExpect) {
      problems.push(`${at}: 片段至少要给出 act 或非空 expect（空片段展开不出可判定的步骤）`)
    }
    if (raw['expect'] !== undefined && !Array.isArray(raw['expect'])) {
      problems.push(`${at}: expect 必须是数组`)
    }
    if (Array.isArray(raw['expect'])) {
      raw['expect'].forEach((assertion, index) => {
        if (!isPlainObject(assertion)) {
          problems.push(`${at}: expect[${index}] 必须是对象`)
          return
        }
        if (typeof assertion['ref'] !== 'string' || assertion['ref'].trim() === '') {
          problems.push(`${at}: expect[${index}].ref 必须是非空字符串`)
        }
        const words = ASSERTION_WORDS.filter((word) => assertion[word] !== undefined)
        if (words.length === 0) {
          problems.push(`${at}: expect[${index}] 缺少判定词（${ASSERTION_WORDS.join(' | ')}）`)
        } else if (words.length > 1) {
          problems.push(`${at}: expect[${index}] 一行只允许一个判定词，发现 ${words.join(' + ')}`)
        }
      })
    }

    // dependencies
    let dependencies: string[] = []
    if (raw['dependencies'] !== undefined) {
      if (!Array.isArray(raw['dependencies']) || raw['dependencies'].some((d) => typeof d !== 'string' || d.trim() === '')) {
        problems.push(`${at}: dependencies 必须是非空字符串数组`)
      } else {
        dependencies = raw['dependencies'] as string[]
      }
    }

    // cost / sandbox
    if (raw['cost'] !== undefined && !COSTS.has(String(raw['cost']))) {
      problems.push(`${at}: cost 只能是 none | low | high，实际 ${JSON.stringify(raw['cost'])}`)
    }
    if (raw['sandbox'] !== undefined) {
      if (!isPlainObject(raw['sandbox'])) {
        problems.push(`${at}: sandbox 必须是对象`)
      } else if (
        raw['sandbox']['mode'] !== undefined &&
        !SANDBOX_MODES.has(String(raw['sandbox']['mode']))
      ) {
        problems.push(`${at}: sandbox.mode 只能是 read-only | workspace-write | danger-full-access`)
      }
    }

    const fragment: StepFragment = {
      name,
      version: typeof raw['version'] === 'string' ? raw['version'] : '0',
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      ...(raw['params'] === undefined ? {} : { params: raw['params'] as Record<string, unknown> }),
      dependencies,
      ...(raw['cost'] === undefined ? {} : { cost: raw['cost'] as StepCost }),
      ...(raw['sandbox'] === undefined ? {} : { sandbox: raw['sandbox'] as Record<string, unknown> }),
      ...(raw['act'] === undefined ? {} : { act: raw['act'] as StepAction }),
      ...(raw['expect'] === undefined ? {} : { expect: raw['expect'] as Assertion[] }),
    }

    // 占位符必须来自已声明的参数：模板里写错 `{condtion}` 必须报错，
    // 否则展开时它会被当成字面文本静默留下。
    const placeholderRoots = new Set<string>()
    collectPlaceholders(fragment.act, placeholderRoots)
    collectPlaceholders(fragment.expect, placeholderRoots)
    const declared = new Set(declaredParamNames(fragment))
    for (const root of placeholderRoots) {
      if (!declared.has(root)) {
        problems.push(`${at} (${name}): 模板里用了占位符 {${root}}，但 params.properties 没有声明它`)
      }
    }

    steps.set(name, fragment)
  }

  return { version, steps, problems }
}

/** 简化 JSON Schema 形状校验：只认 object 根 + 少量类型词汇。 */
function validateParamsSchema(name: string, fragment: StepFragment): string[] {
  const problems: string[] = []
  const params = fragment.params
  if (params === undefined) return problems
  if (params['type'] !== undefined && params['type'] !== 'object') {
    problems.push(`${name}: params.type 只能是 object（片段参数是一个对象），实际 ${JSON.stringify(params['type'])}`)
  }
  for (const key of Object.keys(params)) {
    if (!PARAM_ROOT_KEYS.has(key)) problems.push(`${name}: params 里未知字段 ${key}`)
  }
  const properties = params['properties']
  if (properties !== undefined && !isPlainObject(properties)) {
    problems.push(`${name}: params.properties 必须是对象`)
    return problems
  }
  if (isPlainObject(properties)) {
    for (const [param, spec] of Object.entries(properties)) {
      if (!isPlainObject(spec)) {
        problems.push(`${name}: params.properties.${param} 必须是对象`)
        continue
      }
      const type = spec['type']
      if (typeof type !== 'string' || !PARAM_TYPES.has(type)) {
        problems.push(
          `${name}: params.properties.${param}.type 必须是 ${[...PARAM_TYPES].join(' | ')} 之一，实际 ${JSON.stringify(type)}`,
        )
      }
      if (spec['enum'] !== undefined && !Array.isArray(spec['enum'])) {
        problems.push(`${name}: params.properties.${param}.enum 必须是数组`)
      }
      for (const key of Object.keys(spec)) {
        if (!['type', 'description', 'default', 'enum'].includes(key)) {
          problems.push(`${name}: params.properties.${param} 未知字段 ${key}`)
        }
      }
    }
  }
  const required = params['required']
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((item) => typeof item !== 'string')) {
      problems.push(`${name}: params.required 必须是字符串数组`)
    } else if (isPlainObject(properties)) {
      for (const item of required as string[]) {
        if (!(item in properties)) {
          problems.push(`${name}: params.required 里的 ${item} 没有对应 properties 声明`)
        }
      }
    }
  }
  return problems
}

/** 依赖成环检测（DFS 三色）。 */
function findDependencyCycles(graph: Map<string, string[]>): string[] {
  const problems: string[] = []
  const color = new Map<string, 0 | 1 | 2>()
  const stack: string[] = []
  const visit = (name: string): void => {
    color.set(name, 1)
    stack.push(name)
    for (const dep of graph.get(name) ?? []) {
      const seen = color.get(dep) ?? 0
      if (seen === 1) {
        const from = stack.indexOf(dep)
        problems.push(`依赖成环：${[...stack.slice(from), dep].join(' → ')}`)
      } else if (seen === 0) {
        visit(dep)
      }
    }
    stack.pop()
    color.set(name, 2)
  }
  for (const name of graph.keys()) {
    if ((color.get(name) ?? 0) === 0) visit(name)
  }
  return problems
}

/**
 * 语义校验：参数 schema、依赖存在性、依赖成环；并叠加 load 阶段的问题。
 *
 * `ok` 为 true 当且仅当**一条问题都没有**。
 */
export function checkRegistry(reg: LoadedRegistry): { ok: boolean; problems: string[] } {
  const problems: string[] = [...reg.problems]

  for (const fragment of reg.steps.values()) {
    problems.push(...validateParamsSchema(fragment.name, fragment))
  }

  const graph = new Map<string, string[]>()
  for (const [name, fragment] of reg.steps) {
    const deps: string[] = []
    for (const dep of fragment.dependencies) {
      if (!reg.steps.has(dep)) {
        problems.push(`${name}: dependencies 里的 ${dep} 不存在`)
        continue
      }
      if (dep === name) {
        problems.push(`${name}: dependencies 不能依赖自己`)
        continue
      }
      deps.push(dep)
    }
    graph.set(name, deps)
  }

  problems.push(...findDependencyCycles(graph))

  return { ok: problems.length === 0, problems }
}
