mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{
    create_agent_operation, create_update_operation, path_buf, respawn_service, TestService,
};

// The events feed is ordered by event time, which follows a block or a signer
// and not arrival, so a reader could not ask it what was new (#1689). The
// change feed numbers each change to an accepted history as this node makes it.

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

async fn admin_post(service: &TestService, path: &str, payload: Value) -> Result<Value> {
    let response = service
        .admin(service.client.post(format!("{}/{path}", service.base_url)))
        .json(&payload)
        .send()
        .await?;
    assert!(response.status().is_success(), "{path} should succeed");
    Ok(response.json::<Value>().await?)
}

async fn changes(service: &TestService, query: &str) -> Result<(u16, Value)> {
    let response = service
        .client
        .get(format!("{}/changes?{query}", service.base_url))
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json::<Value>().await?))
}

// Follows the feed from a sequence to its end, as a reader does, and returns
// the DIDs in the order listed.
async fn follow(service: &TestService, since: u64, limit: usize) -> Result<Vec<String>> {
    let mut dids = Vec::new();
    let mut cursor = since;
    loop {
        let (status, page) = changes(service, &format!("since={cursor}&limit={limit}")).await?;
        assert_eq!(status, 200);
        let listed = page["changes"].as_array().unwrap();
        for change in listed {
            let sequence = change["sequence"].as_u64().unwrap();
            assert!(sequence > cursor, "sequences ascend");
            cursor = sequence;
            dids.push(change["did"].as_str().unwrap().to_string());
        }
        if listed.len() < limit {
            return Ok(dids);
        }
    }
}

async fn head(service: &TestService) -> Result<(String, u64)> {
    let (status, page) = changes(service, "").await?;
    assert_eq!(status, 200);
    assert_eq!(page["changes"], json!([]), "no sequence, no changes");
    Ok((
        page["epoch"].as_str().unwrap().to_string(),
        page["sequence"].as_u64().unwrap(),
    ))
}

#[tokio::test]
async fn changes_list_each_did_once_in_the_order_changed() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let data_dir = path_buf(temp_dir.path());
    let service = respawn_service("json", &data_dir, &[]).await?;

    let (epoch, sequence) = head(&service).await?;
    assert!(!epoch.is_empty());
    assert_eq!(sequence, 0);
    assert_eq!(follow(&service, 0, 1000).await?, Vec::<String>::new());

    let first = create_did(
        &service,
        create_agent_operation(31, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    let second = create_did(
        &service,
        create_agent_operation(32, "2026-04-11T12:01:00Z", "hyperswarm"),
    )
    .await?;
    let third = create_did(
        &service,
        create_agent_operation(33, "2026-04-11T12:02:00Z", "local"),
    )
    .await?;
    assert_eq!(
        follow(&service, 0, 1000).await?,
        vec![first.clone(), second.clone(), third.clone()]
    );
    // In pages smaller than the list, nothing is missed or repeated.
    assert_eq!(
        follow(&service, 0, 2).await?,
        vec![first.clone(), second.clone(), third.clone()]
    );

    let (_, mark) = head(&service).await?;
    update_did(
        &service,
        31,
        &first,
        "2026-04-11T12:03:00Z",
        json!({ "n": 1 }),
    )
    .await?;

    // The updated DID moves to the end: each DID is listed once, at its latest
    // change. It is what is new since the mark.
    let all = follow(&service, 0, 1000).await?;
    assert_eq!(all.len(), 3);
    assert_eq!(all.last(), Some(&first));
    assert!(all.contains(&second) && all.contains(&third));
    assert_eq!(follow(&service, mark, 1000).await?.last(), Some(&first));
    let (same_epoch, latest) = head(&service).await?;
    assert_eq!(same_epoch, epoch);
    assert_eq!(follow(&service, latest, 1000).await?, Vec::<String>::new());

    // A removed DID is a change like any other.
    admin_post(&service, "dids/remove", json!([second.clone()])).await?;
    assert!(follow(&service, latest, 1000).await?.contains(&second));
    drop(service);

    // A restart begins a new epoch, in which nothing has changed yet.
    let service = respawn_service("json", &data_dir, &[]).await?;
    let (restarted, sequence) = head(&service).await?;
    assert_ne!(restarted, epoch);
    assert_eq!(sequence, 0);
    assert_eq!(follow(&service, 0, 1000).await?, Vec::<String>::new());
    Ok(())
}

#[tokio::test]
async fn changes_reject_invalid_parameters() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let service = respawn_service("json", path_buf(temp_dir.path()), &[]).await?;
    for (query, field) in [
        ("since=-1", "since"),
        ("since=1e1", "since"),
        ("since=", "since"),
        ("since=1&since=2", "since"),
        ("since=9007199254740992", "since"),
        ("limit=0", "limit"),
        ("limit=1001", "limit"),
        ("limit=ten", "limit"),
        ("limit=1&limit=2", "limit"),
    ] {
        assert_eq!(
            changes(&service, query).await?,
            (
                400,
                json!({ "error": format!("Invalid parameter: {field}") })
            ),
            "{query}"
        );
    }
    Ok(())
}
