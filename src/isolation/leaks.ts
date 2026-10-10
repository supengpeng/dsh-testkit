/**
 * 残留检测（第 7.4 节：幂等 / 可重入 / 清理残留）。
 *
 * ## 检测三类残留
 *
 *   ① `tmpdir` 里还有东西（文件 / 子目录）——最常见，也是唯一可以**离线**真检测的；
 *   ② `ctx.ports` 里还有端口被占用；
 *   ③ 探针报出来的孤儿进程名。
 *
 * ## 为什么探针必须可注入
 *
 * 后两类的"真检测"在本进程里**做不可靠**：
 *   · Node 没有同步的"端口是否被占"API（`listen(0)` 是异步的，且在检测时
 *     自己占用一下端口反而会制造假阳性）；
 *   · 孤儿进程要按平台调 `tasklist` / `ps`，跨平台且要解析输出。
 * 所以这里把三类都做成探针：缺省只做 tmpdir（真实文件系统检查），
 * 端口 / 进程由 runner 按平台注入。单测则用注入的探针**造出**残留，
 * 断言它们确实被报出来——"检测器抓不到人为造的残留"才是真 bug。
 *
 * ## 缺省探针的诚实边界
 *
 * 不注入 `portProbe` / `procProbe` 时，本函数**不假装**它们是干净的：
 * 它只是不产生这两类条目（产生不了假阴性以外的结论）。
 * 报告里该不该把"未探测"单独写出来，由 runner 决定（它知道自己注没注入）。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { CleanupRecord } from '../runtime/runlog.js'
import type { IsolationContext } from './context.js'

/** 单个目录最多列多少条（防止误指到巨型目录时把报告撑爆）。 */
const MAX_FS_ENTRIES = 200

export interface LeakProbes {
  /** 端口是否仍被占用；缺省不探测。 */
  portProbe?: (port: number) => boolean
  /** 当前进程视角下的孤儿进程名；缺省不探测。 */
  procProbe?: () => string[]
  /** 返回目录下仍存在的条目（相对路径）；缺省用真实的递归列目录。 */
  fsProbe?: (dir: string) => string[]
}

/**
 * 检测残留，返回清理取证。
 *
 * `released` 恒为空数组：本函数只"看"，不"释放"。
 * 释放清单由 runner 合并 `releaseStepNotes` 的返回与夹具兜底 release 报告。
 * 条目格式（便于报告里 `grep`）：
 *   · `tmpdir:<相对路径>`
 *   · `port:<端口号>`
 *   · `proc:<进程名>`
 *   · `probe-error:<fs|port|proc>:<错误>`（探针自己炸了——这本身也是风险，如实报）
 *
 * 条目**去重**：同一类残留出现两次只记一条。否则一个会抛错的端口探针
 * 会按端口数乘出 N 条一模一样的噪音，报告读者从中看不出任何新信息。
 */
export function detectLeftovers(ctx: IsolationContext, probes: LeakProbes = {}): CleanupRecord {
  const leftovers: string[] = []

  // ---- ① 临时目录残留（缺省是真实文件系统检查）----
  const fsProbe = probes.fsProbe ?? defaultFsProbe
  try {
    const entries = [...fsProbe(ctx.tmpdir)].sort()
    for (const entry of entries.slice(0, MAX_FS_ENTRIES)) leftovers.push(`tmpdir:${entry}`)
    if (entries.length > MAX_FS_ENTRIES) {
      leftovers.push(`tmpdir:（另有 ${entries.length - MAX_FS_ENTRIES} 项已省略）`)
    }
  } catch (error) {
    leftovers.push(`probe-error:fs:${describeError(error)}`)
  }

  // ---- ② 端口仍被占用 ----
  const portProbe = probes.portProbe
  if (portProbe) {
    for (const port of ctx.ports) {
      try {
        if (portProbe(port)) leftovers.push(`port:${port}`)
      } catch (error) {
        leftovers.push(`probe-error:port:${describeError(error)}`)
      }
    }
  }

  // ---- ③ 孤儿进程 ----
  const procProbe = probes.procProbe
  if (procProbe) {
    try {
      const names = [...new Set(procProbe().map((name) => String(name)))].sort()
      for (const name of names) {
        if (name !== '') leftovers.push(`proc:${name}`)
      }
    } catch (error) {
      leftovers.push(`probe-error:proc:${describeError(error)}`)
    }
  }

  return { released: [], leftovers: dedupe(leftovers) }
}

/** 保序去重：残留清单是"集合"，不是"事件流"。 */
function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)]
}

/** 真实探针：递归列出目录下仍存在的条目（目录本身也算残留）。 */
function defaultFsProbe(dir: string): string[] {
  const out: string[] = []
  collect(dir, '', out, MAX_FS_ENTRIES)
  return out
}

/** `readdirSync(dir, { withFileTypes: true })` 里我们真正用到的那几个面。 */
interface DirEntryLike {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

function collect(absDir: string, prefix: string, out: string[], cap: number): void {
  let entries: DirEntryLike[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    // 目录不存在 / 读不了：视为"没有残留"。
    // 为什么不是"报错"：dispose 之后目录本就该不存在，那是正常路径。
    return
  }

  for (const entry of entries) {
    if (out.length >= cap) return
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    out.push(relative)
    // 符号链接不跟进去：跟进去可能读到目录树外面，也会成环
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      collect(join(absDir, entry.name), relative, out, cap)
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
