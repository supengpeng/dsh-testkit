/**
 * DSH 适配层 · 工具定义契约。
 *
 * ## 这一层存在的唯一理由
 *
 * **本目录（`src/adapters/dsh/`）是全仓唯一允许出现 `@deepseek-ai/dsh-*` 依赖的地方。**
 *
 * 为什么要把一行 re-export 单独放一个文件？因为"收敛"必须是**可机器校验的**，
 * 而不是靠口头纪律：
 *   · 早先 `src/host-facade.ts` 直接 `import { defineTool } from '@deepseek-ai/dsh-tools'`，
 *     于是"DSH 升级时改动收敛在一处"这句话只对了一个文件，不对一个目录；
 *   · 更麻烦的是，它无法被 grep 判据稳定守住——同一份源码里有 9 处**注释**提到
 *     `@deepseek-ai/dsh-*`（引用发行体路径、对照上游实现等），
 *     于是"grep 到包名就报"的验收方式会把注释全部误报（详见 `scripts/check-adapter-boundary.mjs`
 *     头注与 `tests/adapter-boundary.test.mjs`）。
 *
 * 现在判据是明确的：**静态 import / 动态 `import()` / `require()` 里出现的
 * `@deepseek-ai/dsh-*` 说明符，其所在文件必须位于 `src/adapters/dsh/` 下**；
 * 注释里出现的包名不算（守卫先剥离注释再扫描）。
 *
 * 注意 `@deepseek-ai/cordis` 与 `@deepseek-ai/schemastery` **不算** DSH 内部包：
 * 它们是 cordis 生态的基础设施，真实 DSH 与本包的 headless 宿主都要用，
 * 强行收进适配层只会把依赖关系弄反。
 */

export { defineTool } from '@deepseek-ai/dsh-tools'
