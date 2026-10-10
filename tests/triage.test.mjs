/**
 * 自动 triage：issue 草稿 / PR 评论 / 按 owner 路由（文档 §7.5 + §8.2）。
 *
 * ## 这个测试最看重什么
 *
 * 不是"文案好看"，而是**两条纪律被钉住**：
 *   ① 全绿 / 只有跳过时**不生成 issue**，但 PR 评论**必须有内容**（哪怕只有一行结论）；
 *   ② 公开正文里**不得出现取证原文**（`notes` 完全不参与生成；进入正文的
 *      期望/实际/消息/复现都经过脱敏 + 截断）。
 *
 * 第 ② 条用一份**带假 token 的 summary** 做负向断言，并且复用
 * `src/report/redact.ts` 的 `scanFindings` 当裁判——自己写一套"我觉得不含敏感"
 * 的判断等于没有判断。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { scanFindings } from '../lib/report/redact.js'
import { tallyTotals } from '../lib/runtime/runlog.js'
import {
  ELLIPSIS,
  buildIssueDraft,
  buildPrComment,
  failingCases,
  labelsFor,
  ownerOf,
  routeByOwner,
} from '../lib/triage/index.js'

/* --------------------------------------------------------------- 夹具 -- */

/**
 * 假 token：形态命中 `github-token`，但绝不是真凭据（`scanFindings` 会抓它）。
 *
 * 刻意**不在源码里写字面量**：`scripts/check-secrets.mjs` 会扫 `tests/`，
 * 一个字面量假凭据会让全队 gate 变红。运行时拼出来即可——这也顺带证明了
 * "扫描器认的是形态，不是这一行代码"。
 */
const FAKE_TOKEN = `ghp_${'A'.repeat(36)}`
/** 长取证原文：用来证明正文被截断（而不是整段贴上来）。 */
const LONG_BLOB = 'X'.repeat(2000)
/** notes 里的独特标记：正文里出现它就说明"取证原文进了公开面"。 */
const NOTES_MARKER = 'NOTES-STDOUT-BEGIN-SHOULD-NEVER-APPEAR'

function assertionOutcome({ ok = true, soft = false, message = '', actual = 1 } = {}) {
  return { assertion: { ref: 'fx.exitCode', is: 0 }, ok, actual, message, soft }
}

function step(name, { action, assertions = [], durationMs = 0 } = {}) {
  return { name, ...(action === undefined ? {} : { action }), assertions, durationMs }
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

function runSummary(cases, runId) {
  return {
    runId,
    startedAt: '2026-10-10T08:40:00.000Z',
    finishedAt: '2026-10-10T08:40:31.000Z',
    casesDir: 'cases',
    dshVersion: '0.2.0-rc.2',
    platform: 'win32',
    totals: tallyTotals(cases),
    cases,
  }
}

/** primary：产品 bug + owner + 复现 + 带假 token 的取证原文与期望/实际。 */
const C1 = caseOutcome({
  id: 'TK-2001',
  title: '退出码应为 0',
  kind: 'shell',
  verdict: 'failed',
  durationMs: 250,
  owner: '@alice',
  failureCategory: 'product_bug',
  minimalRepro: 'testkit_run { "ids": ["TK-2001"] }    # 或 /testkit run TK-2001',
  steps: [
    step('跑命令', {
      action: { kind: 'shell', ok: false, detail: `exit 1（token=${FAKE_TOKEN}）` },
      assertions: [
        assertionOutcome({
          ok: false,
          actual: `${FAKE_TOKEN} ${LONG_BLOB}`,
          message: '期望 0，实际 1',
        }),
      ],
      durationMs: 50,
    }),
  ],
  notes: {
    stdout: `${NOTES_MARKER}\n${LONG_BLOB}\nAuthorization: Bearer ${FAKE_TOKEN}`,
  },
})

/** errored + 没有 owner：它的"错误"既带假 token 又很长，用来验评论侧的脱敏 + 截断。 */
const C2 = caseOutcome({
  id: 'TK-2002',
  title: 'agent 超时',
  kind: 'agent',
  verdict: 'errored',
  durationMs: 30_000,
  error: `ECONNREFUSED 127.0.0.1:1 Authorization: Bearer ${FAKE_TOKEN} ${LONG_BLOB}`,
  failureCategory: 'env',
})

/** 通过 + owner（alice 的第二条 case）。 */
const C3 = caseOutcome({
  id: 'TK-2003',
  title: '工具返回正常',
  kind: 'tool',
  verdict: 'passed',
  durationMs: 120,
  owner: '@alice',
})

/** 跳过 + 没有 owner（路由里应落进 `(未指派)`）。 */
const C4 = caseOutcome({
  id: 'TK-2004',
  title: '需要 llm 能力',
  kind: 'llm',
  verdict: 'skipped',
  durationMs: 0,
  skipReason: '宿主缺少能力：llm',
})

/** flaky + owner 写成不带 `@`（应与 `@alice` 合并成一组）。 */
const C5 = caseOutcome({
  id: 'TK-2005',
  title: '三轮里只挂一轮',
  kind: 'session',
  verdict: 'failed',
  durationMs: 900,
  owner: 'alice',
  failureCategory: 'flaky',
  rounds: [true, false, true],
  steps: [
    step('flush', {
      assertions: [assertionOutcome({ ok: false, actual: false, message: '第 2 轮未落盘' })],
      durationMs: 30,
    }),
  ],
})

/** 没有归因：标签应落到 `needs-triage`（不猜类别）。 */
const C6 = caseOutcome({
  id: 'TK-2006',
  title: '未归因的失败',
  kind: 'tool',
  verdict: 'failed',
  durationMs: 10,
  owner: '@Bob',
  steps: [
    step('检查', {
      assertions: [assertionOutcome({ ok: false, actual: 'x', message: '断言未通过' })],
      durationMs: 10,
    }),
  ],
})

/** 用例缺陷 + owner 大小写不同（应与 `@Bob` 合并成一组）。 */
const C7 = caseOutcome({
  id: 'TK-2007',
  title: '取值路径写错',
  kind: 'file',
  verdict: 'failed',
  durationMs: 20,
  owner: '@bob',
  failureCategory: 'case_bug',
  steps: [
    step('读文件', {
      assertions: [assertionOutcome({ ok: false, actual: undefined, message: '取值失败：fx.nope 不存在' })],
      durationMs: 20,
    }),
  ],
})

const SUMMARY = runSummary([C1, C2, C3, C4, C5, C6, C7], 'RUN-TRIAGE')
const GREEN = runSummary([C3], 'RUN-GREEN')
const EMPTY = runSummary([], 'RUN-EMPTY')

const ISSUE_OPTS = { repo: 'acme/dsh-testkit', runUrl: 'https://ci.example.com/runs/42' }
const COMMENT_OPTS = {
  reportPath: 'runs/RUN-TRIAGE/report.md',
  junitPath: 'runs/RUN-TRIAGE/junit.xml',
  runUrl: 'https://ci.example.com/runs/42',
}

/* ------------------------------------------------------- issue 草稿 -- */

test('issue：标题含场景 id 与一句话症状，标签/指派按冻结规则推导', () => {
  const draft = buildIssueDraft(SUMMARY, ISSUE_OPTS)

  assert.ok(draft.title.startsWith('[dsh-testkit] TK-2001：'))
  assert.ok(draft.title.includes('期望 0，实际 1'))
  assert.deepEqual(draft.labels, ['bug'])
  // assignees 去掉 `@`，只指派 primary 的 owner。
  assert.deepEqual(draft.assignees, ['alice'])
})

test('issue：正文含期望/实际、归因、最小复现、证据与同批其他失败', () => {
  const draft = buildIssueDraft(SUMMARY, ISSUE_OPTS)

  assert.ok(draft.body.includes('## 失败摘要'))
  assert.ok(draft.body.includes('`TK-2001`'))
  assert.ok(draft.body.includes('❌ failed'))
  // 归因措辞直接取 FAILURE_CATEGORY_LABEL，不许另造。
  assert.ok(draft.body.includes('被测对象缺陷'))
  assert.ok(draft.body.includes('`product_bug`'))
  assert.ok(draft.body.includes('@alice'))

  assert.ok(draft.body.includes('## 期望 / 实际'))
  assert.ok(draft.body.includes('`fx.exitCode is`'))
  assert.ok(draft.body.includes('- 期望：`0`'))
  assert.ok(draft.body.includes('期望 0，实际 1'))

  assert.ok(draft.body.includes('## 最小复现'))
  assert.ok(draft.body.includes('testkit_run'))

  assert.ok(draft.body.includes('## 证据'))
  assert.ok(draft.body.includes('runs/RUN-TRIAGE/'))
  assert.ok(draft.body.includes(ISSUE_OPTS.runUrl))
  assert.ok(draft.body.includes(ISSUE_OPTS.repo))

  // 同批其他失败必须被列出（primary 之外的 4 条），否则会"悄悄没人管"。
  assert.ok(draft.body.includes('## 同批其他失败（4 条）'))
  for (const id of ['TK-2002', 'TK-2005', 'TK-2006', 'TK-2007']) {
    assert.ok(draft.body.includes(id), `正文应提到 ${id}`)
  }
})

test('issue：只有 failed/errored 才生成；全绿与仅跳过返回空草稿哨兵', () => {
  assert.deepEqual(buildIssueDraft(GREEN), { title: '', body: '', labels: [], assignees: [] })
  const onlySkipped = runSummary([C4], 'RUN-SKIP')
  assert.deepEqual(buildIssueDraft(onlySkipped), { title: '', body: '', labels: [], assignees: [] })
})

test('issue：primary 没有 owner 时不指派（不猜人）', () => {
  const draft = buildIssueDraft(runSummary([C2], 'RUN-NOOWNER'), ISSUE_OPTS)
  assert.ok(draft.title !== '')
  assert.deepEqual(draft.assignees, [])
  assert.deepEqual(draft.labels, ['environment'])
})

/* -------------------------------------------------------- PR 评论 -- */

test('PR 评论：一行结论 + 计数 + 失败表 + 最小复现 + 证据', () => {
  const comment = buildPrComment(SUMMARY, COMMENT_OPTS)

  assert.ok(comment.startsWith('<!-- dsh-testkit-report -->'), '要有可原地更新的隐藏标记')
  assert.ok(comment.includes('## dsh-testkit：❌ 5 条失败（7 条中 14% 通过）'))
  assert.ok(comment.includes('✅ 1 · ❌ 4 · 💥 1 · ⏭️ 1'))
  assert.ok(comment.includes('用时 31.30s'))
  assert.ok(comment.includes('归因：'))
  // 归因分布逐类列出（措辞取自 FAILURE_CATEGORY_LABEL，与报告一致）。
  assert.ok(comment.includes('被测对象缺陷 ×1'))
  assert.ok(comment.includes('环境问题 ×1'))
  assert.ok(comment.includes('未归因 ×1'))

  assert.ok(comment.includes('| Case | Kind | 归因 | 症状 | Owner |'))
  for (const id of ['TK-2001', 'TK-2002', 'TK-2005', 'TK-2006', 'TK-2007']) {
    assert.ok(comment.includes(id), `失败表应列出 ${id}`)
  }
  // owner 展示：有主的带 @，无主的是 (未指派)。
  assert.ok(comment.includes('@alice'))
  assert.ok(comment.includes('(未指派)'))

  assert.ok(comment.includes('### 最小复现'))
  assert.ok(comment.includes('<details>'))
  assert.ok(comment.includes('### 证据'))
  assert.ok(comment.includes(COMMENT_OPTS.reportPath))
  assert.ok(comment.includes(COMMENT_OPTS.junitPath))
  assert.ok(comment.includes(COMMENT_OPTS.runUrl))
})

test('PR 评论：全绿也有内容（简短证明），不是空白', () => {
  const comment = buildPrComment(GREEN, COMMENT_OPTS)

  assert.ok(comment.includes('## dsh-testkit：✅ 全部通过（1/1，100%）'))
  assert.ok(comment.includes('✅ 1 · ❌ 0'))
  assert.ok(comment.includes('通过的 case（1）'))
  assert.ok(comment.includes('`TK-2003` 工具返回正常'))
  assert.ok(comment.includes('### 证据'))
  assert.ok(!comment.includes('失败明细'))
  assert.ok(comment.length > 100, '全绿评论也要是一份可读的证明')
})

test('PR 评论：空运行明说"没有 case"，不假装通过', () => {
  const comment = buildPrComment(EMPTY, COMMENT_OPTS)
  assert.ok(comment.includes('没有 case'))
  assert.ok(!comment.includes('全部通过'))
  assert.ok(comment.includes('### 证据'))
})

/* --------------------------------------------------- 正文纪律（负向） -- */

test('纪律：正文不含取证原文，且 scanFindings 扫不到敏感项', () => {
  const issue = buildIssueDraft(SUMMARY, ISSUE_OPTS)
  const comment = buildPrComment(SUMMARY, COMMENT_OPTS)

  for (const [label, text] of [
    ['issue.body', issue.body],
    ['prComment', comment],
  ]) {
    // notes（取证快照）完全不参与生成。
    assert.ok(!text.includes(NOTES_MARKER), `${label} 出现了 notes 原文标记`)
    // 假 token 不进正文（它同时出现在 notes、assertion.actual 与 error 里）。
    assert.ok(!text.includes(FAKE_TOKEN), `${label} 出现了假 token`)
    assert.ok(!text.includes('ghp_'), `${label} 出现了 ghp_ 前缀`)
    // 长取证被截断（2000 个 X 不能整段贴上来）。
    assert.ok(!text.includes('X'.repeat(500)), `${label} 出现了未截断的长取证`)
    assert.ok(text.includes(ELLIPSIS), `${label} 应带省略标记`)

    // 用仓里现成的扫描器当裁判：公开正文必须 0 命中。
    assert.deepEqual(scanFindings(text), [], `${label} 被扫出敏感项`)
  }
})

test('纪律：空 summary 的 issue 草稿是哨兵，评论仍不空', () => {
  assert.deepEqual(buildIssueDraft(EMPTY), { title: '', body: '', labels: [], assignees: [] })
  assert.ok(buildPrComment(EMPTY).trim().length > 0)
})

/* --------------------------------------------------- 按 owner 路由 -- */

test('routeByOwner：无主归 (未指派) 并给出"该补 owner"的原因', () => {
  const routes = routeByOwner(SUMMARY.cases)

  assert.deepEqual(
    routes.map((route) => route.owner),
    ['(未指派)', 'alice', 'Bob'],
  )

  const unassigned = routes[0]
  assert.deepEqual(
    unassigned.cases.map((item) => item.id),
    ['TK-2002', 'TK-2004'],
  )
  assert.ok(unassigned.reason.includes('该补'))
  assert.ok(unassigned.reason.includes('owner'))
  assert.ok(unassigned.reason.includes('无法自动路由到人'))
  // 只有无主组带 reason，其他组干净。
  assert.equal(routes[1].reason, undefined)
})

test('routeByOwner：`@alice` / `alice` 与 `@Bob` / `@bob` 各合并成一组', () => {
  const routes = routeByOwner(SUMMARY.cases)
  const byOwner = new Map(routes.map((route) => [route.owner, route.cases.map((c) => c.id)]))

  assert.deepEqual(byOwner.get('alice'), ['TK-2001', 'TK-2003', 'TK-2005'])
  assert.deepEqual(byOwner.get('Bob'), ['TK-2006', 'TK-2007'])
  // 组名用首次出现的拼写（保留作者的大小写）。
  assert.equal(byOwner.has('bob'), false)
})

test('routeByOwner：只路由失败时同样工作，空输入返回空数组', () => {
  const routes = routeByOwner(failingCases(SUMMARY))
  const byOwner = new Map(routes.map((route) => [route.owner, route.cases.map((c) => c.id)]))
  assert.deepEqual(byOwner.get('(未指派)'), ['TK-2002'])
  assert.deepEqual(byOwner.get('alice'), ['TK-2001', 'TK-2005'])
  assert.deepEqual(byOwner.get('Bob'), ['TK-2006', 'TK-2007'])

  assert.deepEqual(routeByOwner([]), [])
})

test('ownerOf：去 @ 与空白；空 owner 视为没写', () => {
  assert.equal(ownerOf(caseOutcome({ owner: '@alice' })), 'alice')
  assert.equal(ownerOf(caseOutcome({ owner: '  @alice  ' })), 'alice')
  assert.equal(ownerOf(caseOutcome({ owner: 'alice' })), 'alice')
  assert.equal(ownerOf(caseOutcome({ owner: '   ' })), undefined)
  assert.equal(ownerOf(caseOutcome({})), undefined)
})

test('labels：归因 → 标签映射与冻结规则一致', () => {
  assert.deepEqual(labelsFor(caseOutcome({ failureCategory: 'product_bug' })), ['bug'])
  assert.deepEqual(labelsFor(caseOutcome({ failureCategory: 'env' })), ['environment'])
  assert.deepEqual(labelsFor(caseOutcome({ failureCategory: 'flaky' })), ['flaky'])
  assert.deepEqual(labelsFor(caseOutcome({ failureCategory: 'case_bug' })), ['testkit:case'])
  assert.deepEqual(labelsFor(caseOutcome({ failureCategory: 'driver_bug' })), ['testkit:driver'])
  // 没有归因：不猜类别，交给 needs-triage。
  assert.deepEqual(labelsFor(caseOutcome({})), ['needs-triage'])
})
