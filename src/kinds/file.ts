/**
 * kind: file —— 读取文件 / 列目录并取证内容。
 *
 * ## 为什么需要它（来自能力缺口分析）
 *
 * 对 `dsh-memory` / `lingshu` 的 238 条可回归候选做形态分类后，
 * **97 条**（41%）属于 `file-inspect`：判据是"某个文件里有没有某段内容"、
 * "清单里有没有这一项"、"frontmatter 里有没有这个字段"。
 *
 * 这类判据用 `kind: shell` 也能凑（`grep` / `cat`），但：
 *   · 依赖外部命令可用性（Windows 上 `grep` 未必有）
 *   · 输出要再做文本解析，容易写出脆弱的断言
 * 所以值得有直说的 kind。
 *
 * ## 它是**纯离线**的
 *
 * 用 `node:fs` 直接读文件，**不需要宿主提供任何服务**——
 * 所以 `requires` 为空，任何宿主（含 CI 轨）都能跑。
 * 这是继 `ui` 之后第二个纯离线的 kind。
 *
 * ## 动作形状
 *
 * ```yaml
 * steps:
 *   - act: { file: { read: lingshu/core/core.py } }   # 读一个文件
 *     expect: [{ ref: fx.fileText, contains: 'def search_content' }]
 *
 *   - act: { file: { glob: "tests/**\/*.py" } }       # 列文件
 *     expect: [{ ref: fx.globCount, atLeast: 1 }]
 *
 *   - act: { file: { search: { pattern: "compact_access", glob: "md_cg/**\/*.py" } } }
 *     expect: [{ ref: fx.searchCount, atLeast: 2 }]   # 定义 + 至少一个调用点
 * ```
 *
 * `search` 对应 `grep`：很多 issue 的判据是"某段代码有没有被引用"、
 * "某个约定有没有被破坏"，这类**结构性判据**用 glob + read 很难表达。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { Scenario, StepAction } from '../cases/types.js'
import { fixturesRoot, packageRoot } from '../config.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

export interface FileSetup {
  /**
   * 基准目录。`read` / `glob` 的相对路径都相对于它。
   *
   * 缺省 `process.cwd()`；支持令牌：
   *   · `$PKG` → 本插件包根
   *   · `$PKG/<子路径>` → 包根下的子路径
   *   · `$FIXTURES` / `$FIXTURES/<name>` → 外部 fixture 根（`<包根>/.fixtures`）
   */
  root?: string
  /** 单个文件最多读多少字符，缺省 512 KiB（防手滑读进巨型文件）。 */
  maxChars?: number
  /** glob 最多返回多少条，缺省 500。 */
  maxGlob?: number
}

/** file 场景的配置按 Fixture 隔离存放。 */
const fileConfigs = new WeakMap<object, FileSetup>()

/** 展开路径令牌；`$PKG` / `$FIXTURES` 可作前缀。 */
export function expandPathTokens(value: string): string {
  for (const [token, base] of [
    ['$FIXTURES', fixturesRoot],
    ['$PKG', packageRoot],
  ] as const) {
    if (value === token) return base
    for (const sep of ['/', '\\']) {
      if (value.startsWith(`${token}${sep}`)) return join(base, value.slice(token.length + 1))
    }
  }
  return value
}

/**
 * 极简 glob：支持 `**`（任意层）与 `*`（单层内任意）。
 *
 * 刻意不引第三方 glob——判据要能在任何环境下复现，
 * 而这个小实现的行为是**完全确定**的、可单测的。
 */
export function matchGlob(relativePath: string, pattern: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/')
  const p = pattern.replace(/\\/g, '/')

  // 把 glob 编译成正则
  let re = ''
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i] ?? ''
    if (ch === '*' && p[i + 1] === '*') {
      re += '.*'
      i += 1
      // 吞掉紧跟的斜杠，`**/x` 与 `x` 都应匹配
      if (p[i + 1] === '/') i += 1
      continue
    }
    if (ch === '*') {
      re += '[^/]*'
      continue
    }
    if (ch === '?') {
      re += '[^/]'
      continue
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(normalized)
}

/** 递归收集目录下的文件（相对 root）。 */
function walkFiles(dir: string, root: string, out: string[], cap: number): void {
  if (out.length >= cap) return
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    if (entry === 'node_modules' || entry === '.git') continue
    const full = join(dir, entry)
    let isDir = false
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) walkFiles(full, root, out, cap)
    else out.push(relative(root, full).replace(/\\/g, '/'))
  }
}

export const fileDriver: Driver = {
  kind: 'file',
  description: '读取文件 / 列目录并取证内容（纯离线，任何宿主都能跑）',
  // 纯离线：直接读文件，不需要宿主服务
  requires: [],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { file?: FileSetup }).file
    if (!setup) return

    // 显式给了 root 却不存在 → **在 setup 阶段**就跳过（口径与 shell driver 的 cwd 一致）。
    //
    // 为什么位置很关键：runner 把 **setup** 阶段抛出的 SkipCase 当"整条场景跳过"，
    // 而动作阶段抛出的会被记成"这一步失败"。早先这个判断只在 `act` 里，
    // 于是"外部 fixture 没下载"在本地（`.fixtures` 在）绿、在全新检出（CI）红——
    // 环境没准备好被报成了被测对象坏了。
    if (setup.root !== undefined && setup.root !== '') {
      const root = resolve(expandPathTokens(setup.root as string))
      if (!existsSync(root)) {
        throw new SkipCase(
          `file.root 不存在：${root}（若是外部 fixture，见 scripts/fetch-fixtures.mjs）`,
        )
      }
    }

    fileConfigs.set(ctx.fixture, setup)
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('file' in action)) {
      throw new Error(
        `file driver 只支持 \`file\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const setup = fileConfigs.get(ctx.fixture) ?? {}
    const explicitRoot = setup.root !== undefined && setup.root !== ''
    const rootValue = explicitRoot ? (setup.root as string) : process.cwd()
    const root = resolve(expandPathTokens(rootValue))
    const maxChars = setup.maxChars ?? 512 * 1024

    // **显式**给了 root 却不存在 → 跳过并说明，而不是让断言在莫名其妙的路径上失败。
    // 常见情形：场景依赖下载来的 fixture，而它还没准备。
    if (explicitRoot && !existsSync(root)) {
      throw new SkipCase(
        `file.root 不存在：${root}（若是外部 fixture，见 scripts/fetch-fixtures.mjs）`,
      )
    }

    ctx.fixture.note('fileRoot', root)

    const spec = action.file

    /* ---- glob：列文件 ---- */
    if ('glob' in spec && spec.glob !== undefined) {
      const cap = setup.maxGlob ?? 500
      // ⚠️ 扫描上限必须**远大于**返回上限。
      // 早先两者混用（都用 cap），于是深度优先扫到 cap 就停了——
      // `lib/` 下文件多时，`cases/` 根本没轮到，glob 结果恒为空（真踩过）。
      const scanCap = Math.max(cap * 50, 20_000)
      const all: string[] = []
      walkFiles(root, root, all, scanCap)

      const matchedAll = all.filter((rel) => matchGlob(rel, spec.glob)).sort()
      const matched = matchedAll.slice(0, cap)

      ctx.fixture.note('globPattern', spec.glob)
      ctx.fixture.note('globMatches', matched)
      ctx.fixture.note('globCount', matched.length)
      /** 匹配总数（截断前）——用于区分"没匹配"与"匹配很多但被截断" */
      ctx.fixture.note('globTotal', matchedAll.length)
      ctx.fixture.note('globTruncated', matchedAll.length > cap)
      ctx.fixture.note('globScanned', all.length)
      ctx.fixture.note('fileError', undefined)
      return
    }

    /* ---- search：在文件里找内容（对应 grep）---- */
    if ('search' in spec && spec.search !== undefined) {
      const s = spec.search
      if (typeof s.pattern !== 'string' || s.pattern === '') {
        throw new Error('file.search 需要 `pattern`')
      }

      let re: RegExp
      try {
        re = new RegExp(s.pattern, s.flags ?? '')
      } catch (error) {
        throw new Error(`file.search 的 pattern 不是合法正则：${describe(error)}`)
      }

      const cap = s.maxResults ?? setup.maxGlob ?? 500
      const scanCap = Math.max(cap * 50, 20_000)
      const all: string[] = []
      walkFiles(root, root, all, scanCap)

      const candidates =
        s.glob === undefined ? all : all.filter((rel) => matchGlob(rel, s.glob as string))

      const matches: Array<{ file: string; line: number; text: string }> = []
      const filesWithHits = new Set<string>()
      const scannedFiles: string[] = []

      for (const rel of candidates) {
        if (matches.length >= cap) break
        const full = resolve(root, rel)
        let content: string
        try {
          if (statSync(full).size > (setup.maxChars ?? 512 * 1024) * 4) continue
          content = readFileSync(full, 'utf8')
        } catch {
          continue
        }
        scannedFiles.push(rel)
        const lines = content.split('\n')
        for (const [index, line] of lines.entries()) {
          if (matches.length >= cap) break
          // 用 lastIndex 归零，避免带 g 标志的正则在跨行复用时有状态残留
          re.lastIndex = 0
          if (re.test(line)) {
            filesWithHits.add(rel)
            matches.push({ file: rel, line: index + 1, text: line.trim().slice(0, 400) })
          }
        }
      }

      ctx.fixture.note('searchPattern', s.pattern)
      ctx.fixture.note('searchGlob', s.glob)
      ctx.fixture.note('searchMatches', matches)
      ctx.fixture.note('searchCount', matches.length)
      ctx.fixture.note('searchFiles', [...filesWithHits].sort())
      ctx.fixture.note('searchFileCount', filesWithHits.size)
      ctx.fixture.note('searchScannedFiles', scannedFiles.length)
      // 所有命中行的拼接——便于用 `contains` 写断言（对对象数组写断言很别扭）
      ctx.fixture.note('searchText', matches.map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n'))
      ctx.fixture.note('fileError', undefined)
      return
    }

    /* ---- read：读一个文件 ---- */
    const rel = spec.read
    if (typeof rel !== 'string' || rel === '') {
      throw new Error('file 动作需要 `read`（相对路径）、`glob`（模式）或 `search`（{ pattern, glob? }）')
    }

    const full = isAbsolute(rel) ? rel : resolve(root, rel)
    ctx.fixture.note('filePath', full)
    ctx.fixture.note('fileRelative', relative(root, full).replace(/\\/g, '/'))

    if (!existsSync(full)) {
      // 文件不存在是**常见真实故障**（装机缺件、路径写错），
      // 所以如实取证而不是抛错——让场景用 `fx.fileExists is false` 断言它。
      ctx.fixture.note('fileExists', false)
      ctx.fixture.note('fileBytes', 0)
      ctx.fixture.note('fileText', undefined)
      ctx.fixture.note('fileLines', undefined)
      ctx.fixture.note('fileError', undefined)
      return
    }

    try {
      const stat = statSync(full)
      if (stat.isDirectory()) {
        ctx.fixture.note('fileExists', true)
        ctx.fixture.note('fileIsDirectory', true)
        ctx.fixture.note('fileError', '目标是目录，不是文件')
        return
      }
      const raw = readFileSync(full, 'utf8')
      const truncated = raw.length > maxChars
      const text = truncated ? raw.slice(0, maxChars) : raw

      ctx.fixture.note('fileExists', true)
      ctx.fixture.note('fileIsDirectory', false)
      ctx.fixture.note('fileBytes', stat.size)
      ctx.fixture.note('fileText', text)
      ctx.fixture.note('fileLines', text.split('\n'))
      ctx.fixture.note('fileLineCount', text.split('\n').length)
      ctx.fixture.note('fileTruncated', truncated)
      // 顺手取证换行风格——跨平台项目里 CRLF 混入是个真实故障源
      ctx.fixture.note('fileHasCRLF', raw.includes('\r\n'))
      ctx.fixture.note('fileError', undefined)
    } catch (error) {
      ctx.fixture.note('fileExists', true)
      ctx.fixture.note('fileError', describe(error))
    }
  },
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string'
      ? `${error.name}[${code}]: ${error.message}`
      : `${error.name}: ${error.message}`
  }
  return String(error)
}
