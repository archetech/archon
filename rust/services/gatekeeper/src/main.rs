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
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use bytes::Bytes;
use cid::Cid;
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
}

struct JsonDb {
    path: PathBuf,
    data: JsonDbFile,
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
                .route("/dids/remove", post(not_implemented_admin))
                .route("/dids/export", post(not_implemented))
                .route("/dids/import", post(not_implemented_admin))
                .route("/batch/export", post(not_implemented_admin))
                .route("/batch/import", post(not_implemented_admin))
                .route("/batch/import/cids", post(not_implemented_admin))
                .route("/queue/:registry", get(not_implemented_admin))
                .route("/queue/:registry/clear", post(not_implemented_admin))
                .route("/db/reset", get(not_implemented_admin))
                .route("/db/verify", get(not_implemented_admin))
                .route("/events/process", post(not_implemented_admin))
                .route("/ipfs/json", post(ipfs_add_json))
                .route("/ipfs/json/:cid", get(ipfs_get_json))
                .route("/ipfs/text", post(ipfs_add_text))
                .route("/ipfs/text/:cid", get(ipfs_get_text))
                .route("/ipfs/data", post(ipfs_add_data))
                .route("/ipfs/data/:cid", get(ipfs_get_data))
                .route("/ipfs/stream", post(ipfs_add_stream))
                .route("/ipfs/stream/:cid", get(ipfs_get_stream))
                .route("/block/:registry/latest", get(not_implemented))
                .route("/block/:registry/:blockId", get(not_implemented))
                .route("/block/:registry", post(not_implemented_admin))
                .route("/search", get(not_implemented))
                .route("/query", post(not_implemented)),
        )
        .fallback(not_found)
        .with_state(state.clone());

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
    let payload = StatusPayload {
        uptimeSeconds: state.started_at.elapsed().as_secs(),
        dids: json!({
            "total": 0,
            "byType": {},
            "byRegistry": {},
            "byVersion": {},
            "eventsQueue": []
        }),
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
    Json(state.config.registries.clone())
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
            record_metrics(&state, "POST", "/did", 200, start.elapsed().as_secs_f64());
            Json(result_value).into_response()
        }
        Err(error) => {
            state
                .metrics
                .did_operations_total
                .with_label_values(&[&op_type, &registry, "error"])
                .inc();
            let status = if error.contains("missing")
                || error.contains("invalid")
                || error.contains("previd")
                || error.contains("not found")
                || error.contains("unsupported")
            {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            };
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

    let store = state.store.lock().await;
    let dids = store.list_dids(&state.config.did_prefix, requested.as_deref());

    if resolve {
        let docs = dids
            .into_iter()
            .filter_map(|did| store.resolve_doc(&state.config, &did, resolve_options.clone()).ok())
            .collect::<Vec<_>>();
        record_metrics(&state, "POST", "/dids/", 200, start.elapsed().as_secs_f64());
        Json(json!(docs)).into_response()
    } else {
        record_metrics(&state, "POST", "/dids/", 200, start.elapsed().as_secs_f64());
        Json(json!(dids)).into_response()
    }
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

    {
        let store = state.store.lock().await;
        if let Ok(doc) = store.resolve_doc(&state.config, &did, resolve_options) {
            record_metrics(&state, "GET", "/did/:did", 200, start.elapsed().as_secs_f64());
            return Json(doc).into_response();
        }
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

async fn handle_did_operation(state: &AppState, payload: &Value) -> Result<Value, String> {
    let op_type = payload
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| "missing operation.type".to_string())?;

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
    path.replace("/did/did:", "/did/:did")
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

        events.push(event);
        self.save()?;
        Ok(true)
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
        let suffix = did
            .split(':')
            .next_back()
            .context("invalid did suffix")?;
        let events = self
            .data
            .dids
            .get(suffix)
            .context("did not found")?;
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

fn chrono_like_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
