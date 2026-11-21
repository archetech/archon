from __future__ import annotations

from copy import deepcopy

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


def test_clone_asset_creates_new_asset_with_cloned_reference(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}))

    clone_did = run(testbed.keymaster.clone_asset(did))
    assert clone_did != did
    assert run(testbed.keymaster.resolve_asset(clone_did)) == {"name": "asset", "cloned": did}


def test_transfer_asset_moves_ownership_between_ids(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.create_id("Bob"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}))

    assert run(testbed.keymaster.transfer_asset(did, alice)) is True
    docs = run(testbed.keymaster.resolve_did(did))
    assert docs["didDocument"]["controller"] == alice
    assert run(testbed.keymaster.list_assets("Alice")) == [did]
    assert run(testbed.keymaster.list_assets("Bob")) == []


def test_transfer_asset_rejects_non_asset_or_non_agent_controller(testbed):
    bob = run(testbed.keymaster.create_id("Bob"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}))

    with pytest.raises(KeymasterError, match="Invalid parameter: id"):
        run(testbed.keymaster.transfer_asset(bob, bob))

    with pytest.raises(KeymasterError, match="Invalid parameter: controller"):
        run(testbed.keymaster.transfer_asset(did, did))


def test_change_registry_updates_asset_registration(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}, {"registry": "local"}))

    assert run(testbed.keymaster.change_registry(did, "hyperswarm")) is True
    assert run(testbed.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"] == "hyperswarm"


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


BLOCK = {"height": 100, "timeISO": "2026-11-01T00:00:00.000Z"}


def _revoked_on(testbed, registry):
    run(testbed.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    did = run(testbed.keymaster.create_asset({"name": "asset"}, {"registry": registry}))
    assert run(testbed.keymaster.revoke_did(did)) is True
    return did


def _revoking(testbed, name="Bob"):
    return run(testbed.keymaster.fetch_id_info(name)).get("revoking")


def test_list_revocations_is_empty_for_a_wallet_with_no_record(testbed):
    run(testbed.keymaster.create_id("Bob"))

    assert run(testbed.keymaster.list_revocations()) == []
    assert _revoking(testbed) is None


def test_list_revocations_lists_a_revoked_chain_asset_as_pending(testbed):
    did = _revoked_on(testbed, "BTC:signet")

    assert run(testbed.keymaster.list_assets()) == []
    assert run(testbed.keymaster.list_revocations()) == [{"did": did, "registry": "BTC:signet", "status": "pending"}]
    assert run(testbed.keymaster.list_revocations("Bob")) == [{"did": did, "registry": "BTC:signet", "status": "pending"}]
    assert _revoking(testbed) == [did]


@pytest.mark.parametrize("registry", ["local", "hyperswarm"])
def test_revocation_on_an_unanchored_registry_is_not_tracked(testbed, registry):
    _revoked_on(testbed, registry)

    assert run(testbed.keymaster.list_assets()) == []
    assert run(testbed.keymaster.list_revocations()) == []
    assert _revoking(testbed) is None


def test_list_revocations_is_by_the_identity_that_owned_the_asset(testbed):
    did = _revoked_on(testbed, "BTC:signet")
    run(testbed.keymaster.create_id("Carol"))

    assert run(testbed.keymaster.list_revocations()) == []
    assert run(testbed.keymaster.list_revocations("Bob")) == [{"did": did, "registry": "BTC:signet", "status": "pending"}]


def test_list_revocations_keeps_one_confirmed_or_anchored_on_another_chain(testbed):
    did = _revoked_on(testbed, "BTC:signet")
    pending = [{"did": did, "registry": "BTC:signet", "status": "pending"}]
    metadata = testbed.gatekeeper.docs[did]["didDocumentMetadata"]

    metadata["confirmed"] = True
    assert run(testbed.keymaster.list_revocations()) == pending

    metadata["timestamp"] = {"chain": "ZEC:mainnet", "upperBound": BLOCK}
    assert run(testbed.keymaster.list_revocations()) == pending

    metadata["timestamp"] = {"chain": "BTC:signet", "lowerBound": BLOCK}
    assert run(testbed.keymaster.list_revocations()) == pending

    metadata["timestamp"] = {"chain": "BTC:signet", "upperBound": {"height": True, "timeISO": BLOCK["timeISO"]}}
    assert run(testbed.keymaster.list_revocations()) == pending
    assert _revoking(testbed) == [did]


def test_list_revocations_drops_one_anchored_on_the_assets_registry(testbed):
    did = _revoked_on(testbed, "BTC:signet")
    metadata = testbed.gatekeeper.docs[did]["didDocumentMetadata"]

    metadata["timestamp"] = {"chain": "BTC:signet", "upperBound": BLOCK}
    assert run(testbed.keymaster.list_revocations()) == []

    del metadata["timestamp"]
    assert run(testbed.keymaster.list_revocations()) == []
    assert _revoking(testbed) is None
    assert run(testbed.keymaster.list_assets()) == []


def test_list_revocations_reports_a_displaced_one_once_and_lists_the_asset_again(testbed):
    run(testbed.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    did = run(testbed.keymaster.create_asset({"name": "asset"}, {"registry": "BTC:signet"}))
    live = deepcopy(testbed.gatekeeper.docs[did])
    assert run(testbed.keymaster.revoke_did(did)) is True

    testbed.gatekeeper.docs[did] = live
    assert run(testbed.keymaster.list_revocations()) == [{"did": did, "registry": "BTC:signet", "status": "displaced"}]
    assert run(testbed.keymaster.list_revocations()) == []
    assert run(testbed.keymaster.list_assets()) == [did]
    assert _revoking(testbed) is None


def test_list_revocations_does_not_list_a_displaced_asset_another_identity_controls(testbed):
    run(testbed.keymaster.create_id("Bob", {"registry": "hyperswarm"}))
    did = run(testbed.keymaster.create_asset({"name": "asset"}, {"registry": "BTC:signet"}))
    live = deepcopy(testbed.gatekeeper.docs[did])
    assert run(testbed.keymaster.revoke_did(did)) is True

    live["didDocument"]["controller"] = "did:cid:someone-else"
    testbed.gatekeeper.docs[did] = live
    assert run(testbed.keymaster.list_revocations()) == [{"did": did, "registry": "BTC:signet", "status": "displaced"}]
    assert run(testbed.keymaster.list_assets()) == []


def test_list_revocations_keeps_one_the_node_cannot_resolve(testbed):
    did = _revoked_on(testbed, "BTC:signet")
    doc = testbed.gatekeeper.docs.pop(did)

    assert run(testbed.keymaster.list_revocations()) == [{"did": did, "status": "unresolved"}]

    testbed.gatekeeper.docs[did] = doc
    assert run(testbed.keymaster.list_revocations()) == [{"did": did, "registry": "BTC:signet", "status": "pending"}]


def test_revoke_asset_removes_it_from_owned_list(testbed):
    run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.create_asset({"name": "asset"}))
    assert did in run(testbed.keymaster.list_assets())

    assert run(testbed.keymaster.revoke_did(did)) is True
    assert did not in run(testbed.keymaster.list_assets())