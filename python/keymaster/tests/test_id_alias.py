from __future__ import annotations

import pytest

from keymaster import KeymasterError, UnknownIDError

from .helpers import run


def test_create_id_updates_wallet_and_current_id(testbed):
    did = run(testbed.keymaster.create_id("Bob"))
    wallet = run(testbed.keymaster.load_wallet())

    assert wallet["ids"]["Bob"]["did"] == did
    assert wallet["current"] == "Bob"


def test_create_id_operation_does_not_modify_wallet(testbed):
    before = run(testbed.keymaster.load_wallet())
    operation = run(testbed.keymaster.create_id_operation("Alice", options={"registry": "BTC:signet"}))
    after = run(testbed.keymaster.load_wallet())

    assert operation["registration"]["registry"] == "BTC:signet"
    assert before == after
    assert "Alice" not in after["ids"]


def test_create_id_rejects_duplicate_or_empty_names(testbed):
    run(testbed.keymaster.create_id("Bob"))

    with pytest.raises(KeymasterError, match="name already used"):
        run(testbed.keymaster.create_id("Bob"))

    with pytest.raises(KeymasterError, match="name must be a non-empty string"):
        run(testbed.keymaster.create_id("   "))


def test_set_current_rename_and_remove_id(testbed):
    run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.create_id("Bob"))

    assert run(testbed.keymaster.set_current_id("Alice")) is True
    assert run(testbed.keymaster.get_current_id()) == "Alice"

    assert run(testbed.keymaster.rename_id("Alice", "Carol")) is True
    assert run(testbed.keymaster.get_current_id()) == "Carol"

    assert run(testbed.keymaster.remove_id("Bob")) is True
    assert run(testbed.keymaster.list_ids()) == ["Carol"]


def test_set_current_id_rejects_unknown_name(testbed):
    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.set_current_id("missing"))


def test_alias_crud_and_lookup(testbed):
    did = run(testbed.keymaster.create_id("Bob"))

    assert run(testbed.keymaster.add_alias("Jack", did)) is True
    assert run(testbed.keymaster.get_alias("Jack")) == did
    assert run(testbed.keymaster.lookup_did("Jack")) == did
    assert run(testbed.keymaster.list_aliases()) == {"Jack": did}

    assert run(testbed.keymaster.remove_alias("Jack")) is True
    assert run(testbed.keymaster.get_alias("Jack")) is None


def test_alias_rejects_duplicate_and_long_names(testbed):
    did = run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.add_alias("Jack", did))

    with pytest.raises(KeymasterError, match="alias already used"):
        run(testbed.keymaster.add_alias("Jack", did))

    with pytest.raises(KeymasterError, match="alias too long"):
        run(testbed.keymaster.add_alias("x" * 33, did))


def test_resolve_did_marks_owned_for_wallet_entries(testbed):
    did = run(testbed.keymaster.create_id("Bob"))
    docs = run(testbed.keymaster.resolve_did(did))

    assert docs["didDocumentMetadata"]["isOwned"] is True


def test_change_registry_updates_id_registration(testbed):
    did = run(testbed.keymaster.create_id("Bob", {"registry": "local"}))

    assert run(testbed.keymaster.change_registry("Bob", "hyperswarm")) is True
    assert run(testbed.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"] == "hyperswarm"


def test_change_registry_returns_true_when_unchanged(testbed):
    did = run(testbed.keymaster.create_id("Bob", {"registry": "local"}))
    before = run(testbed.keymaster.resolve_did(did))["didDocumentMetadata"]["versionSequence"]

    assert run(testbed.keymaster.change_registry("Bob", "local")) is True
    after = run(testbed.keymaster.resolve_did(did))["didDocumentMetadata"]["versionSequence"]
    assert after == before


def test_change_registry_accepts_raw_did(testbed):
    did = run(testbed.keymaster.create_id("Bob", {"registry": "local"}))

    assert run(testbed.keymaster.change_registry(did, "hyperswarm")) is True
    assert run(testbed.keymaster.resolve_did(did))["didDocumentRegistration"]["registry"] == "hyperswarm"


def test_change_registry_rejects_unsupported_or_empty_registry(testbed):
    run(testbed.keymaster.create_id("Bob", {"registry": "local"}))

    with pytest.raises(KeymasterError, match="not supported"):
        run(testbed.keymaster.change_registry("Bob", "BTC:mainnet"))

    with pytest.raises(KeymasterError, match="Invalid parameter: registry"):
        run(testbed.keymaster.change_registry("Bob", ""))