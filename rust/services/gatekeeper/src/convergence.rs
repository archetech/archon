//! Cross-port checks against the restricted executable convergence model.
use std::collections::BTreeSet;

use serde_json::{json, Value};

use crate::store::{DbBackend, JsonDbFile};
use crate::{AppState, GatekeeperDb, JsonDb, ResolveOptions};

async fn assert_projection(state: &AppState, vector: &Value, case: &Value) -> String {
    crate::history::ensure_history_ready(state).await.unwrap();
    let did = vector["did"].as_str().unwrap();
    let doc = crate::resolve_local_doc_async(
        state,
        did,
        ResolveOptions {
            verify: true,
            confirm: false,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let ids = vector["ids"].as_array().unwrap();
    let store = state.store.lock().await;
    let path: Vec<usize> = store
        .get_events(did)
        .iter()
        .map(|event| {
            ids.iter()
                .position(|id| id.as_str() == event.opid.as_deref())
                .unwrap()
        })
        .collect();
    assert_eq!(
        json!(path),
        case["expected"],
        "{} {}",
        vector["name"],
        case["order"]
    );
    let head = *path.last().unwrap();
    assert_eq!(doc["didDocumentMetadata"]["versionId"], ids[head]);
    assert_eq!(
        doc["didDocumentData"],
        vector["operations"][head]["doc"]["didDocumentData"]
    );
    assert_eq!(
        store.get_candidates().unwrap()[did].len(),
        case["order"].as_array().unwrap().len()
    );
    drop(store);
    let mut confirmed_head = 0;
    for &index in path.iter().skip(1) {
        let registry = if vector["transport"] == "foreign-anchor" {
            json!(if index == 2 { "BTC:signet" } else { "local" })
        } else if vector["transport"] == "mixed" {
            json!(if index % 2 == 1 {
                "hyperswarm"
            } else {
                "local"
            })
        } else {
            vector["transport"].clone()
        };
        if registry != vector["registry"] {
            break;
        }
        confirmed_head = index;
    }
    let confirmed = crate::resolve_local_doc_async(
        state,
        did,
        ResolveOptions {
            verify: true,
            confirm: true,
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        confirmed["didDocumentMetadata"]["versionId"],
        ids[confirmed_head]
    );
    path.iter()
        .map(usize::to_string)
        .collect::<Vec<_>>()
        .join(",")
}

#[tokio::test]
async fn convergence_delivery_permutations_match_restricted_model() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../tests/convergence/vectors.json")).unwrap();
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let mut vector = fixture["histories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|history| history["registry"] == scenario["registry"])
            .unwrap()
            .clone();
        vector
            .as_object_mut()
            .unwrap()
            .extend(scenario.as_object().unwrap().clone());
        let mut outcomes = BTreeSet::new();
        for case in vector["cases"].as_array().unwrap() {
            let (state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            let events: Vec<Value> = case["order"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(receipt, index)| {
                    let index = index.as_u64().unwrap() as usize;
                    let operation = &vector["operations"][index];
                    let registry = if vector["transport"] == "foreign-anchor" {
                        json!(if index == 2 { "BTC:signet" } else { "local" })
                    } else if vector["transport"] == "mixed" {
                        json!(if index % 2 == 1 { "hyperswarm" } else { "local" })
                    } else {
                        vector["transport"].clone()
                    };
                    let ordinal = if vector["receipts"] == "fresh" {
                        receipt
                    } else if vector["receipts"] == "tied" {
                        0
                    } else {
                        index
                    };
                    let mut event = json!({
                        "operation": operation, "registry": registry,
                        "time": operation["proof"]["created"],
                        "ordinal": [1000 + ordinal, 0]
                    });
                    if vector["transport"] == "BTC:signet" || (vector["transport"] == "foreign-anchor" && index == 2) {
                        event["registration"] = json!({ "height": 1000 + index, "txid": format!("tx{index}"), "batch": "batch", "opidx": 0 });
                    }
                    event
                })
                .collect();
            for event in &events {
                crate::import_batch_impl(&state, &[event.clone()]).await;
                crate::process_events_impl(&state).await;
            }
            outcomes.insert(assert_projection(&state, &vector, case).await);
            let reversed: Vec<_> = events.iter().rev().cloned().collect();
            crate::import_batch_impl(&state, &reversed).await;
            crate::process_events_impl(&state).await;
            assert_projection(&state, &vector, case).await;
            // Reconstruct from serialized storage with empty in-memory caches.
            let data = serde_json::from_value(
                serde_json::to_value(&state.store.lock().await.data).unwrap(),
            )
            .unwrap();
            let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data,
                redis_connection: None,
            });
            outcomes.insert(assert_projection(&restarted, &vector, case).await);
        }
        assert_eq!(outcomes.len(), 1, "{}", vector["name"]);
    }
}

#[tokio::test]
async fn convergence_controller_fork_replays_asset_authorization() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../tests/convergence/vectors.json")).unwrap();
    for v in fixture["controllerForks"].as_array().unwrap() {
        for order in v["orders"].as_array().unwrap() {
            let (state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for (receipt, index) in order.as_array().unwrap().iter().enumerate() {
                let operation = &v["operations"][index.as_u64().unwrap() as usize];
                let event = json!({ "operation": operation, "registry": "hyperswarm",
                    "time": operation["proof"]["created"], "ordinal": [receipt, 0] });
                crate::import_batch_impl(&state, &[event]).await;
                crate::process_events_impl(&state).await;
            }
            let data = serde_json::from_value(
                serde_json::to_value(&state.store.lock().await.data).unwrap(),
            )
            .unwrap();
            let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data,
                redis_connection: None,
            });
            for current in [&state, &restarted] {
                crate::history::ensure_history_ready(current).await.unwrap();
                for (did_field, path_field) in
                    [("controller", "controllerPath"), ("asset", "assetPath")]
                {
                    let did = v[did_field].as_str().unwrap();
                    let doc = crate::resolve_local_doc_async(
                        current,
                        did,
                        ResolveOptions {
                            verify: true,
                            confirm: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                    let store = current.store.lock().await;
                    let path: Vec<_> = store
                        .get_events(did)
                        .iter()
                        .map(|event| {
                            v["ids"]
                                .as_array()
                                .unwrap()
                                .iter()
                                .position(|id| id.as_str() == event.opid.as_deref())
                                .unwrap()
                        })
                        .collect();
                    assert_eq!(
                        json!(path),
                        v[path_field],
                        "legacy={} order={order}",
                        v["legacy"]
                    );
                    assert_eq!(
                        doc["didDocumentMetadata"]["versionId"],
                        v["ids"][*path.last().unwrap()]
                    );
                    assert_eq!(store.get_candidates().unwrap()[did].len(), 3);
                }
            }
        }
    }
}
