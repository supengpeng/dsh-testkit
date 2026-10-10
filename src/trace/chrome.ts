/**
 * Chrome Trace Event Format 导出（`chrome://tracing` / Perfetto 可直接打开）。
 *
 * 形态是**事件数组**：
 * ```
 * [{ name, cat, ph: 'X', ts, dur, pid, tid }]
 * ```
 *
 * 坐标怎么定（这三条决定了"图看起来对不对"）：
 *   · `ts` 是**运行级绝对偏移**：`该 case 的 startMs + span.startMs`。
 *     trace 里每个事件共享一条时间轴，各 case 首尾相接排开。
 *   · `dur` 直接用 `durationMs`（毫秒，Chrome 的时间单位就是微秒/毫秒无所谓，
 *     同一份数据内部一致即可；这里保持与报告的毫秒一致）。
 *   · `pid` = **case 序号（从 1 起）**：每个 case 占一条"进程"泳道。
 *   · `tid` = **阶段序号**（case/setup/act/assert/cleanup → 0..4）：同一条泳道
 *     内按阶段分线程，一眼能看出时间花在 act 还是 assert 上。
 *
 * `ph: 'X'` 是"完整事件"（有起止时间），也是三种 phase 里唯一自带 `dur` 的。
 */

import type { RunSummary, TraceSpan } from '../runtime/runlog.js'
import { resolveTrace } from './spans.js'

/** 阶段 → tid（顺序稳定，改顺序会让历史 trace 的图错位，别乱动）。 */
const PHASE_THREAD: Record<TraceSpan['phase'], number> = {
  case: 0,
  setup: 1,
  act: 2,
  assert: 3,
  cleanup: 4,
}

export interface ChromeTraceEvent {
  name: string
  /** 分类 = 阶段，方便按 cat 过滤。 */
  cat: string
  ph: 'X'
  ts: number
  dur: number
  pid: number
  tid: number
}

/** 渲染 Chrome Trace Event JSON（数组，2 空格缩进）。 */
export function renderChromeTrace(summary: RunSummary): string {
  const resolved = resolveTrace(summary)
  const events: ChromeTraceEvent[] = []

  resolved.cases.forEach((item, index) => {
    const pid = index + 1
    for (const span of item.spans) {
      events.push({
        name: span.name,
        cat: span.phase,
        ph: 'X',
        ts: item.startMs + span.startMs,
        dur: span.durationMs,
        pid,
        tid: PHASE_THREAD[span.phase],
      })
    }
  })

  return `${JSON.stringify(events, null, 2)}\n`
}
