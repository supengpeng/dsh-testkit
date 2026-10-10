//! 密钥装载、签名与**签名次数计数器**（设计 §7.3.1 的 D4a 落点；指标 §10 的 I1）。
//!
//! # I1「私钥不出进程」怎么落
//!
//! 1. 私钥只从两处来：环境变量 `DSH_TESTKIT_ATTEST_KEY`（hex 种子）或
//!    `DSH_TESTKIT_ATTEST_KEY_FILE` 指向的受保护文件（Unix 上强制 `0600`；
//!    Windows 上无法可移植判定，如实返回 [`KeyFileProtection::Unsupported`]，
//!    **不假装检查过**）。
//! 2. [`KeyMaterial`] 的 `Debug` **手动实现**成脱敏打印——否则 `{:?}` 一次就把种子写进日志。
//! 3. 所有会进报告 / 日志 / 协议消息的公开类型（[`crate::chain::AttestedChain`] /
//!    [`crate::anchor::AnchorHead`]）都只带公钥，不带任何私钥字段。
//! 4. 测试里有一条"全量日志扫描"：把整条签名链产出的每一段文本喂给
//!    [`crate::leak_scan`]，命中只报位置、绝不打印原文。
//!
//! # 允许的"不出进程"边界
//!
//! 进程内的内存里当然有私钥（这是签名的前提）。I1 守的是**它不越出进程边界**
//! （不落盘、不进日志、不进报告、不进协议消息），不是"内存里也没有"。

use std::fmt;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer, SigningKey, VerifyingKey};
use serde::{Deserialize, Serialize};

use crate::error::KeyError;
use crate::hash::sha256_parts;
use crate::leak_scan::SensitiveNeedle;
use crate::types::Bytes32;

/// 验证器版本号（写进锚定文件，便于将来判定"当时是哪个版本验的"）。
pub const VERIFIER_VERSION: &str = "dsh-testkit-attest/1";

/// 批量签名原像的域标签。
pub const BATCH_DOMAIN: &[u8] = b"dsh-testkit/attest/v1:batch:";
/// 链头签名原像的域标签。
pub const HEAD_DOMAIN: &[u8] = b"dsh-testkit/attest/v1:head:";

/// 环境变量：hex 种子（32 字节 = 64 个十六进制字符）。
pub const ENV_KEY_HEX: &str = "DSH_TESTKIT_ATTEST_KEY";
/// 环境变量：受保护的密钥文件路径。
pub const ENV_KEY_FILE: &str = "DSH_TESTKIT_ATTEST_KEY_FILE";

/// 批量签名原像：`域标签 ‖ root ‖ first_seq(8 BE) ‖ last_seq(8 BE)`。
///
/// 把首末 `seq` 绑进去，使"同一棵树换个批次边界"不能再产生同样的签名。
pub fn batch_preimage(root: &Bytes32, first_seq: u64, last_seq: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(BATCH_DOMAIN.len() + 32 + 16);
    out.extend_from_slice(BATCH_DOMAIN);
    out.extend_from_slice(root.as_bytes());
    out.extend_from_slice(&first_seq.to_be_bytes());
    out.extend_from_slice(&last_seq.to_be_bytes());
    out
}

/// 链头签名原像：`域标签 ‖ chain_head ‖ record_count(8 BE)`。
pub fn head_preimage(chain_head: &Bytes32, record_count: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEAD_DOMAIN.len() + 32 + 8);
    out.extend_from_slice(HEAD_DOMAIN);
    out.extend_from_slice(chain_head.as_bytes());
    out.extend_from_slice(&record_count.to_be_bytes());
    out
}

/// D4a 的上界：`签名次数 ≤ ceil(结果记录数 / B) + 2`（指标 §5）。
///
/// `+2` 是**上界里的富余**，不是必须用满的额度：本实现的实际签名次数是
/// `ceil(N/B) + 1`（每批一个根签名 + 一个链头签名），留 1 次富余给将来
/// 可能的"空批也必须有一个签名"之类的形态演进。
pub fn signature_bound(result_records: u64, batch_size: usize) -> u64 {
    if batch_size == 0 {
        return 0;
    }
    result_records.div_ceil(batch_size as u64) + 2
}

/// 签名次数读数（D4a 直接读它，**与机器速度无关**的结构量）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureStats {
    /// 结果记录数（D4a 的 N）。
    pub result_records: u64,
    /// 批大小（D4a 的 B）。
    pub batch_size: usize,
    /// 批量根签名次数。
    pub batch_signatures: u64,
    /// 链头签名次数。
    pub head_signatures: u64,
    /// 逐条结果签名次数（只在对照模式 `per_record` 下非零）。
    pub per_record_signatures: u64,
    /// 总签名次数（= 上三者之和，每次 Ed25519 签名都计数）。
    pub total_signatures: u64,
    /// 上界 `ceil(N/B) + 2`。
    pub bound: u64,
    /// `total_signatures ≤ bound` 是否成立。
    pub within_bound: bool,
}

impl SignatureStats {
    /// 构造并顺带判定上界（唯一入口，避免有人只填一半字段）。
    pub fn new(
        result_records: u64,
        batch_size: usize,
        batch_signatures: u64,
        head_signatures: u64,
        per_record_signatures: u64,
    ) -> Self {
        let total_signatures = batch_signatures + head_signatures + per_record_signatures;
        let bound = signature_bound(result_records, batch_size);
        SignatureStats {
            result_records,
            batch_size,
            batch_signatures,
            head_signatures,
            per_record_signatures,
            total_signatures,
            bound,
            within_bound: total_signatures <= bound,
        }
    }
}

/// 密钥文件权限的可判定性（I1 的一部分：**不可判定要说出来，不能默默跳过**）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KeyFileProtection {
    /// 已强制检查（Unix：文件权限不得有组/其他位）。
    Enforced,
    /// 本平台无法可移植判定（Windows ACL 不是 POSIX 权限位）——如实标注。
    Unsupported {
        /// 原因。
        reason: String,
    },
}

/// 私钥材料。**不实现 `Clone`**：私钥副本越少越好。
pub struct KeyMaterial {
    seed: [u8; 32],
    signing: SigningKey,
}

impl KeyMaterial {
    /// 从 32 字节种子构造。
    pub fn from_seed_bytes(seed: [u8; 32]) -> Self {
        KeyMaterial {
            seed,
            signing: SigningKey::from_bytes(&seed),
        }
    }

    /// 从 hex 种子构造（64 个十六进制字符）。
    pub fn from_seed_hex(text: &str) -> Result<Self, KeyError> {
        let bytes = crate::hex::decode(text.trim()).map_err(KeyError::Hex)?;
        let length = bytes.len();
        let seed: [u8; 32] = bytes
            .try_into()
            .map_err(|_| KeyError::BadSeedLength(length))?;
        Ok(KeyMaterial::from_seed_bytes(seed))
    }

    /// 从环境变量装载：优先 `DSH_TESTKIT_ATTEST_KEY`，否则 `DSH_TESTKIT_ATTEST_KEY_FILE`。
    pub fn load_from_env() -> Result<Self, KeyError> {
        if let Ok(text) = std::env::var(ENV_KEY_HEX) {
            if !text.trim().is_empty() {
                return KeyMaterial::from_seed_hex(&text);
            }
        }
        if let Ok(path) = std::env::var(ENV_KEY_FILE) {
            if !path.trim().is_empty() {
                return KeyMaterial::load_from_file(Path::new(path.trim()));
            }
        }
        Err(KeyError::MissingSource)
    }

    /// 从受保护的文件装载。
    ///
    /// 两道拒绝：文件落在 git 仓库内（会被提交）→ [`KeyError::InsideRepository`]；
    /// Unix 上权限含组/其他位 → [`KeyError::PermissionsTooWide`]。
    ///
    /// **(b) 未覆盖的路径（task-26 的性质判定）**：`read_to_string` 成功 + `from_seed_hex` 成功
    /// 这条"合法密钥文件 ⇒ 装载成功"的路**在本会话里造不出来**——它要求文件在仓库**之外**，
    /// 而沙箱不允许子进程写仓库外路径（E4 的 `degraded` 同源，见 `tests/anchor_e4.rs`）。
    /// 被覆盖的是这条路的**拒绝半边**（仓库内的密钥文件必须被拒，见 `tests/env_paths.rs`），
    /// 也就是安全上更关键的那一半。**不为了让数字好看而放宽"必须在仓库之外"这条规则。**
    pub fn load_from_file(path: &Path) -> Result<Self, KeyError> {
        if let Some(root) = repository_root_of(path) {
            return Err(KeyError::InsideRepository(
                root.to_string_lossy().to_string(),
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(path)
                .map_err(|_| KeyError::Unreadable(path.to_string_lossy().to_string()))?;
            if metadata.permissions().mode() & 0o077 != 0 {
                return Err(KeyError::PermissionsTooWide(
                    path.to_string_lossy().to_string(),
                ));
            }
        }
        let text = std::fs::read_to_string(path)
            .map_err(|_| KeyError::Unreadable(path.to_string_lossy().to_string()))?;
        KeyMaterial::from_seed_hex(&text)
    }

    /// 公钥（32 字节）。
    pub fn public_key(&self) -> Bytes32 {
        Bytes32::from_bytes(self.signing.verifying_key().to_bytes())
    }

    /// 公钥的小写十六进制。
    pub fn public_key_hex(&self) -> String {
        self.public_key().to_hex()
    }

    /// 底层的 ed25519 验证键。
    pub fn verifying_key(&self) -> VerifyingKey {
        self.signing.verifying_key()
    }

    /// 签名一段字节。
    ///
    /// 这是**低层原语**：它不计数、不做域分隔。生产路径请走 [`crate::chain::Attestor`]
    /// （那里每次签名都会进 [`SignatureStats`]，D4a 才读得到数）。测试夹具与向量生成
    /// 直接调它，是为了能构造"签名被改坏"这类对照链条。
    pub fn sign(&self, message: &[u8]) -> Vec<u8> {
        self.signing.sign(message).to_bytes().to_vec()
    }

    /// 独立的 Ed25519 验签（验证器用，不接触私钥）。
    pub fn verify_with(public_key: &Bytes32, message: &[u8], signature: &[u8]) -> bool {
        let Ok(verifying) = VerifyingKey::from_bytes(public_key.as_bytes()) else {
            return false;
        };
        let Ok(signature) = ed25519_dalek::Signature::from_slice(signature) else {
            return false;
        };
        verifying.verify_strict(message, &signature).is_ok()
    }

    /// 本密钥的敏感针（给 [`crate::leak_scan`] 做日志扫描用；**针本身不会被打印**）。
    pub fn sensitive_needles(&self) -> Vec<SensitiveNeedle> {
        let keypair = self.signing.to_keypair_bytes();
        vec![
            SensitiveNeedle::new(
                "ed25519-seed-hex",
                crate::hex::encode(&self.seed).into_bytes(),
            ),
            SensitiveNeedle::new(
                "ed25519-keypair-hex",
                crate::hex::encode(&keypair).into_bytes(),
            ),
        ]
    }
}

impl fmt::Debug for KeyMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // 手动脱敏：绝不能把种子写进 `{:?}`。只给公钥（公开值）。
        write!(
            f,
            "KeyMaterial(<redacted>, public_key={})",
            self.public_key_hex()
        )
    }
}

impl Drop for KeyMaterial {
    fn drop(&mut self) {
        // 尽力而为的擦除。没有 `zeroize` 依赖（停止线 5 限制直接依赖数），
        // 编译器理论上可以优化掉这次写——所以这里**不声称**"内存已被安全清零"，
        // 只声称 I1 守的边界：不落盘、不进日志、不进报告、不进协议消息。
        for byte in self.seed.iter_mut() {
            *byte = 0;
        }
    }
}

/// 密钥文件的权限可判定性（Unix 之外如实返回 `Unsupported`）。
pub fn key_file_protection(_path: &Path) -> KeyFileProtection {
    #[cfg(unix)]
    {
        KeyFileProtection::Enforced
    }
    #[cfg(not(unix))]
    {
        KeyFileProtection::Unsupported {
            reason: "Windows ACL 不是 POSIX 权限位，本实现不做可移植判定（如实标注，不假装检查过）"
                .to_string(),
        }
    }
}

/// 从 `path` 向上找最近的 `.git`；找到则返回那个仓库根。
///
/// 用来拒绝"把私钥放进仓库"这类必然泄露的用法。
pub fn repository_root_of(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    let mut cursor = absolute.parent().map(Path::to_path_buf)?;
    loop {
        if cursor.join(".git").exists() {
            return Some(cursor);
        }
        cursor = cursor.parent().map(Path::to_path_buf)?;
    }
}

/// 域分隔的哈希（备用公开助手，便于外部按同一规则计算标签）。
pub fn domain_separated_hash(domain: &[u8], body: &[u8]) -> Bytes32 {
    sha256_parts(&[domain, body])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bound_follows_the_metric() {
        assert_eq!(signature_bound(0, 4096), 2);
        assert_eq!(signature_bound(1, 4096), 3);
        assert_eq!(signature_bound(4096, 4096), 3);
        assert_eq!(signature_bound(4097, 4096), 4);
        assert_eq!(signature_bound(100_000, 4096), 27);
    }

    #[test]
    fn debug_never_prints_the_seed() {
        let material = KeyMaterial::from_seed_bytes([7u8; 32]);
        let rendered = format!("{material:?}");
        assert!(rendered.contains("<redacted>"));
        assert!(!rendered.contains(&crate::hex::encode(&[7u8; 32])));
    }

    #[test]
    fn sign_then_verify_round_trip() {
        let material = KeyMaterial::from_seed_bytes([9u8; 32]);
        let signature = material.sign(b"payload");
        assert_eq!(signature.len(), 64);
        assert!(KeyMaterial::verify_with(
            &material.public_key(),
            b"payload",
            &signature
        ));
        assert!(!KeyMaterial::verify_with(
            &material.public_key(),
            b"payload!",
            &signature
        ));
        assert!(!KeyMaterial::verify_with(
            &material.public_key(),
            b"payload",
            &[0u8; 64]
        ));
        assert!(!KeyMaterial::verify_with(
            &material.public_key(),
            b"payload",
            &[0u8; 8]
        ));
    }

    #[test]
    fn bad_seed_is_rejected() {
        assert!(matches!(
            KeyMaterial::from_seed_hex("00"),
            Err(KeyError::BadSeedLength(1))
        ));
        assert!(matches!(
            KeyMaterial::from_seed_hex("zz"),
            Err(KeyError::Hex(_))
        ));
    }
}
