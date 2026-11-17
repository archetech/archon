use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use serde_json::Value;

// A document's place in insertion order, and its DID. Sets of these keep a
// query's results in the order a scan of every document would give.
type Entry = (u64, Arc<str>);

// For one query path: each value found at that path, and the documents that
// have it there.
type PathIndex = HashMap<String, BTreeSet<Entry>>;

// How many paths are kept indexed. Anyone can query any path, and each index
// costs memory for every document with a value there, so the least recently
// queried is dropped past this.
const MAX_PATHS: usize = 8;

#[derive(Default)]
pub(crate) struct SearchIndex {
    // didDocumentData by DID, with the DID's place in insertion order.
    docs: HashMap<Arc<str>, (u64, Value)>,
    order: Vec<Arc<str>>,
    next: u64,
    // Built the first time a path is queried and kept current after that, least
    // recently queried first.
    paths: Vec<(String, PathIndex)>,
}

impl SearchIndex {
    pub(crate) fn store(&mut self, did: &str, doc: &Value) {
        let data = Value::Object(
            doc.get("didDocumentData")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        );
        let (seq, key) = match self.docs.get_key_value(did) {
            Some((key, (seq, _))) => (*seq, key.clone()),
            None => {
                let key: Arc<str> = Arc::from(did);
                self.order.push(key.clone());
                self.next += 1;
                (self.next, key)
            }
        };
        let previous = self.docs.get(did).map(|(_, value)| value);
        for (path, index) in &mut self.paths {
            if let Some(previous) = previous {
                forget(index, previous, path, &(seq, key.clone()));
            }
            for value in query_keys(&data, path) {
                index.entry(value).or_default().insert((seq, key.clone()));
            }
        }
        self.docs.insert(key, (seq, data));
    }

    pub(crate) fn delete(&mut self, did: &str) {
        if let Some((key, (seq, data))) = self.docs.remove_entry(did) {
            for (path, index) in &mut self.paths {
                forget(index, &data, path, &(seq, key.clone()));
            }
            self.order.retain(|entry| entry.as_ref() != did);
        }
    }

    pub(crate) fn clear(&mut self) {
        self.docs.clear();
        self.order.clear();
        self.paths.clear();
    }

    pub(crate) fn size(&self) -> usize {
        self.docs.len()
    }

    pub(crate) fn search_docs(&self, q: &str) -> Vec<String> {
        let mut out = Vec::new();
        for did in &self.order {
            let Some((_, doc)) = self.docs.get(did) else {
                continue;
            };
            if serde_json::to_string(doc)
                .map(|value| value.contains(q))
                .unwrap_or(false)
            {
                out.push(did.to_string());
            }
        }
        out
    }

    pub(crate) fn query_docs(&mut self, where_clause: &Value) -> anyhow::Result<Vec<String>> {
        let Some((raw_path, cond)) = where_clause.as_object().and_then(|map| map.iter().next()) else {
            return Ok(Vec::new());
        };
        let list = cond
            .get("$in")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow::anyhow!("Only {{$in:[...]}} supported"))?;

        let index = self.path_index(raw_path);
        let mut found = BTreeSet::new();
        for value in list {
            if let Some(entries) = index.get(&value_key(value)) {
                found.extend(entries.iter().cloned());
            }
        }
        Ok(found.into_iter().map(|(_, did)| did.to_string()).collect())
    }

    // The index for this path, built from every document if the path has not
    // been queried lately. Only that first query reads every document.
    fn path_index(&mut self, raw_path: &str) -> &PathIndex {
        match self.paths.iter().position(|(path, _)| path == raw_path) {
            Some(position) => {
                let recent = self.paths.remove(position);
                self.paths.push(recent);
            }
            None => {
                let mut index = PathIndex::new();
                for (did, (seq, data)) in &self.docs {
                    for value in query_keys(data, raw_path) {
                        index.entry(value).or_default().insert((*seq, did.clone()));
                    }
                }
                if self.paths.len() >= MAX_PATHS {
                    self.paths.remove(0);
                }
                self.paths.push((raw_path.to_string(), index));
            }
        }
        &self.paths.last().expect("a path index was just placed").1
    }
}

fn forget(index: &mut PathIndex, data: &Value, path: &str, entry: &Entry) {
    for value in query_keys(data, path) {
        if let Some(entries) = index.get_mut(&value) {
            entries.remove(entry);
            if entries.is_empty() {
                index.remove(&value);
            }
        }
    }
}

// Two values are equal exactly when they serialize alike: object keys are kept
// sorted, and an integer and a float never compare equal.
fn value_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

// The values a document offers at a query path. The document matches a query
// when any of them is in the query's list.
fn query_keys(root: &Value, raw_path: &str) -> Vec<String> {
    if let Some(base_path) = raw_path.strip_suffix("[*]") {
        return json_path_get(root, base_path)
            .and_then(Value::as_array)
            .map(|arr| arr.iter().map(value_key).collect())
            .unwrap_or_default();
    }

    if let Some((prefix, suffix)) = raw_path.split_once("[*].") {
        return json_path_get(root, prefix)
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| json_path_get(item, suffix))
                    .map(value_key)
                    .collect()
            })
            .unwrap_or_default();
    }

    if let Some(base_path) = raw_path.strip_suffix(".*") {
        return json_path_get(root, base_path)
            .and_then(Value::as_object)
            .map(|obj| {
                obj.keys()
                    .map(|key| value_key(&Value::String(key.clone())))
                    .collect()
            })
            .unwrap_or_default();
    }

    if let Some((prefix, suffix)) = raw_path.split_once(".*.") {
        return json_path_get(root, prefix)
            .and_then(Value::as_object)
            .map(|obj| {
                obj.values()
                    .filter_map(|item| json_path_get(item, suffix))
                    .map(value_key)
                    .collect()
            })
            .unwrap_or_default();
    }

    json_path_get(root, raw_path)
        .map(|value| vec![value_key(value)])
        .unwrap_or_default()
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // What a query returned before there were indexes: every document, in
    // insertion order, tested against the condition.
    fn scan(index: &SearchIndex, raw_path: &str, list: &[Value]) -> Vec<String> {
        index
            .order
            .iter()
            .filter(|did| {
                let (_, data) = &index.docs[*did];
                query_keys(data, raw_path)
                    .iter()
                    .any(|key| list.iter().any(|value| &value_key(value) == key))
            })
            .map(|did| did.to_string())
            .collect()
    }

    fn doc(data: Value) -> Value {
        json!({ "didDocumentData": data })
    }

    fn query(index: &mut SearchIndex, raw_path: &str, list: &[Value]) -> Vec<String> {
        index.query_docs(&json!({ raw_path: { "$in": list } })).unwrap()
    }

    fn populated() -> SearchIndex {
        let mut index = SearchIndex::default();
        index.store("did:a", &doc(json!({ "post": { "author": "alice", "tags": ["x", "y"], "n": 1 } })));
        index.store("did:b", &doc(json!({ "post": { "author": "bob", "tags": ["y"], "n": 1.0 } })));
        index.store("did:c", &doc(json!({ "post": { "author": "alice", "tags": [], "n": 2 } })));
        index.store("did:d", &doc(json!({ "group": { "members": [{ "did": "alice" }, { "did": "carol" }] } })));
        index.store("did:e", &doc(json!({ "names": { "alice": { "role": "owner" }, "bob": { "role": "reader" } } })));
        index.store("did:f", &json!({}));
        index
    }

    const CASES: &[(&str, &[&str])] = &[
        ("post.author", &["\"alice\""]),
        ("post.author", &["\"alice\"", "\"bob\"", "\"nobody\""]),
        ("$.post.author", &["\"bob\""]),
        ("post.tags[*]", &["\"y\""]),
        ("group.members[*].did", &["\"carol\"", "\"alice\""]),
        ("names.*", &["\"bob\""]),
        ("names.*.role", &["\"owner\""]),
        ("post.n", &["1"]),
        ("post.n", &["1.0"]),
        ("post", &["{\"author\":\"bob\",\"n\":1.0,\"tags\":[\"y\"]}"]),
        ("post.missing", &["null"]),
        ("post.author", &[]),
    ];

    fn values(raw: &[&str]) -> Vec<Value> {
        raw.iter().map(|value| serde_json::from_str(value).unwrap()).collect()
    }

    #[test]
    fn indexed_queries_return_what_a_scan_returns() {
        let mut index = populated();
        for (path, raw) in CASES {
            let list = values(raw);
            let expected = scan(&index, path, &list);
            // The first query builds the path's index and the second reads it.
            assert_eq!(query(&mut index, path, &list), expected, "{path} {raw:?}");
            assert_eq!(query(&mut index, path, &list), expected, "{path} {raw:?} again");
        }
        assert_eq!(query(&mut index, "post.author", &values(&["\"alice\""])), ["did:a", "did:c"]);
        assert_eq!(query(&mut index, "post.n", &values(&["1"])), ["did:a"]);
        assert_eq!(query(&mut index, "post.n", &values(&["1.0"])), ["did:b"]);
    }

    #[test]
    fn an_index_follows_updates_and_deletions() {
        let mut index = populated();
        let alice = values(&["\"alice\""]);
        assert_eq!(query(&mut index, "post.author", &alice), ["did:a", "did:c"]);

        // An update moves a document between values and keeps its place.
        index.store("did:a", &doc(json!({ "post": { "author": "bob" } })));
        index.store("did:b", &doc(json!({ "post": { "author": "alice" } })));
        assert_eq!(query(&mut index, "post.author", &alice), ["did:b", "did:c"]);
        assert_eq!(query(&mut index, "post.author", &values(&["\"bob\""])), ["did:a"]);

        index.delete("did:c");
        assert_eq!(query(&mut index, "post.author", &alice), ["did:b"]);

        // A document stored again after deletion goes to the end, as in a scan.
        index.store("did:c", &doc(json!({ "post": { "author": "alice" } })));
        index.store("did:g", &doc(json!({ "post": { "author": "alice" } })));
        assert_eq!(query(&mut index, "post.author", &alice), ["did:b", "did:c", "did:g"]);
        assert_eq!(query(&mut index, "post.author", &alice), scan(&index, "post.author", &alice));

        index.clear();
        assert!(query(&mut index, "post.author", &alice).is_empty());
        assert_eq!(index.size(), 0);
    }

    #[test]
    fn only_the_most_recently_queried_paths_stay_indexed() {
        let mut index = populated();
        let alice = values(&["\"alice\""]);
        for n in 0..MAX_PATHS + 3 {
            query(&mut index, &format!("unused.path{n}"), &alice);
            // Queried between each, so it is never the least recent.
            assert_eq!(query(&mut index, "post.author", &alice), ["did:a", "did:c"]);
        }
        assert_eq!(index.paths.len(), MAX_PATHS);
        assert!(index.paths.iter().any(|(path, _)| path == "post.author"));
        assert!(!index.paths.iter().any(|(path, _)| path == "unused.path0"));

        // A path that was dropped is built again, and still answers correctly.
        index.store("did:h", &doc(json!({ "post": { "tags": ["y"] } })));
        for n in 0..MAX_PATHS {
            query(&mut index, &format!("other.path{n}"), &alice);
        }
        assert!(!index.paths.iter().any(|(path, _)| path == "post.author"));
        assert_eq!(query(&mut index, "post.author", &alice), ["did:a", "did:c"]);
        assert_eq!(query(&mut index, "post.tags[*]", &values(&["\"y\""])), ["did:a", "did:b", "did:h"]);
    }

    #[test]
    fn rejects_a_condition_that_is_not_a_list() {
        let mut index = populated();
        assert!(index.query_docs(&json!({ "post.author": "alice" })).is_err());
        assert!(index.query_docs(&json!({})).unwrap().is_empty());
    }
}
