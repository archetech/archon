from copy import deepcopy

import pytest

from keymaster import Keymaster, KeymasterError
from .helpers import FakeWalletStore, run


def damaged_agent(testbed, absolute=False):
    km = testbed.keymaster
    did = run(km.create_id("Alice", {"registry": "local"}))
    doc = run(km.resolve_did(did))["didDocument"]
    doc["verificationMethod"][0]["id"] = f"{did}#key-1" if absolute else "#key-1"
    doc["capabilityInvocation"] = ["#removed"]
    run(km.update_did(did, {"didDocument": doc, "didDocumentData": {"keep": "data"}}))
    # FakeGatekeeper does not model registry confirmation.
    testbed.gatekeeper.docs[did]["didDocumentMetadata"]["confirmed"] = True
    return did


@pytest.mark.parametrize("absolute", [False, True])
def test_signed_repair_rotation_and_noop(testbed, absolute):
    km = testbed.keymaster
    did = damaged_agent(testbed, absolute)
    before = run(km.resolve_did(did))
    count = len(testbed.gatekeeper.operations)
    report = run(km.check_did("Alice"))
    assert report["canRepair"] is True
    assert [issue["code"] for issue in report["issues"]] == ["stale-operation-permissions", "missing-operation-permission"]
    assert len(testbed.gatekeeper.operations) == count
    assert run(km.repair_did(did))["submitted"] is True
    operation = testbed.gatekeeper.operations[-1]
    assert operation["proof"]["verificationMethod"] == f"{did}#key-1"
    assert operation["previd"] == before["didDocumentMetadata"]["versionId"]
    after = run(km.resolve_did(did))
    assert after["didDocument"] == {**before["didDocument"], "capabilityInvocation": [f"{did}#key-1" if absolute else "#key-1"]}
    assert after["didDocumentData"] == before["didDocumentData"]
    assert after["didDocumentRegistration"] == before["didDocumentRegistration"]
    assert run(km.repair_did(did))["submitted"] is False
    assert len(testbed.gatekeeper.operations) == count + 1
    run(km.rotate_keys())
    assert run(km.check_did(did))["issues"] == []
    assert run(km.resolve_did(did))["didDocument"]["capabilityInvocation"] == ["#key-2"]


def test_other_methods_and_permissions_preserved(testbed):
    km = testbed.keymaster
    did = damaged_agent(testbed)
    run(km.publish_assertion_key())
    run(km.publish_didcomm("https://relay.example/didcomm"))
    document = run(km.resolve_did(did))["didDocument"]
    extra = document["verificationMethod"][1]["id"]
    document["capabilityInvocation"] = [extra, "#removed"]
    run(km.update_did(did, {"didDocument": document}))
    run(km.repair_did(did))
    assert run(km.resolve_did(did))["didDocument"] == {**document, "capabilityInvocation": [extra, "#key-1"]}


def test_asset_refers_to_controller_without_mutating_it(testbed):
    km = testbed.keymaster
    did = damaged_agent(testbed)
    asset = run(km.create_asset({"keep": True}, {"registry": "local"}))
    before = deepcopy(testbed.gatekeeper.docs)
    report = run(km.check_did(asset))
    assert report["issues"][0]["relatedDid"] == did
    assert report["canRepair"] is False
    with pytest.raises(KeymasterError, match="controlling agent separately"):
        run(km.repair_did(asset))
    assert testbed.gatekeeper.docs == before
    run(km.repair_did(did))
    assert run(km.repair_did(asset))["submitted"] is False


def test_inspection_without_wallet_and_no_private_key(testbed):
    did = damaged_agent(testbed)
    store = FakeWalletStore()
    stranger = Keymaster(gatekeeper=testbed.gatekeeper, wallet_store=store, passphrase="test")
    report = run(stranger.check_did(did))
    assert report["issues"]
    assert report["canRepair"] is False
    assert report["changes"] is None
    with pytest.raises(KeymasterError, match="unavailable"):
        run(stranger.repair_did(did))
    assert store.wallet is None


def test_deactivated_and_unconfirmed(testbed):
    did = damaged_agent(testbed)
    metadata = testbed.gatekeeper.docs[did]["didDocumentMetadata"]
    metadata["confirmed"] = False
    assert run(testbed.keymaster.check_did(did))["canRepair"] is False
    metadata["deactivated"] = True
    assert run(testbed.keymaster.check_did(did))["issues"][0]["code"] == "deactivated"


def test_non_fragment_ids_are_distinct(testbed):
    km = testbed.keymaster
    did = damaged_agent(testbed)
    document = run(km.resolve_did(did))["didDocument"]
    document["verificationMethod"].append({**document["verificationMethod"][0], "id": "keys/op#key-1"})
    document["capabilityInvocation"] = ["keys/op#key-1"]
    run(km.update_did(did, {"didDocument": document}))
    assert [issue["code"] for issue in run(km.check_did(did))["issues"]] == ["missing-operation-permission"]
    run(km.repair_did(did))
    run(km.rotate_keys())
    after = run(km.resolve_did(did))["didDocument"]
    assert after["capabilityInvocation"] == ["keys/op#key-1", "#key-2"]
    assert after["verificationMethod"][1] == document["verificationMethod"][1]
    after["capabilityInvocation"].append("#key-1")
    run(km.update_did(did, {"didDocument": after}))
    assert [issue["code"] for issue in run(km.check_did(did))["issues"]] == ["stale-operation-permissions"]
    run(km.repair_did(did))
    assert run(km.resolve_did(did))["didDocument"]["capabilityInvocation"] == ["keys/op#key-1", "#key-2"]


def test_non_fragment_signer_is_not_repairable(testbed):
    km = testbed.keymaster
    did = damaged_agent(testbed)
    document = run(km.resolve_did(did))["didDocument"]
    document["verificationMethod"][0]["id"] = "keys/op#key-1"
    run(km.update_did(did, {"didDocument": document}))
    report = run(km.check_did(did))
    assert report["canRepair"] is False
    assert report["issues"][0]["code"] == "unsupported-operation-key"


def test_repair_with_older_wallet_key(testbed):
    km = testbed.keymaster
    did = damaged_agent(testbed)
    original = run(km.resolve_did(did))["didDocument"]
    run(km.rotate_keys())
    run(km.update_did(did, {"didDocument": original}))
    assert run(km.load_wallet())["ids"]["Alice"]["index"] == 1
    assert run(km.check_did(did))["canRepair"] is True
    assert run(km.repair_did(did))["submitted"] is True
    keypair = run(km.fetch_key_pair(did))
    assert keypair["publicJwk"] == original["verificationMethod"][0]["publicKeyJwk"]


@pytest.mark.parametrize("state", ["deactivated", "unsupported-operation-key", "uncontrolled"])
def test_asset_reports_unavailable_controller_repair(testbed, state):
    km = testbed.keymaster
    agent = damaged_agent(testbed)
    asset = run(km.create_asset({"keep": True}, {"registry": "local"}))
    if state == "deactivated":
        run(km.revoke_did(agent))
    elif state == "unsupported-operation-key":
        document = run(km.resolve_did(agent))["didDocument"]
        document["verificationMethod"][0]["id"] = "keys/op#key-1"
        run(km.update_did(agent, {"didDocument": document}))
    else:
        km = Keymaster(gatekeeper=testbed.gatekeeper, wallet_store=FakeWalletStore(), passphrase="test")
    controller = run(km.check_did(agent))
    report = run(km.check_did(asset))
    assert controller["canRepair"] is False
    assert report["canRepair"] is False
    assert report["changes"] is None
    assert report["issues"][0]["code"] == "controller-repair-unavailable"
    assert report["issues"][0]["relatedDid"] == agent
    assert (controller.get("reason") or controller["issues"][0]["message"]) in report["issues"][0]["message"]
    with pytest.raises(KeymasterError, match="Controller repair unavailable"):
        run(km.repair_did(asset))
