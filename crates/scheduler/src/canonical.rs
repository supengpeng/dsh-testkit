//! 规范字节编码与 64 位哈希（**零外部依赖**）。
//!
//! 用途：把判定事件序列编码成**跨运行逐字节稳定**的字节流，再哈希成指标 C1 的读数
//! （"事件序列哈希相同"）——「重放按记录的 `seq` 注入」也依赖这套编码。
//!
//! # 三条纪律（设计 §6.4）
//!
//! 1. **不用** `std::collections::hash_map::DefaultHasher`。它的跨版本稳定性是实现细节，
//!    而且在 Rust 里它总是和 `RandomState` 一起被误用（后者的种子每个进程都不同）。
//! 2. **不用** `Debug` 输出做编码。格式化不是契约：改一个字段名或派生顺序就会**静默**
//!    改变哈希，而哈希正是判据本身。
//! 3. 变长字段一律带**长度前缀**。否则 `("ab", "c")` 与 `("a", "bc")` 编码成同一串字节，
//!    两条语义不同的事件序列会得到同一个哈希 —— 判据会漏报。
//!
//! 哈希函数是 FNV-1a 64（10 行、无依赖、跨平台字节序固定）。它是**变化探测器**，
//! 不是安全边界：防篡改哈希链是 `crates/attest` 的职责（设计 §7.1，SHA-256）。
//! 用 64 位而非 SHA-256 的理由见 `lib.rs` 的"为什么哈希是 FNV-1a"。

/// FNV-1a 64 的偏移基数。
pub(crate) const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;

/// FNV-1a 64 的质数。
pub(crate) const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64。
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = FNV_OFFSET_BASIS;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// 追加一个字节（定长字段，无需长度前缀）。
pub(crate) fn put_u8(out: &mut Vec<u8>, value: u8) {
    out.push(value);
}

/// 追加一个布尔（定长：1 字节）。
pub(crate) fn put_bool(out: &mut Vec<u8>, value: bool) {
    out.push(u8::from(value));
}

/// 追加一个 `u64`（小端，定长 8 字节）。
pub(crate) fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// 追加一个 `i64`（小端，定长 8 字节）。
pub(crate) fn put_i64(out: &mut Vec<u8>, value: i64) {
    out.extend_from_slice(&value.to_le_bytes());
}

/// 追加一个**带长度前缀**的字节串（长度是 `u32` 小端）。
pub(crate) fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    let length = u32::try_from(bytes.len()).unwrap_or(u32::MAX);
    out.extend_from_slice(&length.to_le_bytes());
    out.extend_from_slice(bytes);
}

/// 追加一个**带长度前缀**的字符串（UTF-8 字节）。
pub(crate) fn put_str(out: &mut Vec<u8>, value: &str) {
    put_bytes(out, value.as_bytes());
}

/// splitmix64：把种子与任务 id 的混合值扩散成均匀的 64 位秩。
///
/// 它是**纯函数**：同样的 `(seed, task_id)` 永远给出同样的秩，
/// 与调用时刻、线程、进程都无关（这正是"同种子 ⇒ 同顺序"的前提）。
pub(crate) fn splitmix64(seed: u64) -> u64 {
    let mut state = seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
    state = (state ^ (state >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    state = (state ^ (state >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    state ^ (state >> 31)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn length_prefix_disambiguates_variable_length_fields() {
        // 纪律 3 的负向证明：没有长度前缀时这两组会撞成同一串字节。
        let mut left = Vec::new();
        put_str(&mut left, "ab");
        put_str(&mut left, "c");
        let mut right = Vec::new();
        put_str(&mut right, "a");
        put_str(&mut right, "bc");
        assert_ne!(left, right, "变长字段必须带长度前缀，否则会静默撞哈希");
    }

    #[test]
    fn hashing_is_stable_for_identical_input() {
        let mut first = Vec::new();
        put_u64(&mut first, 7);
        put_i64(&mut first, -3);
        put_bool(&mut first, true);
        put_str(&mut first, "t1");
        let mut second = first.clone();
        assert_eq!(fnv1a64(&first), fnv1a64(&second));
        // 一个字节的差别必须改变哈希（否则哈希没有判别力）。
        second.push(0);
        assert_ne!(fnv1a64(&first), fnv1a64(&second));
    }

    #[test]
    fn splitmix64_is_a_pure_function_and_spreads() {
        assert_eq!(splitmix64(1), splitmix64(1));
        assert_ne!(splitmix64(1), splitmix64(2));
        // 相邻输入的输出不应保持相邻（低位差异要被扩散到高位）。
        let a = splitmix64(1_000);
        let b = splitmix64(1_001);
        assert!(
            (a ^ b).count_ones() > 8,
            "splitmix64 的雪崩性质过弱：{a:#x} vs {b:#x}"
        );
    }
}
