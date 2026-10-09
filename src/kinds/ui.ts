/**
 * kind: ui —— 验证 **client 半**（浏览器侧 bundle）的产物契约与注册行为。
 *
 * ## 为什么这个 driver 值得存在
 *
 * client 半是双半插件的另一半，但它长期是**测试盲区**：它的代码在浏览器里跑，
 * 而内置 runner 与 CI 轨都活在 Node 里。实测踩过两类坑都只能靠它兜住：
 *   · `lib/client.js` 不存在（构建脚本把它删了）→ GUI 里「测试」标签凭空不见
 *   · client bundle 的导出形态变了 → 加载静默失败
 *
 * ## 怎么在 Node 里验证浏览器产物
 *
 * bundle 的形态是 `window.__ModuleLoader__.load({ id, factory })`。
 * 所以只要在**隔离的 vm context** 里提供两样东西就能把它跑起来：
 *   · `window.__ModuleLoader__.load` —— 收集注册项
 *   · `require` —— 满足 external（React 等），用最小替身即可
 *
 * 然后拿 `factory(require)` 得到模块对象，并用**假 ctx** 调用它的 `apply()`，
 * 记录它对 `slots` / `locale` 的每一次调用。
 *
 * 这样得到的是**真实产物的真实行为**——不是另写一份"测试用的 client 半"。
 *
 * ## 它不验证什么
 *
 * 不验证**渲染结果**（React 组件长什么样、像素对不对）。那是浏览器的事。
 * 它验证的是"bundle 能加载、导出面正确、注册调用正确、注册项的名字与顺序正确"。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import vm from 'node:vm'

import { packageRoot } from '../config.js'
import type { Scenario, StepAction } from '../cases/types.js'
import type { Driver, DriverContext } from './types.js'

/** `ui` 动作。 */
export interface UiAction {
  /**
   * 是否真的加载并执行 bundle。
   *
   * 留成显式值是为了让"我只想看产物在不在"这类场景也能表达。
   */
  load?: boolean
}

export interface UiSetup {
  /** bundle 路径；缺省 `<包根>/lib/client.js`（即本包的真实产物）。 */
  bundle?: string
  /** 期望注册的 slot 名（顺序无关）。 */
  expectSlots?: string[]
  /** 期望注册的 locale 命名空间。 */
  expectLocaleNamespaces?: string[]
}

/* ------------------------------------------------------------ 假宿主面 -- */

interface LocaleRegisterCall {
  namespace: string
  dictionaries: unknown
}

interface SlotRegisterCall {
  name: string
  id: string
  order: number | undefined
}

interface UiObservation {
  bundlePath: string
  bundleExists: boolean
  bundleBytes: number
  moduleId: string | undefined
  name: string | undefined
  inject: string[]
  hasApply: boolean
  loadCalls: number
  /** 执行 apply 后收到的 effect 标签（用于确认注册确实发生） */
  effectLabels: string[]
  /** `locale.register(ns, dict)` 的调用记录 */
  localeCalls: LocaleRegisterCall[]
  /** `slots.inject(name, cb)` 的调用记录 */
  injectedSlots: string[]
  /** `slots.register(def, renderer)` 的调用记录 */
  registeredSlots: SlotRegisterCall[]
  /** 注册时确实给了渲染函数吗 */
  rendererProvided: boolean
  applyError: string | undefined
}

/** React 的最小替身：只要求"能造出元素"，不要求渲染。 */
function makeFakeRequire(calls: { created: number }): (id: string) => unknown {
  const fakeReact = {
    createElement(type: unknown, props: unknown, ...children: unknown[]) {
      calls.created += 1
      return { $$type: type, props, children }
    },
  }
  const table: Record<string, unknown> = {
    react: fakeReact,
    'react/jsx-runtime': {
      jsx: fakeReact.createElement,
      jsxs: fakeReact.createElement,
      Fragment: Symbol('Fragment'),
    },
  }
  return (id: string) => {
    if (id in table) return table[id]
    // external 之外的请求不该出现；如实报错，方便发现新依赖
    throw new Error(`client bundle 请求了未提供的模块：${id}`)
  }
}

/**
 * 在隔离 context 里加载 client bundle 并执行它的 apply。
 *
 * 用 vm 而不是直接 import：bundle 是"给浏览器用的脚本"，它引用 `window`
 * 与 `require`——直接 import 会污染真实全局。
 */
export function inspectClientBundle(source: string, bundlePath: string): UiObservation {
  const observation: UiObservation = {
    bundlePath,
    bundleExists: true,
    bundleBytes: Buffer.byteLength(source, 'utf8'),
    moduleId: undefined,
    name: undefined,
    inject: [],
    hasApply: false,
    loadCalls: 0,
    effectLabels: [],
    localeCalls: [],
    injectedSlots: [],
    registeredSlots: [],
    rendererProvided: false,
    applyError: undefined,
  }

  const loaded: { id: string; factory: (require: (id: string) => unknown) => unknown }[] = []

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
          observation.loadCalls += 1
          loaded.push(entry)
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    // 有些打包产物会摸这些；给最小实现避免它炸在无关处
    globalThis: undefined as unknown,
  }
  ;(sandbox as { globalThis: unknown }).globalThis = sandbox

  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: bundlePath })

  const first = loaded[0]
  if (!first) return observation

  observation.moduleId = first.id

  const reactCalls = { created: 0 }
  const require = makeFakeRequire(reactCalls)
  const moduleObject = first.factory(require) as {
    name?: unknown
    inject?: unknown
    apply?: unknown
  }

  if (typeof moduleObject?.name === 'string') observation.name = moduleObject.name
  if (Array.isArray(moduleObject?.inject)) {
    // 注意用展开复制：`moduleObject.inject` 出自 vm 的另一个 realm，
    // 直接在它上面 `.filter()` 会返回**那个 realm 的数组**，
    // 而 `assert.deepStrictEqual` 会比较原型 —— 于是"值一样却判不等"。
    observation.inject = [...(moduleObject.inject as unknown[])].filter(
      (x): x is string => typeof x === 'string',
    )
  }
  observation.hasApply = typeof moduleObject?.apply === 'function'

  if (!observation.hasApply) return observation

  /* ---- 假 ctx：只实现 client 半真正用到的三个面 ---- */
  const fakeCtx = {
    effect(fn: () => unknown, label?: string) {
      if (typeof label === 'string') observation.effectLabels.push(label)
      // cordis 的 effect 会立即执行回调并收集其返回的 disposer
      return fn()
    },
    locale: {
      register(namespace: string, dictionaries: unknown) {
        observation.localeCalls.push({ namespace, dictionaries })
        return () => undefined
      },
      bind(namespace: string) {
        return (key: string) => `${namespace}.${key}`
      },
    },
    slots: {
      inject(name: string, cb: () => unknown) {
        observation.injectedSlots.push(name)
        return cb()
      },
      register(definition: Record<string, unknown>, renderer: unknown) {
        observation.registeredSlots.push({
          name: typeof definition['name'] === 'string' ? definition['name'] : '',
          id: typeof definition['id'] === 'string' ? definition['id'] : '',
          order: typeof definition['order'] === 'number' ? definition['order'] : undefined,
        })
        if (typeof renderer === 'function') observation.rendererProvided = true
        return () => undefined
      },
    },
  }

  try {
    ;(moduleObject.apply as (ctx: unknown) => void)(fakeCtx)
  } catch (error) {
    observation.applyError = error instanceof Error ? error.message : String(error)
  }

  return observation
}

/* ---------------------------------------------------------------- driver -- */

/** ui 场景的配置按 Fixture 隔离存放。 */
const uiConfigs = new WeakMap<object, UiSetup>()

function resolveBundlePath(configured: string | undefined): string {
  if (configured === undefined || configured.trim() === '') {
    return join(packageRoot, 'lib', 'client.js')
  }
  return isAbsolute(configured) ? configured : join(packageRoot, configured)
}

export const uiDriver: Driver = {
  kind: 'ui',
  description: '验证 client 半 bundle 的产物契约与 slot / 词典注册（在隔离 vm 里加载真实产物）',
  // 纯离线：不需要宿主提供任何服务，所以任何宿主（含 CI 轨）都能跑
  requires: [],

  async setup(ctx: DriverContext, scenario: Scenario): Promise<void> {
    const setup = (scenario.setup as { ui?: UiSetup }).ui
    if (!setup) return
    uiConfigs.set(ctx.fixture, setup)
  },

  async act(ctx: DriverContext, action: StepAction): Promise<void> {
    if (!('ui' in action)) {
      throw new Error(
        `ui driver 只支持 \`ui\` 动作，收到：${Object.keys(action as object).join('/')}`,
      )
    }

    const setup = uiConfigs.get(ctx.fixture) ?? {}
    const bundlePath = resolveBundlePath(setup.bundle)

    ctx.fixture.note('uiBundlePath', bundlePath)

    let source: string
    try {
      source = readFileSync(bundlePath, 'utf8')
    } catch (error) {
      // 产物缺失是**最常见的真实故障**（构建脚本漏跑），所以明确取证而不是抛错，
      // 让场景可以用 `fx.uiBundleExists is false` 断言它。
      ctx.fixture.note('uiBundleExists', false)
      ctx.fixture.note('uiBundleBytes', 0)
      ctx.fixture.note('uiError', `读不到 bundle：${describe(error)}`)
      return
    }

    if (action.ui.load === false) {
      ctx.fixture.note('uiBundleExists', true)
      ctx.fixture.note('uiBundleBytes', Buffer.byteLength(source, 'utf8'))
      ctx.fixture.note('uiError', undefined)
      return
    }

    let observation: UiObservation
    try {
      observation = inspectClientBundle(source, bundlePath)
    } catch (error) {
      ctx.fixture.note('uiBundleExists', true)
      ctx.fixture.note('uiBundleBytes', Buffer.byteLength(source, 'utf8'))
      ctx.fixture.note('uiError', `加载 bundle 失败：${describe(error)}`)
      return
    }

    ctx.fixture.note('uiBundleExists', observation.bundleExists)
    ctx.fixture.note('uiBundleBytes', observation.bundleBytes)
    ctx.fixture.note('uiModuleId', observation.moduleId)
    ctx.fixture.note('uiName', observation.name)
    ctx.fixture.note('uiInject', observation.inject)
    ctx.fixture.note('uiHasApply', observation.hasApply)
    ctx.fixture.note('uiLoadCalls', observation.loadCalls)
    ctx.fixture.note('uiEffectLabels', observation.effectLabels)
    ctx.fixture.note('uiLocaleNamespaces', observation.localeCalls.map((c) => c.namespace))
    ctx.fixture.note('uiInjectedSlots', observation.injectedSlots)
    ctx.fixture.note('uiRegisteredSlots', observation.registeredSlots)
    ctx.fixture.note(
      'uiRegisteredSlotNames',
      observation.registeredSlots.map((s) => s.name),
    )
    ctx.fixture.note('uiRendererProvided', observation.rendererProvided)
    ctx.fixture.note('uiError', observation.applyError)

    if (setup.expectSlots !== undefined) {
      ctx.fixture.note('uiExpectedSlots', setup.expectSlots)
    }
    if (setup.expectLocaleNamespaces !== undefined) {
      ctx.fixture.note('uiExpectedLocaleNamespaces', setup.expectLocaleNamespaces)
    }

    // 配置里声明了期望却没被注册 —— 这是"标签不出现"那类 issue 的直接证据，
    // 所以立即以失败收尾，而不是留给断言慢慢找。
    const registered = new Set(observation.registeredSlots.map((s) => s.name))
    const missing = (setup.expectSlots ?? []).filter((name) => !registered.has(name))
    if (missing.length > 0) {
      throw new Error(
        `client 半没有注册期望的 slot：${missing.join(', ')}（实际注册：${
          [...registered].join(', ') || '无'
        }）`,
      )
    }

    const namespaces = new Set(observation.localeCalls.map((c) => c.namespace))
    const missingNs = (setup.expectLocaleNamespaces ?? []).filter((ns) => !namespaces.has(ns))
    if (missingNs.length > 0) {
      throw new Error(
        `client 半没有注册期望的词典命名空间：${missingNs.join(', ')}（实际：${
          [...namespaces].join(', ') || '无'
        }）`,
      )
    }
  },
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code
    return typeof code === 'string' ? `${error.name}[${code}]: ${error.message}` : error.message
  }
  return String(error)
}
