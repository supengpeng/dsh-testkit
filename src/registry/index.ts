/**
 * 组合系统（step registry + 参数化模板）的包内入口。
 *
 * 三个面各自可独立使用：
 *   · `loadRegistry()` / `checkRegistry()` —— 加载与校验 `registry/`
 *   · `expandScenario()`                  —— 把场景的 `use:` 步骤展平成 flat 步骤
 *   · `loadTemplates()` / `expandTemplates()` —— 参数化模板 → draft 场景
 *
 * 本模块是**纯数据 + 纯函数**，不碰 runner / driver：展开发生在执行之前，
 * 既有 `setup: {kind: …}` + `steps: [{act, expect}]` 场景完全不受影响（加法式）。
 */

export * from './loader.js'
export * from './expand.js'
export * from './templates.js'
