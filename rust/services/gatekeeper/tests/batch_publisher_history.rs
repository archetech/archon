mod common;

use anyhow::Result;
use axum::{extract::Query, routing::post, Json, Router};
use cid::Cid;
use common::{respawn_service, TestService};
use multihash_codetable::{Code, MultihashDigest};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

fn content_cid(value: &Value) -> String {
    Cid::new_v1(
        0x0200,
        Code::Sha2_256.digest(&serde_json_canonicalizer::to_vec(value).unwrap()),
    )
    .to_string()
}

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
    blocks.insert(
        fixture["invalidCid"].as_str().unwrap().into(),
        fixture["invalidOperation"].clone(),
    );
    blocks.insert(
        fixture["invalidBatchDid"]
            .as_str()
            .unwrap()
            .rsplit(':')
            .next()
            .unwrap()
            .into(),
        fixture["invalidBatch"].clone(),
    );
    let mut malformed = fixture["batch"].clone();
    malformed.as_object_mut().unwrap().remove("proof");
    let malformed_cid = content_cid(&malformed);
    blocks.insert(malformed_cid.clone(), malformed);
    let rotation_cid = content_cid(&fixture["rotation"]);
    blocks.insert(rotation_cid.clone(), fixture["rotation"].clone());
    let mut bad_agent = fixture["publisher"].clone();
    bad_agent["publicJwk"] = Value::Null;
    let bad_agent_cid = content_cid(&bad_agent);
    blocks.insert(bad_agent_cid.clone(), bad_agent);
    blocks.insert(content_cid(&fixture["owner"]), fixture["owner"].clone());
    let wrong_cid = content_cid(&fixture["publisher"]);
    blocks.insert(wrong_cid.clone(), fixture["batch"].clone()); // Deliberately incorrect IPFS response.
                                                                // Isolated CID-addressed IPFS responses reached through the real HTTP routes.
    let blocks = Arc::new(Mutex::new(blocks));
    let served_blocks = blocks.clone();
    let app = Router::new().route(
        "/block/get",
        post(move |Query(query): Query<HashMap<String, String>>| {
            let body = served_blocks
                .lock().unwrap()
                .get(query.get("arg").unwrap()).cloned();
            async move {
                match body {
                    Some(body) => (axum::http::StatusCode::OK, Json(body)),
                    None => (axum::http::StatusCode::NOT_FOUND, Json(Value::Null)),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let env = [(
        "ARCHON_IPFS_URL",
        format!("http://{}", listener.local_addr()?),
    )];
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let batch_document = json!({
        "didDocument": {"@context": ["https://www.w3.org/ns/did/v1"],
            "id": batch_did, "controller": fixture["batch"]["controller"]},
        "didDocumentMetadata": {"created": fixture["batch"]["created"]},
        "didDocumentData": fixture["batch"]["data"],
        "didDocumentRegistration": fixture["batch"]["registration"]
    });
    let mut results = Vec::new();
    for rotation_first in [false, true] {
        let dir = tempfile::tempdir()?;
        let mut service = respawn_service("json", dir.path(), &env).await?;
        // Genesis retrieval needs neither an accepted batch nor its publisher.
        assert_eq!(
            get_json(&service, &format!("did/{batch_did}/genesis")).await?,
            batch_document
        );
        assert_eq!(
            get_json(&service, &format!("did/{batch_did}")).await?["didResolutionMetadata"]
                ["error"],
            "notFound"
        );
        for cid in [
            &malformed_cid,
            &bad_agent_cid,
            &rotation_cid,
            &wrong_cid,
            &content_cid(&json!({"missing": true})),
        ] {
            let response = service
                .client
                .get(format!("{}/did/did:cid:{cid}/genesis", service.base_url))
                .send()
                .await?;
            assert_eq!(
                response.status(),
                reqwest::StatusCode::INTERNAL_SERVER_ERROR
            );
        }
        assert_eq!(
            get_json(
                &service,
                &format!("did/did:cid:{}/genesis", content_cid(&fixture["owner"]))
            )
            .await?["didDocument"]["verificationMethod"][0]["publicKeyJwk"],
            fixture["owner"]["publicJwk"]
        );
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
        let invalid_batch_did = fixture["invalidBatchDid"].as_str().unwrap();
        let invalid_batch = get_json(&service, &format!("did/{invalid_batch_did}/genesis")).await?;
        let mut invalid_metadata = fixture["metadata"].clone();
        invalid_metadata["registration"]["batch"] = json!(invalid_batch_did);
        post_json(
            &service,
            "batch/import/cids",
            json!({"cids": invalid_batch["didDocumentData"]["batch"]["ops"], "metadata": invalid_metadata}),
        )
        .await?;
        let processed = post_json(&service, "events/process", Value::Null).await?;
        assert_eq!(processed["rejected"], 1);
        if rotation_first {
            ingest(&service, vec![fixture["rotation"].clone()]).await?;
        }
        let genesis = get_json(&service, &format!("did/{batch_did}/genesis")).await?;
        assert_eq!(genesis, batch_document);
        post_json(
            &service,
            "batch/import/cids",
            json!({
                "cids": genesis["didDocumentData"]["batch"]["ops"], "metadata": fixture["metadata"]
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
                get_json(current, &format!("did/{batch_did}/genesis")).await?,
                batch_document
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
    // A mismatched upstream response reaches the cache via ordinary CID ingress.
    // Retrieval must retry the upstream after that content is corrected.
    let retry_dir = tempfile::tempdir()?;
    let retry_service = respawn_service("json", retry_dir.path(), &env).await?;
    blocks.lock().unwrap()
        .insert(batch_cid.clone(), fixture["publisher"].clone());
    post_json(
        &retry_service,
        "batch/import/cids",
        json!({"cids": [batch_cid], "metadata": fixture["metadata"]}),
    )
    .await?;
    let response = retry_service
        .client
        .get(format!("{}/did/{batch_did}/genesis", retry_service.base_url))
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    blocks.lock().unwrap()
        .insert(batch_cid.clone(), fixture["batch"].clone());
    assert_eq!(
        get_json(&retry_service, &format!("did/{batch_did}/genesis")).await?,
        batch_document
    );
    assert_eq!(
        get_json(&retry_service, &format!("did/{batch_did}")).await?["didResolutionMetadata"]["error"],
        "notFound"
    );
    // Populate only the content cache through ordinary CID ingress, then make
    // IPFS unavailable. Retrieval still does not require accepted DID history.
    let dir = tempfile::tempdir()?;
    let service = respawn_service("json", dir.path(), &env).await?;
    post_json(
        &service,
        "batch/import/cids",
        json!({"cids": [batch_cid], "metadata": fixture["metadata"]}),
    )
    .await?;
    server.abort();
    assert_eq!(
        get_json(&service, &format!("did/{batch_did}/genesis")).await?,
        batch_document
    );
    assert_eq!(
        get_json(&service, &format!("did/{batch_did}")).await?["didResolutionMetadata"]["error"],
        "notFound"
    );
    Ok(())
}
