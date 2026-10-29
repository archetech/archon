"""DIDComm v2 crypto + protocol-builder tests for the Python keymaster library.

The `js_envelopes` fixtures below were produced by the TypeScript stack
(@didcid/cipher) for these exact deterministic keys; decrypting them here proves
the Python port interoperates byte-for-byte with the JS / reference library
(JS -> PY), with no Node needed at test time. The self round-trips cover PY -> PY.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any
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


def test_normalize_rejects_wrong_length_multibase_key():
    # A did:peer:2 copies its key material verbatim, so a well-formed base58
    # string with a valid codec prefix but a short payload can reach here.
    import pytest
    from bip_utils import Base58Encoder

    short_x25519 = "z" + Base58Encoder.Encode(bytes([0xec, 0x01]) + bytes([7] * 31))
    short_ed25519 = "z" + Base58Encoder.Encode(bytes([0xed, 0x01]) + bytes([7] * 31))
    for multibase in (short_x25519, short_ed25519, "z1"):
        with pytest.raises(ValueError, match="key material"):
            dc.normalize_x25519_public_key({"publicKeyMultibase": multibase})


def test_did_key_ed25519_w3c_vector():
    # W3C did:key test vector: z6Mk… (Ed25519) -> z6LS… (derived X25519 key agreement).
    did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
    resolved = dc.did_key_to_x25519(did)
    assert resolved["kid"].endswith("z6LSj72tK8brWgZja8NLRwPigth2T9QRiG1uH9oKZuKjdh9p")


# The example in the peer DID method specification, Method 2.
PEER2_SPEC_DID = (
    "did:peer:2.Vz6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc.Ez6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR"
    ".SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly9leGFtcGxlLmNvbS9kaWRjb21tIiwiYSI6WyJkaWRjb21tL3YyIl0sInIiOlsiZGlkOmV4YW1wbGU6MTIzNDU2Nzg5YWJjZGVmZ2hpI2tleS0xIl19fQ"
    ".SeyJ0IjoiZG0iLCJzIjp7InVyaSI6Imh0dHA6Ly9leGFtcGxlLmNvbS9hbm90aGVyIiwiYSI6WyJkaWRjb21tL3YyIl0sInIiOlsiZGlkOmV4YW1wbGU6MTIzNDU2Nzg5YWJjZGVmZ2hpI2tleS0yIl19fQ"
)


def test_did_peer_2_spec_example():
    assert dc.resolve_did_peer_2(PEER2_SPEC_DID) == {
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
        "id": PEER2_SPEC_DID,
        "verificationMethod": [
            {"id": "#key-1", "controller": PEER2_SPEC_DID, "type": "Multikey", "publicKeyMultibase": "z6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc"},
            {"id": "#key-2", "controller": PEER2_SPEC_DID, "type": "Multikey", "publicKeyMultibase": "z6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR"},
        ],
        "authentication": ["#key-1"],
        "keyAgreement": ["#key-2"],
        "service": [
            {
                "type": "DIDCommMessaging",
                "serviceEndpoint": {"uri": "http://example.com/didcomm", "accept": ["didcomm/v2"], "routingKeys": ["did:example:123456789abcdefghi#key-1"]},
                "id": "#service",
            },
            {
                "type": "DIDCommMessaging",
                "serviceEndpoint": {"uri": "http://example.com/another", "accept": ["didcomm/v2"], "routingKeys": ["did:example:123456789abcdefghi#key-2"]},
                "id": "#service-1",
            },
        ],
    }
    assert dc.resolve_did_peer_2(f"{PEER2_SPEC_DID}#key-2")["id"] == PEER2_SPEC_DID


def test_did_peer_2_purposes_and_service_ids():
    import base64
    import json as jsonlib

    key = "z6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR"
    doc = dc.resolve_did_peer_2(f"did:peer:2.A{key}.E{key}.V{key}.I{key}.D{key}")
    assert doc["assertionMethod"] == ["#key-1"]
    assert doc["keyAgreement"] == ["#key-2"]
    assert doc["authentication"] == ["#key-3"]
    assert doc["capabilityInvocation"] == ["#key-4"]
    assert doc["capabilityDelegation"] == ["#key-5"]
    assert "service" not in doc

    named = base64.urlsafe_b64encode(jsonlib.dumps({"id": "#didcomm", "t": "dm", "s": "https://example.com"}).encode()).decode().rstrip("=")
    assert dc.resolve_did_peer_2(f"did:peer:2.E{key}.S{named}")["service"] == [
        {"id": "#didcomm", "type": "DIDCommMessaging", "serviceEndpoint": "https://example.com"}
    ]


def test_did_peer_2_rejects_malformed_dids():
    import base64
    import pytest

    with pytest.raises(ValueError, match="did:peer:2"):
        dc.resolve_did_peer_2("did:peer:0z6Mkj3PUd1WjvaDhNZhhhXQdz5UnZXmS7ehtx8bsPpD47kKc")
    with pytest.raises(ValueError, match="Invalid"):
        dc.resolve_did_peer_2("did:peer:2.Xz6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR")
    with pytest.raises(ValueError, match="Invalid"):
        dc.resolve_did_peer_2("did:peer:2.E6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR")
    with pytest.raises(Exception):
        dc.resolve_did_peer_2("did:peer:2.Ez0OIl")
    with pytest.raises(ValueError, match="not an object"):
        dc.resolve_did_peer_2("did:peer:2.S" + base64.urlsafe_b64encode(b"[1]").decode().rstrip("="))


PEER4_SPEC_DID = (
    "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd:z2M1k7h4psgp4CmJcnQn2Ljp7Pz7ktsd7oBhMU3dWY5s4fhFNj17qcRTQ427C7"
    "QHNT6cQ7T3XfRh35Q2GhaNFZmWHVFq4vL7F8nm36PA9Y96DvdrUiRUaiCuXnBFrn1o7mxFZAx14JL4t8vUWpuDPwQuddVo1T8myRiVH7wdxuoYbsva5x6idE"
    "pCQydJdFjiHGCpNc2UtjzPQ8awSXkctGCnBmgkhrj5gto3D4i3EREXYq4Z8r2cWGBr2UzbSmnxW2BuYddFo9Yfm6mKjtJyLpF74ytqrF5xtf84MnGFg1hMBm"
    "h1xVx1JwjZ2BeMJs7mNS8DTZhKC7KH38EgqDtUZzfjhpjmmUfkXg2KFEA3EGbbVm1DPqQXayPYKAsYPS9AyKkcQ3fzWafLPP93UfNhtUPL8JW5pMcSV3P8v6"
    "j3vPXqnnGknNyBprD6YGUVtgLiAqDBDUF3LSxFQJCVYYtghMTv8WuSw9h1a1SRFrDQLGHE4UrkgoRvwaGWr64aM87T1eVGkP5Dt4L1AbboeK2ceLArPScrdY"
    "GTpi3BpTkLwZCdjdiFSfTy9okL1YNRARqUf2wm8DvkVGUU7u5nQA3ZMaXWJAewk6k1YUxKd7LvofGUK4YEDtoxN5vb6r1Q2godrGqaPkjfL3RoYPpDYymf9X"
    "hcgG8Kx3DZaA6cyTs24t45KxYAfeCw4wqUpCH9HbpD78TbEUr9PPAsJgXBvBj2VVsxnr7FKbK4KykGcg1W8M1JPz21Z4Y72LWgGQCmixovrkHktcTX1uNHjA"
    "vKBqVD5C7XmVfHgXCHj7djCh3vzLNuVLtEED8J1hhqsB1oCBGiuh3xXr7fZ9wUjJCQ1HYHqxLJKdYKtoCiPmgKM7etVftXkmTFETZmpM19aRyih3bao76Ldp"
    "Qtbw636r7a3qt8v4WfxsXJetSL8c7t24SqQBcAY89FBsbEnFNrQCMK3JEseKHVaU388ctvRD45uQfe5GndFxthj4iSDomk4uRFd1uRbywoP1tRuabHTDX42U"
    "xPjz"
)
PEER4_SPEC_SHORT_FORM = "did:peer:4zQmd8CpeFPci817KDsbSAKWcXAE2mjvCQSasRewvbSF54Bd"


def test_did_peer_4_spec_example():
    # The long-form example in the peer DID method specification, Method 4.
    assert dc.resolve_did_peer_4(PEER4_SPEC_DID) == {
        "@context": [
            "https://www.w3.org/ns/did/v1",
            "https://w3id.org/security/suites/x25519-2020/v1",
            "https://w3id.org/security/suites/ed25519-2020/v1",
        ],
        "verificationMethod": [
            {"id": "#6LSqPZfn", "type": "X25519KeyAgreementKey2020", "publicKeyMultibase": "z6LSqPZfn9krvgXma2icTMKf2uVcYhKXsudCmPoUzqGYW24U", "controller": PEER4_SPEC_DID},
            {"id": "#6MkrCD1c", "type": "Ed25519VerificationKey2020", "publicKeyMultibase": "z6MkrCD1csqtgdj8sjrsu8jxcbeyP6m7LiK87NzhfWqio5yr", "controller": PEER4_SPEC_DID},
        ],
        "service": [
            {
                "id": "#didcommmessaging-0",
                "type": "DIDCommMessaging",
                "serviceEndpoint": {"uri": "didcomm:transport/queue", "accept": ["didcomm/v2"], "routingKeys": []},
            }
        ],
        "authentication": ["#6MkrCD1c"],
        "keyAgreement": ["#6LSqPZfn"],
        "assertionMethod": ["#6MkrCD1c"],
        "capabilityDelegation": ["#6MkrCD1c"],
        "capabilityInvocation": ["#6MkrCD1c"],
        "alsoKnownAs": [PEER4_SPEC_SHORT_FORM],
        "id": PEER4_SPEC_DID,
    }
    assert dc.resolve_did_peer_4(f"{PEER4_SPEC_DID}#6LSqPZfn")["id"] == PEER4_SPEC_DID


def test_did_peer_4_rejects_bad_hashes_and_other_forms():
    import pytest

    with pytest.raises(ValueError, match="hash"):
        dc.resolve_did_peer_4(PEER4_SPEC_DID.replace("SF54Bd:", "SF54Be:"))
    prefix, encoded = PEER4_SPEC_DID.split(":z2M1")
    with pytest.raises(ValueError, match="hash"):
        dc.resolve_did_peer_4(f"{prefix}:z2M2{encoded}")
    with pytest.raises(ValueError, match="long-form"):
        dc.resolve_did_peer_4(PEER4_SPEC_SHORT_FORM)
    with pytest.raises(ValueError, match="did:peer:4"):
        dc.resolve_did_peer_4("did:peer:2.Ez6LSg8zQom395jKLrGiBNruB9MM6V8PWuf2FpEy4uRFiqQBR")


MEDIATOR_ENDPOINT = "https://mediator.example/didcomm"


def _peer_2_mediator(seed_byte: int) -> dict[str, Any]:
    # A mediator as coordinate-mediation grants it: a did:peer:2 routing DID
    # with its own HTTP endpoint.
    import base64
    import json as jsonlib

    kp = dc.generate_x25519_jwk(bytes([seed_byte] * 32))
    service = jsonlib.dumps({"t": "dm", "s": {"uri": MEDIATOR_ENDPOINT, "a": ["didcomm/v2"]}}).encode()
    did = ("did:peer:2.E" + dc.x25519_jwk_to_did_key(kp["publicJwk"])[len("did:key:"):]
           + ".S" + base64.urlsafe_b64encode(service).decode().rstrip("="))
    return {"did": did, "kid": f"{did}#key-1", "kp": kp}


def _peer_4_agent(seed_byte: int, service_uri: str) -> dict[str, Any]:
    # A did:peer:4 agent (as the DIF demo identifies itself) whose service uri is
    # its mediator's routing DID, encoded per the peer DID method specification.
    import hashlib
    import json as jsonlib

    kp = dc.generate_x25519_jwk(bytes([seed_byte] * 32))
    doc = {
        "@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
        "verificationMethod": [{"id": "#key-1", "type": "Multikey",
                                "publicKeyMultibase": dc.x25519_jwk_to_did_key(kp["publicJwk"])[len("did:key:"):]}],
        "keyAgreement": ["#key-1"],
        "service": [{"id": "#didcomm", "type": "DIDCommMessaging", "serviceEndpoint": {"uri": service_uri, "accept": ["didcomm/v2"]}}],
    }
    encoded = dc.bytes_to_multibase(bytes([0x80, 0x04]) + jsonlib.dumps(doc, separators=(",", ":")).encode())
    hash_value = dc.bytes_to_multibase(bytes([0x12, 0x20]) + hashlib.sha256(encoded.encode()).digest())
    did = f"did:peer:4{hash_value}:{encoded}"
    return {"did": did, "kid": f"{did}#key-1", "kp": kp}


def test_unpack_didcomm_from_did_peer_4_without_the_gatekeeper(testbed, monkeypatch):
    import json as jsonlib
    from keymaster.core import KeymasterError
    from .helpers import run

    km = testbed.keymaster
    alice_did = run(km.create_id("Alice", {"registry": "local"}))
    run(km.publish_didcomm("https://relay.example/didcomm", "Alice"))
    alice_doc = run(km.resolve_did(alice_did))["didDocument"]
    alice_ka_id = alice_doc["keyAgreement"][0]
    alice_ka = next(vm for vm in alice_doc["verificationMethod"] if vm["id"] == alice_ka_id)

    peer = _peer_4_agent(0x61, _peer_2_mediator(0x62)["did"])
    message = {"id": "p4", "typ": "application/didcomm-plain+json", "type": "https://x/1/msg",
               "from": peer["did"], "to": [alice_did], "body": {"text": "peer4 hello"}}
    packed = dc.pack_encrypted(
        jsonlib.dumps(message).encode(),
        [{"kid": alice_ka_id, "publicJwk": alice_ka["publicKeyJwk"]}],
        {"kid": peer["kid"], "privateJwk": peer["kp"]["privateJwk"]},
        "A256CBC-HS512",
    )

    # A gatekeeper (or its universal resolver) without a did:peer driver.
    resolve_did = km.resolve_did

    async def no_peer_driver(did, *args, **kwargs):
        if did.startswith("did:peer:"):
            raise KeymasterError("unsupported DID method")
        return await resolve_did(did, *args, **kwargs)

    monkeypatch.setattr(km, "resolve_did", no_peer_driver)

    result = run(km.unpack_didcomm(packed, {"name": "Alice"}))
    assert result["message"]["body"] == {"text": "peer4 hello"}
    assert result["metadata"]["authenticated"] is True
    assert result["metadata"]["sender"] == peer["kid"]


def _foreign_did_peer_2(seed_byte: int) -> dict[str, Any]:
    # A did:peer:2 agent (as the DIF demo, Credo and Aries mediators use), whose
    # X25519 keypair we hold. Its key-agreement key is #key-1, the only key.
    kp = dc.generate_x25519_jwk(bytes([seed_byte] * 32))
    did = "did:peer:2.E" + dc.x25519_jwk_to_did_key(kp["publicJwk"])[len("did:key:"):]
    return {"did": did, "kid": f"{did}#key-1", "kp": kp}


def test_unpack_didcomm_from_did_peer_2_without_the_gatekeeper(testbed, monkeypatch):
    import json as jsonlib
    from .helpers import run

    km = testbed.keymaster
    alice_did = run(km.create_id("Alice", {"registry": "local"}))
    run(km.publish_didcomm("https://relay.example/didcomm", "Alice"))
    alice_doc = run(km.resolve_did(alice_did))["didDocument"]
    alice_ka_id = alice_doc["keyAgreement"][0]
    alice_ka = next(vm for vm in alice_doc["verificationMethod"] if vm["id"] == alice_ka_id)

    peer = _foreign_did_peer_2(0x51)
    message = {"id": "p1", "typ": "application/didcomm-plain+json", "type": "https://x/1/msg",
               "from": peer["did"], "to": [alice_did], "body": {"text": "peer hello"}}
    packed = dc.pack_encrypted(
        jsonlib.dumps(message).encode(),
        [{"kid": alice_ka_id, "publicJwk": alice_ka["publicKeyJwk"]}],
        {"kid": peer["kid"], "privateJwk": peer["kp"]["privateJwk"]},
        "A256CBC-HS512",
    )

    # A gatekeeper (or its universal resolver) without a did:peer driver.
    from keymaster.core import KeymasterError

    resolve_did = km.resolve_did

    async def no_peer_driver(did, *args, **kwargs):
        if did.startswith("did:peer:"):
            raise KeymasterError("unsupported DID method")
        return await resolve_did(did, *args, **kwargs)

    monkeypatch.setattr(km, "resolve_did", no_peer_driver)

    result = run(km.unpack_didcomm(packed, {"name": "Alice"}))
    assert result["message"]["body"] == {"text": "peer hello"}
    assert result["metadata"]["authenticated"] is True
    assert result["metadata"]["sender"] == peer["kid"]


def test_pack_didcomm_to_did_peer_2_addresses_the_absolute_kid(testbed):
    import json as jsonlib
    from .helpers import run

    km = testbed.keymaster
    run(km.create_id("Alice", {"registry": "local"}))
    run(km.publish_didcomm("https://relay.example/didcomm", "Alice"))
    peer = _foreign_did_peer_2(0x52)

    packed = run(km.pack_didcomm({"type": "https://x/1/msg", "body": {"text": "reply"}}, peer["did"], {"name": "Alice", "anoncrypt": True}))

    assert [r["header"]["kid"] for r in jsonlib.loads(packed)["recipients"]] == [peer["kid"]]
    plaintext, _ = dc.unpack_encrypted(packed, {"kid": peer["kid"], "privateJwk": peer["kp"]["privateJwk"]})
    assert jsonlib.loads(plaintext)["body"] == {"text": "reply"}


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


def test_publish_didcomm_advertises_the_object_service_endpoint(testbed):
    # didcomm-rust and the senders built on it reject a bare-string
    # serviceEndpoint, so the object form is published with or without routing.
    from .helpers import run

    km = testbed.keymaster
    did = run(km.create_id("Alice", {"registry": "local"}))
    endpoint = "https://relay.example/didcomm"

    def service():
        doc = run(km.resolve_did(did))["didDocument"]
        return [s for s in doc["service"] if s["id"] == f"{did}#didcomm"]

    run(km.publish_didcomm(endpoint))
    assert service() == [{
        "id": f"{did}#didcomm",
        "type": "DIDCommMessaging",
        "serviceEndpoint": {"uri": endpoint, "accept": ["didcomm/v2"], "routingKeys": []},
    }]

    run(km.publish_didcomm(endpoint, routing_keys=["did:test:mediator#key-agreement-1"]))
    assert service()[0]["serviceEndpoint"] == {
        "uri": endpoint,
        "accept": ["didcomm/v2"],
        "routingKeys": ["did:test:mediator#key-agreement-1"],
    }


def test_send_didcomm_requires_a_node_gateway():
    # A gatekeeper with no `url` (and no override) means no node gateway to reach
    # the DIDComm service -> send_didcomm errors before any network/crypto work.
    # (The keymaster never dials recipients directly; there is no fallback.)
    import asyncio
    import pytest
    from keymaster.core import Keymaster, KeymasterError

    km = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass")
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
    km = core.Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass")
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


def test_send_didcomm_forwards_to_the_mediator_named_by_a_did_service_uri(monkeypatch):
    # The DIF demo's did:peer:4 service uri is its mediator's routing DID. The
    # gatekeeper is never asked: both peer DIDs resolve locally. Mirrors the JS keymaster.
    import asyncio
    import json as jsonlib

    mediator = _peer_2_mediator(0x63)
    peer = _peer_4_agent(0x64, mediator["did"])
    calls: list = []

    def responses(url, kw):
        if url.endswith("/challenge"):
            return _FakeResponse({"challenge": "c"})
        return _FakeResponse({"ids": ["forwarded"]})

    km = _mailbox_keymaster(monkeypatch, calls, responses)
    monkeypatch.setattr(km, "pack_didcomm", _async_return('{"inner":"envelope"}'))
    monkeypatch.setattr(km, "_node_didcomm_endpoint_uri", _async_return(None))
    monkeypatch.setattr("keymaster.core.sign_hash", lambda *args, **kwargs: "sig")

    assert asyncio.run(km.send_didcomm({"type": "t", "body": {}}, peer["did"])) == ["forwarded"]

    delivery = next(kw["json"] for _method, url, kw in calls if url.endswith("/deliver"))
    assert delivery["endpoint"] == MEDIATOR_ENDPOINT
    plaintext, _ = dc.unpack_encrypted(delivery["message"], {"kid": mediator["kid"], "privateJwk": mediator["kp"]["privateJwk"]})
    forward = dc.parse_forward(plaintext.decode("utf-8"))
    assert forward["next"] == peer["did"]
    assert jsonlib.loads(forward["forwardedMessage"]) == {"inner": "envelope"}


def test_send_didcomm_refuses_a_mediator_without_a_direct_endpoint(monkeypatch):
    import asyncio
    import pytest
    from keymaster.core import KeymasterError

    outer_mediator = _peer_4_agent(0x66, _peer_2_mediator(0x65)["did"])
    peer = _peer_4_agent(0x67, outer_mediator["did"])
    calls: list = []

    km = _mailbox_keymaster(monkeypatch, calls, lambda url, kw: _FakeResponse({}))
    monkeypatch.setattr(km, "pack_didcomm", _async_return('{"inner":"envelope"}'))

    with pytest.raises(KeymasterError, match="no direct DIDCommMessaging endpoint"):
        asyncio.run(km.send_didcomm({"type": "t", "body": {}}, peer["did"]))
    assert calls == []


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

    km = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass")
    with pytest.raises(KeymasterError):
        asyncio.run(km.ack_didcomm("msg-1"))


def test_ack_didcomm_empty_list_is_a_noop():
    # An empty ack short-circuits before the gateway is resolved, so this works
    # even with a gatekeeper that could not reach a node.
    import asyncio
    from keymaster.core import Keymaster

    km = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="pass")
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

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")
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

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")
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
    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")

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

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")
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

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")

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

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")

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

    km = Keymaster(gatekeeper=_Gw(), wallet_store=object(), passphrase="pass")

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

# The same zero seed and the values the TypeScript cipher produces for it. Both
# suites pin these constants, so an encoding change on either side fails here
# rather than surfacing as a credential the other cannot verify.
ED25519_ZERO_SEED_X = "O2onvM62pC1io6jQKm8Nc2UyFXcd4kOmOsBIoYtZ2ik"
ED25519_ZERO_SEED_MULTIKEY = "z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp"
ED25519_ZERO_SEED_SIGNATURE = (
    "4lyHI9A5_o9F1snWqJF_qRvHVJE81Zb9NYpJOiGjy1kKZTe6vH3wQAq2GgVYnJw2tloUOHjLA0HU6eSEGcQ3DQ"
)


def test_ed25519_matches_the_typescript_cipher_byte_for_byte():
    pair = dc.generate_ed25519_jwk(bytes(32))
    signature = dc.sign_ed25519(b"hello", pair["privateJwk"])

    assert pair["publicJwk"]["x"] == ED25519_ZERO_SEED_X
    assert dc.ed25519_public_key_to_multikey(dc.ub64url(pair["publicJwk"]["x"])) == ED25519_ZERO_SEED_MULTIKEY
    assert dc.b64url(signature) == ED25519_ZERO_SEED_SIGNATURE


def test_ed25519_verification_rejects_what_it_should():
    pair = dc.generate_ed25519_jwk(bytes(32))
    other = dc.generate_ed25519_jwk(bytes([1] * 32))
    signature = dc.sign_ed25519(b"hello", pair["privateJwk"])

    assert dc.verify_ed25519(b"hello", signature, pair["publicJwk"]) is True
    assert dc.verify_ed25519(b"goodbye", signature, pair["publicJwk"]) is False
    assert dc.verify_ed25519(b"hello", signature, other["publicJwk"]) is False
    assert dc.verify_ed25519(b"hello", b"short", pair["publicJwk"]) is False


def test_multikey_rejects_another_curve():
    import pytest

    x25519 = dc.bytes_to_multibase(bytes([dc.MULTICODEC_X25519_PUB, 0x01]) + bytes(32))

    with pytest.raises(ValueError, match="Ed25519"):
        dc.multikey_to_ed25519_public_key(x25519)


# The BIP39 test mnemonic and the keys the TypeScript keymaster derives for these
# paths. A third-party SLIP-0010 wallet can check them against its own derivation,
# which is the point of moving off the previous custom scheme.
SLIP10_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
SLIP10_ASSERTION_X = "2MESnYkKQoS3HGNxZIrvf7jYWCzu_8i202PDOUdE_Gg"
SLIP10_AGREEMENT_X = "NoQVOtv9-xeZWgAxgNWlddNDb_aTfPA0Hgen80qg2is"


def test_slip10_derivation_matches_the_typescript_keymaster():
    from keymaster.crypto import bip39_seed_from_mnemonic, slip10_ed25519_bytes

    seed = bip39_seed_from_mnemonic(SLIP10_MNEMONIC)
    assertion = dc.generate_ed25519_jwk(slip10_ed25519_bytes(seed, "m/44'/0'/0'/2'/0'"))
    agreement = dc.generate_x25519_jwk(
        dc.ed25519_seed_to_x25519(slip10_ed25519_bytes(seed, "m/44'/0'/0'/1'/0'"))
    )

    assert assertion["publicJwk"]["x"] == SLIP10_ASSERTION_X
    assert agreement["publicJwk"]["x"] == SLIP10_AGREEMENT_X


def test_slip10_ed25519_matches_the_published_vector():
    """SLIP-0010 test vector 1, so the ladder itself is pinned and not just our
    agreement with ourselves."""
    from keymaster.crypto import slip10_ed25519_bytes

    seed = bytes.fromhex("000102030405060708090a0b0c0d0e0f")

    assert slip10_ed25519_bytes(seed, "m/0'").hex() == (
        "68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3"
    )
    assert slip10_ed25519_bytes(seed, "m/0'/1'/2'/2'/1000000000'").hex() == (
        "8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793"
    )


def test_ed25519_torsion_divergence():
    """Pins this port's small-order behaviour: OpenSSL accepts the identity
    point but rejects an order-2 key (R = identity, S = 0). The JS port accepts
    both -- the documented divergence, guarded by tests/cipher/ed25519.test.ts."""
    from keymaster import didcomm_crypto as dc

    signature = bytes([1] + [0] * 31) + bytes(32)  # R = identity, S = 0
    identity = bytes([1] + [0] * 31)
    order2 = bytes.fromhex("ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f")

    def verify(key: bytes) -> bool:
        return dc.verify_ed25519(b"any message", signature, {"kty": "OKP", "crv": "Ed25519", "x": dc.b64url(key)})

    assert verify(identity) is True
    # Order-2 is where the ports diverge: rejected here, accepted by noble.
    assert verify(order2) is False
