from __future__ import annotations

import pytest

from keymaster import KeymasterError, UnknownIDError
from keymaster.crypto import (
    generate_jwk_pair,
    hash_message,
    jwk_to_nsec,
    jwk_to_nostr,
    nsec_to_jwk,
    sign_schnorr,
    verify_schnorr,
)

from .helpers import run


def test_nostr_crypto_helpers_round_trip_and_signing():
    keypair = generate_jwk_pair()

    nostr = jwk_to_nostr(keypair["publicJwk"])
    nsec = jwk_to_nsec(keypair["privateJwk"])
    decoded = nsec_to_jwk(nsec)
    msg_hash = hash_message("test message")
    sig = sign_schnorr(msg_hash, keypair["privateJwk"])

    assert nostr["npub"].startswith("npub1")
    assert jwk_to_nostr(decoded["publicJwk"]) == nostr
    assert nsec.startswith("nsec1")
    assert verify_schnorr(msg_hash, sig, nostr["pubkey"]) is True


def test_add_and_remove_nostr_updates_wallet_and_did_document(testbed):
    did = run(testbed.keymaster.create_id("Bob"))

    nostr = run(testbed.keymaster.add_nostr())

    assert nostr["npub"].startswith("npub1")
    assert len(nostr["pubkey"]) == 64
    assert run(testbed.keymaster.resolve_did(did))["didDocumentData"]["nostr"] == nostr
    assert run(testbed.keymaster.load_wallet())["ids"]["Bob"]["nostr"]["nsec"].startswith("nsec1")
    assert run(testbed.keymaster.export_nsec()).startswith("nsec1")

    assert run(testbed.keymaster.remove_nostr()) is True
    assert "nostr" not in run(testbed.keymaster.resolve_did(did))["didDocumentData"]
    assert "nostr" not in run(testbed.keymaster.load_wallet())["ids"]["Bob"]


def test_add_nostr_supports_named_ids_and_produces_distinct_keys(testbed):
    run(testbed.keymaster.create_id("Alice"))
    run(testbed.keymaster.create_id("Bob"))

    alice_nostr = run(testbed.keymaster.add_nostr("Alice"))
    bob_nostr = run(testbed.keymaster.add_nostr())

    assert alice_nostr["pubkey"] != bob_nostr["pubkey"]
    assert run(testbed.keymaster.export_nsec("Alice")).startswith("nsec1")
    assert run(testbed.keymaster.resolve_did("Alice"))["didDocumentData"]["nostr"] == alice_nostr


def test_add_nostr_requires_existing_identity(testbed):
    with pytest.raises(KeymasterError, match="No current ID"):
        run(testbed.keymaster.add_nostr())

    run(testbed.keymaster.create_id("Bob"))
    with pytest.raises(UnknownIDError, match="Unknown ID"):
        run(testbed.keymaster.add_nostr("Unknown"))


def test_import_nostr_stores_nsec_and_signs_with_imported_key(testbed):
    run(testbed.keymaster.create_id("Bob"))
    imported_keypair = generate_jwk_pair()
    imported_nsec = jwk_to_nsec(imported_keypair["privateJwk"])
    imported_nostr = jwk_to_nostr(imported_keypair["publicJwk"])

    nostr = run(testbed.keymaster.import_nostr(imported_nsec))
    signed = run(
        testbed.keymaster.sign_nostr_event(
            {
                "created_at": 1234567890,
                "kind": 1,
                "tags": [["p", "abc123"]],
                "content": "NIP-01 test",
            }
        )
    )

    assert nostr == imported_nostr
    assert run(testbed.keymaster.export_nsec()) == imported_nsec
    assert signed["pubkey"] == imported_nostr["pubkey"]
    assert verify_schnorr(signed["id"], signed["sig"], signed["pubkey"]) is True
    assert signed["id"] == hash_message('[0,"%s",1234567890,1,[["p","abc123"]],"NIP-01 test"]' % imported_nostr["pubkey"])


def test_sign_nostr_event_preserves_fields_and_matches_added_pubkey(testbed):
    run(testbed.keymaster.create_id("Bob"))
    nostr = run(testbed.keymaster.add_nostr())
    event = {
        "created_at": 1700000000,
        "kind": 0,
        "tags": [["e", "abc"], ["p", "def"]],
        "content": '{"name":"Bob"}',
    }

    signed = run(testbed.keymaster.sign_nostr_event(event))

    assert signed["pubkey"] == nostr["pubkey"]
    assert signed["created_at"] == event["created_at"]
    assert signed["kind"] == event["kind"]
    assert signed["tags"] == event["tags"]
    assert signed["content"] == event["content"]


def test_import_nostr_rejects_invalid_nsec(testbed):
    run(testbed.keymaster.create_id("Bob"))

    with pytest.raises(KeymasterError, match="Invalid parameter: nsec"):
        run(testbed.keymaster.import_nostr("not-an-nsec"))
