//! 泄漏扫描：I1「私钥不出进程」的自检工具。
//!
//! **纪律**：命中只报**位置与类型**，绝不输出命中的原文——否则这个扫描器自己就成了
//! 泄露渠道。这条纪律沿用既有 `scripts/check-secrets.mjs` 的思路（指标 §10 I1）。
//!
//! 扫描对象是"会离开进程的文本"：序列化后的链文件、报告、锚定文件、协议消息、
//! 以及日志行。针（needle）来自 [`crate::signing::KeyMaterial::sensitive_needles`]，
//! 只在进程内存在，不进任何产物。

use crate::hex;

/// 一根敏感针：一个标签 + 一段**绝不能被打印**的字节。
#[derive(Debug, Clone)]
pub struct SensitiveNeedle {
    /// 类型标签（例如 `ed25519-seed-hex`）——可以进报告。
    pub label: String,
    /// 不该出现在文本里的字节。
    pub bytes: Vec<u8>,
}

impl SensitiveNeedle {
    /// 构造一根针。
    pub fn new(label: &str, bytes: Vec<u8>) -> Self {
        SensitiveNeedle {
            label: label.to_string(),
            bytes,
        }
    }
}

/// 一次命中。**只记位置**。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LeakHit {
    /// 命中的针类型。
    pub label: String,
    /// 命中的产物名（例如 `chain.json`）。
    pub artifact: String,
    /// 行号（从 1 起）。
    pub line: usize,
    /// 列号（从 1 起，按字符计）。
    pub column: usize,
    /// 命中的编码形态。
    pub encoding: &'static str,
}

impl LeakHit {
    /// 单行呈现（**不含命中原文**）。
    pub fn render(&self) -> String {
        format!(
            "{}:{}:{} [{}] ({})",
            self.artifact, self.line, self.column, self.label, self.encoding
        )
    }
}

/// 在一段文本里找所有敏感针的全部出现位置。
///
/// 检查三种编码形态：原始 UTF-8（若针本身是合法 UTF-8）、小写十六进制、大写十六进制。
/// 不检查 base64——本 crate 的任何产物都不做 base64 编码，多查一种形态只会增加误报。
pub fn scan_text(artifact: &str, haystack: &str, needles: &[SensitiveNeedle]) -> Vec<LeakHit> {
    let mut hits = Vec::new();
    for needle in needles {
        let mut forms: Vec<(&'static str, String)> =
            vec![("hex-lower", hex::encode(&needle.bytes))];
        let upper = hex::encode(&needle.bytes).to_uppercase();
        // 纯数字的十六进制（例如 `616263`）大小写相同，重复计入会一次命中算两次。
        if upper != forms[0].1 {
            forms.push(("hex-upper", upper));
        }
        if let Ok(text) = std::str::from_utf8(&needle.bytes) {
            if !text.is_empty() {
                forms.push(("utf8", text.to_string()));
            }
        }
        for (encoding, form) in forms {
            // (b) 防御性（task-26 的性质判定）：`encode` 的结果永不为空，
            // 而 utf8 形态在入队前已经查过 `is_empty`。这里保留只是为了让"空形态不参与匹配"
            // 成为一条**局部**不变量，不依赖调用点的正确性。刻意不补测试（判据：改错也不会红）。
            if form.is_empty() {
                continue;
            }
            for (offset, _) in haystack.match_indices(&form) {
                let (line, column) = line_column(haystack, offset);
                hits.push(LeakHit {
                    label: needle.label.clone(),
                    artifact: artifact.to_string(),
                    line,
                    column,
                    encoding,
                });
            }
        }
    }
    hits
}

/// 扫描多份产物。
pub fn scan_artifacts(artifacts: &[(String, String)], needles: &[SensitiveNeedle]) -> Vec<LeakHit> {
    let mut hits = Vec::new();
    for (name, text) in artifacts {
        hits.extend(scan_text(name, text, needles));
    }
    hits
}

/// 把字节偏移换算成 1 起的（行, 列）。
fn line_column(text: &str, offset: usize) -> (usize, usize) {
    let prefix = &text[..offset.min(text.len())];
    let line = prefix.matches('\n').count() + 1;
    let column = match prefix.rfind('\n') {
        Some(index) => prefix[index + 1..].chars().count() + 1,
        None => prefix.chars().count() + 1,
    };
    (line, column)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hits_report_position_only() {
        let needle = SensitiveNeedle::new("test-needle", vec![0xde, 0xad, 0xbe, 0xef]);
        let haystack = "line one\nline two deadbeef here\n";
        let hits = scan_text("chain.json", haystack, &[needle]);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].artifact, "chain.json");
        assert_eq!(hits[0].line, 2);
        assert_eq!(hits[0].encoding, "hex-lower");
        // 呈现里不能出现命中原文。
        assert!(!hits[0].render().contains("deadbeef"));
    }

    #[test]
    fn scanning_is_not_vacuous() {
        // 负向证明：故意把针放进文本，必须命中——否则这条自检就是永远绿的摆设。
        let ascii = SensitiveNeedle::new("test-needle", b"abc".to_vec());
        assert_eq!(
            scan_text("f", "xxabcxx", std::slice::from_ref(&ascii)).len(),
            1
        );
        assert_eq!(
            scan_text("f", "xx616263xx", std::slice::from_ref(&ascii)).len(),
            1
        );
        // 大小写两种十六进制形态都要认（`dead` 含字母，两者才是不同字符串）。
        let binary = SensitiveNeedle::new("test-needle", vec![0xde, 0xad]);
        assert_eq!(
            scan_text("f", "xxdeadxx", std::slice::from_ref(&binary)).len(),
            1
        );
        assert_eq!(
            scan_text("f", "xxDEADxx", std::slice::from_ref(&binary)).len(),
            1
        );
        assert!(scan_text("f", "clean text", std::slice::from_ref(&ascii)).is_empty());
    }
}
