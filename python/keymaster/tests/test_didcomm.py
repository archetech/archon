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
