from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from bip_utils import Bip39SeedGenerator
from coincurve import PublicKey

from keymaster.cashu_crypto import (
    CashuTokenError,
    blind,
    blind_sign,
    create_dleq,
    decode_token,
    derive_secret_and_r,
    encode_token,
    hash_e,
    hash_to_curve,
    keyset_id_int,
    p2pk_lock,
    p2pk_secret,
    p2pk_witness,
    proof_y,
    public_key_hex,
    resolve_keyset_ids,
    sign_mint_quote,
    unblind,
    verify_dleq,
    verify_mint_quote,
    verify_p2pk_witness,
    verify_proof_dleq,
)

# The same two files drive tests/keymaster/cashu-vectors.test.ts: the published
# NUT vectors, and what cashu-ts produces for fixed inputs.
FIXTURES = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
NUT = json.loads((FIXTURES / "cashu-nut-vectors.json").read_text())
GENERATED = json.loads((FIXTURES / "cashu-generated-vectors.json").read_text())

SEED = Bip39SeedGenerator(GENERATED["mnemonic"]).Generate()


def _plain(proof):
    return {key: proof[key] for key in ("id", "amount", "secret", "C")}


@pytest.mark.parametrize("vector", NUT["nut00"]["hashToCurve"])
def test_hash_to_curve(vector):
    assert hash_to_curve(bytes.fromhex(vector["message"])).format().hex() == vector["point"]


@pytest.mark.parametrize("vector", NUT["nut00"]["blind"])
def test_blind(vector):
    assert blind(bytes.fromhex(vector["x"]), int(vector["r"], 16)) == vector["B_"]


@pytest.mark.parametrize("vector", NUT["nut00"]["sign"])
def test_blind_sign(vector):
    assert blind_sign(vector["B_"], bytes.fromhex(vector["k"])) == vector["C_"]


def test_decodes_v3_tokens_padded_or_not():
    v3 = NUT["nut00"]["tokenV3"]
    assert decode_token(v3["encoded"])["memo"] == v3["decoded"]["memo"]
    for token in [v3["encoded"], *v3["paddedAndNot"]]:
        decoded = decode_token(token)
        assert decoded["mint"] == v3["decoded"]["token"][0]["mint"]
        assert decoded["proofs"] == v3["decoded"]["token"][0]["proofs"]


@pytest.mark.parametrize("token", NUT["nut00"]["tokenV3"]["invalid"])
def test_rejects_v3_tokens_with_a_wrong_prefix(token):
    with pytest.raises(CashuTokenError):
        decode_token(token)


@pytest.mark.parametrize("name", ["single", "multi"])
def test_decodes_v4_tokens(name):
    vector = NUT["nut00"]["tokenV4"][name]
    decoded = decode_token(vector["encoded"])
    assert decoded["mint"] == vector["mint"]
    assert decoded["unit"] == "sat"
    assert decoded.get("memo") == vector.get("memo")
    assert decoded["proofs"] == vector["proofs"]


@pytest.mark.parametrize("token", ["cashuB", "cashuBnot-a-token", "cashuC", "cashuBoWF0gA", "cashuBé", "cashuAé", None])
def test_rejects_malformed_tokens(token):
    with pytest.raises(CashuTokenError):
        proofs = decode_token(token)["proofs"]
        assert proofs


def test_hash_e():
    vector = NUT["nut12"]["hashE"]
    points = [PublicKey(bytes.fromhex(vector[key])) for key in ("R1", "R2", "K", "C_")]
    assert hash_e(*points).hex() == vector["hash"]


@pytest.mark.parametrize("field", ["e", "s"])
@pytest.mark.parametrize("value", ["ff" * 33, "ff" * 31, "zz", 7, None])
def test_rejects_a_dleq_scalar_of_the_wrong_shape(field, value):
    vector = NUT["nut12"]["deterministic"]
    scalars = {"e": vector["e"], "s": vector["s"], field: value}
    assert not verify_dleq(scalars["e"], scalars["s"], vector["B_"], vector["C_"], vector["A"])


def test_rejects_a_secret_that_is_not_valid_text():
    payload = '{"token":[{"mint":"https://m","proofs":[{"id":"00","amount":1,"secret":"\\ud800","C":"02"}]}]}'
    token = "cashuA" + base64.urlsafe_b64encode(payload.encode()).decode()
    with pytest.raises(CashuTokenError):
        decode_token(token)


def test_verifies_dleq_on_a_blind_signature():
    vector = NUT["nut12"]["blindSignature"]
    signature = vector["signature"]
    assert verify_dleq(signature["dleq"]["e"], signature["dleq"]["s"], vector["B_"], signature["C_"], vector["A"])
    assert not verify_dleq(signature["dleq"]["s"], signature["dleq"]["s"], vector["B_"], signature["C_"], vector["A"])


def test_verifies_the_deterministic_dleq_vector():
    vector = NUT["nut12"]["deterministic"]
    assert verify_dleq(vector["e"], vector["s"], vector["B_"], vector["C_"], vector["A"])


def test_verifies_dleq_on_a_proof():
    vector = NUT["nut12"]["proof"]
    assert verify_proof_dleq(vector["proof"], vector["A"])
    forged = {**vector["proof"], "dleq": {**vector["proof"]["dleq"], "s": vector["proof"]["dleq"]["e"]}}
    assert not verify_proof_dleq(forged, vector["A"])
    assert not verify_proof_dleq({key: value for key, value in vector["proof"].items() if key != "dleq"}, vector["A"])


def test_keyset_id_int():
    vector = NUT["nut13"]["keysetIdInt"]
    assert keyset_id_int(vector["id"]) == vector["int"]


@pytest.mark.parametrize("version", ["v00", "v01"])
def test_derives_secrets_and_blinding_factors(version):
    seed = Bip39SeedGenerator(NUT["nut13"]["mnemonic"]).Generate()
    vector = NUT["nut13"][version]
    for counter, secret in enumerate(vector["secrets"]):
        derived_secret, r = derive_secret_and_r(seed, vector["keyset"], counter)
        assert derived_secret == secret
        assert f"{r:064x}" == vector["rs"][counter]


def test_a_mint_dleq_verifies():
    private_key = bytes(range(1, 33))
    blinded = blind(b"secret", 12345)
    dleq = create_dleq(blinded, private_key, bytes(range(2, 34)))
    assert verify_dleq(dleq["e"], dleq["s"], blinded, blind_sign(blinded, private_key), public_key_hex(private_key))


@pytest.mark.parametrize("version", ["v00", "v01"])
class TestGenerated:
    def test_reproduces_every_output_from_the_mnemonic(self, version):
        vectors = GENERATED[version]
        for output in vectors["outputs"]:
            secret, r = derive_secret_and_r(SEED, vectors["keyset"], output["counter"])
            assert secret == output["secret"]
            assert f"{r:064x}" == output["r"]
            assert blind(secret.encode(), r) == output["B_"]
            assert proof_y(secret) == output["Y"]

            signature = output["signature"]
            assert blind_sign(output["B_"], bytes.fromhex(output["mintKey"])) == signature["C_"]
            assert verify_dleq(signature["dleq"]["e"], signature["dleq"]["s"], output["B_"], signature["C_"], output["mintPublicKey"])
            assert unblind(signature["C_"], r, output["mintPublicKey"]) == output["C"]

    def test_encodes_the_token_byte_for_byte(self, version):
        vectors = GENERATED[version]
        assert encode_token(GENERATED["mint"], "sat", vectors["tokenProofs"]) == vectors["token"]
        stripped = [_plain(proof) for proof in vectors["tokenProofs"]]
        assert encode_token(GENERATED["mint"], "sat", stripped) == vectors["tokenWithoutDleq"]

    def test_decodes_the_token_with_its_dleq_proofs(self, version):
        vectors = GENERATED[version]
        decoded = decode_token(vectors["token"])
        assert decoded["mint"] == GENERATED["mint"]
        proofs = resolve_keyset_ids(decoded["proofs"], [vectors["keyset"]])
        assert proofs == vectors["tokenProofs"]
        for proof, output in zip(proofs, vectors["outputs"]):
            assert verify_proof_dleq(proof, output["mintPublicKey"])

    def test_verifies_and_produces_nut20_signatures(self, version):
        nut20 = GENERATED[version]["nut20"]
        public_key = public_key_hex(bytes.fromhex(nut20["quoteKey"]))
        assert verify_mint_quote(public_key, nut20["quote"], nut20["blinded"], nut20["signature"])
        assert not verify_mint_quote(public_key, nut20["quote"] + "x", nut20["blinded"], nut20["signature"])
        ours = sign_mint_quote(nut20["quoteKey"], nut20["quote"], nut20["blinded"])
        assert verify_mint_quote(public_key, nut20["quote"], nut20["blinded"], ours)


def test_short_keyset_ids():
    full = "01" + "ab" * 32
    proofs = [{"id": full[:16], "amount": 1, "secret": "s", "C": "c"}]
    assert resolve_keyset_ids(proofs, [full])[0]["id"] == full
    with pytest.raises(CashuTokenError):
        resolve_keyset_ids(proofs, [])
    with pytest.raises(CashuTokenError):
        resolve_keyset_ids(proofs, [full, full[:-2] + "cd"])


P2PK = json.loads((Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "cashu-p2pk-vectors.json").read_text())


@pytest.mark.parametrize("field", ["typescriptWitness", "pythonWitness"])
def test_verifies_each_ports_p2pk_witness(field):
    assert verify_p2pk_witness(P2PK["secret"], P2PK[field], P2PK["publicKey"])
    assert not verify_p2pk_witness(P2PK["secret"], P2PK[field], P2PK["refundKey"])
    assert not verify_p2pk_witness(P2PK["secret"] + " ", P2PK[field], P2PK["publicKey"])


def test_reads_p2pk_conditions():
    assert p2pk_lock(P2PK["secret"]) == P2PK["conditions"]
    for other in P2PK["others"]:
        assert p2pk_lock(other["secret"]) == other["conditions"]


@pytest.mark.parametrize("secret", P2PK["plain"])
def test_treats_other_secrets_as_ordinary(secret):
    assert p2pk_lock(secret) is None


def test_refuses_a_spending_condition_it_does_not_implement():
    with pytest.raises(ValueError):
        p2pk_lock(P2PK["unsupported"])


def test_a_new_secret_is_read_back_the_same():
    secret = p2pk_secret(P2PK["publicKey"], 1900000000, P2PK["refundKey"])

    assert p2pk_lock(secret) == P2PK["conditions"]
    assert verify_p2pk_witness(secret, p2pk_witness(secret, P2PK["privateKey"]), P2PK["publicKey"])
