mod common;

use anyhow::Result;
use axum::{extract::State, http::HeaderMap, routing::get, Json, Router};
use common::{create_agent_operation, create_update_operation, spawn_service};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tokio::sync::Mutex;

#[derive(Clone)]
struct Peer {
    document: Arc<Mutex<Value>>,
    hits: Arc<AtomicUsize>,
}

async fn answer(State(peer): State<Peer>, headers: HeaderMap) -> Json<Value> {
    assert_eq!(headers.get("x-archon-confirm-fallback").unwrap(), "1");
    peer.hits.fetch_add(1, Ordering::SeqCst);
    Json(peer.document.lock().await.clone())
}

#[tokio::test]
async fn pending_and_missing_history_delegate_without_importing_peer_state() -> Result<()> {
    let peer = Peer {
        document: Arc::new(Mutex::new(Value::Null)),
        hits: Arc::new(AtomicUsize::new(0)),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let url = format!("http://{}", listener.local_addr()?);
    let router = Router::new()
        .route("/api/v1/did/:did", get(answer))
        .with_state(peer.clone());
    let server = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    let service = spawn_service(
        "json",
        tempfile::tempdir()?,
        &[("ARCHON_GATEKEEPER_CONFIRM_FALLBACK_URL", url)],
    )
    .await?;
    let operation = create_agent_operation(9, "2026-04-11T12:00:00Z", "hyperswarm");
    let did: String = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&operation)
        .send()
        .await?
        .json()
        .await?;
    let endpoint = format!("{}/did/{did}", service.base_url);
    let initial: Value = service.client.get(&endpoint).send().await?.json().await?;
    let update = create_update_operation(
        9,
        &did,
        initial["didDocumentMetadata"]["versionId"].as_str(),
        "2026-04-11T13:00:00Z",
        json!({"didDocumentData":{"pending":true}}),
    );
    assert!(service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&update)
        .send()
        .await?
        .status()
        .is_success());
    let mut confirmed: Value = service.client.get(&endpoint).send().await?.json().await?;
    confirmed["didDocumentMetadata"]["confirmed"] = json!(true);
    *peer.document.lock().await = confirmed.clone();
    let response: Value = service
        .client
        .get(format!("{endpoint}?confirm=true"))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(response, confirmed);
    assert_eq!(peer.hits.load(Ordering::SeqCst), 1);
    for query in [
        "confirm=false",
        "confirm=true&versionSequence=1",
        "confirm=true&versionTime=2026-04-11T12:30:00Z",
    ] {
        service
            .client
            .get(format!("{endpoint}?{query}"))
            .send()
            .await?;
    }
    let local: Value = service
        .client
        .get(format!("{endpoint}?confirm=true"))
        .header("x-archon-confirm-fallback", "1")
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(local["didDocumentMetadata"]["versionSequence"], "1");
    assert_eq!(peer.hits.load(Ordering::SeqCst), 1);
    for variant in [
        "stale",
        "wrong-did",
        "error",
        "unconfirmed",
        "too-late",
        "too-new",
    ] {
        let mut doc = confirmed.clone();
        match variant {
            "stale" => doc = initial.clone(),
            "wrong-did" => doc["didDocument"]["id"] = json!("did:cid:other"),
            "error" => doc["didResolutionMetadata"]["error"] = json!("notFound"),
            "unconfirmed" => doc["didDocumentMetadata"]["confirmed"] = json!(false),
            "too-late" => doc["didDocumentMetadata"]["updated"] = json!("2030-01-01T00:00:00Z"),
            "too-new" => doc["didDocumentMetadata"]["versionSequence"] = json!("3"),
            _ => unreachable!(),
        }
        *peer.document.lock().await = doc;
        let answer: Value = service
            .client
            .get(format!(
                "{endpoint}?confirm=true&versionSequence=2&versionTime=2026-04-11T14:00:00Z"
            ))
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(
            answer["didDocumentMetadata"]["versionSequence"], "1",
            "{variant}"
        );
    }
    service
        .admin(
            service
                .client
                .post(format!("{}/dids/remove", service.base_url)),
        )
        .json(&json!([did]))
        .send()
        .await?
        .error_for_status()?;
    *peer.document.lock().await = confirmed.clone();
    let missing: Value = service
        .client
        .get(format!("{endpoint}?confirm=true"))
        .send()
        .await?
        .json()
        .await?;
    assert_eq!(missing, confirmed);
    let still_missing: Value = service.client.get(&endpoint).send().await?.json().await?;
    assert_eq!(still_missing["didResolutionMetadata"]["error"], "notFound");
    server.abort();
    Ok(())
}
