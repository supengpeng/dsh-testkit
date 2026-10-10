/**
 * fixture 的加载。
 *
 * ## 路径纪律：一律按**包根**解析，绝不按 `process.cwd()`
 *
 * CI 轨（`src/export/node-test.ts` 生成的用例）可能在任意工作目录下运行；
 * 若夹具路径跟着 `process.cwd()` 走，换个目录就会「静默找不到夹具」——
 * 表现成场景跳过，而不是报错，最难发现。因此：
 *   · `fixturesDir` 为相对路径时，按**包根**解析；
 *   · 缺省夹具根 = `<包根>/fixtures`（与 `src/config.ts` 的 defaultFixturesDir 一致）；
 *   · 解析结果必须仍位于夹具根之下（挡掉 `../` 越界）。
 */

import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import {
  validateFixture,
  type FixtureIssue,
  type FixtureSpec,
} from './schema.js'

/** 本包根（`src/fixtures/` 与 `lib/fixtures/` 的深度相同，因此两者都指向包根）。 */
export const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** 缺省夹具根：`<包根>/fixtures`。 */
export function defaultFixturesDir(): string {
  return join(packageRoot, 'fixtures')
}

/** 归一化夹具根：空值走缺省；相对路径按包根解析。 */
export function resolveFixturesDir(dir?: string): string {
  const trimmed = String(dir ?? '').trim()
  if (trimmed === '') return defaultFixturesDir()
  return isAbsolute(trimmed) ? trimmed : resolve(packageRoot, trimmed)
}

export interface LoadedFixture {
  /** 绝对路径。 */
  file: string
  /** 相对夹具根的 `<kind>/<name>`。 */
  name: string
  ok: boolean
  spec?: FixtureSpec
  issues: FixtureIssue[]
  /** 读取 / YAML 解析阶段的致命错误。 */
  error?: string
  /** 原始文本（敏感数据扫描用）。 */
  text?: string
}

/** 递归列出夹具根下所有 `*.yaml` / `*.yml`（排序，保证可复现）。 */
export function listFixtureFiles(fixturesDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        walk(full)
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
        out.push(full)
      }
    }
  }
  if (!existsSync(fixturesDir) || !statSync(fixturesDir).isDirectory()) return out
  walk(fixturesDir)
  return out.sort()
}

/** 把绝对路径换算成相对夹具根、以 `/` 分隔的 `llm/timeout.yaml`。 */
export function relativeFixturePath(fixturesDir: string, file: string): string {
  return relative(fixturesDir, file).split(sep).join('/')
}

/**
 * 按夹具名解析文件路径。
 *
 * 名字非法（含 `..`、绝对路径、不匹配 `<kind>/<name>`）或文件不存在 → undefined。
 */
export function resolveFixturePath(fixturesDir: string, name: string): string | undefined {
  const trimmed = String(name ?? '').trim()
  if (trimmed === '' || isAbsolute(trimmed) || trimmed.includes('..')) return undefined
  if (!/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(trimmed)) return undefined

  const base = resolveFixturesDir(fixturesDir)
  for (const ext of ['.yaml', '.yml']) {
    const candidate = resolve(base, `${trimmed}${ext}`)
    if (!candidate.startsWith(base + sep) && candidate !== base) continue
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return undefined
}

/** 读取并校验一份夹具文件。 */
export function loadFixtureFile(fixturesDir: string, file: string): LoadedFixture {
  const rel = relativeFixturePath(fixturesDir, file)
  const base: LoadedFixture = { file, name: rel.replace(/\.ya?ml$/i, ''), ok: false, issues: [] }

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    return { ...base, error: `读取失败：${error instanceof Error ? error.message : String(error)}` }
  }

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    return {
      ...base,
      text,
      error: `YAML 解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (raw === null || raw === undefined) return { ...base, text, error: '文件为空' }

  const result = validateFixture(raw, { relativePath: rel })
  if (!result.ok || !result.spec) return { ...base, text, issues: result.issues }
  return { ...base, text, ok: true, spec: result.spec }
}

export interface FixturesLoadResult {
  dir: string
  files: string[]
  fixtures: LoadedFixture[]
  invalid: LoadedFixture[]
  byName: Map<string, LoadedFixture>
}

/** 扫描整个夹具根。单个坏件不阻断其余加载（与 cases 的 loader 同纪律）。 */
export function loadFixtures(fixturesDir?: string): FixturesLoadResult {
  const dir = resolveFixturesDir(fixturesDir)
  const files = listFixtureFiles(dir)
  const result: FixturesLoadResult = { dir, files, fixtures: [], invalid: [], byName: new Map() }
  for (const file of files) {
    const loaded = loadFixtureFile(dir, file)
    if (loaded.ok) {
      result.fixtures.push(loaded)
      if (!result.byName.has(loaded.name)) result.byName.set(loaded.name, loaded)
    } else {
      result.invalid.push(loaded)
    }
  }
  return result
}
