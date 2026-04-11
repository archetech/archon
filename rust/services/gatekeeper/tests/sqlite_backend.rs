mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{deterministic_vectors, path_buf, respawn_service};

#[tokio::test]
async fn sqlite_backend_persists_queue_and_blocks_across_restart() -> Result<()> {
    let vectors = deterministic_vectors();
    let hyperswarm_agent = vectors["hyperswarmAgent"]["operation"].clone();
    let expected_did = vectors["hyperswarmAgent"]["did"].as_str().unwrap();

    let temp_dir = tempfile::tempdir()?;
    let data_dir = path_buf(temp_dir.path());
    let service = respawn_service("sqlite", &data_dir, &[]).await?;

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&hyperswarm_agent)
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(
        response.json::<Value>().await?,
        Value::String(expected_did.to_string())
    );

    let response = service
        .admin(
            service
                .client
                .get(format!("{}/queue/hyperswarm", service.base_url)),
        )
        .send()
        .await?;
    assert!(response.status().is_success());
    let queue = response.json::<Vec<Value>>().await?;
    assert_eq!(queue.len(), 1);
    assert_eq!(queue[0]["type"], "create");

    let block = json!({
        "hash": "sqlite-test-block",
        "height": 17,
        "registry": "hyperswarm",
        "entries": [expected_did],
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
    assert_eq!(response.json::<Value>().await?, block);
    drop(service);

    let service = respawn_service("sqlite", &data_dir, &[]).await?;

    let response = service
        .admin(
            service
                .client
                .get(format!("{}/queue/hyperswarm", service.base_url)),
        )
        .send()
        .await?;
    assert!(response.status().is_success());
    let queue = response.json::<Vec<Value>>().await?;
    assert_eq!(queue.len(), 1);

    let response = service
        .client
        .get(format!("{}/block/hyperswarm/17", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?, block);

    Ok(())
}
