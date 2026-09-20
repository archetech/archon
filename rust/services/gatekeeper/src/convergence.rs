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
        } else if vector["transport"] == "mixed" || vector["transport"] == "pin-mixed" {
            json!(if index % 2 == 1 {
                if vector["transport"] == "pin-mixed" {
                    "pin"
                } else {
                    "hyperswarm"
                }
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
                    } else if vector["transport"] == "mixed" || vector["transport"] == "pin-mixed" {
                        json!(if index % 2 == 1 {
                            if vector["transport"] == "pin-mixed" { "pin" } else { "hyperswarm" }
                        } else { "local" })
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

#[tokio::test]
async fn convergence_full_event_records_settle() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../tests/convergence/vectors.json")).unwrap();
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/record-cases.json"
    ))
    .unwrap();
    let vector = fixture["histories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["registry"] == cases["registry"])
        .unwrap();
    let did = vector["did"].as_str().unwrap();
    for case in cases["cases"]
        .as_array()
        .unwrap()
        .iter()
        .chain(cases["replayCases"].as_array().unwrap())
    {
        let (state, _directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        let events: Vec<Value> = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let index = e["operation"].as_u64().unwrap() as usize;
                json!({ "operation": vector["operations"][index], "opid": vector["ids"][index],
                "registry": e["registry"], "ordinal": e["ordinal"], "did": did,
                "time": vector["operations"][index]["proof"]["created"] })
            })
            .collect();
        let select = |field: &str| -> Vec<crate::EventRecord> {
            case[field]
                .as_array()
                .unwrap()
                .iter()
                .map(|i| {
                    serde_json::from_value(events[i.as_u64().unwrap() as usize].clone()).unwrap()
                })
                .collect()
        };
        let initial = serde_json::to_value(select("initial")).unwrap();
        let expected = serde_json::to_value(select("expected")).unwrap();
        for (index, event) in events.iter().enumerate() {
            crate::import_batch_impl(&state, &[event.clone()]).await;
            crate::process_events_impl(&state).await;
            if index + 1 == case["initial"].as_array().unwrap().len() {
                assert_eq!(
                    serde_json::to_value(state.store.lock().await.get_events(did)).unwrap(),
                    initial,
                    "{} initial",
                    case["name"]
                );
            }
        }
        assert_eq!(
            serde_json::to_value(state.store.lock().await.get_events(did)).unwrap(),
            expected,
            "{} imported",
            case["name"]
        );
        let reversed: Vec<_> = events.iter().rev().cloned().collect();
        crate::import_batch_impl(&state, &reversed).await;
        crate::process_events_impl(&state).await;
        assert_eq!(
            serde_json::to_value(state.store.lock().await.get_events(did)).unwrap(),
            expected,
            "{} repeated",
            case["name"]
        );
        let data =
            serde_json::from_value(serde_json::to_value(&state.store.lock().await.data).unwrap())
                .unwrap();
        let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data,
            redis_connection: None,
        });
        crate::history::ensure_history_ready(&restarted)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(restarted.store.lock().await.get_events(did)).unwrap(),
            expected,
            "{} restarted",
            case["name"]
        );
    }
}

#[tokio::test]
async fn convergence_runtime_passes_match_lean_and_serialized_stopping() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../../tests/convergence/vectors.json")).unwrap();
    let cases: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/record-cases.json"
    ))
    .unwrap();
    let vector = fixture["histories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|h| h["registry"] == cases["registry"])
        .unwrap();
    let did = vector["did"].as_str().unwrap();
    let settled = cases["cases"].as_array().unwrap();
    for (case_index, case) in settled
        .iter()
        .chain(cases["replayCases"].as_array().unwrap())
        .enumerate()
    {
        let events: Vec<crate::EventRecord> = case["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let index = e["operation"].as_u64().unwrap() as usize;
                serde_json::from_value(json!({ "operation": vector["operations"][index],
                "opid": vector["ids"][index], "did": did, "registry": e["registry"],
                "ordinal": e["ordinal"], "time": vector["operations"][index]["proof"]["created"] }))
                .unwrap()
            })
            .collect();
        let select = |indices: &Value| -> Vec<crate::EventRecord> {
            indices
                .as_array()
                .unwrap()
                .iter()
                .map(|i| events[i.as_u64().unwrap() as usize].clone())
                .collect()
        };
        for warm in [false, true] {
            if warm && case_index >= settled.len() {
                continue;
            }
            let (state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            crate::history::ensure_history_ready(&state).await.unwrap();
            let seed = if warm {
                select(&case["initial"])
            } else {
                Vec::new()
            };
            // Exercise the exact routine used by history replay, with no ingress
            // reconciliation between candidates; public imports are checked separately.
            for event in &seed {
                crate::events::import_event_once(&state, event.clone()).await;
            }
            assert!(state.store.lock().await.get_events(did) == seed);
            let passes = if warm {
                vec![case["expected"].clone()]
            } else {
                case["replayPasses"].as_array().unwrap().clone()
            };
            let mut stopped = false;
            for expected in passes.iter().chain(std::iter::once(&case["expected"])) {
                let before = state.store.lock().await.get_events(did);
                let previous = serde_json::to_string(&before).unwrap();
                let decoded: Vec<crate::EventRecord> = serde_json::from_str(&previous).unwrap();
                assert!(decoded == before);
                for event in &events {
                    crate::events::import_event_once(&state, event.clone()).await;
                }
                let after = state.store.lock().await.get_events(did);
                assert_eq!(
                    serde_json::to_value(&after).unwrap(),
                    serde_json::to_value(select(expected)).unwrap(),
                    "{} warm={warm}",
                    case["name"]
                );
                let serialized = serde_json::to_string(&after).unwrap();
                let decoded: Vec<crate::EventRecord> = serde_json::from_str(&serialized).unwrap();
                assert!(decoded == after);
                assert_eq!(
                    serialized == previous,
                    after == before,
                    "{} warm={warm} stopping",
                    case["name"]
                );
                if serialized == previous {
                    stopped = true;
                    break;
                }
            }
            assert!(stopped, "{} warm={warm} did not stop", case["name"]);
            assert!(state.store.lock().await.get_events(did) == select(&case["expected"]));
        }
    }
}

#[tokio::test]
async fn convergence_agent_rotation_and_deletion() {
    let mut vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/agent-vectors.json"
    ))
    .unwrap();
    let documents: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/document-vectors.json"
    ))
    .unwrap();
    vectors
        .as_array_mut()
        .unwrap()
        .extend(documents.as_array().unwrap().iter().cloned());
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        for scenario in vector["scenarios"].as_array().unwrap() {
            for order in scenario["orders"].as_array().unwrap() {
                let (mut state, _directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data: JsonDbFile::default(),
                    redis_connection: None,
                });
                let events: Vec<Value> = order.as_array().unwrap().iter().enumerate().map(|(receipt, index)| {
                    let operation = &vector["operations"][index.as_u64().unwrap() as usize];
                    json!({ "operation": operation, "registry": "hyperswarm", "time": operation["proof"]["created"], "ordinal": [receipt, 0] })
                }).collect();
                for event in &events {
                    crate::import_batch_impl(&state, &[event.clone()]).await;
                    crate::process_events_impl(&state).await;
                }
                let mut restart_directory = None;
                for phase in 0..3 {
                    if phase == 1 {
                        crate::import_batch_impl(
                            &state,
                            &events.iter().rev().cloned().collect::<Vec<_>>(),
                        )
                        .await;
                        crate::process_events_impl(&state).await;
                    }
                    if phase == 2 {
                        let data = serde_json::from_value(
                            serde_json::to_value(&state.store.lock().await.data).unwrap(),
                        )
                        .unwrap();
                        let (restarted, directory) = crate::tests::make_state(JsonDb {
                            backend: DbBackend::Memory,
                            data,
                            redis_connection: None,
                        });
                        state = restarted;
                        restart_directory = Some(directory);
                    }
                    crate::history::ensure_history_ready(&state).await.unwrap();
                    let doc = crate::resolve_local_doc_async(
                        &state,
                        did,
                        ResolveOptions {
                            verify: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                    let ids = vector["ids"].as_array().unwrap();
                    let path: Vec<usize> = state
                        .store
                        .lock()
                        .await
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
                        scenario["expected"],
                        "{} {order} phase {phase}",
                        scenario["name"]
                    );
                    assert_eq!(
                        doc["didDocumentMetadata"]["versionId"],
                        ids[*path.last().unwrap()]
                    );
                    if scenario["finalState"] == "deleted" {
                        assert_eq!(doc["didDocumentMetadata"]["deactivated"], true);
                    } else if let Some(documents) = vector.get("methodDocuments") {
                        assert_eq!(
                            doc["didDocument"]["verificationMethod"],
                            documents[scenario["finalState"].as_u64().unwrap() as usize]
                        );
                    } else {
                        assert_eq!(
                            doc["didDocument"]["verificationMethod"][0]["publicKeyJwk"],
                            vector["keys"][scenario["finalState"].as_u64().unwrap() as usize]
                        );
                    }
                }
                drop(restart_directory);
            }
        }
    }
}
