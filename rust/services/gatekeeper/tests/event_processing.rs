mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{create_event_from_operation, deterministic_vectors, proof_vectors, spawn_json};

#[tokio::test]
async fn event_processing_drains_valid_events_and_requeues_deferred_ones() -> Result<()> {
    let deterministic = deterministic_vectors();
    let proof = proof_vectors();

    let create_event = create_event_from_operation(
        deterministic["localAgent"]["operation"].clone(),
        "local",
        &[0],
    );
    let deferred_update = create_event_from_operation(
        proof["agentUpdateValid"]["operation"].clone(),
        "local",
        &[1],
    );
    let expected_did = deterministic["localAgent"]["did"].as_str().unwrap();

    let service = spawn_json().await?;

    let response = service
        .admin(
            service
                .client
                .post(format!("{}/batch/import", service.base_url)),
        )
        .json(&json!([create_event, deferred_update]))
        .send()
        .await?;
    assert!(response.status().is_success());
    let import = response.json::<Value>().await?;
    assert_eq!(import["queued"], 2);
    assert_eq!(import["rejected"], 0);
    assert_eq!(import["total"], 2);

    let response = service
        .admin(
            service
                .client
                .post(format!("{}/events/process", service.base_url)),
        )
        .send()
        .await?;
    assert!(response.status().is_success());
    let processed = response.json::<Value>().await?;
    assert_eq!(processed["added"], 1);
    assert_eq!(processed["pending"], 1);

    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, expected_did))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?["didDocument"]["id"], expected_did);

    let response = service
        .admin(service.client.get(format!("{}/status", service.base_url)))
        .send()
        .await?;
    assert!(response.status().is_success());
    let status = response.json::<Value>().await?;
    assert_eq!(status["dids"]["eventsQueue"].as_array().unwrap().len(), 1);

    Ok(())
}
