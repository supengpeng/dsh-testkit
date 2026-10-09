/**
 * kind: prompt —— 系统提示的 section / context / variable 注入。
 *
 * ## 为什么这个 driver 是"可完全验证"的
 *
 * `systemPrompt.assemble()` 是**可主动调用**的公开方法，返回组装后的
 * `PromptAssembly { sections, contexts, tools, variables }`。
 * 所以本 driver 不需要等模型真的跑一轮：注册完立刻组装一次，把结果记进 Fixture，
 * 断言直接查 `fx.sectionText` / `fx.variableValue` 即可。
 *
 * 契约（来自 `systemPrompt` 服务）：
 *   section({ name, order, text, interpolate?, complete? }) → disposer
 *   context({ name, order, text })                          → disposer
 *   variable(name, (ctx) => string | undefined)             → disposer
 *   assemble({ scope?, signal? }): Promise<PromptAssembly>
 *
 * ## 一个容易踩的约束
 *
 * `variable` 的名字必须匹配 `[a-z][a-z0-9_]*`——**只能小写**。
 * 写 `testkitVar` 会被 DSH 拒绝。本 driver 在注册前先自查并给出可读的错误，
 * 免得你对着宿主抛出的异常猜。
 */

import type { Scenario, StepAction } from '../cases/types.js'
import { SkipCase, type Driver, type DriverContext } from './types.js'

interface SystemPromptServiceLike {
  section?: (section: {
    name: string
    order: number
    text: string
    interpolate?: boolean
    complete?: boolean
  }) => () => void
  context?: (context: { name: string; order: number; text: string }) => () => void
  variable?: (name: string, provider: (ctx: unknown) => string | undefined) => () => void
  assemble?: (context?: { scope?: unknown; signal?: AbortSignal }) => Promise<PromptAssemblyLike>
}

interface PromptAssemblyLike {
  sections?: Array<{ name?: string; text?: string }>
  contexts?: Array<{ name?: string; text?: string }>
  tools?: unknown[]
  variables?: Record<string, string | undefined>
}

export interface PromptSetup {
  section?: {
    name: string
    order: number
    text: string
    interpolate?: boolean
    complete?: boolean
  }
  context?: {
    name: string
    order: number
    text: string
  }
  variable?: {
    name: string
    value: string
  }
}

/** DSH 对 prompt variable 名字的约束。导出以便单测与错误信息复用同一份规则。 */
export const VARIABLE_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 从组装结果里抽出便于断言的面。纯函数，可单测。 */
export function summarizeAssembly(assembly: PromptAssemblyLike | undefined): {
  sectionNames: string[]
  sectionText: string
  contextNames: string[]
  contextText: string
} {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
  return {
    sectionNames: sections.map((s) => String(s?.name ?? '')),
    sectionText: sections.map((s) => String(s?.text ?? '')).join('\n'),
    contextNames: contexts.map((c) => String(c?.name ?? '')),
    contextText: contexts.map((c) => String(c?.text ?? '')).join('\n'),
  }
}

export const promptDriver: Driver = {
  kind: 'prompt',
  description: '注册系统提示的 section / context / variable，并主动组装一次以取证',
  requires: ['systemPrompt'],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { prompt?: PromptSetup }).prompt
    if (!setup) return

    const service = ctx.host.service('systemPrompt') as SystemPromptServiceLike | undefined
    if (!service) throw new SkipCase('宿主没有 systemPrompt 服务')

    let registered = 0

    if (setup.section) {
      if (typeof service.section !== 'function') {
        throw new SkipCase('systemPrompt 服务不提供 section()')
      }
      const spec = setup.section
      ctx.fixture.add(
        `prompt:section:${spec.name}`,
        service.section({
          name: spec.name,
          order: spec.order,
          text: spec.text,
          ...(spec.interpolate === undefined ? {} : { interpolate: spec.interpolate }),
          ...(spec.complete === undefined ? {} : { complete: spec.complete }),
        }),
      )
      registered += 1
    }

    if (setup.context) {
      if (typeof service.context !== 'function') {
        throw new SkipCase('systemPrompt 服务不提供 context()')
      }
      const spec = setup.context
      ctx.fixture.add(
        `prompt:context:${spec.name}`,
        service.context({ name: spec.name, order: spec.order, text: spec.text }),
      )
      registered += 1
    }

    if (setup.variable) {
      if (typeof service.variable !== 'function') {
        throw new SkipCase('systemPrompt 服务不提供 variable()')
      }
      const spec = setup.variable
      // 先自查名字，免得对着宿主抛的异常猜（DSH 要求 [a-z][a-z0-9_]*）
      if (!VARIABLE_NAME_RE.test(spec.name)) {
        throw new Error(
          `prompt.variable.name 不合法：「${spec.name}」。` +
            `DSH 要求匹配 ${String(VARIABLE_NAME_RE)}（只能小写字母开头，后接小写字母/数字/下划线）`,
        )
      }
      ctx.fixture.add(
        `prompt:variable:${spec.name}`,
        service.variable(spec.name, () => spec.value),
      )
      registered += 1
    }

    if (registered === 0) return

    // 主动组装一次取证。失败**不抛出**——组装失败本身就是要被测的东西，
    // 让 case 用 `fx.assembleError exists: false` 来表达期望更直白。
    if (typeof service.assemble !== 'function') {
      ctx.fixture.note('assembleError', 'systemPrompt 服务不提供 assemble()，无法取证')
      return
    }

    try {
      const assembly = await service.assemble({ signal: ctx.signal })
      const summary = summarizeAssembly(assembly)
      ctx.fixture.note('assembled', assembly)
      ctx.fixture.note('sectionNames', summary.sectionNames)
      ctx.fixture.note('sectionText', summary.sectionText)
      ctx.fixture.note('contextNames', summary.contextNames)
      ctx.fixture.note('contextText', summary.contextText)
      ctx.fixture.note(
        'variableValue',
        setup.variable ? assembly?.variables?.[setup.variable.name] : undefined,
      )
      ctx.fixture.note('assembleError', undefined)
    } catch (error) {
      ctx.fixture.note(
        'assembleError',
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      )
    }
  },

  /** prompt 类场景没有"动作"：注册即条件，组装即取证。 */
  act(_ctx: DriverContext, action: StepAction): void {
    throw new Error(
      `prompt driver 不支持动作（提示词注入在 setup 阶段完成）：${Object.keys(action as object).join('/')}`,
    )
  },
}
