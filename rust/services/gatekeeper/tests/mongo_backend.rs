mod common;

use anyhow::Result;
use serde_json::Value;

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
