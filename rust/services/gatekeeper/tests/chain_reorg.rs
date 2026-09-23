mod common;

use anyhow::Result;
use axum::{extract::Query, routing::post, Json, Router};
use common::{respawn_service, TestService};
use serde_json::{json, Value};
use std::collections::HashMap;

async fn post_json(service: &TestService, path: &str, body: Value) -> Result<Value> {
    let response = service
        .admin(service.client.post(format!("{}/{path}", service.base_url)))
        .json(&body)
        .send()
        .await?;
    assert!(response.status().is_success(), "{path}");
    Ok(response.json().await?)
}
async fn get_json(service: &TestService, path: &str) -> Result<Value> {
    let response = service
        .client
        .get(format!("{}/{path}", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success(), "{path}");
    Ok(response.json().await?)
}

#[tokio::test]
async fn signed_anchor_withdrawal_survives_restart_and_allows_reanchoring() -> Result<()> {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../tests/fixtures/chain-reorg.json"))?;
    let blocks: HashMap<String, Value> = fixture["successors"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["cid"].as_str().unwrap().to_string(),
                entry["op"].clone(),
            )
        })
        .collect();
    let app = Router::new().route(
        "/block/get",
        post(move |Query(query): Query<HashMap<String, String>>| {
            let body = blocks
                .get(query.get("arg").unwrap())
                .expect("fixture CID")
                .clone();
            async move { Json(body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let env = [(
        "ARCHON_IPFS_URL",
        format!("http://{}", listener.local_addr()?),
    )];
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut backends = vec!["json", "sqlite"];
    let mut env = env.to_vec();
    if let Ok(url) = std::env::var("ARCHON_TEST_REDIS_URL") {
        backends.push("redis");
        env.push(("ARCHON_REDIS_URL", url));
    }
    if let Ok(url) = std::env::var("ARCHON_TEST_MONGODB_URL") {
        backends.push("mongodb");
        env.push(("ARCHON_MONGODB_URL", url));
    }
    for backend in backends {
        let dir = tempfile::tempdir()?;
        let mut service = respawn_service(backend, dir.path(), &env).await?;
        let mut operations = vec![
            fixture["publisher"].clone(),
            fixture["owner"].clone(),
            fixture["target"].clone(),
        ];
        operations.extend(
            fixture["successors"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["op"].clone()),
        );
        let events: Vec<Value> = operations.into_iter().map(|op| json!({
            "registry": "hyperswarm", "time": op["proof"]["created"], "ordinal": [0], "operation": op
        })).collect();
        post_json(&service, "batch/import", json!(events)).await?;
        post_json(&service, "events/process", Value::Null).await?;
        for (height, hash) in [(99, "common"), (100, "orphan")] {
            post_json(
                &service,
                "block/BTC:signet",
                json!({ "height": height, "hash": hash, "time": 1000 }),
            )
            .await?;
        }
        let anchor =
            json!({ "cids": [fixture["successors"][1]["cid"]], "metadata": fixture["metadata"] });
        post_json(&service, "batch/import/cids", anchor.clone()).await?;
        post_json(&service, "events/process", Value::Null).await?;
        let path = format!("did/{}", fixture["targetDid"].as_str().unwrap());
        assert_eq!(
            get_json(&service, &path).await?["didDocumentData"],
            fixture["successors"][1]["op"]["doc"]["didDocumentData"]
        );
        let denied = service
            .client
            .post(format!("{}/block/BTC:signet/rewind", service.base_url))
            .json(&json!({"fromHeight": 100}))
            .send()
            .await?;
        assert_eq!(denied.status(), 401);
        post_json(
            &service,
            "block/BTC:signet/rewind",
            json!({ "fromHeight": 100 }),
        )
        .await?;
        post_json(
            &service,
            "block/BTC:signet",
            json!({ "height": 100, "hash": "replacement", "time": 1001 }),
        )
        .await?;
        for restart in [false, true] {
            if restart {
                drop(service);
                service = respawn_service(backend, dir.path(), &env).await?;
            }
            let resolved = get_json(&service, &path).await?;
            assert_eq!(
                resolved["didDocumentData"],
                fixture["successors"][0]["op"]["doc"]["didDocumentData"]
            );
            assert_eq!(resolved["didDocumentMetadata"]["confirmed"], false);
            assert_eq!(
                get_json(&service, "block/BTC:signet/100").await?["hash"],
                "replacement"
            );
            assert!(get_json(&service, "block/BTC:signet/orphan")
                .await?
                .is_null());
            assert_eq!(
                get_json(&service, "block/BTC:signet/99").await?["hash"],
                "common"
            );
        }
        post_json(&service, "batch/import/cids", anchor).await?;
        post_json(&service, "events/process", Value::Null).await?;
        assert_eq!(
            get_json(&service, &path).await?["didDocumentMetadata"]["confirmed"],
            true
        );
    }
    server.abort();
    withdrawing_controller_anchor_replays_dependent_asset().await?;
    Ok(())
}

async fn withdrawing_controller_anchor_replays_dependent_asset() -> Result<()> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/chain-reorg-controller.json"
    ))?;
    let blocks: HashMap<String, Value> = fixture["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["cid"].as_str().unwrap().to_string(),
                entry["operation"].clone(),
            )
        })
        .collect();
    let app = Router::new().route(
        "/block/get",
        post(move |Query(query): Query<HashMap<String, String>>| {
            let body = blocks
                .get(query.get("arg").unwrap())
                .expect("fixture CID")
                .clone();
            async move { Json(body) }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let env = [(
        "ARCHON_IPFS_URL",
        format!("http://{}", listener.local_addr()?),
    )];
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let dir = tempfile::tempdir()?;
    let service = respawn_service("json", dir.path(), &env).await?;
    for entry in fixture["entries"].as_array().unwrap() {
        let height = entry["height"].as_u64().unwrap();
        let operation = &entry["operation"];
        if height == 20 || height == 90 {
            post_json(&service, "batch/import", json!([{
                "operation": operation, "registry": "hyperswarm", "ordinal": [0], "time": operation["proof"]["created"]
            }])).await?;
        } else {
            post_json(&service, "batch/import/cids", json!({
                "cids": [entry["cid"]], "metadata": {
                    "registry": "BTC:signet", "time": operation["proof"]["created"], "ordinal": [height, 0],
                    "registration": {"height": height, "index": 0, "txid": "tx", "batch": "batch"}
                }
            })).await?;
        }
        post_json(&service, "events/process", Value::Null).await?;
    }
    let path = format!("did/{}", fixture["targetDid"].as_str().unwrap());
    assert_eq!(
        get_json(&service, &path).await?["didDocumentData"]["message"],
        "original"
    );
    let stale: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("archon.json"))?)?;
    post_json(
        &service,
        "block/BTC:signet/rewind",
        json!({"fromHeight": 100}),
    )
    .await?;
    assert_eq!(
        get_json(&service, &path).await?["didDocumentData"]["message"],
        "updated"
    );
    drop(service);
    // Model a crash after journal persistence but before projection publication.
    let file = dir.path().join("archon.json");
    let mut saved: Value = serde_json::from_str(&std::fs::read_to_string(&file)?)?;
    saved["dids"] = stale["dids"].clone();
    std::fs::write(&file, serde_json::to_vec(&saved)?)?;
    let service = respawn_service("json", dir.path(), &env).await?;
    assert_eq!(
        get_json(&service, &path).await?["didDocumentData"]["message"],
        "updated"
    );
    server.abort();
    Ok(())
}
