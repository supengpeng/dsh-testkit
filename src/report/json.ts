/**
 * 运行产物的落地：JSON 报告 + Markdown 报告 + JUnit XML，写入 `runs/<RUN-ID>/`。
 *
 * 三份产物覆盖三类读者：`run.json` 机器看、`report.md` 人看、`junit.xml` CI 看。
 * 三者同源（同一份 `RunSummary`），所以这里只负责"写盘"，不做任何渲染决策。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RunSummary } from '../runtime/runlog.js'
import { renderTraceJson } from '../trace/index.js'
import { renderJUnit } from './junit.js'
import { renderMarkdown } from './markdown.js'
import { redactSummary, type RedactionFinding } from './redact.js'

export interface RunArtifacts {
  dir: string
  jsonPath: string
  markdownPath: string
  /** `junit.xml` 路径；这一份写失败时为 undefined（见 `writeRunArtifacts` 的 `junitError`）。 */
  junitPath?: string
  /**
   * `trace.json` 路径；这一份写失败时为 undefined（与 junit 同样隔离）。
   *
   * 只在**这次运行真的记了 trace** 时才写——空 trace 文件比没有文件更误导。
   */
  tracePath?: string
}

/** `writeRunArtifacts` 的选项。 */
export interface WriteArtifactsOptions {
  /**
   * 是否脱敏（`--redact`）。
   *
   * 默认 **false**：脱敏会改写取证原文，不该在没人要求时悄悄发生。
   * 打开时三份产物（json/md/junit）都渲染**同一份已脱敏的** summary——
   * 三面同源在这里也不能破。
   */
  redact?: boolean
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
  options: WriteArtifactsOptions = {},
): Promise<{
  artifacts?: RunArtifacts
  error?: string
  junitError?: string
  traceError?: string
  /** 脱敏命中（只含路径与类型，不含原文）。 */
  redaction?: { count: number; findings: RedactionFinding[] }
}> {
  const dir = join(runsDir, summary.runId)
  try {
    await mkdir(dir, { recursive: true })

    const redacted = options.redact === true ? redactSummary(summary) : undefined
    const effective = redacted === undefined ? summary : redacted.summary

    const jsonPath = join(dir, 'run.json')
    const markdownPath = join(dir, 'report.md')
    const junitPath = join(dir, 'junit.xml')
    const tracePath = join(dir, 'trace.json')
    await writeFile(jsonPath, renderJson(effective), 'utf8')
    await writeFile(markdownPath, renderMarkdown(effective), 'utf8')

    let writtenJUnit: string | undefined
    let junitError: string | undefined
    try {
      await writeFile(junitPath, renderJUnit(effective), 'utf8')
      writtenJUnit = junitPath
    } catch (error) {
      junitError = error instanceof Error ? error.message : String(error)
    }

    // trace.json 只在**这次运行真的记了 trace** 时才写。
    // 给没记 trace 的运行也写一份"重建"文件，会让读者分不清
    // "这是实测偏移"还是"这是从步骤时长反推的近似"——那比没有文件更误导。
    let writtenTrace: string | undefined
    let traceError: string | undefined
    if (effective.cases.some((item) => (item.trace?.length ?? 0) > 0)) {
      try {
        await writeFile(tracePath, renderTraceJson(effective), 'utf8')
        writtenTrace = tracePath
      } catch (error) {
        traceError = error instanceof Error ? error.message : String(error)
      }
    }

    const findings = redacted === undefined ? [] : redacted.findings

    return {
      artifacts: {
        dir,
        jsonPath,
        markdownPath,
        ...(writtenJUnit === undefined ? {} : { junitPath: writtenJUnit }),
        ...(writtenTrace === undefined ? {} : { tracePath: writtenTrace }),
      },
      ...(junitError === undefined ? {} : { junitError }),
      ...(traceError === undefined ? {} : { traceError }),
      ...(findings.length === 0 ? {} : { redaction: { count: findings.length, findings } }),
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export { renderJUnit, renderMarkdown, renderTraceJson }

