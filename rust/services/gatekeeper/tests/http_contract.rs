mod common;

use anyhow::Result;
use serde_json::Value;

use common::{deterministic_vectors, spawn_json, ADMIN_KEY};

#[tokio::test]
async fn http_contract_covers_ready_version_status_admin_and_metrics() -> Result<()> {
    let vectors = deterministic_vectors();
    let local_agent = vectors["localAgent"]["operation"].clone();
    let did = vectors["localAgent"]["did"].as_str().unwrap();

    let service = spawn_json().await?;

    let response = service
        .client
        .get(format!("{}/ready", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?, Value::Bool(true));

    let response = service
        .client
        .get(format!("{}/version", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let version = response.json::<Value>().await?;
    assert!(version["version"].is_string());
    assert!(version["commit"].is_string());

    let response = service
        .client
        .get(format!("{}/registries", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let registries = response.json::<Value>().await?;
    assert!(registries.as_array().unwrap().iter().any(|value| value == "local"));

    let response = service
        .client
        .get(format!("{}/api/nope", service.root_url))
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(response.json::<Value>().await?["message"], "Endpoint not found");

    let response = service
        .client
        .get(format!("{}/db/verify", service.base_url))
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json::<Value>().await?["error"],
        "Unauthorized — valid admin API key required"
    );

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&local_agent)
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .client
        .get(format!("{}/did/{}?confirm=true", service.base_url, did))
        .send()
        .await?;
    assert!(response.status().is_success());
    let doc = response.json::<Value>().await?;
    assert_eq!(doc["didDocument"]["id"], did);
    assert_eq!(doc["didDocumentMetadata"]["confirmed"], true);

    let response = service
        .admin(service.client.get(format!("{}/queue/hyperswarm", service.base_url)))
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .client
        .get(format!("{}/metrics", service.root_url))
        .header("x-archon-admin-key", ADMIN_KEY)
        .send()
        .await?;
    assert!(response.status().is_success());
    let metrics = response.text().await?;
    assert!(metrics.contains("route=\"/did/:did\""));
    assert!(metrics.contains("route=\"/queue/:registry\""));

    Ok(())
}
