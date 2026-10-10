#!/usr/bin/env node
/**
 * `gate` 的并发守卫（缺陷台账 D-2）。
 *
 * ## 它防的是什么
 *
 * `pnpm run gate` 的第一步是 `rm -rf lib && tsc`。**两个 gate 并发时，后启动的那个会删掉
 * 先启动那个正在被测试读取的 `lib/`**，于是半个测试树报 `ERR_MODULE_NOT_FOUND`——
 * 而错误**全部指向别人的测试文件**（`triage` / `ui-driver` / `policy-gate` / …），
 * 看起来像"整棵树被谁改坏了"。
 *
 * 实测证据（`rust-scheduler`，2026-10-11）：抓到 PID 7848（01:52:33）、716（01:54:21）两个并发实例，
 * 同一时刻单独跑 `node --test tests/rpc.test.mjs` → 39/39 全绿、`tsc --noEmit` → exit 0。
 * 也就是说：**"gate 红"与"代码红"在那段时间是两个不相干的读数。**
 *
 * ## 为什么是「显式报错」而不是「排队等待」
 *
 * 排队（拿不到锁就 sleep 重试）会把"**两个人在同时验收**"这件事**藏起来**——
 * 第二个 gate 静静等到第一个结束，看上去一切正常，而真正的问题（工作区不支持并发验收）
 * 从来不会被处理。**显式报错**让它在当场的第一个时刻就成为一个必须处理的事实。
 *
 * 这与本仓一贯的处置同源：**宁可红得难看，不要绿得可疑。**
 *
 * ## 更根本的原因（值得记住）
 *
 * 这条缺陷的触发条件是**多 Agent 共享一个工作目录**——在单机单人开发里它几乎不会出现。
 * 它的存在提醒：**Agent Teams 的"共享文件系统"不仅共享代码，也共享构建产物**，
 * 所以**验收步骤必须串行**，而任何"可被并发破坏"的步骤都该自己说出来。
 *
 * ## 用法
 *
 * ```sh
 * node scripts/gate-guard.mjs            # 获取锁（拿不到就报错退出）
 * node scripts/gate-guard.mjs --release  # 释放锁（放在 gate 脚本链的末尾）
 * ```
 *
 * 环境变量 `DSH_TESTKIT_GATE_NO_LOCK=1` 可绕过（**仅限你确知没有并发时**）。
 *
 * 退出码：0 = 拿到锁 / 正常释放；1 = 检测到并发（**这不是代码问题，是环境问题**）。
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// 锁放在**系统临时目录**而不是仓库里，原因有二：
//   ① gate 的第一步就 `rm -rf lib`——锁放在 `lib/` 下会当场被删掉，等于没有锁；
//   ② 不进仓库 ⇒ 不需要改 `.gitignore`，也不会被 `check-pack-files` 之类扫到。
// 用仓库路径的 hash 做区分，这样同一台机器上的两个 checkout 互不干扰。
const key = createHash('sha256').update(REPO).digest('hex').slice(0, 12);
const LOCK = join(tmpdir(), `dsh-testkit-gate-${key}.lock`);
/** 锁被认为陈旧的上限（分钟）——防 PID 被系统复用后误判为"还在跑"。 */
const STALE_MINUTES = 30;

const release = process.argv.includes('--release');

if (process.env.DSH_TESTKIT_GATE_NO_LOCK === '1') {
  // 显式绕过：仍然打印一行，让它**在日志里留下痕迹**（否则"为什么这次没拦"无从追溯）。
  console.log('[gate-guard] 已按 DSH_TESTKIT_GATE_NO_LOCK=1 跳过并发检查');
  process.exit(0);
}

function readLock() {
  if (!existsSync(LOCK)) return null;
  try {
    return JSON.parse(readFileSync(LOCK, 'utf8'));
  } catch {
    // 锁文件损坏 ⇒ 当成陈旧锁处理（它不可能是"正在跑的 gate"留下的完整记录）。
    return { pid: -1, startedAt: 0, corrupted: true };
  }
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = 进程存在但当前用户无权发信号 ⇒ **它活着**（这一条很容易写错）。
    return e?.code === 'EPERM';
  }
}

function clearLock(why) {
  try {
    rmSync(LOCK, { force: true });
    console.log(`[gate-guard] 已清理陈旧锁（${why}）`);
  } catch {
    /* 清不掉也不是致命问题：下面的写入会覆盖它 */
  }
}

if (release) {
  const held = readLock();
  // 与写锁时同一个判据：**持有者是本 gate 的 shell 进程**（`process.ppid`）。
  if (held !== null && held.pid === process.ppid) {
    clearLock('本次 gate 正常结束');
  } else if (held !== null) {
    // 锁不是自己这套 gate 拿的 ⇒ **不要删**（否则会替别人释放，让并发检测失效）。
    console.log(
      `[gate-guard] 锁属于 gate 进程 PID ${String(held.pid)}，不是本 gate（${String(process.ppid)}），保留不动`,
    );
  }
  process.exit(0);
}

const held = readLock();
if (held !== null) {
  const ageMin = (Date.now() - (held.startedAt ?? 0)) / 60000;
  if (isAlive(held.pid) && ageMin < STALE_MINUTES) {
    console.error(
      [
        '[gate-guard] 检测到另一个 gate 正在运行，拒绝并发启动。',
        '',
        `  持有者 PID : ${String(held.pid)}`,
        `  启动于     : ${new Date(held.startedAt).toISOString()}（${ageMin.toFixed(1)} 分钟前）`,
        `  锁文件     : ${LOCK}`,
        '',
        '  为什么必须拒绝：gate 的第一步是 `rm -rf lib && tsc`，两个 gate 会互删构建目录，',
        '  导致半个测试树报 ERR_MODULE_NOT_FOUND —— 而错误会指向**别人的测试文件**，',
        '  看起来像"代码坏了"。这类假红会让人去改本来正确的代码。',
        '',
        '  怎么做：',
        '    · 等它结束（这是正常做法；多人/多 Agent 共享工作目录时，验收步骤要串行）；',
        '    · 或确认它已死掉后重跑（陈旧锁会被自动清理）。',
      ].join('\n'),
    );
    process.exit(1);
  }
  clearLock(
    held.corrupted
      ? '锁文件损坏'
      : isAlive(held.pid)
        ? `持有者 PID ${String(held.pid)} 已超过 ${String(STALE_MINUTES)} 分钟`
        : `持有者 PID ${String(held.pid)} 已不存在`,
  );
}

// ⚠️ 锁的持有者记的是**父进程**（`process.ppid`），不是本进程——这一点写错过一次，记下来：
//
// guard 是**独立进程**，写完锁就退出。如果锁记自己的 PID，那么"持有者是否还活着"**永远为假**，
// 于是并发检测会**静默失效**：看起来有锁、日志也正常，实际从不拦截任何人。
// （这类"守卫看起来在工作、实际恒不触发"的缺陷，只有负向证明能抓出来。）
//
// guard 的父进程正是 `pnpm run gate` 的 shell，它在**整个 gate 期间**都活着、gate 结束后才退出——
// 那恰好就是这把锁该有的生命周期。
const ownerPid = process.ppid;
writeFileSync(
  LOCK,
  JSON.stringify(
    { pid: ownerPid, guardPid: process.pid, startedAt: Date.now(), repo: REPO },
    null,
    2,
  ),
  'utf8',
);
console.log(`[gate-guard] 已获取锁（gate 进程 PID ${String(ownerPid)}）`);

// 本进程随后退出是**故意的**：锁的生命周期挂在父进程上，所以"自动释放"不会让锁立刻失效。
// 正常路径由 gate 脚本链末尾的 `--release` 释放；中途失败留下的锁由下一次的陈旧检测清掉。
process.exit(0);
