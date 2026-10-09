/**
 * 插件配置。
 *
 * 沿用 DSH 插件惯例：同名 `interface`（类型空间）+ `const Config`（值空间，
 * schemastery schema，供 GUI 生成配置表单）。
 */

import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'

import z from '@deepseek-ai/schemastery'

/** 本插件包根（`lib/` 的上一级）。 */
export const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * 外部 fixture 的根目录（`<包根>/.fixtures`，git 忽略）。
 *
 * 放这里的是**下载来的被测对象**（例如某个 npm 包的 tgz 解开后的目录），
 * 不适合进仓库，但场景需要一个稳定的引用方式。
 * 场景里用 `$FIXTURES/<name>` 引用它；缺失时 driver 会**跳过并说明**，
 * 而不是让场景假装通过。
 */
export const fixturesRoot = join(packageRoot, '.fixtures')

export interface Config {
  /** 场景数据目录；留空 = 包内 `cases/`。 */
  casesDir: string
  /** 运行产物目录；留空 = 包内 `runs/`。 */
  runsDir: string
  /** CI 用例导出目录；留空 = 包内 `export/`。 */
  exportDir: string
  /** 插件激活时是否立即加载场景。 */
  autoload: boolean
  /** 是否监听 casesDir 变化并热重载（Phase 1）。 */
  watch: boolean
  /** 是否向模型暴露 `testkit_*` 工具。 */
  exposeTools: boolean
  /** 是否注册 `/testkit` 人类命令。 */
  exposeCommands: boolean
  /** 默认单 case 超时（毫秒）。 */
  defaultTimeoutMs: number
  /** 列表类输出里最多回显多少条 invalid 明细。 */
  maxInvalidReported: number
  /**
   * 报告里记录的 DSH 版本。
   *
   * 留空时按 `DSH_VERSION` 环境变量取值，都拿不到就记 `unknown`。
   * 为什么不自动读：插件被符号链接装在 profile 的 `node_modules` 下，
   * 而 DSH 自身的包在宿主安装目录（asar）里，**不在插件的解析路径上**，
   * 因此插件内部解析不到宿主版本。需要精确值时在 profile patch 里显式写。
   */
  dshVersion: string
}

export const Config: z<Config> = z.object({
  casesDir: z.string().default(''),
  runsDir: z.string().default(''),
  exportDir: z.string().default(''),
  autoload: z.boolean().default(true),
  watch: z.boolean().default(true),
  exposeTools: z.boolean().default(true),
  exposeCommands: z.boolean().default(true),
  defaultTimeoutMs: z.number().default(30_000),
  maxInvalidReported: z.number().default(20),
  dshVersion: z.string().default(''),
})

/** 包内默认目录。 */
export function defaultCasesDir(): string {
  return join(packageRoot, 'cases')
}
export function defaultRunsDir(): string {
  return join(packageRoot, 'runs')
}
export function defaultExportDir(): string {
  return join(packageRoot, 'export')
}

/** 解析配置里的目录：相对路径按包根解析，空值走默认。 */
export function resolveDir(configured: string, fallback: string): string {
  const trimmed = configured.trim()
  if (trimmed === '') return fallback
  return isAbsolute(trimmed) ? trimmed : resolve(packageRoot, trimmed)
}

/** 应用默认值后的有效配置。 */
export interface ResolvedConfig extends Config {
  casesDirAbs: string
  runsDirAbs: string
  exportDirAbs: string
}

export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...config,
    casesDirAbs: resolveDir(config.casesDir, defaultCasesDir()),
    runsDirAbs: resolveDir(config.runsDir, defaultRunsDir()),
    exportDirAbs: resolveDir(config.exportDir, defaultExportDir()),
  }
}
