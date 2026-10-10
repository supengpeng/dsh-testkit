/**
 * 异步残留探针（`src/isolation/probes.ts`）。
 *
 * ## 为什么端口探针必须"两侧都有证据"
 *
 * 只测"空闲端口报 false"的话，一个永远返回 false 的实现也能通过——
 * 那正是安慰剂。所以这里同时用**自己 listen 住的端口**要求报 busy：
 * 探针必须能区分两种真实状态，报告里的 `port:` 条目才有意义。
 *
 * 进程探针同理：解析路径用注入的执行器造出确定输出；"命令不可用"用
 * 一个不存在的命令与注入的失败结果各造一次；真实机器上再跑一次做形状断言
 * （不断言一定匹配到名字——没匹配到也是合法结论）。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createIsolationContext, disposeIsolationContext } from '../lib/isolation/context.js'
import {
  detectResidue,
  parseProcessNames,
  probePort,
  probePorts,
  probeProcesses,
} from '../lib/isolation/probes.js'

/* ---------------------------------------------------------------- 小工具 -- */

/** 真的 listen 住一个端口（`port: 0` → 系统分配），返回句柄。 */
function listenOnce() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port: 0, host: '127.0.0.1' }, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** 拿一个"此刻空闲"的端口：听一下再放掉。 */
async function freePort() {
  const handle = await listenOnce()
  const { port } = handle
  await handle.close()
  return port
}

function fakeScenario(id) {
  return { schema: 1, id, title: id, kind: 'tool', source: { issue: null }, setup: {}, steps: [] }
}

/* ------------------------------------------------------------------ 端口 -- */

test('probePorts：自己 listen 的端口报 busy，空闲端口报 false', async () => {
  const held = await listenOnce()
  const idle = await freePort()
  try {
    const results = await probePorts([held.port, idle])
    assert.equal(results.length, 2)
    assert.equal(results[0].port, held.port)
    assert.equal(results[0].busy, true, '被 listen 住的端口必须报 busy（否则探针是安慰剂）')
    assert.match(String(results[0].detail), /EADDRINUSE/)
    assert.equal(results[1].port, idle)
    assert.equal(results[1].busy, false, '刚放掉的端口应报空闲')
  } finally {
    await held.close()
  }
})

test('probePort：探不到的情况标 unknown，绝不当作干净', async () => {
  for (const bad of [70000, -1, 1.5]) {
    const result = await probePort(bad)
    assert.equal(result.busy, 'unknown', `端口 ${bad} 应报 unknown`)
    assert.ok(String(result.detail).length > 0, 'unknown 必须给原因')
  }
})

/* ------------------------------------------------------------------ 进程 -- */

test('probeProcesses：tasklist CSV 解析 + 子串匹配 + 去重排序', async () => {
  const stdout = [
    '"node.exe","1111","Console","1","50,000 K"',
    '"ghost-worker.exe","2222","Console","1","1 K"',
    '"node.exe","3333","Console","1","40,000 K"',
    'INFO: No tasks are running which match the specified criteria.',
  ].join('\r\n')

  const result = await probeProcesses(['node', 'ghost'], {
    format: 'tasklist',
    run: () => ({ status: 0, stdout }),
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.names, ['ghost-worker.exe', 'node.exe'], '应去重并排序')
})

test('probeProcesses：ps 输出解析（取 basename、跳空行）+ 大小写不敏感', async () => {
  const stdout = '/usr/local/bin/NODE\n\n   ghost-worker \n'
  const result = await probeProcesses(['node', 'GHOST'], {
    format: 'ps-lines',
    run: () => ({ status: 0, stdout }),
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.names, ['NODE', 'ghost-worker'])
})

test('probeProcesses：命令缺失 / 退出码非 0 / 未给 patterns 都要说明原因', async () => {
  const missing = await probeProcesses(['whatever'], { command: 'definitely-not-a-command-xyz' })
  assert.equal(missing.available, false, '命令跑不起来必须 available:false（不静默）')
  assert.deepEqual(missing.names, [])
  assert.ok(String(missing.detail).length > 0)
  assert.match(missing.detail, /ENOENT|not found|spawn/i)

  const failed = await probeProcesses(['whatever'], {
    run: () => ({ status: 3, stdout: '', stderr: 'boom' }),
  })
  assert.equal(failed.available, false)
  assert.match(failed.detail, /退出码 3/)
  assert.match(failed.detail, /boom/)

  const none = await probeProcesses([])
  assert.equal(none.available, false)
  assert.match(none.detail, /未指定 patterns/)
})

test('probeProcesses：真实机器上跑一次（只断言形状，不假设一定有匹配）', async () => {
  const result = await probeProcesses(['node'])
  assert.equal(typeof result.available, 'boolean')
  assert.ok(Array.isArray(result.names))
  assert.ok(result.command, '应给出实际使用的命令，便于复现')
  if (result.available) {
    // 本测试进程自己就是 node，所以命令可用时必然能匹配到
    assert.ok(result.names.length >= 1, `可用时应匹配到 node，实际：${JSON.stringify(result)}`)
  } else {
    assert.ok(String(result.detail).length > 0, '不可用必须给原因')
  }
})

test('parseProcessNames：坏行不抛（文件头 / 空行 / INFO 行）', () => {
  assert.deepEqual(parseProcessNames('', 'tasklist'), [])
  assert.deepEqual(parseProcessNames('INFO: nothing\nnot-csv\n', 'tasklist'), [])
  assert.deepEqual(parseProcessNames('\n  \n', 'ps-lines'), [])
})

/* ------------------------------------------------------------- 合成残留 -- */

test('detectResidue：tmpdir 残留 + 被占端口，两类都出现', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-testkit-probes-'))
  const held = await listenOnce()
  const ctx = createIsolationContext(fakeScenario('TK-9901'), { root, ports: [held.port] })
  try {
    writeFileSync(join(ctx.tmpdir, 'left.txt'), 'x')

    const record = await detectResidue(ctx, { patterns: [] })
    assert.ok(record.leftovers.includes('tmpdir:left.txt'), record.leftovers.join(', '))
    assert.ok(record.leftovers.includes(`port:${held.port}`), record.leftovers.join(', '))
    assert.ok(
      record.leftovers.every((item) => !item.startsWith('unknown:')),
      `两类都应探得到，实际：${record.leftovers.join(', ')}`,
    )
    assert.deepEqual(record.released, [])

    // 释放后再探：tmpdir 已删、端口已放 → 干净
    await disposeIsolationContext(ctx)
    await held.close()
    const clean = await detectResidue(
      { namespace: 'n', tmpdir: ctx.tmpdir, ports: [], session: 's' },
      { patterns: [] },
    )
    assert.deepEqual(clean.leftovers, [])
  } finally {
    await held.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectResidue：探不到的端口与不可用的进程探针写 unknown: 前缀', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-testkit-probes-unknown-'))
  const ctx = createIsolationContext(fakeScenario('TK-9902'), { root, ports: [70000] })
  try {
    const record = await detectResidue(ctx, {
      patterns: ['ghost'],
      processRunner: () => ({
        status: null,
        stdout: '',
        error: { code: 'ENOENT', message: 'spawn ghost-list ENOENT' },
      }),
    })

    assert.ok(
      record.leftovers.some((item) => item.startsWith('unknown:port:70000')),
      record.leftovers.join(', '),
    )
    assert.ok(
      record.leftovers.some((item) => item.startsWith('unknown:proc:') && item.includes('ENOENT')),
      record.leftovers.join(', '),
    )
    assert.deepEqual(record.released, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
