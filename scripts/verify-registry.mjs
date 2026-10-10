/**
 * 组合系统守卫：step registry + 参数化模板 + 展开。
 *
 * 检查项（任一不通过 → exit 1，并逐条点名）：
 *   ① `registry/` 可加载且 `checkRegistry()` 干净：
 *      无环（片段不得 use 片段）/ 重名 / 参数 schema / 依赖存在 / 无未知字段
 *   ② 9 份必需片段齐全（setup/no-session、setup/with-session、setup/permission-denied、
 *      invoke/tool、invoke/llm、invoke/shell、assert/error、assert/output-contains、assert/tool-called）
 *   ③ `templates/` 可加载、可展开；产物一律 `status: draft`、ID 不撞既有 TK 号
 *   ④ 模板展开与真实 `use:` 场景都能一键展平，且 flat 步骤**不残留 `use`/`with`**、
 *      只出现 `id`/`name`/`act`/`expect`/`cleanup` 这些白名单键
 *   ⑤ 场景含 `use:` 时必须带 `registry:v<version>` 版本锁标签（展开器判定）
 *   ⑥ 禁止 YAML 控制流：`if` / `for` / `while` / `include` / `extends`（键名级）
 *
 * 依赖已编译的 lib/（先 `node scripts/build-lock.mjs`）。
 * 用法：node scripts/verify-registry.mjs
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))

const REGISTRY_LIB = join(root, 'lib', 'registry', 'index.js')
if (!existsSync(REGISTRY_LIB)) {
  console.error('[verify-registry] 未找到 lib/registry/index.js —— 请先运行 node scripts/build-lock.mjs')
  process.exit(2)
}

const { checkRegistry, expandScenario, expandTemplates, loadRegistry, loadTemplates } = await import(
  new URL('../lib/registry/index.js', import.meta.url)
)
const { loadCaseFile } = await import(new URL('../lib/cases/loader.js', import.meta.url))

const problems = []
const add = (message) => problems.push(message)

const registryDir = join(root, 'registry')
const templatesDir = join(root, 'templates')
const casesDir = join(root, 'cases')
const draftDir = join(root, 'cases-draft')

const FORBIDDEN_KEYS = new Set(['if', 'for', 'while', 'include', 'extends'])
const FLAT_KEYS = new Set(['id', 'name', 'act', 'expect', 'cleanup'])
const REQUIRED_FRAGMENTS = [
  'setup/no-session',
  'setup/with-session',
  'setup/permission-denied',
  'invoke/tool',
  'invoke/llm',
  'invoke/shell',
  'assert/error',
  'assert/output-contains',
  'assert/tool-called',
]

function findForbiddenKeys(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => findForbiddenKeys(item, `${path}[${index}]`, out))
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) out.push(`${path}.${key}`)
    findForbiddenKeys(child, `${path}.${key}`, out)
  }
}

function idsIn(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^TK-\d{4}\.yaml$/.test(name))
    .map((name) => name.slice(0, -5))
}

function checkFlatStep(step, where) {
  if (step === null || typeof step !== 'object') {
    add(`${where}: flat 步骤必须是对象`)
    return
  }
  if ('use' in step) add(`${where}: flat 步骤残留 use（展开不彻底）`)
  if ('with' in step) add(`${where}: flat 步骤残留 with（展开不彻底）`)
  for (const key of Object.keys(step)) {
    if (!FLAT_KEYS.has(key)) add(`${where}: flat 步骤出现非白名单键 ${key}`)
  }
}

/** 展开一条场景并检查 flat 步骤。返回是否成功。 */
function flattenAndCheck(scenario, where) {
  const result = expandScenario(scenario, { registry: reg })
  if (!result.ok) {
    for (const problem of result.problems) add(`${where}: ${problem}`)
    return false
  }
  if (result.flat.length === 0) add(`${where}: 展开后没有任何步骤`)
  result.flat.forEach((step, index) => checkFlatStep(step, `${where} steps[${index}]`))
  if (result.scenario.steps.length !== result.flat.length) {
    add(`${where}: scenario.steps 与 flat 长度不一致（"一键展平"契约破坏）`)
  }
  return true
}

/* ----------------------------------------------------------- ① registry -- */

const reg = loadRegistry({ registryDir })
const check = checkRegistry(reg)
for (const problem of check.problems) add(problem)

for (const name of REQUIRED_FRAGMENTS) {
  if (!reg.steps.has(name)) add(`registry 缺少必需片段：${name}`)
}
if (reg.steps.size < 9) add(`registry 只加载到 ${reg.steps.size} 个片段（至少 9 个）`)

/* --------------------------------------------------------- ② templates -- */

const existingIds = [...idsIn(casesDir), ...idsIn(draftDir)]

const loadedTemplates = loadTemplates({ templatesDir, existingIds })
for (const problem of loadedTemplates.problems) add(problem)
if (loadedTemplates.templates.length < 2) {
  add(`templates 只加载到 ${loadedTemplates.templates.length} 个模板（至少 2 个）`)
}

const expanded = expandTemplates({ templatesDir, existingIds })
for (const problem of expanded.problems) add(problem)

const templateIds = new Set()
let templateFlattened = 0
for (const scenario of expanded.scenarios) {
  if (scenario.status !== 'draft') {
    add(`模板展开结果必须 status: draft：${scenario.id} 实际 ${String(scenario.status)}`)
  }
  if (templateIds.has(scenario.id)) add(`模板展开出现重复 ID：${scenario.id}`)
  templateIds.add(scenario.id)
  if (existingIds.includes(scenario.id)) add(`模板展开撞既有场景 ID：${scenario.id}`)
  if (flattenAndCheck(scenario, `模板场景 ${scenario.id}`)) templateFlattened += 1
}

/* ---------------------------------------------- ③ 真实场景里的 use: 步骤 -- */

let composedFiles = 0
for (const [dir, label] of [
  [casesDir, 'cases'],
  [draftDir, 'cases-draft'],
]) {
  if (!existsSync(dir)) continue
  const files = readdirSync(dir)
    .filter((name) => /^TK-\d{4}\.yaml$/.test(name))
    .sort()
  for (const file of files) {
    const full = join(dir, file)
    let raw
    try {
      raw = parseYaml(readFileSync(full, 'utf8'))
    } catch (error) {
      add(`${label}/${file}: YAML 解析失败：${String(error)}`)
      continue
    }
    const hits = []
    findForbiddenKeys(raw, `${label}/${file}`, hits)
    for (const hit of hits) add(`${hit}: 禁止 YAML 控制流（if / for / while / include / extends）`)

    const loaded = loadCaseFile(full)
    if (!loaded.ok || loaded.scenario === undefined) {
      if (loaded.error) add(`${label}/${file}: ${loaded.error}`)
      for (const issue of loaded.issues) add(`${label}/${file}: ${issue.path || '<root>'}: ${issue.message}`)
      continue
    }
    if (loaded.scenario.steps.some((step) => step.use !== undefined)) {
      composedFiles += 1
      flattenAndCheck(loaded.scenario, `${label}/${file}`)
    }
  }
}

/* --------------------------------------------------------------- 汇总 -- */

console.log(`[verify-registry] registry 版本 ${reg.version}｜片段 ${reg.steps.size} 个（必需 ${REQUIRED_FRAGMENTS.length} 个）`)
console.log(`[verify-registry] 模板 ${loadedTemplates.templates.length} 个｜展开 ${expanded.scenarios.length} 条 draft 场景（展开成功 ${templateFlattened} 条）`)
console.log(`[verify-registry] 含 use: 的真实场景 ${composedFiles} 条（cases/ + cases-draft/）`)

if (problems.length > 0) {
  console.error(`\n[verify-registry] ✗ ${problems.length} 项问题：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log('[verify-registry] OK')
