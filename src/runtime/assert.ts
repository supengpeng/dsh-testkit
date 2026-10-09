/**
 * 断言求值。
 *
 * 纯逻辑，无 DSH 依赖，可被单元测试直接覆盖。
 * 断言词语义见 docs/SCENARIO-SPEC.md §2.5。
 */

import type { Assertion } from '../cases/types.js'

/** 单个断言的判定结果。 */
export interface AssertionResult {
  ok: boolean
  /** 断言原文，便于报告里回显。 */
  assertion: Assertion
  /** 实际取到的值。 */
  actual: unknown
  /** 人类可读的说明（失败时给出差异）。 */
  message: string
}

/** 所有断言词的联合类型。 */
const ASSERTION_KEYS = [
  'is',
  'isNot',
  'notIs',
  'exists',
  'notExists',
  'contains',
  'notContains',
  'matches',
  'atLeast',
  'atMost',
  'length',
  'lengthAtLeast',
  'lengthAtMost',
  'throws',
] as const

type AssertionKey = (typeof ASSERTION_KEYS)[number]

/** 深比较（够用于 JSON 形状的数据）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false
    if (a.length !== b.length) return false
    return a.every((item, i) => deepEqual(item, b[i]))
  }

  const ao = a as Record<string, unknown>
  const bo = b as Record<string, unknown>
  const ak = Object.keys(ao)
  const bk = Object.keys(bo)
  if (ak.length !== bk.length) return false
  return ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]))
}

/** 取长度，非可长度对象返回 undefined。 */
function lengthOf(value: unknown): number | undefined {
  if (typeof value === 'string' || Array.isArray(value)) return value.length
  if (value instanceof Map || value instanceof Set) return value.size
  return undefined
}

/** 解析 `/pattern/flags` 形式的正则字面量。 */
export function parseRegexLiteral(source: string): RegExp {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(source)
  if (m) {
    try {
      return new RegExp(m[1]!, m[2]!)
    } catch {
      /* 落回按普通字符串构造 */
    }
  }
  return new RegExp(source)
}

function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/**
 * 对单个断言求值。
 *
 * 一个 Assertion 里若出现多个断言词，**全部**必须通过（视为 AND）。
 */
export function evaluateAssertion(assertion: Assertion, actual: unknown): AssertionResult {
  const present = ASSERTION_KEYS.filter((k) => assertion[k] !== undefined)

  if (present.length === 0) {
    return {
      ok: false,
      assertion,
      actual,
      message: `断言缺少判定词（${assertion.ref} 只给了 ref）`,
    }
  }

  for (const key of present) {
    const verdict = check(key, assertion[key], actual)
    if (!verdict.ok) {
      return { ok: false, assertion, actual, message: verdict.message }
    }
  }

  return {
    ok: true,
    assertion,
    actual,
    message: `${assertion.ref} 满足 ${present.join(' + ')}`,
  }
}

function check(key: AssertionKey, expected: unknown, actual: unknown): { ok: boolean; message: string } {
  switch (key) {
    case 'is':
      return deepEqual(actual, expected)
        ? ok()
        : fail(`期望 is ${describe(expected)}，实际 ${describe(actual)}`)

    case 'isNot':
    case 'notIs':
      return !deepEqual(actual, expected)
        ? ok()
        : fail(`期望不等于 ${describe(expected)}，但相等`)

    case 'exists':
      return Boolean(expected) === (actual !== undefined && actual !== null)
        ? ok()
        : fail(`期望 exists=${String(expected)}，实际 ${describe(actual)}`)

    case 'notExists':
      return Boolean(expected) === (actual === undefined || actual === null)
        ? ok()
        : fail(`期望 notExists=${String(expected)}，实际 ${describe(actual)}`)

    case 'contains': {
      if (typeof actual === 'string') {
        return actual.includes(String(expected))
          ? ok()
          : fail(`期望包含 ${describe(expected)}，实际 ${describe(actual)}`)
      }
      if (Array.isArray(actual)) {
        return actual.some((item) => deepEqual(item, expected))
          ? ok()
          : fail(`期望数组含 ${describe(expected)}`)
      }
      return fail(`contains 不适用于 ${typeof actual}`)
    }

    case 'notContains': {
      if (typeof actual === 'string') {
        return !actual.includes(String(expected))
          ? ok()
          : fail(`期望不包含 ${describe(expected)}`)
      }
      if (Array.isArray(actual)) {
        return !actual.some((item) => deepEqual(item, expected))
          ? ok()
          : fail(`期望数组不含 ${describe(expected)}`)
      }
      return fail(`notContains 不适用于 ${typeof actual}`)
    }

    case 'matches': {
      if (typeof actual !== 'string') return fail(`matches 需要字符串，实际 ${typeof actual}`)
      const re = parseRegexLiteral(String(expected))
      return re.test(actual) ? ok() : fail(`期望匹配 ${String(expected)}，实际 ${describe(actual)}`)
    }

    case 'atLeast':
      return typeof actual === 'number' && actual >= Number(expected)
        ? ok()
        : fail(`期望 >= ${String(expected)}，实际 ${describe(actual)}`)

    case 'atMost':
      return typeof actual === 'number' && actual <= Number(expected)
        ? ok()
        : fail(`期望 <= ${String(expected)}，实际 ${describe(actual)}`)

    case 'length':
    case 'lengthAtLeast':
    case 'lengthAtMost': {
      const len = lengthOf(actual)
      if (len === undefined) return fail(`length 需要可长度对象，实际 ${typeof actual}`)
      const want = Number(expected)
      if (key === 'length') return len === want ? ok() : fail(`期望长度 ${want}，实际 ${len}`)
      if (key === 'lengthAtLeast') return len >= want ? ok() : fail(`期望长度 >= ${want}，实际 ${len}`)
      return len <= want ? ok() : fail(`期望长度 <= ${want}，实际 ${len}`)
    }

    case 'throws':
      return Boolean(expected) ? fail('期望抛错，但取值成功') : ok()
  }
}

function ok(): { ok: boolean; message: string } {
  return { ok: true, message: '' }
}
function fail(message: string): { ok: boolean; message: string } {
  return { ok: false, message }
}

/**
 * 解析取值路径。
 *
 * 支持 `a.b[0].c` 形式的点路径与索引。
 * 数据源映射由调用方提供（见 runtime/refs.ts）。
 */
export function resolvePath(root: unknown, path: string): unknown {
  if (!path) return root
  let cursor: unknown = root
  for (const rawSeg of path.split('.')) {
    if (cursor === undefined || cursor === null) return undefined
    const segments = rawSeg.match(/^([^[\]]*)((?:\[\d+\])*)$/)
    if (!segments) return undefined

    const [, name, indexes] = segments
    if (name) {
      if (typeof cursor !== 'object') return undefined
      cursor = (cursor as Record<string, unknown>)[name]
    }
    if (indexes) {
      for (const idx of indexes.match(/\[\d+\]/g) ?? []) {
        const i = Number(idx.slice(1, -1))
        if (!Array.isArray(cursor)) return undefined
        cursor = cursor[i]
      }
    }
  }
  return cursor
}
