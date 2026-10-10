/**
 * 报告标准化：`junit.xml` / `run.json` / `report.md` **三面同源** + 失败归因呈现。
 *
 * ## 为什么用手写的 RunSummary 而不是 `runs/` 产物
 *
 * `runs/` 是 gitignore 的运行产物，内容随"上一次谁跑了什么"漂移；
 * 拿它当断言输入，测试就会时红时绿。这里手写一份**覆盖全部分支**的
 * RunSummary 字面量，三种格式都从它渲染，才能真的验证"同源"。
 *
 * ## 为什么自己写 JSON Schema 校验器
 *
 * 本仓纪律：不引 zod / ajv。校验器只覆盖本仓 schema 真正用到的关键字
 * （$ref / type / enum / required / properties / items / additionalProperties），
 * 并且**自己也要被验证**——故意破坏一处数据，断言它必须报错；
 * 否则它只是个"永远返回 ok"的安慰剂。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

/**
 * 本文件建的临时目录统一登记，跑完一次性删除。
 *
 * 教训：漏清理会在 `%TEMP%` 里堆出成百上千个 `dsh-testkit-report-*`
 * （实测 118 个），是 `dsh-testkit doctor` 的残留探测先发现的。
 */
const TEMP_DIRS = []
after(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

import { classifyCase, FAILURE_CATEGORY_LABEL } from '../lib/analysis/classify.js'
import { buildMinimalRepro, buildMinimalReproForScenario } from '../lib/analysis/repro.js'
import { escapeXmlAttr, escapeXmlText, renderJUnit } from '../lib/report/junit.js'
import { renderJson, writeRunArtifacts } from '../lib/report/json.js'
import { renderMarkdown } from '../lib/report/markdown.js'
import { tallyTotals } from '../lib/runtime/runlog.js'

/* ---------------------------------------------------------- 手写测试夹具 -- */

function assertionOutcome(assertion, { ok, actual, message = '', soft = false }) {
  return { assertion, ok, actual, message, soft }
}

function step(name, assertions, extra = {}) {
  return { name, assertions, durationMs: 12, ...extra }
}

function caseOutcome(overrides = {}) {
  return {
    id: 'TK-0000',
    title: '示例',
    kind: 'tool',
    verdict: 'passed',
    durationMs: 100,
    steps: [],
    notes: {},
    releaseFailures: [],
    sourceIssue: null,
    ...overrides,
  }
}

const PASSED = caseOutcome({
  id: 'TK-0001',
  title: '工具调用返回正常',
  kind: 'tool',
  verdict: 'passed',
  durationMs: 120,
  steps: [
    step('invoke tool', [assertionOutcome({ ref: 'fx.ok', is: true }, { ok: true, actual: true })]),
  ],
  sourceIssue: 'https://example.invalid/issues/1',
})

const FAILED = caseOutcome({
  id: 'TK-0002',
  title: '退出码应为 0',
  kind: 'shell',
  verdict: 'failed',
  durationMs: 250,
  steps: [
    step('run command', [
      assertionOutcome(
        { ref: 'fx.exitCode', is: 0 },
        { ok: false, actual: 1, message: '期望 0，实际 1' },
      ),
      assertionOutcome({ ref: 'fx.stderr', is: '' }, { ok: true, actual: '' }),
    ]),
  ],
  failureCategory: 'product_bug',
  policy: { allowed: true, reason: '场景声明 cost=low，闸门放行', cost: 'low', source: 'scenario' },
  usage: { modelCalls: 2, tokens: 1234 },
  minimalRepro: buildMinimalRepro({
    caseId: 'TK-0002',
    failingStepIndex: 0,
    failingStepName: 'run command',
  }),
})

const FLAKY = caseOutcome({
  id: 'TK-0003',
  title: '三轮里只挂一轮',
  kind: 'session',
  verdict: 'failed',
  durationMs: 900,
  rounds: [true, false, true],
  steps: [
    step('flush', [
      assertionOutcome(
        { ref: 'fx.flushed', is: true },
        { ok: false, actual: false, message: '第 2 轮未落盘' },
      ),
    ]),
  ],
  failureCategory: 'flaky',
  policy: { allowed: false, reason: 'cost=high 且未开 --allow-model', cost: 'high', source: 'driver' },
  minimalRepro: buildMinimalRepro({ caseId: 'TK-0003' }),
})

const ERRORED = caseOutcome({
  id: 'TK-0004',
  title: 'agent 超时',
  kind: 'agent',
  verdict: 'errored',
  durationMs: 30_000,
  error: '操作超时（> 30000ms）：agent 未在时限内返回',
  failureCategory: 'env',
  usage: { modelCalls: 1, tokens: 20 },
})

const SKIPPED = caseOutcome({
  id: 'TK-0005',
  title: '需要 llm 能力',
  kind: 'llm',
  verdict: 'skipped',
  durationMs: 0,
  skipReason: '宿主缺少能力：llm',
})

/** XML 敌意样本：标题与断言文本里同时塞 `<` `&` `"` `'` 与裸控制字符。 */
const HOSTILE = caseOutcome({
  id: 'TK-0006',
  title: `标签 <script> & "引号" '撇号' \u0001裸控制符`,
  kind: 'ui',
  verdict: 'failed',
  durationMs: 33,
  steps: [
    step('渲染', [
      assertionOutcome(
        { ref: 'fx.dom', is: '<b>&</b>' },
        { ok: false, actual: '<i>"', message: '含 < > & " \u0002 的期望' },
      ),
    ]),
  ],
  failureCategory: 'case_bug',
})

const CASES = [PASSED, FAILED, FLAKY, ERRORED, SKIPPED, HOSTILE]

const SUMMARY = {
  runId: 'RUN-20261010-070000',
  startedAt: '2026-10-10T07:00:00.000Z',
  finishedAt: '2026-10-10T07:00:03.000Z',
  casesDir: 'cases',
  dshVersion: '0.2.0-rc.2',
  platform: 'win32',
  totals: tallyTotals(CASES),
  cases: CASES,
  policySnapshot: { allowModel: false, allowLowCost: true, sandbox: { mode: 'workspace-write' } },
}

/* ------------------------------------------------------- 极简 XML 检查器 -- */

/**
 * 只做两件 CI 真正在意的事：标签配对（well-formed），以及文本 / 属性里
 * 没有裸 `<`、未转义的 `&`、残留的 XML 非法控制字符。
 */
function assertXmlWellFormed(xml) {
  let text = xml
  if (text.startsWith('<?xml')) {
    const end = text.indexOf('?>')
    assert.ok(end > 0, 'XML 声明没有闭合')
    text = text.slice(end + 2)
  }

  const tagRe = /<\/?([A-Za-z_][\w.:-]*)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*"[^"]*")*)\s*(\/?)>/g
  const stack = []
  let last = 0
  let match
  while ((match = tagRe.exec(text)) !== null) {
    assertTextOk(text.slice(last, match.index))
    last = tagRe.lastIndex
    const [raw, name, attrText, selfClose] = match
    if (raw.startsWith('</')) {
      assert.equal(stack.pop(), name, `闭合标签不匹配：${raw}`)
    } else {
      assertAttrsOk(attrText)
      if (selfClose !== '/') stack.push(name)
    }
  }
  assertTextOk(text.slice(last))
  assert.deepEqual(stack, [], `存在未闭合的标签：${stack.join(' > ')}`)
}

function assertTextOk(fragment) {
  assert.ok(!fragment.includes('<'), `文本里出现裸 <：${JSON.stringify(fragment)}`)
  const withoutEntities = fragment.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '')
  assert.ok(!withoutEntities.includes('&'), `文本里出现未转义的 &：${JSON.stringify(fragment)}`)
  assert.ok(
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(fragment),
    `文本里残留 XML 非法控制字符：${JSON.stringify(fragment)}`,
  )
}

function assertAttrsOk(attrText) {
  if (attrText.trim() === '') return
  const attrRe = /\s+([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g
  const consumed = []
  let match
  let count = 0
  while ((match = attrRe.exec(attrText)) !== null) {
    count += 1
    consumed.push(match[0])
    const value = match[2]
    assert.ok(!value.includes('<'), `属性值里出现裸 <：${JSON.stringify(value)}`)
    assert.ok(
      !/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value),
      `属性值里残留 XML 非法控制字符：${JSON.stringify(value)}`,
    )
    const withoutEntities = value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, '')
    assert.ok(!withoutEntities.includes('&'), `属性值里出现未转义的 &：${JSON.stringify(value)}`)
  }
  assert.equal(
    consumed.join(''),
    attrText,
    `属性文本没有被完整解析（可能存在格式错误的属性）：${JSON.stringify(attrText)}`,
  )
}

/** 切出每个 testcase 元素（自闭合与带子节点两种）。 */
function testCaseBlocks(xml) {
  return [...xml.matchAll(/<testcase\b[^>]*\/>|<testcase\b[\s\S]*?<\/testcase>/g)].map((m) => m[0])
}

function idOfBlock(block) {
  const match = block.match(/\sname="([^"]*)"/)
  assert.ok(match, `testcase 没有 name 属性：${block.slice(0, 120)}`)
  return match[1].split(' ')[0]
}

/* ------------------------------------------------ 最小 JSON Schema 校验器 -- */

/**
 * 支持的关键字：`$ref` / `type` / `enum` / `required` / `properties` /
 * `items` / `additionalProperties`。够本仓 schema 用，不替代 ajv。
 */
function validateJson(schema, value) {
  const errors = []
  walkSchema(schema, value, schema, '$', errors)
  return errors
}

function walkSchema(schema, value, root, path, errors) {
  if (schema.$ref !== undefined) {
    walkSchema(resolveRef(schema.$ref, root), value, root, path, errors)
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((type) => matchesType(type, value))) {
      errors.push(`${path}: 期望类型 ${types.join('|')}，实际 ${jsType(value)}`)
      return
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(`${path}: 值 ${JSON.stringify(value)} 不在枚举 [${schema.enum.join(', ')}] 内`)
  }

  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, index) =>
      walkSchema(schema.items, item, root, `${path}[${index}]`, errors),
    )
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}: 缺少必填字段 ${key}`)
    }
    const properties = schema.properties ?? {}
    for (const [key, sub] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) walkSchema(sub, value[key], root, `${path}.${key}`, errors)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${path}: 不允许多余字段 ${key}`)
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          walkSchema(schema.additionalProperties, value[key], root, `${path}.${key}`, errors)
        }
      }
    }
  }
}

function resolveRef(ref, root) {
  assert.ok(typeof ref === 'string' && ref.startsWith('#/'), `只支持本地 $ref：${ref}`)
  let node = root
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    node = isPlainObject(node) ? node[key] : undefined
  }
  assert.ok(node !== undefined, `$ref 解析失败：${ref}`)
  return node
}

function matchesType(type, value) {
  switch (type) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    default:
      throw new Error(`校验器不认识的 type：${type}`)
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function jsType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

const SCHEMA = JSON.parse(
  readFileSync(new URL('../schemas/run-report.schema.json', import.meta.url), 'utf8'),
)

/* ------------------------------------------------------------ 三面同源 -- */

test('junit：testcase 数 = cases 数，根/套件计数与 tally 一致', () => {
  const xml = renderJUnit(SUMMARY)
  assert.equal(testCaseBlocks(xml).length, SUMMARY.cases.length)

  const root = xml.match(/<testsuites\b[^>]*>/)[0]
  assert.match(root, new RegExp(`tests="${SUMMARY.cases.length}"`))
  assert.match(root, new RegExp(`failures="${SUMMARY.totals.failed}"`))
  assert.match(root, new RegExp(`errors="${SUMMARY.totals.errored}"`))
  assert.match(root, new RegExp(`skipped="${SUMMARY.totals.skipped}"`))
  // 根 time = 各 case 耗时之和（秒，三位小数）。
  const totalMs = SUMMARY.cases.reduce((sum, c) => sum + c.durationMs, 0)
  assert.match(root, new RegExp(`time="${(totalMs / 1000).toFixed(3)}"`))

  // 按 kind 分组：组内 tests 之和 = cases 数。
  const suiteTests = [...xml.matchAll(/<testsuite\b[^>]*\btests="(\d+)"/g)].map((m) =>
    Number(m[1]),
  )
  assert.equal(
    suiteTests.reduce((sum, n) => sum + n, 0),
    SUMMARY.cases.length,
  )

  // 每条 case 的 classname 带 kind。
  assert.ok(xml.includes('classname="dsh-testkit.shell"'))
  assert.ok(xml.includes('classname="dsh-testkit.ui"'))
  assertXmlWellFormed(xml)
})

test('三面同源：md「需要关注」的 case 集合 = junit 的 failure/error/skipped 集合', () => {
  const md = renderMarkdown(SUMMARY)
  const xml = renderJUnit(SUMMARY)

  const mdAttention = [...md.matchAll(/^### `([^`]+)`/gm)].map((m) => m[1]).sort()
  const expectedAttention = SUMMARY.cases
    .filter((c) => c.verdict !== 'passed')
    .map((c) => c.id)
    .sort()
  assert.deepEqual(mdAttention, expectedAttention)

  // junit 的 failure/error 只对应 failed/errored；skipped 走自己的 <skipped>。
  const junitBad = testCaseBlocks(xml)
    .filter((block) => /<failure\b/.test(block) || /<error\b/.test(block))
    .map(idOfBlock)
    .sort()
  const expectedBad = SUMMARY.cases
    .filter((c) => c.verdict === 'failed' || c.verdict === 'errored')
    .map((c) => c.id)
    .sort()
  assert.deepEqual(junitBad, expectedBad)
  assert.equal(junitBad.length, SUMMARY.totals.failed + SUMMARY.totals.errored)

  // failure / error 的数量各自对得上 verdict。
  assert.equal(testCaseBlocks(xml).filter((b) => /<failure\b/.test(b)).length, SUMMARY.totals.failed)
  assert.equal(testCaseBlocks(xml).filter((b) => /<error\b/.test(b)).length, SUMMARY.totals.errored)
})

test('junit：failure/error 的 type 取 failureCategory，正文带失败明细与最小复现', () => {
  const xml = renderJUnit(SUMMARY)
  assert.ok(xml.includes('type="product_bug"'), 'TK-0002 应为 product_bug')
  assert.ok(xml.includes('type="flaky"'), 'TK-0003 应为 flaky')
  assert.ok(xml.includes('type="env"'), 'TK-0004 应为 env')
  assert.ok(xml.includes('type="case_bug"'), 'TK-0006 应为 case_bug')

  const failedBlock = testCaseBlocks(xml).find((b) => b.includes('TK-0002 '))
  assert.ok(failedBlock.includes('失败断言：'))
  assert.ok(failedBlock.includes('fx.exitCode'))
  assert.ok(failedBlock.includes('实际 1'))
  assert.ok(failedBlock.includes('最小复现：'))
  assert.ok(failedBlock.includes('testkit_run'))
})

test('junit：skipped 带 message，passed 自闭合且无子标签', () => {
  const xml = renderJUnit(SUMMARY)
  assert.ok(xml.includes('<skipped message="宿主缺少能力：llm"/>'))

  const passedBlock = testCaseBlocks(xml).find((b) => b.includes('TK-0001 '))
  assert.ok(passedBlock.endsWith('/>'))
  assert.ok(!passedBlock.includes('<failure'))
  assert.ok(!passedBlock.includes('<error'))
})

test('markdown：归因列 / 归因标签 / rounds / 闸门 / 用量 / 最小复现 / 闸门快照', () => {
  const md = renderMarkdown(SUMMARY)

  assert.ok(md.includes('| Case | Kind | 结果 | 归因 | 耗时 | 标题 | 来源 |'))
  assert.ok(md.includes(FAILURE_CATEGORY_LABEL.product_bug))
  assert.ok(md.includes('归因：用例缺陷（`case_bug`）'))
  assert.ok(md.includes('2/3 轮通过'))
  assert.ok(md.includes('成本闸门：跑'))
  assert.ok(md.includes('成本闸门：未跑'))
  assert.ok(md.includes('模型调用 2 次 · 1234 tokens'))
  assert.ok(md.includes('```bash'))
  assert.ok(md.includes('第 1 步'))
  assert.ok(md.includes('闸门快照'))
  // 「已通过」段保持简洁：不给通过用例加归因 / 最小复现。
  const passedSection = md.slice(md.indexOf('## 已通过'))
  assert.ok(passedSection.includes('`TK-0001` 工具调用返回正常'))
  assert.ok(!passedSection.includes('最小复现'))
})

/* -------------------------------------------------------- XML 转义用例 -- */

test('junit：标题 / 消息里的 < & " 正确转义，非法控制字符被剔除', () => {
  const xml = renderJUnit(SUMMARY)

  assert.ok(xml.includes('&lt;script&gt;'), '尖括号必须转义')
  assert.ok(xml.includes('&amp;'), '& 必须转义')
  assert.ok(xml.includes('&quot;'), '双引号必须转义')
  assert.ok(xml.includes('&apos;'), '单引号必须转义')
  assert.ok(!xml.includes('\u0001'), '\\u0001 必须被剔除')
  assert.ok(!xml.includes('\u0002'), '\\u0002 必须被剔除')

  // 转义正确 ⇒ 能被简单解析器接受。
  assertXmlWellFormed(xml)
})

test('XML 转义函数：转义顺序与合法控制字符保留', () => {
  assert.equal(escapeXmlText('<&>'), '&lt;&amp;&gt;')
  assert.equal(escapeXmlAttr(`a'b"c<d>&`), 'a&apos;b&quot;c&lt;d&gt;&amp;')
  // \t \n \r 是 XML 合法字符：文本里保留；属性里折成空格（解析器本就会规范化）。
  assert.equal(escapeXmlText('a\tb\nc'), 'a\tb\nc')
  assert.equal(escapeXmlAttr('a\tb\nc'), 'a b c')
  // 非法控制字符一律剔除。
  assert.equal(escapeXmlText('a\u0000b\u000Bc\u001Fd'), 'abcd')
})

/* ------------------------------------------------- run.json Schema 校验 -- */

test('run.json 满足 schemas/run-report.schema.json', () => {
  assert.ok(String(SCHEMA.$schema).includes('2020-12'), 'Schema 应声明 draft 2020-12')
  const parsed = JSON.parse(renderJson(SUMMARY))
  assert.deepEqual(validateJson(SCHEMA, parsed), [])
})

test('Schema 允许缺省全部可选字段（policySnapshot / rounds / policy / usage / 归因）', () => {
  const minimal = {
    runId: 'RUN-X',
    startedAt: '2026-10-10T07:00:00.000Z',
    finishedAt: '2026-10-10T07:00:01.000Z',
    casesDir: 'cases',
    dshVersion: '0.2.0-rc.2',
    platform: 'linux',
    totals: { total: 1, passed: 1, failed: 0, skipped: 0, errored: 0 },
    cases: [PASSED],
  }
  assert.deepEqual(validateJson(SCHEMA, JSON.parse(JSON.stringify(minimal))), [])
})

test('校验器不是安慰剂：故意破坏的 run.json 必须被报出来', () => {
  const parsed = JSON.parse(renderJson(SUMMARY))

  const badVerdict = structuredClone(parsed)
  badVerdict.cases[0].verdict = 'nope'
  const verdictErrors = validateJson(SCHEMA, badVerdict)
  assert.ok(verdictErrors.length > 0, '非法 verdict 必须报错')
  assert.match(verdictErrors.join('\n'), /verdict/)

  const badCategory = structuredClone(parsed)
  badCategory.cases[1].failureCategory = 'wishful_thinking'
  const categoryErrors = validateJson(SCHEMA, badCategory)
  assert.ok(categoryErrors.length > 0, '非法 failureCategory 必须报错')
  assert.match(categoryErrors.join('\n'), /failureCategory/)

  const badCost = structuredClone(parsed)
  badCost.cases[1].policy.cost = 'cheap'
  assert.match(validateJson(SCHEMA, badCost).join('\n'), /policy\.cost/)

  const missingField = structuredClone(parsed)
  delete missingField.runId
  assert.match(validateJson(SCHEMA, missingField).join('\n'), /runId/)

  const extraField = structuredClone(parsed)
  extraField.cases[0].oops = 1
  assert.match(validateJson(SCHEMA, extraField).join('\n'), /oops/)

  const badType = structuredClone(parsed)
  badType.totals.total = '6'
  assert.match(validateJson(SCHEMA, badType).join('\n'), /totals\.total/)

  const badRounds = structuredClone(parsed)
  badRounds.cases[2].rounds = 'yes'
  assert.match(validateJson(SCHEMA, badRounds).join('\n'), /rounds/)
})

/* ----------------------------------------------------------- 产物落地 -- */

test('writeRunArtifacts：写出 run.json / report.md / junit.xml，且不抛出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-report-'))
  TEMP_DIRS.push(dir)
  const { artifacts, error } = await writeRunArtifacts(SUMMARY, dir)

  assert.equal(error, undefined)
  assert.ok(artifacts, '应当返回 artifacts')
  assert.equal(existsSync(artifacts.jsonPath), true)
  assert.equal(existsSync(artifacts.markdownPath), true)
  assert.ok(artifacts.junitPath, '应当返回 junitPath')
  assert.equal(existsSync(artifacts.junitPath), true)

  assertXmlWellFormed(readFileSync(artifacts.junitPath, 'utf8'))
  const fromDisk = JSON.parse(readFileSync(artifacts.jsonPath, 'utf8'))
  assert.deepEqual(validateJson(SCHEMA, fromDisk), [])
})

test('writeRunArtifacts：写入失败只回报 error，不抛出', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-testkit-report-'))
  TEMP_DIRS.push(dir)
  const notADir = join(dir, 'not-a-dir')
  writeFileSync(notADir, 'x')

  const result = await writeRunArtifacts(SUMMARY, notADir)
  assert.equal(result.artifacts, undefined)
  assert.equal(typeof result.error, 'string')
  assert.ok(result.error.length > 0)
})

/* ------------------------------------------------- 判定表 11 条路径 -- */

/** 造一条带硬失败断言的步骤。 */
function failingStep(message) {
  return step('检查', [
    assertionOutcome({ ref: 'fx.value', is: 'expected' }, { ok: false, actual: 'actual', message }),
  ])
}

test('classifyCase：判定表 11 条路径逐条覆盖', () => {
  // 1. 通过 / 跳过 → 无归因
  assert.equal(classifyCase(caseOutcome({ verdict: 'passed', steps: [failingStep('不该看这里')] })), undefined)
  assert.equal(classifyCase(caseOutcome({ verdict: 'skipped', skipReason: '宿主缺少能力：llm' })), undefined)

  // 2. repeat 多轮结果不一致 → flaky
  assert.equal(classifyCase(caseOutcome({ verdict: 'failed', rounds: [true, false, true] })), 'flaky')
  // flaky 优先于环境特征：抖动本身才是要抓的现象。
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'failed', rounds: [true, false], error: 'ECONNREFUSED' })),
    'flaky',
  )

  // 3. 预算超限 → env（本次运行的条件不足，不是产品/用例/引擎的结论）
  assert.equal(
    classifyCase(
      caseOutcome({ verdict: 'failed', error: '预算超限：模型调用次数上限 1 次，已用 2 次' }),
    ),
    'env',
  )
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'errored', error: 'BudgetExceeded: 预算超限：token 上限' })),
    'env',
  )

  // 4. errored + driver 特征
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'errored', error: 'driver 尚未实现：compaction/now' })),
    'driver_bug',
  )
  // 5. errored + 环境特征
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'errored', error: 'connect ECONNREFUSED 127.0.0.1:1' })),
    'env',
  )
  // 6. errored 其余
  assert.equal(classifyCase(caseOutcome({ verdict: 'errored', error: '莫名其妙炸了' })), 'driver_bug')

  // 7. failed + 夹具释放失败
  assert.equal(
    classifyCase(
      caseOutcome({
        verdict: 'failed',
        releaseFailures: [{ label: 'svc', error: 'close failed' }],
        steps: [failingStep('期望 0，实际 1')],
      }),
    ),
    'driver_bug',
  )
  // 8. failed + 环境特征
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'failed', error: '操作超时（> 1000ms）' })),
    'env',
  )
  // 9. failed + 失败断言全部是取值失败
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'failed', steps: [failingStep('取值失败：fx.nope 不存在')] })),
    'case_bug',
  )
  // 9 的反例：只要有一条不是取值失败，就不敢判 case_bug。
  assert.equal(
    classifyCase(
      caseOutcome({
        verdict: 'failed',
        steps: [
          step('检查', [
            assertionOutcome({ ref: 'fx.a', is: 1 }, { ok: false, actual: 2, message: '取值失败：fx.a' }),
            assertionOutcome({ ref: 'fx.b', is: 1 }, { ok: false, actual: 2, message: '期望 1，实际 2' }),
          ]),
        ],
      }),
    ),
    'product_bug',
  )
  // 10. failed 且没有任何失败断言
  assert.equal(classifyCase(caseOutcome({ verdict: 'failed' })), 'driver_bug')
  // 11. failed 其余
  assert.equal(
    classifyCase(caseOutcome({ verdict: 'failed', steps: [failingStep('期望 0，实际 1')] })),
    'product_bug',
  )
})

test('classifyCase：软断言失败不算硬失败（不改变 verdict 的证据）', () => {
  const outcome = caseOutcome({
    verdict: 'failed',
    steps: [
      step('检查', [
        assertionOutcome(
          { ref: 'fx.a', is: 1, soft: true },
          { ok: false, actual: 2, message: '取值失败：fx.a', soft: true },
        ),
      ]),
    ],
  })
  // 只有一条 soft 失败 ⇒ 没有硬失败断言 ⇒ 第 10 条 driver_bug（而不是 case_bug）。
  assert.equal(classifyCase(outcome), 'driver_bug')
})

test('FAILURE_CATEGORY_LABEL：5 类枚举齐全且非空', () => {
  assert.deepEqual(Object.keys(FAILURE_CATEGORY_LABEL).sort(), [
    'case_bug',
    'driver_bug',
    'env',
    'flaky',
    'product_bug',
  ])
  for (const label of Object.values(FAILURE_CATEGORY_LABEL)) {
    assert.equal(typeof label, 'string')
    assert.ok(label.length > 0)
  }
})

/* ----------------------------------------------------- buildMinimalRepro -- */

test('buildMinimalRepro：不带失败步骤下标（只给整条场景复现）', () => {
  const text = buildMinimalRepro({ caseId: 'TK-0100' })
  assert.ok(text.includes('TK-0100'))
  assert.ok(text.includes('testkit_run'))
  assert.ok(!text.includes('失败步骤'))
})

test('buildMinimalRepro：带失败步骤下标（点出第几步 + 步骤名）', () => {
  const withStep = buildMinimalRepro({
    caseId: 'TK-0100',
    failingStepIndex: 1,
    failingStepName: '检查输出',
  })
  assert.ok(withStep.includes('第 2 步'))
  assert.ok(withStep.includes('「检查输出」'))
  assert.ok(withStep.startsWith(buildMinimalRepro({ caseId: 'TK-0100' })))
})

test('buildMinimalReproForScenario：从场景取步骤名，越界下标不炸', () => {
  const scenario = { id: 'TK-0200', steps: [{ name: '第一步' }, { name: '第二步' }] }
  const text = buildMinimalReproForScenario(scenario, 1)
  assert.ok(text.includes('第 2 步'))
  assert.ok(text.includes('「第二步」'))

  const outOfRange = buildMinimalReproForScenario(scenario, 9)
  assert.ok(outOfRange.includes('第 10 步'))
  // 步骤不存在时刻意不写步骤名（不编数据）——注意静态文案里的「需要关注」不算。
  assert.ok(!/第 10 步「/.test(outOfRange))
})
