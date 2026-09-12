use anyhow::{Context, Result};
use async_recursion::async_recursion;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use cid::Cid;
use k256::ecdsa::{signature::hazmat::PrehashVerifier, Signature as K256Signature, VerifyingKey};
use multihash_codetable::{Code, MultihashDigest};
use serde_json::Value;

use crate::{is_valid_registry, resolve_local_doc_async, AppState, Config, ResolveOptions};

/// Validate a `did:<method>:<cid>` DID, mirroring the TypeScript `isValidDID`: the string must
/// start with `did:`, have at least three `:`-separated segments, and its final segment must parse
/// as a valid CID. Lets the conformant surface return 400 `invalidDid` (rather than 404) for a
/// syntactically-`did:` DID whose CID suffix is malformed.
pub(crate) fn is_valid_did(did: &str) -> bool {
    if !did.starts_with("did:") {
        return false;
    }
    if did.split(':').count() < 3 {
        return false;
    }
    did.rsplit(':')
        .next()
        .map(|suffix| Cid::try_from(suffix).is_ok())
        .unwrap_or(false)
}

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

    let Some(event_time) = event.get("time").and_then(Value::as_str) else {
        return false;
    };
    if !verify_date_format(Some(event_time)) {
        return false;
    }

    let Some(operation) = event.get("operation") else {
        return false;
    };
    if exceeds_json_size(operation, 64 * 1024) {
        return false;
    }
    if !verify_proof_format(operation.get("proof")) {
        return false;
    }
    let Some(op_type) = operation.get("type").and_then(Value::as_str) else {
        return false;
    };
    match op_type {
        "create" => {
            operation
                .get("created")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
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
                && match operation
                    .get("registration")
                    .and_then(|value| value.get("type"))
                    .and_then(Value::as_str)
                {
                    Some("agent") => operation.get("publicJwk").is_some(),
                    Some("asset") => {
                        let controller = operation.get("controller").and_then(Value::as_str);
                        let signer = operation
                            .get("proof")
                            .and_then(|value| value.get("verificationMethod"))
                            .and_then(Value::as_str)
                            .and_then(|verification_method| verification_method.split('#').next());
                        controller.is_some() && controller == signer
                    }
                    _ => false,
                }
        }
        "update" => {
            operation.get("did").and_then(Value::as_str).is_some()
                && operation
                    .get("doc")
                    .map(|doc| {
                        let has_doc_payload = doc.get("didDocument").is_some()
                            || doc.get("didDocumentData").is_some()
                            || doc.get("didDocumentRegistration").is_some();
                        let id_matches = match (
                            doc.get("didDocument")
                                .and_then(|value| value.get("id"))
                                .and_then(Value::as_str),
                            operation.get("did").and_then(Value::as_str),
                        ) {
                            (Some(doc_id), Some(operation_did)) => doc_id == operation_did,
                            _ => true,
                        };
                        has_doc_payload && id_matches
                    })
                    .unwrap_or(false)
        }
        "delete" => {
            operation.get("did").and_then(Value::as_str).is_some()
        }
        _ => false,
    }
}

fn verify_did_format(did: &str) -> bool {
    did.starts_with("did:")
}

fn exceeds_json_size(value: &Value, limit: usize) -> bool {
    struct LimitWriter {
        count: usize,
        limit: usize,
    }

    impl std::io::Write for LimitWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.count = self.count.saturating_add(buf.len());
            if self.count > self.limit {
                return Err(std::io::Error::other("json size limit exceeded"));
            }
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut writer = LimitWriter { count: 0, limit };
    serde_json::to_writer(&mut writer, value).is_err()
}

fn verify_date_format(time: Option<&str>) -> bool {
    time.and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_some()
}

pub(crate) fn verify_proof_format(proof: Option<&Value>) -> bool {
    let Some(proof) = proof else {
        return false;
    };
    // Two accepted labels. The legacy one is permanent -- every operation ever
    // anchored was signed under it -- and says the payload is the document
    // alone. The Data Integrity one says the proof configuration is signed with
    // it, which is what binds `created` and `proofPurpose`.
    if !is_operation_proof_type(proof) {
        return false;
    }
    if !verify_date_format(proof.get("created").and_then(Value::as_str)) {
        return false;
    }
    // An operation exercises control over a DID document, which is what
    // `capabilityInvocation` names and what a node emits. The other two are what
    // this accepted before, and refusing either would reject an operation
    // already anchored -- which each node replays on restart.
    if !matches!(
        proof.get("proofPurpose").and_then(Value::as_str),
        Some("capabilityInvocation" | "authentication" | "assertionMethod")
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
    proof
        .get("proofValue")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
}

pub(crate) const ARCHON_SECP256K1_CRYPTOSUITE: &str = "archon-ecdsa-secp256k1-jcs-2026";
pub(crate) const LEGACY_PROOF_TYPE: &str = "EcdsaSecp256k1Signature2019";

fn is_operation_proof_type(proof: &Value) -> bool {
    match proof.get("type").and_then(Value::as_str) {
        Some(LEGACY_PROOF_TYPE) => true,
        Some("DataIntegrityProof") => {
            proof.get("cryptosuite").and_then(Value::as_str) == Some(ARCHON_SECP256K1_CRYPTOSUITE)
        }
        _ => false,
    }
}

// What the proof signs, which its own type decides.
//
// The legacy type signs the operation alone, leaving every member of the proof
// outside the signature -- `created` selects the controller document version
// that authorizes an asset operation, so a third party could move it (#1087).
// The Archon suite signs the proof configuration alongside the operation,
// concatenating the two digests and hashing once more because ECDSA signs a
// 32-byte digest where Ed25519 takes the message.
fn operation_message_hash(operation: &Value) -> Result<String> {
    let unsecured = value_without_proof(operation);
    let proof = operation
        .get("proof")
        .context("Invalid operation: proof")?;

    if proof.get("type").and_then(Value::as_str) == Some(LEGACY_PROOF_TYPE) {
        return generate_message_hash(&unsecured);
    }

    let mut config = proof.clone();

    if let Some(object) = config.as_object_mut() {
        object.remove("proofValue");
    }

    let digests = format!(
        "{}{}",
        generate_message_hash(&config)?,
        generate_message_hash(&unsecured)?
    );
    let bytes = hex_to_bytes(&digests).context("Invalid operation: proof")?;
    let hash = Code::Sha2_256.digest(&bytes);

    Ok(bytes_to_hex(hash.digest()))
}

// A DID URL, whichever form it was written in. A proof names its key absolutely
// (`did:cid:...#key-1`) or relatively (`#key-1`), and a document may list it
// either way, so the two are compared as URLs rather than as strings.
fn absolute_key_id(reference: &str, did: &str) -> String {
    if reference.starts_with('#') {
        format!("{did}{reference}")
    } else {
        reference.to_string()
    }
}

// The key the proof names, which is not always the first one. Rotation replaces
// the identity key in place, so index 0 has been right for every operation
// anchored so far -- but a DID that publishes a second key could not sign with
// it, and a purpose can only be enforced against a key that was looked up
// (#1130).
//
// None rather than an error: an operation naming a key the document does not
// list has not verified, and an error means "Invalid operation" on the import
// path, which defers -- such an operation would be retried forever instead of
// refused.
fn operation_key<'a>(doc: &'a Value, proof: &Value) -> Option<&'a Value> {
    let did_document = doc.get("didDocument")?;
    let did = did_document.get("id").and_then(Value::as_str).unwrap_or_default();
    let named = proof.get("verificationMethod").and_then(Value::as_str)?;
    let target = absolute_key_id(named, did);

    did_document
        .get("verificationMethod")
        .and_then(Value::as_array)?
        .iter()
        .find(|method| {
            method
                .get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| absolute_key_id(id, did) == target)
        })
        .and_then(|method| method.get("publicKeyJwk"))
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
    // proof_value and the JWK are caller-supplied data; a parse failure is a validation error,
    // not an internal fault. Carry the "Invalid operation" convention so it classifies as such.
    let sig_bytes =
        base64url_to_bytes(proof_value).with_context(|| "Invalid operation: proof")?;
    let compressed_key =
        public_jwk_to_sec1_bytes(public_jwk).with_context(|| "Invalid operation: publicJwk")?;
    let verifying_key = VerifyingKey::from_sec1_bytes(&compressed_key)
        .with_context(|| "Invalid operation: publicJwk")?;
    let signature =
        K256Signature::from_slice(&sig_bytes).with_context(|| "Invalid operation: proof")?;
    Ok(verifying_key.verify_prehash(&msg_hash, &signature).is_ok())
}

fn hex_to_bytes(value: &str) -> Result<Vec<u8>> {
    if !value.len().is_multiple_of(2) {
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

// The controller's document as it stood when an operation entered the network.
// `as_of` is an anchored event's block time, or a stored event's time on replay;
// None means the operation is being submitted now.
//
// It is never `proof.created`. The signer chooses that, and choosing one from
// before a key rotation selects the document that still lists the retired key
// -- so a compromised-then-rotated key went on authorizing every asset the
// agent controls (#1131). Confirmed only, so an unanchored rotation cannot be
// conjured either.
async fn controller_document(state: &AppState, controller: &str, as_of: Option<&str>) -> Result<Value> {
    resolve_local_doc_async(
        state,
        controller,
        ResolveOptions {
            confirm: true,
            version_time: as_of.map(ToString::to_string),
            ..ResolveOptions::default()
        },
    )
    .await
}

#[async_recursion]
pub(crate) async fn verify_create_operation_impl(
    state: &AppState,
    operation: &Value,
    as_of: Option<&str>,
) -> Result<bool> {
    if operation.is_null() {
        anyhow::bail!("Invalid operation: missing");
    }
    if exceeds_json_size(operation, 64 * 1024) {
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

    let msg_hash = operation_message_hash(operation)?;
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

    let controller_doc = controller_document(state, &controller_did, as_of).await?;

    if controller_doc
        .get("didDocumentRegistration")
        .and_then(|value| value.get("registry"))
        .and_then(Value::as_str)
        == Some("local")
        && registry != "local"
    {
        anyhow::bail!("Invalid operation: non-local registry={registry}");
    }

    // Absent means the controller has not been imported yet, which the import
    // state machine defers on. An empty array is a document with no keys, which
    // is a refusal rather than a reason to wait.
    if controller_doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .is_none()
    {
        anyhow::bail!("Invalid operation: didDocument missing verificationMethod");
    }

    let Some(public_jwk) = operation_key(&controller_doc, proof) else {
        return Ok(false);
    };

    verify_sig(&msg_hash, proof_value, public_jwk)
}

#[async_recursion]
pub(crate) async fn verify_update_operation_impl(
    state: &AppState,
    operation: &Value,
    doc: &Value,
    as_of: Option<&str>,
) -> Result<bool> {
    if exceeds_json_size(operation, 64 * 1024) {
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
        let controller_doc = controller_document(state, controller_did, as_of).await?;
        return verify_update_operation_impl(state, operation, &controller_doc, as_of).await;
    }

    if doc
        .get("didDocument")
        .and_then(|value| value.get("verificationMethod"))
        .is_none()
    {
        anyhow::bail!("Invalid operation: doc.didDocument.verificationMethod");
    }

    let proof = operation.get("proof").context("Invalid operation: proof")?;
    let msg_hash = operation_message_hash(operation)?;
    let Some(public_jwk) = operation_key(doc, proof) else {
        return Ok(false);
    };
    let proof_value = proof
        .get("proofValue")
        .and_then(Value::as_str)
        .context("Invalid operation: proof")?;
    verify_sig(&msg_hash, proof_value, public_jwk)
}

// `as_of` is when the operation entered the network; see controller_document.
pub(crate) async fn verify_operation_impl(
    state: &AppState,
    operation: &Value,
    as_of: Option<&str>,
) -> Result<bool> {
    match operation.get("type").and_then(Value::as_str) {
        Some("create") => verify_create_operation_impl(state, operation, as_of).await,
        Some("update" | "delete") => {
            let did = operation
                .get("did")
                .and_then(Value::as_str)
                .context("Invalid operation: missing operation.did")?;
            let doc = resolve_local_doc_async(state, did, ResolveOptions::default()).await?;
            verify_update_operation_impl(state, operation, &doc, as_of).await
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


#[cfg(test)]
mod timestamp_vectors {
    use super::verify_date_format;
    use serde_json::Value;

    // The TypeScript port checks the same file, so a change here has to be made
    // in both ports or one of the two suites fails.
    #[test]
    fn matches_the_shared_vectors() {
        let raw = include_str!("../../../../tests/gatekeeper/timestamp-vectors.json");
        let doc: Value = serde_json::from_str(raw).expect("timestamp-vectors.json");
        let vectors = doc["vectors"].as_array().expect("vectors");

        assert!(!vectors.is_empty());

        for vector in vectors {
            let value = vector["value"].as_str().expect("value");
            let expected = vector["valid"].as_bool().expect("valid");
            let note = vector["note"].as_str().unwrap_or("");

            assert_eq!(
                verify_date_format(Some(value)),
                expected,
                "{value:?} should be {expected} ({note})"
            );
        }
    }

    #[test]
    fn rejects_a_missing_timestamp() {
        assert!(!verify_date_format(None));
    }
}

#[cfg(test)]
mod event_shape_vectors {
    use super::verify_event_shape;
    use serde_json::Value;

    // The TypeScript port checks the same file, so a change here has to be made
    // in both ports or one of the two suites fails.
    #[test]
    fn matches_the_shared_vectors() {
        let proofs: Value =
            serde_json::from_str(include_str!("../../../../tests/gatekeeper/proof-vectors.json"))
                .expect("proof-vectors.json");
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../tests/gatekeeper/event-shape-vectors.json"
        ))
        .expect("event-shape-vectors.json");

        let vectors = fixture["vectors"].as_array().expect("vectors");
        assert!(!vectors.is_empty());

        for vector in vectors {
            let base = fixture["bases"][vector["base"].as_str().expect("base")]
                .as_str()
                .expect("base name");

            let mut event = fixture["event"].clone();
            event["operation"] = proofs[base]["operation"].clone();

            let path: Vec<&str> = vector["path"]
                .as_array()
                .expect("path")
                .iter()
                .map(|segment| segment.as_str().expect("segment"))
                .collect();

            if let Some((last, parents)) = path.split_last() {
                let mut node = &mut event;

                for key in parents {
                    node = node.get_mut(key).expect("path segment");
                }

                if vector.get("delete").and_then(Value::as_bool).unwrap_or(false) {
                    node.as_object_mut().expect("object").remove(*last);
                } else {
                    node[*last] = vector["value"].clone();
                }
            }

            let expected = vector["valid"].as_bool().expect("valid");
            let name = vector["name"].as_str().unwrap_or("");
            let note = vector["note"].as_str().unwrap_or("");

            assert_eq!(
                verify_event_shape(&event),
                expected,
                "{name} should be {expected} ({note})"
            );
        }
    }
}

#[cfg(test)]
mod operation_proofs {
    use super::{verify_proof_format, operation_message_hash};
    use serde_json::Value;

    // The TypeScript port checks the same vector, so a change here has to be
    // made in both ports or one of the two suites fails.
    fn vectors() -> Value {
        serde_json::from_str(include_str!("../../../../tests/gatekeeper/proof-vectors.json"))
            .expect("proof-vectors.json")
    }

    #[test]
    fn accepts_both_proof_labels() {
        let vectors = vectors();

        assert!(verify_proof_format(
            vectors["agentCreateValid"]["operation"].get("proof")
        ));
        assert!(verify_proof_format(
            vectors["agentCreateValidDataIntegrity"]["operation"].get("proof")
        ));
    }

    // An operation exercises control over a DID document, which is what
    // capabilityInvocation names. The other two stay accepted because every
    // operation anchored before that was settled claims authentication, and
    // assertionMethod was accepted alongside it.
    #[test]
    fn accepts_the_purposes_an_operation_may_claim() {
        let base = vectors()["agentCreateValidDataIntegrity"]["operation"]["proof"].clone();

        for purpose in ["capabilityInvocation", "authentication", "assertionMethod"] {
            let mut proof = base.clone();
            proof["proofPurpose"] = Value::String(purpose.to_string());
            assert!(verify_proof_format(Some(&proof)), "{purpose} should be accepted");
        }

        for purpose in ["keyAgreement", "capabilityDelegation", ""] {
            let mut proof = base.clone();
            proof["proofPurpose"] = Value::String(purpose.to_string());
            assert!(!verify_proof_format(Some(&proof)), "{purpose} should be refused");
        }
    }

    // Selection is by the key the proof names, not by position. The TypeScript
    // port has the same cases in tests/gatekeeper/operation-proofs.test.ts.
    #[test]
    fn selects_the_key_the_proof_names() {
        let did = "did:cid:bagaaieratest";
        let doc = serde_json::json!({
            "didDocument": {
                "id": did,
                "verificationMethod": [
                    { "id": "#key-1", "publicKeyJwk": { "kty": "EC", "x": "first" } },
                    { "id": "#key-2", "publicKeyJwk": { "kty": "EC", "x": "second" } }
                ]
            }
        });

        let named = |value: &str| serde_json::json!({ "verificationMethod": value });

        assert_eq!(
            super::operation_key(&doc, &named(&format!("{did}#key-2")))
                .and_then(|key| key.get("x"))
                .and_then(Value::as_str),
            Some("second"),
            "a proof naming the second key must not select the first"
        );

        // The proof may name its key absolutely and the document relatively, so
        // the two are compared as DID URLs rather than as strings.
        assert_eq!(
            super::operation_key(&doc, &named("#key-1"))
                .and_then(|key| key.get("x"))
                .and_then(Value::as_str),
            Some("first")
        );

        assert!(super::operation_key(&doc, &named(&format!("{did}#key-9"))).is_none());

        // An empty array is a document with no keys: a refusal, where an absent
        // property is left to the caller as a structural error to defer on.
        let empty = serde_json::json!({ "didDocument": { "id": did, "verificationMethod": [] } });
        assert!(super::operation_key(&empty, &named("#key-1")).is_none());
    }

    #[test]
    fn refuses_a_cryptosuite_it_does_not_implement() {
        let mut proof = vectors()["agentCreateValidDataIntegrity"]["operation"]["proof"].clone();
        proof["cryptosuite"] = Value::String("ecdsa-jcs-2019".to_string());

        assert!(!verify_proof_format(Some(&proof)));
    }

    // The payload is what both ports have to agree on byte for byte: a
    // signature made by one and checked by the other is the whole point.
    #[test]
    fn hashes_the_proof_configuration_with_the_operation() {
        let operation = vectors()["agentCreateValidDataIntegrity"]["operation"].clone();
        let bound = operation_message_hash(&operation).expect("hash");

        let mut moved = operation.clone();
        moved["proof"]["created"] = Value::String("2026-04-12T12:00:00Z".to_string());

        assert_ne!(
            bound,
            operation_message_hash(&moved).expect("hash"),
            "moving created must change what the signature covers"
        );

        // The legacy payload ignores the proof entirely, which is the defect
        // the suite exists to fix and stays true for what is already anchored.
        let legacy = vectors()["agentCreateValid"]["operation"].clone();
        let mut legacy_moved = legacy.clone();
        legacy_moved["proof"]["created"] = Value::String("2026-04-12T12:00:00Z".to_string());

        assert_eq!(
            operation_message_hash(&legacy).expect("hash"),
            operation_message_hash(&legacy_moved).expect("hash")
        );
    }
}
