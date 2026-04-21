from __future__ import annotations

from pathlib import Path
import requests
import sys


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keymaster_sdk import keymaster_sdk as sdk


class _DummyResponse:
    def __init__(self, content: bytes = b"abc", status_code: int = 200, text: str = "", headers=None) -> None:
        self.content = content
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise requests.HTTPError(response=self)


def test_resolve_and_fetch_helpers_forward_query_options(monkeypatch):
    calls: list[tuple[str, str, dict]] = []

    def fake_proxy_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if url.startswith("http://unit.test/api/v1/did/"):
            return {"docs": {"id": "did:test:alice"}}
        if url.startswith("http://unit.test/api/v1/assets/"):
            return {"asset": {"id": "did:test:asset"}}
        if url.startswith("http://unit.test/api/v1/dmail/") and url.endswith("/attachments?confirm=true"):
            return {"attachments": {"doc.txt": {"bytes": 3}}}
        if url.startswith("http://unit.test/api/v1/dmail/"):
            return {"message": {"subject": "hello"}}
        if url.startswith("http://unit.test/api/v1/vaults/") and url.endswith("/items?confirm=true"):
            return {"items": {"doc.txt": {"bytes": 3}}}
        if url.startswith("http://unit.test/api/v1/vaults/"):
            return {"vault": {"id": "did:test:vault"}}
        raise AssertionError(url)

    monkeypatch.setattr(sdk, "proxy_request", fake_proxy_request)
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    assert sdk.resolve_did("did:test:alice", {"confirm": True}) == {"id": "did:test:alice"}
    assert sdk.resolve_asset("did:test:asset", {"versionId": 1}) == {"id": "did:test:asset"}
    assert sdk.get_dmail_message("did:test:dmail", {"confirm": True}) == {"subject": "hello"}
    assert sdk.list_dmail_attachments("did:test:dmail", {"confirm": True}) == {"doc.txt": {"bytes": 3}}
    assert sdk.get_vault("did:test:vault", {"confirm": True}) == {"id": "did:test:vault"}
    assert sdk.list_vault_items("did:test:vault", {"confirm": True}) == {"doc.txt": {"bytes": 3}}

    assert calls == [
        ("GET", "http://unit.test/api/v1/did/did:test:alice?confirm=true", {}),
        ("GET", "http://unit.test/api/v1/assets/did:test:asset?versionId=1", {}),
        ("GET", "http://unit.test/api/v1/dmail/did:test:dmail?confirm=true", {}),
        ("GET", "http://unit.test/api/v1/dmail/did:test:dmail/attachments?confirm=true", {}),
        ("GET", "http://unit.test/api/v1/vaults/did:test:vault?confirm=true", {}),
        ("GET", "http://unit.test/api/v1/vaults/did:test:vault/items?confirm=true", {}),
    ]


def test_test_vault_posts_options_body(monkeypatch):
    calls: list[tuple[str, str, dict]] = []

    def fake_proxy_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return {"test": True}

    monkeypatch.setattr(sdk, "proxy_request", fake_proxy_request)
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    assert sdk.test_vault("did:test:vault", {"confirm": True}) is True
    assert calls == [
        (
            "POST",
            "http://unit.test/api/v1/vaults/did:test:vault/test",
            {"json": {"options": {"confirm": True}}},
        )
    ]


def test_get_vault_item_forwards_query_options(monkeypatch):
    requested_urls: list[str] = []

    class _Session:
        def get(self, url):
            requested_urls.append(url)
            return _DummyResponse(content=b"abc")

    monkeypatch.setattr(sdk, "_session", _Session())
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    assert sdk.get_vault_item("did:test:vault", "doc.txt", {"confirm": True}) == b"abc"
    assert requested_urls == ["http://unit.test/api/v1/vaults/did:test:vault/items/doc.txt?confirm=true"]


def test_get_vault_item_raises_keymaster_error_on_server_error(monkeypatch):
    class _Session:
        def get(self, url):
            return _DummyResponse(status_code=500, text='{"message":"boom"}')

    monkeypatch.setattr(sdk, "_session", _Session())
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    try:
        sdk.get_vault_item("did:test:vault", "missing.txt")
    except sdk.KeymasterError as exc:
        assert str(exc) == 'Error 500: {"message":"boom"}'
    else:
        raise AssertionError("expected KeymasterError")


def test_binary_getters_match_ts_client_behavior(monkeypatch):
    requested: list[tuple[str, dict | None]] = []

    class _Session:
        def get(self, url, headers=None):
            requested.append((url, headers))
            if url.endswith("/images/image-1"):
                return _DummyResponse(
                    content=b"png",
                    headers={
                        "X-Metadata": '{"file":{"cid":"cid-image","filename":"image.png","type":"image/png","bytes":3},"image":{"width":1,"height":1}}'
                    },
                )
            if url.endswith("/files/file-1"):
                return _DummyResponse(
                    content=b"abc",
                    headers={"X-Metadata": '{"cid":"cid-file","filename":"doc.txt","type":"text/plain","bytes":3}'},
                )
            if url.endswith("/images/missing") or url.endswith("/files/missing"):
                return _DummyResponse(status_code=404, text="missing")
            raise AssertionError(url)

    monkeypatch.setattr(sdk, "_session", _Session())
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    assert sdk.get_image("image-1") == {
        "file": {"cid": "cid-image", "filename": "image.png", "type": "image/png", "bytes": 3, "data": b"png"},
        "image": {"width": 1, "height": 1},
    }
    assert sdk.get_file("file-1") == {
        "cid": "cid-file",
        "filename": "doc.txt",
        "type": "text/plain",
        "bytes": 3,
        "data": b"abc",
    }
    assert sdk.get_image("missing") is None
    assert sdk.get_file("missing") is None

    assert requested == [
        ("http://unit.test/api/v1/images/image-1", {"Accept": "application/octet-stream"}),
        ("http://unit.test/api/v1/files/file-1", {"Accept": "application/octet-stream"}),
        ("http://unit.test/api/v1/images/missing", {"Accept": "application/octet-stream"}),
        ("http://unit.test/api/v1/files/missing", {"Accept": "application/octet-stream"}),
    ]


def test_nullable_binary_items_return_none_on_missing_or_empty(monkeypatch):
    responses = iter(
        [
            _DummyResponse(content=b""),
            _DummyResponse(status_code=404, text="missing"),
            _DummyResponse(content=b""),
            _DummyResponse(status_code=404, text="missing"),
        ]
    )

    class _Session:
        def get(self, url, headers=None):
            return next(responses)

    monkeypatch.setattr(sdk, "_session", _Session())
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    assert sdk.get_vault_item("did:test:vault", "doc.txt") is None
    assert sdk.get_vault_item("did:test:vault", "missing.txt") is None
    assert sdk.get_dmail_attachment("did:test:dmail", "doc.txt") is None
    assert sdk.get_dmail_attachment("did:test:dmail", "missing.txt") is None


def test_missing_sdk_wrappers_forward_expected_requests(monkeypatch):
    calls: list[tuple[str, str, dict]] = []

    def fake_proxy_request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        if url.endswith("/change-registry"):
            return {"ok": True}
        if url.endswith("/addresses") and method == "GET":
            return {"addresses": {"alice@example.com": {"added": "now"}}}
        if "/addresses/archon.social" in url:
            return {"address": {"address": "alice@archon.social"}}
        if url.endswith("/addresses/import"):
            return {"addresses": {"alice@archon.social": {"added": "now"}}}
        if "/addresses/check/" in url:
            return {"address": "alice@archon.social", "available": False}
        if url.endswith("/addresses") and method == "POST":
            return {"ok": True}
        if "/addresses/" in url and method == "DELETE":
            return {"ok": True}
        if url.endswith("/nostr/import"):
            return {"npub": "npub1imported"}
        raise AssertionError(url)

    monkeypatch.setattr(sdk, "proxy_request", fake_proxy_request)
    monkeypatch.setattr(sdk, "_keymaster_api", "http://unit.test/api/v1")

    assert sdk.change_registry("Alice", "hyperswarm") is True
    assert sdk.list_addresses() == {"alice@example.com": {"added": "now"}}
    assert sdk.get_address("archon.social") == {"address": "alice@archon.social"}
    assert sdk.import_address("archon.social") == {"alice@archon.social": {"added": "now"}}
    assert sdk.check_address("alice@archon.social") == {"address": "alice@archon.social", "available": False}
    assert sdk.add_address("alice@archon.social") is True
    assert sdk.remove_address("alice@archon.social") is True
    assert sdk.import_nostr("nsec1test", "Alice") == {"npub": "npub1imported"}

    assert calls == [
        ("POST", "http://unit.test/api/v1/ids/Alice/change-registry", {"json": {"registry": "hyperswarm"}}),
        ("GET", "http://unit.test/api/v1/addresses", {}),
        ("GET", "http://unit.test/api/v1/addresses/archon.social", {}),
        ("POST", "http://unit.test/api/v1/addresses/import", {"json": {"domain": "archon.social"}}),
        ("GET", "http://unit.test/api/v1/addresses/check/alice@archon.social", {}),
        ("POST", "http://unit.test/api/v1/addresses", {"json": {"address": "alice@archon.social"}}),
        ("DELETE", "http://unit.test/api/v1/addresses/alice%40archon.social", {}),
        ("POST", "http://unit.test/api/v1/nostr/import", {"json": {"nsec": "nsec1test", "id": "Alice"}}),
    ]


def test_stream_aliases_and_connection_helpers(monkeypatch):
    create_calls: list[tuple] = []
    update_calls: list[tuple] = []
    readiness_checks: list[str] = []
    sleeps: list[int] = []

    monkeypatch.setattr(sdk, "create_file", lambda data, options=None: create_calls.append((data, options)) or "did:test:file")
    monkeypatch.setattr(sdk, "update_file", lambda identifier, data, options=None: update_calls.append((identifier, data, options)) or True)

    ready_sequence = iter([False, False, True])
    monkeypatch.setattr(sdk, "is_ready", lambda: readiness_checks.append("ready") or next(ready_sequence))
    monkeypatch.setattr(sdk.time, "sleep", lambda seconds: sleeps.append(seconds))
    monkeypatch.setattr(sdk, "_keymaster_api", "http://start.test/api/v1")
    monkeypatch.setattr(sdk, "_base_url", "http://start.test")
    sdk._session.headers.clear()

    assert sdk.create_file_stream(b"abc", {"filename": "doc.txt"}) == "did:test:file"
    assert sdk.update_file_stream("did:test:file", b"abc", {"filename": "doc.txt"}) is True

    sdk.add_custom_header("X-Test", "value")
    assert sdk._session.headers["X-Test"] == "value"
    sdk.remove_custom_header("X-Test")
    assert "X-Test" not in sdk._session.headers

    sdk.connect(
        {
            "url": "http://unit.test",
            "apiKey": "secret",
            "waitUntilReady": True,
            "intervalSeconds": 2,
            "maxRetries": 5,
        }
    )

    assert create_calls == [(b"abc", {"filename": "doc.txt"})]
    assert update_calls == [("did:test:file", b"abc", {"filename": "doc.txt"})]
    assert sdk._base_url == "http://unit.test"
    assert sdk._keymaster_api == "http://unit.test/api/v1"
    assert sdk._session.headers["Authorization"] == "Bearer secret"
    assert readiness_checks == ["ready", "ready", "ready"]
    assert sleeps == [2, 2]


def test_create_returns_configured_sdk_module(monkeypatch):
    connect_calls: list[dict] = []

    monkeypatch.setattr(sdk, "connect", lambda options=None: connect_calls.append(options or {}))

    created = sdk.create({"url": "http://unit.test", "apiKey": "secret"})

    assert created is sdk
    assert connect_calls == [{"url": "http://unit.test", "apiKey": "secret"}]
