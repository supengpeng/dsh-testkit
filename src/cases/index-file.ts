/**
 * `cases/index.yaml` 的生成。
 *
 * 为什么把渲染逻辑收在这里，而不是留在 `scripts/verify-cases.mjs`：
 * **索引会被两处写**——① 守卫脚本 `--write` ② 提炼闸门的批准动作
 * （`pipeline` 把提案落地进 `cases/` 后必须同步索引）。
 * 两处各写一份必然漂移，所以真源放这里，脚本改为复用本模块。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { loadCases, type CaseIndex } from './loader.js'
import type { Scenario } from './types.js'

/** 索引文件的固定表头（两处写出的文件必须逐字节一致）。 */
export const INDEX_HEADER =
  '# 由 scripts/verify-cases.mjs --write 生成；只存索引与溯源，真源是各个 case 文件。'

/** 按场景集合构造索引对象；`nextId` 恒为「已用最大 ID + 1」。 */
export function buildIndex(scenarios: readonly Scenario[]): CaseIndex {
  const maxId = scenarios.reduce((max, s) => {
    const n = Number(s.id.slice(3))
    return Number.isFinite(n) && n > max ? n : max
  }, 0)
  return {
    schema: 1,
    nextId: maxId + 1,
    cases: scenarios.map((s) => ({
      id: s.id,
      kind: s.kind,
      status: s.status ?? 'active',
      issue: s.source.issue,
    })),
  }
}

/** 手写 YAML 渲染：索引结构固定，不值得为此引依赖。 */
export function renderIndexYaml(index: CaseIndex): string {
  const lines = [
    INDEX_HEADER,
    `schema: ${index.schema}`,
    `nextId: ${index.nextId}`,
    'cases:',
  ]
  if (index.cases.length === 0) {
    lines[lines.length - 1] = 'cases: []'
  } else {
    for (const c of index.cases) {
      lines.push(`  - id: ${c.id}`)
      lines.push(`    kind: ${c.kind}`)
      lines.push(`    status: ${c.status}`)
      lines.push(`    issue: ${c.issue === null || c.issue === undefined ? 'null' : quote(c.issue)}`)
    }
  }
  return `${lines.join('\n')}\n`
}

/**
 * 重新扫描 `casesDir` 并覆盖写 `index.yaml`。
 *
 * 调用方（守卫脚本 / 批准落地）都用它，保证索引永远由**目录真源**推导，
 * 而不是由调用方手搓的列表推导。
 */
export function writeIndexFile(casesDir: string): { nextId: number; count: number } {
  const result = loadCases(casesDir)
  const index = buildIndex(result.scenarios)
  writeFileSync(join(casesDir, 'index.yaml'), renderIndexYaml(index), 'utf8')
  return { nextId: index.nextId, count: index.cases.length }
}

function quote(value: string): string {
  const text = String(value)
  return /^[A-Za-z0-9_./:#?&=@+-]+$/.test(text) ? text : JSON.stringify(text)
}
