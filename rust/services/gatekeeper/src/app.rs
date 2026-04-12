use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result};
use axum::{
    extract::{DefaultBodyLimit, Request},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use reqwest::Client;
use tokio::{net::TcpListener, signal, sync::Mutex};
use tower_http::cors::{Any, CorsLayer};
use tracing::{info, warn};

use crate::{
    api::{
        add_block, api_not_found, clear_queue, create_did, db_reset, db_verify, export_batch,
        export_dids, generate_did, get_block_by_id, get_latest_block, get_metrics, get_queue,
        import_batch, import_batch_by_cids, import_dids, ipfs_add_data, ipfs_add_json,
        ipfs_add_stream, ipfs_add_text, ipfs_get_data, ipfs_get_json, ipfs_get_stream,
        ipfs_get_text, list_dids, not_found, process_events_route, query_docs, ready, registries,
        remove_dids, resolve_did, search_docs, status, version,
    },
    build_search_index, log_status_snapshot, refresh_metrics_snapshot, start_background_tasks,
    CheckDidsResult, Config, EventRecord, JsonDb, Metrics, SearchIndex,
};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: Config,
    pub(crate) client: Client,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) store: Arc<Mutex<JsonDb>>,
    pub(crate) import_queue: Arc<Mutex<Vec<EventRecord>>>,
    pub(crate) events_seen: Arc<Mutex<HashMap<String, bool>>>,
    pub(crate) verified_dids: Arc<Mutex<HashMap<String, bool>>>,
    pub(crate) supported_registries: Arc<Mutex<Vec<String>>>,
    pub(crate) did_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    pub(crate) status_snapshot: Arc<Mutex<Option<CheckDidsResult>>>,
    pub(crate) search_index: Arc<Mutex<SearchIndex>>,
    pub(crate) processing_events: Arc<Mutex<bool>>,
    pub(crate) ready: Arc<AtomicBool>,
    pub(crate) started_at: Instant,
}

pub async fn run() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Config::from_env()?;
    info!(
        "Starting Archon Gatekeeper v{} ({}) with a db ({}) check...",
        config.version, config.git_commit, config.db
    );
    let state = build_state(config.clone())?;
    let app = build_router(state.clone());

    refresh_metrics_snapshot(&state).await;
    log_status_snapshot(&state).await;

    info!("Initializing search index...");
    build_search_index(&state).await;

    if config.status_interval_minutes > 0 {
        info!(
            "Starting status update every {} minutes",
            config.status_interval_minutes
        );
    } else {
        info!("Status update disabled");
    }

    if config.gc_interval_minutes > 0 {
        info!(
            "Starting DID garbage collection in {} minutes",
            config.gc_interval_minutes
        );
    } else {
        info!("DID garbage collection disabled");
    }

    let did_prefix = serde_json::to_string(&config.did_prefix).unwrap_or_else(|_| "\"\"".to_string());
    let registries = serde_json::to_string(&config.registries).unwrap_or_else(|_| "[]".to_string());
    info!("DID prefix: {did_prefix}");
    info!("Supported registries: {registries}");

    start_background_tasks(state.clone());

    let listener = TcpListener::bind(SocketAddr::new(config.bind_address, config.port))
        .await
        .with_context(|| format!("failed to bind {}:{}", config.bind_address, config.port))?;

    info!("Server is running on {}:{}", config.bind_address, config.port);
    if config.admin_api_key.is_empty() {
        warn!("Warning: ARCHON_ADMIN_API_KEY is not set - admin routes are unprotected");
    } else {
        info!("Admin API key protection is ENABLED");
    }

    state.ready.store(true, Ordering::Relaxed);
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("server failed")?;
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut sig) = signal::unix::signal(signal::unix::SignalKind::terminate()) {
            sig.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }

    info!("shutdown signal received, draining in-flight requests");
}

fn build_state(config: Config) -> Result<AppState> {
    let metrics = Arc::new(Metrics::new(&config)?);
    let client = Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .context("failed to create HTTP client")?;
    let store = Arc::new(Mutex::new(JsonDb::load(&config)?));

    Ok(AppState {
        config: config.clone(),
        client,
        metrics,
        store,
        import_queue: Arc::new(Mutex::new(Vec::new())),
        events_seen: Arc::new(Mutex::new(HashMap::new())),
        verified_dids: Arc::new(Mutex::new(HashMap::new())),
        supported_registries: Arc::new(Mutex::new(config.registries.clone())),
        did_locks: Arc::new(Mutex::new(HashMap::new())),
        status_snapshot: Arc::new(Mutex::new(None)),
        search_index: Arc::new(Mutex::new(SearchIndex::default())),
        processing_events: Arc::new(Mutex::new(false)),
        ready: Arc::new(AtomicBool::new(false)),
        started_at: Instant::now(),
    })
}

fn build_router(state: AppState) -> Router {
    let json_limit = state.config.json_limit;
    let upload_limit = state.config.upload_limit;

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    // TS applies three different body size policies:
    //   - express.json({ limit: jsonLimit }) globally (4 MB default)
    //   - express.text/raw({ limit: uploadLimit }) scoped to /ipfs/text and
    //     /ipfs/data (10 MB default)
    //   - nothing on /ipfs/stream — the request body is piped straight into
    //     Kubo with no server-side cap
    // Mirror that by mounting three routers with their own DefaultBodyLimit.

    // /ipfs/stream POST: unbounded so large uploads don't get 413'd.
    let streaming = Router::new()
        .route("/ipfs/stream", post(ipfs_add_stream))
        .layer(DefaultBodyLimit::disable());

    // /ipfs/text and /ipfs/data POST: raw/text bodies up to uploadLimit.
    let upload = Router::new()
        .route("/ipfs/text", post(ipfs_add_text))
        .route("/ipfs/data", post(ipfs_add_data))
        .layer(DefaultBodyLimit::max(upload_limit));

    // Everything else: JSON bodies bounded by jsonLimit.
    let json = Router::new()
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
        .route("/ipfs/text/:cid", get(ipfs_get_text))
        .route("/ipfs/data/:cid", get(ipfs_get_data))
        .route("/ipfs/stream/:cid", get(ipfs_get_stream))
        .route("/block/:registry/latest", get(get_latest_block))
        .route("/block/:registry/:blockId", get(get_block_by_id))
        .route("/block/:registry", post(add_block))
        .route("/search", get(search_docs))
        .route("/query", post(query_docs))
        .layer(DefaultBodyLimit::max(json_limit));

    Router::new()
        .route("/metrics", get(get_metrics))
        .nest("/api/v1", streaming.merge(upload).merge(json))
        .nest("/api", Router::new().fallback(api_not_found))
        .fallback(not_found)
        .layer(middleware::from_fn(log_http))
        .layer(cors)
        .with_state(state)
}

// Emit one info line per request with method, path, query, status, and
// latency. Mirrors morgan/pinoHttp coverage in the TypeScript gatekeeper
// so endpoints like GET /did/:did show up in the container log.
async fn log_http(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let query = request
        .uri()
        .query()
        .map(|q| format!("?{q}"))
        .unwrap_or_default();
    let started = Instant::now();
    let response = next.run(request).await;
    let status = response.status().as_u16();
    let elapsed_ms = started.elapsed().as_millis();
    info!("{} {}{} {} ({}ms)", method, path, query, status, elapsed_ms);
    response
}

fn init_tracing() {
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    // Match the TypeScript gatekeeper's log shape: plain messages, no
    // timestamp/level/target preamble. `docker compose logs` already prefixes
    // each line with the container name (and can add a timestamp via `-t`).
    tracing_subscriber::fmt()
        .with_env_filter(filter)
        .without_time()
        .with_level(false)
        .with_target(false)
        .init();
}
