/**
 * 供应链守卫的测试：**正向（真实仓库）+ 负向（人为违规必须红）**。
 *
 * ## 为什么负向用例是硬要求
 *
 * 静态守卫最典型的失效形态是"看起来很严，其实一条都没判"——正则写错、
 * 规则接错分支、`main()` 没被接进 gate，全都表现为**永远绿**。
 * 只写"真实仓库通过"是抓不到这类问题的（它本来就该通过）。
 * 所以每个判据都配一条人为违规的用例，并断言**命中的是哪条规则**
 * （`rule` 字段），而不是只看"有没有报错"。
 *
 * ## 真实仓库那几条
 *
 * 纯函数单测全绿、但真实 `.github/workflows/**` 里其实还有一处漏网，
 * 是这类守卫第二常见的失效形态。所以最后对**本仓真实文件**跑一遍：
 * 守卫必须绿，而且必须真的扫到了东西（`scanned` / `pins` / `checked` 有下界），
 * 否则"绿"可能只是"没扫到文件"。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  checkWorkflows,
  checkWorkflowText,
  collectWorkflows,
  extractUses,
  isExemptUses,
  PINNED_SHA_RE,
  RELEASE_WORKFLOW_RE,
  stripYamlComments,
} from '../scripts/check-ci-hardening.mjs'
import {
  checkImporterEntries,
  checkLockfile,
  checkPackageManager,
  expectedLockfileVersion,
  extractPnpmSetupVersions,
  parsePackageManager,
  readJsonFile,
  readYamlFile,
} from '../scripts/check-lockfile.mjs'
import {
  decideExitCode,
  parseRunSummary,
  resolveInputs,
  resolveIssueNumber,
} from '../scripts/action-entry.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function file(relPath, source) {
  return { relPath, source }
}

/** 违规命中的规则名（排序，便于 deepEqual）。 */
function rules(violations) {
  return violations.map((item) => item.rule).sort()
}

/* ------------------------------------------------------ CI 硬化：正例基线 -- */

/** 一份**完全合规**的工作流：负向用例都在它上面改一处（改什么一目了然）。 */
const GOOD = [
  'name: T',
  'on:',
  "  push:",
  "    branches: ['**']",
  'permissions:',
  '  contents: read',
  'jobs:',
  '  gate:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4',
  '      - run: pnpm install --frozen-lockfile',
  '',
].join('\n')

/** 合规的发布流：只申请 contents: read + id-token: write。 */
const GOOD_RELEASE = [
  'name: Release',
  'on:',
  '  push:',
  "    tags: ['v*']",
  'permissions:',
  '  contents: read',
  '  id-token: write',
  'jobs:',
  '  publish:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4',
  '      - run: pnpm install --frozen-lockfile',
  '      - run: npm publish --provenance --access public',
  '',
].join('\n')

test('基线：合规工作流零违规（后面每条负向只改一处）', () => {
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', GOOD)), [])
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/release.yml', GOOD_RELEASE)), [])
  assert.equal(RELEASE_WORKFLOW_RE.test('release.yml'), true)
  assert.equal(RELEASE_WORKFLOW_RE.test('.github/workflows/release.yml'), true)
  assert.equal(RELEASE_WORKFLOW_RE.test('ci.yml'), false)
})

/* ------------------------------------------------ CI 硬化：负向（必须红） -- */

test('负向①：uses 用可变标签 @v4 → uses-unpinned 并点名行号', () => {
  const bad = GOOD.replace(/actions\/checkout@[0-9a-f]{40} # v4/, 'actions/checkout@v4')
  const violations = checkWorkflowText('.github/workflows/ci.yml', bad)
  assert.deepEqual(rules(violations), ['uses-unpinned'])
  assert.match(violations[0].where, /^\.github\/workflows\/ci\.yml:\d+$/)
  assert.match(violations[0].message, /actions\/checkout@v4/)
})

test('负向②：钉了 SHA 但没写 # <ref> → uses-ref-comment', () => {
  const bad = GOOD.replace(' # v4', '')
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['uses-ref-comment'])
})

test('负向③：pull_request_target → 报（fork 上会拿到仓库级权限）', () => {
  const bad = GOOD.replace("  push:\n", '  push:\n  pull_request_target:\n')
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['pull-request-target'])
})

test('负向④：出现 secrets. 引用 → 报（本仓的门必须零 secret）', () => {
  const bad = GOOD.replace(
    '      - run: pnpm install --frozen-lockfile',
    '      - run: pnpm install --frozen-lockfile\n        env:\n          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
  )
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['secrets'])
})

test('负向⑤：缺顶层 permissions → permissions-missing', () => {
  const bad = GOOD.replace('permissions:\n  contents: read\n', '')
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['permissions-missing'])
})

test('负向⑥：非发布流申请 contents: write → permissions-write', () => {
  const bad = GOOD.replace('  contents: read', '  contents: write')
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['permissions-write'])
})

test('负向⑦：发布流缺 id-token: write / contents 不是 read → 各自的规则', () => {
  const noIdToken = GOOD_RELEASE.replace('  id-token: write\n', '')
  assert.ok(rules(checkWorkflowText('.github/workflows/release.yml', noIdToken)).includes('release-permissions-missing-id-token'))

  const writeContents = GOOD_RELEASE.replace('  contents: read', '  contents: write')
  const found = rules(checkWorkflowText('.github/workflows/release.yml', writeContents))
  assert.ok(found.includes('permissions-write'), 'contents: write 必须报')
  assert.ok(found.includes('release-permissions-missing-contents-read'), 'contents 不是 read 必须报')
})

test('负向⑧：continue-on-error: true → 报（它把红变绿）', () => {
  const bad = GOOD.replace(
    '      - run: pnpm install --frozen-lockfile',
    '      - run: pnpm install --frozen-lockfile\n        continue-on-error: true',
  )
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['continue-on-error'])
})

test('负向⑨：pnpm install 没带 --frozen-lockfile → 报；带了才放行', () => {
  const bad = GOOD.replace('pnpm install --frozen-lockfile', 'pnpm install')
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', bad)), ['frozen-lockfile'])
})

test('负向⑩：CI 里改依赖树（pnpm add）→ deps-mutating-command', () => {
  const bad = GOOD.replace('      - run: pnpm install --frozen-lockfile', '      - run: pnpm add left-pad')
  const found = rules(checkWorkflowText('.github/workflows/ci.yml', bad))
  assert.ok(found.includes('deps-mutating-command'))
})

test('负向⑪：整片工作流都没有 --frozen-lockfile → 全局规则报', () => {
  const { violations, scanned, pins } = checkWorkflows([file('.github/workflows/ci.yml', GOOD.replace(' --frozen-lockfile', ''))])
  assert.equal(scanned, 1)
  assert.equal(pins, 1)
  assert.ok(rules(violations).includes('frozen-lockfile-missing'))
})

test('负向⑫：YAML 解析失败要报 yaml-parse（而不是静默跳过权限检查）', () => {
  const found = rules(checkWorkflowText('.github/workflows/ci.yml', 'name: [unclosed\n'))
  assert.ok(found.includes('yaml-parse'))
  // 解析不出文档时权限判据无从进行——但 yaml-parse 本身已经让守卫红，
  // 所以不会出现"解析失败 → 什么都不报 → 看起来合规"的静默形态。
})

test('注释不算依赖也不该误报（剥离注释后才判）', () => {
  const commented = GOOD.replace(
    'permissions:',
    '# uses: actions/checkout@v4 是错的写法\n# secrets.NPM_TOKEN 也不要\npermissions:',
  )
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', commented)), [])
  assert.ok(stripYamlComments("a: 'x # y' # z").includes("'x # y'"), '引号里的 # 不是注释')
})

test('本地 composite action 与 docker:// 不要求钉 SHA', () => {
  assert.equal(isExemptUses('./.github/actions/local'), true)
  assert.equal(isExemptUses('docker://alpine:3.20'), true)
  assert.equal(isExemptUses('actions/checkout@v4'), false)

  const local = GOOD.replace(
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4',
    '      - uses: ./.github/actions/local',
  )
  assert.deepEqual(rules(checkWorkflowText('.github/workflows/ci.yml', local)), [])
  assert.deepEqual(extractUses(local).map((u) => u.specifier), ['./.github/actions/local'])
})

/* --------------------------------------------------------- 锁文件：负向 -- */

const PKG = {
  name: 'demo',
  version: '1.0.0',
  packageManager: 'pnpm@11.7.0',
  dependencies: { yaml: '^2.6.0' },
  devDependencies: { typescript: '^5.6.0' },
  peerDependencies: { cordis: '>=4.0.4' },
  peerDependenciesMeta: { cordis: { optional: true } },
}

const LOCK = {
  lockfileVersion: '9.0',
  importers: {
    '.': {
      dependencies: { yaml: { specifier: '^2.6.0', version: '2.9.1' } },
      devDependencies: { typescript: { specifier: '^5.6.0', version: '5.9.3' } },
    },
  },
  packages: { 'yaml@2.9.1': {}, 'typescript@5.9.3': {}, 'cordis@4.0.4': {} },
}

test('锁文件基线：一致时零违规', () => {
  const { violations, checked } = checkImporterEntries(PKG, LOCK)
  assert.deepEqual(violations, [])
  assert.equal(checked, 3, 'dependencies + devDependencies + peer 各一项')
  assert.deepEqual(checkPackageManager({ pkg: PKG, lock: LOCK }), [])
})

test('负向⑬：package.json 有、lockfile importer 没有 → lockfile-missing-dep', () => {
  const lock = { ...LOCK, importers: { '.': { devDependencies: LOCK.importers['.'].devDependencies } } }
  const found = rules(checkImporterEntries(PKG, lock).violations)
  assert.ok(found.includes('lockfile-missing-dep'))
})

test('负向⑭：范围与 lockfile specifier 不一致 → lockfile-specifier-mismatch', () => {
  const lock = JSON.parse(JSON.stringify(LOCK))
  lock.importers['.'].devDependencies.typescript.specifier = '^5.0.0'
  const violations = checkImporterEntries(PKG, lock).violations
  assert.deepEqual(rules(violations), ['lockfile-specifier-mismatch'])
  assert.match(violations[0].message, /\^5\.0\.0.*\^5\.6\.0/)
})

test('负向⑮：lockfile 没有根 importer → lockfile-importer-missing', () => {
  assert.deepEqual(rules(checkImporterEntries(PKG, { lockfileVersion: '9.0' }).violations), [
    'lockfile-importer-missing',
  ])
})

test('负向⑯：peer 在 importer 与 packages 都找不到 → lockfile-missing-peer', () => {
  const pkg = { ...PKG, peerDependencies: { ghost: '^1.0.0' }, peerDependenciesMeta: {} }
  const violations = checkImporterEntries(pkg, LOCK).violations
  assert.ok(rules(violations).includes('lockfile-missing-peer'))
})

test('负向⑰：非 optional peer 只出现在 packages 里 → lockfile-missing-required-peer', () => {
  const pkg = { ...PKG, peerDependenciesMeta: {} } // cordis 变成非 optional，且不在 importer
  const violations = checkImporterEntries(pkg, LOCK).violations
  assert.deepEqual(rules(violations), ['lockfile-missing-required-peer'])
})

test('负向⑱：packageManager 缺失 / 形态错 / 不是 pnpm → 各自报', () => {
  assert.deepEqual(rules(checkPackageManager({ pkg: { ...PKG, packageManager: undefined }, lock: LOCK })), [
    'package-manager-missing',
  ])
  assert.deepEqual(rules(checkPackageManager({ pkg: { ...PKG, packageManager: 'pnpm' }, lock: LOCK })), [
    'package-manager-malformed',
  ])
  assert.deepEqual(
    rules(checkPackageManager({ pkg: { ...PKG, packageManager: 'npm@11.0.0' }, lock: LOCK })),
    ['package-manager-not-pnpm'],
  )
})

test('负向⑲：lockfileVersion 与 pnpm 大版本不符 → lockfile-version-mismatch', () => {
  const violations = checkPackageManager({ pkg: PKG, lock: { ...LOCK, lockfileVersion: '8.0' } })
  assert.deepEqual(rules(violations), ['lockfile-version-mismatch'])
  assert.equal(expectedLockfileVersion(11), '9.0')
  assert.equal(expectedLockfileVersion(8), '8.0')
  assert.deepEqual(parsePackageManager('pnpm@11.7.0'), { name: 'pnpm', version: '11.7.0', major: 11 })
  assert.equal(parsePackageManager('nonsense'), undefined)
})

const SETUP_WORKFLOW = [
  'name: CI',
  'on:',
  '  push:',
  'permissions:',
  '  contents: read',
  'jobs:',
  '  gate:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4',
  '        with:',
  '          version: 11.7.0',
  '      - run: pnpm install --frozen-lockfile',
  '',
].join('\n')

test('负向⑳：CI 的 pnpm 版本与 packageManager 漂移 → pnpm-version-drift / undeclared', () => {
  const drift = SETUP_WORKFLOW.replace('version: 11.7.0', 'version: 9.0.0')
  const violations = checkPackageManager({
    pkg: PKG,
    lock: LOCK,
    workflows: [file('.github/workflows/ci.yml', drift)],
  })
  assert.deepEqual(rules(violations), ['pnpm-version-drift'])

  const undeclared = SETUP_WORKFLOW.replace('        with:\n          version: 11.7.0\n', '')
  assert.deepEqual(
    rules(checkPackageManager({ pkg: PKG, lock: LOCK, workflows: [file('.github/workflows/ci.yml', undeclared)] })),
    ['pnpm-version-undeclared'],
  )

  const extracted = extractPnpmSetupVersions([file('.github/workflows/ci.yml', SETUP_WORKFLOW)])
  assert.equal(extracted.length, 1)
  assert.equal(extracted[0].version, '11.7.0')
  assert.match(extracted[0].where, /jobs\.gate\.steps\[0\]/)
})

test('负向㉑：已安装的 packageManager 与声明不一致 → installed-package-manager-drift', () => {
  const violations = checkPackageManager({
    pkg: PKG,
    lock: LOCK,
    modulesYaml: { packageManager: 'pnpm@10.0.0' },
  })
  assert.deepEqual(rules(violations), ['installed-package-manager-drift'])
})

/* --------------------------------------------- 真实仓库（守卫真的接上了） -- */

test('真实工作流：check-ci-hardening 零违规，且确实扫到了文件', () => {
  const files = collectWorkflows(root)
  assert.ok(files.length >= 2, `应扫到 ci.yml 与 release.yml，实际 ${files.length} 份`)
  const { violations, scanned, pins } = checkWorkflows(files)
  assert.deepEqual(
    violations.map((item) => item.message),
    [],
  )
  assert.equal(scanned, files.length)
  assert.ok(pins >= 6, `ci.yml + release.yml 至少 6 个 uses 已钉 SHA，实际 ${pins}`)
})

test('真实工作流：所有非本地 uses 都是 40 位 SHA 且带 # <ref>', () => {
  const files = collectWorkflows(root)
  const external = files.flatMap((f) =>
    extractUses(f.source)
      .filter((use) => !isExemptUses(use.specifier))
      .map((use) => ({ relPath: f.relPath, ...use })),
  )
  assert.ok(external.length >= 6)
  for (const use of external) {
    const ref = use.specifier.slice(use.specifier.lastIndexOf('@') + 1)
    assert.ok(PINNED_SHA_RE.test(ref), `${use.relPath}:${use.line} 未钉 SHA：${use.specifier}`)
    assert.notEqual(use.refComment, '', `${use.relPath}:${use.line} 缺 # <ref> 注释`)
  }
})

test('真实 release.yml：provenance + OIDC 权限 + 发布清单关键目录都在', () => {
  const release = collectWorkflows(root).find((f) => f.relPath.endsWith('release.yml'))
  assert.ok(release, 'release.yml 必须存在')
  assert.match(release.source, /id-token: write/)
  assert.match(release.source, /contents: read/)
  assert.match(release.source, /pnpm install --frozen-lockfile/)
  assert.match(release.source, /npm publish --provenance --access public/)
  assert.match(release.source, /tags: \['v\*'\]/)
  // 发布清单断言必须覆盖这些目录（缺一件就是"装出来才报错"）
  for (const dir of ['bin/', 'lib/cli/', 'schemas/', 'cases/', 'fixtures/', 'registry/', 'templates/', 'dsh/']) {
    assert.ok(release.source.includes(`'${dir}'`), `release.yml 的清单断言缺少 ${dir}`)
  }
  // 风险声明必须在（打 tag 即发布 / 先做活宿主验证）
  assert.match(release.source, /打 tag 即发布/)
  assert.match(release.source, /活宿主验证/)
})

test('真实 ci.yml：审计是独立步骤，gate 仍是同一条命令', () => {
  const ci = collectWorkflows(root).find((f) => f.relPath.endsWith('ci.yml'))
  assert.ok(ci, 'ci.yml 必须存在')
  assert.match(ci.source, /pnpm audit --prod --audit-level=high/)
  assert.match(ci.source, /run: pnpm run gate/)
  assert.doesNotMatch(ci.source, /audit[^\n]*&&[^\n]*gate/, '审计不得与 gate 串成一条命令')
  // 审计必须注明"需要网络 / 不在 gate 内"的分工
  assert.match(ci.source, /不在 gate/)
})

test('真实仓库：check-lockfile 零违规，且真的比对到了依赖', () => {
  const pkg = readJsonFile(join(root, 'package.json')).value
  const lock = readYamlFile(join(root, 'pnpm-lock.yaml')).value
  const modulesPath = join(root, 'node_modules', '.modules.yaml')
  const modulesYaml = existsSync(modulesPath) ? readJsonFile(modulesPath).value : undefined
  const workflows = collectWorkflows(root)

  const { violations, checked, declared } = checkLockfile({ pkg, lock, workflows, modulesYaml })
  assert.deepEqual(
    violations.map((item) => item.message),
    [],
  )
  assert.ok(declared >= 15, `声明依赖应有 ${declared} 项`)
  assert.equal(checked, declared, '每一项都应被比对到')
  assert.equal(pkg.packageManager, 'pnpm@11.7.0', 'packageManager 必须钉住，且与 CI 一致')
})

/* ------------------------------------------------- action-entry 纯函数 -- */

test('action-entry：输入解析（默认 / env / 命令行优先级）', () => {
  assert.deepEqual(resolveInputs({}, []), {
    report: 'run.json',
    comment: false,
    token: '',
    failOn: 'failed',
  })
  const fromEnv = resolveInputs(
    { DSH_TESTKIT_REPORT: 'runs/x/run.json', DSH_TESTKIT_COMMENT: 'true', DSH_TESTKIT_TOKEN: 't', DSH_TESTKIT_FAIL_ON: 'never' },
    [],
  )
  assert.deepEqual(fromEnv, { report: 'runs/x/run.json', comment: true, token: 't', failOn: 'never' })
  // INPUT_* 形式（JS action 的惯例）也要认
  assert.equal(resolveInputs({ INPUT_REPORT: 'a.json' }, []).report, 'a.json')
  // 命令行优先
  assert.equal(resolveInputs({ DSH_TESTKIT_REPORT: 'a.json' }, ['--report=b.json']).report, 'b.json')
})

test('action-entry：fail-on 决定退出码，非法取值必须抛', () => {
  const failed = { totals: { failed: 1, errored: 0 } }
  const clean = { totals: { failed: 0, errored: 0 } }
  const errored = { totals: { failed: 0, errored: 2 } }
  assert.equal(decideExitCode(clean, 'failed'), 0)
  assert.equal(decideExitCode(failed, 'failed'), 1)
  assert.equal(decideExitCode(errored, 'failed'), 1)
  assert.equal(decideExitCode(failed, 'never'), 0)
  assert.throws(() => decideExitCode(clean, 'sometimes'), /fail-on/)
})

test('action-entry：run.json 形态不对要点名报错（不猜）', () => {
  assert.throws(() => parseRunSummary('not json', 'x.json'), /不是合法 JSON/)
  assert.throws(() => parseRunSummary('{}', 'x.json'), /RunSummary/)
  const summary = parseRunSummary('{"totals":{},"cases":[]}', 'x.json')
  assert.deepEqual(summary.cases, [])
  assert.equal(resolveIssueNumber({ GITHUB_REF: 'refs/pull/42/merge' }), 42)
  assert.equal(resolveIssueNumber({ GITHUB_REF: 'refs/heads/main' }), undefined)
})

/* --------------------------- 端到端负向：守卫脚本本身必须红（exit 1） --------------------------- */

/**
 * 在临时目录里跑守卫脚本，返回 `{ status, output }`。
 *
 * 输出走**文件描述符**而不是管道：本仓的沙箱环境里"用管道捕获子进程输出"
 * 有已知限制，文件方式在受限与不受限环境下都稳。
 */
function runGuard(scriptRel, fixtureRoot) {
  const logPath = join(tmpdir(), `dsh-testkit-guard-${randomUUID()}.log`)
  const fd = openSync(logPath, 'w')
  try {
    const result = spawnSync(process.execPath, [join(root, scriptRel), fixtureRoot], {
      cwd: root,
      stdio: ['ignore', fd, fd],
    })
    return { status: result.status, output: readFileSync(logPath, 'utf8') }
  } finally {
    closeSync(fd)
    rmSync(logPath, { force: true })
  }
}

function withFixture(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-guard-'))
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, content, 'utf8')
    }
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('负向（端到端）：人为违规的工作流 → 守卫脚本以 1 退出并点名规则', () => {
  const bad = GOOD.replace(/actions\/checkout@[0-9a-f]{40} # v4/, 'actions/checkout@v4').replace(
    'pnpm install --frozen-lockfile',
    'pnpm install',
  )
  withFixture({ '.github/workflows/ci.yml': bad }, (dir) => {
    const { status, output } = runGuard('scripts/check-ci-hardening.mjs', dir)
    assert.equal(status, 1, `守卫必须红，实际 exit=${status}\n${output}`)
    assert.match(output, /uses-unpinned/)
    assert.match(output, /frozen-lockfile/)
  })
})

test('负向（端到端）：package.json 有、lockfile 没有 → 锁文件守卫以 1 退出并点名规则', () => {
  withFixture(
    {
      'package.json': JSON.stringify({
        name: 'x',
        version: '1.0.0',
        packageManager: 'pnpm@11.7.0',
        dependencies: { yaml: '^2.6.0' },
      }),
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies: {}\n",
    },
    (dir) => {
      const { status, output } = runGuard('scripts/check-lockfile.mjs', dir)
      assert.equal(status, 1, `守卫必须红，实际 exit=${status}\n${output}`)
      assert.match(output, /lockfile-missing-dep/)
    },
  )
})

test('正向（端到端）：合规的临时仓库 → 两个守卫脚本都以 0 退出', () => {
  withFixture(
    {
      '.github/workflows/ci.yml': GOOD,
      'package.json': JSON.stringify({
        name: 'x',
        version: '1.0.0',
        packageManager: 'pnpm@11.7.0',
        dependencies: { yaml: '^2.6.0' },
      }),
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    dependencies:',
        '      yaml:',
        '        specifier: ^2.6.0',
        '        version: 2.9.1',
        '',
        'packages:',
        '',
        '  yaml@2.9.1: {}',
        '',
      ].join('\n'),
    },
    (dir) => {
      const ci = runGuard('scripts/check-ci-hardening.mjs', dir)
      assert.equal(ci.status, 0, ci.output)
      const lock = runGuard('scripts/check-lockfile.mjs', dir)
      assert.equal(lock.status, 0, lock.output)
    },
  )
})
