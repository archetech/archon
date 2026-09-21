//! Event authorization shared by import, direct submission, and verified replay.
//! Proof verification receives selected documents and knows nothing about chains.
use anyhow::{Context, Result};
use async_recursion::async_recursion;
use serde_json::Value;

use crate::proofs::{
    verify_create_operation_impl, verify_date_format, verify_proof_format, verify_update_operation_impl,
};
use crate::{resolve_local_doc_async, AppState, EventRecord, GatekeeperDb, ResolveOptions};

/// The two registries whose events this node stamps itself, so that no event
/// on them can carry a position a chain assigned: a local event holds the
/// signer's own `created`, a hyperswarm event the operation's proof time.
/// `pin` also has no chain position, but its relay/deduplication rules differ.
/// Other registries establish anchoring through confirming event metadata.
pub(crate) fn is_locally_stamped_registry(registry: &str) -> bool {
    registry == "local" || registry == "hyperswarm"
}

/// Pin receipts can confirm pin-registry DIDs, but never establish chain order.
pub(crate) fn is_unanchored_registry(registry: &str) -> bool {
    registry == "pin" || is_locally_stamped_registry(registry)
}

/// Whether stored confirming events carry chain positions. This does not
/// establish that the controller history is complete through a cutoff (#1150).
/// Local/hyperswarm histories, unanchored registries, and migrations with no
/// chain event yet retain the historical proof-time fallback.
async fn is_anchored(state: &AppState, did: &str, registry: Option<&str>) -> bool {
    let Some(registry) = registry else {
        return false;
    };
    if is_unanchored_registry(registry) {
        return false;
    }
    let events = {
        let store = state.store.lock().await;
        store.get_events(did)
    };
    let mut expected = events
        .first()
        .and_then(|event| event.operation.get("registration"))
        .and_then(|registration| registration.get("registry"))
        .and_then(Value::as_str);
    let mut anchored = false;
    for (index, event) in events.iter().enumerate() {
        // Genesis is admitted separately; ignore the unconfirmed suffix.
        if index > 0 && Some(event.registry.as_str()) != expected {
            break;
        }
        if Some(event.registry.as_str()) == expected
            && !is_unanchored_registry(&event.registry)
        {
            if event.registration.is_none() {
                return false;
            }
            anchored = true;
        }
        if event.operation.get("type").and_then(Value::as_str) == Some("update") {
            expected = event
                .operation
                .get("doc")
                .and_then(|doc| doc.get("didDocumentRegistration"))
                .and_then(|registration| registration.get("registry"))
                .and_then(Value::as_str)
                .or(expected);
        }
    }
    anchored
}

/// The controller document that authorizes an operation on an asset.
///
/// By default the controller is resolved at `proof.created`, which keeps a
/// signature valid at the historical time it was made. But `proof.created`
/// is the signer's own claim: a key rotated out of the controller can name a
/// `created` from before the rotation and be authorized by the document that
/// still listed it (#1131). Once a chain has committed the operation it has a
/// position the signer did not choose -- the anchoring block -- and the
/// controller is resolved there instead. Only when the controller's own
/// rotation history is on a chain, though: a hyperswarm controller has no
/// independent chain position. Its events use operation proof time; the
/// historical proof-time fallback still applies (#1134).
///
/// Within a block every event shares the block's time, so time cannot order a
/// rotation against an operation the chain committed earlier in the same
/// block; the ordinal can, but only among events on the same registry --
/// ordinals are registry-local, and a controller that migrated registries
/// carries events from both. So the cutoff is the ordinal for the controller's
/// events on the operation's registry and the block time for any other.
async fn controller_for_event(
    state: &AppState,
    controller_did: &str,
    operation: &Value,
    event: Option<&EventRecord>,
) -> Result<Value> {
    if let Some(event) = event.filter(|event| {
        event.registration.is_some() && !is_unanchored_registry(&event.registry)
    }) {
        let doc = resolve_local_doc_async(
            state,
            controller_did,
            ResolveOptions {
                confirm: true,
                version_time: Some(event.time.clone()),
                version_ordinal: event
                    .ordinal
                    .as_ref()
                    .map(|ordinal| (event.registry.clone(), ordinal.clone())),
                ..ResolveOptions::default()
            },
        )
        .await?;
        let registry = doc
            .get("didDocumentRegistration")
            .and_then(|value| value.get("registry"))
            .and_then(Value::as_str);
        if is_anchored(state, controller_did, registry).await {
            return Ok(doc);
        }
    }

    resolve_local_doc_async(
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
    .await
}

async fn creation_registration(state: &AppState, did: &str) -> Option<Value> {
    state
        .store
        .lock()
        .await
        .get_events(did)
        .first()
        .and_then(|event| event.operation.get("registration"))
        .cloned()
}

async fn creation_type(state: &AppState, did: &str) -> Option<String> {
    creation_registration(state, did)
        .await?
        .get("type")?
        .as_str()
        .map(str::to_owned)
}

// Registration replaces the whole component; omission is handled by the caller.
fn valid_registration(value: &Value, genesis: Option<&Value>) -> bool {
    let Some(registration) = value.as_object() else {
        return false;
    };
    if registration.get("version").and_then(Value::as_i64) != Some(1)
        || !matches!(
            registration.get("type").and_then(Value::as_str),
            Some("agent" | "asset")
        )
        || !registration
            .get("registry")
            .and_then(Value::as_str)
            .is_some_and(crate::is_valid_registry)
    {
        return false;
    }
    if let Some(expiry) = registration.get("validUntil") {
        if !verify_date_format(expiry.as_str()) {
            return false;
        }
    }
    genesis.is_none_or(|genesis| {
        registration.get("version") == genesis.get("version")
            && registration.get("type") == genesis.get("type")
            && registration.get("prefix") == genesis.get("prefix")
    })
}

async fn self_controlled_agent(state: &AppState, doc: &Value) -> bool {
    let Some(id) = doc.pointer("/didDocument/id").and_then(Value::as_str) else {
        return false;
    };
    creation_type(state, id).await.as_deref() == Some("agent")
        && doc
            .pointer("/didDocument/controller")
            .map_or(true, |controller| controller.as_str() == Some(id))
        && doc
            .pointer("/didDocumentMetadata/deactivated")
            .and_then(Value::as_bool)
            != Some(true)
}

// The target's predecessor is distinct from the agent selected to authorize it.
async fn validate_predecessor(state: &AppState, operation: &Value, previous: &Value) -> Result<()> {
    let reference = operation
        .get("previd")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let version_id = previous
        .pointer("/didDocumentMetadata/versionId")
        .and_then(Value::as_str);
    let valid = match version_id {
        Some(version_id) if !reference.is_empty() => {
            reference == version_id
                || state.store.lock().await.canonical_reference(reference) == version_id
        }
        _ => false,
    };
    if !valid {
        anyhow::bail!("Invalid operation: previd");
    }
    Ok(())
}

/// Select authority once, then verify the operation against that document.
/// Agents authorize themselves; assets have exactly one agent as their owner.
#[async_recursion]
pub(crate) async fn authorize_operation(
    state: &AppState,
    operation: &Value,
    previous: Option<&Value>,
    event: Option<&EventRecord>,
) -> Result<bool> {
    match operation.get("type").and_then(Value::as_str) {
        Some("create") => {
            let kind = operation
                .pointer("/registration/type")
                .and_then(Value::as_str);
            if kind == Some("agent") && operation.get("controller").is_some() {
                return Ok(false);
            }
            let mut controller = None;
            if kind == Some("asset") && verify_proof_format(operation.get("proof")) {
                if let Some(did) = operation.get("controller").and_then(Value::as_str) {
                    controller = Some(controller_for_event(state, did, operation, event).await?);
                }
            }
            if kind == Some("asset") {
                let Some(owner) = controller.as_ref() else {
                    return Ok(false);
                };
                if !self_controlled_agent(state, owner).await {
                    return Ok(false);
                }
            }
            Ok(
                verify_create_operation_impl(operation, controller.as_ref())?
                    && valid_registration(&operation["registration"], None),
            )
        }
        Some("update" | "delete") => {
            let did = operation
                .get("did")
                .and_then(Value::as_str)
                .context("Invalid operation: missing operation.did")?;
            let current = match previous {
                Some(doc) => doc.clone(),
                None => resolve_local_doc_async(state, did, ResolveOptions::default()).await?,
            };
            validate_predecessor(state, operation, &current).await?;
            let genesis = creation_registration(state, did).await;
            let kind = genesis
                .as_ref()
                .and_then(|value| value.get("type"))
                .and_then(Value::as_str);
            if current
                .pointer("/didDocumentMetadata/deactivated")
                .and_then(Value::as_bool)
                == Some(true)
                || !verify_proof_format(operation.get("proof"))
            {
                return Ok(false);
            }
            if let Some(registration) = operation.pointer("/doc/didDocumentRegistration") {
                if !valid_registration(registration, genesis.as_ref()) {
                    return Ok(false);
                }
            }
            let next = operation
                .pointer("/doc/didDocument")
                .unwrap_or(&current["didDocument"]);
            if next.get("id").and_then(Value::as_str) != Some(did) {
                return Ok(false);
            }
            let authority = match kind {
                Some("agent") => {
                    if !self_controlled_agent(state, &current).await
                        || next
                            .get("controller")
                            .is_some_and(|controller| controller.as_str() != Some(did))
                    {
                        return Ok(false);
                    }
                    current
                }
                Some("asset") => {
                    let Some(controller) = current
                        .pointer("/didDocument/controller")
                        .and_then(Value::as_str)
                    else {
                        return Ok(false);
                    };
                    let Some(next_controller) = next
                        .get("controller")
                        .and_then(Value::as_str)
                        .filter(|did| !did.is_empty())
                    else {
                        return Ok(false);
                    };
                    let authority =
                        controller_for_event(state, controller, operation, event).await?;
                    if !self_controlled_agent(state, &authority).await {
                        return Ok(false);
                    }
                    if next_controller != controller {
                        let owner =
                            controller_for_event(state, next_controller, operation, event).await?;
                        if !self_controlled_agent(state, &owner).await {
                            return Ok(false);
                        }
                    }
                    authority
                }
                _ => return Ok(false),
            };
            verify_update_operation_impl(operation, &authority)
        }
        _ => Ok(false),
    }
}
