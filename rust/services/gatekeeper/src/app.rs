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
    routing::{get, post},
    Router,
};
use reqwest::Client;
use tokio::{net::TcpListener, sync::Mutex};
use tracing::info;

use crate::{
    api::{
        add_block, api_not_found, clear_queue, create_did, db_reset, db_verify, export_batch,
        export_dids, generate_did, get_block_by_id, get_latest_block, get_metrics, get_queue,
        import_batch, import_batch_by_cids, import_dids, ipfs_add_data, ipfs_add_json,
        ipfs_add_stream, ipfs_add_text, ipfs_get_data, ipfs_get_json, ipfs_get_stream,
        ipfs_get_text, list_dids, not_found, process_events_route, query_docs, ready, registries,
        remove_dids, resolve_did, search_docs, status, version,
    },
    refresh_metrics_snapshot, start_background_tasks, Config, JsonDb, Metrics,
};

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: Config,
    pub(crate) client: Client,
    pub(crate) metrics: Arc<Metrics>,
    pub(crate) store: Arc<Mutex<JsonDb>>,
    pub(crate) events_seen: Arc<Mutex<HashMap<String, bool>>>,
    pub(crate) verified_dids: Arc<Mutex<HashMap<String, bool>>>,
    pub(crate) supported_registries: Arc<Mutex<Vec<String>>>,
    pub(crate) processing_events: Arc<Mutex<bool>>,
    pub(crate) ready: Arc<AtomicBool>,
    pub(crate) started_at: Instant,
}

pub async fn run() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Config::from_env()?;
    let state = build_state(config.clone())?;
    let app = build_router(state.clone());

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

    state.ready.store(true, Ordering::Relaxed);
    axum::serve(listener, app).await.context("server failed")?;
    Ok(())
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
        events_seen: Arc::new(Mutex::new(HashMap::new())),
        verified_dids: Arc::new(Mutex::new(HashMap::new())),
        supported_registries: Arc::new(Mutex::new(config.registries.clone())),
        processing_events: Arc::new(Mutex::new(false)),
        ready: Arc::new(AtomicBool::new(false)),
        started_at: Instant::now(),
    })
}

fn build_router(state: AppState) -> Router {
    Router::new()
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
        .with_state(state)
}

fn init_tracing() {
    let filter =
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());
    tracing_subscriber::fmt().with_env_filter(filter).init();
}
