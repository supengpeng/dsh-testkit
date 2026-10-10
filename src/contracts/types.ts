/**
 * 契约测试的形状定义（文档 §5.4：**每个 adapter 一组契约测试，先于场景测试跑**）。
 *
 * ## 契约测试约束的是什么
 *
 * 只约束**接口形状与语义**：谁返回 disposer、谁必须 `await`、参数非法时该抛还是该拒、
 * 注册后如何解绑。**不约束实现细节**——所以每条用例都应当短、可读，且只依赖公开面。
 *
 * ## 为什么必须独立于场景测试
 *
 * 本包的 CI 轨（`export/scenarios.test.mjs`）跑的是**测试替身**
 * （`src/headless/services.ts`）。替身一旦与真实契约漂移，场景测试会
 * "绿着骗人"——绿的是替身，不是 DSH。契约测试把替身按真实契约钉住；
 * gate 因此把 `tests/contracts/*.test.mjs` 排在 `tests/*.test.mjs` **之前**：
 * 先证明"尺子准"，再拿尺子量东西。
 *
 * ## 真实契约的出处（不要凭印象写用例）
 *
 *   · host 门面：本仓 `src/host-facade.ts`（DSH API → 窄接口的唯一翻译层）
 *   · 工具：`@deepseek-ai/dsh-tools` 发行体 `lib/types/schema.js` 的 `defineTool`，
 *     参数校验在 `lib/types/json-schema.js` 的 `validateJsonSchemaValue`
 *   · cordis：`@deepseek-ai/cordis` 发行体 `lib/index.js` 的
 *     `Context.on` / `waterfall` / `effect` / `provide` / `inject`
 *   · 替身：本仓 `src/headless/services.ts` + `src/headless/index.ts`
 */

/**
 * 一条契约用例。
 *
 * `run` 抛出（或返回 rejected promise）即视为**契约被破坏**：
 * 运行器负责把"契约名 + 用例名 + 原始错误"三件事一起报出来。
 */
export interface ContractCase {
  /** 用例名；同一契约内必须唯一（报告靠它点名）。 */
  name: string
  /** 用例本体。允许同步或异步。 */
  run: () => Promise<void> | void
}

/**
 * 一个 adapter 的契约集合。
 *
 * 形状刻意保持最小：契约文件是**测试侧**的 `.mjs`，不该依赖本包的构建产物，
 * 也不该为了写契约先学会一套 DSL。
 */
export interface Contract {
  /** 契约版本；**接口形状**变更时递增（与包版本无关）。 */
  version: string
  /** 被测 adapter 名，报告里的"契约名"。 */
  adapter: string
  /** 用例列表；空列表视为契约形状非法（见 `validateContract`）。 */
  tests: ContractCase[]
}
