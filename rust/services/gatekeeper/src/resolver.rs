use crate::history_view::{history_entries, apply_transition};
use std::{collections::HashMap, fs, time::Duration};

use anyhow::Result;
use async_recursion::async_recursion;
use serde::Serialize;
use serde_json::{json, Value};
use tracing::info;

use crate::store::ResolvedDoc;
use crate::{
    authorize_operation, chrono_like_now, generate_json_cid, is_valid_did, past_cutoff,
    standard_datetime, AppState,
    EventRecord, GatekeeperDb, ResolveOptions,
};

/// Typed classes for resolution failures that are the DID's own problem (a missing DID or an
/// invalid operation chain). These are attached to the specific error message via `.context()`
/// (see `not_found`/`invalid_operation`) so the original diagnostic is preserved while the type
/// drives HTTP classification on the conformant `/1.0/identifiers` surface.
#[derive(Debug, Clone, Copy)]
pub(crate) enum ResolveError {
    /// The DID does not exist, or its operation chain does not yield a valid document.
    NotFound,
    /// An operation in the chain failed validation (bad proof, previd, or structure).
    InvalidOperation,
}

impl std::fmt::Display for ResolveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ResolveError::NotFound => write!(f, "DID not found"),
            ResolveError::InvalidOperation => write!(f, "Invalid operation"),
        }
    }
}

impl std::error::Error for ResolveError {}

/// A not-found resolution failure carrying a specific diagnostic message on top of the typed error.
pub(crate) fn not_found(detail: &'static str) -> anyhow::Error {
    anyhow::Error::from(ResolveError::NotFound).context(detail)
}

/// An invalid-operation resolution failure carrying a specific diagnostic message.
pub(crate) fn invalid_operation(detail: &'static str) -> anyhow::Error {
    anyhow::Error::from(ResolveError::InvalidOperation).context(detail)
}

/// Classify an error from `resolve_local_doc_async` for the conformant `/1.0/identifiers` surface:
/// malformed DID syntax -> 400 `invalidDid`; a DID-level resolution/validation failure -> 404
/// `notFound`; anything else (I/O, storage, crypto, unexpected) -> 500 `internalError`. Returned as
/// a raw status code to keep this module free of the HTTP layer.
///
/// A failure is DID-level if any cause in the chain is a typed `ResolveError`, OR any cause matches
/// the codebase's "Invalid operation" validation convention (also used by proofs.rs / events.rs) —
/// this catches validation errors surfaced from the verify stack (e.g. a malformed proof value)
/// without those layers needing to depend on this module.
pub(crate) fn classify_conformant_error(did: &str, error: &anyhow::Error) -> (u16, &'static str) {
    let is_did_level = error.chain().any(|cause| {
        cause.is::<ResolveError>() || cause.to_string().starts_with("Invalid operation")
    });

    if !is_valid_did(did) {
        (400, "invalidDid")
    } else if is_did_level {
        (404, "notFound")
    } else {
        (500, "internalError")
    }
}

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
    pub(crate) by_type: CheckDidsByType,
    #[serde(rename = "byRegistry")]
    pub(crate) by_registry: HashMap<String, usize>,
    #[serde(rename = "byVersion")]
    pub(crate) by_version: HashMap<String, usize>,
    #[serde(rename = "eventsQueue")]
    pub(crate) events_queue: Vec<EventRecord>,
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
        return Err(not_found("DID not found"));
    }

    let anchor = events.first().ok_or_else(|| not_found("did has no events"))?;
    let anchor_operation = &anchor.operation;
    if anchor_operation.get("type").and_then(Value::as_str) != Some("create") {
        return Err(not_found("first operation must be create"));
    }

    let registration = anchor_operation
        .get("registration")
        .and_then(Value::as_object)
        .ok_or_else(|| not_found("missing registration"))?;
    let did_type = registration
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| not_found("missing registration.type"))?;
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
                "assertionMethod": ["#key-1"],
                // Operations claim capabilityInvocation, and a proof purpose
                // the document does not grant is a safeguard nothing can check.
                // This is the same key: an agent signs its own operations with
                // it.
                "capabilityInvocation": ["#key-1"]
            })
        }
        "asset" => json!({
            "@context": ["https://www.w3.org/ns/did/v1"],
            "id": did,
            "controller": anchor_operation.get("controller").cloned().unwrap_or(Value::Null)
        }),
        _ => return Err(not_found("unsupported registration.type")),
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
        created: standard_datetime(&created),
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

    let anchor_valid =
        authorize_operation(state, anchor_operation, None, Some(anchor)).await?;
    if !anchor_valid {
        return Err(invalid_operation("Invalid operation: proof"));
    }

    for (event, expected_registry, event_confirmed) in history_entries(&events).skip(1) {
        let operation = &event.operation;
        let operation_time = standard_datetime(&event.time);

        if past_cutoff(&options, event) {
            break;
        }
        if let Some(version_sequence) = options.version_sequence {
            if resolved.version_sequence == version_sequence {
                break;
            }
        }

        if options.confirm && !event_confirmed {
            break;
        }
        resolved.confirmed = event_confirmed;

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

        let valid =
            authorize_operation(state, operation, Some(&current_doc), Some(event))
                .await?;
        if !valid {
            return Err(invalid_operation("Invalid operation: proof"));
        }

        apply_transition(&mut resolved, event, did, operation_time);

        if let Some(registry) = expected_registry {
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

pub(crate) async fn refresh_metrics_snapshot(state: &AppState) -> Result<()> {
    crate::history::ensure_history_ready(state).await?;
    let _guard = state.history_lock.lock().await;
    refresh_metrics_snapshot_once(state).await;
    Ok(())
}

// Caller holds history_lock so an old snapshot cannot be published after replay.
pub(crate) async fn refresh_metrics_snapshot_once(state: &AppState) {
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
    let mut progress = crate::progress::ProgressLogger::new("search indexing", dids.len());
    for (index, did) in dids.into_iter().enumerate() {
        if let Ok(doc) = resolve_local_doc_async(state, &did, ResolveOptions::default()).await {
            next_index.store(&did, &doc);
        }
        progress.update(index + 1);
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
    for event in &did_check.events_queue {
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
        ("agents", did_check.by_type.agents),
        ("assets", did_check.by_type.assets),
        ("confirmed", did_check.by_type.confirmed),
        ("unconfirmed", did_check.by_type.unconfirmed),
        ("ephemeral", did_check.by_type.ephemeral),
        ("invalid", did_check.by_type.invalid),
    ] {
        state
            .metrics
            .gatekeeper_dids_by_type
            .with_label_values(&[ty])
            .set(count as f64);
    }

    state.metrics.gatekeeper_dids_by_registry.reset();
    // Seed a zero series for every configured registry before applying counts.
    // The prometheus crate omits a GaugeVec with no series entirely, so with no
    // DIDs yet this family vanished from /metrics — while the TypeScript
    // gatekeeper (prom-client) always emits its HELP/TYPE. A dashboard doing
    // label_values(gatekeeper_dids_by_registry, registry) therefore got nothing
    // from this service until the first DID existed.
    for registry in &state.config.registries {
        state
            .metrics
            .gatekeeper_dids_by_registry
            .with_label_values(&[registry])
            .set(0.0);
    }
    for (registry, count) in &did_check.by_registry {
        state
            .metrics
            .gatekeeper_dids_by_registry
            .with_label_values(&[registry])
            .set(*count as f64);
    }
}

// Startup recovery owns a complete accepted in-memory projection. Build both
// derived views in one pass before releasing history_lock, without Redis reads.
pub(crate) async fn build_startup_views(state: &AppState) {
    let mut index = crate::SearchIndex::default();
    let status = scan_dids(state, None, Some(&mut index)).await;
    let size = index.size();
    *state.search_index.lock().await = index;
    *state.status_snapshot.lock().await = Some(status.clone());
    update_metrics_from_check(state, &status).await;
    info!("Search index initialized with {} DIDs", size);
}

pub(crate) async fn check_dids_impl(
    state: &AppState,
    dids: Option<Vec<String>>,
    _chatty: bool,
) -> CheckDidsResult {
    scan_dids(state, dids, None).await
}

async fn scan_dids(
    state: &AppState,
    dids: Option<Vec<String>>,
    mut search_index: Option<&mut crate::SearchIndex>,
) -> CheckDidsResult {
    let dids = {
        let store = state.store.lock().await;
        dids.unwrap_or_else(|| store.list_dids(&state.config.did_prefix, None))
    };

    let mut by_type = CheckDidsByType::default();
    let mut by_registry = HashMap::new();
    let mut by_version = HashMap::new();

    let phase = if search_index.is_some() {
        "startup search/status views"
    } else {
        "DB status check"
    };
    let mut progress = crate::progress::ProgressLogger::new(phase, dids.len());
    for (index, did) in dids.iter().enumerate() {
        let doc = {
            let store = state.store.lock().await;
            store.resolve_doc(&state.config, did, ResolveOptions::default())
        };
        progress.update(index + 1);
        let Ok(doc) = doc else {
            by_type.invalid += 1;
            continue;
        };

        if let Some(index) = search_index.as_deref_mut() {
            index.store(did, &doc);
        }

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
        by_type,
        by_registry,
        by_version,
        events_queue,
    }
}

pub(crate) async fn verify_db_impl(state: &AppState, chatty: bool) -> Result<VerifyDbResult> {
    let _history_guard = state.history_lock.lock().await;
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
    let mut removed = Vec::new();

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
            removed.push(did);
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
                removed.push(did);
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

    crate::history::remove_histories(state, &removed).await?;
    state.import_queue.lock().await.clear();

    if chatty {
        info!("verifyDb: {}ms", started.elapsed().as_millis());
    }

    Ok(VerifyDbResult {
        total,
        verified,
        expired,
        invalid,
    })
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
                if let Err(error) = refresh_metrics_snapshot(&status_state).await {
                    tracing::error!(%error, "Failed to refresh DID status");
                } else {
                    log_status_snapshot(&status_state).await;
                }
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
                match verify_db_impl(&gc_state, true).await {
                    Ok(result) => {
                        info!(
                            "DID garbage collection: {} waiting {} minutes...",
                            serde_json::to_string(&result).unwrap_or_default(),
                            interval_minutes
                        );
                        if let Err(error) = refresh_metrics_snapshot(&gc_state).await {
                            tracing::error!(%error, "Failed to refresh DID status after GC");
                        }
                    }
                    Err(error) => tracing::error!(%error, "DID garbage collection failed"),
                }
                tokio::time::sleep(interval).await;
            }
        });
    }
}

pub(crate) async fn log_status_snapshot(state: &AppState) {
    if let Err(error) = crate::history::ensure_history_ready(state).await {
        tracing::error!(%error, "Failed to read DID status");
        return;
    }
    let _guard = state.history_lock.lock().await;
    let cached = state.status_snapshot.lock().await.clone();
    let status = if let Some(snapshot) = cached {
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
        info!("    Agents: {}", status.by_type.agents);
        info!("    Assets: {}", status.by_type.assets);
        info!("    Confirmed: {}", status.by_type.confirmed);
        info!("    Unconfirmed: {}", status.by_type.unconfirmed);
        info!("    Ephemeral: {}", status.by_type.ephemeral);
        info!("    Invalid: {}", status.by_type.invalid);

        info!("  By registry:");
        let mut registries = status.by_registry.keys().cloned().collect::<Vec<_>>();
        registries.sort();
        for registry in registries {
            let count = status.by_registry.get(&registry).copied().unwrap_or_default();
            info!("    {}: {}", registry, count);
        }

        info!("  By version:");
        let mut counted = 0usize;
        for version in 1..=5 {
            let key = version.to_string();
            let count = status.by_version.get(&key).copied().unwrap_or_default();
            counted += count;
            info!("    {}: {}", version, count);
        }
        info!("    6+: {}", status.total.saturating_sub(counted));
    }

    info!("Events Queue: {} pending", status.events_queue.len());

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
