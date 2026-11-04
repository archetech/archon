"""Per-identity Cashu wallets, the port of packages/keymaster/src/cashu.ts.

See docs/plans/cashu-1058.md. The proofs are bearer value, so every operation
that talks to a mint is journaled first: its inputs and everything needed to
rebuild its outputs are saved before the request goes out, and the record is
retired only after the result is saved. An interrupted operation is finished by
settlement rather than lost.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import math
import secrets
from typing import Any, Awaitable, Callable, Protocol
from urllib.parse import quote as url_quote, urlsplit

import httpx

from . import cashu_crypto as cc
from .errors import KeymasterError
from .net import fetch_public_https

UNIT = "sat"
REQUEST_TIMEOUT_SECONDS = 30.0
# NUT-05 advises no client timeout, since a melt can take as long as the payment.
# fetch_public_https needs a number for its deadline, so this is an hour, after
# which the record stays open and the quote is polled.
MELT_TIMEOUT_SECONDS = 3600.0
RESTORE_BATCH = 100
RESTORE_EMPTY_BATCHES = 3

# Mints disagree on the code for outputs they have already signed: NUT-00 lists
# 11003, while cdk-mintd answers a mint request with 20006. So that case is
# detected by asking the mint about the outputs (NUT-09), not from the code.
OUTPUTS_PENDING = 11004

# Without NUT-07 the journal cannot be settled; without NUT-08 the unused part of
# a melt's fee reserve is never returned; without NUT-09 ecash could not be
# recovered from the mnemonic.
REQUIRED_NUTS = ("7", "8", "9")

DEFAULT_PORTS = {"https": 443, "http": 80}


class _CashuError(KeymasterError):
    type = ""

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(f"{self.type}: {detail}" if detail else self.type)


class CashuNotConfiguredError(_CashuError):
    type = "Cashu not configured"


class CashuUnavailableError(_CashuError):
    type = "Cashu mint unavailable"


class CashuMintNotAddedError(_CashuError):
    type = "Cashu mint not added"


class CashuMintUnsupportedError(_CashuError):
    type = "Cashu mint unsupported"


class CashuInsufficientFundsError(_CashuError):
    type = "Insufficient ecash"


class CashuQuoteUnpaidError(_CashuError):
    type = "Cashu quote not paid"


class CashuTokenSpentError(_CashuError):
    type = "Cashu token already spent"


class CashuStateError(_CashuError):
    type = "Cashu state present"


class CashuMintError(KeymasterError):
    """A mint's own refusal, with its NUT error code."""

    def __init__(self, detail: str, code: int | None = None) -> None:
        super().__init__(f"mint refused: {detail}")
        self.code = code


def _invalid(what: str) -> KeymasterError:
    return KeymasterError(f"Invalid parameter: {what}")


def normalize_mint_url(url: str) -> str:
    if not isinstance(url, str):
        raise _invalid("mint url")
    try:
        parsed = urlsplit(url.strip())
        port = parsed.port
        hostname = parsed.hostname
    except ValueError as exc:
        raise _invalid("mint url") from exc
    if parsed.scheme.lower() not in DEFAULT_PORTS or not hostname:
        raise _invalid("mint url")
    scheme = parsed.scheme.lower()
    host = f"[{hostname}]" if ":" in hostname else hostname.lower()
    if port is not None and port != DEFAULT_PORTS[scheme]:
        host = f"{host}:{port}"
    return f"{scheme}://{host}{parsed.path}".rstrip("/")


MintFetch = Callable[..., Awaitable[Any]]


async def _plain_fetch(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    json_body: Any | None = None,
    timeout: float = REQUEST_TIMEOUT_SECONDS,
) -> httpx.Response:
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(method, url, headers=headers, json=json_body)


class CashuMintClient:
    def __init__(self, base: str, request: MintFetch) -> None:
        self.base = base
        self._request = request
        self._key_cache: dict[str, dict[str, str]] = {}

    async def _call(self, path: str, body: Any = None, timeout: float = REQUEST_TIMEOUT_SECONDS) -> Any:
        try:
            response = await self._request(
                "GET" if body is None else "POST",
                f"{self.base}{path}",
                None if body is None else {"Content-Type": "application/json"},
                body,
                timeout,
            )
        except (httpx.HTTPError, OSError, ValueError) as exc:
            raise CashuUnavailableError(f"{self.base}: {exc}") from exc

        try:
            payload = response.json()
        except ValueError:
            payload = None
        if response.is_success:
            return payload
        if isinstance(payload, dict):
            code = payload.get("code")
            detail = payload.get("detail")
            if isinstance(code, int) or isinstance(detail, str):
                raise CashuMintError(detail or f"error {code}", code if isinstance(code, int) else None)
        raise CashuUnavailableError(f"{self.base}: HTTP {response.status_code}")

    async def info(self) -> Any:
        return await self._call("/v1/info")

    async def keysets(self) -> list[dict[str, Any]]:
        response = await self._call("/v1/keysets")
        return [keyset for keyset in response["keysets"] if keyset.get("unit") == UNIT]

    async def keys(self, keyset_id: str) -> dict[str, str]:
        # A keyset's keys never change, so they are fetched once.
        keys = self._key_cache.get(keyset_id)
        if keys is None:
            response = await self._call(f"/v1/keys/{url_quote(keyset_id, safe='')}")
            keys = response["keysets"][0]["keys"]
            self._key_cache[keyset_id] = keys
        return keys

    async def create_mint_quote(self, amount: int, pubkey: str | None = None) -> Any:
        body: dict[str, Any] = {"amount": amount, "unit": UNIT}
        if pubkey:
            body["pubkey"] = pubkey
        return await self._call("/v1/mint/quote/bolt11", body)

    async def check_mint_quote(self, quote: str) -> Any:
        return await self._call(f"/v1/mint/quote/bolt11/{url_quote(quote, safe='')}")

    async def mint(self, quote: str, outputs: list[dict[str, Any]], signature: str | None = None) -> Any:
        body: dict[str, Any] = {"quote": quote, "outputs": outputs}
        if signature:
            body["signature"] = signature
        return await self._call("/v1/mint/bolt11", body)

    async def create_melt_quote(self, request: str) -> Any:
        return await self._call("/v1/melt/quote/bolt11", {"unit": UNIT, "request": request})

    async def check_melt_quote(self, quote: str) -> Any:
        return await self._call(f"/v1/melt/quote/bolt11/{url_quote(quote, safe='')}")

    async def melt(self, quote: str, inputs: list[dict[str, Any]], outputs: list[dict[str, Any]]) -> Any:
        return await self._call("/v1/melt/bolt11", {"quote": quote, "inputs": inputs, "outputs": outputs}, MELT_TIMEOUT_SECONDS)

    async def swap(self, inputs: list[dict[str, Any]], outputs: list[dict[str, Any]]) -> Any:
        return await self._call("/v1/swap", {"inputs": inputs, "outputs": outputs})

    async def states(self, ys: list[str]) -> dict[str, str]:
        if not ys:
            return {}
        response = await self._call("/v1/checkstate", {"Ys": ys})
        return {state["Y"]: state["state"] for state in response["states"]}

    async def restore(self, outputs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        """NUT-09: the signatures the mint holds for these outputs, by B_."""
        if not outputs:
            return {}
        response = await self._call("/v1/restore", {"outputs": outputs})
        return {output["B_"]: response["signatures"][i] for i, output in enumerate(response["outputs"])}


def split_amount(amount: int) -> list[int]:
    """Ascending powers of two, the split both ports use."""
    return [1 << bit for bit in range(amount.bit_length()) if amount >> bit & 1]


def _sum_proofs(proofs: list[dict[str, Any]]) -> int:
    return sum(proof["amount"] for proof in proofs)


def _fee_for(proofs: list[dict[str, Any]], keysets: list[dict[str, Any]]) -> int:
    by_id = {keyset["id"]: keyset.get("input_fee_ppk") or 0 for keyset in keysets}
    ppk = sum(by_id.get(proof["id"], 0) for proof in proofs)
    return math.ceil(ppk / 1000)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def has_cashu_state(id_info: dict[str, Any]) -> bool:
    return any(
        entry.get("proofs") or entry.get("operations")
        for entry in (id_info.get("cashu") or {}).values()
    )


def _mints(id_info: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return id_info.get("cashu") or {}


class _MintContext:
    def __init__(self, name: str | None, url: str, client: CashuMintClient) -> None:
        self.name = name
        self.url = url
        self.client = client


class CashuHost(Protocol):
    gatekeeper: Any
    _lock: Any

    async def load_wallet(self) -> dict[str, Any]: ...
    async def _save_loaded_wallet(self, wallet: dict[str, Any], overwrite: bool = True) -> bool: ...
    async def fetch_id_info(self, identifier: str | None = None, wallet: dict[str, Any] | None = None) -> dict[str, Any]: ...
    async def _bip39_seed(self, wallet: dict[str, Any] | None = None) -> bytes: ...
    async def get_node_capabilities(self) -> dict[str, bool] | None: ...
    async def resolve_did(self, name: str, options: dict[str, Any] | None = None) -> dict[str, Any]: ...
    async def update_did(self, identifier: str, doc: dict[str, Any]) -> bool: ...


class CashuWallet:
    def __init__(self, host: CashuHost, public_fetch: MintFetch = fetch_public_https, node_fetch: MintFetch = _plain_fetch) -> None:
        self.host = host
        self.public_fetch = public_fetch
        self.node_fetch = node_fetch
        # Operations with a request on the wire in this process. Settlement skips
        # them: the lock is not held across mint requests, so a concurrent
        # operation would otherwise resubmit a request that is still in flight.
        self._active: set[str] = set()

    def _node_url(self) -> str | None:
        url = getattr(self.host.gatekeeper, "url", None)
        return url.rstrip("/") if url else None

    def _client_for(self, url: str, entry: dict[str, Any] | None = None) -> CashuMintClient:
        node = self._node_url()
        if entry and entry.get("node") and entry["node"] == node:
            return CashuMintClient(f"{node}/cashu", self.node_fetch)
        return CashuMintClient(url, self.public_fetch)

    async def _mutate(self, mutator: Callable[[dict[str, Any]], Awaitable[Any]]) -> Any:
        # On a copy, so a refusal part way through leaves the wallet as it was.
        async with self.host._lock:
            wallet = deepcopy(await self.host.load_wallet())
            result = await mutator(wallet)
            await self.host._save_loaded_wallet(wallet, overwrite=True)
            return result

    # The node's mint when the identity has it, else its only mint.
    async def _context(self, mint: str | None, name: str | None) -> _MintContext:
        id_info = await self.host.fetch_id_info(name, await self.host.load_wallet())
        mints = _mints(id_info)
        if not mints:
            raise CashuNotConfiguredError(f"No Cashu mints configured for {id_info['did']}")

        if mint:
            url = normalize_mint_url(mint)
            if url not in mints:
                raise CashuMintNotAddedError(url)
        else:
            node = self._node_url()
            own = next((candidate for candidate, entry in mints.items() if entry.get("node") and entry["node"] == node), None)
            if own is None and len(mints) > 1:
                raise _invalid("mint is required: this identity uses several")
            url = own if own is not None else next(iter(mints))
        # By DID, not the name given: with none given it means the current identity,
        # which can change while a request is out, and proofs must not follow it.
        return _MintContext(id_info["did"], url, self._client_for(url, mints[url]))

    async def _bound_identity(self, name: str | None) -> str:
        return (await self.host.fetch_id_info(name, await self.host.load_wallet()))["did"]

    async def _entry_of(self, wallet: dict[str, Any], ctx: _MintContext) -> dict[str, Any]:
        id_info = await self.host.fetch_id_info(ctx.name, wallet)
        entry = _mints(id_info).get(ctx.url)
        if entry is None:
            raise CashuMintNotAddedError(ctx.url)
        return entry

    async def _read_op(self, ctx: _MintContext, op_id: str) -> dict[str, Any] | None:
        entry = await self._entry_of(await self.host.load_wallet(), ctx)
        return next((op for op in entry.get("operations") or [] if op["id"] == op_id), None)

    @staticmethod
    def _find_op(entry: dict[str, Any], op_id: str) -> dict[str, Any]:
        return next(op for op in entry["operations"] if op["id"] == op_id)

    @staticmethod
    def _counters(wallet: dict[str, Any]) -> dict[str, Any]:
        return wallet.setdefault("cashu", {"counters": {}})["counters"]

    # Reserved counters are saved before the outputs they cover are sent, so a
    # crash can never reuse one the mint has signed. Released ranges go first.
    def _reserve(self, wallet: dict[str, Any], keyset: str, count: int) -> list[int]:
        state = self._counters(wallet).setdefault(keyset, {"next": 0, "free": []})
        reserved: list[int] = []
        while len(reserved) < count:
            if state["free"]:
                current = state["free"][0]
                reserved.append(current[0])
                if current[0] == current[1]:
                    state["free"].pop(0)
                else:
                    current[0] += 1
            else:
                reserved.append(state["next"])
                state["next"] += 1
        return reserved

    def _release(self, wallet: dict[str, Any], keyset: str, released: list[int]) -> None:
        if not released:
            return
        state = self._counters(wallet).setdefault(keyset, {"next": 0, "free": []})
        merged: list[list[int]] = []
        for start, end in sorted([*map(tuple, state["free"]), *((counter, counter) for counter in released)]):
            if merged and start <= merged[-1][1] + 1:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        state["free"] = merged

    async def _output_data(self, op: dict[str, Any]) -> tuple[list[tuple[str, int]], list[dict[str, Any]]]:
        seed = await self.host._bip39_seed(await self.host.load_wallet())
        data: list[tuple[str, int]] = []
        blinded: list[dict[str, Any]] = []
        for output in op["outputs"]:
            counter = output.get("counter")
            if counter is None:
                raise KeymasterError("Cashu output has no counter")
            secret, r = cc.derive_secret_and_r(seed, op["keyset"], counter)
            data.append((secret, r))
            blinded.append({"amount": output["amount"], "id": op["keyset"], "B_": cc.blind(secret.encode(), r)})
        return data, blinded

    async def _unblind(self, ctx: _MintContext, signature: dict[str, Any], data: tuple[str, int]) -> dict[str, Any]:
        secret, r = data
        keys = await ctx.client.keys(signature["id"])
        amount = signature["amount"]
        key = keys.get(str(amount))
        if key is None:
            raise KeymasterError(f"Mint has no key for amount {amount} in keyset {signature['id']}")
        dleq = signature.get("dleq")
        if dleq and not cc.verify_dleq(dleq["e"], dleq["s"], cc.blind(secret.encode(), r), signature["C_"], key):
            raise KeymasterError("Mint's DLEQ proof did not verify")
        proof = {"id": signature["id"], "amount": amount, "secret": secret, "C": cc.unblind(signature["C_"], r, key)}
        if dleq:
            proof["dleq"] = {"e": dleq["e"], "s": dleq["s"], "r": f"{r:064x}"}
        return proof

    # No path adds a proof already held anywhere in the wallet, so restores,
    # retries and recoveries cannot count value twice.
    def _known_ys(self, wallet: dict[str, Any]) -> set[str]:
        known: set[str] = set()
        for id_info in wallet["ids"].values():
            for entry in _mints(id_info).values():
                held = list(entry["proofs"])
                for op in entry.get("operations") or []:
                    held.extend(op["inputs"])
                    held.extend(op.get("sent") or [])
                known.update(cc.proof_y(proof["secret"]) for proof in held)
        return known

    def _credit(self, wallet: dict[str, Any], entry: dict[str, Any], proofs: list[dict[str, Any]]) -> None:
        known = self._known_ys(wallet)
        for proof in proofs:
            y = cc.proof_y(proof["secret"])
            if y not in known:
                entry["proofs"].append(proof)
                known.add(y)

    @staticmethod
    def _retire(entry: dict[str, Any], op_id: str) -> None:
        entry["operations"] = [op for op in entry.get("operations") or [] if op["id"] != op_id]
        if not entry["operations"]:
            del entry["operations"]

    async def _active_keyset(self, ctx: _MintContext) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        keysets = await ctx.client.keysets()
        candidates = [keyset for keyset in keysets if keyset.get("active")]
        if not candidates:
            raise CashuUnavailableError(f"{ctx.url} has no active {UNIT} keyset")
        return min(candidates, key=lambda keyset: keyset.get("input_fee_ppk") or 0), keysets

    @staticmethod
    def _select(proofs: list[dict[str, Any]], target: int, keysets: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Largest first until the proofs cover the target and their own input fee."""
        selected: list[dict[str, Any]] = []
        for proof in sorted(proofs, key=lambda item: item["amount"], reverse=True):
            if _sum_proofs(selected) - _fee_for(selected, keysets) >= target:
                break
            selected.append(proof)
        if _sum_proofs(selected) - _fee_for(selected, keysets) < target:
            raise CashuInsufficientFundsError(f"need {target} {UNIT} plus fees, have {_sum_proofs(proofs)}")
        return selected

    @staticmethod
    def _remove_from_entry(entry: dict[str, Any], proofs: list[dict[str, Any]]) -> None:
        taken = {proof["secret"] for proof in proofs}
        entry["proofs"] = [proof for proof in entry["proofs"] if proof["secret"] not in taken]

    async def _with_active(self, op_id: str, work: Callable[[], Awaitable[Any]]) -> Any:
        self._active.add(op_id)
        try:
            return await work()
        finally:
            self._active.discard(op_id)

    # ---- settlement ----

    async def _reserve_fresh(self, ctx: _MintContext, op_id: str) -> None:
        async def mutator(wallet: dict[str, Any]) -> None:
            stored = self._find_op(await self._entry_of(wallet, ctx), op_id)
            fresh = self._reserve(wallet, stored["keyset"], len(stored["outputs"]))
            for output, counter in zip(stored["outputs"], fresh):
                output["counter"] = counter

        await self._mutate(mutator)

    async def _repair_counters(self, ctx: _MintContext, keyset_id: str) -> None:
        """After a mint refused a request whose outputs it had already signed,
        although this request was never accepted: the counters are stale, as after
        recovering a wallet."""
        proofs, highest, signed = await self._scan_keyset(ctx, keyset_id)
        spendable = await self._unspent(ctx, proofs)

        async def mutator(wallet: dict[str, Any]) -> None:
            state = self._counters(wallet).setdefault(keyset_id, {"next": 0, "free": []})
            state["next"] = max(state["next"], highest + 1)
            state["free"] = [
                [counter, counter]
                for start, end in state["free"]
                for counter in range(start, end + 1)
                if counter not in signed and counter < state["next"]
            ]
            self._credit(wallet, await self._entry_of(wallet, ctx), spendable)

        await self._mutate(mutator)

    async def _unspent(self, ctx: _MintContext, proofs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        states = await ctx.client.states([cc.proof_y(proof["secret"]) for proof in proofs])
        return [proof for proof in proofs if states.get(cc.proof_y(proof["secret"])) == "UNSPENT"]

    async def _scan_keyset(self, ctx: _MintContext, keyset_id: str) -> tuple[list[dict[str, Any]], int, set[int]]:
        """NUT-13 recovery of one keyset: stops after three empty batches of 100."""
        seed = await self.host._bip39_seed(await self.host.load_wallet())
        proofs: list[dict[str, Any]] = []
        signed: set[int] = set()
        highest = -1
        empty = 0
        start = 0
        while empty < RESTORE_EMPTY_BATCHES:
            data = [cc.derive_secret_and_r(seed, keyset_id, start + i) for i in range(RESTORE_BATCH)]
            blinded = [{"amount": 0, "id": keyset_id, "B_": cc.blind(secret.encode(), r)} for secret, r in data]
            found = await ctx.client.restore(blinded)
            if not found:
                empty += 1
            else:
                empty = 0
                for i, output in enumerate(blinded):
                    signature = found.get(output["B_"])
                    if signature:
                        proofs.append(await self._unblind(ctx, signature, data[i]))
                        signed.add(start + i)
                        highest = max(highest, start + i)
            start += RESTORE_BATCH
        return proofs, highest, signed

    async def _resolve_rejected(self, ctx: _MintContext, op_id: str, error: CashuMintError, retried: bool) -> str:
        """The outcome of a swap-shaped request the mint would not accept as sent."""
        op = await self._read_op(ctx, op_id)
        if error.code == OUTPUTS_PENDING:
            return "open"
        data, blinded = await self._output_data(op)
        recovered = await ctx.client.restore(blinded)
        states = await ctx.client.states([cc.proof_y(proof["secret"]) for proof in op["inputs"]])
        input_states = list(states.values())
        if "PENDING" in input_states:
            return "open"
        spent = "SPENT" in input_states

        # An earlier attempt was signed and its response lost.
        if spent and blinded and all(output["B_"] in recovered for output in blinded):
            await self._apply_swap(ctx, op_id, [recovered[output["B_"]] for output in blinded], data)
            return "done"
        if not spent and recovered and not retried:
            await self._repair_counters(ctx, op["keyset"])
            await self._reserve_fresh(ctx, op_id)
            return await self._run_swap(ctx, op_id, True)

        # Settled and unable to sign: its unsigned counters are free again.
        unsigned = [output["counter"] for output, sent in zip(op["outputs"], blinded) if sent["B_"] not in recovered]

        async def mutator(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            self._retire(entry, op_id)
            self._release(wallet, op["keyset"], unsigned)
            # Only what the identity owned goes back; a received token's proofs
            # were never its own.
            if not spent and op["kind"] != "receive":
                self._credit(wallet, entry, op["inputs"])

        await self._mutate(mutator)
        if not spent:
            raise error
        return "spent"

    async def _apply_swap(self, ctx: _MintContext, op_id: str, signatures: list[dict[str, Any]], data: list[tuple[str, int]]) -> None:
        op = await self._read_op(ctx, op_id)
        proofs = [await self._unblind(ctx, signature, data[i]) for i, signature in enumerate(signatures)]
        keep = [proof for proof, output in zip(proofs, op["outputs"]) if output["role"] == "keep"]
        sent = [proof for proof, output in zip(proofs, op["outputs"]) if output["role"] == "send"]

        async def mutator(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            if sent:
                # Outstanding until redeemed: not balance, and not in flight.
                stored = self._find_op(entry, op_id)
                stored["sent"] = sent
                stored["inputs"] = []
                stored["outputs"] = []
            else:
                self._retire(entry, op_id)
            self._credit(wallet, entry, keep)

        await self._mutate(mutator)

    async def _run_swap(self, ctx: _MintContext, op_id: str, retried: bool = False) -> str:
        op = await self._read_op(ctx, op_id)
        data, blinded = await self._output_data(op)
        try:
            response = await ctx.client.swap(op["inputs"], blinded)
        except CashuMintError as error:
            return await self._resolve_rejected(ctx, op_id, error, retried)
        await self._apply_swap(ctx, op_id, response["signatures"], data)
        return "done"

    async def _drop_op(self, ctx: _MintContext, op_id: str) -> None:
        async def mutator(wallet: dict[str, Any]) -> None:
            self._retire(await self._entry_of(wallet, ctx), op_id)

        await self._mutate(mutator)

    async def _settle_sent(self, ctx: _MintContext, op: dict[str, Any]) -> str:
        states = await ctx.client.states([cc.proof_y(proof["secret"]) for proof in op["sent"]])
        if states and all(state == "SPENT" for state in states.values()):
            await self._drop_op(ctx, op["id"])
            return "done"
        return "open"

    async def _run_mint(self, ctx: _MintContext, op_id: str, retried: bool = False) -> str:
        op = await self._read_op(ctx, op_id)
        quote = await ctx.client.check_mint_quote(op["quote"])

        if quote.get("state") == "ISSUED":
            return await self._recover_mint(ctx, op_id)
        if quote.get("state") != "PAID":
            expiry = quote.get("expiry") or op.get("expiry")
            if expiry and expiry < datetime.now(timezone.utc).timestamp():
                await self._release_unsigned(ctx, op_id)
                return "done"
            return "open"

        if not op["outputs"]:
            keyset, _ = await self._active_keyset(ctx)

            async def assign(wallet: dict[str, Any]) -> None:
                stored = self._find_op(await self._entry_of(wallet, ctx), op_id)
                parts = split_amount(stored["amount"])
                counters = self._reserve(wallet, keyset["id"], len(parts))
                stored["keyset"] = keyset["id"]
                stored["outputs"] = [{"amount": amount, "role": "keep", "counter": counters[i]} for i, amount in enumerate(parts)]

            await self._mutate(assign)

        current = await self._read_op(ctx, op_id)
        data, blinded = await self._output_data(current)
        signature = cc.sign_mint_quote(current["quoteKey"], current["quote"], blinded) if current.get("quoteKey") else None
        try:
            response = await ctx.client.mint(current["quote"], blinded, signature)
        except CashuMintError as error:
            if error.code == OUTPUTS_PENDING:
                return "open"
            after = await ctx.client.check_mint_quote(current["quote"])
            if after.get("state") == "ISSUED":
                return await self._recover_mint(ctx, op_id)
            if not retried and await ctx.client.restore(blinded):
                await self._repair_counters(ctx, current["keyset"])
                await self._reserve_fresh(ctx, op_id)
                return await self._run_mint(ctx, op_id, True)
            raise

        proofs = [await self._unblind(ctx, sig, data[i]) for i, sig in enumerate(response["signatures"])]

        async def finish(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            self._retire(entry, op_id)
            self._credit(wallet, entry, proofs)

        await self._mutate(finish)
        return "done"

    async def _recover_mint(self, ctx: _MintContext, op_id: str) -> str:
        """The quote was issued: an earlier claim's response was lost, or another
        copy of the wallet claimed it."""
        op = await self._read_op(ctx, op_id)
        data, blinded = await self._output_data(op)
        recovered = await ctx.client.restore(blinded)
        proofs: list[dict[str, Any]] = []
        unsigned: list[int] = []
        for i, output in enumerate(blinded):
            signature = recovered.get(output["B_"])
            if signature:
                proofs.append(await self._unblind(ctx, signature, data[i]))
            else:
                unsigned.append(op["outputs"][i]["counter"])

        async def mutator(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            self._retire(entry, op_id)
            self._release(wallet, op["keyset"], unsigned)
            self._credit(wallet, entry, proofs)

        await self._mutate(mutator)
        return "done"

    async def _release_unsigned(self, ctx: _MintContext, op_id: str) -> None:
        """Retires a record whose outputs were never signed, after confirming that."""
        op = await self._read_op(ctx, op_id)
        _, blinded = await self._output_data(op)
        recovered = await ctx.client.restore(blinded)
        unsigned = [output["counter"] for output, sent in zip(op["outputs"], blinded) if sent["B_"] not in recovered]

        async def mutator(wallet: dict[str, Any]) -> None:
            self._retire(await self._entry_of(wallet, ctx), op_id)
            self._release(wallet, op["keyset"], unsigned)

        await self._mutate(mutator)

    async def _settle_melt(self, ctx: _MintContext, op_id: str, known: Any = None) -> tuple[str, Any, int]:
        op = await self._read_op(ctx, op_id)
        quote = known if known is not None else await ctx.client.check_melt_quote(op["quote"])

        if quote.get("state") == "PENDING":
            return "open", quote, 0
        data, blinded = await self._output_data(op)

        if quote.get("state") == "PAID":
            change = quote.get("change") or []
            proofs = [await self._unblind(ctx, signature, data[i]) for i, signature in enumerate(change)]
            # NUT-08 lets the mint sign fewer change outputs than were sent. The
            # tail is free once NUT-09 confirms it holds no signature for it.
            tail = blinded[len(change):]
            recovered = await ctx.client.restore(tail)
            unsigned: list[int] = []
            for i, output in enumerate(tail):
                signature = recovered.get(output["B_"])
                if signature:
                    proofs.append(await self._unblind(ctx, signature, data[len(change) + i]))
                else:
                    unsigned.append(op["outputs"][len(change) + i]["counter"])

            async def paid(wallet: dict[str, Any]) -> None:
                entry = await self._entry_of(wallet, ctx)
                self._retire(entry, op_id)
                self._release(wallet, op["keyset"], unsigned)
                self._credit(wallet, entry, proofs)

            await self._mutate(paid)
            return "done", quote, _sum_proofs(proofs)

        # Unpaid: the inputs come back once the mint shows them unspent.
        states = await ctx.client.states([cc.proof_y(proof["secret"]) for proof in op["inputs"]])
        if any(state != "UNSPENT" for state in states.values()):
            return "open", quote, 0
        recovered = await ctx.client.restore(blinded)
        unsigned = [output["counter"] for output, sent in zip(op["outputs"], blinded) if sent["B_"] not in recovered]

        async def unpaid(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            self._retire(entry, op_id)
            self._release(wallet, op["keyset"], unsigned)
            self._credit(wallet, entry, op["inputs"])

        await self._mutate(unpaid)
        return "rejected", quote, 0

    async def _submit_melt(self, ctx: _MintContext, op_id: str, retried: bool = False) -> tuple[Any, CashuMintError | None]:
        op = await self._read_op(ctx, op_id)
        _, blinded = await self._output_data(op)
        try:
            return await ctx.client.melt(op["quote"], op["inputs"], blinded), None
        except CashuMintError as error:
            if not retried and await ctx.client.restore(blinded):
                quote = await ctx.client.check_melt_quote(op["quote"])
                if quote.get("state") == "UNPAID":
                    await self._repair_counters(ctx, op["keyset"])
                    await self._reserve_fresh(ctx, op_id)
                    return await self._submit_melt(ctx, op_id, True)
            return None, error

    async def _settle_op(self, ctx: _MintContext, op: dict[str, Any]) -> str:
        if op["kind"] == "mint":
            return await self._run_mint(ctx, op["id"])
        if op["kind"] == "melt":
            return (await self._settle_melt(ctx, op["id"]))[0]
        return await self._settle_sent(ctx, op) if op.get("sent") else await self._run_swap(ctx, op["id"])

    async def _settle(self, ctx: _MintContext) -> dict[str, int]:
        """Settles the mint's open records for the identity. Unpaid mint quotes
        stay open without counting against anything. One record's failure does not
        block the rest, or the operation that asked for settlement."""
        entry = await self._entry_of(await self.host.load_wallet(), ctx)
        settled = 0
        remaining = 0
        for op_id in [op["id"] for op in entry.get("operations") or []]:
            # Checked per record: earlier records take time to settle, during which
            # a concurrent operation can start or finish this one.
            if op_id in self._active:
                remaining += 1
                continue

            async def work(record_id: str = op_id) -> str | None:
                op = await self._read_op(ctx, record_id)
                return await self._settle_op(ctx, op) if op else None

            try:
                outcome = await self._with_active(op_id, work)
            except (CashuMintError, CashuUnavailableError):
                outcome = "open" if await self._read_op(ctx, op_id) else "rejected"
            if outcome == "open":
                remaining += 1
            elif outcome:
                settled += 1
        return {"settled": settled, "open": remaining}

    # ---- enabling and mint trust ----

    @staticmethod
    async def _require_nuts(client: CashuMintClient, url: str) -> None:
        info = await client.info()
        nuts = (info or {}).get("nuts") or {}
        missing = [nut for nut in REQUIRED_NUTS if not (nuts.get(nut) or {}).get("supported")]
        if missing:
            raise CashuMintUnsupportedError(f"{url} does not support " + ", ".join(f"NUT-{nut}" for nut in missing))

    async def add_cashu(self, name: str | None = None) -> dict[str, Any]:
        identity = await self._bound_identity(name)
        node = self._node_url()
        capabilities = await self.host.get_node_capabilities()
        get_mint = getattr(self.host.gatekeeper, "get_cashu_mint", None)
        url = None
        if not (capabilities or {}).get("cashu") is False and get_mint:
            url = await get_mint()
        if not node or not url:
            raise CashuUnavailableError("this node offers no Cashu mint; use addCashuMint to add another")
        normalized = normalize_mint_url(url)
        client = CashuMintClient(f"{node}/cashu", self.node_fetch)
        await self._require_nuts(client, normalized)
        listed = {keyset["id"] for keyset in await client.keysets()}

        async def mutator(wallet: dict[str, Any]) -> None:
            id_info = await self.host.fetch_id_info(identity, wallet)
            mints = id_info.setdefault("cashu", {})
            if normalized in mints:
                return
            # The public host changed: the same mint keeps its entry. Keyset ids
            # tell whether it is the same mint, so a different one is never
            # relabelled.
            for candidate, entry in list(mints.items()):
                used = list(entry["proofs"])
                for op in entry.get("operations") or []:
                    used.extend(op["inputs"])
                    used.extend(op.get("sent") or [])
                if entry.get("node") == node and all(proof["id"] in listed for proof in used):
                    mints[normalized] = mints.pop(candidate)
                    return
            mints[normalized] = {"added": _now(), "node": node, "proofs": []}

        await self._mutate(mutator)
        return await self._describe(normalized, client, True)

    async def add_cashu_mint(self, url: str, name: str | None = None) -> dict[str, Any]:
        identity = await self._bound_identity(name)
        normalized = normalize_mint_url(url)
        client = CashuMintClient(normalized, self.public_fetch)
        await self._require_nuts(client, normalized)

        async def mutator(wallet: dict[str, Any]) -> None:
            id_info = await self.host.fetch_id_info(identity, wallet)
            id_info.setdefault("cashu", {}).setdefault(normalized, {"added": _now(), "proofs": []})

        await self._mutate(mutator)
        return await self._describe(normalized, client, False)

    @staticmethod
    async def _describe(url: str, client: CashuMintClient, is_node_mint: bool) -> dict[str, Any]:
        info = await client.info()
        keysets = await client.keysets()
        described = {"url": url, "nuts": (info or {}).get("nuts") or {}, "keysets": keysets, "isNodeMint": is_node_mint}
        if (info or {}).get("name"):
            described["name"] = info["name"]
        return described

    async def remove_cashu_mint(self, url: str, force: bool = False, name: str | None = None) -> bool:
        normalized = normalize_mint_url(url)

        async def mutator(wallet: dict[str, Any]) -> None:
            id_info = await self.host.fetch_id_info(name, wallet)
            entry = _mints(id_info).get(normalized)
            if entry is None:
                raise CashuMintNotAddedError(normalized)
            if force is not True and (entry["proofs"] or entry.get("operations")):
                raise CashuStateError(f"{normalized} holds ecash or open operations; use force to discard them")
            del id_info["cashu"][normalized]
            if not id_info["cashu"]:
                del id_info["cashu"]

        await self._mutate(mutator)
        return True

    async def remove_cashu(self, force: bool = False, name: str | None = None) -> bool:
        async def mutator(wallet: dict[str, Any]) -> None:
            id_info = await self.host.fetch_id_info(name, wallet)
            if force is not True and has_cashu_state(id_info):
                raise CashuStateError("this identity holds ecash or open operations; use force to discard them")
            id_info.pop("cashu", None)

        await self._mutate(mutator)
        return True

    async def list_cashu_mints(self, name: str | None = None) -> list[dict[str, Any]]:
        id_info = await self.host.fetch_id_info(name, await self.host.load_wallet())
        node = self._node_url()
        described = []
        for url, entry in _mints(id_info).items():
            is_node_mint = bool(entry.get("node")) and entry["node"] == node
            try:
                described.append(await self._describe(url, self._client_for(url, entry), is_node_mint))
            except (CashuMintError, CashuUnavailableError):
                described.append({"url": url, "nuts": {}, "keysets": [], "isNodeMint": is_node_mint})
        return described

    async def publish_cashu(self, name: str | None = None) -> bool:
        id_info = await self.host.fetch_id_info(name, await self.host.load_wallet())
        urls = list(_mints(id_info))
        if not urls:
            raise CashuNotConfiguredError(f"No Cashu mints configured for {id_info['did']}")
        doc = await self.host.resolve_did(id_info["did"])
        service_id = f"{id_info['did']}#cashu"
        services = [service for service in doc["didDocument"].get("service") or [] if service.get("id") != service_id]
        services.append({"id": service_id, "type": "Cashu", "serviceEndpoint": urls})
        doc["didDocument"]["service"] = services
        await self.host.update_did(id_info["did"], doc)
        return True

    async def unpublish_cashu(self, name: str | None = None) -> bool:
        id_info = await self.host.fetch_id_info(name, await self.host.load_wallet())
        doc = await self.host.resolve_did(id_info["did"])
        service_id = f"{id_info['did']}#cashu"
        services = [service for service in doc["didDocument"].get("service") or [] if service.get("id") != service_id]
        if services:
            doc["didDocument"]["service"] = services
        else:
            doc["didDocument"].pop("service", None)
        await self.host.update_did(id_info["did"], doc)
        return True

    # ---- read methods: never settle or send anything ----

    @staticmethod
    def _entry_totals(entry: dict[str, Any]) -> dict[str, int]:
        operations = entry.get("operations") or []
        return {
            "spendable": _sum_proofs(entry["proofs"]),
            "inFlight": sum(_sum_proofs(op["inputs"]) for op in operations),
            "outstanding": sum(_sum_proofs(op.get("sent") or []) for op in operations),
        }

    async def get_cashu_balance(self, mint: str | None = None, name: str | None = None) -> dict[str, Any]:
        id_info = await self.host.fetch_id_info(name, await self.host.load_wallet())
        mints = _mints(id_info)
        if not mints:
            raise CashuNotConfiguredError(f"No Cashu mints configured for {id_info['did']}")
        if mint:
            url = normalize_mint_url(mint)
            if url not in mints:
                raise CashuMintNotAddedError(url)
            return self._entry_totals(mints[url])
        if len(mints) == 1:
            return self._entry_totals(next(iter(mints.values())))
        breakdown = {url: self._entry_totals(entry) for url, entry in mints.items()}
        total = {key: sum(totals[key] for totals in breakdown.values()) for key in ("spendable", "inFlight", "outstanding")}
        return {**total, "mints": breakdown}

    async def _scoped_entries(self, mint: str | None, name: str | None) -> list[tuple[str, dict[str, Any]]]:
        id_info = await self.host.fetch_id_info(name, await self.host.load_wallet())
        mints = _mints(id_info)
        if mint:
            url = normalize_mint_url(mint)
            if url not in mints:
                raise CashuMintNotAddedError(url)
            return [(url, mints[url])]
        return list(mints.items())

    async def list_cashu_quotes(self, mint: str | None = None, name: str | None = None) -> list[dict[str, Any]]:
        records = []
        for url, entry in await self._scoped_entries(mint, name):
            for op in entry.get("operations") or []:
                if op["kind"] not in ("mint", "melt"):
                    continue
                record = {"operationId": op["id"], "kind": op["kind"], "quote": op["quote"], "mint": url, "created": op["created"]}
                record.update({key: op[key] for key in ("amount", "request", "expiry") if key in op})
                records.append(record)
        return records

    async def list_cashu_sends(self, mint: str | None = None, name: str | None = None) -> list[dict[str, Any]]:
        return [
            {"operationId": op["id"], "mint": url, "amount": _sum_proofs(op["sent"]), "created": op["created"]}
            for url, entry in await self._scoped_entries(mint, name)
            for op in entry.get("operations") or []
            if op.get("sent")
        ]

    # ---- operations ----

    @staticmethod
    def _require_amount(amount: Any) -> None:
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0 or amount > 2**53 - 1:
            raise _invalid("amount")

    async def create_cashu_mint_quote(self, amount: int, mint: str | None = None, name: str | None = None) -> dict[str, Any]:
        self._require_amount(amount)
        ctx = await self._context(mint, name)
        await self._settle(ctx)

        # NUT-04 warns that anyone who learns a quote id can otherwise claim its
        # tokens, and quote ids appear in URLs that proxies log. The key is random
        # per quote so the mint cannot link quotes to an identity.
        info = await ctx.client.info()
        supported = (((info or {}).get("nuts") or {}).get("20") or {}).get("supported")
        secret = cc.new_secret_key() if supported else None
        quote = await ctx.client.create_mint_quote(amount, cc.public_key_hex(secret) if secret else None)

        async def mutator(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            record: dict[str, Any] = {
                "id": secrets.token_hex(16),
                "kind": "mint",
                "quote": quote["quote"],
                "request": quote["request"],
                "amount": amount,
                "inputs": [],
                "keyset": "",
                "outputs": [],
                "created": _now(),
            }
            if secret:
                record["quoteKey"] = secret.hex()
            if quote.get("expiry"):
                record["expiry"] = quote["expiry"]
            entry.setdefault("operations", []).append(record)

        await self._mutate(mutator)
        result = {"quote": quote["quote"], "request": quote["request"], "amount": amount, "state": quote.get("state")}
        if quote.get("expiry"):
            result["expiry"] = quote["expiry"]
        return result

    async def claim_cashu_mint_quote(self, quote_id: str, mint: str | None = None, name: str | None = None) -> dict[str, Any]:
        ctx = await self._context(mint, name)
        entry = await self._entry_of(await self.host.load_wallet(), ctx)
        op = next((item for item in entry.get("operations") or [] if item["kind"] == "mint" and item["quote"] == quote_id), None)
        if op is None:
            raise _invalid("quote")
        if op["id"] in self._active:
            raise CashuUnavailableError(f"quote {quote_id} is already being claimed")
        outcome = await self._with_active(op["id"], lambda: self._run_mint(ctx, op["id"]))
        if outcome != "done":
            raise CashuQuoteUnpaidError(quote_id)
        return {"amount": op["amount"], "mint": ctx.url}

    async def melt_cashu(self, bolt11: str, mint: str | None = None, name: str | None = None) -> dict[str, Any]:
        if not isinstance(bolt11, str) or not bolt11:
            raise _invalid("bolt11")
        ctx = await self._context(mint, name)
        await self._settle(ctx)
        quote = await ctx.client.create_melt_quote(bolt11)
        keyset, keysets = await self._active_keyset(ctx)
        target = quote["amount"] + quote["fee_reserve"]
        op_id = secrets.token_hex(16)

        async def mutator(wallet: dict[str, Any]) -> int:
            entry = await self._entry_of(wallet, ctx)
            inputs = self._select(entry["proofs"], target, keysets)
            self._remove_from_entry(entry, inputs)
            spent_total = _sum_proofs(inputs)
            # NUT-08: enough blank outputs for whatever the mint returns.
            overpaid = spent_total - _fee_for(inputs, keysets) - quote["amount"]
            blanks = max(math.ceil(math.log2(max(overpaid, 1))), 1)
            counters = self._reserve(wallet, keyset["id"], blanks)
            entry.setdefault("operations", []).append({
                "id": op_id,
                "kind": "melt",
                "quote": quote["quote"],
                "request": bolt11,
                "amount": quote["amount"],
                "inputs": inputs,
                "keyset": keyset["id"],
                "outputs": [{"amount": 0, "role": "keep", "counter": counter} for counter in counters],
                "created": _now(),
            })
            return spent_total

        spent = await self._mutate(mutator)

        async def work() -> dict[str, Any]:
            # On a refusal the quote says what actually happened.
            response, refusal = await self._submit_melt(ctx, op_id)
            known = response if isinstance(response, dict) and response.get("state") else None
            outcome, final, change = await self._settle_melt(ctx, op_id, known)
            if outcome == "rejected" and refusal:
                raise refusal
            result: dict[str, Any] = {"paid": outcome == "done", "change": change}
            if outcome == "open":
                result["pending"] = True
            if (final or {}).get("payment_preimage"):
                result["preimage"] = final["payment_preimage"]
            if outcome == "done":
                result["fee"] = spent - quote["amount"] - change
            return result

        return await self._with_active(op_id, work)

    async def send_cashu(self, amount: int, mint: str | None = None, name: str | None = None) -> dict[str, Any]:
        self._require_amount(amount)
        ctx = await self._context(mint, name)
        await self._settle(ctx)
        keyset, keysets = await self._active_keyset(ctx)

        # The recipient must net the amount after the fee on redeeming the sent
        # proofs. That fee follows the number of parts, which does not grow with
        # the value, so this finds the smallest gross that nets enough rather than
        # solving for an exact one that may not exist.
        ppk = keyset.get("input_fee_ppk") or 0
        gross = amount
        while gross - math.ceil(len(split_amount(gross)) * ppk / 1000) < amount:
            gross += 1

        op_id = secrets.token_hex(16)

        async def mutator(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            inputs = self._select(entry["proofs"], gross, keysets)
            self._remove_from_entry(entry, inputs)
            send = split_amount(gross)
            keep = split_amount(_sum_proofs(inputs) - _fee_for(inputs, keysets) - gross)
            counters = self._reserve(wallet, keyset["id"], len(send) + len(keep))
            entry.setdefault("operations", []).append({
                "id": op_id,
                "kind": "send",
                "inputs": inputs,
                "keyset": keyset["id"],
                "outputs": [
                    *({"amount": part, "role": "send", "counter": counters[i]} for i, part in enumerate(send)),
                    *({"amount": part, "role": "keep", "counter": counters[len(send) + i]} for i, part in enumerate(keep)),
                ],
                "created": _now(),
            })

        await self._mutate(mutator)

        outcome = await self._with_active(op_id, lambda: self._run_swap(ctx, op_id))
        if outcome == "spent":
            raise CashuTokenSpentError("the selected proofs were already spent; run cashu-check")
        if outcome != "done":
            raise CashuUnavailableError(f"{ctx.url} has the send pending; run cashu-check")
        op = await self._read_op(ctx, op_id)
        return {"token": cc.encode_token(ctx.url, UNIT, op["sent"]), "amount": amount, "fee": gross - amount, "operationId": op_id}

    async def receive_cashu(self, token: str, name: str | None = None) -> dict[str, Any]:
        try:
            decoded = cc.decode_token(token)
        except cc.CashuTokenError as exc:
            raise _invalid("token") from exc
        # Refused before any request: a token cannot point Keymaster at a host.
        ctx = await self._context(normalize_mint_url(decoded["mint"]), name)
        await self._settle(ctx)
        keyset, keysets = await self._active_keyset(ctx)

        if decoded["unit"] != UNIT:
            raise _invalid("token")
        try:
            proofs = cc.resolve_keyset_ids(decoded["proofs"], [item["id"] for item in keysets])
        except cc.CashuTokenError as exc:
            raise _invalid("token") from exc
        for proof in proofs:
            try:
                keys = await ctx.client.keys(proof["id"])
            except (CashuMintError, KeyError, IndexError) as exc:
                raise _invalid("token") from exc
            key = keys.get(str(proof["amount"]))
            if key is None or ("dleq" in proof and not cc.verify_proof_dleq(proof, key)):
                raise _invalid("token")

        amount = _sum_proofs(proofs) - _fee_for(proofs, keysets)
        if amount <= 0:
            raise _invalid("token amount does not cover its fee")

        op_id = secrets.token_hex(16)

        async def mutator(wallet: dict[str, Any]) -> None:
            entry = await self._entry_of(wallet, ctx)
            held = {proof["secret"] for proof in entry["proofs"]}
            if any(proof["secret"] in held for proof in proofs):
                raise CashuTokenSpentError("this token is already in the wallet")
            parts = split_amount(amount)
            counters = self._reserve(wallet, keyset["id"], len(parts))
            entry.setdefault("operations", []).append({
                "id": op_id,
                "kind": "receive",
                "inputs": proofs,
                "keyset": keyset["id"],
                "outputs": [{"amount": part, "role": "keep", "counter": counters[i]} for i, part in enumerate(parts)],
                "created": _now(),
            })

        await self._mutate(mutator)

        outcome = await self._with_active(op_id, lambda: self._run_swap(ctx, op_id))
        if outcome == "spent":
            raise CashuTokenSpentError()
        if outcome == "open":
            raise CashuUnavailableError(f"{ctx.url} has the token pending; run cashu-check")
        return {"amount": amount, "mint": ctx.url}

    async def check_cashu(self, mint: str | None = None, name: str | None = None) -> dict[str, int]:
        total = {"settled": 0, "open": 0}
        identity = await self._bound_identity(name)
        for url, _ in await self._scoped_entries(mint, identity):
            result = await self._settle(await self._context(url, identity))
            total["settled"] += result["settled"]
            total["open"] += result["open"]
        return total

    async def restore_cashu(self, mint: str | None = None, name: str | None = None) -> dict[str, int]:
        ctx = await self._context(mint, name)
        await self._settle(ctx)
        totals = {"restored": 0, "amount": 0}
        # Every keyset, inactive included: proofs minted under a rotated keyset are
        # still redeemable.
        for keyset in await ctx.client.keysets():
            proofs, highest, _ = await self._scan_keyset(ctx, keyset["id"])
            spendable = await self._unspent(ctx, proofs)

            async def mutator(wallet: dict[str, Any], keyset_id: str = keyset["id"], top: int = highest, found: list[dict[str, Any]] = spendable) -> None:
                state = self._counters(wallet).setdefault(keyset_id, {"next": 0, "free": []})
                state["next"] = max(state["next"], top + 1)
                entry = await self._entry_of(wallet, ctx)
                before = len(entry["proofs"])
                value = _sum_proofs(entry["proofs"])
                self._credit(wallet, entry, found)
                totals["restored"] += len(entry["proofs"]) - before
                totals["amount"] += _sum_proofs(entry["proofs"]) - value

            await self._mutate(mutator)
        return totals

    async def reclaim_cashu(self, operation_id: str, name: str | None = None) -> dict[str, Any]:
        identity = await self._bound_identity(name)
        entries = await self._scoped_entries(None, identity)
        found = next(
            (url for url, entry in entries if any(op["id"] == operation_id and op.get("sent") for op in entry.get("operations") or [])),
            None,
        )
        if found is None:
            raise _invalid("operationId")
        ctx = await self._context(found, identity)
        keyset, keysets = await self._active_keyset(ctx)

        # The token becomes an ordinary swap's inputs, in one write, so the record
        # can be finished after a crash and the value never appears twice.
        swap_id = secrets.token_hex(16)

        async def mutator(wallet: dict[str, Any]) -> int:
            entry = await self._entry_of(wallet, ctx)
            op = next((item for item in entry.get("operations") or [] if item["id"] == operation_id and item.get("sent")), None)
            if op is None:
                raise _invalid("operationId")
            inputs = op["sent"]
            value = _sum_proofs(inputs) - _fee_for(inputs, keysets)
            parts = split_amount(value)
            counters = self._reserve(wallet, keyset["id"], len(parts))
            self._retire(entry, operation_id)
            entry.setdefault("operations", []).append({
                "id": swap_id,
                "kind": "swap",
                "inputs": inputs,
                "keyset": keyset["id"],
                "outputs": [{"amount": part, "role": "keep", "counter": counters[i]} for i, part in enumerate(parts)],
                "created": _now(),
            })
            return value

        amount = await self._mutate(mutator)

        outcome = await self._with_active(swap_id, lambda: self._run_swap(ctx, swap_id))
        if outcome == "spent":
            raise CashuTokenSpentError("the recipient already redeemed this token")
        if outcome != "done":
            raise CashuUnavailableError(f"{ctx.url} has the reclaim pending; run cashu-check")
        return {"amount": amount, "mint": ctx.url}
