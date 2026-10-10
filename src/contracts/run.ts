/**
 * 契约运行器（文档 §5.4）。
 *
 * 职责只有三件事：
 *   ① 按契约跑一遍，**逐条隔离**——一条红不该掩盖后面几条的结果；
 *   ② 失败时给出**点名错误**：契约名 + 用例名 + 原始错误（三者缺一不可，
 *      否则 CI 日志里只剩一句 `AssertionError`，定位成本立刻回到人工 grep）；
 *   ③ 返回**结构化结果**，便于单测断言与报告复用。
 *
 * 它不依赖 DSH、不依赖 cordis，也不写盘：契约文件自己 import 被测面，
 * 运行器只负责"跑、汇总、点名"。
 */

import type { Contract, ContractCase } from './types.js'

/** 单条用例的结果。 */
export interface ContractCaseResult {
  name: string
  ok: boolean
  durationMs: number
  /** 失败时的原始错误文本（`name: message`；非 Error 抛出也会被物化）。 */
  error?: string
}

/** 一个契约跑完的结果。 */
export interface ContractResult {
  adapter: string
  version: string
  ok: boolean
  total: number
  passed: number
  failed: number
  cases: ContractCaseResult[]
  /** 逐条"点名"失败行，形如 `adapter › 用例名：AssertionError: ...`。 */
  failures: string[]
}

/** 契约本身形状不合法（不是"被测面违约"，而是"契约文件写坏了"）。 */
export class ContractShapeError extends Error {
  readonly problems: readonly string[]

  constructor(adapter: string, problems: readonly string[]) {
    super(`契约形状非法（${adapter === '' ? '<未命名>' : adapter}）：${problems.join('；')}`)
    this.name = 'ContractShapeError'
    this.problems = problems
  }
}

/** 有契约用例失败时由 `assertContractsPass` 抛出，携带完整结构化结果。 */
export class ContractFailureError extends Error {
  readonly results: readonly ContractResult[]

  constructor(results: readonly ContractResult[]) {
    super(formatContractResults(results))
    this.name = 'ContractFailureError'
    this.results = results
  }
}

/** 把任意抛出物描述成一条可读文本；**绝不吞掉原始信息**。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return `非 Error 抛出：${String(error)}`
}

/**
 * 失败点名格式。
 *
 * 单独导出是为了让测试能断言"运行器确实按这个格式点名"，
 * 而不是只看得到一句汇总。
 */
export function formatCaseFailure(adapter: string, caseName: string, error: unknown): string {
  return `${adapter} › ${caseName}：${describeError(error)}`
}

/**
 * 检查契约形状（纯函数，不跑用例）。
 *
 * 返回问题清单；空数组 = 合法。之所以把"契约写坏了"和"被测面违约"分开：
 * 前者是测试代码 bug，应该在跑之前就炸，而不是伪装成一条产品失败。
 */
export function validateContract(contract: unknown): string[] {
  const problems: string[] = []
  if (contract === null || typeof contract !== 'object') {
    return ['契约必须是对象']
  }
  const candidate = contract as Partial<Contract>
  if (typeof candidate.version !== 'string' || candidate.version.trim() === '') {
    problems.push('version 必须是非空字符串')
  }
  if (typeof candidate.adapter !== 'string' || candidate.adapter.trim() === '') {
    problems.push('adapter 必须是非空字符串')
  }
  if (!Array.isArray(candidate.tests)) {
    problems.push('tests 必须是数组')
    return problems
  }
  if (candidate.tests.length === 0) {
    problems.push('tests 不能为空（空契约等于没测）')
  }
  const seen = new Set<string>()
  candidate.tests.forEach((test, index) => {
    const where = `tests[${index}]`
    if (test === null || typeof test !== 'object') {
      problems.push(`${where} 必须是对象`)
      return
    }
    const entry = test as Partial<ContractCase>
    if (typeof entry.name !== 'string' || entry.name.trim() === '') {
      problems.push(`${where}.name 必须是非空字符串`)
    } else if (seen.has(entry.name)) {
      problems.push(`${where}.name 重复：${entry.name}（报告靠用例名点名，必须唯一）`)
    } else {
      seen.add(entry.name)
    }
    if (typeof entry.run !== 'function') {
      problems.push(`${where}.run 必须是函数`)
    }
  })
  return problems
}

/**
 * 跑一个契约。
 *
 * 形状非法 → 抛 `ContractShapeError`（测试代码的问题，越早炸越好）；
 * 用例失败 → **不抛**，写进返回结果，让调用方决定怎么呈现。
 */
export async function runContract(contract: Contract): Promise<ContractResult> {
  const problems = validateContract(contract)
  if (problems.length > 0) {
    throw new ContractShapeError(
      typeof (contract as { adapter?: unknown } | null)?.adapter === 'string'
        ? String((contract as { adapter: string }).adapter)
        : '',
      problems,
    )
  }

  const cases: ContractCaseResult[] = []
  for (const entry of contract.tests) {
    const startedAt = Date.now()
    try {
      await entry.run()
      cases.push({ name: entry.name, ok: true, durationMs: Date.now() - startedAt })
    } catch (error) {
      cases.push({
        name: entry.name,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: describeError(error),
      })
    }
  }

  const failures = cases
    .filter((entry) => !entry.ok)
    .map((entry) => `${contract.adapter} › ${entry.name}：${entry.error ?? '未知错误'}`)
  const failed = failures.length
  return {
    adapter: contract.adapter,
    version: contract.version,
    ok: failed === 0,
    total: cases.length,
    passed: cases.length - failed,
    failed,
    cases,
    failures,
  }
}

/** 按顺序跑多个契约（串行：契约之间共享宿主资源时避免互相干扰）。 */
export async function runContracts(
  contracts: readonly Contract[],
): Promise<ContractResult[]> {
  const results: ContractResult[] = []
  for (const contract of contracts) {
    results.push(await runContract(contract))
  }
  return results
}

/**
 * 汇总文本：每个契约一行计数，失败逐条点名，最后一行总计。
 *
 * 失败时这段文本就是 `ContractFailureError.message`，直接进 CI 日志。
 */
export function formatContractResults(results: readonly ContractResult[]): string {
  const lines: string[] = []
  for (const result of results) {
    const head = `契约 ${result.adapter}@${result.version}：${result.passed}/${result.total} 通过`
    lines.push(result.ok ? head : `${head}，${result.failed} 失败`)
    for (const failure of result.failures) lines.push(`  ✗ ${failure}`)
  }
  const total = results.reduce((sum, result) => sum + result.total, 0)
  const passed = results.reduce((sum, result) => sum + result.passed, 0)
  const failed = results.reduce((sum, result) => sum + result.failed, 0)
  lines.push(`合计：${results.length} 个契约｜${total} 用例｜${passed} 通过｜${failed} 失败`)
  return lines.join('\n')
}

/**
 * 一站式断言：跑完，任一契约红就抛 `ContractFailureError`（message 即点名汇总）。
 *
 * 返回结构化结果，方便调用方在绿的时候继续断言计数。
 */
export async function assertContractsPass(
  contracts: readonly Contract[],
): Promise<ContractResult[]> {
  const results = await runContracts(contracts)
  if (results.some((result) => !result.ok)) {
    throw new ContractFailureError(results)
  }
  return results
}
