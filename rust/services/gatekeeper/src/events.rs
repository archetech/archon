use crate::event_policy::{candidate_key, normalize_event_time, queue_key};
use std::{cmp::Ordering, env};

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use tracing::{info, warn};

use crate::store::compare_ordinals;
use crate::{
    authorize_operation, ensure_event_opid, event_record_to_value, expected_registry_for_index,
    generate_did_from_operation, generate_json_cid, infer_event_did, is_unanchored_registry,
    resolve_local_doc_async, update_search_doc, value_to_event_record,
    verify_event_shape, AppState, EventRecord, GatekeeperDb, ResolveOptions,
};

// Compare authorized siblings of one predecessor; Less means a wins.
// Chain ordinals and canonical opids have already passed admission.
// Same-operation receipt replacement stays in its separate importer branch.
fn compare_successors(expected_registry: Option<&str>, a: &EventRecord, b: &EventRecord) -> Ordering {
    let chain = expected_registry.filter(|registry| !is_unanchored_registry(registry));
    let a_anchored = chain == Some(a.registry.as_str());
    let b_anchored = chain == Some(b.registry.as_str());
    if a_anchored != b_anchored {
        return b_anchored.cmp(&a_anchored);
    }
    let ordinal = if a_anchored {
        compare_ordinals(a.ordinal.as_ref(), b.ordinal.as_ref())
    } else {
        Ordering::Equal
    };
    ordinal.then_with(|| a.opid.cmp(&b.opid))
}

const PIN_QUEUE: &str = "pin";

#[derive(Serialize)]
pub(crate) struct ImportBatchResult {
    pub(crate) queued: usize,
    pub(crate) processed: usize,
    pub(crate) rejected: usize,
    pub(crate) total: usize,
}

#[derive(Serialize)]
pub(crate) struct ImportEventsResult {
    pub(crate) added: usize,
    pub(crate) merged: usize,
    pub(crate) rejected: usize,
}

#[derive(Serialize)]
pub(crate) struct ProcessEventsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) busy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) added: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) merged: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rejected: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) pending: Option<usize>,
    #[serde(rename = "pendingBatches", skip_serializing_if = "Option::is_none")]
    pub(crate) pending_batches: Option<Vec<String>>,
}

pub(crate) enum ImportStatus {
    Added,
    Merged,
    Rejected,
    Deferred,
}

fn import_trace_enabled() -> bool {
    matches!(
        env::var("ARCHON_GATEKEEPER_IMPORT_TRACE").ok().as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES")
    )
}

fn summarize_value_event(event: &Value) -> String {
    let registry = event
        .get("registry")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let did = event.get("did").and_then(Value::as_str).unwrap_or("-");
    let op_type = event
        .get("operation")
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let opid = event.get("opid").and_then(Value::as_str).unwrap_or("-");
    let previd = event
        .get("operation")
        .and_then(|value| value.get("previd"))
        .and_then(Value::as_str)
        .unwrap_or("-");
    let ordinal = event
        .get("ordinal")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_u64)
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join(".")
        })
        .unwrap_or_else(|| "-".to_string());
    format!(
        "registry={registry} did={did} type={op_type} opid={opid} previd={previd} ordinal={ordinal}"
    )
}

fn summarize_record_event(event: &EventRecord) -> String {
    let op_type = event
        .operation
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let previd = event
        .operation
        .get("previd")
        .and_then(Value::as_str)
        .unwrap_or("-");
    let ordinal = event
        .ordinal
        .as_ref()
        .map(|items| {
            items
                .iter()
                .map(|value| value.to_string())
                .collect::<Vec<_>>()
                .join(".")
        })
        .unwrap_or_else(|| "-".to_string());
    format!(
        "registry={} did={} type={} opid={} previd={} ordinal={}",
        event.registry,
        event.did.as_deref().unwrap_or("-"),
        op_type,
        event.opid.as_deref().unwrap_or("-"),
        previd,
        ordinal
    )
}

pub(crate) async fn handle_did_operation(
    state: &AppState,
    payload: &Value,
) -> Result<Value, String> {
    crate::history::ensure_history_ready(state)
        .await
        .map_err(|error| error.to_string())?;
    let _history_guard = state.history_lock.lock().await;

    let op_type = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing operation.type".to_string())?;

    let valid = authorize_operation(state, payload, None, None)
        .await
        .map_err(|error| error.to_string())?;
    if !valid {
        return Err("Invalid operation: proof".to_string());
    }

    let did = match op_type {
        "create" => generate_did_from_operation(&state.config, payload)
            .map_err(|error| error.to_string())?,
        "update" | "delete" => payload
            .get("did")
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .ok_or_else(|| "missing operation.did".to_string())?,
        _ => return Err(format!("unsupported operation.type={op_type}")),
    };

    let supported_registries = state.supported_registries.lock().await.clone();
    let mut resolved_registry: Option<String> = None;
    let is_ephemeral: bool;
    if op_type == "create" {
        let registry = payload
            .get("registration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
            .ok_or_else(|| "missing operation.registration.registry".to_string())?;
        is_ephemeral = payload
            .get("registration")
            .and_then(|value| value.get("validUntil"))
            .is_some();
        if !supported_registries.iter().any(|item| item == registry) {
            return Err(format!("Invalid operation: registry {registry} not supported"));
        }
    } else {
        let current_info = {
            let store = state.store.lock().await;
            store
                .resolve_doc(&state.config, &did, ResolveOptions::default())
                .ok()
                .and_then(|doc| {
                    let registration = doc.get("didDocumentRegistration")?;
                    let registry = registration.get("registry")?.as_str()?.to_string();
                    Some((registry, registration.get("validUntil").is_some()))
                })
        };

        let (current_registry, current_is_ephemeral) = current_info
            .ok_or_else(|| "Invalid operation: registry missing".to_string())?;
        is_ephemeral = current_is_ephemeral;
        if !supported_registries.iter().any(|item| item == &current_registry) {
            return Err(format!(
                "Invalid operation: registry {current_registry} not supported"
            ));
        }

        let new_registry = payload
            .get("doc")
            .and_then(|value| value.get("didDocumentRegistration"))
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str);
        if let Some(new_registry) = new_registry {
            if new_registry != current_registry
                && !supported_registries.iter().any(|item| item == new_registry)
            {
                return Err(format!(
                    "Invalid operation: registry {new_registry} not supported"
                ));
            }
        }

        resolved_registry = Some(current_registry);
    }

    let opid = generate_json_cid(payload).map_err(|error| error.to_string())?;
    let mut event = EventRecord {
        registry: "local".to_string(),
        time: String::new(),
        ordinal: Some(vec![0]),
        operation: payload.clone(),
        opid: Some(opid),
        did: Some(did.clone()),
        registration: None,
    };

    normalize_event_time(&mut event);

    let queue_registry = if op_type == "create" {
        payload
            .get("registration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    } else {
        resolved_registry
    };

    let result = with_did_lock(state, &did, || async {
        let mut store = state.store.lock().await;
        match op_type {
            "create" => store
                .add_create_event(&did, event)
                .map(Value::String)
                .map_err(|error| error.to_string()),
            "update" | "delete" => store
                .add_followup_event(&did, event)
                .map(Value::Bool)
                .map_err(|error| error.to_string()),
            _ => Err(format!("unsupported operation.type={op_type}")),
        }
    })
    .await?;

    if let Some(registry) = queue_registry {
        let _ = queue_outbound_operation(state, &registry, payload.clone(), is_ephemeral).await;
    }
    // Invalidate the cached status snapshot so the next /status request
    // recomputes DID counts lazily instead of doing a full database scan
    // on every write (which was the dominant cost for dmail creation).
    *state.status_snapshot.lock().await = None;
    update_search_doc(state, &did).await;
    state.verified_dids.lock().await.remove(&did);

    crate::history::reconcile_history(state, &did, false)
        .await
        .map_err(|error| error.to_string())?;
    Ok(result)
}

async fn did_lock(state: &AppState, did: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut locks = state.did_locks.lock().await;
    locks
        .entry(did.to_string())
        .or_insert_with(|| std::sync::Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

async fn with_did_lock<F, Fut, T>(state: &AppState, did: &str, f: F) -> T
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = T>,
{
    let lock = did_lock(state, did).await;
    let _guard = lock.lock().await;
    f().await
}

pub(crate) async fn queue_outbound_operation(
    state: &AppState,
    registry: &str,
    operation: Value,
    skip_pin: bool,
) -> Result<()> {
    if registry == "local" {
        return Ok(());
    }

    let queue_size = {
        let pin_enabled = state
            .supported_registries
            .lock()
            .await
            .iter()
            .any(|item| item == PIN_QUEUE);
        let mut store = state.store.lock().await;
        let _ = store.queue_operation("hyperswarm", operation.clone())?;
        let pin_queue_size = if !skip_pin
            && pin_enabled
            && state.config.pin_registries.iter().any(|item| item == registry)
            && registry != PIN_QUEUE
        {
            Some(store.queue_operation(PIN_QUEUE, operation.clone())?)
        } else {
            None
        };
        if registry != "hyperswarm" {
            (Some(store.queue_operation(registry, operation)?), pin_queue_size)
        } else {
            (None, pin_queue_size)
        }
    };

    if queue_size.0.is_some_and(|size| size >= state.config.max_queue_size) {
        let mut supported = state.supported_registries.lock().await;
        supported.retain(|item| item != registry);
    }
    if queue_size.1.is_some_and(|size| size >= state.config.max_queue_size) {
        let mut supported = state.supported_registries.lock().await;
        supported.retain(|item| item != PIN_QUEUE);
    }

    Ok(())
}

pub(crate) async fn import_batch_impl(state: &AppState, batch: &[Value]) -> ImportBatchResult {
    let mut queued = 0;
    let mut rejected = 0;
    let mut processed = 0;
    let trace = import_trace_enabled();

    // Validate and decode every event outside the mutex critical section so
    // shape checks and JSON cloning don't serialize behind the store lock.
    // TS runs this in a single-threaded JS loop with zero contention; batching
    // the lock acquisition here keeps parity with that cost model.
    let mut accepted: Vec<(String, EventRecord)> = Vec::with_capacity(batch.len());
    for event in batch {
        if !verify_event_shape(event) || infer_event_did(&state.config, event).is_err() {
            if trace {
                warn!("import_batch rejected malformed event {}", summarize_value_event(event));
            }
            rejected += 1;
            continue;
        }

        let Some(key) = queue_key(event) else {
            if trace {
                warn!("import_batch rejected event without key {}", summarize_value_event(event));
            }
            rejected += 1;
            continue;
        };

        accepted.push((key, value_to_event_record(event)));
    }

    let total = {
        let mut seen = state.events_seen.lock().await;
        let mut queue = state.import_queue.lock().await;
        for (key, record) in accepted {
            if seen.contains_key(&key) {
                if trace {
                    info!("import_batch skipped previously seen key={key}");
                }
                processed += 1;
                continue;
            }
            if trace {
                info!("import_batch queued key={key}");
            }
            seen.insert(key, true);
            queue.push(record);
            queued += 1;
        }
        queue.len()
    };

    ImportBatchResult {
        queued,
        processed,
        rejected,
        total,
    }
}

pub(crate) async fn process_events_impl(state: &AppState) -> ProcessEventsResult {
    if let Err(error) = crate::history::ensure_history_ready(state).await {
        warn!("Failed to recover authorization history: {}", error);
        return ProcessEventsResult {
            busy: Some(true),
            added: None,
            merged: None,
            rejected: None,
            pending: None,
            pending_batches: None,
        };
    }
    {
        let mut busy = state.processing_events.lock().await;
        if *busy {
            info!("processEvents: {}", serde_json::json!({ "busy": true }));
            return ProcessEventsResult {
                busy: Some(true),
                added: None,
                merged: None,
                rejected: None,
                pending: None,
                pending_batches: None,
            };
        }
        *busy = true;
    }

    let mut added = 0;
    let mut merged = 0;
    let mut rejected = 0;

    loop {
        let result = import_events_once(state).await;
        added += result.added;
        merged += result.merged;
        rejected += result.rejected;

        if result.added == 0 && result.merged == 0 {
            break;
        }
    }

    let (pending, pending_batches) = {
        let queue = state.import_queue.lock().await;
        let batches: std::collections::BTreeSet<String> = queue
            .iter()
            .filter_map(|event| {
                event.registration.as_ref()?.get("batch")?.as_str().map(str::to_owned)
            })
            .collect();
        let pending_batches = if queue.is_empty() {
            None
        } else {
            Some(batches.into_iter().collect())
        };
        (queue.len(), pending_batches)
    };
    *state.processing_events.lock().await = false;

    let response = ProcessEventsResult {
        busy: None,
        added: Some(added),
        merged: Some(merged),
        rejected: Some(rejected),
        pending: Some(pending),
        pending_batches,
    };
    info!(
        "processEvents: {}",
        serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string())
    );
    response
}

async fn import_events_once(state: &AppState) -> ImportEventsResult {
    let mut temp_queue = std::mem::take(&mut *state.import_queue.lock().await);
    let total = temp_queue.len();

    let mut added = 0;
    let mut merged = 0;
    let mut rejected = 0;
    let trace = import_trace_enabled();

    for (index, event) in temp_queue.drain(..).enumerate() {
        let summary = if trace {
            Some(summarize_record_event(&event))
        } else {
            None
        };
        let did = event_log_did(&state.config, &event);
        let outcome = match import_event_impl(state, event.clone()).await {
            ImportStatus::Added => {
                added += 1;
                info!("import {}/{}: added event for {}", index + 1, total, did);
                "added"
            }
            ImportStatus::Merged => {
                merged += 1;
                info!("import {}/{}: merged event for {}", index + 1, total, did);
                "merged"
            }
            ImportStatus::Rejected => {
                rejected += 1;
                info!("import {}/{}: rejected event for {}", index + 1, total, did);
                "rejected"
            }
            ImportStatus::Deferred => {
                state.import_queue.lock().await.push(event);
                info!("import {}/{}: deferred event for {}", index + 1, total, did);
                "deferred"
            }
        };
        if let Some(summary) = summary.as_deref() {
            info!("process_events outcome={} {}", outcome, summary);
        }
    }

    ImportEventsResult {
        added,
        merged,
        rejected,
    }
}

fn event_log_did(config: &crate::Config, event: &EventRecord) -> String {
    if let Some(did) = event.did.as_ref().filter(|did| !did.is_empty()) {
        return did.clone();
    }
    if let Some(did) = event
        .operation
        .get("did")
        .and_then(Value::as_str)
        .filter(|did| !did.is_empty())
    {
        return did.to_string();
    }

    infer_event_did(config, &event_record_to_value(event)).unwrap_or_default()
}

pub(crate) async fn import_event_impl(state: &AppState, mut event: EventRecord) -> ImportStatus {
    let valid_ordinal = if is_unanchored_registry(&event.registry) {
        event.ordinal.as_ref().is_none_or(|items| {
            items.iter().all(|number| *number <= crate::proofs::MAX_ORDINAL_COMPONENT)
        })
    } else {
        event.ordinal.as_ref().is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|number| *number <= crate::proofs::MAX_ORDINAL_COMPONENT)
        })
    };
    if !valid_ordinal || (!is_unanchored_registry(&event.registry) && !crate::proofs::record_has_chain_metadata(&event)) {
        return ImportStatus::Rejected;
    }
    normalize_event_time(&mut event);
    let _guard = state.history_lock.lock().await;
    let did = match infer_event_did(&state.config, &event_record_to_value(&event)) {
        Ok(did) => did,
        Err(_) => return ImportStatus::Rejected,
    };
    event.did = Some(did.clone());
    event.opid = generate_json_cid(&event.operation).ok();
    let changed = match crate::history::retain_candidates(state, &did, Some(event.clone())).await {
        Ok(changed) => changed,
        Err(error) => {
            warn!("Failed to retain candidate: {}", error);
            return ImportStatus::Deferred;
        }
    };
    let key = candidate_key(&event);
    if let Some(known) = state.candidate_history.lock().await.as_ref()
        .and_then(|candidates| candidates.get(&did))
        .and_then(|events| events.iter().find(|known| candidate_key(known) == key))
    {
        event = known.clone();
    }
    let status = import_event_once(state, event).await;
    // Recovery and evidence changes already replay affected histories. Repeated
    // merged or deferred evidence needs no further reconstruction.
    if !changed && matches!(status, ImportStatus::Merged | ImportStatus::Deferred) && *state.history_ready.lock().await {
        return status;
    }
    if matches!(status, ImportStatus::Added) {
        state.verified_dids.lock().await.remove(&did);
    }
    let reconciled = if matches!(status, ImportStatus::Merged) && *state.history_ready.lock().await {
        crate::history::reconcile_merged_history(state, &did).await
    } else {
        crate::history::reconcile_history(state, &did, true).await
    };
    if let Err(error) = reconciled {
        warn!("Failed to reconcile authorization history: {}", error);
        *state.history_ready.lock().await = false;
        return ImportStatus::Deferred;
    }
    // Publish search state only after authorization replay has settled. The
    // insertion primitive also runs in an isolated replay view, where indexing
    // every intermediate version is unnecessary work.
    if matches!(status, ImportStatus::Added) {
        update_search_doc(state, &did).await;
    }
    let accepted = state
        .store
        .lock()
        .await
        .get_events(&did)
        .iter()
        .any(|event| candidate_key(event) == key);
    if accepted && matches!(status, ImportStatus::Rejected | ImportStatus::Deferred) {
        return ImportStatus::Added;
    }
    if !accepted && matches!(status, ImportStatus::Added) {
        return ImportStatus::Rejected;
    }
    status
}

pub(crate) async fn import_event_once(state: &AppState, event: EventRecord) -> ImportStatus {
    let valid_ordinal = if is_unanchored_registry(&event.registry) {
        event.ordinal.as_ref().is_none_or(|items| {
            items.iter().all(|number| *number <= crate::proofs::MAX_ORDINAL_COMPONENT)
        })
    } else {
        event.ordinal.as_ref().is_some_and(|items| {
            !items.is_empty()
                && items.iter().all(|number| *number <= crate::proofs::MAX_ORDINAL_COMPONENT)
        })
    };
    if !valid_ordinal || (!is_unanchored_registry(&event.registry) && !crate::proofs::record_has_chain_metadata(&event)) {
        return ImportStatus::Rejected;
    }
    let trace = import_trace_enabled();
    let mut event_value = event_record_to_value(&event);
    let did = match infer_event_did(&state.config, &event_value) {
        Ok(did) => did,
        Err(error) => {
            if trace {
                warn!(
                    "process_events rejected reason=infer_event_did error={} {}",
                    error,
                    summarize_record_event(&event)
                );
            }
            return ImportStatus::Rejected;
        }
    };
    event_value["did"] = Value::String(did.clone());
    let opid = match ensure_event_opid(&mut event_value) {
        Ok(opid) => opid,
        Err(error) => {
            if trace {
                warn!(
                    "process_events rejected reason=ensure_event_opid error={} {}",
                    error,
                    summarize_value_event(&event_value)
                );
            }
            return ImportStatus::Rejected;
        }
    };

    let mut event = value_to_event_record(&event_value);
    event.did = Some(did.clone());
    event.opid = Some(opid.clone());

    let result = with_did_lock(state, &did, || async {
        let mut current_events = {
            let store = state.store.lock().await;
            let mut events = store.get_events(&did);
            for current in &mut events {
                if current.opid.is_none() {
                    current.opid = generate_json_cid(&current.operation).ok();
                }
            }
            events
        };

        if let Some(index) = current_events.iter().position(|item| item.opid.as_deref() == Some(&opid)) {
            let expected_registry = expected_registry_for_index(&current_events, index);
            let earlier_anchor = expected_registry.as_deref().is_some_and(|registry| {
                !is_unanchored_registry(registry)
                    && registry == event.registry.as_str()
            }) && compare_ordinals(
                event.ordinal.as_ref(),
                current_events[index].ordinal.as_ref(),
            ).is_lt();
            // A late predecessor can make a later anchor apply first. Earlier
            // anchors still need the predecessor authorization performed below.
            if expected_registry.as_deref() == Some(current_events[index].registry.as_str()) && !earlier_anchor {
                if trace {
                    info!(
                        "process_events merged reason=duplicate_already_confirmed current_registry={} expected_registry={} {}",
                        current_events[index].registry,
                        expected_registry.as_deref().unwrap_or("-"),
                        summarize_record_event(&event)
                    );
                }
                return ImportStatus::Merged;
            }
            if expected_registry.as_deref() == Some(event.registry.as_str()) {
                // Confirming is what first gives the event a position the
                // signer did not choose, so it is where a backdated proof is
                // caught; replacing unchecked would launder an operation
                // accepted at its own claimed `created`. It is verified
                // against the version it chained from, as replay does --
                // resolving at present would judge a self-update by the
                // document it produced.
                let verified = if index == 0 {
                    authorize_operation(state, &event.operation, None, Some(&event)).await
                } else {
                    match resolve_local_doc_async(
                        state,
                        &did,
                        ResolveOptions {
                            version_sequence: Some(index),
                            ..ResolveOptions::default()
                        },
                    )
                    .await
                    {
                        Ok(previous) => {
                            authorize_operation(state, &event.operation, Some(&previous), Some(&event))
                                .await
                        }
                        Err(error) => Err(error),
                    }
                };
                if !matches!(verified, Ok(true)) {
                    if trace {
                        warn!(
                            "process_events rejected reason=confirmation_failed_verification did={} opid={}",
                            did, opid
                        );
                    }
                    return ImportStatus::Rejected;
                }

                current_events[index] = event.clone();
                {
                    let mut store = state.store.lock().await;
                    let _ = store.set_events(&did, current_events);
                }
                if trace {
                    info!(
                        "process_events added reason=replace_with_expected_registry expected_registry={} did={} opid={}",
                        expected_registry.as_deref().unwrap_or("-"),
                        did,
                        opid
                    );
                }
                return ImportStatus::Added;
            }
            if trace {
                info!(
                    "process_events merged reason=duplicate_unexpected_registry current_registry={} event_registry={} expected_registry={} did={} opid={}",
                    current_events[index].registry,
                    event.registry,
                    expected_registry.as_deref().unwrap_or("-"),
                    did,
                    opid
                );
            }
            return ImportStatus::Merged;
        }

        if !current_events.is_empty()
            && event
                .operation
                .get("previd")
                .and_then(Value::as_str)
                .is_none()
        {
            if trace {
                warn!(
                    "process_events rejected reason=missing_previd did={} opid={} current_events={}",
                    did,
                    opid,
                    current_events.len()
                );
            }
            return ImportStatus::Rejected;
        }

        let previd = event.operation.get("previd").and_then(Value::as_str).unwrap_or_default();
        let previd = state.store.lock().await.canonical_reference(previd);
        let index = current_events.iter().position(|item| item.opid.as_deref() == Some(previd.as_str()));
        if !current_events.is_empty() && index.is_none() {
            return ImportStatus::Deferred;
        }
        let previous = if let Some(index) = index {
            match resolve_local_doc_async(
                state,
                &did,
                ResolveOptions {
                    version_sequence: Some(index + 1),
                    ..ResolveOptions::default()
                },
            ).await {
                Ok(doc) => Some(doc),
                Err(_) => return ImportStatus::Deferred,
            }
        } else {
            None
        };

        let verified = match authorize_operation(state, &event.operation, previous.as_ref(), Some(&event)).await {
            Ok(verified) => verified,
            Err(error) => {
                if trace {
                    info!(
                        "process_events deferred reason=verify_error error={} did={} opid={} current_events={}",
                        error,
                        did,
                        opid,
                        current_events.len()
                    );
                }
                return ImportStatus::Deferred;
            }
        };
        if !verified {
            if trace {
                warn!(
                    "process_events rejected reason=verify_false did={} opid={} current_events={}",
                    did,
                    opid,
                    current_events.len()
                );
            }
            return ImportStatus::Rejected;
        }

        if current_events.is_empty() {
            let added = {
                let mut store = state.store.lock().await;
                store.add_create_event(&did, event.clone()).is_ok()
            };
            return if added {
                if trace {
                    info!("process_events added reason=create did={} opid={}", did, opid);
                }
                ImportStatus::Added
            } else {
                if trace {
                    warn!(
                        "process_events rejected reason=create_store_error did={} opid={}",
                        did,
                        opid
                    );
                }
                ImportStatus::Rejected
            };
        }

        let Some(index) = index else {
            return ImportStatus::Deferred;
        };

        if index == current_events.len() - 1 {
            let added = {
                let mut store = state.store.lock().await;
                store.add_followup_event(&did, event.clone()).is_ok()
            };
            return if added {
                if trace {
                    info!(
                        "process_events added reason=append_followup did={} opid={} previd={}",
                        did,
                        opid,
                        previd
                    );
                }
                ImportStatus::Added
            } else {
                if trace {
                    warn!(
                        "process_events rejected reason=append_followup_store_error did={} opid={} previd={}",
                        did,
                        opid,
                        previd
                    );
                }
                ImportStatus::Rejected
            };
        }

        let expected_registry = expected_registry_for_index(&current_events, index + 1);
        let next_event = &current_events[index + 1];
        if compare_successors(expected_registry.as_deref(), &event, next_event).is_lt() {
            let mut new_sequence = current_events[..=index].to_vec();
            new_sequence.push(event.clone());
            {
                let mut store = state.store.lock().await;
                let _ = store.set_events(&did, new_sequence);
            }
            if trace {
                info!(
                    "process_events added reason=insert_preferred_branch did={} opid={} previd={} next_registry={} expected_registry={}",
                    did,
                    opid,
                    previd,
                    next_event.registry,
                    expected_registry.as_deref().unwrap_or("-")
                );
            }
            return ImportStatus::Added;
        }

        if trace {
            warn!(
                "process_events rejected reason=duplicate_or_unexpected_branch did={} opid={} previd={} index={} current_events={} expected_registry={} event_registry={}",
                did,
                opid,
                previd,
                index,
                current_events.len(),
                expected_registry.as_deref().unwrap_or("-"),
                event.registry
            );
        }
        ImportStatus::Rejected
    })
    .await;
    result
}

#[cfg(test)]
mod successor_ordering_tests {
    use super::*;

    #[test]
    fn shared_successor_ordering_cases() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/convergence/successor-ordering.json"
        )).unwrap();
        for case in cases {
            let a = value_to_event_record(&case["a"]);
            let b = value_to_event_record(&case["b"]);
            let expected = case["expectedRegistry"].as_str();
            let order = case["comparison"].as_i64().unwrap().cmp(&0);
            assert_eq!(compare_successors(expected, &a, &b), order, "{}", case["name"]);
            assert_eq!(compare_successors(expected, &b, &a), order.reverse(), "{}", case["name"]);
            assert_eq!(compare_successors(expected, &a, &a), Ordering::Equal);
        }
    }
}
