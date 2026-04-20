from __future__ import annotations

import pytest

from keymaster import KeymasterError

from .helpers import MOCK_SCHEMA, run


def test_schema_lifecycle_and_template(testbed):
    run(testbed.keymaster.create_id("Alice"))
    schema_did = run(testbed.keymaster.create_schema(MOCK_SCHEMA))

    assert run(testbed.keymaster.get_schema(schema_did)) == MOCK_SCHEMA
    assert run(testbed.keymaster.test_schema(schema_did)) is True
    assert run(testbed.keymaster.list_schemas()) == [schema_did]

    template = run(testbed.keymaster.create_template(schema_did))
    assert template == {"email": "TBD", "$schema": schema_did}


def test_create_schema_rejects_invalid_schema(testbed):
    run(testbed.keymaster.create_id("Alice"))

    with pytest.raises(KeymasterError, match="Invalid parameter: schema"):
        run(testbed.keymaster.create_schema({"type": "object"}))


def test_group_membership_and_recursion(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    bob = run(testbed.keymaster.create_id("Bob"))
    group_a = run(testbed.keymaster.create_group("A"))
    group_b = run(testbed.keymaster.create_group("B"))

    assert run(testbed.keymaster.add_group_member(group_a, bob)) is True
    assert run(testbed.keymaster.add_group_member(group_b, group_a)) is True

    assert run(testbed.keymaster.test_group(group_a, bob)) is True
    assert run(testbed.keymaster.test_group(group_b, bob)) is True
    assert run(testbed.keymaster.test_group(group_b, alice)) is False


def test_group_rejects_self_and_mutual_membership(testbed):
    run(testbed.keymaster.create_id("Alice"))
    group_a = run(testbed.keymaster.create_group("A"))
    group_b = run(testbed.keymaster.create_group("B"))

    with pytest.raises(KeymasterError, match="can't add a group to itself"):
        run(testbed.keymaster.add_group_member(group_a, group_a))

    assert run(testbed.keymaster.add_group_member(group_a, group_b)) is True
    with pytest.raises(KeymasterError, match="can't create mutual membership"):
        run(testbed.keymaster.add_group_member(group_b, group_a))


def test_remove_group_member_updates_members(testbed):
    bob = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.create_id("Alice"))
    group = run(testbed.keymaster.create_group("A"))
    run(testbed.keymaster.add_group_member(group, bob))

    assert run(testbed.keymaster.remove_group_member(group, bob)) is True
    assert run(testbed.keymaster.get_group(group)) == {"name": "A", "members": []}


def test_create_and_verify_challenge_response(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    challenge_did = run(testbed.keymaster.create_challenge({"credentials": []}, {"controller": alice}))
    response_did = run(testbed.keymaster.create_response(challenge_did, {"registry": "local"}))
    verified = run(testbed.keymaster.verify_response(response_did))

    assert verified["challenge"] == challenge_did
    assert verified["match"] is True
    assert verified["requested"] == 0
    assert verified["responder"] == alice


def test_verify_response_rejects_non_response_asset(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.encrypt_json({"plain": True}, alice, {"registry": "local"}))

    with pytest.raises(KeymasterError, match="responseDID not a valid challenge response"):
        run(testbed.keymaster.verify_response(did))