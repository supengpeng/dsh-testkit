/**
 * CI 硬化守卫（**离线可判**，文档 §7.1「供应链安全」+ §8.2）。
 *
 * ## 为什么要有它
 *
 * 工作流是**唯一能在仓库里直接执行代码、并持有 OIDC/仓库权限**的文件。
 * 它的失效形态和源码不同：写错一行不会让测试变红，而是让攻击面悄悄变大
 * （比如把 `@v4` 写成可变标签、加一句 `continue-on-error: true` 让红变绿、
 * 或者为了"跑得通"加上 `contents: write`）。所以这些必须是**机器判据**。
 *
 * ## 它判什么
 *
 *   ① 每个工作流必须有**显式顶层 `permissions:`**，且非发布流不得含任何 `write`；
 *   ② 发布流（文件名含 `release`，见 `RELEASE_WORKFLOW_RE`）只允许
 *      `contents: read` + `id-token: write`（OIDC provenance），其余 write 一律报；
 *   ③ 禁 `pull_request_target`（fork 上会拿到仓库密钥的作用域）；
 *   ④ 禁 `secrets.` 引用（本仓的门必须**零 secret** 才能跑，见 ci.yml 头注）；
 *   ⑤ 每个 `uses:` 必须钉到 **40 位 commit SHA**，并要求带 `# <ref>` 注释说明
 *      这个 SHA 对应哪个版本（否则半年后没人知道它是 v4 还是 v4.2.2）；
 *      本地 composite action（`./...`）与 `docker://` 例外（后者无 commit SHA 可钉）；
 *   ⑥ 禁 `continue-on-error: true`（它把红变绿，等于把门拆了）；
 *   ⑦ 安装命令必须 `--frozen-lockfile`；且**整份扫描范围内至少出现一次**
 *      （避免"某个流偷偷用 `pnpm install` 改依赖树"）。
 *
 * 扫描范围只到 `.github/workflows/**`（根目录 `action.yml` 是**被调用方**，
 * 由 `check-lockfile` / 发布清单守卫，不在这里判）。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/check-ci-hardening.mjs            # 检查本仓
 * node scripts/check-ci-hardening.mjs <包目录>
 * ```
 *
 * 退出码：0 = 通过；1 = 有违规。
 *
 * 结构约定（同 check-adapter-boundary.mjs）：纯函数留在顶层便于单测，
 * **所有 I/O 与 `process.exit` 都在 `main()`**，由 `isMain` 守卫调用。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

const here = fileURLToPath(new URL('.', import.meta.url))
const defaultRoot = resolve(join(here, '..'))

/** 工作流目录（仓库相对路径）。 */
export const WORKFLOWS_DIR = '.github/workflows'

/** 发布流判定：文件名以 release 开头（`release.yml` / `release-*.yml`）。 */
export const RELEASE_WORKFLOW_RE = /(^|\/)release[^/]*\.ya?ml$/i

/** 钉 SHA 的形态：正好 40 位小写十六进制。 */
export const PINNED_SHA_RE = /^[0-9a-f]{40}$/

/** 发布流里唯一允许的 write 作用域。 */
export const RELEASE_ALLOWED_WRITE = new Set(['id-token'])

/** 依赖安装命令；命中即要求同一行带 `--frozen-lockfile`。 */
export const INSTALL_RE = /\b(?:pnpm|npm|yarn)\s+(?:install|i|ci)\b/

/** 会**改动依赖树**的命令：CI 里一律不许（本仓"不加新依赖"是硬约束）。 */
export const MUTATING_DEP_RE = /\b(?:pnpm|npm|yarn)\s+(?:add|remove|rm|uninstall|update|upgrade|up|dedupe|prune)\b/

/* ------------------------------------------------------------ 纯函数层 -- */

/**
 * 把 YAML 的 `#` 注释替换成空格（保持字符数与换行不变，行号不漂）。
 *
 * 为什么不能直接对原文做正则：注释里写 `# uses: actions/checkout@v4` 是**说明**，
 * 不是依赖；反过来 `secrets.` / `pull_request_target` 这类词出现在注释里
 * 也不该报。所以先剥注释，再判。
 */
export function stripYamlComments(source) {
  const lines = String(source).split(/\r?\n/)
  return lines
    .map((line) => {
      let quote = null
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]
        if (quote !== null) {
          if (ch === quote) quote = null
          continue
        }
        if (ch === "'" || ch === '"') {
          quote = ch
          continue
        }
        if (ch === '#' && (i === 0 || /\s/.test(line[i - 1] ?? ''))) {
          return line.slice(0, i) + ' '.repeat(line.length - i)
        }
      }
      return line
    })
    .join('\n')
}

/**
 * 抽出所有 `uses:` 依赖（已剥离注释）。
 *
 * 返回 `{ line, specifier, refComment }`；`refComment` 取自**原文**同一行，
 * 用来判"有没有写明对应哪个版本"。
 */
export function extractUses(source) {
  const code = stripYamlComments(source)
  const codeLines = code.split(/\r?\n/)
  const rawLines = String(source).split(/\r?\n/)
  const out = []
  codeLines.forEach((line, index) => {
    // 两种写法都要认：列表项内联（`- uses: x`）与独立键（`        uses: x`）。
    const match = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?([^"'\s#]+)["']?/.exec(line)
    if (!match) return
    const raw = rawLines[index] ?? ''
    const comment = /#\s*(\S[^\n]*)$/.exec(raw)
    out.push({
      line: index + 1,
      specifier: match[1],
      refComment: comment === null ? '' : comment[1].trim(),
    })
  })
  return out
}

/** 本地 composite action 或 docker 镜像引用：不要求 40 位 SHA。 */
export function isExemptUses(specifier) {
  const value = String(specifier)
  return value.startsWith('./') || value.startsWith('../') || value.startsWith('docker://')
}

/** 收集一份工作流里所有 `permissions:` 块（顶层 + 每个 job）。 */
export function collectPermissionBlocks(doc) {
  const blocks = []
  if (doc === null || typeof doc !== 'object') return blocks
  if (Object.hasOwn(doc, 'permissions')) blocks.push({ where: 'permissions', value: doc.permissions })
  const jobs = doc.jobs
  if (jobs !== null && typeof jobs === 'object') {
    for (const [id, job] of Object.entries(jobs)) {
      if (job !== null && typeof job === 'object' && Object.hasOwn(job, 'permissions')) {
        blocks.push({ where: `jobs.${id}.permissions`, value: job.permissions })
      }
    }
  }
  return blocks
}

/** 一个权限值（字符串或映射）里出现的 write 作用域列表。 */
export function writeScopes(value) {
  if (typeof value === 'string') {
    return value.toLowerCase().includes('write') ? [value] : []
  }
  if (value === null || typeof value !== 'object') return []
  const scopes = []
  for (const [scope, level] of Object.entries(value)) {
    if (typeof level === 'string' && level.toLowerCase() === 'write') scopes.push(scope)
  }
  return scopes
}

function violation(rule, where, message) {
  return { rule, where, message }
}

/**
 * 判一份工作流文本（纯函数；`relPath` 只用于报告与发布流判定）。
 *
 * 返回违规数组，元素形如 `{ rule, where: '<file>:<line>', message }`。
 */
export function checkWorkflowText(relPath, source) {
  const rel = String(relPath).replace(/\\/g, '/')
  const violations = []
  const isRelease = RELEASE_WORKFLOW_RE.test(rel)
  const code = stripYamlComments(String(source))
  const codeLines = code.split(/\r?\n/)
  const at = (line) => `${rel}:${line}`

  // ① 权限：显式顶层 permissions + 不许 write（发布流例外）
  let doc = null
  try {
    doc = parseYaml(String(source))
  } catch (error) {
    violations.push(
      violation('yaml-parse', rel, `${rel}: YAML 解析失败（${error instanceof Error ? error.message : String(error)}）`),
    )
  }
  if (doc !== null && typeof doc === 'object') {
    const blocks = collectPermissionBlocks(doc)
    if (!Object.hasOwn(doc, 'permissions')) {
      violations.push(
        violation('permissions-missing', rel, `${rel}: 缺少显式顶层 \`permissions:\`（默认权限可能含 write）`),
      )
    }
    const seenWrite = new Set()
    for (const block of blocks) {
      for (const scope of writeScopes(block.value)) {
        seenWrite.add(scope)
        if (isRelease && RELEASE_ALLOWED_WRITE.has(scope)) continue
        violations.push(
          violation(
            'permissions-write',
            `${rel}#${block.where}`,
            `${rel}: \`${block.where}\` 含 \`${scope}: write\`；非发布流不得申请 write，发布流只允许 id-token`,
          ),
        )
      }
    }
    if (isRelease) {
      if (!seenWrite.has('id-token')) {
        violations.push(
          violation(
            'release-permissions-missing-id-token',
            rel,
            `${rel}: 发布流必须声明 \`id-token: write\`（npm provenance 走 OIDC，不用 secret）`,
          ),
        )
      }
      const contents = blocks.map((b) => b.value).find((v) => v !== null && typeof v === 'object' && Object.hasOwn(v, 'contents'))
      const contentsLevel = contents === undefined ? undefined : contents.contents
      if (contentsLevel !== 'read') {
        violations.push(
          violation(
            'release-permissions-missing-contents-read',
            rel,
            `${rel}: 发布流必须显式 \`contents: read\`（最小读取权限）`,
          ),
        )
      }
    }
  }

  codeLines.forEach((line, index) => {
    const lineNo = index + 1

    // ③ fork 上的危险触发器
    if (/\bpull_request_target\b/.test(line)) {
      violations.push(
        violation('pull-request-target', at(lineNo), `${at(lineNo)}: 禁用 \`pull_request_target\`（fork 上会拿到仓库级权限/密钥）`),
      )
    }

    // ④ 零 secret
    if (/\bsecrets\s*\./.test(line)) {
      violations.push(
        violation('secrets', at(lineNo), `${at(lineNo)}: 出现 \`secrets.\`；本仓的门必须零 secret 才能跑`),
      )
    }

    // ⑥ continue-on-error 会把红变绿
    if (/continue-on-error:\s*(?:true|"true"|'true'|yes)\b/i.test(line)) {
      violations.push(
        violation('continue-on-error', at(lineNo), `${at(lineNo)}: 禁用 \`continue-on-error: true\`（它让失败不再失败）`),
      )
    }

    // ⑦ 依赖安装必须锁死；不得改依赖树
    if (INSTALL_RE.test(line) && !/--frozen-lockfile\b/.test(line)) {
      violations.push(
        violation('frozen-lockfile', at(lineNo), `${at(lineNo)}: 安装命令缺少 \`--frozen-lockfile\``),
      )
    }
    if (MUTATING_DEP_RE.test(line)) {
      violations.push(
        violation('deps-mutating-command', at(lineNo), `${at(lineNo)}: CI 里不得改动依赖树（本仓不加新依赖）`),
      )
    }
  })

  // ⑤ uses 必须钉 SHA + 写清对应版本
  for (const use of extractUses(String(source))) {
    if (isExemptUses(use.specifier)) continue
    const atSign = use.specifier.lastIndexOf('@')
    const ref = atSign < 0 ? '' : use.specifier.slice(atSign + 1)
    if (!PINNED_SHA_RE.test(ref)) {
      violations.push(
        violation(
          'uses-unpinned',
          at(use.line),
          `${at(use.line)}: \`${use.specifier}\` 未钉 40 位 commit SHA（可变标签等于不设防）`,
        ),
      )
      continue
    }
    if (use.refComment === '') {
      violations.push(
        violation(
          'uses-ref-comment',
          at(use.line),
          `${at(use.line)}: \`${use.specifier}\` 缺少 \`# <ref>\` 注释（半年后没人知道这个 SHA 是什么版本）`,
        ),
      )
    }
  }

  return violations
}

/**
 * 判一组工作流（纯函数）。
 *
 * `files` 形如 `[{ relPath, source }]`；额外判一条**全局**规则：
 * 扫描范围内至少要出现一次 `--frozen-lockfile`。
 */
export function checkWorkflows(files) {
  const violations = []
  let frozenSeen = false
  let pins = 0
  let scanned = 0
  for (const file of files) {
    const rel = String(file.relPath ?? file.path ?? '').replace(/\\/g, '/')
    const source = String(file.source ?? '')
    scanned += 1
    violations.push(...checkWorkflowText(rel, source))
    if (/--frozen-lockfile\b/.test(stripYamlComments(source))) frozenSeen = true
    for (const use of extractUses(source)) if (!isExemptUses(use.specifier)) pins += 1
  }
  if (scanned > 0 && !frozenSeen) {
    violations.push(
      violation(
        'frozen-lockfile-missing',
        WORKFLOWS_DIR,
        `${WORKFLOWS_DIR}/**: 没有任何一步使用 \`--frozen-lockfile\`；依赖树在 CI 上是可变的`,
      ),
    )
  }
  return { violations, scanned, pins }
}

/* ----------------------------------------------------------- I/O 辅助层 -- */

/** 收集 `.github/workflows/**` 下的 YAML（保持只读，不 exit）。 */
export function collectWorkflows(packageRoot, { dir = WORKFLOWS_DIR } = {}) {
  const base = join(packageRoot, dir)
  let entries
  try {
    entries = readdirSync(base)
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    const full = join(base, entry)
    let isFile = false
    try {
      isFile = statSync(full).isFile()
    } catch {
      continue
    }
    if (!isFile || !/\.ya?ml$/.test(entry)) continue
    out.push({
      relPath: relative(packageRoot, full).replace(/\\/g, '/'),
      absPath: full,
      source: readFileSync(full, 'utf8'),
    })
  }
  return out
}

/* --------------------------------------------------------------- 主流程 -- */

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

function main() {
  const packageRoot = resolve(process.argv[2] ?? defaultRoot)
  const files = collectWorkflows(packageRoot)
  const { violations, scanned, pins } = checkWorkflows(files)

  console.log(`[check-ci-hardening] 包根：${packageRoot}`)
  console.log(`[check-ci-hardening] 扫描 ${scanned} 份工作流｜已钉 SHA 的外部 action ${pins} 个`)

  if (violations.length > 0) {
    console.error(`\n[check-ci-hardening] ✗ ${violations.length} 处 CI 硬化违规：`)
    for (const item of violations) console.error(`  - [${item.rule}] ${item.message}`)
    console.error(
      '\n修法：uses 钉 40 位 commit SHA 并带 `# <ref>` 注释；顶层写最小 `permissions:`；' +
        '安装一律 `--frozen-lockfile`；不要用 pull_request_target / secrets / continue-on-error。',
    )
    process.exit(1)
  }

  console.log('[check-ci-hardening] OK')
}

if (isMain) main()
