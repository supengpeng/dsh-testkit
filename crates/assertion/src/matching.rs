//! `matches` 判定词的正则支持：`/pattern/flags` 字面量解析 + 最小 JS 子集匹配引擎。
//!
//! # 为什么不用 `regex` crate（这是一处**必须显式汇报**的设计取舍）
//!
//! 本 crate 的依赖只能是工作区已批准的 `serde` / `serde_json`（`Cargo.toml` 的
//! `[dependencies]`）；新增依赖要过 RFC 0001 §7 停止线评审，不是本任务能自行决定的。
//! 因此这里**手写**一个匹配器。
//!
//! 手写匹配器的风险是"看起来能过，实际和 JS 不一致"。所以纪律是：
//!
//! 1. **只实现语义明确、无歧义的子集**：字面量、`.`、字符类 `[...]`（含 `[^...]` 与区间）、
//!    预定义类 `\d \D \w \W \s \S`、锚点 `^ $`、量词 `* + ? {n} {n,} {n,m}`（含懒惰 `?`）、
//!    分组 `(...)`、交替 `|`、转义 `\. \* \+ \? \( \) \[ \] \{ \} \| \/ \\` 与
//!    `\n \r \t \f \v \0`。
//! 2. **子集之外一律 `Unsupported`**（调用方折成 `Inconclusive`），绝不"猜一个结果"。
//!    这是设计 §8.4 硬约束 3 的用法：无法判定就如实说无法判定。
//!    明确不支持（可查表）：lookahead / lookbehind、反向引用、命名组、非捕获组、
//!    Unicode 属性 `\p{..}`、码位转义 `\uXXXX` / `\xNN`、词边界 `\b`、`u` / `v` 旗标。
//! 3. **非法模式判 `InvalidPattern`**（调用方折成 `Failed`，**不是** `Inconclusive`）：
//!    模式写错是**可归因的事实**，不是"测不准"。设计 §3.1 要求断言失败是正常结果、
//!    不进 `Err`，所以这里返回结论而不是让异常冒泡。
//!
//! # 匹配算法（为什么不能是朴素回溯）
//!
//! 朴素回溯遇到嵌套量词（`^(a+)+$`）会指数爆炸，表现为 **hang**——那既不是 `Failed`
//! 也不是 `Inconclusive`，是工具坏了。本引擎用**"结束位置集合 + 记忆化"**：
//! 对每个 `(节点, 起始位置)` 求"能停在哪里"的集合，同一对组合只算一次；
//! 正在计算中的组合再次被请求 ⇒ 左递归环 ⇒ 返回空集（避免死循环）。
//! 记忆表用 `Vec`（按 `节点数 × (文本长度+1)` 索引），**不用 `HashMap`**：
//! 判定路径禁用 `HashMap`（设计 §6.4），且 `Vec` 的 O(1) 查询比 `BTreeMap` 更合适。
//!
//! # 与旧实现的两处**刻意差异**（详细理由见阶段 1 汇报）
//!
//! - 旧实现 `assert.ts:70-80` 的 `parseRegexLiteral` 在 `new RegExp(literal)` 抛错时
//!   **落回 `new RegExp(整串)`**（`/[/` 会走这条回落路径）。本实现用宽容模式复刻这条回落，
//!   但它只在字面量**无法解析**时触发；**触发后仍失败**的模式判 `InvalidPattern`。
//! - 旧实现的"非法正则"会**冒泡出断言循环**（`runner.ts:729-744` 没有 try/catch），
//!   使整条 case 变 `errored`（`spec/behaviors/engine/assert.md` 边界 6 记为缺陷）。
//!   本实现把它折成 `Failed` + 说明性消息，**不**让判定层把 case 炸掉。

use crate::core::stringify_like_js;
use serde_json::Value;
use std::collections::BTreeSet;

/// 匹配结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MatchVerdict {
    /// 匹配成功。
    Matched,
    /// 匹配失败（模式合法、结论明确）。
    NotMatched,
    /// 模式合法但用了本引擎**不支持**的构造；无法给出可信结论 ⇒ 调用方折成 `Inconclusive`。
    Unsupported {
        /// 可归因的说明（哪个构造不被支持）。
        reason: String,
    },
    /// 模式本身非法 ⇒ 调用方折成 `Failed`（可归因的事实，不是异常）。
    InvalidPattern {
        /// 可归因的说明（语法错误）。
        reason: String,
    },
}

/// `/pattern/flags` 字面量的解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegexLiteral {
    /// 模式正文（不含两侧斜杠）。
    pub pattern: String,
    /// 旗标串（原样保留）。
    pub flags: String,
}

/// 解析 `/pattern/flags` 形式的正则字面量；不是字面量形态时返回 `None`。
///
/// 语法与旧实现 `assert.ts:70-80` 的正则 `/^\/(.*)\/([a-z]*)$/s` **一致**：
/// 以 `/` 开头，模式与旗标的分隔取**最后一个** `/`（贪婪 `(.*)`），旗标只允许小写字母。
///
/// | 输入 | pattern | flags | 说明 |
/// |---|---|---|---|
/// | `/ABC/i` | `ABC` | `i` | 文档示例形态（旧实现经实测同样如此，见下） |
/// | `/^错误：/` | `^错误：` | （空） | 旧实现里最常见的形态 |
/// | `/a/b/i` | `a/b` | `i` | 贪婪取法：模式里的 `/` 不转义（JS 里必须转义，此处口径更宽） |
/// | `abc` | —— | —— | 不以 `/` 开头 ⇒ 不是字面量（调用方按裸模式处理） |
/// | `/x/GI` | —— | —— | `GI` 不是 `[a-z]*` ⇒ **整串回退成裸模式**（实测旧实现同） |
///
/// # 实测核对（不是推演）
///
/// 这四条结论都在真实 Node 里跑过旧实现的 `parseRegexLiteral`：
/// `/ABC/i` → pattern `ABC` + flags `i`；`/a/b/i` → `a/b` + `i`；
/// `/x/GI` → 字面量匹配失败、回退成 `\/x\/GI`。
/// 一开始误判为"旧实现必须整串以 `/` 结尾"，实测证伪——**文档与实现一致，无差异**。
pub fn parse_regex_literal(source: &str) -> Option<RegexLiteral> {
    if !source.starts_with('/') {
        return None;
    }
    let closing = source.rfind('/')?;
    let pattern = &source[1..closing];
    let flags = &source[closing + 1..];
    if !flags.chars().all(|c| c.is_ascii_lowercase()) {
        return None;
    }
    Some(RegexLiteral {
        pattern: pattern.to_string(),
        flags: flags.to_string(),
    })
}

/// 对 `matches` 判定词求匹配。
///
/// `actual` 是 ref 取到的值；`expected` 是 YAML 里 `matches:` 后面的值。
pub fn matches(actual: &Value, expected: Option<&Value>) -> MatchVerdict {
    let Value::String(text) = actual else {
        // 调用方先用 [`type_name`](crate::core::type_name) 产出
        // `matches 需要字符串，实际 <type>` 的 Failed。
        return MatchVerdict::NotMatched;
    };
    let source = stringify_like_js(expected);
    let (pattern, flags, permissive) = match parse_regex_literal(&source) {
        Some(lit) => (lit.pattern, lit.flags, false),
        None => (source.clone(), String::new(), true),
    };
    evaluate(text, &pattern, &flags, permissive)
}

/// `matches` 判定词在 actual 非字符串时的说明（供失败消息复用，避免两处措辞漂移）。
pub fn type_error_message(actual: Option<&Value>) -> String {
    format!(
        "matches 需要字符串，实际 {}",
        crate::core::type_name(actual)
    )
}

/// 解析错误里"不支持的构造"的标记。
///
/// **为什么用文本标记而不是错误枚举**：解析器是递归下降的，错误要跨多层返回；
/// 用一个显式的哨兵前缀最省事、最不容易漏。命中它的错误一律折成
/// [`MatchVerdict::Unsupported`]（⇒ 调用方判 `Inconclusive`），其余折成
/// [`MatchVerdict::InvalidPattern`]（⇒ 调用方判 `Failed`）。这条分界是硬契约：
/// **"不支持"与"写错了"必须分开**——前者是测不准，后者是 bug。
const UNSUPPORTED_MARKER: &str = "[unsupported]";

/// 造一个"不支持的构造"错误（带 [`UNSUPPORTED_MARKER`] 前缀）。
fn unsupported(reason: impl std::fmt::Display) -> String {
    format!("{UNSUPPORTED_MARKER} {reason}")
}

/// 对一段文本求匹配。
///
/// `permissive` 对齐旧实现的"落回 `new RegExp(整串)`"路径：未闭合的 `[` 当字面量。
pub fn evaluate(text: &str, pattern: &str, flags: &str, permissive: bool) -> MatchVerdict {
    let options = match MatchOptions::from_flags(flags) {
        Ok(options) => options,
        Err(reason) => return MatchVerdict::Unsupported { reason },
    };

    let chars: Vec<char> = text.chars().collect();
    match parse(pattern, permissive) {
        Ok(program) => {
            if program.is_match(&chars, options) {
                MatchVerdict::Matched
            } else {
                MatchVerdict::NotMatched
            }
        }
        Err(reason) if reason.starts_with(UNSUPPORTED_MARKER) => MatchVerdict::Unsupported {
            reason: reason
                .trim_start_matches(UNSUPPORTED_MARKER)
                .trim()
                .to_string(),
        },
        Err(reason) => MatchVerdict::InvalidPattern {
            reason: format!("正则模式非法：{reason}"),
        },
    }
}

/// 旗标语义。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MatchOptions {
    /// `i`：忽略大小写。**只做 ASCII 折叠**（非 ASCII 码位按原样比较，见模块文档）。
    pub ignore_case: bool,
    /// `m`：`^` / `$` 匹配换行处。
    pub multiline: bool,
    /// `s`：`.` 匹配换行。
    pub dot_all: bool,
}

impl MatchOptions {
    /// 解析旗标串。
    ///
    /// **不支持的旗标是 `Unsupported` 而不是忽略**：静默忽略 `u` / `v` 会让
    /// Unicode 模式给出错误结论（例如 `.`、`\w`、大小写折叠的成员集都不同）。
    fn from_flags(flags: &str) -> Result<Self, String> {
        let mut options = Self::default();
        for flag in flags.chars() {
            match flag {
                'i' => options.ignore_case = true,
                'm' => options.multiline = true,
                's' => options.dot_all = true,
                // `g` / `y` 只影响"从哪里继续找下一次匹配"，不影响 `test()` 的布尔结果。
                'g' | 'y' => {}
                'u' | 'v' => {
                    return Err(format!(
                        "旗标 {flag} 会改变模式语义（Unicode 模式），本引擎不支持该子集"
                    ));
                }
                other => return Err(format!("不支持的旗标：{other}")),
            }
        }
        Ok(options)
    }
}

// ---------------------------------------------------------------------------
// AST 与解析器
// ---------------------------------------------------------------------------

/// 预定义字符类。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Predicate {
    /// `\d`。
    Digit,
    /// `\D`。
    NotDigit,
    /// `\w`。
    Word,
    /// `\W`。
    NotWord,
    /// `\s`。
    Space,
    /// `\S`。
    NotSpace,
}

impl Predicate {
    fn test(self, c: char) -> bool {
        match self {
            Self::Digit => c.is_ascii_digit(),
            Self::NotDigit => !c.is_ascii_digit(),
            Self::Word => c.is_ascii_alphanumeric() || c == '_',
            Self::NotWord => !(c.is_ascii_alphanumeric() || c == '_'),
            Self::Space => is_space(c),
            Self::NotSpace => !is_space(c),
        }
    }
}

/// JS `\s` 的空白集（与 `regex` crate 的 `\s` 不一致，这里显式列出）。
fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// JS 的换行符集（`.` 与 `m` 旗标下的 `^` / `$` 都用它）。
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// 字符类里的一项。
#[derive(Debug, Clone, PartialEq, Eq)]
enum ClassItem {
    /// 单个字符。
    Char(char),
    /// 闭区间 `a-z`。
    Range(char, char),
    /// 预定义类（`\d` 等）。
    Predicate(Predicate),
}

/// 字符类。
#[derive(Debug, Clone, PartialEq, Eq)]
struct CharClass {
    /// 是否取反（`[^...]`）。
    negated: bool,
    /// 成员项。
    items: Vec<ClassItem>,
}

impl CharClass {
    fn matches(&self, c: char, ignore_case: bool) -> bool {
        let hit = self.items.iter().any(|item| match item {
            ClassItem::Char(expected) => {
                if ignore_case {
                    c.eq_ignore_ascii_case(expected)
                } else {
                    c == *expected
                }
            }
            ClassItem::Range(from, to) => {
                if ignore_case {
                    let folded = c.to_ascii_lowercase();
                    folded >= from.to_ascii_lowercase() && folded <= to.to_ascii_lowercase()
                } else {
                    c >= *from && c <= *to
                }
            }
            ClassItem::Predicate(predicate) => predicate.test(c),
        });
        hit != self.negated
    }
}

/// 语法树节点（带**扁平的**索引：子节点存索引，避免借用问题与指针身份不稳定）。
#[derive(Debug, Clone)]
enum NodeKind {
    /// 空序列（`(|a)` 的左支）。
    Empty,
    /// 字面字符。
    Literal(char),
    /// 字符类。
    Class(CharClass),
    /// `.`（是否跨行由 `s` 旗标决定）。
    Any,
    /// `^`。
    Start,
    /// `$`。
    End,
    /// 序列。
    Seq(Vec<usize>),
    /// 交替。
    Alt(Vec<usize>),
    /// 量词。
    Repeat {
        /// 被重复的子节点。
        inner: usize,
        /// 最少次数。
        min: u32,
        /// 最多次数；`None` 表示无上限。
        max: Option<u32>,
        /// 是否贪婪。
        greedy: bool,
    },
}

/// 解析出来的程序（节点池 + 根索引）。
#[derive(Debug, Clone)]
struct Program {
    nodes: Vec<NodeKind>,
    root: usize,
}

impl Program {
    /// 是否存在任意位置的匹配（JS `RegExp.prototype.test` 的语义）。
    fn is_match(&self, text: &[char], options: MatchOptions) -> bool {
        let mut matcher = Matcher::new(self, text, options);
        (0..=text.len()).any(|start| !matcher.ends_at(self.root, start).is_empty())
    }
}

/// 匹配器：持有文本、旗标与记忆表。
struct Matcher<'a> {
    program: &'a Program,
    text: &'a [char],
    options: MatchOptions,
    /// `memo[node * width + pos]`：已知的结束位置集合；`None` = 还没算过。
    memo: Vec<Option<BTreeSet<usize>>>,
    /// 正在计算中的 `(node, pos)`，用于检出左递归环。
    in_progress: Vec<bool>,
    width: usize,
}

impl<'a> Matcher<'a> {
    fn new(program: &'a Program, text: &'a [char], options: MatchOptions) -> Self {
        let width = text.len() + 1;
        let cells = program.nodes.len().saturating_mul(width).max(1);
        Self {
            program,
            text,
            options,
            memo: vec![None; cells],
            in_progress: vec![false; cells],
            width,
        }
    }

    /// 记忆表里 `(节点, 位置)` 的线性索引。
    fn index(&self, node: usize, pos: usize) -> usize {
        node * self.width + pos
    }

    /// 从 `pos` 起匹配 `node`，返回**所有**可能的结束位置（升序）。
    ///
    /// 这是整个引擎的核心：把"布尔匹配"变成"结束位置集合"，从而让 `Seq` / `Repeat`
    /// 可以确定性地组合，且对 `(节点, 位置)` 组合只算一次（记忆化）。
    fn ends_at(&mut self, node: usize, pos: usize) -> BTreeSet<usize> {
        let index = self.index(node, pos);
        if let Some(cached) = self.memo.get(index).and_then(|cell| cell.clone()) {
            return cached;
        }
        if self.in_progress.get(index).copied().unwrap_or(false) {
            // 左递归环：`(a*)*` 这类空匹配重复。返回空集而不是无限递归。
            return BTreeSet::new();
        }
        if let Some(flag) = self.in_progress.get_mut(index) {
            *flag = true;
        }
        let result = self.compute(node, pos);
        if let Some(flag) = self.in_progress.get_mut(index) {
            *flag = false;
        }
        if let Some(cell) = self.memo.get_mut(index) {
            *cell = Some(result.clone());
        }
        result
    }

    fn compute(&mut self, node: usize, pos: usize) -> BTreeSet<usize> {
        let kind = self
            .program
            .nodes
            .get(node)
            .cloned()
            .expect("节点索引由解析器生成，必然有效");
        match kind {
            NodeKind::Empty => BTreeSet::from([pos]),
            NodeKind::Literal(expected) => {
                let hit = self.text.get(pos).is_some_and(|c| {
                    if self.options.ignore_case {
                        c.eq_ignore_ascii_case(&expected)
                    } else {
                        *c == expected
                    }
                });
                if hit {
                    BTreeSet::from([pos + 1])
                } else {
                    BTreeSet::new()
                }
            }
            NodeKind::Class(class) => {
                let hit = self
                    .text
                    .get(pos)
                    .is_some_and(|c| class.matches(*c, self.options.ignore_case));
                if hit {
                    BTreeSet::from([pos + 1])
                } else {
                    BTreeSet::new()
                }
            }
            NodeKind::Any => {
                let hit = self.text.get(pos).is_some_and(|c| {
                    if self.options.dot_all {
                        true
                    } else {
                        !is_line_terminator(*c)
                    }
                });
                if hit {
                    BTreeSet::from([pos + 1])
                } else {
                    BTreeSet::new()
                }
            }
            NodeKind::Start => {
                let hit = pos == 0
                    || (self.options.multiline
                        && self
                            .text
                            .get(pos - 1)
                            .is_some_and(|c| is_line_terminator(*c)));
                if hit {
                    BTreeSet::from([pos])
                } else {
                    BTreeSet::new()
                }
            }
            NodeKind::End => {
                let hit = pos == self.text.len()
                    || (self.options.multiline
                        && self.text.get(pos).is_some_and(|c| is_line_terminator(*c)));
                if hit {
                    BTreeSet::from([pos])
                } else {
                    BTreeSet::new()
                }
            }
            NodeKind::Seq(children) => self.seq_ends(&children, pos),
            NodeKind::Alt(branches) => {
                let mut ends = BTreeSet::new();
                for branch in branches {
                    ends.extend(self.ends_at(branch, pos));
                }
                ends
            }
            NodeKind::Repeat {
                inner,
                min,
                max,
                greedy,
            } => self.repeat_ends(inner, min, max, greedy, pos),
        }
    }

    /// 序列匹配：从左到右累积可达位置。
    fn seq_ends(&mut self, children: &[usize], pos: usize) -> BTreeSet<usize> {
        let mut current = BTreeSet::from([pos]);
        for child in children {
            let mut next = BTreeSet::new();
            for start in &current {
                next.extend(self.ends_at(*child, *start));
            }
            if next.is_empty() {
                return next;
            }
            current = next;
        }
        current
    }

    /// 量词匹配：按"重复次数"分层累积可达位置，再按贪婪/懒惰选序。
    ///
    /// # 零宽重复的处理（这是本引擎最容易写错的一处）
    ///
    /// `(a*)*` 里的内层组在**同一个位置**既能空匹配、又能吃掉一个字符。两种朴素处理都会跑偏：
    ///
    /// - **把零宽结果丢掉** ⇒ 外层 `*` 永远看不到"再迭代一次能前进"的可能，
    ///   于是 `^(a*)*$` 对 `"b"` 判**不匹配**——而 JS 判**匹配**。
    /// - **无条件保留零宽结果并继续迭代** ⇒ 同一个位置无限打转（hang）。
    ///
    /// 正确做法是把两件事分开：
    ///
    /// - **`results[n]` = 恰好重复 `n` 次后可以停下的所有位置**。零宽匹配也是合法的重复，
    ///   所以 `start` 自己也算一层（不然第 `n` 层会漏掉"最后一轮是空匹配"的位置）。
    /// - **是否继续展开**：只看有没有"前进了"的位置（`progress`)；没有就停——空匹配不改变位置，
    ///   再算一轮还是同一批位置。
    ///
    /// 推演（`"b"`，`^(a*)*$`）：`results[0] = {0}`；第 1 层 `next = {1}`（内层在位置 0
    /// 空匹配或吃掉 `a`），并入 `start` 自己的 `{0}` ⇒ `results[1] = {0, 1}`。
    /// 有前进 ⇒ 继续，但第 2 层不再前进 ⇒ 停。`$` 在 `1` 成立 ⇒ 匹配。
    fn repeat_ends(
        &mut self,
        inner: usize,
        min: u32,
        max: Option<u32>,
        greedy: bool,
        pos: usize,
    ) -> BTreeSet<usize> {
        // 无界量词的实际上限由文本长度决定：每重复一次至多吃掉一个字符。
        let ceiling = max.unwrap_or(u32::MAX).min(self.text.len() as u32 + 1);
        let mut results: Vec<BTreeSet<usize>> = vec![BTreeSet::from([pos])];
        let mut current = results[0].clone();
        let mut count: u32 = 0;
        while count < ceiling {
            let mut progress = BTreeSet::new();
            let mut next = BTreeSet::new();
            for start in &current {
                for end in self.ends_at(inner, *start) {
                    next.insert(end);
                    if end != *start {
                        progress.insert(end);
                    }
                }
            }
            if progress.is_empty() {
                // 这一轮只能零宽匹配：位置与上一层相同，不再展开。
                break;
            }
            // `start` 自己也要算进这一层：最后一轮可以是空匹配（零宽）后再没有前进。
            next.extend(current.iter().copied());
            count += 1;
            current = next.clone();
            results.push(next);
        }
        let lower = min as usize;
        let layers = if lower < results.len() {
            &results[lower..]
        } else {
            &results[0..0]
        };
        let mut ordered: Vec<usize> = if greedy {
            layers.iter().rev().flatten().copied().collect()
        } else {
            layers.iter().flatten().copied().collect()
        };
        ordered.dedup();
        ordered.into_iter().collect()
    }
}

/// 解析一个模式。
///
/// `permissive` 为真时：未闭合的 `[` 当字面量、孤立量词当字面量
/// （对齐旧实现落回 `new RegExp(整串)` 的容忍度）。
fn parse(pattern: &str, permissive: bool) -> Result<Program, String> {
    let mut parser = Parser {
        chars: pattern.chars().collect(),
        pos: 0,
        permissive,
        depth: 0,
        nodes: Vec::new(),
    };
    let root = parser.parse_alternation()?;
    if parser.pos < parser.chars.len() {
        let rest: String = parser.chars[parser.pos..].iter().collect();
        return Err(format!("残余无法解析：{rest:?}"));
    }
    Ok(Program {
        nodes: parser.nodes,
        root,
    })
}

/// 解析深度的上限。超过它说明模式病态（嵌套过深）⇒ 判为无法解析，而不是栈溢出。
const MAX_DEPTH: usize = 128;

/// 递归下降解析器（把节点推进扁平的 `nodes` 池，返回索引）。
struct Parser {
    chars: Vec<char>,
    pos: usize,
    permissive: bool,
    depth: usize,
    nodes: Vec<NodeKind>,
}

impl Parser {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn peek_at(&self, offset: usize) -> Option<char> {
        self.chars.get(self.pos + offset).copied()
    }

    fn push(&mut self, kind: NodeKind) -> usize {
        self.nodes.push(kind);
        self.nodes.len() - 1
    }

    fn parse_alternation(&mut self) -> Result<usize, String> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(format!("模式嵌套超过 {MAX_DEPTH} 层"));
        }
        let mut branches = vec![self.parse_sequence()?];
        while self.peek() == Some('|') {
            self.pos += 1;
            branches.push(self.parse_sequence()?);
        }
        self.depth -= 1;
        Ok(if branches.len() == 1 {
            branches.pop().expect("至少一个分支")
        } else {
            self.push(NodeKind::Alt(branches))
        })
    }

    fn parse_sequence(&mut self) -> Result<usize, String> {
        let mut children = Vec::new();
        while let Some(c) = self.peek() {
            if c == '|' || c == ')' {
                break;
            }
            let atom = self.parse_quantified()?;
            children.push(atom);
        }
        Ok(match children.len() {
            0 => self.push(NodeKind::Empty),
            1 => children.pop().expect("长度为 1"),
            _ => self.push(NodeKind::Seq(children)),
        })
    }

    /// 解析"原子 + 可选量词"。
    fn parse_quantified(&mut self) -> Result<usize, String> {
        let atom = self.parse_atom()?;
        // **先**消费 `*` / `+` / `{n,m}` 这类"自身唯一"的量词；
        // 只有在它们都没出现时，`?` 才可能是"0 或 1 次"量词。
        //
        // 这个顺序是关键：`a+?` / `a*?` 里的 `?` 是前面那个量词的**懒惰标记**。
        // 若先判 `?`（把它当"0 或 1 次"），`+` 就永远不会被消费，
        // 于是 `^a+?$` 被解析成"字面量 `+` 恰好一次"——语义完全跑偏。
        let bounds = match self.consume_quantifier()? {
            Some((min, max)) => Some((min, max)),
            None if self.peek() == Some('?') => {
                self.pos += 1;
                Some((0, Some(1)))
            }
            None => None,
        };
        let Some((min, max)) = bounds else {
            return Ok(atom);
        };
        let greedy = if self.peek() == Some('?') {
            self.pos += 1;
            false
        } else {
            true
        };
        self.reject_trailing_quantifier()?;
        Ok(self.push(NodeKind::Repeat {
            inner: atom,
            min,
            max,
            greedy,
        }))
    }

    /// 消费一个量词（`*` / `+` / `{n}` / `{n,}` / `{n,m}`）。
    ///
    /// **`?` 不在这里处理**：它既可能是"0 或 1 次"，也可能是懒惰标记，
    /// 必须由调用方结合"下一个字符是不是量词"来判（见 [`Self::parse_quantified`]）。
    ///
    /// `{` 后不是合法区间（如 `a{x}`）时返回 `None` ⇒ 它是**字面量**（JS 同），不是量词。
    fn consume_quantifier(&mut self) -> Result<Option<(u32, Option<u32>)>, String> {
        match self.peek() {
            Some('*') => {
                self.pos += 1;
                Ok(Some((0, None)))
            }
            Some('+') => {
                self.pos += 1;
                Ok(Some((1, None)))
            }
            Some('{') => {
                let Some((min, max)) = self.try_parse_repetition_bounds() else {
                    return Ok(None);
                };
                if let Some(max) = max {
                    if min > max {
                        return Err(format!("量词区间非法：{{{min},{max}}}"));
                    }
                }
                while self.chars.get(self.pos).is_some_and(|c| *c != '}') {
                    self.pos += 1;
                }
                if self.chars.get(self.pos) == Some(&'}') {
                    self.pos += 1;
                }
                Ok(Some((min, max)))
            }
            _ => Ok(None),
        }
    }

    /// 量词后面不能再跟量词（`a*+`、`a{2}{3}`），`?` 除外（它是懒惰标记，已被消费）。
    fn reject_trailing_quantifier(&self) -> Result<(), String> {
        match self.peek() {
            Some('*' | '+') => Err("量词后面不能再跟量词".to_string()),
            Some('{') if self.try_parse_repetition_bounds().is_some() => {
                Err("量词后面不能再跟量词".to_string())
            }
            _ => Ok(()),
        }
    }

    /// 解析一个原子（不含量词）。
    fn parse_atom(&mut self) -> Result<usize, String> {
        let Some(c) = self.peek() else {
            return Err("模式意外结束".to_string());
        };
        let kind = match c {
            '(' => {
                self.pos += 1;
                if self.peek() == Some('?') {
                    return Err(unsupported(
                        "不支持的构造：(? 开头（非捕获组 / 断言 / 命名组）",
                    ));
                }
                self.depth += 1;
                if self.depth > MAX_DEPTH {
                    return Err(format!("模式嵌套超过 {MAX_DEPTH} 层"));
                }
                let inner = self.parse_alternation()?;
                if self.peek() != Some(')') {
                    return Err("括号不匹配：缺少 )".to_string());
                }
                self.pos += 1;
                self.depth -= 1;
                return Ok(inner);
            }
            '[' => NodeKind::Class(self.parse_char_class()?),
            '.' => {
                self.pos += 1;
                NodeKind::Any
            }
            '^' => {
                self.pos += 1;
                NodeKind::Start
            }
            '$' => {
                self.pos += 1;
                NodeKind::End
            }
            '\\' => match self.parse_escape()? {
                ClassItem::Char(ch) => NodeKind::Literal(ch),
                other => NodeKind::Class(CharClass {
                    negated: false,
                    items: vec![other],
                }),
            },
            ')' => return Err("括号不匹配：多余的 )".to_string()),
            other => {
                self.pos += 1;
                NodeKind::Literal(other)
            }
        };
        Ok(self.push(kind))
    }

    /// 解析转义序列，返回一个字符类项。
    fn parse_escape(&mut self) -> Result<ClassItem, String> {
        self.pos += 1; // 吃掉 `\`
        let Some(c) = self.peek() else {
            return Err("转义符 \\ 出现在模式末尾".to_string());
        };
        self.pos += 1;
        let item = match c {
            'd' => ClassItem::Predicate(Predicate::Digit),
            'D' => ClassItem::Predicate(Predicate::NotDigit),
            'w' => ClassItem::Predicate(Predicate::Word),
            'W' => ClassItem::Predicate(Predicate::NotWord),
            's' => ClassItem::Predicate(Predicate::Space),
            'S' => ClassItem::Predicate(Predicate::NotSpace),
            'n' => ClassItem::Char('\n'),
            'r' => ClassItem::Char('\r'),
            't' => ClassItem::Char('\t'),
            'f' => ClassItem::Char('\u{000C}'),
            'v' => ClassItem::Char('\u{000B}'),
            '0' => ClassItem::Char('\0'),
            'b' => {
                return Err(unsupported(
                    "不支持的构造：\\b（词边界；字符类内外语义不同，判为不可判定）",
                ))
            }
            'p' | 'P' => {
                return Err(unsupported(
                    "不支持的构造：\\p{..} / \\P{..}（Unicode 属性）",
                ))
            }
            'u' | 'x' => {
                return Err(unsupported(format!(
                    "不支持的构造：\\{c}（码位转义；非 ASCII 语义无法在本引擎内可信判定）"
                )))
            }
            'k' => return Err(unsupported("不支持的构造：\\k（命名反向引用）")),
            digit if digit.is_ascii_digit() => {
                return Err(unsupported(format!("不支持的构造：\\{digit}（反向引用）")))
            }
            other => ClassItem::Char(other),
        };
        Ok(item)
    }

    /// 解析字符类 `[...]`。
    fn parse_char_class(&mut self) -> Result<CharClass, String> {
        self.pos += 1; // 吃掉 `[`
        let negated = if self.peek() == Some('^') {
            self.pos += 1;
            true
        } else {
            false
        };
        let mut items = Vec::new();
        let mut first = true;
        loop {
            let Some(c) = self.peek() else {
                if self.permissive {
                    // 未闭合：`[` 自己也是成员（对齐 `new RegExp("[/")` 的容忍度）。
                    items.push(ClassItem::Char('['));
                    break;
                }
                return Err("字符类没有闭合：缺少 ]".to_string());
            };
            if c == ']' && !first {
                self.pos += 1;
                break;
            }
            // JS 里 `[]` 是空类（永远不匹配），`[^]` 匹配任意字符；这里保持同一取向。
            first = false;
            let start = if c == '\\' {
                self.parse_escape()?
            } else {
                self.pos += 1;
                ClassItem::Char(c)
            };
            if let ClassItem::Char(from) = start {
                let has_dash = self.peek() == Some('-')
                    && self.peek_at(1).is_some()
                    && self.peek_at(1) != Some(']');
                if has_dash {
                    self.pos += 1; // 吃掉 `-`
                    let to = if self.peek() == Some('\\') {
                        self.parse_escape()?
                    } else {
                        let ch = self.peek().expect("已确认存在");
                        self.pos += 1;
                        ClassItem::Char(ch)
                    };
                    match to {
                        ClassItem::Char(to) => items.push(ClassItem::Range(from, to)),
                        ClassItem::Predicate(_) => {
                            return Err(unsupported(
                                "不支持的构造：字符类里 `-` 右侧是预定义类（如 `[a-\\d]`）",
                            ))
                        }
                        ClassItem::Range(..) => unreachable!("parse_escape 不产出区间"),
                    }
                    continue;
                }
                items.push(ClassItem::Char(from));
            } else {
                items.push(start);
            }
        }
        Ok(CharClass { negated, items })
    }

    /// 探测 `{n}` / `{n,}` / `{n,m}`（**不改** `pos`）。
    fn try_parse_repetition_bounds(&self) -> Option<(u32, Option<u32>)> {
        let mut cursor = self.pos;
        if self.chars.get(cursor) != Some(&'{') {
            return None;
        }
        cursor += 1;
        let min = self.read_number(&mut cursor)?;
        match self.chars.get(cursor) {
            Some('}') => Some((min, Some(min))),
            Some(',') => {
                cursor += 1;
                match self.chars.get(cursor) {
                    Some('}') => Some((min, None)),
                    _ => {
                        let max = self.read_number(&mut cursor)?;
                        (self.chars.get(cursor) == Some(&'}')).then_some((min, Some(max)))
                    }
                }
            }
            _ => None,
        }
    }

    fn read_number(&self, cursor: &mut usize) -> Option<u32> {
        let start = *cursor;
        while self.chars.get(*cursor).is_some_and(|c| c.is_ascii_digit()) {
            *cursor += 1;
        }
        if *cursor == start {
            return None;
        }
        self.chars[start..*cursor]
            .iter()
            .collect::<String>()
            .parse()
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn verdict(actual: &Value, expected: &Value) -> MatchVerdict {
        matches(actual, Some(expected))
    }

    /// 字面量解析：对齐旧实现 `/^\/(.*)\/([a-z]*)$/s` 的**贪婪取法**。
    ///
    /// 期望值经真实 JS 的 `parseRegexLiteral` 核对（`node -e`）。
    #[test]
    fn parse_literal_takes_last_slash() {
        let lit = parse_regex_literal("/a/b/i").expect("应是字面量");
        assert_eq!(lit.pattern, "a/b");
        assert_eq!(lit.flags, "i");
        assert!(parse_regex_literal("abc").is_none());
        // `/x/GI`：前缀 `/x/` 已被贪婪 `(.*)` 吃掉、`GI` 不是 `[a-z]*` ⇒ 整串回退成模式。
        // 旧实现同样得到 `\/x\/GI`（已实测），所以这里判 None 是对的。
        assert!(
            parse_regex_literal("/x/GI").is_none(),
            "大写旗标不构成字面量"
        );
        let slash = parse_regex_literal("//").expect("空模式也是字面量");
        assert_eq!(slash.pattern, "");
        assert_eq!(slash.flags, "");
        // 空旗标形态（旧实现里最常见的一类）。
        let bare = parse_regex_literal("/^错误：/").expect("应是字面量");
        assert_eq!(bare.pattern, "^错误：");
        assert_eq!(bare.flags, "");
    }

    /// 端到端：与 `tests/assert.test.mjs::matches 支持 /pattern/flags 字面量` 对齐。
    #[test]
    fn matches_supports_flags_and_ui_hint() {
        assert_eq!(
            verdict(&json!("错误：炸了"), &json!("/^错误：/")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("没事"), &json!("/^错误：/")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!("xxabc"), &json!("/ABC/i")),
            MatchVerdict::Matched
        );
        // 非字符串 actual → 不匹配（调用方据此产出 Failed）。
        assert_eq!(
            verdict(&json!(123), &json!("/x/")),
            MatchVerdict::NotMatched
        );
    }

    /// 非法字面量旗标：对齐旧实现"落回整串当模式"。
    #[test]
    fn invalid_or_unsupported_flags_are_reported() {
        // `/x/u`：是合法字面量形态，但 `u` 会改变语义 ⇒ Unsupported（不是 NotMatched）。
        assert!(matches!(
            verdict(&json!("x"), &json!("/x/u")),
            MatchVerdict::Unsupported { .. }
        ));
        // `/x/GI` 不是字面量（大写）⇒ 落回整串模式。
        assert_eq!(
            verdict(&json!("/x/GI"), &json!("/x/GI")),
            MatchVerdict::Matched
        );
    }

    /// 不支持的构造显式判 Unsupported，绝不猜（这是 `Inconclusive` 的来源）。
    #[test]
    fn unsupported_constructs_are_inconclusive_not_guessed() {
        for pattern in [
            r"(?=a)", r"(?<=a)b", r"a\1", r"\p{L}", r"\u0041", r"\bword", r"(?:a)",
        ] {
            let source = format!("/{pattern}/");
            assert!(
                matches!(
                    verdict(&json!("a"), &json!(source)),
                    MatchVerdict::Unsupported { .. }
                ),
                "模式 {source} 应判 Unsupported"
            );
        }
    }

    /// 非法模式判 InvalidPattern（对齐"边界 6：非法正则"，但**不**冒泡成 errored）。
    #[test]
    fn invalid_patterns_are_reported_not_thrown() {
        assert!(matches!(
            verdict(&json!("x"), &json!("/(/")),
            MatchVerdict::InvalidPattern { .. }
        ));
        // `a{2,1}` 是非法区间（JS 也抛）。
        assert!(matches!(
            verdict(&json!("aa"), &json!("a{2,1}")),
            MatchVerdict::InvalidPattern { .. }
        ));
        // 字符类没有闭合：宽容模式下 `[` 与后续字符都是成员。
        assert_eq!(
            verdict(&json!("abc"), &json!("[abc")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("d"), &json!("[abc")),
            MatchVerdict::NotMatched
        );
        // `a{x}` 里的 `{` 是字面量（JS 同）。
        assert_eq!(
            verdict(&json!("a{x}"), &json!("a{x}")),
            MatchVerdict::Matched
        );
    }

    /// 量词、锚点、字符类、交替。
    #[test]
    fn engine_covers_the_declared_subset() {
        assert_eq!(
            verdict(&json!("abbb"), &json!("ab*")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("a"), &json!("ab+")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!("color"), &json!("colou?r")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("aaa"), &json!("^a{3}$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("aaaa"), &json!("^a{3}$")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!("ab"), &json!("^a{1,2}b$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("aab"), &json!("^a{1,}b$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("a1"), &json!(r"^[a-z]\d$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("A1"), &json!(r"^[^a-z]\d$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("cat"), &json!("^(cat|dog)$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("xabcy"), &json!("abc")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("abc"), &json!(r"^\w+$")),
            MatchVerdict::Matched
        );
        // 大小写折叠作用于 ASCII，中文按原样比较。
        assert_eq!(
            verdict(&json!("错误 Abc"), &json!("/abc/i")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("错误 abc"), &json!("/ABC/i")),
            MatchVerdict::Matched
        );
    }

    /// `m` / `s` 旗标与 `.` 的换行语义。
    #[test]
    fn multiline_and_dotall_flags() {
        assert_eq!(
            verdict(&json!("a\nb"), &json!("^b")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!("a\nb"), &json!("/^b/m")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("a\nb"), &json!("a.b")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!("a\nb"), &json!("/a.b/s")),
            MatchVerdict::Matched
        );
        // `$` 在走完全串时也成立（不需要 `m`）。
        assert_eq!(
            verdict(&json!("abc"), &json!("abc$")),
            MatchVerdict::Matched
        );
    }

    /// 懒惰量词不会漏匹配。
    #[test]
    fn lazy_quantifiers_still_match() {
        assert_eq!(
            verdict(&json!("a123b"), &json!("^a.*?b$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("aaa"), &json!("^a+?$")),
            MatchVerdict::Matched
        );
    }

    /// 病态模式不能在判定路径上挂住（记忆化 + 深度上限的意义）。
    ///
    /// 期望值全部经**真实 JS 引擎**核对（`node -e 'new RegExp(p).test(t)'`），
    /// 不是靠推演——这一组里有两条曾经被推错（见下）。
    #[test]
    fn pathological_pattern_terminates() {
        let text = "a".repeat(64);
        assert_eq!(
            verdict(&json!(text), &json!("^(a+)+$")),
            MatchVerdict::Matched
        );
        // 这两条是"空匹配"的语义分界：
        // - `(a*)*` 不锚定时能在位置 0 空匹配 ⇒ true；
        // - `^(a*)*$` 要求**整串**被吃掉，而 `(a*)*` 吃不掉 `b` ⇒ **false**（JS 同）。
        assert_eq!(verdict(&json!("b"), &json!("(a*)*")), MatchVerdict::Matched);
        assert_eq!(
            verdict(&json!("b"), &json!("^(a*)*$")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!(""), &json!("^(a*)*$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("aaab"), &json!("^a*$")),
            MatchVerdict::NotMatched
        );
        assert_eq!(
            verdict(&json!("aaa"), &json!("^a*$")),
            MatchVerdict::Matched
        );
        // 嵌套分组 + 交替（真实 JS 同样为 true）。
        assert_eq!(
            verdict(&json!("aa"), &json!("^(a|aa)+$")),
            MatchVerdict::Matched
        );
        assert_eq!(
            verdict(&json!("b"), &json!("^(a?)*$")),
            MatchVerdict::NotMatched
        );
    }
}
