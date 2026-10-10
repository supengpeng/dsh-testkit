/**
 * 自举契约测试（self-bootstrap）。
 *
 * ## 它守住什么
 *
 * 本仓的核心主张是「**插件自己测自己**」：`cases/` 里的场景由 `src/kinds/` 的 driver 驱动，
 * 而驱动结果反过来证明这些 driver 是活的。这个闭环有三个不显眼但会静默失效的前提：
 *
 *   ① `SCENARIO_KINDS`（类型层常量）与 `createDriverRegistry()`（运行时注册表）必须**同集**。
 *      少一个 → 用户写出的合法场景被 schema 拒绝；多一个 → 文档/校验器与实现对不上。
 *      （`scripts/verify-cases.mjs` 从另一侧守这件事，这里从注册表侧再守一遍。）
 *   ② 每个 driver 必须带非空 `kind` / `description`，且 `kind` 与注册键一致。
 *      描述为空不会让任何测试变红，但会让 `/testkit list` 与报告的"覆盖什么"变成空白——
 *      这是典型的**不报错的失效**。
 *   ③ `llm` driver 的"零上游请求"必须是真的：调用计数取自 **headless 宿主暴露的真实适配器位**，
 *      而不是 driver 自己的记账。driver 自己数自己，永远数得出想要的数。
 *
 * ## 为什么单独一个文件
 *
 * 前两条是"结构契约"，会随新增 kind 而变；第三条是"能力承诺"，与具体场景无关。
 * 把它们从各 driver 的单测里提出来，是为了在**新增一个 kind 时必然撞到这里**——
 * 提醒作者把注册、描述、成本分级一起补齐，而不是只写一个 driver 文件。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { SCENARIO_KINDS } from '../lib/cases/types.js'
import { createHeadlessHost } from '../lib/headless/index.js'
import { createDriverRegistry } from '../lib/kinds/index.js'
import { llmDriver } from '../lib/kinds/llm.js'
import { Fixture } from '../lib/runtime/fixture.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/* -------------------------------------------------------- 结构契约（①②） -- */

test('自举契约：SCENARIO_KINDS 与注册表同集（不多不少）', () => {
  const registry = createDriverRegistry()
  const registered = [...registry.kinds()].sort()
  const declared = [...SCENARIO_KINDS].sort()

  const missing = declared.filter((kind) => registry.get(kind) === undefined)
  assert.deepEqual(
    missing,
    [],
    `SCENARIO_KINDS 里有 kind 没有对应 driver：${missing.join(', ')}` +
      '（用户写出的合法场景会在运行期找不到 driver）',
  )

  const extra = registered.filter((kind) => !SCENARIO_KINDS.includes(kind))
  assert.deepEqual(
    extra,
    [],
    `有 driver 注册了却没有登记进 SCENARIO_KINDS：${extra.join(', ')}` +
      '（schema 会拒绝这种 kind，等于这个 driver 永远跑不到）',
  )

  assert.deepEqual(registered, declared, '两侧必须完全同集')
  assert.equal(registered.length, SCENARIO_KINDS.length)
  assert.ok(registered.length >= 12, `driver 数量应不小于 12，实际 ${registered.length}`)
})

test('自举契约：每个 driver 的 kind / description / setup 都立得住', () => {
  const registry = createDriverRegistry()

  for (const kind of registry.kinds()) {
    const driver = registry.get(kind)
    assert.ok(driver, `${kind}: registry.get 应返回 driver`)
    assert.equal(driver.kind, kind, `${kind}: driver.kind 必须与注册键一致`)
    assert.equal(typeof driver.kind, 'string')
    assert.ok(driver.kind.trim().length > 0)

    assert.equal(
      typeof driver.description,
      'string',
      `${kind}: 缺少 description（会让列表与报告出现空白"覆盖什么"）`,
    )
    assert.ok(
      driver.description.trim().length > 0,
      `${kind}: description 不能是空白字符串`,
    )

    // setup 是 driver 契约里唯一必填的行为面
    assert.equal(typeof driver.setup, 'function', `${kind}: 必须实现 setup()`)
    // act / teardown 可选，但写了就必须是函数
    if ('act' in driver && driver.act !== undefined) {
      assert.equal(typeof driver.act, 'function', `${kind}: act 写了就必须是函数`)
    }
    if ('teardown' in driver && driver.teardown !== undefined) {
      assert.equal(typeof driver.teardown, 'function', `${kind}: teardown 写了就必须是函数`)
    }
    // requires 写了必须是能力名数组
    if (driver.requires !== undefined) {
      assert.ok(Array.isArray(driver.requires), `${kind}: requires 必须是数组`)
      for (const capability of driver.requires) {
        assert.equal(typeof capability, 'string', `${kind}: requires 项必须是字符串`)
      }
    }
  }
})

/* -------------------------------------------- 能力承诺：llm 零上游请求（③） -- */

/** 组装一个最小 DriverContext（与 tests/llm-driver.test.mjs 同形）。 */
function makeDriverContext(host, setup) {
  const scenario = { kind: 'llm', schema: 1, id: 'TK-SELF', title: '自举', source: {}, setup, steps: [] }
  return {
    host,
    fixture: new Fixture(),
    scenario,
    signal: new AbortController().signal,
  }
}

test('自举契约：llm driver 在 headless 宿主上跑一条 action，真实适配器调用计数为 0', async () => {
  const headless = await createHeadlessHost()
  const ctx = makeDriverContext(headless.host, {
    llm: { respond: { chunks: ['自', '举'], finishReason: 'stop' } },
  })

  try {
    await llmDriver.setup(ctx, ctx.scenario)
    await llmDriver.act(ctx, { llm: { prompt: 'self-bootstrap' } })

    // 先证明"流真的被消费了"——否则计数为 0 可能只是因为什么都没发生
    assert.equal(ctx.fixture.getNote('mockText'), '自举', '应消费到 driver 声明的分块')
    assert.equal(ctx.fixture.getNote('finishReason'), 'stop')
    assert.equal(ctx.fixture.getNote('llmCallCount'), 1)

    // 核心断言：计数来自**宿主暴露的真实适配器位**，不是 driver 自己的账本
    assert.equal(
      headless.services.llm.realAdapterCalls,
      0,
      '零上游请求被打破：listener 调用了 next()，真实适配器位被执行',
    )

    await ctx.fixture.release()
  } finally {
    await headless.dispose()
  }
})

test('自举契约：对照组证明那个计数探针本身是有效的', async () => {
  const headless = await createHeadlessHost()

  try {
    // 不做任何拦截：真实适配器位必须被触达，否则上面的 0 没有意义
    for await (const _chunk of headless.services.llm.stream({
      provider: 'p',
      model: 'm',
      messages: [],
    })) {
      void _chunk
    }
    assert.equal(
      headless.services.llm.realAdapterCalls,
      1,
      '没有 listener 时真实适配器位必须被走到（探针有效性的证明）',
    )
  } finally {
    await headless.dispose()
  }
})

/* ------------------------------------------------- CI 轨、包形态与 CLI（有 bin） -- */

/**
 * 形态决定**翻转**（0.2.0 第二批）：本包此前**刻意没有 `bin`**，
 * 命令行能力由 `/testkit` 人类命令 + `testkit_*` 工具 + 导出轨承担。
 * 现在加了 CLI（`bin/dsh-testkit.mjs`），于是这条契约改成守**新的形态**：
 *   · `bin` 必须存在且**指向真实存在的文件**（指向不存在的入口 = 装出来就是坏的）；
 *   · `bin` 必须在 `files` 白名单里（否则 `npm pack` 根本不带它）；
 *   · 导出链路仍然必须存在（CLI 是**另一条**入口，不替代 CI 轨）。
 *
 * 为什么不留一条"没有 bin"的断言：契约要守的是**当前形态**，
 * 形态变了就该改契约并在 CHANGELOG 里写明——留着旧断言只会逼人删测试。
 */
test('自举契约：CLI 入口存在且指向真实文件，导出链路同时保留', () => {
  const bin = pkg.bin
  assert.ok(bin !== undefined && typeof bin === 'object', '本包现在**应当**有 bin（CLI 入口）')

  const entries = Object.entries(bin)
  assert.ok(entries.length >= 1, 'bin 至少要有 1 个命令')
  for (const [name, target] of entries) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `bin 命令名应是小写短横线形态：${name}`)
    const rel = String(target).replace(/^\.\//, '')
    const file = join(root, rel)
    assert.ok(existsSync(file), `bin.${name} 指向的文件必须存在：${rel}`)
    // 入口必须是 ESM + 带 shebang（否则 `npm i -g` 后直接执行会失败）
    const head = readFileSync(file, 'utf8').split('\n')[0] ?? ''
    assert.match(head, /^#!.*node/, `bin.${name} 首行必须是 node shebang，实际：${head}`)
  }

  // 打包面：bin 目录必须在 files 里，否则发布出去没有 CLI
  const files = Array.isArray(pkg.files) ? pkg.files : []
  assert.ok(files.includes('bin'), 'files 白名单必须包含 bin（否则装出来没有 CLI）')

  // 导出链路的两个源：生成器与离线导出脚本（都是提交进仓库的源码）
  const generator = join(root, 'src', 'export', 'node-test.ts')
  const exportScript = join(root, 'scripts', 'export-scenarios.mjs')
  assert.ok(existsSync(generator), '导出用例生成器 src/export/node-test.ts 必须存在')
  assert.ok(existsSync(exportScript), '离线导出脚本 scripts/export-scenarios.mjs 必须存在')

  // gate 必须真的把"导出 + 跑导出的用例"串在链上：
  // 没有这两步，"CI 轨"就只是文档里的一句话。
  assert.match(
    String(pkg.scripts?.gate ?? ''),
    /scripts\/export-scenarios\.mjs/,
    'gate 里必须生成导出用例',
  )
  assert.match(
    String(pkg.scripts?.gate ?? ''),
    /export\/scenarios\.test\.mjs/,
    'gate 里必须跑导出的用例（CI 轨不能只生成不执行）',
  )

  // 导出产物是 git 忽略的生成物：存在就顺带看一眼不是空文件。
  // 不能断言"必须存在"——gate 里 `node --test tests/*.test.mjs` 跑在导出之前，
  // 全新检出时它本来就不在。
  const generated = join(root, 'export', 'scenarios.test.mjs')
  if (existsSync(generated)) {
    assert.ok(readFileSync(generated, 'utf8').length > 0, '导出产物不应是空文件')
  }
})

test('自举契约：适配层边界守卫已接进 gate', () => {
  assert.equal(
    typeof pkg.scripts?.['verify:adapter'],
    'string',
    'package.json 应有 verify:adapter 脚本',
  )
  assert.match(pkg.scripts['verify:adapter'], /check-adapter-boundary\.mjs/)
  assert.match(
    String(pkg.scripts?.gate ?? ''),
    /check-adapter-boundary\.mjs/,
    'gate 链上必须跑适配层守卫（否则它在日常开发里不会被执行）',
  )
})
