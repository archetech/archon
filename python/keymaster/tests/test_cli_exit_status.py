"""A command that reports a failure has to exit non-zero (#1054).

Without it ``keymaster create-id alice && next`` runs ``next`` after alice
failed, and no script, Makefile or CI step can tell from the status. The JS CLI
sets ``process.exitCode``; here the dispatcher returns the code, so a handler
signals failure by raising.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from keymaster import cli


class _Gatekeeper:
    def __init__(self, url: str) -> None:
        self.url = url

    async def connect(self, **kwargs: Any) -> None:
        return None

    async def close(self) -> None:
        return None


def _invoke(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, argv: list[str], keymaster: type) -> int:
    wallet = tmp_path / "wallet.json"
    wallet.write_text(json.dumps({"version": 2, "seed": {}}))

    monkeypatch.setenv("ARCHON_PASSPHRASE", "passphrase")
    monkeypatch.setenv("ARCHON_WALLET_PATH", str(wallet))
    monkeypatch.setattr(cli, "GatekeeperClient", _Gatekeeper)
    monkeypatch.setattr(cli, "Keymaster", keymaster)

    return cli.main(argv)


def test_handler_that_raises_exits_non_zero(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class Failing:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def list_registries(self) -> list[str]:
            raise RuntimeError("gatekeeper said no")

    assert _invoke(monkeypatch, tmp_path, ["list-registries"], Failing) == 1


def test_handler_that_succeeds_exits_zero(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    class Working:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def list_registries(self) -> list[str]:
            return ["local"]

    assert _invoke(monkeypatch, tmp_path, ["list-registries"], Working) == 0


def test_reported_failure_exits_non_zero_and_says_why(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    # cmd_resolve_did catches the underlying error and reports its own
    # message, so nothing reaches the dispatcher unless the handler raises.
    class Unresolving:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def resolve_did(self, did: str, options: Any = None) -> dict[str, Any]:
            raise RuntimeError("no such DID")

    status = _invoke(monkeypatch, tmp_path, ["resolve-did", "did:cid:nope"], Unresolving)
    captured = capsys.readouterr()

    assert status == 1
    assert "cannot resolve did:cid:nope" in captured.err
    assert captured.out == ""
