/**
 * E5：独立验证器**零依赖**（指标 §6：运行时依赖数，不含 Node 内置 = 0）。
 *
 * 设计 §7.4 的理由必须写在这里，否则将来会有人"顺手"给它加个方便库：
 * **验证器若依赖第三方 npm 包，供应链攻击面会直接落在"验证"这个动作上。**
 *
 * 判定方式：静态扫描 `src/attest/**` 的全部模块说明符 + 从 `verify.mjs` 出发求**运行时闭包**，
 * 断言闭包里每一个说明符要么是 `node:` 内置，要么是同目录相对路径。
 * 另附**负向证明**：把一段含 `import yaml from 'yaml'` 的合成源码喂给扫描器，它必须报红——
 * 否则这条自检就是永远绿的摆设。
 *
 * 与 `npm ls --prod` 的关系（诚实说明）：`package.json` 本仓有 `yaml` 依赖（报告层的 YAML
 * 解析），所以"整包零依赖"并不成立、也不该成立。E5 约束的是**验证器**：本测试证明它的运行时
 * 闭包只有 Node 内置，因此它可以在一个**没有 node_modules** 的环境里被复制出去独立运行。
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..')
const attestDir = join(repoRoot, 'src', 'attest')

/**
 * 递归列出 `src/attest/**` 下的 `.mjs` 文件。
 * @param {string} dir 目录
 * @returns {string[]} 绝对路径
 */
export function listModules(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...listModules(path))
    else if (name.endsWith('.mjs')) out.push(path)
  }
  return out.sort()
}

/**
 * 从源码里取出所有模块说明符（import / export-from / require / 动态 import）。
 * @param {string} source 源码
 * @returns {string[]} 说明符
 */
export function collectSpecifiers(source) {
  const specifiers = []
  const patterns = [
    /(?:^|[\s;{}])(?:import|export)\s+(?:[^'"\n]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.push(match[1])
  }
  return specifiers
}

/**
 * 过滤出"非 Node 内置且非相对路径"的说明符（也就是第三方包）。
 * @param {string[]} specifiers 说明符
 * @returns {string[]} 违规说明符
 */
export function nonBuiltinSpecifiers(specifiers) {
  return specifiers.filter((item) => !item.startsWith('node:') && !item.startsWith('.'))
}

test('src/attest/** 只 import node: 内置或相对路径', () => {
  const modules = listModules(attestDir)
  assert.ok(modules.length >= 6, `模块数太少（${modules.length}），扫描面不对`)
  const violations = []
  for (const path of modules) {
    const source = readFileSync(path, 'utf8')
    for (const item of nonBuiltinSpecifiers(collectSpecifiers(source))) {
      violations.push(`${relative(repoRoot, path)} → ${item}`)
    }
  }
  assert.deepEqual(violations, [], `E5 违规（不许第三方依赖）：${violations.join(', ')}`)
  console.log(`[E5] 静态扫描 ${modules.length} 个模块：第三方说明符 0 个`)
})

test('负向证明：扫描器能抓到第三方 import', () => {
  // 刻意用模板拼接而不是字面量：本文件自己也在上面那条目录扫描的覆盖范围内，
  // 若把 `import yaml from 'yaml'` 写成字面量，扫描器会（正确地）把它当成真实违规。
  // 拼接后**源码**里不出现完整的 `import … from '包名'`，但喂给扫描器的**运行时字符串**
  // 仍然是货真价实的 import/require 语句。
  const quote = (name) => `'${name}'`
  const synthetic = [
    `import yamlJs from ${quote('yaml')}`,
    `const x = require(${quote('lodash')})`,
    `await import(${quote('left-pad')})`,
  ].join('\n')
  assert.ok(synthetic.includes("from 'yaml'"), '运行时字符串必须真的是 import 语句')
  const found = nonBuiltinSpecifiers(collectSpecifiers(synthetic))
  assert.deepEqual(found.sort(), ['left-pad', 'lodash', 'yaml'])
  // 同一扫描器对合规源码必须静默。
  const clean = "import { test } from 'node:test'\nimport { x } from './y.mjs'\n"
  assert.deepEqual(nonBuiltinSpecifiers(collectSpecifiers(clean)), [])
})

test('验证器的运行时闭包为零依赖', () => {
  // 从 verify.mjs 出发，按相对路径递归求闭包——这才是"验证器跑起来真正加载了什么"。
  const entry = join(attestDir, 'verify.mjs')
  const seen = new Set()
  const queue = [entry]
  const closures = []
  while (queue.length > 0) {
    const path = queue.shift()
    const normalized = path.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    closures.push(path)
    const source = readFileSync(path, 'utf8')
    for (const specifier of collectSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue
      if (!specifier.startsWith('.')) {
        assert.fail(`验证器闭包里出现第三方依赖：${specifier}（来自 ${relative(repoRoot, path)}）`)
      }
      queue.push(join(dirname(path), specifier))
    }
  }
  assert.ok(closures.length >= 3, `闭包太小（${closures.length}）：${closures.join(', ')}`)
  for (const path of closures) {
    assert.ok(
      path.toLowerCase().startsWith(attestDir.toLowerCase()),
      `闭包里出现了 src/attest 之外的文件：${path}`,
    )
  }
  console.log(
    `[E5] verify.mjs 运行时闭包 = ${closures.length} 个模块（全部在 src/attest 内，外部依赖 0）：` +
      closures.map((path) => relative(repoRoot, path).replace(/\\/g, '/')).sort().join(', '),
  )
  // 测试文件不在闭包里——验证器不是测试夹具的一部分。
  assert.ok(!closures.some((path) => path.includes('.test.mjs')))
  // 注入器同样不在闭包里（验证器不该依赖"能造篡改"的代码）。
  assert.ok(!closures.some((path) => path.endsWith('tamper.mjs')))
})

test('验证器不写文件、不联网（静态证据）', () => {
  const forbidden = [
    ['node:fs', /from\s+['"]node:fs['"]/],
    ['node:http', /from\s+['"]node:http['"]/],
    ['node:https', /from\s+['"]node:https['"]/],
    ['node:net', /from\s+['"]node:net['"]/],
    ['writeFile', /\bwriteFile\w*\s*\(/],
    ['appendFile', /\bappendFile\w*\s*\(/],
    ['createWriteStream', /\bcreateWriteStream\s*\(/],
  ]
  for (const file of ['verify.mjs', 'jcs.mjs', 'hex.mjs', 'ed25519.mjs']) {
    const source = readFileSync(join(attestDir, file), 'utf8')
    for (const [label, pattern] of forbidden) {
      assert.ok(!pattern.test(source), `${file} 出现 ${label}——验证器必须只读且不联网`)
    }
  }
  console.log('[E5] 验证器四个模块：无 fs / 无 http(s) / 无 net / 无任何写文件调用')
})
