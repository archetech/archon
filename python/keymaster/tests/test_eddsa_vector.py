"""The published W3C test vectors for eddsa-jcs-2022.

From the Verifiable Credential Data Integrity EdDSA cryptosuites,
https://www.w3.org/TR/vc-di-eddsa/ examples 29, 30, 33 and 38.

This is the only check in the Python suite that is not Archon verifying Archon.
The proof was produced by the specification's own implementation, so it fails if
this port's payload assembly differs from the spec in any respect -- key
encoding, canonicalization, digest order, or signature encoding. Mirrors
tests/cipher/eddsa-jcs-2022-vector.test.ts, which does the same for the
JavaScript port; a divergence between the two would otherwise be invisible,
since each port only ever verifies what it signed.
"""

from keymaster import didcomm_crypto as dc
from keymaster.crypto import hash_json

UNSIGNED = {
    "@context": [
        "https://www.w3.org/ns/credentials/v2",
        "https://www.w3.org/ns/credentials/examples/v2",
    ],
    "id": "urn:uuid:58172aac-d8ba-11ed-83dd-0b3aef56cc33",
    "type": ["VerifiableCredential", "AlumniCredential"],
    "name": "Alumni Credential",
    "description": "A minimum viable example of an Alumni Credential.",
    "issuer": "https://vc.example/issuers/5678",
    "validFrom": "2023-01-01T00:00:00Z",
    "credentialSubject": {"id": "did:example:abcdefgh", "alumniOf": "The School of Examples"},
}

PROOF_CONFIG = {
    "type": "DataIntegrityProof",
    "cryptosuite": "eddsa-jcs-2022",
    "created": "2023-02-24T23:36:38Z",
    "verificationMethod": (
        "did:key:z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"
        "#z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"
    ),
    "proofPurpose": "assertionMethod",
    "@context": [
        "https://www.w3.org/ns/credentials/v2",
        "https://www.w3.org/ns/credentials/examples/v2",
    ],
}

PUBLIC_KEY_MULTIBASE = "z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2"
PROOF_VALUE = "z2HnFSSPPBzR36zdDgK8PbEHeXbR56YF24jwMpt3R1eHXQzJDMWS93FCzpvJpwTWd3GAVFuUfjoJdcnTMuVor51aX"


def _payload(config, document):
    """sha256 of the canonical proof config, then of the canonical document."""
    return bytes.fromhex(hash_json(config) + hash_json(document))


def _public_jwk():
    return {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": dc.b64url(dc.multikey_to_ed25519_public_key(PUBLIC_KEY_MULTIBASE)),
    }


def _verify(payload):
    return dc.verify_ed25519(payload, dc.multibase_to_bytes(PROOF_VALUE), _public_jwk())


def test_verifies_a_proof_this_codebase_did_not_produce():
    assert _verify(_payload(PROOF_CONFIG, UNSIGNED)) is True


# Each of these is a way the payload could be assembled wrong while still
# round-tripping against itself.
def test_fails_if_the_document_is_altered():
    altered = {**UNSIGNED, "credentialSubject": {**UNSIGNED["credentialSubject"], "alumniOf": "Elsewhere"}}

    assert _verify(_payload(PROOF_CONFIG, altered)) is False


def test_fails_if_the_proof_config_is_dropped_from_the_payload():
    assert _verify(bytes.fromhex(hash_json(UNSIGNED))) is False


def test_fails_if_the_two_digests_are_concatenated_the_other_way_round():
    assert _verify(_payload(UNSIGNED, PROOF_CONFIG)) is False


def test_fails_if_the_config_keeps_a_proof_value_that_was_not_signed():
    assert _verify(_payload({**PROOF_CONFIG, "proofValue": PROOF_VALUE}, UNSIGNED)) is False
