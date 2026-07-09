mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{create_agent_operation, create_update_operation, deterministic_vectors, spawn_json, ADMIN_KEY};

#[tokio::test]
async fn http_contract_covers_ready_version_status_admin_and_metrics() -> Result<()> {
    let vectors = deterministic_vectors();
    let local_agent = vectors["localAgent"]["operation"].clone();
    let did = vectors["localAgent"]["did"].as_str().unwrap();

    let service = spawn_json().await?;

    let response = service
        .client
        .get(format!("{}/ready", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(response.json::<Value>().await?, Value::Bool(true));

    let response = service
        .client
        .get(format!("{}/version", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let version = response.json::<Value>().await?;
    assert!(version["version"].is_string());
    assert!(version["commit"].is_string());

    let response = service
        .client
        .get(format!("{}/registries", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let registries = response.json::<Value>().await?;
    assert!(registries
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "local"));

    let response = service
        .client
        .post(format!("{}/dids", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    assert!(response.json::<Value>().await?.as_array().is_some());

    let response = service
        .client
        .get(format!("{}/api/nope", service.root_url))
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        response.json::<Value>().await?["message"],
        "Endpoint not found"
    );

    let response = service
        .client
        .get(format!("{}/db/verify", service.base_url))
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert_eq!(
        response.json::<Value>().await?["error"],
        "Unauthorized — valid admin API key required"
    );

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&local_agent)
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .client
        .get(format!("{}/did/{}?confirm=true", service.base_url, did))
        .send()
        .await?;
    assert!(response.status().is_success());
    let doc = response.json::<Value>().await?;
    assert_eq!(doc["didDocument"]["id"], did);
    assert_eq!(doc["didDocumentMetadata"]["confirmed"], true);

    let response = service
        .admin(
            service
                .client
                .get(format!("{}/queue/hyperswarm", service.base_url)),
        )
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .client
        .get(format!("{}/metrics", service.root_url))
        .header("x-archon-admin-key", ADMIN_KEY)
        .send()
        .await?;
    assert!(response.status().is_success());
    let metrics = response.text().await?;
    assert!(metrics.contains("route=\"/api/v1/did/:did\""));
    assert!(metrics.contains("route=\"/api/v1/queue/:registry\""));

    Ok(())
}

#[tokio::test]
async fn universal_resolver_surface_returns_fixture_stable_did_resolution_result() -> Result<()> {
    let service = spawn_json().await?;
    let create = create_agent_operation(21, "2026-04-11T12:03:00.495Z", "local");

    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&create)
        .send()
        .await?;
    assert!(response.status().is_success());
    let did = response
        .json::<Value>()
        .await?
        .as_str()
        .unwrap()
        .to_string();

    let response = service
        .client
        .get(format!("{}/did/{did}", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let mut latest_doc = response.json::<Value>().await?;
    let version_id = latest_doc["didDocumentMetadata"]["versionId"]
        .as_str()
        .unwrap()
        .to_string();
    latest_doc["didDocumentData"] = json!({ "hello": "world" });
    let update = create_update_operation(
        21,
        &did,
        Some(&version_id),
        "2026-05-28T16:47:27.000Z",
        latest_doc,
    );
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&update)
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .client
        .get(format!("{}/1.0/identifiers/{did}", service.root_url))
        .header("accept", "application/did+ld+json")
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/did+ld+json")
    );
    assert_eq!(
        response
            .headers()
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Accept")
    );
    let doc = response.json::<Value>().await?;
    let object = doc.as_object().unwrap();
    assert_eq!(object.len(), 3);
    assert_eq!(doc["didDocument"]["id"], did);
    assert_eq!(
        doc["didResolutionMetadata"]["contentType"],
        "application/did+ld+json"
    );
    assert!(doc["didResolutionMetadata"].get("retrieved").is_none());
    assert_eq!(doc["didDocumentMetadata"]["confirmed"], true);
    assert_eq!(doc["didDocumentMetadata"]["created"], "2026-04-11T12:03:00Z");
    assert_eq!(doc["didDocumentMetadata"]["updated"], "2026-05-28T16:47:27Z");
    assert!(doc.get("didDocumentData").is_none());
    assert!(doc.get("didDocumentRegistration").is_none());

    let response = service
        .client
        .get(format!(
            "{}/1.0/identifiers/{did}?versionSequence=1",
            service.root_url
        ))
        .send()
        .await?;
    assert!(response.status().is_success());
    let historical = response.json::<Value>().await?;
    assert_eq!(
        historical["didDocumentMetadata"]["created"],
        "2026-04-11T12:03:00Z"
    );
    assert!(historical["didDocumentMetadata"].get("updated").is_none());

    let response = service
        .client
        .get(format!("{}/1.0/identifiers/{did}", service.root_url))
        .header("accept", "Application/DID+JSON;Q=1, application/did+ld+json;q=0.5")
        .send()
        .await?;
    assert!(response.status().is_success());
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("application/did+json")
    );
    assert_eq!(
        response
            .headers()
            .get("vary")
            .and_then(|value| value.to_str().ok()),
        Some("Accept")
    );
    let doc = response.json::<Value>().await?;
    assert_eq!(
        doc["didResolutionMetadata"]["contentType"],
        "application/did+json"
    );

    Ok(())
}

#[tokio::test]
async fn http_contract_matches_resolution_error_and_supported_registry_semantics() -> Result<()> {
    let service = spawn_json().await?;

    let response = service
        .client
        .get(format!("{}/did/not-a-did", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let invalid = response.json::<Value>().await?;
    assert_eq!(invalid["didResolutionMetadata"]["error"], "invalidDid");

    let missing_did = "did:cid:bagaaieramissing";
    let response = service
        .client
        .get(format!("{}/did/{missing_did}", service.base_url))
        .send()
        .await?;
    assert!(response.status().is_success());
    let missing = response.json::<Value>().await?;
    assert_eq!(missing["didResolutionMetadata"]["error"], "notFound");

    let unsupported_create = create_agent_operation(11, "2026-04-11T12:00:00Z", "BTC:signet");
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&unsupported_create)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        response
            .text()
            .await?
            .contains("Invalid operation: registry BTC:signet not supported")
    );

    let response = service
        .admin(service.client.get(format!("{}/queue/pin", service.base_url)))
        .send()
        .await?;
    assert!(response.status().is_success());

    let pin_create = create_agent_operation(12, "2026-04-11T12:00:30Z", "pin");
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&pin_create)
        .send()
        .await?;
    assert!(response.status().is_success());

    let response = service
        .admin(service.client.get(format!("{}/queue/pin", service.base_url)))
        .send()
        .await?;
    assert!(response.status().is_success());
    let queue = response.json::<Value>().await?;
    assert_eq!(queue.as_array().unwrap(), &[pin_create]);

    let create = create_agent_operation(7, "2026-04-11T12:01:00Z", "local");
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&create)
        .send()
        .await?;
    assert!(response.status().is_success());
    let did = response.json::<Value>().await?.as_str().unwrap().to_string();

    let response = service
        .client
        .get(format!("{}/did/{}", service.base_url, did))
        .send()
        .await?;
    let doc = response.json::<Value>().await?;
    let version_id = doc["didDocumentMetadata"]["versionId"]
        .as_str()
        .unwrap()
        .to_string();
    let mut next_doc = doc.clone();
    next_doc["didDocumentRegistration"] = json!({
        "version": 1,
        "type": "agent",
        "registry": "BTC:signet"
    });
    let unsupported_update = create_update_operation(
        7,
        &did,
        Some(&version_id),
        "2026-04-11T12:02:00Z",
        next_doc,
    );
    let response = service
        .client
        .post(format!("{}/did", service.base_url))
        .json(&unsupported_update)
        .send()
        .await?;
    assert_eq!(response.status(), reqwest::StatusCode::INTERNAL_SERVER_ERROR);
    assert!(
        response
            .text()
            .await?
            .contains("Invalid operation: registry BTC:signet not supported")
    );

    Ok(())
}
