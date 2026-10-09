/**
 * 场景文件的加载：扫描目录、解析 YAML、校验、构建索引视图。
 *
 * 纪律：**单个文件坏掉不阻断启动**，坏件进 `invalid`，由工具/UI 暴露出来。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { validateScenario, type ValidationIssue } from './schema.js'
import type { Scenario, ScenarioKind } from './types.js'

export interface LoadedCase {
  /** 绝对路径。 */
  file: string
  /** 文件名，如 `TK-0001.yaml`。 */
  name: string
  ok: boolean
  scenario?: Scenario
  issues: ValidationIssue[]
  /** 读取/解析阶段的致命错误（区别于校验问题）。 */
  error?: string
}

export interface CaseIndexEntry {
  id: string
  kind?: ScenarioKind | string
  status?: string
  issue?: string | null
}

export interface CaseIndex {
  schema: number
  nextId: number
  cases: CaseIndexEntry[]
}

export interface LoadResult {
  casesDir: string
  /** 全部被扫描到的文件（含坏件）。 */
  loaded: LoadedCase[]
  /** 校验通过、可执行的场景，按 id 排序。 */
  scenarios: Scenario[]
  /** 校验失败或读取失败的条目。 */
  invalid: LoadedCase[]
  index?: CaseIndex
  indexIssues: ValidationIssue[]
}

/** 读取并校验一个场景文件。 */
export function loadCaseFile(file: string): LoadedCase {
  const name = basename(file)
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { file, name, ok: false, issues: [], error: `读取失败：${String(error)}` }
  }

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    return { file, name, ok: false, issues: [], error: `YAML 解析失败：${String(error)}` }
  }

  if (raw === null || raw === undefined) {
    return { file, name, ok: false, issues: [], error: '文件为空' }
  }

  const result = validateScenario(raw, name)
  if (!result.ok || !result.scenario) {
    return { file, name, ok: false, issues: result.issues }
  }
  return { file, name, ok: true, scenario: result.scenario, issues: [] }
}

/** 扫描目录下所有 `*.yaml`（不含 index.yaml）并逐个加载。 */
export function loadCases(casesDir: string): LoadResult {
  const out: LoadResult = { casesDir, loaded: [], scenarios: [], invalid: [], indexIssues: [] }

  if (!existsSync(casesDir)) {
    out.indexIssues.push({ path: '', message: `casesDir 不存在：${casesDir}` })
    return out
  }
  if (!statSync(casesDir).isDirectory()) {
    out.indexIssues.push({ path: '', message: `casesDir 不是目录：${casesDir}` })
    return out
  }

  const files = readdirSync(casesDir)
    .filter((f) => f.toLowerCase().endsWith('.yaml') || f.toLowerCase().endsWith('.yml'))
    .filter((f) => f !== 'index.yaml' && f !== 'index.yml')
    .sort()

  for (const f of files) {
    const loaded = loadCaseFile(join(casesDir, f))
    out.loaded.push(loaded)
    if (loaded.ok && loaded.scenario) out.scenarios.push(loaded.scenario)
    else out.invalid.push(loaded)
  }

  out.scenarios.sort((a, b) => a.id.localeCompare(b.id))

  const indexResult = loadIndex(casesDir)
  out.index = indexResult.index
  out.indexIssues = indexResult.issues.concat(checkIndexConsistency(out.scenarios, indexResult.index))

  return out
}

/** 读取 `cases/index.yaml`（缺失不算错，但会记录提示）。 */
export function loadIndex(casesDir: string): { index?: CaseIndex; issues: ValidationIssue[] } {
  const file = join(casesDir, 'index.yaml')
  if (!existsSync(file)) {
    return { issues: [{ path: 'index.yaml', message: '索引文件缺失（建议运行 scripts/verify-cases.mjs 生成）' }] }
  }
  try {
    const raw = parseYaml(readFileSync(file, 'utf8')) as Partial<CaseIndex> | null
    if (!raw || typeof raw !== 'object') {
      return { issues: [{ path: 'index.yaml', message: '索引文件内容不是对象' }] }
    }
    const index: CaseIndex = {
      schema: Number(raw.schema ?? 1),
      nextId: Number(raw.nextId ?? 1),
      cases: Array.isArray(raw.cases) ? (raw.cases as CaseIndexEntry[]) : [],
    }
    return { index, issues: [] }
  } catch (error) {
    return { issues: [{ path: 'index.yaml', message: `索引解析失败：${String(error)}` }] }
  }
}

/** 核对场景集合与索引的一致性（孤儿项、ID 冲突、nextId 越界）。 */
export function checkIndexConsistency(
  scenarios: readonly Scenario[],
  index: CaseIndex | undefined,
): ValidationIssue[] {
  if (!index) return []
  const issues: ValidationIssue[] = []
  const indexIds = new Set(index.cases.map((c) => c.id))
  const scenarioIds = new Set(scenarios.map((s) => s.id))

  for (const s of scenarios) {
    if (!indexIds.has(s.id)) issues.push({ path: 'index.yaml', message: `场景 ${s.id} 未登记进索引` })
  }
  for (const id of indexIds) {
    if (!scenarioIds.has(id)) issues.push({ path: 'index.yaml', message: `索引里的 ${id} 没有对应文件` })
  }

  const maxUsed = scenarios.reduce((max, s) => {
    const n = Number(s.id.slice(3))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  if (index.nextId <= maxUsed) {
    issues.push({ path: 'index.yaml', message: `nextId (${index.nextId}) 必须大于已用最大 ID (${maxUsed})` })
  }

  return issues
}
