/**
 * 提炼闸门（pipeline）模块的公开面。
 *
 * 三层分工：`types` 是数据模型，`quality` 是纯判据，`store` 是文件系统编排。
 * 工具面与命令面都只依赖 `PipelineStore`，避免两个表面各写一套闸门逻辑。
 */

export * from './types.js'
export * from './quality.js'
export * from './store.js'
