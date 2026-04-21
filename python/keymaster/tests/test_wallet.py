from __future__ import annotations

import pytest

from keymaster import Keymaster, KeymasterError

from .helpers import run


def test_load_wallet_creates_new_wallet(testbed):
    wallet = run(testbed.keymaster.load_wallet())

    assert wallet["version"] == 2
    assert wallet["counter"] == 0
    assert wallet["ids"] == {}
    assert "mnemonicEnc" in wallet["seed"]


def test_load_wallet_returns_cached_wallet(testbed):
    wallet1 = run(testbed.keymaster.load_wallet())
    wallet2 = run(testbed.keymaster.load_wallet())

    assert wallet1 is wallet2


def test_save_wallet_respects_overwrite_flag(testbed):
    wallet = run(testbed.keymaster.load_wallet())
    wallet["counter"] = 1
    assert run(testbed.keymaster.save_wallet(wallet)) is True

    replacement = dict(wallet)
    replacement["counter"] = 2
    assert run(testbed.keymaster.save_wallet(replacement, overwrite=False)) is False
    assert run(testbed.keymaster.load_wallet())["counter"] == 1


def test_new_wallet_rejects_invalid_mnemonic(testbed):
    with pytest.raises(KeymasterError, match="Invalid parameter: mnemonic"):
        run(testbed.keymaster.new_wallet("not a valid mnemonic", overwrite=True))


def test_check_and_fix_wallet_remove_deactivated_items(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    note = run(testbed.keymaster.create_asset({"kind": "note"}))
    run(testbed.keymaster.add_alias("favorite", note))

    check_before = run(testbed.keymaster.check_wallet())
    assert check_before["deleted"] == 0

    run(testbed.keymaster.revoke_did(note))

    check_after = run(testbed.keymaster.check_wallet())
    assert check_after["deleted"] >= 1

    fixed = run(testbed.keymaster.fix_wallet())
    assert fixed["aliasesRemoved"] == 1

    wallet = run(testbed.keymaster.load_wallet())
    assert wallet["aliases"] == {}
    assert alice in [info["did"] for info in wallet["ids"].values()]


def test_backup_wallet_updates_seed_bank_reference(testbed):
    run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.add_alias("home", "did:test:9999"))

    backup_did = run(testbed.keymaster.backup_wallet())
    seed_bank = run(testbed.keymaster.resolve_seed_bank())

    assert (seed_bank.get("didDocumentData") or {}).get("wallet") == backup_did


def test_change_passphrase_reencrypts_wallet_and_preserves_mnemonic(testbed):
    did = run(testbed.keymaster.create_id("Bob"))
    mnemonic_before = run(testbed.keymaster.decrypt_mnemonic())

    assert run(testbed.keymaster.change_passphrase("new-passphrase")) is True

    wallet_after = run(testbed.keymaster.load_wallet())
    assert wallet_after["ids"]["Bob"]["did"] == did
    assert run(testbed.keymaster.decrypt_mnemonic()) == mnemonic_before


def test_change_passphrase_allows_reload_with_new_passphrase(testbed):
    run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.change_passphrase("new-passphrase"))

    km2 = Keymaster(
        gatekeeper=testbed.gatekeeper,
        wallet_store=testbed.wallet_store,
        passphrase="new-passphrase",
    )
    loaded = run(km2.load_wallet())
    assert "Bob" in loaded["ids"]


def test_change_passphrase_rejects_empty_passphrase(testbed):
    run(testbed.keymaster.load_wallet())

    with pytest.raises(KeymasterError, match="Invalid parameter: newPassphrase"):
        run(testbed.keymaster.change_passphrase(""))