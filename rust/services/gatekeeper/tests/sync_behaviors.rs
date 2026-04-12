mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{
    create_agent_operation, create_asset_operation, create_update_operation, make_event,
    spawn_json,
};

async fn admin_post(service: &common::TestService, path: &str, payload: Value) -> Result<Value> {
    let response = service
        .admin(service.client.post(format!("{}/{}", service.base_url, path)))
        .json(&payload)
        .send()
        .await?;
    assert!(response.status().is_success(), "{path} should succeed");
    Ok(response.json::<Value>().await?)
}

async fn admin_get(service: &common::TestService, path: &str) -> Result<Value> {
    let response = service
        .admin(service.client.get(format!("{}/{}", service.base_url, path)))
        .send()
        .await?;
    assert!(response.status().is_success(), "{path} should succeed");
    Ok(response.json::<Value>().await?)
}

async fn create_did(service: &common::TestService, operation: Value) -> Result<String> {
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&operation)
        .send()
        .await?;
    assert!(response.status().is_success(), "create DID should succeed");
    Ok(response.json::<Value>().await?.as_str().unwrap().to_string())
}

async fn resolve_did(service: &common::TestService, did: &str) -> Result<Value> {
    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, did))
        .send()
        .await?;
    assert!(response.status().is_success(), "resolve DID should succeed");
    Ok(response.json::<Value>().await?)
}

async fn export_did(service: &common::TestService, did: &str) -> Result<Vec<Value>> {
    let batch = admin_post(service, "dids/export", json!({ "dids": [did] })).await?;
    Ok(batch[0].as_array().unwrap().to_vec())
}

async fn export_all_events(service: &common::TestService) -> Result<Vec<Value>> {
    let batch = admin_post(service, "dids/export", json!({})).await?;
    Ok(batch
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_array)
        .flat_map(|events| events.iter().cloned())
        .collect())
}

#[tokio::test]
async fn sync_import_reports_processed_when_event_was_seen_before() -> Result<()> {
    let service = spawn_json().await?;
    let agent_op = create_agent_operation(7, "2026-04-11T12:00:00Z", "local");
    let did = create_did(&service, agent_op).await?;
    let events = export_did(&service, &did).await?;

    let first = admin_post(&service, "batch/import", json!(events.clone())).await?;
    assert_eq!(first["queued"], 1);
    assert_eq!(first["processed"], 0);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 0);
    assert_eq!(processed["merged"], 1);

    let second = admin_post(&service, "batch/import", json!(events)).await?;
    assert_eq!(second["queued"], 0);
    assert_eq!(second["processed"], 1);

    Ok(())
}

#[tokio::test]
async fn sync_processing_handles_updates_imported_before_creates() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    let mut agent_doc = resolve_did(&service, &agent_did).await?;
    agent_doc["didDocumentData"] = json!({ "version": 2 });
    let agent_update = create_update_operation(
        7,
        &agent_did,
        agent_doc["didDocumentMetadata"]["versionId"].as_str(),
        "2026-04-11T12:01:00Z",
        agent_doc.clone(),
    );
    let updated = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&agent_update)
        .send()
        .await?;
    assert!(updated.status().is_success(), "agent update should succeed");

    let asset_did = create_did(
        &service,
        create_asset_operation(
            7,
            &agent_did,
            "2026-04-11T12:02:00Z",
            "local",
            json!({ "asset": 1 }),
        ),
    )
    .await?;
    let mut asset_doc = resolve_did(&service, &asset_did).await?;
    asset_doc["didDocumentData"] = json!({ "asset": 2 });
    let asset_update = create_update_operation(
        7,
        &asset_did,
        asset_doc["didDocumentMetadata"]["versionId"].as_str(),
        "2026-04-11T12:03:00Z",
        asset_doc.clone(),
    );
    let updated = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&asset_update)
        .send()
        .await?;
    assert!(updated.status().is_success(), "asset update should succeed");

    let mut events = export_all_events(&service).await?;
    events.reverse();

    let reset = admin_get(&service, "db/reset").await?;
    assert_eq!(reset, Value::Bool(true));

    let imported = admin_post(&service, "batch/import", json!(events)).await?;
    assert_eq!(imported["queued"], 4);
    assert_eq!(imported["rejected"], 0);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 4);
    assert_eq!(processed["rejected"], 0);
    assert_eq!(processed["pending"], 0);

    let agent_doc = resolve_did(&service, &agent_did).await?;
    let asset_doc = resolve_did(&service, &asset_did).await?;
    assert_eq!(agent_doc["didDocumentMetadata"]["versionSequence"], "2");
    assert_eq!(asset_doc["didDocumentMetadata"]["versionSequence"], "2");

    Ok(())
}

#[tokio::test]
async fn sync_processing_defers_signed_updates_with_unknown_previd() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    let asset_did = create_did(
        &service,
        create_asset_operation(
            7,
            &agent_did,
            "2026-04-11T12:01:00Z",
            "local",
            json!({ "asset": 1 }),
        ),
    )
    .await?;

    let mut create_events = export_all_events(&service).await?;
    create_events.sort_by(|a, b| a["time"].as_str().cmp(&b["time"].as_str()));

    let mut agent_doc = resolve_did(&service, &agent_did).await?;
    agent_doc["didDocumentData"] = json!({ "version": 2 });
    let mut asset_doc = resolve_did(&service, &asset_did).await?;
    asset_doc["didDocumentData"] = json!({ "asset": 2 });

    let batch = vec![
        create_events[0].clone(),
        create_events[1].clone(),
        make_event(
            "local",
            "2026-04-11T12:02:00Z",
            &[2],
            create_update_operation(
                7,
                &agent_did,
                Some("mock-previd"),
                "2026-04-11T12:02:00Z",
                agent_doc,
            ),
        ),
        make_event(
            "local",
            "2026-04-11T12:03:00Z",
            &[3],
            create_update_operation(
                7,
                &asset_did,
                Some("mock-previd"),
                "2026-04-11T12:03:00Z",
                asset_doc,
            ),
        ),
    ];

    admin_get(&service, "db/reset").await?;
    let imported = admin_post(&service, "batch/import", json!(batch)).await?;
    assert_eq!(imported["queued"], 4);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 2);
    assert_eq!(processed["rejected"], 0);
    assert_eq!(processed["pending"], 2);

    let status = admin_get(&service, "status").await?;
    assert_eq!(status["dids"]["eventsQueue"].as_array().unwrap().len(), 2);

    Ok(())
}

#[tokio::test]
async fn sync_processing_rejects_signed_update_without_previd() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    let create_events = export_did(&service, &agent_did).await?;
    let mut agent_doc = resolve_did(&service, &agent_did).await?;
    agent_doc["didDocumentData"] = json!({ "version": 2 });

    admin_get(&service, "db/reset").await?;
    let batch = vec![
        create_events[0].clone(),
        make_event(
            "local",
            "2026-04-11T12:01:00Z",
            &[1],
            create_update_operation(7, &agent_did, None, "2026-04-11T12:01:00Z", agent_doc),
        ),
    ];

    admin_post(&service, "batch/import", json!(batch)).await?;
    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 1);
    assert_eq!(processed["rejected"], 1);
    assert_eq!(processed["pending"], 0);

    Ok(())
}

#[tokio::test]
async fn sync_processing_rejects_duplicate_previd_branches() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    let agent_doc = resolve_did(&service, &agent_did).await?;
    let previd = agent_doc["didDocumentMetadata"]["versionId"]
        .as_str()
        .unwrap()
        .to_string();

    let mut doc1 = agent_doc.clone();
    doc1["didDocumentData"] = json!({ "branch": 1 });
    let mut doc2 = agent_doc.clone();
    doc2["didDocumentData"] = json!({ "branch": 2 });
    let mut doc3 = agent_doc.clone();
    doc3["didDocumentData"] = json!({ "branch": 3 });

    let batch = vec![
        make_event(
            "local",
            "2026-04-11T12:01:00Z",
            &[0],
            create_update_operation(7, &agent_did, Some(&previd), "2026-04-11T12:01:00Z", doc1),
        ),
        make_event(
            "local",
            "2026-04-11T12:02:00Z",
            &[1],
            create_update_operation(7, &agent_did, Some(&previd), "2026-04-11T12:02:00Z", doc2),
        ),
        make_event(
            "local",
            "2026-04-11T12:03:00Z",
            &[2],
            create_update_operation(7, &agent_did, Some(&previd), "2026-04-11T12:03:00Z", doc3),
        ),
    ];

    let imported = admin_post(&service, "batch/import", json!(batch)).await?;
    assert_eq!(imported["queued"], 3);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 1);
    assert_eq!(processed["rejected"], 2);
    assert_eq!(processed["pending"], 0);

    let resolved = resolve_did(&service, &agent_did).await?;
    assert_eq!(resolved["didDocumentMetadata"]["versionSequence"], "2");

    Ok(())
}

#[tokio::test]
async fn sync_import_from_native_registry_confirms_latest_version() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "hyperswarm"),
    )
    .await?;
    let mut agent_doc = resolve_did(&service, &agent_did).await?;

    agent_doc["didDocumentData"] = json!({ "version": 2 });
    let previd = agent_doc["didDocumentMetadata"]["versionId"]
        .as_str()
        .map(ToString::to_string);
    let update = create_update_operation(
        7,
        &agent_did,
        previd.as_deref(),
        "2026-04-11T12:01:00Z",
        agent_doc,
    );
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&update)
        .send()
        .await?;
    assert!(response.status().is_success(), "local update should succeed");
    let local_latest = resolve_did(&service, &agent_did).await?;
    assert_eq!(local_latest["didDocumentMetadata"]["versionSequence"], "2");
    assert_eq!(local_latest["didDocumentMetadata"]["confirmed"], false);

    let mut events = export_did(&service, &agent_did).await?;
    for event in &mut events {
        event["registry"] = Value::String("hyperswarm".to_string());
    }

    let imported = admin_post(&service, "batch/import", json!(events)).await?;
    assert_eq!(imported["queued"], 2);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 2);
    assert_eq!(processed["pending"], 0);

    let resolved = resolve_did(&service, &agent_did).await?;
    assert_eq!(resolved["didDocumentMetadata"]["versionSequence"], "2");
    assert_eq!(resolved["didDocumentMetadata"]["confirmed"], true);

    Ok(())
}

#[tokio::test]
async fn sync_import_batch_without_event_dids_processes_cleanly() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "hyperswarm"),
    )
    .await?;
    let mut agent_doc = resolve_did(&service, &agent_did).await?;
    agent_doc["didDocumentData"] = json!({ "version": 2 });
    let previd = agent_doc["didDocumentMetadata"]["versionId"]
        .as_str()
        .map(ToString::to_string);
    let update = create_update_operation(
        7,
        &agent_did,
        previd.as_deref(),
        "2026-04-11T12:01:00Z",
        agent_doc,
    );
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&update)
        .send()
        .await?;
    assert!(response.status().is_success(), "local update should succeed");

    let asset_did = create_did(
        &service,
        create_asset_operation(
            7,
            &agent_did,
            "2026-04-11T12:02:00Z",
            "hyperswarm",
            json!({ "asset": 1 }),
        ),
    )
    .await?;

    let mut batch = export_all_events(&service).await?;
    batch.sort_by(|a, b| a["time"].as_str().cmp(&b["time"].as_str()));
    for event in &mut batch {
        event.as_object_mut().unwrap().remove("did");
        event["registry"] = Value::String("hyperswarm".to_string());
    }

    admin_get(&service, "db/reset").await?;
    let imported = admin_post(&service, "batch/import", json!(batch)).await?;
    assert_eq!(imported["queued"], 3);
    assert_eq!(imported["rejected"], 0);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 3);
    assert_eq!(processed["rejected"], 0);
    assert_eq!(processed["pending"], 0);

    let agent_doc = resolve_did(&service, &agent_did).await?;
    let asset_doc = resolve_did(&service, &asset_did).await?;
    assert_eq!(agent_doc["didDocumentMetadata"]["versionSequence"], "2");
    assert_eq!(agent_doc["didDocumentMetadata"]["confirmed"], true);
    assert_eq!(asset_doc["didDocumentMetadata"]["versionSequence"], "1");
    assert_eq!(asset_doc["didDocumentMetadata"]["confirmed"], true);

    Ok(())
}

#[tokio::test]
async fn sync_processing_handles_large_linear_update_chain_without_pending() -> Result<()> {
    let service = spawn_json().await?;

    let agent_did = create_did(
        &service,
        create_agent_operation(7, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;

    let mut current_doc = resolve_did(&service, &agent_did).await?;
    for i in 0..10 {
        current_doc["didDocumentData"] = json!({ "version": i + 2 });
        let previd = current_doc["didDocumentMetadata"]["versionId"]
            .as_str()
            .map(ToString::to_string);
        let created = format!("2026-04-11T12:{:02}:00Z", i + 1);
        let update = create_update_operation(
            7,
            &agent_did,
            previd.as_deref(),
            &created,
            current_doc.clone(),
        );
        let response = service
            .client
            .post(format!("{}/did", service.base_url))
            .json(&update)
            .send()
            .await?;
        assert!(response.status().is_success(), "chain update {i} should succeed");
        current_doc = resolve_did(&service, &agent_did).await?;
    }

    let events = export_did(&service, &agent_did).await?;
    admin_get(&service, "db/reset").await?;

    let imported = admin_post(&service, "batch/import", json!(events)).await?;
    assert_eq!(imported["queued"], 11);
    assert_eq!(imported["rejected"], 0);

    let processed = admin_post(&service, "events/process", json!(null)).await?;
    assert_eq!(processed["added"], 11);
    assert_eq!(processed["rejected"], 0);
    assert_eq!(processed["pending"], 0);

    let resolved = resolve_did(&service, &agent_did).await?;
    assert_eq!(resolved["didDocumentMetadata"]["versionSequence"], "11");

    Ok(())
}
