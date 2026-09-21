//! Pure interpretation of accepted predecessor-ordered histories.
use crate::store::ResolvedDoc;
use crate::{generate_json_cid, is_unanchored_registry, EventRecord};
use serde_json::{json, Value};

fn registry_after<'a>(registry: Option<&'a str>, operation: &'a Value) -> Option<&'a str> {
    if operation["type"] == "update" {
        operation
            .pointer("/doc/didDocumentRegistration/registry")
            .and_then(Value::as_str)
            .or(registry)
    } else {
        registry
    }
}

pub(crate) fn expected_registry_for_index(events: &[EventRecord], index: usize) -> Option<String> {
    let mut registry = events
        .first()
        .and_then(|event| event.operation.pointer("/registration/registry"))
        .and_then(Value::as_str);
    for event in events.iter().take(index).skip(1) {
        registry = registry_after(registry, &event.operation);
    }
    registry.map(ToString::to_string)
}

// Expose the predecessor registry before applying the operation's migration.
// Public genesis confirmation is unconditional; chain anchoring is not.
pub(crate) fn history_entries(
    events: &[EventRecord],
) -> impl Iterator<Item = (&EventRecord, Option<&str>, bool)> {
    let registry = events
        .first()
        .and_then(|event| event.operation.pointer("/registration/registry"))
        .and_then(Value::as_str);
    events
        .iter()
        .enumerate()
        .scan((registry, true), |(registry, confirmed), (index, event)| {
            if index > 0 {
                *confirmed = *confirmed && Some(event.registry.as_str()) == *registry;
            }
            let entry = (event, *registry, *confirmed);
            *registry = registry_after(*registry, &event.operation);
            Some(entry)
        })
}

// Scan the whole confirmed prefix, independently of the selected controller cutoff.
pub(crate) fn has_anchored_prefix(events: &[EventRecord]) -> bool {
    let mut anchored = false;
    for (event, expected, confirmed) in history_entries(events) {
        if !confirmed {
            break;
        }
        if Some(event.registry.as_str()) == expected && !is_unanchored_registry(&event.registry) {
            if !crate::proofs::record_has_chain_metadata(event) {
                return false;
            }
            anchored = true;
        }
    }
    anchored
}

pub(crate) fn apply_transition(
    state: &mut ResolvedDoc,
    event: &EventRecord,
    did: &str,
    operation_time: String,
) {
    let operation = &event.operation;
    match operation.get("type").and_then(Value::as_str) {
        Some("update") => {
            state.version_sequence += 1;
            state.version_id = event
                .opid
                .clone()
                .unwrap_or_else(|| generate_json_cid(operation).unwrap_or_default());
            state.updated = Some(operation_time);
            if let Some(next_doc) = operation.get("doc") {
                if let Some(doc) = next_doc.get("didDocument") {
                    state.did_document = doc.clone();
                }
                if let Some(data) = next_doc.get("didDocumentData") {
                    state.did_document_data = data.clone();
                }
                if let Some(registration) = next_doc.get("didDocumentRegistration") {
                    state.did_document_registration = registration.clone();
                }
            }
            state.deactivated = false;
        }
        Some("delete") => {
            state.version_sequence += 1;
            state.version_id = event
                .opid
                .clone()
                .unwrap_or_else(|| generate_json_cid(operation).unwrap_or_default());
            state.deleted = Some(operation_time);
            state.updated = None;
            state.did_document = json!({ "id": did });
            state.did_document_data = json!({});
            state.deactivated = true;
        }
        _ => {}
    }
}
