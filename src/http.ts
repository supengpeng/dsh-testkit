/**
 * host 半的 HTTP bridge —— client 半与 host 半之间的**真实通道**。
 *
 * ## 为什么不是 host.call
 *
 * DSH 确实有一个包私有 RPC `host.call(method, args)`，但它属于**动态包**机制：
 * 它的 host 端是 `harness.handle(method, fn)`，定义在
 * `@deepseek-ai/dsh-cordis-host-runner/lib/types/guard.js` 的「沙箱边界归一化器」
 * （"the `harness.handle` invoke-handler normalizer, the SANDBOX CONTEXT"），
 * 由 `dsh-cordis-client-runner` 在求值动态包源码时注入。
 *
 * 静态插件包（npm 包里带 `dsh.client` 的那种）**拿不到**它：
 *   - 静态插件的浏览器半是打包好的 bundle，由 `dsh-client-modules` 装载，
 *     其 `lib/client.js` 里没有任何 builtin 注入逻辑；
 *   - 已装的两个静态插件都不使用它：`dsh-free-search` 自建 HTTP bridge
 *     （其源码注释明写「配置读写走自建 bridge，不依赖 dsh-web-ui」），
 *     `dsh-model-extension` 复用官方已有的 `ctx.remote.*` namespace。
 *
 * 因此本插件采用**已被实战验证**的路径：自建 `webServer` 路由 + 浏览器侧 `fetch`。
 * 契约见 DSH 的 `webServer` 服务：`WebRoute = { kind: 'exact'|'prefix', path, handler(req, res) }`。
 *
 * ## 通道纪律
 *
 * client 半不持有真相（见 docs/ARCHITECTURE.md §6.3）：本文件只做
 * 「读场景 / 跑场景 / 取报告」三件事的转发，全部返回 JSON。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { CaseRegistry } from './cases/registry.js'
import { resolvePolicy, type PolicyOptions } from './executor/policy.js'
import type { DriverRegistry, HostFacade } from './kinds/types.js'
import { writeRunArtifacts } from './report/json.js'
import { renderMarkdown } from './report/markdown.js'
import { runScenarios } from './runtime/runner.js'

/** 所有路由共享的前缀。client 半用同一个常量拼 URL。 */
export const BRIDGE_PREFIX = '/api/dsh-testkit'

/** 与 DSH `webServer.register` 的入参同形（不 import 宿主类型，保持本文件可独立编译）。 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface HttpBridgeDeps {
  registry: CaseRegistry
  drivers: DriverRegistry
  host: HostFacade
  runsDir: () => string
  defaultTimeoutMs: () => number
  /**
   * 成本闸门的默认值（插件配置）。
   *
   * 与工具面同样的纪律：**总是**构造策略并传入（省略即 `DEFAULT_POLICY`，
   * `allowModel: false`），client 半的「跑一下」按钮不能成为绕过闸门的后门。
   */
  policyDefaults?: () => PolicyOptions
  /** 夹具根（client 半点「跑一下」时同样要应用 `fixtures:`）。 */
  fixturesDir?: () => string
  /** 并发度上限；省略 = 1（串行）。 */
  parallelLimit?: () => number
  /** 是否对报告脱敏；省略 = false。 */
  redact?: () => boolean
}

/** 统一的响应信封，风格沿用 dsh-free-search 的 bridge。 */
type Envelope<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string }

export function makeBridgeRoutes(deps: HttpBridgeDeps): WebRouteLike[] {
  const handlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
    async list() {
      const { registry } = deps
      return {
        dir: registry.dir,
        loadedAt: registry.snapshot.loadedAt,
        scenarios: registry.all.map((s) => ({
          id: s.id,
          kind: s.kind,
          status: s.status ?? 'active',
          title: s.title,
          tags: s.tags ?? [],
          issue: s.source.issue,
        })),
        counts: registry.countsByKind(),
        invalid: registry.invalidCases.map((c) => ({
          file: c.name,
          detail:
            c.error ?? c.issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('; '),
        })),
        problems: registry.problems.map((p) => `${p.path || 'index.yaml'}: ${p.message}`),
      }
    },

    async run(payload) {
      const { registry, drivers, host } = deps
      const ids = asStringArray(payload['ids'])
      const kinds = asStringArray(payload['kinds'])
      const tags = asStringArray(payload['tags'])

      const summary = await runScenarios({
        registry,
        drivers,
        host,
        filter: {
          ...(ids ? { ids } : {}),
          ...(kinds ? { kinds: kinds as never } : {}),
          ...(tags ? { tags } : {}),
          // 与 testkit_run 同一条规则：显式点名可按 id 跑 draft，无选择器时只跑 active
          ...(ids ? {} : { status: ['active'] }),
        },
        defaultTimeoutMs: deps.defaultTimeoutMs(),
        // 与工具面一致：总是带闸门，client 半不是绕过成本闸门的后门。
        // 放权由人走命令面（`/testkit run --allow-model`），bridge 只读配置默认值。
        policy: resolvePolicy(deps.policyDefaults?.() ?? {}),
        // 夹具与并发同样按配置生效：否则「UI 里跑一遍」与「命令里跑一遍」不是同一件事。
        ...(deps.fixturesDir === undefined
          ? {}
          : { fixtures: { fixturesDir: deps.fixturesDir(), dshVersion: host.env.dshVersion } }),
        ...(deps.parallelLimit === undefined ? {} : { parallelLimit: deps.parallelLimit() }),
      })

      const write = await writeRunArtifacts(summary, deps.runsDir(), {
        redact: deps.redact?.() === true,
      })

      return {
        runId: summary.runId,
        totals: summary.totals,
        policySnapshot: summary.policySnapshot ?? null,
        reportPath: write.artifacts?.markdownPath ?? null,
        writeError: write.error ?? null,
        cases: summary.cases.map((c) => ({
          id: c.id,
          title: c.title,
          kind: c.kind,
          verdict: c.verdict,
          durationMs: c.durationMs,
          error: c.error ?? null,
          skipReason: c.skipReason ?? null,
          // 归因 / 复现 / 用量是与 verdict 并列的证据，UI 要能直接展示
          failureCategory: c.failureCategory ?? null,
          minimalRepro: c.minimalRepro ?? null,
          usage: c.usage ?? null,
        })),
      }
    },

    async report(payload) {
      const { readdir, readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      const runsDir = deps.runsDir()
      let runId = typeof payload['runId'] === 'string' ? payload['runId'] : undefined

      if (!runId) {
        const entries = (await readdir(runsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
        runId = entries[entries.length - 1]
        if (!runId) return { runId: null, markdown: null }
      }

      const markdown = await readFile(join(runsDir, runId, 'report.md'), 'utf8')
      return { runId, markdown }
    },

    async reload() {
      const result = deps.registry.reload()
      return {
        scenarios: result.scenarios.length,
        invalid: result.invalid.length,
        loadedAt: deps.registry.snapshot.loadedAt,
      }
    },
  }

  return Object.entries(handlers).map(([name, run]) => ({
    kind: 'exact' as const,
    path: `${BRIDGE_PREFIX}/${name}`,
    handler: async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'use POST' })
        return
      }
      let payload: Record<string, unknown> = {}
      try {
        const raw = await readBody(req)
        if (raw.trim() !== '') {
          const parsed: unknown = JSON.parse(raw)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>
          }
        }
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          code: 'bad-json',
          message: error instanceof Error ? error.message : String(error),
        })
        return
      }

      try {
        const value = await run(payload)
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'handler-failed',
          message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        })
      }
    },
  }))
}

/** 与 WebRoute 的 handler 签名对齐的上限：16 MiB 足够，防止畸形请求打爆内存。 */
const MAX_BODY_BYTES = 16 * 1024 * 1024

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    total += buf.byteLength
    if (total > MAX_BODY_BYTES) throw new Error(`请求体过大（> ${MAX_BODY_BYTES} 字节）`)
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res: ServerResponse, status: number, payload: Envelope<unknown>): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string')
  return out.length > 0 ? out : undefined
}

export { renderMarkdown }
