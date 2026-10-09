/**
 * dsh-testkit —— DeepSeek Harness 测试插件（host 半入口）
 *
 * 职责：把 `cases/*.yaml` 里的声明式测试场景装载进来，暴露成
 * 工具（`testkit_*`）与人类命令（`/testkit`），并可驱动执行引擎出报告。
 *
 * 架构见 docs/ARCHITECTURE.md。
 * 依赖纪律：只把 `tools` 声明为硬依赖，其余能力运行时探测（缺则降级告警）。
 */

import { appendFileSync, mkdirSync, watch as fsWatch } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'

import { CaseRegistry } from './cases/registry.js'
import { defineTestkitCommands } from './commands.js'
import { policyDefaultsFromConfig, resolveConfig, type Config as ConfigShape } from './config.js'
import { createHostFacade } from './host-facade.js'
import { BRIDGE_PREFIX, makeBridgeRoutes, type WebRouteLike } from './http.js'
import { createDriverRegistry } from './kinds/index.js'
import { PipelineStore } from './pipeline/index.js'
import { defineTestkitTools } from './tools.js'

export const name = 'dsh-testkit'

/** 硬依赖：只有 tools 是必须的，保证最小宿主也能激活。 */
export const inject = ['tools']

// 配置 schema（值 + 类型同名导出，DSH loader 取值空间做表单与校验）
export { Config } from './config.js'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'
type Log = (level: LogLevel, message: string) => void

/**
 * 调试探针：把 apply 失败写到 DSH 日志系统之外。
 *
 * 起因（沿用 dsh-memory 的经验）：`apply` 抛错会让插件"静默不激活"，
 * 表现为工具凭空消失，是最难定位的失效形态。探针独立落盘可快速自证。
 */
const APPLY_ERROR_LOG = join(homedir(), '.dsh', 'logs', 'dsh-testkit-apply-error.log')
let applyLogDirReady = false

/**
 * bridge 路由注册的诊断探针。
 *
 * 为什么需要它：`/api/dsh-testkit/*` 曾出现"host 半明明激活了（工具可用）、
 * 但路由 404"的现象，而 DSH 的 logger 在那个时机拿不到输出。
 * 探针把关键事实直接写盘，不依赖日志系统。
 */
const BRIDGE_PROBE_LOG = join(homedir(), '.dsh', 'logs', 'dsh-testkit-bridge.log')

function probeBridge(message: string): void {
  try {
    mkdirSync(dirname(BRIDGE_PROBE_LOG), { recursive: true })
    appendFileSync(BRIDGE_PROBE_LOG, `[${new Date().toISOString()}] ${message}\n`)
  } catch {
    /* 探针失败忽略 */
  }
}

function probeApplyError(error: unknown): void {
  try {
    if (!applyLogDirReady) {
      mkdirSync(dirname(APPLY_ERROR_LOG), { recursive: true })
      applyLogDirReady = true
    }
    const stack = error instanceof Error ? (error.stack ?? '') : ''
    appendFileSync(
      APPLY_ERROR_LOG,
      `[${new Date().toISOString()}] apply failed: ${String(error)}\n${stack}\n`,
    )
  } catch {
    /* 探针自身失败不影响主流程 */
  }
}

export function apply(ctx: Context, config: ConfigShape): void {
  try {
    applyInner(ctx, config)
  } catch (error) {
    probeApplyError(error)
    throw error
  }
}

function applyInner(ctx: Context, config: ConfigShape): void {
  const resolved = resolveConfig(config)
  const log = createLogger(ctx)
  const host = createHostFacade({ ctx, dshVersion: detectDshVersion(resolved), log })
  const registry = new CaseRegistry(resolved.casesDirAbs)
  const drivers = createDriverRegistry()
  // 提炼闸门：台账与提案住在 pipelineDirAbs，只有命令面能批准落地进 casesDirAbs
  const pipeline = new PipelineStore({
    pipelineDir: resolved.pipelineDirAbs,
    casesDir: resolved.casesDirAbs,
  })

  const reload = (): string => {
    const result = registry.reload()
    const lines = [
      `已重载：可用 ${result.scenarios.length} 条，无法解析 ${result.invalid.length} 条`,
    ]
    for (const bad of result.invalid.slice(0, 5)) {
      lines.push(`  ${bad.name}：${bad.error ?? bad.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`)
    }
    log('info', lines[0]!)
    return lines.join('\n')
  }

  if (resolved.autoload) {
    const result = registry.reload()
    log(
      'info',
      `场景已加载：可用 ${result.scenarios.length} 条，无效 ${result.invalid.length} 条（${resolved.casesDirAbs}）`,
    )
    for (const issue of result.indexIssues) log('warn', `索引：${issue.message}`)
    for (const bad of result.invalid) {
      log(
        'warn',
        `无效场景 ${bad.name}：${bad.error ?? bad.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      )
    }
  }

  log('debug', `可用能力：${[...host.capabilities].join(', ') || '（无）'}`)

  // ---- 工具面 ----
  if (resolved.exposeTools) {
    if (!host.capabilities.has('tools')) {
      log('error', '宿主不具备 tools 能力，testkit_* 工具未注册')
    } else {
      const tools = defineTestkitTools({
        registry,
        drivers,
        host,
        runsDir: () => resolved.runsDirAbs,
        exportDir: () => resolved.exportDirAbs,
        defaultTimeoutMs: () => resolved.defaultTimeoutMs,
        maxInvalidReported: () => resolved.maxInvalidReported,
        pipeline,
        // 成本闸门默认值（allowModel 默认 false）；工具面只能在此基础上收紧
        policyDefaults: () => policyDefaultsFromConfig(resolved),
      })
      for (const tool of tools) {
        installEffect(ctx, () => host.registerTool(tool), `dsh-testkit: tool ${tool.name}`, log)
      }
      log('info', `已注册 ${tools.length} 个工具：${tools.map((t) => t.name).join(', ')}`)
    }
  }

  // ---- 命令面 ----
  if (resolved.exposeCommands) {
    if (!host.capabilities.has('commands')) {
      log('warn', '宿主不具备 commands 能力，/testkit 命令不可用')
    } else {
      const commands = defineTestkitCommands({
        registry,
        drivers,
        host,
        runsDir: () => resolved.runsDirAbs,
        exportDir: () => resolved.exportDirAbs,
        defaultTimeoutMs: () => resolved.defaultTimeoutMs,
        pipeline,
        reload,
        // 命令面可以用 --allow-model / --allow-low-cost 显式放权（人类发起）
        policyDefaults: () => policyDefaultsFromConfig(resolved),
      })
      for (const command of commands) {
        installEffect(
          ctx,
          () => host.registerCommand(command),
          `dsh-testkit: command ${command.name}`,
          log,
        )
      }
      log('info', `已注册命令：${commands.map((c) => `/${c.name}`).join(', ')}`)
    }
  }

  // ---- client 半通道（HTTP bridge）----
  //
  // 静态插件包拿不到 host.call（那是动态包沙箱专属，详见 src/http.ts 头注），
  // 所以 client 半读数据的唯一通道是这个自建 HTTP 路由。
  //
  // ⚠️ **必须用 `ctx.inject` 等 webServer 就绪再注册。**
  //
  // 为什么：`apply()` 执行时 webServer 可能还没注册（cordis 的插件激活是异步的），
  // 此时 `ctx.get('webServer')` 拿到 undefined。它的表现极难定位——
  // **host 半明明激活了（工具可用、模型能调），但 bridge 端点一律 404**。
  // 实测诊断探针写出「能力探测：不具备 webServer」，而同一进程里 `testkit_list` 正常。
  //
  // `ctx.inject(names, cb)` 是 cordis 的标准做法（`dsh-free-search` 同样如此）。
  const installBridge = (scope: Context): void => {
    const webServer = (
      scope as unknown as { webServer?: { register: (route: WebRouteLike) => () => void } }
    ).webServer
    probeBridge(
      `webServer 就绪｜service=${typeof webServer}｜register=${typeof webServer?.register}`,
    )
    if (!webServer || typeof webServer.register !== 'function') {
      probeBridge('webServer 形状不符（拿不到 register 方法）')
      log('warn', 'webServer 服务形状不符，client 通道未注册')
      return
    }

    const routes = makeBridgeRoutes({
      registry,
      drivers,
      host,
      runsDir: () => resolved.runsDirAbs,
      defaultTimeoutMs: () => resolved.defaultTimeoutMs,
      policyDefaults: () => policyDefaultsFromConfig(resolved),
    })
    for (const route of routes) {
      installEffect(
        scope,
        () => webServer.register(route),
        `dsh-testkit: route ${route.path}`,
        log,
      )
    }
    probeBridge(`已注册 ${routes.length} 条：${routes.map((r) => r.path).join(', ')}`)
    log('info', `已注册 ${routes.length} 条 client 通道：${BRIDGE_PREFIX}/*`)
  }

  const ctxInject = (
    ctx as unknown as {
      inject?: (names: string[], callback: (scope: Context) => void) => unknown
    }
  ).inject

  if (typeof ctxInject === 'function') {
    ctxInject.call(ctx, ['webServer'], installBridge)
  } else {
    // 回退：最小的 host（如集成测试里的假宿主）没有 ctx.inject，
    // 此时按当前可见性直接试一次。
    probeBridge('宿主没有 ctx.inject，回退为直接注册')
    if (host.capabilities.has('webServer')) installBridge(ctx)
    else probeBridge('能力探测：不具备 webServer，bridge 未注册（回退路径）')
  }
  // ---- 场景目录热重载 ----
  if (resolved.watch) installWatcher(ctx, resolved.casesDirAbs, reload, log)
}

/**
 * 把一次注册绑定到 ctx 作用域，插件卸载时自动回滚。
 *
 * 回退策略：宿主没有 `effect` 时直接安装（不阻断功能，但失去自动清理）。
 */
function installEffect(
  ctx: Context,
  install: () => unknown,
  label: string,
  log: Log,
): void {
  const effect = (ctx as unknown as { effect?: (cb: () => unknown, label?: string) => unknown }).effect
  if (typeof effect === 'function') {
    effect.call(ctx, install, label)
    return
  }
  try {
    install()
  } catch (error) {
    log('error', `${label} 安装失败：${String(error)}`)
  }
}

/** 监听 casesDir 的 YAML 变化并防抖重载。 */
function installWatcher(ctx: Context, dir: string, reload: () => void, log: Log): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let watcher: ReturnType<typeof fsWatch> | undefined

  try {
    watcher = fsWatch(dir, { persistent: false }, (_event, filename) => {
      const name = filename === null ? '' : String(filename)
      if (name !== '' && !name.toLowerCase().endsWith('.yaml')) return
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          reload()
        } catch (error) {
          log('warn', `热重载失败：${String(error)}`)
        }
      }, 250)
    })
    watcher.on('error', (error: Error) => log('warn', `场景目录监听出错：${String(error)}`))
  } catch (error) {
    log('warn', `无法监听场景目录 ${dir}：${String(error)}`)
    return
  }

  const handle = watcher
  installEffect(
    ctx,
    () => () => {
      if (timer !== undefined) clearTimeout(timer)
      handle.close()
    },
    'dsh-testkit: cases watcher',
    log,
  )
}

/** 带插件前缀的日志。优先走 DSH logger，缺失则退到 console。 */
function createLogger(ctx: Context): Log {
  return (level, message) => {
    const text = `dsh-testkit: ${message}`
    const logger = (ctx as unknown as { logger?: Record<string, unknown> }).logger
    const fn = logger?.[level]
    if (typeof fn === 'function') {
      try {
        ;(fn as (m: string) => void).call(logger, text)
        return
      } catch {
        /* 落到 console */
      }
    }
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
  }
}

/**
 * 解析报告里要记录的 DSH 版本。
 *
 * 优先级：配置项 > `DSH_VERSION` 环境变量 > `unknown`。
 *
 * 为什么不自动读宿主版本：插件以符号链接装在 profile 的 `node_modules` 下，
 * 而 DSH 自身的包在宿主安装目录（asar）里——**不在插件的模块解析路径上**，
 * 所以插件内部解析不到。需要精确值时在 profile 的 patch 里显式配 `dshVersion`。
 */
function detectDshVersion(config: { dshVersion: string }): string {
  if (typeof config.dshVersion === 'string' && config.dshVersion.trim() !== '') {
    return config.dshVersion.trim()
  }
  return process.env['DSH_VERSION'] ?? 'unknown'
}
