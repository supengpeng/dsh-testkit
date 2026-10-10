/**
 * 宿主级残留扫描：体检真正"看得到"的那部分。
 *
 * 与 `detectResidue(ctx, …)` 的分工：
 *   · 那一份围着**某条场景的隔离上下文**转（刚刚跑完的那条，跑完就该干净）；
 *   · 这一份不看场景，只看**这台机器上有没有上一轮崩掉留下的东西**——
 *     陈旧 `dsh-testkit-*` 临时目录、仍被占着的测试端口、还挂着的孤儿进程。
 *
 * 为什么值得单独做：`runs/` 里有失败记录、但临时目录/进程没人收尸，
 * 是"跑完就忘"最典型的漏点；体检报告是唯一会主动去看它的地方。
 */

import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { probePorts, probeProcesses, type ProcessProbeResult } from '../isolation/probes.js'
import type { CleanupRecord } from '../runtime/runlog.js'
import type { DoctorResidue } from './types.js'

export interface HostResidueOptions {
  /** 临时目录根；缺省 `os.tmpdir()`。 */
  tmpRoot?: string
  /** 视为"本工具留下的"目录名前缀；缺省 `['dsh-testkit']`。 */
  dirPrefixes?: readonly string[]
  /** 要探测的端口；缺省 `[]`（不猜端口，见下）。 */
  ports?: readonly number[]
  /** 要匹配的进程名子串；缺省 `['dsh-testkit']`。 */
  patterns?: readonly string[]
  /** 探针超时（毫秒），缺省 2000。 */
  timeoutMs?: number
}

const DEFAULT_DIR_PREFIXES = ['dsh-testkit'] as const
const DEFAULT_PATTERNS = ['dsh-testkit'] as const
/** 陈旧目录最多列这么多条；超了只记一条"另有 N 项"，别让报告被一次泄漏刷爆。 */
const MAX_STALE_DIRS = 200

/**
 * 扫描宿主上的残留。
 *
 * **不猜端口**：`ports` 缺省为空。端口是"场景声明的"而不是"能猜的"，
 * 猜一个范围去扫既慢又会把无关服务报成残留。要探端口就把端口传进来
 * （runner 可以从最近一次运行记录里收集）。
 */
export async function collectHostResidue(options: HostResidueOptions = {}): Promise<DoctorResidue> {
  const tmpRoot = resolve(options.tmpRoot ?? tmpdir())
  const dirPrefixes = normalizeList(options.dirPrefixes, DEFAULT_DIR_PREFIXES)
  const patterns = normalizeList(options.patterns, DEFAULT_PATTERNS)
  const ports = [...(options.ports ?? [])]

  const targets: string[] = []
  const notes: string[] = []
  const leftovers: string[] = []

  // ---- ① 陈旧的隔离临时目录 ----
  if (dirPrefixes.length > 0) {
    targets.push(`${tmpRoot} 下以 ${dirPrefixes.join(' / ')} 开头的目录`)
    const stale = scanStaleDirs(tmpRoot, dirPrefixes)
    if (stale.error !== undefined) notes.push(`临时目录扫描失败：${stale.error}`)
    for (const name of stale.names.slice(0, MAX_STALE_DIRS)) leftovers.push(`tmpdir:${name}`)
    if (stale.names.length > MAX_STALE_DIRS) {
      leftovers.push(`tmpdir:（另有 ${stale.names.length - MAX_STALE_DIRS} 项陈旧目录已省略）`)
      notes.push(
        `陈旧目录共 ${stale.names.length} 个，报告只列前 ${MAX_STALE_DIRS} 个` +
          `（多半是测试没清理，建议顺手把 ${tmpRoot} 下的陈旧目录删掉）。`,
      )
    }
  } else {
    notes.push('未指定 dirPrefixes：本次没有临时目录残留结论')
  }

  // ---- ② 端口 ----
  const portResults = ports.length > 0 ? await probePorts(ports, { timeoutMs: options.timeoutMs }) : []
  if (ports.length > 0) {
    targets.push(`端口 ${ports.join('、')}（只探 127.0.0.1）`)
  } else {
    notes.push('未指定待探端口（不猜端口范围）；如需端口残留检查，请由调用方把端口传进来')
  }
  for (const result of portResults) {
    if (result.busy === true) leftovers.push(`port:${result.port}`)
    else if (result.busy === 'unknown') {
      leftovers.push(
        `unknown:port:${result.port}${result.detail === undefined ? '' : `（${result.detail}）`}`,
      )
    }
  }

  // ---- ③ 孤儿进程 ----
  let processes: ProcessProbeResult | undefined
  if (patterns.length > 0) {
    targets.push(`名字含 ${patterns.map((p) => `\`${p}\``).join(' / ')} 的进程`)
    processes = await probeProcesses(patterns, { timeoutMs: options.timeoutMs })
    if (!processes.available) {
      notes.push(
        `进程探针不可用（${processes.detail ?? '原因未知'}）：本次**没有**进程残留结论，不等于没有`,
      )
      leftovers.push(`unknown:proc:${processes.detail ?? '进程探针不可用'}`)
    } else {
      for (const name of processes.names) leftovers.push(`proc:${name}`)
      if (processes.names.length === 0) {
        notes.push(`进程探针可用（${processes.command ?? '未知命令'}）：没有匹配的进程`)
      }
    }
  } else {
    notes.push('未指定进程 patterns：本次没有进程残留结论')
  }

  notes.push('端口/进程都只能"探到就报"：探不到的记为 `unknown:`，**不等于干净**')

  const record: CleanupRecord = { released: [], leftovers: [...new Set(leftovers)] }
  return { targets, record, notes, ports: portResults, ...(processes === undefined ? {} : { processes }) }
}

interface StaleScan {
  names: string[]
  error?: string
}

function scanStaleDirs(tmpRoot: string, prefixes: readonly string[]): StaleScan {
  try {
    const names = readdirSync(tmpRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.startsWith(prefix)))
      .map((entry) => entry.name)
      .sort()
    return { names }
  } catch (error) {
    // 临时目录不存在 / 读不了：这本身是环境问题，如实报，不伪装成"没有残留"
    return { names: [], error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 列表归一化：`undefined` → 用缺省；显式 `[]` → **真的不探**（不是"用缺省"）。
 *
 * 这个区别很重要：体检里"我不想探进程"和"我没说"必须能分开表达，
 * 否则调用方想省掉一次 tasklist 都做不到。
 */
function normalizeList(value: readonly string[] | undefined, fallback: readonly string[]): string[] {
  if (value === undefined) return [...fallback]
  return value.map((item) => String(item)).filter((item) => item !== '')
}

/** 供 CLI 复用的默认临时目录（避免 CLI 自己再 import os）。 */
export function defaultTmpRoot(): string {
  return tmpdir()
}
