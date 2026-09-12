"""Which proof an operation carries.

Mirrors tests/keymaster/operation-proofs.test.ts. The gatekeepers accept both
forms (#1087); which one a wallet emits is a deployment decision, because a node
that has not upgraded refuses the bound form outright (#1125).
"""

from keymaster.crypto import hash_json, hash_message

from .helpers import make_testbed, run


def _create_op(bound: bool) -> dict:
    bed = make_testbed(bound_operation_proofs=bound)
    run(bed.keymaster.create_id("Alice", {"registry": "local"}))

    return bed.gatekeeper.operations[0]


def test_emits_the_legacy_proof_by_default():
    assert _create_op(False)["proof"]["type"] == "EcdsaSecp256k1Signature2019"


def test_emits_a_proof_that_signs_its_configuration_when_asked():
    proof = _create_op(True)["proof"]

    assert proof["type"] == "DataIntegrityProof"
    assert proof["cryptosuite"] == "archon-ecdsa-jcs-2019"
    assert proof["proofPurpose"] == "authentication"


def test_the_bound_payload_covers_the_proof_configuration():
    # The same construction the gatekeepers verify: the two digests
    # concatenated and hashed once more, because ECDSA signs a 32-byte digest.
    operation = _create_op(True)
    proof = dict(operation["proof"])
    unsecured = {key: value for key, value in operation.items() if key != "proof"}
    config = {key: value for key, value in proof.items() if key != "proofValue"}

    bound = hash_message(bytes.fromhex(hash_json(config) + hash_json(unsecured)))

    moved = dict(config)
    moved["created"] = "2030-01-01T00:00:00Z"

    assert bound != hash_message(bytes.fromhex(hash_json(moved) + hash_json(unsecured)))
