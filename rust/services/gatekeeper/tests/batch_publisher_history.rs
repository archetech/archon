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

async fn ingest(service: &TestService, operations: Vec<Value>) -> Result<()> {
    let events: Vec<Value> = operations.into_iter().map(|op| json!({
        "registry": "hyperswarm", "time": op["proof"]["created"], "ordinal": [0], "operation": op
    })).collect();
    post_json(service, "batch/import", json!(events)).await?;
    post_json(service, "events/process", Value::Null).await?;
    Ok(())
}

#[tokio::test]
async fn batch_content_survives_publisher_invalidation_and_restart() -> Result<()> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../tests/fixtures/batch-publisher-history.json"
    ))?;
    let batch_did = fixture["batchDid"].as_str().unwrap();
    let batch_cid = batch_did.strip_prefix("did:cid:").unwrap().to_string();
    let mut blocks = HashMap::from([(batch_cid.clone(), fixture["batch"].clone())]);
    for entry in fixture["successors"].as_array().unwrap() {
        blocks.insert(
            entry["cid"].as_str().unwrap().to_string(),
            entry["op"].clone(),
        );
    }
    // Isolated CID-addressed IPFS responses reached through the real HTTP routes.
    let app = Router::new().route(
        "/block/get",
        post(move |Query(query): Query<HashMap<String, String>>| {
            let body = blocks
                .get(query.get("arg").unwrap())
                .expect("known fixture CID")
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
    let mut results = Vec::new();
    for rotation_first in [false, true] {
        let dir = tempfile::tempdir()?;
        let mut service = respawn_service("json", dir.path(), &env).await?;
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
        operations.push(fixture["batch"].clone());
        ingest(&service, operations).await?;
        if rotation_first {
            ingest(&service, vec![fixture["rotation"].clone()]).await?;
        }
        let genesis = get_json(&service, &format!("ipfs/json/{batch_cid}")).await?;
        assert_eq!(genesis, fixture["batch"]);
        post_json(
            &service,
            "batch/import/cids",
            json!({
                "cids": genesis["data"]["batch"]["ops"], "metadata": fixture["metadata"]
            }),
        )
        .await?;
        post_json(&service, "events/process", Value::Null).await?;
        if !rotation_first {
            ingest(&service, vec![fixture["rotation"].clone()]).await?;
        }
        for restart in [false, true] {
            if restart {
                drop(service);
                service = respawn_service("json", dir.path(), &env).await?;
            }
            let current = &service;
            let invalid = get_json(current, &format!("did/{batch_did}?versionSequence=1")).await?;
            assert_eq!(invalid["didResolutionMetadata"]["error"], "notFound");
            assert_eq!(
                get_json(current, &format!("ipfs/json/{batch_cid}")).await?,
                fixture["batch"]
            );
            let mut resolved = get_json(
                current,
                &format!("did/{}", fixture["targetDid"].as_str().unwrap()),
            )
            .await?;
            assert_eq!(
                resolved["didDocumentData"],
                fixture["successors"][1]["op"]["doc"]["didDocumentData"]
            );
            assert_eq!(resolved["didDocumentMetadata"]["confirmed"], true);
            resolved["didResolutionMetadata"]
                .as_object_mut()
                .unwrap()
                .remove("retrieved");
            results.push(resolved);
        }
    }
    for result in &results {
        assert_eq!(result, &results[0]);
    }
    server.abort();
    Ok(())
}
