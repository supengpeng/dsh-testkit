/**
 * Ed25519 验签与签名（只经由 `node:crypto`——设计 §7.4：验证器若依赖第三方 npm 包，
 * 供应链攻击面会直接落在"验证"这个动作上）。
 *
 * 公钥/私钥都用**裸字节**表示（链文件里就是裸字节的 hex，没有 `0x`、没有 PEM）：
 *   · SPKI 的 Ed25519 前缀固定是 `302a300506032b6570032100`（12 字节），后面接 32 字节裸公钥；
 *   · PKCS#8 的前缀固定是 `302e020100300506032b657004220420`（16 字节），后面接 32 字节种子。
 * 两个前缀都是 RFC 8410 固定的结构，不是"经验值"。
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

import { fromHexFixed, toHex } from './hex.mjs'

/** SPKI 结构里 Ed25519 公钥的固定前缀。 */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** PKCS#8 结构里 Ed25519 私钥（种子）的固定前缀。 */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

const DOMAIN_SEPARATOR = null // Ed25519 是"纯"签名（RFC 8032）：不需要再套一层摘要算法

/**
 * 裸公钥字节 → KeyObject。
 * @param {Buffer} publicKey 32 字节裸公钥
 * @returns {import('node:crypto').KeyObject} 公钥对象
 */
export function publicKeyObject(publicKey) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) {
    throw new Error('Ed25519 公钥必须是 32 字节')
  }
  return createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, publicKey]),
    format: 'der',
    type: 'spki',
  })
}

/**
 * 32 字节种子 → 私钥 KeyObject。
 * @param {Buffer} seed 32 字节种子
 * @returns {import('node:crypto').KeyObject} 私钥对象
 */
export function privateKeyObject(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) {
    throw new Error('Ed25519 种子必须是 32 字节')
  }
  return createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  })
}

/**
 * 从私钥对象导出裸公钥（取 SPKI DER 的末 32 字节）。
 * @param {import('node:crypto').KeyObject} privateKey 私钥对象
 * @returns {Buffer} 32 字节裸公钥
 */
export function rawPublicKey(privateKey) {
  const der = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return Buffer.from(der.subarray(der.length - 32))
}

/**
 * 验证一个 Ed25519 签名。
 *
 * 长度不对一律返回 `false`（而不是抛错）——验证器的语义是"给出结论"，不是"炸掉"。
 * @param {Buffer} publicKey 32 字节裸公钥
 * @param {Buffer} message 被签名的消息
 * @param {Buffer} signature 64 字节签名
 * @returns {boolean} 是否通过
 */
export function verifyEd25519(publicKey, message, signature) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) return false
  if (!Buffer.isBuffer(signature) || signature.length !== 64) return false
  try {
    return verify(DOMAIN_SEPARATOR, message, publicKeyObject(publicKey), signature)
  } catch {
    return false
  }
}

/**
 * 签一个 Ed25519 签名（测试夹具与向量生成用；验证器本身**不**调用它）。
 * @param {import('node:crypto').KeyObject} privateKey 私钥对象
 * @param {Buffer} message 消息
 * @returns {Buffer} 64 字节签名
 */
export function signEd25519(privateKey, message) {
  return sign(DOMAIN_SEPARATOR, message, privateKey)
}

/**
 * 用公开标签派生一把测试密钥（两侧同构：`seed = SHA-256(utf8(label))`）。
 *
 * ⚠️ **只用于测试与向量**：标签是公开的，任何人都能重算出同一把密钥，所以它不构成秘密。
 * 生产中私钥必须来自环境变量或受权限保护的文件（Rust 侧 `KeyMaterial::load_from_env`）。
 * @param {string} label 公开标签
 * @returns {{seed: Buffer, publicKey: Buffer, privateKey: import('node:crypto').KeyObject}} 测试密钥
 */
export function deriveLabelKey(label) {
  const seed = createHash('sha256').update(Buffer.from(label, 'utf8')).digest()
  const privateKey = privateKeyObject(seed)
  return { seed, publicKey: rawPublicKey(privateKey), privateKey }
}

/**
 * 从 hex 读一把测试密钥（给 CLI 的 `--pubkey` 之类用；不接受私钥形态）。
 * @param {string} hex 64 字符 hex
 * @returns {Buffer} 32 字节公钥
 */
export function publicKeyFromHex(hex) {
  return fromHexFixed(hex, 32)
}

/**
 * 公钥 → hex（报告用）。
 * @param {Buffer} publicKey 32 字节公钥
 * @returns {string} 小写 hex
 */
export function publicKeyToHex(publicKey) {
  return toHex(publicKey)
}
