/**
 * 串行化 `tsc -p tsconfig.json` 的构建闸门（多人 / 多智能体协作时的共享资源）。
 *
 * 为什么需要：`lib/` 全仓共用一份产物，**两个并发的 tsc 会互相踩**
 * （一个进程清目录、另一个正在写文件），表现为随机出现的 "找不到模块"，
 * 而且这种错误极难归因。所有需要编译产物的人（跑测试的人）都必须经这里编译。
 *
 * 用法：`node scripts/build-lock.mjs`（可加 `--force` 忽略锁等待）
 * 退出码：透传 tsc 的退出码。
 *
 * 锁策略：
 *   · 独占创建 `<tmp>/dsh-testkit-build.lock`（`wx`）
 *   · 已被占用则最多等 `WAIT_MS`，每 `POLL_MS` 重试一次
 *   · 锁文件比 `STALE_MS` 更老 → 视为残留锁（上一个进程被强杀），抢占
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const lockPath = join(tmpdir(), 'dsh-testkit-build.lock')
const tscPath = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const WAIT_MS = Number(process.env['TK_BUILD_LOCK_WAIT_MS'] ?? 10 * 60 * 1000)
const POLL_MS = 1000
const STALE_MS = 5 * 60 * 1000
const force = process.argv.includes('--force')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 尝试取锁；成功返回 true。 */
function tryAcquire() {
  try {
    const fd = openSync(lockPath, 'wx')
    writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`)
    closeSync(fd)
    return true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }

  try {
    const age = Date.now() - statSync(lockPath).mtimeMs
    if (age > STALE_MS) {
      const owner = safeRead(lockPath)
      console.warn(`[build-lock] 清理残留锁（${Math.round(age / 1000)}s 前创建：${owner.trim()}）`)
      rmSync(lockPath, { force: true })
      return tryAcquire()
    }
  } catch {
    /* 锁在我们检查时被释放：下一轮重试即可 */
  }
  return false
}

function safeRead(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '(读取失败)'
  }
}

async function acquire() {
  if (force) {
    rmSync(lockPath, { force: true })
    if (!tryAcquire()) throw new Error('取锁失败（--force 之后仍被占用）')
    return
  }
  const deadline = Date.now() + WAIT_MS
  let waited = false
  for (;;) {
    if (tryAcquire()) {
      if (waited) console.log('[build-lock] 已取到锁，开始编译')
      return
    }
    if (Date.now() > deadline) {
      throw new Error(
        `[build-lock] 等待 ${Math.round(WAIT_MS / 1000)}s 仍拿不到锁（${lockPath}）。` +
          `如果确认没有别的编译在跑，用 --force 清锁。持有者：${safeRead(lockPath).trim()}`,
      )
    }
    if (!waited) {
      waited = true
      console.log(`[build-lock] 另一个编译在进行中（${lockPath}），等待…`)
    }
    await sleep(POLL_MS)
  }
}

async function main() {
  await acquire()
  try {
    const result = spawnSync(process.execPath, [tscPath, '-p', 'tsconfig.json'], {
      cwd: root,
      stdio: 'inherit',
    })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } finally {
    rmSync(lockPath, { force: true })
  }
}

await main()
