use std::{
    collections::HashMap,
    env, fs,
    sync::atomic::Ordering,
    time::{Duration, Instant},
};

use anyhow::Result;
use axum::{
    body::{to_bytes, Body},
    extract::{Path, Query, Request, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use bytes::Bytes;
use prometheus::{Encoder, TextEncoder};
use serde::Serialize;
use serde_json::{json, Value};
use tracing::error;

use crate::{
    build_search_index, chrono_like_now, clear_search_index, delete_search_doc,
    generate_did_from_operation, handle_did_operation, import_batch_impl, normalize_path,
    process_events_impl, query_docs_impl, record_metrics, refresh_metrics_snapshot,
    resolve_local_doc_async, search_docs_impl, verify_db_impl, AppState, BlockLookup,
    GatekeeperDb, ResolveOptions,
};

#[derive(Serialize)]
struct StatusPayload {
    #[serde(rename = "uptimeSeconds")]
    uptime_seconds: u64,
    dids: Value,
    #[serde(rename = "memoryUsage")]
    memory_usage: MemoryUsage,
}

#[derive(Serialize)]
struct MemoryUsage {
    rss: u64,
    #[serde(rename = "heapTotal")]
    heap_total: u64,
    #[serde(rename = "heapUsed")]
    heap_used: u64,
    external: u64,
    #[serde(rename = "arrayBuffers")]
    array_buffers: u64,
}

#[derive(Serialize)]
struct VersionPayload {
    version: String,
    commit: String,
}

pub(crate) async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    record_metrics(&state, "GET", "/ready", 200, 0.0);
    Json(state.ready.load(Ordering::Relaxed))
}

pub(crate) async fn version(State(state): State<AppState>) -> impl IntoResponse {
    record_metrics(&state, "GET", "/version", 200, 0.0);
    Json(VersionPayload {
        version: state.config.version.clone(),
        commit: state.config.git_commit.clone(),
    })
}

pub(crate) async fn status(State(state): State<AppState>) -> impl IntoResponse {
    if state.status_snapshot.lock().await.is_none() {
        refresh_metrics_snapshot(&state).await;
    }
    let dids = state
        .status_snapshot
        .lock()
        .await
        .clone()
        .unwrap_or_default();
    let payload = StatusPayload {
        uptime_seconds: state.started_at.elapsed().as_secs(),
        dids: serde_json::to_value(dids).unwrap_or_else(|_| json!({})),
        memory_usage: current_memory_usage(),
    };

    record_metrics(&state, "GET", "/status", 200, 0.0);
    Json(payload)
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

fn parse_optional_json_body(body: Bytes) -> Result<Value, String> {
    if body.is_empty() {
        return Ok(json!({}));
    }

    serde_json::from_slice::<Value>(&body).map_err(|error| format!("Error: Invalid JSON body: {error}"))
}

fn did_resolution_error_doc(error: &str) -> Value {
    json!({
        "didResolutionMetadata": {
            "error": error
        },
        "didDocument": {},
        "didDocumentMetadata": {}
    })
}

pub(crate) async fn registries(State(state): State<AppState>) -> impl IntoResponse {
    record_metrics(&state, "GET", "/registries", 200, 0.0);
    Json(state.supported_registries.lock().await.clone())
}

pub(crate) async fn generate_did(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    match generate_did_from_operation(&state.config, &payload) {
        Ok(did) => {
            record_metrics(
                &state,
                "POST",
                "/did/generate",
                200,
                start.elapsed().as_secs_f64(),
            );
            Json(json!(did)).into_response()
        }
        Err(error) => {
            record_metrics(
                &state,
                "POST",
                "/did/generate",
                400,
                start.elapsed().as_secs_f64(),
            );
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": error.to_string() })),
            )
                .into_response()
        }
    }
}

pub(crate) async fn create_did(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Response {
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
            record_metrics(
                &state,
                "POST",
                "/did",
                status.as_u16(),
                start.elapsed().as_secs_f64(),
            );
            text_error_response(status, &format!("Error: {}", error))
        }
    }
}

pub(crate) async fn list_dids(
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let payload = match parse_optional_json_body(body) {
        Ok(payload) => payload,
        Err(error) => {
            record_metrics(
                &state,
                "POST",
                "/dids/",
                400,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(StatusCode::BAD_REQUEST, &error);
        }
    };
    let resolve = payload
        .get("resolve")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let updated_after = payload
        .get("updatedAfter")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let updated_before = payload
        .get("updatedBefore")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let resolve_options = ResolveOptions {
        version_time: payload
            .get("versionTime")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        version_sequence: payload
            .get("versionSequence")
            .and_then(Value::as_u64)
            .and_then(|value| usize::try_from(value).ok()),
        confirm: payload
            .get("confirm")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        verify: payload
            .get("verify")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    };
    let requested = payload.get("dids").and_then(Value::as_array).map(|items| {
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
        let mut matches = Vec::new();
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
            matches.push((updated.to_string(), did, doc));
        }

        matches.sort_by(|a, b| a.0.cmp(&b.0));
        let docs = matches
            .iter()
            .map(|(_, _, doc)| doc.clone())
            .collect::<Vec<_>>();
        let filtered_dids = matches
            .into_iter()
            .map(|(_, did, _)| did)
            .collect::<Vec<_>>();

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

pub(crate) async fn export_dids(
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    let payload = match parse_optional_json_body(body) {
        Ok(payload) => payload,
        Err(error) => {
            record_metrics(
                &state,
                "POST",
                "/dids/export",
                400,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(StatusCode::BAD_REQUEST, &error);
        }
    };
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

    record_metrics(
        &state,
        "POST",
        "/dids/export",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(batch)).into_response()
}

pub(crate) async fn remove_dids(
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
        record_metrics(
            &state,
            "POST",
            "/dids/remove",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Error: Invalid parameter: dids",
        );
    }

    let mut store = state.store.lock().await;
    let ok = dids.iter().all(|did| store.delete_events(did).is_ok());
    drop(store);
    for did in &dids {
        delete_search_doc(&state, did).await;
    }
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "POST",
        "/dids/remove",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(ok)).into_response()
}

pub(crate) async fn import_dids(
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
            record_metrics(
                &state,
                "POST",
                "/dids/import",
                500,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "TypeError: dids.flat is not a function",
            );
        }
    };

    let flat_batch = did_batches
        .iter()
        .filter_map(Value::as_array)
        .flat_map(|events| events.iter().cloned())
        .collect::<Vec<_>>();

    let result = import_batch_impl(&state, &flat_batch).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "POST",
        "/dids/import",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(result)).into_response()
}

pub(crate) async fn export_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    let payload = match parse_optional_json_body(body) {
        Ok(payload) => payload,
        Err(error) => {
            record_metrics(
                &state,
                "POST",
                "/batch/export",
                400,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(StatusCode::BAD_REQUEST, &error);
        }
    };

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

    record_metrics(
        &state,
        "POST",
        "/batch/export",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(events)).into_response()
}

pub(crate) async fn import_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let batch = match payload.as_array() {
        Some(items) if !items.is_empty() => items.iter().cloned().collect::<Vec<_>>(),
        _ => {
            record_metrics(
                &state,
                "POST",
                "/batch/import",
                500,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Error: Invalid parameter: batch",
            );
        }
    };

    let result = import_batch_impl(&state, &batch).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "POST",
        "/batch/import",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(result)).into_response()
}

pub(crate) async fn import_batch_by_cids(
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
            record_metrics(
                &state,
                "POST",
                "/batch/import/cids",
                500,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Error: Invalid parameter: cids",
            );
        }
    };
    let metadata = match payload.get("metadata") {
        Some(value) if value.is_object() => value,
        _ => {
            record_metrics(
                &state,
                "POST",
                "/batch/import/cids",
                500,
                start.elapsed().as_secs_f64(),
            );
            return text_error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "Error: Invalid parameter: metadata",
            );
        }
    };
    let has_registry = metadata
        .get("registry")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let has_time = metadata
        .get("time")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty());
    let has_ordinal = metadata
        .get("ordinal")
        .and_then(Value::as_array)
        .is_some();
    if !has_registry || !has_time || !has_ordinal {
        record_metrics(
            &state,
            "POST",
            "/batch/import/cids",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Error: Invalid parameter: metadata",
        );
    }

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
    record_metrics(
        &state,
        "POST",
        "/batch/import/cids",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(result)).into_response()
}

pub(crate) async fn get_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(registry): Path<String>,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    if !is_valid_registry(&registry) {
        record_metrics(
            &state,
            "GET",
            "/queue/:registry",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Error: Invalid parameter: registry={registry}"),
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
    record_metrics(
        &state,
        "GET",
        "/queue/:registry",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(queue)).into_response()
}

pub(crate) async fn clear_queue(
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
        record_metrics(
            &state,
            "POST",
            "/queue/:registry/clear",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Error: Invalid parameter: registry={registry}"),
        );
    }

    let events = payload.as_array().cloned().unwrap_or_default();
    let operations = events
        .into_iter()
        .filter(|value| value.is_object())
        .collect::<Vec<_>>();

    let remaining = {
        let mut store = state.store.lock().await;
        let _ = store.clear_queue(&registry, &operations);
        store.get_queue(&registry)
    };
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "POST",
        "/queue/:registry/clear",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(remaining)).into_response()
}

pub(crate) async fn process_events_route(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let result = process_events_impl(&state).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "POST",
        "/events/process",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(result)).into_response()
}

pub(crate) async fn db_reset(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }
    if env::var("NODE_ENV").ok().as_deref() == Some("production") {
        record_metrics(
            &state,
            "GET",
            "/db/reset",
            403,
            start.elapsed().as_secs_f64(),
        );
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
    state.import_queue.lock().await.clear();
    clear_search_index(&state).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "GET",
        "/db/reset",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(ok)).into_response()
}

pub(crate) async fn db_verify(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let start = Instant::now();
    if let Some(response) = require_admin_key(&state, &headers) {
        return response;
    }

    let result = verify_db_impl(&state, false).await;
    build_search_index(&state).await;
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "GET",
        "/db/verify",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(result)).into_response()
}

pub(crate) async fn search_docs(
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

pub(crate) async fn query_docs(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Response {
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

pub(crate) async fn get_latest_block(
    State(state): State<AppState>,
    Path(registry): Path<String>,
) -> Response {
    let start = Instant::now();
    if !is_valid_registry(&registry) {
        record_metrics(
            &state,
            "GET",
            "/block/:registry/latest",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Error: Invalid parameter: registry={registry}"),
        );
    }

    let store = state.store.lock().await;
    let block = store.get_block(&registry, None);
    record_metrics(
        &state,
        "GET",
        "/block/:registry/latest",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(block)).into_response()
}

pub(crate) async fn get_block_by_id(
    State(state): State<AppState>,
    Path((registry, block_id)): Path<(String, String)>,
) -> Response {
    let start = Instant::now();
    if !is_valid_registry(&registry) {
        record_metrics(
            &state,
            "GET",
            "/block/:registry/:blockId",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Error: Invalid parameter: registry={registry}"),
        );
    }

    let block_key = block_id
        .parse::<u64>()
        .ok()
        .map(BlockLookup::Height)
        .unwrap_or(BlockLookup::Hash(block_id));
    let store = state.store.lock().await;
    let block = store.get_block(&registry, Some(block_key));
    record_metrics(
        &state,
        "GET",
        "/block/:registry/:blockId",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(block)).into_response()
}

pub(crate) async fn add_block(
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
        record_metrics(
            &state,
            "POST",
            "/block/:registry",
            500,
            start.elapsed().as_secs_f64(),
        );
        return text_error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("Error: Invalid parameter: registry={registry}"),
        );
    }

    let mut store = state.store.lock().await;
    let ok = store.add_block(&registry, payload).is_ok();
    drop(store);
    refresh_metrics_snapshot(&state).await;
    record_metrics(
        &state,
        "POST",
        "/block/:registry",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(json!(ok)).into_response()
}

pub(crate) async fn resolve_did(
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
        confirm: query
            .get("confirm")
            .map(|value| value == "true")
            .unwrap_or(false),
        verify: query
            .get("verify")
            .map(|value| value == "true")
            .unwrap_or(false),
    };

    let local_doc = match resolve_local_doc_async(&state, &did, resolve_options.clone()).await {
        Ok(doc) => doc,
        Err(_) => {
            let error_kind = if !did.starts_with("did:") {
                "invalidDid"
            } else {
                "notFound"
            };
            did_resolution_error_doc(error_kind)
        }
    };

    let has_resolver_error = local_doc
        .get("didResolutionMetadata")
        .and_then(|value| value.get("error"))
        .is_some();

    if has_resolver_error && !state.config.fallback_url.trim().is_empty() {
        let url = format!(
            "{}/1.0/identifiers/{}",
            state.config.fallback_url.trim_end_matches('/'),
            url_encode_component(&did)
        );

        match state
            .client
            .get(url)
            .timeout(Duration::from_millis(state.config.fallback_timeout_ms))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => match response.bytes().await {
                Ok(body) => match serde_json::from_slice::<Value>(&body) {
                    Ok(resolved) => {
                        record_metrics(
                            &state,
                            "GET",
                            "/did/:did",
                            200,
                            start.elapsed().as_secs_f64(),
                        );
                        return Json(resolved).into_response();
                    }
                    Err(error) => {
                        error!("resolve DID fallback body parse failed: {error}");
                    }
                },
                Err(error) => {
                    error!("resolve DID fallback body read failed: {error}");
                }
            },
            Ok(_) => {}
            Err(error) => {
                error!("resolve DID fallback failed: {error}");
            }
        }
    }

    record_metrics(
        &state,
        "GET",
        "/did/:did",
        200,
        start.elapsed().as_secs_f64(),
    );
    Json(local_doc).into_response()
}

pub(crate) async fn ipfs_add_json(
    State(state): State<AppState>,
    Json(payload): Json<Value>,
) -> Response {
    let start = Instant::now();
    let url = format!("{}/block/put", state.config.ipfs_url.trim_end_matches('/'));
    let response = state
        .client
        .post(url)
        .query(&[
            ("pin", "true"),
            ("cid-codec", "json"),
            ("mhtype", "sha2-256"),
        ])
        .multipart(
            reqwest::multipart::Form::new().part(
                "file",
                reqwest::multipart::Part::bytes(payload.to_string().into_bytes())
                    .mime_str("application/json")
                    .unwrap(),
            ),
        )
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            error!("ipfs json block put failed: {error}");
            record_metrics(
                &state,
                "POST",
                "/ipfs/json",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (StatusCode::BAD_GATEWAY, error_json("IPFS add failed")).into_response();
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            error!("ipfs json block put body read failed: {error}");
            record_metrics(
                &state,
                "POST",
                "/ipfs/json",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (
                StatusCode::BAD_GATEWAY,
                error_json("IPFS add response failed"),
            )
                .into_response();
        }
    };

    let cid = extract_ipfs_hash(&body).unwrap_or(body.trim().to_string());
    record_metrics(
        &state,
        "POST",
        "/ipfs/json",
        status.as_u16(),
        start.elapsed().as_secs_f64(),
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(cid))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub(crate) async fn ipfs_get_json(
    State(state): State<AppState>,
    Path(cid): Path<String>,
) -> Response {
    let start = Instant::now();
    let url = format!("{}/block/get", state.config.ipfs_url.trim_end_matches('/'));
    let response = state
        .client
        .post(url)
        .query(&[("arg", cid.as_str())])
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            error!("ipfs json block get failed: {error}");
            record_metrics(
                &state,
                "GET",
                "/ipfs/json/:cid",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (StatusCode::BAD_GATEWAY, error_json("IPFS cat failed")).into_response();
        }
    };

    let status = response.status();
    let body = match response.bytes().await {
        Ok(body) => body,
        Err(error) => {
            error!("ipfs json block get body read failed: {error}");
            record_metrics(
                &state,
                "GET",
                "/ipfs/json/:cid",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (
                StatusCode::BAD_GATEWAY,
                error_json("IPFS cat response failed"),
            )
                .into_response();
        }
    };

    record_metrics(
        &state,
        "GET",
        "/ipfs/json/:cid",
        status.as_u16(),
        start.elapsed().as_secs_f64(),
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub(crate) async fn ipfs_add_text(State(state): State<AppState>, request: Request) -> Response {
    let start = Instant::now();
    let body = match request_body_bytes(request, state.config.upload_limit).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    proxy_ipfs_add(
        &state,
        vec![
            ("pin".to_string(), "true".to_string()),
            ("cid-version".to_string(), "1".to_string()),
        ],
        reqwest::multipart::Form::new().part(
            "file",
            reqwest::multipart::Part::bytes(body.to_vec())
                .mime_str("text/plain")
                .unwrap(),
        ),
        "/ipfs/text",
        start,
    )
    .await
}

pub(crate) async fn ipfs_get_text(
    State(state): State<AppState>,
    Path(cid): Path<String>,
) -> Response {
    let start = Instant::now();
    proxy_ipfs_cat(
        &state,
        &cid,
        "text/plain; charset=utf-8",
        "/ipfs/text/:cid",
        start,
    )
    .await
}

pub(crate) async fn ipfs_add_data(State(state): State<AppState>, request: Request) -> Response {
    let start = Instant::now();
    let body = match request_body_bytes(request, state.config.upload_limit).await {
        Ok(bytes) => bytes,
        Err(response) => return response,
    };

    proxy_ipfs_add(
        &state,
        vec![
            ("pin".to_string(), "true".to_string()),
            ("cid-version".to_string(), "1".to_string()),
        ],
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

pub(crate) async fn ipfs_get_data(
    State(state): State<AppState>,
    Path(cid): Path<String>,
) -> Response {
    let start = Instant::now();
    proxy_ipfs_cat(
        &state,
        &cid,
        "application/octet-stream",
        "/ipfs/data/:cid",
        start,
    )
    .await
}

pub(crate) async fn ipfs_add_stream(State(state): State<AppState>, request: Request) -> Response {
    let start = Instant::now();
    let (_parts, body) = request.into_parts();
    let body_stream = body.into_data_stream();
    let reqwest_body = reqwest::Body::wrap_stream(body_stream);
    let form = reqwest::multipart::Form::new()
        .part("file", reqwest::multipart::Part::stream(reqwest_body));

    let url = format!("{}/add", state.config.ipfs_url.trim_end_matches('/'));
    let response = state
        .client
        .post(url)
        .query(&[("pin", "true"), ("cid-version", "1")])
        .multipart(form)
        .send()
        .await;

    let response = match response {
        Ok(response) => response,
        Err(error) => {
            error!("ipfs stream upload failed: {error}");
            record_metrics(
                &state,
                "POST",
                "/ipfs/stream",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (StatusCode::BAD_GATEWAY, error_json("IPFS add failed")).into_response();
        }
    };

    let status = response.status();
    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            error!("ipfs stream upload body read failed: {error}");
            record_metrics(
                &state,
                "POST",
                "/ipfs/stream",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (
                StatusCode::BAD_GATEWAY,
                error_json("IPFS add response failed"),
            )
                .into_response();
        }
    };

    let cid = extract_ipfs_hash(&body).unwrap_or(body.trim().to_string());
    record_metrics(
        &state,
        "POST",
        "/ipfs/stream",
        status.as_u16(),
        start.elapsed().as_secs_f64(),
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(cid))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub(crate) async fn ipfs_get_stream(
    State(state): State<AppState>,
    Path(cid): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    let start = Instant::now();
    let url = format!("{}/cat", state.config.ipfs_url.trim_end_matches('/'));
    let response = match state
        .client
        .post(url)
        .query(&[("arg", cid.as_str())])
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            error!("ipfs stream cat request failed: {error}");
            record_metrics(
                &state,
                "GET",
                "/ipfs/stream/:cid",
                502,
                start.elapsed().as_secs_f64(),
            );
            return (StatusCode::BAD_GATEWAY, error_json("IPFS cat failed")).into_response();
        }
    };

    let status = response.status();
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

    let stream = response.bytes_stream();
    builder
        .body(Body::from_stream(stream))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

pub(crate) async fn get_metrics(State(state): State<AppState>) -> Response {
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

pub(crate) async fn not_found(State(state): State<AppState>, request: Request) -> Response {
    let route = normalize_path(request.uri().path());
    record_metrics(&state, request.method().as_str(), &route, 404, 0.0);
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "message": "Endpoint not found" })),
    )
        .into_response()
}

pub(crate) async fn api_not_found(State(state): State<AppState>, request: Request) -> Response {
    let route = normalize_path(request.uri().path());
    record_metrics(&state, request.method().as_str(), &route, 404, 0.0);
    (
        StatusCode::NOT_FOUND,
        Json(json!({ "message": "Endpoint not found" })),
    )
        .into_response()
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
    to_bytes(body, limit).await.map_err(|_| {
        (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "request body too large" })),
        )
            .into_response()
    })
}

async fn proxy_ipfs_add(
    state: &AppState,
    query: Vec<(String, String)>,
    form: reqwest::multipart::Form,
    route: &str,
    start: Instant,
) -> Response {
    let url = format!("{}/add", state.config.ipfs_url.trim_end_matches('/'));
    let response = state
        .client
        .post(url)
        .query(&query)
        .multipart(form)
        .send()
        .await;

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
            return (
                StatusCode::BAD_GATEWAY,
                error_json("IPFS add response failed"),
            )
                .into_response();
        }
    };

    let cid = extract_ipfs_hash(&body).unwrap_or(body.trim().to_string());
    record_metrics(
        state,
        "POST",
        route,
        status.as_u16(),
        start.elapsed().as_secs_f64(),
    );
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(cid))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn proxy_ipfs_cat(
    state: &AppState,
    cid: &str,
    content_type: &str,
    route: &str,
    start: Instant,
) -> Response {
    let response = proxy_ipfs_cat_raw(state, cid).await;

    let (status, body) = match response {
        Ok(value) => value,
        Err(response) => {
            record_metrics(state, "GET", route, 502, start.elapsed().as_secs_f64());
            return response;
        }
    };

    record_metrics(
        state,
        "GET",
        route,
        status.as_u16(),
        start.elapsed().as_secs_f64(),
    );
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
        (
            StatusCode::BAD_GATEWAY,
            error_json("IPFS cat response failed"),
        )
            .into_response()
    })?;

    Ok((status, body))
}

fn error_json(message: &str) -> Json<Value> {
    Json(json!({ "error": message }))
}

async fn fetch_ipfs_json(state: &AppState, cid: &str) -> Option<Value> {
    let response = proxy_ipfs_cat_raw(state, cid).await.ok()?;
    let (_status, body) = response;
    serde_json::from_slice::<Value>(&body).ok()
}

pub(crate) fn is_valid_registry(registry: &str) -> bool {
    matches!(
        registry,
        "local" | "hyperswarm" | "BTC:mainnet" | "BTC:testnet4" | "BTC:signet"
    )
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
        _ => Some(
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "Unauthorized — valid admin API key required" })),
            )
                .into_response(),
        ),
    }
}

fn extract_ipfs_hash(body: &str) -> Option<String> {
    for line in body.lines().rev() {
        if let Ok(json) = serde_json::from_str::<Value>(line) {
            if let Some(hash) = json.get("Hash").and_then(Value::as_str) {
                return Some(hash.to_string());
            }
            if let Some(hash) = json.get("Key").and_then(Value::as_str) {
                return Some(hash.to_string());
            }
            if let Some(hash) = json
                .get("Cid")
                .and_then(|value| value.get("/"))
                .and_then(Value::as_str)
            {
                return Some(hash.to_string());
            }
        }
    }
    None
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
