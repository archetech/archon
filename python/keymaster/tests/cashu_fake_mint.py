from __future__ import annotations

import hashlib
import re
import time
from typing import Any

import httpx

from keymaster.cashu_crypto import (
    blind_sign,
    create_dleq,
    hash_to_curve,
    proof_y,
    public_key_hex,
    verify_mint_quote,
)


class MintRefusal(Exception):
    def __init__(self, code: int, detail: str) -> None:
        super().__init__(detail)
        self.code = code


class FakeMint:
    """A mint that really signs, as in tests/keymaster/cashu-fake-mint.ts. Journal
    recovery can only be tested against something that enforces double-spend rules."""

    def __init__(self, input_fee_ppk: int = 0, nuts: list[int] | None = None) -> None:
        self.input_fee_ppk = input_fee_ppk
        self.nuts = nuts if nuts is not None else [4, 5, 7, 8, 9, 12, 20]
        self.private_keys = {
            2**bit: hashlib.sha256(f"fake-mint-{bit}".encode()).digest() for bit in range(16)
        }
        self.public_keys = {str(amount): public_key_hex(key) for amount, key in self.private_keys.items()}
        self.keyset_id = "01" + hashlib.sha256("".join(self.public_keys.values()).encode()).hexdigest()
        self.spent: set[str] = set()
        self.signed: dict[str, dict[str, Any]] = {}
        self.mint_quotes: dict[str, dict[str, Any]] = {}
        self.melt_quotes: dict[str, dict[str, Any]] = {}
        self.requests: list[str] = []
        self.melt_routing_fee = 1
        self.melt_outcome = "PAID"
        # Mints differ here: NUT-00 lists 11003, cdk-mintd sends 20006 on a mint.
        self.already_signed_code = 11003
        # Runs while a request is on the wire, before the mint answers it.
        self.on_request = None
        self._lose: set[str] = set()
        self._refuse: dict[str, MintRefusal] = {}
        self._next = 0

    def pay_mint_quote(self, quote: str) -> None:
        self.mint_quotes[quote]["state"] = "PAID"

    def lose_response(self, path: str) -> None:
        self._lose.add(path)

    def refuse_next(self, path: str, code: int, detail: str) -> None:
        self._refuse[path] = MintRefusal(code, detail)

    def _sign(self, outputs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        signatures = []
        for output in outputs:
            key = self.private_keys[output["amount"]]
            nonce = hashlib.sha256(key + output["B_"].encode()).digest()
            signature = {
                "id": self.keyset_id,
                "amount": output["amount"],
                "C_": blind_sign(output["B_"], key),
                "dleq": create_dleq(output["B_"], key, nonce),
            }
            self.signed[output["B_"]] = signature
            signatures.append(signature)
        return signatures

    def _check_outputs(self, outputs: list[dict[str, Any]]) -> None:
        if any(output["B_"] in self.signed for output in outputs):
            raise MintRefusal(self.already_signed_code, "outputs already signed")

    def _spend(self, inputs: list[dict[str, Any]]) -> None:
        for proof in inputs:
            expected = hash_to_curve(proof["secret"].encode()).multiply(self.private_keys[proof["amount"]])
            if expected.format().hex() != proof["C"]:
                raise MintRefusal(10003, "invalid proof")
            if proof_y(proof["secret"]) in self.spent:
                raise MintRefusal(11001, "token already spent")
        self.spent.update(proof_y(proof["secret"]) for proof in inputs)

    def _fee(self, inputs: list[dict[str, Any]]) -> int:
        return -(-len(inputs) * self.input_fee_ppk // 1000)

    def _route(self, method: str, path: str, body: Any) -> Any:
        if method == "GET" and path == "/v1/info":
            return {"name": "Fake mint", "version": "fake/1", "nuts": {str(nut): {"supported": True} for nut in self.nuts}}
        if method == "GET" and path == "/v1/keysets":
            return {"keysets": [{"id": self.keyset_id, "unit": "sat", "active": True, "input_fee_ppk": self.input_fee_ppk}]}
        if method == "GET" and path.startswith("/v1/keys/"):
            return {"keysets": [{"id": self.keyset_id, "unit": "sat", "keys": self.public_keys}]}
        if method == "POST" and path == "/v1/mint/quote/bolt11":
            self._next += 1
            quote = f"mq{self._next}"
            self.mint_quotes[quote] = {"amount": body["amount"], "state": "UNPAID", "pubkey": body.get("pubkey"), "expiry": int(time.time()) + 600}
            return {"quote": quote, "request": f"lnbc-{quote}", "unit": "sat", **self.mint_quotes[quote]}
        if method == "GET" and path.startswith("/v1/mint/quote/bolt11/"):
            quote = path.rsplit("/", 1)[1]
            return {"quote": quote, "request": "lnbc", "unit": "sat", **self.mint_quotes[quote]}
        if method == "POST" and path == "/v1/mint/bolt11":
            quote = self.mint_quotes[body["quote"]]
            if quote["state"] == "ISSUED":
                raise MintRefusal(20002, "quote already issued")
            if quote["state"] != "PAID":
                raise MintRefusal(20001, "quote not paid")
            if quote.get("pubkey") and not verify_mint_quote(quote["pubkey"], body["quote"], body["outputs"], body.get("signature", "")):
                raise MintRefusal(20008, "bad quote signature")
            self._check_outputs(body["outputs"])
            quote["state"] = "ISSUED"
            return {"signatures": self._sign(body["outputs"])}
        if method == "POST" and path == "/v1/swap":
            self._check_outputs(body["outputs"])
            total = sum(proof["amount"] for proof in body["inputs"])
            if total - self._fee(body["inputs"]) != sum(output["amount"] for output in body["outputs"]):
                raise MintRefusal(11002, "transaction unbalanced")
            self._spend(body["inputs"])
            return {"signatures": self._sign(body["outputs"])}
        if method == "POST" and path == "/v1/melt/quote/bolt11":
            self._next += 1
            quote = f"xq{self._next}"
            match = re.search(r"amount=(\d+)", body["request"])
            amount = int(match.group(1)) if match else 100
            self.melt_quotes[quote] = {"amount": amount, "fee_reserve": 10, "state": "UNPAID", "request": body["request"]}
            return {"quote": quote, "unit": "sat", "expiry": int(time.time()) + 600, **self.melt_quotes[quote]}
        if method == "GET" and path.startswith("/v1/melt/quote/bolt11/"):
            quote = path.rsplit("/", 1)[1]
            return {"quote": quote, "unit": "sat", "expiry": 0, **self.melt_quotes[quote]}
        if method == "POST" and path == "/v1/melt/bolt11":
            quote = self.melt_quotes[body["quote"]]
            self._check_outputs(body["outputs"])
            self._spend(body["inputs"])
            if self.melt_outcome != "PAID":
                quote["state"] = self.melt_outcome
                if self.melt_outcome == "UNPAID":
                    self.spent.difference_update(proof_y(proof["secret"]) for proof in body["inputs"])
                return {"quote": body["quote"], "unit": "sat", "expiry": 0, **quote}
            quote["state"] = "PAID"
            quote["payment_preimage"] = "ab" * 32
            total = sum(proof["amount"] for proof in body["inputs"])
            overpaid = total - self._fee(body["inputs"]) - quote["amount"] - self.melt_routing_fee
            parts = [1 << bit for bit in range(overpaid.bit_length()) if overpaid >> bit & 1]
            change = [{**output, "amount": part} for output, part in zip(body["outputs"], parts)]
            quote["change"] = self._sign(change)
            return {"quote": body["quote"], "unit": "sat", "expiry": 0, **quote}
        if method == "POST" and path == "/v1/checkstate":
            return {"states": [{"Y": y, "state": "SPENT" if y in self.spent else "UNSPENT", "witness": None} for y in body["Ys"]]}
        if method == "POST" and path == "/v1/restore":
            found = [output for output in body["outputs"] if output["B_"] in self.signed]
            return {"outputs": found, "signatures": [self.signed[output["B_"]] for output in found]}
        return None

    async def fetch(self, method: str, url: str, headers: Any = None, json_body: Any = None, timeout: float = 30.0) -> httpx.Response:
        path = httpx.URL(url).path.removeprefix("/cashu")
        self.requests.append(f"{method} {path}")
        if self.on_request:
            await self.on_request(path)
        refusal = self._refuse.pop(path, None)
        try:
            if refusal:
                raise refusal
            result = self._route(method, path, json_body)
        except MintRefusal as error:
            return httpx.Response(400, json={"code": error.code, "detail": str(error)})
        if path in self._lose:
            self._lose.discard(path)
            raise httpx.ReadError("connection lost")
        if result is None:
            return httpx.Response(404, json={"detail": "not found"})
        return httpx.Response(200, json=result)
