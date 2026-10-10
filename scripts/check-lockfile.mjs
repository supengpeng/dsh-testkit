/**
 * 锁文件一致性守卫（**离线可判**，文档 §7.1「依赖锁定」）。
 *
 * ## 它防的是哪一类问题
 *
 * `pnpm install --frozen-lockfile` 只在 CI 上跑；如果 `package.json` 与
 * `pnpm-lock.yaml` 漂移了，CI 才会红——而"依赖被悄悄换掉"这件事，
 * 更早、更便宜的检测点就是**直接比对两份文件**：
 *
 *   ① `dependencies` / `devDependencies` 的每一项，都必须在 lockfile
 *      根 importer（`.`）的同名分组里找得到，且 `specifier` 与声明的范围一致；
 *   ② `peerDependencies` 必须能被 lockfile 解析到（importer 任一分组或
 *      `packages:` 里出现）；非 optional 的 peer 还必须真的进 importer，
 *      否则"本地能跑、装出来报 missing peer"；
 *   ③ `packageManager` 必须声明、必须是 pnpm、版本必须与 lockfileVersion 兼容，
 *      **并与工作流里 `pnpm/action-setup` 的 version 一致**（这条跨文件比对
 *      才是真价值：CI 用 pnpm 11 而本地声明 pnpm 9 时，lockfile 会被改写成别人看不懂的样子）；
 *   ④ 若存在 `node_modules/.modules.yaml`，它的 `packageManager` 也要与声明一致
 *      （那是"实际装出来的"事实，缺了或对不上都说明环境与声明漂移）。
 *
 * ## 为什么 peer 不用"必须出现在 importer"
 *
 * pnpm 的 importer 只记 `dependencies` / `devDependencies` / `optionalDependencies`；
 * `peerDependencies` 由 `settings.autoInstallPeers` 解析，**不一定落进 importer**。
 * 强行要求会让任何"只有 peer 没有 devDep"的包假红。所以按"能解析到"判，
 * 并对非 optional 的 peer 加严。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-lockfile.mjs            # 检查本仓
 * node scripts/check-lockfile.mjs <包目录>
 * ```
 *
 * 退出码：0 = 通过；1 = 有违规。
 *
 * 结构约定（同 check-adapter-boundary.mjs）：纯函数留在顶层便于单测，
 * 所有 I/O 与 `process.exit` 都在 `main()`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

import { collectWorkflows } from './check-ci-hardening.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const defaultRoot = resolve(join(here, '..'))

/** lockfile 里的根 importer 键。 */
export const ROOT_IMPORTER = '.'

/**
 * pnpm 大版本 → 它写出的 lockfileVersion。
 *
 * pnpm 9 起统一是 `9.0`（10/11 也沿用，见本仓 pnpm-lock.yaml 的 `lockfileVersion: '9.0'`
 * 与 `node_modules/.modules.yaml` 的 `packageManager: pnpm@11.7.0`）。
 * 6/7/8 各自的主版本号即 lockfileVersion。表里没有的大版本按"未知"报出来，
 * 宁可真红也不要猜。
 */
export const LOCKFILE_VERSION_BY_MAJOR = { 6: '6.0', 7: '7.0', 8: '8.0' }
export const SHARED_LOCKFILE_VERSION_SINCE_MAJOR = 9

/** 声明式依赖分组（peer 另算，见文件头注）。 */
export const DEP_GROUPS = ['dependencies', 'devDependencies']

function violation(rule, where, message) {
  return { rule, where, message }
}

/* ------------------------------------------------------------ 纯函数层 -- */

/** 解析 `packageManager` 字段（容忍 corepack 的 `+sha512....` 后缀）。 */
export function parsePackageManager(spec) {
  if (typeof spec !== 'string') return undefined
  const match = /^([a-z0-9-]+)@(\d+)\.(\d+)\.(\d+)(?:\+.*)?$/i.exec(spec.trim())
  if (!match) return undefined
  return {
    name: match[1],
    version: `${match[2]}.${match[3]}.${match[4]}`,
    major: Number(match[2]),
  }
}

/** 大版本对应的期望 lockfileVersion；未知返回 undefined。 */
export function expectedLockfileVersion(major) {
  if (typeof major !== 'number' || Number.isNaN(major)) return undefined
  if (major >= SHARED_LOCKFILE_VERSION_SINCE_MAJOR) return '9.0'
  return LOCKFILE_VERSION_BY_MAJOR[major]
}

/** package.json 里声明的依赖清单（含分组，便于报告计数）。 */
export function collectDeclaredDeps(pkg) {
  const out = []
  for (const group of [...DEP_GROUPS, 'peerDependencies']) {
    const entries = pkg?.[group]
    if (entries === null || typeof entries !== 'object') continue
    for (const [name, range] of Object.entries(entries)) out.push({ group, name, range })
  }
  return out
}

/** 根 importer 里出现过的所有包名（跨分组并集）。 */
export function importerNames(lock) {
  const importer = lock?.importers?.[ROOT_IMPORTER] ?? {}
  const names = new Set()
  for (const group of [...DEP_GROUPS, 'optionalDependencies', 'peerDependencies']) {
    const entries = importer[group]
    if (entries === null || typeof entries !== 'object') continue
    for (const name of Object.keys(entries)) names.add(name)
  }
  return names
}

/** `packages:` 里是否出现过某个包（键形如 `name@version`）。 */
export function packagePresent(lock, name) {
  const packages = lock?.packages
  if (packages === null || typeof packages !== 'object') return false
  return Object.keys(packages).some((key) => key === name || key.startsWith(`${name}@`))
}

/**
 * 依赖项与 lockfile importer 的一致性（纯函数）。
 *
 * 返回 `{ violations, checked }`。
 */
export function checkImporterEntries(pkg, lock) {
  const violations = []
  const importer = lock?.importers?.[ROOT_IMPORTER]
  if (importer === undefined || importer === null || typeof importer !== 'object') {
    return {
      violations: [
        violation('lockfile-importer-missing', 'pnpm-lock.yaml', `pnpm-lock.yaml: 找不到根 importer（\`importers: { '.': ... }\`）`),
      ],
      checked: 0,
    }
  }

  let checked = 0
  for (const group of DEP_GROUPS) {
    const declared = pkg?.[group]
    if (declared === null || typeof declared !== 'object') continue
    const entries = importer[group]
    for (const [name, range] of Object.entries(declared)) {
      checked += 1
      const entry = entries === null || typeof entries !== 'object' ? undefined : entries[name]
      if (entry === undefined || entry === null) {
        violations.push(
          violation(
            'lockfile-missing-dep',
            `pnpm-lock.yaml#importers..${group}`,
            `pnpm-lock.yaml: package.json 的 ${group} 里有 \`${name}\`，但 lockfile 根 importer 里没有（lockfile 已漂移）`,
          ),
        )
        continue
      }
      const specifier = entry.specifier
      if (typeof specifier === 'string' && specifier !== range) {
        violations.push(
          violation(
            'lockfile-specifier-mismatch',
            `pnpm-lock.yaml#importers..${group}.${name}`,
            `pnpm-lock.yaml: \`${name}\` 的范围是 \`${specifier}\`，package.json 声明的是 \`${range}\``,
          ),
        )
      }
    }
  }

  const names = importerNames(lock)
  const peers = pkg?.peerDependencies
  if (peers !== null && typeof peers === 'object') {
    const meta = pkg?.peerDependenciesMeta ?? {}
    for (const name of Object.keys(peers)) {
      checked += 1
      const optional = meta?.[name]?.optional === true
      const inImporter = names.has(name)
      const inPackages = packagePresent(lock, name)
      if (!inImporter && !inPackages) {
        violations.push(
          violation(
            'lockfile-missing-peer',
            'pnpm-lock.yaml',
            `pnpm-lock.yaml: peer \`${name}\` 在 importer 与 packages 里都找不到（装出来会报 missing peer）`,
          ),
        )
        continue
      }
      if (!optional && !inImporter) {
        violations.push(
          violation(
            'lockfile-missing-required-peer',
            'pnpm-lock.yaml',
            `pnpm-lock.yaml: 非 optional 的 peer \`${name}\` 没有进根 importer；本地/CI 都不会真的装上它`,
          ),
        )
      }
    }
  }

  return { violations, checked }
}

/**
 * 从工作流里抽出 `pnpm/action-setup` 的 `with.version`（纯函数）。
 *
 * 这是 `packageManager` 那条判据的**跨文件**部分：CI 用的 pnpm 与仓库声明必须同一个版本。
 */
export function extractPnpmSetupVersions(files) {
  const out = []
  for (const file of files) {
    const rel = String(file.relPath ?? file.path ?? '').replace(/\\/g, '/')
    let doc
    try {
      doc = parseYaml(String(file.source ?? ''))
    } catch {
      continue
    }
    const jobs = doc?.jobs
    if (jobs === null || typeof jobs !== 'object') continue
    for (const [jobId, job] of Object.entries(jobs)) {
      const steps = job?.steps
      if (!Array.isArray(steps)) continue
      steps.forEach((step, index) => {
        const uses = step?.uses
        if (typeof uses !== 'string' || !uses.startsWith('pnpm/action-setup@')) return
        out.push({
          relPath: rel,
          where: `${rel}#jobs.${jobId}.steps[${index}]`,
          version: step?.with?.version,
        })
      })
    }
  }
  return out
}

/**
 * `packageManager` 与 lockfile / 工作流 / 已安装事实的一致性（纯函数）。
 *
 * `modulesYaml` 是 `node_modules/.modules.yaml` 解析后的对象（可为 undefined）。
 */
export function checkPackageManager({ pkg, lock, workflows = [], modulesYaml }) {
  const violations = []
  const declared = pkg?.packageManager
  const parsed = parsePackageManager(declared)

  if (typeof declared !== 'string' || declared.trim() === '') {
    violations.push(
      violation(
        'package-manager-missing',
        'package.json',
        'package.json: 缺少 `packageManager`；没有它就没有"用哪个包管理器/哪个版本"的单一事实',
      ),
    )
  } else if (parsed === undefined) {
    violations.push(
      violation(
        'package-manager-malformed',
        'package.json',
        `package.json: \`packageManager\` 形态不对（期望 \`pnpm@x.y.z\`，实际 \`${declared}\`）`,
      ),
    )
  } else if (parsed.name !== 'pnpm') {
    violations.push(
      violation(
        'package-manager-not-pnpm',
        'package.json',
        `package.json: 本仓用 pnpm（lockfile 是 pnpm-lock.yaml），但声明的是 \`${parsed.name}\``,
      ),
    )
  }

  const lockfileVersion = lock?.lockfileVersion
  if (parsed !== undefined && parsed.name === 'pnpm') {
    const expected = expectedLockfileVersion(parsed.major)
    if (expected === undefined) {
      violations.push(
        violation(
          'lockfile-version-unknown-manager',
          'pnpm-lock.yaml',
          `pnpm-lock.yaml: 不认识 pnpm ${parsed.major} 对应哪个 lockfileVersion（本守卫的表里没有）；请更新 LOCKFILE_VERSION_BY_MAJOR`,
        ),
      )
    } else if (String(lockfileVersion ?? '') !== expected) {
      violations.push(
        violation(
          'lockfile-version-mismatch',
          'pnpm-lock.yaml',
          `pnpm-lock.yaml: lockfileVersion 是 \`${String(lockfileVersion)}\`，但 packageManager 声明的 pnpm ${parsed.major} 写出来应该是 \`${expected}\``,
        ),
      )
    }
  }

  // 跨文件比对：工作流里的 `pnpm/action-setup.with.version` 必须等于 packageManager 的**版本号**
  //（不是整串 `pnpm@x.y.z`——那两处写法本来就不同，比错维度会假红）。
  const declaredVersion = parsed !== undefined && parsed.name === 'pnpm' ? parsed.version : undefined
  if (declaredVersion !== undefined) {
    for (const setup of extractPnpmSetupVersions(workflows)) {
      if (setup.version === declaredVersion) continue
      if (setup.version === undefined) {
        violations.push(
          violation(
            'pnpm-version-undeclared',
            setup.where,
            `${setup.where}: \`pnpm/action-setup\` 没有写 \`with.version\`；版本会随 action 默认值漂移`,
          ),
        )
        continue
      }
      violations.push(
        violation(
          'pnpm-version-drift',
          setup.where,
          `${setup.where}: CI 用 pnpm \`${setup.version}\`，package.json 的 packageManager 是 \`${declared}\`（版本必须一致）`,
        ),
      )
    }
  }

  const installed = typeof modulesYaml?.packageManager === 'string' ? modulesYaml.packageManager : undefined
  if (installed !== undefined && typeof declared === 'string' && installed !== declared) {
    violations.push(
      violation(
        'installed-package-manager-drift',
        'node_modules/.modules.yaml',
        `node_modules/.modules.yaml: 实际安装用的是 \`${installed}\`，package.json 声明的是 \`${declared}\``,
      ),
    )
  }

  return violations
}

/** 两条判据的合并入口（纯函数），便于单测一次断言。 */
export function checkLockfile({ pkg, lock, workflows = [], modulesYaml } = {}) {
  const importer = checkImporterEntries(pkg, lock)
  const manager = checkPackageManager({ pkg, lock, workflows, modulesYaml })
  return {
    violations: [...importer.violations, ...manager],
    checked: importer.checked,
    declared: collectDeclaredDeps(pkg).length,
  }
}

/* ----------------------------------------------------------- I/O 辅助层 -- */

/** 读 JSON/YAML 文件；不存在或解析失败返回 `{ error }`。 */
export function readJsonFile(path) {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

export function readYamlFile(path) {
  try {
    return { value: parseYaml(readFileSync(path, 'utf8')) }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/* --------------------------------------------------------------- 主流程 -- */

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

function main() {
  const packageRoot = resolve(process.argv[2] ?? defaultRoot)
  const problems = []

  const pkgPath = join(packageRoot, 'package.json')
  if (!existsSync(pkgPath)) {
    console.error(`[check-lockfile] 找不到 package.json：${pkgPath}`)
    process.exit(1)
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))

  const lockPath = join(packageRoot, 'pnpm-lock.yaml')
  if (!existsSync(lockPath)) {
    console.error(`[check-lockfile] 找不到 pnpm-lock.yaml：${lockPath}（本仓必须锁依赖）`)
    process.exit(1)
  }
  const lockResult = readYamlFile(lockPath)
  if (lockResult.error !== undefined) {
    console.error(`[check-lockfile] pnpm-lock.yaml 解析失败：${lockResult.error}`)
    process.exit(1)
  }

  const workflows = collectWorkflows(packageRoot)
  const modulesPath = join(packageRoot, 'node_modules', '.modules.yaml')
  const modulesYaml = existsSync(modulesPath) ? readJsonFile(modulesPath).value : undefined

  const { violations, checked, declared } = checkLockfile({
    pkg,
    lock: lockResult.value,
    workflows,
    modulesYaml,
  })
  problems.push(...violations)

  console.log(`[check-lockfile] 包根：${packageRoot}`)
  console.log(
    `[check-lockfile] lockfileVersion ${String(lockResult.value?.lockfileVersion)}｜声明依赖 ${declared} 项｜比对 ${checked} 项｜工作流 ${workflows.length} 份`,
  )

  if (problems.length > 0) {
    console.error(`\n[check-lockfile] ✗ ${problems.length} 处锁文件不一致：`)
    for (const item of problems) console.error(`  - [${item.rule}] ${item.message}`)
    console.error(
      '\n修法：改完 package.json 依赖就本地跑一次 `pnpm install`（会同步 lockfile）；' +
        '`packageManager` 与工作流里的 `pnpm/action-setup` 版本必须同一个。',
    )
    process.exit(1)
  }

  console.log('[check-lockfile] OK')
}

if (isMain) main()
