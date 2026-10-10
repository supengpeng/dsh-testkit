#!/usr/bin/env node
/**
 * dsh-testkit CLI 的**薄入口**。
 *
 * 它只做三件事，别的什么都不做：
 *   ① 把 argv 交给 `main()`（`lib/cli/index.js`——编译产物）；
 *   ② 等两个输出流的待写数据全部交给内核；
 *   ③ 用 `main()` 返回的退出码退出。
 *
 * ## 为什么要有第 ② 步（这条不是仪式）
 *
 * POSIX 上标准输出接的是**管道**时，`process.stdout.write` 是**异步**的。
 * 若写完立刻 `process.exit()`，还没 flush 的数据会被丢掉——
 * 表现是 CI 里 `execFileSync` 读到**被截断的 JSON**，而本地（TTY 是同步写）一切正常。
 * 这类"只在管道里坏"的 bug 极难定位，所以入口处统一设一道 flush 闸门：
 * 等到 `writableLength === 0`（内核已收下）再退。
 *
 * ## 为什么不在这个文件里写业务逻辑
 *
 * `main()` 是**可测的**（返回退出码、不自己退出）。入口文件是唯一知道
 * "自己是个进程"的地方——把逻辑留在那里会让测试只能去解析子进程。
 */

import { main } from '../lib/cli/index.js'

/** 等一个流把缓冲写空（`writableLength` 归零 = 已交给内核）。 */
async function flush(stream) {
  while (stream.writableLength > 0) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

let code
try {
  code = await main(process.argv.slice(2))
} catch (error) {
  // 走到这里说明连 main 自己都没接住（例如 lib/ 没构建）。给出可执行的下一步，不甩裸栈。
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error)
  process.stderr.write(
    `dsh-testkit: CLI 未能启动（编译产物 lib/cli/index.js 是否已构建？先跑 node scripts/build-lock.mjs）\n${message}\n`,
  )
  code = 3
}

await flush(process.stdout)
await flush(process.stderr)
process.exit(code)
