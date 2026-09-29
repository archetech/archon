mod common;

use anyhow::Result;
use serde_json::{json, Value};

use common::{
    create_agent_operation, create_update_operation, path_buf, respawn_service, TestService,
};

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

async fn list(service: &TestService, query: &str) -> Result<(u16, Value)> {
    let response = service
        .client
        .get(format!("{}/events?{query}", service.base_url))
        .send()
        .await?;
    let status = response.status().as_u16();
    Ok((status, response.json::<Value>().await?))
}

fn millis(time: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(time)
        .unwrap()
        .timestamp_millis()
}

// What /events must return, computed from the stored histories directly.
async fn expected(
    service: &TestService,
    after: Option<&str>,
    before: Option<&str>,
    registry: Option<&str>,
    limit: usize,
    offset: usize,
) -> Result<Value> {
    let dids = admin_post(service, "dids", json!({})).await?;
    let dids: Vec<String> = dids
        .as_array()
        .unwrap()
        .iter()
        .map(|did| did.as_str().unwrap().to_string())
        .collect();
    let exported = admin_post(service, "dids/export", json!({ "dids": dids })).await?;
    let mut all = Vec::new();
    for (did, events) in dids.iter().zip(exported.as_array().unwrap()) {
        let key = did.rsplit(':').next().unwrap().to_string();
        for (position, event) in events.as_array().unwrap().iter().enumerate() {
            let mut event = event.clone();
            if event.get("did").is_none() {
                event["did"] = json!(did);
            }
            all.push((
                millis(event["time"].as_str().unwrap()),
                key.clone(),
                position,
                event,
            ));
        }
    }
    all.retain(|(time, _, _, event)| {
        after.is_none_or(|after| *time > millis(after))
            && before.is_none_or(|before| *time < millis(before))
            && registry.is_none_or(|registry| event["registry"] == registry)
    });
    all.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.cmp(&b.1))
            .then_with(|| b.2.cmp(&a.2))
    });
    let total = all.len();
    let events: Vec<Value> = all
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|entry| entry.3)
        .collect();
    Ok(json!({ "total": total, "events": events }))
}

async fn populate(service: &TestService) -> Result<()> {
    let first = create_did(
        service,
        create_agent_operation(21, "2026-04-11T12:00:00Z", "local"),
    )
    .await?;
    update_did(
        service,
        21,
        &first,
        "2026-04-11T12:03:00Z",
        json!({ "n": 1 }),
    )
    .await?;
    update_did(
        service,
        21,
        &first,
        "2026-04-11T12:05:00.500+02:00",
        json!({ "n": 2 }),
    )
    .await?;
    let second = create_did(
        service,
        create_agent_operation(22, "2026-04-11T12:01:00Z", "hyperswarm"),
    )
    .await?;
    update_did(
        service,
        22,
        &second,
        "2026-04-11T12:04:00Z",
        json!({ "n": 1 }),
    )
    .await?;
    create_did(
        service,
        create_agent_operation(23, "2026-04-11T12:03:00Z", "local"),
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn events_listing_pages_filters_and_survives_restart() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let data_dir = path_buf(temp_dir.path());
    // An empty store at startup builds no replay snapshot; the listing must
    // still follow the DIDs created afterwards.
    let service = respawn_service("json", &data_dir, &[]).await?;
    assert_eq!(
        list(&service, "").await?,
        (200, json!({ "total": 0, "events": [] }))
    );
    populate(&service).await?;

    let (status, all) = list(&service, "").await?;
    assert_eq!(status, 200);
    assert_eq!(all["total"], 6);
    assert_eq!(all, expected(&service, None, None, None, 50, 0).await?);

    let middle = all["events"][2]["time"].as_str().unwrap().to_string();
    let cases: Vec<(
        String,
        Option<&str>,
        Option<&str>,
        Option<&str>,
        usize,
        usize,
    )> = vec![
        ("limit=2&offset=1".into(), None, None, None, 2, 1),
        (
            "registry=hyperswarm".into(),
            None,
            None,
            Some("hyperswarm"),
            50,
            0,
        ),
        (
            "registry=BTC:signet".into(),
            None,
            None,
            Some("BTC:signet"),
            50,
            0,
        ),
        (
            format!("after={}", urlencode(&middle)),
            Some(&middle),
            None,
            None,
            50,
            0,
        ),
        (
            format!("before={}&limit=1", urlencode(&middle)),
            None,
            Some(&middle),
            None,
            1,
            0,
        ),
    ];
    for (query, after, before, registry, limit, offset) in cases {
        let (status, body) = list(&service, &query).await?;
        assert_eq!(status, 200, "{query}");
        assert_eq!(
            body,
            expected(&service, after, before, registry, limit, offset).await?,
            "{query}"
        );
    }
    drop(service);

    let service = respawn_service("json", &data_dir, &[]).await?;
    assert_eq!(list(&service, "").await?.1, all);
    Ok(())
}

#[tokio::test]
async fn events_listing_follows_reset_import_and_removal() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let service = respawn_service("json", path_buf(temp_dir.path()), &[]).await?;
    populate(&service).await?;
    let (_, before) = list(&service, "").await?;
    let exported = admin_post(&service, "dids/export", json!({})).await?;

    let reset = service
        .admin(service.client.get(format!("{}/db/reset", service.base_url)))
        .send()
        .await?;
    assert!(reset.status().is_success());
    assert_eq!(
        list(&service, "").await?.1,
        json!({ "total": 0, "events": [] })
    );

    admin_post(&service, "dids/import", exported).await?;
    admin_post(&service, "events/process", json!({})).await?;
    assert_eq!(list(&service, "").await?.1, before);

    let removed = before["events"][0]["did"].as_str().unwrap().to_string();
    admin_post(&service, "dids/remove", json!([removed])).await?;
    let (_, after) = list(&service, "").await?;
    assert_eq!(after, expected(&service, None, None, None, 50, 0).await?);
    assert!(after["events"]
        .as_array()
        .unwrap()
        .iter()
        .all(|event| event["did"] != removed.as_str()));
    Ok(())
}

#[tokio::test]
async fn events_listing_rejects_invalid_parameters() -> Result<()> {
    let temp_dir = tempfile::tempdir()?;
    let service = respawn_service("json", path_buf(temp_dir.path()), &[]).await?;
    for (query, field) in [
        ("after=yesterday", "after"),
        ("after=2026-01-01", "after"),
        ("after=2026-02-30T00:00:00Z", "after"),
        ("before=2026-01-01T24:00:00Z", "before"),
        ("registry=", "registry"),
        ("registry=local&registry=local", "registry"),
        ("limit=abc", "limit"),
        ("limit=", "limit"),
        ("limit=%205", "limit"),
        ("limit=1e1", "limit"),
        ("limit=5.0", "limit"),
        ("limit=0", "limit"),
        ("limit=1001", "limit"),
        ("limit=1&limit=2", "limit"),
        ("offset=-1", "offset"),
        ("offset=9007199254740992", "offset"),
    ] {
        let (status, body) = list(&service, query).await?;
        assert_eq!((query, status), (query, 400));
        assert_eq!(
            body,
            json!({ "error": format!("Invalid parameter: {field}") }),
            "{query}"
        );
    }
    Ok(())
}

fn urlencode(value: &str) -> String {
    value.replace('+', "%2B").replace(':', "%3A")
}
