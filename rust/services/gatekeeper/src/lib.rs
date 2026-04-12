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
    use reqwest::Client;
    use serde_json::{json, Value};
    use std::{
        collections::HashMap,
        env,
        net::IpAddr,
        path::PathBuf,
        sync::{atomic::AtomicBool, Arc},
        time::Instant,
    };
    use tempfile::TempDir;
    use tokio::sync::Mutex;

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

    fn temp_json_db() -> (JsonDb, TempDir) {
        let temp_dir = tempfile::tempdir().expect("temp dir should be created");
        let db = JsonDb {
            backend: DbBackend::JsonFile {
                path: temp_dir.path().join("gatekeeper-test.json"),
            },
            data: JsonDbFile::default(),
        };
        (db, temp_dir)
    }

    fn make_state(db: JsonDb) -> (AppState, TempDir) {
        let temp_dir = tempfile::tempdir().expect("temp dir should be created");
        let config = Config {
            data_dir: temp_dir.path().to_path_buf(),
            ..test_config()
        };

        let state = AppState {
            config: config.clone(),
            client: Client::builder().build().expect("client should build"),
            metrics: Arc::new(Metrics::new(&config).expect("metrics should build")),
            store: Arc::new(Mutex::new(db)),
            events_seen: Arc::new(Mutex::new(HashMap::new())),
            verified_dids: Arc::new(Mutex::new(HashMap::new())),
            supported_registries: Arc::new(Mutex::new(config.registries.clone())),
            processing_events: Arc::new(Mutex::new(false)),
            ready: Arc::new(AtomicBool::new(false)),
            started_at: Instant::now(),
        };

        (state, temp_dir)
    }

    fn proof_vectors() -> Value {
        serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/proof-vectors.json"
        ))
        .expect("proof vectors should decode")
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

    #[test]
    fn verify_event_shape_covers_valid_and_invalid_create_update_delete_cases() {
        let valid_create = json!({
            "registry": "local",
            "time": "2026-04-11T12:00:00Z",
            "operation": {
                "type": "create",
                "created": "2026-04-11T12:00:00Z",
                "registration": {
                    "version": 1,
                    "type": "agent",
                    "registry": "local"
                },
                "publicJwk": {
                    "kty": "EC",
                    "crv": "secp256k1",
                    "x": "TzVb3LfMCvco7zzOuWFdkGhLtbLKX4WasPC3BAdYcao",
                    "y": "OFtrG46tgJymdFTZaD_PK6A0Vtb-LEq-Kwfw-9uy8cE"
                },
                "proof": {
                    "type": "EcdsaSecp256k1Signature2019",
                    "created": "2026-04-11T12:00:00Z",
                    "verificationMethod": "#key-1",
                    "proofPurpose": "authentication",
                    "proofValue": "sig"
                }
            }
        });
        let valid_asset_create = json!({
            "registry": "hyperswarm",
            "time": "2026-04-11T12:00:00Z",
            "operation": {
                "type": "create",
                "created": "2026-04-11T12:00:00Z",
                "registration": {
                    "version": 1,
                    "type": "asset",
                    "registry": "hyperswarm"
                },
                "controller": "did:cid:bagaaieratestcontroller",
                "proof": {
                    "type": "EcdsaSecp256k1Signature2019",
                    "created": "2026-04-11T12:00:00Z",
                    "verificationMethod": "did:cid:bagaaieratestcontroller#key-1",
                    "proofPurpose": "authentication",
                    "proofValue": "sig"
                }
            }
        });
        let valid_update = json!({
            "registry": "local",
            "time": "2026-04-11T12:05:00Z",
            "operation": {
                "type": "update",
                "did": "did:cid:bagaaieratestdid",
                "doc": {
                    "didDocumentData": {
                        "name": "updated"
                    }
                },
                "proof": {
                    "type": "EcdsaSecp256k1Signature2019",
                    "created": "2026-04-11T12:05:00Z",
                    "verificationMethod": "did:cid:bagaaieratestdid#key-1",
                    "proofPurpose": "authentication",
                    "proofValue": "sig"
                }
            }
        });
        let valid_delete = json!({
            "registry": "local",
            "time": "2026-04-11T12:10:00Z",
            "operation": {
                "type": "delete",
                "did": "did:cid:bagaaieratestdid",
                "proof": {
                    "type": "EcdsaSecp256k1Signature2019",
                    "created": "2026-04-11T12:10:00Z",
                    "verificationMethod": "did:cid:bagaaieratestdid#key-1",
                    "proofPurpose": "authentication",
                    "proofValue": "sig"
                }
            }
        });

        assert!(verify_event_shape(&valid_create));
        assert!(verify_event_shape(&valid_asset_create));
        assert!(verify_event_shape(&valid_update));
        assert!(verify_event_shape(&valid_delete));

        let mut invalid_registry = valid_create.clone();
        invalid_registry["registry"] = Value::String("not-a-registry".to_string());
        assert!(!verify_event_shape(&invalid_registry));

        let mut missing_time = valid_create.clone();
        missing_time.as_object_mut().unwrap().remove("time");
        assert!(!verify_event_shape(&missing_time));

        let mut invalid_time = valid_create.clone();
        invalid_time["time"] = Value::String("not-a-date".to_string());
        assert!(!verify_event_shape(&invalid_time));

        let mut invalid_version = valid_create.clone();
        invalid_version["operation"]["registration"]["version"] = Value::Number(2.into());
        assert!(!verify_event_shape(&invalid_version));

        let mut invalid_type = valid_create.clone();
        invalid_type["operation"]["registration"]["type"] = Value::String("other".to_string());
        assert!(!verify_event_shape(&invalid_type));

        let mut invalid_proof = valid_create.clone();
        invalid_proof["operation"]["proof"]["verificationMethod"] =
            Value::String("not-a-did".to_string());
        assert!(!verify_event_shape(&invalid_proof));

        let mut agent_missing_key = valid_create.clone();
        agent_missing_key["operation"]
            .as_object_mut()
            .unwrap()
            .remove("publicJwk");
        assert!(!verify_event_shape(&agent_missing_key));

        let mut asset_wrong_signer = valid_asset_create.clone();
        asset_wrong_signer["operation"]["proof"]["verificationMethod"] =
            Value::String("did:cid:bagaaieradifferent#key-1".to_string());
        assert!(!verify_event_shape(&asset_wrong_signer));

        let mut update_missing_doc = valid_update.clone();
        update_missing_doc["operation"].as_object_mut().unwrap().remove("doc");
        assert!(!verify_event_shape(&update_missing_doc));

        let mut update_mismatched_doc_id = valid_update.clone();
        update_mismatched_doc_id["operation"]["doc"]["didDocument"] =
            json!({ "id": "did:cid:bagaaieradifferent" });
        assert!(!verify_event_shape(&update_mismatched_doc_id));

        let mut delete_missing_did = valid_delete.clone();
        delete_missing_did["operation"]
            .as_object_mut()
            .unwrap()
            .remove("did");
        assert!(!verify_event_shape(&delete_missing_did));
    }

    #[test]
    fn infer_event_did_and_ensure_event_opid_follow_expected_precedence() {
        let config = test_config();
        let vectors: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/deterministic-vectors.json"
        ))
        .expect("vectors should decode");
        let generated_did = vectors["localAgent"]["did"].as_str().unwrap().to_string();
        let operation = vectors["localAgent"]["operation"].clone();

        let explicit_event = json!({
            "did": "did:cid:bagaaieraexplicit",
            "operation": operation
        });
        assert_eq!(
            infer_event_did(&config, &explicit_event).expect("did should be inferred"),
            "did:cid:bagaaieraexplicit"
        );

        let operation_did_event = json!({
            "operation": {
                "type": "update",
                "did": "did:cid:bagaaieraoperation",
                "doc": { "didDocumentData": { "name": "ok" } }
            }
        });
        assert_eq!(
            infer_event_did(&config, &operation_did_event).expect("did should come from operation"),
            "did:cid:bagaaieraoperation"
        );

        let generated_event = json!({ "operation": vectors["localAgent"]["operation"].clone() });
        assert_eq!(
            infer_event_did(&config, &generated_event).expect("did should be generated"),
            generated_did
        );

        let mut with_existing_opid = json!({
            "opid": "existing-opid",
            "operation": vectors["localAgent"]["operation"].clone()
        });
        assert_eq!(
            ensure_event_opid(&mut with_existing_opid).expect("existing opid should win"),
            "existing-opid"
        );

        let mut without_opid = json!({
            "operation": vectors["localAgent"]["operation"].clone()
        });
        let generated_opid =
            ensure_event_opid(&mut without_opid).expect("opid should be generated");
        assert_eq!(
            without_opid.get("opid").and_then(Value::as_str),
            Some(generated_opid.as_str())
        );
    }

    #[test]
    fn expected_registry_for_index_tracks_registry_changes_across_updates() {
        let did = "did:cid:bagaaieratestdid";
        let events = vec![
            EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "create",
                    "created": "2026-04-11T12:00:00Z",
                    "registration": {
                        "version": 1,
                        "type": "agent",
                        "registry": "local"
                    }
                }),
                opid: Some("create-op".to_string()),
                did: Some(did.to_string()),
            },
            EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:01:00Z".to_string(),
                ordinal: Some(vec![1]),
                operation: json!({
                    "type": "update",
                    "did": did,
                    "previd": "create-op",
                    "doc": {
                        "didDocumentRegistration": {
                            "registry": "hyperswarm"
                        }
                    }
                }),
                opid: Some("update-op".to_string()),
                did: Some(did.to_string()),
            },
            EventRecord {
                registry: "hyperswarm".to_string(),
                time: "2026-04-11T12:02:00Z".to_string(),
                ordinal: Some(vec![2]),
                operation: json!({
                    "type": "delete",
                    "did": did,
                    "previd": "update-op"
                }),
                opid: Some("delete-op".to_string()),
                did: Some(did.to_string()),
            },
        ];

        assert_eq!(expected_registry_for_index(&events, 0).as_deref(), Some("local"));
        assert_eq!(expected_registry_for_index(&events, 1).as_deref(), Some("local"));
        assert_eq!(
            expected_registry_for_index(&events, 2).as_deref(),
            Some("hyperswarm")
        );
    }

    #[test]
    fn json_db_helpers_cover_requested_dids_queue_and_block_selection() {
        let (mut db, _temp_dir) = temp_json_db();
        let did = "did:cid:bagaaieratestdid";

        db.data.dids.insert(
            "bagaaieratestdid".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "create",
                    "created": "2026-04-11T12:00:00Z",
                    "registration": {
                        "version": 1,
                        "type": "agent",
                        "registry": "local"
                    }
                }),
                opid: Some("create-op".to_string()),
                did: Some(did.to_string()),
            }],
        );

        assert_eq!(
            db.list_dids(
                "did:cid",
                Some(&[
                    "did:cid:second".to_string(),
                    "did:cid:first".to_string(),
                ])
            ),
            vec!["did:cid:second".to_string(), "did:cid:first".to_string()]
        );
        assert!(db.get_events("not-a-did").is_empty());
        assert!(db.get_events("totallymalformed").is_empty());

        let first = json!({ "proof": { "proofValue": "first" } });
        let second = json!({ "proof": { "proofValue": "second" } });
        let third = json!({ "proof": { "proofValue": "third" } });
        db.queue_operation("hyperswarm", first.clone())
            .expect("queue should accept first");
        db.queue_operation("hyperswarm", second.clone())
            .expect("queue should accept second");
        db.queue_operation("hyperswarm", third.clone())
            .expect("queue should accept third");
        db.clear_queue("hyperswarm", &[second.clone()])
            .expect("clear queue should succeed");
        assert_eq!(db.get_queue("hyperswarm"), vec![first, third]);

        let block_a = json!({ "hash": "a", "height": 4 });
        let block_b = json!({ "hash": "b", "height": 9 });
        db.add_block("hyperswarm", block_a.clone())
            .expect("block add should succeed");
        db.add_block("hyperswarm", block_b.clone())
            .expect("block add should succeed");
        assert_eq!(db.get_block("hyperswarm", None), Some(block_b.clone()));
        assert_eq!(
            db.get_block("hyperswarm", Some(BlockLookup::Height(4))),
            Some(block_a)
        );
        assert_eq!(
            db.get_block("hyperswarm", Some(BlockLookup::Hash("b".to_string()))),
            Some(block_b)
        );
        assert_eq!(
            db.get_block("hyperswarm", Some(BlockLookup::Height(99))),
            None
        );
    }

    #[test]
    fn resolve_doc_supports_confirm_version_sequence_version_time_and_canonical_id() {
        let config = test_config();
        let did = "did:test:bagaaieratestdid";
        let (mut db, _temp_dir) = temp_json_db();
        db.data.dids.insert(
            "bagaaieratestdid".to_string(),
            vec![
                EventRecord {
                    registry: "local".to_string(),
                    time: "2026-04-11T12:00:00Z".to_string(),
                    ordinal: Some(vec![0]),
                    operation: json!({
                        "type": "create",
                        "created": "2026-04-11T12:00:00Z",
                        "publicJwk": {},
                        "registration": {
                            "version": 1,
                            "type": "agent",
                            "registry": "local",
                            "prefix": "did:test"
                        },
                        "data": {
                            "displayName": "created"
                        }
                    }),
                    opid: Some("create-op".to_string()),
                    did: Some(did.to_string()),
                },
                EventRecord {
                    registry: "hyperswarm".to_string(),
                    time: "2026-04-11T12:05:00Z".to_string(),
                    ordinal: Some(vec![1]),
                    operation: json!({
                        "type": "update",
                        "did": did,
                        "previd": "create-op",
                        "doc": {
                            "didDocumentData": {
                                "displayName": "updated"
                            }
                        }
                    }),
                    opid: Some("update-op".to_string()),
                    did: Some(did.to_string()),
                },
                EventRecord {
                    registry: "local".to_string(),
                    time: "2026-04-11T12:10:00Z".to_string(),
                    ordinal: Some(vec![2]),
                    operation: json!({
                        "type": "update",
                        "did": did,
                        "previd": "update-op",
                        "doc": {
                            "didDocumentData": {
                                "displayName": "late-update"
                            }
                        }
                    }),
                    opid: Some("late-update-op".to_string()),
                    did: Some(did.to_string()),
                },
            ],
        );

        let resolved = db
            .resolve_doc(&config, did, ResolveOptions::default())
            .expect("resolve should succeed");
        assert_eq!(resolved["didDocumentMetadata"]["confirmed"], false);
        assert_eq!(resolved["didDocumentMetadata"]["versionSequence"], "3");
        assert_eq!(resolved["didDocumentMetadata"]["canonicalId"], did);
        assert_eq!(
            resolved["didDocumentData"]["displayName"],
            Value::String("late-update".to_string())
        );

        let confirmed = db
            .resolve_doc(
                &config,
                did,
                ResolveOptions {
                    confirm: true,
                    ..ResolveOptions::default()
                },
            )
            .expect("confirmed resolve should succeed");
        assert_eq!(confirmed["didDocumentMetadata"]["confirmed"], false);
        assert_eq!(confirmed["didDocumentMetadata"]["versionSequence"], "2");
        assert_eq!(
            confirmed["didDocumentData"]["displayName"],
            Value::String("updated".to_string())
        );

        let by_sequence = db
            .resolve_doc(
                &config,
                did,
                ResolveOptions {
                    version_sequence: Some(1),
                    ..ResolveOptions::default()
                },
            )
            .expect("sequence resolve should succeed");
        assert_eq!(by_sequence["didDocumentMetadata"]["versionSequence"], "1");
        assert_eq!(
            by_sequence["didDocumentData"]["displayName"],
            Value::String("created".to_string())
        );

        let by_time = db
            .resolve_doc(
                &config,
                did,
                ResolveOptions {
                    version_time: Some("2026-04-11T12:03:00Z".to_string()),
                    ..ResolveOptions::default()
                },
            )
            .expect("time resolve should succeed");
        assert_eq!(by_time["didDocumentMetadata"]["versionSequence"], "1");
    }

    #[tokio::test]
    async fn check_dids_impl_counts_invalid_unconfirmed_ephemeral_and_versions() {
        let did_agent = "did:cid:bagaaieragent";
        let did_asset = "did:cid:bagaaierasset";
        let did_invalid = "did:cid:bagaaierinvalid";
        let (mut db, _temp_dir) = temp_json_db();

        db.data.dids.insert(
            "bagaaieragent".to_string(),
            vec![
                EventRecord {
                    registry: "local".to_string(),
                    time: "2026-04-11T12:00:00Z".to_string(),
                    ordinal: Some(vec![0]),
                    operation: json!({
                        "type": "create",
                        "created": "2026-04-11T12:00:00Z",
                        "publicJwk": {},
                        "registration": {
                            "version": 1,
                            "type": "agent",
                            "registry": "local",
                            "validUntil": "2099-01-01T00:00:00Z"
                        }
                    }),
                    opid: Some("agent-create".to_string()),
                    did: Some(did_agent.to_string()),
                },
                EventRecord {
                    registry: "hyperswarm".to_string(),
                    time: "2026-04-11T12:05:00Z".to_string(),
                    ordinal: Some(vec![1]),
                    operation: json!({
                        "type": "update",
                        "did": did_agent,
                        "previd": "agent-create",
                        "doc": {
                            "didDocumentData": {
                                "status": "remote-update"
                            }
                        }
                    }),
                    opid: Some("agent-update".to_string()),
                    did: Some(did_agent.to_string()),
                },
            ],
        );
        db.data.dids.insert(
            "bagaaierasset".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "create",
                    "created": "2026-04-11T12:00:00Z",
                    "controller": did_agent,
                    "registration": {
                        "version": 1,
                        "type": "asset",
                        "registry": "local"
                    }
                }),
                opid: Some("asset-create".to_string()),
                did: Some(did_asset.to_string()),
            }],
        );
        db.data.dids.insert(
            "bagaaierinvalid".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "update",
                    "did": did_invalid,
                    "doc": {
                        "didDocumentData": {}
                    }
                }),
                opid: Some("invalid-update".to_string()),
                did: Some(did_invalid.to_string()),
            }],
        );
        db.push_import_event(EventRecord {
            registry: "hyperswarm".to_string(),
            time: "2026-04-11T12:10:00Z".to_string(),
            ordinal: Some(vec![5]),
            operation: json!({ "type": "create" }),
            opid: Some("queued".to_string()),
            did: Some("did:cid:queued".to_string()),
        });

        let (state, _state_dir) = make_state(db);
        let result = check_dids_impl(&state, None, false).await;

        assert_eq!(result.total, 3);
        assert_eq!(result.byType.agents, 1);
        assert_eq!(result.byType.assets, 1);
        assert_eq!(result.byType.unconfirmed, 1);
        assert_eq!(result.byType.confirmed, 1);
        assert_eq!(result.byType.ephemeral, 1);
        assert_eq!(result.byType.invalid, 1);
        assert_eq!(result.byRegistry.get("local"), Some(&2));
        assert_eq!(result.byVersion.get("1"), Some(&1));
        assert_eq!(result.byVersion.get("2"), Some(&1));
        assert_eq!(result.eventsQueue.len(), 1);
    }

    #[tokio::test]
    async fn verify_db_impl_removes_invalid_dids_and_clears_import_queue() {
        let vectors = proof_vectors();
        let valid_did = generate_did_from_operation(&test_config(), &vectors["agentCreateValid"]["operation"])
            .expect("valid vector should produce did");
        let expired_did = "did:cid:bagaaieraexpired";
        let invalid_did = "did:cid:bagaaierainvalid";
        let (mut db, _temp_dir) = temp_json_db();

        db.data.dids.insert(
            valid_did.rsplit(':').next().unwrap().to_string(),
            vec![value_to_event_record(&json!({
                "registry": "local",
                "time": vectors["agentCreateValid"]["operation"]["created"],
                "ordinal": [0],
                "operation": vectors["agentCreateValid"]["operation"].clone(),
                "did": valid_did
            }))],
        );
        db.data.dids.insert(
            "bagaaieraexpired".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2020-01-01T00:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "create",
                    "created": "2020-01-01T00:00:00Z",
                    "publicJwk": vectors["agentCreateValid"]["operation"]["publicJwk"].clone(),
                    "registration": {
                        "version": 1,
                        "type": "agent",
                        "registry": "local",
                        "validUntil": "2020-01-02T00:00:00Z"
                    },
                    "proof": vectors["agentCreateValid"]["operation"]["proof"].clone()
                }),
                opid: Some("expired-create".to_string()),
                did: Some(expired_did.to_string()),
            }],
        );
        db.data.dids.insert(
            "bagaaierainvalid".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "update",
                    "did": invalid_did,
                    "doc": {
                        "didDocumentData": {}
                    },
                    "proof": vectors["agentCreateValid"]["operation"]["proof"].clone()
                }),
                opid: Some("invalid-op".to_string()),
                did: Some(invalid_did.to_string()),
            }],
        );
        db.push_import_event(EventRecord {
            registry: "local".to_string(),
            time: "2026-04-11T12:10:00Z".to_string(),
            ordinal: Some(vec![1]),
            operation: json!({ "type": "create" }),
            opid: Some("queued".to_string()),
            did: Some("did:cid:queued".to_string()),
        });

        let (state, _state_dir) = make_state(db);
        let result = verify_db_impl(&state, false).await;
        assert_eq!(result.total, 3);
        assert_eq!(result.verified, 1);
        assert_eq!(result.expired, 0);
        assert_eq!(result.invalid, 2);

        let store = state.store.lock().await;
        assert!(store.get_events(expired_did).is_empty());
        assert!(store.get_events(invalid_did).is_empty());
        assert_eq!(store.import_queue_len(), 0);
        drop(store);

        let cached = verify_db_impl(&state, false).await;
        assert_eq!(cached.total, 1);
        assert_eq!(cached.verified, 1);
    }

    #[tokio::test]
    async fn search_and_query_docs_cover_exact_nested_and_wildcard_paths() {
        let did_a = "did:cid:bagaaieraa";
        let did_b = "did:cid:bagaaierab";
        let (mut db, _temp_dir) = temp_json_db();

        db.data.dids.insert(
            "bagaaieraa".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "create",
                    "created": "2026-04-11T12:00:00Z",
                    "publicJwk": {},
                    "registration": {
                        "version": 1,
                        "type": "agent",
                        "registry": "local"
                    },
                    "data": {
                        "name": "alpha",
                        "profile": {
                            "team": "red"
                        },
                        "tags": ["founder", "builder"],
                        "links": [
                            { "type": "twitter", "value": "@alpha" }
                        ]
                    }
                }),
                opid: Some("create-a".to_string()),
                did: Some(did_a.to_string()),
            }],
        );
        db.data.dids.insert(
            "bagaaierab".to_string(),
            vec![EventRecord {
                registry: "local".to_string(),
                time: "2026-04-11T12:00:00Z".to_string(),
                ordinal: Some(vec![0]),
                operation: json!({
                    "type": "create",
                    "created": "2026-04-11T12:00:00Z",
                    "publicJwk": {},
                    "registration": {
                        "version": 1,
                        "type": "agent",
                        "registry": "local"
                    },
                    "data": {
                        "name": "beta",
                        "profile": {
                            "team": "blue"
                        },
                        "tags": ["ops"],
                        "links": [
                            { "type": "github", "value": "beta" }
                        ]
                    }
                }),
                opid: Some("create-b".to_string()),
                did: Some(did_b.to_string()),
            }],
        );

        let (state, _state_dir) = make_state(db);
        assert_eq!(search_docs_impl(&state, "alpha").await, vec![did_a.to_string()]);
        assert!(search_docs_impl(&state, "didDocumentMetadata").await.is_empty());

        assert_eq!(
            query_docs_impl(&state, &json!({ "name": { "$in": ["alpha"] } }))
                .await
                .expect("exact query should succeed"),
            vec![did_a.to_string()]
        );
        assert_eq!(
            query_docs_impl(&state, &json!({ "$.profile.team": { "$in": ["blue"] } }))
                .await
                .expect("nested query should succeed"),
            vec![did_b.to_string()]
        );
        assert_eq!(
            query_docs_impl(&state, &json!({ "tags[*]": { "$in": ["builder"] } }))
                .await
                .expect("array wildcard should succeed"),
            vec![did_a.to_string()]
        );
        assert_eq!(
            query_docs_impl(&state, &json!({ "links[*].type": { "$in": ["github"] } }))
                .await
                .expect("array object wildcard should succeed"),
            vec![did_b.to_string()]
        );
        assert_eq!(
            query_docs_impl(&state, &json!({ "profile.*": { "$in": ["team"] } }))
                .await
                .expect("object key wildcard should succeed"),
            vec![did_a.to_string(), did_b.to_string()]
        );
        assert!(
            query_docs_impl(&state, &json!({ "name": { "$eq": "alpha" } }))
                .await
                .is_err()
        );
    }
}
