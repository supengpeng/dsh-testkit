/**
 * bundle patch 守卫的回归测试（`scripts/check-bundle-patch.mjs`）。
 *
 * ## 为什么这条必须有测试
 *
 * 它守的是一个**只在活宿主上才看得见**的静默失败：`dsh/cordis.patch.yml` 里的
 * `name` 是 Node 模块说明符，改名后没同步（`name: dsh-testkit` 而包名已是
 * `@supengpeng/dsh-testkit`）时——
 *
 *   · 宿主半照样加载（HTTP bridge 还是通的，`/testkit list` 也有输出）；
 *   · **client 半静默不进启动图**：页面里搜不到 `<name>/client.js`，「测试」标签不出现；
 *   · `verify:cases` / `verify:docs` / `check-pack-files` 全部照绿。
 *
 * 也就是说：**没有这条判据，这个 bug 只有靠人打开浏览器看标签才能发现。**
 * 测试用"临时包目录"造正反两个用例（守卫支持 `<包目录>` 参数），
 * 这样负向证明与真仓库状态无关。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const GUARD = join(ROOT, 'scripts', 'check-bundle-patch.mjs')

/** 造一个最小"包"：package.json（含 dsh.bundle.patch）+ 指定内容的 patch。 */
function makePackage(label, { packageName, patchEntryName, patchText }) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-testkit-patch-${label}-`))
  mkdirSync(join(dir, 'dsh'), { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: packageName,
        version: '0.0.0',
        dsh: { bundle: { patch: './dsh/cordis.patch.yml' } },
      },
      null,
      2,
    )}\n`,
  )
  const text =
    patchText ??
    `- insert:\n    - id: dsh-testkit\n      name: ${JSON.stringify(patchEntryName)}\n`
  writeFileSync(join(dir, 'dsh', 'cordis.patch.yml'), text)
  return dir
}

function runGuard(root) {
  const result = spawnSync(process.execPath, [GUARD, root], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

test('真仓库：patch 条目名与包名一致 → 守卫通过', () => {
  const { status, stdout } = runGuard(ROOT)
  assert.equal(status, 0, `真仓库的 bundle patch 应通过：${stdout}`)
  assert.match(stdout, /check-bundle-patch\] OK/)
})

test('负向：patch 里写旧包名 → 守卫必须红（client 半会静默不进启动图）', () => {
  const dir = makePackage('stale', {
    packageName: '@supengpeng/dsh-testkit',
    patchEntryName: 'dsh-testkit',
  })
  try {
    const { status, stderr } = runGuard(dir)
    assert.equal(status, 1, '旧名必须被拦下')
    assert.match(stderr, /与 package.json 的 name/)
    assert.match(stderr, /client 半静默不进启动图/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正向对照：同结构的合规包 → 守卫通过（证明不是"一律报错"）', () => {
  const dir = makePackage('good', {
    packageName: '@supengpeng/dsh-testkit',
    patchEntryName: '@supengpeng/dsh-testkit',
  })
  try {
    assert.equal(runGuard(dir).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('负向：patch 里没有 insert 条目 → 装进 profile 也不会挂载', () => {
  const dir = makePackage('empty', {
    packageName: '@supengpeng/dsh-testkit',
    patchEntryName: '@supengpeng/dsh-testkit',
    patchText: '# 空 patch\n- config: {}\n',
  })
  try {
    const { status, stderr } = runGuard(dir)
    assert.equal(status, 1)
    assert.match(stderr, /没有任何 `insert:` 条目/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('负向：重复 id → 加载器起不来', () => {
  const dir = makePackage('dup', {
    packageName: '@supengpeng/dsh-testkit',
    patchEntryName: '@supengpeng/dsh-testkit',
    patchText:
      '- insert:\n' +
      '    - id: dsh-testkit\n      name: "@supengpeng/dsh-testkit"\n' +
      '    - id: dsh-testkit\n      name: "@supengpeng/dsh-testkit"\n',
  })
  try {
    const { status, stderr } = runGuard(dir)
    assert.equal(status, 1)
    assert.match(stderr, /重复/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
