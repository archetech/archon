use std::collections::HashMap;

use serde_json::Value;

#[derive(Default)]
pub(crate) struct SearchIndex {
    docs: HashMap<String, serde_json::Map<String, Value>>,
    order: Vec<String>,
}

impl SearchIndex {
    pub(crate) fn store(&mut self, did: &str, doc: &Value) {
        let data = doc
            .get("didDocumentData")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        if !self.docs.contains_key(did) {
            self.order.push(did.to_string());
        }
        self.docs.insert(did.to_string(), data);
    }

    pub(crate) fn delete(&mut self, did: &str) {
        if self.docs.remove(did).is_some() {
            self.order.retain(|entry| entry != did);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.docs.clear();
        self.order.clear();
    }

    pub(crate) fn size(&self) -> usize {
        self.docs.len()
    }

    pub(crate) fn search_docs(&self, q: &str) -> Vec<String> {
        let mut out = Vec::new();
        for did in &self.order {
            let Some(doc) = self.docs.get(did) else {
                continue;
            };
            if serde_json::to_string(doc)
                .map(|value| value.contains(q))
                .unwrap_or(false)
            {
                out.push(did.clone());
            }
        }
        out
    }

    pub(crate) fn query_docs(&self, where_clause: &Value) -> anyhow::Result<Vec<String>> {
        let Some((raw_path, cond)) = where_clause.as_object().and_then(|map| map.iter().next()) else {
            return Ok(Vec::new());
        };
        let list = cond
            .get("$in")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("Only {{$in:[...]}} supported"))?;

        let mut result = Vec::new();
        for did in &self.order {
            let Some(doc) = self.docs.get(did) else {
                continue;
            };
            if query_match(&Value::Object(doc.clone()), raw_path, list) {
                result.push(did.clone());
            }
        }
        Ok(result)
    }
}

fn query_match(root: &Value, raw_path: &str, list: &[Value]) -> bool {
    if let Some(base_path) = raw_path.strip_suffix("[*]") {
        return json_path_get(root, base_path)
            .and_then(Value::as_array)
            .map(|arr| arr.iter().any(|value| list.contains(value)))
            .unwrap_or(false);
    }

    if let Some((prefix, suffix)) = raw_path.split_once("[*].") {
        return json_path_get(root, prefix)
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| json_path_get(item, suffix))
                    .any(|value| list.contains(value))
            })
            .unwrap_or(false);
    }

    if let Some(base_path) = raw_path.strip_suffix(".*") {
        return json_path_get(root, base_path)
            .and_then(Value::as_object)
            .map(|obj| obj.keys().any(|key| list.contains(&Value::String(key.clone()))))
            .unwrap_or(false);
    }

    if let Some((prefix, suffix)) = raw_path.split_once(".*.") {
        return json_path_get(root, prefix)
            .and_then(Value::as_object)
            .map(|obj| {
                obj.values()
                    .filter_map(|item| json_path_get(item, suffix))
                    .any(|value| list.contains(value))
            })
            .unwrap_or(false);
    }

    json_path_get(root, raw_path)
        .map(|value| list.contains(value))
        .unwrap_or(false)
}

fn json_path_get<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    if path.is_empty() {
        return Some(root);
    }

    let clean = path
        .strip_prefix("$.")
        .or_else(|| path.strip_prefix('$'))
        .unwrap_or(path);
    if clean.is_empty() {
        return Some(root);
    }

    let mut current = root;
    for raw_part in clean.split('.') {
        if let Ok(index) = raw_part.parse::<usize>() {
            current = current.as_array()?.get(index)?;
        } else {
            current = current.get(raw_part)?;
        }
    }
    Some(current)
}
