use std::{collections::HashMap, fs, time::Duration};

use anyhow::{Context, Result};
use async_recursion::async_recursion;
use serde::Serialize;
use serde_json::{json, Value};
use tracing::info;

use crate::store::ResolvedDoc;
use crate::{
    chrono_like_now, generate_json_cid, verify_create_operation_impl, verify_update_operation_impl,
    AppState, EventRecord, GatekeeperDb, ResolveOptions,
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
    #[serde(rename = "byType")]
    pub(crate) byType: CheckDidsByType,
    #[serde(rename = "byRegistry")]
    pub(crate) byRegistry: HashMap<String, usize>,
    #[serde(rename = "byVersion")]
    pub(crate) byVersion: HashMap<String, usize>,
    #[serde(rename = "eventsQueue")]
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
        anyhow::bail!("DID not found");
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
            let public_jwk = anchor_operation
                .get("publicJwk")
                .cloned()
                .unwrap_or_else(|| json!({}));
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
        did_document_data: anchor_operation
            .get("data")
            .cloned()
            .unwrap_or_else(|| json!({})),
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
        timestamp: None,
    };

    let anchor_registry = resolved
        .did_document_registration
        .get("registry")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    if let Some(registry) = anchor_registry.as_deref() {
        resolved.timestamp = state
            .store
            .lock()
            .await
            .build_timestamp(registry, &resolved.version_id, anchor);
    }

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

        let registry_for_timestamp = resolved
            .did_document_registration
            .get("registry")
            .and_then(Value::as_str)
            .map(ToString::to_string);

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

        if let Some(registry) = registry_for_timestamp.as_deref() {
            resolved.timestamp = state
                .store
                .lock()
                .await
                .build_timestamp(registry, &resolved.version_id, event);
        }
    }

    if let Some(registration) = resolved.did_document_registration.as_object_mut() {
        registration.remove("opid");
        registration.remove("registration");
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
    if let Some(timestamp) = resolved.timestamp.clone() {
        metadata["timestamp"] = timestamp;
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
    *state.status_snapshot.lock().await = Some(did_check.clone());
    update_metrics_from_check(state, &did_check).await;
}

pub(crate) async fn build_search_index(state: &AppState) {
    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, None)
    };

    let mut next_index = crate::SearchIndex::default();
    for did in dids {
        if let Ok(doc) = resolve_local_doc_async(state, &did, ResolveOptions::default()).await {
            next_index.store(&did, &doc);
        }
    }

    let size = next_index.size();
    *state.search_index.lock().await = next_index;
    info!("Search index initialized with {} DIDs", size);
}

pub(crate) async fn update_search_doc(state: &AppState, did: &str) {
    if let Ok(doc) = resolve_local_doc_async(state, did, ResolveOptions::default()).await {
        state.search_index.lock().await.store(did, &doc);
    } else {
        state.search_index.lock().await.delete(did);
    }
}

pub(crate) async fn delete_search_doc(state: &AppState, did: &str) {
    state.search_index.lock().await.delete(did);
}

pub(crate) async fn clear_search_index(state: &AppState) {
    state.search_index.lock().await.clear();
}

async fn ensure_search_index_ready(state: &AppState) {
    let has_index = state.search_index.lock().await.size() > 0;
    if has_index {
        return;
    }

    let has_dids = {
        let store = state.store.lock().await;
        !store.list_dids(&state.config.did_prefix, None).is_empty()
    };

    if has_dids {
        build_search_index(state).await;
    }
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

    state
        .metrics
        .gatekeeper_dids_total
        .set(did_check.total as f64);
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

    let events_queue = state.import_queue.lock().await.clone();

    CheckDidsResult {
        total: dids.len(),
        byType: by_type,
        byRegistry: by_registry,
        byVersion: by_version,
        eventsQueue: events_queue,
    }
}

pub(crate) async fn verify_db_impl(state: &AppState, chatty: bool) -> VerifyDbResult {
    let started = std::time::Instant::now();
    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, None)
    };
    let total = dids.len();
    let mut expired = 0;
    let mut invalid = 0;
    let mut verified = state.verified_dids.lock().await.len();
    let mut n = 0usize;

    for did in dids {
        n += 1;
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
            if chatty {
                info!("removing {}/{} {} invalid", n, total, did);
            }
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
                if chatty {
                    info!("removing {}/{} {} expired", n, total, did);
                }
                expired += 1;
                let mut store = state.store.lock().await;
                let _ = store.delete_events(&did);
            } else {
                if chatty {
                    let minutes_left = chrono::DateTime::parse_from_rfc3339(&valid_until)
                        .ok()
                        .map(|expiry| {
                            let now = chrono::Utc::now();
                            let delta = expiry.with_timezone(&chrono::Utc) - now;
                            (delta.num_seconds() as f64 / 60.0).round() as i64
                        })
                        .unwrap_or_default();
                    info!(
                        "expiring {}/{} {} in {} minutes",
                        n, total, did, minutes_left
                    );
                }
                verified += 1;
            }
        } else {
            if chatty {
                info!("verifying {}/{} {} OK", n, total, did);
            }
            state.verified_dids.lock().await.insert(did, true);
            verified += 1;
        }
    }

    state.import_queue.lock().await.clear();

    if chatty {
        info!("verifyDb: {}ms", started.elapsed().as_millis());
    }

    VerifyDbResult {
        total,
        verified,
        expired,
        invalid,
    }
}

pub(crate) async fn search_docs_impl(state: &AppState, q: &str) -> Vec<String> {
    ensure_search_index_ready(state).await;
    state.search_index.lock().await.search_docs(q)
}

pub(crate) async fn query_docs_impl(state: &AppState, where_clause: &Value) -> Result<Vec<String>> {
    ensure_search_index_ready(state).await;
    state.search_index.lock().await.query_docs(where_clause)
}

pub(crate) fn start_background_tasks(state: AppState) {
    if state.config.status_interval_minutes > 0 {
        let interval_minutes = state.config.status_interval_minutes;
        let status_state = state.clone();
        tokio::spawn(async move {
            let interval = Duration::from_secs(interval_minutes * 60);
            tokio::time::sleep(interval).await;
            loop {
                refresh_metrics_snapshot(&status_state).await;
                log_status_snapshot(&status_state).await;
                tokio::time::sleep(interval).await;
            }
        });
    }

    if state.config.gc_interval_minutes > 0 {
        let interval_minutes = state.config.gc_interval_minutes;
        let gc_state = state.clone();
        tokio::spawn(async move {
            let interval = Duration::from_secs(interval_minutes * 60);
            tokio::time::sleep(interval).await;
            loop {
                let result = verify_db_impl(&gc_state, true).await;
                info!(
                    "DID garbage collection: {} waiting {} minutes...",
                    serde_json::to_string(&result).unwrap_or_default(),
                    interval_minutes
                );
                refresh_metrics_snapshot(&gc_state).await;
                tokio::time::sleep(interval).await;
            }
        });
    }
}

pub(crate) async fn log_status_snapshot(state: &AppState) {
    let status = if let Some(snapshot) = state.status_snapshot.lock().await.clone() {
        snapshot
    } else {
        let started = std::time::Instant::now();
        let status = check_dids_impl(state, None, false).await;
        let elapsed_ms = started.elapsed().as_millis();
        info!("checkDIDs: {}ms", elapsed_ms);
        *state.status_snapshot.lock().await = Some(status.clone());
        status
    };
    info!("Status -----------------------------");
    info!("DID Database ({}):", state.config.db);
    info!("  Total: {}", status.total);

    if status.total > 0 {
        info!("  By type:");
        info!("    Agents: {}", status.byType.agents);
        info!("    Assets: {}", status.byType.assets);
        info!("    Confirmed: {}", status.byType.confirmed);
        info!("    Unconfirmed: {}", status.byType.unconfirmed);
        info!("    Ephemeral: {}", status.byType.ephemeral);
        info!("    Invalid: {}", status.byType.invalid);

        info!("  By registry:");
        let mut registries = status.byRegistry.keys().cloned().collect::<Vec<_>>();
        registries.sort();
        for registry in registries {
            let count = status.byRegistry.get(&registry).copied().unwrap_or_default();
            info!("    {}: {}", registry, count);
        }

        info!("  By version:");
        let mut counted = 0usize;
        for version in 1..=5 {
            let key = version.to_string();
            let count = status.byVersion.get(&key).copied().unwrap_or_default();
            counted += count;
            info!("    {}: {}", version, count);
        }
        info!("    6+: {}", status.total.saturating_sub(counted));
    }

    info!("Events Queue: {} pending", status.eventsQueue.len());

    let memory = current_memory_usage();
    info!("Memory Usage Report:");
    info!(
        "  RSS: {} (Resident Set Size - total memory allocated for the process)",
        format_bytes(memory.rss)
    );
    info!("  Heap Total: {} (Total heap allocated)", format_bytes(memory.heap_total));
    info!("  Heap Used: {} (Heap actually used)", format_bytes(memory.heap_used));
    info!(
        "  External: {} (Memory used by C++ objects bound to JavaScript)",
        format_bytes(memory.external)
    );
    info!(
        "  Array Buffers: {} (Memory used by ArrayBuffer and SharedArrayBuffer)",
        format_bytes(memory.array_buffers)
    );

    let uptime_seconds = state.started_at.elapsed().as_secs();
    info!(
        "Uptime: {}s ({})",
        uptime_seconds,
        format_duration(uptime_seconds)
    );
    info!("------------------------------------");
}

#[derive(Default)]
struct MemoryUsage {
    rss: u64,
    heap_total: u64,
    heap_used: u64,
    external: u64,
    array_buffers: u64,
}

fn current_memory_usage() -> MemoryUsage {
    let rss = fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|contents| {
            contents.lines().find_map(|line| {
                let value = line.strip_prefix("VmRSS:")?.trim();
                let kilobytes = value.split_whitespace().next()?.parse::<u64>().ok()?;
                Some(kilobytes.saturating_mul(1024))
            })
        })
        .unwrap_or(0);

    MemoryUsage {
        rss,
        heap_total: 0,
        heap_used: 0,
        external: 0,
        array_buffers: 0,
    }
}

fn format_duration(mut seconds: u64) -> String {
    let sec_per_min = 60;
    let sec_per_hour = sec_per_min * 60;
    let sec_per_day = sec_per_hour * 24;

    let days = seconds / sec_per_day;
    seconds %= sec_per_day;

    let hours = seconds / sec_per_hour;
    seconds %= sec_per_hour;

    let minutes = seconds / sec_per_min;
    seconds %= sec_per_min;

    let mut parts = Vec::new();
    if days > 0 {
        parts.push(if days == 1 {
            "1 day".to_string()
        } else {
            format!("{days} days")
        });
    }
    if hours > 0 {
        parts.push(if hours == 1 {
            "1 hour".to_string()
        } else {
            format!("{hours} hours")
        });
    }
    if minutes > 0 {
        parts.push(if minutes == 1 {
            "1 minute".to_string()
        } else {
            format!("{minutes} minutes")
        });
    }
    parts.push(if seconds == 1 {
        "1 second".to_string()
    } else {
        format!("{seconds} seconds")
    });
    parts.join(", ")
}

fn format_bytes(bytes: u64) -> String {
    let sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if bytes == 0 {
        return "0 Byte".to_string();
    }

    let mut size = bytes as f64;
    let mut index = 0usize;
    while size >= 1024.0 && index < sizes.len() - 1 {
        size /= 1024.0;
        index += 1;
    }

    format!("{size:.2} {}", sizes[index])
}
