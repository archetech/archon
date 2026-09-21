use crate::store::{DbBackend, JsonDbFile};
use crate::{GatekeeperDb, JsonDb};
use serde_json::{json, Value};

fn vectors() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../../../tests/convergence/chain-registration-counterexample.json"
    ))
    .unwrap()
}
fn malformed() -> Vec<Value> {
    serde_json::from_str(include_str!(
        "../../../../../tests/convergence/invalid-chain-metadata.json"
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

#[tokio::test]
async fn complete_metadata_is_required_before_dedup_and_replay() {
    for v in vectors() {
        for invalid in malformed() {
            let (state, _directory) = crate::tests::make_state(memory());
            let good = v["genesis"][1].clone();
            let mut bad = good.clone();
            if let Some(registration) = invalid.get("registration") {
                bad["registration"] = registration.clone();
            } else {
                bad.as_object_mut().unwrap().remove("registration");
            }
            let result = crate::import_batch_impl(&state, &[bad.clone()]).await;
            assert_eq!(
                (result.queued, result.rejected),
                (0, 1),
                "{}",
                invalid["name"]
            );
            assert!(matches!(
                crate::events::import_event_once(&state, crate::value_to_event_record(&bad)).await,
                crate::events::ImportStatus::Rejected
            ));
            assert!(state
                .store
                .lock()
                .await
                .get_candidates()
                .unwrap()
                .is_empty());
            assert_eq!(crate::import_batch_impl(&state, &[good]).await.queued, 1);
            crate::process_events_impl(&state).await;
            assert_eq!(
                state
                    .store
                    .lock()
                    .await
                    .get_events(v["did"].as_str().unwrap())
                    .len(),
                1
            );
            assert_eq!(
                crate::import_batch_impl(&state, &crate::events::relay_hints(&[bad]))
                    .await
                    .rejected,
                0
            );
        }
    }
}

#[tokio::test]
async fn cid_ingress_checks_metadata_before_fetch_and_keeps_original_index() {
    for v in vectors() {
        let (mut state, _directory) = crate::tests::make_state(memory());
        state.config.admin_api_key = "metadata-test".to_string();
        let headers = axum::http::HeaderMap::from_iter([(
            axum::http::header::HeaderName::from_static("x-archon-admin-key"),
            "metadata-test".parse().unwrap(),
        )]);
        let good = v["genesis"][1].clone();
        let cid = crate::generate_json_cid(&good["operation"]).unwrap();
        for invalid in malformed() {
            let name = invalid["name"].as_str().unwrap();
            if name.starts_with("opidx-") || name == "missing-opidx" {
                continue;
            }
            let mut metadata = good.clone();
            metadata["ordinal"] = json!([1, 0]);
            if let Some(registration) = invalid.get("registration") {
                metadata["registration"] = registration.clone();
            } else {
                metadata.as_object_mut().unwrap().remove("registration");
            }
            let response = crate::api::import_batch_by_cids(
                axum::extract::State(state.clone()),
                headers.clone(),
                axum::Json(json!({"cids": [cid], "metadata": metadata})),
            )
            .await;
            assert_eq!(
                response.status(),
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "{name}"
            );
            assert!(state.store.lock().await.get_operation(&cid).is_none());
        }
        state
            .store
            .lock()
            .await
            .add_operation(&cid, good["operation"].clone())
            .unwrap();
        for registry in [
            "BTC:signet",
            "ZEC:testnet",
            "ETH:sepolia",
            "SOL:devnet",
            "future:chain",
        ] {
            let mut metadata = good.clone();
            metadata["registry"] = json!(registry);
            metadata["ordinal"] = json!([1, 0, 7]);
            let response = crate::api::import_batch_by_cids(
                axum::extract::State(state.clone()),
                headers.clone(),
                axum::Json(json!({"cids": [null, cid], "metadata": metadata})),
            )
            .await;
            assert_eq!(response.status(), axum::http::StatusCode::OK);
            crate::process_events_impl(&state).await;
            let candidates = state.store.lock().await.get_candidates().unwrap();
            let event = candidates[v["did"].as_str().unwrap()]
                .iter()
                .find(|e| e.registry == registry)
                .unwrap();
            assert_eq!(event.ordinal, Some(vec![1, 0, 7, 1]));
            assert_eq!(event.registration.as_ref().unwrap()["opidx"], 1);
        }
    }
}
