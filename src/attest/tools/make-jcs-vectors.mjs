/**
 * 开发工具：生成 `spec/vectors/jcs/*.json`（"输入 + 期望规范化字节"）。
 *
 * **这不是验证器的一部分**：验证器（`verify.mjs` / `jcs.mjs`）零依赖、只读；
 * 本文件是向量**生成侧**的工具，会写 `spec/vectors/jcs/`。之所以把它提交进仓，
 * 是因为向量的推导过程必须可复核——否则"期望字节"就成了不可追溯的魔数。
 *
 * 用法：`node src/attest/tools/make-jcs-vectors.mjs`
 *
 * 生成用的 oracle **刻意与 `jcs.mjs` 是两套代码**：
 *   · 数字：`String(x)`（RFC 8785 §3.2.2.3 把数字形态直接定义为 ECMAScript `Number::toString`）
 *   · 字符串：`JSON.stringify`（ES2019 起只逃逸强制集，且对孤立代理项输出 \uXXXX）
 *   · 键序：`Object.keys(...).sort()`（JS 默认字符串比较就是 UTF-16 码元序，RFC 8785 §3.2.3）
 *   · 结构：递归拼接，不加空白
 * 换句话说：oracle 是"用宿主语言的 JSON 语义"直接算出来的，不经过本仓的 JCS 实现。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const outDir = join(here, '..', '..', '..', 'spec', 'vectors', 'jcs')

/** 独立 oracle：把 JS 值与它的 RFC 8785 规范化文本对应起来。 */
function oracle(value) {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number': {
      if (!Number.isFinite(value)) throw new Error('JCS 不允许 NaN / Infinity')
      // -0 也必须落成 "0"（String(-0) === "0"）。
      return String(value)
    }
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(oracle).join(',')}]`
      const keys = Object.keys(value).sort()
      const pairs = keys.map((key) => `${JSON.stringify(key)}:${oracle(value[key])}`)
      return `{${pairs.join(',')}}`
    }
    default:
      throw new Error(`不支持的 JSON 类型：${typeof value}`)
  }
}

const hex = (text) => Buffer.from(text, 'utf8').toString('hex')

/** 用例表：`[id, note, JSON 文本]`。文本里刻意保留 `1.0` / `\u00e9` 这类**字面形态**。 */
const FILES = [
  {
    file: 'key-order.json',
    covers: ['key_order'],
    note: '键序无关性：对象键按 UTF-16 码元序排列（RFC 8785 §3.2.3）',
    cases: [
      ['key-order-01', '两个键：排序后 a 在前', '{"b":1,"a":2}'],
      ['key-order-02', '三个键全部倒序输入', '{"z":0,"m":0,"a":0}'],
      ['key-order-03', '空键排在最前', '{"":1,"a":2}'],
      ['key-order-04', 'UTF-16 码元序：大写字母在小写之前', '{"A":1,"a":2,"B":3}'],
      ['key-order-05', '嵌套对象同样要排序', '{"b":{"d":1,"c":2},"a":3}'],
      [
        'key-order-06',
        'UTF-16 码元序 ≠ 码点序：U+10000（代理对 D800 DC00）排在 U+E000 之前',
        '{"\\ue000":1,"\\ud800\\udc00":2}',
      ],
      [
        'key-order-07',
        '同一对键、输入顺序反过来，规范化结果必须逐字节相同',
        '{"\\ud800\\udc00":2,"\\ue000":1}',
      ],
      ['key-order-08', '数组里的对象各自排序，数组本身保序', '[{"b":1,"a":2},{"d":4,"c":3}]'],
    ],
  },
  {
    file: 'numbers.json',
    covers: ['number'],
    note: '数字规范化：ECMAScript Number::toString（RFC 8785 §3.2.2.3）',
    cases: [
      ['number-01', '1.0 规范化成 1（整数不带小数点）', '1.0'],
      ['number-02', '整数原样', '1'],
      ['number-03', '1e2 → 100（指数在阈值内要展开）', '1e2'],
      ['number-04', '大写 E 同样接受', '1E2'],
      ['number-05', '-0 规范化成 0', '-0'],
      ['number-06', '0.0 规范化成 0', '0.0'],
      ['number-07', '1e21 → 1e+21（≥1e21 走指数形式）', '1e21'],
      ['number-08', '1e20 → 100000000000000000000（<1e21 展开成 21 位整数）', '1e20'],
      ['number-09', '1e-6 → 0.000001（-6 < n ≤ 0 走小数形式）', '1e-6'],
      ['number-10', '1e-7 → 1e-7（n = -6 走指数形式）', '1e-7'],
      ['number-11', '0.0001', '0.0001'],
      ['number-12', '123.456', '123.456'],
      ['number-13', '负的小指数：-1.5e-7', '-1.5e-7'],
      ['number-14', '1.5e300 → 1.5e+300', '1.5e300'],
      [
        'number-15',
        '2^53+1 超出双精度可精确表示范围：按 IEEE 754 解释为 9007199254740992',
        '9007199254740993',
      ],
      [
        'number-16',
        'ECMAScript 最短可回环：1000000000000000128 → 1000000000000000100',
        '1000000000000000128',
      ],
      ['number-17', '0.1（二进制不能精确表示，但最短可回环就是 0.1）', '0.1'],
      ['number-18', '2.5', '2.5'],
      ['number-19', '次正规数下界 1e-323', '1e-323'],
      ['number-20', '嵌套结构里的数字同样规范化', '{"a":1.0,"b":[2.0,3e0]}'],
    ],
  },
  {
    file: 'unicode.json',
    covers: ['unicode'],
    note: 'Unicode：转义与字面等价，但不做任何归一化（RFC 8785 §3.2.2.2）',
    cases: [
      ['unicode-01', '\\u00e9 与字面 é 规范化后相同', '"\\u00e9"'],
      ['unicode-02', '字面 é（UTF-8 C3 A9）', '"é"'],
      ['unicode-03', '大写的 \\u00E9 同样', '"\\u00E9"'],
      ['unicode-04', '中文（非 ASCII 原样输出 UTF-8）', '"中文"'],
      ['unicode-05', '代理对转义 → 增补平面字符 😀', '"\\ud83d\\ude00"'],
      ['unicode-06', '字面 😀', '"😀"'],
      ['unicode-07', 'U+007F DEL 不在强制转义集里 → 原样输出', '"\\u007f"'],
      ['unicode-08', 'U+2028 / U+2029 不转义 → 原样输出', '"\\u2028\\u2029"'],
      ['unicode-09', '不做 NFC：e + U+0301 组合尖音符保持两个码点', '"e\\u0301"'],
      ['unicode-10', '不做 NFKC：U+FB01（ﬁ 连字）保持', '"\\uFB01"'],
      ['unicode-11', '键与值都涉及非 ASCII', '{"é":"\\u00e9"}'],
    ],
  },
  {
    file: 'escapes.json',
    covers: ['escape'],
    note: '转义：只转义强制集（" \\ 与 U+0000–U+001F），且短转义优先',
    cases: [
      ['escapes-01', '双引号', '"a\\"b"'],
      ['escapes-02', '反斜杠', '"a\\\\b"'],
      ['escapes-03', '换行用 \\n', '"a\\nb"'],
      ['escapes-04', '制表用 \\t', '"a\\tb"'],
      ['escapes-05', '回车用 \\r', '"a\\rb"'],
      ['escapes-06', 'U+0008 用 \\b（短转义优先）', '"a\\bb"'],
      ['escapes-07', 'U+000C 用 \\f（短转义优先）', '"a\\fb"'],
      ['escapes-08', 'U+001F 无短转义 → \\u001f（小写十六进制）', '"\\u001f"'],
      ['escapes-09', 'U+000B 无短转义 → \\u000b', '"\\u000b"'],
      ['escapes-10', '斜杠不是强制转义字符', '"/"'],
    ],
  },
  {
    file: 'nested.json',
    covers: ['nested'],
    note: '嵌套结构：任意深度的对象/数组都不加空白，键序与数字规则递归生效',
    cases: [
      ['nested-01', '深嵌套对象含空数组', '{"a":{"b":{"c":[1,2,{"d":[]}]}}}'],
      ['nested-02', '数组里嵌对象', '{"a":[{"z":1,"y":2}]}'],
      ['nested-03', '纯嵌套数组', '[[1,[2,[3,[]]]]]'],
      ['nested-04', '标量数组', '{"a":[true,false,null]}'],
      ['nested-05', '多层键排序', '{"b":{"a":{"d":1,"c":2},"z":3},"a":4}'],
    ],
  },
  {
    file: 'empty.json',
    covers: ['empty'],
    note: '空对象 / 空数组 / 空串：显式的 {} 与 []，没有空白',
    cases: [
      ['empty-01', '空对象', '{}'],
      ['empty-02', '空数组', '[]'],
      ['empty-03', '对象里嵌空对象与空数组', '{"a":{},"b":[]}'],
      ['empty-04', '空字符串', '""'],
      ['empty-05', '数组里嵌空数组与空对象', '[[],{}]'],
      ['empty-06', '两个空对象', '[{},{}]'],
      ['empty-07', '空键 + 空值', '{"":""}'],
    ],
  },
  {
    file: 'mixed.json',
    covers: ['nested'],
    note: '混合：接近真实报告的结构（键序 / 数字 / 转义 / 空结构一起出现）',
    cases: [
      [
        'mixed-01',
        '一份 run.json 形状的摘要（键序、1.0、嵌套、空数组同时出现）',
        '{"run_id":"a-1","overall":"pass","totals":{"total":2,"failed":0.0,"skipped":0},"cases":[],"uncompared_fields":[],"by_layer":{"L3":{"count":2,"confidence":"real"}}}',
      ],
      [
        'mixed-02',
        '用例数组：每条的键序都要排，数字要规范化',
        '{"cases":[{"id":"TK-0001","durationMs":31.0,"verdict":"passed"},{"verdict":"failed","id":"TK-0002","durationMs":4.4e1,"error":"\\u65ad\\u8a00\\u5931\\u8d25：expected 1.0"}]}',
      ],
      [
        'mixed-03',
        '键序无关 + 数字形态 + 非 ASCII + 控制字符一起上',
        '{"b":1,"a":1.0,"n":[1e-7,1e21,"é","\\u0000"]}',
      ],
      ['mixed-04', 'null / true / false / 嵌套空结构', '{"z":null,"y":true,"x":false,"w":[[]],"v":{}}'],
    ],
  },
]

let total = 0
mkdirSync(outDir, { recursive: true })
const coverage = new Set()
for (const entry of FILES) {
  const cases = entry.cases.map(([id, note, inputJson]) => {
    const normalized = oracle(JSON.parse(inputJson))
    total += 1
    for (const item of entry.covers) coverage.add(item)
    return {
      id,
      covers: entry.covers[0],
      note,
      input_json: inputJson,
      expected_hex: hex(normalized),
      expected_text: normalized,
    }
  })
  const document = {
    domain: 'jcs',
    covers: entry.covers,
    note: entry.note,
    source:
      'src/attest/tools/make-jcs-vectors.mjs（oracle = JS 的 JSON.stringify + 默认键排序；' +
      'RFC 8785 §3.2.2.3 把数字形态定义为 ECMAScript Number::toString）',
    cases,
  }
  const path = join(outDir, entry.file)
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  console.log(`[vectors] ${entry.file}: ${cases.length} 条（covers=${entry.covers.join(',')}）`)
}
console.log(`[vectors] 合计 ${total} 条向量 → ${outDir}`)
console.log(`[vectors] 覆盖类别：${[...coverage].sort().join(', ')}`)
