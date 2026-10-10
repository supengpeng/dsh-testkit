/**
 * 契约运行器自身的测试 + **反安慰剂**用例（文档 §5.4 的验收点）。
 *
 * ## 为什么"契约测试自己也要被测"
 *
 * 契约测试最常见的失效形态不是"用例写少了"，而是**运行器把红当绿**：
 * 异常被吞、计数算错、失败只报一句 `AssertionError`。所以这里钉住三件事：
 *   ① 结构化结果（ok/total/passed/failed/cases/failures）
 *   ② 点名格式：契约名 + 用例名 + 原始错误三者都在
 *   ③ 契约文件形状非法时抛 `ContractShapeError`，而不是伪装成一条产品失败
 *
 * ## 反安慰剂：故意破坏形状，契约必须变红
 *
 * 本文件用**同一个契约工厂**跑两遍：
 *   · 打真实现 → 必须 0 失败；
 *   · 打形状被破坏的 adapter / 替身 → 必须变红，且失败行点名到具体用例。
 * 对照组是关键：只有"真实现绿 + 破坏版红"同时成立，才证明契约不是安慰剂。
 *
 * ① 破损 host-facade（T5）：on 不返 disposer、registerTool 不转发 disposer
 * ② 破损 headless 替身（T5）：不再校验 arguments 必为对象
 * ③ dispose 退回 no-op（T9a）：契约必须抓住"卸了等于没卸"
 * ④ enum 退回"只保留 string"（T9b）：契约必须抓住约束被静默丢弃
 * ⑤ 把根级 additionalProperties 拷成同名参数（T9c 的错误修法）：契约必须抓住
 * ⑥ const 退回"全类型丢弃"（T10）：契约必须抓住约束被静默丢弃
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  assertContractsPass,
  ContractFailureError,
  ContractShapeError,
  describeError,
  formatCaseFailure,
  formatContractResults,
  runContract,
  runContracts,
  validateContract,
} from '../../lib/contracts/run.js'
import { createHeadlessHost } from '../../lib/headless/index.js'
import { createHostFacade, jsonSchemaToParameters } from '../../lib/host-facade.js'
import { makeDshToolsContract } from './dsh-tools.contract.mjs'
import { makeHeadlessContract } from './headless.contract.mjs'
import hostFacadeContract, { makeHostFacadeContract } from './host-facade.contract.mjs'

/** 一条永远通过的契约。 */
function greenContract() {
  return {
    version: '1.0.0',
    adapter: 'demo',
    tests: [
      { name: '同步通过', run() {} },
      {
        name: '异步通过',
        run: async () => {
          await Promise.resolve()
        },
      },
    ],
  }
}

/** 一条必然失败的契约。 */
function redContract() {
  return {
    version: '1.0.0',
    adapter: 'broken',
    tests: [
      {
        name: '坏用例',
        run() {
          throw new Error('原始错误')
        },
      },
    ],
  }
}

/* --------------------------------------------------------------- 形状校验 -- */

test('validateContract：真实契约零问题', () => {
  assert.deepEqual(validateContract(hostFacadeContract), [])
  assert.deepEqual(validateContract(greenContract()), [])
})

test('validateContract：形状非法逐条点名（version/adapter/tests/name/run/重复名）', () => {
  const problems = validateContract({
    version: '',
    adapter: '',
    tests: [{ name: '', run: 1 }],
  })
  assert.ok(problems.some((p) => /version/.test(p)), '应点名 version')
  assert.ok(problems.some((p) => /adapter/.test(p)), '应点名 adapter')
  assert.ok(problems.some((p) => /name/.test(p)), '应点名 name')
  assert.ok(problems.some((p) => /run/.test(p)), '应点名 run')

  assert.ok(
    validateContract({
      version: '1',
      adapter: 'a',
      tests: [
        { name: 'x', run() {} },
        { name: 'x', run() {} },
      ],
    }).some((p) => /重复/.test(p)),
    '用例名重复必须报（报告靠用例名点名）',
  )
  assert.ok(
    validateContract({ version: '1', adapter: 'a', tests: 'nope' }).some((p) => /tests/.test(p)),
  )
  assert.ok(
    validateContract({ version: '1', adapter: 'a', tests: [] }).some((p) => /不能为空/.test(p)),
    '空契约必须报',
  )
  assert.ok(validateContract(null).length > 0)
})

/* --------------------------------------------------------------- 结构化结果 -- */

test('runContract：全绿时给出结构化计数与逐条结果', async () => {
  const result = await runContract(greenContract())
  assert.equal(result.ok, true)
  assert.equal(result.adapter, 'demo')
  assert.equal(result.version, '1.0.0')
  assert.equal(result.total, 2)
  assert.equal(result.passed, 2)
  assert.equal(result.failed, 0)
  assert.deepEqual(result.cases.map((entry) => entry.name), ['同步通过', '异步通过'])
  assert.ok(result.cases.every((entry) => entry.ok === true))
  assert.ok(result.cases.every((entry) => typeof entry.durationMs === 'number'))
  assert.deepEqual(result.failures, [])
})

test('runContract：失败点名 = 契约名 + 用例名 + 原始错误', async () => {
  const result = await runContract(redContract())
  assert.equal(result.ok, false)
  assert.equal(result.total, 1)
  assert.equal(result.passed, 0)
  assert.equal(result.failed, 1)
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0], /^broken › 坏用例：/)
  assert.match(result.failures[0], /Error: 原始错误/)
  assert.equal(result.cases[0].error, 'Error: 原始错误')
})

test('runContract：一条失败不阻断其余用例（逐条隔离）', async () => {
  const seen = []
  const result = await runContract({
    version: '1',
    adapter: 'demo',
    tests: [
      { name: '1', run: () => seen.push(1) },
      {
        name: '2',
        run() {
          seen.push(2)
          throw new Error('boom')
        },
      },
      { name: '3', run: () => seen.push(3) },
      { name: '4', run: () => Promise.reject(new Error('async boom')) },
    ],
  })
  assert.deepEqual(seen, [1, 2, 3], '失败之后的用例仍必须被执行')
  assert.equal(result.passed, 2)
  assert.equal(result.failed, 2)
})

test('runContract：同步抛错 / rejected promise / 非 Error 抛出都被物化', async () => {
  const result = await runContract({
    version: '1',
    adapter: 'demo',
    tests: [
      {
        name: 'sync',
        run() {
          throw new Error('sync boom')
        },
      },
      {
        name: 'async',
        run: async () => {
          throw new Error('async boom')
        },
      },
      {
        name: 'plain',
        run() {
          throw 'plain string'
        },
      },
    ],
  })
  const text = result.failures.join('\n')
  assert.match(text, /Error: sync boom/)
  assert.match(text, /Error: async boom/)
  assert.match(text, /非 Error 抛出：plain string/, '非 Error 抛出也必须留住原始值')
})

test('runContract：契约形状非法时抛 ContractShapeError（点名 adapter 与问题）', async () => {
  await assert.rejects(
    () => runContract({ version: '1', adapter: 'broken-contract', tests: [] }),
    (error) => {
      assert.ok(error instanceof ContractShapeError, '应是 ContractShapeError')
      assert.match(error.message, /broken-contract/)
      assert.ok(error.problems.some((problem) => /不能为空/.test(problem)))
      return true
    },
  )
})

/* ------------------------------------------------------------------ 汇总 -- */

test('runContracts + formatContractResults：计数汇总与失败行同源', async () => {
  const results = await runContracts([greenContract(), redContract()])
  const text = formatContractResults(results)
  assert.match(text, /契约 demo@1\.0\.0：2\/2 通过/)
  assert.match(text, /契约 broken@1\.0\.0：0\/1 通过，1 失败/)
  assert.match(text, /✗ broken › 坏用例：Error: 原始错误/)
  assert.match(text, /合计：2 个契约｜3 用例｜2 通过｜1 失败/)
})

test('assertContractsPass：全绿返回结果；遇红抛 ContractFailureError 且带点名汇总', async () => {
  const results = await assertContractsPass([greenContract()])
  assert.equal(results.length, 1)
  assert.equal(results[0].ok, true)

  await assert.rejects(
    () => assertContractsPass([greenContract(), redContract()]),
    (error) => {
      assert.ok(error instanceof ContractFailureError)
      assert.match(error.message, /✗ broken › 坏用例/)
      assert.equal(error.results.length, 2)
      return true
    },
  )
})

test('describeError / formatCaseFailure：点名格式稳定（单测可依赖）', () => {
  assert.equal(describeError(new TypeError('x')), 'TypeError: x')
  assert.equal(describeError('plain'), '非 Error 抛出：plain')
  assert.equal(
    formatCaseFailure('a', 'b', new Error('c')),
    'a › b：Error: c',
  )
})

/* ------------------------------------------------------- 反安慰剂：破坏形状 -- */

test('反安慰剂①：形状被破坏的 host-facade 必须让契约变红，且点名到具体用例', async () => {
  // 破坏点：`on` 不再返回 disposer，`registerTool` 也不再转发宿主的 disposer。
  const brokenAdapterContract = makeHostFacadeContract((options) => {
    const facade = createHostFacade(options)
    return {
      ...facade,
      on: () => undefined,
      registerTool: (definition) => {
        facade.registerTool(definition)
        return undefined
      },
    }
  })

  const result = await runContract(brokenAdapterContract)
  assert.equal(result.ok, false, '破坏形状后契约必须变红')
  assert.ok(result.failed >= 2, `至少应有两处破坏被抓住，实际 ${result.failed}`)

  const failures = result.failures.join('\n')
  assert.match(failures, /host-facade/, '失败行必须带契约名')
  assert.match(failures, /on：返回 disposer/, '必须点名"on 返回 disposer"这条用例')
  assert.match(failures, /registerTool：返回 tools\.register 的 disposer/, '必须点名 registerTool 那条')
  assert.match(failures, /AssertionError/, '必须保留原始错误类型')

  // 对照组：同一个契约打真实现必须零失败——否则红的原因是"契约自己写了必红断言"
  const clean = await runContract(makeHostFacadeContract())
  assert.equal(clean.failed, 0, formatContractResults([clean]))
})

test('反安慰剂②：形状被破坏的 headless 替身（不再校验 arguments）必须让契约变红', async () => {
  // 破坏点：替身对非对象 arguments "宽容处理"——正是文件头注警告的那种漂移。
  const brokenSubstitute = async (options) => {
    const headless = await createHeadlessHost(options)
    const execute = headless.services.tools.execute
    headless.services.tools.execute = (input) => {
      const args = input.arguments
      const normalized =
        args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {}
      return execute({ ...input, arguments: normalized })
    }
    return headless
  }

  const result = await runContract(makeHeadlessContract(brokenSubstitute))
  assert.equal(result.ok, false, '替身漂移必须被契约抓住（否则 CI 绿着骗人）')
  assert.ok(
    result.failures.some((failure) => /arguments 必须是对象/.test(failure)),
    '失败行必须点名 arguments 校验那条用例',
  )
  assert.match(result.failures.join('\n'), /headless/)

  const clean = await runContract(makeHeadlessContract())
  assert.equal(clean.failed, 0, formatContractResults([clean]))
})

/* ------------------- 反安慰剂：T9 三处修复各自的"回归就红"证明 ------------------- */

test('反安慰剂③：dispose 退回旧的 no-op 语义 → headless 契约必须红', async () => {
  // 复刻 T9(a) 修复前的旧实现：dispose 什么都没做（判 ctx.dispose，而它不存在）。
  const legacyNoopDispose = async (options) => {
    const headless = await createHeadlessHost(options)
    return { ...headless, dispose: async () => {} }
  }

  const result = await runContract(makeHeadlessContract(legacyNoopDispose))
  assert.equal(result.ok, false, 'no-op dispose 必须被契约抓住')
  assert.ok(
    result.failures.some((failure) => /dispose：真卸载/.test(failure)),
    '失败行必须点名 dispose 那条用例',
  )

  const clean = await runContract(makeHeadlessContract())
  assert.equal(clean.failed, 0, formatContractResults([clean]))
})

test('反安慰剂④：enum 退回"只保留 string" → dsh-tools 契约必须红', async () => {
  // 复刻 T9(b) 修复前的旧实现：非 string 标量的 enum 被静默丢弃。
  const legacyStringOnlyEnum = (schema) => {
    const spec = jsonSchemaToParameters(schema)
    for (const [key, value] of Object.entries(spec)) {
      if (value && typeof value === 'object' && value.type !== 'string' && 'enum' in value) {
        const { enum: _dropped, ...rest } = value
        spec[key] = rest
      }
    }
    return spec
  }

  const result = await runContract(makeDshToolsContract({ toParameters: legacyStringOnlyEnum }))
  assert.equal(result.ok, false, 'enum 被静默丢弃必须被契约抓住')
  assert.ok(
    result.failures.some((failure) => /非 string 的 enum 必须保留/.test(failure)),
    '失败行必须点名 enum 保真那条用例',
  )

  const clean = await runContract(makeDshToolsContract())
  assert.equal(clean.failed, 0, formatContractResults([clean]))
})

test('反安慰剂⑤：把根级 additionalProperties 错误地塞成同名参数 → dsh-tools 契约必须红', async () => {
  // 复刻 T9(c) 的**错误修法**：不是显式丢弃，而是把它拷进属性表
  // （那会变成一条名为 additionalProperties 的真实参数）。
  const wrongRootOpenness = (schema) => {
    const spec = jsonSchemaToParameters(schema)
    if (schema && typeof schema === 'object' && schema.additionalProperties === false) {
      spec.additionalProperties = { type: 'boolean' }
    }
    return spec
  }

  const result = await runContract(makeDshToolsContract({ toParameters: wrongRootOpenness }))
  assert.equal(result.ok, false, '把 openness 拷成参数必须被契约抓住')
  assert.ok(
    result.failures.some((failure) => /根级 additionalProperties 不可表达/.test(failure)),
    '失败行必须点名根级 additionalProperties 那条用例',
  )

  const clean = await runContract(makeDshToolsContract())
  assert.equal(clean.failed, 0, formatContractResults([clean]))
})

test('反安慰剂⑥：const 退回"全类型丢弃" → dsh-tools 契约必须红', async () => {
  // 复刻 T10 修复前的旧实现：const 被整体静默丢弃（enum 不动，确保红的归因唯一）。
  const legacyConstDropping = (schema) => {
    const spec = jsonSchemaToParameters(schema)
    for (const [key, value] of Object.entries(spec)) {
      if (value && typeof value === 'object' && Object.hasOwn(value, 'const')) {
        const copy = { ...value }
        delete copy.const
        spec[key] = copy
      }
    }
    return spec
  }

  const result = await runContract(makeDshToolsContract({ toParameters: legacyConstDropping }))
  assert.equal(result.ok, false, 'const 被静默丢弃必须被契约抓住')
  assert.ok(
    result.failures.some((failure) => /const 必须保留/.test(failure)),
    '失败行必须点名 const 保真那条用例',
  )

  const clean = await runContract(makeDshToolsContract())
  assert.equal(clean.failed, 0, formatContractResults([clean]))
})
