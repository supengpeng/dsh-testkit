#!/usr/bin/env node
// spec/ 守卫：校验 spec/behaviors/**/*.md 的 YAML front-matter。
//
// 用法： node spec/schema/validate-spec.mjs [--json]
// 退出码： 0 = 全部通过；1 = 存在错误；2 = 用法/环境错误
//
// 校验四件事（spec/README.md §3.1）：
//   1. 格式：front-matter 满足 schema/behavior.schema.json（格式真源）。
//   2. 追溯可落地：source.file 存在、symbols 能在其中检索到、tests 引用指向真实文件。
//   3. 唯一性：原子条目 id 全局唯一，同一文件内 atomic 名不重复。
//   4. 与设计对齐：kinds 域的 atomic 集合必须与 REWRITE-DESIGN.md §2.2 的映射表逐项相等（不多不少）。
// 只读：不写任何文件。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// --root <dir>  覆盖 spec 目录（含 behaviors/）；供 selftest.mjs 在临时目录里做负向证明
// --repo <dir>  覆盖仓库根（source 追溯核对的对象）
const SPEC_DIR = argValue('--root') ? resolve(argValue('--root')) : resolve(HERE, '..');
const REPO_DIR = argValue('--repo') ? resolve(argValue('--repo')) : resolve(SPEC_DIR, '..');
const SCHEMA_PATH = join(HERE, 'behavior.schema.json'); // schema 永远是本脚本旁的这一份（格式真源）
const BEHAVIORS_DIR = join(SPEC_DIR, 'behaviors');

const asJson = process.argv.includes('--json');

// ------------------------------------------------- 设计 §2.2 的期望原子表（守卫期望值）
// 真源：docs/REWRITE-DESIGN.md §2.2「既有 12 个 kind 到 BaseTool 的映射」。
// 该节变更时必须同步这里——这正是守卫的作用（防止 spec 悄悄漏掉一个原子）。
const EXPECTED_KIND_ATOMICS = {
  tool: ['register-tool', 'call-tool'],
  prompt: ['assemble-prompt', 'inject-section'],
  llm: ['intercept-llm-stream'],
  interaction: ['answer-question', 'answer-approval'],
  session: ['run-command', 'flush-session', 'goal-op', 'observe-events'],
  resource: ['fake-provider'],
  agent: ['spawn-agent'],
  ui: ['load-client-bundle'],
  shell: ['run-argv'],
  file: ['read-file', 'glob-file', 'search-file'],
  fs: ['fs-resolve', 'fs-stat', 'fs-read', 'fs-list', 'fs-write', 'fs-edit'],
  compaction: ['compaction-if-needed', 'compaction-region', 'compaction-now', 'compaction-inspect', 'compaction-dump'],
};

// ------------------------------------------------------------------ YAML 载入
let YAML;
try {
  ({ default: YAML } = await import('yaml'));
} catch {
  YAML = null;
}

function parseFrontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { ok: false, reason: '缺少 YAML front-matter（文件必须以 --- 开头，以 --- 结束）' };
  if (!YAML) return { ok: false, reason: '缺少 yaml 依赖，无法解析 front-matter' };
  try {
    return { ok: true, data: YAML.parse(m[1]) ?? {} };
  } catch (e) {
    return { ok: false, reason: `front-matter YAML 解析失败：${e.message}` };
  }
}

// --------------------------------------------------- 极简 JSON Schema 校验器
// 支持：type / required / properties / items / minItems / minLength / minimum /
//       enum / pattern / oneOf / additionalProperties / $ref（#/$defs/*）
function validate(node, schema, path, errors, root) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.$ref) {
    const ref = schema.$ref;
    if (!ref.startsWith('#/')) {
      errors.push(`${path}: 不支持的 $ref ${ref}`);
      return;
    }
    let target = root;
    for (const seg of ref.slice(2).split('/')) target = target?.[seg];
    if (!target) {
      errors.push(`${path}: $ref ${ref} 无法解析`);
      return;
    }
    return validate(node, target, path, errors, root);
  }

  if (schema.oneOf) {
    const branches = schema.oneOf.map((s) => {
      const local = [];
      validate(node, s, path, local, root);
      return local;
    });
    if (!branches.some((b) => b.length === 0)) {
      errors.push(`${path}: 不满足 oneOf 的任何一支（值=${JSON.stringify(node)}）`);
    }
    return;
  }

  if (schema.enum && !schema.enum.includes(node)) {
    errors.push(`${path}: 取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' | ')}，实际 ${JSON.stringify(node)}`);
    return;
  }

  if (schema.type) {
    const t = schema.type;
    const actual = Array.isArray(node) ? 'array' : node === null ? 'null' : typeof node;
    if (t === 'object' && actual !== 'object') {
      errors.push(`${path}: 期望 object，实际 ${actual}`);
      return;
    }
    if (t === 'integer' && !(actual === 'number' && Number.isInteger(node))) {
      errors.push(`${path}: 期望 integer，实际 ${JSON.stringify(node)}`);
      return;
    }
    if (t !== 'object' && t !== 'integer' && t !== actual) {
      errors.push(`${path}: 期望 ${t}，实际 ${actual}（值=${JSON.stringify(node)}）`);
      return;
    }
  }

  if (typeof node === 'number' && schema.minimum !== undefined && node < schema.minimum) {
    errors.push(`${path}: ${node} < minimum ${schema.minimum}`);
  }

  if (typeof node === 'string') {
    if (schema.minLength !== undefined && node.length < schema.minLength) {
      errors.push(`${path}: 长度 ${node.length} < minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) {
      errors.push(`${path}: "${node}" 不匹配 ${schema.pattern}`);
    }
  }

  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      errors.push(`${path}: 元素数 ${node.length} < minItems ${schema.minItems}`);
    }
    if (schema.items) node.forEach((v, i) => validate(v, schema.items, `${path}[${i}]`, errors, root));
    return;
  }

  if (node && typeof node === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in node)) errors.push(`${path}: 缺少必填字段 "${key}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in node) validate(node[key], sub, `${path}.${key}`, errors, root);
    }
  }
}

// --------------------------------------------------------- 仓库事实（追溯核对）
const fileCache = new Map();
function readRepoFile(rel) {
  if (fileCache.has(rel)) return fileCache.get(rel);
  const abs = join(REPO_DIR, rel);
  let out = null;
  try {
    if (existsSync(abs) && statSync(abs).isFile()) out = readFileSync(abs, 'utf8');
  } catch {
    out = null;
  }
  fileCache.set(rel, out);
  return out;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------- 主流程
if (!existsSync(SCHEMA_PATH)) {
  console.error(`[spec-guard] 找不到 ${SCHEMA_PATH}`);
  process.exit(2);
}
const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

const files = walk(BEHAVIORS_DIR).sort();
const seenIds = new Map();
const results = [];
const kindsSeen = new Map(); // module -> Set(atomic)
let errorCount = 0;
let warningCount = 0;
let entryCount = 0;

for (const file of files) {
  const rel = relative(REPO_DIR, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');
  const errors = [];
  const warnings = [];

  const fm = parseFrontMatter(text);
  if (!fm.ok) {
    errors.push(fm.reason);
    results.push({ file: rel, errors, warnings });
    errorCount += errors.length;
    continue;
  }

  validate(fm.data, schema, '(front-matter)', errors, schema);
  const d = fm.data;
  const entries = Array.isArray(d.atomics) ? d.atomics : [];
  entryCount += entries.length;

  const fileModule = typeof d.module === 'string' ? d.module : rel;

  entries.forEach((e, i) => {
    const at = `atomics[${i}]`;
    const label = e && typeof e.id === 'string' ? e.id : at;

    if (e && typeof e.id === 'string') {
      if (seenIds.has(e.id)) errors.push(`${label}: id 与 ${seenIds.get(e.id)} 重复（id 必须全局唯一）`);
      else seenIds.set(e.id, rel);
    }

    // 追溯核对：source.file 存在，symbols 能在其中检索到，tests 引用可落地。
    const src = e?.source;
    if (src && typeof src.file === 'string') {
      const content = readRepoFile(src.file);
      if (content === null) {
        errors.push(`${label}: source.file 不存在或不可读：${src.file}`);
      } else {
        for (const sym of src.symbols ?? []) {
          if (!content.includes(sym)) {
            errors.push(`${label}: source.symbols 中的 "${sym}" 无法在 ${src.file} 中检索到（追溯不可猜）`);
          }
        }
      }
    }
    for (const t of src?.tests ?? []) {
      const filePart = String(t).split('::')[0];
      if (!filePart) continue;
      if (readRepoFile(filePart) === null) {
        errors.push(`${label}: source.tests 引用的文件不存在：${filePart}`);
      }
    }

    if ((src?.tests ?? []).length === 0) {
      warnings.push(`${label}: source.tests 为空——该原子当前无既有测试覆盖（阶段 1 需补测试）`);
    }
    if (!e?.nonDeterministic || e.nonDeterministic.length === 0) {
      warnings.push(`${label}: nonDeterministic 为空——请确认该行为确实无时间戳/路径/浮点/哈希序等非确定字段`);
    }

    // 同文件内 atomic 名唯一
    if (e && typeof e.atomic === 'string') {
      const set = kindsSeen.get(fileModule) ?? new Set();
      if (set.has(e.atomic)) errors.push(`${label}: 同一模块内 atomic 名 "${e.atomic}" 重复`);
      set.add(e.atomic);
      kindsSeen.set(fileModule, set);
    }
  });

  errorCount += errors.length;
  warningCount += warnings.length;
  results.push({ file: rel, module: fileModule, domain: d.domain, entries: entries.length, errors, warnings });
}

// ------------------------- 与设计 §2.2 逐项对齐（仅 kinds 域，且仅在文件存在时判缺失）
const alignment = [];
if (files.length > 0) {
  for (const [kind, expected] of Object.entries(EXPECTED_KIND_ATOMICS)) {
    const got = kindsSeen.get(kind);
    if (!got) {
      alignment.push({ kind, status: 'missing-file', missing: expected, extra: [] });
      continue;
    }
    const missing = expected.filter((a) => !got.has(a));
    const extra = [...got].filter((a) => !expected.includes(a));
    if (missing.length || extra.length) alignment.push({ kind, status: 'mismatch', missing, extra });
  }
}

const summary = {
  specDir: SPEC_DIR,
  files: files.length,
  entries: entryCount,
  uniqueIds: seenIds.size,
  errors: errorCount,
  warnings: warningCount,
  kindAlignment: alignment,
  results,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`[spec-guard] spec/behaviors：${files.length} 个模块文件 / ${entryCount} 条原子条目 / ${seenIds.size} 个唯一 id`);
  for (const r of results) {
    if (r.errors.length === 0 && r.warnings.length === 0) continue;
    console.log(`\n${r.file}`);
    for (const e of r.errors) console.log(`  ERROR   ${e}`);
    for (const w of r.warnings) console.log(`  WARN    ${w}`);
  }
  if (alignment.length) {
    console.log('\n--- 与 REWRITE-DESIGN §2.2 的对齐差异 ---');
    for (const a of alignment) {
      console.log(`  ${a.kind.padEnd(12)} ${a.status}` +
        (a.missing.length ? `  缺失=[${a.missing.join(', ')}]` : '') +
        (a.extra.length ? `  多余=[${a.extra.join(', ')}]` : ''));
    }
  }
  console.log(`\n错误 ${errorCount} 条，警告 ${warningCount} 条`);
}

process.exit(errorCount > 0 ? 1 : 0);
