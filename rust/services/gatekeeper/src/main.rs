use std::{
    collections::HashMap,
    env,
    net::{IpAddr, SocketAddr},
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
use prometheus::{
    Encoder, Gauge, GaugeVec, HistogramOpts, HistogramVec, IntCounterVec, Registry, TextEncoder,
};
use reqwest::Client;
use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tracing::{error, info};

#[derive(Clone)]
struct AppState {
    config: Config,
    client: Client,
    metrics: Arc<Metrics>,
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

    let state = AppState {
        config: config.clone(),
        client,
        metrics,
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
                .route("/did", post(not_implemented))
                .route("/did/generate", post(not_implemented))
                .route("/did/:did", get(resolve_did))
                .route("/dids", post(not_implemented))
                .route("/dids/", post(not_implemented))
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

async fn resolve_did(
    State(state): State<AppState>,
    Path(did): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let start = Instant::now();

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
