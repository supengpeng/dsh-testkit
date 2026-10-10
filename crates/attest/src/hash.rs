//! SHA-256 摘要助手（唯一实现，链上所有哈希都从这里出）。

use sha2::{Digest, Sha256};

use crate::types::Bytes32;

/// 对一段字节求 SHA-256。
pub fn sha256(data: &[u8]) -> Bytes32 {
    let mut hasher = Sha256::new();
    hasher.update(data);
    finish(hasher)
}

/// 对多段字节**拼接后**求 SHA-256（等价于先 concat 再哈希，但不多分配一次）。
pub fn sha256_parts(parts: &[&[u8]]) -> Bytes32 {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    finish(hasher)
}

fn finish(hasher: Sha256) -> Bytes32 {
    let digest = hasher.finalize();
    let mut bytes = [0u8; 32];
    bytes.copy_from_slice(&digest);
    Bytes32(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_known_vector() {
        // 空串的 SHA-256（公开已知值，与实现无关）。
        assert_eq!(
            sha256(b"").to_hex(),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        // 拼接等价于 concat。
        assert_eq!(sha256_parts(&[b"ab", b"c"]), sha256(b"abc"));
    }
}
