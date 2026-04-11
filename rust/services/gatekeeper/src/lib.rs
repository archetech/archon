mod api;
mod app;
mod config;
mod events;
mod metrics;
mod proofs;
mod resolver;
mod store;

pub use app::run;

pub(crate) use api::is_valid_registry;
pub(crate) use app::AppState;
pub(crate) use config::Config;
pub(crate) use events::{handle_did_operation, import_batch_impl, process_events_impl};
pub(crate) use metrics::{normalize_path, record_metrics, Metrics};
pub(crate) use proofs::{
    ensure_event_opid, generate_did_from_operation, generate_json_cid, infer_event_did,
    verify_create_operation_impl, verify_event_shape, verify_operation_impl,
    verify_update_operation_impl,
};
pub(crate) use resolver::{
    check_dids_impl, query_docs_impl, refresh_metrics_snapshot, resolve_local_doc_async,
    search_docs_impl, start_background_tasks, update_metrics_from_check, verify_db_impl,
};
pub(crate) use store::{
    chrono_like_now, event_record_to_value, expected_registry_for_index, value_to_event_record,
    BlockLookup, EventRecord, GatekeeperDb, JsonDb, ResolveOptions,
};
#[cfg(test)]
mod tests {
    use super::*;
    use crate::proofs::{canonical_json, verify_proof_format};
    use crate::store::{
        compare_ordinals, hydrate_redis_event, redis_event_to_stored_value, DbBackend, JsonDbFile,
    };
    use serde_json::{json, Value};
    use std::{collections::HashMap, env, net::IpAddr, path::PathBuf};

    fn test_config() -> Config {
        Config {
            port: 0,
            bind_address: IpAddr::from([127, 0, 0, 1]),
            db: "json".to_string(),
            data_dir: PathBuf::new(),
            ipfs_url: String::new(),
            did_prefix: "did:cid".to_string(),
            registries: vec!["local".to_string(), "hyperswarm".to_string()],
            json_limit: 4 * 1024 * 1024,
            upload_limit: 10 * 1024 * 1024,
            gc_interval_minutes: 60,
            status_interval_minutes: 60,
            admin_api_key: String::new(),
            fallback_url: String::new(),
            fallback_timeout_ms: 0,
            max_queue_size: 100,
            git_commit: "test".to_string(),
            version: "test".to_string(),
        }
    }

    #[test]
    fn value_to_event_record_preserves_large_ordinals() {
        let record = value_to_event_record(&json!({
            "registry": "hyperswarm",
            "time": "2026-03-20T11:10:06.160Z",
            "ordinal": [1774005006160u64, 6],
            "opid": "bagaaieratestopid",
            "did": "did:cid:bagaaieratestdid"
        }));

        assert_eq!(record.ordinal, Some(vec![1774005006160, 6]));
    }

    #[test]
    fn hydrate_redis_event_restores_operation_from_op_store() {
        let raw = r#"{"registry":"hyperswarm","time":"2026-03-20T11:10:06.160Z","ordinal":[1774005006160,6],"did":"did:cid:bagaaiera4yheu3faxmc7kqpwpd3w2uj62psmy3giczzyrdf2ulnckg2e3hnq","opid":"bagaaiera4yheu3faxmc7kqpwpd3w2uj62psmy3giczzyrdf2ulnckg2e3hnq"}"#;
        let operation = json!({
            "type": "create",
            "created": "2026-03-20T11:10:06.160Z",
            "registration": {
                "version": 1,
                "type": "agent",
                "registry": "hyperswarm"
            },
            "publicJwk": {
                "kty": "EC",
                "crv": "secp256k1",
                "x": "test-x",
                "y": "test-y"
            }
        });
        let mut ops = HashMap::new();
        ops.insert(
            "bagaaiera4yheu3faxmc7kqpwpd3w2uj62psmy3giczzyrdf2ulnckg2e3hnq".to_string(),
            operation.clone(),
        );

        let event = hydrate_redis_event(raw, &ops).expect("event should decode");

        assert_eq!(event.ordinal, Some(vec![1774005006160, 6]));
        assert_eq!(
            event.opid.as_deref(),
            Some("bagaaiera4yheu3faxmc7kqpwpd3w2uj62psmy3giczzyrdf2ulnckg2e3hnq")
        );
        assert_eq!(event.operation, operation);
    }

    #[test]
    fn redis_event_storage_strips_embedded_operation_when_opid_present() {
        let event = EventRecord {
            registry: "hyperswarm".to_string(),
            time: "2026-03-20T11:10:06.160Z".to_string(),
            ordinal: Some(vec![1774005006160, 6]),
            operation: json!({ "type": "create" }),
            opid: Some("bagaaieratestopid".to_string()),
            did: Some("did:cid:bagaaieratestdid".to_string()),
        };

        let stored = redis_event_to_stored_value(&event);

        assert_eq!(stored.get("operation"), None);
        assert_eq!(
            stored.get("opid").and_then(Value::as_str),
            Some("bagaaieratestopid")
        );
        assert_eq!(
            stored
                .get("ordinal")
                .and_then(Value::as_array)
                .map(|a| a.len()),
            Some(2)
        );
    }

    #[test]
    fn redis_event_storage_keeps_operation_when_no_opid_exists() {
        let event = EventRecord {
            registry: "local".to_string(),
            time: "2026-04-11T12:00:00.000Z".to_string(),
            ordinal: Some(vec![0]),
            operation: json!({ "type": "create", "created": "2026-04-11T12:00:00.000Z" }),
            opid: None,
            did: Some("did:cid:bagaaieralocal".to_string()),
        };

        let stored = redis_event_to_stored_value(&event);

        assert_eq!(
            stored
                .get("operation")
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str),
            Some("create")
        );
        assert_eq!(stored.get("opid"), None);
    }

    #[test]
    fn compare_ordinals_handles_large_values_lexicographically() {
        assert!(
            compare_ordinals(Some(&vec![1774005006160, 5]), Some(&vec![1774005006160, 6])).is_lt()
        );
        assert!(
            compare_ordinals(Some(&vec![1774005006161]), Some(&vec![1774005006160, 999])).is_gt()
        );
        assert!(
            compare_ordinals(Some(&vec![1774005006160, 6]), Some(&vec![1774005006160, 6])).is_eq()
        );
    }

    #[test]
    fn env_parse_treats_empty_value_as_default() {
        unsafe {
            env::set_var("ARCHON_TEST_EMPTY_PARSE", "");
        }
        let parsed = crate::config::env_parse("ARCHON_TEST_EMPTY_PARSE", 42u64)
            .expect("parse should succeed");
        assert_eq!(parsed, 42);
        unsafe {
            env::remove_var("ARCHON_TEST_EMPTY_PARSE");
        }
    }

    #[test]
    fn env_var_or_default_treats_empty_value_as_default() {
        unsafe {
            env::set_var("ARCHON_TEST_EMPTY_STRING", "");
        }
        assert_eq!(
            crate::config::env_var_or_default("ARCHON_TEST_EMPTY_STRING", "fallback"),
            "fallback"
        );
        unsafe {
            env::remove_var("ARCHON_TEST_EMPTY_STRING");
        }
    }

    #[test]
    fn event_record_round_trips_through_value_conversion() {
        let original = EventRecord {
            registry: "hyperswarm".to_string(),
            time: "2026-04-11T12:34:56.000Z".to_string(),
            ordinal: Some(vec![1774005006160, 6]),
            operation: json!({ "type": "create", "registration": { "registry": "hyperswarm" } }),
            opid: Some("bagaaieratestopid".to_string()),
            did: Some("did:cid:bagaaieratestdid".to_string()),
        };

        let round_trip = value_to_event_record(&event_record_to_value(&original));

        assert_eq!(round_trip.registry, original.registry);
        assert_eq!(round_trip.time, original.time);
        assert_eq!(round_trip.ordinal, original.ordinal);
        assert_eq!(round_trip.operation, original.operation);
        assert_eq!(round_trip.opid, original.opid);
        assert_eq!(round_trip.did, original.did);
    }

    #[test]
    fn normalize_path_collapses_dynamic_segments_for_metrics() {
        assert_eq!(
            normalize_path("/api/v1/did/did:cid:bagaaieratest?confirm=true"),
            "/api/v1/did/:did"
        );
        assert_eq!(
            normalize_path("/api/v1/queue/hyperswarm/clear"),
            "/api/v1/queue/:registry/clear"
        );
        assert_eq!(
            normalize_path("/api/v1/block/BTC:signet/latest"),
            "/api/v1/block/:registry/latest"
        );
    }

    #[test]
    fn canonical_json_and_cid_match_shared_deterministic_vector() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/deterministic-vectors.json"
        ))
        .expect("vectors should decode");
        let local_agent = &vectors["localAgent"];
        let operation = &local_agent["operation"];

        assert_eq!(
            canonical_json(operation),
            local_agent["canonical"].as_str().unwrap()
        );
        assert_eq!(
            generate_json_cid(operation).expect("cid generation should work"),
            local_agent["cid"].as_str().unwrap()
        );
        assert_eq!(
            generate_did_from_operation(&test_config(), operation)
                .expect("did generation should work"),
            local_agent["did"].as_str().unwrap()
        );
    }

    #[test]
    fn verify_proof_format_accepts_valid_and_rejects_invalid_vectors() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/proof-vectors.json"
        ))
        .expect("vectors should decode");

        assert!(verify_proof_format(
            vectors["agentCreateValid"]["operation"].get("proof")
        ));
        assert!(verify_proof_format(
            vectors["agentCreateInvalidProof"]["operation"].get("proof")
        ));

        let mut missing_hash = vectors["agentCreateValid"]["operation"]["proof"].clone();
        missing_hash["verificationMethod"] = Value::String("not-a-did".to_string());
        assert!(!verify_proof_format(Some(&missing_hash)));

        let mut wrong_type = vectors["agentCreateValid"]["operation"]["proof"].clone();
        wrong_type["type"] = Value::String("OtherSignature".to_string());
        assert!(!verify_proof_format(Some(&wrong_type)));
    }

    #[test]
    fn list_dids_and_resolve_doc_preserve_version_and_delete_semantics() {
        let config = test_config();
        let did = "did:cid:bagaaieratestdid";
        let create_operation = json!({
            "type": "create",
            "created": "2026-04-11T12:00:00Z",
            "publicJwk": {
                "kty": "EC",
                "crv": "secp256k1",
                "x": "TzVb3LfMCvco7zzOuWFdkGhLtbLKX4WasPC3BAdYcao",
                "y": "OFtrG46tgJymdFTZaD_PK6A0Vtb-LEq-Kwfw-9uy8cE"
            },
            "registration": {
                "version": 1,
                "type": "agent",
                "registry": "local"
            }
        });
        let update_operation = json!({
            "type": "update",
            "did": did,
            "previd": "create-op",
            "doc": {
                "didDocumentData": {
                    "displayName": "updated"
                }
            }
        });
        let delete_operation = json!({
            "type": "delete",
            "did": did,
            "previd": "update-op"
        });

        let mut db = JsonDb {
            backend: DbBackend::JsonFile {
                path: PathBuf::from("/tmp/archon-rust-gatekeeper-test-unused.json"),
            },
            data: JsonDbFile::default(),
        };
        db.data.dids.insert(
            "bagaaieratestdid".to_string(),
            vec![
                EventRecord {
                    registry: "local".to_string(),
                    time: "2026-04-11T12:00:00Z".to_string(),
                    ordinal: Some(vec![0]),
                    operation: create_operation,
                    opid: Some("create-op".to_string()),
                    did: Some(did.to_string()),
                },
                EventRecord {
                    registry: "local".to_string(),
                    time: "2026-04-11T12:05:00Z".to_string(),
                    ordinal: Some(vec![1]),
                    operation: update_operation,
                    opid: Some("update-op".to_string()),
                    did: Some(did.to_string()),
                },
                EventRecord {
                    registry: "local".to_string(),
                    time: "2026-04-11T12:10:00Z".to_string(),
                    ordinal: Some(vec![2]),
                    operation: delete_operation,
                    opid: Some("delete-op".to_string()),
                    did: Some(did.to_string()),
                },
            ],
        );

        assert_eq!(db.list_dids("did:cid", None), vec![did.to_string()]);

        let resolved = db
            .resolve_doc(&config, did, ResolveOptions::default())
            .expect("resolve should succeed");

        assert_eq!(resolved["didDocument"]["id"], did);
        assert_eq!(resolved["didDocumentMetadata"]["versionId"], "delete-op");
        assert_eq!(resolved["didDocumentMetadata"]["versionSequence"], "3");
        assert_eq!(resolved["didDocumentMetadata"]["deactivated"], true);
        assert_eq!(
            resolved["didDocumentMetadata"]["deleted"],
            "2026-04-11T12:10:00Z"
        );
        assert_eq!(resolved["didDocumentData"], json!({}));
    }
}
