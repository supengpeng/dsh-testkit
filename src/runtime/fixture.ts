/**
 * Fixture —— 夹具容器。
 *
 * 这是本项目"可回滚"纪律的落点：所有对活宿主的干预都必须经 `add()` 登记，
 * 场景结束时由 `release()` **逆序**释放。参见 docs/ARCHITECTURE.md §5.4。
 */

export interface DisposeEntry {
  label: string
  dispose: () => void | Promise<void>
}

export interface ReleaseReport {
  released: string[]
  failures: Array<{ label: string; error: string }>
}

export class Fixture {
  private readonly disposers: DisposeEntry[] = []
  private readonly notesMap = new Map<string, unknown>()
  private released = false

  /** 登记一个可回滚的干预。 */
  add(label: string, dispose: () => void | Promise<void>): void {
    if (this.released) {
      // 释放后再登记说明 driver 时序有问题：立即执行 dispose，避免泄漏。
      void Promise.resolve(dispose()).catch(() => undefined)
      return
    }
    this.disposers.push({ label, dispose })
  }

  /** 记录一条运行期证据，供断言与报告读取（`fx.<key>`）。 */
  note(key: string, value: unknown): void {
    this.notesMap.set(key, value)
  }

  /** 记录证据并追加到数组（同名多次调用时累积，如捕获到的请求列表）。 */
  noteAppend(key: string, value: unknown): void {
    const current = this.notesMap.get(key)
    if (Array.isArray(current)) current.push(value)
    else this.notesMap.set(key, [value])
  }

  /** 读取一条证据。 */
  getNote(key: string): unknown {
    return this.notesMap.get(key)
  }

  /** 全部证据的浅拷贝（Map 便于 `resolvePath` 之外的自定义读取）。 */
  get notes(): ReadonlyMap<string, unknown> {
    return this.notesMap
  }

  /** 证据的普通对象快照，用于序列化进报告。 */
  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.notesMap)
  }

  /**
   * 逆序释放全部干预。
   *
   * 单个释放失败**不阻断**其余释放，失败项收集进报告。
   * 幂等：重复调用只生效一次。
   */
  async release(): Promise<ReleaseReport> {
    const report: ReleaseReport = { released: [], failures: [] }
    if (this.released) return report
    this.released = true

    for (let i = this.disposers.length - 1; i >= 0; i -= 1) {
      const entry = this.disposers[i]!
      try {
        await entry.dispose()
        report.released.push(entry.label)
      } catch (error) {
        report.failures.push({ label: entry.label, error: describeError(error) })
      }
    }
    this.disposers.length = 0
    return report
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
