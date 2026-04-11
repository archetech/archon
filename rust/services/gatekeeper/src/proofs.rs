use anyhow::{Context, Result};
use async_recursion::async_recursion;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cid::Cid;
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature as K256Signature, VerifyingKey};
use multihash_codetable::{Code, MultihashDigest};
use serde_json::Value;

use crate::{is_valid_registry, resolve_local_doc_async, AppState, Config, ResolveOptions};

pub(crate) fn infer_event_did(config: &Config, event: &Value) -> Result<String> {
    if let Some(did) = event.get("did").and_then(Value::as_str) {
        return Ok(did.to_string());
    }

    let operation = event.get("operation").context("missing event.operation")?;
    if let Some(did) = operation.get("did").and_then(Value::as_str) {
        return Ok(did.to_string());
    }

    generate_did_from_operation(config, operation)
}

pub(crate) fn ensure_event_opid(event: &mut Value) -> Result<String> {
    if let Some(opid) = event.get("opid").and_then(Value::as_str) {
        return Ok(opid.to_string());
    }

    let operation = event.get("operation").context("missing event.operation")?;
    let opid = generate_json_cid(operation)?;
    event["opid"] = Value::String(opid.clone());
    Ok(opid)
}

pub(crate) fn verify_event_shape(event: &Value) -> bool {
    let Some(registry) = event.get("registry").and_then(Value::as_str) else {
        return false;
    };
    if !is_valid_registry(registry) {
        return false;
    }

    if event.get("time").and_then(Value::as_str).is_none() {
        return false;
    }

    let Some(operation) = event.get("operation") else {
        return false;
    };
    let Some(op_type) = operation.get("type").and_then(Value::as_str) else {
        return false;
    };
    match op_type {
        "create" => {
            operation.get("created").and_then(Value::as_str).is_some()
                && operation.get("registration").is_some()
                && operation
                    .get("registration")
                    .and_then(|value| value.get("registry"))
                    .and_then(Value::as_str)
                    .map(is_valid_registry)
                    .unwrap_or(false)
                && operation
                    .get("registration")
                    .and_then(|value| value.get("version"))
                    .and_then(Value::as_i64)
                    == Some(1)
                && matches!(
                    operation
                        .get("registration")
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str),
                    Some("agent" | "asset")
                )
                && operation
                    .get("proof")
                    .and_then(|value| value.get("proofValue"))
                    .and_then(Value::as_str)
                    .is_some()
        }
        "update" => {
            operation.get("did").and_then(Value::as_str).is_some()
                && operation
                    .get("doc")
                    .map(|doc| {
                        doc.get("didDocument").is_some()
                            || doc.get("didDocumentData").is_some()
                            || doc.get("didDocumentRegistration").is_some()
                    })
                    .unwrap_or(false)
                && operation
                    .get("proof")
                    .and_then(|value| value.get("proofValue"))
                    .and_then(Value::as_str)
                    .is_some()
        }
        "delete" => {
            operation.get("did").and_then(Value::as_str).is_some()
                && operation
                    .get("proof")
                    .and_then(|value| value.get("proofValue"))
                    .and_then(Value::as_str)
                    .is_some()
        }
        _ => false,
    }
}

fn verify_did_format(did: &str) -> bool {
    did.starts_with("did:")
}

fn verify_date_format(time: Option<&str>) -> bool {
    time.and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some()
}

pub(crate) fn verify_proof_format(proof: Option<&Value>) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    if proof.get("type").and_then(Value::as_str) != Some("EcdsaSecp256k1Signature2019") {
        return false;
    }
    if !verify_date_format(proof.get("created").and_then(Value::as_str)) {
        return false;
    }
    if !matches!(
        proof.get("proofPurpose").and_then(Value::as_str),
        Some("assertionMethod" | "authentication")
    ) {
        return false;
    }
    let Some(verification_method) = proof.get("verificationMethod").and_then(Value::as_str) else {
        return false;
    };
    if !verification_method.contains('#') {
        return false;
    }
    let did = verification_method.split('#').next().unwrap_or_default();
    if !did.is_empty() && !verify_did_format(did) {
        return false;
    }
    proof.get("proofValue").and_then(Value::as_str).is_some()
}

fn value_without_proof(value: &Value) -> Value {
    let mut copy = value.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("proof");
    }
    copy
}

fn base64url_to_bytes(value: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value)
        .with_context(|| "invalid base64url")
}

fn public_jwk_to_sec1_bytes(public_jwk: &Value) -> Result<Vec<u8>> {
    if public_jwk.get("kty").and_then(Value::as_str) != Some("EC") {
        anyhow::bail!("Invalid operation: publicJwk");
    }
    if public_jwk.get("crv").and_then(Value::as_str) != Some("secp256k1") {
        anyhow::bail!("Invalid operation: publicJwk");
    }

    let x_bytes = base64url_to_bytes(
        public_jwk
            .get("x")
            .and_then(Value::as_str)
            .context("Invalid operation: publicJwk")?,
    )?;
    let y_bytes = base64url_to_bytes(
        public_jwk
            .get("y")
            .and_then(Value::as_str)
            .context("Invalid operation: publicJwk")?,
    )?;

    if x_bytes.len() != 32 || y_bytes.len() != 32 {
        anyhow::bail!("Invalid operation: publicJwk");
    }

    let prefix = if y_bytes.last().copied().unwrap_or_default() % 2 == 0 {
        0x02
    } else {
        0x03
    };

    let mut compressed = Vec::with_capacity(33);
    compressed.push(prefix);
    compressed.extend_from_slice(&x_bytes);
    Ok(compressed)
}

fn verify_sig(msg_hash_hex: &str, proof_value: &str, public_jwk: &Value) -> Result<bool> {
    let msg_hash = hex_to_bytes(msg_hash_hex)?;
    let sig_bytes = base64url_to_bytes(proof_value)?;
    let compressed_key = public_jwk_to_sec1_bytes(public_jwk)?;
    let verifying_key = VerifyingKey::from_sec1_bytes(&compressed_key)
        .with_context(|| "Invalid operation: publicJwk")?;
    let signature =
        K256Signature::from_slice(&sig_bytes).with_context(|| "Invalid operation: proof")?;
    Ok(verifying_key.verify_prehash(&msg_hash, &signature).is_ok())
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        anyhow::bail!("invalid hex");
    }
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16).with_context(|| "invalid hex")
        })
        .collect()
}

fn bytes_to_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

#[async_recursion]
pub(crate) async fn verify_create_operation_impl(
    state: &AppState,
    operation: &Value,
) -> Result<bool> {
    if operation.is_null() {
        anyhow::bail!("Invalid operation: missing");
    }
    if operation.to_string().len() > 64 * 1024 {
        anyhow::bail!("Invalid operation: size");
    }
    if operation.get("type").and_then(Value::as_str) != Some("create") {
        anyhow::bail!(
            "Invalid operation: type={}",
            operation
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        );
    }
    if !verify_date_format(operation.get("created").and_then(Value::as_str)) {
        anyhow::bail!(
            "Invalid operation: created={}",
            operation
                .get("created")
                .and_then(Value::as_str)
                .unwrap_or_default()
        );
    }

    let registration = operation
        .get("registration")
        .context("Invalid operation: registration")?;
    let version = registration
        .get("version")
        .and_then(Value::as_i64)
        .ok_or_else(|| anyhow::anyhow!("Invalid operation: registration.version=null"))?;
    if version != 1 {
        anyhow::bail!("Invalid operation: registration.version={version}");
    }
    let reg_type = registration
        .get("type")
        .and_then(Value::as_str)
        .context("Invalid operation: registration.type")?;
    if !matches!(reg_type, "agent" | "asset") {
        anyhow::bail!("Invalid operation: registration.type={reg_type}");
    }
    let registry = registration
        .get("registry")
        .and_then(Value::as_str)
        .context("Invalid operation: registration.registry")?;
    if !is_valid_registry(registry) {
        anyhow::bail!("Invalid operation: registration.registry={registry}");
    }
    if !verify_proof_format(operation.get("proof")) {
        anyhow::bail!("Invalid operation: proof");
    }

    let proof = operation.get("proof").context("Invalid operation: proof")?;
    if reg_type == "agent"
        && proof.get("verificationMethod").and_then(Value::as_str) != Some("#key-1")
    {
        anyhow::bail!(
            "Invalid operation: proof.verificationMethod must be #key-1 for agent create"
        );
    }
    if let Some(valid_until) = registration.get("validUntil").and_then(Value::as_str) {
        if !verify_date_format(Some(valid_until)) {
            anyhow::bail!("Invalid operation: registration.validUntil={valid_until}");
        }
    }

    let operation_copy = value_without_proof(operation);
    let msg_hash = generate_message_hash(&operation_copy)?;
    let proof_value = proof
        .get("proofValue")
        .and_then(Value::as_str)
        .context("Invalid operation: proof")?;

    if reg_type == "agent" {
        let public_jwk = operation
            .get("publicJwk")
            .context("Invalid operation: publicJwk")?;
        return verify_sig(&msg_hash, proof_value, public_jwk);
    }

    let controller_did = proof
        .get("verificationMethod")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .split('#')
        .next()
        .unwrap_or_default()
        .to_string();
    if operation.get("controller").and_then(Value::as_str) != Some(controller_did.as_str()) {
        anyhow::bail!("Invalid operation: signer is not controller");
    }

    let controller_doc = resolve_local_doc_async(
        state,
        &controller_did,
        ResolveOptions {
            confirm: true,
            version_time: proof
                .get("created")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            ..ResolveOptions::default()
        },
    )
    .await?;

    if controller_doc
        .get("didDocumentRegistration")
        .and_then(|value| value.get("registry"))
        .and_then(Value::as_str)
        == Some("local")
        && registry != "local"
    {
        anyhow::bail!("Invalid operation: non-local registry={registry}");
    }

    let public_jwk = controller_doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|value| value.get("publicKeyJwk"))
        .context("Invalid operation: didDocument missing verificationMethod")?;

    verify_sig(&msg_hash, proof_value, public_jwk)
}

#[async_recursion]
pub(crate) async fn verify_update_operation_impl(
    state: &AppState,
    operation: &Value,
    doc: &Value,
) -> Result<bool> {
    if operation.to_string().len() > 64 * 1024 {
        anyhow::bail!("Invalid operation: size");
    }
    if !verify_proof_format(operation.get("proof")) {
        anyhow::bail!("Invalid operation: proof");
    }
    if doc.get("didDocument").is_none() {
        anyhow::bail!("Invalid operation: doc.didDocument");
    }
    if doc
        .get("didDocumentMetadata")
        .and_then(|value| value.get("deactivated"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        anyhow::bail!("Invalid operation: DID deactivated");
    }

    if let Some(controller_did) = doc
        .get("didDocument")
        .and_then(|value| value.get("controller"))
        .and_then(Value::as_str)
    {
        let controller_doc = resolve_local_doc_async(
            state,
            controller_did,
            ResolveOptions {
                confirm: true,
                version_time: operation
                    .get("proof")
                    .and_then(|value| value.get("created"))
                    .and_then(Value::as_str)
                    .map(ToString::to_string),
                ..ResolveOptions::default()
            },
        )
        .await?;
        return verify_update_operation_impl(state, operation, &controller_doc).await;
    }

    if doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .is_none()
    {
        anyhow::bail!("Invalid operation: doc.didDocument.verificationMethod");
    }

    let proof = operation.get("proof").context("Invalid operation: proof")?;
    let msg_hash = generate_message_hash(&value_without_proof(operation))?;
    let public_jwk = doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|value| value.get("publicKeyJwk"))
        .context("Invalid operation: didDocument missing verificationMethod")?;
    let proof_value = proof
        .get("proofValue")
        .and_then(Value::as_str)
        .context("Invalid operation: proof")?;
    verify_sig(&msg_hash, proof_value, public_jwk)
}

pub(crate) async fn verify_operation_impl(state: &AppState, operation: &Value) -> Result<bool> {
    match operation.get("type").and_then(Value::as_str) {
        Some("create") => verify_create_operation_impl(state, operation).await,
        Some("update" | "delete") => {
            let did = operation
                .get("did")
                .and_then(Value::as_str)
                .context("Invalid operation: missing operation.did")?;
            let doc = resolve_local_doc_async(state, did, ResolveOptions::default()).await?;
            verify_update_operation_impl(state, operation, &doc).await
        }
        _ => Ok(false),
    }
}

fn generate_message_hash(value: &Value) -> Result<String> {
    let canonical = canonical_json(value);
    let hash = Code::Sha2_256.digest(canonical.as_bytes());
    Ok(bytes_to_hex(hash.digest()))
}

pub(crate) fn generate_did_from_operation(config: &Config, operation: &Value) -> Result<String> {
    let cid = generate_json_cid(operation)?;
    let prefix = operation
        .get("registration")
        .and_then(|v| v.get("prefix"))
        .and_then(Value::as_str)
        .unwrap_or(&config.did_prefix);
    Ok(format!("{prefix}:{cid}"))
}

pub(crate) fn generate_json_cid(value: &Value) -> Result<String> {
    let canonical = canonical_json(value);
    let hash = Code::Sha2_256.digest(canonical.as_bytes());
    let cid = Cid::new_v1(0x0200, hash);
    Ok(cid.to_string())
}

pub(crate) fn canonical_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(boolean) => boolean.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(string) => {
            serde_json::to_string(string).unwrap_or_else(|_| "\"\"".to_string())
        }
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
