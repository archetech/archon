use crate::store::{DbBackend, JsonDbFile};
use crate::{GatekeeperDb, JsonDb};
use serde_json::{json, Value};

fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../../../tests/convergence/event-target-vectors.json"
    ))
    .unwrap()
}

fn memory() -> JsonDb {
    JsonDb {
        backend: DbBackend::Memory,
        data: JsonDbFile::default(),
        redis_connection: None,
    }
}

fn hint(operation: &Value, did: Option<&str>) -> Value {
    let mut event = json!({ "registry": "hyperswarm", "time": operation["proof"]["created"], "operation": operation });
    if let Some(did) = did {
        event["did"] = json!(did);
    }
    event
}

#[tokio::test]
async fn binds_targets_before_queue_deduplication() {
    for v in vectors() {
        let did = v["did"].as_str().unwrap();
        let wrong = v["otherDid"].as_str().unwrap();
        for relay in [false, true] {
            for explicit in [false, true] {
                let (state, _directory) = crate::tests::make_state(memory());
                for (i, op) in v["operations"].as_array().unwrap().iter().enumerate() {
                    let bad = hint(op, Some(wrong));
                    let bad = if relay {
                        crate::events::relay_hints(&[bad])
                    } else {
                        vec![bad]
                    };
                    let result = crate::import_batch_impl(&state, &bad).await;
                    assert_eq!((result.rejected, result.queued), (1, 0), "{}", v["name"]);
                    let good = hint(op, explicit.then_some(did));
                    let good = if relay {
                        crate::events::relay_hints(&[good])
                    } else {
                        vec![good]
                    };
                    assert_eq!(crate::import_batch_impl(&state, &good).await.queued, 1);
                    crate::process_events_impl(&state).await;
                    let store = state.store.lock().await;
                    let ids: Vec<_> = store
                        .get_events(did)
                        .iter()
                        .map(|e| json!(e.opid))
                        .collect();
                    assert_eq!(ids, v["ids"].as_array().unwrap()[..=i]);
                    assert!(store.get_events(wrong).is_empty());
                    assert_eq!(store.get_candidates().unwrap().len(), 1);
                }
            }
        }
    }
}

#[tokio::test]
async fn conflicting_genesis_converges_through_durable_restart() {
    for v in vectors() {
        for reverse in [false, true] {
            let did = v["did"].as_str().unwrap();
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("target.json");
            let (mut state, _state_directory) = crate::tests::make_state(JsonDb {
                backend: DbBackend::JsonFile { path: path.clone() },
                ..memory()
            });
            let mut bad = hint(&v["other"], Some(did));
            bad["opid"] = v["ids"][0].clone();
            let mut events = vec![bad, hint(&v["operations"][0], Some(did))];
            if reverse {
                events.reverse();
            }
            for event in events {
                crate::import_batch_impl(&state, &crate::events::relay_hints(&[event])).await;
                crate::process_events_impl(&state).await;
            }
            for _ in 0..2 {
                crate::history::ensure_history_ready(&state).await.unwrap();
                let store = state.store.lock().await;
                let events = store.get_events(did);
                assert_eq!(events.len(), 1, "{}", v["name"]);
                assert_eq!(events[0].operation, v["operations"][0]);
                assert_eq!(events[0].opid.as_deref(), v["ids"][0].as_str());
                assert_eq!(store.get_candidates().unwrap()[did].len(), 1);
                drop(store);
                let (restarted, _restart_directory) = crate::tests::make_state(JsonDb {
                    backend: DbBackend::JsonFile { path: path.clone() },
                    data: serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap(),
                    redis_connection: None,
                });
                state = restarted;
            }
        }
    }
}

#[tokio::test]
async fn direct_and_imported_creation_use_the_same_identity() {
    for v in vectors() {
        let (state, _directory) = crate::tests::make_state(memory());
        for op in v["operations"].as_array().unwrap() {
            assert!(
                crate::events::handle_did_operation(&state, op)
                    .await
                    .is_ok(),
                "{}",
                v["name"]
            );
        }
        assert_eq!(
            crate::events::handle_did_operation(&state, &v["createWithDid"])
                .await
                .unwrap(),
            v["createWithDidTarget"]
        );
        let (imported, _import_directory) = crate::tests::make_state(memory());
        let bad = hint(&v["createWithDid"], v["otherDid"].as_str());
        assert_eq!(
            crate::import_batch_impl(&imported, &[bad]).await.rejected,
            1
        );
        crate::import_batch_impl(&imported, &[hint(&v["createWithDid"], None)]).await;
        crate::process_events_impl(&imported).await;
        assert_eq!(
            imported
                .store
                .lock()
                .await
                .get_events(v["createWithDidTarget"].as_str().unwrap())
                .len(),
            1
        );
    }
}

#[tokio::test]
async fn checks_targets_in_per_event_replay_importer() {
    for v in vectors() {
        let (state, _directory) = crate::tests::make_state(memory());
        for op in v["operations"].as_array().unwrap() {
            let bad = crate::value_to_event_record(&hint(op, v["otherDid"].as_str()));
            assert!(matches!(
                crate::events::import_event_once(&state, bad).await,
                crate::events::ImportStatus::Rejected
            ));
            let good = crate::value_to_event_record(&hint(op, v["did"].as_str()));
            assert!(matches!(
                crate::events::import_event_once(&state, good).await,
                crate::events::ImportStatus::Added
            ));
        }
        let store = state.store.lock().await;
        assert_eq!(store.get_events(v["did"].as_str().unwrap()).len(), 3);
        assert!(store.get_events(v["otherDid"].as_str().unwrap()).is_empty());
    }
}
