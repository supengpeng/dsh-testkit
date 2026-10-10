/**
 * CI 导出（Phase 4）的单元测试。
 *
 * 生成器是纯函数，所以这里穷举"产物长什么样"。
 * 而"产出的文件真的能跑"由 gate 的
 *   node scripts/export-scenarios.mjs && node --test export/scenarios.test.mjs
 * 端到端验证——两者互补：这里保证结构，那里保证可执行。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EXPORT_IMPORTS,
  generateNodeTestFile,
  toLibSpecifier,
} from '../lib/export/node-test.js'
import { exportScenariosToFile } from '../lib/export/write.js'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 造一条够用的场景。 */
function scenario(id, title = '示例标题', extra = {}) {
  return {
    schema: 1,
    id,
    title,
    kind: 'tool',
    source: { issue: null },
    setup: { tool: {} },
    steps: [{ name: '一步', expect: [{ ref: 'fx.a', exists: true }] }],
    ...extra,
  }
}

const BASE = {
  casesDir: join('C:', 'pkg', 'cases'),
  libSpecifier: '../lib/',
  generatedAt: '2026-10-10T00:00:00.000Z',
}

test('每条场景生成一个 test()，名字含 id 与 title', () => {
  const out = generateNodeTestFile([scenario('TK-0001'), scenario('TK-0002', '另一个')], BASE)

  assert.equal((out.match(/^test\(/gm) ?? []).length, 2, '应有 2 个 test()')
  assert.match(out, /test\("TK-0001 示例标题"/)
  assert.match(out, /test\("TK-0002 另一个"/)
  assert.match(out, /runScenario\("TK-0001"\)/)
  assert.match(out, /runScenario\("TK-0002"\)/)
})

test('import 语句覆盖全部入口，且使用给定的 libSpecifier', () => {
  const out = generateNodeTestFile([scenario('TK-0001')], {
    ...BASE,
    libSpecifier: '@scope/dsh-testkit/lib/',
  })

  assert.equal((out.match(/^import /gm) ?? []).length, EXPORT_IMPORTS.length + 2, '含 node:assert 与 node:test')

  for (const path of EXPORT_IMPORTS) {
    assert.ok(out.includes(`"@scope/dsh-testkit/lib/${path}"`), `应包含 ${path} 的 import`)
  }
})

test('casesDir 被 JSON 化（Windows 反斜杠安全）', () => {
  const casesDir = join('C:', 'a b', 'cases')
  const out = generateNodeTestFile([scenario('TK-0001')], { ...BASE, casesDir })

  assert.ok(out.includes(`const CASES_DIR = ${JSON.stringify(casesDir)}`))
  // JSON.stringify 会把反斜杠转义，保证生成的文件语法合法
  assert.ok(!out.includes(`const CASES_DIR = "${casesDir}"`) || !casesDir.includes('\\'))
})

test('timeoutMs 与 generatedAt 可注入（产物稳定可比对）', () => {
  const out = generateNodeTestFile([scenario('TK-0001')], {
    ...BASE,
    timeoutMs: 1234,
    generatedAt: '2026-01-02T03:04:05.000Z',
  })

  assert.match(out, /defaultTimeoutMs: 1234/)
  assert.match(out, /生成时间：2026-01-02T03:04:05\.000Z/)
})

test('同一个输入产出同一份文本（无隐藏时间依赖）', () => {
  const a = generateNodeTestFile([scenario('TK-0001')], BASE)
  const b = generateNodeTestFile([scenario('TK-0001')], BASE)
  assert.equal(a, b)
})

test('空场景列表仍产出合法文件（只是没有 test）', () => {
  const out = generateNodeTestFile([], BASE)
  assert.equal((out.match(/^test\(/gm) ?? []).length, 0)
  assert.match(out, /场景数：0/)
  // 骨架仍完整：imports、宿主装配、after 钩子
  assert.match(out, /createHeadlessHost\(\)/)
  assert.match(out, /after\(async \(\) => \{/)
})

test('产物声明了自己的边界（不越界声称验证过真实 DSH）', () => {
  const out = generateNodeTestFile([scenario('TK-0001')], BASE)
  assert.match(out, /不依赖 DSH 运行时/)
  assert.match(out, /替代活宿主验证/)
})

test('requires 会写进失败信息，便于定位跳过原因', () => {
  const out = generateNodeTestFile(
    [scenario('TK-0001', '带依赖', { runtime: { requires: ['tools', 'llm'] } })],
    BASE,
  )
  assert.match(out, /requires=tools,llm/)
})

test('toLibSpecifier：包内 export/ → ../lib/', () => {
  const root = join('C:', 'pkg')
  assert.equal(toLibSpecifier(join(root, 'export'), join(root, 'lib')), '../lib/')
})

test('toLibSpecifier：包根 → ./lib/', () => {
  const root = join('C:', 'pkg')
  assert.equal(toLibSpecifier(root, join(root, 'lib')), './lib/')
})

test('toLibSpecifier：包外目录 → 相对上跳', () => {
  const root = join('C:', 'pkg')
  assert.equal(toLibSpecifier(join('C:', 'ci', 'out'), join(root, 'lib')), '../../pkg/lib/')
})

test('toLibSpecifier：同一目录 → ./', () => {
  const root = join('C:', 'pkg')
  assert.equal(toLibSpecifier(root, root), './')
})

test('toLibSpecifier：绝对路径解不回去时退回 file:// URL（macOS 的 /var ↔ /private/var 真踩过）', () => {
  // 造一对"绝对但命名不一致"的目录：一边 realpath、一边原样。
  // macOS 上 `/var/folders/...` 的真实路径是 `/private/var/folders/...`，
  // 只 realpath 一边，relative() 就会算出爬出根目录的路径
  // （解析后落在一个不存在的 `private/<home>` 前缀上）。
  const base = mkdtempSync(join(tmpdir(), 'dsh-testkit-libspec-'))
  try {
    const realBase = realpathSync.native(base)
    const libDir = join(base, 'lib')
    const outDir = join(realBase, 'rerun')
    mkdirSync(libDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const spec = toLibSpecifier(outDir, libDir)
    // 无论走相对还是 file://，**解出来必须还是 libDir**（这才是模块解析真正要的性质）
    const resolved = spec.startsWith('file:')
      ? fileURLToPath(spec.replace(/\/$/, ''))
      : resolve(outDir, spec)
    assert.equal(
      realpathSync.native(resolved).replace(/\\/g, '/'),
      realpathSync.native(libDir).replace(/\\/g, '/'),
      `说明符必须解回 libDir，实际算成了 ${spec}`,
    )
    // 而且不能出现"爬出根目录再进 private/..."这种只存在于 macOS 的错误形态
    assert.ok(
      spec.startsWith('file:') || !spec.includes('/private/'),
      `解不回去的相对形态必须被拦下，实际：${spec}`,
    )
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

/* ---------------------------------------------------------- 落盘（有副作用） -- */

test('exportScenariosToFile：写出文件、返回路径与条数、推导相对 lib 说明符', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-testkit-export-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))

  const result = await exportScenariosToFile({
    scenarios: [scenario('TK-0001'), scenario('TK-0002', '第二条')],
    casesDir: join(REPO_ROOT, 'cases'),
    outDir,
    libDir: join(REPO_ROOT, 'lib'),
    generatedAt: '2026-10-10T00:00:00.000Z',
  })

  assert.equal(result.count, 2)
  assert.ok(existsSync(result.file), '文件应真的落盘')
  assert.ok(result.file.endsWith('scenarios.test.mjs'))

  const content = readFileSync(result.file, 'utf8')
  assert.match(content, /test\("TK-0001 示例标题"/)
  assert.match(content, /test\("TK-0002 第二条"/)
  // 导出到包外目录时，说明符必须是相对上跳而不是写死 ../lib/
  assert.ok(content.includes('"../lib/cases/registry.js"') || content.includes('lib/cases/registry.js'))
})

test('exportScenariosToFile：自定义文件名生效', async (t) => {
  const outDir = mkdtempSync(join(tmpdir(), 'dsh-testkit-export-'))
  t.after(() => rmSync(outDir, { recursive: true, force: true }))

  const result = await exportScenariosToFile({
    scenarios: [scenario('TK-0001')],
    casesDir: join(REPO_ROOT, 'cases'),
    outDir,
    libDir: join(REPO_ROOT, 'lib'),
    fileName: 'custom.test.mjs',
  })

  assert.ok(result.file.endsWith('custom.test.mjs'))
  assert.ok(existsSync(result.file))
})

test('exportScenariosToFile：目录不存在时自动创建', async (t) => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-testkit-export-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const nested = join(base, 'a', 'b', 'c')

  const result = await exportScenariosToFile({
    scenarios: [scenario('TK-0001')],
    casesDir: join(REPO_ROOT, 'cases'),
    outDir: nested,
    libDir: join(REPO_ROOT, 'lib'),
  })

  assert.ok(existsSync(result.file))
})
