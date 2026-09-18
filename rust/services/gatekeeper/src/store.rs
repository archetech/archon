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

#[derive(Clone, PartialEq, Serialize, Deserialize)]
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) registration: Option<Value>,
}

#[derive(Default, Serialize, Deserialize)]
pub(crate) struct JsonDbFile {
    pub(crate) dids: HashMap<String, Vec<EventRecord>>,
    #[serde(default)]
    pub(crate) candidates: HashMap<String, Vec<EventRecord>>,
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
    Memory,
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
    // Retrieval aliases are retained in the operation cache, not trusted from relay metadata.
    fn canonical_reference(&self, reference: &str) -> String {
        self.get_operation(reference).and_then(|operation| generate_json_cid(&operation).ok())
            .unwrap_or_else(|| reference.to_string())
    }
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
    /// A chain position, as (registry, ordinal). Not a resolution mode a
    /// caller can ask for -- the resolution surface is time- and
    /// sequence-based and ordinals are registry-internal -- but what
    /// `controller_at` resolves a controller at. For events on that registry
    /// only those the chain committed strictly before the ordinal are
    /// applied, which orders within a block where `version_time` cannot and
    /// survives a later block carrying an earlier timestamp. Events on any
    /// other registry fall back to `version_time`, since ordinals do not
    /// compare across registries.
    pub(crate) version_ordinal: Option<(String, Vec<u64>)>,
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

/// A timestamp as the resolved document reports it: UTC, second precision,
/// `Z`. The TypeScript port normalizes every metadata timestamp this way
/// (`generateStandardDatetime`); clients stamp operations with millisecond
/// precision, so echoing the input made every DID's `created`, `updated` and
/// `deleted` differ between the ports. The accepted input is RFC 3339 with an
/// optional fraction, either separator case, and `z` or an offset; an
/// unparseable string is returned as given rather than failing resolution.
pub(crate) fn standard_datetime(time: &str) -> String {
    let mut normalized: Vec<char> = time.chars().collect();
    if let Some(separator) = normalized.get_mut(10) {
        if *separator == ' ' || *separator == 't' {
            *separator = 'T';
        }
    }
    if let Some(last) = normalized.last_mut() {
        if *last == 'z' {
            *last = 'Z';
        }
    }
    let normalized: String = normalized.into_iter().collect();
    match chrono::DateTime::parse_from_rfc3339(&normalized) {
        Ok(parsed) => parsed
            .with_timezone(&chrono::Utc)
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        Err(_) => time.to_string(),
    }
}

/// Hyperswarm receipt times are node-local. Validated operations supply their
/// own proof time; this selects a prefix without reordering predecessors.
pub(crate) fn resolution_time(event: &EventRecord) -> &str {
    if event.registry == "hyperswarm" {
        event
            .operation
            .get("proof")
            .and_then(|proof| proof.get("created"))
            .and_then(Value::as_str)
            .unwrap_or_default()
    } else {
        &event.time
    }
}

/// Whether resolution stops before this event: by ordinal if the event is on
/// the cutoff's registry, by time otherwise.
pub(crate) fn past_cutoff(options: &ResolveOptions, event: &EventRecord) -> bool {
    if let Some((registry, ordinal)) = options.version_ordinal.as_ref() {
        if event.registry == *registry {
            return event
                .ordinal
                .as_ref()
                .map(|position| compare_ordinals(Some(position), Some(ordinal)).is_ge())
                .unwrap_or(false);
        }
    }
    match options.version_time.as_ref() {
        Some(version_time) if event.registry == "hyperswarm" => {
            // Compare instants, including offsets and subsecond precision,
            // consistently with TypeScript's Date comparison.
            chrono::DateTime::parse_from_rfc3339(resolution_time(event))
                .ok()
                .zip(chrono::DateTime::parse_from_rfc3339(version_time).ok())
                .is_some_and(|(time, cutoff)| time.timestamp_millis() > cutoff.timestamp_millis())
        }
        Some(version_time) => event.time > *version_time,
        None => false,
    }
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
        registration: value.get("registration").cloned().filter(|v| !v.is_null()),
    }
}

pub(crate) fn event_record_to_value(event: &EventRecord) -> Value {
    let mut val = json!({
        "registry": event.registry,
        "time": event.time,
        "ordinal": event.ordinal,
        "operation": event.operation,
        "opid": event.opid,
        "did": event.did
    });
    if let Some(reg) = &event.registration {
        val["registration"] = reg.clone();
    }
    val
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

    // Startup reads a bounded batch at a time instead of issuing two round trips
    // per DID. Other backends retain their ordinary history-read semantics.
    pub(crate) fn get_histories(
        &self,
        dids: &[String],
    ) -> Result<HashMap<String, Vec<EventRecord>>> {
        if !matches!(self.backend, DbBackend::Redis { .. }) {
            return Ok(dids
                .iter()
                .map(|did| (did.clone(), self.get_events(did)))
                .collect());
        }
        self.with_redis_connection(|conn, namespace| {
            let mut histories = HashMap::new();
            for batch in dids.chunks(256) {
                let mut pipe = redis::pipe();
                for did in batch {
                    pipe.cmd("LRANGE")
                        .arg(Self::redis_did_key(namespace, did)?)
                        .arg(0)
                        .arg(-1);
                }
                let rows: Vec<Vec<String>> = pipe.query(conn)?;
                let mut parsed = Vec::new();
                let mut ids = std::collections::HashSet::new();
                for events in rows {
                    let events: Vec<EventRecord> = events
                        .iter()
                        .map(|raw| serde_json::from_str(raw))
                        .collect::<std::result::Result<_, _>>()?;
                    for event in &events {
                        if event.operation.is_null() {
                            if let Some(opid) = &event.opid {
                                ids.insert(opid.clone());
                            }
                        }
                    }
                    parsed.push(events);
                }
                let ids: Vec<_> = ids.into_iter().collect();
                let mut operations = HashMap::new();
                if !ids.is_empty() {
                    let keys: Vec<_> = ids
                        .iter()
                        .map(|id| Self::redis_operation_key(namespace, id))
                        .collect();
                    let values: Vec<Option<String>> = conn.get(keys)?;
                    for (id, raw) in ids.into_iter().zip(values) {
                        if let Some(raw) = raw {
                            operations.insert(id, serde_json::from_str::<Value>(&raw)?);
                        }
                    }
                }
                for (did, mut events) in batch.iter().zip(parsed) {
                    for event in &mut events {
                        if event.operation.is_null() {
                            if let Some(operation) =
                                event.opid.as_ref().and_then(|id| operations.get(id))
                            {
                                event.operation = operation.clone();
                            }
                        }
                    }
                    histories.insert(did.clone(), events);
                }
            }
            Ok(histories)
        })
    }

    pub(crate) fn get_candidates(&self) -> Result<HashMap<String, Vec<EventRecord>>> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let rows: HashMap<String, String> =
                    conn.hgetall(format!("{namespace}/candidates"))?;
                rows.into_iter()
                    .map(|(did, raw)| Ok((did, serde_json::from_str(&raw)?)))
                    .collect()
            });
        }
        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            let mut statement = conn.prepare("SELECT id, events FROM candidates")?;
            let rows = statement.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            return rows
                .map(|row| {
                    let (did, raw) = row?;
                    Ok((did, serde_json::from_str(&raw)?))
                })
                .collect();
        }
        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            let collection = client
                .database(self.mongo_database_name()?)
                .collection::<Document>("candidates");
            let mut result = HashMap::new();
            for row in collection.find(doc! {}).run()? {
                let row = row?;
                result.insert(
                    row.get_str("id")?.to_string(),
                    bson::from_bson(row.get("events").context("missing candidates")?.clone())?,
                );
            }
            return Ok(result);
        }
        Ok(self.data.candidates.clone())
    }

    pub(crate) fn set_candidates(&mut self, did: &str, events: Vec<EventRecord>) -> Result<()> {
        if matches!(self.backend, DbBackend::Redis { .. }) {
            return self.with_redis_connection(|conn, namespace| {
                let _: usize = conn.hset(
                    format!("{namespace}/candidates"),
                    did,
                    serde_json::to_string(&events)?,
                )?;
                Ok(())
            });
        }
        if let DbBackend::Sqlite { path } = &self.backend {
            let conn = DbBackend::open_sqlite(path)?;
            conn.execute("INSERT INTO candidates(id, events) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET events = excluded.events",
                params![did, serde_json::to_string(&events)?])?;
            return Ok(());
        }
        if matches!(self.backend, DbBackend::Mongo { .. }) {
            let client = self.mongo_client()?;
            client
                .database(self.mongo_database_name()?)
                .collection::<Document>("candidates")
                .update_one(
                    doc! { "id": did },
                    doc! { "$set": { "events": bson::to_bson(&events)? } },
                )
                .upsert(true)
                .run()?;
            return Ok(());
        }
        self.data.candidates.insert(did.to_string(), events);
        self.save()
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
        let canonical_previd = event.operation.get("previd").and_then(Value::as_str)
            .map(|reference| self.canonical_reference(reference));
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
                    pin_registries: vec![],
                    json_limit: 0,
                    upload_limit: 0,
                    gc_interval_minutes: 0,
                    status_interval_minutes: 0,
                    admin_api_key: String::new(),
                    fallback_url: String::new(),
                    confirm_fallback_url: String::new(),
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

            if previd != current_version_id && canonical_previd.as_deref() != Some(current_version_id) {
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
                    pin_registries: vec![],
                    json_limit: 0,
                    upload_limit: 0,
                    gc_interval_minutes: 0,
                    status_interval_minutes: 0,
                    admin_api_key: String::new(),
                    fallback_url: String::new(),
                    confirm_fallback_url: String::new(),
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

            if previd != current_version_id && canonical_previd.as_deref() != Some(current_version_id) {
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
                pin_registries: vec![],
                json_limit: 0,
                upload_limit: 0,
                gc_interval_minutes: 0,
                status_interval_minutes: 0,
                admin_api_key: String::new(),
                fallback_url: String::new(),
                confirm_fallback_url: String::new(),
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

        if previd != current_version_id && canonical_previd.as_deref() != Some(current_version_id) {
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
            conn.execute("DELETE FROM candidates", [])?;
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
            db.collection::<Document>("candidates")
                .delete_many(doc! {})
                .run()?;
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
            // Store the block time as an integer so it reads back as a JSON number,
            // matching the redis and mongo backends. It was previously stringified,
            // which left `timeISO` null on this backend (see get_block below).
            let time_value: i64 = match block.get("time") {
                Some(Value::Number(value)) => value
                    .as_i64()
                    .or_else(|| value.as_f64().map(|seconds| seconds as i64))
                    .unwrap_or(0),
                Some(Value::String(value)) => value.parse::<i64>().unwrap_or(0),
                _ => 0,
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
                        // Emit a JSON number. Databases created before the column
                        // became INTEGER stored a string, so coerce those on read —
                        // otherwise `Value::as_u64` fails downstream and the
                        // anchoring metadata's `timeISO` comes out null.
                        "time": match row.get::<_, rusqlite::types::Value>(3)? {
                            rusqlite::types::Value::Integer(value) => json!(value),
                            rusqlite::types::Value::Real(value) => json!(value as i64),
                            rusqlite::types::Value::Text(value) => value
                                .parse::<i64>()
                                .map(|parsed| json!(parsed))
                                .unwrap_or(Value::Null),
                            _ => Value::Null,
                        },
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

        let upper = event.registration.as_ref().and_then(|reg| {
            let height = reg.get("height").and_then(Value::as_u64)?;
            let block = self.get_block(registry, Some(BlockLookup::Height(height)))?;
            let mut obj = serde_json::Map::new();
            obj.insert("time".to_string(), block.get("time").cloned().unwrap_or(Value::Null));
            obj.insert("timeISO".to_string(), block.get("time")
                .and_then(Value::as_u64)
                .and_then(|time| chrono::DateTime::<chrono::Utc>::from_timestamp(time as i64, 0))
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
                .map(Value::String)
                .unwrap_or(Value::Null));
            obj.insert("blockid".to_string(), block.get("hash").cloned().unwrap_or(Value::Null));
            obj.insert("height".to_string(), block.get("height").cloned().unwrap_or(Value::Null));
            if let Some(v) = reg.get("txid") { obj.insert("txid".to_string(), v.clone()); }
            if let Some(v) = reg.get("index") { obj.insert("txidx".to_string(), v.clone()); }
            if let Some(v) = reg.get("batch") { obj.insert("batchid".to_string(), v.clone()); }
            if let Some(v) = reg.get("opidx") { obj.insert("opidx".to_string(), v.clone()); }
            Some(Value::Object(obj))
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
        let mut timestamp = json!({
            "chain": registry,
            "opid": version_id
        });
        if let Some(lower) = lower {
            timestamp["lowerBound"] = lower;
        }
        if let Some(upper) = upper {
            timestamp["upperBound"] = upper;
        }
        Some(timestamp)
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
                    "assertionMethod": ["#key-1"],
                    // Operations claim capabilityInvocation, and a proof
                    // purpose the document does not grant is a safeguard
                    // nothing can check. Kept identical to resolver.rs, which
                    // builds the same document on the resolution path.
                    "capabilityInvocation": ["#key-1"]
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
            created: standard_datetime(created),
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
            let operation_time = standard_datetime(resolution_time(event));

            if past_cutoff(&options, event) {
                break;
            }

            if let Some(version_sequence) = options.version_sequence {
                if state.version_sequence == version_sequence {
                    break;
                }
            }

            // Whether this event is confirmed is decided before it is applied,
            // so that a confirmed resolution stops at the last confirmed
            // version -- and reports that version's flag -- rather than one
            // past it. That is what the verifying resolver and the TypeScript
            // port do; judging by the previous event's state applied the first
            // unconfirmed event and reported the result as unconfirmed.
            let event_confirmed = state.confirmed
                && state
                    .did_document_registration
                    .get("registry")
                    .and_then(Value::as_str)
                    .map(|registry| registry == event.registry)
                    .unwrap_or(false);

            if options.confirm && !event_confirmed {
                break;
            }

            state.confirmed = event_confirmed;

            if options.verify {
                // Signature verification is handled by higher-level resolver paths.
            }

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
                    state.deleted = Some(operation_time);
                    state.updated = None;
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
            Self::Memory => Ok(JsonDbFile::default()),
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
                db.collection::<Document>("candidates")
                    .create_index(
                        IndexModel::builder()
                            .keys(doc! { "id": 1 })
                            .options(IndexOptions::builder().unique(true).build())
                            .build(),
                    )
                    .run()?;
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
            Self::Memory => Ok(()),
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
            "CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, events TEXT NOT NULL)",
            [],
        )?;
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
                time INTEGER NOT NULL,
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

#[cfg(test)]
mod startup_read_tests {
    use super::*;

    #[test]
    #[ignore = "requires isolated Redis via ARCHON_TEST_REDIS_URL"]
    fn redis_batched_histories_match_individual_reads() -> Result<()> {
        let url = env::var("ARCHON_TEST_REDIS_URL")?;
        let client = redis::Client::open(url.as_str())?;
        let mut conn = client.get_connection()?;
        let directory = tempfile::tempdir()?;
        let namespace = format!(
            "startup-test-{}",
            directory.path().file_name().unwrap().to_string_lossy()
        );
        let operation = json!({"type": "create", "data": {"test": true}});
        let op_key = JsonDb::redis_operation_key(&namespace, "op");
        let _: () = conn.set(&op_key, operation.to_string())?;
        let mut dids = Vec::new();
        let mut keys = vec![op_key];
        // Cross the batch boundary; include inline operations, shared cached
        // operations, missing cache entries, and a missing DID.
        for index in 0..257 {
            let did = format!("did:cid:test-{index}");
            let key = JsonDb::redis_did_key(&namespace, &did)?;
            for event in [
                json!({"registry": "hyperswarm", "time": "now", "opid": "op"}),
                json!({"registry": "hyperswarm", "time": "now", "operation": operation}),
                json!({"registry": "hyperswarm", "time": "now", "opid": "missing"}),
            ] {
                let _: usize = conn.rpush(&key, event.to_string())?;
            }
            dids.push(did);
            keys.push(key);
        }
        dids.push("did:cid:absent".to_string());
        let db = JsonDb {
            backend: DbBackend::Redis {
                url,
                namespace: namespace.clone(),
            },
            data: JsonDbFile::default(),
            redis_connection: Some(StdMutex::new(client.get_connection()?)),
        };
        let batch = db.get_histories(&dids)?;
        for did in &dids {
            assert!(
                batch[did] == db.get_events(did),
                "batch differs from individual read"
            );
        }
        let bad_key = JsonDb::redis_did_key(&namespace, &dids[0])?;
        let _: usize = conn.rpush(&bad_key, "malformed JSON")?;
        assert!(
            db.get_histories(&dids).is_err(),
            "startup must propagate corrupt storage"
        );
        let _: usize = conn.del(keys)?;
        Ok(())
    }
}

#[cfg(test)]
mod hyperswarm_time_tests {
    use super::*;

    #[test]
    fn hyperswarm_cutoff_uses_proof_instant_without_changing_other_registries() {
        let mut event = value_to_event_record(&serde_json::json!({
            "registry": "hyperswarm", "time": "2026-09-17T17:53:05.466Z",
            "ordinal": [42], "operation": { "proof": { "created": "2026-09-04T00:51:32.807000001Z" } }
        }));
        let mut options = ResolveOptions {
            version_time: Some("2026-09-03T20:51:32.807-04:00".to_string()),
            ..Default::default()
        };
        assert!(!past_cutoff(&options, &event));
        options.version_time = Some("2026-09-04T00:51:32.806Z".to_string());
        assert!(past_cutoff(&options, &event));
        for registry in ["local", "BTC:signet"] {
            event.registry = registry.to_string();
            options.version_time = Some("2026-09-04T00:51:33Z".to_string());
            assert!(past_cutoff(&options, &event));
            assert_eq!(resolution_time(&event), event.time);
        }
        // Chain ordering still takes precedence over the time cutoff.
        options.version_ordinal = Some(("BTC:signet".to_string(), vec![43]));
        assert!(!past_cutoff(&options, &event));
    }
}
