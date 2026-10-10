/**
 * fixture 的 DSH 版本范围判定 —— 最小实现，**不引任何依赖**。
 *
 * 为什么不引 semver：本包对宿主的依赖树刻意保持精简（见 cases/schema.ts 的同类说明），
 * 而这里真正需要的语法只有一小撮（`>=0.2.0-rc.2` / `^0.2.0` / `~0.1` / `1.x` / `*`）。
 * 引一个包换来的风险（版本漂移、预发布语义差异）大于收益。
 *
 * ## 与 npm semver 的**唯一**有意差异
 *
 * 标准 semver 有一条「预发布默认被排除」的规则：`0.3.0-rc.1` 不满足 `>=0.2.0`，
 * 除非范围里显式写了同 major.minor.patch 的预发布。**本实现不做这条排除**——
 * 本仓的场景夹具恰恰是给 RC 用的（`>=0.2.0-rc.2` 就是范例），
 * 按标准规则会因为「范围里没写预发布」而把 RC 宿主判成不兼容，
 * 那是反直觉且难以排查的静默降级。这里改成直接按 semver 的**序**比较：
 * 预发布 < 同版本正式版，其余逐段比大小。
 *
 * 判定失败（范围语法不认识）一律返回 `{ ok: false }`，由调用方决定退回策略——
 * **绝不**把「看不懂」当成「满足」或「不满足」。
 */

/** 解析后的版本号。 */
export interface ParsedVersion {
  major: number
  minor: number
  patch: number
  /** 预发布标识；空数组 = 正式版。 */
  prerelease: ReadonlyArray<string | number>
  raw: string
}

export type VersionCheck =
  | { ok: true; satisfied: boolean }
  | { ok: false; reason: string }

export type RangeParse =
  | { ok: true; alternatives: ReadonlyArray<ReadonlyArray<Comparator>> }
  | { ok: false; reason: string }

interface Comparator {
  op: 'gt' | 'gte' | 'lt' | 'lte' | 'eq'
  version: ParsedVersion
}

const VERSION_RE = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 解析一个版本号；不合法返回 undefined（调用方负责报错，不静默兜底）。 */
export function parseVersion(text: string): ParsedVersion | undefined {
  const raw = String(text).trim()
  const match = VERSION_RE.exec(raw)
  if (!match) return undefined
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  const patch = Number(match[3] ?? 0)
  const pre: Array<string | number> = []
  if (match[4] !== undefined) {
    for (const part of match[4].split('.')) {
      pre.push(/^\d+$/.test(part) ? Number(part) : part)
    }
  }
  return { major, minor, patch, prerelease: pre, raw }
}

/**
 * 按 semver 序比较两个已解析版本。
 *
 * 返回值 <0 / 0 / >0 分别表示 a 早于 / 等于 / 晚于 b。
 */
export function compareVersions(a: ParsedVersion, b: ParsedVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }
  const ap = a.prerelease
  const bp = b.prerelease
  if (ap.length === 0 && bp.length === 0) return 0
  // 预发布 < 正式版
  if (ap.length === 0) return 1
  if (bp.length === 0) return -1
  const len = Math.max(ap.length, bp.length)
  for (let i = 0; i < len; i += 1) {
    const x = ap[i]
    const y = bp[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = typeof x === 'number'
    const yn = typeof y === 'number'
    if (xn && yn) {
      if (x !== y) return (x as number) < (y as number) ? -1 : 1
    } else if (xn !== yn) {
      // 数字标识 < 字母标识
      return xn ? -1 : 1
    } else if (x !== y) {
      return String(x) < String(y) ? -1 : 1
    }
  }
  return 0
}

function makeVersion(major: number, minor: number, patch: number): ParsedVersion {
  return { major, minor, patch, prerelease: [], raw: `${major}.${minor}.${patch}` }
}

/** 把「1.2」/「1.2.3-rc.1」这类片段解析成 { parts, prerelease }；非法返回 undefined。 */
function parsePartial(text: string): { parts: number[]; prerelease: string[] } | undefined {
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(text.trim())
  if (!match) return undefined
  const parts: number[] = [Number(match[1])]
  if (match[2] !== undefined) parts.push(Number(match[2]))
  if (match[3] !== undefined) parts.push(Number(match[3]))
  return { parts, prerelease: match[4] === undefined ? [] : match[4].split('.') }
}

function withPrerelease(base: ParsedVersion, prerelease: readonly string[]): ParsedVersion {
  return {
    ...base,
    prerelease: prerelease.map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
    raw: `${base.major}.${base.minor}.${base.patch}${prerelease.length > 0 ? `-${prerelease.join('.')}` : ''}`,
  }
}

/** 解析一段由单个「操作符 + 版本」组成的比较子句。 */
function parseComparator(token: string): Comparator[] | { error: string } {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token)
  if (!match) return { error: `无法解析的比较子句：${token}` }
  const op = match[1]
  const rest = match[2]!.trim()
  if (rest === '') return { error: `比较子句缺少版本号：${token}` }

  // 通配：`*` / `x` / `1.x` / `1.2.*`
  //
  // 只在**数字段**上认通配（先切掉预发布/构建元数据），否则 `1.0.0-abc.x`
  // 这种预发布标识会被误判成通配。
  const numeric = rest.split(/[-+]/, 1)[0] ?? ''
  if (numeric === '*' || /^[xX]$/.test(numeric)) {
    // 裸通配 = 任意版本
    return [{ op: 'gte', version: makeVersion(0, 0, 0) }]
  }
  if (/[xX*]/.test(numeric)) {
    const parts = numeric.split('.')
    const index = parts.findIndex((p) => p === '*' || /^[xX]$/i.test(p))
    if (index < 0 || index >= 3) return { error: `通配版本无法解析：${token}` }
    const nums = parts.slice(0, index).map((p) => Number(p))
    if (nums.some((n) => !Number.isFinite(n))) return { error: `通配版本无法解析：${token}` }
    const lower = makeVersion(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0)
    if (op === '>' || op === '>=' || op === '<' || op === '<=') {
      const mapped: Record<string, Comparator['op']> = {
        '>': 'gt',
        '>=': 'gte',
        '<': 'lt',
        '<=': 'lte',
      }
      return [{ op: mapped[op]!, version: lower }]
    }
    // 通配位决定上界：`1.x` → <2.0.0；`1.2.x` → <1.3.0
    const upper =
      index <= 1
        ? makeVersion((nums[0] ?? 0) + 1, 0, 0)
        : makeVersion(nums[0] ?? 0, (nums[1] ?? 0) + 1, 0)
    return [
      { op: 'gte', version: lower },
      { op: 'lt', version: upper },
    ]
  }

  const partial = parsePartial(rest)
  if (!partial) return { error: `版本号无法解析：${rest}` }
  const [major = 0, minor = 0, patch = 0] = partial.parts
  const base = makeVersion(major, minor, patch)
  const version = withPrerelease(base, partial.prerelease)

  switch (op) {
    case '>':
      return [{ op: 'gt', version }]
    case '>=':
      return [{ op: 'gte', version }]
    case '<':
      return [{ op: 'lt', version }]
    case '<=':
      return [{ op: 'lte', version }]
    case '=':
      return [{ op: 'eq', version }]
    case '^': {
      const upper =
        major > 0
          ? makeVersion(major + 1, 0, 0)
          : minor > 0
            ? makeVersion(0, minor + 1, 0)
            : makeVersion(0, 0, patch + 1)
      return [
        { op: 'gte', version },
        { op: 'lt', version: upper },
      ]
    }
    case '~': {
      const upper =
        partial.parts.length >= 2 ? makeVersion(major, minor + 1, 0) : makeVersion(major + 1, 0, 0)
      return [
        { op: 'gte', version },
        { op: 'lt', version: upper },
      ]
    }
    default: {
      // 裸版本：写满三段 = 精确匹配；只写 1~2 段 = npm 的「范围」语义
      if (partial.parts.length >= 3) return [{ op: 'eq', version }]
      const upper =
        partial.parts.length === 2 ? makeVersion(major, minor + 1, 0) : makeVersion(major + 1, 0, 0)
      return [
        { op: 'gte', version },
        { op: 'lt', version: upper },
      ]
    }
  }
}

/** 解析版本范围（空格 = AND，`||` = OR，`a - b` = 区间）。 */
export function parseRange(range: string): RangeParse {
  const text = String(range ?? '').trim()
  if (text === '') return { ok: false, reason: '版本范围为空' }

  const alternatives: Comparator[][] = []
  for (const rawAlt of text.split('||')) {
    const alt = rawAlt.trim()
    if (alt === '') return { ok: false, reason: `范围里有空的 || 分支：${range}` }

    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(alt)
    if (hyphen) {
      const from = parseVersion(hyphen[1]!)
      const to = parseVersion(hyphen[2]!)
      if (!from || !to) return { ok: false, reason: `区间端点无法解析：${alt}` }
      alternatives.push([
        { op: 'gte', version: from },
        { op: 'lte', version: to },
      ])
      continue
    }

    const tokens = alt.split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return { ok: false, reason: `范围分支为空：${range}` }
    const comparators: Comparator[] = []
    for (const token of tokens) {
      const parsed = parseComparator(token)
      if (!Array.isArray(parsed)) return { ok: false, reason: parsed.error }
      comparators.push(...parsed)
    }
    alternatives.push(comparators)
  }
  return { ok: true, alternatives }
}

/** 范围是否语法合法（schema 校验用，不关心具体版本）。 */
export function isValidRange(range: string): boolean {
  return parseRange(range).ok
}

function pass(comparator: Comparator, version: ParsedVersion): boolean {
  const cmp = compareVersions(version, comparator.version)
  switch (comparator.op) {
    case 'gt':
      return cmp > 0
    case 'gte':
      return cmp >= 0
    case 'lt':
      return cmp < 0
    case 'lte':
      return cmp <= 0
    case 'eq':
      return cmp === 0
  }
}

/**
 * 判定 `version` 是否落在 `range` 内。
 *
 * 任一环节解析失败 → `{ ok: false, reason }`；调用方必须据此决定退回策略
 * （本仓的约定是：解析失败 = 场景跳过并写明原因，而不是当满足硬跑）。
 */
export function checkDshVersion(version: string, range: string): VersionCheck {
  const parsed = parseVersion(String(version ?? '').trim())
  if (!parsed) return { ok: false, reason: `DSH 版本无法解析：${JSON.stringify(version)}` }

  const parsedRange = parseRange(range)
  if (!parsedRange.ok) return { ok: false, reason: parsedRange.reason }

  const satisfied = parsedRange.alternatives.some((comparators) =>
    comparators.every((comparator) => pass(comparator, parsed)),
  )
  return { ok: true, satisfied }
}

/** 便捷判定：解析失败一律算「不满足」（只给不需要区分原因的调用方用）。 */
export function satisfies(version: string, range: string): boolean {
  const result = checkDshVersion(version, range)
  return result.ok ? result.satisfied : false
}
