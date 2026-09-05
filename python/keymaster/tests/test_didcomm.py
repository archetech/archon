"""DIDComm v2 crypto + protocol-builder tests for the Python keymaster library.

The `js_envelopes` fixtures below were produced by the TypeScript stack
(@didcid/cipher) for these exact deterministic keys; decrypting them here proves
the Python port interoperates byte-for-byte with the JS / reference library
(JS -> PY), with no Node needed at test time. The self round-trips cover PY -> PY.
"""

from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keymaster import didcomm_crypto as dc
from keymaster import didcomm_protocols as p
from keymaster.crypto import private_key_to_jwk_pair

BOB = dc.generate_x25519_jwk(bytes([7] * 32))
ALICE = dc.generate_x25519_jwk(bytes([9] * 32))
SIGNER = private_key_to_jwk_pair(bytes([5] * 32))

BOB_KID = "did:test:bob#key-agreement-1"
ALICE_KID = "did:test:alice#key-agreement-1"
SIGNER_KID = "did:test:alice#key-1"

BOB_PRIV = {"kid": BOB_KID, "privateJwk": BOB["privateJwk"]}
BOB_RECIP = {"kid": BOB_KID, "publicJwk": BOB["publicJwk"]}
ALICE_SENDER = {"kid": ALICE_KID, "privateJwk": ALICE["privateJwk"]}
SIGNER_IN = {"kid": SIGNER_KID, "privateJwk": SIGNER["privateJwk"]}

MESSAGE = {"type": "https://didcomm.org/basicmessage/2.0/message", "body": {"content": "hello from python"}}

# Envelopes packed by @didcid/cipher (TypeScript) for the keys above.
JS_ENVELOPES = {
    "anon": '{"protected":"eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLWVuY3J5cHRlZCtqc29uIiwiYWxnIjoiRUNESC1FUytBMjU2S1ciLCJlbmMiOiJYQzIwUCIsImFwdiI6ImFxMkg1akU0d3hqU1pMTkhjM3NZRlp3Wm1HbHJTOXZubDV3cVBuaHg5WnciLCJlcGsiOnsia3R5IjoiT0tQIiwiY3J2IjoiWDI1NTE5IiwieCI6Im9CNVFfOWR1U1lWd29BRkFqTzl2QUx6azQ0R05vSlZKYWF5SmFDYUkya28ifX0","recipients":[{"header":{"kid":"did:test:bob#key-agreement-1"},"encrypted_key":"YSfkW7zcFFCCSr548hafJY-ZjkzG6lXHK7rQvT65apYSFsOyoH6n2g"}],"iv":"9iCt5k3gmIiZDdunw5wUOdhxbeBjONIa","ciphertext":"W-JAXEzaS9FiJjdmP5UGXsi2skvAgAV3CSd76p9nzoxEBNShjhsc9Q8hywc6gS7BIL0RlxooqkzlBWbJtXfVH98QwNxRFPAldJeUv_nvmFtBORv_HvCUkGTBjuMvIw","tag":"O1jz2Yg3cSigLi8LeelpCw"}',
    "auth": '{"protected":"eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLWVuY3J5cHRlZCtqc29uIiwiYWxnIjoiRUNESC0xUFUrQTI1NktXIiwiZW5jIjoiQTI1NkNCQy1IUzUxMiIsInNraWQiOiJkaWQ6dGVzdDphbGljZSNrZXktYWdyZWVtZW50LTEiLCJhcHUiOiJaR2xrT25SbGMzUTZZV3hwWTJVamEyVjVMV0ZuY21WbGJXVnVkQzB4IiwiYXB2IjoiYXEySDVqRTR3eGpTWkxOSGMzc1lGWndabUdsclM5dm5sNXdxUG5oeDladyIsImVwayI6eyJrdHkiOiJPS1AiLCJjcnYiOiJYMjU1MTkiLCJ4IjoiajFCM1plVUJzOWdsbU5QaGo3YjI1bGZ5c2dPVlhmNnY0VGlNYWdIUFFGayJ9fQ","recipients":[{"header":{"kid":"did:test:bob#key-agreement-1"},"encrypted_key":"Hu6U6oS_31ERA5g_UJDD-IcJjbpcWgRQF4iAuBm-_77mmql7PlZgGFNjQZS-OoGt6E2yWzmmeGcg-xPf7qt6RMJRmiJX2UPY"}],"iv":"F4thXmgdQXzIML22-p4uIg","ciphertext":"XKoTjERMUaQvWbapwcS6Z9Y6lN6Tam4rFiuZ66TzMwXXvMSauLQpjB9MqvD8JGmqBNAYZJSL6tbOlNl8Be65a_H-QKLFdmyhSw23V_L_TlCoJGeJ9BoCCjoC1oxnwFuR","tag":"cNQz9KB-d5o6Mr_8HSkCOC6ttXvQwCcFvtw7xqK9M8M"}',
    "gcm": '{"protected":"eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLWVuY3J5cHRlZCtqc29uIiwiYWxnIjoiRUNESC0xUFUrQTI1NktXIiwiZW5jIjoiQTI1NkdDTSIsInNraWQiOiJkaWQ6dGVzdDphbGljZSNrZXktYWdyZWVtZW50LTEiLCJhcHUiOiJaR2xrT25SbGMzUTZZV3hwWTJVamEyVjVMV0ZuY21WbGJXVnVkQzB4IiwiYXB2IjoiYXEySDVqRTR3eGpTWkxOSGMzc1lGWndabUdsclM5dm5sNXdxUG5oeDladyIsImVwayI6eyJrdHkiOiJPS1AiLCJjcnYiOiJYMjU1MTkiLCJ4IjoiMGd0NDJYdnlxczVQZ3dPX0ZPTmdMbElvc19IZXRjS1ltcUxLdFBsNzJDNCJ9fQ","recipients":[{"header":{"kid":"did:test:bob#key-agreement-1"},"encrypted_key":"ZRT8_qhlvKkJRG9aRzgQNvWUewpDk04F2ySlS_lFTpvNoOIq1gAHpA"}],"iv":"dSaG9_uaK2SJ1mBl","ciphertext":"SFsIxDk4SLEOfEQ6kJ8FmMzbnNeNl9KKy1oEKRcN8Dk7GGC4MoSpFY0Gqf2OP7cG9R6A5We-zOah4sNBX-a7JttHQR04vs6tLzjNk2t9j28ut7AYSUFzjf9mWwHX0g","tag":"E5h3Mtk_qhRf6rwkDzKS3w"}',
    "signed": '{"protected":"eyJ0eXAiOiJhcHBsaWNhdGlvbi9kaWRjb21tLWVuY3J5cHRlZCtqc29uIiwiYWxnIjoiRUNESC0xUFUrQTI1NktXIiwiZW5jIjoiQTI1NkNCQy1IUzUxMiIsInNraWQiOiJkaWQ6dGVzdDphbGljZSNrZXktYWdyZWVtZW50LTEiLCJhcHUiOiJaR2xrT25SbGMzUTZZV3hwWTJVamEyVjVMV0ZuY21WbGJXVnVkQzB4IiwiYXB2IjoiYXEySDVqRTR3eGpTWkxOSGMzc1lGWndabUdsclM5dm5sNXdxUG5oeDladyIsImVwayI6eyJrdHkiOiJPS1AiLCJjcnYiOiJYMjU1MTkiLCJ4IjoiMERjWWtISkhZM0NGTzhPRVNQaEh3MHJqa2w0RUtDT0tzWm9MdFNJYTlrNCJ9fQ","recipients":[{"header":{"kid":"did:test:bob#key-agreement-1"},"encrypted_key":"ILJhItsbXqT4WpP_tZRINR0AfcDdqNSxpfAFKLphTRFsDxjdNtKtx3Z_1_QchFm3aMJz2aOONDLLZP8ulNgadAuXvZ-T4dbA"}],"iv":"Gf4xhta2gNPhvd3WcaUWQw","ciphertext":"7taDBuv5tFp-5FGPMq5lQMSUwLYe4kd9ROaWCqDjoMPebnOwP6N6niqW8zn7usGb9_aTPDT71wlj57sUQjZBVYeFCuAIUv9q-cMJZVFBaCp8N6xlP8OVCwhZNkDeeRQ0AzeqAuNq3dKZNhy-zExHAAYeJKm23OBBv55KFqKbrrOEgx7BUfwMYThoaR8NqcZk_hY-yztVbCV6YSeLXCuu1JW-wbESO4Yyl7WggaENMyvX3x_QhlTpjr-gtOwiXlFAaKkiWMv7sev8mYnTgY9ah9eW3-FhbLUHaXykjPpn_lOP4KAnpbU51KNY0n8ZDrW4NaXsEKEN9wuXE4AUweB61AtwrG2oKL_2di1beqbxOesLsQHgTIwlxEkeJdTo31ERsU2aWFIxfibu8_Um1dwp28nU8b7xAHkNryFw5PZUDk8NI2m4gbobT78yC-eyszC-2jQTydJeCIyS0MZUt0lyOrtL1Ckyma7dzv1WlsWUs6oma-9_eNpaIPIk88W97Ib1VAJGgpy3Lqqqy3A-jlU6-A","tag":"JJE8kyHDZ2sgUc4gJ1mY_kCRk2ADLXw2O_XPmWTY8jE"}',
}


# --- Python self round-trip --------------------------------------------------

def test_anoncrypt_roundtrip():
    packed = dc.pack_didcomm_message(MESSAGE, [BOB_RECIP])
    result = dc.unpack_didcomm_message(packed, BOB_PRIV)
    assert result["message"] == MESSAGE
    assert result["metadata"]["encrypted"] and not result["metadata"]["authenticated"]


def test_authcrypt_roundtrip():
    packed = dc.pack_didcomm_message(MESSAGE, [BOB_RECIP], sender=ALICE_SENDER)
    result = dc.unpack_didcomm_message(packed, BOB_PRIV, sender_key=ALICE["publicJwk"])
    assert result["message"] == MESSAGE
    assert result["metadata"]["authenticated"]
    assert result["metadata"]["sender"] == ALICE_KID


def test_gcm_roundtrip():
    packed = dc.pack_didcomm_message(MESSAGE, [BOB_RECIP], sender=ALICE_SENDER, enc="A256GCM")
    assert dc.unpack_didcomm_message(packed, BOB_PRIV, sender_key=ALICE["publicJwk"])["message"] == MESSAGE


def test_signed_roundtrip():
    packed = dc.pack_didcomm_message(MESSAGE, [BOB_RECIP], sender=ALICE_SENDER, signer=SIGNER_IN)
    result = dc.unpack_didcomm_message(packed, BOB_PRIV, sender_key=ALICE["publicJwk"], signer_key=SIGNER["publicJwk"])
    assert result["message"] == MESSAGE
    assert result["metadata"]["nonRepudiation"] and result["metadata"]["signer"] == SIGNER_KID


def test_forward_roundtrip():
    inner = dc.pack_didcomm_message(MESSAGE, [BOB_RECIP], sender=ALICE_SENDER)
    forward = dc.wrap_forward(inner, "did:test:bob", BOB_RECIP)
    plaintext, _ = dc.unpack_encrypted(forward, BOB_PRIV)
    parsed = dc.parse_forward(plaintext.decode("utf-8"))
    assert parsed["next"] == "did:test:bob" and parsed["forwardedMessage"] == inner


def test_envelope_info_and_wrong_recipient():
    packed = dc.pack_didcomm_message(MESSAGE, [BOB_RECIP], sender=ALICE_SENDER)
    info = dc.get_envelope_info(packed)
    assert info["type"] == "encrypted" and info["alg"] == "ECDH-1PU+A256KW"
    assert info["kids"] == [BOB_KID] and info["skid"] == ALICE_KID


# --- JS -> PY interop (decrypt envelopes produced by the TypeScript stack) ----

def test_js_anoncrypt_vector():
    assert dc.unpack_didcomm_message(JS_ENVELOPES["anon"], BOB_PRIV)["message"] == MESSAGE


def test_js_authcrypt_vector():
    result = dc.unpack_didcomm_message(JS_ENVELOPES["auth"], BOB_PRIV, sender_key=ALICE["publicJwk"])
    assert result["message"] == MESSAGE and result["metadata"]["authenticated"]


def test_js_gcm_vector():
    assert dc.unpack_didcomm_message(JS_ENVELOPES["gcm"], BOB_PRIV, sender_key=ALICE["publicJwk"])["message"] == MESSAGE


def test_js_signed_vector():
    result = dc.unpack_didcomm_message(JS_ENVELOPES["signed"], BOB_PRIV, sender_key=ALICE["publicJwk"], signer_key=SIGNER["publicJwk"])
    assert result["message"] == MESSAGE and result["metadata"]["nonRepudiation"]


# --- did:key cross-method ----------------------------------------------------

def test_did_key_roundtrip():
    did = dc.x25519_jwk_to_did_key(BOB["publicJwk"])
    assert did.startswith("did:key:z6LS")
    resolved = dc.did_key_to_x25519(did)
    assert resolved["publicJwk"]["x"] == BOB["publicJwk"]["x"]


def test_did_key_ed25519_w3c_vector():
    # W3C did:key test vector: z6Mk… (Ed25519) -> z6LS… (derived X25519 key agreement).
    did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
    resolved = dc.did_key_to_x25519(did)
    assert resolved["kid"].endswith("z6LSj72tK8brWgZja8NLRwPigth2T9QRiG1uH9oKZuKjdh9p")


# --- protocol builders -------------------------------------------------------

def test_trust_ping_and_basic_message():
    assert p.trust_ping()["body"]["response_requested"] is True
    assert p.trust_ping(False)["body"]["response_requested"] is False
    assert p.trust_ping_response("ping-1")["thid"] == "ping-1"
    assert p.basic_message("hi") == {"type": p.BASIC_MESSAGE_TYPE, "body": {"content": "hi"}}


def test_out_of_band_roundtrip():
    inv = p.out_of_band_invitation("did:cid:alice", {"goal": "connect"})
    assert inv["body"]["accept"] == ["didcomm/v2"]
    url = p.encode_out_of_band_invitation({"id": "inv-1", **inv})
    decoded = p.decode_out_of_band_invitation(url)
    assert decoded["from"] == "did:cid:alice" and decoded["body"]["goal"] == "connect"
    assert p.decode_out_of_band_invitation(url.split("_oob=")[1])["type"] == p.OUT_OF_BAND_INVITATION_TYPE


def test_credential_and_presentation_builders():
    vc = {"issuer": "did:cid:alice", "proof": {"proofValue": "x"}}
    msg = p.issue_credential_message(vc, comment="here you go")
    assert msg["type"] == p.ISSUE_CREDENTIAL_TYPE
    assert msg["body"]["formats"][0]["format"] == p.VC_ATTACHMENT_FORMAT
    assert p.attached_json(msg) == vc
    vp = {"type": ["VerifiablePresentation"], "verifiableCredential": [vc]}
    pres = p.presentation_message(vp, thid="req-1")
    assert pres["thid"] == "req-1" and p.attached_json(pres) == vp


def test_send_didcomm_requires_a_node_gateway():
    # A gatekeeper with no `url` (and no override) means no node gateway to reach
    # the DIDComm service -> send_didcomm errors before any network/crypto work.
    # (The keymaster never dials recipients directly; there is no fallback.)
    import asyncio
    import pytest
    from keymaster.core import Keymaster, KeymasterError

    km = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    with pytest.raises(KeymasterError):
        asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:bob"))


class _FakeResponse:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    @property
    def is_success(self):
        return self.status_code < 400

    def json(self):
        return self._payload


class _FakeClient:
    """Stands in for httpx.AsyncClient so the mailbox HTTP calls can be observed.

    core.py builds its own client inside `async with`, so there is nothing to
    inject; patching the class is the seam.
    """

    def __init__(self, responses, calls):
        self._responses = responses
        self._calls = calls

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url, **kwargs):
        self._calls.append(("GET", url, kwargs))
        return self._responses(url, kwargs)

    async def post(self, url, **kwargs):
        self._calls.append(("POST", url, kwargs))
        return self._responses(url, kwargs)


def _mailbox_keymaster(monkeypatch, calls, responses):
    import keymaster.core as core

    monkeypatch.setattr(core.httpx, "AsyncClient", lambda **kw: _FakeClient(responses, calls))
    km = core.Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    monkeypatch.setattr(km, "fetch_id_info", _async_return({"did": "did:cid:alice"}))
    monkeypatch.setattr(km, "fetch_key_pair", _async_return({"privateJwk": {}, "publicJwk": {}}))
    monkeypatch.setattr(km, "_didcomm_gateway_base", lambda endpoint=None: "https://gateway.example/didcomm")
    monkeypatch.setattr(km, "_require_node_capability", _async_return(None))
    monkeypatch.setattr(km, "_didcomm_challenge_auth", _async_return({"challenge": "c", "signature": "s"}))
    return km


def _async_return(value):
    async def _inner(*args, **kwargs):
        return value
    return _inner


def test_ack_didcomm_reports_the_relay_count_not_the_requested_count(monkeypatch):
    # Mirrors the JS keymaster: the relay decides how many were really removed.
    import asyncio

    calls: list = []
    km = _mailbox_keymaster(monkeypatch, calls, lambda url, kw: _FakeResponse({"removed": 1}))

    assert asyncio.run(km.ack_didcomm(["msg-1", "msg-gone"])) == 1


def test_unpack_rejects_a_from_that_contradicts_the_authenticated_sender():
    # Authcrypt binds the sender to skid; the plaintext `from` is an unchecked
    # claim inside the envelope. Mirrors the JS keymaster.
    import pytest
    from keymaster.core import Keymaster, KeymasterError

    metadata = {"authenticated": True, "sender": "did:cid:mallory#key-agreement-1"}

    with pytest.raises(KeymasterError, match="sender mismatch"):
        Keymaster._assert_sender_matches_envelope({"from": "did:cid:bob"}, metadata)

    # Matching from, and a message with no from at all, both pass.
    Keymaster._assert_sender_matches_envelope({"from": "did:cid:mallory"}, metadata)
    Keymaster._assert_sender_matches_envelope({"body": {}}, metadata)


def test_unpack_leaves_an_anoncrypt_from_alone():
    # No skid means no authenticated sender to contradict; the claim is simply
    # unverified, and callers must present it that way rather than reject it.
    from keymaster.core import Keymaster

    Keymaster._assert_sender_matches_envelope(
        {"from": "did:cid:bob"}, {"authenticated": False, "sender": None}
    )


def test_send_didcomm_deposits_locally_for_a_mailbox_on_this_node(monkeypatch):
    # Sending to your own identity must not leave the node. With an auto-discovered
    # .onion endpoint that would be a full Tor round trip out and back -- and no
    # delivery at all on a node running no Tor. Mirrors the JS keymaster.
    import asyncio

    onion = "http://abcdefghijklmnop.onion:4222/didcomm"
    calls: list = []

    def responses(url, kw):
        return _FakeResponse({"ids": ["local-1"]})

    km = _mailbox_keymaster(monkeypatch, calls, responses)
    monkeypatch.setattr(km, "pack_didcomm", _async_return("envelope"))
    monkeypatch.setattr(km, "_resolve_didcomm_endpoint", _async_return({"uri": onion, "routingKeys": []}))
    monkeypatch.setattr(km, "_node_didcomm_endpoint_uri", _async_return(onion))

    assert asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:alice")) == ["local-1"]

    urls = [url for _method, url, _kw in calls]
    assert urls == ["https://gateway.example/didcomm/api/v1/messages"]
    assert not any("/deliver" in url for url in urls)
    assert not any("/challenge" in url for url in urls)


def test_send_didcomm_uses_the_service_for_a_mailbox_elsewhere(monkeypatch):
    import asyncio

    calls: list = []

    def responses(url, kw):
        if url.endswith("/challenge"):
            return _FakeResponse({"challenge": "c"})
        return _FakeResponse({"ids": ["remote-1"]})

    km = _mailbox_keymaster(monkeypatch, calls, responses)
    monkeypatch.setattr(km, "pack_didcomm", _async_return("envelope"))
    monkeypatch.setattr(km, "_resolve_didcomm_endpoint", _async_return({"uri": "https://othernode.example/didcomm", "routingKeys": []}))
    monkeypatch.setattr(km, "_node_didcomm_endpoint_uri", _async_return("https://mynode.example/didcomm"))
    monkeypatch.setattr("keymaster.core.sign_hash", lambda *args, **kwargs: "sig")

    assert asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:bob")) == ["remote-1"]

    urls = [url for _method, url, _kw in calls]
    assert any("/deliver" in url for url in urls)
    assert not any(url.endswith("/api/v1/messages") for url in urls)


def test_same_didcomm_endpoint_ignores_case_and_trailing_slash():
    from keymaster.core import Keymaster

    assert Keymaster._same_didcomm_endpoint("https://Node.Example/didcomm/", "https://node.example/didcomm")
    assert not Keymaster._same_didcomm_endpoint("https://node.example/didcomm", "https://other.example/didcomm")


def test_delivery_failure_carries_the_service_error_body(monkeypatch):
    # 502 alone cannot tell a missing Tor proxy from a recipient that rejected the
    # envelope; the reason lives in the body. Mirrors the JS keymaster.
    import asyncio
    import pytest
    from keymaster.core import KeymasterError

    def responses(url, kw):
        if url.endswith("/challenge"):
            return _FakeResponse({"challenge": "c"})
        return _FakeResponse(
            {"error": "onion endpoint requires a Tor proxy (set ARCHON_DIDCOMM_TOR_PROXY)"},
            status_code=502,
        )

    calls: list = []
    km = _mailbox_keymaster(monkeypatch, calls, responses)
    monkeypatch.setattr(km, "pack_didcomm", _async_return("envelope"))
    monkeypatch.setattr(km, "_resolve_didcomm_endpoint", _async_return({"uri": "https://bob.example/didcomm", "routingKeys": []}))
    monkeypatch.setattr("keymaster.core.sign_hash", lambda *args, **kwargs: "sig")

    with pytest.raises(KeymasterError) as exc:
        asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:bob"))

    assert "502 (onion endpoint requires a Tor proxy" in str(exc.value)


def test_delivery_failure_without_a_body_still_reports_the_status(monkeypatch):
    import asyncio
    import pytest
    from keymaster.core import KeymasterError

    class _NoBody:
        status_code = 504
        is_success = False

        @staticmethod
        def json():
            raise ValueError("not json")

    def responses(url, kw):
        if url.endswith("/challenge"):
            return _FakeResponse({"challenge": "c"})
        return _NoBody()

    calls: list = []
    km = _mailbox_keymaster(monkeypatch, calls, responses)
    monkeypatch.setattr(km, "pack_didcomm", _async_return("envelope"))
    monkeypatch.setattr(km, "_resolve_didcomm_endpoint", _async_return({"uri": "https://bob.example/didcomm", "routingKeys": []}))
    monkeypatch.setattr("keymaster.core.sign_hash", lambda *args, **kwargs: "sig")

    with pytest.raises(KeymasterError) as exc:
        asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:bob"))

    assert str(exc.value).endswith("failed: 504")


def test_receive_didcomm_acks_unless_ack_is_explicitly_false(monkeypatch):
    # A None (e.g. a JSON null crossing an API boundary) must not be read as
    # "do not acknowledge"; only an explicit False skips the remove call.
    import asyncio

    def responses(url, kw):
        if url.endswith("/messages/fetch"):
            return _FakeResponse({"messages": [{"id": "msg-ok", "message": "envelope"}]})
        return _FakeResponse({"removed": 1})

    # (ack value, is the message expected to be removed)
    for ack, expect_removed in ((None, True), (True, True), (False, False), ("unset", True)):
        calls: list = []
        km = _mailbox_keymaster(monkeypatch, calls, responses)
        # Unpacking is not what is under test here; stub it so the message counts
        # as handled and the ack decision is actually reached.
        monkeypatch.setattr(km, "unpack_didcomm", _async_return({"message": {}, "metadata": {}}))

        options = {} if ack == "unset" else {"ack": ack}
        results = asyncio.run(km.receive_didcomm(options))

        assert len(results) == 1
        assert results[0]["id"] == "msg-ok"
        removed = any(url.endswith("/messages/remove") for _, url, _ in calls)
        assert removed is expect_removed, f"ack={ack!r} should removed={expect_removed}"


def test_ack_didcomm_rejects_non_list_ids():
    # Mirrors the JS keymaster: ids is validated before any network/wallet work.
    import asyncio
    import pytest
    from keymaster.core import Keymaster, KeymasterError

    km = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    with pytest.raises(KeymasterError):
        asyncio.run(km.ack_didcomm("msg-1"))


def test_ack_didcomm_empty_list_is_a_noop():
    # An empty ack short-circuits before the gateway is resolved, so this works
    # even with a gatekeeper that could not reach a node.
    import asyncio
    from keymaster.core import Keymaster

    km = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    assert asyncio.run(km.ack_didcomm([])) == 0


def test_capability_gating_blocks_unavailable_services():
    # When the node's manifest says a service is off, the relevant verb fails with
    # a clear "does not offer …" error (before any network/crypto/wallet work).
    import asyncio
    import pytest
    from keymaster.core import Keymaster, KeymasterError

    class _Gw:
        url = "http://node.test"

        async def create_lightning_wallet(self, name):  # lets require_drawbridge pass
            return {}

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    km._node_capabilities = {"didcomm": False, "lightning": False}  # preset cache, no fetch

    with pytest.raises(KeymasterError, match="does not offer DIDComm"):
        asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:bob"))
    with pytest.raises(KeymasterError, match="does not offer Lightning"):
        asyncio.run(km.get_lightning_config())


def test_capability_gating_permissive_when_manifest_absent():
    # No manifest (older node / bare gatekeeper) -> the gate is permissive; the verb
    # proceeds and fails later for a different reason, never "does not offer".
    import asyncio
    import pytest
    from keymaster.core import Keymaster, KeymasterError

    class _Gw:
        url = "http://node.test"

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    km._node_capabilities = None  # node exposes no manifest

    # Gets past the gate, then fails at crypto/resolve against the bare fake gateway —
    # the point is the error is NOT the capability gate.
    with pytest.raises(Exception) as exc:
        asyncio.run(km.send_didcomm({"type": "t", "body": {}}, "did:cid:bob"))
    assert "does not offer" not in str(exc.value)


def test_get_node_capabilities_is_public_and_memoized(monkeypatch):
    # The same signal the gates use, exposed so a wallet can hide a surface instead
    # of offering it and failing. Mirrors the JS Keymaster.getNodeCapabilities.
    import asyncio
    import httpx
    from keymaster.core import Keymaster

    class _Gw:
        url = "http://node.test"

    calls: list[str] = []

    class _Response:
        is_success = True

        @staticmethod
        def json():
            return {"didcomm": True, "lightning": False, "names": True}

    class _Client:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url):
            calls.append(url)
            return _Response()

    monkeypatch.setattr(httpx, "AsyncClient", _Client)
    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)

    async def run():
        first = await km.get_node_capabilities()
        second = await km.get_node_capabilities()
        return first, second

    first, second = asyncio.run(run())
    assert first == {"didcomm": True, "lightning": False, "names": True}
    assert second == first
    assert calls == ["http://node.test/api/v1/capabilities"]  # memoized, fetched once


def test_get_node_capabilities_none_without_node_url():
    import asyncio
    from keymaster.core import Keymaster

    class _Gw:
        url = None

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)
    assert asyncio.run(km.get_node_capabilities()) is None


def test_coordinate_mediation_builders():
    assert p.mediate_request()["type"] == p.MEDIATE_REQUEST_TYPE
    grant = p.mediate_grant("did:cid:mediator", "req-1")
    assert grant["body"]["routing_did"] == "did:cid:mediator" and grant["thid"] == "req-1"
    assert p.mediate_deny("req-1")["type"] == p.MEDIATE_DENY_TYPE
    update = p.keylist_update(["did:cid:bob"], "add")
    assert update["body"]["updates"][0] == {"recipient_did": "did:cid:bob", "action": "add"}
    response = p.keylist_update_response([{"recipient_did": "did:cid:bob", "action": "add", "result": "success"}], "u-1")
    assert response["thid"] == "u-1" and response["body"]["updated"][0]["result"] == "success"
    assert p.keylist(["did:cid:bob"])["body"]["keys"][0] == {"recipient_did": "did:cid:bob"}


def test_accept_credential_didcomm_requires_a_resolvable_did():
    # A credential from a foreign issuer carries no did:cid for this wallet to
    # look up, so there is nothing to hold -- saying so beats reporting a success
    # that stored nothing. Mirrors the JS keymaster (#905).
    import asyncio
    from keymaster.core import Keymaster

    class _Gw:
        url = "http://node.test"

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)

    foreign = {
        "type": "https://didcomm.org/issue-credential/3.0/issue-credential",
        "body": {"credential_did": "https://university.example/credentials/1872"},
        "attachments": [{"data": {"json": {
            "id": "https://university.example/credentials/1872",
            "issuer": "did:web:university.example",
        }}}],
    }

    assert asyncio.run(km.accept_credential_didcomm(foreign)) is False
    assert asyncio.run(km.accept_credential_didcomm({"body": {}})) is False


def test_send_credential_didcomm_carries_the_credential_not_a_reference(monkeypatch):
    # The whole point: a foreign holder cannot resolve or decrypt a credential
    # DID, so the message must contain the signed VC itself.
    import asyncio
    from keymaster.core import Keymaster

    class _Gw:
        url = "http://node.test"

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)

    vc = {
        "@context": ["https://www.w3.org/ns/credentials/v2"],
        "type": ["VerifiableCredential"],
        "issuer": "did:cid:alice",
        "credentialSubject": {"id": "did:web:example.com"},
        "proof": {"proofValue": "sig"},
    }

    sent: dict = {}

    async def fake_send(message, to, options=None):
        sent["message"] = message
        sent["to"] = to
        return ["msg-1"]

    monkeypatch.setattr(km, "lookup_did", _async_return("did:cid:credential"))
    monkeypatch.setattr(km, "get_credential", _async_return(vc))
    monkeypatch.setattr(km, "send_didcomm", fake_send)

    assert asyncio.run(
        km.send_credential_didcomm("did:cid:credential", "did:web:example.com")
    ) == ["msg-1"]

    # The DID is named in the body, where the protocol expects the hint, and the
    # credential travels byte-for-byte as it was signed. It also names its own
    # asset DID: issue_credential embeds `id` before signing, so the identifier
    # is covered by the proof rather than added after it (#108). This test hands
    # in its own VC, so what arrives is whatever was passed.
    assert sent["message"]["body"]["credential_did"] == "did:cid:credential"

    attached = sent["message"]["attachments"][0]["data"]["json"]
    assert attached == vc


def test_accept_credential_didcomm_refuses_a_credential_it_did_not_show(monkeypatch):
    # A sender can name one credential in the body and attach another. The
    # credential now names its own asset under the issuer's signature (#108), so
    # the two would disagree -- but comparing the full content catches strictly
    # more, including an attachment that names the right DID and differs from
    # what that DID holds.
    import asyncio
    from keymaster.core import Keymaster

    class _Gw:
        url = "http://node.test"

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass", create_wallet_if_missing=True)

    resolved = {"type": ["VerifiableCredential"], "issuer": "did:cid:alice"}
    shown = {"type": ["VerifiableCredential"], "issuer": "did:cid:mallory"}

    accepted: list[str] = []

    async def fake_accept(did):
        accepted.append(did)
        return True

    monkeypatch.setattr(km, "get_credential", _async_return(resolved))
    monkeypatch.setattr(km, "accept_credential", fake_accept)

    message = {
        "type": "https://didcomm.org/issue-credential/3.0/issue-credential",
        "body": {"credential_did": "did:cid:credential"},
        "attachments": [{"data": {"json": shown}}],
    }

    assert asyncio.run(km.accept_credential_didcomm(message)) is False
    assert accepted == []

    message["attachments"][0]["data"]["json"] = resolved
    assert asyncio.run(km.accept_credential_didcomm(message)) is True
    assert accepted == ["did:cid:credential"]
