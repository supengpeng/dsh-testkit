/**
 * DSH 工具适配层的契约（P0 §5.4）。
 *
 * ## 契约出处（不凭印象）
 *
 *   · 适配层：本仓 `src/adapters/dsh/tools.ts` —— `defineTool` 的唯一 re-export 点
 *     （`scripts/check-adapter-boundary.mjs` 机器守卫：`@deepseek-ai/dsh-*` 只能出现在
 *     该目录下）。
 *   · 真实实现：`@deepseek-ai/dsh-tools@0.2.0-rc.2` 发行体
 *     - `lib/types/schema.js` 的 `defineTool`：产出 `{ name, description, parameters,
 *       output, execute, timeoutMs, isConcurrencySafe }`；`parameters` 是**已编译的
 *       object 根 JSON Schema**；`execute` 先校验再调用用户实现，非法时抛
 *       `ToolArgsError`（`code === 'INVALID_ARGS'`，message 前缀 `invalid arguments:`）。
 *     - `lib/types/json-schema.js` 的 `validateJsonSchemaValue`：非对象实参报
 *       `"arguments" must be an object`。
 *   · 转换器：本仓 `src/host-facade.ts` 的 `jsonSchemaToParameters`
 *     （标准 JSON Schema → DSH 的 `ParameterSchemaSpec`）。
 *
 * ## 这里只约束形状与语义
 *
 * 「转换出来的 spec 能不能被真实 defineTool 接受」「arguments 非对象时该抛什么」
 * 「signal 是不是同一引用」——都是接口面的事实，与工具业务逻辑无关。
 */

import assert from 'node:assert/strict'

import { defineTool } from '../../lib/adapters/dsh/tools.js'
import { createHostFacade, jsonSchemaToParameters } from '../../lib/host-facade.js'

export const DSH_TOOLS_CONTRACT_VERSION = '1.0.0'

const renderOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** 造一个最小可用的 defineTool 定义（契约用例的公共外壳）。 */
function makeDefinition({ parameters = {}, execute = () => 'OK' } = {}) {
  return defineTool({
    name: 'contract_probe',
    description: '契约探针',
    parameters,
    output: renderOutput,
    timeoutMs: 1000,
    isConcurrencySafe: () => false,
    execute,
  })
}

export function makeDshToolsContract({ defineTool: define = defineTool, toParameters = jsonSchemaToParameters } = {}) {
  return {
    version: DSH_TOOLS_CONTRACT_VERSION,
    adapter: 'dsh-tools',
    tests: [
      {
        name: '适配层导出的是真 defineTool：产物形状与 DSH 契约一致',
        run() {
          assert.equal(typeof define, 'function')
          const definition = makeDefinition()
          assert.equal(definition.name, 'contract_probe')
          assert.equal(definition.description, '契约探针')
          assert.equal(typeof definition.execute, 'function')
          assert.equal(typeof definition.output.render, 'function')
          assert.equal(definition.timeoutMs, 1000)
          assert.equal(definition.isConcurrencySafe(), false)
          assert.equal(definition.parameters.type, 'object', 'parameters 是已编译的 object 根 JSON Schema')
        },
      },
      {
        name: '参数形状转换：标准 JSON Schema → DSH spec（含 required / enum / 未知类型落 json）',
        run() {
          const spec = toParameters({
            type: 'object',
            required: ['q'],
            properties: {
              q: { type: 'string', description: 'query' },
              n: { type: 'integer' },
              ratio: { type: 'number' },
              flag: { type: 'boolean' },
              nothing: { type: 'null' },
              tags: { type: 'array', items: { type: 'string' } },
              nested: {
                type: 'object',
                additionalProperties: false,
                properties: { a: { type: 'number' } },
              },
              mode: { type: 'string', enum: ['fast', 'slow'] },
              mystery: {},
            },
          })

          assert.deepEqual(spec.q, { type: 'string', description: 'query', required: true })
          assert.deepEqual(spec.n, { type: 'integer' })
          assert.deepEqual(spec.ratio, { type: 'number' })
          assert.deepEqual(spec.flag, { type: 'boolean' })
          assert.deepEqual(spec.nothing, { type: 'null' })
          assert.deepEqual(spec.tags, { type: 'array', items: { type: 'string' } })
          assert.deepEqual(spec.nested, {
            type: 'object',
            properties: { a: { type: 'number' } },
            additionalProperties: false,
          })
          assert.deepEqual(spec.mode, { type: 'string', enum: ['fast', 'slow'] })
          assert.deepEqual(spec.mystery, { type: 'json' }, '未知/缺省类型必须落 json，而不是被丢掉')

          // 非对象根：不是合法 parameters，一律给空 spec（调用方拿不到参数即等价于"无参工具"）
          assert.deepEqual(toParameters(undefined), {})
          assert.deepEqual(toParameters(null), {})
          assert.deepEqual(toParameters({ type: 'string' }), {})
        },
      },
      {
        name: '非 string 的 enum 必须保留（string/number/integer/boolean/null）',
        run() {
          // 回归：原实现只在 `type: 'string'` 时保留 enum，其余标量的 enum 被静默丢弃，
          // 于是 `limit: {type:'integer', enum:[10,20]}` 这类约束**无声消失**（校验变松）。
          // DSH 的支持集合：lib/types/schema.d.ts:20-48 的 enum? 字段 +
          // lib/types/json-schema.js:251-263 的 allowedFor。
          const spec = toParameters({
            type: 'object',
            properties: {
              s: { type: 'string', enum: ['a', 'b'] },
              n: { type: 'number', enum: [1.5] },
              i: { type: 'integer', enum: [1, 2] },
              b: { type: 'boolean', enum: [true] },
              z: { type: 'null', enum: [null] },
            },
          })

          assert.deepEqual(spec.s, { type: 'string', enum: ['a', 'b'] })
          assert.deepEqual(spec.n, { type: 'number', enum: [1.5] }, 'number 的 enum 必须保留')
          assert.deepEqual(spec.i, { type: 'integer', enum: [1, 2] }, 'integer 的 enum 必须保留')
          assert.deepEqual(spec.b, { type: 'boolean', enum: [true] }, 'boolean 的 enum 必须保留')
          assert.deepEqual(spec.z, { type: 'null', enum: [null] }, 'null 的 enum 必须保留')

          // 端到端：编译后的参数 schema 里 enum 仍然在（defineTool 会投影 enum，见 schema.js:195-199）
          const definition = makeDefinition({ parameters: spec })
          assert.deepEqual(definition.parameters.properties.i.enum, [1, 2])
          assert.deepEqual(definition.parameters.properties.b.enum, [true])
          assert.deepEqual(definition.parameters.properties.z.enum, [null])

          // 忠实翻译、不替调用方放宽：类型不匹配的 enum 原样传下去，由 DSH **大声拒绝**
          // （若日后有人加"sanitize 掉不匹配 enum"的逻辑，这条会红）
          assert.throws(
            () => makeDefinition({ parameters: { i: { type: 'integer', enum: ['a'] } } }),
            /enum/,
          )
        },
      },
      {
        name: 'enum 只给标量：array/object/json 不得凭空获得 enum（DSH 会拒）',
        run() {
          const spec = toParameters({
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' }, enum: ['x'] },
              nested: { type: 'object', enum: ['x'], properties: {} },
              mystery: { enum: ['x'] },
            },
          })
          assert.ok(!Object.hasOwn(spec.tags, 'enum'), 'array 不支持 enum，不得带入 spec')
          assert.ok(!Object.hasOwn(spec.nested, 'enum'), 'object 不支持 enum，不得带入 spec')
          assert.deepEqual(spec.mystery, { type: 'json' }, '未知类型落 json，且不带 enum')
          // 顺带证明"带上就是非法的"：这些 spec 里只要出现 enum，defineTool 就会拒
          assert.throws(
            () => makeDefinition({ parameters: { a: { type: 'array', enum: [1] } } }),
            /enum/,
          )
        },
      },
      {
        name: 'const 必须保留（string/number/integer/boolean/null），false/null 不得被真值判断丢掉',
        run() {
          // 回归：原实现对**所有类型**静默丢弃 const——与 enum 同属"约束无声放松"。
          // DSH 支持集合：schema.d.ts:20-48 的 const? 字段 +
          // lib/types/json-schema.js:256-257 的 allowedFor（只允许标量）。
          const spec = toParameters({
            type: 'object',
            properties: {
              s: { type: 'string', const: 'fast' },
              n: { type: 'number', const: 1.5 },
              i: { type: 'integer', const: 2 },
              b: { type: 'boolean', const: false },
              z: { type: 'null', const: null },
              both: { type: 'string', enum: ['a', 'b'], const: 'b' },
            },
          })

          assert.deepEqual(spec.s, { type: 'string', const: 'fast' })
          assert.deepEqual(spec.n, { type: 'number', const: 1.5 })
          assert.deepEqual(spec.i, { type: 'integer', const: 2 })
          // 这两条专门守"实现别用真值判断"：false / null 都是合法取值，丢了就是放宽约束
          assert.deepEqual(spec.b, { type: 'boolean', const: false }, 'const: false 必须保留')
          assert.deepEqual(spec.z, { type: 'null', const: null }, 'const: null 必须保留')
          assert.deepEqual(spec.both, { type: 'string', enum: ['a', 'b'], const: 'b' })

          // 端到端：编译后的参数 schema 里 const 仍然在（schema.js:200-201 投影 const）
          const definition = makeDefinition({ parameters: spec })
          assert.equal(definition.parameters.properties.s.const, 'fast')
          assert.equal(definition.parameters.properties.b.const, false)
          assert.equal(definition.parameters.properties.z.const, null)

          // 忠实翻译、不得 sanitize：类型不匹配 / 与 enum 冲突 → 由 DSH 大声拒绝
          // （若日后有人加"丢掉不合法 const"的容错，这两条会红）
          assert.throws(
            () => makeDefinition({ parameters: { i: { type: 'integer', const: 'a' } } }),
            /const/,
          )
          assert.throws(
            () =>
              makeDefinition({ parameters: { s: { type: 'string', enum: ['a'], const: 'b' } } }),
            /const/,
          )
        },
      },
      {
        name: 'const 只给标量：array/object/json 不得凭空获得 const（DSH 会拒）',
        run() {
          const spec = toParameters({
            type: 'object',
            properties: {
              tags: { type: 'array', items: { type: 'string' }, const: ['x'] },
              nested: { type: 'object', const: 'x', properties: {} },
              mystery: { const: 'x' },
            },
          })
          assert.ok(!Object.hasOwn(spec.tags, 'const'), 'array 不支持 const，不得带入 spec')
          assert.ok(!Object.hasOwn(spec.nested, 'const'), 'object 不支持 const，不得带入 spec')
          assert.deepEqual(spec.mystery, { type: 'json' }, '未知类型落 json，且不带 const')
          // 顺带证明"带上就是非法的"：这些 spec 里只要出现 const，defineTool 就会拒
          assert.throws(
            () => makeDefinition({ parameters: { a: { type: 'array', const: 1 } } }),
            /const/,
          )
        },
      },
      {
        name: '根级 additionalProperties 不可表达：显式丢弃（不得变成同名参数），嵌套 openness 必须保留',
        run() {
          // `ParameterSchemaSpec` 是"隐式开放的对象根"（schema.d.ts:77-84），
          // 编译产物只有 { type:'object', properties[, required] }（schema.js:238-247），
          // 所以根级 additionalProperties 无法映射——策略是**显式丢弃**并写明理由。
          const spec = toParameters({
            type: 'object',
            additionalProperties: false,
            properties: {
              q: { type: 'string' },
              closed: {
                type: 'object',
                additionalProperties: false,
                properties: { a: { type: 'string' } },
              },
              open: { type: 'object', properties: { b: { type: 'string' } } },
            },
          })

          assert.ok(
            !Object.hasOwn(spec, 'additionalProperties'),
            '根级 openness 必须显式丢弃，绝不能变成一条名为 additionalProperties 的参数',
          )
          assert.deepEqual(Object.keys(spec).sort(), ['closed', 'open', 'q'])
          assert.equal(spec.closed.additionalProperties, false, '嵌套 object 的 openness 必须保留')
          assert.equal(spec.open.additionalProperties, true, '未声明时必须显式写 true（DSH 必填）')

          // 文档化副作用：编译后的参数根仍是开放的（DSH 既有语义，本函数无法修）
          const definition = makeDefinition({ parameters: spec })
          assert.equal(definition.parameters.type, 'object')
          assert.ok(
            !Object.hasOwn(definition.parameters, 'additionalProperties'),
            '根参数 schema 本就不带 openness（这就是"不可表达"的证据）',
          )
        },
      },
      {
        name: '转换产物必须能被真实 defineTool 接受（不得产出非法 spec）',
        run() {
          const table = [
            { type: 'string' },
            { type: 'number' },
            { type: 'integer' },
            { type: 'boolean' },
            { type: 'null' },
            { type: 'array' },
            { type: 'array', items: { type: 'json' } },
            { type: 'object' },
            { type: 'object', additionalProperties: false, properties: { x: { type: 'string' } } },
            {},
          ]
          for (const property of table) {
            const spec = toParameters({ type: 'object', properties: { p: property } })
            const definition = makeDefinition({ parameters: spec })
            assert.equal(definition.parameters.type, 'object', `spec 非法：${JSON.stringify(property)}`)
          }
        },
      },
      {
        name: 'arguments 非对象：defineTool 产物抛 ToolArgsError（code=INVALID_ARGS），替身必须同语义',
        run() {
          const definition = makeDefinition({ parameters: toParameters({ type: 'object' }) })
          const bad = ['nope', 42, null, undefined, [1, 2]]
          return Promise.all(
            bad.map((value) =>
              definition.execute(value, { signal: undefined }).then(
                () => assert.fail(`非对象 arguments 必须被拒：${JSON.stringify(value)}`),
                (error) => {
                  assert.equal(error.name, 'ToolArgsError')
                  assert.equal(error.code, 'INVALID_ARGS')
                  assert.match(error.message, /invalid arguments/)
                  assert.match(error.message, /must be an object/)
                },
              ),
            ),
          )
        },
      },
      {
        name: 'exec.signal 透传：包装后的 execute 把同一个 AbortSignal 交给用户实现',
        run() {
          const signal = new AbortController().signal
          let seen
          const definition = makeDefinition({
            execute: (_args, exec) => {
              seen = exec.signal
              return 'OK'
            },
          })
          return definition.execute({}, { signal }).then((value) => {
            assert.equal(value, 'OK')
            assert.equal(seen, signal, 'signal 必须同一引用透传（不得造新 controller）')
          })
        },
      },
      {
        name: '宿主注册路径：host-facade.registerTool 交给 tools.register 的就是 defineTool 产物',
        run() {
          const registered = new Map()
          const facade = makeFacadeForProbe(registered)
          facade.registerTool({
            name: 'probe',
            description: 'd',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
            execute: () => 'OK',
          })

          const definition = registered.get('probe')
          const spec = toParameters({ type: 'object', properties: { q: { type: 'string' } } })
          assert.deepEqual(definition.parameters, {
            type: 'object',
            properties: { q: { type: 'string' } },
          })
          assert.deepEqual(Object.keys(spec), ['q'])
          return definition.execute('not-an-object', { signal: undefined }).then(
            () => assert.fail('经 host-facade 注册的工具也必须校验 arguments'),
            (error) => {
              assert.equal(error.code, 'INVALID_ARGS')
            },
          )
        },
      },
      {
        name: '非法参数 schema 在 defineTool 期就被拒（不拖到 execute 才炸）',
        run() {
          assert.throws(() => makeDefinition({ parameters: { p: { type: 'weird' } } }), /weird|type/)
        },
      },
    ],
  }
}

/**
 * 只为本契约服务的最小 host-facade 装配：一个只提供 `tools` 的假 ctx。
 *
 * 它验证的是**注册路径**（host-facade → defineTool → tools.register），
 * 所以刻意不引真 cordis：契约用例依赖越少，红的时候越能确定是谁违约。
 */
function makeFacadeForProbe(registered) {
  return createHostFacade({
    ctx: {
      get(name) {
        if (name !== 'tools') return undefined
        return {
          register(definition) {
            registered.set(definition.name, definition)
            return () => registered.delete(definition.name)
          },
        }
      },
    },
    dshVersion: 'contract-1.0.0',
    log: () => {},
  })
}

export default makeDshToolsContract()
