/**
 * 文档守卫（`scripts/verify-docs.mjs`）的回归用例。
 *
 * 这个守卫是"文档 ↔ 实现"的判据，所以**它自己出错代价很高**：
 *   · 假阳性 → 逼人绕过守卫（`fx.add()` 已经造成过一次）
 *   · 假阴性 → 真漂移被放过
 * 两侧都要有钉子，所以下面每条"必须报"的用例旁边都有一条"必须不报"的对照。
 *
 * `checkDocument()` 被设计成纯函数（存在性判定走注入的 `ctx.exists`），
 * 所以这里不需要构造真实仓库文件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'

import {
  checkDocument,
  collectCliSubcommandCount,
  collectFixtureApi,
  collectGuardCount,
  collectKnownRefs,
  root,
} from '../scripts/verify-docs.mjs'

/**
 * 构造受控上下文：除 `missing` 里列出的路径外，一律视为"存在"。
 * `cliSubcommands` / `guardCount` 缺省为 `null` = 不校验计数（像旧版守卫那样）。
 * @param {{missing?: string[], knownRefs?: string[], fixtureApi?: string[],
 *          knownScripts?: string[], actualCaseCount?: number,
 *          cliSubcommands?: number|null, guardCount?: number|null}} [overrides]
 */
function ctxOf(overrides = {}) {
  const missing = overrides.missing ?? []
  return {
    knownRefs: new Set(overrides.knownRefs ?? ['callCount', 'resultValue']),
    fixtureApi: new Set(
      overrides.fixtureApi ?? ['add', 'note', 'noteAppend', 'getNote', 'snapshot', 'release'],
    ),
    knownScripts: new Set(overrides.knownScripts ?? ['gate', 'verify:docs']),
    actualCaseCount: overrides.actualCaseCount ?? 39,
    repoRoot: 'C:/repo',
    exists: (p) => {
      const s = String(p).replace(/\\/g, '/')
      return !missing.some((m) => s.endsWith(m))
    },
    cliSubcommands: overrides.cliSubcommands ?? null,
    guardCount: overrides.guardCount ?? null,
  }
}

function problemsOf(text, overrides) {
  return checkDocument({ rel: 'docs/X.md', text, ctx: ctxOf(overrides) })
}

/* ---------------------------------------------------- ① fx.* 的两侧钉子 -- */

test('fx.add() 是 Fixture 的 API，不算取证字段漂移（假阳性回归）', () => {
  assert.deepEqual(problemsOf('所有干预必须经 `fx.add()` 登记，逆序释放。'), [])
})

test('fx.getNote() / fx.notes 同样豁免（方法与 getter）', () => {
  assert.deepEqual(problemsOf('读 `fx.getNote(k)`，或直接遍历 `fx.notes`。'), [])
})

test('真正的未知取证字段必须被抓（负向证明）', () => {
  const problems = problemsOf('断言 fx.definitelyNotAFieldXYZ 应为真')
  assert.equal(problems.length, 1)
  assert.match(problems[0], /fx\.definitelyNotAFieldXYZ/)
})

test('真实存在的取证字段不报错', () => {
  assert.deepEqual(problemsOf('`fx.callCount` 应为 1'), [])
})

test('代码围栏内的 fx.* 不参与检查（示例不是契约）', () => {
  const text = ['```', 'fx.add()', 'fx.notARealFieldEither', '```'].join('\n')
  assert.deepEqual(problemsOf(text), [])
})

/* ------------------------------------------------- ③④⑤ 其余检查的两侧钉子 -- */

test('不存在的 pnpm run 脚本被抓；存在的不报', () => {
  const bad = problemsOf('跑 pnpm run verify:nonexistent 即可')
  assert.equal(bad.length, 1)
  assert.match(bad[0], /verify:nonexistent/)

  assert.deepEqual(problemsOf('跑 pnpm run gate 即可'), [])
})

test('不存在的 scripts/*.mjs 被抓', () => {
  const problems = problemsOf('见 scripts/definitely-missing.mjs', {
    missing: ['scripts/definitely-missing.mjs'],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /definitely-missing\.mjs/)
})

test('cases 场景数量声明不符被抓；相符不报', () => {
  const bad = problemsOf('`cases/` 下 **99 条场景**', { actualCaseCount: 39 })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /99 条场景/)

  assert.deepEqual(problemsOf('`cases/` 下 **39 条场景**', { actualCaseCount: 39 }), [])
})

test('仓库内不存在的相对链接被抓；http 链接与纯锚点不报', () => {
  const bad = problemsOf('见 [x](docs/nope.md)', { missing: ['docs/nope.md'] })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /docs\/nope\.md/)

  assert.deepEqual(problemsOf('见 [x](https://example.com) 与 [y](#sec)'), [])
})

/* ---------------------------------------------- ⑥⑦ 计数真源的两侧钉子 -- */

test('CLI 子命令数与真源不符被抓；相符不报；缺省不校验', () => {
  const bad = problemsOf('共 15 个 CLI 子命令', { cliSubcommands: 16 })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /15 个 CLI 子命令/)

  assert.deepEqual(problemsOf('共 16 个 CLI 子命令', { cliSubcommands: 16 }), [])
  // 缺省 null：像旧版守卫一样不校验，避免"真源取不到就全红"
  assert.deepEqual(problemsOf('共 15 个 CLI 子命令'), [])
})

test('质量守卫数与真源不符被抓；相符不报', () => {
  const bad = problemsOf('10 个守卫全绿', { guardCount: 11 })
  assert.equal(bad.length, 1)
  assert.match(bad[0], /10 个守卫/)

  assert.deepEqual(problemsOf('11 个守卫全绿', { guardCount: 11 }), [])
})

test('历史/过程文档豁免计数校验（不篡改审计痕迹）', () => {
  const ctx = ctxOf({ cliSubcommands: 16, guardCount: 11 })
  const problems = checkDocument({
    rel: 'docs/OPTIMIZATION-REVIEW-2026-10.md',
    text: '结论读数：CLI 15 个子命令 · 10 个守卫全绿 · 16 个 CLI 子命令',
    ctx,
  })
  assert.deepEqual(problems, [])
})

/* ------------------------------------------------------------ 真源提取 -- */

test('真源：Fixture API 从 src/runtime/fixture.ts 提取到预期方法', () => {
  const api = collectFixtureApi(root)
  for (const name of ['add', 'note', 'noteAppend', 'getNote', 'snapshot', 'release']) {
    assert.ok(api.has(name), `Fixture API 应含 ${name}`)
  }
  // 参数名/注释里的词不该被收进来 —— 剥注释这条不能省
  assert.ok(!api.has('label'), '不应把参数名 label 当成方法名')
  assert.ok(!api.has('dispose'), '不应把参数类型里的 dispose 当成方法名')
})

test('真源：取证字段集合非空（守卫不是在空集上放行）', () => {
  const refs = collectKnownRefs(join(root, 'src'))
  assert.ok(refs.size > 0, 'note()/noteAppend() 字段集合不应为空')
})

test('真源：CLI 子命令数与守卫数可提取且为正整数', () => {
  const cli = collectCliSubcommandCount(root)
  const guards = collectGuardCount(root)
  assert.ok(Number.isInteger(cli) && cli > 0, `CLI 子命令数应可提取，实得 ${cli}`)
  assert.ok(Number.isInteger(guards) && guards > 0, `守卫数应可提取，实得 ${guards}`)
  // CLI 子命令数是对外契约（文档会引用它），值得钉死
  assert.equal(cli, 16)
  // 守卫数会随版本增长，只断言下界——写死会在加守卫时假红（本测试就被 verify:encoding 触发过一次）
  assert.ok(guards >= 11, `守卫数应 ≥ 11，实得 ${guards}`)
})
