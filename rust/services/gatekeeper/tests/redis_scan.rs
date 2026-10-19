mod common;

use anyhow::Result;
use redis::Commands;
use serde_json::{json, Value};

use common::{deterministic_vectors, did_suffix, spawn_redis};

// Listing DIDs must not use KEYS, which blocks Redis while it walks every key
// in the database (#1407). Most keys on a production node are block
// checkpoints, so the fixture surrounds one DID with thousands of them.
#[tokio::test]
async fn redis_lists_dids_with_scan_among_many_other_keys() -> Result<()> {
    let Some(redis_url) = std::env::var("ARCHON_TEST_REDIS_URL").ok() else {
        eprintln!("skipping redis scan test; set ARCHON_TEST_REDIS_URL");
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

    let _: () = conn.set(format!("archon/ops/{opid}"), serde_json::to_string(&operation)?)?;
    let _: usize = conn.rpush(
        format!("archon/dids/{suffix}"),
        serde_json::to_string(&json!({
            "registry": "hyperswarm",
            "time": operation["created"],
            "ordinal": [1774005006160u64, 6],
            "did": did,
            "opid": opid
        }))?,
    )?;
    let mut pipe = redis::pipe();
    for i in 0..25_000 {
        pipe.set(
            format!("archon/registry/SOL:mainnet-beta/blocks/hash-{i}"),
            format!(r#"{{"hash":"hash-{i}","height":{i}}}"#),
        )
        .ignore();
    }
    let _: () = pipe.query(&mut conn)?;

    let service = spawn_redis(&redis_url).await?;
    let _: () = redis::cmd("CONFIG").arg("RESETSTAT").query(&mut conn)?;

    let response = service
        .client
        .post(format!("{}/dids", service.base_url))
        .json(&json!({}))
        .send()
        .await?;
    assert!(response.status().is_success());
    let dids = response.json::<Value>().await?;
    assert_eq!(dids, json!([did]));

    let response = service
        .client
        .get(format!("{}/status", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?["dids"]["total"], 1);

    let stats: String = redis::cmd("INFO").arg("commandstats").query(&mut conn)?;
    assert!(!stats.contains("cmdstat_keys:"), "KEYS was used:\n{stats}");
    assert!(stats.contains("cmdstat_scan:"), "SCAN was not used:\n{stats}");

    Ok(())
}
