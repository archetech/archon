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
