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

from keymaster import KeymasterError, cli


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


# A write the node refuses ----------------------------------------------------

CLI_SOURCE = Path(cli.__file__).read_text(encoding="utf-8")


def _refusing(method: str) -> type:
    class Refusing:
        def __init__(self, **kwargs: Any) -> None:
            pass

    async def refuse(self: Any, *args: Any, **kwargs: Any) -> bool:
        return False

    setattr(Refusing, method, refuse)
    return Refusing


@pytest.mark.parametrize(
    ("argv", "method", "refusal"),
    [
        (["revoke-did", "did:cid:asset"], "revoke_did", "Update failed"),
        (["rotate-keys"], "rotate_keys", "Update failed"),
        (["change-registry", "did:cid:asset", "hyperswarm"], "change_registry", "Update failed"),
        (["accept-credential", "did:cid:credential"], "accept_credential", "Update failed"),
        (["unpublish-didcomm"], "unpublish_didcomm", "failed"),
    ],
)
def test_a_write_the_node_refuses_exits_non_zero_and_prints_no_ok(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str],
    argv: list[str], method: str, refusal: str,
) -> None:
    status = _invoke(monkeypatch, tmp_path, argv, _refusing(method))
    captured = capsys.readouterr()

    assert status == 1
    assert captured.out == ""
    assert captured.err == f"{refusal}\n"


def test_a_refused_credential_over_didcomm_prints_its_answer_and_exits_non_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    message = tmp_path / "message.json"
    message.write_text("{}")

    status = _invoke(monkeypatch, tmp_path, ["accept-credential-didcomm", str(message)], _refusing("accept_credential_didcomm"))
    captured = capsys.readouterr()

    assert status == 1
    assert json.loads(captured.out) == {"ok": False}
    assert captured.err == "Credential not accepted\n"


def test_a_write_the_node_takes_exits_zero_and_prints_ok(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    class Taking:
        def __init__(self, **kwargs: Any) -> None:
            pass

        async def rotate_keys(self) -> bool:
            return True

    assert _invoke(monkeypatch, tmp_path, ["rotate-keys"], Taking) == 0
    assert capsys.readouterr().out == "OK\n"


def _handlers() -> dict[str, str]:
    """The source of each command handler, by its name."""
    parts = CLI_SOURCE.split("\nasync def cmd_")[1:]
    return {part.split("(", 1)[0]: part.split("\n\n\n", 1)[0] for part in parts}


def test_every_handler_that_holds_a_write_result_reports_it_as_one() -> None:
    writes = {name: body for name, body in _handlers().items() if "ok = await km." in body}

    assert len(writes) > 30
    assert {"revoke_did", "rotate_keys", "change_registry", "update_grant", "revoke_grant", "accept_credential"} <= set(writes)
    unreported = sorted(
        name for name, body in writes.items()
        if "_report_write(ok" not in body
        and "raise CommandError(UPDATE_FAILED)" not in body
        and "if not ok:\n        raise CommandError(" not in body
    )
    assert unreported == []


def test_no_handler_prints_a_failure_on_standard_output() -> None:
    printed = [
        line.strip()
        for line in CLI_SOURCE.splitlines()
        if "print(" in line
        and "file=sys.stderr" not in line
        and ("UPDATE_FAILED" in line or "if ok else" in line or '"failed"' in line or '"Failed"' in line)
    ]

    assert printed == []


def _accepting(refusal: str | None = None) -> type:
    class Accepting:
        calls: list[tuple[str, Any]] = []

        def __init__(self, **kwargs: Any) -> None:
            pass

        async def accept_credential(self, did: str, options: Any = None) -> bool:
            type(self).calls.append((did, options))
            if refusal:
                raise KeymasterError(refusal)
            return True

    return Accepting


def test_accept_credential_gives_keymaster_the_alias_to_check_before_accepting(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    keymaster = _accepting()

    assert _invoke(monkeypatch, tmp_path, ["accept-credential", "did:cid:credential", "--alias", "license"], keymaster) == 0
    assert _invoke(monkeypatch, tmp_path, ["accept-credential", "did:cid:credential"], keymaster) == 0
    assert capsys.readouterr().out == "OK\nOK\n"
    assert keymaster.calls == [("did:cid:credential", {"alias": "license"}), ("did:cid:credential", {"alias": None})]


@pytest.mark.parametrize(
    ("alias", "refusal"),
    [
        ("", "Invalid parameter: alias must be a non-empty string"),
        ("Alice", "Invalid parameter: alias already used"),
    ],
)
def test_accept_credential_fails_with_keymasters_refusal_of_an_alias(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str], alias: str, refusal: str,
) -> None:
    keymaster = _accepting(refusal)

    status = _invoke(monkeypatch, tmp_path, ["accept-credential", "did:cid:credential", "--alias", alias], keymaster)
    captured = capsys.readouterr()

    assert status == 1
    assert captured.out == ""
    assert refusal in captured.err
    assert keymaster.calls == [("did:cid:credential", {"alias": alias})]
