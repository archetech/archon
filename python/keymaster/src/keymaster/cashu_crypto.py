"""Cashu's cryptography and token formats, matching cashu-ts byte for byte.

Checked against the NUT specification vectors and committed cashu-ts output
(tests/fixtures/cashu-*-vectors.json). The TypeScript port uses cashu-ts itself;
no maintained Python library covers this, so it is implemented here over
coincurve, as didcomm_crypto.py is for DIDComm.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from typing import Any

import cbor2
from bip_utils import Bip32Secp256k1
from coincurve import PrivateKey, PublicKey, PublicKeyXOnly

CURVE_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
HASH_TO_CURVE_DOMAIN = b"Secp256k1_HashToCurve_Cashu_"
HMAC_KDF_DOMAIN = b"Cashu_KDF_HMAC_SHA256"
TOKEN_URI_PREFIXES = ("web+cashu://", "cashu://", "cashu:")


class CashuTokenError(ValueError):
    pass


def hash_to_curve(message: bytes) -> PublicKey:
    digest = hashlib.sha256(HASH_TO_CURVE_DOMAIN + message).digest()
    for counter in range(2**16):
        candidate = hashlib.sha256(digest + counter.to_bytes(4, "little")).digest()
        try:
            return PublicKey(b"\x02" + candidate)
        except ValueError:
            continue
    raise ValueError("No valid point found")


def proof_y(secret: str) -> str:
    return hash_to_curve(secret.encode()).format(compressed=True).hex()


def _scalar_bytes(scalar: int) -> bytes:
    return (scalar % CURVE_ORDER).to_bytes(32, "big")


def _base_point_times(scalar: int) -> PublicKey:
    return PublicKey.from_secret(_scalar_bytes(scalar))


def blind(secret: bytes, r: int) -> str:
    point = PublicKey.combine_keys([hash_to_curve(secret), _base_point_times(r)])
    return point.format(compressed=True).hex()


def blind_sign(blinded: str, private_key: bytes) -> str:
    return PublicKey(bytes.fromhex(blinded)).multiply(private_key).format(compressed=True).hex()


def unblind(blind_signature: str, r: int, mint_public_key: str) -> str:
    # C = C_ - rA, written as C_ + (n - r)A.
    negated = PublicKey(bytes.fromhex(mint_public_key)).multiply(_scalar_bytes(CURVE_ORDER - r))
    point = PublicKey.combine_keys([PublicKey(bytes.fromhex(blind_signature)), negated])
    return point.format(compressed=True).hex()


def hash_e(*points: PublicKey) -> bytes:
    joined = "".join(point.format(compressed=False).hex() for point in points)
    return hashlib.sha256(joined.encode()).digest()


def _scalar_field(value: Any) -> bytes:
    """A 32-byte scalar from a token or a mint, which may hold anything."""
    if not isinstance(value, str):
        raise ValueError("scalar must be a hex string")
    raw = bytes.fromhex(value)
    if len(raw) != 32:
        raise ValueError("scalar must be 32 bytes")
    return raw


def verify_dleq(e_hex: str, s_hex: str, blinded: str, signature: str, mint_public_key: str) -> bool:
    """NUT-12: R1 = sG - eA, R2 = sB_ - eC_, and e = hash(R1, R2, A, C_)."""
    try:
        e = _scalar_field(e_hex)
        s = _scalar_field(s_hex)
        negated_e = _scalar_bytes(CURVE_ORDER - int.from_bytes(e, "big"))
        A = PublicKey(bytes.fromhex(mint_public_key))
        B_ = PublicKey(bytes.fromhex(blinded))
        C_ = PublicKey(bytes.fromhex(signature))
        R1 = PublicKey.combine_keys([PublicKey.from_secret(s), A.multiply(negated_e)])
        R2 = PublicKey.combine_keys([B_.multiply(s), C_.multiply(negated_e)])
    except ValueError:
        return False
    return hmac.compare_digest(hash_e(R1, R2, A, C_), e)


def verify_proof_dleq(proof: dict[str, Any], mint_public_key: str) -> bool:
    """A proof's DLEQ, reblinding it with the r the sender included."""
    dleq = proof.get("dleq") or {}
    if not all(isinstance(dleq.get(field), str) for field in ("e", "s", "r")):
        return False
    try:
        r = int.from_bytes(_scalar_field(dleq["r"]), "big")
        A = PublicKey(bytes.fromhex(mint_public_key))
        blinded = blind(proof["secret"].encode(), r)
        point = PublicKey.combine_keys([PublicKey(bytes.fromhex(proof["C"])), A.multiply(_scalar_bytes(r))])
    except ValueError:
        return False
    return verify_dleq(dleq["e"], dleq["s"], blinded, point.format(compressed=True).hex(), mint_public_key)


def create_dleq(blinded: str, private_key: bytes, nonce: bytes) -> dict[str, str]:
    """A mint's half of NUT-12, used by the test mint. The nonce is its own choice."""
    A = PublicKey.from_secret(private_key)
    R1 = PublicKey.from_secret(nonce)
    B_ = PublicKey(bytes.fromhex(blinded))
    e = hash_e(R1, B_.multiply(nonce), A, B_.multiply(private_key))
    s = (int.from_bytes(nonce, "big") + int.from_bytes(e, "big") * int.from_bytes(private_key, "big")) % CURVE_ORDER
    return {"e": e.hex(), "s": _scalar_bytes(s).hex()}


def keyset_id_int(keyset_id: str) -> int:
    try:
        raw = int(keyset_id, 16)
    except ValueError:
        # Legacy keysets have base64 ids.
        raw = int.from_bytes(base64.b64decode(keyset_id), "big")
    return raw % (2**31 - 1)


def _is_hmac_keyset(keyset_id: str) -> bool:
    try:
        int(keyset_id, 16)
    except ValueError:
        return False
    return keyset_id.startswith("01")


def derive_secret_and_r(seed: bytes, keyset_id: str, counter: int) -> tuple[str, int]:
    """NUT-13. The secret is the hex string of the derived bytes, used as text."""
    if _is_hmac_keyset(keyset_id):
        message = HMAC_KDF_DOMAIN + bytes.fromhex(keyset_id) + counter.to_bytes(8, "big")
        secret = hmac.new(seed, message + b"\x00", hashlib.sha256).digest()
        factor = int.from_bytes(hmac.new(seed, message + b"\x01", hashlib.sha256).digest(), "big")
        return secret.hex(), factor - CURVE_ORDER if factor >= CURVE_ORDER else factor

    node = Bip32Secp256k1.FromSeed(seed).DerivePath(f"m/129372'/0'/{keyset_id_int(keyset_id)}'/{counter}'")
    secret = node.ChildKey(0).PrivateKey().Raw().ToBytes()
    factor = node.ChildKey(1).PrivateKey().Raw().ToBytes()
    return secret.hex(), int.from_bytes(factor, "big")


def _mint_quote_digest(quote: str, blinded: list[dict[str, Any]]) -> bytes:
    return hashlib.sha256((quote + "".join(output["B_"] for output in blinded)).encode()).digest()


def sign_mint_quote(private_key_hex: str, quote: str, blinded: list[dict[str, Any]]) -> str:
    return PrivateKey(bytes.fromhex(private_key_hex)).sign_schnorr(_mint_quote_digest(quote, blinded)).hex()


def verify_mint_quote(public_key_hex: str, quote: str, blinded: list[dict[str, Any]], signature_hex: str) -> bool:
    try:
        key = PublicKeyXOnly(bytes.fromhex(public_key_hex)[1:])
        return key.verify(bytes.fromhex(signature_hex), _mint_quote_digest(quote, blinded))
    except ValueError:
        return False


def new_secret_key() -> bytes:
    return PrivateKey().secret


def public_key_hex(private_key: bytes) -> str:
    return PublicKey.from_secret(private_key).format(compressed=True).hex()


def _hex_field(value: Any, label: str) -> str:
    if not isinstance(value, (bytes, bytearray)) or len(value) == 0:
        raise CashuTokenError(f"Invalid token: {label} must be a non-empty byte string")
    return bytes(value).hex()


def _text_field(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value:
        raise CashuTokenError(f"Invalid token: {label} must be a non-empty string")
    try:
        value.encode()
    except UnicodeEncodeError as exc:
        raise CashuTokenError(f"Invalid token: {label} is not valid text") from exc
    return value


def _amount_field(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CashuTokenError("Invalid token: amount")
    return value


def _decode_base64url(data: str) -> bytes:
    normalized = data.replace("-", "+").replace("_", "/").rstrip("=")
    try:
        return base64.b64decode(normalized + "=" * (-len(normalized) % 4), validate=True)
    except ValueError as exc:
        raise CashuTokenError("Invalid token: not base64") from exc


def _decode_v3(payload: str) -> dict[str, Any]:
    try:
        token = json.loads(_decode_base64url(payload))
    except (ValueError, RecursionError) as exc:
        raise CashuTokenError("Invalid token") from exc
    entries = token.get("token") if isinstance(token, dict) else None
    if not isinstance(entries, list) or len(entries) != 1:
        raise CashuTokenError("Invalid token")
    entry = entries[0]
    if not isinstance(entry, dict) or not isinstance(entry.get("proofs"), list):
        raise CashuTokenError("Invalid token")
    proofs = []
    for raw in entry["proofs"]:
        if not isinstance(raw, dict):
            raise CashuTokenError("Invalid token")
        proof = {
            "id": _text_field(raw.get("id"), "keyset id"),
            "amount": _amount_field(raw.get("amount")),
            "secret": _text_field(raw.get("secret"), "secret"),
            "C": _text_field(raw.get("C"), "proof C"),
        }
        dleq = raw.get("dleq")
        if isinstance(dleq, dict) and dleq.get("e") and dleq.get("s") and dleq.get("r"):
            proof["dleq"] = {"e": dleq["e"], "s": dleq["s"], "r": dleq["r"]}
        proofs.append(proof)
    decoded = {"mint": _text_field(entry.get("mint"), "mint"), "proofs": proofs, "unit": token.get("unit") or "sat"}
    if token.get("memo"):
        decoded["memo"] = token["memo"]
    return decoded


def _decode_v4(payload: str) -> dict[str, Any]:
    try:
        token = cbor2.loads(_decode_base64url(payload))
    except (cbor2.CBORDecodeError, ValueError, TypeError, OverflowError, RecursionError) as exc:
        raise CashuTokenError("Invalid token") from exc
    if not isinstance(token, dict) or not isinstance(token.get("t"), list):
        raise CashuTokenError("Invalid token")
    proofs = []
    for group in token["t"]:
        if not isinstance(group, dict) or not isinstance(group.get("p"), list):
            raise CashuTokenError("Invalid token")
        for raw in group["p"]:
            if not isinstance(raw, dict):
                raise CashuTokenError("Invalid token")
            proof = {
                "id": _hex_field(group.get("i"), "keyset id"),
                "amount": _amount_field(raw.get("a")),
                "secret": _text_field(raw.get("s"), "secret"),
                "C": _hex_field(raw.get("c"), "proof C"),
            }
            dleq = raw.get("d")
            if isinstance(dleq, dict) and dleq.get("e") and dleq.get("s") and dleq.get("r"):
                proof["dleq"] = {
                    "e": _hex_field(dleq["e"], "dleq e"),
                    "s": _hex_field(dleq["s"], "dleq s"),
                    "r": _hex_field(dleq["r"], "dleq r"),
                }
            proofs.append(proof)
    decoded = {"mint": _text_field(token.get("m"), "mint"), "proofs": proofs, "unit": token.get("u") or "sat"}
    if token.get("d"):
        decoded["memo"] = _text_field(token["d"], "memo")
    return decoded


def decode_token(token: str) -> dict[str, Any]:
    """Either format, with V4 keyset ids still short. See resolve_keyset_ids."""
    if not isinstance(token, str):
        raise CashuTokenError("Invalid token")
    for prefix in TOKEN_URI_PREFIXES:
        if token.startswith(prefix):
            token = token[len(prefix):]
            break
    if not token.startswith("cashu"):
        raise CashuTokenError("Token version is not supported")
    body = token[len("cashu"):]
    if body.startswith("A"):
        return _decode_v3(body[1:])
    if body.startswith("B"):
        return _decode_v4(body[1:])
    raise CashuTokenError("Token version is not supported")


def resolve_keyset_ids(proofs: list[dict[str, Any]], keyset_ids: list[str]) -> list[dict[str, Any]]:
    """A V4 token may carry a short id; an ambiguous one rejects it (NUT-00)."""
    known = {keyset.lower() for keyset in keyset_ids}
    resolved = []
    for proof in proofs:
        short = proof["id"].lower()
        if short.startswith("01"):
            matches = [keyset for keyset in known if keyset.startswith(short)]
            if len(matches) != 1:
                raise CashuTokenError(f"Cannot resolve short keyset id {short}")
            proof = {**proof, "id": matches[0]}
        resolved.append(proof)
    return resolved


def encode_token(mint: str, unit: str, proofs: list[dict[str, Any]]) -> str:
    """A cashuB token. Key order and id truncation match cashu-ts, so the bytes do."""
    groups: dict[str, list[dict[str, Any]]] = {}
    for proof in proofs:
        entry: dict[str, Any] = {"a": proof["amount"], "s": proof["secret"], "c": bytes.fromhex(proof["C"])}
        dleq = proof.get("dleq")
        if dleq:
            entry["d"] = {field: bytes.fromhex(dleq[field]) for field in ("e", "s", "r")}
        groups.setdefault(proof["id"][:16], []).append(entry)
    token = {"m": mint, "u": unit, "t": [{"i": bytes.fromhex(keyset), "p": entries} for keyset, entries in groups.items()]}
    return "cashuB" + base64.urlsafe_b64encode(cbor2.dumps(token)).decode().rstrip("=")
