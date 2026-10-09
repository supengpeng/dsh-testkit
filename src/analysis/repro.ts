/**
 * 最小复现指引的生成。
 *
 * 纪律：**只写本仓真的能执行的命令**。没有的东西不写——
 * 编一条 `dsh-testkit run TK-0100 --step invoke/tool` 看着更漂亮，
 * 但它在这个仓里跑不起来（本包没有 `bin`），会让读者照着敲一遍然后怀疑人生。
 *
 * 本仓现有的两条真通道：
 *   ① 活宿主：`testkit_run` 工具（或 `/testkit run <id>`）
 *   ② CI 轨：`scripts/export-scenarios.mjs` 导出 → `node --test` 按用例名筛
 */

import type { Scenario } from '../cases/types.js'
export interface MinimalReproInput {
  /** 场景 ID，如 `TK-0100`。 */
  caseId: string
  /** 第一条失败步骤的下标（从 0 起）；省略则只给整条场景的复现。 */
  failingStepIndex?: number
  /** 该步骤的名字，用于在指引里点出"看哪一步"。 */
  failingStepName?: string
}

/** 生成多行最小复现指引（报告里以代码块展示）。 */
export function buildMinimalRepro(input: MinimalReproInput): string {
  const { caseId } = input
  const lines: string[] = []
  lines.push(`# 活宿主（单跑这一条）`)
  lines.push(`testkit_run { "ids": ["${caseId}"] }    # 或 /testkit run ${caseId}`)
  lines.push(`# CI 轨（同样的场景数据，脱离活宿主）`)
  lines.push(`node scripts/export-scenarios.mjs && node --test export/scenarios.test.mjs --test-name-pattern ${caseId}`)
  if (input.failingStepIndex !== undefined) {
    const ordinal = input.failingStepIndex + 1
    const name = input.failingStepName ? `「${input.failingStepName}」` : ''
    lines.push(`# 失败步骤：第 ${ordinal} 步${name}（报告的「需要关注」段有它的期望 / 实际）`)
  }
  return lines.join('\n')
}

/**
 * 从场景 + 失败步骤下标生成指引（runner 的调用入口）。
 *
 * `failingStepIndex` 由 runner 在合并多轮断言后给出；没有失败步骤时不写那行。
 */
export function buildMinimalReproForScenario(
  scenario: Scenario,
  failingStepIndex?: number,
): string {
  const step = failingStepIndex === undefined ? undefined : scenario.steps[failingStepIndex]
  return buildMinimalRepro({
    caseId: scenario.id,
    ...(failingStepIndex === undefined ? {} : { failingStepIndex }),
    ...(step?.name === undefined ? {} : { failingStepName: step.name }),
  })
}
