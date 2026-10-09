/**
 * 场景注册表：内存中的场景真源 + 变更通知。
 */

import { loadCases, type LoadResult, type LoadedCase } from './loader.js'
import type { Scenario, ScenarioKind } from './types.js'

export interface CaseFilter {
  ids?: readonly string[]
  kinds?: readonly ScenarioKind[]
  tags?: readonly string[]
  status?: readonly string[]
  /** 只看某条 issue 关联的场景。 */
  issue?: string
}

export type RegistryListener = (snapshot: RegistrySnapshot) => void

export interface RegistrySnapshot {
  scenarios: readonly Scenario[]
  invalid: readonly LoadedCase[]
  indexIssues: LoadResult['indexIssues']
  loadedAt: string
}

export class CaseRegistry {
  private scenarios: Scenario[] = []
  private invalid: LoadedCase[] = []
  private indexIssues: LoadResult['indexIssues'] = []
  private loadedAt = ''
  private casesDir = ''
  private readonly listeners = new Set<RegistryListener>()

  constructor(casesDir: string) {
    this.casesDir = casesDir
  }

  get dir(): string {
    return this.casesDir
  }

  /** 重新扫描并替换内容；返回本次结果供调用方汇报。 */
  reload(casesDir?: string): LoadResult {
    if (casesDir) this.casesDir = casesDir
    const result = loadCases(this.casesDir)
    this.scenarios = result.scenarios
    this.invalid = result.invalid
    this.indexIssues = result.indexIssues
    this.loadedAt = new Date().toISOString()
    this.emit()
    return result
  }

  get snapshot(): RegistrySnapshot {
    return {
      scenarios: this.scenarios,
      invalid: this.invalid,
      indexIssues: this.indexIssues,
      loadedAt: this.loadedAt,
    }
  }

  get all(): readonly Scenario[] {
    return this.scenarios
  }

  get invalidCases(): readonly LoadedCase[] {
    return this.invalid
  }

  get problems(): LoadResult['indexIssues'] {
    return this.indexIssues
  }

  get(id: string): Scenario | undefined {
    return this.scenarios.find((s) => s.id === id)
  }

  filter(query: CaseFilter = {}): Scenario[] {
    return this.scenarios.filter((s) => {
      if (query.ids && query.ids.length > 0 && !query.ids.includes(s.id)) return false
      if (query.kinds && query.kinds.length > 0 && !query.kinds.includes(s.kind)) return false
      if (query.status && query.status.length > 0 && !query.status.includes(s.status ?? 'active')) return false
      if (query.tags && query.tags.length > 0) {
        const own = new Set(s.tags ?? [])
        if (!query.tags.some((t) => own.has(t))) return false
      }
      if (query.issue !== undefined && (s.source.issue ?? '') !== query.issue) return false
      return true
    })
  }

  /** 按 kind 统计（报告与列表用）。 */
  countsByKind(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const s of this.scenarios) out[s.kind] = (out[s.kind] ?? 0) + 1
    return out
  }

  onChange(listener: RegistryListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    const snap = this.snapshot
    for (const listener of this.listeners) {
      try {
        listener(snap)
      } catch {
        /* 监听器异常不影响注册表 */
      }
    }
  }
}
