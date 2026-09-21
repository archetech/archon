use crate::store::{DbBackend, JsonDbFile};
use crate::{GatekeeperDb, JsonDb};
use serde_json::{json, Value};

#[tokio::test]
async fn method_id_admission_submission_import_and_restart() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!(
        "../../../../../tests/convergence/method-id-vectors.json"
    )).unwrap();
    for v in vectors {
        for direct in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("methods.json");
            let open = || JsonDb {
                backend: DbBackend::JsonFile { path: path.clone() },
                data: JsonDbFile::default(),
                redis_connection: None,
            };
            let (mut state, _state_dir) = crate::tests::make_state(open());
            let hint = |op: &Value| json!({
                "registry": "hyperswarm", "time": op["proof"]["created"], "operation": op
            });
            for op in v["setup"].as_array().unwrap() {
                if direct {
                    crate::events::handle_did_operation(&state, op).await.unwrap();
                } else {
                    crate::import_batch_impl(&state, &[hint(op)]).await;
                    crate::process_events_impl(&state).await;
                }
            }
            let accepted = v["accepted"].as_bool().unwrap();
            if direct {
                let result = crate::events::handle_did_operation(&state, &v["update"]).await;
                assert_eq!(result.is_ok(), accepted, "{}", v["name"]);
                if accepted {
                    crate::events::handle_did_operation(&state, &v["successor"]).await.unwrap();
                }
            } else {
                crate::import_batch_impl(&state, &[hint(&v["update"])]).await;
                crate::process_events_impl(&state).await;
                if accepted {
                    crate::import_batch_impl(&state, &[hint(&v["successor"])]).await;
                    crate::process_events_impl(&state).await;
                }
            }
            for _ in 0..2 {
                crate::history::ensure_history_ready(&state).await.unwrap();
                let ids: Vec<_> = state.store.lock().await.get_events(v["did"].as_str().unwrap())
                    .iter().map(|e| json!(e.opid)).collect();
                assert_eq!(json!(ids), v["ids"], "{}", v["name"]);
                let mut db = open();
                db.data = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                state = crate::tests::make_state(db).0;
            }
        }
    }
}
