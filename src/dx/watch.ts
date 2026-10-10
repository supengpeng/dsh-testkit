/**
 * 本地 DX：场景目录的 **watch**（`node:fs.watch` + 防抖合并）。
 *
 * ## 为什么要防抖合并
 *
 * 编辑器保存一个文件常常产生 2~4 个底层事件（写临时文件 → rename → 改元数据）。
 * 不合并的话，一次保存会触发多次重载：轻则白跑几遍，重则在重载中途读到半个文件。
 * 这里把窗口内的事件**合并成一次回调**，并把窗口内的文件名一起交出去。
 *
 * ## 为什么目录不存在必须报错（而不是静默不干活）
 *
 * `fs.watch` 对不存在的目录会抛错，但在某些平台上"路径拼错 + 父目录存在"会静默
 * 监听一个空目录——表现是"watch 明明开着，改场景却没反应"，最难查。
 * 所以这里先 `statSync` 判一次，早失败、说清是哪个路径。
 *
 * ## 与其他 watcher 的关系
 *
 * `src/index.ts` 里有一段等价的内联 watcher（只认 `.yaml`、250ms 防抖）。
 * 那是活宿主里的注册逻辑；本模块是**可单测的纯机制**，交给工具/命令面复用。
 * 触发后做什么（重载注册表 / 打印一行）由 `onChange` 决定，本模块不做业务判断。
 */

import { statSync, watch as fsWatch, type FSWatcher } from 'node:fs'

/** 默认防抖窗口（与 `src/index.ts` 的内联 watcher 一致）。 */
export const DEFAULT_DEBOUNCE_MS = 250

export interface WatchCasesOptions {
  /** 防抖窗口（毫秒）；缺省 `DEFAULT_DEBOUNCE_MS`。`0` = 不合并（下一个事件循环立即回调）。 */
  debounceMs?: number
}

/** 合并后的一次变更通知。 */
export interface CasesChange {
  /** 合并窗口内最后一次事件的类型；watcher 自身出错时为 `error`。 */
  type: 'change' | 'rename' | 'error'
  /** 窗口内出现过的文件名（去重、保序）；底层拿不到名字时为空数组。 */
  files: string[]
  /** 合并了几个底层事件（`> 1` 说明防抖真的在合并，而不是恰好只来一个）。 */
  events: number
  /** `type === 'error'` 时的原因（例如目录被删）。 */
  error?: string
}

export type CasesChangeHandler = (change: CasesChange) => void

export interface CasesWatcher {
  /** 停止监听；**幂等**（重复调用不抛错）。 */
  close(): void
  /** 是否仍在监听（诊断与测试用）。 */
  readonly active: boolean
  /** 被监听的目录。 */
  readonly dir: string
}

/**
 * 监听场景目录，变化经防抖窗口合并后回调一次。
 *
 * @param dir - 要监听的目录（必须是**已存在**的目录，否则抛出明确错误）
 * @param onChange - 合并后的回调；回调自身抛错不会让 watcher 失效（后续变更照常通知）
 * @param options - `debounceMs`
 */
export function watchCases(
  dir: string,
  onChange: CasesChangeHandler,
  options: WatchCasesOptions = {},
): CasesWatcher {
  let isDirectory = false
  try {
    isDirectory = statSync(dir).isDirectory()
  } catch {
    throw new Error(`要监听的场景目录不存在：${dir}（先创建它，或检查配置里的 casesDir）`)
  }
  if (!isDirectory) {
    throw new Error(`要监听的路径不是目录：${dir}（watch 需要目录，而不是单个文件）`)
  }

  const debounceMs = Math.max(0, Math.floor(options.debounceMs ?? DEFAULT_DEBOUNCE_MS))
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: { type: CasesChange['type']; files: string[]; events: number } | undefined

  const flush = (): void => {
    timer = undefined
    if (pending === undefined || closed) return
    const change = pending
    pending = undefined
    try {
      onChange({ type: change.type, files: change.files, events: change.events })
    } catch {
      /* 回调抛错不该让 watcher 挂掉：一次通知失败，后续变更仍要能通知 */
    }
  }

  let watcher: FSWatcher
  try {
    watcher = fsWatch(dir, { persistent: false }, (eventType, filename) => {
      if (closed) return
      const type: CasesChange['type'] = eventType === 'rename' ? 'rename' : 'change'
      const name = filename === null || filename === undefined ? '' : String(filename)
      if (pending === undefined) pending = { type, files: [], events: 0 }
      // 窗口内以最后一次事件类型为准，但事件数全部计入（自证"合并了几个"）
      pending.type = type
      pending.events += 1
      if (name !== '' && !pending.files.includes(name)) pending.files.push(name)
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(flush, debounceMs)
    })
  } catch (error) {
    throw new Error(
      `无法监听场景目录 ${dir}：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // watcher 自身出错（例如目录在中途被删）：**立即**上报，不排队、不静默
  watcher.on('error', (error: Error) => {
    if (closed) return
    try {
      onChange({
        type: 'error',
        files: [],
        events: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    } catch {
      /* 同上：回调抛错不影响 watcher 状态 */
    }
  })

  return {
    dir,
    get active(): boolean {
      return !closed
    },
    close(): void {
      if (closed) return
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      pending = undefined
      try {
        watcher.close()
      } catch {
        /* 已经关了：close 是幂等的 */
      }
    },
  }
}
