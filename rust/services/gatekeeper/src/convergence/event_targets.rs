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

fn stored(operation: &Value, did: Option<&str>) -> crate::EventRecord {
    let mut event = hint(operation, did);
    event["opid"] = json!(crate::generate_json_cid(operation).unwrap());
    crate::value_to_event_record(&event)
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
async fn removes_misaddressed_stored_evidence_before_replay() {
    for v in vectors() {
        for journal in [false, true] {
            for envelope in ["wrong", "correct", "omitted"] {
                let did = v["did"].as_str().unwrap();
                let wrong = v["otherDid"].as_str().unwrap();
                let mut db = memory();
                let claimed = match envelope {
                    "wrong" => Some(wrong),
                    "correct" => Some(did),
                    _ => None,
                };
                let bad: Vec<_> = v["operations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|op| stored(op, claimed))
                    .collect();
                db.set_events(wrong, bad.clone()).unwrap();
                if journal {
                    let mut retained = bad;
                    retained.push(stored(&v["other"], Some(wrong)));
                    db.set_candidates(wrong, retained).unwrap();
                }
                let valid = v["operations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|op| stored(op, Some(did)))
                    .collect();
                db.set_events(did, valid).unwrap();
                let (state, _directory) = crate::tests::make_state(db);
                crate::history::ensure_history_ready(&state).await.unwrap();
                let store = state.store.lock().await;
                let accepted: Vec<_> = store
                    .get_events(did)
                    .iter()
                    .map(|e| e.operation.clone())
                    .collect();
                assert_eq!(json!(accepted), v["operations"], "{} {envelope}", v["name"]);
                let expected = if journal {
                    vec![v["other"].clone()]
                } else {
                    vec![]
                };
                assert_eq!(
                    store
                        .get_events(wrong)
                        .iter()
                        .map(|e| e.operation.clone())
                        .collect::<Vec<_>>(),
                    expected
                );
                assert_eq!(
                    store
                        .get_candidates()
                        .unwrap()
                        .get(wrong)
                        .into_iter()
                        .flatten()
                        .map(|e| e.operation.clone())
                        .collect::<Vec<_>>(),
                    expected
                );
                assert_eq!(
                    store
                        .get_candidates()
                        .unwrap()
                        .values()
                        .map(Vec::len)
                        .sum::<usize>(),
                    v["operations"].as_array().unwrap().len() + usize::from(journal)
                );
            }
        }
    }
}

#[tokio::test]
async fn rejected_prefix_alias_cannot_erase_canonical_history() {
    for v in vectors() {
        for (published, journal) in [(false, true), (true, true), (true, false)] {
            let did = v["did"].as_str().unwrap();
            let alias = v["aliasDid"].as_str().unwrap();
            let mut db = memory();
            let good = stored(&v["operations"][0], Some(did));
            if journal {
                db.set_candidates(did, vec![good.clone()]).unwrap();
            }
            db.set_candidates(alias, vec![stored(&v["operations"][0], Some(alias))])
                .unwrap();
            if published {
                db.set_events(did, vec![good]).unwrap();
            }
            let (state, _directory) = crate::tests::make_state(db);
            crate::history::ensure_history_ready(&state).await.unwrap();
            {
                let store = state.store.lock().await;
                assert_eq!(store.get_events(did).len(), 1);
                assert_eq!(store.get_events(did)[0].operation, v["operations"][0]);
                assert!(store.get_candidates().unwrap()[alias].is_empty());
            }
            let resolved =
                crate::resolve_local_doc_async(&state, alias, crate::ResolveOptions::default())
                    .await
                    .unwrap();
            assert_eq!(resolved["didDocument"]["id"], alias);
            assert!(
                crate::events::handle_did_operation(&state, &v["aliasUpdate"])
                    .await
                    .is_err()
            );
            crate::import_batch_impl(&state, &[hint(&v["aliasUpdate"], None)]).await;
            let result = crate::process_events_impl(&state).await;
            assert_eq!(result.rejected, Some(1));
            assert_eq!(result.added, Some(0));
            let store = state.store.lock().await;
            assert_eq!(store.get_events(did).len(), 1);
            assert_eq!(store.get_events(did)[0].operation, v["operations"][0]);
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
