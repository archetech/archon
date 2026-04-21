from __future__ import annotations

import pytest

from keymaster import KeymasterError, UnknownIDError

from .helpers import run


def test_resolve_did_supports_names_aliases_and_unknown_names(testbed):
    did = run(testbed.keymaster.create_id("Bob"))
    asset = run(testbed.keymaster.create_asset({"name": "asset"}))
    run(testbed.keymaster.add_alias("mock", asset))

    assert run(testbed.keymaster.resolve_did("Bob"))["didDocument"]["id"] == did
    assert run(testbed.keymaster.resolve_did("mock"))["didDocument"]["id"] == asset

    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.resolve_did("missing"))


def test_update_did_respects_wallet_ownership(testbed):
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.set_current_id("Bob"))
    asset = run(testbed.keymaster.create_asset({"name": "asset"}))
    doc = run(testbed.keymaster.resolve_did(asset))
    doc["didDocumentData"] = {"name": "updated"}

    run(testbed.keymaster.set_current_id("Alice"))
    assert run(testbed.keymaster.update_did(asset, doc)) is True
    assert run(testbed.keymaster.resolve_did(asset))["didDocument"]["controller"] == bob
    assert run(testbed.keymaster.resolve_did(asset))["didDocumentData"] == {"name": "updated"}

    run(testbed.keymaster.remove_id("Bob"))
    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.update_did(asset, doc))


def test_revoke_did_and_remove_from_owned_semantics(testbed):
    owner = run(testbed.keymaster.create_id("Alice"))

    assert run(testbed.keymaster.remove_from_owned("did:test:missing", owner)) is False

    asset = run(testbed.keymaster.create_asset({"name": "asset"}))
    assert run(testbed.keymaster.remove_from_owned(asset, owner)) is True
    assert run(testbed.keymaster.remove_from_owned(asset, owner)) is False

    asset2 = run(testbed.keymaster.create_asset({"name": "asset-2"}))
    assert run(testbed.keymaster.revoke_did(asset2)) is True
    revoked = run(testbed.keymaster.resolve_did(asset2))
    assert revoked["didDocumentMetadata"]["deactivated"] is True
    assert revoked["didDocument"] == {"id": asset2}
    assert revoked["didDocumentData"] == {}


def test_rotate_keys_updates_public_key_and_keeps_old_messages_decryptable(testbed):
    alice = run(testbed.keymaster.create_id("Alice", {"registry": "local"}))
    bob = run(testbed.keymaster.create_id("Bob", {"registry": "local"}))
    run(testbed.keymaster.set_current_id("Alice"))

    previous_key = run(testbed.keymaster.resolve_did(alice))["didDocument"]["verificationMethod"][0]["publicKeyJwk"]
    secret = run(testbed.keymaster.encrypt_message("hi bob", bob, {"registry": "local"}))

    assert run(testbed.keymaster.rotate_keys()) is True
    rotated_key = run(testbed.keymaster.resolve_did(alice))["didDocument"]["verificationMethod"][0]["publicKeyJwk"]
    assert previous_key["x"] != rotated_key["x"]
    assert previous_key["y"] != rotated_key["y"]

    assert run(testbed.keymaster.decrypt_message(secret)) == "hi bob"
    run(testbed.keymaster.set_current_id("Bob"))
    assert run(testbed.keymaster.decrypt_message(secret)) == "hi bob"


def test_agent_did_and_public_key_helpers_validate_documents(testbed):
    bob = run(testbed.keymaster.create_id("Bob"))
    agent_doc = run(testbed.keymaster.resolve_did(bob))
    asset = run(testbed.keymaster.create_asset({"name": "asset"}))
    asset_doc = run(testbed.keymaster.resolve_did(asset))

    assert run(testbed.keymaster.get_public_key_jwk(agent_doc)) == agent_doc["didDocument"]["verificationMethod"][0]["publicKeyJwk"]
    assert testbed.keymaster.get_agent_did(agent_doc) == bob

    with pytest.raises(KeymasterError, match="The DID document does not contain any verification methods"):
        run(testbed.keymaster.get_public_key_jwk(asset_doc))

    with pytest.raises(KeymasterError, match="Document is not an agent"):
        testbed.keymaster.get_agent_did(asset_doc)

    broken_doc = dict(agent_doc)
    broken_doc.pop("didDocument")
    with pytest.raises(KeymasterError, match="Missing didDocument"):
        run(testbed.keymaster.get_public_key_jwk(broken_doc))

    missing_key_doc = run(testbed.keymaster.resolve_did(bob))
    missing_key_doc["didDocument"]["verificationMethod"][0].pop("publicKeyJwk")
    with pytest.raises(KeymasterError, match="The publicKeyJwk is missing in the first verification method"):
        run(testbed.keymaster.get_public_key_jwk(missing_key_doc))


def test_list_registries_returns_configured_values(testbed):
    registries = run(testbed.keymaster.list_registries())

    assert "local" in registries
    assert "hyperswarm" in registries
    assert "BTC:signet" in registries