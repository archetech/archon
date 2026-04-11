mod common;

use anyhow::Result;
use redis::Commands;
use serde_json::{json, Value};

use common::{deterministic_vectors, did_suffix, spawn_redis};

#[tokio::test]
async fn redis_compat_loads_typescript_keys_and_persists_back_same_schema() -> Result<()> {
    let Some(redis_url) = std::env::var("ARCHON_TEST_REDIS_URL").ok() else {
        eprintln!("skipping redis compatibility test; set ARCHON_TEST_REDIS_URL");
        return Ok(());
    };

    let vectors = deterministic_vectors();
    let did = vectors["hyperswarmAgent"]["did"].as_str().unwrap();
    let suffix = did_suffix(did);
    let operation = vectors["hyperswarmAgent"]["operation"].clone();
    let opid = vectors["hyperswarmAgent"]["cid"].as_str().unwrap();

    let client = redis::Client::open(redis_url.as_str())?;
    let mut conn = client.get_connection()?;
    let _: () = redis::cmd("FLUSHDB").query(&mut conn)?;

    let op_key = format!("archon/ops/{opid}");
    let did_key = format!("archon/dids/{suffix}");
    let queue_key = "archon/registry/hyperswarm/queue";
    let block_key = "archon/registry/hyperswarm/blocks/test-hash";
    let height_map_key = "archon/registry/hyperswarm/heightMap";
    let max_height_key = "archon/registry/hyperswarm/maxHeight";

    let _: () = conn.set(&op_key, serde_json::to_string(&operation)?)?;
    let _: usize = conn.rpush(
        &did_key,
        serde_json::to_string(&json!({
            "registry": "hyperswarm",
            "time": operation["created"],
            "ordinal": [1774005006160u64, 6],
            "did": did,
            "opid": opid
        }))?,
    )?;
    let _: usize = conn.rpush(&queue_key, serde_json::to_string(&operation)?)?;
    let block = json!({
        "hash": "test-hash",
        "height": 22,
        "registry": "hyperswarm",
        "entries": [did]
    });
    let _: () = conn.set(&block_key, serde_json::to_string(&block)?)?;
    let _: usize = conn.hset(height_map_key, "22", "test-hash")?;
    let _: () = conn.set(max_height_key, "22")?;

    let service = spawn_redis(&redis_url).await?;

    let response = service
        .client
        .get(format!("{}/status", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let status = response.json::<Value>().await?;
    assert_eq!(status["dids"]["total"], 1);

    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, did))
        .send()
        .await?;
    assert!(response.status().is_success());
    let doc = response.json::<Value>().await?;
    assert_eq!(doc["didDocument"]["id"], did);

    let response = service
        .admin(
            service
                .client
                .post(format!("{}/block/hyperswarm", service.base_url)),
        )
        .json(&json!({
            "hash": "test-hash-2",
            "height": 23,
            "registry": "hyperswarm",
            "entries": [did]
        }))
        .send()
        .await?;
    assert!(response.status().is_success());

    let raw_events: Vec<String> = conn.lrange(&did_key, 0, -1)?;
    assert_eq!(raw_events.len(), 1);
    let stored_event: Value = serde_json::from_str(&raw_events[0])?;
    assert_eq!(stored_event["opid"], opid);
    assert!(stored_event.get("operation").is_none());

    let persisted_max_height: String = conn.get(max_height_key)?;
    assert_eq!(persisted_max_height, "23");

    Ok(())
}
