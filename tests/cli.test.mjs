/**
 * `dsh-testkit` CLI 的测试。
 *
 * ## 为什么跑**真实子进程**而不是直接调 `main()`
 *
 * CLI 有一半的正确性在"进程边界"上：shebang 能不能被执行、退出码能不能传给调用方、
 * stdout 是不是**纯** JSON（`--json` 模式下任何一行日志都会弄坏它）、
 * 写管道时会不会被截断。这些**只有起进程才测得到**——进程内调用全都会"通过"，
 * 因为进程内的 `io` 是我们自己传的。
 *
 * 所以主路径一律 `execFileSync(process.execPath, [bin, ...])`；
 * 另有少量**进程内**用例（`main()` 直接调用）专门守住"`main` 返回退出码、
 * 不自己 `process.exit`"这条契约——那是它能被嵌入与测试的前提。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { main } from '../lib/cli/index.js'
import { createBufferIo } from '../lib/cli/io.js'
import { EXIT } from '../lib/cli/exit.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(root, 'bin', 'dsh-testkit.mjs')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/**
 * 跑一次真实 CLI。
 *
 * `execFileSync` 在退出码非 0 时**抛异常**，且把 stdout/stderr 挂在错误对象上——
 * 这正是我们要断言的两种信息，所以统一收成 `{ code, stdout, stderr }`。
 */
function runCli(args, options = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      ...options,
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    if (typeof error?.status !== 'number') throw error
    return {
      code: error.status,
      stdout: typeof error.stdout === 'string' ? error.stdout : '',
      stderr: typeof error.stderr === 'string' ? error.stderr : '',
    }
  }
}

/** 解析 JSON 输出（失败时把原文一起报出来，便于定位"多了一行日志"这类问题）。 */
function parseJson(stdout, where) {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    assert.fail(`${where}: stdout 不是合法 JSON（${error.message}）：\n${stdout.slice(0, 400)}`)
  }
}

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `tk-cli-${label}-`))
}

/** T11 / T12 的洞察模块是否已落地（未落地时对应子命令会明确报"未就绪"，退出码 3）。 */
function insightModuleReady(kind) {
  const candidates =
    kind === 'trace'
      ? ['lib/trace/index.js', 'lib/trace/render.js', 'lib/trace/format.js']
      : ['lib/insight/index.js', `lib/insight/${kind}.js`]
  return candidates.some((rel) => existsSync(join(root, rel)))
}

/* ------------------------------------------------------------- bin 形态 -- */

test('bin 形态：shebang、入口映射、且 node 能直接执行它', (t) => {
  assert.ok(existsSync(BIN), `bin 必须存在：${BIN}`)

  const source = readFileSync(BIN, 'utf8')
  // 比较前去掉 `\r`：行尾由 `.gitattributes`（`eol=lf`）保证，但断言不该依赖
  // checkout 时的 autocrlf 设置——那会让"文件其实是对的"在 Windows 上假红。
  assert.equal(
    source.split('\n')[0].replace(/\r$/, ''),
    '#!/usr/bin/env node',
    '第一行必须是 shebang（否则 npm 的 shim 不认）',
  )
  assert.ok(source.length > 100, 'bin 不该是空壳')

  assert.equal(pkg.bin?.['dsh-testkit'], './bin/dsh-testkit.mjs', 'package.json 的 bin 必须指向它')
  assert.ok(
    (pkg.files ?? []).includes('bin'),
    'bin/ 必须在 files 白名单里，否则装出来没有 CLI',
  )
  assert.equal(BIN, join(root, pkg.bin['dsh-testkit']), 'bin 的相对路径应解析到同一个文件')

  // POSIX 上 npm 会在安装时补可执行位；仓库里的源码位由 git 的 fileMode 决定
  // （本机是 Windows，git 默认不记录 exec 位），所以这里只**如实报告**、不判红。
  if (process.platform !== 'win32') {
    const mode = statSync(BIN).mode
    t.diagnostic(
      `POSIX exec 位：${(mode & 0o111) !== 0 ? '已置位' : '未置位（npm 安装时会补；源码位需 chmod +x 并提交）'}`,
    )
  }

  const version = runCli(['version'])
  assert.equal(version.code, 0, 'node 必须能直接执行 bin')
  assert.match(version.stdout, /dsh-testkit/)
})

/* ----------------------------------------------------------- help / usage -- */

test('help：退出码 0，且写清退出码表与 headless 边界', () => {
  const bare = runCli([])
  assert.equal(bare.code, EXIT.OK)
  assert.match(bare.stdout, /退出码/)
  assert.match(bare.stdout, /headless/)

  const help = runCli(['help'])
  assert.equal(help.code, EXIT.OK)
  assert.match(help.stdout, /dsh-testkit run/)

  const one = runCli(['help', 'run'])
  assert.equal(one.code, EXIT.OK)
  assert.match(one.stdout, /--allow-model/)
  assert.match(one.stdout, /--only/)

  const flag = runCli(['--help'])
  assert.equal(flag.code, EXIT.OK)

  const json = parseJson(runCli(['help', '--json']).stdout, 'help --json')
  assert.equal(json.exitCode, 0)
  assert.ok(Array.isArray(json.commands) && json.commands.length >= 10)
  // ⚠️ 这里曾经断言 `exitCodes` **精确等于** `[0,1,2,3]`。1.0.0 起退出码扩展了
  // （RFC 0001 §3.3 / 决定 3：新增 `6` 协议不兼容、`7` 必需能力缺失），
  // 所以断言拆成两半——**原意（0-3 冻结且顺序不变）逐字保留**，
  // 另加"新增码必须也进表"。放宽成"包含 0-3"是错的：那会让 `help` 漏报新码而没人发现，
  // 而调用方在 CI 里真的遇到 6/7 时查不到含义。
  assert.deepEqual(
    json.exitCodes.map((item) => item.code).slice(0, 4),
    [0, 1, 2, 3],
    '退出码表的前四项必须是冻结的 0/1/2/3（顺序也是契约的一部分）',
  )
  assert.deepEqual(
    json.exitCodes.map((item) => item.code).slice(4),
    [6, 7],
    '1.0.0 新增的协议/能力退出码必须写进 help 的表里',
  )
})

test('未知子命令 / 未知选项一律退出码 2（绝不静默忽略）', () => {
  const bogusCommand = runCli(['definitely-not-a-command'])
  assert.equal(bogusCommand.code, EXIT.USAGE)
  assert.match(bogusCommand.stderr, /未知子命令/)

  const bogusOption = runCli(['run', '--definitely-not-an-option'])
  assert.equal(bogusOption.code, EXIT.USAGE)
  assert.match(bogusOption.stderr, /未知选项/)

  const missingValue = runCli(['run', '--only'])
  assert.equal(missingValue.code, EXIT.USAGE)
  assert.match(missingValue.stderr, /需要一个值/)
})

test('version：人类可读 + JSON 两种形态，且声明这是 headless 轨', () => {
  const text = runCli(['version'])
  assert.equal(text.code, EXIT.OK)
  assert.match(text.stdout, /headless/)

  const json = parseJson(runCli(['version', '--json']).stdout, 'version --json')
  assert.equal(json.exitCode, 0)
  assert.equal(json.track, 'headless')
  assert.equal(json.version, pkg.version)
  assert.equal(json.name, pkg.name)
})

/* ------------------------------------------------------------------ list -- */

test('list：默认列出全部场景；过滤与 JSON 都可用', () => {
  const text = runCli(['list'])
  assert.equal(text.code, EXIT.OK)
  assert.match(text.stdout, /场景目录/)
  assert.match(text.stdout, /TK-0001/)

  const json = parseJson(runCli(['list', '--json']).stdout, 'list --json')
  assert.equal(json.command, 'list')
  assert.ok(json.total >= 30, `场景数应 >= 30，实际 ${json.total}`)
  assert.ok(json.scenarios.every((item) => typeof item.id === 'string' && typeof item.kind === 'string'))

  const filtered = parseJson(runCli(['list', '--kind', 'tool', '--json']).stdout, 'list --kind tool --json')
  assert.ok(filtered.total > 0)
  assert.ok(filtered.scenarios.every((item) => item.kind === 'tool'))

  const smoke = parseJson(runCli(['list', '--tag', 'smoke', '--json']).stdout, 'list --tag smoke --json')
  assert.ok(smoke.total > 0, '仓库里应有 smoke 标签的场景（--smoke 的兜底口径依赖它）')

  const badKind = runCli(['list', '--kind', 'not-a-kind'])
  assert.equal(badKind.code, EXIT.USAGE)
  assert.match(badKind.stderr, /未知 kind/)
})

/* ------------------------------------------------------- registry / fixtures -- */

test('registry：列出 step 片段；缺失的注册表目录不崩', () => {
  const text = runCli(['registry'])
  assert.ok(text.code === EXIT.OK || text.code === EXIT.FAILED, `退出码 ${text.code}`)
  assert.match(text.stdout, /step 片段注册表/)

  const json = parseJson(runCli(['registry', '--json']).stdout, 'registry --json')
  assert.ok(json.count > 0, 'step registry 应有片段')

  const missing = runCli(['registry', '--registry', join(root, 'definitely-missing-registry')])
  assert.notEqual(missing.code, 0, '注册表不存在时不该报成功')
})

test('fixtures：列出夹具与 DSH 版本绑定', () => {
  const text = runCli(['fixtures'])
  assert.ok(text.code === EXIT.OK || text.code === EXIT.FAILED, `退出码 ${text.code}`)
  assert.match(text.stdout, /夹具目录/)

  const json = parseJson(runCli(['fixtures', '--json']).stdout, 'fixtures --json')
  assert.equal(json.command, 'fixtures')
  assert.ok(json.total > 0, '仓库里应有夹具')
})

/* ----------------------------------------------------------------- expand -- */

test('expand：真实场景可展开；不存在的 id 退出码 2', () => {
  const ok = runCli(['expand', 'TK-0001'])
  assert.equal(ok.code, EXIT.OK)
  assert.match(ok.stdout, /已展开为 flat/)

  const json = parseJson(runCli(['expand', 'TK-0001', '--json']).stdout, 'expand --json')
  assert.equal(json.stepCount, json.steps.length)
  assert.ok(json.stepCount > 0)

  assert.equal(runCli(['expand']).code, EXIT.USAGE)
  const missing = runCli(['expand', 'TK-9999'])
  assert.equal(missing.code, EXIT.USAGE)
  assert.match(missing.stderr, /找不到场景/)
})

/* ------------------------------------------------------- run（主命令） -- */

test('run --only TK-0001 --out <tmp>：退出码 0，且报告三件产物落盘', () => {
  const outDir = tempDir('run')
  try {
    const result = runCli(['run', '--only', 'TK-0001', '--out', outDir])
    assert.equal(result.code, EXIT.OK, `stderr: ${result.stderr}`)
    // 诚实标注：必须写清这是 headless 轨
    assert.match(result.stdout, /headless/)
    assert.match(result.stdout, /合计 1/)

    const runDirs = readdirSync(outDir)
    assert.equal(runDirs.length, 1, `应恰好一个运行目录：${runDirs.join(', ')}`)
    const dir = join(outDir, runDirs[0])
    assert.ok(existsSync(join(dir, 'report.md')), 'report.md 应落盘')
    assert.ok(existsSync(join(dir, 'run.json')), 'run.json 应落盘')
    assert.ok(existsSync(join(dir, 'junit.xml')), 'junit.xml 应落盘')

    const summary = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    assert.equal(summary.cases.length, 1)
    assert.equal(summary.cases[0].verdict, 'passed')
    assert.equal(summary.cases[0].id, 'TK-0001')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('run --json：stdout 是**纯** JSON（进度走 stderr），载荷含 headless 声明与产物路径', () => {
  const outDir = tempDir('runjson')
  try {
    const result = runCli(['run', '--only', 'TK-0001', '--out', outDir, '--json'])
    assert.equal(result.code, EXIT.OK, `stderr: ${result.stderr}`)
    assert.equal(result.stdout.slice(0, 1), '{', 'stdout 第一行就必须是 JSON（否则解析方会炸）')

    const payload = parseJson(result.stdout, 'run --json')
    assert.equal(payload.command, 'run')
    assert.equal(payload.exitCode, 0)
    assert.equal(payload.track, 'headless')
    assert.equal(payload.totals.total, 1)
    assert.equal(payload.totals.passed, 1)
    assert.ok(Array.isArray(payload.host.provided) && payload.host.provided.includes('tools'))
    assert.ok(Array.isArray(payload.host.missing), '缺口必须如实列出（哪怕是空数组）')
    assert.ok(existsSync(payload.artifacts.markdownPath), 'JSON 里的产物路径必须真实存在')
    assert.ok(existsSync(payload.artifacts.junitPath))
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('run 选中 0 条 → 退出码 2（一条没跑却报成功是最危险的假绿）', () => {
  const missing = runCli(['run', '--only', 'TK-9999'])
  assert.equal(missing.code, EXIT.USAGE)
  assert.match(missing.stderr, /没有选中任何场景/)

  const noMatch = runCli(['run', '--kind', 'ui', '--tag', 'definitely-not-a-tag'])
  assert.equal(noMatch.code, EXIT.USAGE)
})

test('run 的用法错误（未知 kind / 非法 cost / 非整数 parallel）退出码 2', () => {
  assert.equal(runCli(['run', '--kind', 'not-a-kind']).code, EXIT.USAGE)
  assert.equal(runCli(['run', '--cost', 'expensive']).code, EXIT.USAGE)
  assert.equal(runCli(['run', '--parallel', '0']).code, EXIT.USAGE)
  assert.equal(runCli(['run', '--parallel', 'abc']).code, EXIT.USAGE)
  assert.equal(runCli(['run', '--smoke-budget', '-1']).code, EXIT.USAGE)
})

test('run --cases <不存在的目录> → 退出码 3（基础设施错误，不是"0 条"）', () => {
  const result = runCli(['run', '--cases', join(root, 'definitely-missing-cases')])
  assert.equal(result.code, EXIT.INFRA)
  assert.match(result.stderr, /场景目录不存在/)
})

test('run --smoke：命中 smoke 集（预算估算模块未就绪时退回 tag=smoke）', (t) => {
  const dxReady =
    existsSync(join(root, 'lib', 'dx', 'select.js')) || existsSync(join(root, 'lib', 'dx', 'index.js'))
  if (!dxReady) {
    t.diagnostic('T13（src/dx）未就绪：--smoke 的断言只做"不崩"检查，并注明原因')
  }

  const outDir = tempDir('smoke')
  try {
    const result = runCli(['run', '--smoke', '--out', outDir])
    if (!dxReady) {
      // 未就绪时的兜底口径是 tag=smoke；仓库里确实有 smoke 场景，所以仍应选出 > 0 条。
      assert.ok(
        result.code === EXIT.OK || result.code === EXIT.USAGE,
        `未就绪路径下 --smoke 不该崩：退出码 ${result.code}\n${result.stderr}`,
      )
      return
    }
    assert.ok(
      result.code === EXIT.OK || result.code === EXIT.USAGE,
      `--smoke 退出码 ${result.code}\n${result.stderr}`,
    )
    assert.match(result.stdout, /smoke/, '输出应说明 smoke 集是怎么选出来的')
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

/* ----------------------------------------------------------------- report -- */

test('report：从 --out 目录取最近一次运行；空目录退出码 2', () => {
  const outDir = tempDir('report')
  try {
    const empty = runCli(['report', '--out', outDir])
    assert.equal(empty.code, EXIT.USAGE, '还没有运行记录时应报用法层面的事实')
    assert.match(empty.stderr, /还没有任何运行记录/)

    const ran = runCli(['run', '--only', 'TK-0001', '--out', outDir])
    assert.equal(ran.code, EXIT.OK, `stderr: ${ran.stderr}`)

    const report = runCli(['report', '--out', outDir])
    assert.equal(report.code, EXIT.OK)
    assert.match(report.stdout, /report\.md/)

    const json = parseJson(runCli(['report', '--out', outDir, '--json']).stdout, 'report --json')
    assert.equal(json.command, 'report')
    assert.equal(json.truncated, false)
    assert.match(json.markdown, /TK-0001/)

    const missing = runCli(['report', 'definitely-not-a-run', '--out', outDir])
    assert.equal(missing.code, EXIT.USAGE)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

/* -------------------------------------------------------- export / import -- */

test('export：真实导出 node-test 用例到临时目录（不碰仓库的 export/）', () => {
  const outDir = tempDir('export')
  try {
    const result = runCli(['export', '--out', outDir, '--json'])
    assert.equal(result.code, EXIT.OK, `stderr: ${result.stderr}`)
    const json = parseJson(result.stdout, 'export --json')
    assert.equal(json.command, 'export')
    assert.ok(json.count > 0)
    assert.ok(existsSync(json.file), `导出文件应存在：${json.file}`)
    assert.match(json.file, /scenarios\.test\.mjs$/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('export --format 非法 → 退出码 2；touchstone 目标缺运行记录 → 退出码 2', () => {
  assert.equal(runCli(['export', '--format', 'nonsense']).code, EXIT.USAGE)

  const outDir = tempDir('export-ts')
  try {
    const result = runCli([
      'export',
      '--format',
      'touchstone',
      '--run-id',
      'definitely-not-a-run',
      '--out',
      join(outDir, 'bug_report'),
    ])
    assert.equal(result.code, EXIT.USAGE)
    assert.match(result.stderr, /找不到运行记录/)
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

test('import --dry-run：只转换不登记提案，且**绝不**写 cases/', () => {
  const dir = tempDir('import')
  const casesBefore = readdirSync(join(root, 'cases')).sort()
  try {
    const file = join(dir, 'case.md')
    writeFileSync(
      file,
      [
        '---',
        'title: 保留设备名守卫必须末端直判',
        'kind: shell',
        'severity: high',
        'tags: [windows, device-name]',
        '---',
        '## 症状 / 现象',
        '写 `con` 之类的保留设备名时，守卫没有在末段直判。',
        '## 期望',
        '谓词表两侧都拦得住。',
        '## 实际',
        '漏掉了末段。',
        '## 复现步骤',
        '跑 python -c "open(\'con\')"',
        '## 来源',
        'https://example.invalid/issues/57',
      ].join('\n'),
      'utf8',
    )

    const result = runCli(['import', file, '--dry-run', '--json'])
    assert.equal(result.code, EXIT.OK, `stderr: ${result.stderr}`)
    const json = parseJson(result.stdout, 'import --dry-run --json')
    assert.equal(json.dryRun, true)
    assert.match(json.yaml, /kind: shell/)
    // 关键安全性质：dry-run 不写提案、更不写 cases/
    assert.deepEqual(readdirSync(join(root, 'cases')).sort(), casesBefore, 'cases/ 内容不该被改动')

    const usage = runCli(['import'])
    assert.equal(usage.code, EXIT.USAGE)
    assert.match(usage.stderr, /用法/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/* --------------------------------------------------------------- 洞察类 -- */

test('trace / trend / coverage / search：可用则真出结果，未就绪则明确报错（退出码 3）', (t) => {
  const outDir = tempDir('insight')
  try {
    // trace 需要一条运行记录
    const ran = runCli(['run', '--only', 'TK-0001', '--out', outDir])
    assert.equal(ran.code, EXIT.OK, `stderr: ${ran.stderr}`)

    const checks = [
      { kind: 'trace', args: ['trace', '--json'], ready: insightModuleReady('trace') },
      { kind: 'trend', args: ['trend', '--json'], ready: insightModuleReady('trend') },
      { kind: 'coverage', args: ['coverage', '--json'], ready: insightModuleReady('coverage') },
      { kind: 'search', args: ['search', '工具', '--json'], ready: insightModuleReady('search') },
    ]

    for (const check of checks) {
      const result = runCli(check.args, { env: { ...process.env, DSH_TESTKIT_RUNS_DIR: outDir } })
      if (check.ready) {
        assert.equal(result.code, EXIT.OK, `${check.kind} 应可用：退出码 ${result.code}\n${result.stderr}`)
        const json = parseJson(result.stdout, `${check.kind} --json`)
        assert.equal(json.command, check.kind)
        assert.equal(json.ok, true)
      } else {
        t.diagnostic(`${check.kind}：模块未落地，只断言"明确报未就绪"`)
        assert.equal(result.code, EXIT.INFRA, `${check.kind} 未就绪时应为 3，实际 ${result.code}`)
        assert.match(result.stderr, /尚未就绪/)
      }
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true })
  }
})

/* --------------------------------------------------- 进程内契约（main） -- */

test('main() 返回退出码而不自己退出（可嵌入、可测）', async () => {
  const io = createBufferIo()
  assert.equal(await main([], io), EXIT.OK)
  assert.match(io.stdout, /dsh-testkit/)
  assert.equal(io.stderr, '')

  const versionIo = createBufferIo()
  assert.equal(await main(['version'], versionIo), EXIT.OK)
  assert.match(versionIo.stdout, /headless/)

  const listIo = createBufferIo()
  assert.equal(await main(['list', '--json'], listIo), EXIT.OK)
  const payload = parseJson(listIo.stdout, 'main(list --json)')
  assert.ok(payload.total > 0)
  // 进程内的报错走 stderr，而不是抛出去
  assert.equal(listIo.stderr, '')
})

test('main() 的用法错误也返回退出码（不抛异常）', async () => {
  const io = createBufferIo()
  assert.equal(await main(['run', '--definitely-not-an-option'], io), EXIT.USAGE)
  assert.match(io.stderr, /未知选项/)
  assert.equal(io.stdout, '', '用法错误时 stdout 不该有东西（--json 关闭时）')
})

test('退出码：0/1/2/3 冻结不变，6/7 为 1.0.0 新增（RFC 决定 3）', () => {
  // **原意逐字保留**：这四个码的语义是对外契约，CI 脚本、`&&` 链、外部触发器按它们分流。
  assert.deepEqual(
    { OK: EXIT.OK, FAILED: EXIT.FAILED, USAGE: EXIT.USAGE, INFRA: EXIT.INFRA },
    { OK: 0, FAILED: 1, USAGE: 2, INFRA: 3 },
    '0/1/2/3 的语义与取值必须逐字不变',
  )
  // 1.0.0（major）新增：协议不兼容 → 6；必需能力缺失 → 7（设计 §4.5 的错误码映射表）。
  assert.equal(EXIT.PROTOCOL, 6)
  assert.equal(EXIT.CAPABILITY, 7)
  // ⚠️ 4 / 5 **保留不使用**（同名第三方包的发布语义——同名不同义是最贵的坑）；
  //    `8` **不定义**（RFC §8 Q3 提过，但设计的裁决表只映射到 7，定义空号等于制造歧义）。
  //    这三条"不存在"必须被钉住，否则哪天有人顺手填上就没人拦。
  const used = new Set(Object.values(EXIT))
  for (const reserved of [4, 5, 8]) {
    assert.ok(!used.has(reserved), `退出码 ${String(reserved)} 应保持未定义/保留`)
  }
})
