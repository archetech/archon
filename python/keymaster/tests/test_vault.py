from __future__ import annotations

import json

import pytest

from keymaster import KeymasterError

from .helpers import make_testbed, run


def test_create_get_and_test_vault():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())
    vault = run(keymaster.get_vault(vault_id))

    assert run(keymaster.test_vault(vault_id)) is True
    assert vault["version"] == 1
    assert vault["publicJwk"]
    assert vault["salt"]
    assert vault["keys"]
    assert vault["items"]


def test_list_vault_members_for_owner_and_member_secret_behavior():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    alice = run(keymaster.create_id("Alice"))
    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault({"secretMembers": True}))

    assert run(keymaster.add_vault_member(vault_id, alice)) is True
    owner_members = run(keymaster.list_vault_members(vault_id))
    run(keymaster.set_current_id("Alice"))
    member_members = run(keymaster.list_vault_members(vault_id))

    assert alice in owner_members
    assert member_members == {}


def test_vault_member_upgrade_from_legacy_version():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    alice = run(keymaster.create_id("Alice"))
    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault({"version": 0}))

    assert run(keymaster.add_vault_member(vault_id, alice)) is True
    members = run(keymaster.list_vault_members(vault_id))
    vault = run(keymaster.get_vault(vault_id))

    assert alice in members
    assert vault["version"] == 1


def test_add_and_remove_vault_member_owner_rules():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    alice = run(keymaster.create_id("Alice"))
    bob = run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())

    assert run(keymaster.add_vault_member(vault_id, bob)) is False
    assert run(keymaster.add_vault_member(vault_id, alice)) is True
    assert run(keymaster.remove_vault_member(vault_id, bob)) is False
    assert run(keymaster.remove_vault_member(vault_id, alice)) is True
    assert run(keymaster.list_vault_members(vault_id)) == {}


def test_add_and_get_vault_item_for_owner_and_member():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    alice = run(keymaster.create_id("Alice"))
    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())
    payload = b'{"login":{"service":"https://example.com","username":"bob","password":"secret"}}'

    run(keymaster.add_vault_member(vault_id, alice))
    assert run(keymaster.add_vault_item(vault_id, "login.json", payload)) is True

    items = run(keymaster.list_vault_items(vault_id))
    owner_item = run(keymaster.get_vault_item(vault_id, "login.json"))
    run(keymaster.set_current_id("Alice"))
    member_item = run(keymaster.get_vault_item(vault_id, "login.json"))

    assert items["login.json"]["type"] == "application/json"
    assert items["login.json"]["data"]
    assert json.loads(owner_item.decode("utf-8"))["login"]["username"] == "bob"
    assert member_item == payload


def test_get_vault_item_uses_ipfs_fallback_and_missing_data_errors():
    testbed = make_testbed()
    keymaster = testbed.keymaster
    gatekeeper = testbed.gatekeeper

    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())
    payload = b"X" * (10 * 1024)

    run(keymaster.add_vault_item(vault_id, "large.bin", payload))
    items = run(keymaster.list_vault_items(vault_id))
    assert "data" not in items["large.bin"]
    assert run(keymaster.get_vault_item(vault_id, "large.bin")) == payload

    gatekeeper.text_blobs.clear()
    with pytest.raises(KeymasterError, match="Failed to retrieve data for item 'large.bin'"):
        run(keymaster.get_vault_item(vault_id, "large.bin"))


def test_non_member_cannot_read_vault_item():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Alice"))
    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())
    run(keymaster.add_vault_item(vault_id, "doc.txt", b"hello"))
    run(keymaster.set_current_id("Alice"))

    with pytest.raises(KeymasterError, match="No access to vault"):
        run(keymaster.get_vault_item(vault_id, "doc.txt"))


def test_owner_required_for_vault_mutations():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())
    run(keymaster.create_id("Alice"))

    with pytest.raises(KeymasterError, match="Only vault owner can modify the vault"):
        run(keymaster.add_vault_item(vault_id, "doc.txt", b"hello"))

    with pytest.raises(KeymasterError, match="Only vault owner can modify the vault"):
        run(keymaster.add_vault_member(vault_id, "did:test:0001"))


def test_vault_item_name_must_be_non_empty():
    testbed = make_testbed()
    keymaster = testbed.keymaster

    run(keymaster.create_id("Bob"))
    vault_id = run(keymaster.create_vault())

    with pytest.raises(KeymasterError, match="name must be a non-empty string"):
        run(keymaster.add_vault_item(vault_id, "", b"hello"))
