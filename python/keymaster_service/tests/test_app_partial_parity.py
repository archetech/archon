from __future__ import annotations

import asyncio
import importlib
import json
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
        def __init__(self, query_params=None, headers=None, body: bytes = b""):
            self.query_params = query_params or {}
            self.headers = headers or {}
            self._body = body

        async def body(self):
            return self._body

    class APIRouter:
        def __init__(self, *args, **kwargs):
            self.args = args
            self.kwargs = kwargs

        def _decorator(self, *args, **kwargs):
            def decorate(func):
                return func

            return decorate

        get = post = put = delete = api_route = _decorator

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
        def __init__(self, content=None, media_type: str | None = None, headers=None, status_code: int = 200):
            self.content = content
            self.media_type = media_type
            self.headers = headers or {}
            self.status_code = status_code

    class JSONResponse(Response):
        def __init__(self, status_code: int = 200, content=None):
            super().__init__(content=content, status_code=status_code)

    class PlainTextResponse(Response):
        def __init__(self, content: str = "", media_type: str | None = None):
            super().__init__(content=content, media_type=media_type)

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

    async def create_vault(self, options):
        self.calls.append(("create_vault", options))
        return "did:test:vault"

    async def create_image(self, data: bytes, options):
        self.calls.append(("create_image", data, options))
        return "did:test:image"

    async def update_image(self, identifier: str, data: bytes, options):
        self.calls.append(("update_image", identifier, data, options))
        return True

    async def get_image(self, identifier: str):
        self.calls.append(("get_image", identifier))
        return {
            "file": {
                "cid": "cid-image",
                "filename": "image.png",
                "type": "image/png",
                "bytes": 68,
                "data": b"png-bytes",
            },
            "image": {
                "width": 1,
                "height": 1,
            },
        }

    async def test_image(self, identifier: str) -> bool:
        self.calls.append(("test_image", identifier))
        return True

    async def create_file_stream(self, data: bytes, options):
        self.calls.append(("create_file_stream", data, options))
        return "did:test:file"

    async def update_file_stream(self, identifier: str, data: bytes, options):
        self.calls.append(("update_file_stream", identifier, data, options))
        return True

    async def get_file(self, identifier: str):
        self.calls.append(("get_file", identifier))
        return {
            "cid": "cid-file",
            "filename": "doc.txt",
            "type": "text/plain",
            "bytes": 3,
            "data": b"abc",
        }

    async def test_file(self, identifier: str) -> bool:
        self.calls.append(("test_file", identifier))
        return True

    async def poll_template(self):
        self.calls.append(("poll_template",))
        return {
            "version": 2,
            "name": "poll-name",
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": "2026-04-11T13:00:00.000Z",
        }

    async def list_polls(self, owner=None):
        self.calls.append(("list_polls", owner))
        return ["did:test:poll"]

    async def create_poll(self, poll, options):
        self.calls.append(("create_poll", poll, options))
        return "did:test:poll"

    async def get_poll(self, identifier: str):
        self.calls.append(("get_poll", identifier))
        return {
            "version": 2,
            "name": "poll-name",
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": "2026-04-11T13:00:00.000Z",
        }

    async def test_poll(self, identifier: str) -> bool:
        self.calls.append(("test_poll", identifier))
        return True

    async def view_poll(self, identifier: str):
        self.calls.append(("view_poll", identifier))
        return {
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": "2026-04-11T13:00:00.000Z",
            "isOwner": True,
            "isEligible": True,
            "voteExpired": False,
            "hasVoted": False,
            "ballots": [],
            "results": {"tally": [], "votes": {"eligible": 1, "received": 0, "pending": 1}, "final": False},
        }

    async def send_poll(self, poll: str) -> str:
        self.calls.append(("send_poll", poll))
        return "did:test:notice"

    async def vote_poll(self, poll: str, vote: int, options):
        self.calls.append(("vote_poll", poll, vote, options))
        return "did:test:ballot"

    async def update_poll(self, ballot: str) -> bool:
        self.calls.append(("update_poll", ballot))
        return True

    async def publish_poll(self, poll: str, options):
        self.calls.append(("publish_poll", poll, options))
        return True

    async def unpublish_poll(self, poll: str) -> bool:
        self.calls.append(("unpublish_poll", poll))
        return True

    async def send_ballot(self, ballot: str, poll: str) -> str:
        self.calls.append(("send_ballot", ballot, poll))
        return "did:test:notice"

    async def view_ballot(self, ballot: str):
        self.calls.append(("view_ballot", ballot))
        return {
            "poll": "did:test:poll",
            "voter": "did:test:alice",
            "vote": 1,
            "option": "yes",
        }

    async def add_poll_voter(self, poll: str, member_id: str) -> bool:
        self.calls.append(("add_poll_voter", poll, member_id))
        return True

    async def remove_poll_voter(self, poll: str, voter: str) -> bool:
        self.calls.append(("remove_poll_voter", poll, voter))
        return True

    async def list_poll_voters(self, poll: str):
        self.calls.append(("list_poll_voters", poll))
        return {"did:test:alice": {"added": "2026-04-04T13:00:00.000Z"}}

    async def get_vault(self, identifier: str):
        self.calls.append(("get_vault", identifier))
        return {"version": 1, "keys": {}, "items": "enc", "publicJwk": {"kty": "EC"}}

    async def test_vault(self, identifier: str) -> bool:
        self.calls.append(("test_vault", identifier))
        return True

    async def add_vault_member(self, identifier: str, member_id: str) -> bool:
        self.calls.append(("add_vault_member", identifier, member_id))
        return True

    async def remove_vault_member(self, identifier: str, member: str) -> bool:
        self.calls.append(("remove_vault_member", identifier, member))
        return True

    async def list_vault_members(self, identifier: str):
        self.calls.append(("list_vault_members", identifier))
        return {"did:test:alice": {"added": "2026-04-04T13:00:00.000Z"}}

    async def add_vault_item(self, identifier: str, name: str, body: bytes) -> bool:
        self.calls.append(("add_vault_item", identifier, name, body))
        return True

    async def remove_vault_item(self, identifier: str, name: str) -> bool:
        self.calls.append(("remove_vault_item", identifier, name))
        return True

    async def list_vault_items(self, identifier: str):
        self.calls.append(("list_vault_items", identifier))
        return {"doc.txt": {"cid": "cid-1", "bytes": 3}}

    async def get_vault_item(self, identifier: str, name: str):
        self.calls.append(("get_vault_item", identifier, name))
        return b"abc"

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


def test_vault_handlers(stub_service: StubService):
    request = app_module.Request(headers={"x-options": '{"name":"doc.txt"}'})

    created = run(app_module.create_vault({"options": {"secretMembers": True}}))
    fetched = run(app_module.get_vault("did:test:vault"))
    tested = run(app_module.test_vault("did:test:vault"))
    added_member = run(app_module.add_vault_member("did:test:vault", {"memberId": "did:test:alice"}))
    listed_members = run(app_module.list_vault_members("did:test:vault"))
    removed_member = run(app_module.remove_vault_member("did:test:vault", "did:test:alice"))
    added_item = run(app_module.add_vault_item("did:test:vault", request, b"abc"))
    listed_items = run(app_module.list_vault_items("did:test:vault"))
    fetched_item = run(app_module.get_vault_item("did:test:vault", "doc.txt"))
    removed_item = run(app_module.remove_vault_item("did:test:vault", "doc.txt"))

    assert created == {"did": "did:test:vault"}
    assert fetched == {"vault": {"version": 1, "keys": {}, "items": "enc", "publicJwk": {"kty": "EC"}}}
    assert tested == {"test": True}
    assert added_member == {"ok": True}
    assert listed_members == {"members": {"did:test:alice": {"added": "2026-04-04T13:00:00.000Z"}}}
    assert removed_member == {"ok": True}
    assert added_item == {"ok": True}
    assert listed_items == {"items": {"doc.txt": {"cid": "cid-1", "bytes": 3}}}
    assert fetched_item.content == b"abc"
    assert fetched_item.media_type == "application/octet-stream"
    assert removed_item == {"ok": True}
    assert stub_service.calls == [
        ("create_vault", {"secretMembers": True}),
        ("get_vault", "did:test:vault"),
        ("test_vault", "did:test:vault"),
        ("add_vault_member", "did:test:vault", "did:test:alice"),
        ("list_vault_members", "did:test:vault"),
        ("remove_vault_member", "did:test:vault", "did:test:alice"),
        ("add_vault_item", "did:test:vault", "doc.txt", b"abc"),
        ("list_vault_items", "did:test:vault"),
        ("get_vault_item", "did:test:vault", "doc.txt"),
        ("remove_vault_item", "did:test:vault", "doc.txt"),
    ]


def test_file_and_image_handlers(stub_service: StubService):
    image_request = app_module.Request(headers={"x-options": '{"filename":"image.png"}'}, body=b"png-bytes")
    file_request = app_module.Request(
        headers={"x-options": '{"filename":"doc.txt","contentType":"text/plain"}', "content-length": "3"},
        body=b"abc",
    )

    created_image = run(app_module.create_image(image_request))
    updated_image = run(app_module.update_image("did:test:image", image_request))
    fetched_image = run(app_module.get_image("did:test:image", app_module.Request(headers={})))
    fetched_image_binary = run(
        app_module.get_image("did:test:image", app_module.Request(headers={"accept": "application/octet-stream"}))
    )
    tested_image = run(app_module.test_image("did:test:image"))

    created_file = run(app_module.create_file(file_request))
    updated_file = run(app_module.update_file("did:test:file", file_request))
    fetched_file = run(app_module.get_file("did:test:file", app_module.Request(headers={})))
    fetched_file_binary = run(
        app_module.get_file("did:test:file", app_module.Request(headers={"accept": "application/octet-stream"}))
    )
    tested_file = run(app_module.test_file("did:test:file"))

    assert created_image == {"did": "did:test:image"}
    assert updated_image == {"ok": True}
    assert fetched_image["image"]["image"] == {"width": 1, "height": 1}
    assert fetched_image_binary.content == b"png-bytes"
    assert fetched_image_binary.media_type == "application/octet-stream"
    assert json.loads(fetched_image_binary.headers["X-Metadata"]) == {
        "file": {"cid": "cid-image", "filename": "image.png", "type": "image/png", "bytes": 68},
        "image": {"width": 1, "height": 1},
    }
    assert tested_image == {"test": True}

    assert created_file == {"did": "did:test:file"}
    assert updated_file == {"ok": True}
    assert fetched_file == {"file": {"cid": "cid-file", "filename": "doc.txt", "type": "text/plain", "bytes": 3, "data": b"abc"}}
    assert fetched_file_binary.content == b"abc"
    assert fetched_file_binary.media_type == "application/octet-stream"
    assert json.loads(fetched_file_binary.headers["X-Metadata"]) == {
        "cid": "cid-file",
        "filename": "doc.txt",
        "type": "text/plain",
        "bytes": 3,
    }
    assert tested_file == {"test": True}
    assert stub_service.calls == [
        ("create_image", b"png-bytes", {"filename": "image.png"}),
        ("update_image", "did:test:image", b"png-bytes", {"filename": "image.png"}),
        ("get_image", "did:test:image"),
        ("get_image", "did:test:image"),
        ("test_image", "did:test:image"),
        ("create_file_stream", b"abc", {"filename": "doc.txt", "contentType": "text/plain", "bytes": 3}),
        ("update_file_stream", "did:test:file", b"abc", {"filename": "doc.txt", "contentType": "text/plain", "bytes": 3}),
        ("get_file", "did:test:file"),
        ("get_file", "did:test:file"),
        ("test_file", "did:test:file"),
    ]


def test_poll_handlers(stub_service: StubService):
    templated = run(app_module.poll_template())
    listed = run(app_module.list_polls("did:test:bob"))
    created = run(app_module.create_poll({
        "poll": {
            "version": 2,
            "name": "poll-name",
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": "2026-04-11T13:00:00.000Z",
        },
        "options": {"registry": "local"},
    }))
    fetched = run(app_module.get_poll("did:test:poll"))
    tested = run(app_module.test_poll("did:test:poll"))
    viewed = run(app_module.view_poll("did:test:poll"))
    sent = run(app_module.send_poll("did:test:poll"))
    voted = run(app_module.vote_poll("did:test:poll", {"vote": 2, "options": {"registry": "local"}}))
    updated = run(app_module.update_poll({"ballot": "did:test:ballot"}))
    published = run(app_module.publish_poll("did:test:poll", {"options": {"reveal": True}}))
    unpublished = run(app_module.unpublish_poll("did:test:poll"))
    ballot_notice = run(app_module.send_ballot({"ballot": "did:test:ballot", "poll": "did:test:poll"}))
    ballot_view = run(app_module.view_ballot("did:test:ballot"))
    added = run(app_module.add_poll_voter("did:test:poll", {"memberId": "did:test:alice"}))
    voters = run(app_module.list_poll_voters("did:test:poll"))
    removed = run(app_module.remove_poll_voter("did:test:poll", "did:test:alice"))

    assert templated == {
        "template": {
            "version": 2,
            "name": "poll-name",
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": "2026-04-11T13:00:00.000Z",
        }
    }
    assert listed == {"polls": ["did:test:poll"]}
    assert created == {"did": "did:test:poll"}
    assert fetched["poll"]["name"] == "poll-name"
    assert tested == {"test": True}
    assert viewed["poll"]["isOwner"] is True
    assert sent == {"did": "did:test:notice"}
    assert voted == {"did": "did:test:ballot"}
    assert updated == {"ok": True}
    assert published == {"ok": True}
    assert unpublished == {"ok": True}
    assert ballot_notice == {"did": "did:test:notice"}
    assert ballot_view == {"ballot": {"poll": "did:test:poll", "voter": "did:test:alice", "vote": 1, "option": "yes"}}
    assert added == {"ok": True}
    assert voters == {"voters": {"did:test:alice": {"added": "2026-04-04T13:00:00.000Z"}}}
    assert removed == {"ok": True}
    assert stub_service.calls == [
        ("poll_template",),
        ("list_polls", "did:test:bob"),
        ("create_poll", {
            "version": 2,
            "name": "poll-name",
            "description": "What is this poll about?",
            "options": ["yes", "no", "abstain"],
            "deadline": "2026-04-11T13:00:00.000Z",
        }, {"registry": "local"}),
        ("get_poll", "did:test:poll"),
        ("test_poll", "did:test:poll"),
        ("view_poll", "did:test:poll"),
        ("send_poll", "did:test:poll"),
        ("vote_poll", "did:test:poll", 2, {"registry": "local"}),
        ("update_poll", "did:test:ballot"),
        ("publish_poll", "did:test:poll", {"reveal": True}),
        ("unpublish_poll", "did:test:poll"),
        ("send_ballot", "did:test:ballot", "did:test:poll"),
        ("view_ballot", "did:test:ballot"),
        ("add_poll_voter", "did:test:poll", "did:test:alice"),
        ("list_poll_voters", "did:test:poll"),
        ("remove_poll_voter", "did:test:poll", "did:test:alice"),
    ]