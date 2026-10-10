/**
 * 阶段 0-D：把「设计口径下的变更清单」与「spec 实际声明的源文件」求交。
 *
 * 回答 Lead 的问题：
 *   · 变更模块口径下的**引用覆盖率**是否接近 100%？
 *   · 若有个别变更模块没有 spec 条目 → **逐个点名**，那是阶段 0 真正的漏提。
 *
 * 输入（都由本目录的工具生成，不手抄）：
 *   baseline/design-scope.json          判定规则 + change_final / keep_final / unlisted_by_1_2
 *   baseline/spec-source-map.json       spec/behaviors/** 的 atomics[].source.file 去重集合
 *   baseline/coverage-change-scope.json 修正口径的逐文件覆盖率（用于"弱文件 × 分类"）
 * 产物：baseline/spec-vs-design.json
 *
 * 用法（cwd = 仓库根）：& <node.exe> baseline/spec-vs-design.mjs
 * 退出码：0 = 计算成功；2 = 输入缺失
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))

function load(rel) {
  try {
    return JSON.parse(readFileSync(join(root, rel), 'utf8'))
  } catch (error) {
    console.error(`[spec-vs-design] 读不到 ${rel}：${error.message}（先跑对应的生成工具）`)
    process.exit(2)
  }
}

const design = load('baseline/design-scope.json')
const specMap = load('baseline/spec-source-map.json')

// 引用覆盖率的【官方分子口径】：只算 status: active 且 source.file 指向旧代码的条目。
// 若 spec-source-map.json 还没有 active 字段（旧产物），退回状态无关集合并把这件事写进输出。
const activeList = specMap.spec_covered_src_files_active
const statusBlindList = specMap.spec_covered_src_files ?? []
const usedActiveField = Array.isArray(activeList)
const specFiles = new Set((activeList ?? statusBlindList).map((f) => f.path))
const specFilesStatusBlind = new Set(statusBlindList.map((f) => f.path))
const histogram = specMap.source_file_histogram ?? {}
const histogramActive = specMap.source_file_histogram_active_only ?? histogram
const atomCount = (p) => histogramActive[p] ?? 0
const atomCountAnyStatus = (p) => histogram[p] ?? 0

const CHANGE = design.change_final
const KEEP = design.keep_final
const UNLISTED_12 = design.unlisted_by_1_2

const classOf = (p) => (CHANGE.includes(p) ? 'change' : KEEP.includes(p) ? 'keep' : UNLISTED_12.includes(p) ? 'unlisted' : 'unknown')

const byClass = {}
const byClassStatusBlind = {}
for (const [cls, files] of [
  ['change_final', CHANGE],
  ['keep_final', KEEP],
  ['unlisted_by_1_2', UNLISTED_12],
]) {
  const referenced = files.filter((p) => specFiles.has(p))
  const missing = files.filter((p) => !specFiles.has(p))
  byClass[cls] = {
    total: files.length,
    referenced: referenced.length,
    missing: missing.length,
    reference_ratio: files.length === 0 ? null : Number(((referenced.length / files.length) * 100).toFixed(1)),
    referenced_files: referenced.sort(),
    missing_files: missing.sort().map((p) => ({ path: p, spec_atoms: atomCount(p), spec_atoms_any_status: atomCountAnyStatus(p) })),
  }
  const refBlind = files.filter((p) => specFilesStatusBlind.has(p))
  byClassStatusBlind[cls] = {
    total: files.length,
    referenced: refBlind.length,
    reference_ratio: files.length === 0 ? null : Number(((refBlind.length / files.length) * 100).toFixed(1)),
  }
}
const activeOnlyChangesAnything =
  byClass.change_final.referenced !== byClassStatusBlind.change_final.referenced

const specNotInAnyClass = [...specFiles].filter((p) => classOf(p) === 'unknown')
const specOnKeep = [...specFiles].filter((p) => KEEP.includes(p))

/* ---------------- 低覆盖文件 × 设计分类（机器推导，不手抄） ---------------- */
let weakest15 = []
let weakestSource = null
try {
  const changeScope = load('baseline/coverage-change-scope.json')
  const files = changeScope.variants.all_src_fixed.files.filter((f) => f.path.startsWith('src/'))
  weakestSource = 'baseline/coverage-change-scope.json#variants.all_src_fixed'
  weakest15 = [...files]
    .sort((a, b) => a.branch - b.branch)
    .slice(0, 15)
    .map((f) => ({
      path: f.path,
      line_pct: f.line,
      branch_pct: f.branch,
      funcs_pct: f.funcs,
      design_class: classOf(f.path),
      spec_atoms: atomCount(f.path),
      spec_atoms_any_status: atomCountAnyStatus(f.path),
    }))
} catch {
  weakest15 = []
}
const weakestByClass = weakest15.reduce((acc, f) => {
  acc[f.design_class] = (acc[f.design_class] ?? 0) + 1
  return acc
}, {})

const out = {
  generated_at: new Date().toISOString(),
  question: '变更模块口径下的引用覆盖率是否接近 100%？',
  answer: `变更清单 ${byClass.change_final.total} 个中，spec 的 **active** 条目覆盖了 ${byClass.change_final.referenced} 个（${byClass.change_final.reference_ratio}%），**未覆盖 ${byClass.change_final.missing} 个**`,
  reference_coverage_rule: specMap.reference_coverage_rule ?? {
    numerator: '只算 status: active 且 source.file 指向旧代码的条目',
    note: 'spec-source-map.json 里没有 reference_coverage_rule（旧产物）',
  },
  used_active_field: usedActiveField,
  status_histogram: specMap.status_histogram ?? null,
  excluded_non_active_atoms: specMap.excluded_non_active_atoms ?? [],
  active_only_changes_anything: activeOnlyChangesAnything,
  by_class: byClass,
  by_class_status_blind: byClassStatusBlind,
  spec_declared_file_count: specFiles.size,
  design_source: design.section_source,
  ruling: design.ruling,
  unlisted_but_referenced_by_spec: specNotInAnyClass,
  spec_referenced_keep_modules: specOnKeep,
  weakest_15_with_design_class: { source: weakestSource, by_class: weakestByClass, files: weakest15 },
  conclusion: {
    change_reference_ratio: byClass.change_final.reference_ratio,
    is_near_100: byClass.change_final.reference_ratio === 100,
    missing_change_files: byClass.change_final.missing_files.map((m) => m.path),
    numerator_rule: 'status === "active" 且 source.file 指向 src/**',
    status_blind_reference_ratio: byClassStatusBlind.change_final.reference_ratio,
    active_guard_effect: activeOnlyChangesAnything
      ? '⚠️ 按 status 过滤改变了结果——说明有非 active 条目指向旧代码（必须看清是哪些）'
      : '按 status 过滤与不过滤结果相同（当前没有非 active 条目指向变更清单里的旧文件）',
  },
}
writeFileSync(join(root, 'baseline', 'spec-vs-design.json'), `${JSON.stringify(out, null, 2)}\n`, 'utf8')

console.log(out.answer)
console.log(`\n【分子口径】${out.reference_coverage_rule.numerator}`)
console.log(`status 分布：${JSON.stringify(out.status_histogram)}；被排除的非 active 条目 ${out.excluded_non_active_atoms.length} 条；按 status 过滤是否改变结果：${activeOnlyChangesAnything}`)
console.log(`spec 的 active 条目覆盖的源文件：${specFiles.size} 个（状态无关口径为 ${specFilesStatusBlind.size} 个）`)
for (const cls of ['change_final', 'keep_final', 'unlisted_by_1_2']) {
  const c = byClass[cls]
  const b = byClassStatusBlind[cls]
  console.log(
    `  ${cls.padEnd(16)} 共 ${String(c.total).padStart(2)} 个，active 引用 ${String(c.referenced).padStart(2)} 个（${c.reference_ratio}%），未引用 ${c.missing}；状态无关口径 ${b.reference_ratio}%`,
  )
}
console.log('\n=== 变更清单里**没有** active 条目的文件（逐个点名）===')
for (const m of byClass.change_final.missing_files) console.log(`  - ${m.path}（active 条目 ${m.spec_atoms}；状态无关 ${m.spec_atoms_any_status}）`)
console.log('=== 被排除的非 active 条目（见证）===')
for (const a of out.excluded_non_active_atoms) console.log(`  - ${a.id}（status=${a.status}，source.file=${a.source_file ?? '(空)'}）`)
console.log('\nspec 引用到「沿用」模块的文件（允许，但记录）：', specOnKeep.join(', ') || '（无）')
console.log('spec 引用了但分类未覆盖的文件：', specNotInAnyClass.join(', ') || '（无）')
console.log(`\n=== 分支最低的 15 个文件 × 设计分类（来源 ${weakestSource}）===`)
for (const f of weakest15) {
  console.log(`  branch=${String(f.branch_pct).padStart(6)}%  [${f.design_class.padEnd(8)}]  atoms(active)=${String(f.spec_atoms).padStart(3)}  ${f.path}`)
}
console.log('  按分类计数：', JSON.stringify(weakestByClass))
