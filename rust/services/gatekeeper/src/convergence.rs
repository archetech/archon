//! Cross-port checks against the restricted executable convergence model.
mod event_targets;
mod chain_metadata;
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
                        "ordinal": [1000 + ordinal, 0, 0]
                    });
                    if vector["transport"] == "BTC:signet" || (vector["transport"] == "foreign-anchor" && index == 2) {
                        event["registration"] = json!({ "height": 1000 + ordinal, "index": 0, "txid": format!("tx{index}"), "batch": "batch", "opidx": 0 });
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
    let components: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/component-vectors.json"
    ))
    .unwrap();
    vectors
        .as_array_mut()
        .unwrap()
        .extend(components.as_array().unwrap().iter().cloned());
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
                    if let Some(components) = scenario.get("components") {
                        assert_eq!(
                            json!({ "didDocument": doc["didDocument"], "didDocumentData": doc["didDocumentData"], "didDocumentRegistration": doc["didDocumentRegistration"] }),
                            *components
                        );
                    }
                    if scenario["finalState"] == "deleted" {
                        assert_eq!(doc["didDocumentMetadata"]["deactivated"], true);
                    } else if scenario.get("components").is_some() {
                        assert_ne!(doc["didDocumentMetadata"]["deactivated"], true);
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

#[tokio::test]
async fn convergence_earliest_valid_chain_anchors() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/chain-anchor-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        let asset_did = vector["assetDid"].as_str().unwrap();
        for order in vector["orders"].as_array().unwrap() {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            state
                .store
                .lock()
                .await
                .add_block("BTC:signet", vector["block"].clone())
                .unwrap();
            for index in order.as_array().unwrap() {
                crate::import_batch_impl(
                    &state,
                    &[vector["events"][index.as_u64().unwrap() as usize].clone()],
                )
                .await;
                crate::process_events_impl(&state).await;
            }
            let mut restart_directory = None;
            for phase in 0..3 {
                if phase == 1 {
                    let events: Vec<_> = vector["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .cloned()
                        .collect();
                    crate::import_batch_impl(&state, &events).await;
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
                let events = state.store.lock().await.get_events(did);
                assert_eq!(
                    json!(events
                        .iter()
                        .map(|event| &event.ordinal)
                        .collect::<Vec<_>>()),
                    json!([[100, 30, 0], [100, 40, 0], [100, 10, 0]]),
                    "{order}, phase {phase}"
                );
                assert_eq!(
                    json!(events.iter().map(|event| &event.opid).collect::<Vec<_>>()),
                    json!(&vector["ids"].as_array().unwrap()[..3])
                );
                assert!(events.iter().all(|event| event.registry == "BTC:signet"));
                let asset = crate::resolve_local_doc_async(
                    &state,
                    asset_did,
                    ResolveOptions {
                        verify: true,
                        confirm: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                assert_eq!(asset["didDocumentData"], json!({ "state": "created" }));
                let store = state.store.lock().await;
                assert_eq!(
                    json!(store
                        .get_events(asset_did)
                        .iter()
                        .map(|event| &event.ordinal)
                        .collect::<Vec<_>>()),
                    json!([[100, 45, 0]])
                );
                let candidates = store.get_candidates().unwrap();
                assert_eq!(candidates[did].len(), 6);
                assert_eq!(candidates[asset_did].len(), 2);
            }
            drop(restart_directory);
        }
    }
}
#[tokio::test]
async fn convergence_chain_successor_priority() {
    let mut vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/chain-successor-vectors.json"
    ))
    .unwrap();
    let documents: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/chain-document-vectors.json"
    ))
    .unwrap();
    vectors
        .as_array_mut()
        .unwrap()
        .extend(documents.as_array().unwrap().iter().cloned());
    let migrations: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/migration-vectors.json"
    ))
    .unwrap();
    vectors
        .as_array_mut()
        .unwrap()
        .extend(migrations.as_array().unwrap().iter().cloned());
    let tied: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/tied-anchor-vectors.json"
    ))
    .unwrap();
    vectors
        .as_array_mut()
        .unwrap()
        .extend(tied.as_array().unwrap().iter().cloned());
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        for order in vector["orders"].as_array().unwrap() {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            if let Some(blocks) = vector["blocks"].as_array() {
                for entry in blocks {
                    state
                        .store
                        .lock()
                        .await
                        .add_block(entry["registry"].as_str().unwrap(), entry["block"].clone())
                        .unwrap();
                }
            } else {
                state
                    .store
                    .lock()
                    .await
                    .add_block("BTC:signet", vector["block"].clone())
                    .unwrap();
            }
            for token in order.as_array().unwrap() {
                crate::import_batch_impl(
                    &state,
                    &[vector["events"][token.as_u64().unwrap() as usize].clone()],
                )
                .await;
                crate::process_events_impl(&state).await;
            }
            let mut restart_directory = None;
            for phase in 0..3 {
                if phase == 1 {
                    let events: Vec<_> = vector["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .cloned()
                        .collect();
                    crate::import_batch_impl(&state, &events).await;
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
                let mut ordinary = crate::resolve_local_doc_async(&state, did, ResolveOptions::default()).await.unwrap();
                let mut verified = doc.clone();
                ordinary["didResolutionMetadata"].as_object_mut().unwrap().remove("retrieved");
                verified["didResolutionMetadata"].as_object_mut().unwrap().remove("retrieved");
                assert_eq!(ordinary, verified);
                let store = state.store.lock().await;
                let expected = vector["expected"].as_array().unwrap();
                let ids: Vec<_> = expected
                    .iter()
                    .map(|i| vector["ids"][i.as_u64().unwrap() as usize].clone())
                    .collect();
                assert_eq!(
                    json!(store
                        .get_events(did)
                        .iter()
                        .map(|e| &e.opid)
                        .collect::<Vec<_>>()),
                    json!(ids),
                    "{order}, phase {phase}"
                );
                if let Some(tokens) = vector["expectedEvents"].as_array() {
                    let expected_events: Vec<crate::EventRecord> = tokens
                        .iter()
                        .enumerate()
                        .map(|(i, token)| {
                            let mut event =
                                vector["events"][token.as_u64().unwrap() as usize].clone();
                            event["did"] = json!(did);
                            event["opid"] = ids[i].clone();
                            serde_json::from_value(event).unwrap()
                        })
                        .collect();
                    assert_eq!(
                        serde_json::to_value(store.get_events(did)).unwrap(),
                        serde_json::to_value(expected_events).unwrap()
                    );
                    assert_eq!(
                        doc["didDocumentRegistration"]["registry"],
                        vector["expectedRegistry"]
                    );
                }
                let last = expected.last().unwrap().as_u64().unwrap() as usize;
                if vector["operations"][last]["type"] == "delete" {
                    assert_eq!(doc["didDocumentMetadata"]["deactivated"], json!(true));
                    assert_eq!(doc["didDocumentData"], json!({}));
                } else {
                    assert_ne!(doc["didDocumentMetadata"]["deactivated"], json!(true));
                    assert_eq!(
                        doc["didDocumentData"],
                        vector["operations"][last]["doc"]["didDocumentData"]
                    );
                    if let Some(active) = vector["states"][last].as_u64() {
                        let mut ids: Vec<_> = vector["ids"].as_array().unwrap().iter().collect();
                        ids.sort_by_key(|id| id.as_str().unwrap());
                        let operation = vector["ids"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .position(|id| id == ids[active as usize])
                            .unwrap();
                        assert_eq!(
                            doc["didDocument"]["verificationMethod"],
                            vector["operations"][operation]["doc"]["didDocument"]
                                ["verificationMethod"]
                        );
                    }
                }
                assert_eq!(
                    store.get_candidates().unwrap()[did].len(),
                    vector["events"].as_array().unwrap().len()
                );
            }
            drop(restart_directory);
        }
    }
}
#[tokio::test]
async fn convergence_interleaved_transitions() {
    for (source, trace) in [
        (
            include_str!("../../../../tests/convergence/chain-successor-vectors.json"),
            include_str!("../../../../tests/convergence/interleaved-cases.json"),
        ),
        (
            include_str!("../../../../tests/convergence/chain-document-vectors.json"),
            include_str!("../../../../tests/convergence/chain-document-cases.json"),
        ),
        (
            include_str!("../../../../tests/convergence/migration-vectors.json"),
            include_str!("../../../../tests/convergence/registry-interleaved-cases.json"),
        ),
    ] {
        let vectors: Value = serde_json::from_str(source).unwrap();
        let cases: Value = serde_json::from_str(trace).unwrap();
        for case in cases.as_array().unwrap() {
            let v = &vectors[case["vector"].as_u64().unwrap() as usize];
            let did = v["did"].as_str().unwrap();
            let (state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            crate::history::ensure_history_ready(&state).await.unwrap();
            let blocks = v["blocks"]
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![json!({"registry": "BTC:signet", "block": v["block"]})]);
            for entry in blocks {
                state
                    .store
                    .lock()
                    .await
                    .add_block(entry["registry"].as_str().unwrap(), entry["block"].clone())
                    .unwrap();
            }
            let events: Vec<crate::EventRecord> = v["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|event| {
                    let op = v["operations"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .position(|op| op == &event["operation"])
                        .unwrap();
                    let mut event = event.clone();
                    event["did"] = json!(did);
                    event["opid"] = v["ids"][op].clone();
                    serde_json::from_value(event).unwrap()
                })
                .collect();
            if let Some(seed) = case["seed"].as_u64().or_else(|| v["seed"].as_u64()) {
                crate::events::import_event_once(&state, events[seed as usize].clone()).await;
            }
            let passes = case["passes"].as_array().unwrap();
            assert!(passes.len() <= case["passBound"].as_u64().unwrap() as usize);
            for (pass, steps) in passes.iter().enumerate() {
                let before =
                    serde_json::to_string(&state.store.lock().await.get_events(did)).unwrap();
                for (step, token) in case["order"].as_array().unwrap().iter().enumerate() {
                    crate::events::import_event_once(
                        &state,
                        events[token.as_u64().unwrap() as usize].clone(),
                    )
                    .await;
                    let expected: Vec<_> = steps[step]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|t| events[t.as_u64().unwrap() as usize].clone())
                        .collect();
                    assert_eq!(
                        serde_json::to_value(state.store.lock().await.get_events(did)).unwrap(),
                        serde_json::to_value(expected).unwrap(),
                        "vector {}, pass {pass}, step {step}",
                        case["vector"]
                    );
                }
                let after =
                    serde_json::to_string(&state.store.lock().await.get_events(did)).unwrap();
                assert_eq!(before == after, pass == passes.len() - 1);
            }
        }
    }
}

#[tokio::test]
async fn convergence_controller_cutoff_view() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/controller-view-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        let asset_did = vector["assetDid"].as_str().unwrap();
        let mut projections = Vec::new();
        for order in vector["orders"].as_array().unwrap() {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for entry in vector["blocks"].as_array().unwrap() {
                state
                    .store
                    .lock()
                    .await
                    .add_block(entry["registry"].as_str().unwrap(), entry["block"].clone())
                    .unwrap();
            }
            for token in order.as_array().unwrap() {
                crate::import_batch_impl(
                    &state,
                    &[vector["events"][token.as_u64().unwrap() as usize].clone()],
                )
                .await;
                crate::process_events_impl(&state).await;
            }
            let mut restart_directory = None;
            for phase in 0..3 {
                if phase == 1 {
                    let events: Vec<_> = vector["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .rev()
                        .cloned()
                        .collect();
                    crate::import_batch_impl(&state, &events).await;
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
                // Ordinary and verified paths must expose identical full bounded views.
                let accepted = state.store.lock().await.get_events(did);
                for (index, event) in accepted.iter().enumerate() {
                    for confirm in [false, true] {
                        let mut bounds = vec![
                            ResolveOptions { version_sequence: Some(index + 1), confirm, ..Default::default() },
                            ResolveOptions { version_time: Some(event.time.clone()), confirm, ..Default::default() },
                        ];
                        if let Some(ordinal) = &event.ordinal {
                            bounds.push(ResolveOptions {
                                version_time: Some(event.time.clone()),
                                version_ordinal: Some((event.registry.clone(), ordinal.clone())),
                                confirm, ..Default::default()
                            });
                        }
                        for options in bounds {
                            let mut ordinary = crate::resolve_local_doc_async(&state, did, options.clone()).await.unwrap();
                            let mut verified = crate::resolve_local_doc_async(&state, did, ResolveOptions { verify: true, ..options }).await.unwrap();
                            ordinary["didResolutionMetadata"].as_object_mut().unwrap().remove("retrieved");
                            verified["didResolutionMetadata"].as_object_mut().unwrap().remove("retrieved");
                            assert_eq!(ordinary, verified, "{}, phase {phase}", vector["mode"]);
                        }
                    }
                }
                let agent = crate::resolve_local_doc_async(
                    &state,
                    did,
                    ResolveOptions {
                        verify: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                let confirmed = crate::resolve_local_doc_async(
                    &state,
                    did,
                    ResolveOptions {
                        confirm: true,
                        verify: true,
                        ..Default::default()
                    },
                )
                .await
                .unwrap();
                let asset = crate::resolve_local_doc_async(
                    &state,
                    asset_did,
                    ResolveOptions {
                        verify: true,
                        ..Default::default()
                    },
                )
                .await;
                let asset = if vector["assetAccepted"].as_bool().unwrap() {
                    asset.unwrap()
                } else {
                    assert_eq!(asset.unwrap_err().root_cause().to_string(), "DID not found");
                    json!({"didDocument": {}, "didResolutionMetadata": {"error": "notFound"}})
                };
                assert_eq!(
                    json!(state
                        .store
                        .lock()
                        .await
                        .get_events(did)
                        .iter()
                        .map(|e| &e.opid)
                        .collect::<Vec<_>>()),
                    vector["controllerIds"]
                );
                assert_eq!(
                    confirmed["didDocumentMetadata"]["versionSequence"],
                    vector["confirmedVersions"]
                );
                if vector["assetAccepted"].as_bool().unwrap() {
                    assert_eq!(
                        asset["didDocument"]["controller"],
                        json!(did),
                        "{}, {order}, phase {phase}",
                        vector["mode"]
                    );
                } else {
                    assert_eq!(asset["didResolutionMetadata"]["error"], "notFound");
                }
                projections.push(json!({"agent": agent["didDocument"], "data": agent["didDocumentData"],
                    "registration": agent["didDocumentRegistration"], "confirmed": confirmed["didDocument"], "asset": asset["didDocument"]}));
            }
            drop(restart_directory);
        }
        for result in &projections {
            assert_eq!(result, &projections[0], "{}", vector["mode"]);
        }
    }
}

#[tokio::test]
async fn convergence_chain_ordinals_required() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/tied-anchor-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap().iter().step_by(2) {
        let did = vector["did"].as_str().unwrap();
        let genesis = json!({
            "registry": "SOL:devnet", "time": "2026-09-01T00:00:00Z",
            "ordinal": [100, 0, 0], "operation": vector["operations"][0],
            "opid": vector["ids"][0], "did": did,
            "registration": {"height": 100, "index": 0, "txid": "ordinal-audit", "batch": did, "opidx": 0}
        });
        for ordinal in [
            None,
            Some(Value::Null),
            Some(json!([])),
            Some(json!(7)),
            Some(json!("7")),
            Some(json!([null])),
            Some(json!([null, 1])),
            Some(json!([-1])),
            Some(json!([0.5])),
            Some(json!(["1", 2])),
            Some(json!([9_007_199_254_740_992u64])),
        ] {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            state.config.admin_api_key = "ordinal-test".to_string();
            let mut invalid = genesis.clone();
            if let Some(value) = ordinal {
                invalid["ordinal"] = value;
            } else {
                invalid.as_object_mut().unwrap().remove("ordinal");
            }
            assert!(!crate::verify_event_shape(&invalid));
            let result = crate::import_batch_impl(&state, &[invalid.clone()]).await;
            assert_eq!((result.queued, result.rejected), (0, 1));
            if let Ok(record) = serde_json::from_value::<crate::EventRecord>(invalid.clone()) {
                assert!(matches!(
                    crate::events::import_event_impl(&state, record).await,
                    crate::events::ImportStatus::Rejected
                ));
            }
            state
                .store
                .lock()
                .await
                .add_operation(
                    vector["ids"][0].as_str().unwrap(),
                    vector["operations"][0].clone(),
                )
                .unwrap();
            let response = crate::api::import_batch_by_cids(
                axum::extract::State(state.clone()),
                axum::http::HeaderMap::from_iter([(
                    axum::http::header::HeaderName::from_static("x-archon-admin-key"),
                    "ordinal-test".parse().unwrap(),
                )]),
                axum::Json(json!({"cids": [vector["ids"][0]], "metadata": invalid})),
            )
            .await;
            assert_eq!(
                response.status(),
                axum::http::StatusCode::INTERNAL_SERVER_ERROR
            );
            assert!(state.import_queue.lock().await.is_empty());
            // Only absent/null/empty ordinals are representable legacy omissions;
            // do not sanitize malformed raw storage to manufacture compatibility.
            if invalid
                .get("ordinal")
                .is_some_and(|value| !value.is_null() && value != &json!([]))
            {
                continue;
            }
            {
                let mut store = state.store.lock().await;
                assert!(store.get_events(did).is_empty());
                assert!(!store.get_candidates().unwrap().contains_key(did));
                let event = crate::value_to_event_record(&invalid);
                store.set_candidates(did, vec![event.clone()]).unwrap();
                store.set_events(did, vec![event]).unwrap();
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
            state = restarted;
            crate::history::ensure_history_ready(&state).await.unwrap();
            assert!(state.store.lock().await.get_events(did).is_empty());
            let result = crate::import_batch_impl(&state, &[genesis.clone()]).await;
            assert_eq!((result.queued, result.rejected), (1, 0));
            crate::process_events_impl(&state).await;
            assert_eq!(
                state.store.lock().await.get_events(did)[0].ordinal,
                Some(vec![100, 0, 0])
            );
            let data = serde_json::from_value(
                serde_json::to_value(&state.store.lock().await.data).unwrap(),
            )
            .unwrap();
            let (restarted, _final_directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data,
                redis_connection: None,
            });
            crate::history::ensure_history_ready(&restarted)
                .await
                .unwrap();
            assert_eq!(
                restarted.store.lock().await.get_events(did)[0].ordinal,
                Some(vec![100, 0, 0])
            );
        }
        let (mut state, _directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        state.config.admin_api_key = "ordinal-test".to_string();
        state
            .store
            .lock()
            .await
            .add_operation(
                vector["ids"][0].as_str().unwrap(),
                vector["operations"][0].clone(),
            )
            .unwrap();
        let mut metadata = genesis.clone();
        metadata["ordinal"] = serde_json::from_str("[1099511627776, 1.0]").unwrap();
        metadata["registration"]["height"] = json!(1_099_511_627_776u64);
        metadata["registration"]["index"] = json!(1);
        let response = crate::api::import_batch_by_cids(
            axum::extract::State(state.clone()),
            axum::http::HeaderMap::from_iter([(
                axum::http::header::HeaderName::from_static("x-archon-admin-key"),
                "ordinal-test".parse().unwrap(),
            )]),
            axum::Json(json!({"cids": [null, vector["ids"][0]], "metadata": metadata})),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        crate::process_events_impl(&state).await;
        assert_eq!(
            state.store.lock().await.get_events(did)[0].ordinal,
            Some(vec![1_099_511_627_776, 1, 1])
        );
        assert_eq!(state.store.lock().await.get_events(did)[0].registration.as_ref().unwrap()["opidx"], json!(1));
        let response = crate::api::import_batch_by_cids(
            axum::extract::State(state.clone()),
            axum::http::HeaderMap::from_iter([(axum::http::header::HeaderName::from_static("x-archon-admin-key"), "ordinal-test".parse().unwrap())]),
            axum::Json(json!({"cids": [null], "metadata": genesis})),
        ).await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096).await.unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({"queued": 0, "processed": 0, "rejected": 0, "total": 0}));
        for registry in ["local", "hyperswarm", "pin"] {
            let mut hint = genesis.clone();
            hint["registry"] = json!(registry);
            hint.as_object_mut().unwrap().remove("ordinal");
            assert!(crate::verify_event_shape(&hint));
            hint["ordinal"] = json!([]);
            assert!(crate::verify_event_shape(&hint));
            for ordinal in [
                json!(null),
                json!(7),
                json!([null]),
                json!([null, 1]),
                json!([-1]),
                json!([0.5]),
                json!(["1", 2]),
                json!([9_007_199_254_740_992u64]),
            ] {
                let mut invalid_hint = genesis.clone();
                invalid_hint["registry"] = json!(registry);
                invalid_hint["ordinal"] = ordinal.clone();
                assert!(!crate::verify_event_shape(&invalid_hint));
                let response = crate::api::import_batch_by_cids(
                    axum::extract::State(state.clone()),
                    axum::http::HeaderMap::from_iter([(axum::http::header::HeaderName::from_static("x-archon-admin-key"), "ordinal-test".parse().unwrap())]),
                    axum::Json(json!({"cids": [vector["ids"][0]], "metadata": invalid_hint})),
                ).await;
                assert_eq!(response.status(), axum::http::StatusCode::INTERNAL_SERVER_ERROR);
            }
        }
        let (state, _directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        let mut unpositioned = genesis.clone();
        unpositioned.as_object_mut().unwrap().remove("ordinal");
        let result =
            crate::import_batch_impl(&state, &crate::event_policy::relay_hints(&[unpositioned])).await;
        assert_eq!((result.queued, result.rejected), (1, 0));
        crate::process_events_impl(&state).await;
        let events = state.store.lock().await.get_events(did);
        assert_eq!(events[0].registry, "hyperswarm");
        assert!(events[0].registration.is_none());
    }
}

#[tokio::test]
async fn convergence_integrated_agents() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/integrated-agent-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        for scenario in vector["scenarios"].as_array().unwrap() {
            for order in scenario["orders"].as_array().unwrap() {
                let (mut state, _directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data: JsonDbFile::default(),
                    redis_connection: None,
                });
                for entry in vector["blocks"].as_array().unwrap() {
                    state
                        .store
                        .lock()
                        .await
                        .add_block(entry["registry"].as_str().unwrap(), entry["block"].clone())
                        .unwrap();
                }
                for token in order.as_array().unwrap() {
                    crate::import_batch_impl(
                        &state,
                        &[vector["events"][token.as_u64().unwrap() as usize].clone()],
                    )
                    .await;
                    crate::process_events_impl(&state).await;
                }
                let mut restart_directory = None;
                for phase in 0..3 {
                    if phase == 1 {
                        let events: Vec<_> = order
                            .as_array()
                            .unwrap()
                            .iter()
                            .rev()
                            .map(|token| vector["events"][token.as_u64().unwrap() as usize].clone())
                            .collect();
                        crate::import_batch_impl(&state, &events).await;
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
                    let resolved = crate::resolve_local_doc_async(
                        &state,
                        did,
                        ResolveOptions {
                            verify: true,
                            ..Default::default()
                        },
                    )
                    .await
                    .unwrap();
                    let expected: Vec<_> = scenario["expected"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|index| vector["ids"][index.as_u64().unwrap() as usize].clone())
                        .collect();
                    assert_eq!(
                        json!(state
                            .store
                            .lock()
                            .await
                            .get_events(did)
                            .iter()
                            .map(|e| &e.opid)
                            .collect::<Vec<_>>()),
                        json!(expected),
                        "{}, {order}, phase {phase}",
                        scenario["name"]
                    );
                    let history = state.store.lock().await.get_events(did);
                    let mut expected_registry = history[0].operation["registration"]["registry"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    let mut receipt_view = Vec::new();
                    for (index, event) in history.iter().enumerate() {
                        let matching = event.registry == expected_registry;
                        if index > 0 && !matching {
                            break;
                        }
                        let cutoff = if !matching {
                            json!({"kind": "unconfirmed"})
                        } else if crate::is_unanchored_registry(&event.registry) {
                            json!({"kind": "unanchored", "registry": event.registry,
                                "time": chrono::DateTime::parse_from_rfc3339(&event.time).unwrap().timestamp_millis()})
                        } else {
                            json!({"kind": "chain", "registry": event.registry, "ordinal": event.ordinal,
                                "time": chrono::DateTime::parse_from_rfc3339(&event.time).unwrap().timestamp_millis(),
                                "registration": event.registration.is_some()})
                        };
                        receipt_view.push(json!({"operation": event.opid, "matching": matching, "cutoff": cutoff}));
                        if let Some(registry) =
                            event.operation["doc"]["didDocumentRegistration"]["registry"].as_str()
                        {
                            expected_registry = registry.to_owned();
                        }
                    }
                    assert_eq!(json!(receipt_view), scenario["receiptView"]);
                    assert_eq!(
                        json!({"didDocument": resolved["didDocument"], "didDocumentData": resolved["didDocumentData"],
                        "didDocumentRegistration": resolved["didDocumentRegistration"]}),
                        scenario["components"]
                    );
                    assert_eq!(
                        resolved["didDocumentMetadata"]["deactivated"]
                            .as_bool()
                            .unwrap_or(false),
                        scenario["deactivated"].as_bool().unwrap()
                    );
                }
                drop(restart_directory);
            }
        }
    }
}

// Regresses the signed first-applicable pin-clock divergence.
#[tokio::test]
async fn convergence_pin_receipt_proof_time() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/pin-receipt-counterexample.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        let asset_did = vector["assetDid"].as_str().unwrap();
        let mut outcomes = Vec::new();
        let mut candidate_sets = Vec::new();
        for order in vector["orders"].as_array().unwrap() {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for index in order.as_array().unwrap() {
                let data = serde_json::from_value(
                    serde_json::to_value(&state.store.lock().await.data).unwrap(),
                )
                .unwrap();
                let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data,
                    redis_connection: None,
                });
                state = restarted;
                crate::import_batch_impl(
                    &state,
                    &[vector["events"][index.as_u64().unwrap() as usize].clone()],
                )
                .await;
                crate::process_events_impl(&state).await;
            }
            for _ in 0..2 {
                let data = serde_json::from_value(
                    serde_json::to_value(&state.store.lock().await.data).unwrap(),
                )
                .unwrap();
                let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data,
                    redis_connection: None,
                });
                state = restarted;
                crate::history::ensure_history_ready(&state).await.unwrap();
                crate::import_batch_impl(&state, &[vector["asset"].clone()]).await;
                crate::process_events_impl(&state).await;
                let store = state.store.lock().await;
                outcomes.push(store.get_events(asset_did).len());
                for event in &store.get_candidates().unwrap()[did] {
                    if event.registry == "pin" {
                        assert_eq!(
                            event.time,
                            event.operation["proof"]["created"].as_str().unwrap()
                        );
                    }
                }
                let mut candidates: Vec<_> = store.get_candidates().unwrap()[did]
                    .iter()
                    .map(|event| serde_json::to_string(event).unwrap())
                    .collect();
                candidates.sort();
                candidate_sets.push(candidates);
            }
        }
        assert_eq!(candidate_sets[0], candidate_sets[2]);
        assert_eq!(outcomes, vec![0, 0, 0, 0]);
        // Repair an actual pre-fix projection with the later pin receipt selected.
        let mut db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        let retained: Vec<_> = vector["events"]
            .as_array()
            .unwrap()
            .iter()
            .map(|event| {
                let mut value = event.clone();
                value["did"] = json!(did);
                value["opid"] = json!(crate::generate_json_cid(&event["operation"]).unwrap());
                crate::value_to_event_record(&value)
            })
            .collect();
        let mut asset = vector["asset"].clone();
        asset["did"] = json!(asset_did);
        asset["opid"] = json!(crate::generate_json_cid(&asset["operation"]).unwrap());
        let asset = crate::value_to_event_record(&asset);
        db.set_candidates(did, retained.clone()).unwrap();
        db.set_events(
            did,
            vec![
                retained[0].clone(),
                retained[3].clone(),
                retained[4].clone(),
            ],
        )
        .unwrap();
        db.set_candidates(asset_did, vec![asset.clone()]).unwrap();
        db.set_events(asset_did, vec![asset]).unwrap();
        let (state, _directory) = crate::tests::make_state(db);
        crate::history::ensure_history_ready(&state).await.unwrap();
        let store = state.store.lock().await;
        assert!(store.get_events(asset_did).is_empty());
        let candidates = store.get_candidates().unwrap();
        for (old, repaired) in retained.iter().zip(&candidates[did]) {
            assert_eq!(old.operation, repaired.operation);
            if repaired.registry == "pin" {
                assert_eq!(
                    repaired.time,
                    repaired.operation["proof"]["created"].as_str().unwrap()
                );
            }
        }
    }
}

#[tokio::test]
async fn convergence_assets_with_controller_recovery() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/asset-vectors.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let did = vector["did"].as_str().unwrap();
        let stages = vector["stages"].as_array().unwrap();
        let mut scenarios: Vec<Vec<&Value>> = stages.iter().map(|stage| vec![stage]).collect();
        scenarios.push(
            vector["transitions"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| stages.iter().find(|stage| &stage["name"] == name).unwrap())
                .collect(),
        );
        for scenario in scenarios {
            for order_index in 0..3 {
                let directory = tempfile::tempdir().unwrap();
                let path = directory.path().join("assets.json");
                let (mut state, mut state_directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::JsonFile { path: path.clone() },
                    data: JsonDbFile::default(),
                    redis_connection: None,
                });
                for entry in vector["blocks"].as_array().unwrap() {
                    state
                        .store
                        .lock()
                        .await
                        .add_block(entry["registry"].as_str().unwrap(), entry["block"].clone())
                        .unwrap();
                }
                for stage in &scenario {
                    let order = stage["orders"][order_index].as_array().unwrap();
                    for index in order {
                        let event = vector["events"][index.as_u64().unwrap() as usize].clone();
                        let mut weak = event.clone();
                        weak.as_object_mut().unwrap().remove("registration");
                        let copies = if event.get("registration").is_some()
                            && !crate::is_unanchored_registry(event["registry"].as_str().unwrap()) {
                            if order_index == 1 { vec![event, weak] } else { vec![weak, event] }
                        } else { vec![event] };
                        for copy in copies {
                            crate::import_batch_impl(&state, &[copy]).await;
                            crate::process_events_impl(&state).await;
                        }
                    }
                    for phase in 0..3 {
                        if phase == 1 {
                            let events: Vec<_> = order
                                .iter()
                                .rev()
                                .map(|i| vector["events"][i.as_u64().unwrap() as usize].clone())
                                .collect();
                            crate::import_batch_impl(&state, &events).await;
                            crate::process_events_impl(&state).await;
                        }
                        if phase == 2 {
                            // Read persisted bytes, not an in-memory clone of the previous store.
                            let data =
                                serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                            let (restarted, restarted_directory) =
                                crate::tests::make_state(JsonDb {
                                    backend: DbBackend::JsonFile { path: path.clone() },
                                    data,
                                    redis_connection: None,
                                });
                            state = restarted;
                            state_directory = restarted_directory;
                        }
                        crate::history::ensure_history_ready(&state).await.unwrap();
                        let resolved = crate::resolve_local_doc_async(
                            &state,
                            did,
                            ResolveOptions {
                                verify: true,
                                ..Default::default()
                            },
                        )
                        .await;
                        let resolved = if stage["components"].is_null() {
                            assert!(
                                format!("{:#}", resolved.unwrap_err()).contains("DID not found")
                            );
                            json!({"didResolutionMetadata": {"error": "notFound"}})
                        } else {
                            resolved.unwrap()
                        };
                        let store = state.store.lock().await;
                        let history = store.get_events(did);
                        let expected: Vec<_> = stage["expected"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .map(|i| vector["ids"][i.as_u64().unwrap() as usize].clone())
                            .collect();
                        let context = format!(
                            "{} legacy={} stage={} order={} phase={}",
                            vector["mode"], vector["legacy"], stage["name"], order_index, phase
                        );
                        assert_eq!(
                            json!(history.iter().map(|e| &e.opid).collect::<Vec<_>>()),
                            json!(expected),
                            "{context}"
                        );
                        if !stage["components"].is_null() {
                            assert_eq!(
                                json!({"didDocument": resolved["didDocument"], "didDocumentData": resolved["didDocumentData"], "didDocumentRegistration": resolved["didDocumentRegistration"]}),
                                stage["components"],
                                "{context}"
                            );
                            assert_eq!(
                                resolved["didDocumentMetadata"]["deactivated"]
                                    .as_bool()
                                    .unwrap_or(false),
                                stage["deactivated"].as_bool().unwrap(),
                                "{context}"
                            );
                        } else {
                            assert_eq!(
                                resolved["didResolutionMetadata"]["error"], "notFound",
                                "{context}"
                            );
                        }
                        let candidates = store.get_candidates().unwrap();
                        let retained = candidates.get(did).unwrap();
                        for index in stage["evidence"].as_array().unwrap() {
                            let op =
                                &vector["events"][index.as_u64().unwrap() as usize]["operation"];
                            if op["did"] == did
                                || op["type"] == "create" && op["registration"]["type"] == "asset"
                            {
                                assert!(
                                    retained.iter().any(|event| event.operation == *op),
                                    "lost candidate {context}"
                                );
                            }
                        }
                    }
                }
                drop(state_directory);
            }
        }
    }
}

// Local receipt normalization preserves signed history and repairs authorization.
#[tokio::test]
async fn convergence_local_receipt_clock_audit() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/local-receipt-counterexample.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let mut outcomes = Vec::new();
        let did = vector["did"].as_str().unwrap();
        let asset_did = vector["assetDid"].as_str().unwrap();
        for order in vector["orders"].as_array().unwrap() {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for index in order.as_array().unwrap() {
                crate::import_batch_impl(
                    &state,
                    &[vector["events"][index.as_u64().unwrap() as usize].clone()],
                )
                .await;
                crate::process_events_impl(&state).await;
            }
            for _ in 0..2 {
                let data = serde_json::from_value(
                    serde_json::to_value(&state.store.lock().await.data).unwrap(),
                )
                .unwrap();
                let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory,
                    data,
                    redis_connection: None,
                });
                state = restarted;
                crate::history::ensure_history_ready(&state).await.unwrap();
                crate::import_batch_impl(&state, &[vector["asset"].clone()]).await;
                crate::process_events_impl(&state).await;
                let store = state.store.lock().await;
                let accepted = store.get_events(did);
                assert_eq!(accepted.len(), 3);
                for (index, event) in accepted.iter().enumerate() {
                    assert_eq!(event.operation, vector["events"][index]["operation"]);
                    assert_eq!(event.opid, Some(crate::generate_json_cid(&event.operation).unwrap()));
                    let time = if event.operation["type"] == "create" {
                        &event.operation["created"]
                    } else {
                        &event.operation["proof"]["created"]
                    };
                    assert_eq!(event.time, time.as_str().unwrap());
                }
                outcomes.push(store.get_events(asset_did).len());
            }
            crate::import_batch_impl(&state, &[vector["deletion"].clone()]).await;
            crate::process_events_impl(&state).await;
            let store = state.store.lock().await;
            let deleted = store.get_events(did);
            assert_eq!(deleted.len(), 4);
            assert_eq!(deleted[3].operation, vector["deletion"]["operation"]);
            assert_eq!(deleted[3].time, vector["deletion"]["operation"]["proof"]["created"].as_str().unwrap());
        }
        assert_eq!(outcomes, vec![0, 0, 0, 0]);
        let mut db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        let retained: Vec<_> = [0, 1, 4].iter().map(|index| {
            let mut value = vector["events"][*index].clone();
            value["did"] = json!(did);
            value["opid"] = json!(crate::generate_json_cid(&value["operation"]).unwrap());
            crate::value_to_event_record(&value)
        }).collect();
        let mut asset = vector["asset"].clone();
        asset["did"] = json!(asset_did);
        asset["opid"] = json!(crate::generate_json_cid(&asset["operation"]).unwrap());
        let asset = crate::value_to_event_record(&asset);
        db.set_candidates(did, retained.clone()).unwrap();
        db.set_events(did, retained.clone()).unwrap();
        db.set_candidates(asset_did, vec![asset.clone()]).unwrap();
        db.set_events(asset_did, vec![asset]).unwrap();
        let (state, _directory) = crate::tests::make_state(db);
        crate::history::ensure_history_ready(&state).await.unwrap();
        let store = state.store.lock().await;
        assert!(store.get_events(asset_did).is_empty());
        let candidates = store.get_candidates().unwrap();
        assert_eq!(candidates[did].len(), retained.len());
        for (old, repaired) in retained.iter().zip(&candidates[did]) {
            assert_eq!(old.operation, repaired.operation);
            assert_eq!(old.opid, repaired.opid);
            assert_eq!(old.ordinal, repaired.ordinal);
            let time = if repaired.operation["type"] == "create" {
                &repaired.operation["created"]
            } else {
                &repaired.operation["proof"]["created"]
            };
            assert_eq!(repaired.time, time.as_str().unwrap());
        }
    }
}

// Unanchored registration metadata cannot supply chain context.
#[tokio::test]
async fn convergence_local_registration_metadata_audit() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/local-registration-counterexample.json"
    ))
    .unwrap();
    for vector in vectors.as_array().unwrap() {
        let mut outcomes = Vec::new();
        for order in [[0, 1], [1, 0]] {
            let (state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for event in vector["events"].as_array().unwrap() {
                crate::import_batch_impl(&state, &[event.clone()]).await;
                crate::process_events_impl(&state).await;
            }
            for index in order {
                crate::import_batch_impl(&state, &[vector["receipts"][index].clone()]).await;
                crate::process_events_impl(&state).await;
            }
            assert!(state.store.lock().await.get_events(vector["assetDid"].as_str().unwrap()).is_empty());
            let data = serde_json::from_value(
                serde_json::to_value(&state.store.lock().await.data).unwrap(),
            ).unwrap();
            let (state, _restart) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data,
                redis_connection: None,
            });
            crate::history::ensure_history_ready(&state).await.unwrap();
            let store = state.store.lock().await;
            let agents = store.get_events(vector["did"].as_str().unwrap());
            assert_eq!(agents.len(), 3);
            for (index, event) in agents.iter().enumerate() {
                assert_eq!(event.operation, vector["events"][index]["operation"]);
            }
            let did = vector["assetDid"].as_str().unwrap();
            let candidates = store.get_candidates().unwrap();
            assert_eq!(candidates[did].len(), 1);
            assert_eq!(candidates[did][0].operation, vector["receipts"][0]["operation"]);
            outcomes.push(store.get_events(did).len());
        }
        assert_eq!(outcomes, vec![0, 0]);
        let mut db = JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        };
        let did = vector["did"].as_str().unwrap();
        let asset_did = vector["assetDid"].as_str().unwrap();
        let retained: Vec<_> = vector["events"].as_array().unwrap().iter().map(|event| {
            let mut value = event.clone();
            value["did"] = json!(did);
            value["opid"] = json!(crate::generate_json_cid(&value["operation"]).unwrap());
            crate::value_to_event_record(&value)
        }).collect();
        let mut asset = vector["receipts"][1].clone();
        asset["did"] = json!(asset_did);
        asset["opid"] = json!(crate::generate_json_cid(&asset["operation"]).unwrap());
        let asset = crate::value_to_event_record(&asset);
        db.set_candidates(did, retained.clone()).unwrap();
        db.set_events(did, retained).unwrap();
        db.set_candidates(asset_did, vec![asset.clone()]).unwrap();
        db.set_events(asset_did, vec![asset.clone()]).unwrap();
        let (state, _directory) = crate::tests::make_state(db);
        crate::history::ensure_history_ready(&state).await.unwrap();
        let store = state.store.lock().await;
        assert!(store.get_events(asset_did).is_empty());
        assert_eq!(serde_json::to_value(&store.get_candidates().unwrap()[asset_did]).unwrap(),
            serde_json::to_value(vec![asset]).unwrap());
    }
}

#[tokio::test]
async fn convergence_direct_local_creation_clock() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/local-receipt-counterexample.json"
    )).unwrap();
    for vector in vectors.as_array().unwrap() {
        let (state, _directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        let operation = &vector["events"][0]["operation"];
        assert_ne!(operation["created"], operation["proof"]["created"]);
        let result = crate::events::handle_did_operation(&state, operation).await.unwrap();
        assert_eq!(result, vector["did"]);
        let store = state.store.lock().await;
        let accepted = store.get_events(vector["did"].as_str().unwrap());
        assert_eq!(accepted.len(), 1);
        assert_eq!(&accepted[0].operation, operation);
        assert_eq!(accepted[0].time, operation["created"].as_str().unwrap());
    }
}

#[tokio::test]
async fn convergence_local_receipt_of_chain_genesis() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/local-receipt-counterexample.json"
    )).unwrap();
    for vector in vectors.as_array().unwrap() {
        let (mut state, _directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        state.supported_registries.lock().await.push("BTC:signet".to_string());
        let operation = &vector["nonlocalGenesis"];
        let did = vector["nonlocalDid"].as_str().unwrap();
        assert_ne!(operation["created"], operation["proof"]["created"]);
        assert_eq!(crate::events::handle_did_operation(&state, operation).await.unwrap(), vector["nonlocalDid"]);
        for _ in 0..2 {
            let data = {
                let store = state.store.lock().await;
                let accepted = store.get_events(did);
                assert_eq!(accepted.len(), 1);
                assert_eq!(accepted[0].registry, "local");
                assert_eq!(accepted[0].time, operation["created"].as_str().unwrap());
                assert_eq!(&accepted[0].operation, operation);
                let doc = store.resolve_doc(&state.config, did, crate::ResolveOptions {
                    confirm: true, ..Default::default()
                }).unwrap();
                // Genesis admission does not establish matching chain authority.
                assert_eq!(doc["didDocumentMetadata"]["confirmed"], true);
                assert_ne!(accepted[0].registry, doc["didDocumentRegistration"]["registry"].as_str().unwrap());
                assert_eq!(doc["didDocument"]["id"], did);
                serde_json::from_value(serde_json::to_value(&store.data).unwrap()).unwrap()
            };
            let (restarted, _restart) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory, data, redis_connection: None,
            });
            state = restarted;
            crate::history::ensure_history_ready(&state).await.unwrap();
        }
    }
}

// Metadata-bearing copies win at the same chain position before authorization.
#[tokio::test]
async fn convergence_chain_registration_metadata_audit() {
    let vectors: Value = serde_json::from_str(include_str!(
        "../../../../tests/convergence/chain-registration-counterexample.json"
    )).unwrap();
    for vector in vectors.as_array().unwrap() {
        let mut outcomes = Vec::new();
        for order in [[0, 1], [1, 0]] {
            let (state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory,
                data: JsonDbFile::default(),
                redis_connection: None,
            });
            for index in order {
                crate::import_batch_impl(&state, &[vector["genesis"][index].clone()]).await;
                crate::process_events_impl(&state).await;
            }
            for event in vector["events"].as_array().unwrap().iter().chain(std::iter::once(&vector["asset"])) {
                crate::import_batch_impl(&state, &[event.clone()]).await;
                crate::process_events_impl(&state).await;
            }
            let asset_did = vector["assetDid"].as_str().unwrap();
            let data = {
                let store = state.store.lock().await;
                let agents = store.get_events(vector["did"].as_str().unwrap());
                assert_eq!(agents.len(), 3);
                assert_eq!(agents[0].operation, vector["genesis"][0]["operation"]);
                for (event, original) in agents[1..].iter().zip(vector["events"].as_array().unwrap()) {
                    assert_eq!(event.operation, original["operation"]);
                }
                outcomes.push(store.get_events(asset_did).len());
                serde_json::from_value(serde_json::to_value(&store.data).unwrap()).unwrap()
            };
            let (state, _restart) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory, data, redis_connection: None,
            });
            crate::history::ensure_history_ready(&state).await.unwrap();
            outcomes.push(state.store.lock().await.get_events(asset_did).len());
        }
        assert_eq!(outcomes, vec![1, 1, 1, 1]);
        for order in [[0, 1], [1, 0]] {
            let (mut state, _directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::Memory, data: JsonDbFile::default(), redis_connection: None,
            });
            for event in std::iter::once(&vector["genesis"][1]).chain(vector["events"].as_array().unwrap()) {
                crate::import_batch_impl(&state, &[event.clone()]).await;
                crate::process_events_impl(&state).await;
            }
            for index in order {
                crate::import_batch_impl(&state, &[vector["lateReceipts"][index].clone()]).await;
                crate::process_events_impl(&state).await;
            }
            for _ in 0..2 {
                let data = {
                    let store = state.store.lock().await;
                    let did = vector["lateAssetDid"].as_str().unwrap();
                    assert!(store.get_events(did).is_empty());
                    let candidates = store.get_candidates().unwrap();
                    assert_eq!(candidates[did].len(), 1);
                    assert_eq!(candidates[did][0].registration.as_ref(), Some(&vector["lateReceipts"][1]["registration"]));
                    assert_eq!(candidates[did][0].operation, vector["lateReceipts"][1]["operation"]);
                    serde_json::from_value(serde_json::to_value(&store.data).unwrap()).unwrap()
                };
                let (restarted, _restart) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::Memory, data, redis_connection: None,
                });
                state = restarted;
                crate::history::ensure_history_ready(&state).await.unwrap();
            }
        }
    }
}

mod method_ids;
