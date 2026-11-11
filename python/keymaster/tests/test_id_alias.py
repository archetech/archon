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


def test_fetch_id_info_finds_name_starting_with_did(testbed):
    did = run(testbed.keymaster.create_id("didier"))
    run(testbed.keymaster.create_id("Bob"))

    assert run(testbed.keymaster.fetch_id_info("didier"))["did"] == did
    assert run(testbed.keymaster.fetch_id_info(did))["did"] == did


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

# Paying a 402 from a paywalled Drawbridge mutates the wallet while create_id or
# rotate_keys waits on Gatekeeper (#1596), so neither may hold the wallet lock
# across those calls.

import asyncio

DEADLINE_SECONDS = 2


def _hook_writes(testbed, during):
    """Make Gatekeeper's create_did and update_did first run ``during``, as a 402 payment would."""
    gatekeeper = testbed.gatekeeper
    create_did, update_did = gatekeeper.create_did, gatekeeper.update_did

    async def hooked_create(operation):
        await during()
        return await create_did(operation)

    async def hooked_update(operation):
        await during()
        return await update_did(operation)

    gatekeeper.create_did = hooked_create
    gatekeeper.update_did = hooked_update


def test_create_id_waits_on_gatekeeper_outside_the_wallet_lock(testbed):
    km = testbed.keymaster
    paid = []

    async def pay():
        if not paid:
            paid.append(True)
            await km.add_alias("paid-for", "did:cid:bagaaieraexample")

    _hook_writes(testbed, pay)
    did = run(asyncio.wait_for(km.create_id("Bob"), DEADLINE_SECONDS))

    assert run(km.load_wallet())["ids"]["Bob"]["did"] == did
    assert run(km.get_alias("paid-for")) == "did:cid:bagaaieraexample"


def test_rotate_keys_waits_on_gatekeeper_outside_the_wallet_lock(testbed):
    km = testbed.keymaster
    run(km.create_id("Bob"))
    armed = [True]

    async def pay():
        if armed:
            armed.clear()
            await km.add_alias("paid-for", "did:cid:bagaaieraexample")

    _hook_writes(testbed, pay)
    assert run(asyncio.wait_for(km.rotate_keys(), DEADLINE_SECONDS)) is True

    assert run(km.load_wallet())["ids"]["Bob"]["index"] == 1
    assert run(km.get_alias("paid-for")) == "did:cid:bagaaieraexample"


def test_rotation_is_recorded_against_the_did_if_the_id_is_renamed_meanwhile(testbed):
    km = testbed.keymaster
    run(km.create_id("Bob"))
    armed = [True]

    async def rename():
        if armed:
            armed.clear()
            await km.rename_id("Bob", "Robert")

    _hook_writes(testbed, rename)
    run(asyncio.wait_for(km.rotate_keys(), DEADLINE_SECONDS))

    assert run(km.load_wallet())["ids"]["Robert"]["index"] == 1


def test_the_used_account_is_recorded_when_the_name_is_taken_meanwhile(testbed):
    km = testbed.keymaster
    taken = []

    async def take_name():
        if not taken:
            taken.append(True)
            await km.add_alias("Bob", "did:cid:bagaaieraexample")

    _hook_writes(testbed, take_name)
    with pytest.raises(KeymasterError, match="already used"):
        run(asyncio.wait_for(km.create_id("Bob"), DEADLINE_SECONDS))
    assert run(km.load_wallet())["counter"] == 1

    # The next identity gets the next account, not the published DID's key.
    run(km.create_id("Carol"))
    assert run(km.load_wallet())["ids"]["Carol"]["account"] == 1


def test_a_did_is_not_recorded_into_a_wallet_replaced_meanwhile(testbed):
    km = testbed.keymaster
    replaced = []

    async def replace_wallet():
        if not replaced:
            replaced.append(True)
            await km.new_wallet(overwrite=True)

    _hook_writes(testbed, replace_wallet)
    with pytest.raises(KeymasterError, match="replaced"):
        run(asyncio.wait_for(km.create_id("Bob"), DEADLINE_SECONDS))
    assert "Bob" not in run(km.load_wallet())["ids"]


def test_a_did_is_recorded_when_the_passphrase_changed_meanwhile(testbed):
    km = testbed.keymaster
    changed = []

    async def change_passphrase():
        if not changed:
            changed.append(True)
            await km.change_passphrase("new passphrase")

    _hook_writes(testbed, change_passphrase)
    did = run(asyncio.wait_for(km.create_id("Bob"), DEADLINE_SECONDS))
    wallet = run(km.load_wallet())
    assert wallet["ids"]["Bob"] == {"did": did, "account": 0, "index": 0}
    assert wallet["counter"] == 1


def test_concurrent_create_ids_for_one_name_create_one_did(testbed):
    km = testbed.keymaster
    calls = []
    create_did = testbed.gatekeeper.create_did

    async def counted(operation):
        calls.append(operation)
        return await create_did(operation)

    testbed.gatekeeper.create_did = counted

    async def both():
        return await asyncio.gather(km.create_id("Bob"), km.create_id("Bob"), return_exceptions=True)

    results = run(both())

    assert sorted(isinstance(result, Exception) for result in results) == [False, True]
    assert len(calls) == 1
