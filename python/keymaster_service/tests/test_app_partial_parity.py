from __future__ import annotations

import asyncio
import importlib
from pathlib import Path
import sys
import types
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "keymaster" / "src"))


def _install_fastapi_stubs() -> None:
    if "fastapi" in sys.modules:
        return

    fastapi: Any = types.ModuleType("fastapi")
    responses: Any = types.ModuleType("fastapi.responses")
    prometheus: Any = types.ModuleType("prometheus_client")

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail):
            super().__init__(detail)
            self.status_code = status_code
            self.detail = detail

    class Request:
        def __init__(self, query_params=None, headers=None):
            self.query_params = query_params or {}
            self.headers = headers or {}

    class APIRouter:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def _decorator(self, *args, **kwargs):
            def decorate(func):
                return func

            return decorate

        get = post = put = delete = _decorator

    class FastAPI:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def exception_handler(self, *args, **kwargs):
            def decorate(func):
                return func

            return decorate

        def include_router(self, *args, **kwargs):
            return None

        def get(self, *args, **kwargs):
            def decorate(func):
                return func

            return decorate

        def api_route(self, *args, **kwargs):
            def decorate(func):
                return func

            return decorate

    def Depends(value):
        return value

    class Response:
        pass

    class JSONResponse(Response):
        def __init__(self, status_code: int = 200, content=None):
            self.status_code = status_code
            self.content = content

    class PlainTextResponse(Response):
        def __init__(self, content: str = "", media_type: str | None = None):
            self.content = content
            self.media_type = media_type

    fastapi.APIRouter = APIRouter
    fastapi.Depends = Depends
    fastapi.FastAPI = FastAPI
    fastapi.HTTPException = HTTPException
    fastapi.Request = Request
    responses.JSONResponse = JSONResponse
    responses.PlainTextResponse = PlainTextResponse
    responses.Response = Response
    prometheus.CONTENT_TYPE_LATEST = "text/plain"
    prometheus.generate_latest = lambda: b""

    sys.modules["fastapi"] = fastapi
    sys.modules["fastapi.responses"] = responses
    sys.modules["prometheus_client"] = prometheus


_install_fastapi_stubs()

app_module = importlib.import_module("keymaster_service.app")
service_module = importlib.import_module("keymaster_service.service")


def run(coro):
    return asyncio.run(coro)


class StubService:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def change_passphrase(self, passphrase: str) -> bool:
        self.calls.append(("change_passphrase", passphrase))
        return True

    async def change_registry(self, identifier: str, registry: str) -> bool:
        self.calls.append(("change_registry", identifier, registry))
        return True

    async def create_asset(self, data, options):
        self.calls.append(("create_asset", data, options))
        return "did:test:asset"

    async def list_addresses(self):
        self.calls.append(("list_addresses",))
        return {"alice@archon.social": {"added": "2026-04-04T13:00:00.000Z"}}

    async def get_address(self, domain: str):
        self.calls.append(("get_address", domain))
        return {
            "domain": domain,
            "name": "alice",
            "address": f"alice@{domain}",
            "added": "2026-04-04T13:00:00.000Z",
        }

    async def import_address(self, domain: str):
        self.calls.append(("import_address", domain))
        return {f"alice@{domain}": {"added": "2026-04-04T13:00:00.000Z"}}

    async def check_address(self, address: str):
        self.calls.append(("check_address", address))
        return {"address": address, "status": "claimed", "available": False, "did": "did:test:alice"}

    async def add_address(self, address: str) -> bool:
        self.calls.append(("add_address", address))
        return True

    async def remove_address(self, address: str) -> bool:
        self.calls.append(("remove_address", address))
        return True

    async def merge_data(self, identifier: str, data) -> bool:
        self.calls.append(("merge_data", identifier, data))
        return True

    async def transfer_asset(self, identifier: str, controller: str) -> bool:
        self.calls.append(("transfer_asset", identifier, controller))
        return True

    async def clone_asset(self, identifier: str, options):
        self.calls.append(("clone_asset", identifier, options))
        return "did:test:clone"

    async def create_notice(self, message, options):
        self.calls.append(("create_notice", message, options))
        return "did:test:notice"

    async def refresh_notices(self) -> bool:
        self.calls.append(("refresh_notices",))
        return True

    async def update_notice(self, identifier: str, message) -> bool:
        self.calls.append(("update_notice", identifier, message))
        return True

    async def export_encrypted_wallet(self):
        self.calls.append(("export_encrypted_wallet",))
        return {"version": 2, "seed": {"mnemonicEnc": {}}, "enc": "wallet"}

    async def bind_credential(self, subject: str, options):
        self.calls.append(("bind_credential", subject, options))
        return {"issuer": "did:test:issuer", "credentialSubject": {"id": subject}}

    async def list_credentials(self):
        self.calls.append(("list_credentials",))
        return ["did:test:credential"]

    async def accept_credential(self, did: str) -> bool:
        self.calls.append(("accept_credential", did))
        return True

    async def get_credential(self, identifier: str):
        self.calls.append(("get_credential", identifier))
        return {"issuer": "did:test:issuer", "credentialSubject": {"id": "did:test:alice"}}

    async def remove_credential(self, identifier: str) -> bool:
        self.calls.append(("remove_credential", identifier))
        return True

    async def publish_credential(self, identifier: str, options):
        self.calls.append(("publish_credential", identifier, options))
        return {"credentialSubject": {"id": "did:test:alice"}}

    async def unpublish_credential(self, identifier: str):
        self.calls.append(("unpublish_credential", identifier))
        return f"OK credential {identifier} removed from manifest"

    async def list_issued(self):
        self.calls.append(("list_issued",))
        return ["did:test:issued"]

    async def issue_credential(self, credential, options):
        self.calls.append(("issue_credential", credential, options))
        return "did:test:issued"

    async def send_credential(self, identifier: str, options):
        self.calls.append(("send_credential", identifier, options))
        return "did:test:notice"

    async def update_credential(self, identifier: str, credential) -> bool:
        self.calls.append(("update_credential", identifier, credential))
        return True

    async def revoke_credential(self, identifier: str) -> bool:
        self.calls.append(("revoke_credential", identifier))
        return True


@pytest.fixture
def stub_service(monkeypatch: pytest.MonkeyPatch) -> StubService:
    stub = StubService()
    monkeypatch.setattr(app_module, "service", stub)
    return stub


def test_wallet_passphrase_handler(stub_service: StubService):
    result = run(app_module.wallet_passphrase({"passphrase": "new-passphrase"}))

    assert result == {"ok": True}
    assert stub_service.calls == [("change_passphrase", "new-passphrase")]


def test_service_module_exports_singleton():
    assert hasattr(service_module, "service")
    assert hasattr(service_module, "settings")


def test_change_registry_handler(stub_service: StubService):
    result = run(app_module.change_registry("alice", {"registry": "hyperswarm"}))

    assert result == {"ok": True}
    assert stub_service.calls == [("change_registry", "alice", "hyperswarm")]


def test_asset_handlers(stub_service: StubService):
    created = run(app_module.create_asset({"data": {"name": "asset"}, "options": {"registry": "local"}}))
    updated = run(app_module.update_asset("did:test:asset", {"data": {"count": 1}}))
    transferred = run(app_module.transfer_asset("did:test:asset", {"controller": "did:test:alice"}))
    cloned = run(app_module.clone_asset("did:test:asset", {"options": {"registry": "hyperswarm"}}))
    exported = run(app_module.export_wallet_encrypted())

    assert created == {"did": "did:test:asset"}
    assert updated == {"ok": True}
    assert transferred == {"ok": True}
    assert cloned == {"did": "did:test:clone"}
    assert exported == {"wallet": {"version": 2, "seed": {"mnemonicEnc": {}}, "enc": "wallet"}}
    assert stub_service.calls == [
        ("create_asset", {"name": "asset"}, {"registry": "local"}),
        ("merge_data", "did:test:asset", {"count": 1}),
        ("transfer_asset", "did:test:asset", "did:test:alice"),
        ("clone_asset", "did:test:asset", {"registry": "hyperswarm"}),
        ("export_encrypted_wallet",),
    ]


def test_address_handlers(stub_service: StubService):
    listed = run(app_module.list_addresses())
    fetched = run(app_module.get_address("archon.social"))
    imported = run(app_module.import_address({"domain": "archon.social"}))
    checked = run(app_module.check_address("alice@archon.social"))
    added = run(app_module.add_address({"address": "alice@archon.social"}))
    removed = run(app_module.remove_address("alice@archon.social"))

    assert listed == {"addresses": {"alice@archon.social": {"added": "2026-04-04T13:00:00.000Z"}}}
    assert fetched == {
        "address": {
            "domain": "archon.social",
            "name": "alice",
            "address": "alice@archon.social",
            "added": "2026-04-04T13:00:00.000Z",
        }
    }
    assert imported == {"addresses": {"alice@archon.social": {"added": "2026-04-04T13:00:00.000Z"}}}
    assert checked == {
        "address": "alice@archon.social",
        "status": "claimed",
        "available": False,
        "did": "did:test:alice",
    }
    assert added == {"ok": True}
    assert removed == {"ok": True}
    assert stub_service.calls == [
        ("list_addresses",),
        ("get_address", "archon.social"),
        ("import_address", "archon.social"),
        ("check_address", "alice@archon.social"),
        ("add_address", "alice@archon.social"),
        ("remove_address", "alice@archon.social"),
    ]


def test_credential_handlers(stub_service: StubService):
    bound = run(app_module.bind_credential({"subject": "did:test:alice", "options": {"schema": "did:test:schema"}}))
    held = run(app_module.list_credentials())
    accepted = run(app_module.accept_credential({"did": "did:test:credential"}))
    got = run(app_module.get_credential("did:test:credential"))
    removed = run(app_module.remove_credential("did:test:credential"))
    published = run(app_module.publish_credential("did:test:credential", {"options": {"reveal": True}}))
    unpublished = run(app_module.unpublish_credential("did:test:credential"))
    issued = run(app_module.list_issued())
    created = run(app_module.issue_credential({"credential": {"issuer": "did:test:issuer"}, "options": {}}))
    sent = run(app_module.send_credential("did:test:credential", {"options": {}}))
    updated = run(app_module.update_credential("did:test:credential", {"credential": {"issuer": "did:test:issuer", "credentialSubject": {"id": "did:test:alice"}}}))
    revoked = run(app_module.revoke_credential("did:test:credential"))

    assert bound == {"credential": {"issuer": "did:test:issuer", "credentialSubject": {"id": "did:test:alice"}}}
    assert held == {"held": ["did:test:credential"]}
    assert accepted == {"ok": True}
    assert got == {"credential": {"issuer": "did:test:issuer", "credentialSubject": {"id": "did:test:alice"}}}
    assert removed == {"ok": True}
    assert published == {"ok": {"credentialSubject": {"id": "did:test:alice"}}}
    assert unpublished == {"ok": "OK credential did:test:credential removed from manifest"}
    assert issued == {"issued": ["did:test:issued"]}
    assert created == {"did": "did:test:issued"}
    assert sent == {"did": "did:test:notice"}
    assert updated == {"ok": True}
    assert revoked == {"ok": True}
    assert stub_service.calls == [
        ("bind_credential", "did:test:alice", {"schema": "did:test:schema"}),
        ("list_credentials",),
        ("accept_credential", "did:test:credential"),
        ("get_credential", "did:test:credential"),
        ("remove_credential", "did:test:credential"),
        ("publish_credential", "did:test:credential", {"reveal": True}),
        ("unpublish_credential", "did:test:credential"),
        ("list_issued",),
        ("issue_credential", {"issuer": "did:test:issuer"}, {}),
        ("send_credential", "did:test:credential", {}),
        ("update_credential", "did:test:credential", {"issuer": "did:test:issuer", "credentialSubject": {"id": "did:test:alice"}}),
        ("revoke_credential", "did:test:credential"),
    ]


def test_notice_handlers(stub_service: StubService):
    created = run(app_module.create_notice({"message": {"to": ["did:test:alice"], "dids": ["did:test:credential"]}, "options": {"registry": "hyperswarm"}}))
    refreshed = run(app_module.refresh_notices())
    updated = run(app_module.update_notice("did:test:notice", {"message": {"to": ["did:test:alice"], "dids": ["did:test:credential", "did:test:credential-2"]}}))

    assert created == {"did": "did:test:notice"}
    assert refreshed == {"ok": True}
    assert updated == {"ok": True}
    assert stub_service.calls == [
        ("create_notice", {"to": ["did:test:alice"], "dids": ["did:test:credential"]}, {"registry": "hyperswarm"}),
        ("refresh_notices",),
        ("update_notice", "did:test:notice", {"to": ["did:test:alice"], "dids": ["did:test:credential", "did:test:credential-2"]}),
    ]