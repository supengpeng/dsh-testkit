/**
 * dsh-testkit —— client 半（浏览器侧）入口。
 *
 * 产物形态：esbuild 打成 `window.__ModuleLoader__.load({ id, factory })`，
 * 由 DSH 的模块加载器装载（见 scripts/build-client.mjs 与 docs/DEVELOPMENT.md §3）。
 *
 * 注意：本文件与 src/client/* 使用**无扩展名导入**（Bundler 解析），
 * 与 host 半的 `.js` 后缀约定不同。
 */

import * as React from 'react'

import { ConsoleView } from './console'
import { DICT_EN, DICT_ZH, NS } from './dict'
import type { ClientContext } from './types'

export const name = 'dsh-testkit'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // 词典：与官方设置页的标签风格保持一致
  ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-testkit: dictionaries')
  const t = ctx.locale.bind(NS)

  // 主入口：会话视图环里的「测试」标签页（Chat / Trajectory 旁）
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.view', () =>
        ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'testkit',
            order: 30,
            locale: NS,
            label: () => t('tab'),
          },
          (props) => React.createElement(ConsoleView, { ...(props as object), t }),
        ),
      ),
    'dsh-testkit: console tab',
  )
}
