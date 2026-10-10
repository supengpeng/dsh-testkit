//! 十六进制编解码。
//!
//! 为什么自己写而不是引一个 hex crate：本 crate 的直接依赖被 RFC 0001 §7 停止线 5 钉死在
//! 四个（`serde` / `serde_json` / `sha2` / `ed25519-dalek`）。十六进制编解码是二十行的事，
//! 不值得为它多开一个供应链面。
//!
//! 输出一律**小写**——签名链的字节表示必须唯一，`AB` 与 `ab` 同时被接受会让"同一份链"
//! 出现两种文本形态。

use std::fmt;

/// 十六进制解码错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HexError {
    /// 人类可读的原因（不含输入原文，避免把敏感字节带进日志）。
    pub reason: String,
}

impl fmt::Display for HexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "十六进制解码失败：{}", self.reason)
    }
}

impl std::error::Error for HexError {}

/// 把字节编码成小写十六进制字符串。
pub fn encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(TABLE[(byte >> 4) as usize] as char);
        out.push(TABLE[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 解码小写/大写十六进制字符串；长度必须是偶数。
pub fn decode(text: &str) -> Result<Vec<u8>, HexError> {
    if !text.len().is_multiple_of(2) {
        return Err(HexError {
            reason: "长度不是偶数".to_string(),
        });
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let high = nibble(pair[0])?;
        let low = nibble(pair[1])?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

/// 解码成固定长度的字节数组。
pub fn decode_array<const N: usize>(text: &str) -> Result<[u8; N], HexError> {
    let bytes = decode(text)?;
    if bytes.len() != N {
        return Err(HexError {
            reason: format!("期望 {} 字节，实际 {} 字节", N, bytes.len()),
        });
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&bytes);
    Ok(out)
}

fn nibble(byte: u8) -> Result<u8, HexError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err(HexError {
            reason: "出现非十六进制字符".to_string(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_lowercase_only() {
        assert_eq!(encode(&[0x00, 0x0f, 0xff]), "000fff");
        assert_eq!(decode("00aA").unwrap(), vec![0x00, 0xaa]);
        assert!(decode("0").is_err());
        assert!(decode("zz").is_err());
        assert_eq!(decode_array::<2>("0011").unwrap(), [0x00, 0x11]);
        assert!(decode_array::<3>("0011").is_err());
    }
}
