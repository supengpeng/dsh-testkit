//! 枚举 `run-report.schema.json` 的**叶子路径**（A3 的分母）。
//!
//! 枚举规则只有一条（与 `reconcile-fields.yaml` 的生成器一致）：
//! 解开 `$ref`、逐 `properties` / `items` 下降，**遇到没有 properties/items 的节点即为叶子**。
//! 数组在路径里记成 `[]`（如 `cases[].verdict`、`cases[].rounds[]`）。
//!
//! 这个枚举器是 A3 闭环的一半：`tests/a3_closure.rs` 用它产出的集合
//! 与 `reconcile-fields.yaml` 的 `fields[].path` 求差，差集为空才算 A3 闭合。

use std::collections::BTreeSet;

use serde_json::Value;

/// 一个 schema 叶子。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SchemaLeaf {
    /// 叶子路径（数组用 `[]`）。
    pub path: String,
    /// 声明的 `type`（可为多类型；缺省表示"任意类型"，如 `actual`）。
    pub schema_type: Option<String>,
}

/// 递归深度上限（防御病态 schema；本 schema 深度 < 10）。
const MAX_DEPTH: usize = 64;

fn ref_name(reference: &str) -> Option<&str> {
    reference.strip_prefix("#/$defs/")
}

fn type_of(node: &Value) -> Option<String> {
    match node.get("type") {
        Some(Value::String(text)) => Some(text.clone()),
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("|"),
        ),
        _ => None,
    }
}

fn walk(node: &Value, path: &str, root: &Value, out: &mut Vec<SchemaLeaf>, depth: usize) {
    if depth > MAX_DEPTH {
        return;
    }
    if let Some(reference) = node.get("$ref").and_then(Value::as_str) {
        if let Some(name) = ref_name(reference) {
            if let Some(target) = root.get("$defs").and_then(|defs| defs.get(name)) {
                walk(target, path, root, out, depth + 1);
                return;
            }
        }
        return;
    }
    if let Some(items) = node.get("items") {
        walk(items, &format!("{path}[]"), root, out, depth + 1);
        return;
    }
    if let Some(properties) = node.get("properties").and_then(Value::as_object) {
        // BTreeMap 语义：`serde_json` 的 `Map` 缺省用 `BTreeMap`（未开 `preserve_order`），
        // 所以这里的迭代顺序天然有序、可复现。
        for (key, child) in properties {
            let child_path = if path.is_empty() {
                key.clone()
            } else {
                format!("{path}.{key}")
            };
            walk(child, &child_path, root, out, depth + 1);
        }
        return;
    }
    out.push(SchemaLeaf {
        path: path.to_string(),
        schema_type: type_of(node),
    });
}

/// 枚举全部叶子（按路径有序）。
pub fn enumerate_schema_leaves(schema: &Value) -> Vec<SchemaLeaf> {
    let mut out = Vec::new();
    walk(schema, "", schema, &mut out, 0);
    out.sort_by(|left, right| left.path.cmp(&right.path));
    out.dedup_by(|left, right| left.path == right.path);
    out
}

/// 只要路径集合。
pub fn schema_leaf_paths(schema: &Value) -> BTreeSet<String> {
    enumerate_schema_leaves(schema)
        .into_iter()
        .map(|leaf| leaf.path)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn enumerates_arrays_refs_and_open_objects() {
        let schema = json!({
            "type": "object",
            "properties": {
                "runId": { "type": "string" },
                "totals": { "$ref": "#/$defs/totals" },
                "cases": { "type": "array", "items": { "$ref": "#/$defs/caseOutcome" } },
                "openObject": { "type": "object" }
            },
            "$defs": {
                "totals": {
                    "type": "object",
                    "properties": { "total": { "type": "integer" } }
                },
                "caseOutcome": {
                    "type": "object",
                    "properties": {
                        "id": { "type": "string" },
                        "rounds": { "type": "array", "items": { "type": "boolean" } }
                    }
                }
            }
        });
        let paths = schema_leaf_paths(&schema);
        assert!(paths.contains("runId"));
        assert!(paths.contains("totals.total"));
        assert!(paths.contains("cases[].id"));
        // 数组元素本身是叶子时保留 `[]`（与 reconcile-fields.yaml 的 `cases[].rounds[]` 同形）。
        assert!(paths.contains("cases[].rounds[]"));
        // 没有 properties 的 object 是叶子（与 `cases[].notes` 同形）。
        assert!(paths.contains("openObject"));
    }

    #[test]
    fn depth_limit_does_not_hang_on_self_reference() {
        // 自引用 $ref 必须被深度上限截断，而不是把进程跑死。
        let schema = json!({
            "type": "object",
            "properties": { "self": { "$ref": "#/$defs/loop" } },
            "$defs": { "loop": { "$ref": "#/$defs/loop" } }
        });
        let paths = schema_leaf_paths(&schema);
        assert!(paths.len() <= 1, "自引用不应产出无限叶子：{paths:?}");
    }
}
