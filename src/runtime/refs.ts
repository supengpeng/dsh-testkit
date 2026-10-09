/**
 * 取值路径解析：把断言里的 `ref` 映射到实际值。
 *
 * 前缀语义见 docs/SCENARIO-SPEC.md §2.5：
 *   fx.*    driver 通过 Fixture.note() 暴露的运行期数据
 *   case.*  case 自身的字段
 *   env.*   运行环境信息
 */

import type { Scenario } from '../cases/types.js'
import { resolvePath } from './assert.js'
import type { Fixture } from './fixture.js'

export interface RefEnvironment {
  dshVersion: string
  platform: string
  nodeVersion: string
  [key: string]: unknown
}

export interface RefSources {
  fixture: Fixture
  scenario: Scenario
  env: RefEnvironment
}

export interface RefResolution {
  found: boolean
  value: unknown
  /** 无法解析时说明原因（供报告使用）。 */
  reason?: string
}

/** 解析一个 ref。 */
export function resolveRef(ref: string, sources: RefSources): RefResolution {
  const dot = ref.indexOf('.')
  if (dot < 0) return { found: false, value: undefined, reason: `ref 缺少前缀：${ref}` }

  const prefix = ref.slice(0, dot)
  const path = ref.slice(dot + 1)

  switch (prefix) {
    case 'fx':
      // Fixture.notes 是一个**存在的容器**：没有记过的 key 就是 undefined，
      // 而不是「取值失败」。否则 `exists: false`（断言"没有出错"）永远无法表达
      // —— 这是一个被 TK-0001 暴露出来、现已修正的语义缺陷。
      return { found: true, value: resolvePath(sources.fixture.snapshot(), path) }
    case 'case':
      return { found: true, value: resolvePath(sources.scenario, path) }
    case 'env':
      return { found: true, value: resolvePath(sources.env, path) }
    default:
      return { found: false, value: undefined, reason: `未知 ref 前缀：${prefix}` }
  }
}
