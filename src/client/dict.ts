/**
 * 双语词典。client 半通过 `ctx.locale.register(ns, { zh, en })` 注册。
 */

export const NS = 'dsh-testkit'

export const DICT_ZH: Record<string, string> = {
  tab: '测试',
  title: 'dsh-testkit 测试控制台',
  subtitle: '场景来自 cases/*.yaml，由 host 半提供真源',
  refresh: '刷新',
  runAll: '全部运行',
  run: '运行',
  running: '运行中…',
  empty: '尚无场景。把 YAML 放进 cases/ 目录后点「刷新」。',
  invalid: '无法解析的场景文件',
  kind: '类型',
  status: '状态',
  title_field: '标题',
  bridgeMissing: '与 host 半的通道未就绪',
}

export const DICT_EN: Record<string, string> = {
  tab: 'Tests',
  title: 'dsh-testkit console',
  subtitle: 'Scenarios come from cases/*.yaml, owned by the host half',
  refresh: 'Refresh',
  runAll: 'Run all',
  run: 'Run',
  running: 'Running…',
  empty: 'No scenarios yet. Drop YAML files into cases/ and hit Refresh.',
  invalid: 'Unparsable scenario files',
  kind: 'Kind',
  status: 'Status',
  title_field: 'Title',
  bridgeMissing: 'Bridge to the host half is not ready',
}
