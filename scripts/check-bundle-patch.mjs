/**
 * 守卫：bundle patch（`dsh.bundle.patch`）里的插件条目必须是**能解析的模块说明符**。
 *
 * ## 为什么需要它（活宿主真的踩过）
 *
 * `dsh/cordis.patch.yml` 里原本写的是：
 *
 * ```yaml
 * - insert:
 *     - id: dsh-testkit
 *       name: dsh-testkit     # ← 改名后这里没跟着改
 * ```
 *
 * 当时文件里的注释还专门写着"`id` 是插件身份、与 npm 包名是两件事，所以这行不用跟着改"——
 * **那句话是错的**：`name` 是 **Node 的模块说明符**，由宿主在 profile 的 `node_modules`
 * 里解析；包名改成 `@supengpeng/dsh-testkit` 之后，`name: dsh-testkit` 解析到的是
 * 上一次安装留下的旧链路。宿主半照样能加载（所以 bridge 还是通的），
 * 但 **client 半会静默地不进启动图**：页面里搜不到 `<新名>/client.js`，
 * 浏览器控制台**不报错**，「测试」标签就是不会出现。
 *
 * 这正是 [docs/PUBLISHING.md](../docs/PUBLISHING.md) §5 第四条要抓的东西，
 * 而它逃过了 `verify:cases` / `verify:docs` / `check-pack-files` 全部静态守卫。
 * 所以把它固化成一条机器判据：
 *
 *   · patch 文件必须存在、能被 YAML 解析；
 *   · `insert[]` 每条都要有 `id`（插件身份）；`id` 不能重复；
 *   · 条目**带 `name`** 时，它必须与 `package.json` 的 `name` 一致
 *     （相对路径 `./x` 与显式 npm 包名都允许，但"裸旧名"不允许）；
 *   · `name` 不存在时给出提示（宿主会用 bundle 名解析，仍可工作，但显式更安全）。
 *
 * 退出码：0 通过 / 1 有问题 / 2 环境问题（读不到 patch 文件）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse as parseYaml } from 'yaml'

// 包根可用参数覆盖（与本仓其它 checker 同形：`check-pack-files.mjs <包目录>`），
// 单测靠它造"旧名 patch"的负向用例。省略时用本仓库。
const root = process.argv[2] === undefined ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.argv[2])

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const patchRel = pkg?.dsh?.bundle?.patch

if (typeof patchRel !== 'string' || patchRel === '') {
  console.error('[check-bundle-patch] package.json 的 dsh.bundle.patch 缺失：没有 bundle patch 就没法装进 profile')
  process.exit(1)
}

const patchPath = join(root, patchRel.replace(/^\.\//, ''))
if (!existsSync(patchPath)) {
  // 环境/打包问题，不是"内容不对"
  console.error(`[check-bundle-patch] patch 文件不存在：${patchPath}`)
  process.exit(2)
}

let doc
try {
  doc = parseYaml(readFileSync(patchPath, 'utf8'))
} catch (error) {
  console.error(
    `[check-bundle-patch] ${patchRel} 不是合法 YAML：${error instanceof Error ? error.message : String(error)}`,
  )
  process.exit(1)
}

const problems = []
const entries = []
if (Array.isArray(doc)) {
  for (const layer of doc) {
    if (layer !== null && typeof layer === 'object' && Array.isArray(layer.insert)) {
      for (const entry of layer.insert) entries.push(entry)
    }
  }
}

if (entries.length === 0) {
  problems.push('patch 里没有任何 `insert:` 条目：装进 profile 后不会挂载本插件')
}

const seen = new Map()
for (const [index, entry] of entries.entries()) {
  const where = `insert[${index}]`
  if (entry === null || typeof entry !== 'object') {
    problems.push(`${where} 不是对象`)
    continue
  }
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (id === '') {
    problems.push(`${where} 缺少 id（插件身份，对应 src/index.ts 的 export const name）`)
  } else if (seen.has(id)) {
    problems.push(`${where} 的 id 与 insert[${seen.get(id)}] 重复：${id}（重复 id 会让加载器起不来）`)
  } else {
    seen.set(id, index)
  }

  const name = typeof entry.name === 'string' ? entry.name.trim() : undefined
  if (name === undefined) {
    // 不判红：宿主会用 bundle 名解析这一个条目。但显式写出来更不容易在改名时漏掉。
    console.log(`[check-bundle-patch] 提示：${where}（id=${id}）没写 name，宿主将用 bundle 名解析`)
    continue
  }
  const isRelative = name.startsWith('./') || name.startsWith('../')
  if (!isRelative && name !== pkg.name) {
    problems.push(
      `${where} 的 name（${name}）与 package.json 的 name（${pkg.name}）不一致：` +
        `name 是**模块说明符**，改名后必须同步，否则宿主会解析到旧链路、client 半静默不进启动图`,
    )
  }
}

if (problems.length > 0) {
  console.error(`[check-bundle-patch] ✗ ${problems.length} 处问题（patch：${patchRel}）：`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(
  `[check-bundle-patch] OK｜patch：${patchRel}｜条目 ${entries.length} 个｜包名 ${pkg.name}`,
)
