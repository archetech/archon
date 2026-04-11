use anyhow::Result;
use serde::Serialize;
use serde_json::Value;

use crate::store::compare_ordinals;
use crate::{
    ensure_event_opid, event_record_to_value, expected_registry_for_index,
    generate_did_from_operation, generate_json_cid, infer_event_did, value_to_event_record,
    verify_event_shape, verify_operation_impl, AppState, EventRecord, GatekeeperDb, ResolveOptions,
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

    let result = {
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
    }?;

    if let Some(registry) = queue_registry {
        let _ = queue_outbound_operation(state, &registry, payload.clone()).await;
    }

    Ok(result)
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

    for event in batch {
        if !verify_event_shape(event) {
            rejected += 1;
            continue;
        }

        let Some(key) = event_key(event) else {
            rejected += 1;
            continue;
        };

        let mut seen = state.events_seen.lock().await;
        if seen.contains_key(&key) {
            processed += 1;
            continue;
        }
        seen.insert(key, true);
        drop(seen);

        let mut store = state.store.lock().await;
        store.push_import_event(value_to_event_record(event));
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

    ProcessEventsResult {
        busy: None,
        added: Some(added),
        merged: Some(merged),
        rejected: Some(rejected),
        pending: Some(pending),
    }
}

async fn import_events_once(state: &AppState) -> ImportEventsResult {
    let mut temp_queue = state.store.lock().await.take_import_queue();

    let mut added = 0;
    let mut merged = 0;
    let mut rejected = 0;

    for event in temp_queue.drain(..) {
        match import_event_impl(state, event.clone()).await {
            ImportStatus::Added => added += 1,
            ImportStatus::Merged => merged += 1,
            ImportStatus::Rejected => rejected += 1,
            ImportStatus::Deferred => {
                let mut store = state.store.lock().await;
                store.push_import_event(event);
            }
        }
    }

    ImportEventsResult {
        added,
        merged,
        rejected,
    }
}

async fn import_event_impl(state: &AppState, event: EventRecord) -> ImportStatus {
    let mut event_value = event_record_to_value(&event);
    let did = match infer_event_did(&state.config, &event_value) {
        Ok(did) => did,
        Err(_) => return ImportStatus::Rejected,
    };
    event_value["did"] = Value::String(did.clone());
    let opid = match ensure_event_opid(&mut event_value) {
        Ok(opid) => opid,
        Err(_) => return ImportStatus::Rejected,
    };

    let mut event = value_to_event_record(&event_value);
    event.did = Some(did.clone());
    event.opid = Some(opid.clone());

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
            return ImportStatus::Merged;
        }
        if expected_registry.as_deref() == Some(event.registry.as_str()) {
            current_events[index] = event;
            let mut store = state.store.lock().await;
            let _ = store.set_events(&did, current_events);
            return ImportStatus::Added;
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
        return ImportStatus::Rejected;
    }

    let verified = match verify_operation_impl(state, &event.operation).await {
        Ok(verified) => verified,
        Err(_) => return ImportStatus::Deferred,
    };
    if !verified {
        return ImportStatus::Rejected;
    }

    if current_events.is_empty() {
        let mut store = state.store.lock().await;
        return if store.add_create_event(&did, event).is_ok() {
            ImportStatus::Added
        } else {
            ImportStatus::Rejected
        };
    }

    let previd = match event.operation.get("previd").and_then(Value::as_str) {
        Some(value) => value,
        None => return ImportStatus::Rejected,
    };
    let Some(index) = current_events
        .iter()
        .position(|item| item.opid.as_deref() == Some(previd))
    else {
        return ImportStatus::Deferred;
    };

    if index == current_events.len() - 1 {
        let mut store = state.store.lock().await;
        return if store.add_followup_event(&did, event).is_ok() {
            ImportStatus::Added
        } else {
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
            new_sequence.push(event);
            let mut store = state.store.lock().await;
            let _ = store.set_events(&did, new_sequence);
            return ImportStatus::Added;
        }
    }

    ImportStatus::Rejected
}
