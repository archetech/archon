use std::{
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use k256::{
    ecdsa::{signature::hazmat::PrehashSigner, Signature, SigningKey},
    SecretKey,
};
use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

pub const ADMIN_KEY: &str = "test-admin-key";

pub struct TestService {
    child: Child,
    pub root_url: String,
    pub base_url: String,
    pub client: Client,
    _temp_dir: Option<TempDir>,
}

impl TestService {
    pub fn data_dir(&self) -> &Path {
        if let Some(temp_dir) = self._temp_dir.as_ref() {
            temp_dir.path()
        } else {
            Path::new(".")
        }
    }

    pub fn admin(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.header("x-archon-admin-key", ADMIN_KEY)
    }
}

impl Drop for TestService {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub async fn spawn_json() -> Result<TestService> {
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    spawn_service("json", temp_dir, &[]).await
}

pub async fn spawn_sqlite() -> Result<TestService> {
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    spawn_service("sqlite", temp_dir, &[]).await
}

pub async fn spawn_mongodb(mongo_url: &str) -> Result<TestService> {
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    spawn_service(
        "mongodb",
        temp_dir,
        &[("ARCHON_MONGODB_URL", mongo_url.to_string())],
    )
    .await
}

pub async fn spawn_redis(redis_url: &str) -> Result<TestService> {
    let temp_dir = tempfile::tempdir().context("failed to create temp dir")?;
    spawn_service(
        "redis",
        temp_dir,
        &[("ARCHON_REDIS_URL", redis_url.to_string())],
    )
    .await
}

pub async fn spawn_service(
    db: &str,
    temp_dir: TempDir,
    extra_env: &[(&str, String)],
) -> Result<TestService> {
    let port = free_port()?;
    let root_url = format!("http://127.0.0.1:{port}");
    let base_url = format!("http://127.0.0.1:{port}/api/v1");
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("failed to build reqwest client")?;

    let mut command = Command::new(env!("CARGO_BIN_EXE_archon-rust-gatekeeper"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("ARCHON_GATEKEEPER_PORT", port.to_string())
        .env("ARCHON_BIND_ADDRESS", "127.0.0.1")
        .env("ARCHON_GATEKEEPER_DB", db)
        .env("ARCHON_DATA_DIR", temp_dir.path())
        .env("ARCHON_GATEKEEPER_FALLBACK_URL", "")
        .env("ARCHON_GATEKEEPER_REGISTRIES", "local,hyperswarm")
        .env("ARCHON_GATEKEEPER_STATUS_INTERVAL", "60")
        .env("ARCHON_GATEKEEPER_GC_INTERVAL", "60")
        .env("ARCHON_ADMIN_API_KEY", ADMIN_KEY)
        .env("RUST_LOG", "error")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    for (key, value) in extra_env {
        command.env(key, value);
    }

    let child = command.spawn().context("failed to spawn gatekeeper")?;
    let mut service = TestService {
        child,
        root_url,
        base_url,
        client,
        _temp_dir: Some(temp_dir),
    };

    wait_for_ready(&mut service).await?;
    Ok(service)
}

pub async fn respawn_service(
    db: &str,
    data_dir: impl AsRef<Path>,
    extra_env: &[(&str, String)],
) -> Result<TestService> {
    let port = free_port()?;
    let root_url = format!("http://127.0.0.1:{port}");
    let base_url = format!("http://127.0.0.1:{port}/api/v1");
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .context("failed to build reqwest client")?;

    let mut command = Command::new(env!("CARGO_BIN_EXE_archon-rust-gatekeeper"));
    command
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("ARCHON_GATEKEEPER_PORT", port.to_string())
        .env("ARCHON_BIND_ADDRESS", "127.0.0.1")
        .env("ARCHON_GATEKEEPER_DB", db)
        .env("ARCHON_DATA_DIR", data_dir.as_ref())
        .env("ARCHON_GATEKEEPER_FALLBACK_URL", "")
        .env("ARCHON_GATEKEEPER_REGISTRIES", "local,hyperswarm")
        .env("ARCHON_GATEKEEPER_STATUS_INTERVAL", "60")
        .env("ARCHON_GATEKEEPER_GC_INTERVAL", "60")
        .env("ARCHON_ADMIN_API_KEY", ADMIN_KEY)
        .env("RUST_LOG", "error")
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    for (key, value) in extra_env {
        command.env(key, value);
    }

    let child = command.spawn().context("failed to respawn gatekeeper")?;
    let mut service = TestService {
        child,
        root_url,
        base_url,
        client,
        _temp_dir: None,
    };

    wait_for_ready(&mut service).await?;
    Ok(service)
}

pub fn deterministic_vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../tests/gatekeeper/deterministic-vectors.json"
    ))
    .expect("deterministic vectors should decode")
}

pub fn proof_vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../../tests/gatekeeper/proof-vectors.json"
    ))
    .expect("proof vectors should decode")
}

pub fn create_event_from_operation(operation: Value, registry: &str, ordinal: &[u64]) -> Value {
    let time = operation
        .get("proof")
        .and_then(|value| value.get("created"))
        .and_then(Value::as_str)
        .or_else(|| operation.get("created").and_then(Value::as_str))
        .unwrap_or("2026-04-11T00:00:00Z");
    serde_json::json!({
        "registry": registry,
        "time": time,
        "ordinal": ordinal,
        "operation": operation,
    })
}

async fn wait_for_ready(service: &mut TestService) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(20);

    loop {
        if let Some(status) = service.child.try_wait().context("failed to poll child")? {
            bail!("gatekeeper exited before ready: {status}");
        }

        match service
            .client
            .get(format!("{}/ready", service.base_url))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => return Ok(()),
            _ if Instant::now() < deadline => tokio::time::sleep(Duration::from_millis(100)).await,
            _ => bail!("timed out waiting for gatekeeper ready"),
        }
    }
}

fn free_port() -> Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0").context("failed to bind ephemeral port")?;
    let port = listener
        .local_addr()
        .context("failed to get local addr")?
        .port();
    drop(listener);
    Ok(port)
}

pub fn did_suffix(did: &str) -> &str {
    did.rsplit(':').next().expect("did should have suffix")
}

pub fn path_buf(path: impl AsRef<Path>) -> PathBuf {
    path.as_ref().to_path_buf()
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => serde_json::to_string(string).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(items) => {
            let joined = items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{joined}]")
        }
        Value::Object(map) => {
            let mut entries = map.iter().collect::<Vec<_>>();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let joined = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{joined}}}")
        }
    }
}

fn signing_key(seed: u8) -> SigningKey {
    let bytes = [seed; 32];
    let secret = SecretKey::from_slice(&bytes).expect("seed should create valid secret key");
    SigningKey::from(secret)
}

fn public_jwk(seed: u8) -> Value {
    let signing_key = signing_key(seed);
    let verifying_key = signing_key.verifying_key();
    let point = verifying_key.to_encoded_point(false);
    let x = point.x().expect("x should exist");
    let y = point.y().expect("y should exist");

    json!({
        "kty": "EC",
        "crv": "secp256k1",
        "x": URL_SAFE_NO_PAD.encode(x),
        "y": URL_SAFE_NO_PAD.encode(y)
    })
}

fn sign_operation(seed: u8, operation: &Value, verification_method: &str, created: &str) -> Value {
    let mut unsigned = operation.clone();
    unsigned
        .as_object_mut()
        .expect("operation should be an object")
        .remove("proof");
    let canonical = canonical_json(&unsigned);
    let hash = Sha256::digest(canonical.as_bytes());
    let signature: Signature = signing_key(seed)
        .sign_prehash(hash.as_ref())
        .expect("signing should succeed");

    let mut signed = unsigned;
    signed["proof"] = json!({
        "type": "EcdsaSecp256k1Signature2019",
        "created": created,
        "verificationMethod": verification_method,
        "proofPurpose": "authentication",
        "proofValue": URL_SAFE_NO_PAD.encode(signature.to_bytes())
    });
    signed
}

pub fn create_agent_operation(seed: u8, created: &str, registry: &str) -> Value {
    let operation = json!({
        "type": "create",
        "created": created,
        "registration": {
            "version": 1,
            "type": "agent",
            "registry": registry
        },
        "publicJwk": public_jwk(seed)
    });
    sign_operation(seed, &operation, "#key-1", created)
}

pub fn create_asset_operation(
    seed: u8,
    controller_did: &str,
    created: &str,
    registry: &str,
    data: Value,
) -> Value {
    let operation = json!({
        "type": "create",
        "created": created,
        "registration": {
            "version": 1,
            "type": "asset",
            "registry": registry
        },
        "controller": controller_did,
        "data": data
    });
    sign_operation(seed, &operation, &format!("{controller_did}#key-1"), created)
}

pub fn create_update_operation(
    seed: u8,
    did: &str,
    previd: Option<&str>,
    created: &str,
    doc: Value,
) -> Value {
    let mut operation = json!({
        "type": "update",
        "did": did,
        "doc": doc
    });
    if let Some(previd) = previd {
        operation["previd"] = Value::String(previd.to_string());
    }
    sign_operation(seed, &operation, &format!("{did}#key-1"), created)
}

pub fn create_delete_operation(seed: u8, did: &str, previd: &str, created: &str) -> Value {
    let operation = json!({
        "type": "delete",
        "did": did,
        "previd": previd
    });
    sign_operation(seed, &operation, &format!("{did}#key-1"), created)
}

pub fn make_event(registry: &str, time: &str, ordinal: &[u64], operation: Value) -> Value {
    json!({
        "registry": registry,
        "time": time,
        "ordinal": ordinal,
        "operation": operation
    })
}
