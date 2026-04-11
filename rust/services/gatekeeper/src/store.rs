use std::{
    collections::HashMap,
    env, fs,
    net::IpAddr,
    path::PathBuf,
};

use anyhow::{Context, Result};
use mongodb::{
    bson::{doc, Document},
    sync::Client as MongoClient,
};
use redis::Commands;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{config::Config, generate_json_cid};

const STATE_KEY: &str = "jsondb";

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct EventRecord {
    pub(crate) registry: String,
    pub(crate) time: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) ordinal: Option<Vec<u64>>,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub(crate) operation: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) opid: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) did: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct JsonDbFile {
    pub(crate) dids: HashMap<String, Vec<EventRecord>>,
    #[serde(default)]
    pub(crate) import_queue: Vec<EventRecord>,
    #[serde(default)]
    pub(crate) queue: HashMap<String, Vec<Value>>,
    #[serde(default)]
    pub(crate) blocks: HashMap<String, HashMap<String, Value>>,
    #[serde(default)]
    pub(crate) ops: HashMap<String, Value>,
}

pub(crate) struct JsonDb {
    pub(crate) backend: DbBackend,
    pub(crate) data: JsonDbFile,
}

#[derive(Clone)]
pub(crate) enum DbBackend {
    JsonFile { path: PathBuf },
    Sqlite { path: PathBuf },
    Redis { url: String, namespace: String },
    Mongo {
        url: String,
        database: String,
        collection: String,
        document_id: String,
    },
}

pub(crate) trait GatekeeperDb {
    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String>;
    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool>;
    fn get_events(&self, did: &str) -> Vec<EventRecord>;
    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()>;
    fn delete_events(&mut self, did: &str) -> Result<()>;
    fn reset_db(&mut self) -> Result<()>;
    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()>;
    fn get_operation(&self, opid: &str) -> Option<Value>;
    fn push_import_event(&mut self, event: EventRecord);
    fn take_import_queue(&mut self) -> Vec<EventRecord>;
    fn import_queue_len(&self) -> usize;
    fn import_queue_snapshot(&self) -> Vec<EventRecord>;
    fn clear_import_queue(&mut self);
    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize>;
    fn get_queue(&self, registry: &str) -> Vec<Value>;
    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool>;
    fn add_block(&mut self, registry: &str, block: Value) -> Result<bool>;
    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value>;
    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String>;
    fn resolve_doc(&self, config: &Config, did: &str, options: ResolveOptions) -> Result<Value>;
}

#[derive(Clone, Default)]
pub(crate) struct ResolveOptions {
    pub(crate) version_time: Option<String>,
    pub(crate) version_sequence: Option<usize>,
    pub(crate) confirm: bool,
    pub(crate) verify: bool,
}

pub(crate) struct ResolvedDoc {
    pub(crate) did_document: Value,
    pub(crate) did_document_data: Value,
    pub(crate) did_document_registration: Value,
    pub(crate) created: String,
    pub(crate) updated: Option<String>,
    pub(crate) deleted: Option<String>,
    pub(crate) version_id: String,
    pub(crate) version_sequence: usize,
    pub(crate) confirmed: bool,
    pub(crate) canonical_id: Option<String>,
    pub(crate) deactivated: bool,
}

pub(crate) enum BlockLookup {
    Height(u64),
    Hash(String),
}

pub(crate) fn compare_ordinals(left: Option<&Vec<u64>>, right: Option<&Vec<u64>>) -> std::cmp::Ordering {
    match (left, right) {
        (Some(left), Some(right)) => {
            for (l, r) in left.iter().zip(right.iter()) {
                match l.cmp(r) {
                    std::cmp::Ordering::Equal => continue,
                    other => return other,
                }
            }
            left.len().cmp(&right.len())
        }
        _ => std::cmp::Ordering::Equal,
    }
}

pub(crate) fn expected_registry_for_index(events: &[EventRecord], index: usize) -> Option<String> {
    if events.is_empty() {
        return None;
    }
    if index == 0 {
        return events[0]
            .operation
            .get("registration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str)
            .map(ToString::to_string);
    }

    let mut registry = events[0]
        .operation
        .get("registration")
        .and_then(|value| value.get("registry"))
        .and_then(Value::as_str)
        .map(ToString::to_string);

    for event in events.iter().take(index).skip(1) {
        if event.operation.get("type").and_then(Value::as_str) == Some("update") {
            if let Some(next_registry) = event
                .operation
                .get("doc")
                .and_then(|value| value.get("didDocumentRegistration"))
                .and_then(|value| value.get("registry"))
                .and_then(Value::as_str)
            {
                registry = Some(next_registry.to_string());
            }
        }
    }

    registry
}

pub(crate) fn value_to_event_record(value: &Value) -> EventRecord {
    EventRecord {
        registry: value
            .get("registry")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_string(),
        time: value
            .get("time")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        ordinal: value.get("ordinal").and_then(|items| {
            items.as_array().map(|values| values.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        }),
        operation: value.get("operation").cloned().unwrap_or(Value::Null),
        opid: value.get("opid").and_then(Value::as_str).map(ToString::to_string),
        did: value.get("did").and_then(Value::as_str).map(ToString::to_string),
    }
}

pub(crate) fn event_record_to_value(event: &EventRecord) -> Value {
    json!({
        "registry": event.registry,
        "time": event.time,
        "ordinal": event.ordinal,
        "operation": event.operation,
        "opid": event.opid,
        "did": event.did
    })
}

pub(crate) fn redis_event_to_stored_value(event: &EventRecord) -> Value {
    let mut stored = serde_json::to_value(event).unwrap_or_else(|_| json!({}));
    if event.opid.is_some() {
        if let Some(object) = stored.as_object_mut() {
            object.remove("operation");
        }
    }
    stored
}

pub(crate) fn hydrate_redis_event(raw: &str, ops: &HashMap<String, Value>) -> Result<EventRecord> {
    let mut event = serde_json::from_str::<EventRecord>(raw).context("failed to decode redis did event")?;
    if event.operation.is_null() {
        if let Some(opid) = event.opid.as_ref() {
            if let Some(operation) = ops.get(opid) {
                event.operation = operation.clone();
            }
        }
    }
    Ok(event)
}

pub(crate) fn chrono_like_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl JsonDb {
    pub(crate) fn load(config: &Config) -> Result<Self> {
        let backend = DbBackend::from_config(config);
        let data = backend.load_state()?;
        Ok(Self { backend, data })
    }

    fn save(&self) -> Result<()> {
        self.backend.save_state(&self.data)
    }

    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String> {
        let suffix = did.split(':').next_back().context("invalid did suffix")?.to_string();
        let events = self.data.dids.entry(suffix).or_default();
        if events.is_empty() {
            if let (Some(opid), operation) = (event.opid.clone(), event.operation.clone()) {
                self.data.ops.insert(opid, operation);
            }
            events.push(event);
            self.save()?;
        }
        Ok(did.to_string())
    }

    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool> {
        let suffix = did.split(':').next_back().context("invalid did suffix")?.to_string();

        let latest = self.resolve_doc(
            &Config {
                port: 0,
                bind_address: IpAddr::from([0, 0, 0, 0]),
                db: String::new(),
                data_dir: PathBuf::new(),
                ipfs_url: String::new(),
                did_prefix: String::new(),
                registries: vec![],
                json_limit: 0,
                upload_limit: 0,
                gc_interval_minutes: 0,
                status_interval_minutes: 0,
                admin_api_key: String::new(),
                fallback_url: String::new(),
                fallback_timeout_ms: 0,
                max_queue_size: 0,
                git_commit: String::new(),
                version: String::new(),
            },
            did,
            ResolveOptions::default(),
        )?;

        let events = self.data.dids.get_mut(&suffix).context("did not found")?;
        if events.is_empty() {
            anyhow::bail!("did not found");
        }

        let previd = event
            .operation
            .get("previd")
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing operation.previd"))?;
        let current_version_id = latest
            .get("didDocumentMetadata")
            .and_then(|value| value.get("versionId"))
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("missing current versionId"))?;

        if previd != current_version_id {
            anyhow::bail!("invalid previd");
        }

        if let (Some(opid), operation) = (event.opid.clone(), event.operation.clone()) {
            self.data.ops.insert(opid, operation);
        }
        events.push(event);
        self.save()?;
        Ok(true)
    }

    fn get_events(&self, did: &str) -> Vec<EventRecord> {
        let suffix = match did.split(':').next_back() {
            Some(value) => value,
            None => return Vec::new(),
        };
        self.data
            .dids
            .get(suffix)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|mut event| {
                if event.operation.is_null() {
                    if let Some(opid) = event.opid.as_ref() {
                        if let Some(operation) = self.data.ops.get(opid) {
                            event.operation = operation.clone();
                        }
                    }
                }
                event
            })
            .collect()
    }

    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()> {
        let suffix = did.split(':').next_back().context("invalid did suffix")?.to_string();
        for event in &events {
            if let Some(opid) = event.opid.as_ref() {
                self.data.ops.insert(opid.clone(), event.operation.clone());
            }
        }
        self.data.dids.insert(suffix, events);
        self.save()
    }

    fn delete_events(&mut self, did: &str) -> Result<()> {
        let suffix = did.split(':').next_back().context("invalid did suffix")?.to_string();
        self.data.dids.remove(&suffix);
        self.save()
    }

    fn reset_db(&mut self) -> Result<()> {
        self.data = JsonDbFile::default();
        self.save()
    }

    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()> {
        self.data.ops.insert(opid.to_string(), operation);
        self.save()
    }

    fn get_operation(&self, opid: &str) -> Option<Value> {
        self.data.ops.get(opid).cloned()
    }

    fn push_import_event(&mut self, event: EventRecord) {
        self.data.import_queue.push(event);
        let _ = self.save();
    }

    fn take_import_queue(&mut self) -> Vec<EventRecord> {
        let queue = std::mem::take(&mut self.data.import_queue);
        let _ = self.save();
        queue
    }

    fn import_queue_len(&self) -> usize {
        self.data.import_queue.len()
    }

    fn import_queue_snapshot(&self) -> Vec<EventRecord> {
        self.data.import_queue.clone()
    }

    fn clear_import_queue(&mut self) {
        self.data.import_queue.clear();
        let _ = self.save();
    }

    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize> {
        let len = {
            let queue = self.data.queue.entry(registry.to_string()).or_default();
            queue.push(operation);
            queue.len()
        };
        self.save()?;
        Ok(len)
    }

    fn get_queue(&self, registry: &str) -> Vec<Value> {
        self.data.queue.get(registry).cloned().unwrap_or_default()
    }

    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool> {
        let proof_values = operations
            .iter()
            .filter_map(|value| {
                value.get("proof")
                    .and_then(|proof| proof.get("proofValue"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>();

        if let Some(queue) = self.data.queue.get_mut(registry) {
            queue.retain(|item| {
                let proof_value = item
                    .get("proof")
                    .and_then(|proof| proof.get("proofValue"))
                    .and_then(Value::as_str);
                !proof_values.iter().any(|value| Some(*value) == proof_value)
            });
        }

        self.save()?;
        Ok(true)
    }

    fn add_block(&mut self, registry: &str, block: Value) -> Result<bool> {
        let hash = block
            .get("hash")
            .and_then(Value::as_str)
            .context("missing block.hash")?
            .to_string();

        self.data
            .blocks
            .entry(registry.to_string())
            .or_default()
            .insert(hash, block);
        self.save()?;
        Ok(true)
    }

    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value> {
        let registry_blocks = self.data.blocks.get(registry)?;
        if registry_blocks.is_empty() {
            return None;
        }

        match block_id {
            None => registry_blocks
                .values()
                .filter_map(|block| {
                    block.get("height").and_then(Value::as_u64).map(|height| (height, block.clone()))
                })
                .max_by_key(|(height, _)| *height)
                .map(|(_, block)| block),
            Some(BlockLookup::Height(height)) => registry_blocks.values().find_map(|block| {
                (block.get("height").and_then(Value::as_u64) == Some(height)).then(|| block.clone())
            }),
            Some(BlockLookup::Hash(hash)) => registry_blocks.get(&hash).cloned(),
        }
    }

    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String> {
        match requested {
            Some(items) => items.to_vec(),
            None => {
                let mut keys = self.data.dids.keys().cloned().collect::<Vec<_>>();
                keys.sort();
                keys.into_iter().map(|suffix| format!("{prefix}:{suffix}")).collect()
            }
        }
    }

    fn resolve_doc(&self, _config: &Config, did: &str, options: ResolveOptions) -> Result<Value> {
        let _ = did.split(':').next_back().context("invalid did suffix")?;
        let events = self.get_events(did);
        if events.is_empty() {
            anyhow::bail!("did not found");
        }
        let anchor = events.first().context("did has no events")?;
        let anchor_operation = &anchor.operation;

        if anchor_operation.get("type").and_then(Value::as_str) != Some("create") {
            anyhow::bail!("first operation must be create");
        }

        let registration = anchor_operation
            .get("registration")
            .and_then(Value::as_object)
            .context("missing registration")?;
        let did_type = registration
            .get("type")
            .and_then(Value::as_str)
            .context("missing registration.type")?;
        let created = anchor_operation.get("created").and_then(Value::as_str).unwrap_or("");

        let initial_document = match did_type {
            "agent" => {
                let public_jwk = anchor_operation.get("publicJwk").cloned().unwrap_or_else(|| json!({}));
                json!({
                    "@context": ["https://www.w3.org/ns/did/v1"],
                    "id": did,
                    "verificationMethod": [{
                        "id": "#key-1",
                        "controller": did,
                        "type": "EcdsaSecp256k1VerificationKey2019",
                        "publicKeyJwk": public_jwk
                    }],
                    "authentication": ["#key-1"],
                    "assertionMethod": ["#key-1"]
                })
            }
            "asset" => {
                json!({
                    "@context": ["https://www.w3.org/ns/did/v1"],
                    "id": did,
                    "controller": anchor_operation.get("controller").cloned().unwrap_or(Value::Null)
                })
            }
            _ => anyhow::bail!("unsupported registration.type"),
        };

        let canonical_id = anchor_operation
            .get("registration")
            .and_then(|v| v.get("prefix"))
            .and_then(Value::as_str)
            .map(|_| did.to_string());

        let mut state = ResolvedDoc {
            did_document: initial_document,
            did_document_data: anchor_operation.get("data").cloned().unwrap_or_else(|| json!({})),
            did_document_registration: Value::Object(registration.clone()),
            created: created.to_string(),
            updated: None,
            deleted: None,
            version_id: anchor
                .opid
                .clone()
                .unwrap_or_else(|| generate_json_cid(anchor_operation).unwrap_or_default()),
            version_sequence: 1,
            confirmed: true,
            canonical_id,
            deactivated: false,
        };

        for event in events.iter().skip(1) {
            let operation = &event.operation;
            let operation_time = event.time.clone();

            if let Some(version_time) = options.version_time.as_ref() {
                if operation_time > *version_time {
                    break;
                }
            }

            if let Some(version_sequence) = options.version_sequence {
                if state.version_sequence == version_sequence {
                    break;
                }
            }

            if options.confirm && !state.confirmed {
                break;
            }

            if options.verify {
                // Signature verification is handled by higher-level resolver paths.
            }

            state.confirmed = state.confirmed
                && state
                    .did_document_registration
                    .get("registry")
                    .and_then(Value::as_str)
                    .map(|registry| registry == event.registry)
                    .unwrap_or(false);

            match operation.get("type").and_then(Value::as_str) {
                Some("update") => {
                    state.version_sequence += 1;
                    state.version_id = event
                        .opid
                        .clone()
                        .unwrap_or_else(|| generate_json_cid(operation).unwrap_or_default());
                    state.updated = Some(operation_time);
                    if let Some(next_doc) = operation.get("doc") {
                        if let Some(doc) = next_doc.get("didDocument") {
                            state.did_document = doc.clone();
                        }
                        if let Some(data) = next_doc.get("didDocumentData") {
                            state.did_document_data = data.clone();
                        }
                        if let Some(registration) = next_doc.get("didDocumentRegistration") {
                            state.did_document_registration = registration.clone();
                        }
                    }
                    state.deactivated = false;
                }
                Some("delete") => {
                    state.version_sequence += 1;
                    state.version_id = event
                        .opid
                        .clone()
                        .unwrap_or_else(|| generate_json_cid(operation).unwrap_or_default());
                    state.deleted = Some(operation_time.clone());
                    state.updated = Some(operation_time);
                    state.did_document = json!({ "id": did });
                    state.did_document_data = json!({});
                    state.deactivated = true;
                }
                _ => {}
            }
        }

        let mut metadata = json!({
            "created": state.created,
            "versionId": state.version_id,
            "versionSequence": state.version_sequence.to_string(),
            "confirmed": state.confirmed
        });

        if let Some(updated) = state.updated.clone() {
            metadata["updated"] = Value::String(updated);
        }
        if let Some(deleted) = state.deleted.clone() {
            metadata["deleted"] = Value::String(deleted);
        }
        if state.deactivated {
            metadata["deactivated"] = Value::Bool(true);
        }
        if let Some(canonical_id) = state.canonical_id.clone() {
            metadata["canonicalId"] = Value::String(canonical_id);
        }

        Ok(json!({
            "didDocument": state.did_document,
            "didDocumentMetadata": metadata,
            "didDocumentData": state.did_document_data,
            "didDocumentRegistration": state.did_document_registration,
            "didResolutionMetadata": {
                "retrieved": chrono_like_now()
            }
        }))
    }
}

impl DbBackend {
    fn from_config(config: &Config) -> Self {
        match config.db.as_str() {
            "sqlite" => Self::Sqlite {
                path: config.data_dir.join("archon.sqlite"),
            },
            "redis" => Self::Redis {
                url: env::var("ARCHON_REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".to_string()),
                namespace: "archon".to_string(),
            },
            "mongodb" => Self::Mongo {
                url: env::var("ARCHON_MONGODB_URL").unwrap_or_else(|_| "mongodb://localhost:27017".to_string()),
                database: "archon".to_string(),
                collection: "gatekeeper_state".to_string(),
                document_id: STATE_KEY.to_string(),
            },
            _ => Self::JsonFile {
                path: config.data_dir.join("archon.json"),
            },
        }
    }

    fn load_state(&self) -> Result<JsonDbFile> {
        match self {
            Self::JsonFile { path } => match fs::read_to_string(path) {
                Ok(raw) => serde_json::from_str::<JsonDbFile>(&raw).context("failed to decode json db"),
                Err(_) => Ok(JsonDbFile::default()),
            },
            Self::Sqlite { path } => {
                let conn = Self::open_sqlite(path)?;
                let raw = conn
                    .query_row("SELECT value FROM kv WHERE key = ?1", [STATE_KEY], |row| row.get::<_, String>(0))
                    .optional()
                    .context("failed to load sqlite state")?;
                match raw {
                    Some(raw) => serde_json::from_str::<JsonDbFile>(&raw).context("failed to decode sqlite state"),
                    None => Ok(JsonDbFile::default()),
                }
            }
            Self::Redis { url, namespace } => {
                let client = redis::Client::open(url.as_str()).context("failed to open redis client")?;
                let mut conn = client.get_connection().context("failed to connect to redis")?;
                Self::load_redis_state(&mut conn, namespace)
            }
            Self::Mongo { url, database, collection, document_id } => {
                let client = MongoClient::with_uri_str(url).context("failed to connect to mongodb")?;
                let coll = client.database(database).collection::<Document>(collection);
                let raw = coll
                    .find_one(doc! { "_id": document_id })
                    .run()
                    .context("failed to load mongodb state")?
                    .and_then(|doc| doc.get_str("value").ok().map(ToString::to_string));
                match raw {
                    Some(raw) => serde_json::from_str::<JsonDbFile>(&raw).context("failed to decode mongodb state"),
                    None => Ok(JsonDbFile::default()),
                }
            }
        }
    }

    fn save_state(&self, data: &JsonDbFile) -> Result<()> {
        let body = serde_json::to_string_pretty(data).context("failed to encode db")?;
        match self {
            Self::JsonFile { path } => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("failed to create {}", parent.display()))?;
                }
                fs::write(path, body).with_context(|| format!("failed to write {}", path.display()))
            }
            Self::Sqlite { path } => {
                let conn = Self::open_sqlite(path)?;
                conn.execute(
                    "INSERT INTO kv (key, value) VALUES (?1, ?2)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    params![STATE_KEY, body],
                )
                .context("failed to persist sqlite state")?;
                Ok(())
            }
            Self::Redis { url, namespace } => {
                let client = redis::Client::open(url.as_str()).context("failed to open redis client")?;
                let mut conn = client.get_connection().context("failed to connect to redis")?;
                Self::save_redis_state(&mut conn, namespace, data)?;
                Ok(())
            }
            Self::Mongo { url, database, collection, document_id } => {
                let client = MongoClient::with_uri_str(url).context("failed to connect to mongodb")?;
                let coll = client.database(database).collection::<Document>(collection);
                coll.replace_one(
                    doc! { "_id": document_id },
                    doc! { "_id": document_id, "value": body },
                )
                .upsert(true)
                .run()
                .context("failed to persist mongodb state")?;
                Ok(())
            }
        }
    }

    fn open_sqlite(path: &PathBuf) -> Result<Connection> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("failed to open sqlite db {}", path.display()))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
            [],
        )
        .context("failed to initialize sqlite schema")?;
        Ok(conn)
    }

    fn load_redis_state(conn: &mut redis::Connection, namespace: &str) -> Result<JsonDbFile> {
        let did_keys: Vec<String> = conn.keys(format!("{namespace}/dids/*")).context("failed to scan redis did keys")?;
        let op_keys: Vec<String> = conn.keys(format!("{namespace}/ops/*")).context("failed to scan redis op keys")?;
        let queue_keys: Vec<String> = conn
            .keys(format!("{namespace}/registry/*/queue"))
            .context("failed to scan redis queue keys")?;
        let block_keys: Vec<String> = conn
            .keys(format!("{namespace}/registry/*/blocks/*"))
            .context("failed to scan redis block keys")?;

        let mut data = JsonDbFile::default();

        for key in op_keys {
            let Some(opid) = key.rsplit('/').next() else { continue; };
            let raw: Option<String> = conn.get(&key).with_context(|| format!("failed to load redis op {key}"))?;
            if let Some(raw) = raw {
                let operation = serde_json::from_str::<Value>(&raw)
                    .with_context(|| format!("failed to decode redis op {key}"))?;
                data.ops.insert(opid.to_string(), operation);
            }
        }

        for key in did_keys {
            let Some(suffix) = key.rsplit('/').next() else { continue; };
            let raw_events: Vec<String> = conn
                .lrange(&key, 0, -1)
                .with_context(|| format!("failed to load redis did events {key}"))?;
            let mut events = Vec::with_capacity(raw_events.len());
            for raw in raw_events {
                let event = hydrate_redis_event(&raw, &data.ops)
                    .with_context(|| format!("failed to decode redis did event {key}"))?;
                events.push(event);
            }
            data.dids.insert(suffix.to_string(), events);
        }

        for key in queue_keys {
            let segments = key.split('/').collect::<Vec<_>>();
            if segments.len() < 4 {
                continue;
            }
            let registry = segments[2].to_string();
            let raw_ops: Vec<String> = conn
                .lrange(&key, 0, -1)
                .with_context(|| format!("failed to load redis queue {key}"))?;
            let mut ops = Vec::with_capacity(raw_ops.len());
            for raw in raw_ops {
                ops.push(
                    serde_json::from_str::<Value>(&raw)
                        .with_context(|| format!("failed to decode redis queue item {key}"))?,
                );
            }
            data.queue.insert(registry, ops);
        }

        for key in block_keys {
            let segments = key.split('/').collect::<Vec<_>>();
            if segments.len() < 5 {
                continue;
            }
            let registry = segments[2].to_string();
            let hash = segments[4].to_string();
            let raw: Option<String> = conn.get(&key).with_context(|| format!("failed to load redis block {key}"))?;
            if let Some(raw) = raw {
                let block = serde_json::from_str::<Value>(&raw)
                    .with_context(|| format!("failed to decode redis block {key}"))?;
                data.blocks.entry(registry).or_default().insert(hash, block);
            }
        }

        let import_queue_key = format!("{namespace}/import_queue");
        let raw_import_events: Vec<String> = conn
            .lrange(&import_queue_key, 0, -1)
            .context("failed to load redis import queue")?;
        for raw in raw_import_events {
            data.import_queue.push(
                serde_json::from_str::<EventRecord>(&raw)
                    .context("failed to decode redis import queue event")?,
            );
        }

        Ok(data)
    }

    fn save_redis_state(conn: &mut redis::Connection, namespace: &str, data: &JsonDbFile) -> Result<()> {
        let existing_keys: Vec<String> = conn
            .keys(format!("{namespace}/*"))
            .context("failed to scan redis namespace for persist")?;
        if !existing_keys.is_empty() {
            let _: usize = conn.del(existing_keys).context("failed to clear redis namespace before persist")?;
        }

        for (opid, operation) in &data.ops {
            let key = format!("{namespace}/ops/{opid}");
            let body = serde_json::to_string(operation).context("failed to encode redis operation")?;
            let _: () = conn.set(key, body).context("failed to persist redis operation")?;
        }

        for (suffix, events) in &data.dids {
            let key = format!("{namespace}/dids/{suffix}");
            for event in events {
                let stored = redis_event_to_stored_value(event);
                let body = serde_json::to_string(&stored).context("failed to serialize redis did event")?;
                let _: usize = conn.rpush(&key, body).context("failed to persist redis did event")?;
            }
        }

        for (registry, operations) in &data.queue {
            let key = format!("{namespace}/registry/{registry}/queue");
            for operation in operations {
                let body = serde_json::to_string(operation).context("failed to encode redis queue item")?;
                let _: usize = conn.rpush(&key, body).context("failed to persist redis queue item")?;
            }
        }

        for (registry, blocks) in &data.blocks {
            let mut max_height: Option<u64> = None;
            for (hash, block) in blocks {
                let block_key = format!("{namespace}/registry/{registry}/blocks/{hash}");
                let body = serde_json::to_string(block).context("failed to encode redis block")?;
                let _: () = conn.set(&block_key, body).context("failed to persist redis block")?;

                if let Some(height) = block.get("height").and_then(Value::as_u64) {
                    let height_map_key = format!("{namespace}/registry/{registry}/heightMap");
                    let _: usize = conn
                        .hset(&height_map_key, height.to_string(), hash)
                        .context("failed to persist redis block height map")?;
                    max_height = Some(max_height.map_or(height, |current| current.max(height)));
                }
            }

            if let Some(height) = max_height {
                let max_height_key = format!("{namespace}/registry/{registry}/maxHeight");
                let _: () = conn
                    .set(max_height_key, height.to_string())
                    .context("failed to persist redis max height")?;
            }
        }

        let import_queue_key = format!("{namespace}/import_queue");
        for event in &data.import_queue {
            let body = serde_json::to_string(event).context("failed to encode redis import queue event")?;
            let _: usize = conn
                .rpush(&import_queue_key, body)
                .context("failed to persist redis import queue event")?;
        }

        Ok(())
    }
}

impl GatekeeperDb for JsonDb {
    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String> { JsonDb::add_create_event(self, did, event) }
    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool> { JsonDb::add_followup_event(self, did, event) }
    fn get_events(&self, did: &str) -> Vec<EventRecord> { JsonDb::get_events(self, did) }
    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()> { JsonDb::set_events(self, did, events) }
    fn delete_events(&mut self, did: &str) -> Result<()> { JsonDb::delete_events(self, did) }
    fn reset_db(&mut self) -> Result<()> { JsonDb::reset_db(self) }
    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()> { JsonDb::add_operation(self, opid, operation) }
    fn get_operation(&self, opid: &str) -> Option<Value> { JsonDb::get_operation(self, opid) }
    fn push_import_event(&mut self, event: EventRecord) { JsonDb::push_import_event(self, event) }
    fn take_import_queue(&mut self) -> Vec<EventRecord> { JsonDb::take_import_queue(self) }
    fn import_queue_len(&self) -> usize { JsonDb::import_queue_len(self) }
    fn import_queue_snapshot(&self) -> Vec<EventRecord> { JsonDb::import_queue_snapshot(self) }
    fn clear_import_queue(&mut self) { JsonDb::clear_import_queue(self) }
    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize> { JsonDb::queue_operation(self, registry, operation) }
    fn get_queue(&self, registry: &str) -> Vec<Value> { JsonDb::get_queue(self, registry) }
    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool> { JsonDb::clear_queue(self, registry, operations) }
    fn add_block(&mut self, registry: &str, block: Value) -> Result<bool> { JsonDb::add_block(self, registry, block) }
    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value> { JsonDb::get_block(self, registry, block_id) }
    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String> { JsonDb::list_dids(self, prefix, requested) }
    fn resolve_doc(&self, config: &Config, did: &str, options: ResolveOptions) -> Result<Value> { JsonDb::resolve_doc(self, config, did, options) }
}
