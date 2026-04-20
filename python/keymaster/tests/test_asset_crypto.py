from __future__ import annotations

import pytest

from keymaster import KeymasterError

from .helpers import MOCK_JSON, run


def test_create_asset_records_ownership_and_resolves_data(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}, {"alias": "asset-alias"}))

    assert run(testbed.keymaster.resolve_asset(did)) == {"name": "asset"}
    assert did in run(testbed.keymaster.list_assets())
    assert run(testbed.keymaster.get_alias("asset-alias")) == did


def test_merge_data_updates_asset_document_data(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"name": "asset", "active": True}))

    assert run(testbed.keymaster.merge_data(did, {"count": 3, "active": None})) is True
    assert run(testbed.keymaster.resolve_asset(did)) == {"name": "asset", "count": 3}


def test_add_proof_and_verify_proof_round_trip(testbed):
    run(testbed.keymaster.create_id("Alice"))
    payload = {"hello": "world"}
    signed = run(testbed.keymaster.add_proof(payload))

    assert "proof" in signed
    assert run(testbed.keymaster.verify_proof(signed)) is True


def test_encrypt_and_decrypt_json_round_trip(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.encrypt_json(MOCK_JSON, alice, {"registry": "local"}))

    assert run(testbed.keymaster.decrypt_json(did)) == MOCK_JSON


def test_rotate_keys_keeps_old_ciphertext_decryptable(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    encrypted_did = run(testbed.keymaster.encrypt_message("secret", alice, {"registry": "local"}))

    assert run(testbed.keymaster.rotate_keys()) is True
    assert run(testbed.keymaster.decrypt_message(encrypted_did)) == "secret"


def test_decrypt_message_rejects_plain_assets(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"plain": True}))

    with pytest.raises(KeymasterError, match="did not encrypted"):
        run(testbed.keymaster.decrypt_message(did))


def test_revoke_asset_removes_it_from_owned_list(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}))
    assert did in run(testbed.keymaster.list_assets())

    assert run(testbed.keymaster.revoke_did(did)) is True
    assert did not in run(testbed.keymaster.list_assets())