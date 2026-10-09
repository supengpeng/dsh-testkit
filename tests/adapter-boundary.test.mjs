/**
 * 适配层边界守卫与 CI 工作流的测试。
 *
 * 分三层：
 *   ① 纯函数 —— 注释剥离、依赖抽取、判定规则（不碰文件系统）
 *   ② 正向/负向用例 —— 合法位置不报、越界位置必报、注释不误报
 *   ③ **真实仓库** —— 在本仓真实 src/ 上跑一遍守卫，并把 CI 工作流交给 yaml 解析
 *
 * 第 ③ 层是刻意加的：纯函数单测全绿但"真实源码里其实还有一处漏网"是这类
 * 静态守卫最常见的失效形态，只有对真实目录跑一次才守得住。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

import {
  ALLOWED_PREFIX,
  collectSourceFiles,
  extractDshImports,
  findViolations,
  isDshInternalPackage,
  normalizeRel,
  stripComments,
} from '../scripts/check-adapter-boundary.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

/** 造一条待扫描的假文件。 */
function file(relPath, source) {
  return { relPath, source }
}

/* ------------------------------------------------------------ 纯函数层 -- */

test('isDshInternalPackage：dsh 系列算，cordis / schemastery 不算', () => {
  assert.equal(isDshInternalPackage('@deepseek-ai/dsh-tools'), true)
  assert.equal(isDshInternalPackage('@deepseek-ai/dsh-llm'), true)
  assert.equal(isDshInternalPackage('@deepseek-ai/dsh-client-locale'), true)
  assert.equal(isDshInternalPackage('@deepseek-ai/dsh'), true)

  assert.equal(isDshInternalPackage('@deepseek-ai/cordis'), false)
  assert.equal(isDshInternalPackage('@deepseek-ai/schemastery'), false)
  assert.equal(isDshInternalPackage('react'), false)
  assert.equal(isDshInternalPackage('node:fs'), false)
  // 前缀像但不是同一个 scope
  assert.equal(isDshInternalPackage('@other-ai/dsh-tools'), false)
})

test('stripComments：剥掉行注释与块注释，但保留字符串与换行', () => {
  const src = ["import { a } from 'x' // 行注释里的 'y'", "/* 块注释", "   跨行 */", "const s = 'z'"].join('\n')
  const out = stripComments(src)

  assert.equal(out.length, src.length, '长度必须不变，否则行号会漂')
  assert.equal(src.split('\n').length, out.split('\n').length, '换行数必须不变')
  assert.ok(!out.includes('行注释'), '行注释内容应被剥掉')
  assert.ok(!out.includes('块注释'), '块注释内容应被剥掉')
  assert.ok(out.includes("'z'"), '字符串字面量必须保留')
  assert.ok(out.includes("'x'"), '代码里的说明符必须保留')
})

test('stripComments：字符串里的 // 不会被误当注释（URL 是常见形态）', () => {
  const src = "const u = 'https://example.com/a' // 注释"
  const out = stripComments(src)
  assert.ok(out.includes('https://example.com/a'), 'URL 不应被截断')
  assert.ok(!out.includes('注释'))
})

test('extractDshImports：四种依赖形式都能抽出来（含行号）', () => {
  const src = [
    "import { a } from '@deepseek-ai/dsh-tools'",
    "export type { B } from '@deepseek-ai/dsh-llm'",
    "import '@deepseek-ai/dsh-session'",
    "const m = await import('@deepseek-ai/dsh-system-prompt')",
    "const c = require('@deepseek-ai/dsh-tools')",
  ].join('\n')

  const hits = extractDshImports(src)
  assert.deepEqual(
    hits.map((h) => [h.line, h.specifier, h.kind]),
    [
      [1, '@deepseek-ai/dsh-tools', 'static-import'],
      [2, '@deepseek-ai/dsh-llm', 'static-import'],
      [3, '@deepseek-ai/dsh-session', 'side-effect-import'],
      [4, '@deepseek-ai/dsh-system-prompt', 'dynamic-import'],
      [5, '@deepseek-ai/dsh-tools', 'require'],
    ],
  )
})

/* -------------------------------------------------------- 判定规则用例 -- */

test('合法：src/adapters/dsh/tools.ts 里的 re-export 不报错', () => {
  const files = [
    file('src/adapters/dsh/tools.ts', "export { defineTool } from '@deepseek-ai/dsh-tools'\n"),
  ]
  const { violations, scanned, allowed } = findViolations(files)
  assert.deepEqual(violations, [])
  assert.equal(scanned, 1)
  assert.equal(allowed, 1, '适配目录下的依赖应被计数（证明扫描真的走到了）')
})

test('非法：在 src/kinds 下写一行 import 会被抓出来', () => {
  const files = [
    file('src/kinds/evil.ts', "import { defineTool } from '@deepseek-ai/dsh-tools'\n"),
  ]
  const { violations } = findViolations(files)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].where, 'src/kinds/evil.ts')
  assert.equal(violations[0].line, 1)
  assert.equal(violations[0].specifier, '@deepseek-ai/dsh-tools')
  assert.match(violations[0].message, /必须位于 src\/adapters\/dsh\//)
})

test('非法：动态 import() 与 require() 绕不过守卫', () => {
  const files = [
    file('src/runtime/a.ts', "const m = await import('@deepseek-ai/dsh-llm')\n"),
    file('src/report/b.ts', "const m = require('@deepseek-ai/dsh-session')\n"),
  ]
  const { violations } = findViolations(files)
  assert.deepEqual(
    violations.map((v) => [v.where, v.kind]),
    [
      ['src/runtime/a.ts', 'dynamic-import'],
      ['src/report/b.ts', 'require'],
    ],
  )
})

test('注释里的包名不误报（文档那条 grep 判据的误报来源）', () => {
  const files = [
    file(
      'src/kinds/llm.ts',
      [
        '/**',
        ' * 触发点（`@deepseek-ai/dsh-llm/lib/index.js`）：',
        ' *   真实范例见 `@deepseek-ai/dsh-llm/lib/invariant.js`',
        ' */',
        "// 曾经这里直接 import { defineTool } from '@deepseek-ai/dsh-tools'",
        "/* require('@deepseek-ai/dsh-tools') 也不行 */",
        'export const x = 1',
      ].join('\n') + '\n',
    ),
  ]
  const { violations, allowed } = findViolations(files)
  assert.deepEqual(violations, [], '注释里的包名不该算依赖')
  assert.equal(allowed, 0, '注释里的包名也不该被计成"适配层内的依赖"')
})

test('cordis / schemastery 即使在 driver 里出现也不报', () => {
  const files = [
    file('src/kinds/a.ts', "import type { Context } from '@deepseek-ai/cordis'\n"),
    file('src/runtime/b.ts', "import { Schema } from '@deepseek-ai/schemastery'\n"),
  ]
  const { violations } = findViolations(files)
  assert.deepEqual(violations, [])
})

test('非 TS 文件与相对路径导入不受影响', () => {
  const files = [
    file('scripts/tool.mjs', "import x from '@deepseek-ai/dsh-tools'\n"),
    file('src/kinds/relative.ts', "import { defineTool } from '../adapters/dsh/tools.js'\n"),
  ]
  const { violations, scanned } = findViolations(files)
  assert.deepEqual(violations, [])
  assert.equal(scanned, 1, '只数 TS/TSX')
})

test('Windows 风格的相对路径会被归一化', () => {
  assert.equal(normalizeRel('.\\src\\kinds\\a.ts'), 'src/kinds/a.ts')
  assert.equal(ALLOWED_PREFIX, 'src/adapters/dsh/')
  assert.deepEqual(
    findViolations([file('.\\src\\kinds\\a.ts', "import '@deepseek-ai/dsh-tools'")]).violations.length,
    1,
  )
})

/* ------------------------------------------------------------ 真实仓库 -- */

test('真实 src/ 扫描：零越界（适配层是唯一入口）', () => {
  const files = collectSourceFiles(root)
  assert.ok(files.length > 30, `应扫描到足量源码，实际 ${files.length} 个`)

  const { violations, allowed } = findViolations(files)
  assert.deepEqual(
    violations.map((v) => v.message),
    [],
  )
  assert.ok(allowed >= 1, '真实源码里至少要有一处 DSH 依赖落在适配目录下，否则守卫等于没接上')

  // 适配层那座桥本身必须真的存在且确实依赖 dsh-tools
  const bridge = files.find((f) => f.relPath === `${ALLOWED_PREFIX}tools.ts`)
  assert.ok(bridge, 'src/adapters/dsh/tools.ts 必须存在')
  assert.ok(
    extractDshImports(bridge.source).some((h) => h.specifier === '@deepseek-ai/dsh-tools'),
    '适配层要真的 re-export dsh-tools 的 defineTool',
  )
  assert.ok(/defineTool/.test(bridge.source), '适配层应转发 defineTool')
})

test('host-facade 经适配层取 defineTool，不直接 import DSH 内部包', () => {
  const text = readFileSync(join(root, 'src', 'host-facade.ts'), 'utf8')
  assert.match(text, /from '\.\/adapters\/dsh\/tools\.js'/, '必须从适配层导入')
  assert.ok(
    !extractDshImports(text).some((h) => isDshInternalPackage(h.specifier)),
    'host-facade.ts 不该再直接依赖 @deepseek-ai/dsh-*',
  )
})

/* ----------------------------------------------------------- CI 工作流 -- */

/** 读取并解析 CI 工作流（用本仓既有的 yaml 依赖，不靠肉眼看）。 */
function loadWorkflow() {
  const path = join(root, '.github', 'workflows', 'ci.yml')
  const text = readFileSync(path, 'utf8')
  return { path, text, doc: parseYaml(text) }
}

test('ci.yml 能被 yaml 解析，且矩阵是 2 档 Node × 3 个平台', () => {
  const { doc } = loadWorkflow()

  assert.equal(typeof doc, 'object')
  const job = doc.jobs?.gate
  assert.ok(job, '应有一个名为 gate 的 job')
  assert.equal(
    job['runs-on'],
    '${{ matrix.os }}',
    'runs-on 应交给矩阵（证明矩阵真的生效，而不是写死一个平台）',
  )

  const matrix = job.strategy?.matrix
  assert.deepEqual(matrix?.node, ['22.x', '24.x'])
  assert.deepEqual(matrix?.os, ['ubuntu-latest', 'windows-latest', 'macos-latest'])
  assert.equal(job.strategy?.['fail-fast'], false, '一个平台红不该掩盖其它平台的结果')
})

test('ci.yml：pnpm/action-setup + setup-node 缓存 + frozen-lockfile + gate', () => {
  const { text, doc } = loadWorkflow()
  const steps = doc.jobs.gate.steps
  assert.ok(Array.isArray(steps) && steps.length >= 5)

  const pnpmSetup = steps.find((s) => String(s.uses ?? '').startsWith('pnpm/action-setup@'))
  assert.ok(pnpmSetup, '必须用 pnpm/action-setup')
  assert.match(String(pnpmSetup.uses), /@v4$/, '版本钉在 v4')
  assert.equal(pnpmSetup.with?.version, '11.7.0', 'pnpm 版本固定，避免 CI 与本地漂移')

  const nodeSetup = steps.find((s) => String(s.uses ?? '').startsWith('actions/setup-node@'))
  assert.ok(nodeSetup, '必须用 actions/setup-node')
  assert.equal(nodeSetup.with?.cache, 'pnpm', '必须开 pnpm 缓存')
  assert.equal(nodeSetup.with?.['node-version'], '${{ matrix.node }}')

  const runs = steps.map((s) => String(s.run ?? ''))
  assert.ok(
    runs.some((r) => /pnpm install\s+--frozen-lockfile/.test(r)),
    '必须用 --frozen-lockfile 装依赖（否则 lockfile 漂移不会被发现）',
  )
  assert.ok(runs.some((r) => r.trim() === 'pnpm run gate'), 'CI 跑的就是本机同一条 gate')

  // checkout 必须排在装 pnpm 之前：action-setup 需要在仓库根读配置
  assert.match(String(steps[0].uses), /^actions\/checkout@/)
  // 反向约束：不要在 CI 里另写一套 tsc / node --test，避免双标准
  assert.ok(
    !runs.some((r) => /\btsc\b|node --test/.test(r)),
    'CI 不应绕过 gate 自己拼命令（那会产生"CI 绿但本地红"的双标准）',
  )
  assert.ok(!/secrets\./.test(text), 'gate 不需要任何 secret；出现 secrets 说明设计跑偏了')
})

test('ci.yml：权限最小化，且并发去重', () => {
  const { doc } = loadWorkflow()
  assert.equal(doc.permissions?.contents, 'read', '只需要读仓库')
  assert.equal(doc.concurrency?.['cancel-in-progress'], true)
  assert.ok(doc.on, '必须有触发条件')
})
