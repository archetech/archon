use std::env;

use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use tracing::{info, warn};

use crate::store::compare_ordinals;
use crate::{
    ensure_event_opid, event_record_to_value, expected_registry_for_index,
    generate_did_from_operation, generate_json_cid, infer_event_did, value_to_event_record,
    update_search_doc, verify_event_shape, verify_operation_impl, AppState, EventRecord,
    GatekeeperDb, ResolveOptions,
};

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
    let op_type = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing operation.type".to_string())?;

    let valid = verify_operation_impl(state, payload)
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
    if op_type == "create" {
        let registry = payload
            .get("registration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
            .ok_or_else(|| "missing operation.registration.registry".to_string())?;
        if !supported_registries.iter().any(|item| item == registry) {
            return Err(format!("Invalid operation: registry {registry} not supported"));
        }
    } else {
        let current_registry = {
            let store = state.store.lock().await;
            store
                .resolve_doc(&state.config, &did, ResolveOptions::default())
                .ok()
                .and_then(|doc| {
                    doc.get("didDocumentRegistration")
                        .and_then(|value| value.get("registry"))
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
        };

        let current_registry = current_registry
            .ok_or_else(|| "Invalid operation: registry missing".to_string())?;
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
    }

    let event_time = payload
        .get("proof")
        .and_then(|value| value.get("created"))
        .and_then(Value::as_str)
        .or_else(|| payload.get("created").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    let opid = generate_json_cid(payload).map_err(|error| error.to_string())?;
    let event = EventRecord {
        registry: "local".to_string(),
        time: event_time,
        ordinal: Some(vec![0]),
        operation: payload.clone(),
        opid: Some(opid),
        did: Some(did.clone()),
    };

    let queue_registry = if op_type == "create" {
        payload
            .get("registration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
            .map(ToString::to_string)
    } else {
        let store = state.store.lock().await;
        store
            .resolve_doc(&state.config, &did, ResolveOptions::default())
            .ok()
            .and_then(|doc| {
                doc.get("didDocumentRegistration")
                    .and_then(|value| value.get("registry"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
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
        let _ = queue_outbound_operation(state, &registry, payload.clone()).await;
    }
    update_search_doc(state, &did).await;

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
) -> Result<()> {
    if registry == "local" {
        return Ok(());
    }

    let queue_size = {
        let mut store = state.store.lock().await;
        let _ = store.queue_operation("hyperswarm", operation.clone())?;
        if registry != "hyperswarm" {
            Some(store.queue_operation(registry, operation)?)
        } else {
            None
        }
    };

    if queue_size.is_some_and(|size| size >= state.config.max_queue_size) {
        let mut supported = state.supported_registries.lock().await;
        supported.retain(|item| item != registry);
    }

    Ok(())
}

fn event_key(event: &Value) -> Option<String> {
    let registry = event.get("registry").and_then(Value::as_str)?;
    let proof_value = event
        .get("operation")
        .and_then(|value| value.get("proof"))
        .and_then(|value| value.get("proofValue"))
        .and_then(Value::as_str)?;
    Some(format!("{registry}/{proof_value}"))
}

pub(crate) async fn import_batch_impl(state: &AppState, batch: &[Value]) -> ImportBatchResult {
    let mut queued = 0;
    let mut rejected = 0;
    let mut processed = 0;
    let trace = import_trace_enabled();

    for event in batch {
        if !verify_event_shape(event) {
            if trace {
                warn!("import_batch rejected malformed event {}", summarize_value_event(event));
            }
            rejected += 1;
            continue;
        }

        let Some(key) = event_key(event) else {
            if trace {
                warn!("import_batch rejected event without key {}", summarize_value_event(event));
            }
            rejected += 1;
            continue;
        };

        let mut seen = state.events_seen.lock().await;
        if seen.contains_key(&key) {
            if trace {
                info!("import_batch skipped previously seen key={key} {}", summarize_value_event(event));
            }
            processed += 1;
            continue;
        }
        seen.insert(key.clone(), true);
        drop(seen);

        let mut store = state.store.lock().await;
        store.push_import_event(value_to_event_record(event));
        if trace {
            info!("import_batch queued key={key} {}", summarize_value_event(event));
        }
        queued += 1;
    }

    ImportBatchResult {
        queued,
        processed,
        rejected,
        total: state.store.lock().await.import_queue_len(),
    }
}

pub(crate) async fn process_events_impl(state: &AppState) -> ProcessEventsResult {
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

    let pending = state.store.lock().await.import_queue_len();
    *state.processing_events.lock().await = false;

    let response = ProcessEventsResult {
        busy: None,
        added: Some(added),
        merged: Some(merged),
        rejected: Some(rejected),
        pending: Some(pending),
    };
    info!(
        "processEvents: {}",
        serde_json::to_string(&response).unwrap_or_else(|_| "{}".to_string())
    );
    response
}

async fn import_events_once(state: &AppState) -> ImportEventsResult {
    let mut temp_queue = state.store.lock().await.take_import_queue();
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
                let mut store = state.store.lock().await;
                store.push_import_event(event);
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

async fn import_event_impl(state: &AppState, event: EventRecord) -> ImportStatus {
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

        let proof_value = event
            .operation
            .get("proof")
            .and_then(|value| value.get("proofValue"))
            .and_then(Value::as_str)
            .unwrap_or("");

        if let Some(index) = current_events.iter().position(|item| {
            item.operation
                .get("proof")
                .and_then(|value| value.get("proofValue"))
                .and_then(Value::as_str)
                == Some(proof_value)
        }) {
            let expected_registry = expected_registry_for_index(&current_events, index);
            if expected_registry.as_deref() == Some(current_events[index].registry.as_str()) {
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
                current_events[index] = event.clone();
                {
                    let mut store = state.store.lock().await;
                    let _ = store.set_events(&did, current_events);
                }
                update_search_doc(state, &did).await;
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

        let verified = match verify_operation_impl(state, &event.operation).await {
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
                update_search_doc(state, &did).await;
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

        let previd = match event.operation.get("previd").and_then(Value::as_str) {
            Some(value) => value.to_string(),
            None => return ImportStatus::Rejected,
        };
        let Some(index) = current_events
            .iter()
            .position(|item| item.opid.as_deref() == Some(previd.as_str()))
        else {
            if trace {
                info!(
                    "process_events deferred reason=unknown_previd did={} opid={} previd={} current_events={}",
                    did,
                    opid,
                    previd,
                    current_events.len()
                );
            }
            return ImportStatus::Deferred;
        };

        if index == current_events.len() - 1 {
            let added = {
                let mut store = state.store.lock().await;
                store.add_followup_event(&did, event.clone()).is_ok()
            };
            return if added {
                update_search_doc(state, &did).await;
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
        if expected_registry.as_deref() == Some(event.registry.as_str()) {
            let next_event = &current_events[index + 1];
            if next_event.registry != event.registry
                || compare_ordinals(event.ordinal.as_ref(), next_event.ordinal.as_ref()).is_lt()
            {
                let mut new_sequence = current_events[..=index].to_vec();
                new_sequence.push(event.clone());
                {
                    let mut store = state.store.lock().await;
                    let _ = store.set_events(&did, new_sequence);
                }
                update_search_doc(state, &did).await;
                if trace {
                    info!(
                        "process_events added reason=insert_reorg did={} opid={} previd={} next_registry={} expected_registry={}",
                        did,
                        opid,
                        previd,
                        next_event.registry,
                        expected_registry.as_deref().unwrap_or("-")
                    );
                }
                return ImportStatus::Added;
            }
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
