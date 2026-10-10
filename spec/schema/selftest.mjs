#!/usr/bin/env node
// validate-spec.mjs 的自测与负向证明（REWRITE-METRICS §18：测量工具自身也必须被测）。
//
// 两类断言：
//   正向 —— 一份合法 spec 必须通过（exit 0）。
//   负向 —— 每一类错误都必须被**点名检出**（exit 1 且报错文本包含特征串）。
//           如果注入的错误没被检出，本自测失败 —— 守卫就成了安慰剂。
//
// 用法： node spec/schema/selftest.mjs
// 退出码： 0 = 自测通过；1 = 自测失败

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'validate-spec.mjs');

const failures = [];
let checks = 0;

function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-spec-selftest-'));
  const spec = join(root, 'spec');
  const repo = join(root, 'repo');
  mkdirSync(join(spec, 'behaviors', 'kinds'), { recursive: true });
  mkdirSync(join(repo, 'src', 'kinds'), { recursive: true });
  mkdirSync(join(repo, 'tests'), { recursive: true });
  return { root, spec, repo };
}

function runGuard(spec, repo) {
  // 用人类可读输出做断言：--json 会把报错文本里的引号转义成 \"，导致特征串匹配失败。
  const r = spawnSync(process.execPath, [GUARD, '--root', spec, '--repo', repo], {
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function check(name, cond, detail) {
  checks += 1;
  if (!cond) failures.push(`${name}${detail ? ` —— ${detail}` : ''}`);
}

// ------------------------------------------------------------------ 正向：合法条目
{
  const { root, spec, repo } = makeWorkspace();
  writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
  writeFileSync(join(repo, 'tests', 'file-driver.test.mjs'), '// test\n', 'utf8');
  writeFileSync(
    join(spec, 'behaviors', 'kinds', 'file.md'),
    `---
domain: kinds
module: file
revision: 1
atomics:
  - id: BEH-KIND-FILE-001
    title: read-file 读取已存在的文件
    atomic: read-file
    status: draft
    source:
      file: src/kinds/file.ts
      symbols: ["runFileRead"]
      tests: ["tests/file-driver.test.mjs"]
    capabilities: []
    availableIn: Any
    costTier: none
    parallel: exclusive
    observable:
      - given: "文件存在"
        when: "op: read"
        then: "返回内容逐字相等"
        verdict: pass
    cleanup: none
    nonDeterministic:
      - field: durationMs
        reason: 挂钟时间
        reconcile: ignore
---
## read-file
正文。
`,
    'utf8',
  );
  const { code, out } = runGuard(spec, repo);
  check('正向：合法条目应通过', code === 0, `exit=${code} out=${out.slice(0, 400)}`);
  rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------- 负向：逐类错误必须被点名检出
const badCases = [
  {
    name: '负向①：source.symbols 在文件中不存在（追溯不可猜）',
    expect: '无法在',
    build: (spec, repo) => {
      writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
      writeFileSync(join(repo, 'tests', 'file-driver.test.mjs'), '// test\n', 'utf8');
      writeFileSync(
        join(spec, 'behaviors', 'kinds', 'file.md'),
        `---
domain: kinds
module: file
atomics:
  - id: BEH-KIND-FILE-001
    title: 符号不存在的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["thisSymbolDoesNotExist"], tests: ["tests/file-driver.test.mjs"] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`,
        'utf8',
      );
    },
  },
  {
    name: '负向②：source.file 不存在',
    expect: 'source.file 不存在',
    build: (spec) => {
      writeFileSync(
        join(spec, 'behaviors', 'kinds', 'ghost.md'),
        `---
domain: kinds
module: ghost
atomics:
  - id: BEH-KIND-GHOST-001
    title: 源文件不存在的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/ghost.ts, symbols: ["x"], tests: [] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`,
        'utf8',
      );
    },
  },
  {
    name: '负向③：source.tests 引用的测试文件不存在',
    expect: 'source.tests 引用的文件不存在',
    build: (spec, repo) => {
      writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
      writeFileSync(
        join(spec, 'behaviors', 'kinds', 'file.md'),
        `---
domain: kinds
module: file
atomics:
  - id: BEH-KIND-FILE-001
    title: 测试引用不存在的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: ["tests/nope.test.mjs"] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`,
        'utf8',
      );
    },
  },
  {
    name: '负向④：必填字段缺失（observable）',
    expect: '缺少必填字段 "observable"',
    build: (spec, repo) => {
      writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
      writeFileSync(
        join(spec, 'behaviors', 'kinds', 'file.md'),
        `---
domain: kinds
module: file
atomics:
  - id: BEH-KIND-FILE-001
    title: 缺 observable 的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: [] }
    capabilities: []
    availableIn: Any
---
`,
        'utf8',
      );
    },
  },
  {
    name: '负向⑤：id 格式非法',
    expect: '不匹配',
    build: (spec, repo) => {
      writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
      writeFileSync(
        join(spec, 'behaviors', 'kinds', 'file.md'),
        `---
domain: kinds
module: file
atomics:
  - id: FILE-1
    title: id 非法的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: [] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`,
        'utf8',
      );
    },
  },
  {
    name: '负向⑥：id 重复（跨文件）',
    expect: '重复',
    build: (spec, repo) => {
      writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
      const body = (mod) => `---
domain: kinds
module: ${mod}
atomics:
  - id: BEH-KIND-FILE-001
    title: 重复 id 的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: [] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`;
      writeFileSync(join(spec, 'behaviors', 'kinds', 'file.md'), body('file'), 'utf8');
      writeFileSync(join(spec, 'behaviors', 'kinds', 'file2.md'), body('file2'), 'utf8');
    },
  },
  {
    name: '负向⑦：status 取值非法',
    expect: '取值必须是',
    build: (spec, repo) => {
      writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
      writeFileSync(
        join(spec, 'behaviors', 'kinds', 'file.md'),
        `---
domain: kinds
module: file
atomics:
  - id: BEH-KIND-FILE-001
    title: status 非法的条目
    atomic: read-file
    status: totally-fine
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: [] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`,
        'utf8',
      );
    },
  },
  {
    name: '负向⑧：front-matter 缺失',
    expect: '缺少 YAML front-matter',
    build: (spec) => {
      writeFileSync(join(spec, 'behaviors', 'kinds', 'nofm.md'), '# 没有 front-matter\n', 'utf8');
    },
  },
];

for (const c of badCases) {
  const { root, spec, repo } = makeWorkspace();
  c.build(spec, repo);
  const { code, out } = runGuard(spec, repo);
  check(c.name, code === 1 && out.includes(c.expect), `exit=${code} 期望含「${c.expect}」 实际=${out.slice(0, 300)}`);
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------- 负向：与 §2.2 的原子差异必须被点名
{
  const { root, spec, repo } = makeWorkspace();
  writeFileSync(join(repo, 'src', 'kinds', 'file.ts'), 'export function runFileRead() {}\n', 'utf8');
  writeFileSync(
    join(spec, 'behaviors', 'kinds', 'file.md'),
    `---
domain: kinds
module: file
atomics:
  - id: BEH-KIND-FILE-001
    title: 原子名偏离设计 §2.2 的条目
    atomic: read-file
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: [] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
  - id: BEH-KIND-FILE-002
    title: 设计里没有的原子
    atomic: invented-tool
    status: draft
    source: { file: src/kinds/file.ts, symbols: ["runFileRead"], tests: [] }
    capabilities: []
    availableIn: Any
    observable: [ { given: a, when: b, then: c, verdict: pass } ]
---
`,
    'utf8',
  );
  const { code, out } = runGuard(spec, repo);
  // 对齐差异不进入 errorCount（它是覆盖信息），但必须被打印出来且与设计表吻合。
  check('负向⑨：与 §2.2 的差异必须被列出（多余原子）', out.includes('invented-tool'), `out=${out.slice(0, 400)}`);
  check('负向⑨：与 §2.2 的差异必须被列出（缺失原子）', out.includes('glob-file'), `out=${out.slice(0, 400)}`);
  rmSync(root, { recursive: true, force: true });
}

// -------------------------------------------------------------------- 结果
if (failures.length === 0) {
  console.log(`[spec-guard selftest] 通过：${checks} 项断言全部成立（含 ${badCases.length + 1} 类负向证明）`);
  process.exit(0);
}
console.log(`[spec-guard selftest] 失败 ${failures.length}/${checks} 项：`);
for (const f of failures) console.log(`  - ${f}`);
process.exit(1);
