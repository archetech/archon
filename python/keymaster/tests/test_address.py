from __future__ import annotations

import pytest

from keymaster import KeymasterError

from .helpers import run


class FakeResponse:
    def __init__(self, status_code: int, data=None, headers: dict[str, str] | None = None):
        self.status_code = status_code
        self._data = data
        self.headers = headers or {"content-type": "application/json; charset=utf-8"}

    def json(self):
        if isinstance(self._data, Exception):
            raise self._data
        return self._data


def test_list_addresses_defaults_to_empty(testbed):
    assert run(testbed.keymaster.list_addresses()) == {}


def test_get_address_returns_stored_domain_entry(testbed):
    run(testbed.keymaster.create_id("Alice"))
    wallet = run(testbed.keymaster.load_wallet())
    wallet["ids"]["Alice"]["addresses"] = {"archon.social": {"name": "alice", "added": "2026-04-04T13:00:00.000Z"}}
    assert run(testbed.keymaster.save_wallet(wallet, True)) is True

    assert run(testbed.keymaster.get_address("archon.social")) == {
        "domain": "archon.social",
        "name": "alice",
        "address": "alice@archon.social",
        "added": "2026-04-04T13:00:00.000Z",
    }


def test_import_address_stores_matching_remote_name(testbed, monkeypatch: pytest.MonkeyPatch):
    alice = run(testbed.keymaster.create_id("Alice"))

    async def fake_request(method: str, url: str, headers=None, json_body=None):
        _ = (method, headers, json_body)
        assert url == "https://archon.social/.well-known/names"
        return FakeResponse(200, {"names": {"alice": alice, "bob": "did:test:9999"}})

    monkeypatch.setattr(testbed.keymaster, "_http_request", fake_request)
    imported = run(testbed.keymaster.import_address("archon.social"))

    assert list(imported.keys()) == ["alice@archon.social"]
    assert run(testbed.keymaster.list_addresses()) == imported


def test_check_address_reports_available_claimed_unsupported_and_unreachable(testbed, monkeypatch: pytest.MonkeyPatch):
    responses = {
        "https://archon.social/.well-known/names/alice": FakeResponse(404, {"error": "Name not found"}),
        "https://archon.social/.well-known/names/bob": FakeResponse(200, {"did": "did:test:bob"}),
        "https://google.com/.well-known/names/alice": FakeResponse(404, "<html>404</html>", {"content-type": "text/html; charset=utf-8"}),
    }

    async def fake_request(method: str, url: str, headers=None, json_body=None):
        _ = (method, headers, json_body)
        if url == "https://lucifer.com/.well-known/names/alice":
            raise RuntimeError("boom")
        return responses[url]

    monkeypatch.setattr(testbed.keymaster, "_http_request", fake_request)

    assert run(testbed.keymaster.check_address("alice@archon.social"))["status"] == "available"
    assert run(testbed.keymaster.check_address("bob@archon.social")) == {
        "address": "bob@archon.social",
        "status": "claimed",
        "available": False,
        "did": "did:test:bob",
    }
    assert run(testbed.keymaster.check_address("alice@google.com"))["status"] == "unsupported"
    assert run(testbed.keymaster.check_address("alice@lucifer.com"))["status"] == "unreachable"


def test_add_and_remove_address_updates_wallet(testbed, monkeypatch: pytest.MonkeyPatch):
    run(testbed.keymaster.create_id("Alice"))

    async def fake_bearer(domain: str) -> str:
        assert domain == "archon.social"
        return "did:test:response"

    async def fake_fetch(domain: str, path: str, method: str, headers, json_body, fallback: str):
        _ = (headers, fallback)
        assert domain == "archon.social"
        assert path == "name"
        if method == "PUT":
            assert json_body == {"name": "alice"}
        return FakeResponse(200, {"ok": True})

    monkeypatch.setattr(testbed.keymaster, "create_address_bearer_token", fake_bearer)
    monkeypatch.setattr(testbed.keymaster, "fetch_address_api_response", fake_fetch)

    assert run(testbed.keymaster.add_address("alice@archon.social")) is True
    stored = run(testbed.keymaster.get_address("archon.social"))
    assert stored is not None
    assert stored["address"] == "alice@archon.social"

    assert run(testbed.keymaster.remove_address("alice@archon.social")) is True
    assert run(testbed.keymaster.list_addresses()) == {}


def test_remove_address_rejects_mismatched_stored_name(testbed):
    run(testbed.keymaster.create_id("Alice"))
    wallet = run(testbed.keymaster.load_wallet())
    wallet["ids"]["Alice"]["addresses"] = {"archon.social": {"name": "alice2", "added": "2026-04-04T13:00:00.000Z"}}
    assert run(testbed.keymaster.save_wallet(wallet, True)) is True

    with pytest.raises(KeymasterError, match="Invalid parameter: address"):
        run(testbed.keymaster.remove_address("alice@archon.social"))