"""Which proof an operation carries.

Mirrors tests/keymaster/operation-proofs.test.ts.
"""

from keymaster.crypto import hash_json, hash_message

from .helpers import make_testbed, run


def _create_op() -> dict:
    bed = make_testbed()
    run(bed.keymaster.create_id("Alice", {"registry": "local"}))

    return bed.gatekeeper.operations[0]


def test_signs_the_proof_configuration_into_every_operation():
    proof = _create_op()["proof"]

    assert proof["type"] == "DataIntegrityProof"
    assert proof["cryptosuite"] == "archon-ecdsa-jcs-2019"
    assert proof["proofPurpose"] == "authentication"


def test_the_bound_payload_covers_the_proof_configuration():
    # The same construction the gatekeepers verify: the two digests
    # concatenated and hashed once more, because ECDSA signs a 32-byte digest.
    operation = _create_op()
    proof = dict(operation["proof"])
    unsecured = {key: value for key, value in operation.items() if key != "proof"}
    config = {key: value for key, value in proof.items() if key != "proofValue"}

    bound = hash_message(bytes.fromhex(hash_json(config) + hash_json(unsecured)))

    moved = dict(config)
    moved["created"] = "2030-01-01T00:00:00Z"

    assert bound != hash_message(bytes.fromhex(hash_json(moved) + hash_json(unsecured)))


def test_the_seed_bank_keeps_the_legacy_proof():
    # Its DID is the CID of the operation, proof included, so signing it any
    # other way computes a different DID and orphans every wallet that has one.
    bed = make_testbed()
    run(bed.keymaster.create_id("Alice", {"registry": "local"}))
    run(bed.keymaster.resolve_seed_bank())

    types = [operation["proof"]["type"] for operation in bed.gatekeeper.operations]

    assert "EcdsaSecp256k1Signature2019" in types
    assert "DataIntegrityProof" in types
