/**
 * JCS 规范化（RFC 8785）——TS 侧实现。
 *
 * 这一份**不是**"Rust 实现的翻译"，也不是把 `JSON.stringify` 包一层：字符串转义、
 * 键序、数字形态三条规则都在这里显式写出。两侧之所以都要有实现，是因为设计 §7.2 说得很直白：
 * **只靠一侧实现，另一侧的"独立验证"就不是独立的——那等于用同一个实现自证。**
 *
 * 与 Rust 侧一致的三条：
 *   · 键按 **UTF-16 码元序**（JS 对字符串的默认 `<` 就是码元比较，`Array.prototype.sort()`
 *     缺省也用它——但这里显式写成比较函数，免得将来有人给它塞 localeCompare）；
 *   · 字符串只逃逸强制集（`"` `\` 与 U+0000–U+001F），短转义优先，其余 `\u00xx` **小写**；
 *   · 数字用 `String(x)`——RFC 8785 §3.2.2.3 把数字形态**直接定义**为 ECMAScript
 *     `Number::toString`，所以在 JS 里这就是规范本身，不是取巧。
 *
 * 另外两条同样是规范要求：**不做 Unicode 归一化**；`-0` 落成 `0`。
 *
 * 边界：孤立代理项（lone surrogate）在 JCS 里是非法输入，这里直接抛错——**不静默替换成
 * U+FFFD**，因为那会让两个不同的输入产生同一个"规范化"结果，等于毁掉签名的前提。
 */

/** 短转义表（RFC 8785 §3.2.2.2：这五个控制字符用短转义）。 */
const SHORT_ESCAPES = new Map([
  [0x08, '\\b'],
  [0x09, '\\t'],
  [0x0a, '\\n'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
])

/**
 * 按 JCS 规则转义一个字符串。
 * @param {string} text 输入文本
 * @returns {string} 含引号的 JSON 字符串字面量
 */
export function quote(text) {
  if (typeof text !== 'string') throw new Error('JCS 只接受字符串')
  let out = '"'
  for (const ch of text) {
    const code = ch.codePointAt(0)
    if (code === 0x22) {
      out += '\\"'
    } else if (code === 0x5c) {
      out += '\\\\'
    } else if (SHORT_ESCAPES.has(code)) {
      out += SHORT_ESCAPES.get(code)
    } else if (code < 0x20) {
      out += `\\u${code.toString(16).padStart(4, '0')}`
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // `for...of` 会把合法代理对合成一个码点，所以走到这里的都是孤立代理项。
      throw new Error(`JCS 不允许孤立代理项（U+${code.toString(16).toUpperCase()}）`)
    } else {
      out += ch
    }
  }
  return `${out}"`
}

/**
 * 按 JCS 规则格式化一个数字。
 * @param {number} value 数字
 * @returns {string} 规范化文本
 */
export function formatEsNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('JCS 不允许 NaN / Infinity')
  }
  return String(value)
}

/**
 * 键的 UTF-16 码元序比较（RFC 8785 §3.2.3）。
 * @param {string} left 左键
 * @param {string} right 右键
 * @returns {number} 比较结果
 */
export function compareKeys(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * 递归写出一段规范化的 JSON 文本。
 * @param {unknown} value 任意 JSON 值
 * @param {string[]} out 输出缓冲
 */
function writeValue(value, out) {
  if (value === null) {
    out.push('null')
    return
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false')
      return
    case 'number':
      out.push(formatEsNumber(value))
      return
    case 'string':
      out.push(quote(value))
      return
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[')
        value.forEach((item, index) => {
          if (index > 0) out.push(',')
          writeValue(item, out)
        })
        out.push(']')
        return
      }
      const keys = Object.keys(value).sort(compareKeys)
      out.push('{')
      keys.forEach((key, index) => {
        if (index > 0) out.push(',')
        out.push(quote(key))
        out.push(':')
        // `Object.keys` 与取值同源；`undefined` 不是合法 JSON，直接抛。
        const item = value[key]
        if (item === undefined) throw new Error('JCS 不接受 undefined')
        writeValue(item, out)
      })
      out.push('}')
      return
    }
    default:
      throw new Error(`JCS 不支持的类型：${typeof value}`)
  }
}

/**
 * 规范化一个已经解析好的 JSON 值。
 * @param {unknown} value 任意 JSON 值
 * @returns {string} 规范化文本
 */
export function canonicalize(value) {
  const out = []
  writeValue(value, out)
  return out.join('')
}

/**
 * 规范化一份 JSON 文本。
 * @param {string} text JSON 文本
 * @returns {string} 规范化文本
 */
export function canonicalizeText(text) {
  return canonicalize(JSON.parse(text))
}

/**
 * 规范化后的字节（UTF-8）。
 * @param {unknown} value 任意 JSON 值
 * @returns {Buffer} 规范化字节
 */
export function canonicalizeBytes(value) {
  return Buffer.from(canonicalize(value), 'utf8')
}
