//! Durable candidate evidence and import-time revalidation of dependent histories.
use crate::event_policy::{normalize_event_time, preferred_candidates};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use serde_json::Value;
#[cfg(test)]
use serde_json::json;
use tokio::sync::Mutex;

use crate::events::import_event_once;
use crate::progress::ProgressLogger;
use crate::store::{compare_ordinals, DbBackend, JsonDbFile};
use crate::{
    generate_json_cid, update_search_doc, AppState, EventRecord, GatekeeperDb, JsonDb, SearchIndex,
};

// Derive the TypeScript numeric-key reference from content, never a peer opid.
// Existing predecessor verification still checks the referenced operation's CID.
fn normalize_candidate_event(store: &mut JsonDb, event: &mut EventRecord) -> Result<()> {
    normalize_event_time(event);
    let canonical = generate_json_cid(&event.operation)?;
    if let Some(alias) = crate::proofs::typescript_numeric_cid(&event.operation) {
        if alias != canonical && store.get_operation(&alias).is_none() {
            store.add_operation(&alias, event.operation.clone())?;
        }
    }
    event.opid = Some(canonical);
    Ok(())
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
) -> Result<bool> {
    retain_candidates_with_histories(state, did, incoming, None).await
}

async fn retain_candidates_with_histories(
    state: &AppState,
    did: &str,
    incoming: Option<EventRecord>,
    histories: Option<&HashMap<String, Vec<EventRecord>>>,
) -> Result<bool> {
    let mut cache = state.candidate_history.lock().await;
    let mut dependents = state.dependents.lock().await;
    let mut store = state.store.lock().await;
    if cache.is_none() {
        let mut candidates = store.get_candidates()?;
        for current in store.list_dids(&state.config.did_prefix, None) {
            if !candidates.contains_key(&current) {
                let mut events = histories
                    .map(|items| items.get(&current).cloned().unwrap_or_default())
                    .unwrap_or_else(|| store.get_events(&current));
                for event in &mut events {
                    normalize_candidate_event(&mut store, event)?;
                }
                store.set_candidates(&current, events.clone())?;
                candidates.insert(current, events);
            }
        }
        for (key, events) in &mut candidates {
            let mut changed = false;
            for event in events.iter_mut() {
                let previous = (event.opid.clone(), event.time.clone());
                normalize_candidate_event(&mut store, event)?;
                changed |= event.opid != previous.0 || event.time != previous.1;
            }
            let count = events.len();
            *events = preferred_candidates(std::mem::take(events));
            changed |= events.len() != count;
            if changed {
                store.set_candidates(key, events.clone())?;
            }
            index_candidates(&mut dependents, key, events);
        }
        *cache = Some(candidates);
    }
    let candidates = cache.as_mut().expect("candidate cache initialized");
    let mut events = candidates.get(did).cloned().unwrap_or_default();
    // The journal is authoritative after migration; a stale projection cannot
    // resurrect evidence withdrawn by a reorg.
    events.extend(incoming);
    for event in &mut events {
        normalize_candidate_event(&mut store, event)?;
    }
    let events = preferred_candidates(events);
    let changed = candidates.get(did) != Some(&events);
    if changed {
        store.set_candidates(did, events.clone())?;
    }
    index_candidates(&mut dependents, did, &events);
    candidates.insert(did.to_string(), events);
    Ok(changed)
}

// Call with history_lock held and event processing excluded.
pub(crate) async fn rewind_registry(
    state: &AppState,
    registry: &str,
    from_height: u64,
) -> Result<()> {
    let withdrawn = |event: &EventRecord| {
        event.registry == registry
            && event
                .registration
                .as_ref()
                .and_then(|r| crate::proofs::ordinal_component(&r["height"]))
                .is_some_and(|h| h >= from_height)
    };
    let demote = |mut event: EventRecord| {
        if withdrawn(&event) {
            event.registry = "hyperswarm".to_string();
            event.registration = None;
            normalize_event_time(&mut event);
        }
        event
    };
    let result = async {
        {
            let mut queue = state.import_queue.lock().await;
            *queue = queue.iter().cloned().map(&demote).collect();
        }
        let mut affected = HashSet::new();
        {
            let mut cache = state.candidate_history.lock().await;
            let candidates = cache.as_mut().expect("history initialized");
            for (did, events) in candidates.iter_mut() {
                if !events.iter().any(&withdrawn) {
                    continue;
                }
                let retained = preferred_candidates(events.iter().cloned().map(&demote).collect());
                state
                    .store
                    .lock()
                    .await
                    .set_candidates(did, retained.clone())?;
                *events = retained;
                affected.insert(did.clone());
            }
        }
        state
            .store
            .lock()
            .await
            .remove_blocks(registry, from_height)?;
        state.events_seen.lock().await.clear();
        {
            let dependents = state.dependents.lock().await;
            let mut pending: Vec<_> = affected.iter().cloned().collect();
            while let Some(did) = pending.pop() {
                for dependent in dependents.get(&did).into_iter().flatten() {
                    if affected.insert(dependent.clone()) {
                        pending.push(dependent.clone());
                    }
                }
            }
        }
        rebuild_histories(state, affected.into_iter().collect(), None).await?;
        Ok(())
    }
    .await;
    *state.status_snapshot.lock().await = None;
    if result.is_err() {
        *state.history_ready.lock().await = false;
    }
    result
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
    tracing::info!("Gatekeeper history recovery: loading candidate journal and DID list");
    let mut dids: Vec<_> = {
        let store = state.store.lock().await;
        let mut dids: HashSet<_> = store.get_candidates()?.into_keys().collect();
        dids.extend(store.list_dids(&state.config.did_prefix, None));
        dids.into_iter().collect()
    };
    dids.sort();
    // Journal all existing projections before rebuilding any of them. A single
    // startup projection avoids replaying each controller's dependents again
    // when the outer DID scan reaches them.
    let mut loading = ProgressLogger::new("history loading", dids.len());
    let histories = state.store.lock().await.get_histories(&dids)?;
    loading.update(dids.len());
    let mut preparing = ProgressLogger::new("candidate preparation", dids.len());
    for (index, did) in dids.iter().enumerate() {
        retain_candidates_with_histories(state, did, None, Some(&histories)).await?;
        preparing.update(index + 1);
    }
    rebuild_histories(state, dids, Some(&histories)).await?;
    *state.history_ready.lock().await = true;
    Ok(())
}

// The insertion merged without changing accepted state. New evidence still
// needs self-replay, but unchanged authority cannot affect its dependents.
pub(crate) async fn reconcile_merged_history(state: &AppState, did: &str) -> Result<()> {
    let result = async {
        if rebuild_histories(state, vec![did.to_string()], None).await? {
            reconcile_history(state, did, false).await?;
        }
        Ok(())
    }
    .await;
    if result.is_err() {
        *state.history_ready.lock().await = false;
    }
    result
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
    rebuild_histories(state, affected.into_iter().collect(), None)
        .await
        .map(|_| ())
}

async fn rebuild_histories(
    state: &AppState,
    mut targets: Vec<String>,
    histories: Option<&HashMap<String, Vec<EventRecord>>>,
) -> Result<bool> {
    if targets.is_empty() {
        return Ok(false);
    }
    // Snapshot-backed replay is startup recovery; runtime imports stay quiet.
    let mut snapshot = histories.map(|_| ProgressLogger::new("replay snapshot", targets.len()));
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
    if histories.is_some() {
        // Startup retained and canonicalized every candidate before replay.
        // Reuse that content for canonical predecessors instead of reading it
        // back one operation at a time. Retrieval aliases still require the DB.
        for event in candidates.values().flatten() {
            if let Some(opid) = &event.opid {
                data.ops.insert(opid.clone(), event.operation.clone());
            }
        }
    }
    let mut original = HashMap::new();
    {
        let cache = state.candidate_history.lock().await;
        let cache = cache.as_ref().expect("candidate cache initialized");
        let store = state.store.lock().await;
        // Snapshot only affected histories and their transitive authorities.
        // An unrelated DID must not turn every asset import into a DB-wide scan.
        let mut needed: HashSet<_> = targets.iter().cloned().collect();
        let mut pending = targets.clone();
        let mut references = HashSet::new();
        while let Some(key) = pending.pop() {
            let events = histories
                .map(|items| items.get(&key).cloned().unwrap_or_default())
                .unwrap_or_else(|| store.get_events(&key));
            for event in events.iter().chain(cache.get(&key).into_iter().flatten()) {
                if let Some(previd) = event.operation.get("previd").and_then(Value::as_str) {
                    if references.insert(previd.to_string()) && !data.ops.contains_key(previd) {
                        if let Some(operation) = store.get_operation(previd) {
                            data.ops.insert(previd.to_string(), operation);
                        }
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
            if candidates.contains_key(&key) {
                original.insert(key.clone(), serde_json::to_string(&events)?);
                if let Some(progress) = &mut snapshot {
                    progress.update(original.len());
                }
            }
            data.dids
                .insert(key.rsplit(':').next().unwrap_or(&key).to_string(), events);
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
    // Only self-controlled agents can authorize another DID. Their histories
    // therefore have no external dependencies; finish them before any assets.
    // Invalid controller assignments are still rejected by normal authorization.
    targets.sort_by_key(|target| {
        !candidates.get(target).into_iter().flatten().any(|event| {
            event.operation.get("type").and_then(Value::as_str) == Some("create")
                && event
                    .operation
                    .pointer("/registration/type")
                    .and_then(Value::as_str)
                    == Some("agent")
        })
    });
    let mut replay_progress = histories.map(|_| ProgressLogger::new("history replay", targets.len()));
    for (index, target) in targets.iter().enumerate() {
        #[cfg(test)]
        let _ = tests::REPLAYED_HISTORIES.try_with(|replayed| {
            replayed.borrow_mut().push(target.clone());
        });
        let mut events = candidates.get(target).cloned().unwrap_or_default();
        events.sort_by(|a, b| {
            let a_hint = crate::is_locally_stamped_registry(&a.registry);
            let b_hint = crate::is_locally_stamped_registry(&b.registry);
            if a_hint && b_hint {
                // Keep the usual predecessor-first traversal. The shared importer
                // selects competing unanchored siblings by canonical CID.
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
            let previous = serde_json::to_string(&replay.store.lock().await.get_events(target))?;
            for event in &events {
                import_event_once(&replay, event.clone()).await;
            }
            if serde_json::to_string(&replay.store.lock().await.get_events(target))? == previous {
                break;
            }
        }
        if let Some(progress) = &mut replay_progress {
            progress.update(index + 1);
        }
    }
    let mut publishing = histories.map(|_| ProgressLogger::new("history publication", targets.len()));
    let mut changed = Vec::new();
    {
        let replay_store = replay.store.lock().await;
        let mut store = state.store.lock().await;
        for (index, target) in targets.iter().enumerate() {
            let events = replay_store.get_events(target);
            if original.get(target) != Some(&serde_json::to_string(&events)?) {
                if events.is_empty() {
                    store.delete_events(target)?;
                } else {
                    store.set_events(target, events)?;
                }
                changed.push(target.clone());
            }
            if let Some(progress) = &mut publishing {
                progress.update(index + 1);
            }
        }
    }
    let has_changes = !changed.is_empty();
    for target in &changed {
        state.verified_dids.lock().await.remove(target);
    }
    if histories.is_some() {
        // The replay store contains every accepted startup history. Empty
        // candidates were removed from durable storage during publication and
        // must not be counted as invalid DIDs in the derived views.
        replay
            .store
            .lock()
            .await
            .data
            .dids
            .retain(|_, events| !events.is_empty());
        crate::resolver::build_startup_views(&replay).await;
        *state.search_index.lock().await = std::mem::take(&mut *replay.search_index.lock().await);
        // status_snapshot and metrics are shared by the replay state clone.
    } else {
        // Runtime reconciliation only replaces affected search documents.
        for target in changed {
            update_search_doc(state, &target).await;
        }
        *state.status_snapshot.lock().await = None;
    }
    Ok(has_changes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{resolve_local_doc_async, ResolveOptions};
    use serde_json::Value;

    tokio::task_local! {
        // Scoped to one import so concurrent tests cannot contaminate the trace.
        pub(super) static REPLAYED_HISTORIES: std::cell::RefCell<Vec<String>>;
    }

    async fn import_with_replay_trace(
        state: &AppState,
        event: EventRecord,
    ) -> (crate::events::ImportStatus, Vec<String>) {
        REPLAYED_HISTORIES
            .scope(std::cell::RefCell::new(Vec::new()), async {
                let status = crate::events::import_event_impl(state, event).await;
                let replayed = REPLAYED_HISTORIES.with(|items| items.borrow().clone());
                (status, replayed)
            })
            .await
    }

    #[tokio::test]
    async fn new_gossip_hint_skips_dependents_until_controller_changes() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let controller = vector["controller"].as_str().unwrap();
        let asset = vector["asset"].as_str().unwrap();
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        for value in vector["base"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&vector["old"]))
        {
            assert!(matches!(
                crate::events::import_event_impl(
                    &state,
                    serde_json::from_value(value.clone()).unwrap(),
                )
                .await,
                crate::events::ImportStatus::Added
            ));
        }
        ensure_history_ready(&state).await.unwrap();
        let before = state.store.lock().await.get_events(controller);
        let asset_before = state.store.lock().await.get_events(asset);
        assert_eq!(asset_before.len(), 2);
        assert_eq!(
            state.store.lock().await.get_candidates().unwrap()[controller].len(),
            1
        );

        let mut hint: EventRecord =
            serde_json::from_value(vector["base"][0].clone()).unwrap();
        hint.registry = "hyperswarm".to_string();
        hint.registration = None;
        let (status, replayed) = import_with_replay_trace(&state, hint).await;
        assert!(matches!(status, crate::events::ImportStatus::Merged));
        // New evidence must replay the controller, but not its unchanged dependents.
        assert_eq!(replayed, vec![controller.to_string()]);
        assert!(state.store.lock().await.get_events(controller) == before);
        assert!(state.store.lock().await.get_events(asset) == asset_before);
        assert_eq!(
            state.store.lock().await.get_candidates().unwrap()[controller].len(),
            2
        );

        let (status, replayed) = import_with_replay_trace(
            &state,
            serde_json::from_value(vector["rotation"].clone()).unwrap(),
        )
        .await;
        assert!(matches!(status, crate::events::ImportStatus::Added));
        assert!(replayed.contains(&controller.to_string()));
        assert!(replayed.contains(&asset.to_string()));
        let doc = resolve_local_doc_async(
            &state,
            asset,
            ResolveOptions {
                verify: true,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(doc["didDocumentData"], json!("original"));
        assert_eq!(state.store.lock().await.get_events(asset).len(), 1);
    }

    #[tokio::test]
    async fn unchanged_deferred_event_skips_replay_and_recovers_with_its_predecessor() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        for value in vector["base"]
            .as_array()
            .unwrap()
            .iter()
            .chain(std::iter::once(&vector["rotation"]))
        {
            crate::events::import_event_impl(
                &state,
                serde_json::from_value(value.clone()).unwrap(),
            )
            .await;
        }
        ensure_history_ready(&state).await.unwrap();
        let deferred: EventRecord = serde_json::from_value(vector["freshNext"].clone()).unwrap();
        assert!(matches!(
            crate::events::import_event_impl(&state, deferred.clone()).await,
            crate::events::ImportStatus::Deferred
        ));
        crate::refresh_metrics_snapshot(&state).await.unwrap();
        assert!(state.status_snapshot.lock().await.is_some());
        assert!(matches!(
            crate::events::import_event_impl(&state, deferred).await,
            crate::events::ImportStatus::Deferred
        ));
        // Replay invalidates this cache; an unchanged retry must preserve it.
        assert!(state.status_snapshot.lock().await.is_some());
        crate::events::import_event_impl(
            &state,
            serde_json::from_value(vector["fresh"].clone()).unwrap(),
        )
        .await;
        let doc = resolve_local_doc_async(
            &state,
            vector["asset"].as_str().unwrap(),
            ResolveOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(doc["didDocumentData"], json!("new-key-successor"));
    }

    #[tokio::test]
    async fn pending_batches_track_only_deferred_chain_events() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        for gossip in [false, true] {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            let mut asset = vectors[0]["base"][1].clone();
            if gossip {
                asset["registry"] = json!("hyperswarm");
                asset.as_object_mut().unwrap().remove("registration");
            } else {
                asset["registration"]["batch"] = json!("pending-batch");
            }
            crate::import_batch_impl(&state, &[asset]).await;
            let response = crate::process_events_impl(&state).await;
            assert_eq!(response.pending, Some(1));
            assert_eq!(
                response.pending_batches,
                Some(if gossip { vec![] } else { vec!["pending-batch".to_string()] })
            );
            crate::import_batch_impl(&state, &[vectors[0]["base"][0].clone()]).await;
            let response = crate::process_events_impl(&state).await;
            assert_eq!(response.pending, Some(0));
            assert_eq!(response.pending_batches, None);
        }
    }

    #[tokio::test]
    async fn duplicate_sync_preserves_cached_status_and_replays_new_evidence() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        ))
        .unwrap();
        let vector = &vectors[0];
        let controller = vector["controller"].as_str().unwrap();
        let asset = vector["asset"].as_str().unwrap();
        for mode in ["anchored", "gossip", "restamped-gossip", "recovery-pending"] {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for value in vector["base"].as_array().unwrap() {
                let mut event: EventRecord = serde_json::from_value(value.clone()).unwrap();
                if mode.contains("gossip") {
                    event.registry = "hyperswarm".to_string();
                    event.registration = None;
                }
                crate::events::import_event_impl(&state, event).await;
            }
            ensure_history_ready(&state).await.unwrap();
            crate::refresh_metrics_snapshot(&state).await.unwrap();
            let before = state.store.lock().await.get_candidates().unwrap();
            let mut duplicate = before[controller][0].clone();
            if mode == "restamped-gossip" {
                duplicate.time = "2026-09-16T00:00:00.000Z".to_string();
                duplicate.ordinal = Some(vec![1789516800000, 42]);
            }
            if mode == "recovery-pending" {
                *state.history_ready.lock().await = false;
            }
            assert!(matches!(
                crate::events::import_event_impl(&state, duplicate).await,
                crate::events::ImportStatus::Merged
            ));
            assert_eq!(
                state.status_snapshot.lock().await.is_some(),
                mode != "recovery-pending"
            );
            assert!(state.store.lock().await.get_candidates().unwrap() == before);
            crate::events::import_event_impl(
                &state,
                serde_json::from_value(vector["old"].clone()).unwrap(),
            )
            .await;
            crate::events::import_event_impl(
                &state,
                serde_json::from_value(vector["rotation"].clone()).unwrap(),
            )
            .await;
            let doc = resolve_local_doc_async(
                &state,
                asset,
                ResolveOptions {
                    verify: true,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(doc["didDocumentData"], json!("original"));
        }
    }

    #[tokio::test]
    #[ignore = "requires a local accepted-history snapshot"]
    async fn benchmark_duplicate_sync() {
        let path = std::env::var("ARCHON_BENCHMARK_ACCEPTED").unwrap();
        let dids: HashMap<String, Vec<EventRecord>> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut data = JsonDbFile {
            dids,
            ..Default::default()
        };
        let mut dependents: HashMap<String, usize> = HashMap::new();
        for (suffix, events) in &data.dids {
            data.candidates
                .insert(format!("did:cid:{suffix}"), events.clone());
            if let Some(controller) = events
                .first()
                .and_then(|event| event.operation.get("controller"))
                .and_then(Value::as_str)
            {
                *dependents.entry(controller.to_string()).or_default() += 1;
            }
            for event in events {
                data.ops.insert(
                    generate_json_cid(&event.operation).unwrap(),
                    event.operation.clone(),
                );
            }
        }
        let (controller, fanout) = dependents
            .into_iter()
            .max_by_key(|(_, count)| *count)
            .unwrap();
        let mut duplicates = vec![data.candidates[&controller][0].clone()];
        let mut keys: Vec<_> = data.candidates.keys().cloned().collect();
        keys.sort();
        duplicates.extend(
            keys.iter()
                .filter(|did| *did != &controller)
                .filter_map(|did| data.candidates[did].first().cloned())
                .take(99),
        );
        let before = serde_json::to_value(&data.dids).unwrap();
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data,
            redis_connection: None,
        });
        // The snapshot is already recovered; benchmark sync, excluding startup.
        retain_candidates(&state, &controller, None).await.unwrap();
        *state.history_ready.lock().await = true;
        let started = std::time::Instant::now();
        for event in &duplicates {
            assert!(matches!(
                crate::events::import_event_impl(&state, event.clone()).await,
                crate::events::ImportStatus::Merged
            ));
        }
        eprintln!(
            "duplicate sync events={} controller_dependents={fanout} elapsed={:?}",
            duplicates.len(),
            started.elapsed()
        );
        assert_eq!(
            serde_json::to_value(&state.store.lock().await.data.dids).unwrap(),
            before
        );
    }

    // Local, isolated benchmark: never connects to the source database.
    #[tokio::test]
    #[ignore]
    async fn benchmark_startup_histories() {
        let path = std::env::var("ARCHON_BENCHMARK_HISTORIES").unwrap();
        let candidates: HashMap<String, Vec<EventRecord>> =
            serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        let mut data = JsonDbFile::default();
        for (did, events) in &candidates {
            data.dids.insert(did.rsplit(':').next().unwrap().to_string(), events.clone());
            for event in events {
                data.ops.insert(generate_json_cid(&event.operation).unwrap(), event.operation.clone());
            }
        }
        data.candidates = candidates;
        let count = data.dids.len();
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory, data, redis_connection: None,
        });
        let started = std::time::Instant::now();
        ensure_history_ready(&state).await.unwrap();
        eprintln!("startup histories={count} elapsed={:?}", started.elapsed());
        let store = state.store.lock().await;
        let output = std::env::var("ARCHON_BENCHMARK_OUTPUT").unwrap();
        std::fs::write(output, serde_json::to_vec(&store.data.dids).unwrap()).unwrap();
    }

    #[tokio::test]
    async fn shared_predecessor_validation_precedes_direct_writes_and_preserves_recovery() {
        let vector: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/transition-predecessor-vectors.json"
        )).unwrap();
        let did = vector["did"].as_str().unwrap();
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory, data: JsonDbFile::default(), redis_connection: None,
        });
        crate::events::handle_did_operation(&state, &vector["create"]).await.unwrap();
        let before = serde_json::to_value(&state.store.lock().await.data).unwrap();
        for case in vector["cases"].as_array().unwrap() {
            let error = crate::events::handle_did_operation(&state, &case["operation"])
                .await.unwrap_err();
            assert!(error.contains("previd"), "{}: {error}", case["name"]);
            assert_eq!(serde_json::to_value(&state.store.lock().await.data).unwrap(), before);
        }
        crate::events::handle_did_operation(&state, &vector["valid"]).await.unwrap();
        assert!(crate::events::handle_did_operation(&state, &vector["valid"])
            .await.unwrap_err().contains("previd"));

        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory, data: JsonDbFile::default(), redis_connection: None,
        });
        for name in ["create", "successor", "valid"] {
            let event = crate::value_to_event_record(&json!({
                "operation": vector[name], "registry": "hyperswarm",
                "time": vector[name]["proof"]["created"],
            }));
            crate::events::import_event_impl(&state, event).await;
        }
        *state.history_ready.lock().await = false;
        ensure_history_ready(&state).await.unwrap();
        let doc = crate::resolve_local_doc_async(&state, did, crate::ResolveOptions {
            verify: true, ..crate::ResolveOptions::default()
        }).await.unwrap();
        assert_eq!(doc["didDocumentData"], json!({"version": 3}));
    }

    fn numeric_predecessor_fixture() -> (Value, Vec<EventRecord>) {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/numeric-predecessor-vectors.json"
        ))
        .unwrap();
        let events = ["agent", "update", "successor"].into_iter().map(|name| {
            assert_eq!(generate_json_cid(&v[name]).unwrap(), v["cids"][name]["rust"]);
            if let Some(cid) = crate::proofs::typescript_numeric_cid(&v[name]) {
                assert_eq!(cid, v["cids"][name]["typescript"]);
            }
            crate::value_to_event_record(&json!({
                "operation": v[name], "registry": "hyperswarm", "time": v[name]["proof"]["created"],
                "did": v["did"], "opid": v["cids"][name]["rust"]
            }))
        }).collect();
        (v, events)
    }

    #[tokio::test]
    async fn numeric_predecessor_import_recovers_in_both_orders_and_deduplicates() {
        let (v, events) = numeric_predecessor_fixture();
        let did = v["did"].as_str().unwrap();
        for order in [[0, 1, 2], [0, 2, 1]] {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for index in order {
                crate::events::import_event_impl(&state, events[index].clone()).await;
            }
            let doc = crate::resolve_local_doc_async(
                &state,
                did,
                crate::ResolveOptions {
                    verify: true,
                    ..crate::ResolveOptions::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(doc["didDocumentData"], json!({"recovered": true}));
            // A claimed opid must never poison another operation's cache entry.
            let mut duplicate = events[1].clone();
            duplicate.opid = events[0].opid.clone();
            assert!(matches!(
                crate::events::import_event_impl(&state, duplicate).await,
                crate::events::ImportStatus::Merged
            ));
            let store = state.store.lock().await;
            assert_eq!(store.get_events(did).len(), 3);
            assert_eq!(
                store.get_operation(events[0].opid.as_ref().unwrap()),
                Some(v["agent"].clone())
            );
            assert_eq!(
                store.get_events(did)[2].operation["previd"],
                v["cids"]["update"]["typescript"]
            );
        }
    }

    #[tokio::test]
    async fn numeric_predecessor_startup_repairs_missing_alias_and_survives_restart() {
        let (v, events) = numeric_predecessor_fixture();
        let did = v["did"].as_str().unwrap();
        let alias = v["cids"]["update"]["typescript"].as_str().unwrap();
        let mut data = JsonDbFile::default();
        data.dids.insert(
            did.rsplit(':').next().unwrap().to_string(),
            events[..2].to_vec(),
        );
        data.candidates.insert(did.to_string(), events.clone());
        for event in &events[..2] {
            data.ops
                .insert(event.opid.clone().unwrap(), event.operation.clone());
        }
        assert!(!data.ops.contains_key(alias));
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data,
            redis_connection: None,
        });
        ensure_history_ready(&state).await.unwrap();
        let doc = crate::resolve_local_doc_async(
            &state,
            did,
            crate::ResolveOptions {
                verify: true,
                ..crate::ResolveOptions::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(doc["didDocumentData"], json!({"recovered": true}));
        let before = serde_json::to_value(&state.store.lock().await.data).unwrap();
        let repaired: JsonDbFile = serde_json::from_value(before.clone()).unwrap();
        assert_eq!(repaired.ops.get(alias), Some(&v["update"]));
        let (restarted, _restart_dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: repaired,
            redis_connection: None,
        });
        ensure_history_ready(&restarted).await.unwrap();
        assert_eq!(
            serde_json::to_value(&restarted.store.lock().await.data).unwrap(),
            before
        );
    }

    #[tokio::test]
    async fn hyperswarm_imports_microsecond_proof_times() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/hyperswarm-time-vectors.json"
        ))
        .unwrap();
        let v = vectors
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["legacy"] == true)
            .unwrap();
        let mut rotation = v["controllerRotation"].clone();
        rotation["proof"]["created"] = json!("2026-09-04T00:51:32.807411Z");
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        ensure_history_ready(&state).await.unwrap();
        for operation in [&v["agent"], &rotation] {
            let status = crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
                "operation": operation, "registry": "hyperswarm", "time": "2026-09-04T00:51:32.083Z"
            }))).await;
            assert!(matches!(status, crate::events::ImportStatus::Added));
        }
        for (cutoff, sequence) in [
            ("2026-09-04T00:51:32.806999Z", "1"),
            ("2026-09-04T00:51:32.807Z", "2"),
            ("2026-09-03T20:51:32.807-04:00", "2"),
        ] {
            let doc = crate::resolve_local_doc_async(
                &state,
                v["controller"].as_str().unwrap(),
                crate::ResolveOptions {
                    version_time: Some(cutoff.to_string()),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
            assert_eq!(doc["didDocumentMetadata"]["versionSequence"], sequence);
        }
    }

    #[tokio::test]
    async fn hyperswarm_recovery_repairs_candidates_and_old_http_envelopes() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/hyperswarm-time-vectors.json"
        ))
        .unwrap();
        for v in vectors.as_array().unwrap() {
            let controller = v["controller"].as_str().unwrap();
            let asset = v["asset"].as_str().unwrap();
            let old: Vec<EventRecord> = ["agent", "controllerDelete"]
                .iter()
                .map(|name| {
                    crate::value_to_event_record(&json!({
                        "operation": v[name], "did": controller, "registry": "hyperswarm",
                        "opid": generate_json_cid(&v[name]).unwrap(),
                        "time": "2026-09-04T00:51:32.083Z", "ordinal": [42]
                    }))
                })
                .collect();
            let mut db = JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            };
            db.set_events(controller, old.clone()).unwrap();
            db.set_candidates(controller, old.clone()).unwrap();
            let (state, _dir) = crate::tests::make_state(db);
            ensure_history_ready(&state).await.unwrap();
            let incoming: Vec<Value> = ["assetCreate", "assetUpdate", "assetDelete"].iter().map(|name| json!({
                "operation": v[name], "registry": "BTC:signet", "registration": { "height": 42 },
                "time": "2026-09-17T17:53:05.466Z"
            })).collect();
            crate::events::import_batch_impl(&state, &crate::event_policy::relay_hints(&incoming)).await;
            crate::events::process_events_impl(&state).await;
            let doc = crate::resolve_local_doc_async(&state, asset, Default::default())
                .await
                .unwrap();
            assert_eq!(doc["didDocumentMetadata"]["deactivated"], true);
            for event in old {
                crate::events::import_event_impl(&state, event).await;
            }
            let repaired: JsonDbFile = serde_json::from_value(
                serde_json::to_value(&state.store.lock().await.data).unwrap(),
            )
            .unwrap();
            let (restarted, _dir2) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: repaired,
                redis_connection: None,
            });
            ensure_history_ready(&restarted).await.unwrap();
            let store = restarted.store.lock().await;
            let candidates = store.get_candidates().unwrap();
            assert_eq!(candidates[controller].len(), 2);
            for event in candidates[controller]
                .iter()
                .chain(store.get_events(controller).iter())
            {
                assert_eq!(
                    event.time,
                    event.operation["proof"]["created"].as_str().unwrap()
                );
                assert_eq!(event.ordinal, Some(vec![42]));
            }
        }
    }

    #[tokio::test]
    async fn hyperswarm_proof_time_is_independent_of_receipts_and_arrival_order() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/hyperswarm-time-vectors.json"
        ))
        .unwrap();
        for v in vectors.as_array().unwrap() {
            for scenario in ["deletion", "rotation", "late-deletion"] {
                for time in ["2026-09-04T00:51:32.083Z", "2026-09-17T17:53:05.466Z"] {
                    for order in ["controller-first", "asset-first", "reverse", "direct"] {
                        let wrap = |op: &Value| {
                            crate::value_to_event_record(&json!({
                                "operation": op, "registry": "hyperswarm", "time": time
                            }))
                        };
                        let (state, _dir) = crate::tests::make_state(JsonDb {
                            backend: DbBackend::Memory,
                            data: JsonDbFile::default(),
                            redis_connection: None,
                        });
                        ensure_history_ready(&state).await.unwrap();
                        let controllers = vec![
                            &v["agent"],
                            &v[if scenario == "rotation" {
                                "controllerRotation"
                            } else {
                                "controllerDelete"
                            }],
                        ];
                        let assets = vec![
                            &v["assetCreate"],
                            &v["assetUpdate"],
                            &v[if scenario == "deletion" {
                                "assetDelete"
                            } else if scenario == "rotation" {
                                "afterRotation"
                            } else {
                                "lateAssetDelete"
                            }],
                        ];
                        if order == "direct" {
                            for op in controllers {
                                crate::events::import_event_impl(&state, wrap(op)).await;
                            }
                            for op in &assets {
                                assert_eq!(
                                    crate::events::handle_did_operation(&state, op)
                                        .await
                                        .is_ok(),
                                    *op != &v["lateAssetDelete"]
                                );
                            }
                            for op in assets {
                                crate::events::import_event_impl(&state, wrap(op)).await;
                            }
                        } else {
                            let mut ops = if order == "asset-first" {
                                [assets, controllers].concat()
                            } else {
                                [controllers, assets].concat()
                            };
                            if order == "reverse" {
                                ops.reverse();
                            }
                            for op in ops {
                                crate::events::import_event_impl(&state, wrap(op)).await;
                            }
                        }
                        let data: JsonDbFile = serde_json::from_value(
                            serde_json::to_value(&state.store.lock().await.data).unwrap(),
                        )
                        .unwrap();
                        let (restarted, _restart_dir) = crate::tests::make_state(JsonDb {
                            backend: DbBackend::Memory,
                            data,
                            redis_connection: None,
                        });
                        let controller = v["controller"].as_str().unwrap();
                        let asset = v["asset"].as_str().unwrap();
                        for current in [&state, &restarted] {
                            ensure_history_ready(current).await.unwrap();
                            for verify in [false, true] {
                                for (cutoff, sequence) in [
                                    ("2026-09-04T00:51:32.806Z", "1"),
                                    ("2026-09-04T00:51:32.807Z", "2"),
                                    ("2026-09-03T20:51:32.807-04:00", "2"),
                                ] {
                                    let doc = crate::resolve_local_doc_async(
                                        current,
                                        controller,
                                        crate::ResolveOptions {
                                            version_time: Some(cutoff.to_string()),
                                            confirm: true,
                                            verify,
                                            ..Default::default()
                                        },
                                    )
                                    .await
                                    .unwrap();
                                    assert_eq!(
                                        doc["didDocumentMetadata"]["versionSequence"], sequence,
                                        "{scenario}/{order}/{time}"
                                    );
                                    assert_eq!(
                                        doc["didDocumentMetadata"]["deactivated"]
                                            .as_bool()
                                            .unwrap_or(false),
                                        sequence == "2" && scenario != "rotation"
                                    );
                                }
                                let doc = crate::resolve_local_doc_async(
                                    current,
                                    asset,
                                    crate::ResolveOptions {
                                        version_time: Some("2026-09-04T00:51:32.400Z".to_string()),
                                        confirm: true,
                                        verify,
                                        ..Default::default()
                                    },
                                )
                                .await
                                .unwrap();
                                assert_eq!(doc["didDocumentMetadata"]["versionSequence"], "2");
                                assert_eq!(
                                    doc["didDocumentMetadata"]["updated"],
                                    "2026-09-04T00:51:32Z"
                                );
                                let latest = crate::resolve_local_doc_async(
                                    current,
                                    asset,
                                    crate::ResolveOptions {
                                        confirm: true,
                                        verify,
                                        ..Default::default()
                                    },
                                )
                                .await
                                .unwrap();
                                assert_eq!(
                                    latest["didDocumentMetadata"]["versionSequence"],
                                    if scenario == "late-deletion" {
                                        "2"
                                    } else {
                                        "3"
                                    }
                                );
                                assert_eq!(
                                    latest["didDocumentMetadata"]["deactivated"]
                                        .as_bool()
                                        .unwrap_or(false),
                                    scenario == "deletion"
                                );
                                if scenario == "deletion" {
                                    assert_eq!(
                                        latest["didDocumentMetadata"]["deleted"],
                                        "2026-09-04T00:51:32Z"
                                    );
                                } else {
                                    assert_eq!(
                                        latest["didDocumentData"],
                                        json!({"state": if scenario == "rotation" { "rotated" } else { "updated" }})
                                    );
                                }
                            }
                        }
                        let store = state.store.lock().await;
                        for event in &store.data.dids[controller.rsplit(':').next().unwrap()] {
                            assert_eq!(event.time, event.operation["proof"]["created"].as_str().unwrap());
                        }
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn hyperswarm_proof_time_accepts_existing_leap_second_grammar() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/hyperswarm-time-vectors.json"
        ))
        .unwrap();
        for v in vectors.as_array().unwrap() {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            ensure_history_ready(&state).await.unwrap();
            for name in ["agent", "leapRotation"] {
                crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
                        "operation": v[name], "registry": "hyperswarm", "time": "2026-09-17T17:53:05.466Z"
                    }))).await;
            }
            for verify in [false, true] {
                for (cutoff, sequence) in [
                    ("2026-09-04T00:51:59.999Z", "1"),
                    ("2026-09-04T00:52:00Z", "2"),
                ] {
                    let doc = crate::resolve_local_doc_async(
                        &state,
                        v["controller"].as_str().unwrap(),
                        crate::ResolveOptions {
                            version_time: Some(cutoff.to_string()),
                            verify,
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                    assert_eq!(doc["didDocumentMetadata"]["versionSequence"], sequence);
                    if sequence == "2" {
                        assert_eq!(
                            doc["didDocumentMetadata"]["updated"],
                            "2026-09-04T00:51:60Z"
                        );
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn hyperswarm_proof_time_preserves_predecessor_prefix() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/hyperswarm-time-vectors.json"
        ))
        .unwrap();
        for v in vectors.as_array().unwrap() {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            ensure_history_ready(&state).await.unwrap();
            for name in ["backdatedSuccessor", "controllerRotation", "agent"] {
                crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
                        "operation": v[name], "registry": "hyperswarm", "time": "2026-09-04T00:51:32.083Z"
                    }))).await;
            }
            for verify in [false, true] {
                for (cutoff, sequence) in [
                    ("2026-09-04T00:51:32.600Z", "1"),
                    ("2026-09-04T00:51:32.807Z", "3"),
                ] {
                    let doc = crate::resolve_local_doc_async(
                        &state,
                        v["controller"].as_str().unwrap(),
                        crate::ResolveOptions {
                            version_time: Some(cutoff.to_string()),
                            verify,
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                    assert_eq!(doc["didDocumentMetadata"]["versionSequence"], sequence);
                }
            }
        }
    }

    #[tokio::test]
    async fn operation_size_v1_covers_submission_import_and_restart() {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/operation-size-v1-vectors.json"
        ))
        .unwrap();
        let wrap = |operation: &Value| {
            crate::value_to_event_record(&json!({
                "operation": operation, "registry": "hyperswarm", "time": operation["proof"]["created"]
            }))
        };
        for case in v["cases"].as_array().unwrap() {
            let operation = crate::proofs::expand_size_vector(case);
            let create = operation["type"] == "create";
            let agent = &v["agent"];
            let target = if create {
                format!("did:cid:{}", generate_json_cid(&operation).unwrap())
            } else {
                v["did"].as_str().unwrap().to_string()
            };
            let did = target.as_str();
            let accepted = case["accepted"].as_bool().unwrap();
            for mode in ["direct", "import", "replay"] {
                let (state, _dir) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data: JsonDbFile::default(),
                    redis_connection: None,
                });
                if mode == "direct" {
                    state
                        .supported_registries
                        .lock()
                        .await
                        .push("BTC:signet".to_string());
                }
                ensure_history_ready(&state).await.unwrap();
                if mode == "direct" {
                    if !create {
                        crate::events::handle_did_operation(&state, agent)
                            .await
                            .unwrap();
                    }
                    let before = serde_json::to_value(&state.store.lock().await.data).unwrap();
                    assert_eq!(
                        crate::events::handle_did_operation(&state, &operation)
                            .await
                            .is_ok(),
                        accepted,
                        "{}",
                        case["name"]
                    );
                    if !accepted {
                        assert_eq!(
                            serde_json::to_value(&state.store.lock().await.data).unwrap(),
                            before
                        );
                    }
                } else if mode == "import" {
                    if !create {
                        crate::events::import_event_impl(&state, wrap(agent)).await;
                    }
                    let batch = vec![crate::event_record_to_value(&wrap(&operation))];
                    let result = crate::events::import_batch_impl(&state, &batch).await;
                    assert_eq!(result.queued, usize::from(accepted), "{}", case["name"]);
                    assert_eq!(result.rejected, usize::from(!accepted), "{}", case["name"]);
                    let processed = crate::events::process_events_impl(&state).await;
                    assert_eq!(processed.added.unwrap_or(0), usize::from(accepted));
                }
                if mode == "replay" {
                    let operations = if create {
                        vec![&operation]
                    } else {
                        vec![agent, &operation]
                    };
                    let events: Vec<_> = operations
                        .into_iter()
                        .map(|op| {
                            let mut event = wrap(op);
                            event.opid = Some(generate_json_cid(op).unwrap());
                            event
                        })
                        .collect();
                    let mut store = state.store.lock().await;
                    store
                        .data
                        .dids
                        .insert(did.rsplit(':').next().unwrap().to_string(), events.clone());
                    store.data.candidates.insert(did.to_string(), events);
                }
                let data: JsonDbFile = serde_json::from_value(
                    serde_json::to_value(&state.store.lock().await.data).unwrap(),
                )
                .unwrap();
                let (restarted, _restart_dir) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data,
                    redis_connection: None,
                });
                let states = if mode == "replay" {
                    vec![&restarted]
                } else {
                    vec![&state, &restarted]
                };
                for current in states {
                    ensure_history_ready(current).await.unwrap();
                    for verify in [false, true] {
                        let result = crate::resolve_local_doc_async(
                            current,
                            did,
                            crate::ResolveOptions {
                                verify,
                                ..crate::ResolveOptions::default()
                            },
                        )
                        .await;
                        if create && !accepted {
                            assert!(result.is_err(), "{}", case["name"]);
                            continue;
                        }
                        let doc = result.unwrap();
                        assert_eq!(
                            doc["didDocumentMetadata"]["versionSequence"],
                            if create || !accepted { "1" } else { "2" },
                            "{}",
                            case["name"]
                        );
                        assert_eq!(
                            doc["didDocumentMetadata"]["deactivated"]
                                .as_bool()
                                .unwrap_or(false),
                            accepted && operation["type"] == "delete"
                        );
                    }
                }
            }
        }
    }

    #[tokio::test]
    async fn registration_v1_validation_covers_submission_import_and_restart() {
        let v: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/registration-transition-v1-vectors.json"
        ))
        .unwrap();
        let wrap = |operation: &Value| {
            crate::value_to_event_record(&json!({
                "operation": operation, "registry": "hyperswarm", "time": operation["proof"]["created"]
            }))
        };
        for case in v["cases"].as_array().unwrap() {
            let agent = case.get("agent").unwrap_or(&v["agent"]);
            let did = case.get("did").unwrap_or(&v["did"]).as_str().unwrap();
            let accepted = case["accepted"].as_bool().unwrap();
            for mode in ["direct", "import", "replay"] {
                let (state, _dir) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data: JsonDbFile::default(),
                    redis_connection: None,
                });
                if mode == "direct" {
                    state
                        .supported_registries
                        .lock()
                        .await
                        .push("BTC:signet".to_string());
                }
                ensure_history_ready(&state).await.unwrap();
                if mode == "direct" {
                    crate::events::handle_did_operation(&state, agent)
                        .await
                        .unwrap();
                    let before = serde_json::to_value(&state.store.lock().await.data).unwrap();
                    assert_eq!(
                        crate::events::handle_did_operation(&state, &case["operation"])
                            .await
                            .is_ok(),
                        accepted,
                        "{}",
                        case["name"]
                    );
                    if !accepted {
                        assert_eq!(
                            serde_json::to_value(&state.store.lock().await.data).unwrap(),
                            before
                        );
                    }
                } else if mode == "import" {
                    crate::events::import_event_impl(&state, wrap(agent)).await;
                    let status =
                        crate::events::import_event_impl(&state, wrap(&case["operation"])).await;
                    assert!(
                        match status {
                            crate::events::ImportStatus::Added => accepted,
                            crate::events::ImportStatus::Rejected => !accepted,
                            _ => false,
                        },
                        "{}",
                        case["name"]
                    );
                }
                if mode == "replay" {
                    let events: Vec<_> = [agent, &case["operation"]]
                        .into_iter()
                        .map(|op| {
                            let mut event = wrap(op);
                            event.opid = Some(generate_json_cid(op).unwrap());
                            event
                        })
                        .collect();
                    let mut store = state.store.lock().await;
                    store
                        .data
                        .dids
                        .insert(did.rsplit(':').next().unwrap().to_string(), events.clone());
                    store.data.candidates.insert(did.to_string(), events);
                }
                let data: JsonDbFile = serde_json::from_value(
                    serde_json::to_value(&state.store.lock().await.data).unwrap(),
                )
                .unwrap();
                let (restarted, _restart_dir) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data,
                    redis_connection: None,
                });
                let states = if mode == "replay" {
                    vec![&restarted]
                } else {
                    vec![&state, &restarted]
                };
                for current in states {
                    ensure_history_ready(current).await.unwrap();
                    for verify in [false, true] {
                        let doc = crate::resolve_local_doc_async(
                            current,
                            did,
                            crate::ResolveOptions {
                                verify,
                                ..crate::ResolveOptions::default()
                            },
                        )
                        .await
                        .unwrap();
                        assert_eq!(doc["didDocument"]["id"], did);
                        assert_eq!(
                            doc["didDocumentRegistration"], case["expectedRegistration"],
                            "{}",
                            case["name"]
                        );
                        assert_eq!(
                            doc["didDocumentMetadata"]["versionSequence"],
                            if accepted { "2" } else { "1" }
                        );
                    }
                }
            }
        }
        for operation in v["invalidGenesis"].as_array().unwrap() {
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            ensure_history_ready(&state).await.unwrap();
            let before = serde_json::to_value(&state.store.lock().await.data).unwrap();
            assert!(crate::events::handle_did_operation(&state, operation)
                .await
                .is_err());
            assert_eq!(
                serde_json::to_value(&state.store.lock().await.data).unwrap(),
                before
            );
            let status = crate::events::import_event_impl(&state, wrap(operation)).await;
            // Malformed-string exceptions retain existing retry classification (#1178).
            assert!(matches!(
                status,
                crate::events::ImportStatus::Rejected | crate::events::ImportStatus::Deferred
            ));
            assert!(state.store.lock().await.data.dids.is_empty());
        }
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        assert!(
            crate::events::handle_did_operation(&state, &v["unsupportedGenesis"])
                .await
                .is_err()
        );
        assert!(!crate::verify_event_shape(&crate::event_record_to_value(
            &wrap(&v["unsupportedGenesis"])
        )));
        assert!(state
            .store
            .lock()
            .await
            .list_dids(&state.config.did_prefix, None)
            .is_empty());
    }

    fn identity_fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/operation-identity-vectors.json"
        ))
        .unwrap()
    }

    fn identity_event(operation: &Value, height: u64) -> EventRecord {
        crate::value_to_event_record(&json!({
            "operation": operation, "registry": "BTC:signet", "time": "2026-04-11T13:00:00Z",
            "ordinal": [height, 0, 0], "registration": {"height": height, "index": 0, "opidx": 0, "txid": "tx", "batch": "batch"}
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
        late["ordinal"] = json!([350, 0, 0]);
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
    async fn startup_views_match_published_histories_and_runtime_updates() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/hyperswarm-time-vectors.json"
        ))
        .unwrap();
        let v = &vectors[0]; // Legacy proof timestamps can be changed without resigning.
        let controller = v["controller"].as_str().unwrap();
        let asset = v["asset"].as_str().unwrap();
        let (state, _dir) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        ensure_history_ready(&state).await.unwrap();
        for name in ["agent", "assetCreate", "assetUpdate", "controllerDelete"] {
            crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
                "operation": v[name], "registry": "hyperswarm", "time": v[name]["proof"]["created"]
            }))).await;
        }
        // A real signed create after controller deletion remains candidate-only.
        let mut rejected = v["assetCreate"].clone();
        rejected["proof"]["created"] = json!("2026-09-05T00:00:00Z");
        crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
            "operation": rejected, "registry": "hyperswarm", "time": rejected["proof"]["created"]
        }))).await;
        assert_eq!(state.store.lock().await.get_candidates().unwrap().len(), 3);
        // Only the controller needs envelope repair; unchanged asset data must
        // still appear in the complete startup index.
        {
            let mut store = state.store.lock().await;
            let mut candidates = store.get_candidates().unwrap()[controller].clone();
            for event in &mut candidates {
                event.time = "2026-09-17T00:00:00Z".to_string();
            }
            store
                .set_candidates(controller, candidates.clone())
                .unwrap();
            store.set_events(controller, candidates).unwrap();
        }
        for _ in 0..2 {
            *state.history_ready.lock().await = false;
            *state.candidate_history.lock().await = None;
            state.dependents.lock().await.clear();
            state.search_index.lock().await.clear();
            ensure_history_ready(&state).await.unwrap();
            let cached = state.status_snapshot.lock().await.clone().unwrap();
            assert_eq!(cached.total, 2);
            assert_eq!(cached.by_type.invalid, 0);
            let actual = crate::resolver::check_dids_impl(&state, None, false).await;
            assert_eq!(
                serde_json::to_value(cached).unwrap(),
                serde_json::to_value(actual).unwrap()
            );
            assert_eq!(state.search_index.lock().await.size(), 2);
            let query = json!({"state": {"$in": ["updated"]}});
            assert_eq!(
                crate::query_docs_impl(&state, &query).await.unwrap(),
                vec![asset.to_string()]
            );
            let before = state.search_index.lock().await.search_docs("updated");
            crate::build_search_index(&state).await;
            assert_eq!(
                before,
                state.search_index.lock().await.search_docs("updated")
            );
        }
        // Import-time reconciliation still removes stale searchable content.
        crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
            "operation": v["assetDelete"], "registry": "hyperswarm", "time": v["assetDelete"]["proof"]["created"]
        }))).await;
        assert!(state
            .search_index
            .lock()
            .await
            .search_docs("updated")
            .is_empty());
        assert!(state.status_snapshot.lock().await.is_none());
        remove_histories(&state, &[controller.to_string()])
            .await
            .unwrap();
        assert_eq!(state.search_index.lock().await.size(), 0);
    }

    #[tokio::test]
    async fn canonical_startup_does_not_rewrite_unchanged_storage() {
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/history-recovery-vectors.json"
        )).unwrap();
        let (state, directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        for vector in &vectors {
            for event in vector["base"].as_array().unwrap() {
                crate::events::import_event_impl(&state, serde_json::from_value(event.clone()).unwrap()).await;
            }
        }
        // Complete one recovery so all persisted events have canonical metadata.
        *state.history_ready.lock().await = false;
        *state.candidate_history.lock().await = None;
        ensure_history_ready(&state).await.unwrap();
        let before = {
            let mut store = state.store.lock().await;
            let before = serde_json::to_value(&store.data).unwrap();
            // Writing to a directory fails; an unchanged restart must not write.
            store.backend = DbBackend::JsonFile { path: directory.path().to_path_buf() };
            before
        };
        *state.history_ready.lock().await = false;
        *state.candidate_history.lock().await = None;
        state.dependents.lock().await.clear();
        ensure_history_ready(&state).await.unwrap();
        assert_eq!(serde_json::to_value(&state.store.lock().await.data).unwrap(), before);
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
    #[tokio::test]
    async fn signed_jcs_generation_import_and_restart() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/canonicalization-vectors.json"
        )).unwrap();
        for v in vectors["signed"].as_array().unwrap() {
            let operations = v["operations"].as_array().unwrap();
            let did = v["did"].as_str().unwrap();
            for (index, operation) in operations.iter().enumerate() {
                assert_eq!(generate_json_cid(operation).unwrap(), v["cids"][index]);
            }
            let (direct, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory, data: JsonDbFile::default(), redis_connection: None,
            });
            for op in operations {
                crate::events::handle_did_operation(&direct, op).await.unwrap();
            }
            let (state, _dir) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory, data: JsonDbFile::default(), redis_connection: None,
            });
            for index in [2, 1, 0] {
                let op = &operations[index];
                crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
                    "operation": op, "registry": "hyperswarm", "time": op["proof"]["created"]
                }))).await;
            }
            *state.history_ready.lock().await = false;
            *state.candidate_history.lock().await = None;
            ensure_history_ready(&state).await.unwrap();
            let doc = crate::resolve_local_doc_async(&state, did, crate::ResolveOptions {
                verify: true, ..Default::default()
            }).await.unwrap();
            assert_eq!(doc["didDocumentData"], operations[2]["doc"]["didDocumentData"]);
            assert_eq!(doc["didDocumentMetadata"]["versionId"], v["cids"][2]);
            let op = &operations[3];
            crate::events::import_event_impl(&state, crate::value_to_event_record(&json!({
                "operation": op, "registry": "hyperswarm", "time": op["proof"]["created"]
            }))).await;
            let doc = crate::resolve_local_doc_async(&state, did, crate::ResolveOptions {
                verify: true, ..Default::default()
            }).await.unwrap();
            assert_eq!(doc["didDocumentMetadata"]["deactivated"], true);
        }
    }

}
