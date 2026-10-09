/**
 * file driver 的单元测试。
 *
 * 用**真实临时文件**——它本来就纯离线，不需要替身。
 *
 * 重点守两件事：
 *   ① `matchGlob` 的行为完全确定（它是判据的基础，不能含糊）
 *   ② "文件不存在"是**取证**而不是抛错（装机缺件是最常见的真实故障）
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { Context } from '@deepseek-ai/cordis'

import { createHostFacade } from '../lib/host-facade.js'
import { fileDriver, matchGlob } from '../lib/kinds/file.js'
import { Fixture } from '../lib/runtime/fixture.js'

/* ------------------------------------------------------------ 纯函数层 -- */

test('matchGlob：单层 `*` 不跨目录', () => {
  assert.equal(matchGlob('a.py', '*.py'), true)
  assert.equal(matchGlob('pkg/a.py', '*.py'), false)
  assert.equal(matchGlob('pkg/a.py', 'pkg/*.py'), true)
  assert.equal(matchGlob('pkg/sub/a.py', 'pkg/*.py'), false)
})

test('matchGlob：`**` 跨任意层，且 `**/x` 也匹配根下的 x', () => {
  assert.equal(matchGlob('pkg/sub/a.py', 'pkg/**'), true)
  assert.equal(matchGlob('pkg/sub/deep/a.py', 'pkg/**'), true)
  assert.equal(matchGlob('a.py', '**/*.py'), true, '`**/` 应也能匹配根层')
  assert.equal(matchGlob('pkg/a.py', '**/*.py'), true)
  assert.equal(matchGlob('pkg/sub/a.py', '**/*.py'), true)
})

test('matchGlob：`?` 匹配单个非斜杠字符', () => {
  assert.equal(matchGlob('a.py', '?.py'), true)
  assert.equal(matchGlob('ab.py', '?.py'), false)
})

test('matchGlob：正则特殊字符被转义（不会被当成模式）', () => {
  assert.equal(matchGlob('a+b.py', 'a+b.py'), true)
  assert.equal(matchGlob('aab.py', 'a+b.py'), false, '+ 不该被当成正则量词')
  assert.equal(matchGlob('a.py', 'a.py'), true)
})

test('matchGlob：反斜杠路径先归一化', () => {
  assert.equal(matchGlob('pkg\\a.py', 'pkg/*.py'), true)
})

/* -------------------------------------------------------- driver 契约层 -- */

function makeHarness(root) {
  const ctx = new Context()
  const driverCtx = {
    host: createHostFacade({ ctx, dshVersion: 'test', log: () => undefined }),
    fixture: new Fixture(),
    scenario: { setup: {} },
    signal: new AbortController().signal,
  }
  return {
    driverCtx,
    prepare: () => fileDriver.setup(driverCtx, { setup: { file: { root } } }),
  }
}

/**
 * 用临时目录跑一段测试，结束即清理。
 *
 * ⚠️ 必须是 **async 且 await fn**：`fn` 是 async 时它立即返回 Promise，
 * 若在 `finally` 里直接 `rmSync`，目录会在 await 完成**之前**就被删掉——
 * 表现为"文件明明刚写完却 fileExists=false"（真踩过一次）。
 */
async function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-file-'))
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('act：读文件取证内容、行数与大小', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\n', 'utf8')
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { read: 'a.txt' } })

    assert.equal(h.driverCtx.fixture.getNote('fileExists'), true)
    assert.equal(h.driverCtx.fixture.getNote('fileText'), 'line1\nline2\n')
    assert.deepEqual(h.driverCtx.fixture.getNote('fileLines'), ['line1', 'line2', ''])
    assert.equal(h.driverCtx.fixture.getNote('fileHasCRLF'), false)
    assert.equal(h.driverCtx.fixture.getNote('fileError'), undefined)
  })
})

test('act：文件不存在时记 fileExists=false 而不是抛错', async () => {
  await withTempDir(async (dir) => {
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { read: 'nope.txt' } })

    assert.equal(h.driverCtx.fixture.getNote('fileExists'), false)
    assert.equal(h.driverCtx.fixture.getNote('fileBytes'), 0)
    assert.equal(h.driverCtx.fixture.getNote('fileText'), undefined)
  })
})

test('act：CRLF 换行会被取证到（跨平台真实故障源）', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'crlf.txt'), 'a\r\nb\r\n', 'utf8')
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { read: 'crlf.txt' } })
    assert.equal(h.driverCtx.fixture.getNote('fileHasCRLF'), true)
  })
})

test('act：glob 列出匹配文件（递归 + 排序 + 跳过 node_modules）', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'tests', 'sub'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'tests', 'a.py'), '', 'utf8')
    writeFileSync(join(dir, 'tests', 'sub', 'b.py'), '', 'utf8')
    writeFileSync(join(dir, 'tests', 'c.txt'), '', 'utf8')
    writeFileSync(join(dir, 'node_modules', 'x', 'ignored.py'), '', 'utf8')

    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { glob: 'tests/**/*.py' } })

    assert.deepEqual(h.driverCtx.fixture.getNote('globMatches'), ['tests/a.py', 'tests/sub/b.py'])
    assert.equal(h.driverCtx.fixture.getNote('globCount'), 2)
    assert.ok(h.driverCtx.fixture.getNote('globScanned') >= 3, 'node_modules 应被跳过')
  })
})

test('act：目标是目录时如实说明', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'subdir'), { recursive: true })
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { read: 'subdir' } })
    assert.match(String(h.driverCtx.fixture.getNote('fileError')), /目录/)
  })
})

test('act：动作既没 read 也没 glob 时报错（不静默）', async () => {
  await withTempDir(async (dir) => {
    const h = makeHarness(dir)
    await h.prepare()
    await assert.rejects(() => fileDriver.act(h.driverCtx, { file: {} }), /需要 `read`/)
  })
})

test('act：search 命中并给出文件/行号/文本', async () => {
  await withTempDir(async (dir) => {
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'a.py'), 'def compact_access():\n    pass\n', 'utf8')
    writeFileSync(join(dir, 'sub', 'b.py'), 'cg.compact_access()\n', 'utf8')
    writeFileSync(join(dir, 'c.txt'), 'compact_access\n', 'utf8')

    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { search: { pattern: 'compact_access', glob: '**/*.py' } } })

    // c.txt 不匹配 glob，所以只有 2 处
    assert.equal(h.driverCtx.fixture.getNote('searchCount'), 2)
    assert.equal(h.driverCtx.fixture.getNote('searchFileCount'), 2)
    assert.deepEqual(h.driverCtx.fixture.getNote('searchFiles'), ['a.py', 'sub/b.py'])
    assert.match(String(h.driverCtx.fixture.getNote('searchText')), /a\.py:1: def compact_access/)
  })
})

test('act：search 不带 glob 时搜全部文件', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.py'), 'NEEDLE\n', 'utf8')
    writeFileSync(join(dir, 'b.txt'), 'NEEDLE\n', 'utf8')
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { search: { pattern: 'NEEDLE' } } })
    assert.equal(h.driverCtx.fixture.getNote('searchCount'), 2)
  })
})

test('act：search 支持 flags（大小写不敏感）', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), 'Needle\n', 'utf8')
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { search: { pattern: 'needle' } } })
    assert.equal(h.driverCtx.fixture.getNote('searchCount'), 0, '默认区分大小写')

    await fileDriver.act(h.driverCtx, { file: { search: { pattern: 'needle', flags: 'i' } } })
    assert.equal(h.driverCtx.fixture.getNote('searchCount'), 1)
  })
})

test('act：search 的 maxResults 生效', async () => {
  await withTempDir(async (dir) => {
    writeFileSync(join(dir, 'a.txt'), Array.from({ length: 10 }, () => 'HIT').join('\n'), 'utf8')
    const h = makeHarness(dir)
    await h.prepare()
    await fileDriver.act(h.driverCtx, { file: { search: { pattern: 'HIT', maxResults: 3 } } })
    assert.equal(h.driverCtx.fixture.getNote('searchCount'), 3)
  })
})

test('act：search 的非法正则明确报错（不静默）', async () => {
  await withTempDir(async (dir) => {
    const h = makeHarness(dir)
    await h.prepare()
    await assert.rejects(
      () => fileDriver.act(h.driverCtx, { file: { search: { pattern: 'a(' } } }),
      /不是合法正则/,
    )
  })
})

test('act：search 缺 pattern 时报错', async () => {
  await withTempDir(async (dir) => {
    const h = makeHarness(dir)
    await h.prepare()
    await assert.rejects(() => fileDriver.act(h.driverCtx, { file: { search: {} } }), /需要 `pattern`/)
  })
})

test('act：非 file 动作直接报错', async () => {
  await withTempDir(async (dir) => {
    const h = makeHarness(dir)
    await assert.rejects(() => fileDriver.act(h.driverCtx, { tool: 'x' }), /只支持 `file` 动作/)
  })
})

test('driver 元信息：kind=file 且不静态声明 requires（纯离线）', () => {
  assert.equal(fileDriver.kind, 'file')
  assert.deepEqual(fileDriver.requires, [], 'file 直接用 node:fs，不需要宿主服务')
})
