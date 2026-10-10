//! JCS —— JSON Canonicalization Scheme（RFC 8785）。
//!
//! **为什么需要**（设计 §7.2）：签名的前提是"同样的语义 ⇒ 同样的字节"，而 JSON 不保证这一点
//! （键顺序、数字格式、Unicode 转义都可变）。所以先规范化，再哈希、再签名。
//!
//! # 本实现覆盖的规则
//!
//! | 规则 | 依据 | 落地 |
//! |---|---|---|
//! | 对象键按 **UTF-16 码元**序排列 | RFC 8785 §3.2.3 | [`sort_keys`]，不用码点序（两者在增补平面与 U+E000 之后不同） |
//! | 字符串只转义强制集 | RFC 8785 §3.2.2.2 | `"` `\` 与 U+0000–U+001F；`\b \t \n \f \r` 用短转义，其余 `\u00xx`（**小写**） |
//! | 不做 Unicode 归一化 | RFC 8785 §3.2.2.2 | 组合字符原样输出；`é`（U+00E9）与 `e`+U+0301 是**不同**的规范化结果 |
//! | 数字按 ECMAScript `Number::toString` | RFC 8785 §3.2.2.3 | [`format_es_number`] |
//! | 空对象 / 空数组 | RFC 8785 §3.2.1 | `{}` / `[]`（无空白） |
//!
//! # 数字处理的诚实说明
//!
//! RFC 8785 把数字形态**直接定义为 ECMAScript 的 `Number::toString`**，即"最短可回环的十进制
//! 表示 + ECMAScript 的指数阈值"。本实现用 Rust 的 `{:e}`（最短可回环）取出有效数字串，
//! 再按 ECMAScript 的四条分支重排（整数展开 / 小数展开 / 指数形式）。它**不是**自己发明
//! 一套十进制算法，所以与 TS 侧的 `String(x)` 必须逐字节一致——`spec/vectors/jcs/*.json`
//! 与跨侧随机对拍（`tests/jcs_cross.rs` + `src/attest/jcs-cross.test.mjs`）守这条一致性。
//!
//! 注意：JSON 里的整数**一律按 IEEE 754 双精度解释**（RFC 8785 的立场）。因此
//! `9007199254740993` 规范化为 `9007199254740992`——这是规范要求，不是精度 bug。

use serde_json::Value;

use crate::error::JcsError;

/// 解析 JSON 文本。
pub fn parse(text: &str) -> Result<Value, JcsError> {
    serde_json::from_str(text).map_err(|error| JcsError::Parse(error.to_string()))
}

/// 规范化一个 JSON 值，返回规范化后的 UTF-8 字符串。
pub fn canonicalize(value: &Value) -> Result<String, JcsError> {
    let mut out = String::new();
    write_value(value, &mut out)?;
    Ok(out)
}

/// 规范化后的字节（规范化字符串的 UTF-8 编码）。
pub fn canonicalize_bytes(value: &Value) -> Result<Vec<u8>, JcsError> {
    Ok(canonicalize(value)?.into_bytes())
}

/// 规范化一份 JSON 文本。
pub fn canonicalize_str(text: &str) -> Result<String, JcsError> {
    canonicalize(&parse(text)?)
}

fn write_value(value: &Value, out: &mut String) -> Result<(), JcsError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(number) => out.push_str(&format_number(number)?),
        Value::String(text) => write_string(text, out),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            out.push('{');
            let keys = sort_keys(map.keys());
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                // `map.get(key)` 必然命中：key 来自同一张 map 的键集合。
                if let Some(item) = map.get(*key) {
                    write_value(item, out)?;
                }
            }
            out.push('}');
        }
    }
    Ok(())
}

/// 按 **UTF-16 码元**序排列键（RFC 8785 §3.2.3）。
///
/// 用码点序（Rust 默认的 `String: Ord`）会在两处出错：U+E000 与 U+10000 的相对顺序。
/// ["é", "😀"] 这类键两种序一致，只有跨 BMP 边界才分叉——所以必须按码元比。
pub fn sort_keys<'a, I: Iterator<Item = &'a String>>(keys: I) -> Vec<&'a String> {
    let mut collected: Vec<&String> = keys.collect();
    collected.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
    collected
}

fn write_string(text: &str, out: &mut String) {
    out.push('"');
    for ch in text.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{0008}' => out.push_str("\\b"),
            '\u{0009}' => out.push_str("\\t"),
            '\u{000A}' => out.push_str("\\n"),
            '\u{000C}' => out.push_str("\\f"),
            '\u{000D}' => out.push_str("\\r"),
            // 其余 C0 控制字符走 \u00xx（小写十六进制）。
            ch if (ch as u32) < 0x20 => {
                out.push_str("\\u00");
                out.push(hex_digit(((ch as u32) >> 4) as u8));
                out.push(hex_digit(((ch as u32) & 0x0f) as u8));
            }
            // 其余字符（含 U+007F DEL、U+2028/2029、增补平面）**原样**输出 UTF-8。
            ch => out.push(ch),
        }
    }
    out.push('"');
}

fn hex_digit(value: u8) -> char {
    b"0123456789abcdef"[value as usize] as char
}

fn format_number(number: &serde_json::Number) -> Result<String, JcsError> {
    match number.as_f64() {
        Some(value) => format_es_number(value),
        None => Err(JcsError::NonFiniteNumber),
    }
}

/// 按 ECMAScript `Number::toString` 的规则格式化一个 `f64`。
///
/// 规范（ECMA-262 `Number::toString`）：取最短可回环的有效数字 `s`（k 位）与十进制指数位置 `n`，
/// 使 `s × 10^(n-k) = x`，然后：
///
/// 1. `k ≤ n ≤ 21` → 数字串后补 `n-k` 个 `0`；
/// 2. `0 < n ≤ 21` → 前 `n` 位 + `.` + 余下位；
/// 3. `-6 < n ≤ 0` → `0.` + `-n` 个 `0` + 数字串；
/// 4. 否则指数形式（`k = 1` 时无小数点），指数带显式符号。
pub fn format_es_number(value: f64) -> Result<String, JcsError> {
    if !value.is_finite() {
        return Err(JcsError::NonFiniteNumber);
    }
    // +0 与 -0 都规范化成 "0"（JS 的 String(-0) === "0"）。
    if value == 0.0 {
        return Ok("0".to_string());
    }
    let negative = value < 0.0;
    let magnitude = value.abs();
    // Rust 的 LowerExp 用最短可回环表示（grisu），形如 "1.2345e3" / "1e-7"。
    let exponential = format!("{magnitude:e}");
    let (mantissa, exponent) = exponential
        .split_once('e')
        .ok_or(JcsError::Internal("浮点格式化缺少指数分隔符"))?;
    let mut digits: String = mantissa.chars().filter(|ch| *ch != '.').collect();
    let exponent: i32 = exponent
        .parse()
        .map_err(|_| JcsError::Internal("浮点指数无法解析"))?;
    // 最短表示本不该有尾随 0；留着这一步是为了让"数字串 = 有效数字"这条不变量成立。
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    if digits.is_empty() {
        return Err(JcsError::Internal("浮点有效数字为空"));
    }
    let k = digits.len() as i32;
    let n = exponent + 1;

    let mut out = String::new();
    if k <= n && n <= 21 {
        out.push_str(&digits);
        for _ in 0..(n - k) {
            out.push('0');
        }
    } else if n > 0 && n <= 21 {
        out.push_str(&digits[..n as usize]);
        out.push('.');
        out.push_str(&digits[n as usize..]);
    } else if n > -6 && n <= 0 {
        out.push_str("0.");
        for _ in 0..(-n) {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        out.push_str(&digits[..1]);
        if k > 1 {
            out.push('.');
            out.push_str(&digits[1..]);
        }
        out.push('e');
        let exponent_digits = (n - 1).abs();
        out.push(if n >= 1 { '+' } else { '-' });
        out.push_str(&exponent_digits.to_string());
    }
    if negative {
        out.insert(0, '-');
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn canon(text: &str) -> String {
        canonicalize_str(text).unwrap()
    }

    #[test]
    fn key_order_is_utf16_sorted() {
        assert_eq!(canon(r#"{"b":1,"a":2}"#), r#"{"a":2,"b":1}"#);
        // U+10000（UTF-16 代理对 D800 DC00）排在 U+E000 之前——码点序会给出相反结果。
        // 输入里 U+E000 的值是 1、U+10000 的值是 2，所以输出顺序是"U+10000 在前、值 2"。
        assert_eq!(
            canon(r#"{"\ue000":1,"\ud800\udc00":2}"#),
            "{\"\u{10000}\":2,\"\u{e000}\":1}"
        );
    }

    #[test]
    fn numbers_follow_ecmascript_to_string() {
        assert_eq!(canon("1.0"), "1");
        assert_eq!(canon("1e2"), "100");
        assert_eq!(canon("-0"), "0");
        assert_eq!(canon("1e21"), "1e+21");
        assert_eq!(canon("1e-7"), "1e-7");
        assert_eq!(canon("1e-6"), "0.000001");
        assert_eq!(canon("123.456"), "123.456");
        assert_eq!(canon("9007199254740993"), "9007199254740992");
    }

    #[test]
    fn strings_escape_only_the_mandatory_set() {
        assert_eq!(canon("\"\u{00e9}\""), "\"\u{00e9}\"");
        assert_eq!(canon(r#""\u00e9""#), "\"\u{00e9}\"");
        assert_eq!(canon(r#""\u0000""#), r#""\u0000""#);
        // DEL 不转义（RFC 8785 只强制 C0 与引号/反斜杠）。
        assert_eq!(canon(r#""\u007f""#), "\"\u{007f}\"");
        // 不做 Unicode 归一化：预组合的 é 与 e+组合尖音符是两个不同的规范化结果。
        assert_eq!(canon(r#""\u00e9""#), "\"\u{00e9}\"");
        assert_eq!(canon(r#""\u0065\u0301""#), "\"e\u{0301}\"");
        assert_ne!(canon(r#""\u00e9""#), canon(r#""\u0065\u0301""#));
    }

    #[test]
    fn empty_structures_have_no_whitespace() {
        assert_eq!(canon("{}"), "{}");
        assert_eq!(canon("[]"), "[]");
        assert_eq!(canon(r#"{"a":{},"b":[]}"#), r#"{"a":{},"b":[]}"#);
    }

    #[test]
    fn non_finite_is_rejected() {
        assert_eq!(format_es_number(f64::NAN), Err(JcsError::NonFiniteNumber));
        assert_eq!(
            format_es_number(f64::INFINITY),
            Err(JcsError::NonFiniteNumber)
        );
    }
}
