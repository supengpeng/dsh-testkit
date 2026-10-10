/**
 * 运行产物定位（工具面与命令面共用）。
 *
 * 为什么单独一层：`testkit_export --format touchstone` 与 `/testkit export --format touchstone`
 * 都要"找最近一次运行的 run.json"，两处各写一遍就会在"按目录名排序还是按 mtime 排序"
 * 这类细节上漂移（而排序口径直接决定导出的到底是哪一次运行）。
 */

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export interface LatestRunResult {
  ok: boolean
  /** `runs/<id>/run.json` 的绝对路径。 */
  path?: string
  /** 运行 ID。 */
  runId?: string
  /** 失败原因（目录不存在 / 一个运行都没有）。 */
  reason?: string
}

/**
 * 找最近一次运行的 `run.json`。
 *
 * 排序口径：**目录名降序**（`makeRunId` 把时间戳放在最前面，所以字典序等于时间序，
 * 且不依赖文件系统 mtime——复制 / 解压会改 mtime，改不了目录名）。
 */
export function latestRunJson(runsDir: string, runId?: string): LatestRunResult {
  const wanted = runId?.trim()
  if (wanted !== undefined && wanted !== '') {
    return { ok: true, path: join(runsDir, wanted, 'run.json'), runId: wanted }
  }

  let entries: string[]
  try {
    entries = readdirSync(runsDir).filter((name) => {
      try {
        return statSync(join(runsDir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return { ok: false, reason: `运行产物目录不存在或不可读：${runsDir}` }
  }

  const sorted = entries.sort()
  const latest = sorted[sorted.length - 1]
  if (latest === undefined) return { ok: false, reason: `还没有任何运行记录（${runsDir}）` }
  return { ok: true, path: join(runsDir, latest, 'run.json'), runId: latest }
}
