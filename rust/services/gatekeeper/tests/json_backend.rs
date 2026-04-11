mod common;

use anyhow::Result;
use serde_json::Value;

use common::{deterministic_vectors, path_buf, respawn_service};

#[tokio::test]
async fn json_backend_persists_create_and_status_across_restart() -> Result<()> {
    let vectors = deterministic_vectors();
    let local_agent = vectors["localAgent"]["operation"].clone();
    let expected_did = vectors["localAgent"]["did"].as_str().unwrap();

    let temp_dir = tempfile::tempdir()?;
    let data_dir = path_buf(temp_dir.path());
    let service = respawn_service("json", &data_dir, &[]).await?;

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&local_agent)
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?, Value::String(expected_did.to_string()));

    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, expected_did))
        .send()
        .await?;
    assert!(response.status().is_success());
    let doc = response.json::<Value>().await?;
    assert_eq!(doc["didDocument"]["id"], expected_did);
    assert_eq!(doc["didDocumentMetadata"]["versionSequence"], "1");
    assert_eq!(doc["didDocumentMetadata"]["confirmed"], true);

    let response = service
        .client
        .get(format!("{}/status", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let status = response.json::<Value>().await?;
    assert_eq!(status["dids"]["total"], 1);
    assert_eq!(status["dids"]["byType"]["agents"], 1);
    drop(service);

    let service = respawn_service("json", &data_dir, &[]).await?;
    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, expected_did))
        .send()
        .await?;
    assert!(response.status().is_success());
    let doc = response.json::<Value>().await?;
    assert_eq!(doc["didDocument"]["id"], expected_did);
    assert_eq!(doc["didDocumentMetadata"]["versionSequence"], "1");

    Ok(())
}
