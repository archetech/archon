"""DIDComm v2 envelope crypto (Python port of @didcid/cipher's didcomm.ts).

Implements the encrypted (JWE) and signed (JWS) envelopes DIDComm requires, so
the Python Keymaster interoperates byte-for-byte with the TypeScript stack and
the `didcomm`/`didcomm-node` reference library:

  - anoncrypt: ECDH-ES + A256KW
  - authcrypt: ECDH-1PU + A256KW (the content-encryption tag is mixed into the
    Concat-KDF as length-prefixed SuppPrivInfo, per draft-madden-jose-ecdh-1pu)
  - content encryption: A256CBC-HS512 (authcrypt default), XC20P (anoncrypt
    default), A256GCM
  - signed: ES256K (secp256k1) JWS

These are pure functions over raw JWKs — no DID resolution or wallet access.
"""

from __future__ import annotations

import hashlib
import hmac as hmaclib
import json
import os
import struct
from typing import Any

from bip_utils import Base58Decoder, Base58Encoder
from cryptography.hazmat.primitives.asymmetric.x25519 import (
    X25519PrivateKey,
    X25519PublicKey,
)
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM, ChaCha20Poly1305
from cryptography.hazmat.primitives.keywrap import aes_key_unwrap, aes_key_wrap
from cryptography.hazmat.primitives.padding import PKCS7

from .crypto import b64url, sign_hash, ub64url, verify_sig

DIDCOMM_ENC_VALUES = ("A256CBC-HS512", "XC20P", "A256GCM")
DIDCOMM_FORWARD_TYPE = "https://didcomm.org/routing/2.0/forward"

# Multicodec varint prefixes for did:key multibase material.
_MULTICODEC_X25519_PUB = 0xEC  # followed by 0x01
_MULTICODEC_ED25519_PUB = 0xED  # followed by 0x01


# ---------------------------------------------------------------------------
# byte / json helpers
# ---------------------------------------------------------------------------

def _b64u_json(obj: Any) -> str:
    return b64url(json.dumps(obj, separators=(",", ":")).encode("utf-8"))


def _sha256(data: bytes) -> bytes:
    return hashlib.sha256(data).digest()


# --- XChaCha20-Poly1305 (no libsodium/PyNaCl) -------------------------------
# XChaCha20-Poly1305-IETF: derive a subkey with HChaCha20 over the first 16
# nonce bytes, then run IETF ChaCha20-Poly1305 (from `cryptography`) with the
# subkey and a 12-byte nonce of (0x00000000 || last 8 nonce bytes). Matches
# libsodium's crypto_aead_xchacha20poly1305_ietf and @noble/ciphers' xchacha.

_CHACHA_CONSTANTS = (0x61707865, 0x3320646E, 0x79622D32, 0x6B206574)


def _rotl32(value: int, count: int) -> int:
    return ((value << count) & 0xFFFFFFFF) | (value >> (32 - count))


def _quarter_round(state: list[int], a: int, b: int, c: int, d: int) -> None:
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF
    state[d] = _rotl32(state[d] ^ state[a], 16)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF
    state[b] = _rotl32(state[b] ^ state[c], 12)
    state[a] = (state[a] + state[b]) & 0xFFFFFFFF
    state[d] = _rotl32(state[d] ^ state[a], 8)
    state[c] = (state[c] + state[d]) & 0xFFFFFFFF
    state[b] = _rotl32(state[b] ^ state[c], 7)


def _hchacha20(key: bytes, nonce16: bytes) -> bytes:
    state = list(_CHACHA_CONSTANTS) + list(struct.unpack("<8I", key)) + list(struct.unpack("<4I", nonce16))
    for _ in range(10):
        _quarter_round(state, 0, 4, 8, 12)
        _quarter_round(state, 1, 5, 9, 13)
        _quarter_round(state, 2, 6, 10, 14)
        _quarter_round(state, 3, 7, 11, 15)
        _quarter_round(state, 0, 5, 10, 15)
        _quarter_round(state, 1, 6, 11, 12)
        _quarter_round(state, 2, 7, 8, 13)
        _quarter_round(state, 3, 4, 9, 14)
    return struct.pack("<8I", *(state[0:4] + state[12:16]))


def _xchacha_nonce12(nonce24: bytes) -> bytes:
    return b"\x00\x00\x00\x00" + nonce24[16:24]


def _xchacha_encrypt(message: bytes, aad: bytes, nonce24: bytes, key: bytes) -> bytes:
    return ChaCha20Poly1305(_hchacha20(key, nonce24[:16])).encrypt(_xchacha_nonce12(nonce24), message, aad)


def _xchacha_decrypt(ciphertext_and_tag: bytes, aad: bytes, nonce24: bytes, key: bytes) -> bytes:
    return ChaCha20Poly1305(_hchacha20(key, nonce24[:16])).decrypt(_xchacha_nonce12(nonce24), ciphertext_and_tag, aad)


# --- Ed25519 -> X25519 public key (birational map, no libsodium) ------------
# Edwards y -> Montgomery u = (1 + y) / (1 - y) mod p, p = 2^255 - 19. Matches
# libsodium's crypto_sign_ed25519_pk_to_curve25519 for well-formed keys.

def _ed25519_pk_to_x25519(ed_public: bytes) -> bytes:
    p = (1 << 255) - 19
    y = int.from_bytes(ed_public, "little") & ((1 << 255) - 1)  # drop the sign bit
    u = ((1 + y) * pow((1 - y) % p, p - 2, p)) % p
    return u.to_bytes(32, "little")


def _x25519_public(seed: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(seed).public_key().public_bytes_raw()


def _x25519_shared(private_seed: bytes, public_bytes: bytes) -> bytes:
    return X25519PrivateKey.from_private_bytes(private_seed).exchange(
        X25519PublicKey.from_public_bytes(public_bytes)
    )


def generate_x25519_jwk(seed: bytes) -> dict[str, dict[str, str]]:
    """Deterministic X25519 JWK pair from a 32-byte seed (matches generateX25519Jwk)."""
    if len(seed) != 32:
        raise ValueError("X25519 seed must be 32 bytes")
    public_bytes = _x25519_public(seed)
    public_jwk = {"kty": "OKP", "crv": "X25519", "x": b64url(public_bytes)}
    private_jwk = {**public_jwk, "d": b64url(seed)}
    return {"publicJwk": public_jwk, "privateJwk": private_jwk}


# ---------------------------------------------------------------------------
# Concat KDF (NIST SP 800-56A / RFC 7518 §4.6.2), with optional SuppPrivInfo
# ---------------------------------------------------------------------------

def _uint32_be(value: int) -> bytes:
    return value.to_bytes(4, "big")


def concat_kdf(
    shared_secret: bytes,
    key_bit_length: int,
    algorithm_id: str,
    apu: bytes = b"",
    apv: bytes = b"",
    supp_priv_info: bytes = b"",
) -> bytes:
    alg_bytes = algorithm_id.encode("utf-8")
    other_info = b"".join(
        [
            _uint32_be(len(alg_bytes)), alg_bytes,
            _uint32_be(len(apu)), apu,
            _uint32_be(len(apv)), apv,
            _uint32_be(key_bit_length),
        ]
        + ([_uint32_be(len(supp_priv_info)), supp_priv_info] if supp_priv_info else [])
    )

    reps = -(-key_bit_length // 256)  # ceil(key_bit_length / 256)
    out = bytearray()
    for counter in range(1, reps + 1):
        out += _sha256(_uint32_be(counter) + shared_secret + other_info)
    return bytes(out[: key_bit_length // 8])


# ---------------------------------------------------------------------------
# Content encryption
# ---------------------------------------------------------------------------

def _cek_length(enc: str) -> int:
    return 64 if enc == "A256CBC-HS512" else 32


def _a256cbc_hs512_tag(mac_key: bytes, aad: bytes, iv: bytes, ciphertext: bytes) -> bytes:
    al = (len(aad) * 8).to_bytes(8, "big")
    return hmaclib.new(mac_key, aad + iv + ciphertext + al, hashlib.sha512).digest()[:32]


def _content_encrypt(enc: str, cek: bytes, plaintext: bytes, aad: bytes) -> tuple[bytes, bytes, bytes]:
    if enc == "A256CBC-HS512":
        mac_key, enc_key = cek[:32], cek[32:64]
        iv = os.urandom(16)
        padder = PKCS7(128).padder()
        padded = padder.update(plaintext) + padder.finalize()
        encryptor = Cipher(algorithms.AES(enc_key), modes.CBC(iv)).encryptor()
        ciphertext = encryptor.update(padded) + encryptor.finalize()
        return iv, ciphertext, _a256cbc_hs512_tag(mac_key, aad, iv, ciphertext)
    if enc == "XC20P":
        iv = os.urandom(24)
        out = _xchacha_encrypt(plaintext, aad, iv, cek)
        return iv, out[:-16], out[-16:]
    if enc == "A256GCM":
        iv = os.urandom(12)
        out = AESGCM(cek).encrypt(iv, plaintext, aad)
        return iv, out[:-16], out[-16:]
    raise ValueError(f"Unsupported DIDComm enc: {enc}")


def _content_decrypt(enc: str, cek: bytes, iv: bytes, ciphertext: bytes, tag: bytes, aad: bytes) -> bytes:
    if enc == "A256CBC-HS512":
        mac_key, enc_key = cek[:32], cek[32:64]
        expected = _a256cbc_hs512_tag(mac_key, aad, iv, ciphertext)
        if not hmaclib.compare_digest(expected, tag):
            raise ValueError("A256CBC-HS512: authentication tag mismatch")
        decryptor = Cipher(algorithms.AES(enc_key), modes.CBC(iv)).decryptor()
        padded = decryptor.update(ciphertext) + decryptor.finalize()
        unpadder = PKCS7(128).unpadder()
        return unpadder.update(padded) + unpadder.finalize()
    if enc == "XC20P":
        return _xchacha_decrypt(ciphertext + tag, aad, iv, cek)
    if enc == "A256GCM":
        return AESGCM(cek).decrypt(iv, ciphertext + tag, aad)
    raise ValueError(f"Unsupported DIDComm enc: {enc}")


# ---------------------------------------------------------------------------
# Key agreement
# ---------------------------------------------------------------------------

def _compute_apv(kids: list[str]) -> str:
    return b64url(_sha256(".".join(sorted(kids)).encode("utf-8")))


def _derive_kek(alg: str, shared_secret: bytes, apu: bytes, apv: bytes, tag: bytes = b"") -> bytes:
    return concat_kdf(shared_secret, 256, alg, apu, apv, tag)


# ---------------------------------------------------------------------------
# Encrypted envelope (JWE general serialization)
# ---------------------------------------------------------------------------

def pack_encrypted(
    plaintext: bytes,
    recipients: list[dict[str, Any]],
    sender: dict[str, Any] | None,
    enc: str,
) -> str:
    """recipients: [{kid, publicJwk}]; sender: {kid, privateJwk} or None (anoncrypt)."""
    if not recipients:
        raise ValueError("pack_encrypted: at least one recipient required")

    alg = "ECDH-1PU+A256KW" if sender else "ECDH-ES+A256KW"
    apv_str = _compute_apv([r["kid"] for r in recipients])

    eph_seed = X25519PrivateKey.generate().private_bytes_raw()
    eph_pub = _x25519_public(eph_seed)

    header: dict[str, Any] = {"typ": "application/didcomm-encrypted+json", "alg": alg, "enc": enc}
    if sender:
        header["skid"] = sender["kid"]
        header["apu"] = b64url(sender["kid"].encode("utf-8"))
    header["apv"] = apv_str
    header["epk"] = {"kty": "OKP", "crv": "X25519", "x": b64url(eph_pub)}

    protected_b64 = _b64u_json(header)
    aad = protected_b64.encode("ascii")

    apu = sender["kid"].encode("utf-8") if sender else b""
    apv = ub64url(apv_str)

    cek = os.urandom(_cek_length(enc))
    iv, ciphertext, tag = _content_encrypt(enc, cek, plaintext, aad)

    sender_seed = ub64url(sender["privateJwk"]["d"]) if sender else None

    recipients_out = []
    for r in recipients:
        recip_pub = ub64url(r["publicJwk"]["x"])
        ze = _x25519_shared(eph_seed, recip_pub)
        z = ze + _x25519_shared(sender_seed, recip_pub) if sender_seed else ze
        kek = _derive_kek(alg, z, apu, apv, tag if sender_seed else b"")
        encrypted_key = aes_key_wrap(kek, cek)
        recipients_out.append({"header": {"kid": r["kid"]}, "encrypted_key": b64url(encrypted_key)})

    return json.dumps(
        {
            "protected": protected_b64,
            "recipients": recipients_out,
            "iv": b64url(iv),
            "ciphertext": b64url(ciphertext),
            "tag": b64url(tag),
        },
        separators=(",", ":"),
    )


def unpack_encrypted(
    packed: str,
    recipient: dict[str, Any],
    sender_public_jwk: dict[str, str] | None = None,
) -> tuple[bytes, dict[str, Any]]:
    """recipient: {kid, privateJwk}. Returns (plaintext, protected_header)."""
    jwe = json.loads(packed)
    header = json.loads(ub64url(jwe["protected"]))
    enc = header["enc"]

    is_authcrypt = header["alg"] == "ECDH-1PU+A256KW"
    if not is_authcrypt and header["alg"] != "ECDH-ES+A256KW":
        raise ValueError(f"Unsupported DIDComm alg: {header['alg']}")
    if is_authcrypt and not sender_public_jwk:
        raise ValueError("authcrypt message requires the sender public key")

    match = next((r for r in jwe["recipients"] if r["header"]["kid"] == recipient["kid"]), None)
    if not match:
        raise ValueError(f"No recipient entry for kid {recipient['kid']}")

    recip_seed = ub64url(recipient["privateJwk"]["d"])
    eph_pub = ub64url(header["epk"]["x"])
    ze = _x25519_shared(recip_seed, eph_pub)
    z = ze + _x25519_shared(recip_seed, ub64url(sender_public_jwk["x"])) if is_authcrypt else ze

    apu = ub64url(header["apu"]) if header.get("apu") else b""
    apv = ub64url(header["apv"]) if header.get("apv") else b""
    tag_bytes = ub64url(jwe["tag"])
    kek = _derive_kek(header["alg"], z, apu, apv, tag_bytes if is_authcrypt else b"")
    cek = aes_key_unwrap(kek, ub64url(match["encrypted_key"]))

    aad = jwe["protected"].encode("ascii")
    plaintext = _content_decrypt(enc, cek, ub64url(jwe["iv"]), ub64url(jwe["ciphertext"]), tag_bytes, aad)
    return plaintext, header


# ---------------------------------------------------------------------------
# Signed envelope (JWS general serialization), ES256K (secp256k1)
# ---------------------------------------------------------------------------

def sign_jws(payload: bytes, signer: dict[str, Any]) -> str:
    """signer: {kid, privateJwk}."""
    protected_b64 = _b64u_json({"typ": "application/didcomm-signed+json", "alg": "ES256K"})
    payload_b64 = b64url(payload)
    signing_input = f"{protected_b64}.{payload_b64}".encode("ascii")
    sig_hex = sign_hash(_sha256(signing_input).hex(), signer["privateJwk"])
    return json.dumps(
        {
            "payload": payload_b64,
            "signatures": [
                {"protected": protected_b64, "header": {"kid": signer["kid"]}, "signature": b64url(bytes.fromhex(sig_hex))}
            ],
        },
        separators=(",", ":"),
    )


def verify_jws(jws: str, public_jwk: dict[str, str]) -> dict[str, Any]:
    obj = json.loads(jws)
    sig_entry = obj["signatures"][0]
    signing_input = f"{sig_entry['protected']}.{obj['payload']}".encode("ascii")
    sig_hex = ub64url(sig_entry["signature"]).hex()
    if not verify_sig(_sha256(signing_input).hex(), sig_hex, public_jwk):
        raise ValueError("JWS signature verification failed")
    return {"payload": ub64url(obj["payload"]), "kid": sig_entry.get("header", {}).get("kid")}


# ---------------------------------------------------------------------------
# Message-level pack/unpack: serialize JWM -> optional JWS -> JWE
# ---------------------------------------------------------------------------

def pack_didcomm_message(
    message: dict[str, Any],
    recipients: list[dict[str, Any]],
    sender: dict[str, Any] | None = None,
    signer: dict[str, Any] | None = None,
    enc: str | None = None,
) -> str:
    jwm = json.dumps(message, separators=(",", ":")).encode("utf-8")
    payload = sign_jws(jwm, signer).encode("utf-8") if signer else jwm
    chosen_enc = enc or ("A256CBC-HS512" if sender else "XC20P")
    return pack_encrypted(payload, recipients, sender, chosen_enc)


def unpack_didcomm_message(
    packed: str,
    recipient: dict[str, Any],
    sender_key: dict[str, str] | None = None,
    signer_key: dict[str, str] | None = None,
) -> dict[str, Any]:
    plaintext, header = unpack_encrypted(packed, recipient, sender_key)
    text = plaintext.decode("utf-8")
    inner = json.loads(text)
    authenticated = header["alg"] == "ECDH-1PU+A256KW"

    if isinstance(inner, dict) and inner.get("signatures"):
        if not signer_key:
            raise ValueError("signed message requires the signer public key to verify")
        result = verify_jws(text, signer_key)
        return {
            "message": json.loads(result["payload"].decode("utf-8")),
            "metadata": {
                "encrypted": True,
                "authenticated": authenticated,
                "nonRepudiation": True,
                "sender": header.get("skid"),
                "signer": result["kid"],
            },
        }
    return {
        "message": inner,
        "metadata": {
            "encrypted": True,
            "authenticated": authenticated,
            "nonRepudiation": False,
            "sender": header.get("skid"),
        },
    }


# ---------------------------------------------------------------------------
# Envelope inspection
# ---------------------------------------------------------------------------

def get_envelope_info(packed: str) -> dict[str, Any]:
    try:
        obj = json.loads(packed)
    except (ValueError, TypeError):
        return {"type": "plaintext"}
    if isinstance(obj, dict) and obj.get("ciphertext") and obj.get("recipients"):
        header = json.loads(ub64url(obj["protected"]))
        return {
            "type": "encrypted",
            "alg": header.get("alg"),
            "enc": header.get("enc"),
            "skid": header.get("skid"),
            "kids": [r["header"]["kid"] for r in obj["recipients"]],
        }
    if isinstance(obj, dict) and (obj.get("signatures") or obj.get("signature")):
        return {"type": "signed"}
    return {"type": "plaintext"}


# ---------------------------------------------------------------------------
# Routing — DIDComm Forward protocol (routing/2.0)
# ---------------------------------------------------------------------------

def wrap_forward(forwarded_message: str, next_hop: str, routing_key: dict[str, Any]) -> str:
    forward = {
        "id": b64url(os.urandom(16)),
        "typ": "application/didcomm-plain+json",
        "type": DIDCOMM_FORWARD_TYPE,
        "body": {"next": next_hop},
        "attachments": [{"data": {"json": json.loads(forwarded_message)}}],
    }
    return pack_encrypted(json.dumps(forward, separators=(",", ":")).encode("utf-8"), [routing_key], None, "XC20P")


def parse_forward(plaintext: str | dict[str, Any]) -> dict[str, str]:
    msg = json.loads(plaintext) if isinstance(plaintext, str) else plaintext
    if not msg or msg.get("type") != DIDCOMM_FORWARD_TYPE:
        raise ValueError("not a DIDComm Forward message")
    next_hop = msg.get("body", {}).get("next")
    attachments = msg.get("attachments") or [{}]
    json_payload = attachments[0].get("data", {}).get("json")
    if not next_hop or json_payload is None:
        raise ValueError("malformed Forward message")
    return {"next": next_hop, "forwardedMessage": json.dumps(json_payload, separators=(",", ":"))}


# ---------------------------------------------------------------------------
# Cross-method key material: did:key resolution + multibase normalization
# ---------------------------------------------------------------------------

def _x25519_multibase_to_bytes(multibase: str) -> bytes:
    if not multibase.startswith("z"):
        raise ValueError("Unsupported multibase key material")
    decoded = Base58Decoder.Decode(multibase[1:])
    if len(decoded) < 3 or decoded[1] != 0x01:
        raise ValueError("Unsupported multibase key material")
    key = decoded[2:]
    if decoded[0] == _MULTICODEC_X25519_PUB:
        return key
    if decoded[0] == _MULTICODEC_ED25519_PUB:
        return _ed25519_pk_to_x25519(key)  # Ed25519 verification key -> X25519 key agreement
    raise ValueError(f"Unsupported multicodec 0x{decoded[0]:x} (need X25519 or Ed25519)")


def _x25519_bytes_to_multibase(key: bytes) -> str:
    return "z" + Base58Encoder.Encode(bytes([_MULTICODEC_X25519_PUB, 0x01]) + key)


def x25519_jwk_to_did_key(public_jwk: dict[str, str]) -> str:
    return f"did:key:{_x25519_bytes_to_multibase(ub64url(public_jwk['x']))}"


def did_key_to_x25519(did: str) -> dict[str, Any]:
    base = did.split("?")[0].split("#")[0]
    multibase = base[len("did:key:"):]
    if not base.startswith("did:key:") or not multibase.startswith("z"):
        raise ValueError("Not a did:key")
    x25519_key = _x25519_multibase_to_bytes(multibase)
    fragment = _x25519_bytes_to_multibase(x25519_key)
    return {"kid": f"{base}#{fragment}", "publicJwk": {"kty": "OKP", "crv": "X25519", "x": b64url(x25519_key)}}


def normalize_x25519_public_key(vm: dict[str, Any]) -> dict[str, str]:
    jwk = vm.get("publicKeyJwk")
    if jwk:
        if jwk.get("kty") == "OKP" and jwk.get("crv") == "X25519":
            return jwk
        raise ValueError("verification method is not an X25519 JWK")
    multibase = vm.get("publicKeyMultibase")
    if multibase:
        return {"kty": "OKP", "crv": "X25519", "x": b64url(_x25519_multibase_to_bytes(multibase))}
    raise ValueError("verification method has no supported key material")
