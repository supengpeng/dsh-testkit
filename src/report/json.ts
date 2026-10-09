/**
 * 运行产物的落地：JSON 报告 + Markdown 报告 + JUnit XML，写入 `runs/<RUN-ID>/`。
 *
 * 三份产物覆盖三类读者：`run.json` 机器看、`report.md` 人看、`junit.xml` CI 看。
 * 三者同源（同一份 `RunSummary`），所以这里只负责"写盘"，不做任何渲染决策。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RunSummary } from '../runtime/runlog.js'
import { renderJUnit } from './junit.js'
import { renderMarkdown } from './markdown.js'

export interface RunArtifacts {
  dir: string
  jsonPath: string
  markdownPath: string
  /** `junit.xml` 路径；这一份写失败时为 undefined（见 `writeRunArtifacts` 的 `junitError`）。 */
  junitPath?: string
}

/** 序列化整份运行记录（稳定缩进，便于 diff）。 */
export function renderJson(summary: RunSummary): string {
  return `${JSON.stringify(summary, null, 2)}\n`
}

/**
 * 把一次运行写入 `runsDir/<runId>/`。
 *
 * 写入失败**不抛出**（报告失败不该让一次已经跑完的测试变成失败），
 * 而是把错误通过返回值告知调用方。
 *
 * `run.json` / `report.md` 与 `junit.xml` 分成两层 try：
 * CI 面（junit）单独失败时，不把已经写好的另外两份一起作废——
 * 报告三份是并列产物，不是一份的中间状态。
 */
export async function writeRunArtifacts(
  summary: RunSummary,
  runsDir: string,
): Promise<{ artifacts?: RunArtifacts; error?: string; junitError?: string }> {
  const dir = join(runsDir, summary.runId)
  try {
    await mkdir(dir, { recursive: true })
    const jsonPath = join(dir, 'run.json')
    const markdownPath = join(dir, 'report.md')
    const junitPath = join(dir, 'junit.xml')
    await writeFile(jsonPath, renderJson(summary), 'utf8')
    await writeFile(markdownPath, renderMarkdown(summary), 'utf8')

    let writtenJUnit: string | undefined
    let junitError: string | undefined
    try {
      await writeFile(junitPath, renderJUnit(summary), 'utf8')
      writtenJUnit = junitPath
    } catch (error) {
      junitError = error instanceof Error ? error.message : String(error)
    }

    return {
      artifacts: {
        dir,
        jsonPath,
        markdownPath,
        ...(writtenJUnit === undefined ? {} : { junitPath: writtenJUnit }),
      },
      ...(junitError === undefined ? {} : { junitError }),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export { renderJUnit, renderMarkdown }
