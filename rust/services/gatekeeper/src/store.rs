use std::{collections::HashMap, env, fs, net::IpAddr, path::PathBuf, sync::Mutex as StdMutex};

use anyhow::{Context, Result};
use mongodb::{
    bson::{self, doc, Bson, Document},
    options::IndexOptions,
    sync::Client as MongoClient,
    IndexModel,
};
use redis::Commands;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::{config::Config, generate_json_cid};

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
    pub(crate) queue: HashMap<String, Vec<Value>>,
    #[serde(default)]
    pub(crate) blocks: HashMap<String, HashMap<String, Value>>,
    #[serde(default)]
    pub(crate) ops: HashMap<String, Value>,
}

pub(crate) struct JsonDb {
    pub(crate) backend: DbBackend,
    pub(crate) data: JsonDbFile,
    pub(crate) redis_connection: Option<StdMutex<redis::Connection>>,
}

#[derive(Clone)]
pub(crate) enum DbBackend {
    JsonFile {
        path: PathBuf,
    },
    Sqlite {
        path: PathBuf,
    },
    Redis {
        url: String,
        namespace: String,
    },
    Mongo {
        url: String,
        database: String,
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
    pub(crate) timestamp: Option<Value>,
}

pub(crate) enum BlockLookup {
    Height(u64),
    Hash(String),
}

pub(crate) fn compare_ordinals(
    left: Option<&Vec<u64>>,
    right: Option<&Vec<u64>>,
) -> std::cmp::Ordering {
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
            items
                .as_array()
                .map(|values| values.iter().filter_map(Value::as_u64).collect::<Vec<_>>())
        }),
        operation: value.get("operation").cloned().unwrap_or(Value::Null),
        opid: value
            .get("opid")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        did: value
            .get("did")
            .and_then(Value::as_str)
            .map(ToString::to_string),
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

pub(crate) fn hydrate_redis_event(
    raw: &str,
    ops: &HashMap<String, Value>,
) -> Result<EventRecord> {
    let mut event =
        serde_json::from_str::<EventRecord>(raw).context("failed to decode redis did event")?;
    if event.operation.is_null() {
        if let Some(opid) = event.opid.as_ref() {
            if let Some(operation) = ops.get(opid) {
                event.operation = operation.clone();
            }
        }
    }
    Ok(event)
}

fn encode_json_db_with_indent(data: &JsonDbFile) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    let formatter = serde_json::ser::PrettyFormatter::with_indent(b"    ");
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, formatter);
    serde::Serialize::serialize(data, &mut ser).context("failed to encode db")?;
    Ok(buf)
}

pub(crate) fn chrono_like_now() -> String {
    use std::time::SystemTime;
    let now = SystemTime::now();
    let datetime: chrono::DateTime<chrono::Utc> = now.into();
    datetime.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

impl JsonDb {
    fn did_suffix(did: &str) -> Result<String> {
        did.split(':')
            .next_back()
            .map(ToString::to_string)
            .context("invalid did suffix")
    }

    fn redis_did_key(namespace: &str, did: &str) -> Result<String> {
        let suffix = did.split(':').next_back().context("invalid did suffix")?;
        Ok(format!("{namespace}/dids/{suffix}"))
    }

    fn redis_operation_key(namespace: &str, opid: &str) -> String {
        format!("{namespace}/ops/{opid}")
    }

    fn redis_queue_key(namespace: &str, registry: &str) -> String {
        format!("{namespace}/registry/{registry}/queue")
    }

    fn redis_block_key(namespace: &str, registry: &str, hash: &str) -> String {
        format!("{namespace}/registry/{registry}/blocks/{hash}")
    }

    fn redis_height_map_key(namespace: &str, registry: &str) -> String {
        format!("{namespace}/registry/{registry}/heightMap")
    }

    fn redis_max_height_key(namespace: &str, registry: &str) -> String {
        format!("{namespace}/registry/{registry}/maxHeight")
    }

    fn with_redis_connection<T>(
        &self,
        f: impl FnOnce(&mut redis::Connection, &str) -> Result<T>,
    ) -> Result<T> {
        let DbBackend::Redis { namespace, .. } = &self.backend else {
            anyhow::bail!("backend is not redis");
        };
        let mutex = self
            .redis_connection
            .as_ref()
            .context("redis connection not initialized")?;
        let mut conn = mutex.lock().map_err(|_| anyhow::anyhow!("redis connection poisoned"))?;
        f(&mut conn, namespace)
    }

    pub(crate) fn load(config: &Config) -> Result<Self> {
        let backend = DbBackend::from_config(config);
        let data = backend.load_state()?;
        let redis_connection = match &backend {
            DbBackend::Redis { url, .. } => {
                let client =
                    redis::Client::open(url.as_str()).context("failed to open redis client")?;
                let conn = client
                    .get_connection()
                    .context("failed to connect to redis")?;
                Some(StdMutex::new(conn))
            }
            _ => None,
        };
        Ok(Self {
            backend,
            data,
            redis_connection,
        })
    }

    fn save(&self) -> Result<()> {
        self.backend.save_state(&self.data)
    }

    fn mongo_client(&self) -> Result<MongoClient> {
        let DbBackend::Mongo { url, .. } = &self.backend else {
            anyhow::bail!("backend is not mongodb");
        };
        MongoClient::with_uri_str(url).context("failed to connect to mongodb")
    }

    fn mongo_database_name(&self) -> Result<&str> {
        let DbBackend::Mongo { database, .. } = &self.backend else {
            anyhow::bail!("backend is not mongodb");
        };
        Ok(database.as_str())
    }

    fn event_to_mongo_bson(event: &EventRecord) -> Result<Bson> {
        let stored = redis_event_to_stored_value(event);
        bson::to_bson(&stored).context("failed to encode mongo event")
    }

    fn value_from_bson(bson: &Bson) -> Result<Value> {
        bson::from_bson::<Value>(bson.clone()).context("failed to decode bson value")
    }

    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            if !self.get_events(did).is_empty() {
                return Ok(did.to_string());
            }

            self.with_redis_connection(|conn, namespace| {
                if let Some(opid) = event.opid.as_ref() {
                    let op_key = Self::redis_operation_key(namespace, opid);
                    let body = serde_json::to_string(&event.operation)
                        .context("failed to encode redis operation")?;
                    let _: () = conn
                        .set(op_key, body)
                        .context("failed to persist redis operation")?;
                }
                let did_key = Self::redis_did_key(namespace, did)?;
                let stored = redis_event_to_stored_value(&event);
                let body = serde_json::to_string(&stored)
                    .context("failed to serialize redis did event")?;
                let _: usize = conn
                    .rpush(&did_key, body)
                    .context("failed to persist redis did event")?;
                Ok(())
            })?;
            return Ok(did.to_string());
        }

        if matches!(self.backend, DbBackend::Sqlite { .. } | DbBackend::Mongo { .. }) {
            if !self.get_events(did).is_empty() {
                return Ok(did.to_string());
            }

            let mut events = self.get_events(did);
            if let (Some(opid), operation) = (event.opid.clone(), event.operation.clone()) {
                self.add_operation(&opid, operation)?;
            }
            events.push(event);
            self.set_events(did, events)?;
            return Ok(did.to_string());
        }

        let suffix = Self::did_suffix(did)?;
        let was_empty = self
            .data
            .dids
            .get(&suffix)
            .map(|events| events.is_empty())
            .unwrap_or(true);
        if !was_empty {
            return Ok(did.to_string());
        }

        if let (Some(opid), operation) = (event.opid.clone(), event.operation.clone()) {
            self.data.ops.insert(opid, operation);
        }
        self.data
            .dids
            .entry(suffix)
            .or_default()
            .push(event.clone());

        self.save()?;
        Ok(did.to_string())
    }

    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
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

            let current_events = self.get_events(did);
            if current_events.is_empty() {
                anyhow::bail!("DID not found");
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

            self.with_redis_connection(|conn, namespace| {
                if let Some(opid) = event.opid.as_ref() {
                    let op_key = Self::redis_operation_key(namespace, opid);
                    let body = serde_json::to_string(&event.operation)
                        .context("failed to encode redis operation")?;
                    let _: () = conn
                        .set(op_key, body)
                        .context("failed to persist redis operation")?;
                }
                let did_key = Self::redis_did_key(namespace, did)?;
                let stored = redis_event_to_stored_value(&event);
                let body = serde_json::to_string(&stored)
                    .context("failed to serialize redis did event")?;
                let _: usize = conn
                    .rpush(&did_key, body)
                    .context("failed to persist redis did event")?;
                Ok(())
            })?;
            return Ok(true);
        }

        if matches!(self.backend, DbBackend::Sqlite { .. } | DbBackend::Mongo { .. }) {
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

            let mut events = self.get_events(did);
            if events.is_empty() {
                anyhow::bail!("DID not found");
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
                self.add_operation(&opid, operation)?;
            }
            events.push(event);
            self.set_events(did, events)?;
            return Ok(true);
        }

        let suffix = Self::did_suffix(did)?;

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

        let events = self.data.dids.get_mut(&suffix).context("DID not found")?;
        if events.is_empty() {
            anyhow::bail!("DID not found");
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
        events.push(event.clone());

        self.save()?;
        Ok(true)
    }

    fn get_events(&self, did: &str) -> Vec<EventRecord> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self
                .with_redis_connection(|conn, namespace| {
                    let key = Self::redis_did_key(namespace, did)?;
                    let raw_events: Vec<String> = conn
                        .lrange(&key, 0, -1)
                        .context("failed to load redis did events")?;
                    let parsed = raw_events
                        .iter()
                        .map(|raw| {
                            serde_json::from_str::<EventRecord>(raw)
                                .context("failed to decode redis did event")
                        })
                        .collect::<Result<Vec<_>>>()?;

                    let missing_opids = parsed
                        .iter()
                        .filter(|event| event.operation.is_null())
                        .filter_map(|event| event.opid.clone())
                        .collect::<Vec<_>>();

                    let mut events = Vec::with_capacity(raw_events.len());
                    let mut ops = HashMap::new();
                    if !missing_opids.is_empty() {
                        let op_keys = missing_opids
                            .iter()
                            .map(|opid| Self::redis_operation_key(namespace, opid))
                            .collect::<Vec<_>>();
                        let raw_operations: Vec<Option<String>> = conn
                            .get(op_keys)
                            .context("failed to batch load redis operations")?;
                        for (opid, raw_operation) in missing_opids.iter().zip(raw_operations) {
                            if let Some(raw_operation) = raw_operation {
                                let operation = serde_json::from_str::<Value>(&raw_operation)
                                    .context("failed to decode redis operation")?;
                                ops.insert(opid.clone(), operation);
                            }
                        }
                    }

                    for (raw, parsed) in raw_events.into_iter().zip(parsed.into_iter()) {
                        if let Some(opid) = parsed.opid.as_ref() {
                            if !parsed.operation.is_null() {
                                ops.insert(opid.clone(), parsed.operation.clone());
                            }
                        }
                        let event = hydrate_redis_event(&raw, &ops)?;
                        events.push(event);
                    }
                    Ok(events)
                })
                .unwrap_or_default();
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let id = match Self::did_suffix(did) {
                Ok(id) => id,
                Err(_) => return Vec::new(),
            };
            let conn = match DbBackend::open_sqlite(path) {
                Ok(conn) => conn,
                Err(_) => return Vec::new(),
            };
            let raw = match conn.query_row(
                "SELECT events FROM dids WHERE id = ?1",
                [id.as_str()],
                |row| row.get::<_, String>(0),
            ).optional() {
                Ok(raw) => raw,
                Err(_) => return Vec::new(),
            };
            let Some(raw) = raw else {
                return Vec::new();
            };
            let stored = match serde_json::from_str::<Vec<EventRecord>>(&raw) {
                Ok(stored) => stored,
                Err(_) => return Vec::new(),
            };
            return stored
                .into_iter()
                .map(|mut event| {
                    if event.operation.is_null() {
                        if let Some(opid) = event.opid.as_ref() {
                            if let Some(operation) = self.get_operation(opid) {
                                event.operation = operation;
                            }
                        }
                    }
                    event
                })
                .collect();
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let id = match Self::did_suffix(did) {
                Ok(id) => id,
                Err(_) => return Vec::new(),
            };
            let client = match self.mongo_client() {
                Ok(client) => client,
                Err(_) => return Vec::new(),
            };
            let database = match self.mongo_database_name() {
                Ok(database) => database,
                Err(_) => return Vec::new(),
            };
            let coll = client.database(database).collection::<Document>("dids");
            let row = match coll.find_one(doc! { "id": &id }).run() {
                Ok(row) => row,
                Err(_) => return Vec::new(),
            };
            let Some(row) = row else {
                return Vec::new();
            };
            let events = match row.get_array("events") {
                Ok(events) => events.clone(),
                Err(_) => return Vec::new(),
            };
            return events
                .into_iter()
                .filter_map(|item| {
                    let mut event = bson::from_bson::<EventRecord>(item).ok()?;
                    if event.operation.is_null() {
                        if let Some(opid) = event.opid.as_ref() {
                            if let Some(operation) = self.get_operation(opid) {
                                event.operation = operation;
                            }
                        }
                    }
                    Some(event)
                })
                .collect();
        }

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
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let did_key = Self::redis_did_key(namespace, did)?;
                let mut pipe = redis::pipe();
                pipe.atomic().del(&did_key);
                let mut payloads = Vec::with_capacity(events.len());
                for event in &events {
                    if let Some(opid) = event.opid.as_ref() {
                        let op_key = Self::redis_operation_key(namespace, opid);
                        let body = serde_json::to_string(&event.operation)
                            .context("failed to encode redis operation")?;
                        pipe.cmd("SET").arg(op_key).arg(body);
                    }
                    let stored = redis_event_to_stored_value(event);
                    payloads.push(
                        serde_json::to_string(&stored)
                            .context("failed to serialize redis did event")?,
                    );
                }
                if !payloads.is_empty() {
                    pipe.cmd("RPUSH").arg(&did_key).arg(payloads);
                }
                let _: () = pipe
                    .query(conn)
                    .context("failed to persist redis did events")?;
                Ok(())
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let id = Self::did_suffix(did)?;
            let conn = DbBackend::open_sqlite(path)?;
            let mut stripped_events = Vec::with_capacity(events.len());
            for event in &events {
                if let Some(opid) = event.opid.as_ref() {
                    self.add_operation(opid, event.operation.clone())?;
                }
                let stored = redis_event_to_stored_value(event);
                stripped_events.push(
                    serde_json::from_value::<EventRecord>(stored)
                        .context("failed to encode sqlite did event")?,
                );
            }
            conn.execute(
                "INSERT INTO dids(id, events) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET events = excluded.events",
                params![id, serde_json::to_string(&stripped_events)?],
            )
            .context("failed to persist sqlite did events")?;
            return Ok(());
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let id = Self::did_suffix(did)?;
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            let coll = client.database(&database).collection::<Document>("dids");
            let mut encoded = Vec::with_capacity(events.len());
            for event in &events {
                if let Some(opid) = event.opid.as_ref() {
                    self.add_operation(opid, event.operation.clone())?;
                }
                encoded.push(Self::event_to_mongo_bson(event)?);
            }
            coll.update_one(
                doc! { "id": &id },
                doc! { "$set": { "id": &id, "events": encoded } },
            )
            .upsert(true)
            .run()
            .context("failed to persist mongodb did events")?;
            return Ok(());
        }

        let suffix = Self::did_suffix(did)?;
        for event in &events {
            if let Some(opid) = event.opid.as_ref() {
                self.data.ops.insert(opid.clone(), event.operation.clone());
            }
        }
        self.data.dids.insert(suffix, events.clone());

        self.save()
    }

    fn delete_events(&mut self, did: &str) -> Result<()> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let did_key = Self::redis_did_key(namespace, did)?;
                let _: usize = conn
                    .del(&did_key)
                    .context("failed to delete redis did events")?;
                Ok(())
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let id = Self::did_suffix(did)?;
            let conn = DbBackend::open_sqlite(path)?;
            conn.execute("DELETE FROM dids WHERE id = ?1", [id])
                .context("failed to delete sqlite did events")?;
            return Ok(());
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let id = Self::did_suffix(did)?;
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            client
                .database(&database)
                .collection::<Document>("dids")
                .delete_one(doc! { "id": &id })
                .run()
                .context("failed to delete mongodb did events")?;
            return Ok(());
        }

        let suffix = Self::did_suffix(did)?;
        self.data.dids.remove(&suffix);
        self.save()
    }

    fn reset_db(&mut self) -> Result<()> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let mut cursor = 0_u64;
                loop {
                    let (next_cursor, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                        .arg(cursor)
                        .arg("MATCH")
                        .arg(format!("{namespace}/*"))
                        .arg("COUNT")
                        .arg(1000)
                        .query(conn)
                        .context("failed to scan redis namespace for reset")?;
                    if !keys.is_empty() {
                        let _: usize = conn
                            .del(keys)
                            .context("failed to delete redis namespace keys")?;
                    }
                    if next_cursor == 0 {
                        break;
                    }
                    cursor = next_cursor;
                }
                Ok(())
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            conn.execute("DELETE FROM dids", [])
                .context("failed to clear sqlite dids")?;
            conn.execute("DELETE FROM queue", [])
                .context("failed to clear sqlite queue")?;
            conn.execute("DELETE FROM blocks", [])
                .context("failed to clear sqlite blocks")?;
            conn.execute("DELETE FROM operations", [])
                .context("failed to clear sqlite operations")?;
            return Ok(());
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            let db = client.database(&database);
            db.collection::<Document>("dids")
                .delete_many(doc! {})
                .run()
                .context("failed to clear mongodb dids")?;
            db.collection::<Document>("queue")
                .delete_many(doc! {})
                .run()
                .context("failed to clear mongodb queue")?;
            db.collection::<Document>("operations")
                .delete_many(doc! {})
                .run()
                .context("failed to clear mongodb operations")?;
            return Ok(());
        }

        self.data = JsonDbFile::default();
        self.save()
    }

    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let key = Self::redis_operation_key(namespace, opid);
                let body = serde_json::to_string(&operation)
                    .context("failed to encode redis operation")?;
                let _: () = conn
                    .set(key, body)
                    .context("failed to persist redis operation")?;
                Ok(())
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            conn.execute(
                "INSERT INTO operations(opid, operation) VALUES (?1, ?2)
                 ON CONFLICT(opid) DO UPDATE SET operation = excluded.operation",
                params![opid, serde_json::to_string(&operation)?],
            )
            .context("failed to persist sqlite operation")?;
            return Ok(());
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            let coll = client.database(&database).collection::<Document>("operations");
            let mut op_doc = bson::to_document(&operation).context("failed to encode mongodb operation")?;
            op_doc.insert("opid", opid);
            coll.update_one(doc! { "opid": opid }, doc! { "$set": op_doc })
                .upsert(true)
                .run()
                .context("failed to persist mongodb operation")?;
            return Ok(());
        }

        self.data.ops.insert(opid.to_string(), operation.clone());
        self.save()
    }

    fn get_operation(&self, opid: &str) -> Option<Value> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self
                .with_redis_connection(|conn, namespace| {
                    let key = Self::redis_operation_key(namespace, opid);
                    let raw: Option<String> = conn
                        .get(&key)
                        .context("failed to load redis operation")?;
                    raw.map(|raw| {
                        serde_json::from_str::<Value>(&raw)
                            .context("failed to decode redis operation")
                    })
                    .transpose()
                })
                .ok()
                .flatten();
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path).ok()?;
            let raw = conn
                .query_row(
                    "SELECT operation FROM operations WHERE opid = ?1",
                    [opid],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()??;
            return serde_json::from_str(&raw).ok();
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client().ok()?;
            let database = self.mongo_database_name().ok()?.to_string();
            let doc = client
                .database(&database)
                .collection::<Document>("operations")
                .find_one(doc! { "opid": opid })
                .projection(doc! { "_id": 0, "opid": 0 })
                .run()
                .ok()??;
            return bson::from_document::<Value>(doc).ok();
        }

        self.data.ops.get(opid).cloned()
    }

    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let key = Self::redis_queue_key(namespace, registry);
                let body = serde_json::to_string(&operation)
                    .context("failed to encode redis queue item")?;
                let len: usize = conn
                    .rpush(&key, body)
                    .context("failed to persist redis queue item")?;
                Ok(len)
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            let raw = conn
                .query_row("SELECT ops FROM queue WHERE id = ?1", [registry], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
                .context("failed to load sqlite queue")?;
            let mut ops = raw
                .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
                .unwrap_or_default();
            ops.push(operation);
            conn.execute(
                "INSERT INTO queue(id, ops) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET ops = excluded.ops",
                params![registry, serde_json::to_string(&ops)?],
            )
            .context("failed to persist sqlite queue")?;
            return Ok(ops.len());
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            let coll = client.database(&database).collection::<Document>("queue");
            let result = coll
                .find_one_and_update(
                    doc! { "id": registry },
                    doc! { "$push": { "ops": bson::to_bson(&operation).context("failed to encode mongodb queue item")? } },
                )
                .upsert(true)
                .return_document(mongodb::options::ReturnDocument::After)
                .run()
                .context("failed to persist mongodb queue")?;
            let len = result
                .as_ref()
                .and_then(|doc| doc.get_array("ops").ok())
                .map(|ops| ops.len())
                .unwrap_or(0);
            return Ok(len);
        }

        let len = {
            let queue = self.data.queue.entry(registry.to_string()).or_default();
            queue.push(operation.clone());
            queue.len()
        };
        self.save()?;
        Ok(len)
    }

    fn get_queue(&self, registry: &str) -> Vec<Value> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self
                .with_redis_connection(|conn, namespace| {
                    let key = Self::redis_queue_key(namespace, registry);
                    let raw_ops: Vec<String> = conn
                        .lrange(&key, 0, -1)
                        .context("failed to load redis queue")?;
                    raw_ops
                        .into_iter()
                        .map(|raw| {
                            serde_json::from_str::<Value>(&raw)
                                .context("failed to decode redis queue item")
                        })
                        .collect::<Result<Vec<_>>>()
                })
                .unwrap_or_default();
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = match DbBackend::open_sqlite(path) {
                Ok(conn) => conn,
                Err(_) => return Vec::new(),
            };
            let raw = match conn
                .query_row("SELECT ops FROM queue WHERE id = ?1", [registry], |row| {
                    row.get::<_, String>(0)
                })
                .optional()
            {
                Ok(raw) => raw,
                Err(_) => return Vec::new(),
            };
            return raw
                .and_then(|raw| serde_json::from_str::<Vec<Value>>(&raw).ok())
                .unwrap_or_default();
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = match self.mongo_client() {
                Ok(client) => client,
                Err(_) => return Vec::new(),
            };
            let database = match self.mongo_database_name() {
                Ok(database) => database.to_string(),
                Err(_) => return Vec::new(),
            };
            let row = match client
                .database(&database)
                .collection::<Document>("queue")
                .find_one(doc! { "id": registry })
                .run()
            {
                Ok(row) => row,
                Err(_) => return Vec::new(),
            };
            let Some(row) = row else {
                return Vec::new();
            };
            return row
                .get_array("ops")
                .ok()
                .map(|ops| {
                    ops.iter()
                        .filter_map(|item| Self::value_from_bson(item).ok())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
        }

        self.data.queue.get(registry).cloned().unwrap_or_default()
    }

    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool> {
        let proof_values = operations
            .iter()
            .filter_map(|value| {
                value
                    .get("proof")
                    .and_then(|proof| proof.get("proofValue"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>();

        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let key = Self::redis_queue_key(namespace, registry);
                let script = r#"
                    local key = KEYS[1]
                    local n = tonumber(ARGV[1])
                    local idx = 2
                    local want = {}
                    for i = 1, n do
                      want[ARGV[idx]] = true
                      idx = idx + 1
                    end
                    local list = redis.call('LRANGE', key, 0, -1)
                    if #list == 0 then return 0 end
                    local keep = {}
                    for i = 1, #list do
                      local ok, obj = pcall(cjson.decode, list[i])
                      if ok and obj and obj.proof and obj.proof.proofValue and want[obj.proof.proofValue] then
                      else
                        table.insert(keep, list[i])
                      end
                    end
                    redis.call('DEL', key)
                    if #keep > 0 then
                      redis.call('RPUSH', key, unpack(keep))
                    end
                    return #list - #keep
                "#;
                let _: i64 = redis::cmd("EVAL")
                    .arg(script)
                    .arg(1)
                    .arg(&key)
                    .arg(proof_values.len())
                    .arg(&proof_values)
                    .query(conn)
                    .context("failed to clear redis queue entries")?;
                Ok(true)
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            let mut queue = self.get_queue(registry);
            queue.retain(|item| {
                let proof_value = item
                    .get("proof")
                    .and_then(|proof| proof.get("proofValue"))
                    .and_then(Value::as_str);
                !proof_values.iter().any(|value| Some(*value) == proof_value)
            });
            conn.execute(
                "INSERT INTO queue(id, ops) VALUES (?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET ops = excluded.ops",
                params![registry, serde_json::to_string(&queue)?],
            )
            .context("failed to persist sqlite cleared queue")?;
            return Ok(true);
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            client
                .database(&database)
                .collection::<Document>("queue")
                .update_one(
                    doc! { "id": registry },
                    doc! { "$pull": { "ops": { "proof.proofValue": { "$in": bson::to_bson(&proof_values)? } } } },
                )
                .run()
                .context("failed to clear mongodb queue entries")?;
            return Ok(true);
        }

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

        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let block_key = Self::redis_block_key(namespace, registry, &hash);
                let body = serde_json::to_string(&block).context("failed to encode redis block")?;
                if let Some(height) = block.get("height").and_then(Value::as_u64) {
                    let height_map_key = Self::redis_height_map_key(namespace, registry);
                    let max_height_key = Self::redis_max_height_key(namespace, registry);
                    let current_max: Option<String> = conn
                        .get(&max_height_key)
                        .context("failed to load redis max height")?;
                    let current_max = current_max
                        .as_deref()
                        .and_then(|value| value.parse::<u64>().ok())
                        .unwrap_or(0);
                    let next_max = current_max.max(height);
                    let mut pipe = redis::pipe();
                    pipe.atomic()
                        .cmd("SET")
                        .arg(&block_key)
                        .arg(body)
                        .cmd("HSET")
                        .arg(&height_map_key)
                        .arg(height.to_string())
                        .arg(&hash)
                        .cmd("SET")
                        .arg(&max_height_key)
                        .arg(next_max.to_string());
                    let _: () = pipe
                        .query(conn)
                        .context("failed to persist redis block transaction")?;
                } else {
                    let _: () = conn
                        .set(&block_key, body)
                        .context("failed to persist redis block")?;
                }
                Ok(true)
            });
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            let time_value = match block.get("time") {
                Some(Value::String(value)) => value.clone(),
                Some(Value::Number(value)) => value.to_string(),
                _ => String::new(),
            };
            let txns = block
                .get("txns")
                .and_then(Value::as_i64)
                .or_else(|| block.get("txns").and_then(Value::as_u64).map(|value| value as i64))
                .unwrap_or(0);
            conn.execute(
                "INSERT OR REPLACE INTO blocks (registry, hash, height, time, txns) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    registry,
                    hash,
                    block.get("height").and_then(Value::as_u64).unwrap_or(0) as i64,
                    time_value,
                    txns
                ],
            )
            .context("failed to persist sqlite block")?;
            return Ok(true);
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            let database = self.mongo_database_name()?.to_string();
            let coll = client.database(&database).collection::<Document>("blocks");
            let mut block_doc = bson::to_document(&block).context("failed to encode mongodb block")?;
            block_doc.insert("registry", registry);
            coll.update_one(
                doc! { "registry": registry, "hash": &hash },
                doc! { "$set": block_doc },
            )
            .upsert(true)
            .run()
            .context("failed to persist mongodb block")?;
            return Ok(true);
        }

        self.data
            .blocks
            .entry(registry.to_string())
            .or_default()
            .insert(hash.clone(), block.clone());
        self.save()?;
        Ok(true)
    }

    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self
                .with_redis_connection(|conn, namespace| {
                    let block_hash = match block_id {
                        None => {
                            let max_height_str: Option<String> = conn
                                .get(Self::redis_max_height_key(namespace, registry))
                                .context("failed to load redis max height")?;
                            let Some(max_height_str) = max_height_str else {
                                return Ok(None);
                            };
                            conn.hget(
                                Self::redis_height_map_key(namespace, registry),
                                max_height_str,
                            )
                            .context("failed to load redis latest block hash")?
                        }
                        Some(BlockLookup::Height(height)) => conn
                            .hget(Self::redis_height_map_key(namespace, registry), height.to_string())
                            .context("failed to load redis block hash by height")?,
                        Some(BlockLookup::Hash(hash)) => Some(hash),
                    };

                    let Some(block_hash) = block_hash else {
                        return Ok(None);
                    };

                    let raw: Option<String> = conn
                        .get(Self::redis_block_key(namespace, registry, &block_hash))
                        .context("failed to load redis block")?;
                    raw.map(|raw| {
                        serde_json::from_str::<Value>(&raw).context("failed to decode redis block")
                    })
                    .transpose()
                })
                .ok()
                .flatten();
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path).ok()?;
            let query = match block_id {
                None => ("SELECT registry, hash, height, time, txns FROM blocks WHERE registry = ?1 ORDER BY height DESC LIMIT 1", vec![registry.to_string()]),
                Some(BlockLookup::Height(height)) => ("SELECT registry, hash, height, time, txns FROM blocks WHERE registry = ?1 AND height = ?2", vec![registry.to_string(), height.to_string()]),
                Some(BlockLookup::Hash(hash)) => ("SELECT registry, hash, height, time, txns FROM blocks WHERE registry = ?1 AND hash = ?2", vec![registry.to_string(), hash]),
            };
            let mut stmt = conn.prepare(query.0).ok()?;
            let row = stmt
                .query_row(rusqlite::params_from_iter(query.1.iter()), |row: &rusqlite::Row<'_>| {
                    Ok(json!({
                        "registry": row.get::<_, String>(0)?,
                        "hash": row.get::<_, String>(1)?,
                        "height": row.get::<_, i64>(2)?,
                        "time": row.get::<_, String>(3)?,
                        "txns": row.get::<_, i64>(4)?,
                    }))
                })
                .optional()
                .ok()?;
            return row;
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client().ok()?;
            let database = self.mongo_database_name().ok()?.to_string();
            let coll = client.database(&database).collection::<Document>("blocks");
            let result = match block_id {
                None => coll
                    .find(doc! { "registry": registry })
                    .sort(doc! { "height": -1 })
                    .limit(1)
                    .run()
                    .ok()
                    .and_then(|mut cursor| cursor.next().transpose().ok().flatten()),
                Some(BlockLookup::Height(height)) => coll
                    .find_one(doc! { "registry": registry, "height": height as i64 })
                    .run()
                    .ok()
                    .flatten(),
                Some(BlockLookup::Hash(hash)) => coll
                    .find_one(doc! { "registry": registry, "hash": hash })
                    .run()
                    .ok()
                    .flatten(),
            }?;
            return bson::from_document::<Value>(result).ok();
        }

        let registry_blocks = self.data.blocks.get(registry)?;
        if registry_blocks.is_empty() {
            return None;
        }

        match block_id {
            None => registry_blocks
                .values()
                .filter_map(|block| {
                    block
                        .get("height")
                        .and_then(Value::as_u64)
                        .map(|height| (height, block.clone()))
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
        if matches!(self.backend, DbBackend::Redis { .. }) {
            if let Some(items) = requested {
                return items.to_vec();
            }

            return self
                .with_redis_connection(|conn, namespace| {
                    let mut suffixes = conn
                        .keys::<_, Vec<String>>(format!("{namespace}/dids/*"))
                        .context("failed to scan redis did keys")?
                        .into_iter()
                        .filter_map(|key| key.rsplit('/').next().map(ToString::to_string))
                        .collect::<Vec<_>>();
                    suffixes.sort();
                    Ok(suffixes
                        .into_iter()
                        .map(|suffix| format!("{prefix}:{suffix}"))
                        .collect::<Vec<_>>())
                })
                .unwrap_or_default();
        }

        if let Some(items) = requested {
            return items.to_vec();
        }

        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = match DbBackend::open_sqlite(path) {
                Ok(conn) => conn,
                Err(_) => return Vec::new(),
            };
            let mut stmt = match conn.prepare("SELECT id FROM dids ORDER BY id") {
                Ok(stmt) => stmt,
                Err(_) => return Vec::new(),
            };
            let rows = match stmt.query_map([], |row| row.get::<_, String>(0)) {
                Ok(rows) => rows,
                Err(_) => return Vec::new(),
            };
            return rows
                .filter_map(|row| row.ok())
                .map(|suffix| format!("{prefix}:{suffix}"))
                .collect();
        }

        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = match self.mongo_client() {
                Ok(client) => client,
                Err(_) => return Vec::new(),
            };
            let database = match self.mongo_database_name() {
                Ok(database) => database.to_string(),
                Err(_) => return Vec::new(),
            };
            let rows = match client
                .database(&database)
                .collection::<Document>("dids")
                .find(doc! {})
                .run()
            {
                Ok(rows) => rows,
                Err(_) => return Vec::new(),
            };
            let mut ids = rows
                .filter_map(|row| row.ok())
                .filter_map(|row| row.get_str("id").ok().map(ToString::to_string))
                .collect::<Vec<_>>();
            ids.sort();
            return ids
                .into_iter()
                .map(|suffix| format!("{prefix}:{suffix}"))
                .collect();
        }

        match requested {
            Some(items) => items.to_vec(),
            None => {
                let mut keys = self.data.dids.keys().cloned().collect::<Vec<_>>();
                keys.sort();
                keys.into_iter()
                    .map(|suffix| format!("{prefix}:{suffix}"))
                    .collect()
            }
        }
    }

    pub(crate) fn block_timestamp_bounds(&self, registry: &str, event: &EventRecord) -> (Option<Value>, Option<Value>) {
        let lower = event
            .operation
            .get("blockid")
            .and_then(Value::as_str)
            .and_then(|hash| self.get_block(registry, Some(BlockLookup::Hash(hash.to_string()))))
            .map(|block| json!({
                "time": block.get("time").cloned().unwrap_or(Value::Null),
                "timeISO": block.get("time")
                    .and_then(Value::as_u64)
                    .and_then(|time| chrono::DateTime::<chrono::Utc>::from_timestamp(time as i64, 0))
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                "blockid": block.get("hash").cloned().unwrap_or(Value::Null),
                "height": block.get("height").cloned().unwrap_or(Value::Null)
            }));

        let registration = event
            .operation
            .get("registration")
            .cloned()
            .or_else(|| {
                // registration may be attached at the event level for batch-imported events
                None
            });
        let upper = registration.as_ref().and_then(|reg| {
            let height = reg.get("height").and_then(Value::as_u64)?;
            let block = self.get_block(registry, Some(BlockLookup::Height(height)))?;
            Some(json!({
                "time": block.get("time").cloned().unwrap_or(Value::Null),
                "timeISO": block.get("time")
                    .and_then(Value::as_u64)
                    .and_then(|time| chrono::DateTime::<chrono::Utc>::from_timestamp(time as i64, 0))
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                    .map(Value::String)
                    .unwrap_or(Value::Null),
                "blockid": block.get("hash").cloned().unwrap_or(Value::Null),
                "height": block.get("height").cloned().unwrap_or(Value::Null),
                "txid": reg.get("txid").cloned().unwrap_or(Value::Null),
                "txidx": reg.get("index").cloned().unwrap_or(Value::Null),
                "batchid": reg.get("batch").cloned().unwrap_or(Value::Null),
                "opidx": reg.get("opidx").cloned().unwrap_or(Value::Null)
            }))
        });

        (lower, upper)
    }

    pub(crate) fn build_timestamp(
        &self,
        registry: &str,
        version_id: &str,
        event: &EventRecord,
    ) -> Option<Value> {
        let (lower, upper) = self.block_timestamp_bounds(registry, event);
        if lower.is_none() && upper.is_none() {
            return None;
        }
        Some(json!({
            "chain": registry,
            "opid": version_id,
            "lowerBound": lower.unwrap_or(Value::Null),
            "upperBound": upper.unwrap_or(Value::Null)
        }))
    }

    fn resolve_doc(&self, _config: &Config, did: &str, options: ResolveOptions) -> Result<Value> {
        let _ = did.split(':').next_back().context("invalid did suffix")?;
        let events = self.get_events(did);
        if events.is_empty() {
            anyhow::bail!("DID not found");
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
        let created = anchor_operation
            .get("created")
            .and_then(Value::as_str)
            .unwrap_or("");

        let initial_document = match did_type {
            "agent" => {
                let public_jwk = anchor_operation
                    .get("publicJwk")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
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
            did_document_data: anchor_operation
                .get("data")
                .cloned()
                .unwrap_or_else(|| json!({})),
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
            timestamp: None,
        };

        let anchor_registry = state
            .did_document_registration
            .get("registry")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if let Some(registry) = anchor_registry.as_deref() {
            state.timestamp = self.build_timestamp(registry, &state.version_id, anchor);
        }

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

            let registry_for_timestamp = state
                .did_document_registration
                .get("registry")
                .and_then(Value::as_str)
                .map(ToString::to_string);

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

            if let Some(registry) = registry_for_timestamp.as_deref() {
                state.timestamp = self.build_timestamp(registry, &state.version_id, event);
            }
        }

        if let Some(registration) = state.did_document_registration.as_object_mut() {
            registration.remove("opid");
            registration.remove("registration");
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
        if let Some(timestamp) = state.timestamp.clone() {
            metadata["timestamp"] = timestamp;
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
                path: config.data_dir.join("archon.db"),
            },
            "redis" => Self::Redis {
                url: env::var("ARCHON_REDIS_URL")
                    .unwrap_or_else(|_| "redis://localhost:6379".to_string()),
                namespace: "archon".to_string(),
            },
            "mongodb" => Self::Mongo {
                url: env::var("ARCHON_MONGODB_URL")
                    .unwrap_or_else(|_| "mongodb://localhost:27017".to_string()),
                database: "archon".to_string(),
            },
            _ => Self::JsonFile {
                path: config.data_dir.join("archon.json"),
            },
        }
    }

    fn load_state(&self) -> Result<JsonDbFile> {
        match self {
            Self::JsonFile { path } => match fs::read_to_string(path) {
                Ok(raw) => {
                    serde_json::from_str::<JsonDbFile>(&raw).context("failed to decode json db")
                }
                Err(_) => Ok(JsonDbFile::default()),
            },
            Self::Sqlite { path } => {
                let _ = Self::open_sqlite(path)?;
                Ok(JsonDbFile::default())
            }
            Self::Redis { .. } => Ok(JsonDbFile::default()),
            Self::Mongo { url, database, .. } => {
                let client =
                    MongoClient::with_uri_str(url).context("failed to connect to mongodb")?;
                let db = client.database(database);
                db.collection::<Document>("dids")
                    .create_index(IndexModel::builder().keys(doc! { "id": 1 }).build())
                    .run()
                    .context("failed to initialize mongodb did index")?;
                db.collection::<Document>("blocks")
                    .create_index(
                        IndexModel::builder()
                            .keys(doc! { "registry": 1, "height": -1 })
                            .build(),
                    )
                    .run()
                    .context("failed to initialize mongodb block height index")?;
                db.collection::<Document>("blocks")
                    .create_index(
                        IndexModel::builder()
                            .keys(doc! { "registry": 1, "hash": 1 })
                            .options(IndexOptions::builder().unique(Some(true)).build())
                            .build(),
                    )
                    .run()
                    .context("failed to initialize mongodb block hash index")?;
                db.collection::<Document>("operations")
                    .create_index(
                        IndexModel::builder()
                            .keys(doc! { "opid": 1 })
                            .options(IndexOptions::builder().unique(Some(true)).build())
                            .build(),
                    )
                    .run()
                    .context("failed to initialize mongodb op index")?;
                Ok(JsonDbFile::default())
            }
        }
    }

    fn save_state(&self, data: &JsonDbFile) -> Result<()> {
        match self {
            Self::JsonFile { path } => {
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent)
                        .with_context(|| format!("failed to create {}", parent.display()))?;
                }
                let body = encode_json_db_with_indent(data)?;
                fs::write(path, body).with_context(|| format!("failed to write {}", path.display()))
            }
            Self::Sqlite { path } => {
                let _ = Self::open_sqlite(path)?;
                let _ = data;
                anyhow::bail!("sqlite snapshot persistence is disabled; use direct table operations")
            }
            Self::Redis { url, namespace } => {
                let client =
                    redis::Client::open(url.as_str()).context("failed to open redis client")?;
                let mut conn = client
                    .get_connection()
                    .context("failed to connect to redis")?;
                let keyspace_size = conn
                    .keys::<_, Vec<String>>(format!("{namespace}/*"))
                    .context("failed to scan redis namespace for guardrail")?
                    .len();
                let _ = data;
                anyhow::bail!(
                    "full redis snapshot persistence is disabled for safety; refusing to rewrite namespace `{namespace}` containing {keyspace_size} keys"
                )
            }
            Self::Mongo { url, database, .. } => {
                let client =
                    MongoClient::with_uri_str(url).context("failed to connect to mongodb")?;
                let _ = client.database(database);
                let _ = data;
                anyhow::bail!("mongodb snapshot persistence is disabled; use direct collection operations")
            }
        }
    }

    fn open_sqlite(path: &PathBuf) -> Result<Connection> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("failed to open sqlite db {}", path.display()))?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS dids (
                id TEXT PRIMARY KEY,
                events TEXT NOT NULL
            )",
            [],
        )
        .context("failed to initialize sqlite did schema")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS queue (
                id TEXT PRIMARY KEY,
                ops TEXT NOT NULL
            )",
            [],
        )
        .context("failed to initialize sqlite queue schema")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS blocks (
                registry TEXT NOT NULL,
                hash TEXT NOT NULL,
                height INTEGER NOT NULL,
                time TEXT NOT NULL,
                txns INTEGER NOT NULL,
                PRIMARY KEY (registry, hash)
            )",
            [],
        )
        .context("failed to initialize sqlite blocks schema")?;
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_registry_height ON blocks (registry, height)",
            [],
        )
        .context("failed to initialize sqlite block height index")?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS operations (
                opid TEXT PRIMARY KEY,
                operation TEXT NOT NULL
            )",
            [],
        )
        .context("failed to initialize sqlite operations schema")?;
        Ok(conn)
    }

}

impl GatekeeperDb for JsonDb {
    fn add_create_event(&mut self, did: &str, event: EventRecord) -> Result<String> {
        JsonDb::add_create_event(self, did, event)
    }
    fn add_followup_event(&mut self, did: &str, event: EventRecord) -> Result<bool> {
        JsonDb::add_followup_event(self, did, event)
    }
    fn get_events(&self, did: &str) -> Vec<EventRecord> {
        JsonDb::get_events(self, did)
    }
    fn set_events(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()> {
        JsonDb::set_events(self, did, events)
    }
    fn delete_events(&mut self, did: &str) -> Result<()> {
        JsonDb::delete_events(self, did)
    }
    fn reset_db(&mut self) -> Result<()> {
        JsonDb::reset_db(self)
    }
    fn add_operation(&mut self, opid: &str, operation: Value) -> Result<()> {
        JsonDb::add_operation(self, opid, operation)
    }
    fn get_operation(&self, opid: &str) -> Option<Value> {
        JsonDb::get_operation(self, opid)
    }
    fn queue_operation(&mut self, registry: &str, operation: Value) -> Result<usize> {
        JsonDb::queue_operation(self, registry, operation)
    }
    fn get_queue(&self, registry: &str) -> Vec<Value> {
        JsonDb::get_queue(self, registry)
    }
    fn clear_queue(&mut self, registry: &str, operations: &[Value]) -> Result<bool> {
        JsonDb::clear_queue(self, registry, operations)
    }
    fn add_block(&mut self, registry: &str, block: Value) -> Result<bool> {
        JsonDb::add_block(self, registry, block)
    }
    fn get_block(&self, registry: &str, block_id: Option<BlockLookup>) -> Option<Value> {
        JsonDb::get_block(self, registry, block_id)
    }
    fn list_dids(&self, prefix: &str, requested: Option<&[String]>) -> Vec<String> {
        JsonDb::list_dids(self, prefix, requested)
    }
    fn resolve_doc(&self, config: &Config, did: &str, options: ResolveOptions) -> Result<Value> {
        JsonDb::resolve_doc(self, config, did, options)
    }
}
