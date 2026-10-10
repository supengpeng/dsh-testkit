#!/usr/bin/env node
/**
 * GitHub Action 入口：`run.json` → 评论正文 → Job Summary / stdout →（可选）POST 到 PR。
 *
 * ## 职责边界（重要）
 *
 * 渲染**全部**委托给 `src/triage/` 的 `buildPrComment(summary, opts)`（task-17 冻结的
 * 接口）。本文件只做四件事：读输入、读 run.json、把正文写到该去的地方、可选发一个 POST。
 * 为什么不在这里再写一遍 Markdown：triage 那边有长度上限、脱敏与"不贴取证原文"的
 * 纪律，两处实现必然漂移，而漂移的表现是"PR 里贴出了不该贴的东西"。
 *
 * ## 两条纪律
 *
 *   ① **只生成文本，不发请求**——除非 `comment: true` 且真的给了 token；
 *   ② POST 失败**绝不静默**：打印状态码 + 响应片段 + **完整正文**，
 *      让人能直接手工贴到 PR（否则"评论没发出去"这件事没人会发现）。
 *
 * ## 输入
 *
 * 环境变量（action.yml 里以 `DSH_TESTKIT_*` 传入；也接受 GitHub 的 `INPUT_*`
 * 形式与 `--key=value` 命令行参数，便于本地干跑）：
 *   · `DSH_TESTKIT_REPORT`    run.json 路径（默认 `run.json`）
 *   · `DSH_TESTKIT_COMMENT`   `true` | `false`（默认 false）
 *   · `DSH_TESTKIT_TOKEN`     GitHub token（`comment: true` 时必需）
 *   · `DSH_TESTKIT_FAIL_ON`   `failed`（默认）| `never`
 *
 * 本地干跑：
 * ```sh
 * node scripts/action-entry.mjs --report=runs/<id>/run.json
 * ```
 *
 * `node scripts/build-lock.mjs` 之后 `lib/triage/index.js` 才会存在；缺失时本脚本
 * **明确报错**（不做静默降级成"空评论"）。
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** triage 模块位置（构建产物）。 */
export const TRIAGE_MODULE_URL = new URL('../lib/triage/index.js', import.meta.url)

/** `fail-on` 允许的取值。 */
export const FAIL_ON_VALUES = ['failed', 'never']

/* ------------------------------------------------------------ 纯函数层 -- */

function flagValue(argv) {
  const flags = new Map()
  for (const arg of argv) {
    const match = /^--([a-zA-Z][a-zA-Z0-9-]*)=(.*)$/.exec(String(arg))
    if (match) flags.set(match[1], match[2])
  }
  return flags
}

/** 解析输入（env + argv），做形态归一。纯函数，便于单测。 */
export function resolveInputs(env = process.env, argv = []) {
  const flags = flagValue(argv)
  const pick = (name, envName, fallback) =>
    flags.get(name) ?? env[envName] ?? env[`INPUT_${envName.replace(/^DSH_TESTKIT_/, '')}`] ?? fallback

  const report = String(pick('report', 'DSH_TESTKIT_REPORT', 'run.json')).trim() || 'run.json'
  const commentRaw = String(pick('comment', 'DSH_TESTKIT_COMMENT', 'false')).trim()
  const token = String(pick('token', 'DSH_TESTKIT_TOKEN', '')).trim()
  const failOn = String(pick('fail-on', 'DSH_TESTKIT_FAIL_ON', 'failed')).trim() || 'failed'
  return {
    report,
    comment: /^(?:1|true|yes)$/i.test(commentRaw),
    token,
    failOn,
  }
}

/** 解析 run.json；形态不对就点名报错（不猜）。 */
export function parseRunSummary(text, where) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(`${where}: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${where}: 顶层应是对象（RunSummary）`)
  }
  if (value.totals === null || typeof value.totals !== 'object' || !Array.isArray(value.cases)) {
    throw new Error(`${where}: 不像一份 RunSummary（缺少 totals 或 cases）——是不是拿错了文件？`)
  }
  return value
}

/** 按 `fail-on` 决定退出码；取值非法直接抛（不静默放行）。 */
export function decideExitCode(summary, failOn) {
  if (!FAIL_ON_VALUES.includes(failOn)) {
    throw new Error(`fail-on 只支持 ${FAIL_ON_VALUES.map((v) => `'${v}'`).join(' | ')}，收到 '${failOn}'`)
  }
  if (failOn === 'never') return 0
  const failed = Number(summary?.totals?.failed ?? 0)
  const errored = Number(summary?.totals?.errored ?? 0)
  return failed + errored > 0 ? 1 : 0
}

/** 从 Actions 环境推导 run 的公开链接（拿不到就 undefined）。 */
export function runUrlOf(env = process.env) {
  const server = env.GITHUB_SERVER_URL
  const repo = env.GITHUB_REPOSITORY
  const runId = env.GITHUB_RUN_ID
  if (!server || !repo || !runId) return undefined
  return `${server}/${repo}/actions/runs/${runId}`
}

/** 从事件 payload / GITHUB_REF 推导 PR（或 issue）号；拿不到返回 undefined。 */
export function resolveIssueNumber(env = process.env) {
  const eventPath = env.GITHUB_EVENT_PATH
  if (eventPath && existsSync(eventPath)) {
    try {
      const payload = JSON.parse(readFileSync(eventPath, 'utf8'))
      const number = payload?.pull_request?.number ?? payload?.issue?.number
      if (typeof number === 'number') return number
    } catch {
      /* 落到 GITHUB_REF 推导 */
    }
  }
  const ref = env.GITHUB_REF ?? ''
  const match = /^refs\/pull\/(\d+)\//.exec(ref)
  return match === null ? undefined : Number(match[1])
}

/* ------------------------------------------------------------ I/O 层 -- */

/**
 * 加载 triage 渲染器。
 *
 * **缺失时明确报错**，不降级：宁可不评论，也不要发一份"看起来正常、其实空"的评论。
 */
export async function loadTriage(moduleUrl = TRIAGE_MODULE_URL) {
  let mod
  try {
    mod = await import(moduleUrl.href)
  } catch (error) {
    throw new Error(
      `加载 ${moduleUrl.href} 失败：${error instanceof Error ? error.message : String(error)}\n` +
        '  → 先构建：node scripts/build-lock.mjs（triage 渲染在 src/triage/，未构建时无法生成正文）',
    )
  }
  if (typeof mod.buildPrComment !== 'function') {
    const names = Object.keys(mod)
    throw new Error(
      `src/triage 没有导出 buildPrComment（现有导出：${names.length > 0 ? names.join(', ') : '（无）'}）`,
    )
  }
  return mod
}

/** 把正文写到 Job Summary / step output / stdout；返回写入目标的描述。 */
export function writeBody(body, env = process.env) {
  const sinks = []
  if (typeof env.GITHUB_STEP_SUMMARY === 'string' && env.GITHUB_STEP_SUMMARY !== '') {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${body}\n`, 'utf8')
    sinks.push(`Job Summary(${env.GITHUB_STEP_SUMMARY})`)
  }
  if (typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT !== '') {
    const delimiter = 'DSH_TESTKIT_BODY_EOF'
    appendFileSync(env.GITHUB_OUTPUT, `body<<${delimiter}\n${body}\n${delimiter}\n`, 'utf8')
    sinks.push('step output(body)')
  }
  // stdout 永远写：本地干跑与"评论失败要人工贴"都靠它。
  console.log(body)
  sinks.push('stdout')
  return sinks.join(' + ')
}

/** POST 一条 issue/PR 评论。失败抛错（调用方负责打印正文 + 非 0 退出）。 */
export async function postComment({ body, token, env = process.env, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('当前 Node 没有全局 fetch（需要 Node >= 18）')
  }
  const repo = env.GITHUB_REPOSITORY
  const number = resolveIssueNumber(env)
  if (!repo) throw new Error('拿不到 GITHUB_REPOSITORY（不在 GitHub Actions 里？）')
  if (number === undefined) {
    throw new Error('拿不到 PR/issue 号（事件 payload 与 GITHUB_REF 都没有；本 step 需要跑在 PR 上）')
  }
  const api = String(env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')
  const response = await fetchImpl(`${api}/repos/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-testkit-action',
    },
    body: JSON.stringify({ body }),
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = (await response.text()).slice(0, 500)
    } catch {
      /* 读不到响应体就算了 */
    }
    throw new Error(`POST 评论失败：HTTP ${response.status}${detail === '' ? '' : ` ${detail}`}`)
  }
  return { number, status: response.status }
}

/* --------------------------------------------------------------- 主流程 -- */

/**
 * 执行一次 action。返回进程退出码（0 / 1）。
 *
 * 抛出的错误由调用方兜底成退出码 1 —— 但凡是"能给出正文"的失败，
 * 这里已经自己打印过了。
 */
export async function main(env = process.env, argv = process.argv.slice(2)) {
  const inputs = resolveInputs(env, argv)

  const reportPath = resolve(inputs.report)
  if (!existsSync(reportPath)) {
    throw new Error(`找不到报告 ${reportPath}（--report= 或 DSH_TESTKIT_REPORT 指定；先跑一次 testkit_run）`)
  }
  const summary = parseRunSummary(readFileSync(reportPath, 'utf8'), reportPath)

  const triage = await loadTriage()
  const junitPath = join(dirname(reportPath), 'junit.xml')
  const runUrl = runUrlOf(env)
  const body = triage.buildPrComment(summary, {
    ...(runUrl === undefined ? {} : { runUrl }),
    reportPath,
    ...(existsSync(junitPath) ? { junitPath } : {}),
  })

  const sink = writeBody(body, env)
  const totals = summary.totals ?? {}
  console.log(
    `[action] 正文已写入 ${sink}｜${body.length} 字符｜总计 ${totals.total ?? '?'}，通过 ${totals.passed ?? '?'}，失败 ${totals.failed ?? '?'}，错误 ${totals.errored ?? '?'}`,
  )

  if (inputs.comment) {
    if (inputs.token === '') {
      console.error('[action] ✗ comment=true 但没有给 token：不做请求。正文已在上方/Job Summary，可人工贴。')
      return 1
    }
    try {
      const posted = await postComment({ body, token: inputs.token, env })
      console.log(`[action] 已评论到 #${posted.number}（HTTP ${posted.status}）`)
    } catch (error) {
      console.error(`[action] ✗ 评论失败（不静默）：${error instanceof Error ? error.message : String(error)}`)
      console.error('----- 正文（可直接人工贴到 PR） -----')
      console.error(body)
      console.error('------------------------------------')
      return 1
    }
  }

  return decideExitCode(summary, inputs.failOn)
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      console.error(`[action] ✗ ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    })
}
