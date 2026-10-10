/**
 * 阶段 0-D：环境指纹比对器——把 REWRITE-METRICS §5 纪律 1（"只有 env.json 完全匹配时才比较数值"）
 * 从一句纪律变成一条**可执行的判定**。
 *
 * 它做两件事：
 *   ① 重新采集当前环境事实，与 baseline/env.json 的 `comparability.must_match` 逐项比对；
 *   ② 用当前事实重算 fingerprint.sha256，与 env.json 里冻结的哈希比对。
 *
 * 退出码：0 = 指纹匹配（可以比 D1–D3 数值）；1 = 指纹不匹配（必须重采基线，不得相除）。
 *
 * 用法（cwd = 仓库根）：
 *   & <node.exe> baseline/check-env.mjs
 *
 * 注意：physical cores 与内存总量 Node 取不到/口径不同，走 PowerShell（WMI）；
 *       时区用 Windows id（`China Standard Time`），不用 IANA（`Asia/Shanghai`）——
 *       两者都对，但冻结时用的是前者，比对必须用同一个口径。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cpus, release, totalmem } from 'node:os'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const env = JSON.parse(readFileSync(join(root, 'baseline', 'env.json'), 'utf8'))

function ps(command) {
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
  })
  return out.trim()
}

let physicalCores
let totalBytes
let winTz
try {
  physicalCores = Number(ps('(Get-CimInstance Win32_Processor | Select-Object -First 1).NumberOfCores'))
  totalBytes = Number(ps('(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory'))
  winTz = ps('[System.TimeZoneInfo]::Local.Id')
} catch (error) {
  console.error('[check-env] 无法采集 Windows 侧事实（需要 powershell）:', error.message)
  process.exit(3)
}

let pnpmVersion
try {
  pnpmVersion = execFileSync(process.execPath, [env.runtime.pnpm_executable, '--version'], {
    encoding: 'utf8',
    cwd: root,
  }).trim()
} catch (error) {
  console.error('[check-env] 无法读取 pnpm 版本:', error.message)
  process.exit(3)
}

const cpuList = cpus()
const live = {
  os_version: release(),
  os_build: release().split('.')[2] ?? '',
  platform: process.platform,
  arch: process.arch,
  cpu_model: (cpuList[0]?.model ?? '').trim(),
  cpu_physical_cores: physicalCores,
  cpu_logical_processors: cpuList.length,
  memory_total_bytes: totalBytes,
  node: process.version,
  pnpm: pnpmVersion,
  v8: process.versions.v8,
  timezone: winTz,
}

// 与 env.json 里 frozen 的取值口径对齐后逐项比对
const RULES = {
  os_version: () => env.os.version,
  os_build: () => env.os.build,
  platform: () => env.os.platform,
  arch: () => env.runtime.arch,
  cpu_model: () => env.cpu.model,
  cpu_physical_cores: () => env.cpu.physical_cores,
  cpu_logical_processors: () => env.cpu.logical_processors,
  memory_total_bytes: () => env.memory.total_bytes,
  node: () => env.runtime.node,
  pnpm: () => env.runtime.pnpm,
  v8: () => env.runtime.v8,
  timezone: () => env.timezone.windows_id,
}

const mismatches = []
for (const [key, expectedOf] of Object.entries(RULES)) {
  const expected = expectedOf()
  const actual = live[key]
  const same = String(expected) === String(actual)
  if (!same) mismatches.push({ field: key, frozen: expected, live: actual })
  console.log(`${same ? 'OK  ' : 'DIFF'} ${key.padEnd(24)} frozen=${expected}  live=${actual}`)
}

const liveHash = createHash('sha256').update(JSON.stringify(live), 'utf8').digest('hex')
const hashSame = liveHash === env.fingerprint.sha256
console.log(`\nfingerprint.sha256 frozen=${env.fingerprint.sha256}`)
console.log(`fingerprint.sha256 live  =${liveHash}  ${hashSame ? '(一致)' : '(不一致)'}`)

// totalmem() 只在提示里出现（口径与 WMI 不同，不参与判定）
console.log(`\n[note] os.totalmem()=${totalmem()}（与 WMI TotalPhysicalMemory 口径不同，仅提示，不参与判定）`)
console.log(`[note] Node 侧总逻辑核 os.cpus().length=${cpuList.length}`)

const ok = mismatches.length === 0 && hashSame
console.log(ok ? '\n[check-env] 指纹匹配：可以把读数与 D1–D3 冻结值相除' : '\n[check-env] 指纹不匹配：禁止比较数值，必须由人发起重采基线并记录原因')
process.exit(ok ? 0 : 1)
