/**
 * 增量测试选择 —— 变更文件 → 受影响场景的**判定规则**（纯函数，可单测）。
 *
 * ## 取向：不认识的东西一律保守全选
 *
 * 增量选择最大的风险不是"多跑了几条"，而是"该跑的没跑"——一条静默漏跑的场景
 * 会让红灯变绿，而没有人会去追问"为什么它没跑"。因此规则分三档：
 *
 *   ① **命中若干条**：能准确说出"哪些场景受影响"的路径（kind 文件、step 片段、夹具、单条 case）；
 *   ② **不影响任何场景**：明确与场景执行无关的路径（`tests/**`、`docs/**`、`*.md`、
 *      `README`、`LICENSE`、`.github/**`）——注意这是**反例必须成立**的一档；
 *   ③ **保守命中全部**：内核路径（`src/adapters|runtime|cases|executor/**`）以及
 *      **任何认不出来的路径**。不默认放行、也不默认跳过。
 *
 * `reason` 必须说清每条规则为什么这样判，因为报告里要能回答"我改了一行，
 * 为什么它一条都没跑"。
 */

import { SCENARIO_KINDS, type Scenario } from '../cases/types.js'

export interface AffectedScenariosInput {
  scenarios: readonly Scenario[]
  /** step 片段注册表根；给了它就能把绝对路径换算成片段名。 */
  registryDir?: string
  /** 夹具根；给了它就能把绝对路径换算成夹具名。 */
  fixturesDir?: string
}

export interface AffectedScenariosResult {
  /** 受影响的场景 ID（按传入 scenarios 的顺序）。 */
  matched: string[]
  /** 人类可读的判定依据。 */
  reason: string
}

/** 改动这些路径 = 改内核，全部场景都要重跑。 */
export const KERNEL_PREFIXES = ['src/adapters/', 'src/runtime/', 'src/cases/', 'src/executor/'] as const

/** 这些路径与场景执行无关（反例档）。 */
export const IGNORED_PREFIXES = ['tests/', 'docs/', '.github/'] as const

/** 归一化：统一 `/`、去掉 `./` 前缀与首尾空白。 */
export function normalizePath(file: string): string {
  return String(file ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
}

/** 这条路径是否明确"不影响任何场景"。 */
export function isIgnoredPath(file: string): boolean {
  const path = normalizePath(file)
  if (path === '') return false
  const base = path.split('/').pop() ?? path
  if (/\.md$/i.test(base)) return true
  if (base === 'README' || base === 'LICENSE') return true
  for (const prefix of IGNORED_PREFIXES) {
    if (path.startsWith(prefix)) return true
  }
  return false
}

/** 场景"用到"的 kind：主 kind ＋ setup 键 ＋ 每步 act 的键（取交集于已注册 kind）。 */
export function scenarioKinds(scenario: Scenario): string[] {
  const known = new Set<string>(SCENARIO_KINDS as readonly string[])
  const out = new Set<string>()
  if (known.has(scenario.kind)) out.add(scenario.kind)
  for (const key of Object.keys(scenario.setup ?? {})) {
    if (known.has(key)) out.add(key)
  }
  for (const step of scenario.steps ?? []) {
    if (step.act === undefined) continue
    for (const key of Object.keys(step.act)) {
      if (known.has(key)) out.add(key)
    }
  }
  return [...out]
}

/** 场景复用到的 step 片段名。 */
export function scenarioStepUses(scenario: Scenario): string[] {
  const out: string[] = []
  for (const step of scenario.steps ?? []) {
    if (typeof step.use === 'string' && step.use.trim() !== '') out.push(step.use.trim())
  }
  return out
}

/** 从一个路径里剥出相对某个根的路径（`/` 分隔）；不在根下返回 undefined。 */
function relativeTo(root: string | undefined, file: string): string | undefined {
  if (root === undefined || root.trim() === '') return undefined
  const dir = normalizePath(root).replace(/\/+$/, '')
  const path = normalizePath(file)
  if (path === dir) return ''
  if (!path.startsWith(`${dir}/`)) return undefined
  return path.slice(dir.length + 1)
}

function stripExt(path: string): string {
  return path.replace(/\.ya?ml$/i, '')
}

/** 去掉源码扩展名（`src/kinds/llm.ts` → `llm`）。 */
function stripModuleExt(path: string): string {
  return path.replace(/\.(ts|tsx|mts|cts|js|mjs|cjs)$/i, '')
}

type Decision =
  | { action: 'all'; why: string }
  | { action: 'ids'; why: string; ids: string[] }
  | { action: 'none'; why: string }

function decide(file: string, input: AffectedScenariosInput): Decision {
  const scenarios = input.scenarios

  // ① 明确无关档
  if (isIgnoredPath(file)) {
    return { action: 'none', why: '测试/文档/CI 配置，不影响任何场景' }
  }

  // ② 内核档
  for (const prefix of KERNEL_PREFIXES) {
    if (file.startsWith(prefix)) {
      return { action: 'all', why: `内核路径（${prefix}**），全部场景重跑` }
    }
  }

  // ③ kind 实现档：src/kinds/<kind>.ts
  if (file.startsWith('src/kinds/')) {
    const rest = file.slice('src/kinds/'.length)
    const base = stripModuleExt(rest)
    if (!rest.includes('/') && (SCENARIO_KINDS as readonly string[]).includes(base)) {
      const ids = scenarios.filter((s) => scenarioKinds(s).includes(base)).map((s) => s.id)
      return { action: 'ids', why: `kind=${base} 的实现变化`, ids }
    }
    // index.ts / types.ts 等是 kind 注册与类型真源，认不出来就全选
    return { action: 'all', why: `src/kinds 下的非单 kind 文件（${rest}），保守全选` }
  }

  // ④ step 片段档
  const registryRel =
    relativeTo(input.registryDir, file) ??
    (file.startsWith('registry/') ? file.slice('registry/'.length) : undefined)
  if (registryRel !== undefined && registryRel.startsWith('steps/')) {
    const rel = stripExt(registryRel.slice('steps/'.length))
    if (rel === '' || rel === 'index') {
      return { action: 'all', why: 'registry/steps 的索引/目录级变化，保守全选' }
    }
    if (!/\.(ya?ml)$/i.test(registryRel)) {
      return { action: 'all', why: `registry/steps 下的非 YAML 文件（${rel}），保守全选` }
    }
    const ids = scenarios.filter((s) => scenarioStepUses(s).includes(rel)).map((s) => s.id)
    return { action: 'ids', why: `step 片段 ${rel} 被引用`, ids }
  }
  if (file.startsWith('registry/steps/')) {
    // 上面的分支已覆盖；保留兜底（registryDir 传了绝对路径时相对换算可能不成立）
    return { action: 'all', why: 'registry/steps 变化但无法换算片段名，保守全选' }
  }

  // ⑤ 夹具档
  const fixtureRel =
    relativeTo(input.fixturesDir, file) ??
    (file.startsWith('fixtures/') ? file.slice('fixtures/'.length) : undefined)
  if (fixtureRel !== undefined) {
    const rel = stripExt(fixtureRel)
    if (/\.(ya?ml)$/i.test(fixtureRel) && /^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(rel)) {
      const ids = scenarios
        .filter((s) => (s.fixtures ?? []).some((f) => String(f).trim() === rel))
        .map((s) => s.id)
      return { action: 'ids', why: `夹具 ${rel} 被声明`, ids }
    }
    return { action: 'all', why: `fixtures 下的非夹具文件（${fixtureRel}），保守全选` }
  }

  // ⑥ 单条 case 档：cases/TK-XXXX.yaml
  if (file.startsWith('cases/')) {
    const rel = file.slice('cases/'.length)
    const base = stripExt(rel)
    if (!rel.includes('/') && /^TK-\d{4}$/.test(base)) {
      const exists = scenarios.some((s) => s.id === base)
      if (exists) return { action: 'ids', why: `场景文件 ${base}.yaml 自身变化`, ids: [base] }
      return { action: 'all', why: `cases/${rel} 指向的场景不在本次集合里，保守全选` }
    }
    return { action: 'all', why: 'cases 的索引/目录级变化，保守全选' }
  }

  // ⑦ 认不出来 → 保守全选
  return { action: 'all', why: '未识别的路径，按"不默认放行"保守全选' }
}

/** 判定一组变更文件影响哪些场景。 */
export function affectedScenarios(
  files: readonly string[],
  input: AffectedScenariosInput,
): AffectedScenariosResult {
  const scenarios = input.scenarios
  const allIds = scenarios.map((s) => s.id)
  const matched = new Set<string>()
  const causes: string[] = []
  const unrecognized: string[] = []
  let hitAll = false

  for (const raw of files) {
    const file = normalizePath(raw)
    if (file === '') continue
    const decision = decide(file, input)
    if (decision.action === 'none') {
      causes.push(`${file} → 不影响场景（${decision.why}）`)
      continue
    }
    if (decision.action === 'all') {
      hitAll = true
      causes.push(`${file} → 全部场景（${decision.why}）`)
      if (decision.why.includes('未识别')) unrecognized.push(file)
      continue
    }
    for (const id of decision.ids) matched.add(id)
    causes.push(`${file} → ${decision.ids.length} 条（${decision.why}）`)
  }

  const finalIds = hitAll ? allIds : allIds.filter((id) => matched.has(id))
  const head =
    files.length === 0
      ? '变更文件为空：按定义没有场景受影响'
      : hitAll
        ? `命中全部 ${finalIds.length} 条场景`
        : `命中 ${finalIds.length}/${allIds.length} 条场景`
  const tail = unrecognized.length > 0 ? `；未识别路径 ${unrecognized.length} 个：${unrecognized.join('、')}` : ''

  return {
    matched: finalIds,
    reason: `${head}${tail}${causes.length > 0 ? `｜依据：${causes.join('；')}` : ''}`,
  }
}
