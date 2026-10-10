//! Merkle 树、inclusion proof 与批量签名用到的叶子编码（设计 §7.3.1）。
//!
//! # 树形规则（本仓自己定，因此必须写清）
//!
//! - 叶子：`leaf = SHA-256(0x00 ‖ record_hash)`；
//! - 内部节点：`node = SHA-256(0x01 ‖ left ‖ right)`；
//! - 前缀字节是**域分隔**：防止把"叶子"当成"内部节点"重放（RFC 6962 的做法）；
//! - 奇数个节点时**末位直接晋升**（不复制自己）——复制会让"7 片叶"和"8 片叶其中一片重复"
//!   得到同一个根，那是 CVE-2012-2459 那类可塑性问题；
//! - 叶序 = 结果记录在链上的 `seq` 升序（由调用方保证，见 [`crate::chain`]）。
//!
//! 验证成本 `O(log N)` 每叶、签名次数 `O(N/B)`（B 为批大小）——这正是设计 §7.3.1 的要点。

use serde::{Deserialize, Serialize};

use crate::hash::sha256_parts;
use crate::types::Bytes32;

/// 叶子前缀字节。
pub const LEAF_PREFIX: u8 = 0x00;
/// 内部节点前缀字节。
pub const NODE_PREFIX: u8 = 0x01;

/// 计算叶子哈希。
pub fn leaf_hash(record_hash: &Bytes32) -> Bytes32 {
    sha256_parts(&[&[LEAF_PREFIX], record_hash.as_bytes()])
}

/// 计算内部节点哈希。
pub fn node_hash(left: &Bytes32, right: &Bytes32) -> Bytes32 {
    sha256_parts(&[&[NODE_PREFIX], left.as_bytes(), right.as_bytes()])
}

/// 兄弟节点在左还是在右。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    /// 兄弟在当前节点的**左**边。
    Left,
    /// 兄弟在当前节点的**右**边。
    Right,
}

/// inclusion proof 的一步。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProofStep {
    /// 兄弟节点哈希。
    pub sibling: Bytes32,
    /// 兄弟节点所在的一侧。
    pub side: Side,
}

/// 一条叶子的 inclusion proof。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InclusionProof {
    /// 自底向上的步骤序列（奇数晋升的层不会产生步骤）。
    pub path: Vec<ProofStep>,
}

impl InclusionProof {
    /// 步骤数（= 树高，验证成本 `O(log N)` 的依据）。
    pub fn len(&self) -> usize {
        self.path.len()
    }

    /// 是否没有步骤（单叶树的证据）。
    pub fn is_empty(&self) -> bool {
        self.path.is_empty()
    }

    /// 用本条证据从叶子重算根。
    pub fn recompute_root(&self, leaf: &Bytes32) -> Bytes32 {
        let mut current = *leaf;
        for step in &self.path {
            current = match step.side {
                Side::Left => node_hash(&step.sibling, &current),
                Side::Right => node_hash(&current, &step.sibling),
            };
        }
        current
    }

    /// 校验本条证据是否指向 `root`。
    pub fn verifies(&self, leaf: &Bytes32, root: &Bytes32) -> bool {
        self.recompute_root(leaf) == *root
    }
}

/// 预建好各层的 Merkle 树；根与所有叶子的证据都是 `O(log N)` 查询。
#[derive(Debug, Clone)]
pub struct MerkleTree {
    levels: Vec<Vec<Bytes32>>,
}

impl MerkleTree {
    /// 用叶子哈希建树（空输入得到空树）。
    pub fn from_leaves(leaves: &[Bytes32]) -> Self {
        let mut levels = vec![leaves.to_vec()];
        while levels.last().map(|level| level.len()).unwrap_or(0) > 1 {
            let Some(current) = levels.last() else {
                break;
            };
            levels.push(next_level(current));
        }
        MerkleTree { levels }
    }

    /// 叶子数。
    pub fn leaf_count(&self) -> usize {
        self.levels.first().map(|level| level.len()).unwrap_or(0)
    }

    /// 是否空树。
    pub fn is_empty(&self) -> bool {
        self.leaf_count() == 0
    }

    /// 树高（空树与单叶树都是 0）。
    pub fn height(&self) -> usize {
        self.levels.len().saturating_sub(1)
    }

    /// Merkle 根（空树为 `None`）。
    pub fn root(&self) -> Option<Bytes32> {
        if self.is_empty() {
            return None;
        }
        self.levels.last().and_then(|level| level.first().copied())
    }

    /// 第 `index` 片叶子的 inclusion proof。
    pub fn proof(&self, index: usize) -> Option<InclusionProof> {
        if index >= self.leaf_count() {
            return None;
        }
        let mut path = Vec::with_capacity(self.height());
        let mut cursor = index;
        for level in &self.levels[..self.levels.len().saturating_sub(1)] {
            if cursor % 2 == 1 {
                // 左侧一定有兄弟（cursor 是奇数）。
                let sibling = *level.get(cursor - 1)?;
                path.push(ProofStep {
                    sibling,
                    side: Side::Left,
                });
            } else if let Some(sibling) = level.get(cursor + 1) {
                path.push(ProofStep {
                    sibling: *sibling,
                    side: Side::Right,
                });
            }
            // 否则：末位晋升，这一层不产生步骤。
            cursor /= 2;
        }
        Some(InclusionProof { path })
    }
}

/// 单次求根（不需要证据时的快捷路径）。
pub fn merkle_root(leaves: &[Bytes32]) -> Option<Bytes32> {
    MerkleTree::from_leaves(leaves).root()
}

/// 单条叶子的 inclusion proof。
pub fn inclusion_proof(leaves: &[Bytes32], index: usize) -> Option<InclusionProof> {
    MerkleTree::from_leaves(leaves).proof(index)
}

fn next_level(level: &[Bytes32]) -> Vec<Bytes32> {
    let mut next = Vec::with_capacity(level.len().div_ceil(2));
    let mut index = 0;
    while index < level.len() {
        if index + 1 < level.len() {
            next.push(node_hash(&level[index], &level[index + 1]));
            index += 2;
        } else {
            // 末位直接晋升：不复制自己（否则 7 叶与 8 叶里的重复叶会撞根）。
            next.push(level[index]);
            index += 1;
        }
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaves(count: usize) -> Vec<Bytes32> {
        // 注意：`MerkleTree::from_leaves` 接收的是**叶子哈希**（= `leaf_hash(record_hash)`），
        // 不是记录哈希。这里直接造叶子哈希，`leaf_hash()` 只在调用方（chain/verify）用。
        (0..count)
            .map(|index| Bytes32::from_bytes([index as u8 + 1; 32]))
            .collect()
    }

    #[test]
    fn root_matches_manual_two_leaf_construction() {
        let leaves = leaves(2);
        let expected = node_hash(&leaves[0], &leaves[1]);
        assert_eq!(merkle_root(&leaves), Some(expected));
    }

    #[test]
    fn every_leaf_proof_verifies_for_many_sizes() {
        for size in [1usize, 2, 3, 5, 8, 13, 33, 64] {
            let leaves = leaves(size);
            let tree = MerkleTree::from_leaves(&leaves);
            let root = tree.root().unwrap();
            for (index, leaf) in leaves.iter().enumerate() {
                let proof = tree.proof(index).unwrap();
                assert!(
                    proof.verifies(leaf, &root),
                    "size={size} index={index} 的证据必须能推出根"
                );
            }
        }
    }

    #[test]
    fn promotion_avoids_duplicate_leaf_malleability() {
        // 7 叶（末位晋升）与"把第 8 片叶子复制一份"的 8 叶必须给出不同的根。
        let seven = leaves(7);
        let mut eight = leaves(8);
        eight[7] = eight[6];
        assert_ne!(merkle_root(&seven), merkle_root(&eight));
    }

    #[test]
    fn tampered_proof_is_rejected() {
        let leaves = leaves(8);
        let tree = MerkleTree::from_leaves(&leaves);
        let root = tree.root().unwrap();
        let mut proof = tree.proof(3).unwrap();
        proof.path[0].sibling = Bytes32::from_bytes([0xaa; 32]);
        assert!(!proof.verifies(&leaves[3], &root));
        assert!(inclusion_proof(&leaves, 99).is_none());
    }
}
