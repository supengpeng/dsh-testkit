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

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

/**
 * client 模块 id = **package.json 的 name**，所以这里从 package.json 读，
 * 不再硬编码：DSH 的 client 模块表按包名索引（`dsh.client` 扫描 → `__DSH_BOOT__` 入口图）。
 *
 * 证据：DSH 自己的客户端包同样用包名做 id，且**支持 scoped 名**
 * （发行体里可见 `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-api-gateway" …)`
 * 与示例 `id: '@local/my-decoration'`）。
 *
 * 注意区分两件事（改名时别搞混）：
 *   · **模块 id**（这里）= npm 包名 → 改名就跟着变；
 *   · **插件身份**（`src/index.ts` 的 `export const name`、`dsh/cordis.patch.yml` 的 id、
 *     client 半的 `export const name`）= 产品名 `dsh-testkit`，**不随 npm 名变化**。
 */
const PKG_ID = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

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

// 诊断信息走 **stderr**：本脚本是 `prepare` 的一部分，`npm pack --json` / `npm install`
// 会通过 stdout 传机器可读数据；往 stdout 打日志会把 JSON 污染成非 JSON
// （真踩过：发布工作流的 `npm pack --dry-run --json > pack.json` 直接 JSON.parse 失败）。
console.error(`[build-client] → lib/client.js (id=${PKG_ID})`)
