/**
 * 导出落盘（有副作用的半边）。
 *
 * `node-test.ts` 的生成器刻意保持**纯函数**（只产字符串），
 * 因为"生成物长什么样"要能被单测穷举。写文件这半边放在这里，
 * 让工具面（`testkit_export`）与命令面（`/testkit export`）共用同一份实现
 * ——否则两条入口迟早会漂移。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Scenario } from '../cases/types.js'
import { generateNodeTestFile, toLibSpecifier } from './node-test.js'

export interface ExportToFileRequest {
  scenarios: readonly Scenario[]
  /** 场景目录（写进生成文件的绝对路径）。 */
  casesDir: string
  /** 导出目录。 */
  outDir: string
  /** 本包 lib 目录（用于推导 import 说明符）。 */
  libDir: string
  timeoutMs?: number
  generatedAt?: string
  /** 文件名，缺省 `scenarios.test.mjs`。 */
  fileName?: string
}

export interface ExportToFileResult {
  file: string
  count: number
}

/** 把场景导出成一个自包含的 `node:test` 文件。 */
export async function exportScenariosToFile(
  request: ExportToFileRequest,
): Promise<ExportToFileResult> {
  await mkdir(request.outDir, { recursive: true })

  const content = generateNodeTestFile(request.scenarios, {
    casesDir: request.casesDir,
    libSpecifier: toLibSpecifier(request.outDir, request.libDir),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
  })

  const file = join(request.outDir, request.fileName ?? 'scenarios.test.mjs')
  await writeFile(file, content, 'utf8')
  return { file, count: request.scenarios.length }
}
