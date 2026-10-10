//! NDJSON 帧读写（设计 §4.1：`stdio` + 换行分隔 JSON）。
//!
//! 为什么用 NDJSON 而不是长度前缀：LSP / MCP 生态一致，且**人能直接读日志**——
//! 出现协议问题时，一帧一行比二进制长度头好查得多。
//!
//! 用同步 IO：TS 侧是客户端（一次一个请求），Rust 侧的并发性由调度器在
//! **任务之间**表达（设计 §6.3：用例间多进程并行），不在单条帧的读写上。

use crate::message::ProtocolMessage;
use std::io::{BufRead, Write};

/// 帧读写错误。
#[derive(Debug)]
pub enum FrameError {
    /// 底层 IO 失败。
    Io(std::io::Error),
    /// 该行不是合法 JSON。
    NotJson {
        /// 行号（从 1 起）。
        line: usize,
        /// 底层错误说明。
        detail: String,
    },
    /// 是合法 JSON 但不是本协议的消息（未知 tag / 缺 `type`）。
    NotProtocol {
        /// 行号。
        line: usize,
        /// 底层错误说明。
        detail: String,
    },
    /// 单帧超过上限（防止无界内存增长）。
    TooLarge {
        /// 行号。
        line: usize,
        /// 实际字节数。
        bytes: usize,
    },
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(e) => write!(f, "IO 错误：{e}"),
            Self::NotJson { line, detail } => write!(f, "第 {line} 行不是合法 JSON：{detail}"),
            Self::NotProtocol { line, detail } => {
                write!(f, "第 {line} 行不是本协议消息：{detail}")
            }
            Self::TooLarge { line, bytes } => {
                write!(f, "第 {line} 行 {bytes} 字节，超过单帧上限")
            }
        }
    }
}

impl std::error::Error for FrameError {}

impl From<std::io::Error> for FrameError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// 单帧字节上限（16 MiB）。
///
/// 有界的理由：一个畸形（或恶意）的客户端可以用一帧把服务端内存吃光。
/// 16 MiB 远大于任何真实 plan（含数千节点的 plan 也只有几百 KB）。
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// 读一帧。返回 `Ok(None)` 表示对端正常关闭（EOF）。
///
/// 空行**跳过**（不是错误）：它是帧之间的自然噪声，把它当错误会让
/// "最后一行没有换行"这类正常情况变成故障。
pub fn read_frame<R: BufRead>(
    reader: &mut R,
) -> Result<Option<(usize, ProtocolMessage)>, FrameError> {
    let mut line = String::new();
    let mut line_no = 0usize;
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(None);
        }
        line_no += 1;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.len() > MAX_FRAME_BYTES {
            return Err(FrameError::TooLarge {
                line: line_no,
                bytes: trimmed.len(),
            });
        }
        let value: serde_json::Value =
            serde_json::from_str(trimmed).map_err(|e| FrameError::NotJson {
                line: line_no,
                detail: e.to_string(),
            })?;
        let msg: ProtocolMessage =
            serde_json::from_value(value).map_err(|e| FrameError::NotProtocol {
                line: line_no,
                detail: e.to_string(),
            })?;
        return Ok(Some((line_no, msg)));
    }
}

/// 写一帧（单行 JSON + `\n`），并 flush。
///
/// **必须 flush**：stdin/stdout 的管道缓冲会让客户端等到超时，
/// 而"等超时"会被误诊成"执行慢"。
pub fn write_frame<W: Write>(writer: &mut W, msg: &ProtocolMessage) -> Result<(), FrameError> {
    let json = serde_json::to_string(msg).map_err(|e| FrameError::NotJson {
        line: 0,
        detail: e.to_string(),
    })?;
    writer.write_all(json.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message::{ProtocolHandshake, Version};
    use std::io::{BufReader, Cursor};

    fn handshake() -> ProtocolMessage {
        ProtocolMessage::Handshake(ProtocolHandshake {
            client_version: Version::new(1, 0, 0),
            extensions: vec![],
        })
    }

    #[test]
    fn round_trip_single_frame() {
        let mut buf = Vec::new();
        write_frame(&mut buf, &handshake()).expect("write");
        assert!(buf.ends_with(b"\n"), "帧必须以换行结束");
        let text = String::from_utf8(buf.clone()).unwrap();
        assert_eq!(text.lines().count(), 1, "一帧必须恰好一行");

        let mut r = BufReader::new(Cursor::new(buf));
        let (line, msg) = read_frame(&mut r).expect("read").expect("有帧");
        assert_eq!(line, 1);
        assert_eq!(msg, handshake());
        // 再读应得 EOF
        assert!(read_frame(&mut r).expect("read").is_none());
    }

    #[test]
    fn blank_lines_are_skipped_not_errors() {
        let mut r = BufReader::new(Cursor::new(b"\n\n  \n".to_vec()));
        assert!(read_frame(&mut r).expect("空行不该报错").is_none());
    }

    #[test]
    fn invalid_json_reports_line_number() {
        let mut r = BufReader::new(Cursor::new(b"\nnot-json\n".to_vec()));
        match read_frame(&mut r) {
            Err(FrameError::NotJson { line, .. }) => assert_eq!(line, 2),
            other => panic!("期望 NotJson，实际 {other:?}"),
        }
    }

    #[test]
    fn valid_json_with_unknown_tag_is_not_protocol() {
        // 区分"不是 JSON"与"是 JSON 但不是我们的消息"：
        // 前者是传输故障，后者是协议版本问题——两者的诊断路径完全不同。
        let mut r = BufReader::new(Cursor::new(b"{\"type\":\"nope\"}\n".to_vec()));
        match read_frame(&mut r) {
            Err(FrameError::NotProtocol { line, .. }) => assert_eq!(line, 1),
            other => panic!("期望 NotProtocol，实际 {other:?}"),
        }
    }

    #[test]
    fn oversized_frame_is_rejected_before_parsing() {
        let big = format!(
            "{{\"type\":\"trace\",\"pad\":\"{}\"}}\n",
            "x".repeat(MAX_FRAME_BYTES + 10)
        );
        let mut r = BufReader::new(Cursor::new(big.into_bytes()));
        match read_frame(&mut r) {
            Err(FrameError::TooLarge { .. }) => {}
            other => panic!("期望 TooLarge，实际 {other:?}"),
        }
    }
}
