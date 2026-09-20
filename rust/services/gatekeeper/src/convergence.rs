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
            "registration": {"height": 100, "txid": "ordinal-audit", "batch": did, "opidx": 0}
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
        let response = crate::api::import_batch_by_cids(
            axum::extract::State(state.clone()),
            axum::http::HeaderMap::from_iter([(
                axum::http::header::HeaderName::from_static("x-archon-admin-key"),
                "ordinal-test".parse().unwrap(),
            )]),
            axum::Json(json!({"cids": [vector["ids"][0]], "metadata": metadata})),
        )
        .await;
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        crate::process_events_impl(&state).await;
        assert_eq!(
            state.store.lock().await.get_events(did)[0].ordinal,
            Some(vec![1_099_511_627_776, 1, 0])
        );
        for registry in ["local", "hyperswarm", "pin"] {
            let mut hint = genesis.clone();
            hint["registry"] = json!(registry);
            hint.as_object_mut().unwrap().remove("ordinal");
            assert!(crate::verify_event_shape(&hint));
        }
        let (state, _directory) = crate::tests::make_state(JsonDb {
            backend: DbBackend::Memory,
            data: JsonDbFile::default(),
            redis_connection: None,
        });
        let mut unpositioned = genesis.clone();
        unpositioned.as_object_mut().unwrap().remove("ordinal");
        let result =
            crate::import_batch_impl(&state, &crate::events::relay_hints(&[unpositioned])).await;
        assert_eq!((result.queued, result.rejected), (1, 0));
        crate::process_events_impl(&state).await;
        let events = state.store.lock().await.get_events(did);
        assert_eq!(events[0].registry, "hyperswarm");
        assert!(events[0].registration.is_none());
    }
}
