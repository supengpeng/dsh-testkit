/**
 * touchstone 融合 · 阶段二（输入通道）
 * touchstone 的 `case.md` → 本仓场景 YAML **草稿**（`status: draft`）。
 *
 * ## 停止线（硬约束，写进文件头不是装饰）
 *
 * **转换器本身超过 500 行 → 停止自动转换，改人工转换。**
 *
 * 理由：转换器越长，「结构映射」就越滑向「语义推断」，而推断出来的判据是**猜的判据**。
 * 猜错的判据进了回归集会同时制造假红与假绿——比"这条没进回归集"糟得多。
 * 所以这条不是建议：`assertConverterWithinStopLine()` 在运行时数**源文件**行数，超限直接抛错；
 * `tests/touchstone.test.mjs` 有用例专门钉住这个守卫（它真的拦住过一次本文件自己）。
 *
 * ## 只做结构映射，判据交给人和闸门
 *
 * `case.md` 的假定形状（**容错**解析：缺段不报错，多出来的段不丢）：
 *
 * ```md
 * ---
 * title: ...            # 也可用正文一级标题 `# ...`
 * kind: shell           # 可选；必须是本仓已注册的 kind
 * severity: high        # 可选
 * tags: [a, b]          # 可选
 * owner: @someone       # 可选
 * source: <issue URL>   # 或正文里第一个 issue 链接
 * steps: [...]          # 可选：已结构化的步骤 → 原样透传（仍属结构映射）
 * ---
 * ## 症状 / 现象   ## 期望   ## 实际   ## 复现步骤   ## 来源
 * ```
 *
 * 映射不了的内容**原样保留成 YAML 注释**（不丢信息，也不假装理解）。
 *
 * `act` / `expect` 是**判据**：除非 front matter 已给出结构化 `steps`（或 `act` + `expect`），
 * 否则产出一条带 `TODO(人工)` 的**占位步骤**——它结构合法（过得了 `validateScenario`），
 * 但过不了提炼闸门的质量预检（`unfinished-todo` / `no-assertion`）。这是刻意的：
 * **要不要提炼、判据长什么样，都由人定**（见 `src/pipeline/quality.ts`）。
 *
 * ## 落地必须走闸门
 *
 * `proposeCase()` 只调 `PipelineStore.propose()`，把草稿写进 `pipeline/proposals/`；
 * **永远不写 `cases/`**（正式 TK 号由人的 `/testkit issue approve` 分配）。
 * 本文件不提供"自动开批次"的入口——要不要提炼同样由人决定。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { validateScenario, type ValidationIssue } from '../cases/schema.js'
import { SCENARIO_KINDS, SCHEMA_VERSION, type Severity, type Step } from '../cases/types.js'
import { PipelineStore, type ProposeResult } from '../pipeline/store.js'
import { PROPOSAL_PLACEHOLDER_ID } from '../pipeline/types.js'

/** 停止线：转换器行数上限。超了就改人工转换（见文件头）。 */
export const CONVERTER_STOP_LINE = 500

const SEVERITIES = new Set<string>(['low', 'medium', 'high'])
const KINDS = new Set<string>(SCENARIO_KINDS)
/** 没有结构信息时的兜底 kind；逐条必须由人确认（会写进 YAML 注释与 notes）。 */
const FALLBACK_KIND = 'shell'
const PLACEHOLDER_ACT_TEXT = 'TODO(人工)：把 case.md 的复现步骤写成真实动作'
const PLACEHOLDER_FILE = 'TK-0000.yaml'

/** 段标题 → 语义槽位的**结构**匹配（不做语义推断，只认这些词根）。 */
const SECTION_SLOTS: ReadonlyArray<[string, RegExp]> = [
  ['symptom', /症状|现象|问题|表现|symptom|describe/i],
  ['expected', /期望|预期|应该|expected|should/i],
  ['actual', /实际|现状|观察|actual|observed/i],
  ['repro', /复现|重现|步骤|repro/i],
  ['source', /来源|出处|引用|参考|source|reference|issue|link/i],
]

export interface CaseMdFacts {
  title: string
  issue: string | null
  kind: string
  severity?: Severity
  tags: string[]
  owner?: string
  reported?: string
  /** 各语义槽位的原文（多段以空行拼接）。 */
  sections: Record<string, string>
  /** 复现步骤里抽出的列表项 / 代码块。 */
  reproSteps: string[]
  /** 正文里出现的所有链接。 */
  links: string[]
}

export interface CaseMdDraft {
  /** 可直接交给 `PipelineStore.propose()` 的 YAML 正文。 */
  yaml: string
  facts: CaseMdFacts
  /** 没有对应字段、以注释形式保留的块（非空就说明有人要看一眼）。 */
  unmapped: string[]
  /** 结构映射过程中的提醒（兜底 kind、截断标题、steps 来源…）。 */
  notes: string[]
  /** 产出 YAML 的 `validateScenario` 结论（阶段二验收：必须 ok）。 */
  validation: { ok: boolean; issues: ValidationIssue[] }
}

/** 把 `case.md` 解析成场景 YAML 草稿（纯函数，不碰文件系统）。 */
export function parseCaseMd(text: string): CaseMdDraft {
  const notes: string[] = []
  const normalized = text.replace(/\r\n/g, '\n')
  const { front, body } = splitFrontMatter(normalized, notes)
  const sections = parseSections(body)
  const facts = extractFacts(front, sections, body, notes)
  const steps = buildSteps(front, facts, notes)
  const unmapped = collectUnmapped(front, sections, body)
  if (unmapped.length > 0) {
    notes.push(`有 ${unmapped.length} 段内容没有对应字段，已原样保留为 YAML 注释`)
  }

  const scenario: Record<string, unknown> = {
    schema: SCHEMA_VERSION,
    id: PROPOSAL_PLACEHOLDER_ID,
    title: facts.title,
    kind: facts.kind,
    status: 'draft',
    ...(facts.severity === undefined ? {} : { severity: facts.severity }),
    ...(facts.tags.length > 0 ? { tags: facts.tags } : {}),
    ...(facts.owner === undefined ? {} : { owner: facts.owner }),
    source: {
      issue: facts.issue,
      ...(facts.reported === undefined ? {} : { reported: facts.reported }),
      summary: facts.sections['summary'] ?? '',
    },
    steps,
  }

  const yaml = composeYaml(scenario, facts, unmapped, notes)
  const checked = validateScenario(parseYaml(yaml), PLACEHOLDER_FILE, { allowIdMismatch: true })
  if (!checked.ok) {
    notes.push(
      `validateScenario 未通过（**必须人工修正**）：${checked.issues
        .map((i) => `${i.path || '<root>'}: ${i.message}`)
        .join('；')}`,
    )
  }
  return { yaml, facts, unmapped, notes, validation: { ok: checked.ok, issues: checked.issues } }
}

export interface ProposeCaseRequest {
  yamlText: string
  /** 闸门数据根（`<包根>/pipeline`）。 */
  pipelineDir: string
  /** 场景真源目录（`<包根>/cases`）——本函数**只读**它。 */
  casesDir: string
  /** 给裁决人看的提炼要点。 */
  notes?: string
}

/**
 * 走提炼闸门的**提案**通道提交草稿。
 *
 * 纪律：不 `open()` 批次（那是人的动作）、不写 `cases/`；质量预检不过就不落盘。
 * 所以本函数在"没有 open 批次"或"草稿还没写完判据"时**必然失败**——那是预期行为，
 * 不是 bug：把失败原因（含闸门给出的 findings）原样回报即可。
 */
export function proposeCase(request: ProposeCaseRequest): ProposeResult {
  const store = new PipelineStore({ pipelineDir: request.pipelineDir, casesDir: request.casesDir })
  return store.propose({
    yamlText: request.yamlText,
    ...(request.notes === undefined ? {} : { notes: request.notes }),
  })
}

/* -------------------------------------------------- 停止线守卫（硬约束） -- */

/**
 * 转换器源文件路径。
 *
 * 优先数 **TS 源码**（`src/touchstone/import.ts`）——"500 行"说的是人写的代码；
 * 编译产物（`lib/touchstone/import.js`）只作兜底（`src/` 也在 npm `files` 里）。
 */
export function converterSourcePath(): string {
  const candidates = [
    new URL('../../src/touchstone/import.ts', import.meta.url),
    new URL('./import.ts', import.meta.url),
    new URL('./import.js', import.meta.url),
  ]
  for (const url of candidates) {
    const path = fileURLToPath(url)
    if (existsSync(path)) return path
  }
  return fileURLToPath(candidates[0] as URL)
}

/** 转换器行数；源文件读不到时返回 undefined（不猜）。 */
export function converterLineCount(): number | undefined {
  const path = converterSourcePath()
  if (!existsSync(path)) return undefined
  try {
    return readFileSync(path, 'utf8').split('\n').length
  } catch {
    return undefined
  }
}

/**
 * 停止线守卫：超限即抛错。
 *
 * @returns 实际行数（未超限时）
 * @throws 超限、或行数无法确定（**宁可报错也不要静默放行**）
 */
export function assertConverterWithinStopLine(max: number = CONVERTER_STOP_LINE): number {
  const lines = converterLineCount()
  if (lines === undefined) {
    throw new Error(`无法确定转换器行数（读 ${converterSourcePath()} 失败）：停止线守卫拒绝放行。`)
  }
  if (lines > max) {
    throw new Error(
      `转换器已超停止线：import.ts 实际 ${lines} 行 > ${max} 行 → ` +
        `停止自动转换，改人工转换（见 docs/TOUCHSTONE.md「停止线」）。`,
    )
  }
  return lines
}

/* ------------------------------------------------------------ 内部解析 -- */

function splitFrontMatter(
  text: string,
  notes: string[],
): { front: Record<string, unknown>; body: string } {
  if (!/^---\s*\n/.test(text)) return { front: {}, body: text }
  const end = text.indexOf('\n---', 4)
  if (end < 0) return { front: {}, body: text }
  const frontText = text.slice(text.indexOf('\n') + 1, end)
  const afterLine = text.indexOf('\n', end + 1)
  const body = afterLine < 0 ? '' : text.slice(afterLine + 1)
  try {
    const parsed = parseYaml(frontText)
    if (isRecord(parsed)) return { front: parsed, body }
    notes.push('front matter 顶层不是对象，已忽略（正文照常解析）')
  } catch (error) {
    notes.push(`front matter 解析失败，已忽略：${messageOf(error)}`)
  }
  return { front: {}, body }
}

interface Section {
  level: number
  title: string
  lines: string[]
}

function parseSections(body: string): Section[] {
  const sections: Section[] = []
  let current: Section | null = null
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const heading = inFence ? null : /^(#{1,6})\s+(.*\S)\s*$/.exec(line)
    if (heading) {
      current = { level: (heading[1] ?? '#').length, title: (heading[2] ?? '').trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return sections
}

function extractFacts(
  front: Record<string, unknown>,
  sections: Section[],
  body: string,
  notes: string[],
): CaseMdFacts {
  const h1 = sections.find((s) => s.level === 1)
  const title = clipTitle(
    stringOf(front['title']) ?? h1?.title ?? sections[0]?.title ?? 'case.md 导入草稿（缺标题）',
    notes,
  )

  const slots: Record<string, string[]> = {}
  const reproSteps: string[] = []
  for (const section of sections) {
    const slot = SECTION_SLOTS.find(([, re]) => re.test(section.title))?.[0]
    if (slot === undefined) continue
    const text = section.lines.join('\n').trim()
    if (text === '') continue
    ;(slots[slot] ??= []).push(text)
    if (slot === 'repro') reproSteps.push(...extractReproSteps(section.lines))
  }

  const links = [...new Set(body.match(/https?:\/\/[^\s)<>"'\]]+/g) ?? [])]
  const frontSource = isRecord(front['source']) ? front['source'] : undefined
  const issue =
    stringOf(frontSource?.['issue']) ??
    stringOf(front['issue']) ??
    links.find((l) => /\/issues?\/\d+/.test(l)) ??
    links[0] ??
    (slots['source'] ?? []).map((t) => /#\d+/.exec(t)?.[0]).find((v) => v !== undefined) ??
    null

  const summaryParts: string[] = []
  for (const [label, key] of [['症状', 'symptom'], ['期望', 'expected'], ['实际', 'actual'], ['复现步骤', 'repro']] as const) {
    const text = (slots[key] ?? []).join('\n\n').trim()
    if (text !== '') summaryParts.push(`【${label}】\n${text}`)
  }
  if (summaryParts.length === 0) {
    notes.push('case.md 里没有可识别的「症状 / 期望 / 实际 / 复现步骤」段，source.summary 留空待人工补')
  }

  const frontKind = stringOf(front['kind'])
  let kind = FALLBACK_KIND
  if (frontKind === undefined) {
    notes.push(`case.md 没有 kind 字段：已用 ${FALLBACK_KIND} 占位，**必须人工确认干预点**`)
  } else if (KINDS.has(frontKind)) {
    kind = frontKind
  } else {
    notes.push(`case.md 的 kind=${frontKind} 不是本仓已注册类型（${[...KINDS].join('/')}），已用 ${FALLBACK_KIND} 占位`)
  }

  const frontSeverity = stringOf(front['severity'])
  const severity = frontSeverity !== undefined && SEVERITIES.has(frontSeverity) ? (frontSeverity as Severity) : undefined
  if (frontSeverity !== undefined && severity === undefined) {
    notes.push(`case.md 的 severity=${frontSeverity} 非法，已忽略（只允许 low/medium/high）`)
  }

  const owner = stringOf(front['owner'])
  const reported = stringOf(front['reported'])
  const sectionsOut: Record<string, string> = { summary: summaryParts.join('\n\n') }
  for (const [key, value] of Object.entries(slots)) sectionsOut[key] = value.join('\n\n')

  return {
    title,
    issue,
    kind,
    tags: Array.isArray(front['tags']) ? front['tags'].filter((t): t is string => typeof t === 'string') : [],
    sections: sectionsOut,
    reproSteps,
    links,
    ...(severity === undefined ? {} : { severity }),
    ...(owner === undefined ? {} : { owner }),
    ...(reported !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(reported) ? { reported } : {}),
  }
}

function buildSteps(front: Record<string, unknown>, facts: CaseMdFacts, notes: string[]): Step[] {
  const frontSteps = front['steps']
  if (Array.isArray(frontSteps) && frontSteps.length > 0) {
    notes.push('steps 来自 case.md front matter，**原样结构透传**（本转换器未做任何语义推断）')
    return frontSteps as Step[]
  }

  const frontExpect = front['expect'] ?? front['assertions']
  if (Array.isArray(frontExpect) && frontExpect.length > 0) {
    notes.push('单步来自 case.md front matter 的 act/expect，原样结构透传')
    return [
      {
        name: stringOf(front['stepName']) ?? '（来自 case.md front matter）',
        ...(front['act'] === undefined ? {} : { act: front['act'] as Step['act'] }),
        expect: frontExpect as Step['expect'],
      },
    ]
  }

  // 判据不猜：占位步骤过得了 schema、过不了闸门（TODO 标记 + 无断言），必须人工补完。
  const firstRepro = facts.reproSteps[0]
  notes.push(
    '没有结构化 steps/expect：已产出**占位步骤**（含 TODO(人工)）。它会通过 validateScenario，' +
      '但会被提炼闸门拦下——判据必须由人写死。',
  )
  return [
    {
      name: firstRepro === undefined ? '（人工填写：复现动作）' : `（人工确认）${clipTitle(firstRepro, [])}`,
      act: { shell: { argv: ['echo', PLACEHOLDER_ACT_TEXT] } },
    },
  ]
}

/** 找出所有没有映射到字段的内容（未映射的 front matter 字段 + 段 + 一级标题前的引言）。 */
function collectUnmapped(
  front: Record<string, unknown>,
  sections: Section[],
  body: string,
): string[] {
  const mapped = new Set([
    'title', 'kind', 'severity', 'tags', 'owner', 'source', 'steps',
    'expect', 'assertions', 'act', 'stepName', 'reported',
  ])
  const out: string[] = []

  const extraKeys = Object.keys(front).filter((k) => !mapped.has(k))
  if (extraKeys.length > 0) {
    out.push(`front matter 未映射字段：\n${extraKeys.map((k) => `${k}: ${inlineYaml(front[k])}`).join('\n')}`)
  }

  for (const section of sections) {
    const isSlot = SECTION_SLOTS.some(([, re]) => re.test(section.title))
    if (isSlot || section.level === 1) continue
    const text = section.lines.join('\n').trim()
    if (text === '') continue
    out.push(`${'#'.repeat(section.level)} ${section.title}\n${text}`)
  }

  const preamble = (body.startsWith('#') ? '' : (body.split(/^#{1,6}\s/m)[0] ?? '')).trim()
  if (preamble !== '') out.push(`引言：\n${preamble}`)
  return out
}

/** 组装最终 YAML：头注释 + 主体 + 未映射原文（注释）。 */
function composeYaml(
  scenario: Record<string, unknown>,
  facts: CaseMdFacts,
  unmapped: string[],
  notes: string[],
): string {
  const lines: string[] = []
  lines.push('# ---------------------------------------------------------------')
  lines.push('# 由 src/touchstone/import.ts 从 touchstone 的 case.md **结构映射**而来')
  lines.push(`# 停止线：转换器 > ${CONVERTER_STOP_LINE} 行 → 停止自动转换，改人工转换（见 docs/TOUCHSTONE.md）`)
  lines.push('# 这是**草稿**：status=draft、id 是占位值，必须走提炼闸门（人批准）才可能进 cases/')
  lines.push('# ---------------------------------------------------------------')
  lines.push(`# 来源：${facts.issue ?? '(case.md 里没有可识别的 issue 链接——闸门会因此拦下它)'}`)
  if (facts.links.length > 0) {
    lines.push('# 正文里的链接：')
    for (const link of facts.links.slice(0, 8)) lines.push(`#   - ${link}`)
  }
  if (notes.length > 0) {
    lines.push('# 转换提醒：')
    for (const note of notes) lines.push(`#   - ${note}`)
  }
  lines.push(stringifyYaml(scenario, { lineWidth: 0 }).replace(/\n$/, ''))
  if (unmapped.length > 0) {
    lines.push('')
    lines.push('# ===============================================================')
    lines.push('# 【未映射原文】下面这些内容没有对应的场景字段，原样保留（不做语义推断）：')
    for (const block of unmapped) {
      lines.push('# ---------------------------------------------------------------')
      for (const line of block.split('\n')) lines.push(line === '' ? '#' : `# ${line}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/* -------------------------------------------------------------- 小工具 -- */

function extractReproSteps(lines: string[]): string[] {
  const out: string[] = []
  let inFence = false
  let fence: string[] = []
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inFence) {
        const block = fence.join('\n').trim()
        if (block !== '') out.push(block)
        fence = []
      }
      inFence = !inFence
      continue
    }
    if (inFence) {
      fence.push(line)
      continue
    }
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/.exec(line)
    if (bullet) out.push((bullet[1] ?? '').trim())
  }
  if (fence.length > 0) {
    const block = fence.join('\n').trim()
    if (block !== '') out.push(block)
  }
  return out
}

/** 标题上限 60 字（`validateScenario` 的硬规则）；被截断就留一条提醒。 */
function clipTitle(text: string, notes: string[]): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= 60) return clean === '' ? 'case.md 导入草稿（缺标题）' : clean
  notes.push(`标题超过 60 字，已截断（原文 ${clean.length} 字）`)
  return `${clean.slice(0, 59)}…`
}

function inlineYaml(value: unknown): string {
  if (typeof value === 'string') return value
  return JSON.stringify(value) ?? String(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
