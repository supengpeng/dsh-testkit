/**
 * `check-python-topimports.mjs` 的纯函数测试。
 *
 * 它守的是"**装机后才会炸**"的隐式依赖——而判据全靠 `extractTopLevelImports`
 * 抽得准不准。抽错一个，就会漏报（放过真问题）或误报（噪音）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { extractTopLevelImports } from '../scripts/check-python-topimports.mjs'

test('识别 `import X` 与 `from X import`', () => {
  assert.deepEqual(extractTopLevelImports('import os\n'), ['os'])
  assert.deepEqual(extractTopLevelImports('from utf8_boot import ensure_utf8\n'), ['utf8_boot'])
  assert.deepEqual(extractTopLevelImports('from x import a, b\n'), ['x'])
})

test('`import a.b` 取顶层名 a（那才是 sys.path 上要找的）', () => {
  assert.deepEqual(extractTopLevelImports('import a.b.c\n'), ['a'])
})

test('相对导入不算（`from .x import` / `from ..y import`）', () => {
  assert.deepEqual(extractTopLevelImports('from .mdcg import f\n'), [])
  assert.deepEqual(extractTopLevelImports('from ..pkg import f\n'), [])
  assert.deepEqual(extractTopLevelImports('from . import trust\n'), [])
})

test('`from __future__ import` 会被抽出来（调用方按"包内是否存在"过滤掉它）', () => {
  // 这里刻意不过滤——过滤责任在调用方（它知道包内有哪些模块），
  // 纯函数只负责"如实抽取"。
  assert.deepEqual(extractTopLevelImports('from __future__ import annotations\n'), ['__future__'])
})

test('缩进的 import 也能识别（函数内的延迟导入）', () => {
  const source = ['def f():', '    import json', '    from utf8_boot import x', ''].join('\n')
  assert.deepEqual(extractTopLevelImports(source), ['json', 'utf8_boot'])
})

test('注释里的 import 不算', () => {
  assert.deepEqual(extractTopLevelImports('import os  # import fake\n'), ['os'])
  assert.deepEqual(extractTopLevelImports('# import fake\n'), [])
})

test('去重且保持首次出现顺序', () => {
  const source = ['import b', 'import a', 'import b', 'from a import x', ''].join('\n')
  assert.deepEqual(extractTopLevelImports(source), ['b', 'a'])
})

test('空行与无关行被忽略', () => {
  assert.deepEqual(extractTopLevelImports('\n\nx = 1\nprint("hi")\n\n'), [])
})

test('`from X.Y import z` 取 X', () => {
  assert.deepEqual(extractTopLevelImports('from pkg.sub import thing\n'), ['pkg'])
})
