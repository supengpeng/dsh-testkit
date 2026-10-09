/**
 * client 半构建：src/client/index.ts → lib/client.js
 *
 * 产物必须是 DSH 模块加载器的入口形态：
 *   window.__ModuleLoader__.load({ id, factory: (require) => { ... return module.exports } })
 *
 * `react` / `react/jsx-runtime` / `@deepseek-ai/*` 全部 external —— 由宿主模块表
 * 通过注入的 require 提供（对照 dsh-context / dsh-model-extension 的实测产物）。
 *
 * 用法：node scripts/build-client.mjs
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

/** 必须与 package.json 的 name 一致：DSH 的 client 模块表按它索引。 */
const PKG_ID = 'dsh-testkit'

mkdirSync(join(root, 'lib'), { recursive: true })

await build({
  absWorkingDir: root,
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  // 注意：esbuild 的 JS API 只接受字符串/通配符 external，不接受正则。
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/*'],
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PKG_ID)}, factory: (require) => {\n` +
      `var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: {
    js: `return module.exports;\n} });`,
  },
  outfile: 'lib/client.js',
  logLevel: 'info',
  legalComments: 'none',
})

console.log(`[build-client] → lib/client.js (id=${PKG_ID})`)
