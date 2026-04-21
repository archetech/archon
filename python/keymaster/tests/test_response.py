from __future__ import annotations

import pytest

from keymaster import KeymasterError, UnknownIDError

from .helpers import MOCK_SCHEMA, run


def test_create_response_selects_matching_held_credentials(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.create_id("Victor"))

    run(testbed.keymaster.set_current_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    bound = run(testbed.keymaster.bind_credential(bob, {"schema": schema_did}))
    vc_did = run(testbed.keymaster.issue_credential(bound))

    run(testbed.keymaster.set_current_id("Bob"))
    assert run(testbed.keymaster.accept_credential(vc_did)) is True

    run(testbed.keymaster.set_current_id("Victor"))
    challenge_did = run(testbed.keymaster.create_challenge({"credentials": [{"schema": schema_did, "issuers": [alice]}]}))

    run(testbed.keymaster.set_current_id("Bob"))
    response_did = run(testbed.keymaster.create_response(challenge_did))
    response = run(testbed.keymaster.decrypt_json(response_did))["response"]

    assert response["challenge"] == challenge_did
    assert len(response["credentials"]) == 1
    assert response["credentials"][0]["vc"] == vc_did
    assert response["fulfilled"] == 1
    assert response["match"] is True


def test_create_response_rejects_invalid_or_non_challenge_dids(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))

    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.create_response("missing"))

    with pytest.raises(KeymasterError, match="Invalid parameter: challengeDID"):
        run(testbed.keymaster.create_response(alice))


def test_verify_response_handles_empty_and_unmatched_challenges(testbed):
    run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))

    run(testbed.keymaster.set_current_id("Alice"))
    empty_challenge = run(testbed.keymaster.create_challenge())

    run(testbed.keymaster.set_current_id("Bob"))
    response_did = run(testbed.keymaster.create_response(empty_challenge))

    run(testbed.keymaster.set_current_id("Alice"))
    verified = run(testbed.keymaster.verify_response(response_did))
    assert verified == {
        "challenge": empty_challenge,
        "credentials": [],
        "requested": 0,
        "fulfilled": 0,
        "match": True,
        "vps": [],
        "responder": bob,
    }

    run(testbed.keymaster.set_current_id("Bob"))
    unmatched_schema = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    run(testbed.keymaster.set_current_id("Alice"))
    challenge = run(testbed.keymaster.create_challenge({"credentials": [{"schema": unmatched_schema}]}))
    run(testbed.keymaster.set_current_id("Bob"))
    unmatched_response = run(testbed.keymaster.create_response(challenge))
    run(testbed.keymaster.set_current_id("Alice"))
    unmatched = run(testbed.keymaster.verify_response(unmatched_response))
    assert unmatched["match"] is False
    assert unmatched["requested"] == 1
    assert unmatched["fulfilled"] == 0
    assert unmatched["vps"] == []


def test_verify_response_accepts_updated_credentials_and_detects_revocation(testbed):
    run(testbed.keymaster.create_id("Alice"))
    carol = run(testbed.keymaster.create_id("Carol"))
    run(testbed.keymaster.create_id("Victor"))

    run(testbed.keymaster.set_current_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA, {"registry": "local"}))
    bound = run(testbed.keymaster.bind_credential(carol, {"schema": schema_did}))
    vc_did = run(testbed.keymaster.issue_credential(bound, {"registry": "local"}))

    run(testbed.keymaster.set_current_id("Carol"))
    assert run(testbed.keymaster.accept_credential(vc_did)) is True

    run(testbed.keymaster.set_current_id("Alice"))
    updated = run(testbed.keymaster.get_credential(vc_did))
    updated["credentialSubject"]["email"] = "updated@email.com"
    assert run(testbed.keymaster.update_credential(vc_did, updated)) is True

    run(testbed.keymaster.set_current_id("Victor"))
    challenge_did = run(testbed.keymaster.create_challenge({"credentials": [{"schema": schema_did}]}))

    run(testbed.keymaster.set_current_id("Carol"))
    response_did = run(testbed.keymaster.create_response(challenge_did))

    run(testbed.keymaster.set_current_id("Victor"))
    verified = run(testbed.keymaster.verify_response(response_did))
    assert verified["match"] is True
    assert verified["fulfilled"] == 1
    assert len(verified["vps"]) == 1

    run(testbed.keymaster.set_current_id("Alice"))
    assert run(testbed.keymaster.revoke_credential(vc_did)) is True

    run(testbed.keymaster.set_current_id("Victor"))
    revoked = run(testbed.keymaster.verify_response(response_did))
    assert revoked["match"] is False
    assert revoked["fulfilled"] == 0
    assert revoked["vps"] == []


def test_verify_response_rejects_non_response_asset(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.encrypt_json({"plain": True}, alice, {"registry": "local"}))

    with pytest.raises(KeymasterError, match="responseDID not a valid challenge response"):
        run(testbed.keymaster.verify_response(did))
