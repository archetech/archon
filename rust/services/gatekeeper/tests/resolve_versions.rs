mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{
    create_agent_operation, create_update_operation, path_buf, respawn_service, TestService,
};

// A reader that needs every version of a DID had to export the node's events
// and apply their operations itself, repeating what resolution does.
// `POST /dids/versions` gives it the versions as this node resolves them.

async fn create_did(service: &TestService, operation: Value) -> Result<String> {
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&operation)
        .send()
        .await?;
    assert!(response.status().is_success(), "create DID should succeed");
    Ok(response
        .json::<Value>()
        .await?
        .as_str()
        .unwrap()
        .to_string())
}

async fn update_did(
    service: &TestService,
    seed: u8,
    did: &str,
    created: &str,
    data: Value,
) -> Result<()> {
    let mut doc = service
        .client
        .get(format!("{}/did/{did}", service.base_url))
        .send()
        .await?
        .json::<Value>()
        .await?;
    doc["didDocumentData"] = data;
    let previd = doc["didDocumentMetadata"]["versionId"]
        .as_str()
        .map(str::to_string);
    let update = create_update_operation(seed, did, previd.as_deref(), created, doc);
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&update)
        .send()
        .await?;
    assert!(response.status().is_success(), "update should succeed");
    Ok(())
}

async fn versions(service: &TestService, body: Value) -> Result<(u16, Value)> {
    let response = service
        .client
        .post(format!("{}/dids/versions", service.base_url))
        .json(&body)
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json::<Value>().await?))
}

// What /dids/versions must return for a DID: each versionSequence, resolved,
// without the resolution metadata.
async fn expected(service: &TestService, did: &str) -> Result<Vec<Value>> {
    let mut all = Vec::new();
    for sequence in 1.. {
        let mut doc = service
            .client
            .get(format!(
                "{}/did/{did}?versionSequence={sequence}",
                service.base_url
            ))
            .send()
            .await?
            .json::<Value>()
            .await?;
        if doc.pointer("/didResolutionMetadata/error").is_some() {
            break;
        }
        doc.as_object_mut().unwrap().remove("didResolutionMetadata");
        all.push(doc);
    }
    Ok(all)
}

#[tokio::test]
async fn versions_are_each_sequence_as_resolution_returns_it() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let service = respawn_service("json", path_buf(temp_dir.path()), &[]).await?;

    let first = create_did(
        &service,
        create_agent_operation(41, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    update_did(
        &service,
        41,
        &first,
        "2026-04-11T12:03:00Z",
        json!({ "n": 1 }),
    )
    .await?;
    update_did(
        &service,
        41,
        &first,
        "2026-04-11T12:05:00Z",
        json!({ "n": 2 }),
    )
    .await?;
    let second = create_did(
        &service,
        create_agent_operation(42, "2026-04-11T12:01:00Z", "hyperswarm"),
    )
    .await?;

    // Aligned with the request; a DID the node cannot resolve has no versions.
    let (status, body) = versions(
        &service,
        json!({ "dids": ["did:cid:mock", first, "not a did", second, first] }),
    )
    .await?;
    assert_eq!(status, 200);
    let listed = body.as_array().unwrap();
    assert_eq!(listed.len(), 5);
    assert_eq!(listed[0], json!([]));
    assert_eq!(listed[2], json!([]));
    assert_eq!(listed[1], json!(expected(&service, &first).await?));
    assert_eq!(listed[3], json!(expected(&service, &second).await?));
    assert_eq!(listed[4], listed[1]);

    let of_first = listed[1].as_array().unwrap();
    assert_eq!(of_first.len(), 3);
    let sequences: Vec<&str> = of_first
        .iter()
        .map(|version| version["didDocumentMetadata"]["versionSequence"].as_str().unwrap())
        .collect();
    assert_eq!(sequences, vec!["1", "2", "3"]);
    assert_eq!(of_first[1]["didDocumentData"], json!({ "n": 1 }));
    assert_eq!(of_first[2]["didDocumentData"], json!({ "n": 2 }));
    assert!(of_first
        .iter()
        .all(|version| version.get("didResolutionMetadata").is_none()));
    assert_eq!(listed[3].as_array().unwrap().len(), 1);

    // A stored DID's bare identifier, and that identifier under another prefix,
    // are not the DID and have no versions.
    let suffix = first.rsplit(':').next().unwrap().to_string();
    let (status, body) = versions(
        &service,
        json!({ "dids": [suffix, format!("not-a-did:{suffix}"), first] }),
    )
    .await?;
    assert_eq!(status, 200);
    assert_eq!(body[0], json!([]));
    assert_eq!(body[1], json!([]));
    assert_eq!(body[2].as_array().unwrap().len(), 3);

    assert_eq!(versions(&service, json!({ "dids": [] })).await?, (200, json!([])));
    Ok(())
}

#[tokio::test]
async fn versions_reject_a_body_that_is_not_a_list_of_dids() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let service = respawn_service("json", path_buf(temp_dir.path()), &[]).await?;
    for body in [
        json!({}),
        json!({ "dids": "did:cid:mock" }),
        json!({ "dids": [1] }),
        json!({ "dids": ["did:cid:mock", null] }),
    ] {
        assert_eq!(
            versions(&service, body.clone()).await?,
            (400, json!({ "error": "Invalid parameter: dids" })),
            "{body}"
        );
    }
    Ok(())
}
