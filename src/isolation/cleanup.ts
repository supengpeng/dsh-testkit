/**
 * 步骤级释放（第 7.4 节：幂等 / 可重入）。
 *
 * ## 它解决什么
 *
 * `Step.cleanup.releaseNotes` 声明"这一步结束后就该拆掉的取证键"。
 * 不拆的代价很实际：接管 `llm/stream` 的监听器会一直挂到整条场景结束，
 * 于是后面的步骤观测到的是"被前一步改造过的宿主"——现场不可信。
 *
 * ## 为什么是"取证键 → 资源句柄"而不是"标签 → disposer"
 *
 * `Fixture` 的公开面只有 `add(label, dispose)` / `release()`（整份释放），
 * **没有**按 label 单独释放的入口，也不允许从外部摘下已登记的条目
 * （见 `src/runtime/fixture.ts`，本任务不得改它）。
 * 所以这里把"可单独释放的资源"做成一个句柄对象，用 `Fixture.note(key, handle)`
 * 存进取证键下：
 *
 *   · 单独释放 = 直接调句柄（本模块的 `releaseStepNotes`）；
 *   · 整份兜底释放 = 句柄同时也被 `Fixture.add()` 登记了一份兜底，
 *     场景结束时 `Fixture.release()` 会走到它——**没被本步释放的仍然会被释放**；
 *   · 失败收集 = 句柄把失败记在自己身上，兜底那一份再把它抛出去，
 *     于是失败进的是 `Fixture.release()` 的 `failures`，**不抛穿**调用方。
 *
 * 由此得到一条**幂等链**：单独释放过 → 兜底那份变成 no-op（不会二次释放）；
 * 没单独释放过 → 兜底那份照常释放。两条路径都不抛穿。
 *
 * ## 报告里的形状
 *
 * 句柄带 `toJSON()`，所以 `run.json` 里这个键显示为
 * `{"kind":"step-resource","key":"…","released":true|false}`，
 * 而不是一个函数被 `JSON.stringify` 丢掉后留下的 `{}`。
 */

import type { Fixture } from '../runtime/fixture.js'

/** 步骤级可释放资源句柄；`step.cleanup.releaseNotes` 里的键指向它。 */
export interface StepResource {
  /** 释放键（= 取证键）。裸函数句柄为 `(anonymous)`，失败上报时用键名覆盖。 */
  readonly key: string
  /** 真正的释放实现。 */
  readonly dispose: () => void | Promise<void>
  /** 是否已释放（幂等标记；本模块读写）。 */
  released: boolean
  /** 已发生但尚未上报的失败描述（留给夹具兜底 release 收进 failures）。 */
  failure?: string
  /** 是否已把兜底释放登记进夹具。 */
  registered: boolean
  toJSON(): { kind: 'step-resource'; key: string; released: boolean }
}

/** 裸函数句柄的登记表：同一个函数重复传入仍是同一个句柄（幂等）。 */
const anonymousResources = new WeakMap<object, StepResource>()

/**
 * 登记一个步骤级资源：把句柄写进取证键，并挂一份夹具兜底释放。
 *
 * 这是 driver 侧应该用的入口——只用 `fixture.add()` 登记的话，
 * `releaseNotes` 就找不到它（找不到**不报错**，只是这一步拆不掉，等场景结束）。
 */
export function registerStepDisposer(
  fixture: Fixture,
  key: string,
  dispose: () => void | Promise<void>,
): StepResource {
  if (typeof dispose !== 'function') {
    throw new TypeError('registerStepDisposer: dispose 必须是函数')
  }
  const resource = makeStepResource(key, dispose)
  fixture.note(key, resource)
  registerFallback(fixture, resource, key)
  return resource
}

/**
 * 按 `step.cleanup.releaseNotes` 释放对应资源，返回**实际释放成功**的键。
 *
 * 语义：
 *   · 键不存在、值不是资源句柄 → 跳过，不抛；
 *   · 已释放过 → 跳过，不抛（幂等，重复调用安全）；
 *   · 释放失败 → 记进句柄，交给 `Fixture.release()` 的 failures，**不抛穿**，
 *     且该键**不计入**返回值（"返回实际释放了哪些键"要能当真）。
 *
 * 返回 `Promise`：disposer 允许异步（`Fixture.add` 的契约就是
 * `void | Promise<void>`）。**必须 `await`**——不 await 就会退回
 * "步骤结束时没真正拆掉"的老问题，那正是本模块存在的理由。
 */
export async function releaseStepNotes(
  fixture: Fixture,
  notes: readonly string[],
): Promise<string[]> {
  const released: string[] = []

  for (const key of notes) {
    const resource = stepResourceOf(fixture.getNote(key))
    if (resource === undefined || resource.released) continue

    // 先置标记再执行：这样即使 dispose 里再入本函数，也不会二次释放
    resource.released = true
    registerFallback(fixture, resource, key)

    try {
      await resource.dispose()
      released.push(key)
    } catch (error) {
      resource.failure = describeError(error)
      // 刻意不抛穿：失败已记进句柄，夹具兜底 release() 会上报它
    }
  }

  return released
}

/**
 * 把一个取证值解释成资源句柄。
 *
 * 支持两种登记方式：
 *   · `registerStepDisposer()` 造出的句柄对象；
 *   · 直接 `fixture.note(key, () => …)` 存的**裸函数**（便利路径，同样幂等）。
 * 其它值（字符串 / 数字 / 普通对象）一律返回 undefined——不许把证据误当资源。
 */
export function stepResourceOf(value: unknown): StepResource | undefined {
  if (typeof value === 'function') {
    const fn = value as () => void | Promise<void>
    const existing = anonymousResources.get(fn)
    if (existing !== undefined) return existing
    const created = makeStepResource('(anonymous)', fn)
    anonymousResources.set(fn, created)
    return created
  }
  return isStepResource(value) ? value : undefined
}

/** 把资源登记进夹具的兜底释放链（只登记一次）。 */
function registerFallback(fixture: Fixture, resource: StepResource, label: string): void {
  if (resource.registered) return
  resource.registered = true

  fixture.add(label, async () => {
    if (resource.released) {
      // 本步已经单独释放过：这份只剩"上报失败"的职责（no-op 或抛一次）
      if (resource.failure !== undefined) throw new Error(resource.failure)
      return
    }

    resource.released = true
    try {
      await resource.dispose()
    } catch (error) {
      resource.failure = describeError(error)
      throw error // 交给 Fixture.release() 收进 failures
    }
  })
}

function makeStepResource(key: string, dispose: () => void | Promise<void>): StepResource {
  return {
    key,
    dispose,
    released: false,
    registered: false,
    toJSON() {
      return { kind: 'step-resource' as const, key: this.key, released: this.released }
    },
  }
}

function isStepResource(value: unknown): value is StepResource {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StepResource>
  return (
    typeof candidate.dispose === 'function' &&
    typeof candidate.key === 'string' &&
    typeof candidate.released === 'boolean' &&
    typeof candidate.registered === 'boolean'
  )
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
