//! 线格式基础类型：32 字节摘要（哈希与 Ed25519 公钥）与变长字节的十六进制序列化。
//!
//! 判定路径上**不使用** `HashMap` / `HashSet`（设计 §6.4）：本 crate 一律 `Vec` + 显式排序。

use std::fmt;

use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::hex::{self, HexError};

/// 32 字节定长值：SHA-256 摘要、Ed25519 公钥都走这个类型。
///
/// 它的 JSON 形态是 **64 字符小写十六进制字符串**（没有 `0x` 前缀、没有 `sha256:` 前缀——
/// 前缀属于报告层的呈现，链文件里只放裸字节）。
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Bytes32(pub [u8; 32]);

impl Bytes32 {
    /// 字节长度。
    pub const LEN: usize = 32;

    /// 全零值（哈希链第 1 条的 `prev_hash`）。
    pub const fn zero() -> Self {
        Bytes32([0u8; 32])
    }

    /// 从字节数组构造。
    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Bytes32(bytes)
    }

    /// 是否全零。
    pub fn is_zero(&self) -> bool {
        self.0.iter().all(|byte| *byte == 0)
    }

    /// 裸字节。
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// 小写十六进制。
    pub fn to_hex(&self) -> String {
        hex::encode(&self.0)
    }

    /// 从十六进制解析。
    pub fn from_hex(text: &str) -> Result<Self, HexError> {
        Ok(Bytes32(hex::decode_array::<32>(text)?))
    }
}

impl fmt::Display for Bytes32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_hex())
    }
}

impl fmt::Debug for Bytes32 {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Bytes32({})", self.to_hex())
    }
}

impl Serialize for Bytes32 {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_hex())
    }
}

impl<'de> Deserialize<'de> for Bytes32 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        Bytes32::from_hex(&text).map_err(|error| D::Error::custom(error.reason))
    }
}

/// `Vec<u8>` 的十六进制 serde 适配器：用 `#[serde(with = "crate::types::hex_bytes")]`。
///
/// 载荷字节（`payload_jcs`）与签名（`sig`）都走它。空字节序列编码成空字符串——这是
/// "该记录没有单独签名"（批量模式下由 Merkle 证明承担）的线格式表示。
pub mod hex_bytes {
    use serde::de::Error as _;
    use serde::{Deserialize, Deserializer, Serializer};

    use crate::hex;

    /// 序列化为小写十六进制字符串。
    pub fn serialize<S: Serializer>(bytes: &[u8], serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&hex::encode(bytes))
    }

    /// 从小写/大写十六进制字符串反序列化。
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<u8>, D::Error> {
        let text = String::deserialize(deserializer)?;
        hex::decode(&text).map_err(|error| D::Error::custom(error.reason))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes32_hex_round_trip() {
        let value = Bytes32::from_hex(&"ab".repeat(32)).unwrap();
        assert_eq!(value.to_hex(), "ab".repeat(32));
        assert!(!value.is_zero());
        assert!(Bytes32::zero().is_zero());
        assert!(Bytes32::from_hex("00").is_err());
    }

    #[test]
    fn bytes32_serializes_as_bare_hex() {
        let value = Bytes32::from_bytes([0x01; 32]);
        let json = serde_json::to_string(&value).unwrap();
        assert_eq!(json, format!("\"{}\"", "01".repeat(32)));
        let back: Bytes32 = serde_json::from_str(&json).unwrap();
        assert_eq!(back, value);
    }
}
