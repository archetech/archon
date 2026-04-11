use std::{
    collections::HashMap,
    env,
    fs,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use async_recursion::async_recursion;
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use bytes::Bytes;
use cid::Cid;
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature as K256Signature, VerifyingKey};
use multihash_codetable::{Code, MultihashDigest};
use prometheus::{
    Encoder, Gauge, GaugeVec, HistogramOpts, HistogramVec, IntCounterVec, Registry, TextEncoder,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    config: Config,
    client: Client,
    metrics: Arc<Metrics>,
    store: Arc<Mutex<JsonDb>>,
    events_seen: Arc<Mutex<HashMap<String, bool>>>,
    verified_dids: Arc<Mutex<HashMap<String, bool>>>,
    supported_registries: Arc<Mutex<Vec<String>>>,
    processing_events: Arc<Mutex<bool>>,
    started_at: Instant,
}

struct Metrics {
    registry: Registry,
    http_requests_total: IntCounterVec,
    http_request_duration_seconds: HistogramVec,
    did_operations_total: IntCounterVec,
    events_queue_size: GaugeVec,
    gatekeeper_dids_total: Gauge,
    gatekeeper_dids_by_type: GaugeVec,
    gatekeeper_dids_by_registry: GaugeVec,
    service_version_info: GaugeVec,
}

#[derive(Clone)]
struct Config {
    port: u16,
    bind_address: IpAddr,
    db: String,
    data_dir: PathBuf,
    ipfs_url: String,
    did_prefix: String,
    registries: Vec<String>,
    json_limit: usize,
    upload_limit: usize,
    gc_interval_minutes: u64,
    status_interval_minutes: u64,
    admin_api_key: String,
    fallback_url: String,
    fallback_timeout_ms: u64,
    max_queue_size: usize,
    git_commit: String,
    version: String,
}

#[derive(Serialize)]
struct StatusPayload {
    uptimeSeconds: u64,
    dids: Value,
    memoryUsage: MemoryUsage,
}

#[derive(Serialize)]
struct MemoryUsage {
    rss: u64,
    heapTotal: u64,
    heapUsed: u64,
    external: u64,
    arrayBuffers: u64,
}

#[derive(Serialize)]
struct VersionPayload {
    version: String,
    commit: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct EventRecord {
    registry: String,
    time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    ordinal: Option<Vec<u32>>,
    operation: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    opid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    did: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct JsonDbFile {
    dids: HashMap<String, Vec<EventRecord>>,
    #[serde(default)]
    import_queue: Vec<EventRecord>,
    #[serde(default)]
    queue: HashMap<String, Vec<Value>>,
    #[serde(default)]
    blocks: HashMap<String, HashMap<String, Value>>,
    #[serde(default)]
    ops: HashMap<String, Value>,
}

struct JsonDb {
    path: PathBuf,
    data: JsonDbFile,
}

trait GatekeeperDb {
    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String>;
    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool>;
    fn get_events(&self, did: &str) -> Vec<EventRecord>;
    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()>;
    fn delete_events(&mut self, did: &str) -> Result<()>;
    fn reset_db(&mut self) -> Result<()>;
    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()>;
    fn get_operation(&self, opid: &str) -> Option<Value>;
    fn push_import_event(&mut self, event: EventRecord);
    fn take_import_queue(&mut self) -> Vec<EventRecord>;
    fn import_queue_len(&self) -> usize;
    fn import_queue_snapshot(&self) -> Vec<EventRecord>;
    fn clear_import_queue(&mut self);
    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize>;
    fn get_queue(&self, registry: &str) -> Vec<Value>;
    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool>;
    fn add_block(&mut self, registry: &str, block: Value) -> Result<bool>;
    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value>;
    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String>;
    fn resolve_doc(&self, config: &Config, did: &str, options: ResolveOptions) -> Result<Value>;
}

#[derive(Clone, Default)]
struct ResolveOptions {
    version_time: Option<String>,
    version_sequence: Option<usize>,
    confirm: bool,
    verify: bool,
}

struct ResolvedDoc {
    did_document: Value,
    did_document_data: Value,
    did_document_registration: Value,
    created: String,
    updated: Option<String>,
    deleted: Option<String>,
    version_id: String,
    version_sequence: usize,
    confirmed: bool,
    canonical_id: Option<String>,
    deactivated: bool,
}

#[derive(Serialize)]
struct ImportBatchResult {
    queued: usize,
    processed: usize,
    rejected: usize,
    total: usize,
}

#[derive(Serialize)]
struct ImportEventsResult {
    added: usize,
    merged: usize,
    rejected: usize,
}

#[derive(Serialize)]
struct ProcessEventsResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    busy: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    added: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    merged: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rejected: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pending: Option<usize>,
}

#[derive(Clone, Serialize, Default)]
struct CheckDidsByType {
    agents: usize,
    assets: usize,
    confirmed: usize,
    unconfirmed: usize,
    ephemeral: usize,
    invalid: usize,
}

#[derive(Clone, Serialize, Default)]
struct CheckDidsResult {
    total: usize,
    byType: CheckDidsByType,
    byRegistry: HashMap<String, usize>,
    byVersion: HashMap<String, usize>,
    eventsQueue: Vec<EventRecord>,
}

#[derive(Serialize, Default)]
struct VerifyDbResult {
    total: usize,
    verified: usize,
    expired: usize,
    invalid: usize,
}

enum ImportStatus {
    Added,
    Merged,
    Rejected,
    Deferred,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Config::from_env()?;
    let metrics = Arc::new(Metrics::new(&config)?);
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("failed to create HTTP client")?;
    let store = Arc::new(Mutex::new(JsonDb::load(&config)?));

    let state = AppState {
        config: config.clone(),
        client,
        metrics,
        store,
        events_seen: Arc::new(Mutex::new(HashMap::new())),
        verified_dids: Arc::new(Mutex::new(HashMap::new())),
        supported_registries: Arc::new(Mutex::new(config.registries.clone())),
        processing_events: Arc::new(Mutex::new(false)),
        started_at: Instant::now(),
    };

    let app = Router::new()
        .route("/metrics", get(get_metrics))
        .nest(
            "/api/v1",
            Router::new()
                .route("/ready", get(ready))
                .route("/version", get(version))
                .route("/status", get(status))
                .route("/registries", get(registries))
                .route("/did", post(create_did))
                .route("/did/generate", post(generate_did))
                .route("/did/:did", get(resolve_did))
                .route("/dids", post(list_dids))
                .route("/dids/", post(list_dids))
                .route("/dids/remove", post(remove_dids))
                .route("/dids/export", post(export_dids))
                .route("/dids/import", post(import_dids))
                .route("/batch/export", post(export_batch))
                .route("/batch/import", post(import_batch))
                .route("/batch/import/cids", post(import_batch_by_cids))
                .route("/queue/:registry", get(get_queue))
                .route("/queue/:registry/clear", post(clear_queue))
                .route("/db/reset", get(db_reset))
                .route("/db/verify", get(db_verify))
                .route("/events/process", post(process_events_route))
                .route("/ipfs/json", post(ipfs_add_json))
                .route("/ipfs/json/:cid", get(ipfs_get_json))
                .route("/ipfs/text", post(ipfs_add_text))
                .route("/ipfs/text/:cid", get(ipfs_get_text))
                .route("/ipfs/data", post(ipfs_add_data))
                .route("/ipfs/data/:cid", get(ipfs_get_data))
                .route("/ipfs/stream", post(ipfs_add_stream))
                .route("/ipfs/stream/:cid", get(ipfs_get_stream))
                .route("/block/:registry/latest", get(get_latest_block))
                .route("/block/:registry/:blockId", get(get_block_by_id))
                .route("/block/:registry", post(add_block))
                .route("/search", get(search_docs))
                .route("/query", post(query_docs)),
        )
        .nest("/api", Router::new().fallback(api_not_found))
        .fallback(not_found)
        .with_state(state.clone());

    refresh_metrics_snapshot(&state).await;
    start_background_tasks(state.clone());

    let listener = TcpListener::bind(SocketAddr::new(config.bind_address, config.port))
        .await
        .with_context(|| format!("failed to bind {}:{}", config.bind_address, config.port))?;

    info!(
        port = config.port,
        bind_address = %config.bind_address,
        db = %config.db,
        "Native Rust Gatekeeper listening"
    );

    axum::serve(listener, app).await.context("server failed")?;
    Ok(())
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    record_metrics(&state, "GET", "/ready", 200, 0.0);
    Json(true)
}

async fn version(State(state): State<AppState>) -> impl IntoResponse {
    record_metrics(&state, "GET", "/version", 200, 0.0);
    Json(VersionPayload {
        version: state.config.version.clone(),
        commit: state.config.git_commit.clone(),
    })
}

async fn status(State(state): State<AppState>) -> impl IntoResponse {
    let dids = check_dids_impl(&state, None, false).await;
    update_metrics_from_check(&state, &dids).await;
    let payload = StatusPayload {
        uptimeSeconds: state.started_at.elapsed().as_secs(),
        dids: serde_json::to_value(dids).unwrap_or_else(|_| json!({})),
        memoryUsage: MemoryUsage {
            rss: 0,
            heapTotal: 0,
            heapUsed: 0,
            external: 0,
            arrayBuffers: 0,
        },
    };

    record_metrics(&state, "GET", "/status", 200, 0.0);
    Json(payload)
}

async fn registries(State(state): State<AppState>) -> impl IntoResponse {
    record_metrics(&state, "GET", "/registries", 200, 0.0);
    Json(state.supported_registries.lock().await.clone())
}

async fn generate_did(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let start = Instant::now();
    match generate_did_from_operation(&state.config, &payload) {
        Ok(did) => {
            record_metrics(&state, "POST", "/did/generate", 200, start.elapsed().as_secs_f64());
            Json(json!(did)).into_response()
        }
        Err(error) => {
            record_metrics(&state, "POST", "/did/generate", 400, start.elapsed().as_secs_f64());
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response()
        }
    }
}

async fn create_did(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let start = Instant::now();
    let op_type = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let registry = payload
        .get("registration")
        .and_then(|v| v.get("registry"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let result = handle_did_operation(&state, &payload).await;

    match result {
        Ok(result_value) => {
            state
                .metrics
                .did_operations_total
                .with_label_values(&[&op_type, &registry, "success"])
                .inc();
            refresh_metrics_snapshot(&state).await;
            record_metrics(&state, "POST", "/did", 200, start.elapsed().as_secs_f64());
            Json(result_value).into_response()
        }
        Err(error) => {
            state
                .metrics
                .did_operations_total
                .with_label_values(&[&op_type, &registry, "error"])
                .inc();
            let status = StatusCode::INTERNAL_SERVER_ERROR;
            record_metrics(&state, "POST", "/did", status.as_u16(), start.elapsed().as_secs_f64());
            (
                status,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response()
        }
    }
}

async fn list_dids(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let start = Instant::now();
    let resolve = payload.get("resolve").and_then(Value::as_bool).unwrap_or(false);
    let updated_after = payload.get("updatedAfter").and_then(Value::as_str).map(ToString::to_string);
    let updated_before = payload.get("updatedBefore").and_then(Value::as_str).map(ToString::to_string);
    let resolve_options = ResolveOptions {
        version_time: payload.get("versionTime").and_then(Value::as_str).map(ToString::to_string),
        version_sequence: payload
            .get("versionSequence")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok()),
        confirm: payload.get("confirm").and_then(Value::as_bool).unwrap_or(false),
        verify: payload.get("verify").and_then(Value::as_bool).unwrap_or(false),
    };
    let requested = payload
        .get("dids")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        });

    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, requested.as_deref())
    };

    if resolve || updated_after.is_some() || updated_before.is_some() {
        let mut docs = Vec::new();
        let mut filtered_dids = Vec::new();
        for did in dids {
            let doc = resolve_local_doc_async(&state, &did, resolve_options.clone()).await;
            let Ok(doc) = doc else {
                continue;
            };

            let updated = doc
                .get("didDocumentMetadata")
                .and_then(|value| value.get("updated").or_else(|| value.get("created")))
                .and_then(Value::as_str)
                .unwrap_or("");

            if let Some(after) = updated_after.as_deref() {
                if updated <= after {
                    continue;
                }
            }
            if let Some(before) = updated_before.as_deref() {
                if updated >= before {
                    continue;
                }
            }

            if resolve {
                docs.push(doc);
            } else {
                filtered_dids.push(did);
            }
        }
        record_metrics(&state, "POST", "/dids/", 200, start.elapsed().as_secs_f64());
        if resolve {
            Json(json!(docs)).into_response()
        } else {
            Json(json!(filtered_dids)).into_response()
        }
    } else {
        record_metrics(&state, "POST", "/dids/", 200, start.elapsed().as_secs_f64());
        Json(json!(dids)).into_response()
    }
}

async fn export_dids(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let start = Instant::now();
    let requested = payload.get("dids").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    });

    let store = state.store.lock().await;
    let dids = store.list_dids(&state.config.did_prefix, requested.as_deref());
    let batch = dids
        .iter()
        .map(|did| store.get_events(did))
        .collect::<Vec<_>>();

    record_metrics(&state, "POST", "/dids/export", 200, start.elapsed().as_secs_f64());
    Json(json!(batch)).into_response()
}

async fn remove_dids(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let dids = match payload.get("dids").and_then(Value::as_array) {
        Some(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        None if payload.is_array() => payload
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        None => Vec::new(),
    };

    if dids.is_empty() {
        record_metrics(&state, "POST", "/dids/remove", 500, start.elapsed().as_secs_f64());
        return text_error_response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid parameter: dids");
    }

    let mut store = state.store.lock().await;
    let ok = dids.iter().all(|did| store.delete_events(did).is_ok());
    drop(store);
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/dids/remove", 200, start.elapsed().as_secs_f64());
    Json(json!(ok)).into_response()
}

async fn import_dids(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let did_batches = match payload.as_array() {
        Some(items) => items,
        None => {
            record_metrics(&state, "POST", "/dids/import", 500, start.elapsed().as_secs_f64());
            return text_error_response(StatusCode::INTERNAL_SERVER_ERROR, "TypeError: dids.flat is not a function");
        }
    };

    let flat_batch = did_batches
        .iter()
        .filter_map(Value::as_array)
        .flat_map(|events| events.iter().cloned())
        .collect::<Vec<_>>();

    let result = import_batch_impl(&state, &flat_batch).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/dids/import", 200, start.elapsed().as_secs_f64());
    Json(json!(result)).into_response()
}

async fn export_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let requested = payload.get("dids").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect::<Vec<_>>()
    });

    let store = state.store.lock().await;
    let dids = store.list_dids(&state.config.did_prefix, requested.as_deref());
    let mut events = Vec::new();
    for did in dids {
        let did_events = store.get_events(&did);
        if let Some(create) = did_events.first() {
            let registry = create
                .operation
                .get("registration")
                .and_then(|value| value.get("registry"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if registry != "local" {
                events.extend(did_events);
            }
        }
    }

    events.sort_by(|a, b| {
        let left = a
            .operation
            .get("proof")
            .and_then(|value| value.get("created"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let right = b
            .operation
            .get("proof")
            .and_then(|value| value.get("created"))
            .and_then(Value::as_str)
            .unwrap_or("");
        left.cmp(right)
    });

    record_metrics(&state, "POST", "/batch/export", 200, start.elapsed().as_secs_f64());
    Json(json!(events)).into_response()
}

async fn import_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let batch = match payload.as_array() {
        Some(items) => items.iter().cloned().collect::<Vec<_>>(),
        None => {
            record_metrics(&state, "POST", "/batch/import", 500, start.elapsed().as_secs_f64());
            return text_error_response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid parameter: batch");
        }
    };

    let result = import_batch_impl(&state, &batch).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/batch/import", 200, start.elapsed().as_secs_f64());
    Json(json!(result)).into_response()
}

async fn import_batch_by_cids(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let cids = match payload.get("cids").and_then(Value::as_array) {
        Some(items) if !items.is_empty() => items,
        _ => {
            record_metrics(&state, "POST", "/batch/import/cids", 500, start.elapsed().as_secs_f64());
            return text_error_response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid parameter: cids");
        }
    };
    let metadata = match payload.get("metadata") {
        Some(value) if value.is_object() => value,
        _ => {
            record_metrics(&state, "POST", "/batch/import/cids", 500, start.elapsed().as_secs_f64());
            return text_error_response(StatusCode::INTERNAL_SERVER_ERROR, "Invalid parameter: metadata");
        }
    };

    let mut batch = Vec::new();
    for (index, cid) in cids.iter().filter_map(Value::as_str).enumerate() {
        let mut operation = {
            let store = state.store.lock().await;
            store.get_operation(cid)
        };

        if operation.is_none() {
            operation = fetch_ipfs_json(&state, cid).await;
            if let Some(op) = operation.as_ref() {
                let mut store = state.store.lock().await;
                if let Err(error) = store.add_operation(cid, op.clone()) {
                    error!("failed to persist imported operation {cid}: {error}");
                }
            }
        }

        if let Some(operation) = operation {
            let ordinal = metadata
                .get("ordinal")
                .and_then(Value::as_array)
                .map(|items| {
                    let mut values = items
                        .iter()
                        .filter_map(Value::as_u64)
                        .filter_map(|value| u32::try_from(value).ok())
                        .collect::<Vec<_>>();
                    values.push(index as u32);
                    values
                })
                .unwrap_or_else(|| vec![index as u32]);

            batch.push(json!({
                "registry": metadata.get("registry").cloned().unwrap_or(Value::String("hyperswarm".to_string())),
                "time": metadata.get("time").cloned().unwrap_or(Value::String(chrono_like_now())),
                "ordinal": ordinal,
                "operation": operation,
                "opid": cid,
                "registration": metadata.get("registration").cloned().unwrap_or(Value::Null)
            }));
        }
    }

    let result = import_batch_impl(&state, &batch).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/batch/import/cids", 200, start.elapsed().as_secs_f64());
    Json(json!(result)).into_response()
}

async fn get_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(registry): Path<String>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    if !is_valid_registry(&registry) {
        record_metrics(&state, "GET", "/queue/:registry", 500, start.elapsed().as_secs_f64());
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Invalid parameter: registry={registry}"),
        );
    }

    {
        let mut supported = state.supported_registries.lock().await;
        if !supported.contains(&registry) {
            supported.push(registry.clone());
        }
    }

    let store = state.store.lock().await;
    let queue = store.get_queue(&registry);
    record_metrics(&state, "GET", "/queue/:registry", 200, start.elapsed().as_secs_f64());
    Json(json!(queue)).into_response()
}

async fn clear_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(registry): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    if !is_valid_registry(&registry) {
        record_metrics(&state, "POST", "/queue/:registry/clear", 500, start.elapsed().as_secs_f64());
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Invalid parameter: registry={registry}"),
        );
    }

    let events = payload.as_array().cloned().unwrap_or_default();
    let operations = events
        .into_iter()
        .filter(|value| value.is_object())
        .collect::<Vec<_>>();

    let mut store = state.store.lock().await;
    let ok = store.clear_queue(&registry, &operations).is_ok();
    drop(store);
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/queue/:registry/clear", 200, start.elapsed().as_secs_f64());
    Json(json!(ok)).into_response()
}

async fn process_events_route(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let result = process_events_impl(&state).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/events/process", 200, start.elapsed().as_secs_f64());
    Json(json!(result)).into_response()
}

async fn db_reset(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    if env::var("NODE_ENV").ok().as_deref() == Some("production") {
        record_metrics(&state, "GET", "/db/reset", 403, start.elapsed().as_secs_f64());
        return (
            StatusCode::FORBIDDEN,
            Json(json!({ "error": "Database reset is disabled in production" })),
        )
            .into_response();
    }

    let ok = {
        let mut store = state.store.lock().await;
        store.reset_db().is_ok()
    };
    state.events_seen.lock().await.clear();
    state.verified_dids.lock().await.clear();
    *state.supported_registries.lock().await = state.config.registries.clone();
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "GET", "/db/reset", 200, start.elapsed().as_secs_f64());
    Json(json!(ok)).into_response()
}

async fn db_verify(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let result = verify_db_impl(&state, false).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "GET", "/db/verify", 200, start.elapsed().as_secs_f64());
    Json(json!(result)).into_response()
}

async fn search_docs(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let start = Instant::now();
    let q = query.get("q").cloned().unwrap_or_default();
    if q.is_empty() {
        record_metrics(&state, "GET", "/search", 200, start.elapsed().as_secs_f64());
        return Json(json!([])).into_response();
    }

    let result = search_docs_impl(&state, &q).await;
    record_metrics(&state, "GET", "/search", 200, start.elapsed().as_secs_f64());
    Json(json!(result)).into_response()
}

async fn query_docs(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let start = Instant::now();
    let Some(where_clause) = payload.get("where") else {
        record_metrics(&state, "POST", "/query", 400, start.elapsed().as_secs_f64());
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "`where` must be an object" })),
        )
            .into_response();
    };
    if !where_clause.is_object() {
        record_metrics(&state, "POST", "/query", 400, start.elapsed().as_secs_f64());
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "`where` must be an object" })),
        )
            .into_response();
    }

    match query_docs_impl(&state, where_clause).await {
        Ok(result) => {
            record_metrics(&state, "POST", "/query", 200, start.elapsed().as_secs_f64());
            Json(json!(result)).into_response()
        }
        Err(error) => {
            record_metrics(&state, "POST", "/query", 500, start.elapsed().as_secs_f64());
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response()
        }
    }
}

async fn get_latest_block(State(state): State<AppState>, Path(registry): Path<String>) -> Response {
    let start = Instant::now();
    if !is_valid_registry(&registry) {
        record_metrics(&state, "GET", "/block/:registry/latest", 500, start.elapsed().as_secs_f64());
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Invalid parameter: registry={registry}"),
        );
    }

    let store = state.store.lock().await;
    let block = store.get_block(&registry, None);
    record_metrics(&state, "GET", "/block/:registry/latest", 200, start.elapsed().as_secs_f64());
    Json(json!(block)).into_response()
}

async fn get_block_by_id(
    State(state): State<AppState>,
    Path((registry, block_id)): Path<(String, String)>,
) -> Response {
    let start = Instant::now();
    if !is_valid_registry(&registry) {
        record_metrics(&state, "GET", "/block/:registry/:blockId", 500, start.elapsed().as_secs_f64());
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Invalid parameter: registry={registry}"),
        );
    }

    let block_key = block_id.parse::<u64>().ok().map(BlockLookup::Height).unwrap_or(BlockLookup::Hash(block_id));
    let store = state.store.lock().await;
    let block = store.get_block(&registry, Some(block_key));
    record_metrics(&state, "GET", "/block/:registry/:blockId", 200, start.elapsed().as_secs_f64());
    Json(json!(block)).into_response()
}

async fn add_block(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(registry): Path<String>,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    if !is_valid_registry(&registry) {
        record_metrics(&state, "POST", "/block/:registry", 500, start.elapsed().as_secs_f64());
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Invalid parameter: registry={registry}"),
        );
    }

    let mut store = state.store.lock().await;
    let ok = store.add_block(&registry, payload).is_ok();
    drop(store);
    refresh_metrics_snapshot(&state).await;
    record_metrics(&state, "POST", "/block/:registry", 200, start.elapsed().as_secs_f64());
    Json(json!(ok)).into_response()
}

async fn resolve_did(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let start = Instant::now();
    let resolve_options = ResolveOptions {
        version_time: query.get("versionTime").cloned(),
        version_sequence: query
            .get("versionSequence")
            .and_then(|value| value.parse::<usize>().ok()),
        confirm: query.get("confirm").map(|value| value == "true").unwrap_or(false),
        verify: query.get("verify").map(|value| value == "true").unwrap_or(false),
    };

    if let Ok(doc) = resolve_local_doc_async(&state, &did, resolve_options.clone()).await {
        record_metrics(&state, "GET", "/did/:did", 200, start.elapsed().as_secs_f64());
        return Json(doc).into_response();
    }

    if state.config.fallback_url.trim().is_empty() {
        record_metrics(&state, "GET", "/did/:did", 404, start.elapsed().as_secs_f64());
        return (StatusCode::NOT_FOUND, Json(json!({ "error": "DID not found" }))).into_response();
    }

    let mut url = format!(
        "{}/1.0/identifiers/{}",
        state.config.fallback_url.trim_end_matches('/'),
        url_encode_component(&did)
    );

    if !query.is_empty() {
        let mut params: Vec<String> = query.into_iter().map(|(k, v)| format!("{}={}", url_encode_component(&k), url_encode_component(&v))).collect();
        params.sort();
        url.push('?');
        url.push_str(&params.join("&"));
    }

    let response = match state
        .client
        .get(url)
        .timeout(Duration::from_millis(state.config.fallback_timeout_ms))
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            error!("resolve DID fallback failed: {error}");
            record_metrics(&state, "GET", "/did/:did", 404, start.elapsed().as_secs_f64());
            return (StatusCode::NOT_FOUND, Json(json!({ "error": "DID not found" }))).into_response();
        }
    };

    let status = response.status();
    let body = match response.bytes().await {
        Ok(body) => body,
        Err(error) => {
            error!("resolve DID body read failed: {error}");
            record_metrics(&state, "GET", "/did/:did", 502, start.elapsed().as_secs_f64());
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "failed to read DID response" })),
            )
                .into_response();
        }
    };

    let status_code = status.as_u16();
    record_metrics(&state, "GET", "/did/:did", status_code, start.elapsed().as_secs_f64());

    let mut builder = Response::builder().status(status);
    builder = builder.header(header::CONTENT_TYPE, "application/json");
    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[async_recursion]
async fn resolve_local_doc_async(state: &AppState, did: &str, options: ResolveOptions) -> Result<Value> {
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
        did_document_registration: {
            let mut value = Value::Object(registration.clone());
            if value.get("created").is_none() {
                value["created"] = Value::String(created.clone());
            }
            value
        },
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

async fn handle_did_operation(state: &AppState, payload: &Value) -> Result<Value, String> {
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
        "create" => generate_did_from_operation(&state.config, payload).map_err(|error| error.to_string())?,
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

async fn ipfs_add_json(State(state): State<AppState>, Json(payload): Json<Value>) -> Response {
    let start = Instant::now();
    proxy_ipfs_add(
        &state,
        "json",
        vec![("pin".to_string(), "true".to_string())],
        reqwest::multipart::Form::new().text("file", payload.to_string()),
        "/ipfs/json",
        start,
    )
    .await
}

async fn ipfs_get_json(State(state): State<AppState>, Path(cid): Path<String>) -> Response {
    let start = Instant::now();
    proxy_ipfs_cat(&state, &cid, "application/json", "/ipfs/json/:cid", start).await
}

async fn ipfs_add_text(State(state): State<AppState>, request: Request) -> Response {
    let start = Instant::now();
    let body = match request_body_bytes(request, state.config.upload_limit).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    proxy_ipfs_add(
        &state,
        "text",
        vec![("pin".to_string(), "true".to_string())],
        reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(body.to_vec()).mime_str("text/plain").unwrap(),
        ),
        "/ipfs/text",
        start,
    )
    .await
}

async fn ipfs_get_text(State(state): State<AppState>, Path(cid): Path<String>) -> Response {
    let start = Instant::now();
    proxy_ipfs_cat(&state, &cid, "text/plain; charset=utf-8", "/ipfs/text/:cid", start).await
}

async fn ipfs_add_data(State(state): State<AppState>, request: Request) -> Response {
    let start = Instant::now();
    let body = match request_body_bytes(request, state.config.upload_limit).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    proxy_ipfs_add(
        &state,
        "data",
        vec![("pin".to_string(), "true".to_string())],
        reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(body.to_vec())
                .mime_str("application/octet-stream")
                .unwrap(),
        ),
        "/ipfs/data",
        start,
    )
    .await
}

async fn ipfs_get_data(State(state): State<AppState>, Path(cid): Path<String>) -> Response {
    let start = Instant::now();
    proxy_ipfs_cat(&state, &cid, "application/octet-stream", "/ipfs/data/:cid", start).await
}

async fn ipfs_add_stream(State(state): State<AppState>, request: Request) -> Response {
    let start = Instant::now();
    let body = match request_body_bytes(request, state.config.upload_limit).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    proxy_ipfs_add(
        &state,
        "stream",
        vec![("pin".to_string(), "true".to_string())],
        reqwest::multipart::Form::new().part("file", reqwest::multipart::Part::bytes(body.to_vec())),
        "/ipfs/stream",
        start,
    )
    .await
}

async fn ipfs_get_stream(
    State(state): State<AppState>,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let start = Instant::now();
    let response = proxy_ipfs_cat_raw(&state, &cid).await;

    let (status, body) = match response {
        Ok(value) => value,
        Err(response) => return response,
    };

    let content_type = query
        .get("type")
        .cloned()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let mut builder = Response::builder().status(status);
    builder = builder.header(header::CONTENT_TYPE, content_type);

    if let Some(filename) = query.get("filename") {
        builder = builder.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}\"", filename.replace('"', "")),
        );
    }

    record_metrics(
        &state,
        "GET",
        "/ipfs/stream/:cid",
        status.as_u16(),
        start.elapsed().as_secs_f64(),
    );

    builder
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn get_metrics(State(state): State<AppState>) -> Response {
    let encoder = TextEncoder::new();
    let metric_families = state.metrics.registry.gather();
    let mut buffer = Vec::new();

    if encoder.encode(&metric_families, &mut buffer).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, encoder.format_type())
        .body(Body::from(buffer))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn not_implemented(State(state): State<AppState>) -> Response {
    record_metrics(&state, "ANY", "/native-port-todo", 501, 0.0);
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": "native Rust port of this endpoint is not implemented yet" })),
    )
        .into_response()
}

async fn not_implemented_admin(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    record_metrics(&state, "ANY", "/native-port-todo-admin", 501, 0.0);
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({ "error": "native Rust admin endpoint is not implemented yet" })),
    )
        .into_response()
}

async fn not_found(State(state): State<AppState>, request: Request) -> Response {
    let route = normalize_path(request.uri().path());
    record_metrics(&state, request.method().as_str(), &route, 404, 0.0);
    (StatusCode::NOT_FOUND, Json(json!({ "message": "Endpoint not found" }))).into_response()
}

async fn api_not_found(State(state): State<AppState>, request: Request) -> Response {
    let route = normalize_path(request.uri().path());
    record_metrics(&state, request.method().as_str(), &route, 404, 0.0);
    (StatusCode::NOT_FOUND, Json(json!({ "message": "Endpoint not found" }))).into_response()
}

fn text_error_response(status: StatusCode, message: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(message.to_string()))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn request_body_bytes(request: Request, limit: usize) -> Result<Bytes, Response> {
    let (_parts, body) = request.into_parts();
    to_bytes(body, limit)
        .await
        .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "request body too large" }))).into_response())
}

async fn proxy_ipfs_add(
    state: &AppState,
    _kind: &str,
    query: Vec<(String, String)>,
    form: reqwest::multipart::Form,
    route: &str,
    start: Instant,
) -> Response {
    let url = format!("{}/add", state.config.ipfs_url.trim_end_matches('/'));
    let response = state.client.post(url).query(&query).multipart(form).send().await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            error!("ipfs add request failed: {error}");
            record_metrics(state, "POST", route, 502, start.elapsed().as_secs_f64());
            return (StatusCode::BAD_GATEWAY, error_json("IPFS add failed")).into_response();
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            error!("ipfs add body read failed: {error}");
            record_metrics(state, "POST", route, 502, start.elapsed().as_secs_f64());
            return (StatusCode::BAD_GATEWAY, error_json("IPFS add response failed")).into_response();
        }
    };

    let cid = extract_ipfs_hash(&body).unwrap_or(body.trim().to_string());
    record_metrics(state, "POST", route, status.as_u16(), start.elapsed().as_secs_f64());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(cid))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn proxy_ipfs_cat(state: &AppState, cid: &str, content_type: &str, route: &str, start: Instant) -> Response {
    let response = proxy_ipfs_cat_raw(state, cid).await;

    let (status, body) = match response {
        Ok(value) => value,
        Err(response) => {
            record_metrics(state, "GET", route, 502, start.elapsed().as_secs_f64());
            return response;
        }
    };

    record_metrics(state, "GET", route, status.as_u16(), start.elapsed().as_secs_f64());
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn proxy_ipfs_cat_raw(state: &AppState, cid: &str) -> Result<(StatusCode, Bytes), Response> {
    let url = format!("{}/cat", state.config.ipfs_url.trim_end_matches('/'));
    let response = state
        .client
        .post(url)
        .query(&[("arg", cid)])
        .send()
        .await
        .map_err(|error| {
            error!("ipfs cat request failed: {error}");
            (StatusCode::BAD_GATEWAY, error_json("IPFS cat failed")).into_response()
        })?;

    let status = response.status();
    let body = response.bytes().await.map_err(|error| {
        error!("ipfs cat body read failed: {error}");
        (StatusCode::BAD_GATEWAY, error_json("IPFS cat response failed")).into_response()
    })?;

    Ok((status, body))
}

fn error_json(message: &str) -> Json<Value> {
    Json(json!({ "error": message }))
}

enum BlockLookup {
    Height(u64),
    Hash(String),
}

async fn queue_outbound_operation(state: &AppState, registry: &str, operation: Value) -> Result<()> {
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

async fn fetch_ipfs_json(state: &AppState, cid: &str) -> Option<Value> {
    let response = proxy_ipfs_cat_raw(state, cid).await.ok()?;
    let (_status, body) = response;
    serde_json::from_slice::<Value>(&body).ok()
}

fn is_valid_registry(registry: &str) -> bool {
    matches!(
        registry,
        "local" | "hyperswarm" | "BTC:mainnet" | "BTC:testnet4" | "BTC:signet"
    )
}

fn compare_ordinals(left: Option<&Vec<u32>>, right: Option<&Vec<u32>>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => {
            for (l, r) in left.iter().zip(right.iter()) {
                match l.cmp(r) {
                    std::cmp::Ordering::Equal => continue,
                    other => return other,
                }
            }
            left.len().cmp(&right.len())
        }
        _ => std::cmp::Ordering::Equal,
    }
}

fn expected_registry_for_index(events: &[EventRecord], index: usize) -> Option<String> {
    if events.is_empty() {
        return None;
    }
    if index == 0 {
        return events[0]
            .operation
            .get("registration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
    }

    let mut registry = events[0]
        .operation
        .get("registration")
        .and_then(|value| value.get("registry"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    for event in events.iter().take(index).skip(1) {
        if event.operation.get("type").and_then(Value::as_str) == Some("update") {
            if let Some(next_registry) = event
                .operation
                .get("doc")
                .and_then(|value| value.get("didDocumentRegistration"))
                .and_then(|value| value.get("registry"))
                .and_then(Value::as_str)
            {
                registry = Some(next_registry.to_string());
            }
        }
    }

    registry
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

fn infer_event_did(config: &Config, event: &Value) -> Result<String> {
    if let Some(did) = event.get("did").and_then(Value::as_str) {
        return Ok(did.to_string());
    }

    let operation = event
        .get("operation")
        .context("missing event.operation")?;
    if let Some(did) = operation.get("did").and_then(Value::as_str) {
        return Ok(did.to_string());
    }

    generate_did_from_operation(config, operation)
}

fn ensure_event_opid(event: &mut Value) -> Result<String> {
    if let Some(opid) = event.get("opid").and_then(Value::as_str) {
        return Ok(opid.to_string());
    }

    let operation = event
        .get("operation")
        .context("missing event.operation")?;
    let opid = generate_json_cid(operation)?;
    event["opid"] = Value::String(opid.clone());
    Ok(opid)
}

fn verify_event_shape(event: &Value) -> bool {
    let Some(registry) = event.get("registry").and_then(Value::as_str) else {
        return false;
    };
    if !is_valid_registry(registry) {
        return false;
    }

    if event.get("time").and_then(Value::as_str).is_none() {
        return false;
    }

    let Some(operation) = event.get("operation") else {
        return false;
    };
    let Some(op_type) = operation.get("type").and_then(Value::as_str) else {
        return false;
    };
    match op_type {
        "create" => {
            operation.get("created").and_then(Value::as_str).is_some()
                && operation.get("registration").is_some()
                && operation
                    .get("registration")
                    .and_then(|value| value.get("registry"))
                    .and_then(Value::as_str)
                    .map(is_valid_registry)
                    .unwrap_or(false)
                && operation
                    .get("registration")
                    .and_then(|value| value.get("version"))
                    .and_then(Value::as_i64)
                    == Some(1)
                && matches!(
                    operation
                        .get("registration")
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str),
                    Some("agent" | "asset")
                )
                && operation
                    .get("proof")
                    .and_then(|value| value.get("proofValue"))
                    .and_then(Value::as_str)
                    .is_some()
        }
        "update" => {
            operation.get("did").and_then(Value::as_str).is_some()
                && operation
                    .get("doc")
                    .map(|doc| {
                        doc.get("didDocument").is_some()
                            || doc.get("didDocumentData").is_some()
                            || doc.get("didDocumentRegistration").is_some()
                    })
                    .unwrap_or(false)
                && operation
                    .get("proof")
                    .and_then(|value| value.get("proofValue"))
                    .and_then(Value::as_str)
                    .is_some()
        }
        "delete" => {
            operation.get("did").and_then(Value::as_str).is_some()
                && operation
                    .get("proof")
                    .and_then(|value| value.get("proofValue"))
                    .and_then(Value::as_str)
                    .is_some()
        }
        _ => false,
    }
}

fn verify_did_format(did: &str) -> bool {
    did.starts_with("did:")
}

fn verify_date_format(time: Option<&str>) -> bool {
    time.and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some()
}

fn verify_proof_format(proof: Option<&Value>) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    if proof.get("type").and_then(Value::as_str) != Some("EcdsaSecp256k1Signature2019") {
        return false;
    }
    if !verify_date_format(proof.get("created").and_then(Value::as_str)) {
        return false;
    }
    if !matches!(
        proof.get("proofPurpose").and_then(Value::as_str),
        Some("assertionMethod" | "authentication")
    ) {
        return false;
    }
    let Some(verification_method) = proof.get("verificationMethod").and_then(Value::as_str) else {
        return false;
    };
    if !verification_method.contains('#') {
        return false;
    }
    let did = verification_method.split('#').next().unwrap_or_default();
    if !did.is_empty() && !verify_did_format(did) {
        return false;
    }
    proof.get("proofValue").and_then(Value::as_str).is_some()
}

fn value_without_proof(value: &Value) -> Value {
    let mut copy = value.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("proof");
    }
    copy
}

fn base64url_to_bytes(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .with_context(|| "invalid base64url")
}

fn public_jwk_to_sec1_bytes(public_jwk: &Value) -> Result<Vec<u8>> {
    if public_jwk.get("kty").and_then(Value::as_str) != Some("EC") {
        anyhow::bail!("Invalid operation: publicJwk");
    }
    if public_jwk.get("crv").and_then(Value::as_str) != Some("secp256k1") {
        anyhow::bail!("Invalid operation: publicJwk");
    }

    let x_bytes = base64url_to_bytes(
        public_jwk
            .get("x")
            .and_then(Value::as_str)
            .context("Invalid operation: publicJwk")?,
    )?;
    let y_bytes = base64url_to_bytes(
        public_jwk
            .get("y")
            .and_then(Value::as_str)
            .context("Invalid operation: publicJwk")?,
    )?;

    if x_bytes.len() != 32 || y_bytes.len() != 32 {
        anyhow::bail!("Invalid operation: publicJwk");
    }

    let prefix = if y_bytes.last().copied().unwrap_or_default() % 2 == 0 {
        0x02
    } else {
        0x03
    };

    let mut compressed = Vec::with_capacity(33);
    compressed.push(prefix);
    compressed.extend_from_slice(&x_bytes);
    Ok(compressed)
}

fn verify_sig(msg_hash_hex: &str, proof_value: &str, public_jwk: &Value) -> Result<bool> {
    let msg_hash = hex_to_bytes(msg_hash_hex)?;
    let sig_bytes = base64url_to_bytes(proof_value)?;
    let compressed_key = public_jwk_to_sec1_bytes(public_jwk)?;
    let verifying_key = VerifyingKey::from_sec1_bytes(&compressed_key)
        .with_context(|| "Invalid operation: publicJwk")?;
    let signature = K256Signature::from_slice(&sig_bytes).with_context(|| "Invalid operation: proof")?;
    Ok(verifying_key.verify_prehash(&msg_hash, &signature).is_ok())
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        anyhow::bail!("invalid hex");
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).with_context(|| "invalid hex"))
        .collect()
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

#[async_recursion]
async fn verify_create_operation_impl(state: &AppState, operation: &Value) -> Result<bool> {
    if operation.is_null() {
        anyhow::bail!("Invalid operation: missing");
    }
    if operation.to_string().len() > 64 * 1024 {
        anyhow::bail!("Invalid operation: size");
    }
    if operation.get("type").and_then(Value::as_str) != Some("create") {
        anyhow::bail!(
            "Invalid operation: type={}",
            operation.get("type").and_then(Value::as_str).unwrap_or("unknown")
        );
    }
    if !verify_date_format(operation.get("created").and_then(Value::as_str)) {
        anyhow::bail!(
            "Invalid operation: created={}",
            operation.get("created").and_then(Value::as_str).unwrap_or_default()
        );
    }

    let registration = operation
        .get("registration")
        .context("Invalid operation: registration")?;
    let version = registration
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("Invalid operation: registration.version=null"))?;
    if version != 1 {
        anyhow::bail!("Invalid operation: registration.version={version}");
    }
    let reg_type = registration
        .get("type")
        .and_then(Value::as_str)
        .context("Invalid operation: registration.type")?;
    if !matches!(reg_type, "agent" | "asset") {
        anyhow::bail!("Invalid operation: registration.type={reg_type}");
    }
    let registry = registration
        .get("registry")
        .and_then(Value::as_str)
        .context("Invalid operation: registration.registry")?;
    if !is_valid_registry(registry) {
        anyhow::bail!("Invalid operation: registration.registry={registry}");
    }
    if !verify_proof_format(operation.get("proof")) {
        anyhow::bail!("Invalid operation: proof");
    }

    let proof = operation.get("proof").context("Invalid operation: proof")?;
    if reg_type == "agent" && proof.get("verificationMethod").and_then(Value::as_str) != Some("#key-1") {
        anyhow::bail!("Invalid operation: proof.verificationMethod must be #key-1 for agent create");
    }
    if let Some(valid_until) = registration.get("validUntil").and_then(Value::as_str) {
        if !verify_date_format(Some(valid_until)) {
            anyhow::bail!("Invalid operation: registration.validUntil={valid_until}");
        }
    }

    let operation_copy = value_without_proof(operation);
    let msg_hash = generate_message_hash(&operation_copy)?;
    let proof_value = proof
        .get("proofValue")
        .and_then(Value::as_str)
        .context("Invalid operation: proof")?;

    if reg_type == "agent" {
        let public_jwk = operation
            .get("publicJwk")
            .context("Invalid operation: publicJwk")?;
        return verify_sig(&msg_hash, proof_value, public_jwk);
    }

    let controller_did = proof
        .get("verificationMethod")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split('#')
        .next()
        .unwrap_or_default()
        .to_string();
    if operation.get("controller").and_then(Value::as_str) != Some(controller_did.as_str()) {
        anyhow::bail!("Invalid operation: signer is not controller");
    }

    let controller_doc = resolve_local_doc_async(
        state,
        &controller_did,
        ResolveOptions {
            confirm: true,
            version_time: proof.get("created").and_then(Value::as_str).map(ToString::to_string),
            ..ResolveOptions::default()
        },
    )
    .await?;

    if controller_doc
        .get("didDocumentRegistration")
        .and_then(|value| value.get("registry"))
        .and_then(Value::as_str)
        == Some("local")
        && registry != "local"
    {
        anyhow::bail!("Invalid operation: non-local registry={registry}");
    }

    let public_jwk = controller_doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|value| value.get("publicKeyJwk"))
        .context("Invalid operation: didDocument missing verificationMethod")?;

    verify_sig(&msg_hash, proof_value, public_jwk)
}

#[async_recursion]
async fn verify_update_operation_impl(state: &AppState, operation: &Value, doc: &Value) -> Result<bool> {
    if operation.to_string().len() > 64 * 1024 {
        anyhow::bail!("Invalid operation: size");
    }
    if !verify_proof_format(operation.get("proof")) {
        anyhow::bail!("Invalid operation: proof");
    }
    if doc.get("didDocument").is_none() {
        anyhow::bail!("Invalid operation: doc.didDocument");
    }
    if doc
        .get("didDocumentMetadata")
        .and_then(|value| value.get("deactivated"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        anyhow::bail!("Invalid operation: DID deactivated");
    }

    if let Some(controller_did) = doc
        .get("didDocument")
        .and_then(|value| value.get("controller"))
        .and_then(Value::as_str)
    {
        let controller_doc = resolve_local_doc_async(
            state,
            controller_did,
            ResolveOptions {
                confirm: true,
                version_time: operation
                    .get("proof")
                    .and_then(|value| value.get("created"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                ..ResolveOptions::default()
            },
        )
        .await?;
        return verify_update_operation_impl(state, operation, &controller_doc).await;
    }

    if doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .is_none()
    {
        anyhow::bail!("Invalid operation: doc.didDocument.verificationMethod");
    }

    let proof = operation.get("proof").context("Invalid operation: proof")?;
    let msg_hash = generate_message_hash(&value_without_proof(operation))?;
    let public_jwk = doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|value| value.get("publicKeyJwk"))
        .context("Invalid operation: didDocument missing verificationMethod")?;
    let proof_value = proof
        .get("proofValue")
        .and_then(Value::as_str)
        .context("Invalid operation: proof")?;
    verify_sig(&msg_hash, proof_value, public_jwk)
}

async fn verify_operation_impl(state: &AppState, operation: &Value) -> Result<bool> {
    match operation.get("type").and_then(Value::as_str) {
        Some("create") => verify_create_operation_impl(state, operation).await,
        Some("update" | "delete") => {
            let did = operation
                .get("did")
                .and_then(Value::as_str)
                .context("Invalid operation: missing operation.did")?;
            let doc = resolve_local_doc_async(state, did, ResolveOptions::default()).await?;
            verify_update_operation_impl(state, operation, &doc).await
        }
        _ => Ok(false),
    }
}

fn generate_message_hash(value: &Value) -> Result<String> {
    let canonical = canonical_json(value);
    let hash = Code::Sha2_256.digest(canonical.as_bytes());
    Ok(bytes_to_hex(hash.digest()))
}

async fn import_batch_impl(state: &AppState, batch: &[Value]) -> ImportBatchResult {
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

async fn process_events_impl(state: &AppState) -> ProcessEventsResult {
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

    let mut store = state.store.lock().await;
    let mut current_events = store.get_events(&did);
    for current in &mut current_events {
        if current.opid.is_none() {
            current.opid = generate_json_cid(&current.operation).ok();
        }
    }

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
            let _ = store.set_events(&did, new_sequence);
            return ImportStatus::Added;
        }
    }

    ImportStatus::Rejected
}

fn value_to_event_record(value: &Value) -> EventRecord {
    EventRecord {
        registry: value
            .get("registry")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_string(),
        time: value
            .get("time")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        ordinal: value.get("ordinal").and_then(|items| {
            items.as_array().map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_u64)
                    .filter_map(|item| u32::try_from(item).ok())
                    .collect::<Vec<_>>()
            })
        }),
        operation: value.get("operation").cloned().unwrap_or(Value::Null),
        opid: value.get("opid").and_then(Value::as_str).map(ToString::to_string),
        did: value.get("did").and_then(Value::as_str).map(ToString::to_string),
    }
}

fn event_record_to_value(event: &EventRecord) -> Value {
    json!({
        "registry": event.registry,
        "time": event.time,
        "ordinal": event.ordinal,
        "operation": event.operation,
        "opid": event.opid,
        "did": event.did
    })
}

async fn refresh_metrics_snapshot(state: &AppState) {
    let did_check = check_dids_impl(state, None, false).await;
    update_metrics_from_check(state, &did_check).await;
}

async fn update_metrics_from_check(state: &AppState, did_check: &CheckDidsResult) {
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

async fn check_dids_impl(state: &AppState, dids: Option<Vec<String>>, _chatty: bool) -> CheckDidsResult {
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

async fn verify_db_impl(state: &AppState, _chatty: bool) -> VerifyDbResult {
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

async fn search_docs_impl(state: &AppState, q: &str) -> Vec<String> {
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
        let data = doc
            .get("didDocumentData")
            .cloned()
            .unwrap_or_else(|| json!({}));
        if data.to_string().contains(q) {
            result.push(did);
        }
    }
    result
}

async fn query_docs_impl(state: &AppState, where_clause: &Value) -> Result<Vec<String>> {
    let dids = {
        let store = state.store.lock().await;
        store.list_dids(&state.config.did_prefix, None)
    };

    let Some((raw_path, cond)) = where_clause.as_object().and_then(|map| map.iter().next()) else {
        return Ok(Vec::new());
    };
    let list = cond
        .get("$in")
        .and_then(Value::as_array)
        .context("Only {$in:[...]} supported")?;

    let mut result = Vec::new();
    for did in dids {
        let doc = {
            let store = state.store.lock().await;
            store.resolve_doc(&state.config, &did, ResolveOptions::default())
        };
        let Ok(doc) = doc else {
            continue;
        };
        let data = doc
            .get("didDocumentData")
            .cloned()
            .unwrap_or_else(|| json!({}));
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

    json_path_get(root, raw_path)
        .map(|value| list.contains(value))
        .unwrap_or(false)
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

fn start_background_tasks(state: AppState) {
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

async fn log_status_snapshot(state: &AppState) {
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

fn require_admin_key(state: &AppState, headers: &HeaderMap) -> Option<Response> {
    if state.config.admin_api_key.is_empty() {
        return None;
    }

    match headers
        .get("x-archon-admin-key")
        .and_then(|value| value.to_str().ok())
    {
        Some(value) if value == state.config.admin_api_key => None,
        _ => Some((
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "Unauthorized — valid admin API key required" })),
        )
            .into_response()),
    }
}

fn extract_ipfs_hash(body: &str) -> Option<String> {
    for line in body.lines().rev() {
        if let Ok(json) = serde_json::from_str::<Value>(line) {
            if let Some(hash) = json.get("Hash").and_then(Value::as_str) {
                return Some(hash.to_string());
            }
        }
    }
    None
}

fn record_metrics(state: &AppState, method: &str, route: &str, status: u16, duration_seconds: f64) {
    let normalized = normalize_path(route);
    let status_string = status.to_string();
    state
        .metrics
        .http_requests_total
        .with_label_values(&[method, &normalized, &status_string])
        .inc();
    state
        .metrics
        .http_request_duration_seconds
        .with_label_values(&[method, &normalized, &status_string])
        .observe(duration_seconds);
}

fn normalize_path(path: &str) -> String {
    let base_path = path.split('?').next().unwrap_or(path);
    let segments = base_path.split('/').filter(|segment| !segment.is_empty()).collect::<Vec<_>>();

    if let Some(index) = segments.iter().position(|segment| *segment == "did") {
        if let Some(value) = segments.get(index + 1) {
            if value.starts_with("did:") {
                let mut normalized = segments.clone();
                normalized[index + 1] = ":did";
                return format!("/{}", normalized.join("/"));
            }
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "block") {
        if segments.get(index + 2) == Some(&"latest") {
            let mut normalized = segments.clone();
            if let Some(value) = normalized.get_mut(index + 1) {
                *value = ":registry";
            }
            return format!("/{}", normalized.join("/"));
        }
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":registry";
            return format!("/{}", normalized.join("/"));
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "queue") {
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":registry";
            return format!("/{}", normalized.join("/"));
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "events") {
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":registry";
            return format!("/{}", normalized.join("/"));
        }
    }

    if let Some(index) = segments.iter().position(|segment| *segment == "dids") {
        if segments.get(index + 1).is_some() {
            let mut normalized = segments.clone();
            normalized[index + 1] = ":prefix";
            return format!("/{}", normalized.join("/"));
        }
    }

    base_path.to_string()
}

fn init_tracing() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();
}

impl Metrics {
    fn new(config: &Config) -> Result<Self> {
        let registry = Registry::new();

        let http_requests_total = IntCounterVec::new(
            prometheus::Opts::new("http_requests_total", "Total number of HTTP requests"),
            &["method", "route", "status"],
        )?;
        let http_request_duration_seconds = HistogramVec::new(
            HistogramOpts::new("http_request_duration_seconds", "HTTP request duration in seconds")
                .buckets(vec![0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1.0, 2.0, 5.0]),
            &["method", "route", "status"],
        )?;
        let did_operations_total = IntCounterVec::new(
            prometheus::Opts::new("did_operations_total", "Total number of DID operations"),
            &["operation", "registry", "status"],
        )?;
        let events_queue_size = GaugeVec::new(
            prometheus::Opts::new("events_queue_size", "Number of events in the queue"),
            &["registry"],
        )?;
        let gatekeeper_dids_total = Gauge::new("gatekeeper_dids_total", "Total number of DIDs")?;
        let gatekeeper_dids_by_type = GaugeVec::new(
            prometheus::Opts::new("gatekeeper_dids_by_type", "Number of DIDs by type"),
            &["type"],
        )?;
        let gatekeeper_dids_by_registry = GaugeVec::new(
            prometheus::Opts::new("gatekeeper_dids_by_registry", "Number of DIDs by registry"),
            &["registry"],
        )?;
        let service_version_info = GaugeVec::new(
            prometheus::Opts::new("service_version_info", "Service version information"),
            &["version", "commit"],
        )?;

        registry.register(Box::new(http_requests_total.clone()))?;
        registry.register(Box::new(http_request_duration_seconds.clone()))?;
        registry.register(Box::new(did_operations_total.clone()))?;
        registry.register(Box::new(events_queue_size.clone()))?;
        registry.register(Box::new(gatekeeper_dids_total.clone()))?;
        registry.register(Box::new(gatekeeper_dids_by_type.clone()))?;
        registry.register(Box::new(gatekeeper_dids_by_registry.clone()))?;
        registry.register(Box::new(service_version_info.clone()))?;

        service_version_info
            .with_label_values(&[&config.version, &config.git_commit])
            .set(1.0);
        gatekeeper_dids_total.set(0.0);
        let _ = did_operations_total;
        let _ = events_queue_size;
        let _ = gatekeeper_dids_by_type;
        let _ = gatekeeper_dids_by_registry;

        Ok(Self {
            registry,
            http_requests_total,
            http_request_duration_seconds,
            did_operations_total,
            events_queue_size,
            gatekeeper_dids_total,
            gatekeeper_dids_by_type,
            gatekeeper_dids_by_registry,
            service_version_info,
        })
    }
}

impl Config {
    fn from_env() -> Result<Self> {
        Ok(Self {
            port: env_parse("ARCHON_GATEKEEPER_PORT", 4224)?,
            bind_address: env_parse("ARCHON_BIND_ADDRESS", IpAddr::from([0, 0, 0, 0]))?,
            db: env::var("ARCHON_GATEKEEPER_DB").unwrap_or_else(|_| "redis".to_string()),
            data_dir: PathBuf::from(env::var("ARCHON_DATA_DIR").unwrap_or_else(|_| "data".to_string())),
            ipfs_url: env::var("ARCHON_IPFS_URL").unwrap_or_else(|_| "http://localhost:5001/api/v0".to_string()),
            did_prefix: env::var("ARCHON_GATEKEEPER_DID_PREFIX").unwrap_or_else(|_| "did:cid".to_string()),
            registries: env::var("ARCHON_GATEKEEPER_REGISTRIES")
                .ok()
                .map(|value| {
                    value
                        .split(',')
                        .map(str::trim)
                        .filter(|item| !item.is_empty())
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                })
                .filter(|items| !items.is_empty())
                .unwrap_or_else(|| vec!["local".to_string(), "hyperswarm".to_string()]),
            json_limit: parse_size_string(&env::var("ARCHON_GATEKEEPER_JSON_LIMIT").unwrap_or_else(|_| "4mb".to_string()))?,
            upload_limit: parse_size_string(&env::var("ARCHON_GATEKEEPER_UPLOAD_LIMIT").unwrap_or_else(|_| "10mb".to_string()))?,
            gc_interval_minutes: env_parse("ARCHON_GATEKEEPER_GC_INTERVAL", 15)?,
            status_interval_minutes: env_parse("ARCHON_GATEKEEPER_STATUS_INTERVAL", 5)?,
            admin_api_key: env::var("ARCHON_ADMIN_API_KEY").unwrap_or_default(),
            fallback_url: env::var("ARCHON_GATEKEEPER_FALLBACK_URL")
                .unwrap_or_else(|_| "https://dev.uniresolver.io".to_string()),
            fallback_timeout_ms: env_parse("ARCHON_GATEKEEPER_FALLBACK_TIMEOUT", 5000)?,
            max_queue_size: 100,
            git_commit: env::var("GIT_COMMIT").unwrap_or_else(|_| "unknown".to_string()).chars().take(7).collect(),
            version: env::var("ARCHON_GATEKEEPER_VERSION").unwrap_or_else(|_| "0.7.0".to_string()),
        })
    }
}

fn env_parse<T>(name: &str, default: T) -> Result<T>
where
    T: std::str::FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(value) => value.parse::<T>().map_err(|error| anyhow::anyhow!("{name}: {error}")),
        Err(_) => Ok(default),
    }
}

fn parse_size_string(value: &str) -> Result<usize> {
    let trimmed = value.trim().to_ascii_lowercase();
    let (number, multiplier) = if let Some(stripped) = trimmed.strip_suffix("mb") {
        (stripped.trim(), 1024usize * 1024usize)
    } else if let Some(stripped) = trimmed.strip_suffix("kb") {
        (stripped.trim(), 1024usize)
    } else if let Some(stripped) = trimmed.strip_suffix('b') {
        (stripped.trim(), 1usize)
    } else {
        (trimmed.as_str(), 1usize)
    };

    let parsed = number.parse::<usize>().with_context(|| format!("invalid size `{value}`"))?;
    Ok(parsed.saturating_mul(multiplier))
}

fn url_encode_component(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

fn generate_did_from_operation(config: &Config, operation: &Value) -> Result<String> {
    let cid = generate_json_cid(operation)?;
    let prefix = operation
        .get("registration")
        .and_then(|v| v.get("prefix"))
        .and_then(Value::as_str)
        .unwrap_or(&config.did_prefix);
    Ok(format!("{prefix}:{cid}"))
}

fn generate_json_cid(value: &Value) -> Result<String> {
    let canonical = canonical_json(value);
    let hash = Code::Sha2_256.digest(canonical.as_bytes());
    let cid = Cid::new_v1(0x0200, hash);
    Ok(cid.to_string())
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => serde_json::to_string(string).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => {
            let joined = items.iter().map(canonical_json).collect::<Vec<_>>().join(",");
            format!("[{joined}]")
        }
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let joined = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{joined}}}")
        }
    }
}

impl JsonDb {
    fn load(config: &Config) -> Result<Self> {
        let path = config.data_dir.join("archon.json");
        let data = match fs::read_to_string(&path) {
            Ok(raw) => serde_json::from_str::<JsonDbFile>(&raw).unwrap_or_default(),
            Err(_) => JsonDbFile::default(),
        };

        Ok(Self { path, data })
    }

    fn save(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }

        let body = serde_json::to_string_pretty(&self.data).context("failed to encode db")?;
        fs::write(&self.path, body).with_context(|| format!("failed to write {}", self.path.display()))
    }

    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String> {
        let suffix = did
            .split(':')
            .next_back()
            .context("invalid did suffix")?
            .to_string();

        let events = self.data.dids.entry(suffix).or_default();
        if events.is_empty() {
            if let (Some(opid), operation) = (event.opid.clone(), event.operation.clone()) {
                self.data.ops.insert(opid, operation);
            }
            events.push(event);
            self.save()?;
        }
        Ok(did.to_string())
    }

    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool> {
        let suffix = did
            .split(':')
            .next_back()
            .context("invalid did suffix")?
            .to_string();

        let latest = self.resolve_doc(
            &Config {
                port: 0,
                bind_address: IpAddr::from([0, 0, 0, 0]),
                db: String::new(),
                data_dir: PathBuf::new(),
                ipfs_url: String::new(),
                did_prefix: String::new(),
                registries: vec![],
                json_limit: 0,
                upload_limit: 0,
                gc_interval_minutes: 0,
                status_interval_minutes: 0,
                admin_api_key: String::new(),
                fallback_url: String::new(),
                fallback_timeout_ms: 0,
                max_queue_size: 0,
                git_commit: String::new(),
                version: String::new(),
            },
            did,
            ResolveOptions::default(),
        )?;

        let events = self
            .data
            .dids
            .get_mut(&suffix)
            .context("did not found")?;

        if events.is_empty() {
            anyhow::bail!("did not found");
        }

        let previd = event
            .operation
            .get("previd")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing operation.previd"))?;
        let current_version_id = latest
            .get("didDocumentMetadata")
            .and_then(|value| value.get("versionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing current versionId"))?;

        if previd != current_version_id {
            anyhow::bail!("invalid previd");
        }

        if let (Some(opid), operation) = (event.opid.clone(), event.operation.clone()) {
            self.data.ops.insert(opid, operation);
        }
        events.push(event);
        self.save()?;
        Ok(true)
    }

    fn get_events(&self, did: &str) -> Vec<EventRecord> {
        let suffix = match did.split(':').next_back() {
            Some(value) => value,
            None => return Vec::new(),
        };
        self.data
            .dids
            .get(suffix)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut event| {
                if event.operation.is_null() {
                    if let Some(opid) = event.opid.as_ref() {
                        if let Some(operation) = self.data.ops.get(opid) {
                            event.operation = operation.clone();
                        }
                    }
                }
                event
            })
            .collect()
    }

    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()> {
        let suffix = did
            .split(':')
            .next_back()
            .context("invalid did suffix")?
            .to_string();

        for event in &events {
            if let Some(opid) = event.opid.as_ref() {
                self.data.ops.insert(opid.clone(), event.operation.clone());
            }
        }
        self.data.dids.insert(suffix, events);
        self.save()
    }

    fn delete_events(&mut self, did: &str) -> Result<()> {
        let suffix = did
            .split(':')
            .next_back()
            .context("invalid did suffix")?
            .to_string();
        self.data.dids.remove(&suffix);
        self.save()
    }

    fn reset_db(&mut self) -> Result<()> {
        self.data = JsonDbFile::default();
        self.save()
    }

    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()> {
        self.data.ops.insert(opid.to_string(), operation);
        self.save()
    }

    fn get_operation(&self, opid: &str) -> Option<Value> {
        self.data.ops.get(opid).cloned()
    }

    fn push_import_event(&mut self, event: EventRecord) {
        self.data.import_queue.push(event);
        let _ = self.save();
    }

    fn take_import_queue(&mut self) -> Vec<EventRecord> {
        let queue = std::mem::take(&mut self.data.import_queue);
        let _ = self.save();
        queue
    }

    fn import_queue_len(&self) -> usize {
        self.data.import_queue.len()
    }

    fn import_queue_snapshot(&self) -> Vec<EventRecord> {
        self.data.import_queue.clone()
    }

    fn clear_import_queue(&mut self) {
        self.data.import_queue.clear();
        let _ = self.save();
    }

    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize> {
        let len = {
            let queue = self.data.queue.entry(registry.to_string()).or_default();
            queue.push(operation);
            queue.len()
        };
        self.save()?;
        Ok(len)
    }

    fn get_queue(&self, registry: &str) -> Vec<Value> {
        self.data.queue.get(registry).cloned().unwrap_or_default()
    }

    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool> {
        let proof_values = operations
            .iter()
            .filter_map(|value| {
                value
                    .get("proof")
                    .and_then(|proof| proof.get("proofValue"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>();

        if let Some(queue) = self.data.queue.get_mut(registry) {
            queue.retain(|item| {
                let proof_value = item
                    .get("proof")
                    .and_then(|proof| proof.get("proofValue"))
                    .and_then(Value::as_str);
                !proof_values.iter().any(|value| Some(*value) == proof_value)
            });
        }

        self.save()?;
        Ok(true)
    }

    fn add_block(&mut self, registry: &str, mut block: Value) -> Result<bool> {
        let hash = block
            .get("hash")
            .and_then(Value::as_str)
            .context("missing block.hash")?
            .to_string();

        if block.get("timeISO").is_none() {
            if let Some(time) = block.get("time").and_then(Value::as_i64) {
                let dt = chrono::DateTime::<chrono::Utc>::from_timestamp(time, 0)
                    .context("invalid block.time")?;
                block["timeISO"] = Value::String(dt.to_rfc3339());
            }
        }

        self.data
            .blocks
            .entry(registry.to_string())
            .or_default()
            .insert(hash, block);
        self.save()?;
        Ok(true)
    }

    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value> {
        let registry_blocks = self.data.blocks.get(registry)?;
        if registry_blocks.is_empty() {
            return None;
        }

        match block_id {
            None => registry_blocks
                .values()
                .filter_map(|block| {
                    block
                        .get("height")
                        .and_then(Value::as_u64)
                        .map(|height| (height, block.clone()))
                })
                .max_by_key(|(height, _)| *height)
                .map(|(_, block)| block),
            Some(BlockLookup::Height(height)) => registry_blocks.values().find_map(|block| {
                (block.get("height").and_then(Value::as_u64) == Some(height)).then(|| block.clone())
            }),
            Some(BlockLookup::Hash(hash)) => registry_blocks.get(&hash).cloned(),
        }
    }

    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String> {
        match requested {
            Some(items) => items.to_vec(),
            None => {
                let mut keys = self.data.dids.keys().cloned().collect::<Vec<_>>();
                keys.sort();
                keys.into_iter().map(|suffix| format!("{prefix}:{suffix}")).collect()
            }
        }
    }

    fn resolve_doc(&self, _config: &Config, did: &str, options: ResolveOptions) -> Result<Value> {
        let _ = did.split(':').next_back().context("invalid did suffix")?;
        let events = self.get_events(did);
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
            .unwrap_or("");

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
            "asset" => {
                json!({
                    "@context": ["https://www.w3.org/ns/did/v1"],
                    "id": did,
                    "controller": anchor_operation.get("controller").cloned().unwrap_or(Value::Null)
                })
            }
            _ => anyhow::bail!("unsupported registration.type"),
        };

        let canonical_id = anchor_operation
            .get("registration")
            .and_then(|v| v.get("prefix"))
            .and_then(Value::as_str)
            .map(|_| did.to_string());

        let mut state = ResolvedDoc {
            did_document: initial_document,
            did_document_data: anchor_operation.get("data").cloned().unwrap_or_else(|| json!({})),
            did_document_registration: {
                let mut value = Value::Object(registration.clone());
                if value.get("created").is_none() {
                    value["created"] = Value::String(created.to_string());
                }
                value
            },
            created: created.to_string(),
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

        for event in events.iter().skip(1) {
            let operation = &event.operation;
            let operation_time = event.time.clone();

            if let Some(version_time) = options.version_time.as_ref() {
                if operation_time > *version_time {
                    break;
                }
            }

            if let Some(version_sequence) = options.version_sequence {
                if state.version_sequence == version_sequence {
                    break;
                }
            }

            if options.confirm && !state.confirmed {
                break;
            }

            if options.verify {
                // Signature verification is not yet ported; local event-chain semantics still apply.
            }

            state.confirmed = state.confirmed
                && state
                    .did_document_registration
                    .get("registry")
                    .and_then(Value::as_str)
                    .map(|registry| registry == event.registry)
                    .unwrap_or(false);

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
                    state.deleted = Some(operation_time.clone());
                    state.updated = Some(operation_time);
                    state.did_document = json!({ "id": did });
                    state.did_document_data = json!({});
                    state.deactivated = true;
                }
                _ => {}
            }
        }

        let mut metadata = json!({
            "created": state.created,
            "versionId": state.version_id,
            "versionSequence": state.version_sequence.to_string(),
            "confirmed": state.confirmed
        });

        if let Some(updated) = state.updated.clone() {
            metadata["updated"] = Value::String(updated);
        }
        if let Some(deleted) = state.deleted.clone() {
            metadata["deleted"] = Value::String(deleted);
        }
        if state.deactivated {
            metadata["deactivated"] = Value::Bool(true);
        }
        if let Some(canonical_id) = state.canonical_id.clone() {
            metadata["canonicalId"] = Value::String(canonical_id);
        }

        Ok(json!({
            "didDocument": state.did_document,
            "didDocumentMetadata": metadata,
            "didDocumentData": state.did_document_data,
            "didDocumentRegistration": state.did_document_registration,
            "didResolutionMetadata": {
                "retrieved": chrono_like_now()
            }
        }))
    }
}

impl GatekeeperDb for JsonDb {
    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String> {
        JsonDb::add_create_event(self, did, event)
    }

    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool> {
        JsonDb::add_followup_event(self, did, event)
    }

    fn get_events(&self, did: &str) -> Vec<EventRecord> {
        JsonDb::get_events(self, did)
    }

    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()> {
        JsonDb::set_events(self, did, events)
    }

    fn delete_events(&mut self, did: &str) -> Result<()> {
        JsonDb::delete_events(self, did)
    }

    fn reset_db(&mut self) -> Result<()> {
        JsonDb::reset_db(self)
    }

    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()> {
        JsonDb::add_operation(self, opid, operation)
    }

    fn get_operation(&self, opid: &str) -> Option<Value> {
        JsonDb::get_operation(self, opid)
    }

    fn push_import_event(&mut self, event: EventRecord) {
        JsonDb::push_import_event(self, event)
    }

    fn take_import_queue(&mut self) -> Vec<EventRecord> {
        JsonDb::take_import_queue(self)
    }

    fn import_queue_len(&self) -> usize {
        JsonDb::import_queue_len(self)
    }

    fn import_queue_snapshot(&self) -> Vec<EventRecord> {
        JsonDb::import_queue_snapshot(self)
    }

    fn clear_import_queue(&mut self) {
        JsonDb::clear_import_queue(self)
    }

    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize> {
        JsonDb::queue_operation(self, registry, operation)
    }

    fn get_queue(&self, registry: &str) -> Vec<Value> {
        JsonDb::get_queue(self, registry)
    }

    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool> {
        JsonDb::clear_queue(self, registry, operations)
    }

    fn add_block(&mut self, registry: &str, block: Value) -> Result<bool> {
        JsonDb::add_block(self, registry, block)
    }

    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value> {
        JsonDb::get_block(self, registry, block_id)
    }

    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String> {
        JsonDb::list_dids(self, prefix, requested)
    }

    fn resolve_doc(&self, config: &Config, did: &str, options: ResolveOptions) -> Result<Value> {
        JsonDb::resolve_doc(self, config, did, options)
    }
}

fn chrono_like_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
