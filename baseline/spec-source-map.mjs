/**
 * 阶段 0-D：B1 的**实质读数**工具——把 spec 的条目映射回旧代码，再与覆盖率弱点求交。
 *
 * 为什么需要它（Lead 指出的方法学张力）：
 *   B1 的字面定义是「**spec 覆盖的**旧 TS 代码分支数 / 旧代码总分支数」，
 *   而阶段 0 的 spec 是行为描述（.md），它**不执行代码**。
 *   直接测 Node 覆盖率得到的是「既有测试套件的分支覆盖率」——那是**代理读数**，
 *   两者不等价。本工具给出第二个口径：
 *       每个旧代码文件，被多少条 spec 条目引用（source.file），以及这些条目声明了哪些测试。
 *   于是「低分支覆盖率」可以分成两类：
 *       ① 该文件属于 spec 声明覆盖的模块，却仍有大量未覆盖分支 → 缺口在**测试**这一半；
 *       ② 该文件不在 spec 的 18 个模块里（阶段 0 的提取范围）→ 不是「漏提」，而是**范围之外**，
 *          需要人裁定是否扩范围（代价完全不同）。
 *
 * 用法（cwd = 仓库根）：
 *   & <node.exe> baseline/spec-source-map.mjs
 * 产物：
 *   baseline/spec-source-map.json
 * 退出码：0 = 解析成功；1 = 有 spec 文件解析不出 front-matter（不静默跳过）
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const specDir = join(root, 'spec', 'behaviors')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (entry.toLowerCase().endsWith('.md')) out.push(full)
  }
  return out
}

const files = walk(specDir).sort()
const problems = []
const atoms = []
const snapshot = []

for (const full of files) {
  const rel = relative(root, full).replace(/\\/g, '/')
  const text = readFileSync(full, 'utf8')
  snapshot.push({ path: rel, bytes: Buffer.byteLength(text, 'utf8'), mtime: statSync(full).mtime.toISOString() })

  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) {
    problems.push(`${rel}: 没有 front-matter`)
    continue
  }
  let fm
  try {
    fm = parseYaml(m[1])
  } catch (error) {
    problems.push(`${rel}: front-matter 不是合法 YAML（${error.message}）`)
    continue
  }
  const list = Array.isArray(fm?.atomics) ? fm.atomics : []
  if (list.length === 0) problems.push(`${rel}: front-matter 没有 atomics 数组或为空`)
  for (const a of list) {
    atoms.push({
      id: a?.id ?? '(无 id)',
      module: fm?.module ?? '(无 module)',
      domain: fm?.domain ?? '(无 domain)',
      status: a?.status ?? '(无 status)',
      atomic: a?.atomic ?? '(无 atomic)',
      source_file: a?.source?.file ?? null,
      source_lines: a?.source?.lines ?? null,
      tests: Array.isArray(a?.source?.tests) ? a.source.tests : [],
      spec_file: rel,
    })
  }
}

// 每个旧代码文件被哪些条目引用
const byFile = new Map()
for (const a of atoms) {
  if (!a.source_file) continue
  const key = String(a.source_file).replace(/\\/g, '/')
  if (!byFile.has(key)) byFile.set(key, [])
  byFile.get(key).push(a)
}

// 覆盖率弱点（取 coverage-summary.json 里最后一次有效 run 的 src 文件）
const cov = JSON.parse(readFileSync(join(root, 'baseline', 'coverage-summary.json'), 'utf8'))
const validRuns = cov.runs.filter((r) => r.files.length > 0)
const lastValid = validRuns[validRuns.length - 1]
if (!lastValid) {
  console.error('[spec-source-map] coverage-summary.json 里没有有效 run（files 为空），无法求交')
  process.exit(2)
}
const srcFiles = lastValid.files.filter((f) => f.path.startsWith('src/'))
const weakest = [...srcFiles].sort((a, b) => a.branch - b.branch).slice(0, 15)

const annotate = (f) => {
  const refs = byFile.get(f.path) ?? []
  return {
    path: f.path,
    line_pct: f.line,
    branch_pct: f.branch,
    funcs_pct: f.funcs,
    spec_atom_count: refs.length,
    spec_atom_ids: refs.map((r) => r.id),
    spec_modules: [...new Set(refs.map((r) => r.module))],
    spec_declared_tests: [...new Set(refs.flatMap((r) => r.tests))],
  }
}

const weakestAnnotated = weakest.map(annotate)
const specCoveredSrcFiles = [...byFile.keys()].filter((p) => p.startsWith('src/'))

/* ---- 引用覆盖率的分子口径（Lead 裁决：只算 active） -----------------------------
 * 分子只算 `status: active` 且 `source.file` 指向旧代码的条目。
 * `unsupported` / `draft` 一律**不计入**（无论它们指向哪里）——这条口径是可被滥用的：
 * 若有人为了让引用覆盖率达到 100%，给一个"还没实现的目标态"写 active 条目、
 * 把 source.file 指向某个旧文件，机械统计就会把它当成"已覆盖"。
 * 所以：分子按 status 过滤，并且把被排除的条目**原样列出来**做见证。
 */
const ACTIVE = 'active'
const activeAtoms = atoms.filter((a) => a.status === ACTIVE)
const excludedAtoms = atoms.filter((a) => a.status !== ACTIVE)
const byFileActive = new Map()
for (const a of activeAtoms) {
  if (!a.source_file) continue
  const key = String(a.source_file).replace(/\\/g, '/')
  if (!byFileActive.has(key)) byFileActive.set(key, [])
  byFileActive.get(key).push(a)
}
const specCoveredSrcFilesActive = [...byFileActive.keys()].filter((p) => p.startsWith('src/'))
const statusHistogram = atoms.reduce((acc, a) => {
  acc[a.status] = (acc[a.status] ?? 0) + 1
  return acc
}, {})

const summary = {
  generated_at: new Date().toISOString(),
  spec_snapshot: {
    dir: 'spec/behaviors',
    files: files.length,
    atom_entries: atoms.length,
    unique_ids: new Set(atoms.map((a) => a.id)).size,
    files_snapshot: snapshot,
    guard_reading: 'node spec/schema/validate-spec.mjs --json（阶段 0 进行中，spec 树仍在生长，本快照有时间戳）',
  },
  reference_coverage_rule: {
    numerator:
      "只算 `status: active` 且 `source.file` 指向旧代码（src/**）的条目；`unsupported` / `draft` 一律不计入（无论它们指向哪里）",
    why: '目标态条目（status: unsupported，如 surfaces.md 的 collect-refine-tools / collect-refine-command）是**阶段 1 的落点声明**，不是覆盖率分子；旧代码里根本不存在那两个名字。若把它们算进分子，"还没实现"就能被机械统计成"已覆盖"——这条口径防的正是这种滥用。将来它们转 active 也不应用来抬高**旧代码**的引用覆盖率，而应计入"新增面"的对拍。',
    traceable_proof: 'excluded_non_active_atoms 把被排除的条目原样列出（id / status / source.file），统计是否被"稀释"一眼可见',
  },
  status_histogram: statusHistogram,
  source_file_histogram: Object.fromEntries([...byFile.entries()].map(([k, v]) => [k, v.length]).sort()),
  source_file_histogram_active_only: Object.fromEntries([...byFileActive.entries()].map(([k, v]) => [k, v.length]).sort()),
  excluded_non_active_atoms: excludedAtoms.map((a) => ({ id: a.id, status: a.status, source_file: a.source_file, spec_file: a.spec_file })),
  coverage_source: { log: lastValid.log, line: lastValid.aggregate.line, branch: lastValid.aggregate.branch, funcs: lastValid.aggregate.funcs },
  weakest_15_annotated: weakestAnnotated,
  weak_file_summary: {
    n_weak: weakestAnnotated.length,
    n_referenced_by_spec: weakestAnnotated.filter((f) => f.spec_atom_count > 0).length,
    n_not_referenced: weakestAnnotated.filter((f) => f.spec_atom_count === 0).length,
    not_referenced: weakestAnnotated.filter((f) => f.spec_atom_count === 0).map((f) => f.path),
  },
  spec_covered_src_files: specCoveredSrcFiles.map((p) => {
    const f = srcFiles.find((x) => x.path === p)
    return { path: p, branch_pct: f ? f.branch : null, line_pct: f ? f.line : null, atoms: byFile.get(p).length }
  }),
  spec_covered_src_files_active: specCoveredSrcFilesActive.map((p) => {
    const f = srcFiles.find((x) => x.path === p)
    return { path: p, branch_pct: f ? f.branch : null, line_pct: f ? f.line : null, atoms: byFileActive.get(p).length }
  }),
  problems,
}

writeFileSync(join(root, 'baseline', 'spec-source-map.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')

console.log(`spec 模块文件 ${files.length} / 原子条目 ${atoms.length} / 唯一 id ${summary.spec_snapshot.unique_ids}`)
console.log(`status 分布：${JSON.stringify(statusHistogram)}`)
console.log(`spec 声明的 source.file 去重后：${byFile.size} 个（其中 src/ 下 ${specCoveredSrcFiles.length} 个）`)
console.log(`【引用覆盖率分子口径】只算 active：${specCoveredSrcFilesActive.length} 个 src 文件；被排除的非 active 条目 ${excludedAtoms.length} 条`)
for (const a of excludedAtoms) console.log(`  - 排除：${a.id}（status=${a.status}，source.file=${a.source_file ?? '(空)'}）`)
console.log(`\n低覆盖文件（分支最低 15 个）与 spec 条目的关系：`)
for (const f of weakestAnnotated) {
  console.log(
    `  branch=${String(f.branch_pct).padStart(6)}%  atoms=${String(f.spec_atom_count).padStart(3)}  tests=${f.spec_declared_tests.length}  ${f.path}`,
  )
}
console.log(`\n15 个里被 spec 引用的：${summary.weak_file_summary.n_referenced_by_spec}；未被引用：${summary.weak_file_summary.n_not_referenced}`)
if (problems.length > 0) {
  console.log(`\n解析问题 ${problems.length} 条：`)
  for (const p of problems) console.log('  - ' + p)
}
process.exit(problems.length === 0 ? 0 : 1)
