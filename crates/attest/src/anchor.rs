//! 链头本地锚定与 `AnchorProvider`（设计 §7.6，RFC §8 Q2 裁决的落地）。
//!
//! # 分层（Q2 的裁决就是这一张表）
//!
//! | 层 | 本期 | 挡什么 | 挡不住什么 |
//! |---|---|---|---|
//! | 本地锚定 | ✅ 实现 | "报告被单独改动"——链头同时写在报告里与仓库外的锚定目录，两处不一致即报 `anchor_mismatch` | 同时拥有报告与锚定目录写权限的人 |
//! | 外部锚定 | ❌ 只留接口 | （将来）整机 / 整容器被重写 | 第三方可用性与信任问题 |
//!
//! # 为什么一个外部 provider 都不实现
//!
//! 它们各自的失败模式都比它防的风险更常见——TSA 要网络（破离线场景）、CI 日志可被同权限者改、
//! 透明日志的生态与运维成本都还在早期。**留接口的代价接近零；接一个坏 provider 的代价是
//! 整条链的可信度。**（设计 §7.6）
//!
//! # 强度的诚实声明（必须随报告一起发布）
//!
//! > 本地锚定挡的是"**报告被单独改动**"——这是最常见的篡改形态（改一个数字，然后声称工具跑过了）。
//! > 它**挡不住**同时拥有报告与锚定目录写权限的人。要挡后者需要外部锚定，而那正是
//! > RFC §8 Q2 明确推迟的部分。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::AnchorError;
use crate::hash::sha256;
use crate::signing::{repository_root_of, VERIFIER_VERSION};
use crate::types::Bytes32;

/// 环境变量：锚定目录。
pub const ENV_ANCHOR_DIR: &str = "DSH_TESTKIT_ANCHOR_DIR";
/// 缺省锚定目录（相对家目录）。
pub const DEFAULT_ANCHOR_SUBDIR: &str = ".dsh-testkit/anchors";

/// 链头锚定记录（写进 `<锚定目录>/<project-hash>/<run_id>.anchor`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorHead {
    /// 运行 id。
    pub run_id: String,
    /// 链头哈希。
    pub chain_head: Bytes32,
    /// 记录总数。
    pub record_count: u64,
    /// 逻辑时钟刻度（**不是挂钟时间**，与记录链的 `ts` 同源，因此锚定本身是可复现的）。
    pub ts: i64,
    /// 写入时的验证器版本。
    pub verifier_version: String,
}

impl AnchorHead {
    /// 构造一份锚定记录（`verifier_version` 用本 crate 常量，不留给调用方乱填）。
    pub fn new(run_id: &str, chain_head: Bytes32, record_count: u64, ts: i64) -> Self {
        AnchorHead {
            run_id: run_id.to_string(),
            chain_head,
            record_count,
            ts,
            verifier_version: VERIFIER_VERSION.to_string(),
        }
    }

    /// 序列化成锚定文件内容（两空格缩进 + 结尾换行，便于 diff）。
    pub fn to_json_text(&self) -> Result<String, AnchorError> {
        let mut text = serde_json::to_string_pretty(self)
            .map_err(|error| AnchorError::Io(error.to_string()))?;
        text.push('\n');
        Ok(text)
    }
}

/// 外部锚定凭据（URL / 序号 / 票据）。本地实现里它是文件路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorReceipt {
    /// 锚定位置（本地：绝对路径；外部：URL / 序号 / 票据）。
    pub location: String,
    /// 写入后回读校验是否通过。
    pub verified: bool,
}

/// 锚定 provider 接口（设计 §7.6）。
///
/// **本期只实现本地层**；本 crate 里**没有**任何外部 provider 的实现，这是刻意的
/// （理由见模块文档）。接口留着，是为了将来接外部锚定**不改链格式**。
pub trait AnchorProvider: Send + Sync {
    /// provider 名字（进报告）。
    fn name(&self) -> &str;

    /// 把链头交给外部位置；返回可验证的锚定凭据（URL / 序号 / 票据）。
    fn anchor(&self, head: &AnchorHead) -> Result<AnchorReceipt, AnchorError>;

    /// 反查：这个链头在外部位置上是否真的存在。
    fn verify(&self, head: &AnchorHead, receipt: &AnchorReceipt) -> Result<bool, AnchorError>;
}

/// 本地锚定的结果。
///
/// **不允许静默降级**：写不进去或回读不上，就是 [`AnchorOutcome::Failed`]，
/// 如实记 `anchor: failed`（指标 E4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum AnchorOutcome {
    /// 已锚定且回读校验通过。
    Anchored {
        /// 锚定文件路径。
        path: String,
        /// 凭据。
        receipt: AnchorReceipt,
    },
    /// 锚定失败（含写在仓库内、写不进、回读不一致）。
    Failed {
        /// 目标路径（尽力给出，便于排障）。
        path: String,
        /// 失败原因（**不含任何私钥材料**）。
        reason: String,
    },
}

impl AnchorOutcome {
    /// 是否成功。
    pub fn is_anchored(&self) -> bool {
        matches!(self, AnchorOutcome::Anchored { .. })
    }

    /// 序列化成 JSON（进报告的形态）。
    pub fn to_json(&self) -> Value {
        serde_json::to_value(self).unwrap_or(Value::Null)
    }
}

/// 本地锚定 provider：把链头写到**仓库之外**的锚定目录，并立即回读校验。
#[derive(Debug, Clone)]
pub struct LocalAnchor {
    dir: PathBuf,
    project_hash: String,
    /// 仅由 [`LocalAnchor::unchecked_for_tests`] 置真：跳过"必须在仓库之外"的检查。
    allow_in_repo: bool,
}

impl LocalAnchor {
    /// 用显式目录 + 项目标识构造；目录落在 git 仓库内即拒绝。
    pub fn new(dir: PathBuf, project_id: &str) -> Result<Self, AnchorError> {
        if let Some(root) = repository_root_of(&dir) {
            return Err(AnchorError::DirectoryInsideRepository(
                root.to_string_lossy().to_string(),
            ));
        }
        Ok(LocalAnchor {
            dir,
            project_hash: project_hash(project_id),
            allow_in_repo: false,
        })
    }

    /// **仅供测试**：跳过"锚定目录必须在仓库之外"的检查。
    ///
    /// 存在的唯一理由：某些受限环境（例如本仓的开发沙箱）**只允许**子进程写仓库内路径，
    /// 于是"仓库之外"这条生产纪律在测试里无法满足。用它把这条限制**显式标注**出来，
    /// 而不是悄悄把生产检查删掉——生产入口 [`LocalAnchor::new`] / [`LocalAnchor::from_env`]
    /// 仍然强制检查，`tests/anchor.rs` 里有一条守卫证明它拒绝仓库内目录。
    ///
    /// 名字故意难看：任何人写业务代码时看到 `unchecked_for_tests` 都该停下来问一句。
    pub fn unchecked_for_tests(dir: PathBuf, project_id: &str) -> Self {
        LocalAnchor {
            dir,
            project_hash: project_hash(project_id),
            allow_in_repo: true,
        }
    }

    /// 从环境变量 `DSH_TESTKIT_ANCHOR_DIR` 取目录；缺省 `~/.dsh-testkit/anchors/`。
    pub fn from_env(project_id: &str) -> Result<Self, AnchorError> {
        let dir = match std::env::var(ENV_ANCHOR_DIR) {
            Ok(value) if !value.trim().is_empty() => PathBuf::from(value.trim()),
            _ => {
                let home = home_dir().ok_or(AnchorError::NoDirectory)?;
                home.join(DEFAULT_ANCHOR_SUBDIR)
            }
        };
        LocalAnchor::new(dir, project_id)
    }

    /// 锚定根目录。
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 项目哈希（16 个十六进制字符）。
    pub fn project_hash(&self) -> &str {
        &self.project_hash
    }

    /// 某个 run 的锚定文件路径。
    pub fn path_for(&self, run_id: &str) -> PathBuf {
        self.dir
            .join(&self.project_hash)
            .join(format!("{run_id}.anchor"))
    }

    /// 写入 + **立即回读校验**。失败如实返回 [`AnchorOutcome::Failed`]，不静默降级。
    pub fn write(&self, head: &AnchorHead) -> AnchorOutcome {
        let path = self.path_for(&head.run_id);
        let location = path.to_string_lossy().to_string();
        // (b) 环境相关（task-26 的性质判定）：`new` / `from_env` 已经在构造期拒绝了仓库内的
        // 目录，所以**严格模式**下这两条兜底（`!allow_in_repo` 与建目录失败）在测试里造不出来：
        // 要走到它们，锚定目录必须在仓库**之外**——而本会话的沙箱不允许子进程写仓库外路径
        // （E4 的 `degraded` 就是这条限制的产物，见 `tests/anchor_e4.rs` 的模块文档）。
        // 它们在**生产**里是可达的（那才是默认路径），因此保留；不为了让数字好看而放宽规则。
        if !self.allow_in_repo {
            if let Some(root) = repository_root_of(&path) {
                return AnchorOutcome::Failed {
                    path: location,
                    reason: AnchorError::DirectoryInsideRepository(
                        root.to_string_lossy().to_string(),
                    )
                    .to_string(),
                };
            }
        }
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                return AnchorOutcome::Failed {
                    path: location,
                    reason: format!("建目录失败：{error}"),
                };
            }
        }
        let text = match head.to_json_text() {
            Ok(text) => text,
            Err(error) => {
                return AnchorOutcome::Failed {
                    path: location,
                    reason: error.to_string(),
                }
            }
        };
        if let Err(error) = std::fs::write(&path, &text) {
            return AnchorOutcome::Failed {
                path: location,
                reason: format!("写锚定文件失败：{error}"),
            };
        }
        // 回读校验：读不回来 / 解析不了 / 与写入值不一致，三种都算失败。
        match self.read(&head.run_id) {
            Ok(read_back) if read_back == *head => AnchorOutcome::Anchored {
                path: location.clone(),
                receipt: AnchorReceipt {
                    location,
                    verified: true,
                },
            },
            Ok(read_back) => AnchorOutcome::Failed {
                path: location,
                reason: format!(
                    "回读不一致：写入 chain_head={} 读回 chain_head={}",
                    head.chain_head, read_back.chain_head
                ),
            },
            Err(error) => AnchorOutcome::Failed {
                path: location,
                reason: format!("回读失败：{error}"),
            },
        }
    }

    /// 读取某个 run 的锚定记录。
    pub fn read(&self, run_id: &str) -> Result<AnchorHead, AnchorError> {
        let path = self.path_for(run_id);
        let text = std::fs::read_to_string(&path).map_err(|error| {
            AnchorError::Io(format!("{} 不可读：{error}", path.to_string_lossy()))
        })?;
        serde_json::from_str(&text).map_err(|error| AnchorError::Io(error.to_string()))
    }
}

impl AnchorProvider for LocalAnchor {
    fn name(&self) -> &str {
        "local"
    }

    fn anchor(&self, head: &AnchorHead) -> Result<AnchorReceipt, AnchorError> {
        match self.write(head) {
            AnchorOutcome::Anchored { receipt, .. } => Ok(receipt),
            AnchorOutcome::Failed { reason, .. } => Err(AnchorError::ReadbackFailed(reason)),
        }
    }

    fn verify(&self, head: &AnchorHead, receipt: &AnchorReceipt) -> Result<bool, AnchorError> {
        let path = PathBuf::from(&receipt.location);
        if path != self.path_for(&head.run_id) {
            // 凭据指向的位置与本次锚定目录不一致：这是"凭据被换掉"的信号，明确报 false。
            return Ok(false);
        }
        let read_back = self.read(&head.run_id)?;
        Ok(read_back == *head)
    }
}

/// 项目哈希：项目标识的 SHA-256 前 16 个十六进制字符（锚定路径的一段）。
pub fn project_hash(project_id: &str) -> String {
    sha256(project_id.as_bytes()).to_hex()[..16].to_string()
}

/// 家目录（不引 `dirs` crate：`HOME` / `USERPROFILE` 两个环境变量够了）。
pub fn home_dir() -> Option<PathBuf> {
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(name) {
            if !value.trim().is_empty() {
                return Some(PathBuf::from(value.trim()));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        // 本仓的开发沙箱只允许子进程写仓库内路径，所以测试锚定目录落在 `target/attest-tests/` 下，
        // 并通过**显式命名**的 `unchecked_for_tests` 旁路构造（见该方法的文档）。
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/attest-tests")
            .join(tag)
    }

    #[test]
    fn project_hash_is_stable_and_short() {
        let hash = project_hash("C:/work/dsh-testkit");
        assert_eq!(hash.len(), 16);
        assert_eq!(hash, project_hash("C:/work/dsh-testkit"));
        assert_ne!(hash, project_hash("C:/work/other"));
    }

    #[test]
    fn local_anchor_round_trip_and_mismatch() {
        let dir = temp_dir("anchor-roundtrip");
        let anchor = LocalAnchor::unchecked_for_tests(dir.clone(), "project-x");
        assert_eq!(anchor.project_hash().len(), 16);
        let head = AnchorHead::new("run-1", Bytes32::from_bytes([1u8; 32]), 16, 16);
        let outcome = anchor.write(&head);
        assert!(outcome.is_anchored(), "{outcome:?}");
        assert_eq!(anchor.read("run-1").unwrap(), head);
        let receipt = AnchorReceipt {
            location: anchor.path_for("run-1").to_string_lossy().to_string(),
            verified: true,
        };
        assert!(anchor.verify(&head, &receipt).unwrap());
        let other = AnchorHead::new("run-1", Bytes32::from_bytes([2u8; 32]), 16, 16);
        assert!(!anchor.verify(&other, &receipt).unwrap());
    }

    #[test]
    fn anchor_inside_repository_is_refused() {
        let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
        let Some(root) = repository_root_of(manifest_dir) else {
            // 不在 git 工作树里（例如从 tarball 解出来的副本）：这条检查无从触发，如实跳过。
            eprintln!("跳过：{} 不在 git 工作树内", manifest_dir.display());
            return;
        };
        let error = LocalAnchor::new(root.join("target/anchors"), "p").unwrap_err();
        assert!(matches!(error, AnchorError::DirectoryInsideRepository(_)));
        // 生产构造器拒绝之后，显式旁路仍然能用（证明拒绝来自检查而不是路径本身不可用）。
        let unchecked =
            LocalAnchor::unchecked_for_tests(root.join("target/attest-tests/strict"), "p");
        assert_eq!(unchecked.project_hash().len(), 16);
    }

    #[test]
    fn write_failure_is_reported_not_swallowed() {
        let dir = temp_dir("anchor-fail");
        let anchor = LocalAnchor::unchecked_for_tests(dir, "project-x");
        let head = AnchorHead::new("run-2", Bytes32::from_bytes([3u8; 32]), 4, 4);
        // 让目标路径本身是一个目录：写入必然失败，且必须**如实**变成 Failed 而不是静默返回成功。
        std::fs::create_dir_all(anchor.path_for("run-2")).unwrap();
        let outcome = anchor.write(&head);
        assert!(!outcome.is_anchored(), "{outcome:?}");
        assert!(matches!(outcome, AnchorOutcome::Failed { .. }));
        assert!(!outcome.to_json().is_null());
    }
}
