/**
 * 从 issue 提炼数据生成**场景骨架**与**能力缺口报告**。
 *
 * ## 它解决什么
 *
 * 目标里"按用户逐批提供的 issue 提炼测试场景数据"如果只靠手工一条条读，
 * 238 条候选就要读 238 遍。这个工具把**机械的部分**（字段映射、形态分类、
 * 判据缺口清点）自动化，人只负责**真正需要判断的部分**：把判据写成断言。
 *
 * ## 它做什么
 *
 * 1. 读 `extracted/items.jsonl`，筛出「可回归候选」（有最小复现 + 读数/验收判据）
 * 2. 按**判据形态**分类，映射到本插件已有的 kind
 * 3. 为每条候选生成一个 `status: draft` 的场景骨架（不会进默认运行集）
 * 4. 输出**能力缺口报告**：哪些形态现有 kind 覆盖不了
 *
 * ## 它不做什么
 *
 * **不猜断言。** 生成的 expect 全是显式 TODO——因为"判据"必须人来定，
 * 机器猜出来的判据只会制造"看起来在测、其实没测"的假象。
 *
 * 用法：
 *   node scripts/from-issue-data.mjs <数据目录> [--out <输出目录>] [--limit N] [--repo <名>]
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(here)

const argv = process.argv.slice(2)
const dataDir = argv[0]
if (!dataDir) {
  console.error('用法：node scripts/from-issue-data.mjs <数据目录> [--out <目录>] [--limit N] [--repo <名>]')
  process.exit(2)
}
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const outDir = resolve(root, opt('out', 'cases-draft'))
const limit = Number(opt('limit', '0')) || 0
const repoFilter = opt('repo', '')

/* ------------------------------------------------------------ 读数据 -- */

const items = readFileSync(join(dataDir, 'extracted/items.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const candidates = items.filter(
  (i) =>
    i.sec_repro &&
    (i.sec_measurement || i.sec_acceptance) &&
    (repoFilter === '' || i.repo_short === repoFilter),
)

/* ------------------------------------------------ 判据形态 → kind 映射 -- */

/**
 * 从正文判定"这条 issue 的判据属于哪种形态"，并给出**建议的 kind**。
 *
 * 顺序有意：先看有没有可执行命令（最确定的信号），再看关键词。
 */
export function classify(item) {
  const text = [
    item.sec_repro,
    item.sec_measurement,
    item.sec_acceptance,
    (item.test_commands ?? []).join('\n'),
  ]
    .filter(Boolean)
    .join('\n')

  const commands = (item.test_commands ?? []).filter((c) => typeof c === 'string' && c.trim() !== '')

  if (commands.length > 0) {
    return { shape: 'exec-command', kind: 'shell', why: '报告里给了可执行命令' }
  }
  if (/\bpytest\b|python -m |pip install|python3 -m /.test(text)) {
    return { shape: 'python-run', kind: 'shell', why: '正文提到 python/pytest 运行方式' }
  }
  if (/\bgit (apply|diff|rev-parse|log|status)\b/.test(text)) {
    return { shape: 'git-command', kind: 'shell', why: '正文提到 git 命令' }
  }
  if (/frontmatter|\.md\b|读取|文件|目录|白名单|files/i.test(text)) {
    return {
      shape: 'file-inspect',
      kind: 'shell',
      why: '需要检查文件内容/清单（现有 kind 用 shell 可凑，但不是直说）',
      gap: 'kind:file',
    }
  }
  if (/\d+(\.\d+)?\s*(ms|s|GB|MB|%)|倍|提速|PASS/.test(text)) {
    return {
      shape: 'reading-only',
      kind: '',
      why: '**只有读数**，没有给出可执行判据——需要人工构造复现脚本',
      gap: 'manual',
    }
  }
  return {
    shape: 'unknown',
    kind: '',
    why: '形态未识别，需要人工阅读',
    gap: 'manual',
  }
}

/* --------------------------------------------------------- 生成骨架 -- */

const yamlEscape = (s) => String(s ?? '')
  .replace(/\r/g, '')
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')

const blockScalar = (label, text, indent = '    ') => {
  const lines = String(text ?? '').trim().split('\n')
  if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) return `${label}: ""`
  return [`${label}: |`, ...lines.map((l) => `${indent}${l}`)].join('\n')
}

function scaffold(item, index) {
  const c = classify(item)
  const issueUrl = item.url ?? `https://github.com/${item.repo}/issues/${item.number}`
  const steps =
    c.kind === 'shell'
      ? [
          '  - name: TODO(人工)：把判据写成可复现的命令',
          '    act:',
          '      shell:',
          '        argv: ["TODO(人工)：填一条能区分「有问题」与「已修好」的命令"]',
          '    expect:',
          '      # TODO(人工)：判据必须**可机器判定**，且两侧都标（越界前 + 越界后）',
          '      - { ref: fx.exitCode, is: 0 }',
        ]
      : [
          '  - name: TODO(人工)：先写复现脚本，再把它变成命令',
          '    # 这条 issue 只给了**读数**，没有可直接执行的判据。',
          '    # 提炼步骤：① 照 sec_repro 写出最小复现脚本 ② 用 kind: shell 跑它 ③ 把读数变成断言',
          '    act:',
          '      shell:',
          '        argv: ["TODO(人工)"]',
          '    expect:',
          '      - { ref: fx.exitCode, exists: true }',
        ]

  return `# 由 scripts/from-issue-data.mjs 生成 —— **草稿，需人工完善后才可启用**。
#
# 源 issue：${issueUrl}
# 判据形态：${c.shape}（${c.why}）
#
# 状态是 draft：不会被 /testkit run 与 CI 轨选中。
# 完善步骤见 cases/README.md 与 docs/ISSUE-PIPELINE.md。

schema: 1
id: DRAFT-${String(index + 1).padStart(4, '0')}
title: "${yamlEscape(String(item.title ?? '').slice(0, 120))}"
kind: ${c.kind || 'shell'}
severity: medium
status: draft
tags: [from-issue, ${item.repo_short ?? 'unknown'}, ${c.shape}]

source:
  issue: "${issueUrl}"
${blockScalar('  summary', [
  `repo=${item.repo_short}#${item.number}  state=${item.state}  module=${item.module || '-'}  category=${item.category || '-'}`,
  c.gap ? `能力缺口：${c.gap}` : '',
  '',
  '【现象】',
  String(item.sec_phenomenon ?? '(未给出)').slice(0, 1200),
  '',
  '【最小复现】',
  String(item.sec_repro ?? '').slice(0, 1600),
  '',
  '【实测读数 / 验收判据】',
  String(item.sec_measurement ?? item.sec_acceptance ?? '').slice(0, 1200),
].join('\n'))}

runtime:
  requires: [${c.kind === 'shell' ? 'subprocess' : ''}]

steps:
${steps.join('\n')}
`
}

/* ------------------------------------------------------------- 输出 -- */

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const selected = limit > 0 ? candidates.slice(0, limit) : candidates
const byShape = new Map()
let written = 0

for (const [index, item] of selected.entries()) {
  const c = classify(item)
  if (!byShape.has(c.shape)) byShape.set(c.shape, { count: 0, kind: c.kind, why: c.why, gap: c.gap })
  byShape.get(c.shape).count += 1

  const file = join(outDir, `${String(index + 1).padStart(4, '0')}-${item.repo_short}-${item.number}.yaml`)
  writeFileSync(file, scaffold(item, index), 'utf8')
  written += 1
}

const total = candidates.length
const report = [
  '# 提炼草稿与能力缺口报告',
  '',
  `> 由 \`scripts/from-issue-data.mjs\` 生成｜数据目录：\`${dataDir}\``,
  `> 可回归候选 ${total} 条，本次生成 **${written}** 份草稿`,
  '',
  '**这些是草稿（`status: draft`），不会被 `/testkit run` 与 CI 轨选中。**',
  '每条里的 `expect` 都是显式 TODO —— 判据必须人来定。',
  '',
  '## 判据形态分布',
  '',
  '| 形态 | 条数 | 建议 kind | 现有能力够吗 |',
  '|---|---|---|---|',
]
for (const [shape, info] of [...byShape.entries()].sort((a, b) => b[1].count - a[1].count)) {
  const gap = info.gap === 'manual' ? '❌ 需人工构造判据' : info.gap ? `⚠️ 建议加 \`${info.gap}\`` : '✅ 够'
  report.push(`| \`${shape}\` | ${info.count} | \`${info.kind || '—'}\` | ${gap} |`)
}

report.push(
  '',
  '## 怎么用',
  '',
  '1. 打开一份草稿，读它的 `source.summary`（现象 / 最小复现 / 实测读数都在里面）',
  '2. 把 `act.shell.argv` 填成一条**能区分"有问题"与"已修好"**的命令',
  '3. 把 `expect` 填成**可机器判定**的断言（两侧都标：越界前 + 越界后）',
  '4. 改 `id`（`DRAFT-xxxx` → 正式 `TK-xxxx`）、`status: draft` → `active`',
  '5. 移到 `cases/` 并跑 `node scripts/verify-cases.mjs --write`',
  '',
  '## 数据本身的局限',
  '',
  '- 多数候选**只有读数**（性能对比、PASS 计数），没有可执行判据 —— 这类必须先写复现脚本',
  '- 数据是 2026-10-09 的快照；`collect.py && extract.py` 可刷新',
  '- 类别与严重度是启发式标注，不是人工判定',
)

writeFileSync(join(outDir, 'README.md'), report.join('\n'), 'utf8')

console.log(`[from-issue-data] 数据目录：${dataDir}`)
console.log(`[from-issue-data] 可回归候选 ${total} 条 → 生成 ${written} 份草稿`)
for (const [shape, info] of [...byShape.entries()].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${shape.padEnd(16)} ${String(info.count).padStart(4)}  建议 kind=${info.kind || '—'}${info.gap ? `  缺口=${info.gap}` : ''}`)
}
console.log(`[from-issue-data] 输出：${outDir}`)
