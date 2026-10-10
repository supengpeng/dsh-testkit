/**
 * CLI 的上下文：目录、I/O、可选模块探测、宿主缺口描述。
 *
 * ## 一条设计纪律：CLI **不读 profile 配置**
 *
 * 插件面（`/testkit`、`testkit_*`）的配置来自 DSH 的 profile；CLI 是在**没有 DSH** 的
 * 机器上跑的（CI 容器的第一诉求就是这个），所以它只能靠：包内默认目录 + 少量显式覆盖
 * （`--out` / `--cases`）+ 两个环境变量。**刻意不支持配置文件**——
 * 一个能在 CI 上稳定复跑的 CLI，参数应当全部写在命令行里（可读、可 diff、可复制粘贴）。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import type { HostCapability } from '../cases/types.js'
import type { DriverRegistry, HostFacade } from '../kinds/types.js'
import {
  defaultCasesDir,
  defaultExportDir,
  defaultFixturesDir,
  defaultPipelineDir,
  defaultRegistryDir,
  defaultRunsDir,
  defaultTemplatesDir,
  packageRoot,
} from '../config.js'
import type { CliIo } from './io.js'

/** CLI 用到的全部目录（都解析成绝对路径）。 */
export interface CliDirs {
  packageRoot: string
  casesDir: string
  runsDir: string
  exportDir: string
  fixturesDir: string
  registryDir: string
  templatesDir: string
  pipelineDir: string
}

export interface DirOverrides {
  casesDir?: string | undefined
  runsDir?: string | undefined
  exportDir?: string | undefined
  fixturesDir?: string | undefined
  registryDir?: string | undefined
}

export interface CliContext {
  io: CliIo
  cwd: string
  dirs: CliDirs
  /** `--json`：stdout 只放机器可读 JSON。 */
  json: boolean
  env: Readonly<Record<string, string | undefined>>
}

/** 相对路径按**当前工作目录**解析（CLI 的直觉：你在哪个目录敲的，就相对哪里）。 */
function resolveFrom(cwd: string, value: string, fallback: string): string {
  const trimmed = value.trim()
  if (trimmed === '') return fallback
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
}

/** 解析目录：显式参数 > 环境变量 > 包内默认。 */
export function resolveCliDirs(
  cwd: string,
  overrides: DirOverrides = {},
  env: Readonly<Record<string, string | undefined>> = process.env,
): CliDirs {
  const casesFromEnv = env['DSH_TESTKIT_CASES_DIR'] ?? ''
  const runsFromEnv = env['DSH_TESTKIT_RUNS_DIR'] ?? ''
  const fixturesFromEnv = env['DSH_TESTKIT_FIXTURES_DIR'] ?? ''
  const registryFromEnv = env['DSH_TESTKIT_REGISTRY_DIR'] ?? ''

  return {
    packageRoot,
    casesDir: resolveFrom(cwd, overrides.casesDir ?? casesFromEnv, defaultCasesDir()),
    runsDir: resolveFrom(cwd, overrides.runsDir ?? runsFromEnv, defaultRunsDir()),
    exportDir: resolveFrom(cwd, overrides.exportDir ?? '', defaultExportDir()),
    fixturesDir: resolveFrom(cwd, overrides.fixturesDir ?? fixturesFromEnv, defaultFixturesDir()),
    registryDir: resolveFrom(cwd, overrides.registryDir ?? registryFromEnv, defaultRegistryDir()),
    templatesDir: defaultTemplatesDir(),
    pipelineDir: defaultPipelineDir(),
  }
}

/* ------------------------------------------------------- 可选模块探测 -- */

export interface OptionalCandidate {
  /**
   * 相对 `lib/cli/` 的模块说明符（**写 `.js`**：编译产物的真实文件名）。
   *
   * 这里必须是**变量**而不是字面量：字面量会被 `tsc` 当成静态依赖去解析，
   * 而并行任务还没落地的模块会让编译直接失败。变量形式留给运行期判断——
   * 这正是"先探测模块存在性"的实现手段。
   */
  specifier: string
  /** 这个模块必须导出的函数名。 */
  requires: readonly string[]
  /** 该能力由哪个任务/文档章节提供（错误信息里告诉用户"这不是你的用法问题"）。 */
  provider: string
}

export interface OptionalProbe {
  ok: boolean
  module?: Record<string, unknown>
  specifier?: string
  /** 所有候选都**不存在**（能力尚未落地）。 */
  absent: boolean
  /** 候选存在但加载失败 / 缺导出（是真的坏了，不是没做）。 */
  broken: boolean
  problems: string[]
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : undefined
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return `非 Error 抛出：${String(error)}`
}

/**
 * 依次尝试候选说明符，返回第一个**导出齐备**的模块。
 *
 * 关键区分（决定了错误信息的诚实度）：
 *   · `absent` —— 所有候选都是 `ERR_MODULE_NOT_FOUND`：该能力还没落地；
 *   · `broken` —— 某个候选文件存在，但加载抛了别的错、或缺必需导出：
 *     这是**真的坏了**，不能伪装成"还没做"。
 */
export async function probeOptional(
  candidates: readonly OptionalCandidate[],
): Promise<OptionalProbe> {
  const problems: string[] = []
  let sawExisting = false

  for (const candidate of candidates) {
    let raw: unknown
    try {
      // 变量说明符：见 OptionalCandidate.specifier 的注释（必须绕开静态解析）。
      const specifier: string = candidate.specifier
      raw = await import(specifier)
    } catch (error) {
      const code = errorCode(error)
      if (code !== 'ERR_MODULE_NOT_FOUND') sawExisting = true
      problems.push(`${candidate.specifier}：${describeError(error)}`)
      continue
    }

    sawExisting = true
    const module = raw as Record<string, unknown>
    const lacking = candidate.requires.filter((name) => typeof module[name] !== 'function')
    if (lacking.length > 0) {
      problems.push(
        `${candidate.specifier} 缺少导出：${lacking.join(', ')}（该模块存在但形状不符——不是"还没做"）`,
      )
      continue
    }
    return { ok: true, module, specifier: candidate.specifier, absent: false, broken: false, problems: [] }
  }

  return {
    ok: false,
    absent: !sawExisting,
    broken: sawExisting,
    problems,
  }
}

/** 「能力还没落地」时的统一措辞（CLI 与测试都按这段文本断言）。 */
export function notReadyMessage(command: string, candidates: readonly OptionalCandidate[]): string {
  const provider = candidates[0]?.provider ?? '并行任务'
  const paths = candidates.map((c) => c.specifier.replace(/^\.\.\//, 'src/').replace(/\.js$/, '.ts'))
  return [
    `子命令 \`${command}\` 尚未就绪：找不到模块 ${paths.join(' / ')}。`,
    `这不是你的用法问题——该能力由 ${provider} 并行交付，落地后本子命令自动可用。`,
    '（本命令不伪造结果：宁可明确报"没做"，也不输出一张看起来像样的空表。）',
  ].join('\n')
}

/* ---------------------------------------------------------- 宿主缺口 -- */

export interface HostGap {
  /** 宿主实际具备的能力（排序后）。 */
  provided: string[]
  /** 缺口：能力 → 需要它、因而会被跳过的 kind。 */
  missing: { capability: string; kinds: string[] }[]
}

/**
 * 从**注册表**推导"这台宿主缺什么、会影响哪些 kind"。
 *
 * 为什么不硬编码一个"headless 缺 subprocess/fs/sessions"的清单：
 * 那种清单会随 driver 的 `requires` 变化而悄悄过期，而**过期的方式是静默的**——
 * 输出里少列一个缺口，用户就会以为"它应该能跑"。从 `driver.requires` 推导，
 * 加一个 driver 就自动出现在这里。
 */
export function describeHostGap(host: HostFacade, drivers: DriverRegistry): HostGap {
  const needed = new Map<string, string[]>()
  for (const driver of drivers.list()) {
    for (const capability of driver.requires ?? []) {
      const kinds = needed.get(capability) ?? []
      kinds.push(driver.kind)
      needed.set(capability, kinds)
    }
  }

  const provided: string[] = []
  const missing: { capability: string; kinds: string[] }[] = []
  for (const capability of [...host.capabilities].sort()) provided.push(capability)
  for (const [capability, kinds] of [...needed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (host.capabilities.has(capability as HostCapability)) continue
    missing.push({ capability, kinds: [...new Set(kinds)].sort() })
  }
  return { provided, missing }
}

/* ------------------------------------------------------------- 版本 -- */

let cachedVersion: string | undefined

/** 读 `package.json` 的版本（进程内缓存一次）。 */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/** 读 `package.json` 的包名（version 命令与 JSON 输出用）。 */
export function packageName(): string {
  try {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { name?: unknown }
    return typeof parsed.name === 'string' ? parsed.name : 'dsh-testkit'
  } catch {
    return 'dsh-testkit'
  }
}
