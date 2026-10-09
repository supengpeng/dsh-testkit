/**
 * client 半 → host 半 的通信。
 *
 * ## 结论（已实测确认，不再是不确定性）
 *
 * **静态插件包没有 `host.call`。** 那个 API 属于动态包机制：
 * host 端是 `harness.handle(method, fn)`，位于 `@deepseek-ai/dsh-cordis-host-runner`
 * 的沙箱边界（`lib/types/guard.js`），由 `dsh-cordis-client-runner` 在求值动态包时注入。
 * 静态插件的浏览器半是打包 bundle，由 `dsh-client-modules` 装载，拿不到该符号。
 *
 * 因此本文件走**自建 HTTP bridge**——这也是 `dsh-free-search` 实战验证过的路径
 * （其源码注释：「配置读写走自建 bridge，不依赖 dsh-web-ui」）。
 *
 * 端点定义在 host 半的 `src/http.ts`，两侧共用同一个前缀常量。
 */

/** 与 host 半 `src/http.ts` 的 BRIDGE_PREFIX 必须一致。 */
export const BRIDGE_PREFIX = '/api/dsh-testkit'

/** host 半统一的响应信封。 */
type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

/** bridge 调用失败：区分传输失败与 host 半返回的业务失败。 */
export class BridgeError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

/**
 * 调用 host 半的一个 bridge 端点。
 *
 * @param method - 端点名（`list` / `run` / `report` / `reload`）
 * @param args - 会被 JSON 序列化；省略等价于空对象
 */
export async function callHost<T = unknown>(method: string, args?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${BRIDGE_PREFIX}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(args ?? {}),
    })
  } catch (error) {
    throw new BridgeError(
      'transport-failed',
      `无法连接 host 半（${BRIDGE_PREFIX}/${method}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let envelope: Envelope<T>
  try {
    envelope = (await response.json()) as Envelope<T>
  } catch {
    throw new BridgeError(
      'bad-response',
      `host 半返回了非 JSON 响应（HTTP ${response.status}）`,
    )
  }

  if (!envelope.ok) {
    throw new BridgeError(envelope.code, envelope.message)
  }
  return envelope.value
}

/** 浏览器上下文里 fetch 永远可用；保留此函数是为了让 UI 能给出更准确的提示。 */
export function isBridgeAvailable(): boolean {
  return typeof fetch === 'function'
}

/** host 半 /list 端点的返回形状。 */
export interface ScenarioListPayload {
  dir: string
  loadedAt: string
  scenarios: Array<{
    id: string
    kind: string
    status: string
    title: string
    tags: string[]
    issue: string | null
  }>
  counts: Record<string, number>
  invalid: Array<{ file: string; detail: string }>
  problems: string[]
}

/** host 半 /run 端点的返回形状。 */
export interface RunPayload {
  runId: string
  totals: { total: number; passed: number; failed: number; skipped: number; errored: number }
  reportPath: string | null
  writeError: string | null
  cases: Array<{
    id: string
    title: string
    kind: string
    verdict: 'passed' | 'failed' | 'skipped' | 'errored'
    durationMs: number
    error: string | null
    skipReason: string | null
  }>
}
