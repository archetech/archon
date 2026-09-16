//! Durable candidate evidence and import-time revalidation of dependent histories.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use serde_json::{json, Value};
use tokio::sync::Mutex;

use crate::events::import_event_once;
use crate::store::{compare_ordinals, DbBackend, JsonDbFile};
use crate::{
    generate_json_cid, update_search_doc, AppState, EventRecord, GatekeeperDb, JsonDb, SearchIndex,
};

pub(crate) fn candidate_key(event: &EventRecord) -> String {
    json!([event.opid, event.registry, event.time, event.ordinal]).to_string()
}

fn index_candidates(
    dependents: &mut HashMap<String, HashSet<String>>,
    did: &str,
    events: &[EventRecord],
) {
    for event in events {
        for controller in [
            event.operation.get("controller"),
            event.operation.pointer("/doc/didDocument/controller"),
        ]
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str())
        {
            dependents
                .entry(controller.to_string())
                .or_default()
                .insert(did.to_string());
        }
    }
}

pub(crate) async fn retain_candidates(
    state: &AppState,
    did: &str,
    incoming: Option<EventRecord>,
) -> Result<()> {
    let mut cache = state.candidate_history.lock().await;
    let mut dependents = state.dependents.lock().await;
    let mut store = state.store.lock().await;
    if cache.is_none() {
        let mut candidates = store.get_candidates()?;
        for current in store.list_dids(&state.config.did_prefix, None) {
            if !candidates.contains_key(&current) {
                let mut events = store.get_events(&current);
                for event in &mut events {
                    event.opid = Some(generate_json_cid(&event.operation)?);
                }
                store.set_candidates(&current, events.clone())?;
                candidates.insert(current, events);
            }
        }
        for (key, events) in &mut candidates {
            for event in events.iter_mut() {
                event.opid = Some(generate_json_cid(&event.operation)?);
            }
            store.set_candidates(key, events.clone())?;
            index_candidates(&mut dependents, key, events);
        }
        *cache = Some(candidates);
    }
    let candidates = cache.as_mut().expect("candidate cache initialized");
    let mut events = candidates.get(did).cloned().unwrap_or_default();
    events.extend(store.get_events(did));
    events.extend(incoming);
    let mut positions = HashMap::new();
    let mut retained = Vec::new();
    for mut event in events {
        event.opid = Some(generate_json_cid(&event.operation)?);
        let key = candidate_key(&event);
        if let Some(index) = positions.get(&key) {
            retained[*index] = event;
        } else {
            positions.insert(key, retained.len());
            retained.push(event);
        }
    }
    let events = retained;
    store.set_candidates(did, events.clone())?;
    index_candidates(&mut dependents, did, &events);
    candidates.insert(did.to_string(), events);
    Ok(())
}

// Call with history_lock held. Remove the whole set before replaying dependents.
pub(crate) async fn remove_histories(state: &AppState, dids: &[String]) -> Result<()> {
    let Some(first) = dids.first() else {
        return Ok(());
    };
    retain_candidates(state, first, None).await?;
    let result = async {
        for did in dids {
            state.store.lock().await.set_candidates(did, Vec::new())?;
            state
                .candidate_history
                .lock()
                .await
                .as_mut()
                .unwrap()
                .insert(did.clone(), Vec::new());
            state.store.lock().await.delete_events(did)?;
            state.verified_dids.lock().await.remove(did);
            crate::delete_search_doc(state, did).await;
        }
        for did in dids {
            reconcile_history(state, did, false).await?;
        }
        Ok(())
    }
    .await;
    *state.status_snapshot.lock().await = None;
    if result.is_err() {
        *state.history_ready.lock().await = false;
    }
    result
}

pub(crate) async fn ensure_history_ready(state: &AppState) -> Result<()> {
    let _guard = state.history_lock.lock().await;
    if *state.history_ready.lock().await {
        return Ok(());
    }
    let mut dids: Vec<_> = {
        let store = state.store.lock().await;
        let mut dids: HashSet<_> = store.get_candidates()?.into_keys().collect();
        dids.extend(store.list_dids(&state.config.did_prefix, None));
        dids.into_iter().collect()
    };
    dids.sort();
    for did in dids {
        reconcile_history(state, &did, true).await?;
    }
    *state.history_ready.lock().await = true;
    Ok(())
}

pub(crate) async fn reconcile_history(
    state: &AppState,
    did: &str,
    rebuild_self: bool,
) -> Result<()> {
    let result = reconcile_history_once(state, did, rebuild_self).await;
    if result.is_err() {
        *state.history_ready.lock().await = false;
    }
    result
}

async fn reconcile_history_once(state: &AppState, did: &str, rebuild_self: bool) -> Result<()> {
    retain_candidates(state, did, None).await?;
    let mut affected = HashSet::from([did.to_string()]);
    {
        let dependents = state.dependents.lock().await;
        let mut pending = vec![did.to_string()];
        while let Some(controller) = pending.pop() {
            for dependent in dependents.get(&controller).into_iter().flatten() {
                if affected.insert(dependent.clone()) {
                    pending.push(dependent.clone());
                }
            }
        }
    }
    if !rebuild_self {
        affected.remove(did);
    }
    if affected.is_empty() {
        return Ok(());
    }
    let mut targets: Vec<_> = affected.into_iter().collect();
    targets.sort();
    let candidates: HashMap<_, _> = {
        let cache = state.candidate_history.lock().await;
        let cache = cache.as_ref().expect("candidate cache initialized");
        targets
            .iter()
            .map(|target| {
                (
                    target.clone(),
                    cache.get(target).cloned().unwrap_or_default(),
                )
            })
            .collect()
    };
    let mut data = JsonDbFile::default();
    let mut original = HashMap::new();
    {
        let cache = state.candidate_history.lock().await;
        let cache = cache.as_ref().expect("candidate cache initialized");
        let store = state.store.lock().await;
        // Snapshot only affected histories and their transitive authorities.
        // An unrelated DID must not turn every asset import into a DB-wide scan.
        let mut needed: HashSet<_> = targets.iter().cloned().collect();
        let mut pending = targets.clone();
        while let Some(key) = pending.pop() {
            let events = store.get_events(&key);
            for event in events.iter().chain(cache.get(&key).into_iter().flatten()) {
                if let Some(previd) = event.operation.get("previd").and_then(Value::as_str) {
                    if let Some(operation) = store.get_operation(previd) {
                        data.ops.insert(previd.to_string(), operation);
                    }
                }
                for controller in [
                    event.operation.get("controller"),
                    event.operation.pointer("/doc/didDocument/controller"),
                ]
                .into_iter()
                .flatten()
                .filter_map(|value| value.as_str())
                {
                    if needed.insert(controller.to_string()) {
                        pending.push(controller.to_string());
                    }
                }
            }
            data.dids
                .insert(key.rsplit(':').next().unwrap_or(&key).to_string(), events);
        }
        for target in &targets {
            original.insert(
                target.clone(),
                serde_json::to_string(&store.get_events(target))?,
            );
        }
    }
    // Start affected projections empty, so replay does not inherit an
    // arrival-dependent accepted branch from the previous materialization.
    for target in &targets {
        data.dids
            .remove(target.rsplit(':').next().unwrap_or(target));
    }
    let mut replay = state.clone();
    replay.store = Arc::new(Mutex::new(JsonDb {
        backend: DbBackend::Memory,
        data,
        redis_connection: None,
    }));
    replay.did_locks = Arc::new(Mutex::new(HashMap::new()));
    replay.search_index = Arc::new(Mutex::new(SearchIndex::default()));
    loop {
        let before = snapshot(&replay, &targets).await?;
        for target in &targets {
            let mut events = candidates.get(target).cloned().unwrap_or_default();
            events.sort_by(|a, b| {
                let a_hint = crate::is_unanchored_registry(&a.registry);
                let b_hint = crate::is_unanchored_registry(&b.registry);
                if a_hint && b_hint {
                    return std::cmp::Ordering::Equal;
                }
                let registry = if a_hint != b_hint {
                    b_hint.cmp(&a_hint)
                } else {
                    a.registry.cmp(&b.registry)
                };
                registry
                    .then_with(|| compare_ordinals(a.ordinal.as_ref(), b.ordinal.as_ref()))
                    .then_with(|| a.time.cmp(&b.time))
                    .then_with(|| a.opid.cmp(&b.opid))
            });
            replay.store.lock().await.set_events(target, Vec::new())?;
            loop {
                let previous =
                    serde_json::to_string(&replay.store.lock().await.get_events(target))?;
                for event in &events {
                    import_event_once(&replay, event.clone()).await;
                }
                if serde_json::to_string(&replay.store.lock().await.get_events(target))? == previous
                {
                    break;
                }
            }
        }
        if snapshot(&replay, &targets).await? == before {
            break;
        }
    }
    let mut changed = Vec::new();
    {
        let replay_store = replay.store.lock().await;
        let mut store = state.store.lock().await;
        for target in &targets {
            let events = replay_store.get_events(target);
            if original.get(target) != Some(&serde_json::to_string(&events)?) {
                if events.is_empty() {
                    store.delete_events(target)?;
                } else {
                    store.set_events(target, events)?;
                }
                changed.push(target.clone());
            }
        }
    }
    for target in changed {
        state.verified_dids.lock().await.remove(&target);
        update_search_doc(state, &target).await;
    }
    *state.status_snapshot.lock().await = None;
    Ok(())
}

async fn snapshot(state: &AppState, targets: &[String]) -> Result<Vec<String>> {
    let store = state.store.lock().await;
    targets
        .iter()
        .map(|target| Ok(serde_json::to_string(&store.get_events(target))?))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{resolve_local_doc_async, ResolveOptions};
    use serde_json::Value;

    fn identity_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/operation-identity-vectors.json"
        ))
        .unwrap()
    }

    fn identity_event(operation: &Value, height: u64) -> EventRecord {
        crate::value_to_event_record(&json!({
            "operation": operation, "registry": "BTC:signet", "time": "2026-04-11T13:00:00Z",
            "ordinal": [height, 0], "registration": {"height": height, "index": 0, "txid": "tx", "batch": "batch"}
        }))
    }

    #[tokio::test]
    async fn operation_identity_distinguishes_equal_signatures_in_both_orders() {
        let vector = identity_fixture();
        let did = vector["did"].as_str().unwrap();
        for variant_first in [false, true] {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            crate::events::import_event_impl(&state, identity_event(&vector["create"], 100)).await;
            let mut batch = vec![
                identity_event(&vector["update"], 200),
                identity_event(&vector["variant"], 300),
            ];
            if variant_first {
                batch.reverse();
            }
            let queued = crate::events::import_batch_impl(
                &state,
                &batch
                    .iter()
                    .map(crate::event_record_to_value)
                    .collect::<Vec<_>>(),
            )
            .await;
            assert_eq!(queued.queued, 2);
            crate::process_events_impl(&state).await;
            crate::events::import_event_impl(&state, identity_event(&vector["successor"], 400))
                .await;
            *state.history_ready.lock().await = false;
            *state.candidate_history.lock().await = None;
            ensure_history_ready(&state).await.unwrap();
            let doc = resolve_local_doc_async(
                &state,
                did,
                ResolveOptions {
                    verify: true,
                    confirm: true,
                    ..ResolveOptions::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(doc["didDocumentData"], json!({"version":3}));
            assert_eq!(
                state.store.lock().await.get_candidates().unwrap()[did].len(),
                4
            );
        }
    }

    #[tokio::test]
    async fn operation_identity_preserves_cached_alias_predecessors_and_repairs_legacy_projection()
    {
        let vector = identity_fixture();
        let did = vector["did"].as_str().unwrap();
        for legacy in [false, true] {
            for successor in ["successor", "aliasSuccessor"] {
                let (state, _dir) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data: JsonDbFile::default(),
                    redis_connection: None,
                });
                let alias = vector["aliasCid"].as_str().unwrap();
                // CID ingress retains the retrieved bytes under their source CID.
                state
                    .store
                    .lock()
                    .await
                    .add_operation(alias, vector["update"].clone())
                    .unwrap();
                let mut update = identity_event(&vector["update"], 200);
                update.opid = Some(alias.to_string());
                let events = vec![
                    identity_event(&vector["create"], 100),
                    update,
                    identity_event(&vector[successor], 300),
                ];
                if legacy {
                    state.store.lock().await.set_events(did, events).unwrap();
                } else {
                    for event in events {
                        crate::events::import_event_impl(&state, event).await;
                    }
                }
                *state.history_ready.lock().await = false;
                *state.candidate_history.lock().await = None;
                ensure_history_ready(&state).await.unwrap();
                let doc = resolve_local_doc_async(
                    &state,
                    did,
                    ResolveOptions {
                        verify: true,
                        ..ResolveOptions::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(
                    doc["didDocumentData"],
                    json!({"version":3}),
                    "{legacy} {successor}"
                );
                let events = state.store.lock().await.get_events(did);
                assert_eq!(events[1].opid.as_deref(), vector["updateCid"].as_str());
                assert_eq!(events[2].operation["previd"], vector[successor]["previd"]);
            }
        }
    }

    async fn read_status_or_list(state: &AppState, status: bool) -> Value {
        let response = if status {
            crate::api::status(axum::extract::State(state.clone())).await
        } else {
            crate::api::list_dids(
                axum::extract::State(state.clone()),
                bytes::Bytes::from_static(br#"{"resolve":true}"#),
            )
            .await
        };
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn assert_recovered_read(value: Value, vector: &Value, status: bool) {
        if status {
            assert_eq!(value["dids"]["byVersion"]["1"], json!(1));
            assert_eq!(value["dids"]["byVersion"]["2"], json!(1));
        } else {
            let asset = value
                .as_array()
                .unwrap()
                .iter()
                .find(|doc| doc["didDocument"]["id"] == vector["asset"])
                .unwrap();
            assert_eq!(asset["didDocumentData"], json!("original"));
        }
    }

    #[tokio::test]
    async fn status_and_list_repair_before_the_first_read() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        for status in [false, true] {
            let db = JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            };
            let (state, _directory) = crate::tests::make_state(db);
            for event in vector["base"]
                .as_array()
                .unwrap()
                .iter()
                .chain([&vector["old"]])
            {
                crate::events::import_event_impl(
                    &state,
                    serde_json::from_value(event.clone()).unwrap(),
                )
                .await;
            }
            crate::refresh_metrics_snapshot(&state).await.unwrap();
            let did = vector["controller"].as_str().unwrap();
            let mut store = state.store.lock().await;
            let mut journal = store.get_candidates().unwrap()[did].clone();
            journal.push(serde_json::from_value(vector["rotation"].clone()).unwrap());
            store.set_candidates(did, journal).unwrap();
            drop(store);
            *state.history_ready.lock().await = false;
            *state.candidate_history.lock().await = None;
            state.dependents.lock().await.clear();
            let response = tokio::time::timeout(
                std::time::Duration::from_secs(2),
                read_status_or_list(&state, status),
            )
            .await
            .unwrap();
            assert_recovered_read(response, vector, status);
        }
    }

    #[tokio::test]
    async fn status_list_and_background_cache_wait_for_publication() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        let (state, _directory) = crate::tests::make_state(db);
        for event in vector["base"]
            .as_array()
            .unwrap()
            .iter()
            .chain([&vector["old"]])
        {
            crate::events::import_event_impl(
                &state,
                serde_json::from_value(event.clone()).unwrap(),
            )
            .await;
        }
        let guard = state.history_lock.lock().await;
        let mut readers = Vec::new();
        for status in [false, true] {
            let reading_state = state.clone();
            readers.push(tokio::spawn(async move {
                read_status_or_list(&reading_state, status).await
            }));
        }
        let background_state = state.clone();
        let background =
            tokio::spawn(async move { crate::refresh_metrics_snapshot(&background_state).await });
        tokio::task::yield_now().await;
        assert!(readers.iter().all(|reader| !reader.is_finished()));
        assert!(!background.is_finished());
        crate::events::import_event_once(
            &state,
            serde_json::from_value(vector["rotation"].clone()).unwrap(),
        )
        .await;
        reconcile_history(&state, vector["controller"].as_str().unwrap(), true)
            .await
            .unwrap();
        drop(guard);
        for (reader, status) in readers.into_iter().zip([false, true]) {
            let result = tokio::time::timeout(std::time::Duration::from_secs(2), reader)
                .await
                .unwrap()
                .unwrap();
            assert_recovered_read(result, vector, status);
        }
        background.await.unwrap().unwrap();
        assert_eq!(
            state
                .status_snapshot
                .lock()
                .await
                .as_ref()
                .unwrap()
                .by_version
                .get("1"),
            Some(&1)
        );
    }

    #[tokio::test]
    async fn gc_storage_failure_propagates_to_http_and_preserves_pending_imports() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0]["gc"];
        let db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        let (mut state, directory) = crate::tests::make_state(db);
        for event in vector["base"].as_array().unwrap() {
            crate::events::import_event_impl(
                &state,
                serde_json::from_value(event.clone()).unwrap(),
            )
            .await;
        }
        state
            .import_queue
            .lock()
            .await
            .push(serde_json::from_value(vector["base"][1].clone()).unwrap());
        // Reads still work, but attempting to write a JSON file over a directory fails.
        state.store.lock().await.backend = DbBackend::JsonFile {
            path: directory.path().to_path_buf(),
        };
        assert!(crate::verify_db_impl(&state, false).await.is_err());
        assert_eq!(state.import_queue.lock().await.len(), 1);
        state.config.admin_api_key = "gc-test-key".to_string();
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            "x-archon-admin-key",
            axum::http::HeaderValue::from_static("gc-test-key"),
        );
        let response = crate::api::db_verify(axum::extract::State(state.clone()), headers).await;
        assert_eq!(
            response.status(),
            axum::http::StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(state.import_queue.lock().await.len(), 1);
        state.store.lock().await.backend = DbBackend::Memory;
        let result = crate::verify_db_impl(&state, false).await.unwrap();
        assert_eq!(result.expired, 1);
        assert!(state.import_queue.lock().await.is_empty());
        assert!(state
            .store
            .lock()
            .await
            .get_events(vector["asset"].as_str().unwrap())
            .is_empty());
    }

    #[tokio::test]
    async fn signed_controller_rules_apply_to_submissions_imports_and_repair() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/controller-rules-vectors.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            for mode in ["direct", "import", "repair"] {
                let db = JsonDb {
                    backend: DbBackend::Memory,
                    data: JsonDbFile::default(),
                    redis_connection: None,
                };
                let (state, _directory) = crate::tests::make_state(db);
                *state.supported_registries.lock().await =
                    vec!["local".into(), "hyperswarm".into(), "BTC:signet".into()];
                for base in fixture["base"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .chain(case["setup"].as_array().unwrap())
                {
                    crate::events::import_event_impl(
                        &state,
                        serde_json::from_value(base.clone()).unwrap(),
                    )
                    .await;
                }
                let event: EventRecord = serde_json::from_value(case["event"].clone()).unwrap();
                let did = event.did.clone().unwrap();
                let before = state.store.lock().await.get_events(&did).len();
                let accepted = case["accepted"].as_bool().unwrap();
                if mode == "direct" {
                    let result =
                        crate::events::handle_did_operation(&state, &event.operation).await;
                    assert_eq!(result.is_ok(), accepted, "{}: {:?}", case["name"], result);
                } else if mode == "import" {
                    let status = crate::events::import_event_impl(&state, event.clone()).await;
                    assert_eq!(
                        matches!(status, crate::events::ImportStatus::Added),
                        accepted,
                        "{}",
                        case["name"]
                    );
                } else {
                    let mut store = state.store.lock().await;
                    let mut events = store.get_events(&did);
                    events.push(event);
                    store.set_events(&did, events.clone()).unwrap();
                    store.set_candidates(&did, events).unwrap();
                    drop(store);
                    *state.history_ready.lock().await = false;
                    *state.candidate_history.lock().await = None;
                    state.dependents.lock().await.clear();
                    ensure_history_ready(&state).await.unwrap();
                }
                assert_eq!(
                    state.store.lock().await.get_events(&did).len(),
                    before + usize::from(accepted),
                    "{} {}",
                    case["name"],
                    mode
                );
            }
        }
    }

    #[tokio::test]
    async fn signed_cycle_is_rejected_at_controller_assignment_including_legacy_repair() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/controller-rules-vectors.json"
        ))
        .unwrap();
        let dids: Vec<String> = serde_json::from_value(fixture["cycle"]["dids"].clone()).unwrap();
        let events: Vec<EventRecord> =
            serde_json::from_value(fixture["cycle"]["events"].clone()).unwrap();
        for repair in [false, true] {
            let db = JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            };
            let (state, _directory) = crate::tests::make_state(db);
            if repair {
                for did in &dids {
                    let history: Vec<_> = events
                        .iter()
                        .filter(|e| e.did.as_ref() == Some(did))
                        .cloned()
                        .collect();
                    state
                        .store
                        .lock()
                        .await
                        .set_events(did, history.clone())
                        .unwrap();
                    state
                        .store
                        .lock()
                        .await
                        .set_candidates(did, history)
                        .unwrap();
                }
                ensure_history_ready(&state).await.unwrap();
            } else {
                for event in &events {
                    let status = crate::events::import_event_impl(&state, event.clone()).await;
                    if event
                        .operation
                        .pointer("/doc/didDocument/controller")
                        .is_some()
                    {
                        assert!(matches!(status, crate::events::ImportStatus::Rejected));
                    }
                }
            }
            for did in &dids {
                assert_eq!(state.store.lock().await.get_events(did).len(), 1);
                assert_eq!(
                    state.store.lock().await.get_candidates().unwrap()[did].len(),
                    3
                );
                let doc = resolve_local_doc_async(
                    &state,
                    did,
                    ResolveOptions {
                        verify: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(doc["didDocumentMetadata"]["versionSequence"], json!("1"));
                assert!(doc["didDocument"].get("controller").is_none());
            }
        }
    }

    #[tokio::test]
    async fn removing_controller_replays_dependents_even_before_cache_initialization() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        for restart in [false, true] {
            let db = JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            };
            let (state, _directory) = crate::tests::make_state(db);
            for event in vector["base"]
                .as_array()
                .unwrap()
                .iter()
                .chain(vector["delegation"].as_array().unwrap())
                .chain([&vector["old"], &vector["delegated"]])
            {
                crate::events::import_event_impl(
                    &state,
                    serde_json::from_value(event.clone()).unwrap(),
                )
                .await;
            }
            if restart {
                *state.candidate_history.lock().await = None;
                state.dependents.lock().await.clear();
                *state.history_ready.lock().await = false;
            }
            let controller = vector["controller"].as_str().unwrap();
            let asset = vector["asset"].as_str().unwrap();
            let child = vector["child"].as_str().unwrap();
            let candidates = state.store.lock().await.get_candidates().unwrap();
            remove_histories(&state, &[controller.to_string()])
                .await
                .unwrap();
            assert!(state.store.lock().await.get_events(asset).is_empty());
            assert_eq!(state.store.lock().await.get_events(child).len(), 1);
            assert_eq!(
                serde_json::to_value(&state.store.lock().await.get_candidates().unwrap()[asset])
                    .unwrap(),
                serde_json::to_value(&candidates[asset]).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&state.store.lock().await.get_candidates().unwrap()[child])
                    .unwrap(),
                serde_json::to_value(&candidates[child]).unwrap()
            );
            *state.history_ready.lock().await = false;
            ensure_history_ready(&state).await.unwrap();
            assert!(state.store.lock().await.get_events(asset).is_empty());
            crate::events::import_event_impl(
                &state,
                serde_json::from_value(vector["base"][0].clone()).unwrap(),
            )
            .await;
            assert_eq!(
                resolve_local_doc_async(&state, asset, ResolveOptions::default())
                    .await
                    .unwrap()["didDocumentData"],
                json!("retired")
            );
        }
    }

    #[tokio::test]
    async fn gc_controller_replays_previously_verified_dependents() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0]["gc"];
        for invalid in [false, true] {
            let db = JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            };
            let (state, _directory) = crate::tests::make_state(db);
            for event in vector["base"].as_array().unwrap() {
                crate::events::import_event_impl(
                    &state,
                    serde_json::from_value(event.clone()).unwrap(),
                )
                .await;
            }
            let controller = vector["controller"].as_str().unwrap();
            let asset = vector["asset"].as_str().unwrap();
            state
                .verified_dids
                .lock()
                .await
                .insert(asset.to_string(), true);
            if invalid {
                let mut store = state.store.lock().await;
                let mut events = store.get_events(controller);
                events[0].operation["proof"]["proofValue"] = json!("invalid");
                store.set_events(controller, events).unwrap();
            }
            let result = crate::verify_db_impl(&state, false).await.unwrap();
            assert_eq!(
                if invalid {
                    result.invalid
                } else {
                    result.expired
                },
                1
            );
            assert!(state.store.lock().await.get_events(asset).is_empty());
            assert_eq!(
                state.store.lock().await.get_candidates().unwrap()[asset].len(),
                1
            );
            assert!(state.store.lock().await.get_candidates().unwrap()[controller].is_empty());
            *state.history_ready.lock().await = false;
            *state.candidate_history.lock().await = None;
            state.dependents.lock().await.clear();
            ensure_history_ready(&state).await.unwrap();
            assert!(state.store.lock().await.get_events(asset).is_empty());
        }
    }

    #[tokio::test]
    async fn shared_recovery_vectors_converge_in_both_orders_across_restart() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        for backend in ["json", "sqlite"] {
            for vector in &vectors {
                for scenario in [
                    "retired",
                    "new-key",
                    "early",
                    "migration",
                    "delegation",
                    "deletion",
                    "create",
                ] {
                    let mut versions = Vec::new();
                    for rotation_first in [true, false] {
                        let db = JsonDb {
                            backend: DbBackend::Memory,
                            data: JsonDbFile::default(),
                            redis_connection: None,
                        };
                        let (mut state, _directory) = crate::tests::make_state(db);
                        state.config.db = backend.to_string();
                        state.store = Arc::new(Mutex::new(JsonDb::load(&state.config).unwrap()));
                        ensure_history_ready(&state).await.unwrap();
                        let mut base = vector["base"].as_array().unwrap().clone();
                        if scenario == "create" {
                            base.truncate(1);
                        }
                        if scenario == "delegation" {
                            base.extend(vector["delegation"].as_array().unwrap().clone());
                        }
                        let mut late_create = vector["base"][1].clone();
                        for key in ["time", "ordinal", "registration"] {
                            late_create[key] = vector["old"][key].clone();
                        }
                        if scenario == "migration" {
                            base.push(vector["migration"].clone());
                        }
                        let rotation = &vector[if scenario == "migration" {
                            "migrationRotation"
                        } else {
                            "rotation"
                        }];
                        let tail = match scenario {
                            "create" => vec![&late_create],
                            "delegation" => vec![&vector["delegated"]],
                            "deletion" => vec![&vector["deletion"]],
                            "retired" => vec![&vector["old"], &vector["oldNext"]],
                            "early" => vec![&vector["early"]],
                            _ => vec![&vector["fresh"], &vector["freshNext"]],
                        };
                        for event in base
                            .iter()
                            .chain(if rotation_first { Some(rotation) } else { None })
                            .chain(tail.iter().copied())
                        {
                            crate::events::import_event_impl(
                                &state,
                                serde_json::from_value(event.clone()).unwrap(),
                            )
                            .await;
                        }
                        state.store = Arc::new(Mutex::new(JsonDb::load(&state.config).unwrap()));
                        state.candidate_history = Arc::new(Mutex::new(None));
                        state.dependents = Arc::new(Mutex::new(HashMap::new()));
                        state.history_ready = Arc::new(Mutex::new(false));
                        ensure_history_ready(&state).await.unwrap();
                        if !rotation_first {
                            crate::events::import_event_impl(
                                &state,
                                serde_json::from_value(rotation.clone()).unwrap(),
                            )
                            .await;
                        }
                        let asset = vector[if scenario == "delegation" {
                            "child"
                        } else {
                            "asset"
                        }]
                        .as_str()
                        .unwrap();
                        if scenario == "create" {
                            assert!(resolve_local_doc_async(
                                &state,
                                asset,
                                ResolveOptions::default()
                            )
                            .await
                            .is_err());
                            assert!(state.store.lock().await.get_events(asset).is_empty());
                            assert_eq!(
                                state.store.lock().await.get_candidates().unwrap()[asset].len(),
                                1
                            );
                            versions.push(json!("notFound"));
                            continue;
                        }
                        let doc = resolve_local_doc_async(
                            &state,
                            asset,
                            ResolveOptions {
                                confirm: true,
                                verify: true,
                                ..Default::default()
                            },
                        )
                        .await
                        .unwrap();
                        let expected = match scenario {
                            "new-key" => "new-key-successor",
                            "early" => "before-rotation",
                            _ => "original",
                        };
                        assert_eq!(
                            doc["didDocumentData"],
                            json!(expected),
                            "{} {} {} {}",
                            backend,
                            vector["registry"],
                            scenario,
                            rotation_first
                        );
                        let store = state.store.lock().await;
                        assert_eq!(
                            store.get_events(asset).len(),
                            match scenario {
                                "new-key" => 3,
                                "early" => 2,
                                _ => 1,
                            }
                        );
                        assert_eq!(
                            store.get_candidates().unwrap()[asset].len(),
                            tail.len() + if scenario == "delegation" { 2 } else { 1 }
                        );
                        versions.push(doc["didDocumentMetadata"]["versionId"].clone());
                    }
                    assert_eq!(versions[0], versions[1]);
                }
            }
        }
    }
    #[tokio::test]
    async fn earlier_anchor_of_seen_operation_is_not_deduplicated() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        let (state, _directory) = crate::tests::make_state(db);
        crate::import_batch_impl(&state, vector["base"].as_array().unwrap()).await;
        crate::process_events_impl(&state).await;
        let mut late = vector["rotation"].clone();
        late["ordinal"] = json!([350, 0]);
        late["time"] = json!("2026-01-01T00:05:50Z");
        late["registration"]["height"] = json!(350);
        crate::import_batch_impl(&state, &[late, vector["old"].clone()]).await;
        crate::process_events_impl(&state).await;
        let asset = vector["asset"].as_str().unwrap();
        let options = ResolveOptions {
            confirm: true,
            ..Default::default()
        };
        assert_eq!(
            resolve_local_doc_async(&state, asset, options.clone())
                .await
                .unwrap()["didDocumentData"],
            json!("retired")
        );
        let result = crate::import_batch_impl(&state, &[vector["rotation"].clone()]).await;
        assert_eq!(result.queued, 1);
        crate::process_events_impl(&state).await;
        assert_eq!(
            resolve_local_doc_async(&state, asset, options)
                .await
                .unwrap()["didDocumentData"],
            json!("original")
        );
    }
    #[tokio::test]
    async fn upgrades_accepted_histories_without_a_candidate_journal() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let mut db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        for (did, events) in [
            (
                &vector["controller"],
                vec![&vector["base"][0], &vector["rotation"]],
            ),
            (&vector["asset"], vec![&vector["base"][1], &vector["old"]]),
        ] {
            let events = events
                .into_iter()
                .map(|value| {
                    let mut event: EventRecord = serde_json::from_value(value.clone()).unwrap();
                    event.opid = None;
                    event
                })
                .collect();
            db.set_events(did.as_str().unwrap(), events).unwrap();
        }
        let (state, _directory) = crate::tests::make_state(db);
        ensure_history_ready(&state).await.unwrap();
        let asset = vector["asset"].as_str().unwrap();
        let doc = resolve_local_doc_async(
            &state,
            asset,
            ResolveOptions {
                confirm: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(doc["didDocumentData"], json!("original"));
        assert_eq!(
            state.store.lock().await.get_candidates().unwrap()[asset].len(),
            2
        );
    }
}
