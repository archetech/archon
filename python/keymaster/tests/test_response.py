from __future__ import annotations

from copy import deepcopy
import json

import pytest

from keymaster import KeymasterError, UnknownIDError
from keymaster.crypto import encrypt_message, hash_message

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
    assert revoked["vps"] == []


def test_verify_response_rejects_non_response_asset(testbed):
    alice = run(testbed.keymaster.create_id("Alice"))
    did = run(testbed.keymaster.encrypt_json({"plain": True}, alice, {"registry": "local"}))

    with pytest.raises(KeymasterError, match="responseDID not a valid challenge response"):
        run(testbed.keymaster.verify_response(did))


T0 = "2026-09-01T00:"


def _at(minute: int) -> str:
    return f"{T0}{minute:02d}:00.000Z"


def _historical_response(testbed):
    # Minute 0: Alice issues a credential to Carol. Minute 10: Victor
    # challenges and Carol responds.
    km = testbed.keymaster
    testbed.gatekeeper.historical = True
    testbed.gatekeeper.now = _at(0)
    alice = run(km.create_id("Alice"))
    carol = run(km.create_id("Carol"))
    run(km.create_id("Victor"))

    run(km.set_current_id("Alice"))
    schema_did = run(km.create_schema(MOCK_SCHEMA))
    bound = run(km.bind_credential(carol, {"schema": schema_did}))
    vc_did = run(km.issue_credential(bound))
    run(km.set_current_id("Carol"))
    assert run(km.accept_credential(vc_did)) is True

    testbed.gatekeeper.now = _at(10)
    run(km.set_current_id("Victor"))
    challenge_did = run(km.create_challenge({"credentials": [{"schema": schema_did, "issuers": [alice]}]}))
    run(km.set_current_id("Carol"))
    response_did = run(km.create_response(challenge_did))
    return {"alice": alice, "carol": carol, "vc": vc_did, "challenge": challenge_did, "response": response_did}


def _verify_at(testbed, response_did, minute=None, version_sequence=None):
    run(testbed.keymaster.set_current_id("Victor"))
    options = {} if minute is None else {"versionTime": _at(minute)}
    if version_sequence is not None:
        options["versionSequence"] = version_sequence
    return run(testbed.keymaster.verify_response(response_did, options))


def test_verify_response_historical_revocation(testbed):
    ctx = _historical_response(testbed)

    testbed.gatekeeper.now = _at(20)
    run(testbed.keymaster.set_current_id("Alice"))
    run(testbed.keymaster.revoke_credential(ctx["vc"]))

    assert _verify_at(testbed, ctx["response"])["match"] is False

    before = _verify_at(testbed, ctx["response"], 15)
    assert before["match"] is True
    assert [vp["credentialSubject"]["id"] for vp in before["vps"]] == [ctx["carol"]]
    assert before["responder"] == ctx["carol"]

    assert _verify_at(testbed, ctx["response"], 25)["match"] is False


def test_verify_response_historical_challenge(testbed):
    ctx = _historical_response(testbed)

    testbed.gatekeeper.now = _at(20)
    run(testbed.keymaster.set_current_id("Alice"))
    extra = run(testbed.keymaster.create_schema(MOCK_SCHEMA))
    run(testbed.keymaster.set_current_id("Victor"))
    original = run(testbed.keymaster.resolve_asset(ctx["challenge"]))["challenge"]
    run(testbed.keymaster.merge_data(ctx["challenge"], {
        "challenge": {"credentials": [*original["credentials"], {"schema": extra, "issuers": [ctx["alice"]]}]},
    }))

    assert _verify_at(testbed, ctx["response"])["match"] is False
    assert _verify_at(testbed, ctx["response"], 15)["match"] is True


def test_verify_response_rejects_a_challenge_revoked_by_the_cutoff(testbed):
    ctx = _historical_response(testbed)

    testbed.gatekeeper.now = _at(20)
    run(testbed.keymaster.set_current_id("Victor"))
    run(testbed.keymaster.revoke_did(ctx["challenge"]))

    with pytest.raises(KeymasterError, match="Invalid parameter: challengeDID"):
        _verify_at(testbed, ctx["response"])
    assert _verify_at(testbed, ctx["response"], 15)["match"] is True
    with pytest.raises(KeymasterError, match="Invalid parameter: challengeDID"):
        _verify_at(testbed, ctx["response"], 25)


def test_verify_response_reports_another_resolution_error_as_itself(testbed):
    ctx = _historical_response(testbed)
    resolve = testbed.gatekeeper.resolve_did

    # Only a version Gatekeeper does not find is "not found".
    async def refuse_sequences(did, options=None):
        if options and options.get("versionSequence") is not None:
            return {"didResolutionMetadata": {"error": "invalidOptions"}, "didDocumentMetadata": {}}
        return await resolve(did, options)

    testbed.gatekeeper.resolve_did = refuse_sequences
    try:
        with pytest.raises(KeymasterError, match="^invalidOptions$"):
            _verify_at(testbed, ctx["response"], 30, 1)
    finally:
        testbed.gatekeeper.resolve_did = resolve


def test_verify_response_historical_response_version(testbed):
    ctx = _historical_response(testbed)
    km = testbed.keymaster

    testbed.gatekeeper.now = _at(20)
    run(km.set_current_id("Victor"))
    empty = run(km.create_challenge({"credentials": []}))
    run(km.set_current_id("Carol"))
    other = run(km.create_response(empty))
    data = run(km.resolve_did(other))["didDocumentData"]
    run(km.update_did(ctx["response"], {"didDocumentData": data}))

    assert _verify_at(testbed, ctx["response"])["challenge"] == empty
    assert _verify_at(testbed, ctx["response"], 15)["challenge"] == ctx["challenge"]
    assert _verify_at(testbed, ctx["response"], 25)["challenge"] == empty

    first = _verify_at(testbed, ctx["response"], 30, 1)
    assert first["challenge"] == ctx["challenge"]
    assert first["match"] is True
    assert _verify_at(testbed, ctx["response"], 30, 2)["challenge"] == empty

    with pytest.raises(KeymasterError, match="Invalid parameter: responseDID version 2 is later than versionTime"):
        _verify_at(testbed, ctx["response"], 15, 2)
    with pytest.raises(KeymasterError, match="Invalid parameter: responseDID version 3 not found"):
        _verify_at(testbed, ctx["response"], 30, 3)


def test_verify_response_historical_refuses_cutoffs_before_creation(testbed):
    ctx = _historical_response(testbed)
    km = testbed.keymaster

    with pytest.raises(KeymasterError, match="Invalid parameter: responseDID did not exist at versionTime"):
        _verify_at(testbed, ctx["response"], 5)

    # A response whose challenge was created after the cutoff.
    testbed.gatekeeper.now = _at(20)
    run(km.set_current_id("Victor"))
    later = run(km.create_challenge())
    victor = run(km.fetch_id_info())["did"]
    testbed.gatekeeper.now = _at(10)
    run(km.set_current_id("Carol"))
    forged = run(km.encrypt_json({"response": {"challenge": later, "credentials": []}}, victor))

    with pytest.raises(KeymasterError, match="Invalid parameter: challenge did not exist at versionTime"):
        _verify_at(testbed, forged, 15)


def test_verify_response_rejects_malformed_selectors(testbed):
    ctx = _historical_response(testbed)
    km = testbed.keymaster
    run(km.set_current_id("Victor"))

    with pytest.raises(KeymasterError, match="Invalid parameter: versionSequence requires versionTime"):
        run(km.verify_response(ctx["response"], {"versionSequence": 1}))
    malformed = ["yesterday", "0", "01/01/2026", "2026/09/01", "2026-09-01", "2026-09-01T00:15:00",
                 "2026-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-09-01T24:00:00Z", "2026-09-01T00:00:60Z",
                 "2026-09-01T00:15:00+24:00", "0000-01-01T00:00:00Z"]
    for version_time in malformed:
        with pytest.raises(KeymasterError, match="Invalid parameter: versionTime"):
            run(km.verify_response(ctx["response"], {"versionTime": version_time}))
    for version_time in ["2026-09-01t00:15:00.123456789z", "2026-09-01T02:15:00+02:00"]:
        assert run(km.verify_response(ctx["response"], {"versionTime": version_time}))["match"] is True
    with pytest.raises(KeymasterError, match="Invalid parameter: versionSequence"):
        run(km.verify_response(ctx["response"], {"versionTime": _at(15), "versionSequence": 0}))


def test_create_response_binds_each_presentation_to_its_credential(testbed):
    ctx = _historical_response(testbed)
    km = testbed.keymaster

    run(km.set_current_id("Victor"))
    response = run(km.decrypt_json(ctx["response"]))["response"]
    [entry] = response["credentials"]
    assert entry["vc"] == ctx["vc"]
    assert isinstance(entry["vp"], str) and entry["vp"] != ctx["vc"]

    vc_hash = run(km.resolve_asset(entry["vc"]))["encrypted"]["cipher_hash"]
    vp_hash = run(km.resolve_asset(entry["vp"]))["encrypted"]["cipher_hash"]
    assert vc_hash and vc_hash == vp_hash
    assert run(km.decrypt_json(entry["vp"]))["credentialSubject"]["id"] == ctx["carol"]


def test_verify_response_historical_credential_update(testbed):
    ctx = _historical_response(testbed)
    km = testbed.keymaster

    testbed.gatekeeper.now = _at(20)
    run(km.set_current_id("Alice"))
    updated = run(km.get_credential(ctx["vc"]))
    updated["credentialSubject"]["email"] = "updated@email.com"
    assert run(km.update_credential(ctx["vc"], updated)) is True

    # The presentation no longer matches the updated credential.
    assert _verify_at(testbed, ctx["response"])["match"] is False
    assert _verify_at(testbed, ctx["response"], 15)["match"] is True
    assert _verify_at(testbed, ctx["response"], 25)["match"] is False


def test_verify_response_historical_presentation(testbed):
    ctx = _historical_response(testbed)
    km = testbed.keymaster

    run(km.set_current_id("Victor"))
    [entry] = run(km.decrypt_json(ctx["response"]))["response"]["credentials"]

    testbed.gatekeeper.now = _at(20)
    run(km.set_current_id("Carol"))
    assert run(km.revoke_did(entry["vp"])) is True

    assert _verify_at(testbed, ctx["response"])["match"] is False
    assert _verify_at(testbed, ctx["response"], 15)["match"] is True
    assert _verify_at(testbed, ctx["response"], 25)["match"] is False


def test_verify_response_rejects_a_credential_without_a_valid_issuer_proof(testbed):
    km = testbed.keymaster
    alice = run(km.create_id("Alice"))
    carol = run(km.create_id("Carol"))
    victor = run(km.create_id("Victor"))

    run(km.set_current_id("Alice"))
    schema_did = run(km.create_schema(MOCK_SCHEMA))
    bound = run(km.bind_credential(carol, {"schema": schema_did}))
    genuine = run(km.get_credential(run(km.issue_credential(bound))))

    # Carol claims Alice issued a credential Alice never signed. The
    # presentation's hash matches the credential DID, so only the proof check
    # can reject it.
    run(km.set_current_id("Carol"))
    forged = deepcopy(genuine)
    forged["credentialSubject"]["email"] = "forged@example.com"
    plaintext = json.dumps(forged, separators=(",", ":"))
    vc_did = run(km.encrypt_message(plaintext, carol, {"includeHash": True}))

    run(km.set_current_id("Victor"))
    challenge_did = run(km.create_challenge({"credentials": [{"schema": schema_did, "issuers": [alice]}]}))

    run(km.set_current_id("Carol"))
    vp_did = run(km.encrypt_message(plaintext, victor, {"includeHash": True}))
    response = {"challenge": challenge_did, "credentials": [{"vc": vc_did, "vp": vp_did}],
                "requested": 1, "fulfilled": 1, "match": True}
    response_did = run(km.encrypt_json({"response": response}, victor))

    run(km.set_current_id("Victor"))
    verified = run(km.verify_response(response_did))
    assert verified["match"] is False
    assert verified["vps"] == []


def test_verify_response_does_not_count_legacy_inline_credentials(testbed):
    # Before presentation DIDs, Python responses embedded the credential
    # itself. Nothing binds that copy to the credential DID, so it is not
    # counted; such responses are short-lived (validUntil defaults to an hour).
    ctx = _historical_response(testbed)
    km = testbed.keymaster

    run(km.set_current_id("Carol"))
    credential = run(km.get_credential(ctx["vc"]))
    victor = run(km.resolve_did("Victor"))["didDocument"]["id"]
    response = {"challenge": ctx["challenge"], "credentials": [{"vc": ctx["vc"], "vp": credential}],
                "requested": 1, "fulfilled": 1, "match": True}
    legacy = run(km.encrypt_json({"response": response}, victor))

    verified = _verify_at(testbed, legacy)
    assert verified["match"] is False
    assert verified["vps"] == []


# Credential binding: Alice issues, Carol holds, Victor verifies. Each case
# hand-builds the response Carol sends, so one check decides the outcome.

def _parties(testbed):
    km = testbed.keymaster
    alice = run(km.create_id("Alice"))
    carol = run(km.create_id("Carol"))
    victor = run(km.create_id("Victor"))
    run(km.set_current_id("Alice"))
    schema = run(km.create_schema(MOCK_SCHEMA))
    other = run(km.create_schema(MOCK_SCHEMA))
    return alice, carol, victor, schema, other


def _legacy_issue(km, credential, subject, include_hash):
    # Issued as Keymaster did before credentials carried their own DID in
    # `id` (#948), optionally without a cipher_hash as well.
    signed = run(km.add_proof(credential))
    return run(km.encrypt_json(signed, subject, {"includeHash": include_hash}))


def _present(km, victor, challenge, pairs):
    run(km.set_current_id("Carol"))
    credentials = []
    for pair in pairs:
        vp = run(km.encrypt_message(pair["plaintext"], victor, {"includeHash": pair.get("include_hash", True)}))
        credentials.append({"vc": pair["vc"], "vp": vp})
    response = {"challenge": challenge, "credentials": credentials,
                "requested": len(credentials), "fulfilled": len(credentials), "match": True}
    response_did = run(km.encrypt_json({"response": response}, victor))
    run(km.set_current_id("Victor"))
    return run(km.verify_response(response_did))


def _challenge(km, requests):
    run(km.set_current_id("Victor"))
    return run(km.create_challenge({"credentials": requests}))


def test_verify_response_requires_a_proof_by_the_issuer(testbed):
    km = testbed.keymaster
    alice, carol, victor, schema, _ = _parties(testbed)
    bound = run(km.bind_credential(carol, {"schema": schema}))

    # Carol signs a credential naming Alice as issuer, pointing at its own
    # asset so the id check passes.
    run(km.set_current_id("Carol"))
    vc = run(km.encrypt_message("{}", carol, {"includeHash": True}))
    forged = run(km.add_proof({**bound, "issuer": alice, "id": vc}))
    plaintext = json.dumps(forged, separators=(",", ":"))
    carol_public = run(km.fetch_key_pair())["publicJwk"]
    run(km.update_did(vc, {"didDocumentData": {"encrypted": {
        "cipher_hash": hash_message(plaintext), "cipher_sender": None,
        "cipher_receiver": encrypt_message(carol_public, plaintext),
    }}}))

    challenge = _challenge(km, [{"schema": schema, "issuers": [alice]}])
    verified = _present(km, victor, challenge, [{"vc": vc, "plaintext": plaintext}])
    assert verified["vps"] == []
    assert verified["match"] is False


def test_verify_response_rejects_a_revoked_credential_copied_to_a_new_asset(testbed):
    km = testbed.keymaster
    alice, carol, victor, schema, _ = _parties(testbed)
    original = run(km.issue_credential(run(km.bind_credential(carol, {"schema": schema}))))
    run(km.set_current_id("Carol"))
    plaintext = run(km.decrypt_message(original))
    copy = run(km.encrypt_message(plaintext, carol, {"includeHash": True}))
    run(km.set_current_id("Alice"))
    run(km.revoke_credential(original))

    challenge = _challenge(km, [{"schema": schema, "issuers": [alice]}])
    assert _present(km, victor, challenge, [{"vc": copy, "plaintext": plaintext}])["vps"] == []


def test_verify_response_binds_credentials_without_an_id_to_the_issuer_asset(testbed):
    km = testbed.keymaster
    alice, carol, victor, schema, _ = _parties(testbed)
    original = _legacy_issue(km, run(km.bind_credential(carol, {"schema": schema})), carol, True)
    run(km.set_current_id("Carol"))
    plaintext = run(km.decrypt_message(original))
    copy = run(km.encrypt_message(plaintext, carol, {"includeHash": True}))
    run(km.set_current_id("Alice"))
    run(km.revoke_did(original))

    challenge = _challenge(km, [{"schema": schema, "issuers": [alice]}])
    assert _present(km, victor, challenge, [{"vc": copy, "plaintext": plaintext}])["vps"] == []

    # The issuer's own asset still verifies without an id.
    run(km.set_current_id("Alice"))
    kept = _legacy_issue(km, run(km.bind_credential(carol, {"schema": schema})), carol, True)
    run(km.set_current_id("Carol"))
    kept_plaintext = run(km.decrypt_message(kept))
    assert _present(km, victor, challenge, [{"vc": kept, "plaintext": kept_plaintext}])["match"] is True


def test_verify_response_requires_a_schema(testbed):
    km = testbed.keymaster
    alice, carol, victor, schema, _ = _parties(testbed)
    bound = run(km.bind_credential(carol, {"schema": schema}))
    bound.pop("credentialSchema", None)
    vc = run(km.issue_credential(bound))
    run(km.set_current_id("Carol"))
    plaintext = run(km.decrypt_message(vc))

    challenge = _challenge(km, [{"schema": schema, "issuers": [alice]}])
    verified = _present(km, victor, challenge, [{"vc": vc, "plaintext": plaintext}])
    assert verified["vps"] == []
    assert verified["match"] is False


def test_verify_response_satisfies_each_request_with_one_distinct_credential(testbed):
    km = testbed.keymaster
    alice, carol, victor, schema, other = _parties(testbed)
    first = run(km.issue_credential(run(km.bind_credential(carol, {"schema": schema}))))
    second = run(km.issue_credential(run(km.bind_credential(carol, {"schema": schema}))))
    run(km.set_current_id("Carol"))
    pair_1 = {"vc": first, "plaintext": run(km.decrypt_message(first))}
    pair_2 = {"vc": second, "plaintext": run(km.decrypt_message(second))}

    # Two credentials of one schema cannot stand in for a second schema.
    mixed = _challenge(km, [{"schema": schema, "issuers": [alice]}, {"schema": other, "issuers": [alice]}])
    partial = _present(km, victor, mixed, [pair_1, pair_2])
    assert len(partial["vps"]) == 1
    assert partial["match"] is False

    # Two requests for one schema need two credentials, not one twice.
    twice = _challenge(km, [{"schema": schema, "issuers": [alice]}, {"schema": schema, "issuers": [alice]}])
    repeated = _present(km, victor, twice, [pair_1, pair_1])
    assert len(repeated["vps"]) == 1
    assert repeated["match"] is False

    distinct = _present(km, victor, twice, [pair_1, pair_2])
    assert len(distinct["vps"]) == 2
    assert distinct["match"] is True


def test_verify_response_requires_hashes_on_both_envelopes(testbed):
    km = testbed.keymaster
    alice, carol, victor, schema, _ = _parties(testbed)
    bound = run(km.bind_credential(carol, {"schema": schema}))
    vc = _legacy_issue(km, bound, carol, False)
    run(km.set_current_id("Carol"))
    original = run(km.decrypt_message(vc))

    # Alice later replaces the content; the unhashed envelopes cannot show
    # that the presented copy is the old one.
    run(km.set_current_id("Alice"))
    replaced = json.dumps(run(km.add_proof(
        {**bound, "credentialSubject": {**bound["credentialSubject"], "email": "new@example.com"}}
    )), separators=(",", ":"))
    alice_public = run(km.fetch_key_pair())["publicJwk"]
    carol_public = run(km.get_public_key_jwk(run(km.resolve_did(carol))))
    run(km.update_did(vc, {"didDocumentData": {"encrypted": {
        "cipher_hash": None,
        "cipher_sender": encrypt_message(alice_public, replaced),
        "cipher_receiver": encrypt_message(carol_public, replaced),
    }}}))

    challenge = _challenge(km, [{"schema": schema, "issuers": [alice]}])
    verified = _present(km, victor, challenge, [{"vc": vc, "plaintext": original, "include_hash": False}])
    assert verified["vps"] == []


# Credential assignment: Alice and Bob issue, Carol holds, Victor challenges.

def _assignment_setup(testbed):
    km = testbed.keymaster
    alice = run(km.create_id("Alice"))
    bob = run(km.create_id("Bob"))
    carol = run(km.create_id("Carol"))
    run(km.create_id("Victor"))
    run(km.set_current_id("Alice"))
    schema = run(km.create_schema(MOCK_SCHEMA))

    def issue(issuer):
        run(km.set_current_id(issuer))
        vc = run(km.issue_credential(run(km.bind_credential(carol, {"schema": schema}))))
        run(km.set_current_id("Carol"))
        assert run(km.accept_credential(vc)) is True
        return vc

    return alice, bob, schema, issue


def _respond_to(km, requests):
    run(km.set_current_id("Victor"))
    challenge = run(km.create_challenge({"credentials": requests}))
    run(km.set_current_id("Carol"))
    response = run(km.create_response(challenge))
    run(km.set_current_id("Victor"))
    return run(km.verify_response(response))


def test_create_response_presents_distinct_credentials_for_repeated_requests(testbed):
    km = testbed.keymaster
    alice, _, schema, issue = _assignment_setup(testbed)
    issue("Alice")
    issue("Alice")

    verified = _respond_to(km, [{"schema": schema, "issuers": [alice]}, {"schema": schema, "issuers": [alice]}])
    assert verified["fulfilled"] == 2
    assert len(verified["vps"]) == 2
    assert verified["match"] is True


def test_create_response_assigns_credentials_so_every_satisfiable_request_is_met(testbed):
    km = testbed.keymaster
    alice, bob, schema, issue = _assignment_setup(testbed)
    # Held in this order, a first-fit choice gives Alice's credential to the
    # broad request and leaves the Alice-only request unmet.
    issue("Alice")
    issue("Bob")

    verified = _respond_to(km, [{"schema": schema, "issuers": [alice, bob]}, {"schema": schema, "issuers": [alice]}])
    assert verified["fulfilled"] == 2
    assert verified["match"] is True


def test_verify_response_finds_an_assignment_the_presentation_order_hides(testbed):
    km = testbed.keymaster
    alice, bob, schema, issue = _assignment_setup(testbed)
    from_alice = issue("Alice")
    from_bob = issue("Bob")
    victor = run(km.resolve_did("Victor"))["didDocument"]["id"]

    run(km.set_current_id("Victor"))
    challenge = run(km.create_challenge({"credentials": [
        {"schema": schema, "issuers": [alice, bob]}, {"schema": schema, "issuers": [alice]},
    ]}))

    # Alice's credential first: a first-fit verifier spends it on the broad
    # request.
    run(km.set_current_id("Carol"))
    credentials = []
    for vc in [from_alice, from_bob]:
        vp = run(km.encrypt_message(run(km.decrypt_message(vc)), victor, {"includeHash": True}))
        credentials.append({"vc": vc, "vp": vp})
    response = run(km.encrypt_json(
        {"response": {"challenge": challenge, "credentials": credentials, "requested": 2, "fulfilled": 2, "match": True}},
        victor,
    ))

    run(km.set_current_id("Victor"))
    verified = run(km.verify_response(response))
    assert len(verified["vps"]) == 2
    assert verified["match"] is True
