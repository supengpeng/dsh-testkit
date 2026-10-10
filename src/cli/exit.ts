/**
 * CLI 的**冻结退出码**。
 *
 * 为什么单独立一个文件并写死在常量里：CLI 的退出码是**对外契约**——
 * CI 脚本、`&&` 链、外部触发器都按它分流。它一旦被"顺手改成 1"，
 * 调用方就会把"用法写错了"和"测试挂了"混成同一类，而这正是 CLI 最该避免的模糊。
 *
 * | 码 | 含义 |
 * |---|---|
 * | `0` | 全部 passed / skipped（跳过不是失败——宿主缺能力是**如实告知**，不是红） |
 * | `1` | 有 failed / errored（被测对象或场景真的出了问题） |
 * | `2` | 用法错误，**或选中 0 条**（选择器没命中任何场景） |
 * | `3` | 基础设施错误：宿主 / 目录 / 依赖模块建不起来 |
 *
 * 「选中 0 条」刻意归到 `2` 而不是 `0`：一条都没跑却报成功，是 CI 里最难发现的假绿
 * （选择器打错字、场景全被 status 过滤掉，都会静默变成"通过"）。
 */

/** 冻结的退出码。改动它等于改动对外契约。 */
export const EXIT = {
  /** 全部 passed / skipped。 */
  OK: 0,
  /** 有 failed / errored。 */
  FAILED: 1,
  /** 用法错误，或选中 0 条。 */
  USAGE: 2,
  /** 基础设施错误（宿主 / 目录 / 依赖模块）。 */
  INFRA: 3,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

/** 给 `help` 用的退出码表（一处定义，避免文档与实现漂移）。 */
export const EXIT_DOC: readonly { code: ExitCode; meaning: string }[] = [
  { code: EXIT.OK, meaning: '全部 passed / skipped' },
  { code: EXIT.FAILED, meaning: '有 failed / errored' },
  { code: EXIT.USAGE, meaning: '用法错误，或选中 0 条' },
  { code: EXIT.INFRA, meaning: '基础设施错误（宿主 / 目录 / 依赖模块建不起来）' },
]

/**
 * 由运行汇总算退出码——**唯一裁决处**。
 *
 * 各子命令不允许自己判断"这算不算失败"：一旦有两处判断，就会有两套口径
 * （例如某处把 `errored` 当基础设施错误）。这里只认两个数：
 * failed / errored 是不是 0。
 */
export function exitCodeForTotals(totals: { failed: number; errored: number }): ExitCode {
  return totals.failed > 0 || totals.errored > 0 ? EXIT.FAILED : EXIT.OK
}
