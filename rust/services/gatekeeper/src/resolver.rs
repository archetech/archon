use std::{collections::HashMap, time::Duration};

use anyhow::{Context, Result};
use async_recursion::async_recursion;
use serde::Serialize;
use serde_json::{json, Value};
use tracing::info;

use crate::{
    chrono_like_now, generate_json_cid, verify_create_operation_impl, verify_update_operation_impl, AppState,
    EventRecord, GatekeeperDb, ResolveOptions, ResolvedDoc,
};

#[derive(Clone, Serialize, Default)]
pub(crate) struct CheckDidsByType {
    pub(crate) agents: usize,
    pub(crate) assets: usize,
    pub(crate) confirmed: usize,
    pub(crate) unconfirmed: usize,
    pub(crate) ephemeral: usize,
    pub(crate) invalid: usize,
}

#[derive(Clone, Serialize, Default)]
pub(crate) struct CheckDidsResult {
    pub(crate) total: usize,
    pub(crate) byType: CheckDidsByType,
    pub(crate) byRegistry: HashMap<String, usize>,
    pub(crate) byVersion: HashMap<String, usize>,
    pub(crate) eventsQueue: Vec<EventRecord>,
}

#[derive(Serialize, Default)]
pub(crate) struct VerifyDbResult {
    pub(crate) total: usize,
    pub(crate) verified: usize,
    pub(crate) expired: usize,
    pub(crate) invalid: usize,
}

#[async_recursion]
pub(crate) async fn resolve_local_doc_async(
    state: &AppState,
    did: &str,
    options: ResolveOptions,
) -> Result<Value> {
    if !options.verify {
        let store = state.store.lock().await;
        return store.resolve_doc(&state.config, did, options);
    }

    let events = {
        let store = state.store.lock().await;
        store.get_events(did)
    };
    if events.is_empty() {
        anyhow::bail!("did not found");
    }

    let anchor = events.first().context("did has no events")?;
    let anchor_operation = &anchor.operation;
    if anchor_operation.get("type").and_then(Value::as_str) != Some("create") {
        anyhow::bail!("first operation must be create");
    }

    let registration = anchor_operation
        .get("registration")
        .and_then(Value::as_object)
        .context("missing registration")?;
    let did_type = registration
        .get("type")
        .and_then(Value::as_str)
        .context("missing registration.type")?;
    let created = anchor_operation
        .get("created")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let initial_document = match did_type {
        "agent" => {
            let public_jwk = anchor_operation.get("publicJwk").cloned().unwrap_or_else(|| json!({}));
            json!({
                "@context": ["https://www.w3.org/ns/did/v1"],
                "id": did,
                "verificationMethod": [{
                    "id": "#key-1",
                    "controller": did,
                    "type": "EcdsaSecp256k1VerificationKey2019",
                    "publicKeyJwk": public_jwk
                }],
                "authentication": ["#key-1"],
                "assertionMethod": ["#key-1"]
            })
        }
        "asset" => json!({
            "@context": ["https://www.w3.org/ns/did/v1"],
            "id": did,
            "controller": anchor_operation.get("controller").cloned().unwrap_or(Value::Null)
        }),
        _ => anyhow::bail!("unsupported registration.type"),
    };

    let canonical_id = anchor_operation
        .get("registration")
        .and_then(|v| v.get("prefix"))
        .and_then(Value::as_str)
        .map(|_| did.to_string());

    let mut resolved = ResolvedDoc {
        did_document: initial_document,
        did_document_data: anchor_operation.get("data").cloned().unwrap_or_else(|| json!({})),
        did_document_registration: Value::Object(registration.clone()),
        created: created.clone(),
        updated: None,
        deleted: None,
        version_id: anchor
            .opid
            .clone()
            .unwrap_or_else(|| generate_json_cid(anchor_operation).unwrap_or_default()),
        version_sequence: 1,
        confirmed: true,
        canonical_id,
        deactivated: false,
    };

    let anchor_valid = verify_create_operation_impl(state, anchor_operation).await?;
    if !anchor_valid {
        anyhow::bail!("Invalid operation: proof");
    }

    for event in events.iter().skip(1) {
        let operation = &event.operation;
        let operation_time = event.time.clone();

        if let Some(version_time) = options.version_time.as_ref() {
            if operation_time > *version_time {
                break;
            }
        }
        if let Some(version_sequence) = options.version_sequence {
            if resolved.version_sequence == version_sequence {
                break;
            }
        }

        resolved.confirmed = resolved.confirmed
            && resolved
                .did_document_registration
                .get("registry")
                .and_then(Value::as_str)
                .map(|registry| registry == event.registry)
                .unwrap_or(false);
        if options.confirm && !resolved.confirmed {
            break;
        }

        let current_doc = json!({
            "didDocument": resolved.did_document,
            "didDocumentMetadata": {
                "created": resolved.created,
                "updated": resolved.updated,
                "deleted": resolved.deleted,
                "canonicalId": resolved.canonical_id,
                "versionId": resolved.version_id,
                "versionSequence": resolved.version_sequence.to_string(),
                "confirmed": resolved.confirmed,
                "deactivated": resolved.deactivated
            },
            "didDocumentData": resolved.did_document_data,
            "didDocumentRegistration": resolved.did_document_registration
        });

        let valid = verify_update_operation_impl(state, operation, &current_doc).await?;
        if !valid {
            anyhow::bail!("Invalid operation: proof");
        }
        if operation.get("previd").and_then(Value::as_str) != Some(resolved.version_id.as_str()) {
            anyhow::bail!("Invalid operation: previd");
        }

        match operation.get("type").and_then(Value::as_str) {
            Some("update") => {
                resolved.version_sequence += 1;
                resolved.version_id = event
                    .opid
                    .clone()
                    .unwrap_or_else(|| generate_json_cid(operation).unwrap_or_default());
                resolved.updated = Some(operation_time);
                if let Some(next_doc) = operation.get("doc") {
                    if let Some(doc) = next_doc.get("didDocument") {
                        resolved.did_document = doc.clone();
                    }
                    if let Some(data) = next_doc.get("didDocumentData") {
                        resolved.did_document_data = data.clone();
                    }
                    if let Some(registration) = next_doc.get("didDocumentRegistration") {
                        resolved.did_document_registration = registration.clone();
                    }
                }
                resolved.deactivated = false;
            }
            Some("delete") => {
                resolved.version_sequence += 1;
                resolved.version_id = event
                    .opid
                    .clone()
                    .unwrap_or_else(|| generate_json_cid(operation).unwrap_or_default());
                resolved.deleted = Some(operation_time.clone());
                resolved.updated = Some(operation_time);
                resolved.did_document = json!({ "id": did });
                resolved.did_document_data = json!({});
                resolved.deactivated = true;
            }
            _ => {}
        }
    }

    let mut metadata = json!({
        "created": resolved.created,
        "versionId": resolved.version_id,
        "versionSequence": resolved.version_sequence.to_string(),
        "confirmed": resolved.confirmed
    });
    if let Some(updated) = resolved.updated.clone() {
        metadata["updated"] = Value::String(updated);
    }
    if let Some(deleted) = resolved.deleted.clone() {
        metadata["deleted"] = Value::String(deleted);
    }
    if resolved.deactivated {
        metadata["deactivated"] = Value::Bool(true);
    }
    if let Some(canonical_id) = resolved.canonical_id.clone() {
        metadata["canonicalId"] = Value::String(canonical_id);
    }

    Ok(json!({
        "didDocument": resolved.did_document,
        "didDocumentMetadata": metadata,
        "didDocumentData": resolved.did_document_data,
        "didDocumentRegistration": resolved.did_document_registration,
        "didResolutionMetadata": {
            "retrieved": chrono_like_now()
        }
    }))
}

pub(crate) async fn refresh_metrics_snapshot(state: &AppState) {
    let did_check = check_dids_impl(state, None, false).await;
    update_metrics_from_check(state, &did_check).await;
}

pub(crate) async fn update_metrics_from_check(state: &AppState, did_check: &CheckDidsResult) {
    state.metrics.events_queue_size.reset();
    let mut queue_by_registry: HashMap<String, usize> = HashMap::new();
    for event in &did_check.eventsQueue {
        let registry = if event.registry.is_empty() {
            "unknown".to_string()
        } else {
            event.registry.clone()
        };
        *queue_by_registry.entry(registry).or_insert(0) += 1;
    }
    for registry in &state.config.registries {
        queue_by_registry.entry(registry.clone()).or_insert(0);
    }
    for (registry, count) in queue_by_registry {
        state
            .metrics
            .events_queue_size
            .with_label_values(&[&registry])
            .set(count as f64);
    }

    state.metrics.gatekeeper_dids_total.set(did_check.total as f64);
    state.metrics.gatekeeper_dids_by_type.reset();
    for (ty, count) in [
        ("agents", did_check.byType.agents),
        ("assets", did_check.byType.assets),
        ("confirmed", did_check.byType.confirmed),
        ("unconfirmed", did_check.byType.unconfirmed),
        ("ephemeral", did_check.byType.ephemeral),
        ("invalid", did_check.byType.invalid),
    ] {
        state
            .metrics
            .gatekeeper_dids_by_type
            .with_label_values(&[ty])
            .set(count as f64);
    }

    state.metrics.gatekeeper_dids_by_registry.reset();
    for (registry, count) in &did_check.byRegistry {
        state
            .metrics
            .gatekeeper_dids_by_registry
            .with_label_values(&[registry])
            .set(*count as f64);
    }
}

pub(crate) async fn check_dids_impl(
    state: &AppState,
    dids: Option<Vec<String>>,
    _chatty: bool,
) -> CheckDidsResult {
    let dids = {
        let store = state.store.lock().await;
        dids.unwrap_or_else(|| store.list_dids(&state.config.did_prefix, None))
    };

    let mut by_type = CheckDidsByType::default();
    let mut by_registry = HashMap::new();
    let mut by_version = HashMap::new();

    for did in &dids {
        let doc = {
            let store = state.store.lock().await;
            store.resolve_doc(&state.config, did, ResolveOptions::default())
        };
        let Ok(doc) = doc else {
            by_type.invalid += 1;
            continue;
        };

        match doc
            .get("didDocumentRegistration")
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
        {
            Some("agent") => by_type.agents += 1,
            Some("asset") => by_type.assets += 1,
            _ => {}
        }

        if doc
            .get("didDocumentMetadata")
            .and_then(|value| value.get("confirmed"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            by_type.confirmed += 1;
        } else {
            by_type.unconfirmed += 1;
        }

        if doc
            .get("didDocumentRegistration")
            .and_then(|value| value.get("validUntil"))
            .and_then(Value::as_str)
            .is_some()
        {
            by_type.ephemeral += 1;
        }

        if let Some(registry) = doc
            .get("didDocumentRegistration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
        {
            *by_registry.entry(registry.to_string()).or_insert(0) += 1;
        }

        if let Some(version) = doc
            .get("didDocumentMetadata")
            .and_then(|value| value.get("versionSequence"))
            .and_then(Value::as_str)
        {
            *by_version.entry(version.to_string()).or_insert(0) += 1;
        }
    }

    let events_queue = state.store.lock().await.import_queue_snapshot();

    CheckDidsResult {
        total: dids.len(),
        byType: by_type,
        byRegistry: by_registry,
        byVersion: by_version,
        eventsQueue: events_queue,
    }
}

pub(crate) async fn verify_db_impl(state: &AppState, _chatty: bool) -> VerifyDbResult {
    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, None)
    };
    let total = dids.len();
    let mut expired = 0;
    let mut invalid = 0;
    let mut verified = state.verified_dids.lock().await.len();

    for did in dids {
        if state.verified_dids.lock().await.contains_key(&did) {
            continue;
        }

        let doc = resolve_local_doc_async(
            state,
            &did,
            ResolveOptions {
                verify: true,
                ..ResolveOptions::default()
            },
        )
        .await;

        let Ok(doc) = doc else {
            invalid += 1;
            let mut store = state.store.lock().await;
            let _ = store.delete_events(&did);
            continue;
        };

        let valid_until = doc
            .get("didDocumentRegistration")
            .and_then(|value| value.get("validUntil"))
            .and_then(Value::as_str)
            .map(ToString::to_string);

        if let Some(valid_until) = valid_until {
            if valid_until < chrono_like_now() {
                expired += 1;
                let mut store = state.store.lock().await;
                let _ = store.delete_events(&did);
            } else {
                verified += 1;
            }
        } else {
            state.verified_dids.lock().await.insert(did, true);
            verified += 1;
        }
    }

    {
        let mut store = state.store.lock().await;
        store.clear_import_queue();
    }

    VerifyDbResult {
        total,
        verified,
        expired,
        invalid,
    }
}

pub(crate) async fn search_docs_impl(state: &AppState, q: &str) -> Vec<String> {
    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, None)
    };

    let mut result = Vec::new();
    for did in dids {
        let doc = {
            let store = state.store.lock().await;
            store.resolve_doc(&state.config, &did, ResolveOptions::default())
        };
        let Ok(doc) = doc else {
            continue;
        };
        let data = doc.get("didDocumentData").cloned().unwrap_or_else(|| json!({}));
        if data.to_string().contains(q) {
            result.push(did);
        }
    }
    result
}

pub(crate) async fn query_docs_impl(state: &AppState, where_clause: &Value) -> Result<Vec<String>> {
    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, None)
    };

    let Some((raw_path, cond)) = where_clause.as_object().and_then(|map| map.iter().next()) else {
        return Ok(Vec::new());
    };
    let list = cond.get("$in").and_then(Value::as_array).context("Only {$in:[...]} supported")?;

    let mut result = Vec::new();
    for did in dids {
        let doc = {
            let store = state.store.lock().await;
            store.resolve_doc(&state.config, &did, ResolveOptions::default())
        };
        let Ok(doc) = doc else {
            continue;
        };
        let data = doc.get("didDocumentData").cloned().unwrap_or_else(|| json!({}));
        if query_match(&data, raw_path, list) {
            result.push(did);
        }
    }
    Ok(result)
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

    json_path_get(root, raw_path).map(|value| list.contains(value)).unwrap_or(false)
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

pub(crate) fn start_background_tasks(state: AppState) {
    if state.config.status_interval_minutes > 0 {
        let interval_minutes = state.config.status_interval_minutes;
        let status_state = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(interval_minutes * 60));
            loop {
                interval.tick().await;
                refresh_metrics_snapshot(&status_state).await;
                log_status_snapshot(&status_state).await;
            }
        });
    }

    if state.config.gc_interval_minutes > 0 {
        let interval_minutes = state.config.gc_interval_minutes;
        let gc_state = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(interval_minutes * 60)).await;
            let mut interval = tokio::time::interval(Duration::from_secs(interval_minutes * 60));
            loop {
                let result = verify_db_impl(&gc_state, false).await;
                info!("DID garbage collection: {}", serde_json::to_string(&result).unwrap_or_default());
                refresh_metrics_snapshot(&gc_state).await;
                interval.tick().await;
            }
        });
    }
}

pub(crate) async fn log_status_snapshot(state: &AppState) {
    let status = check_dids_impl(state, None, false).await;
    info!(
        total = status.total,
        agents = status.byType.agents,
        assets = status.byType.assets,
        confirmed = status.byType.confirmed,
        unconfirmed = status.byType.unconfirmed,
        pending_events = status.eventsQueue.len(),
        "Gatekeeper status snapshot"
    );
}
