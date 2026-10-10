#!/usr/bin/env node
// H3 守卫：跨语言类型同步一致率 = 重新生成的结果与仓库里提交的完全一致。
//
// 为什么需要它（REWRITE-METRICS §9 的 H3 落地形式）：
// `src/contracts/generated/` 里的类型由 `crates/protocol` 的 ts-rs 导出，
// 纪律是"**禁止手改**"。但**声明挡不住手改，diff 挡得住**——这个脚本就是那个 diff。
//
// 用法：
//   node scripts/check-generated-types.mjs            # 生成 + 比对
//   node scripts/check-generated-types.mjs --no-regen # 只比对（不跑 cargo，用于快速检查）
//
// 环境：
//   CARGO  可执行文件路径；缺省 `cargo`（会从 PATH 找）。
//   需要与 `cargo test -p dsh-testkit-protocol` 相同的环境（GNU target 下还需
//   MinGW binutils 的 as/dlltool —— 见 spec/metrics/toolchain.md §7）。
//
// 退出码：0 = 一致（或在"目录尚未入库"这种无法判定的情形下如实降级）；
//         1 = 不一致（有人手改了生成物，或 Rust 侧类型变了却忘了重新生成）；
//         2 = 环境问题（cargo 不可用等）——**不静默跳过**。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const GEN_DIR = join(REPO, 'src', 'contracts', 'generated');
const GEN_REL = 'src/contracts/generated';
const CARGO = process.env.CARGO ?? 'cargo';
const noRegen = process.argv.includes('--no-regen');

function fail(msg) {
  console.error(`[verify-types] FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(GEN_DIR)) {
  console.error(
    `[verify-types] 找不到 ${GEN_REL}/。\n` +
      '  这不是"没有生成物"，而是"生成步骤从未跑过或产物被删"——两者都必须被看见。\n' +
      '  生成方式：cargo test -p dsh-testkit-protocol（ts-rs 的 export 是测试期副作用）',
  );
  process.exit(2);
}

// ---- 1. 重新生成（ts-rs 的导出是 `cargo test` 的副作用）----
if (!noRegen) {
  console.log('[verify-types] 重新生成跨语言类型：cargo test -p dsh-testkit-protocol');
  const gen = spawnSync(CARGO, ['test', '-p', 'dsh-testkit-protocol'], {
    cwd: REPO,
    stdio: 'inherit',
  });
  if (gen.error) {
    console.error(
      `[verify-types] 无法运行 ${CARGO}：${gen.error.message}\n` +
        '  本机 cargo 不在 PATH 时请设 CARGO 环境变量，例如：\n' +
        "    $env:CARGO='C:\\toolchains\\cargo\\bin\\cargo.exe'",
    );
    process.exit(2);
  }
  if (gen.status !== 0) {
    console.error(`[verify-types] 生成步骤失败（exit ${String(gen.status)}）——不能继续比对`);
    process.exit(2);
  }
}

// ---- 2. 比对：生成物不得相对仓库内容有任何变化 ----
//
// 判据用两条，而不是 `git status --porcelain`：
//   ① `git diff --exit-code`（**工作区 vs 索引**）—— 它精确表示"生成之后被改过"；
//   ② `git ls-files --others`（未入库的生成物）—— 它表示"Rust 侧新增了类型但没提交"。
//
// 为什么**不用** `git status`：它把「刚 `git add` 未提交的新增文件」显示为 `A`，
// 而那**不是**不一致（那只是"还没提交"）。用 status 会让"add 完立刻跑守卫"误报失败——
// 这个精度缺陷是我做负向证明时发现的，它比"守卫不报"更隐蔽：**误报会让人开始忽略守卫**。

const git = (args) =>
  spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });

const trackedRes = git(['ls-files', '--', GEN_REL]);
if (trackedRes.error) {
  console.error(`[verify-types] 无法运行 git：${trackedRes.error.message}`);
  process.exit(2);
}
const tracked = (trackedRes.stdout ?? '').split('\n').filter((l) => l !== '');

// 整个目录还没入库 ⇒ 无法判定"是否被手改"。如实降级，不假装通过。
if (tracked.length === 0) {
  console.warn(
    `[verify-types] WARN：${GEN_REL} 尚未被 git 跟踪（整体为未跟踪状态），` +
      '本次**无法**判定是否被手改。首次提交之后本守卫才会真正生效。\n' +
      '  这不是通过，也不是失败——是"守卫还没上线"。',
  );
  process.exit(0);
}

const diffRes = git(['diff', '--exit-code', '--', GEN_REL]);
const untrackedRes = git(['ls-files', '--others', '--exclude-standard', '--', GEN_REL]);
const untracked = (untrackedRes.stdout ?? '').split('\n').filter((l) => l !== '');

if (diffRes.status === 0 && untracked.length === 0) {
  console.log(
    `[verify-types] OK：${GEN_REL} 与仓库内容逐字节一致（H3 = 100%，已跟踪 ${String(tracked.length)} 个文件）`,
  );
  process.exit(0);
}

console.error('[verify-types] FAIL：生成物与仓库内容不一致。');
if (diffRes.status !== 0) {
  console.error('\n  ① 生成之后被改动（工作区 ≠ 索引）：');
  const changed = (diffRes.stdout ?? '').split('\n').filter((l) => l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff --git'));
  for (const l of changed) console.error(`     ${l}`);
}
if (untracked.length > 0) {
  console.error(`\n  ② 有 ${String(untracked.length)} 个生成物未入库（Rust 侧新增了类型但没提交？）：`);
  for (const l of untracked.slice(0, 20)) console.error(`     ${l}`);
  if (untracked.length > 20) console.error(`     …还有 ${String(untracked.length - 20)} 个`);
}
console.error(
  '\n  两种可能，处理方式不同：\n' +
    '  ① 有人手改了 src/contracts/generated/** ⇒ 那是违规改动，应丢弃（该目录禁止手改）；\n' +
    '  ② Rust 侧类型变了（crates/protocol/**）⇒ 这是**正确的**，把重新生成的结果一并提交。\n' +
    '  判别方法：git diff -- crates/protocol —— 有改动就是 ②，没有就是 ①。',
);
process.exit(1);
