/**
 * 运行产物的落地：JSON 报告 + Markdown 报告，写入 `runs/<RUN-ID>/`。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RunSummary } from '../runtime/runlog.js'
import { renderMarkdown } from './markdown.js'

export interface RunArtifacts {
  dir: string
  jsonPath: string
  markdownPath: string
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
 */
export async function writeRunArtifacts(
  summary: RunSummary,
  runsDir: string,
): Promise<{ artifacts?: RunArtifacts; error?: string }> {
  const dir = join(runsDir, summary.runId)
  try {
    await mkdir(dir, { recursive: true })
    const jsonPath = join(dir, 'run.json')
    const markdownPath = join(dir, 'report.md')
    await writeFile(jsonPath, renderJson(summary), 'utf8')
    await writeFile(markdownPath, renderMarkdown(summary), 'utf8')
    return { artifacts: { dir, jsonPath, markdownPath } }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export { renderMarkdown }
