/**
 * OTLP JSON 导出（OpenTelemetry Protocol，`resourceSpans[].scopeSpans[].spans[]`）。
 *
 * ## 一句话先说清：**只有偏移才有意义**
 *
 * 本仓的 trace 是**单机单进程**的步骤观测，不是分布式追踪：
 * runlog 里记的是"相对本条 case 起点"的偏移，**没有**绝对墙钟时间戳。
 * 所以这里必须**合成**绝对时间：`基准时刻(now) + 运行内偏移`。
 * 基准是你注入的（默认 `Date.now()`），它只影响"这些 span 落在哪一秒"，
 * 不影响任何相对关系——**绝对时间戳本身没有观测含义，偏移才有**。
 * 不要拿这个绝对时间去和别的系统对表。
 *
 * ## 单位与精度
 *
 * OTLP 用 **Unix 纳秒**（uint64）。JS number 只有 53 位有效位，
 * `1.7e18` 早就超出精确整数范围，直接乘 1e6 会静默丢精度
 * （相邻纳秒差可能算错几百 ns）。因此这里全程用 `BigInt` 计算，
 * 并按 protobuf JSON 的约定**输出字符串**。精度落在微秒（毫秒值 ×1000）。
 *
 * ## ID 是合成的
 *
 * 单进程 trace 没有真实 traceId/spanId，但 OTLP 消费方（collector / Jaeger）
 * 要求 span 有身份、且子 span 能挂到父上。这里用**确定性哈希**生成：
 * 同一次运行重复导出得到完全相同的 ID（可复现、可 diff），
 * 但它们不对应任何真实分布式 trace。
 *
 * 粒度是**一个 case 一条 trace**：case 总跨度是这条 trace 的根（无 parentSpanId），
 * 该 case 的各步 span 挂到它下面。case 之间相互独立，不硬连成一棵树。
 */

import type { RunSummary, TraceSpan } from '../runtime/runlog.js'
import { resolveTrace } from './spans.js'

/** 注入的合成基准时刻：epoch 毫秒，或一个 `Date`。 */
export interface OtelExportOptions {
  /** 合成绝对时间的基准（默认 `Date.now()`）。只影响"落在哪一秒"，不影响偏移。 */
  now?: number | Date
}

interface OtelAttributeValue {
  stringValue?: string
  boolValue?: boolean
}

interface OtelAttribute {
  key: string
  value: OtelAttributeValue
}

interface OtelSpan {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  /** 1 = SPAN_KIND_INTERNAL（本仓没有跨进程调用，全部是内部步骤）。 */
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: OtelAttribute[]
}

/**
 * 渲染 OTLP JSON。
 *
 * 输出恒为一条 `resourceSpans`（一个 run 就是一个资源），
 * 其下一条 `scopeSpans`；span 顺序 = 规范 trace 的顺序（case 总跨度在前）。
 */
export function renderOtelSpans(summary: RunSummary, options: OtelExportOptions = {}): string {
  const resolved = resolveTrace(summary)
  const baseMs = epochMs(options.now)
  const spans: OtelSpan[] = []

  for (const item of resolved.cases) {
    const traceId = syntheticId('trace', 32, summary.runId, item.id)
    const spanIds = item.spans.map((_, index) =>
      syntheticId('span', 16, summary.runId, item.id, String(index)),
    )
    // 步骤 span 挂到该 case 的 `case` 总跨度下（若存在）。
    const caseIndex = item.spans.findIndex((span) => span.phase === 'case')
    const caseSpanId = caseIndex >= 0 ? (spanIds[caseIndex] ?? '') : ''

    item.spans.forEach((span, index) => {
      const spanId = spanIds[index] ?? syntheticId('span', 16, summary.runId, item.id, String(index))
      const startUs = Math.round((baseMs + item.startMs + span.startMs) * 1000)
      const endUs = startUs + Math.round(Math.max(0, span.durationMs) * 1000)

      spans.push({
        traceId,
        spanId,
        ...(caseSpanId === '' || index === caseIndex ? {} : { parentSpanId: caseSpanId }),
        name: span.name,
        kind: 1,
        startTimeUnixNano: (BigInt(startUs) * 1000n).toString(),
        endTimeUnixNano: (BigInt(endUs) * 1000n).toString(),
        attributes: otelAttributes(item.id, item.kind, item.verdict, item.generatedFrom, span),
      })
    })
  }

  const document = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'dsh-testkit' } },
            { key: 'dsh.testkit.run_id', value: { stringValue: summary.runId } },
            { key: 'dsh.testkit.platform', value: { stringValue: summary.platform } },
            { key: 'dsh.testkit.dsh_version', value: { stringValue: summary.dshVersion } },
            {
              key: 'dsh.testkit.generated_from',
              value: { stringValue: resolved.generatedFrom },
            },
          ],
        },
        scopeSpans: [
          {
            scope: { name: 'dsh-testkit.trace', version: '1' },
            spans,
          },
        ],
      },
    ],
  }

  return `${JSON.stringify(document, null, 2)}\n`
}

function otelAttributes(
  caseId: string,
  caseKind: string,
  verdict: string,
  generatedFrom: string,
  span: TraceSpan,
): OtelAttribute[] {
  const attributes: OtelAttribute[] = [
    { key: 'dsh.case.id', value: { stringValue: caseId } },
    { key: 'dsh.case.kind', value: { stringValue: caseKind } },
    { key: 'dsh.case.verdict', value: { stringValue: verdict } },
    { key: 'dsh.trace.phase', value: { stringValue: span.phase } },
    { key: 'dsh.trace.source', value: { stringValue: generatedFrom } },
  ]
  // `ok` 只在有判定含义的阶段存在（act / assert / case）；没有就不编。
  if (span.ok !== undefined) {
    attributes.push({ key: 'dsh.span.ok', value: { boolValue: span.ok } })
  }
  return attributes
}

function epochMs(now: number | Date | undefined): number {
  if (now === undefined) return Date.now()
  return now instanceof Date ? now.getTime() : now
}

/**
 * 确定性 ID：FNV-1a 逐 lane 展开成 16/32 位十六进制。
 * 同一输入永远同一输出（可复现），但不对应任何真实分布式 trace。
 */
function syntheticId(prefix: string, length: number, ...parts: string[]): string {
  const text = `${prefix}:${parts.join('\u0000')}`
  let out = ''
  for (let lane = 0; out.length < length; lane += 1) {
    out += hash32(0x811c9dc5 + lane, text).toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

function hash32(seed: number, text: string): number {
  let hash = seed >>> 0
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}
