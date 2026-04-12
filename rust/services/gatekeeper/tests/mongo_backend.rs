mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{deterministic_vectors, spawn_mongodb};

#[tokio::test]
async fn mongo_backend_round_trip_is_env_gated() -> Result<()> {
    let Some(mongo_url) = std::env::var("ARCHON_TEST_MONGODB_URL").ok() else {
        eprintln!("skipping mongodb compatibility test; set ARCHON_TEST_MONGODB_URL");
        return Ok(());
    };

    let vectors = deterministic_vectors();
    let local_agent = vectors["localAgent"]["operation"].clone();
    let did = vectors["localAgent"]["did"].as_str().unwrap();
    let service = spawn_mongodb(&mongo_url).await?;

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&local_agent)
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, did))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?["didDocument"]["id"], did);

    Ok(())
}

#[tokio::test]
async fn mongo_backend_preserves_block_shape_and_reset_contract() -> Result<()> {
    let Some(mongo_url) = std::env::var("ARCHON_TEST_MONGODB_URL").ok() else {
        eprintln!("skipping mongodb compatibility test; set ARCHON_TEST_MONGODB_URL");
        return Ok(());
    };

    let service = spawn_mongodb(&mongo_url).await?;
    let block = json!({
        "hash": "mongo-test-block",
        "height": 23,
        "registry": "hyperswarm",
        "entries": ["did:cid:test-block-entry"],
        "time": "2026-04-11T00:00:00Z"
    });

    let response = service
        .admin(
            service
                .client
                .post(format!("{}/block/hyperswarm", service.base_url)),
        )
        .json(&block)
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?, Value::Bool(true));

    let response = service
        .client
        .get(format!("{}/block/hyperswarm/latest", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let latest = response.json::<Value>().await?;
    assert_eq!(latest["hash"], block["hash"]);
    assert_eq!(latest["height"], block["height"]);
    assert_eq!(latest["registry"], block["registry"]);
    assert_eq!(latest["entries"], block["entries"]);
    assert_eq!(latest["time"], block["time"]);

    let response = service
        .admin(service.client.get(format!("{}/db/reset", service.base_url)))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?, Value::Bool(true));

    let response = service
        .client
        .get(format!("{}/block/hyperswarm/23", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let after_reset = response.json::<Value>().await?;
    assert_eq!(after_reset["hash"], block["hash"]);
    assert_eq!(after_reset["height"], block["height"]);
    assert_eq!(after_reset["registry"], block["registry"]);
    assert_eq!(after_reset["entries"], block["entries"]);
    assert_eq!(after_reset["time"], block["time"]);

    Ok(())
}
