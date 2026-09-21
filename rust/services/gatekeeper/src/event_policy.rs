//! Envelope policy shared by import and recovery. Queue and candidate keys
//! deliberately describe different identities; signed operations are unchanged.
use std::collections::HashMap;
use serde_json::{json, Value};
use crate::{generate_json_cid, EventRecord};

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

// Old mediators and HTTP history imports can supply receipt/chain timestamps.
// Correct the envelope before storage; never rewrite the operation itself.
pub(crate) fn normalize_event_time(event: &mut EventRecord) {
    let time = if event.registry == "local" && event.operation["type"] == "create" {
        event.operation["created"].as_str()
    } else if is_unanchored_registry(&event.registry) {
        event.operation["proof"]["created"].as_str()
    } else {
        None
    };
    if let Some(time) = time {
        event.time = time.to_string();
    }
}

pub(crate) fn candidate_key(event: &EventRecord) -> String {
    if is_locally_stamped_registry(&event.registry) {
        // A fresh gossip receipt time is not new authorization evidence.
        return json!([event.opid, event.registry]).to_string();
    }
    if !is_unanchored_registry(&event.registry) {
        return json!([event.opid, event.registry, event.ordinal]).to_string();
    }
    json!([event.opid, event.registry, event.time, event.ordinal]).to_string()
}

pub(crate) fn preferred_candidates(events: Vec<EventRecord>) -> Vec<EventRecord> {
    let mut positions = HashMap::new();
    let mut retained: Vec<EventRecord> = Vec::new();
    for event in events {
        let key = candidate_key(&event);
        if let Some(&index) = positions.get(&key) {
            if !is_locally_stamped_registry(&event.registry) {
                retained[index] = event;
            }
        } else {
            positions.insert(key, retained.len());
            retained.push(event);
        }
    }
    retained
}

/// Events handed in from a peer or restored export cannot vouch that a
/// chain committed an event. Chain confirmation is accepted only through
/// the mediator's CID import; externally supplied chain registrations are
/// unconfirmed hints. Mediators discover anchors in chain order but skip
/// unavailable content and retry it later (#1151), so confirmation provenance
/// does not establish complete or ordered controller history (#1150).
pub(crate) fn relay_hints(batch: &[Value]) -> Vec<Value> {
    batch
        .iter()
        .map(|event| {
            let Some(object) = event.as_object() else {
                return event.clone();
            };
            let registry = object.get("registry").and_then(Value::as_str);
            match registry {
                Some(registry) if !is_locally_stamped_registry(registry) => {
                    let mut hint = object.clone();
                    hint.remove("registration");
                    hint.insert("registry".to_string(), Value::String("hyperswarm".to_string()));
                    Value::Object(hint)
                }
                _ => event.clone(),
            }
        })
        .collect()
}

pub(crate) fn queue_key(event: &Value) -> Option<String> {
    let registry = event.get("registry").and_then(Value::as_str)?;
    let opid = generate_json_cid(event.get("operation")?).ok()?;
    let position = if event
        .get("registration")
        .is_some_and(|value| !value.is_null())
    {
        format!(
            "/{}",
            serde_json::json!([event.get("time"), event.get("ordinal")])
        )
    } else {
        String::new()
    };
    Some(format!("{registry}/{opid}{position}"))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::{event_record_to_value, value_to_event_record};

    #[test]
    fn shared_event_policy() {
        let policies: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/convergence/event-policy.json"
        )).unwrap();
        let vectors: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/convergence/event-target-vectors.json"
        )).unwrap();
        let local: Vec<Value> = serde_json::from_str(include_str!(
            "../../../../tests/convergence/local-receipt-counterexample.json"
        )).unwrap();
        let mut operations = vectors[0]["operations"].as_array().unwrap().clone();
        operations.push(local[0]["events"][0]["operation"].clone());
        for policy in policies {
            let registry = policy["registry"].as_str().unwrap();
            let local = policy["locallyStamped"].as_bool().unwrap();
            assert_eq!(is_locally_stamped_registry(registry), local);
            assert_eq!(is_unanchored_registry(registry), policy["unanchored"].as_bool().unwrap());
            for operation in &operations {
                let opid = generate_json_cid(operation).unwrap();
                let value = json!({
                    "registry": registry, "time": "2026-09-03T00:00:00Z", "ordinal": [10, 2, 0],
                    "opid": opid, "operation": operation,
                    "registration": { "height": 10, "index": 2, "opidx": 0, "txid": "tx", "batch": "batch" }
                });
                assert_eq!(queue_key(&value).unwrap(), format!("{registry}/{opid}/{}", json!([value["time"], value["ordinal"]])));
                let hints = relay_hints(&[value.clone()]);
                assert_eq!(hints[0]["registry"], policy["relay"]);
                assert_eq!(hints[0]["registration"], if local { value["registration"].clone() } else { Value::Null });
                assert_eq!(hints[0]["operation"], *operation);
                assert_eq!(hints[0]["ordinal"], value["ordinal"]);
                let mut event = value_to_event_record(&value);
                normalize_event_time(&mut event);
                let clock = if operation["type"] == "create" { &policy["createTime"] } else { &policy["updateTime"] };
                let expected = match clock.as_str().unwrap() {
                    "created" => &operation["created"],
                    "proof" => &operation["proof"]["created"],
                    _ => &value["time"],
                };
                assert_eq!(json!(event.time), *expected);
                let normalized = event_record_to_value(&event);
                normalize_event_time(&mut event);
                assert_eq!(event_record_to_value(&event), normalized);
                let mut restored = normalized.clone();
                restored["time"] = value["time"].clone();
                assert_eq!(restored, value);
                let fields: Vec<_> = policy["candidateFields"].as_array().unwrap().iter()
                    .map(|field| normalized[field.as_str().unwrap()].clone()).collect();
                assert_eq!(candidate_key(&event), json!(fields).to_string());
                // Extension metadata distinguishes representations without changing chain facts.
                let mut copy = event.clone();
                copy.registration.as_mut().unwrap()["note"] = json!("second");
                let retained = preferred_candidates(vec![event.clone(), copy.clone()]);
                let chosen = if policy["keepFirst"] == true { &event } else { &copy };
                assert_eq!(event_record_to_value(&retained[0]), event_record_to_value(chosen));
                copy.ordinal = Some(vec![10, 2, 1]);
                assert_eq!(preferred_candidates(vec![event, copy]).len(), if local { 1 } else { 2 });
                let mut plain = value.clone();
                plain.as_object_mut().unwrap().remove("registration");
                assert_eq!(queue_key(&plain).unwrap(), format!("{registry}/{opid}"));
            }
        }
    }
}
