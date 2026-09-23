mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{deterministic_vectors, spawn_mongodb};

#[tokio::test]
async fn mongo_backend_startup_persistence_and_restart() -> Result<()> {
    let Some(mongo_url) = std::env::var("ARCHON_TEST_MONGODB_URL").ok() else {
        eprintln!("skipping mongodb compatibility test; set ARCHON_TEST_MONGODB_URL");
        return Ok(());
    };

    let vectors = deterministic_vectors();
    let agent = vectors["hyperswarmAgent"]["operation"].clone();
    let did = vectors["hyperswarmAgent"]["did"].as_str().unwrap();
    let service = spawn_mongodb(&mongo_url).await?;
    let reset = service
        .admin(service.client.get(format!("{}/db/reset", service.base_url)))
        .send()
        .await?;
    assert!(reset.status().is_success());

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&agent)
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
    let queued = service
        .admin(
            service
                .client
                .get(format!("{}/queue/hyperswarm", service.base_url)),
        )
        .send()
        .await?;
    assert_eq!(queued.json::<Value>().await?, json!([agent]));

    // The service process and its in-memory state are gone; startup must replay
    // the persisted candidate journal and retain the operation and queue.
    drop(service);
    let service = spawn_mongodb(&mongo_url).await?;
    let resolved = service
        .client
        .get(format!("{}/did/{did}", service.base_url))
        .send()
        .await?;
    assert!(resolved.status().is_success());
    assert_eq!(resolved.json::<Value>().await?["didDocument"]["id"], did);
    let genesis = service
        .client
        .get(format!("{}/did/{did}/genesis", service.base_url))
        .send()
        .await?;
    assert_eq!(genesis.json::<Value>().await?["didDocument"]["id"], did);
    let queued = service
        .admin(
            service
                .client
                .get(format!("{}/queue/hyperswarm", service.base_url)),
        )
        .send()
        .await?;
    assert_eq!(queued.json::<Value>().await?, json!([agent]));
    let cleared = service
        .admin(
            service
                .client
                .post(format!("{}/queue/hyperswarm/clear", service.base_url)),
        )
        .json(&json!([agent]))
        .send()
        .await?;
    assert!(cleared.status().is_success());
    let queued = service
        .admin(
            service
                .client
                .get(format!("{}/queue/hyperswarm", service.base_url)),
        )
        .send()
        .await?;
    assert_eq!(queued.json::<Value>().await?, json!([]));
    let removed = service
        .admin(
            service
                .client
                .post(format!("{}/dids/remove", service.base_url)),
        )
        .json(&json!([did]))
        .send()
        .await?;
    assert!(removed.status().is_success());
    let resolved = service
        .client
        .get(format!("{}/did/{did}", service.base_url))
        .send()
        .await?;
    assert_eq!(
        resolved.json::<Value>().await?["didResolutionMetadata"]["error"],
        "notFound"
    );

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
