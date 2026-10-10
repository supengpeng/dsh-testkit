/**
 * 十六进制编解码（零依赖：只用 `node:` 之外的东西一概不碰）。
 *
 * 输出一律**小写**——签名链的字节表示必须唯一，`AB` 与 `ab` 同时被接受会让"同一份链"
 * 出现两种文本形态，而验证器要判的正是"同一份链"。
 */

/** 十六进制字符集。 */
const HEX = /^[0-9a-fA-F]*$/

/**
 * 字节 → 小写十六进制。
 * @param {Uint8Array|Buffer} bytes 字节
 * @returns {string} 小写十六进制
 */
export function toHex(bytes) {
  return Buffer.from(bytes).toString('hex')
}

/**
 * 十六进制 → 字节。
 * @param {string} text 十六进制文本
 * @returns {Buffer} 字节
 */
export function fromHex(text) {
  if (typeof text !== 'string') throw new Error('十六进制必须是字符串')
  if (text.length % 2 !== 0) throw new Error('十六进制长度必须是偶数')
  if (!HEX.test(text)) throw new Error('出现非十六进制字符')
  return Buffer.from(text, 'hex')
}

/**
 * 十六进制 → 固定长度字节（长度不符即抛）。
 * @param {string} text 十六进制文本
 * @param {number} length 期望字节数
 * @returns {Buffer} 字节
 */
export function fromHexFixed(text, length) {
  const bytes = fromHex(text)
  if (bytes.length !== length) {
    throw new Error(`期望 ${length} 字节，实际 ${bytes.length} 字节`)
  }
  return bytes
}

/**
 * 是否合法的 hex 字符串（长度与字符集）。
 * @param {unknown} value 待检查值
 * @param {number} length 期望字节数
 * @returns {boolean} 是否合法
 */
export function isHex(value, length) {
  return typeof value === 'string' && value.length === length * 2 && HEX.test(value)
}
