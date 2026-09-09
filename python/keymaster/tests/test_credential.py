from __future__ import annotations

import pytest

from keymaster import KeymasterError
from keymaster import didcomm_crypto as dc

from .helpers import MOCK_SCHEMA, run


def test_bind_credential_uses_schema_defaults_and_external_subject(testbed):
    run(testbed.keymaster.create_id("Issuer"))
    schema_did = run(testbed.keymaster.create_schema({
        **MOCK_SCHEMA,
        "$credentialType": ["VerifiableCredential", "MembershipCredential"],
        "$credentialContext": ["https://example.org/credentials/v3"],
    }))

    vc = run(testbed.keymaster.bind_credential("mailto:bob@example.com", {"schema": schema_did}))

    assert vc["issuer"].startswith("did:")
    assert vc["credentialSubject"]["id"] == "mailto:bob@example.com"
    assert vc["type"] == ["VerifiableCredential", "MembershipCredential"]
    assert vc["@context"] == ["https://example.org/credentials/v3"]
    assert vc["credentialSchema"]["id"] == schema_did


def test_issue_get_and_list_issued_credential(testbed):
    subject = run(testbed.keymaster.create_id("Bob"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(subject, {"schema": schema_did}))

    did = run(testbed.keymaster.issue_credential(bound))
    vc = run(testbed.keymaster.get_credential(did))

    assert vc is not None
    assert vc["issuer"] == subject
    assert vc["credentialSubject"]["id"] == subject
    assert run(testbed.keymaster.list_issued()) == [did]


def test_issued_credential_names_its_own_did(testbed):
    """A credential must say which asset holds it, under the issuer's signature.

    Otherwise nothing binds the two: a holder can copy a revoked credential --
    genuinely issued and still verifying -- under a fresh asset DID and present
    it as current, because only the pointer lies and the pointer is the part
    nobody signed (#108).
    """
    subject = run(testbed.keymaster.create_id("Bob"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(subject, {"schema": schema_did}))

    did = run(testbed.keymaster.issue_credential(bound))
    vc = run(testbed.keymaster.get_credential(did))

    assert vc["id"] == did
    # Embedded before signing rather than bolted on after, so the binding is
    # the issuer's statement and not something a later holder could have added.
    assert run(testbed.keymaster.verify_proof(vc)) is True


def test_accept_and_list_held_credential(testbed):
    run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.set_current_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(bob, {"schema": schema_did}))
    did = run(testbed.keymaster.issue_credential(bound))

    run(testbed.keymaster.set_current_id("Bob"))
    assert run(testbed.keymaster.accept_credential(did)) is True
    assert run(testbed.keymaster.list_credentials()) == [did]
    assert run(testbed.keymaster.remove_credential(did)) is True
    assert run(testbed.keymaster.list_credentials()) == []


def test_publish_and_unpublish_credential_updates_manifest(testbed):
    run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.set_current_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(bob, {"schema": schema_did}))
    did = run(testbed.keymaster.issue_credential(bound))

    run(testbed.keymaster.set_current_id("Bob"))
    assert run(testbed.keymaster.accept_credential(did)) is True
    published = run(testbed.keymaster.publish_credential(did))
    assert published["credentialSubject"] == {"id": bob}

    doc = run(testbed.keymaster.resolve_did(bob))
    manifest = (doc.get("didDocumentData") or {}).get("manifest") or {}
    assert did in manifest

    message = run(testbed.keymaster.unpublish_credential(did))
    assert did in message
    doc = run(testbed.keymaster.resolve_did(bob))
    assert (doc.get("didDocumentData") or {}).get("manifest") == {}


def test_send_update_and_revoke_credential(testbed):
    run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.set_current_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(bob, {"schema": schema_did}))
    did = run(testbed.keymaster.issue_credential(bound))

    notice_did = run(testbed.keymaster.send_credential(did))
    notice_asset = run(testbed.keymaster.resolve_asset(notice_did))
    assert notice_asset["notice"]["to"] == [bob]
    assert notice_asset["notice"]["dids"] == [did]

    credential = run(testbed.keymaster.get_credential(did))
    assert credential is not None
    credential["validUntil"] = "2030-01-01T00:00:00Z"
    assert run(testbed.keymaster.update_credential(did, credential)) is True
    updated = run(testbed.keymaster.get_credential(did))
    assert updated["validUntil"] == "2030-01-01T00:00:00Z"

    assert run(testbed.keymaster.revoke_credential(did)) is True
    revoked = run(testbed.keymaster.resolve_did(did))
    assert revoked["didDocumentMetadata"]["deactivated"] is True


def test_issue_credential_rejects_mismatched_issuer(testbed):
    run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.set_current_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(bob, {"schema": schema_did}))

    run(testbed.keymaster.set_current_id("Bob"))
    with pytest.raises(KeymasterError, match="credential.issuer"):
        run(testbed.keymaster.issue_credential(bound))

def test_rotate_keys_keeps_a_published_key_agreement_key(testbed):
    """rotate_keys rebuilt verificationMethod as a single-element list, dropping
    every key published beside the identity one -- publish_didcomm's
    `#key-agreement-1` among them -- while keyAgreement, never rebuilt with it,
    went on naming the method just deleted. Mirrors the TypeScript regression in
    tests/keymaster/didcomm.test.ts.
    """
    km = testbed.keymaster
    did = run(km.create_id("Alice", {"registry": "local"}))
    run(km.publish_didcomm("https://relay.example/didcomm"))

    run(km.rotate_keys())

    document = run(km.resolve_did(did))["didDocument"]
    ids = [vm["id"] for vm in document["verificationMethod"]]
    fragments = [str(vm_id).split("#")[-1] for vm_id in ids]

    assert "key-agreement-1" in fragments
    assert all(str(ref).split("#")[-1] in fragments for ref in document.get("keyAgreement", []))
    assert "#key-2" in ids
    assert "#key-1" not in ids
    assert document["authentication"] == ["#key-2"]
    assert document["assertionMethod"] == ["#key-2"]


def test_assertion_key_derivation_is_deterministic_and_its_own_branch(testbed):
    km = testbed.keymaster
    run(km.create_id("Alice", {"registry": "local"}))

    first = run(km.fetch_assertion_key_pair())
    again = run(km.fetch_assertion_key_pair())
    agreement = run(km.fetch_didcomm_key_pair())

    assert first == again
    assert first["publicJwk"]["crv"] == "Ed25519"
    assert first["publicJwk"]["x"] != agreement["publicJwk"]["x"]


def test_publish_assertion_key_adds_a_multikey_without_displacing_the_identity_key(testbed):
    km = testbed.keymaster
    did = run(km.create_id("Alice", {"registry": "local"}))

    assert run(km.publish_assertion_key()) is True

    document = run(km.resolve_did(did))["didDocument"]
    multikeys = [vm for vm in document["verificationMethod"] if vm.get("type") == "Multikey"]
    keypair = run(km.fetch_assertion_key_pair())

    assert len(multikeys) == 1
    assert multikeys[0]["id"] == f"{did}#key-assertion-1"
    assert multikeys[0]["publicKeyMultibase"].startswith("z")
    assert dc.multikey_to_ed25519_public_key(multikeys[0]["publicKeyMultibase"]) == dc.ub64url(
        keypair["publicJwk"]["x"]
    )
    assert document["assertionMethod"] == ["#key-1", f"{did}#key-assertion-1"]
    assert "https://w3id.org/security/multikey/v1" in document["@context"]


def test_unpublish_assertion_key_leaves_the_identity_key_in_place(testbed):
    km = testbed.keymaster
    did = run(km.create_id("Alice", {"registry": "local"}))
    run(km.publish_assertion_key())

    assert run(km.unpublish_assertion_key()) is True

    document = run(km.resolve_did(did))["didDocument"]

    assert [vm["id"] for vm in document["verificationMethod"]] == ["#key-1"]
    assert document["assertionMethod"] == ["#key-1"]
    assert "https://w3id.org/security/multikey/v1" not in document.get("@context", [])


def _sign_eddsa_jcs_2022(km, document, did, name=None, proof_purpose="assertionMethod"):
    """Built here rather than through the implementation, so a wrong payload
    fails instead of agreeing with itself. Mirrors tests/keymaster/verify-proof.test.ts."""
    from keymaster.crypto import hash_json

    keypair = run(km.fetch_assertion_key_pair(name))
    unsecured = {k: v for k, v in document.items() if k != "proof"}
    config = {
        "@context": unsecured["@context"],
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-01T00:00:00.000Z",
        "verificationMethod": f"{did}#key-assertion-1",
        "proofPurpose": proof_purpose,
    }
    payload = bytes.fromhex(hash_json(config) + hash_json(unsecured))
    return {**config, "proofValue": dc.bytes_to_multibase(dc.sign_ed25519(payload, keypair["privateJwk"]))}


def _published_credential(km, name="Alice"):
    did = run(km.create_id(name, {"registry": "local"}))
    run(km.publish_assertion_key(name))
    document = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        "type": ["VerifiableCredential"],
        "issuer": did,
        "credentialSubject": {"id": did},
    }
    return did, document


def test_verify_proof_accepts_an_eddsa_jcs_2022_proof(testbed):
    km = testbed.keymaster
    did, document = _published_credential(km)

    secured = {**document, "proof": _sign_eddsa_jcs_2022(km, document, did)}

    assert run(km.verify_proof(secured)) is True


def test_verify_proof_rejects_a_changed_document_or_proof(testbed):
    km = testbed.keymaster
    did, document = _published_credential(km)
    proof = _sign_eddsa_jcs_2022(km, document, did)

    changed = {**document, "credentialSubject": {"id": "did:cid:someone-else"}, "proof": proof}
    recontexted = {**document, "proof": {**proof, "@context": ["https://example.test/v1"]}}

    assert run(km.verify_proof(changed)) is False
    assert run(km.verify_proof(recontexted)) is False


def test_verify_proof_reads_a_set_and_ignores_suites_it_does_not_implement(testbed):
    km = testbed.keymaster
    did, document = _published_credential(km)
    foreign = {
        "type": "DataIntegrityProof",
        "cryptosuite": "ecdsa-rdfc-2019",
        "created": "2026-01-01T00:00:00.000Z",
        "verificationMethod": f"{did}#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "zNotOurs",
    }
    good = _sign_eddsa_jcs_2022(km, document, did)

    assert run(km.verify_proof({**document, "proof": [foreign, good]})) is True
    assert run(km.verify_proof({**document, "proof": [foreign]})) is False
    assert run(km.verify_proof({**document, "proof": []})) is False


def test_verify_proof_requires_the_key_to_be_authorized_for_the_purpose(testbed):
    """A key published only for key agreement can otherwise sign a credential
    claiming assertionMethod: the signature checks out because the key really is
    the subject's. Mirrors tests/keymaster/verify-proof.test.ts."""
    km = testbed.keymaster
    did, document = _published_credential(km)

    # The key moves out of assertionMethod first: verify_proof resolves at the
    # proof's own created time, so a document changed afterwards cannot
    # retroactively invalidate a proof.
    doc = run(km.resolve_did(did))["didDocument"]
    doc["assertionMethod"] = [r for r in doc["assertionMethod"] if not str(r).endswith("#key-assertion-1")]
    doc["keyAgreement"] = [f"{did}#key-assertion-1"]
    run(km.update_did(did, {"didDocument": doc}))

    proof = _sign_eddsa_jcs_2022(km, document, did)

    assert run(km.verify_proof({**document, "proof": proof})) is False


def test_unpublish_assertion_key_keeps_the_context_while_a_multikey_remains(testbed):
    km = testbed.keymaster
    did, _ = _published_credential(km)

    doc = run(km.resolve_did(did))["didDocument"]
    doc["verificationMethod"] = [
        *doc["verificationMethod"],
        {
            "id": f"{did}#key-other-1",
            "controller": did,
            "type": "Multikey",
            "publicKeyMultibase": "z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp",
        },
    ]
    run(km.update_did(did, {"didDocument": doc}))

    run(km.unpublish_assertion_key())

    after = run(km.resolve_did(did))["didDocument"]

    assert f"{did}#key-other-1" in [vm["id"] for vm in after["verificationMethod"]]
    assert "https://w3id.org/security/multikey/v1" in after.get("@context", [])


def test_verify_proof_rejects_a_purpose_that_is_not_a_relationship(testbed):
    """Signed *with* the bad purpose, so the signature is genuinely valid and
    only the authorization check can reject it."""
    km = testbed.keymaster
    did, document = _published_credential(km)

    for purpose in ("capabilityInvocation", "keyAgreement", ""):
        proof = _sign_eddsa_jcs_2022(km, document, did, proof_purpose=purpose)
        assert run(km.verify_proof({**document, "proof": proof})) is False


def test_verify_proof_survives_a_proof_naming_an_unresolvable_issuer(testbed):
    km = testbed.keymaster
    did, document = _published_credential(km)
    unresolvable = {
        "type": "DataIntegrityProof",
        "cryptosuite": "eddsa-jcs-2022",
        "created": "2026-01-01T00:00:00.000Z",
        "verificationMethod": "did:web:example.test#key-1",
        "proofPurpose": "assertionMethod",
        "proofValue": "zNotOurs",
    }

    good = _sign_eddsa_jcs_2022(km, document, did)

    assert run(km.verify_proof({**document, "proof": [unresolvable, good]})) is True
    assert run(km.verify_proof({**document, "proof": [unresolvable]})) is False


def test_publish_assertion_key_replaces_a_relative_reference(testbed):
    km = testbed.keymaster
    did, _ = _published_credential(km)

    doc = run(km.resolve_did(did))["didDocument"]
    doc["verificationMethod"] = [
        {**vm, "id": "#key-assertion-1"} if vm.get("id") == f"{did}#key-assertion-1" else vm
        for vm in doc["verificationMethod"]
    ]
    doc["assertionMethod"] = [
        "#key-assertion-1" if ref == f"{did}#key-assertion-1" else ref for ref in doc["assertionMethod"]
    ]
    run(km.update_did(did, {"didDocument": doc}))

    run(km.publish_assertion_key())

    after = run(km.resolve_did(did))["didDocument"]
    multikeys = [vm for vm in after["verificationMethod"] if vm.get("type") == "Multikey"]

    assert len(multikeys) == 1
    assert len([r for r in after["assertionMethod"] if str(r).endswith("#key-assertion-1")]) == 1
