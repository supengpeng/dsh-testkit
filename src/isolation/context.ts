/**
 * 隔离上下文 —— 场景级命名空间 / 临时目录 / 端口 / 会话名。
 *
 * ## 为什么需要它（第 5.5 节：并发隔离）
 *
 * `parallel: safe` 是一条**承诺**：这条场景与别的 safe 场景并发跑时互不干扰。
 * 承诺要能被兑现，就必须有"互不干扰的落脚点"——否则两条场景都往
 * `os.tmpdir()` 写同名文件、都抢 3000 端口、都用 `default` 会话名，
 * 并发跑出来的结论就与串行跑不一致（而这种不一致最难归因）。
 *
 * 这个模块只负责**造出**那几个落脚点：
 *   · `namespace` —— 进程内 / 跨进程都唯一的短标识（进日志与报告）
 *   · `tmpdir`    —— 该场景独占的临时目录，跑完必须删
 *   · `ports`     —— 该场景声明要用的端口（**不自动分配**，理由见下）
 *   · `session`   —— 该场景独占的会话名（避免共用 `default` 会话）
 *
 * ## 为什么不自动分配端口
 *
 * 同步 API 里没有"拿一个空闲端口"的可靠做法（`listen(0)` 是异步的），
 * 而猜一个端口号正是并发场景互相踩踏的经典来源。所以这里**只声明不分配**：
 * 端口由调用方（runner 按场景 setup 的声明）传进来，
 * 由 `detectLeftovers` 的端口探针在跑完后核对是否真的干净。
 *
 * ## 幂等
 *
 * `disposeIsolationContext` 重复调用不抛、目录不存在也不抛——
 * 清理代码处在 `finally` 里，"删失败"绝不能盖掉真正的失败结论。
 */

import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import type { Scenario } from '../cases/types.js'

/** 场景级隔离上下文（见文件头注）。 */
export interface IsolationContext {
  /** 进程内唯一的短标识（形如 `tk-0001-m1x2-3-ab12`）。 */
  namespace: string
  /** 该场景独占的临时目录（已创建）。 */
  tmpdir: string
  /** 该场景声明要用的端口（缺省为空数组；只声明不分配）。 */
  ports: number[]
  /** 该场景独占的会话名。 */
  session: string
}

export interface IsolationOptions {
  /** 临时目录的父目录；缺省 `os.tmpdir()`。 */
  root?: string
  /** 本场景要用的端口；缺省空数组。 */
  ports?: readonly number[]
}

/** 进程内计数：保证同一进程内连续创建的两个上下文命名空间不同。 */
let sequence = 0

/** 已释放过的上下文（WeakSet 只做短路，真正幂等的是 `rmSync(force)`）。 */
const disposed = new WeakSet<object>()

/**
 * 为一条场景创建隔离上下文。
 *
 * 命名空间刻意**不是**纯粹的 `scenario.id`：同一条 safe 场景在一次运行里可能
 * 被 repeat 多轮、或在同一个进程里被两个批次同时跑，纯 id 会让它们的
 * tmpdir / 会话名撞在一起。
 */
export function createIsolationContext(
  scenario: Scenario,
  opts: IsolationOptions = {},
): IsolationContext {
  sequence += 1
  const namespace = [
    slugify(scenario.id),
    process.pid.toString(36),
    sequence.toString(36),
    Math.random().toString(36).slice(2, 6),
  ].join('-')

  const root = resolve(opts.root ?? tmpdir())
  const dir = join(root, `dsh-testkit-${namespace}`)
  mkdirSync(dir, { recursive: true })

  return {
    namespace,
    tmpdir: dir,
    // 拷贝一份：调用方之后复用同一个数组也不该改到已建好的上下文
    ports: [...(opts.ports ?? [])],
    session: `dsh-testkit-${namespace}`,
  }
}

/**
 * 释放隔离上下文（删除临时目录）。
 *
 * 三条纪律：
 *   ① **幂等**：重复调用、目录已被删、目录从来没建成功，都不抛；
 *   ② **不抛穿**：删除失败只吞掉——它处在 `finally` 里，抛出去会盖掉真正的失败；
 *   ③ 只删 `tmpdir` 这一层：父目录是所有人共用的，绝不能碰。
 */
export async function disposeIsolationContext(ctx: IsolationContext): Promise<void> {
  if (disposed.has(ctx)) return
  disposed.add(ctx)
  try {
    // force + recursive 本身对"不存在"就是幂等的；maxRetries 缓解 Windows 上的瞬时占用
    rmSync(ctx.tmpdir, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    /* 清理失败不改变任何判定：残留由 detectLeftovers 如实报出来 */
  }
}

/** 把 id 变成适合进目录名的短标识（非字母数字一律折成 `-`）。 */
function slugify(id: string): string {
  const slug = id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return slug === '' ? 'case' : slug
}
