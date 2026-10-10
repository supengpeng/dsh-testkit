/**
 * `--changed` / `--since` 的文件发现：直接调 git，不用任何依赖。
 *
 * ## 为什么失败必须显式返回 `ok:false`
 *
 * 「非 git 仓库」「git 不在 PATH」「ref 不存在」这三种情况下，
 * 一个宽容的实现会返回**空文件列表**，于是增量选择静默地选中 0 条场景——
 * 门是绿的，代码是没测的。这是最坏的一类假绿，所以这里的原则是：
 * **拿不到可信答案就承认拿不到**，由调用方退回全量。
 *
 * ## 为什么还要列 untracked
 *
 * 新写的 `src/kinds/foo.ts` 在 `git diff <ref>` 里**根本不会出现**（还没入库）。
 * 只信 diff 的话，「新增一个 kind 实现」会得到"无变更 → 不跑任何场景"。
 * 因此这里额外合并 `git ls-files --others --exclude-standard`（自动尊重 .gitignore），
 * 让新增文件同样进入判定。
 */

import { execFileSync } from 'node:child_process'

import { normalizePath } from './mapping.js'

export type ChangedFilesResult = { ok: true; files: string[] } | { ok: false; reason: string }

export interface ChangedFilesOptions {
  /** 仓库工作目录；缺省 `process.cwd()`。 */
  cwd?: string
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function describeGitError(error: unknown, ref: string): string {
  const err = error as { status?: number; stderr?: unknown; message?: string; code?: string }
  const stderr = typeof err?.stderr === 'string' ? err.stderr.trim() : ''
  if (err?.code === 'ENOENT') return 'git 不可用（未安装或不在 PATH 上）'
  if (stderr !== '') return stderr.split('\n')[0]!
  if (typeof err?.status === 'number') return `git 退出码 ${err.status}`
  return err?.message ?? `无法对 ${ref} 取变更文件`
}

/**
 * 取 `ref` 之后（含未提交改动与未跟踪文件）变更的文件，路径相对 `cwd`、以 `/` 分隔。
 *
 * 返回 `ok:false` 时**不要**把它当成空集——调用方应退回全量跑。
 */
export function changedFilesSince(ref: string, opts: ChangedFilesOptions = {}): ChangedFilesResult {
  const target = String(ref ?? '').trim()
  if (target === '') return { ok: false, reason: 'ref 为空' }
  // 以 `-` 开头的 ref 会被 git 当成选项（例如 `--output`），直接拒绝
  if (target.startsWith('-')) return { ok: false, reason: `ref 不能以 - 开头：${target}` }

  const cwd = opts.cwd ?? process.cwd()

  let diffOut: string
  try {
    diffOut = git(
      ['-c', 'core.quotepath=false', 'diff', '--name-only', '--relative', '--no-color', target, '--'],
      cwd,
    )
  } catch (error) {
    return { ok: false, reason: `取变更失败（${describeGitError(error, target)}）` }
  }

  let untrackedOut = ''
  try {
    untrackedOut = git(
      ['-c', 'core.quotepath=false', 'ls-files', '--others', '--exclude-standard'],
      cwd,
    )
  } catch (error) {
    // 已经确认是 git 仓库却列不出未跟踪文件：宁可退回全量，也不给一份可能漏项的列表
    return { ok: false, reason: `列未跟踪文件失败（${describeGitError(error, target)}）` }
  }

  const files = new Set<string>()
  for (const line of `${diffOut}\n${untrackedOut}`.split(/\r?\n/)) {
    const normalized = normalizePath(line)
    if (normalized !== '') files.add(normalized)
  }

  return { ok: true, files: [...files].sort() }
}
