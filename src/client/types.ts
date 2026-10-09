/**
 * client 半的类型契约。
 *
 * 这里**不 import** `@deepseek-ai/*` 的 client 包，而是用窄接口描述我们用到的面：
 * 一来避免打包时的外部依赖解析问题，二来把 DSH 侧 API 变动收敛在本文件。
 *
 * client 半运行在浏览器里，可用 builtin：ctx / React / host / styles / console。
 */

/** slot 注册元信息（与 dsh-streamfold / dsh-context 的实测用法一致）。 */
export interface SlotMeta {
  name: string
  id: string
  order?: number
  locale?: string
  label?: () => string
  key?: string
  inject?: (owner?: unknown) => unknown
}

export interface SlotsService {
  inject(key: string, callback: () => unknown): () => void
  register(meta: SlotMeta, component: (props: unknown) => unknown): () => void
}

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string) => string
}

/** client 半能拿到的受限 Cordis Context。 */
export interface ClientContext {
  effect(callback: () => unknown, label?: string): unknown
  readonly slots: SlotsService
  readonly locale: LocaleService
  /** 取其它 client 服务（可选）。 */
  get?(name: string): unknown
}

/** 本包 host 半的 RPC 桥（对应 builtin `host`）。 */
export interface HostBridge {
  call(method: string, args?: unknown): Promise<unknown>
}
