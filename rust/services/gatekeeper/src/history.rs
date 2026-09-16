//! Durable candidate evidence and import-time revalidation of dependent histories.
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::Result;
use serde_json::json;
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
                    if event.opid.is_none() {
                        event.opid = Some(generate_json_cid(&event.operation)?);
                    }
                }
                store.set_candidates(&current, events.clone())?;
                candidates.insert(current, events);
            }
        }
        for (key, events) in &candidates {
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
        if event.opid.is_none() {
            event.opid = Some(generate_json_cid(&event.operation)?);
        }
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

// A repeated projection is unresolved evidence, not a node-wide readiness error.
// Track every state in the cycle so stable neighbors keep their projections.
#[derive(Default)]
struct ReplayCycles {
    snapshots: Vec<Vec<String>>,
}
impl ReplayCycles {
    fn observe(&mut self, state: Vec<String>) -> Option<Vec<usize>> {
        if let Some(cycle) = self
            .snapshots
            .iter()
            .position(|previous| previous == &state)
        {
            let varying = (0..state.len())
                .filter(|&index| {
                    self.snapshots[cycle..]
                        .iter()
                        .any(|previous| previous[index] != state[index])
                })
                .collect();
            self.snapshots.clear();
            Some(varying)
        } else {
            self.snapshots.push(state);
            None
        }
    }
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
    let mut cycles = ReplayCycles::default();
    let mut unresolved = HashSet::new();
    loop {
        let before = snapshot(&replay, &targets).await?;
        if let Some(varying) = cycles.observe(before.clone()) {
            for index in varying {
                unresolved.insert(targets[index].clone());
            }
            for target in &targets {
                replay.store.lock().await.set_events(target, Vec::new())?;
            }
            continue;
        }
        for target in &targets {
            if unresolved.contains(target) {
                continue;
            }
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
            let mut seen = HashSet::new();
            loop {
                let previous =
                    serde_json::to_string(&replay.store.lock().await.get_events(target))?;
                if !seen.insert(previous.clone()) {
                    unresolved.insert(target.clone());
                    replay.store.lock().await.set_events(target, Vec::new())?;
                    break;
                }
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

    #[test]
    fn cycles_isolate_only_histories_that_vary_and_can_be_retried() {
        let mut cycles = ReplayCycles::default();
        let state = |a: &str, b: &str| vec![a.to_string(), b.to_string(), "stable".to_string()];
        assert_eq!(cycles.observe(state("empty", "empty")), None);
        assert_eq!(cycles.observe(state("A", "B")), None);
        assert_eq!(cycles.observe(state("B", "A")), None);
        assert_eq!(cycles.observe(state("A", "B")), Some(vec![0, 1]));
        assert_eq!(cycles.observe(state("empty", "empty")), None);
        assert_eq!(cycles.observe(state("resolved", "resolved")), None);
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
            assert_eq!(state.store.lock().await.get_events(child).len(), 2);
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
            let result = crate::verify_db_impl(&state, false).await;
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
                                "early" | "delegation" => 2,
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
