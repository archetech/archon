from __future__ import annotations

import pytest

from keymaster import KeymasterError

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