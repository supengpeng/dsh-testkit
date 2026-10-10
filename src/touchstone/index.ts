/**
 * touchstone 融合（三阶段适配器）的公开面。
 *
 * 三条通道**互相独立**，各自可单独验收（见 `docs/TOUCHSTONE.md`）：
 *   · 输入：`import.ts` —— touchstone `case.md` → 场景 YAML **草稿**（走提炼闸门）
 *   · 输出：`export.ts` —— `run.json` → `bug_report/`（单向文件产物）
 *   · 回环：`webhook.ts` —— 修复完成 → worktree 隔离复跑 → 结果回传
 *
 * 本模块**只产文件 / 只读对方文件**：不 import touchstone 的代码、不共享数据库、
 * 不嵌入对方运行时、也不对产物做 API 稳定承诺（适配器模式，不是合并模式）。
 */

export * from './export.js'
export * from './import.js'
export * from './webhook.js'
