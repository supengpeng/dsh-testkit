/**
 * 阶段 0-D：B1 的**设计口径**（Lead 裁决二的落地）+ **未列模块归属表**（Lead 最终裁决）。
 *
 * ## 判定规则（可复算，不需要下一个人重新推）
 *
 * ```
 * 变更清单 = §1.2 逐行解析出的「变更」模块
 *          ∪ 未列模块里被**显式点名**为变更的（见 RULING.explicit_change）
 * 其余未列模块 → 一律「沿用」
 *          依据：Lead 裁决原话「没有被要求重写就是沿用，不是没判断」
 * ```
 *
 * 两条都是**数据**，写在下面的 `RULING` 里（含逐条依据），不散落在判断代码里。
 *
 * ## 本脚本的三个纪律
 *   ① 清单从设计 §1.2 **逐行解析**而来，不凭印象列（解析结果原样写进 JSON 备查）。
 *   ② 分类有**自检**：18 个"人可复核"的期望分类必须逐个一致，否则立刻变红、拒绝继续。
 *   ③ 空集合守卫：解析后若没有文件行，退出码 1（沿用 parse-coverage.mjs 的纪律）。
 *
 * ## 修正的一个测量缺陷
 *   旧命令里用"export 目录通配"排除生成产物，会**误伤** `lib/export/node-test.js`
 *   与 `lib/export/write.js`（路径里含 `/export/`）。本脚本改用"只匹配那一个生成文件"
 *   的精确排除项。详见 spec/metrics/coverage.md §4.5。
 *
 * 用法（cwd = 仓库根，且 lib/ 已构建）：
 *   & <node.exe> baseline/coverage-change-scope.mjs
 * 产物：
 *   baseline/design-scope.json   判定规则 + 三分类清单（含归属表与依据）
 *   baseline/coverage-change-scope.json   五个口径变体的读数
 *   baseline/coverage-stage0-<variant>.log 各变体的原始报告
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(new URL('.', import.meta.url)))
const DESIGN = join(root, 'docs', 'REWRITE-DESIGN.md')

/* ============ 变更清单的判定规则（数据，不是判断代码） ============ */

const RULING = {
  decided_on: '2026-10-11',
  decided_by: 'Lead（阶段 0 裁决）',
  rule: '变更清单 = §1.2 逐行解析出的「变更」模块 ∪ 未列模块里被显式点名者；其余未列模块一律「沿用」。依据：没有被要求重写就是沿用，不是没判断。',
  default_for_unlisted: 'keep',
  explicit_change: [
    {
      path: 'src/tools.ts',
      basis:
        'RFC 0001 §5.1：注册面数量「工具 13 → 15」（+testkit_collect / testkit_refine）——新增的两个模型工具只能落在 src/tools.ts；设计 §1.2 漏列了它',
    },
    {
      path: 'src/commands.ts',
      basis: 'Lead 裁决：与上行同源（CLI 子命令 16 → 18，+collect / refine），归入变更',
    },
  ],
  /**
   * 已撤销的裁决留痕（**撤销必须可追溯**，否则下一个人会看到两条互相矛盾的裁决而不知道哪条生效）。
   */
  retracted: [
    {
      ruling: '裁决五',
      path: 'src/cli/index.ts',
      decided_on: '2026-10-11',
      retracted_on: '2026-10-11',
      retracted_by: 'Lead',
      was: 'change',
      now: 'keep',
      reason:
        'B1 度量的是「**将要被替换的**行为」，而 RFC §5.1 的「CLI 子命令 16 → 18」是**新增**两个子命令，不是替换两个：既有的 16 个子命令分派逻辑逐字不变（设计 §1.2 判 cli/** 沿用，理由「退出码见 §9.4」；RFC §3.3 要求「既有 CI 脚本零改动」）。裁决五的依据「16→18 物理上只能发生在 cli/index.ts」本身没错，**错在由此推出「所以它算变更」——「一个文件会被改动」与「它承载的行为会被替换」是两件事**。',
      consequence:
        '该文件判回 keep，最终变更清单仍是 **31 个文件**；按 32 文件跑出的那次读数作为**敏感性对照**保留（变体 change_superseded_ruling5，标 superseded）。',
    },
  ],
  explicit_keep: [
    {
      path: 'src/kinds/types.ts',
      basis:
        'Lead 裁决三（采纳 spec-engine 的源码核对）：① 该文件 8 项里 6 项是纯类型（interface/type，编译期消失，没有运行时可观察行为）；② 剩下 2 个值类型的行为已被现有 spec 覆盖（SkipCase → runner.md 的 runner-run-case 三条 observable + tests/skip-semantics.test.mjs；DriverRegistry 在测试里只作宿主构造工具）；③ 它进分母是设计 §1.2「`kinds/*.ts`（12 个 driver）」被 matcher 机械展开（prefix: src/kinds + suffix: .ts）时把 index.ts / types.ts 一并收进去的产物。**这是"分母错"，不是"分子缺"**。',
    },
  ],
  notes: [
    'cli/** 的粒度（裁决五已**撤销**）：既有 16 个子命令的实现与**注册表 cli/index.ts** 一律沿用；RFC §5.1 的「16 → 18」是**新增**，新增部分是新代码，不进 B1 分母（B1 只量旧代码）。撤销留痕见 RULING.retracted；按 32 文件的那次读数作为敏感性对照保留（变体 change_superseded_ruling5）。',
    '§1.2 与裁决表都未逐条点名的未列文件按 default_for_unlisted 归入沿用：src/adapters/dsh/tools.ts、src/export/node-test.ts、src/export/write.ts、src/runtime/refs.ts、src/runtime/runlog.ts。',
    '其中 src/runtime/runlog.ts 另有旁证：REWRITE-METRICS §2 A4 写「沿用既有 src/runtime/runlog.ts 的枚举」。',
    'src/kinds/index.ts **保留在变更**（Lead 裁决四）：spec-engine 已把它的成本档位真源覆盖进 policy.md::policy-driver-cost（DRIVER_COST 12 项 + withDriverCost + createDriverRegistry），它确实会随 BaseTool 化而变更。',
    'src/fixtures/**（5 个文件）**归沿用**（Lead 裁决 3）：依据是设计 §9.1 明确「复用既有 fixtures 的 dshVersion 兼容机制，不新造第二套」——这不是"文档没提"，而是**设计明确要求复用**。',
    '注册面缺口（Lead 裁决 2）：src/tools.ts 与 src/commands.ts 进了分母，spec-engine 已新增 spec/behaviors/engine/surfaces.md（engine 模块 6 → 7）用 **active** 条目 model-tools / plugin-command 覆盖它们。',
    'src/client.ts 与 lib/client.js（esbuild 产物）不进任何口径：它的编译产物被 client 半产物覆盖，无法按 TS 逐文件测量。',
  ],
}

/* ==================== ① 解析设计 §1.2 ==================== */

const design = readFileSync(DESIGN, 'utf8').split(/\r?\n/)
const start = design.findIndex((l) => /^### 1\.2 /.test(l))
if (start < 0) {
  console.error('[design-scope] docs/REWRITE-DESIGN.md 里找不到 §1.2 标题')
  process.exit(2)
}
let end = design.findIndex((l, i) => i > start && /^#{2,3} /.test(l))
if (end < 0) end = design.length
const section = design.slice(start, end)

/**
 * 把 §1.2「现状（`src/`）」列的一个格子拆成若干**路径模式**。
 * 必须保留 `*`（`isolation/**`、`kinds/*.ts` 的 glob 语义全靠它），只去掉：
 *   ① 反引号；② 中文/英文括号里的说明（如 `runtime/runner.ts`（35,876 字节））。
 */
function toPatterns(cell) {
  return cell
    .split('+')
    .map((s) =>
      s
        .replace(/`/g, '')
        .replace(/（[^）]*）/g, '')
        .replace(/\([^)]*\)/g, '')
        .trim(),
    )
    .filter(Boolean)
}

/** @type {{raw:string, cell:string, patterns:string[], nature:string, kind:'change'|'keep'|null}[]} */
const rows = []
for (const line of section) {
  if (!line.trim().startsWith('|')) continue
  const cells = line.split('|').slice(1, -1).map((c) => c.trim())
  if (cells.length < 3) continue
  if (/^-{2,}$/.test(cells[0].replace(/[-\s]/g, '-'))) continue
  if (cells[0] === '现状（`src/`）') continue
  const nature = cells[2]
  const kind = nature.includes('变更') ? 'change' : nature.includes('沿用') ? 'keep' : null
  rows.push({ raw: line.trim(), cell: cells[0], patterns: toPatterns(cells[0]), nature, kind })
}

const matchers = []
for (const row of rows) {
  if (row.kind === null) continue
  for (const pat of row.patterns) {
    if (pat.endsWith('/**')) matchers.push({ kind: row.kind, prefix: `src/${pat.slice(0, -3)}` })
    else if (pat.endsWith('/*.ts')) matchers.push({ kind: row.kind, prefix: `src/${pat.slice(0, -5)}`, suffix: '.ts' })
    else matchers.push({ kind: row.kind, exact: `src/${pat}` })
  }
}

/** §1.2 单独给出的分类（不含归属表）。unlisted = 未列。 */
function classifySection12(srcPath) {
  for (const m of matchers) {
    if (m.exact && srcPath === m.exact) return m.kind
    if (m.prefix && srcPath.startsWith(`${m.prefix}/`) && (!m.suffix || srcPath.endsWith(m.suffix))) return m.kind
  }
  return 'unlisted'
}

const explicitChange = new Set(RULING.explicit_change.map((x) => x.path))
const explicitKeep = new Set(RULING.explicit_keep.map((x) => x.path))

/** 最终分类 = §1.2 ∪ 归属表（显式移出优先）；未列默认沿用。 */
function classifyFinal(srcPath) {
  if (explicitKeep.has(srcPath)) return 'keep'
  if (explicitChange.has(srcPath)) return 'change'
  const base = classifySection12(srcPath)
  return base === 'unlisted' ? RULING.default_for_unlisted : base
}

/** 只含裁决四（不含裁决三）的分类：用于显式展示"把 types.ts 移出分母"的影响。 */
function classifyWithoutRuling3(srcPath) {
  if (explicitChange.has(srcPath)) return 'change'
  const base = classifySection12(srcPath)
  return base === 'unlisted' ? RULING.default_for_unlisted : base
}

/** 已撤销的裁决五口径：最终清单 + `src/cli/index.ts`（用于保留那次 32 文件读数作敏感性对照）。 */
function classifySupersededRuling5(srcPath) {
  if (srcPath === 'src/cli/index.ts') return 'change'
  return classifyFinal(srcPath)
}

// 自检：分类结果必须与人可复核的期望逐个一致，否则**立刻变红**（防止静默错分）
const SELF_CHECK = [
  ['src/runtime/runner.ts', 'change'],
  ['src/runtime/assert.ts', 'change'],
  ['src/runtime/fixture.ts', 'change'],
  ['src/isolation/pool.ts', 'change'],
  ['src/kinds/tool.ts', 'change'],
  ['src/kinds/index.ts', 'change'], // 裁决四：保留在变更
  ['src/kinds/types.ts', 'keep'], // 裁决三：移出分母
  ['src/report/redact.ts', 'change'],
  ['src/analysis/causes.ts', 'change'],
  ['src/tools.ts', 'change'], // 归属表新增
  ['src/commands.ts', 'change'], // 归属表新增
  ['src/executor/policy.ts', 'keep'],
  ['src/cases/loader.ts', 'keep'],
  ['src/cli/index.ts', 'keep'], // 裁决五已撤销：注册表也属沿用（新增扩展 ≠ 替换）
  ['src/cli/io.ts', 'keep'], // 既有子命令实现的组成部分 → 沿用
  ['src/http.ts', 'keep'],
  ['src/cli/commands/transfer.ts', 'keep'], // §1.2 沿用（注意：CLI 子命令数量变化落在 cli/**）
  ['src/fixtures/load.ts', 'keep'], // 未列 → 默认沿用
  ['src/surface/runs.ts', 'keep'], // 未列 → 默认沿用
  ['src/runtime/refs.ts', 'keep'], // 未列 → 默认沿用（但被 spec 的 assert 模块引用）
  ['src/headless/index.ts', 'keep'], // 未列 → 默认沿用
]
const selfCheckFailures = SELF_CHECK.filter(([p, want]) => classifyFinal(p) !== want).map(
  ([p, want]) => `${p}: 期望 ${want}，实得 ${classifyFinal(p)}`,
)
if (selfCheckFailures.length > 0) {
  console.error(`[design-scope] 自检失败（§1.2 解析或归属表有误，拒绝继续）：\n - ${selfCheckFailures.join('\n - ')}`)
  process.exit(1)
}
if (matchers.filter((m) => m.kind === 'change').length < 5) {
  console.error('[design-scope] §1.2 解析出的 change 匹配器少于 5 条，判定为解析失败，拒绝继续')
  process.exit(1)
}

/* ==================== ② 分类（基于 lib/ 现况） ==================== */

function walkJs(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walkJs(full, out)
    else if (entry.endsWith('.js')) out.push(full)
  }
  return out
}

const libFiles = walkJs(join(root, 'lib'))
const allSrc = []
for (const full of libFiles) {
  const rel = relative(join(root, 'lib'), full).split('\\').join('/')
  allSrc.push({ lib: `lib/${rel}`, src: `src/${rel.replace(/\.js$/, '.ts')}`, isClientBundle: rel === 'client.js' })
}

const srcOnly = allSrc.filter((f) => !f.isClientBundle)
const lists = {
  change_1_2_only: srcOnly.filter((f) => classifySection12(f.src) === 'change'),
  change_final: srcOnly.filter((f) => classifyFinal(f.src) === 'change'),
  change_without_ruling3: srcOnly.filter((f) => classifyWithoutRuling3(f.src) === 'change'),
  change_superseded_ruling5: srcOnly.filter((f) => classifySupersededRuling5(f.src) === 'change'),
  keep_final: srcOnly.filter((f) => classifyFinal(f.src) === 'keep'),
  unlisted_by_1_2: srcOnly.filter((f) => classifySection12(f.src) === 'unlisted'),
  cli_dir: srcOnly.filter((f) => f.src.startsWith('src/cli/')),
}
if (lists.change_final.length === 0 || lists.cli_dir.length === 0) {
  console.error('[design-scope] 分类结果为空（lib/ 是否已构建？），拒绝继续')
  process.exit(1)
}

/* ==================== ③ 跑变体（修正 export 排除） ==================== */

const BASE_EXCLUDES = [
  '--test-coverage-exclude=**/node_modules/**',
  '--test-coverage-exclude=**/tests/**',
  '--test-coverage-exclude=**/scripts/**',
  '--test-coverage-exclude=**/bin/**',
  // 精确排除生成的测试产物；**不能**写成 export 目录通配（会误伤 lib/export/*.js）
  '--test-coverage-exclude=**/export/scenarios.test.mjs',
  '--test-coverage-exclude=**/lib/client.js',
]
const TEST_FILES = ['tests/contracts/*.test.mjs', 'tests/*.test.mjs', 'export/scenarios.test.mjs']

function runVariant(label, keep) {
  const keepSet = new Set(keep.map((f) => f.lib))
  const excludes = srcOnly.filter((f) => !keepSet.has(f.lib)).map((f) => `--test-coverage-exclude=**/${f.lib}`)
  const logPath = join(root, 'baseline', `coverage-stage0-${label}.log`)
  const args = ['--test', '--experimental-test-coverage', '--enable-source-maps', ...BASE_EXCLUDES, ...excludes, ...TEST_FILES]
  const t0 = Date.now()
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  const wallMs = Date.now() - t0
  writeFileSync(logPath, r.stdout ?? '', 'utf8')

  const tmp = mkdtempSync(join(tmpdir(), `${label}-`))
  const p = spawnSync(process.execPath, [join(root, 'baseline', 'parse-coverage.mjs'), '--out-dir', tmp, logPath], {
    cwd: root,
    encoding: 'utf8',
  })
  const run = JSON.parse(readFileSync(join(tmp, 'coverage-summary.json'), 'utf8')).runs[0]
  return {
    label,
    kept_files: keep.length,
    excluded_files: excludes.length,
    test_exit_code: r.status,
    parse_exit_code: p.status,
    wall_ms: wallMs,
    command: `node ${args.join(' ')}`,
    run_valid: run.valid,
    totals: run.totals,
    aggregate: run.aggregate,
    file_rows: run.files.length,
    files: run.files,
    raw_log: `baseline/coverage-stage0-${label}.log`,
  }
}

const REPEAT_FINAL_ONLY = process.argv.includes('--repeat-final')

const variants = REPEAT_FINAL_ONLY
  ? { change_final: runVariant('change-final', lists.change_final) }
  : {
      all_src_fixed: runVariant('all-src-fixed', srcOnly),
      change_1_2_only: runVariant('change-1-2-only', lists.change_1_2_only),
      change_without_ruling3: runVariant('change-without-ruling3', lists.change_without_ruling3),
      change_superseded_ruling5: runVariant('change-superseded-ruling5', lists.change_superseded_ruling5),
      change_final: runVariant('change-final', lists.change_final),
      change_final_plus_cli: runVariant('change-final-plus-cli', [...lists.change_final, ...lists.cli_dir.filter((f) => classifyFinal(f.src) !== 'change')]),
      legacy_change_plus_unlisted: runVariant('change-plus-unlisted', [...lists.change_1_2_only, ...lists.unlisted_by_1_2]),
    }

if (REPEAT_FINAL_ONLY) {
  // 复采模式：只跑判定口径，把读**追加**进 baseline/coverage-final-repeat.json（不覆盖主产物）
  const repeatPath = join(root, 'baseline', 'coverage-final-repeat.json')
  let history = []
  try {
    history = JSON.parse(readFileSync(repeatPath, 'utf8')).readings ?? []
  } catch {
    history = []
  }
  const v = variants.change_final
  history.push({ measured_at: new Date().toISOString(), file_rows: v.file_rows, aggregate: v.aggregate, test_exit_code: v.test_exit_code, wall_ms: v.wall_ms })
  writeFileSync(
    repeatPath,
    `${JSON.stringify(
      {
        purpose: '判定口径（change_final）的复采记录：REWRITE-METRICS §18 + coverage.md §4.6 的"落在门槛 ±0.1pp 内必须重采并报两次"纪律',
        variant: 'change_final',
        files: v.files.length,
        readings: history,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const branches = history.map((h) => h.aggregate.branch)
  console.log(`[repeat] change_final branch = ${branches.join(' / ')}（${history.length} 次）`)
  process.exit(v.file_rows > 0 && v.test_exit_code === 0 ? 0 : 1)
}

/* ==================== ④ 产物 ==================== */

const designScope = {
  generated_at: new Date().toISOString(),
  section_source: 'docs/REWRITE-DESIGN.md §1.2（现状 → 目标 的对应关系）',
  section_lines: `${start + 1}-${end}`,
  ruling: RULING,
  parsed_rows: rows,
  matchers,
  counts: {
    change_1_2_only: lists.change_1_2_only.length,
    change_without_ruling3: lists.change_without_ruling3.length,
    change_superseded_ruling5: lists.change_superseded_ruling5.length,
    change_final: lists.change_final.length,
    keep_final: lists.keep_final.length,
    unlisted_by_1_2: lists.unlisted_by_1_2.length,
    cli_dir: lists.cli_dir.length,
    total_src_files_mapped: srcOnly.length,
  },
  change_1_2_only: lists.change_1_2_only.map((f) => f.src).sort(),
  change_without_ruling3: lists.change_without_ruling3.map((f) => f.src).sort(),
  change_superseded_ruling5: lists.change_superseded_ruling5.map((f) => f.src).sort(),
  change_final: lists.change_final.map((f) => f.src).sort(),
  change_final_added_by_ruling: lists.change_final
    .filter((f) => classifySection12(f.src) !== 'change')
    .map((f) => f.src)
    .sort(),
  change_final_removed_by_ruling3: RULING.explicit_keep.map((x) => x.path).sort(),
  keep_final: lists.keep_final.map((f) => f.src).sort(),
  unlisted_by_1_2: lists.unlisted_by_1_2.map((f) => f.src).sort(),
  note: '分类规则见 ruling：§1.2 未列的模块默认归「沿用」；被显式点名者为「变更」（tools.ts / commands.ts），被显式移出者为「沿用」（kinds/types.ts，裁决三）',
}
writeFileSync(join(root, 'baseline', 'design-scope.json'), `${JSON.stringify(designScope, null, 2)}\n`, 'utf8')

const result = {
  generated_at: new Date().toISOString(),
  purpose: 'B1 的设计口径（Lead 裁决二 + 未列模块归属裁决）：分母 = §1.2「变更」∪ 归属表显式点名者',
  ruling: RULING,
  classification: designScope.counts,
  change_final: designScope.change_final,
  change_final_added_by_ruling: designScope.change_final_added_by_ruling,
  change_final_removed_by_ruling3: designScope.change_final_removed_by_ruling3,
  keep_final: designScope.keep_final,
  measurement_fix:
    '基础排除项里的 export 目录通配改为只匹配生成的测试产物那一项（前者会误伤 lib/export/node-test.js 与 lib/export/write.js）',
  variants,
  guard: 'file_rows === 0 ⇒ 退出码 1（空集合上的 100% 不是覆盖率）',
}
writeFileSync(join(root, 'baseline', 'coverage-change-scope.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8')

for (const [k, v] of Object.entries(variants)) {
  console.log(
    `[${k}] kept=${String(v.kept_files).padStart(3)} excluded=${String(v.excluded_files).padStart(3)} rows=${String(v.file_rows).padStart(3)} test_exit=${v.test_exit_code} wall=${(v.wall_ms / 1000).toFixed(1)}s  aggregate=${JSON.stringify(v.aggregate)}`,
  )
}
console.log(`\n分类计数：${JSON.stringify(designScope.counts)}`)
console.log(`补全后新增进分母的：${designScope.change_final_added_by_ruling.join(', ')}`)

const bad = Object.values(variants).filter((v) => v.file_rows === 0 || v.test_exit_code !== 0)
if (bad.length > 0) {
  console.error(`[design-scope] 变体异常：${bad.map((v) => v.label).join(', ')}`)
  process.exit(1)
}
