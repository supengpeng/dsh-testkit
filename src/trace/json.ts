/**
 * 规范 trace JSON（`trace.json`）渲染。
 *
 * 这是**本仓自己的**形态（不是给别人吃的标准），用于：
 *   · 跨运行对比（"这一步一直是 45ms 还是忽然变成 900ms"）
 *   · 给 Chrome Trace / OTLP 两种标准导出当共同的上游
 *
 * 字段契约：
 * ```
 * { schema: 1, runId, generatedFrom, totals: { cases, spans, totalMs },
 *   cases: [{ id, title, kind, verdict, durationMs, spans }] }
 * ```
 * `spans` 里的 `startMs` 一律是**相对本条 case 起点**的偏移（见 runlog.ts 的
 * `TraceSpan`），`cases[].durationMs` 才是该 case 的总耗时。
 */

import type { RunSummary } from '../runtime/runlog.js'
import { resolveTrace, totalDurationMs } from './spans.js'

/** 规范 trace JSON 的 schema 版本；形态变化时 +1。 */
export const TRACE_SCHEMA_VERSION = 1

/** 渲染规范 trace JSON（2 空格缩进 + 末尾换行，便于 diff）。 */
export function renderTraceJson(summary: RunSummary): string {
  const resolved = resolveTrace(summary)
  const spans = resolved.cases.reduce((sum, item) => sum + item.spans.length, 0)

  const document = {
    schema: TRACE_SCHEMA_VERSION,
    runId: summary.runId,
    generatedFrom: resolved.generatedFrom,
    totals: {
      cases: resolved.cases.length,
      spans,
      // 各 case 耗时之和——不是 span 时长之和（case 总跨度与步骤重叠）。
      totalMs: totalDurationMs(summary),
    },
    cases: resolved.cases.map((item) => ({
      id: item.id,
      title: item.title,
      kind: item.kind,
      verdict: item.verdict,
      durationMs: item.durationMs,
      spans: item.spans,
    })),
  }

  return `${JSON.stringify(document, null, 2)}\n`
}
