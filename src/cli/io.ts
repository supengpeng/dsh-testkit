/**
 * CLI 的 I/O 面。
 *
 * `main(argv, io?)` 之所以要能接收 `io`，是为了让"命令做了什么"可以在**不启动进程**的前提下
 * 断言（见 `tests/cli.test.mjs` 的进程内用例）；真正的 `bin` 走缺省实现（stdout/stderr）。
 *
 * ## 为什么输出一律走 `io` 而不是 `console.log`
 *
 * 两个理由，都不是洁癖：
 *   ① **可测**：进程内跑 `main()` 时把输出收进数组，就不用解析子进程的 stdout；
 *   ② **`--json` 模式要求 stdout 是纯 JSON**：任何一处漏网的 `console.log`
 *      都会把机器可读输出弄坏（而人眼很难发现"多了一行日志"）。
 */

export interface CliIo {
  /** 写标准输出（结果 / 数据）。 */
  out(text: string): void
  /** 写标准错误（进度 / 告警 / 错误原因）。 */
  err(text: string): void
  /** 逻辑工作目录（增量选择交给 git 用）；缺省 = `process.cwd()`。 */
  cwd?: string
}

/** 缺省 I/O：写进程的 stdout / stderr。 */
export function createDefaultIo(): CliIo {
  return {
    out: (text) => {
      process.stdout.write(text)
    },
    err: (text) => {
      process.stderr.write(text)
    },
  }
}

/** 进程内 I/O：把输出攒在字符串里，便于断言（测试与嵌入用）。 */
export function createBufferIo(cwd?: string): CliIo & { stdout: string; stderr: string } {
  const state = { stdout: '', stderr: '' }
  return {
    ...(cwd === undefined ? {} : { cwd }),
    out: (text) => {
      state.stdout += text
    },
    err: (text) => {
      state.stderr += text
    },
    get stdout() {
      return state.stdout
    },
    get stderr() {
      return state.stderr
    },
  }
}

/** 一行输出（自动补换行；已经是整段文本时避免重复补）。 */
export function line(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 机器可读输出：稳定缩进的 JSON + 换行。 */
export function emitJson(io: CliIo, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`)
}

/** 错误输出（统一前缀，便于 CI 日志里 grep）。 */
export function emitError(io: CliIo, message: string): void {
  io.err(`dsh-testkit: ${message}\n`)
}
