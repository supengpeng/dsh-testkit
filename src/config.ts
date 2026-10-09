/**
 * 插件配置。
 *
 * 沿用 DSH 插件惯例：同名 `interface`（类型空间）+ `const Config`（值空间，
 * schemastery schema，供 GUI 生成配置表单）。
 */

import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'

import z from '@deepseek-ai/schemastery'

import type { PolicyOptions } from './executor/policy.js'

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
  /**
   * 提炼闸门目录；留空 = 包内 `pipeline/`。
   *
   * 这里放批次台账（`ledger.json`）与提案（`proposals/`）。
   * 与 `casesDir` 分开是刻意的：**提案不是场景**，只有批准落地后
   * 才会变成 `cases/TK-XXXX.yaml`。
   */
  pipelineDir: string
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

  /* ---------------------------------------------------------- 成本闸门 -- */

  /**
   * 是否允许 `high` 档位（真实模型调用）。
   *
   * **默认 `false` 就是文档 P0「不把真实模型调用塞进 CI」的落点**：
   * 配置缺省时，工具面与 bridge 构造出的策略一律不允许调模型，
   * agent / compaction 这类场景会被判 `skipped` 并写清原因，而不是悄悄花钱。
   * 需要时由人显式打开（配置项，或 `/testkit run --allow-model`）。
   */
  allowModel: boolean
  /**
   * 是否允许 `low` 档位（起进程 / 写文件，无模型成本）。
   *
   * 默认 `true`：本仓既有 shell / fs 场景要写目录，默认收紧会让基线平白出现 skipped，
   * 把真正的失败淹在噪音里。要跑"只读模式"请显式关掉它（连同下面的 sandbox* 开关）。
   */
  allowLowCost: boolean
  /** 沙箱：是否允许 shell 动作；默认 `true`（见 `allowLowCost` 的同类取舍）。 */
  sandboxAllowShell: boolean
  /** 沙箱：是否允许文件写入（`fs` 的 write / edit）；默认 `true`。 */
  sandboxAllowFileWrite: boolean
  /** 沙箱：被拒的命令名（"默认只读"的实现手段之一）。空 = 不拒。 */
  sandboxDenyWriteCommands: string[]
  /** 单次运行的真实模型调用次数上限；`0` = 不限。 */
  maxModelCalls: number
  /** 单次运行的 token 上限；`0` = 不限（只有 driver 上报 token 时才真正强制）。 */
  maxTokens: number
}

export const Config: z<Config> = z.object({
  casesDir: z.string().default(''),
  runsDir: z.string().default(''),
  exportDir: z.string().default(''),
  pipelineDir: z.string().default(''),
  autoload: z.boolean().default(true),
  watch: z.boolean().default(true),
  exposeTools: z.boolean().default(true),
  exposeCommands: z.boolean().default(true),
  defaultTimeoutMs: z.number().default(30_000),
  maxInvalidReported: z.number().default(20),
  dshVersion: z.string().default(''),
  // 成本闸门默认值：与 src/executor/policy.ts 的 DEFAULT_POLICY 保持一致
  // （allowModel=false 是 P0「不把真实模型调用塞进 CI」的落点，理由见 config.ts 的字段注释）
  allowModel: z.boolean().default(false),
  allowLowCost: z.boolean().default(true),
  sandboxAllowShell: z.boolean().default(true),
  sandboxAllowFileWrite: z.boolean().default(true),
  sandboxDenyWriteCommands: z.array(z.string()).default([]),
  maxModelCalls: z.number().default(0),
  maxTokens: z.number().default(0),
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
export function defaultPipelineDir(): string {
  return join(packageRoot, 'pipeline')
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
  pipelineDirAbs: string
}

export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...config,
    casesDirAbs: resolveDir(config.casesDir, defaultCasesDir()),
    runsDirAbs: resolveDir(config.runsDir, defaultRunsDir()),
    exportDirAbs: resolveDir(config.exportDir, defaultExportDir()),
    pipelineDirAbs: resolveDir(config.pipelineDir, defaultPipelineDir()),
  }
}

/**
 * 从插件配置导出成本闸门的默认值。
 *
 * 为什么放在这里：工具面（`testkit_run`）、命令面（`/testkit run`）、client bridge
 * 三条入口都要用**同一份**默认策略。让三处各拼一遍 `PolicyOptions` 迟早漂移
 * （改一处忘一处），而漂移的表现是"某条通道悄悄允许了真实模型调用"，最难察觉。
 *
 * 入口的权限关系（写在类型旁边，免得后来者搞反）：
 *   · 这里是**默认值**，不是天花板；
 *   · 工具面（模型可调）只能在此基础上**收紧**，不能提权（见 `src/tools.ts`）；
 *   · 命令面（人类发起）可以用 `--allow-model` / `--allow-low-cost` 显式放权。
 */
export function policyDefaultsFromConfig(config: Config): PolicyOptions {
  return {
    cost: {
      allowModel: config.allowModel,
      allowLowCost: config.allowLowCost,
      maxModelCalls: config.maxModelCalls,
      maxTokens: config.maxTokens,
    },
    sandbox: {
      allowShell: config.sandboxAllowShell,
      allowFileWrite: config.sandboxAllowFileWrite,
      denyWriteCommands: [...config.sandboxDenyWriteCommands],
    },
  }
}
