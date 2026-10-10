/**
 * 参数化模板（`templates/*.yaml`）→ 独立 TK 号的 **draft 场景**。
 *
 * ## 模板形状
 *
 * ```yaml
 * template: tool-failure
 * id_pattern: TK-01xx          # ID 从 TK-0100 起顺序分配；撞号自动往后找
 * title: "模板：{tool} 抛错（{code}）"
 * kind: tool
 * tags: [registry, template, registry:v1]   # 用了 use: 就必须锁注册表版本
 * matrix:
 *   tool: [probe_read, probe_write]
 *   condition: [no-session]
 *   code: [ENOENT]
 * setup: { tool: { register: { name: "{tool}", throws: "{code}" } } }
 * steps:
 *   - { use: setup/{condition}, with: { settleMs: 0 } }
 *   - { use: invoke/tool, with: { tool: "{tool}", args: {} } }
 * ```
 *
 * ## 语义（只做替换，不做推断）
 *
 *   · `matrix` 的**笛卡尔积**决定生成几条场景；`{name}` 占位符替换成当前组合的值
 *     （整串占位保留类型，所以 `argv: "{argv}"` 能拿到数组）。
 *   · 模板里出现的占位符根名必须是 matrix 的键，否则报 problem（挡住拼写错误）。
 *   · 生成结果一律 `status: 'draft'`——**默认回归集不会跑它们**。
 *   · ID 按 `id_pattern` 分配，跳过 `existingIds` 与本次已分配的号，绝不撞号。
 *   · 生成结果仍是**含 `use:` 的场景**；要执行还需 `expandScenario()` 展平
 *     （这样模板层不用知道 registry 内容，两侧职责不混）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { validateScenario } from '../cases/schema.js'
import { SCENARIO_KINDS, SCHEMA_VERSION, type Scenario, type ScenarioKind } from '../cases/types.js'

/** 一个参数化模板。 */
export interface TemplateSpec {
  /** 文件名（用于点名）。 */
  file: string
  /** 模板名（唯一）。 */
  template: string
  /** ID 分配模式，形如 `TK-01xx`。 */
  idPattern: string
  /** 标题模板（可含 `{占位符}`）。 */
  title: string
  /** 生成的场景 kind。 */
  kind: ScenarioKind
  severity?: string
  tags?: string[]
  /** 参数矩阵；每行是一个 `名字 → 候选值`。 */
  matrix: Record<string, unknown[]>
  setup?: Record<string, unknown>
  runtime?: Record<string, unknown>
  source?: Record<string, unknown>
  /** 步骤模板（可含 `use:` 与占位符）。 */
  steps: Array<Record<string, unknown>>
}

const TEMPLATE_KEYS = new Set([
  'template',
  'id_pattern',
  'title',
  'kind',
  'severity',
  'tags',
  'matrix',
  'setup',
  'runtime',
  'source',
  'steps',
  'description',
])
const FORBIDDEN_KEYS = new Set(['if', 'for', 'while', 'include', 'extends'])
const ID_PATTERN_RE = /^TK-\d*x+$/
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}/g

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

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

/* --------------------------------------------------------------- 加载 -- */

/**
 * 扫描 `templatesDir` 并做形状校验（模板坏掉不阻断其余模板）。
 *
 * @param opts.existingIds - 已占用的场景 ID（生成时跳过它们）
 */
export function loadTemplates(opts: {
  templatesDir: string
  existingIds: readonly string[]
}): { templates: TemplateSpec[]; problems: string[] } {
  const { templatesDir } = opts
  const problems: string[] = []
  const templates: TemplateSpec[] = []

  if (!existsSync(templatesDir) || !statSync(templatesDir).isDirectory()) {
    return { templates, problems: [`templates 目录不存在或不是目录：${templatesDir}`] }
  }

  const files = readdirSync(templatesDir)
    .filter((name) => /\.ya?ml$/i.test(name) && name !== 'index.yaml')
    .sort()

  if (files.length === 0) problems.push(`templates 里没有任何模板（扫描 ${templatesDir}）`)

  const seen = new Set<string>()

  for (const file of files) {
    let raw: unknown
    try {
      raw = parseYaml(readFileSync(join(templatesDir, file), 'utf8'))
    } catch (error) {
      problems.push(`${file}: YAML 解析失败：${String(error)}`)
      continue
    }
    if (!isPlainObject(raw)) {
      problems.push(`${file}: 顶层必须是对象`)
      continue
    }

    const forbidden: string[] = []
    findForbiddenKeys(raw, file, forbidden)
    for (const hit of forbidden) {
      problems.push(`${hit}: 禁止 YAML 控制流（if / for / while / include / extends）`)
    }

    for (const key of Object.keys(raw)) {
      if (!TEMPLATE_KEYS.has(key)) problems.push(`${file}: 未知字段 ${key}`)
    }

    const template = raw['template']
    if (typeof template !== 'string' || template.trim() === '') {
      problems.push(`${file}: template 必须是非空字符串`)
      continue
    }
    if (seen.has(template)) {
      problems.push(`${file}: 模板名重复（${template} 已在别的文件里定义）`)
      continue
    }
    seen.add(template)

    const idPattern = raw['id_pattern']
    if (typeof idPattern !== 'string' || !ID_PATTERN_RE.test(idPattern)) {
      problems.push(`${file}: id_pattern 必须形如 TK-01xx（x 是被分配的数字位），实际 ${JSON.stringify(idPattern)}`)
    }

    const title = raw['title']
    if (typeof title !== 'string' || title.trim() === '') {
      problems.push(`${file}: title 必须是非空字符串`)
    }

    const kind = raw['kind']
    if (typeof kind !== 'string' || !(SCENARIO_KINDS as readonly string[]).includes(kind)) {
      problems.push(`${file}: kind 必须是已注册类型之一：${SCENARIO_KINDS.join(' | ')}`)
    }

    const matrix: Record<string, unknown[]> = {}
    if (raw['matrix'] !== undefined) {
      if (!isPlainObject(raw['matrix'])) {
        problems.push(`${file}: matrix 必须是对象（名字 → 候选值数组）`)
      } else {
        for (const [key, values] of Object.entries(raw['matrix'])) {
          if (!Array.isArray(values) || values.length === 0) {
            problems.push(`${file}: matrix.${key} 必须是非空数组`)
            continue
          }
          matrix[key] = values
        }
      }
    }

    const steps = raw['steps']
    if (!Array.isArray(steps) || steps.length === 0 || steps.some((step) => !isPlainObject(step))) {
      problems.push(`${file}: steps 必须是非空对象数组`)
    }

    if (raw['tags'] !== undefined && (!Array.isArray(raw['tags']) || raw['tags'].some((t) => typeof t !== 'string'))) {
      problems.push(`${file}: tags 必须是字符串数组`)
    }

    // 占位符根名必须是 matrix 的键：模板里写错 `{tools}` 必须报错，
    // 否则它会以字面文本进入场景，展开时才发现已经太远。
    const roots = new Set<string>()
    collectTemplatePlaceholders(raw, roots)
    for (const root of roots) {
      if (!(root in matrix)) {
        problems.push(`${file}: 模板里用了占位符 {${root}}，但 matrix 没有这个变量`)
      }
    }

    templates.push({
      file,
      template,
      idPattern: typeof idPattern === 'string' ? idPattern : 'TK-xxxx',
      title: typeof title === 'string' ? title : template,
      kind: kind as ScenarioKind,
      ...(typeof raw['severity'] === 'string' ? { severity: raw['severity'] } : {}),
      ...(Array.isArray(raw['tags']) ? { tags: raw['tags'] as string[] } : {}),
      matrix,
      ...(isPlainObject(raw['setup']) ? { setup: raw['setup'] } : {}),
      ...(isPlainObject(raw['runtime']) ? { runtime: raw['runtime'] } : {}),
      ...(isPlainObject(raw['source']) ? { source: raw['source'] } : {}),
      steps: Array.isArray(steps) ? (steps as Array<Record<string, unknown>>) : [],
    })
  }

  return { templates, problems }
}

/** 收集模板里所有占位符根名（含嵌套值）。 */
function collectTemplatePlaceholders(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    const re = new RegExp(PLACEHOLDER_RE.source, 'g')
    for (const match of value.matchAll(re)) {
      const root = (match[1] ?? '').split('.')[0]
      if (root) out.add(root)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTemplatePlaceholders(item, out)
    return
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) collectTemplatePlaceholders(child, out)
  }
}

/* --------------------------------------------------------------- 展开 -- */

/** matrix 的笛卡尔积；matrix 为空时得到唯一一个空组合。 */
function combinationOf(matrix: Record<string, unknown[]>): Array<Record<string, unknown>> {
  let out: Array<Record<string, unknown>> = [{}]
  for (const [key, values] of Object.entries(matrix)) {
    const next: Array<Record<string, unknown>> = []
    for (const base of out) {
      for (const value of values) next.push({ ...base, [key]: value })
    }
    out = next
  }
  return out
}

function resolveVar(bindings: Record<string, unknown>, path: string): { found: boolean; value?: unknown } {
  const segments = path.split('.')
  const root = segments[0]
  if (root === undefined || !(root in bindings)) return { found: false }
  let cursor: unknown = bindings[root]
  for (const segment of segments.slice(1)) {
    if (isPlainObject(cursor)) cursor = cursor[segment]
    else if (Array.isArray(cursor)) cursor = cursor[Number(segment)]
    else return { found: false }
    if (cursor === undefined) return { found: false }
  }
  if (cursor === undefined) return { found: false }
  return { found: true, value: cursor }
}

/** 模板层替换：整串占位保留类型；未知占位符原样留下（由加载校验点名）。 */
function renderTemplateValue(value: unknown, bindings: Record<string, unknown>, problems: string[], at: string): unknown {
  if (typeof value === 'string') {
    const whole = /^\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\}$/.exec(value)
    if (whole !== null) {
      const resolved = resolveVar(bindings, whole[1] ?? '')
      if (!resolved.found) {
        problems.push(`${at}: 占位符 {${whole[1]}} 没有对应的 matrix 变量`)
        return value
      }
      return resolved.value
    }
    let out = ''
    let cursor = 0
    const re = new RegExp(PLACEHOLDER_RE.source, 'g')
    for (const match of value.matchAll(re)) {
      const raw = match[0]
      const index = value.indexOf(raw, cursor)
      if (index < 0) continue
      out += value.slice(cursor, index)
      const resolved = resolveVar(bindings, match[1] ?? '')
      if (!resolved.found) {
        problems.push(`${at}: 占位符 {${match[1]}} 没有对应的 matrix 变量`)
        out += raw
      } else if (
        typeof resolved.value === 'string' ||
        typeof resolved.value === 'number' ||
        typeof resolved.value === 'boolean'
      ) {
        out += String(resolved.value)
      } else {
        problems.push(`${at}: 占位符 {${match[1]}} 嵌在字符串里但值不是标量`)
        out += raw
      }
      cursor = index + raw.length
    }
    out += value.slice(cursor)
    return out
  }
  if (Array.isArray(value)) return value.map((item) => renderTemplateValue(item, bindings, problems, at))
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = renderTemplateValue(child, bindings, problems, at)
    }
    return out
  }
  return value
}

/** 按 `id_pattern` 分配一个未占用的 ID；耗尽返回 undefined。 */
function allocateId(idPattern: string, used: Set<string>): string | undefined {
  const match = /^(TK-\d*)(x+)$/.exec(idPattern)
  if (match === null) return undefined
  const head = match[1] ?? ''
  const width = (match[2] ?? '').length
  const digits = /(\d*)$/.exec(head)?.[1] ?? ''
  const prefix = head.slice(0, head.length - digits.length)
  const totalWidth = digits.length + width
  const base = digits === '' ? 0 : Number(digits) * 10 ** width
  const max = base + 10 ** width - 1
  for (let n = base; n <= max; n += 1) {
    const id = `${prefix}${String(n).padStart(totalWidth, '0')}`
    if (!used.has(id)) {
      used.add(id)
      return id
    }
  }
  return undefined
}

/**
 * 展开全部模板为 draft 场景。
 *
 * @param opts.templatesDir - `templates/` 目录
 * @param opts.existingIds - 已占用的场景 ID（跳过它们，绝不撞号）
 */
export function expandTemplates(opts: {
  templatesDir: string
  existingIds: readonly string[]
}): { scenarios: Scenario[]; problems: string[] } {
  const loaded = loadTemplates(opts)
  const problems: string[] = [...loaded.problems]
  const scenarios: Scenario[] = []
  const used = new Set<string>(opts.existingIds)

  for (const template of loaded.templates) {
    const combos = combinationOf(template.matrix)
    for (const combo of combos) {
      const at = `${template.file} (${template.template} ${JSON.stringify(combo)})`

      const id = allocateId(template.idPattern, used)
      if (id === undefined) {
        problems.push(`${at}: id_pattern ${template.idPattern} 的号段已耗尽（撞号太多）`)
        continue
      }

      const title = renderTemplateValue(template.title, combo, problems, at)
      const steps = renderTemplateValue(template.steps, combo, problems, at)
      const setup = renderTemplateValue(template.setup ?? {}, combo, problems, at)
      const runtime = renderTemplateValue(template.runtime ?? {}, combo, problems, at)
      const source = renderTemplateValue(
        template.source ?? {
          issue: null,
          summary: `参数化模板 ${template.template} 展开（${JSON.stringify(combo)}）`,
        },
        combo,
        problems,
        at,
      )
      const declaredTags = Array.isArray(template.tags) ? template.tags : []
      const tags = declaredTags.includes(`template:${template.template}`)
        ? [...declaredTags]
        : [...declaredTags, `template:${template.template}`]

      const raw: Record<string, unknown> = {
        schema: SCHEMA_VERSION,
        id,
        title,
        kind: template.kind,
        status: 'draft',
        tags,
        ...(template.severity === undefined ? {} : { severity: template.severity }),
        source,
        runtime,
        setup,
        steps,
      }

      const validated = validateScenario(raw, `${id}.yaml`)
      if (!validated.ok || validated.scenario === undefined) {
        const detail = validated.issues.map((issue) => `${issue.path || '<root>'}: ${issue.message}`).join('；')
        problems.push(`${at} → ${id}: 生成的场景不合规：${detail}`)
        continue
      }
      scenarios.push(validated.scenario)
    }
  }

  return { scenarios, problems }
}
