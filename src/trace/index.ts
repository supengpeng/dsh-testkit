/**
 * 可观测性导出面（文档 §6.1）。
 *
 * 模块分工：
 *   · `spans.ts`    —— 解析 / 重建 / 汇总（**唯一**的事实提取处，其余文件只做呈现）
 *   · `json.ts`     —— 本仓规范 trace JSON（跨运行对比用）
 *   · `chrome.ts`   —— Chrome Trace Event Format（`chrome://tracing` / Perfetto）
 *   · `otel.ts`     —— OTLP JSON（合成绝对时间戳，见该文件头注）
 *   · `timeline.ts` —— 人类可读时间线
 *
 * 三种机器可读导出**同源**：都从 `resolveTrace` 取同一批 span，
 * 因此它们的 case / span 数一定一致，不会出现"Chrome 里 12 条、OTel 里 11 条"。
 *
 * 历史兼容：`run.json` 没有 `trace` 时按 `steps[].durationMs` 重建，
 * 并在所有导出里标 `generatedFrom: 'reconstructed'`（近似边界见 `spans.ts` 头注）。
 */

export {
  DEFAULT_SLOWEST_TOP,
  reconstructSpans,
  resolveTrace,
  summarizeTrace,
  totalDurationMs,
  type ResolvedCaseTrace,
  type ResolvedTrace,
  type SlowSpan,
  type TraceSource,
  type TraceSummary,
} from './spans.js'

export { TRACE_SCHEMA_VERSION, renderTraceJson } from './json.js'

export { renderChromeTrace, type ChromeTraceEvent } from './chrome.js'

export { renderOtelSpans, type OtelExportOptions } from './otel.js'

export { renderTimeline, type TimelineOptions } from './timeline.js'
