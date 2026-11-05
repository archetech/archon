from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from keymaster import cli
from keymaster.cashu import CashuQuoteUnpaidError, CashuUnavailableError

QUOTE = {"quote": "quote-1", "request": "lnbc-invoice", "amount": 21, "state": "UNPAID"}
MINT = "https://mint.example"


class _Gatekeeper:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    async def connect(self, **kwargs: Any) -> None:
        return None

    async def close(self) -> None:
        return None


def _keymaster(**behaviour: Any) -> type:
    class Stub:
        calls: list[tuple[str, tuple]] = []

        def __init__(self, **kwargs: Any) -> None:
            pass

        def __getattr__(self, name: str) -> Any:
            async def call(*args: Any) -> Any:
                type(self).calls.append((name, args))
                result = behaviour[name]
                if callable(result):
                    return result()
                return result

            return call

    return Stub


def _run(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, argv: list[str], keymaster: type) -> int:
    wallet = tmp_path / "wallet.json"
    wallet.write_text(json.dumps({"version": 2, "seed": {}}))
    monkeypatch.setenv("ARCHON_PASSPHRASE", "passphrase")
    monkeypatch.setenv("ARCHON_WALLET_PATH", str(wallet))
    monkeypatch.setattr(cli, "GatekeeperClient", _Gatekeeper)
    monkeypatch.setattr(cli, "Keymaster", keymaster)
    monkeypatch.setattr(cli, "CASHU_CLAIM_DELAY_MS", 0)
    return cli.main(argv)


def _names(stub: type) -> list[str]:
    return [name for name, _ in stub.calls]


BALANCE = {"spendable": 21, "inFlight": 0, "outstanding": 0}


def test_mint_prints_the_quote_without_paying(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(create_cashu_mint_quote=QUOTE)

    assert _run(monkeypatch, tmp_path, ["cashu-mint", "21"], stub) == 0

    assert json.loads(capsys.readouterr().out) == QUOTE
    assert _names(stub) == ["create_cashu_mint_quote"]


def test_mint_pay_pays_claims_and_prints_the_balance(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(
        create_cashu_mint_quote=QUOTE,
        pay_lightning_invoice={"paymentHash": "hash"},
        claim_cashu_mint_quote={"amount": 21, "mint": MINT},
        get_cashu_balance=BALANCE,
    )

    assert _run(monkeypatch, tmp_path, ["cashu-mint", "21", "Alice", "--pay", "-m", MINT], stub) == 0

    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"amount": 21, "mint": MINT, "balance": BALANCE}
    assert "quote-1" in captured.err
    assert stub.calls == [
        ("create_cashu_mint_quote", (21, MINT, "Alice")),
        ("pay_lightning_invoice", ("lnbc-invoice", "Alice")),
        ("claim_cashu_mint_quote", ("quote-1", MINT, "Alice")),
        ("get_cashu_balance", (MINT, "Alice")),
    ]


def test_mint_pay_retries_a_claim_the_mint_has_not_seen(monkeypatch, tmp_path, capsys) -> None:
    attempts = iter([CashuQuoteUnpaidError("not yet"), {"amount": 21, "mint": MINT}])

    def claim() -> dict[str, Any]:
        outcome = next(attempts)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    stub = _keymaster(
        create_cashu_mint_quote=QUOTE,
        pay_lightning_invoice={},
        claim_cashu_mint_quote=claim,
        get_cashu_balance=BALANCE,
    )

    assert _run(monkeypatch, tmp_path, ["cashu-mint", "21", "--pay"], stub) == 0
    assert _names(stub).count("claim_cashu_mint_quote") == 2


def test_mint_pay_failure_leaves_the_quote_named_and_unclaimed(monkeypatch, tmp_path, capsys) -> None:
    def pay() -> None:
        raise RuntimeError("no route to host")

    stub = _keymaster(create_cashu_mint_quote=QUOTE, pay_lightning_invoice=pay)

    assert _run(monkeypatch, tmp_path, ["cashu-mint", "21", "--pay"], stub) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "quote-1" in captured.err
    assert "claim_cashu_mint_quote" not in _names(stub)


@pytest.mark.parametrize("amount", ["0", "1.5", "10abc", "1e3", "٣"])
def test_amount_is_refused_before_calling_keymaster(monkeypatch, tmp_path, capsys, amount: str) -> None:
    stub = _keymaster()

    assert _run(monkeypatch, tmp_path, ["cashu-send", amount], stub) == 1

    assert "positive whole number" in capsys.readouterr().err
    assert stub.calls == []


def test_send_prints_only_the_token_on_stdout(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(
        send_cashu={"token": "cashuBtoken", "amount": 21, "fee": 1, "operationId": "op-1"},
        get_cashu_balance=BALANCE,
    )

    assert _run(monkeypatch, tmp_path, ["cashu-send", "21"], stub) == 0

    captured = capsys.readouterr()
    assert captured.out.strip() == "cashuBtoken"
    assert "op-1" in captured.err
    assert "Balance: 21" in captured.err


def test_send_succeeds_when_the_balance_cannot_be_read(monkeypatch, tmp_path, capsys) -> None:
    def unavailable() -> None:
        raise CashuUnavailableError("mint down")

    stub = _keymaster(
        send_cashu={"token": "cashuBtoken", "amount": 21, "fee": 1, "operationId": "op-1"},
        get_cashu_balance=unavailable,
    )

    assert _run(monkeypatch, tmp_path, ["cashu-send", "21"], stub) == 0
    assert capsys.readouterr().out.strip() == "cashuBtoken"


def test_remove_passes_force_only_when_asked(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(remove_cashu=True)

    assert _run(monkeypatch, tmp_path, ["remove-cashu"], stub) == 0
    assert _run(monkeypatch, tmp_path, ["remove-cashu", "Alice", "--force"], stub) == 0

    assert stub.calls == [("remove_cashu", (False, None)), ("remove_cashu", (True, "Alice"))]
