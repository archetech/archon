from __future__ import annotations

import pytest

from keymaster import Keymaster, KeymasterError
from keymaster.crypto import encrypt_with_passphrase

from .helpers import make_testbed, run


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


def test_load_wallet_upgrades_legacy_names_and_v1_version(testbed):
    legacy_wallet = {
        "version": 1,
        "seed": {"mnemonicEnc": encrypt_with_passphrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about", "passphrase")},
        "counter": 0,
        "ids": {},
        "names": {"bob": "did:cid:bagaaieraexample"},
    }

    assert testbed.wallet_store.save_wallet(legacy_wallet, overwrite=True) is True
    loaded = run(testbed.keymaster.load_wallet())

    assert loaded["version"] == 2
    assert "names" not in loaded
    assert loaded["aliases"] == {"bob": "did:cid:bagaaieraexample"}


def test_load_wallet_rejects_unsupported_legacy_payload(testbed):
    corrupt_wallet = {"version": 1, "seed": {}, "ids": {}}

    assert testbed.wallet_store.save_wallet(corrupt_wallet, overwrite=True) is True
    with pytest.raises(KeymasterError, match="Unsupported wallet version"):
        run(testbed.keymaster.load_wallet())


def test_save_wallet_respects_overwrite_flag(testbed):
    wallet = run(testbed.keymaster.load_wallet())
    wallet["counter"] = 1
    assert run(testbed.keymaster.save_wallet(wallet)) is True

    replacement = dict(wallet)
    replacement["counter"] = 2
    assert run(testbed.keymaster.save_wallet(replacement, overwrite=False)) is False
    assert run(testbed.keymaster.load_wallet())["counter"] == 1


def test_save_wallet_rejects_unsupported_version(testbed):
    with pytest.raises(KeymasterError, match="Unsupported wallet version"):
        run(testbed.keymaster.save_wallet({"version": 0, "seed": {"mnemonicEnc": {}}, "ids": {}}))


def test_new_wallet_rejects_invalid_mnemonic(testbed):
    with pytest.raises(KeymasterError, match="Invalid parameter: mnemonic"):
        run(testbed.keymaster.new_wallet("not a valid mnemonic", overwrite=True))


def test_new_wallet_does_not_overwrite_by_default(testbed):
    run(testbed.keymaster.load_wallet())

    with pytest.raises(KeymasterError, match="save wallet failed"):
        run(testbed.keymaster.new_wallet())


def test_new_wallet_accepts_explicit_mnemonic(testbed):
    mnemonic = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    run(testbed.keymaster.new_wallet(mnemonic, overwrite=True))
    assert run(testbed.keymaster.decrypt_mnemonic()) == mnemonic


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


def test_update_seed_bank_requires_did(testbed):
    with pytest.raises(KeymasterError, match="Invalid parameter: seed bank missing DID"):
        run(testbed.keymaster.update_seed_bank({}))


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


def test_change_passphrase_rejects_old_passphrase_after_rotation(testbed):
    run(testbed.keymaster.create_id("Bob"))
    run(testbed.keymaster.change_passphrase("new-passphrase"))

    km2 = Keymaster(
        gatekeeper=testbed.gatekeeper,
        wallet_store=testbed.wallet_store,
        passphrase="passphrase",
    )
    with pytest.raises(KeymasterError, match="Incorrect passphrase"):
        run(km2.load_wallet())


def test_change_passphrase_rejects_empty_passphrase(testbed):
    run(testbed.keymaster.load_wallet())

    with pytest.raises(KeymasterError, match="Invalid parameter: newPassphrase"):
        run(testbed.keymaster.change_passphrase(""))


def test_export_encrypted_wallet_returns_ciphertext_shape(testbed):
    exported = run(testbed.keymaster.export_encrypted_wallet())

    assert exported["version"] == 2
    assert "enc" in exported
    assert "mnemonicEnc" in exported["seed"]


def test_recover_wallet_restores_backup_and_falls_back_cleanly(testbed):
    run(testbed.keymaster.create_id("Bob"))
    original_wallet = run(testbed.keymaster.load_wallet())
    mnemonic = run(testbed.keymaster.decrypt_mnemonic())
    backup_did = run(testbed.keymaster.backup_wallet())

    run(testbed.keymaster.new_wallet(mnemonic, overwrite=True))
    recovered = run(testbed.keymaster.recover_wallet())
    recovered_by_did = run(testbed.keymaster.recover_wallet(backup_did))

    assert recovered["ids"] == original_wallet["ids"]
    assert recovered_by_did["ids"] == original_wallet["ids"]

    agent_did = run(testbed.keymaster.create_id("Alice"))
    empty_wallet = run(testbed.keymaster.new_wallet(mnemonic, overwrite=True))
    assert run(testbed.keymaster.recover_wallet(agent_did)) == empty_wallet

    fresh_testbed = make_testbed()
    empty_unbacked = run(fresh_testbed.keymaster.new_wallet(mnemonic, overwrite=True))
    assert run(fresh_testbed.keymaster.recover_wallet()) == empty_unbacked


def test_check_and_fix_wallet_count_owned_and_held_entries(testbed):
    run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.add_to_owned("did:cid:mock1"))
    run(testbed.keymaster.add_to_held("did:cid:mock2"))

    check = run(testbed.keymaster.check_wallet())
    fixed = run(testbed.keymaster.fix_wallet())

    assert check == {"checked": 3, "invalid": 2, "deleted": 0}
    assert fixed == {"idsRemoved": 0, "ownedRemoved": 1, "heldRemoved": 1, "aliasesRemoved": 0}
