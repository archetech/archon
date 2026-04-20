from __future__ import annotations

from base64 import b64decode, b64encode, urlsafe_b64decode, urlsafe_b64encode
import hashlib
import json
import os
from typing import Any

from bip_utils import Bip32Secp256k1, Bip39SeedGenerator
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec, utils
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
import jcs
from mnemonic import Mnemonic


ENC_ITER_DEFAULT = 100_000
IV_LEN = 12
SALT_LEN = 16
TAG_LEN = 16


def b64(data: bytes) -> str:
    return b64encode(data).decode("ascii")


def ub64(value: str) -> bytes:
    return b64decode(value.encode("ascii"))


def b64url(data: bytes) -> str:
    return urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def ub64url(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return urlsafe_b64decode((value + padding).encode("ascii"))


def get_iterations() -> int:
    raw = os.environ.get("PBKDF2_ITERATIONS")
    if raw:
        try:
            parsed = int(raw)
            if parsed > 0:
                return parsed
        except ValueError:
            pass
    return ENC_ITER_DEFAULT


def generate_mnemonic() -> str:
    return Mnemonic("english").generate(strength=128)


def hd_root_from_mnemonic(mnemonic: str) -> Bip32Secp256k1:
    seed = Bip39SeedGenerator(mnemonic).Generate()
    return Bip32Secp256k1.FromSeed(seed)


def derive_private_key_bytes(root: Bip32Secp256k1, path: str) -> bytes:
    return root.DerivePath(path).PrivateKey().Raw().ToBytes()


def private_key_to_jwk_pair(private_key_bytes: bytes) -> dict[str, dict[str, str]]:
    private_key = ec.derive_private_key(int.from_bytes(private_key_bytes, "big"), ec.SECP256K1())
    public_numbers = private_key.public_key().public_numbers()
    x = public_numbers.x.to_bytes(32, "big")
    y = public_numbers.y.to_bytes(32, "big")
    public_jwk = {
        "kty": "EC",
        "crv": "secp256k1",
        "x": b64url(x),
        "y": b64url(y),
    }
    private_jwk = {**public_jwk, "d": b64url(private_key_bytes)}
    return {"publicJwk": public_jwk, "privateJwk": private_jwk}


def jwk_to_public_key(jwk: dict[str, str]) -> ec.EllipticCurvePublicKey:
    public_numbers = ec.EllipticCurvePublicNumbers(
        int.from_bytes(ub64url(jwk["x"]), "big"),
        int.from_bytes(ub64url(jwk["y"]), "big"),
        ec.SECP256K1(),
    )
    return public_numbers.public_key()


def jwk_to_private_key(jwk: dict[str, str]) -> ec.EllipticCurvePrivateKey:
    return ec.derive_private_key(int.from_bytes(ub64url(jwk["d"]), "big"), ec.SECP256K1())


def convert_jwk_to_compressed_bytes(jwk: dict[str, str]) -> bytes:
    x_bytes = ub64url(jwk["x"])
    y_bytes = ub64url(jwk["y"])
    prefix = b"\x02" if y_bytes[-1] % 2 == 0 else b"\x03"
    return prefix + x_bytes


def canonicalize_json(value: Any) -> bytes:
    canonical = jcs.canonicalize(value)
    if isinstance(canonical, bytes):
        return canonical
    return canonical.encode("utf-8")


def hash_message(message: str | bytes) -> str:
    data = message.encode("utf-8") if isinstance(message, str) else message
    return hashlib.sha256(data).hexdigest()


def hash_json(value: Any) -> str:
    return hash_message(canonicalize_json(value))


def sign_hash(msg_hash: str, private_jwk: dict[str, str]) -> str:
    private_key = jwk_to_private_key(private_jwk)
    der = private_key.sign(bytes.fromhex(msg_hash), ec.ECDSA(utils.Prehashed(hashes.SHA256())))
    r, s = utils.decode_dss_signature(der)
    return (r.to_bytes(32, "big") + s.to_bytes(32, "big")).hex()


def verify_sig(msg_hash: str, sig_hex: str, public_jwk: dict[str, str]) -> bool:
    if len(sig_hex) != 128:
        return False
    raw = bytes.fromhex(sig_hex)
    r = int.from_bytes(raw[:32], "big")
    s = int.from_bytes(raw[32:], "big")
    der = utils.encode_dss_signature(r, s)
    public_key = jwk_to_public_key(public_jwk)
    try:
        public_key.verify(der, bytes.fromhex(msg_hash), ec.ECDSA(utils.Prehashed(hashes.SHA256())))
        return True
    except Exception:
        return False


def encrypt_with_passphrase(plaintext: str, password: str) -> dict[str, str]:
    salt = os.urandom(SALT_LEN)
    iv = os.urandom(IV_LEN)
    key = hashlib.pbkdf2_hmac("sha512", password.encode("utf-8"), salt, get_iterations(), dklen=32)
    data = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    return {"salt": b64(salt), "iv": b64(iv), "data": b64(data)}


def decrypt_with_passphrase(blob: dict[str, str], password: str) -> str:
    salt = ub64(blob["salt"])
    iv = ub64(blob["iv"])
    data = ub64(blob["data"])
    key = hashlib.pbkdf2_hmac("sha512", password.encode("utf-8"), salt, get_iterations(), dklen=32)
    plaintext = AESGCM(key).decrypt(iv, data, None)
    return plaintext.decode("utf-8")


def concat_kdf(shared_secret: bytes, key_bit_length: int, algorithm_id: str, apu: bytes = b"", apv: bytes = b"") -> bytes:
    alg_id_bytes = algorithm_id.encode("utf-8")
    other_info = b"".join(
        [
            len(alg_id_bytes).to_bytes(4, "big"), alg_id_bytes,
            len(apu).to_bytes(4, "big"), apu,
            len(apv).to_bytes(4, "big"), apv,
            key_bit_length.to_bytes(4, "big"),
        ]
    )

    reps = (key_bit_length + 255) // 256
    result = bytearray()
    for counter in range(1, reps + 1):
        digest = hashlib.sha256(counter.to_bytes(4, "big") + shared_secret + other_info).digest()
        result.extend(digest)
    return bytes(result[: key_bit_length // 8])


def build_jwe_compact(recipient_pub_jwk: dict[str, str], plaintext: bytes) -> str:
    ephemeral_private = ec.generate_private_key(ec.SECP256K1())
    epk_numbers = ephemeral_private.public_key().public_numbers()
    header = {
        "alg": "ECDH-ES",
        "enc": "A256GCM",
        "epk": {
            "kty": "EC",
            "crv": "secp256k1",
            "x": b64url(epk_numbers.x.to_bytes(32, "big")),
            "y": b64url(epk_numbers.y.to_bytes(32, "big")),
        },
    }
    header_b64 = b64url(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    shared_secret = ephemeral_private.exchange(ec.ECDH(), jwk_to_public_key(recipient_pub_jwk))
    cek = concat_kdf(shared_secret, 256, "A256GCM")
    iv = os.urandom(IV_LEN)
    encrypted = AESGCM(cek).encrypt(iv, plaintext, header_b64.encode("ascii"))
    ciphertext = encrypted[:-TAG_LEN]
    tag = encrypted[-TAG_LEN:]
    return ".".join([header_b64, "", b64url(iv), b64url(ciphertext), b64url(tag)])


def parse_jwe_compact(recipient_priv_jwk: dict[str, str], jwe_compact: str) -> bytes:
    parts = jwe_compact.split(".")
    if len(parts) != 5:
        raise ValueError("Invalid JWE Compact: expected 5 segments")
    header_b64, _, iv_b64, ciphertext_b64, tag_b64 = parts
    header = json.loads(ub64url(header_b64).decode("utf-8"))
    epk = header["epk"]
    shared_secret = jwk_to_private_key(recipient_priv_jwk).exchange(ec.ECDH(), jwk_to_public_key(epk))
    cek = concat_kdf(shared_secret, 256, "A256GCM")
    iv = ub64url(iv_b64)
    ciphertext = ub64url(ciphertext_b64)
    tag = ub64url(tag_b64)
    return AESGCM(cek).decrypt(iv, ciphertext + tag, header_b64.encode("ascii"))


def is_jwe_compact(ciphertext: str) -> bool:
    return ciphertext.startswith("eyJ") and ciphertext.count(".") == 4


def encrypt_message(recipient_pub_jwk: dict[str, str], message: str) -> str:
    return build_jwe_compact(recipient_pub_jwk, message.encode("utf-8"))


def decrypt_message(recipient_priv_jwk: dict[str, str], ciphertext: str) -> str:
    return parse_jwe_compact(recipient_priv_jwk, ciphertext).decode("utf-8")