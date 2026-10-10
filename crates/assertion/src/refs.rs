//! ref 取值路径解析：`fx.*` / `case.*` / `env.*` 三类前缀的前缀语义与 fx 容器纪律。
//!
//! 真源：`spec/behaviors/engine/assert.md` 的 `assert-resolve-ref` 原子
//! （对照物 `src/runtime/refs.ts:14-55`）与 `docs/SCENARIO-SPEC.md` §2.5。
//!
//! # 关键纪律（"fx 是存在的容器"）
//!
//! `fx.*` 取的是 Fixture 取证快照：**没记过的键取到"缺失"，而不是"取值失败"**。
//! 只有**未知前缀**才算取值失败。这条语义让 `exists:false`（断言"这件事没有发生"）
//! 成为合法表达——它是本仓最常用的断言形态之一，曾经因为实现把缺失键判成取值失败
//! 而永远无法表达（由 `cases/TK-0001.yaml` 暴露，`refs.ts:43-47` 的注释记了这条）。
//!
//! # 三种结果的区分（JSON 无法天然表达 `undefined`，所以显式建模）
//!
//! TS 里 `undefined`（键不存在）与 `null` 是**两个**值；JSON 只有一个 `null`。
//! 本实现用 [`RefResolution::value`] 的 `Option` 表达：
//!
//! - `Some(Null)` = 键存在，值是 `null`；
//! - `None` = 键不存在（或路径中途落在 `null` / 非对象上）。
//!
//! [`crate::assertions`] 依赖这个区分来对齐 `exists`（`undefined` 与 `null` 都算不存在）
//! 与 `is: null`（旧实现里 `undefined` ≠ `null`，所以 `is:null` 对不存在的键是 `false`）。

use serde_json::Value;

/// 解析一个 ref 所需的三个数据源。
///
/// 对应 `src/runtime/refs.ts:21-25` 的 `RefSources`。Rust 侧不做 I/O：三个源都由
/// 调用方（阶段 2 的 protocol / executor）填好。
#[derive(Debug, Clone, Default)]
pub struct RefSources {
    /// Fixture 取证快照（`Fixture.snapshot()`）。
    ///
    /// 用 `Option<Value>` 而不是 `Map`：调用方可能只传一个 JSON 文档，
    /// JSON 的键序在默认构建下由 `serde_json` 保证有序（`BTreeMap`），
    /// 所以遍历它是**确定**的（指标 C1）。
    pub fixture: Option<Value>,
    /// 场景自身的字段（`case.*` 的读取面是整条 `Scenario` 对象，含 `setup` / `steps` 等大字段）。
    pub scenario: Option<Value>,
    /// 运行环境信息（`env.dshVersion` / `env.platform` / `env.nodeVersion`）。
    pub env: Option<Value>,
}

/// 取值结果。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RefResolution {
    /// 前缀是否已知（`fx` / `case` / `env`）。
    ///
    /// **只有未知前缀才是 `false`**：`fx` 容器里没有记过的键仍然是 `found: true`。
    pub found: bool,
    /// 取到的值；`None` 表示"缺失"（键不存在 / 路径中途断掉）。
    pub value: Option<Value>,
    /// 无法解析时说明原因（供报告使用）；成功时为 `None`。
    ///
    /// 措辞对齐 `refs.ts`：未知前缀 `未知 ref 前缀：<p>`、缺前缀 `ref 缺少前缀：<ref>`。
    pub reason: Option<String>,
}

impl RefResolution {
    /// 取到的值（缺失时为 `Value::Null`）。
    ///
    /// 断言求值只关心"值是什么"：缺失在 JSON 域的等价物是 `null`
    /// （`exists:false` 之所以能通过，是因为 `null` 也算不存在）。
    /// **要区分"缺失"与"显式 `null`"时必须用 [`Self::value`] 的 `Option`**。
    pub fn value_or_null(&self) -> Value {
        self.value.clone().unwrap_or(Value::Null)
    }

    /// 键是否**缺失**（不是"显式 `null`"）。
    pub fn is_absent(&self) -> bool {
        self.value.is_none()
    }
}

/// 解析一个 ref。
///
/// 前缀语义（`docs/SCENARIO-SPEC.md` §2.5）：
///
/// | 前缀 | 含义 | 缺失键的行为 |
/// |---|---|---|
/// | `fx.` | driver 通过 `Fixture.note()` 暴露的运行期数据 | `found:true` + 缺失（**不是**取值失败） |
/// | `case.` | case 自身的字段（自检用，少用） | `found:true` + 缺失 |
/// | `env.` | 运行环境信息 | `found:true` + 缺失 |
/// | 其它 | —— | `found:false` + `未知 ref 前缀：<p>` |
/// | 无点号 | —— | `found:false` + `ref 缺少前缀：<ref>` |
pub fn resolve_ref(reference: &str, sources: &RefSources) -> RefResolution {
    let Some(dot) = reference.find('.') else {
        return RefResolution {
            found: false,
            value: None,
            reason: Some(format!("ref 缺少前缀：{reference}")),
        };
    };
    let prefix = &reference[..dot];
    let path = &reference[dot + 1..];

    let root = match prefix {
        "fx" => sources.fixture.as_ref(),
        "case" => sources.scenario.as_ref(),
        "env" => sources.env.as_ref(),
        other => {
            return RefResolution {
                found: false,
                value: None,
                reason: Some(format!("未知 ref 前缀：{other}")),
            }
        }
    };

    RefResolution {
        found: true,
        value: root.and_then(|root| resolve_path(root, path)),
        reason: None,
    }
}

/// 解析取值路径（`a.b[0].c` 形态）。
///
/// 对齐 `assert.ts:219-241` 的 `resolvePath`：
///
/// - **空路径返回 root 本身**（`resolvePath(root, '')` === `root`）；
/// - 支持**点分段**与 **`[n]` 下标**；
/// - 中途遇到 `null` 或非对象 ⇒ `None`（旧实现返回 `undefined`）；
/// - 对象上取不存在的键 ⇒ `None`；
/// - 下标落在非数组上 ⇒ `None`；
/// - 段内的 `[n]` 可以连续（`a[0][1]`）。
///
/// **与旧实现的一致点**：段里的"名字"与"下标"是分开解析的——`a.b[0].c` 里的 `b[0]`
/// 先取 `b` 再取 `[0]`。空段（`a.`）在旧实现里会去取名为空串的键（通常得到 `undefined`），
/// 本实现直接返回 `None`，**结论等价**（都是"没取到"），只是省掉一次无意义查找。
pub fn resolve_path(root: &Value, path: &str) -> Option<Value> {
    if path.is_empty() {
        return Some(root.clone());
    }
    let mut cursor = root.clone();
    for raw_segment in path.split('.') {
        let (name, indexes) = split_segment(raw_segment)?;
        if !name.is_empty() {
            let Value::Object(map) = &cursor else {
                return None;
            };
            cursor = map.get(&name)?.clone();
        }
        for index in indexes {
            let Value::Array(items) = &cursor else {
                return None;
            };
            cursor = items.get(index)?.clone();
        }
    }
    Some(cursor)
}

/// 把一个路径段拆成"名字 + 连续下标"。
///
/// 对齐 `assert.ts:224` 的正则 `^([^[\]]*)((?:\[\d+\])*)$`：
/// **名字部分不含 `[` / `]`**；下标部分只认 `[数字]`，可连续任意个。
/// 段与正则不匹配（`a[b]` / `list[0` / `list[0]x`）时返回 `None` ⇒ 整条路径取不到。
fn split_segment(segment: &str) -> Option<(String, Vec<usize>)> {
    if segment.is_empty() {
        // 空段（`a.` / `.a` / `a..b`）：旧实现的正则**能**匹配空名（`[^[\]]*` 允许零长），
        // 于是它去取名为空串的键——普通对象上必然取不到。这里直接判"取不到"，
        // **结论等价**（都是"没取到"），只是省掉一次无意义查找。
        return None;
    }
    let bracket = match segment.find('[') {
        None => {
            // 名字部分不含 `]` 才匹配正则。
            if segment.contains(']') {
                return None;
            }
            return Some((segment.to_string(), Vec::new()));
        }
        Some(index) => index,
    };
    let name = &segment[..bracket];
    if name.contains(']') {
        return None;
    }
    let mut indexes = Vec::new();
    let mut rest = &segment[bracket..];
    while let Some(stripped) = rest.strip_prefix('[') {
        let close = stripped.find(']')?;
        let digits = &stripped[..close];
        indexes.push(digits.parse::<usize>().ok()?);
        rest = &stripped[close + 1..];
    }
    if !rest.is_empty() {
        // 下标之后还有别的字符（`a[0]x`）⇒ 旧实现的正则不匹配。
        return None;
    }
    Some((name.to_string(), indexes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sources() -> RefSources {
        RefSources {
            fixture: Some(json!({"a": {"b": [{"c": 7}]}, "list": [10, 20], "flag": null})),
            scenario: Some(json!({"title": "自检场景", "steps": [{"name": "第一步"}]})),
            env: Some(json!({
                "dshVersion": "1.0.0",
                "platform": "win32",
                "nodeVersion": "22.0.0"
            })),
        }
    }

    /// observable：`ref 以 fx. 开头` —— 命中的键取到值。
    #[test]
    fn fx_prefix_reads_fixture_snapshot() {
        let resolved = resolve_ref("fx.a.b[0].c", &sources());
        assert!(resolved.found);
        assert_eq!(resolved.value, Some(json!(7)));
        assert!(resolved.reason.is_none());
    }

    /// observable：**未记过的键取到"缺失"而不是取值失败**（fx 是存在的容器）。
    #[test]
    fn fx_missing_key_is_absent_not_unresolved() {
        let resolved = resolve_ref("fx.neverNoted", &sources());
        assert!(resolved.found, "fx 是存在的容器，缺失键不是取值失败");
        assert!(resolved.is_absent());
        assert_eq!(resolved.value_or_null(), Value::Null);
        assert!(resolved.reason.is_none());
    }

    /// observable：显式 `null` 与缺失是**两回事**（JSON 域必须显式建模）。
    #[test]
    fn explicit_null_is_present() {
        let resolved = resolve_ref("fx.flag", &sources());
        assert!(resolved.found);
        assert!(!resolved.is_absent());
        assert_eq!(resolved.value, Some(Value::Null));
    }

    /// observable：`case.` 前缀读场景自身字段。
    #[test]
    fn case_prefix_reads_scenario() {
        let resolved = resolve_ref("case.title", &sources());
        assert!(resolved.found);
        assert_eq!(resolved.value, Some(json!("自检场景")));
        let deep = resolve_ref("case.steps[0].name", &sources());
        assert_eq!(deep.value, Some(json!("第一步")));
    }

    /// observable：`env.` 前缀读运行环境。
    #[test]
    fn env_prefix_reads_environment() {
        assert_eq!(
            resolve_ref("env.dshVersion", &sources()).value,
            Some(json!("1.0.0"))
        );
        assert_eq!(
            resolve_ref("env.platform", &sources()).value,
            Some(json!("win32"))
        );
        assert_eq!(
            resolve_ref("env.nodeVersion", &sources()).value,
            Some(json!("22.0.0"))
        );
    }

    /// observable：未知前缀 `found=false` + 措辞 `未知 ref 前缀：<p>`。
    #[test]
    fn unknown_prefix_is_unresolved() {
        let resolved = resolve_ref("bogus.x", &sources());
        assert!(!resolved.found);
        assert!(resolved.is_absent());
        assert_eq!(resolved.reason.as_deref(), Some("未知 ref 前缀：bogus"));
    }

    /// observable：不含点号 `found=false` + 措辞 `ref 缺少前缀：<ref>`。
    #[test]
    fn missing_prefix_is_unresolved() {
        let resolved = resolve_ref("fx", &sources());
        assert!(!resolved.found);
        assert_eq!(resolved.reason.as_deref(), Some("ref 缺少前缀：fx"));
    }

    /// observable：路径语法边界（点路径 / 下标 / 空路径 / 中途断掉 / 下标落在非数组上）。
    #[test]
    fn resolve_path_syntax_boundaries() {
        let root = json!({"a": {"b": [{"c": 7}]}, "list": [10, 20], "nil": null});
        assert_eq!(resolve_path(&root, "a.b[0].c"), Some(json!(7)));
        assert_eq!(resolve_path(&root, "list[1]"), Some(json!(20)));
        assert_eq!(resolve_path(&root, "a.missing"), None);
        assert_eq!(resolve_path(&root, ""), Some(root.clone()));
        // 空段（`a.`）在旧实现里得到 undefined，本实现直接判缺失：结论等价。
        assert_eq!(resolve_path(&root, "a."), None);
        // 下标落在非数组上。
        assert_eq!(resolve_path(&root, "a.b.x[0]"), None);
        assert_eq!(resolve_path(&root, "list[2]"), None);
        assert_eq!(resolve_path(&root, "list[0][0]"), None);
        // 中途遇 null。
        assert_eq!(resolve_path(&root, "nil.x"), None);
        // 连续下标。
        let nested = json!([[1, 2], [3]]);
        assert_eq!(resolve_path(&nested, "[1][0]"), Some(json!(3)));
        assert_eq!(resolve_path(&nested, "[0][1]"), Some(json!(2)));
        // 非数字下标 / 闭合错误 / 尾随字符：旧实现的正则不匹配 ⇒ 取不到。
        assert_eq!(resolve_path(&root, "list[x]"), None);
        assert_eq!(resolve_path(&root, "list[0"), None);
        assert_eq!(resolve_path(&root, "list[0]x"), None);
    }

    /// 数据源整体缺失时（`fx` 前缀但调用方没给 fixture）：仍是"缺失"而不是取值失败，
    /// 因为前缀本身是已知的。
    #[test]
    fn missing_source_still_has_known_prefix() {
        let empty = RefSources::default();
        let resolved = resolve_ref("fx.anything", &empty);
        assert!(resolved.found);
        assert!(resolved.is_absent());
    }
}
