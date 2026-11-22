"""The grant commands of the Python CLI: what each passes to Keymaster and
prints. tests/keymaster/grant-cli.test.ts is this file for scripts/archon-cli.js.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from keymaster import cli

LINK = "archon://grant?request=abc"
GRANTS = [{"did": "did:cid:grant", "status": "pending", "grant": {"v": 1, "client": "did:cid:client"}, "registry": "BTC:mainnet", "created": True}]


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
                if isinstance(result, Exception):
                    raise result
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
    return cli.main(argv)


def test_create_grant_passes_the_link_alone_and_prints_the_did(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(create_grant="did:cid:grant")

    assert _run(monkeypatch, tmp_path, ["create-grant", LINK], stub) == 0
    assert capsys.readouterr().out.strip() == "did:cid:grant"
    assert stub.calls == [("create_grant", (LINK, {}))]


def test_create_grant_passes_its_options(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(create_grant="did:cid:grant")
    argv = [
        "create-grant", LINK, "-r", "ETH:mainnet", "-a", "memepool-grant",
        "--actions", "memeplex:post, memeplex:tag,", "--expires", "2028-01-01T00:00:00Z",
    ]

    assert _run(monkeypatch, tmp_path, argv, stub) == 0
    assert stub.calls == [("create_grant", (LINK, {
        "alias": "memepool-grant",
        "registry": "ETH:mainnet",
        "actions": ["memeplex:post", "memeplex:tag"],
        "expiresAt": "2028-01-01T00:00:00Z",
    }))]


def test_create_grant_no_expiry_passes_none(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(create_grant="did:cid:grant")

    assert _run(monkeypatch, tmp_path, ["create-grant", LINK, "--no-expiry"], stub) == 0
    assert stub.calls == [("create_grant", (LINK, {"expiresAt": None}))]


def test_create_grant_passes_an_empty_list_of_actions_for_keymaster_to_refuse(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(create_grant="did:cid:grant")

    assert _run(monkeypatch, tmp_path, ["create-grant", LINK, "--actions", ""], stub) == 0
    assert stub.calls == [("create_grant", (LINK, {"actions": []}))]


def test_a_refusal_fails_the_command_and_is_printed(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(create_grant=cli.KeymasterError("Invalid parameter: link: not-a-grant-link"))

    assert _run(monkeypatch, tmp_path, ["create-grant", "https://example.com"], stub) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "Invalid parameter: link: not-a-grant-link" in captured.err


def test_list_grants_prints_the_grants(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(list_grants=GRANTS)

    assert _run(monkeypatch, tmp_path, ["list-grants"], stub) == 0
    assert json.loads(capsys.readouterr().out) == GRANTS
    assert stub.calls == [("list_grants", ())]


@pytest.mark.parametrize(
    ("options", "changes"),
    [
        (["--actions", "memeplex:tag"], {"actions": ["memeplex:tag"]}),
        (["--all-actions"], {"actions": None}),
        (["--expires", "2028-01-01T00:00:00Z"], {"expiresAt": "2028-01-01T00:00:00Z"}),
        (["--no-expiry"], {"expiresAt": None}),
        (["--all-actions", "--no-expiry"], {"actions": None, "expiresAt": None}),
        (["--actions", "memeplex:tag,memeplex:rate", "--expires", "2028-01-01T00:00:00Z"],
         {"actions": ["memeplex:tag", "memeplex:rate"], "expiresAt": "2028-01-01T00:00:00Z"}),
        ([], {}),
    ],
)
def test_update_grant_passes_the_changes_asked_for(monkeypatch, tmp_path, capsys, options, changes) -> None:
    stub = _keymaster(update_grant=True)

    assert _run(monkeypatch, tmp_path, ["update-grant", "did:cid:grant", *options], stub) == 0
    assert capsys.readouterr().out.strip() == "OK"
    assert stub.calls == [("update_grant", ("did:cid:grant", changes))]


@pytest.mark.parametrize(
    ("command", "message"),
    [
        (["update-grant", "did:cid:grant", "--actions", "memeplex:tag", "--all-actions"], "--actions and --all-actions cannot be used together"),
        (["update-grant", "did:cid:grant", "--expires", "2028-01-01T00:00:00Z", "--no-expiry"], "--expires and --no-expiry cannot be used together"),
        (["create-grant", LINK, "--expires", "2028-01-01T00:00:00Z", "--no-expiry"], "--expires and --no-expiry cannot be used together"),
    ],
)
def test_options_that_contradict_each_other_are_refused_before_calling_keymaster(monkeypatch, tmp_path, capsys, command, message) -> None:
    stub = _keymaster(update_grant=True, create_grant="did:cid:grant")

    assert _run(monkeypatch, tmp_path, command, stub) == 1
    assert message in capsys.readouterr().err
    assert stub.calls == []


def test_update_grant_says_when_the_node_did_not_accept_the_change(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(update_grant=False)

    assert _run(monkeypatch, tmp_path, ["update-grant", "did:cid:grant", "--no-expiry"], stub) == 0
    assert capsys.readouterr().out.strip() == "Update failed"


def test_revoke_grant_revokes_and_prints_ok(monkeypatch, tmp_path, capsys) -> None:
    stub = _keymaster(revoke_grant=True)

    assert _run(monkeypatch, tmp_path, ["revoke-grant", "memepool-grant"], stub) == 0
    assert capsys.readouterr().out.strip() == "OK"
    assert stub.calls == [("revoke_grant", ("memepool-grant",))]
