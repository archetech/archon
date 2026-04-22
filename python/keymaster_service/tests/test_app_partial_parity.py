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
    starlette: Any = types.ModuleType("starlette")
    starlette_middleware: Any = types.ModuleType("starlette.middleware")
    starlette_base: Any = types.ModuleType("starlette.middleware.base")

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

        def add_middleware(self, *args, **kwargs):
            return None

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
        def __init__(self, content: str = "", media_type: str | None = None, status_code: int = 200):
            super().__init__(content=content, media_type=media_type, status_code=status_code)

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

    class _MetricStub:
        def __init__(self, *args, **kwargs):
            pass

        def labels(self, *args, **kwargs):
            return self

        def inc(self, *args, **kwargs):
            return None

        def observe(self, *args, **kwargs):
            return None

        def set(self, *args, **kwargs):
            return None

    prometheus.Counter = _MetricStub
    prometheus.Gauge = _MetricStub
    prometheus.Histogram = _MetricStub

    class BaseHTTPMiddleware:
        def __init__(self, app, dispatch=None):
            self.app = app
            self.dispatch = dispatch

    starlette_base.BaseHTTPMiddleware = BaseHTTPMiddleware

    sys.modules["fastapi"] = fastapi
    sys.modules["fastapi.responses"] = responses
    sys.modules["prometheus_client"] = prometheus
    sys.modules["starlette"] = starlette
    sys.modules["starlette.middleware"] = starlette_middleware
    sys.modules["starlette.middleware.base"] = starlette_base


_install_fastapi_stubs()

app_module = importlib.import_module("keymaster_service.app")
service_module = importlib.import_module("keymaster_service.service")


def run(coro):
    return asyncio.run(coro)


class StubService:
    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.server_ready = True

    async def list_registries(self):
        self.calls.append(("list_registries",))
        return ["local", "hyperswarm"]

    async def load_wallet(self):
        self.calls.append(("load_wallet",))
        return {"version": 2, "ids": {"Alice": {"did": "did:test:alice"}}, "current": "Alice"}

    async def save_wallet(self, wallet, overwrite: bool = True) -> bool:
        self.calls.append(("save_wallet", wallet, overwrite))
        return True

    async def new_wallet(self, mnemonic=None, overwrite: bool = False):
        self.calls.append(("new_wallet", mnemonic, overwrite))
        return {"version": 2, "seed": {}, "current": "Alice"}

    async def backup_wallet(self) -> bool:
        self.calls.append(("backup_wallet",))
        return True

    async def recover_wallet(self):
        self.calls.append(("recover_wallet",))
        return {"version": 2, "ids": {}, "current": None}

    async def check_wallet(self):
        self.calls.append(("check_wallet",))
        return {"checked": 1, "invalid": 0, "deleted": 0}

    async def fix_wallet(self):
        self.calls.append(("fix_wallet",))
        return {"idsRemoved": 0, "ownedRemoved": 0, "heldRemoved": 0, "aliasesRemoved": 0}

    async def decrypt_mnemonic(self) -> str:
        self.calls.append(("decrypt_mnemonic",))
        return "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    async def get_current_id(self):
        self.calls.append(("get_current_id",))
        return "Alice"

    async def set_current_id(self, name: str) -> bool:
        self.calls.append(("set_current_id", name))
        return True

    async def list_ids(self):
        self.calls.append(("list_ids",))
        return ["Alice"]

    async def create_id(self, name: str, options):
        self.calls.append(("create_id", name, options))
        return "did:test:alice"

    async def resolve_did(self, identifier: str, options=None):
        self.calls.append(("resolve_did", identifier, options or None))
        return {
            "didDocument": {"id": "did:test:alice", "controller": "did:test:alice"},
            "didDocumentMetadata": {"versionSequence": 2},
        }

    async def remove_id(self, identifier: str) -> bool:
        self.calls.append(("remove_id", identifier))
        return True

    async def rename_id(self, identifier: str, name: str) -> bool:
        self.calls.append(("rename_id", identifier, name))
        return True

    async def backup_id(self, identifier: str) -> bool:
        self.calls.append(("backup_id", identifier))
        return True

    async def recover_id(self, did: str) -> str:
        self.calls.append(("recover_id", did))
        return did

    async def list_aliases(self):
        self.calls.append(("list_aliases",))
        return {"alice": "did:test:alice"}

    async def add_alias(self, alias: str, did: str) -> bool:
        self.calls.append(("add_alias", alias, did))
        return True

    async def get_alias(self, alias: str):
        self.calls.append(("get_alias", alias))
        return "did:test:alice"

    async def remove_alias(self, alias: str) -> bool:
        self.calls.append(("remove_alias", alias))
        return True

    async def change_passphrase(self, passphrase: str) -> bool:
        self.calls.append(("change_passphrase", passphrase))
        return True

    async def change_registry(self, identifier: str, registry: str) -> bool:
        self.calls.append(("change_registry", identifier, registry))
        return True

    async def get_data(self, cid: str) -> bytes:
        self.calls.append(("get_data", cid))
        return b"cid-bytes"

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

    async def add_nostr(self, identifier: str | None = None):
        self.calls.append(("add_nostr", identifier))
        return {"npub": "npub1test", "pubkey": "11" * 32}

    async def remove_nostr(self, identifier: str | None = None) -> bool:
        self.calls.append(("remove_nostr", identifier))
        return True

    async def import_nostr(self, nsec: str, identifier: str | None = None):
        self.calls.append(("import_nostr", nsec, identifier))
        return {"npub": "npub1imported", "pubkey": "22" * 32}

    async def export_nsec(self, identifier: str | None = None) -> str:
        self.calls.append(("export_nsec", identifier))
        return "nsec1test"

    async def sign_nostr_event(self, event):
        self.calls.append(("sign_nostr_event", event))
        return {
            **event,
            "id": "33" * 32,
            "pubkey": "22" * 32,
            "sig": "44" * 64,
        }

    async def add_lightning(self, identifier: str | None = None):
        self.calls.append(("add_lightning", identifier))
        return {"walletId": "wallet-1", "adminKey": "admin-1", "invoiceKey": "invoice-1"}

    async def remove_lightning(self, identifier: str | None = None) -> bool:
        self.calls.append(("remove_lightning", identifier))
        return True

    async def get_lightning_balance(self, identifier: str | None = None):
        self.calls.append(("get_lightning_balance", identifier))
        return {"balance": 1000}

    async def create_lightning_invoice(self, amount: int, memo: str, identifier: str | None = None):
        self.calls.append(("create_lightning_invoice", amount, memo, identifier))
        return {"paymentRequest": "lnbc100...", "paymentHash": "hash123"}

    async def pay_lightning_invoice(self, bolt11: str, identifier: str | None = None):
        self.calls.append(("pay_lightning_invoice", bolt11, identifier))
        return {"paymentHash": "out-hash"}

    async def check_lightning_payment(self, payment_hash: str, identifier: str | None = None):
        self.calls.append(("check_lightning_payment", payment_hash, identifier))
        return {"paid": True, "status": "complete", "preimage": "preimage123", "paymentHash": payment_hash}

    async def decode_lightning_invoice(self, bolt11: str):
        self.calls.append(("decode_lightning_invoice", bolt11))
        return {"description": "1 cup coffee", "network": "bc"}

    async def publish_lightning(self, identifier: str | None = None) -> bool:
        self.calls.append(("publish_lightning", identifier))
        return True

    async def unpublish_lightning(self, identifier: str | None = None) -> bool:
        self.calls.append(("unpublish_lightning", identifier))
        return True

    async def zap_lightning(self, did: str, amount: int, memo: str | None = None, identifier: str | None = None):
        self.calls.append(("zap_lightning", did, amount, memo, identifier))
        return {"paymentHash": "zap-hash"}

    async def get_lightning_payments(self, identifier: str | None = None):
        self.calls.append(("get_lightning_payments", identifier))
        return [{"paymentHash": "hash1", "amount": 100, "fee": 0, "memo": "received", "pending": False}]

    async def merge_data(self, identifier: str, data) -> bool:
        self.calls.append(("merge_data", identifier, data))
        return True

    async def transfer_asset(self, identifier: str, controller: str) -> bool:
        self.calls.append(("transfer_asset", identifier, controller))
        return True

    async def clone_asset(self, identifier: str, options):
        self.calls.append(("clone_asset", identifier, options))
        return "did:test:clone"

    async def resolve_asset(self, identifier: str, options=None):
        self.calls.append(("resolve_asset", identifier, options or None))
        return {"name": "asset", "version": 1}

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

    async def get_vault(self, identifier: str, options=None):
        self.calls.append(("get_vault", identifier, options or None))
        return {"version": 1, "keys": {}, "items": "enc", "publicJwk": {"kty": "EC"}}

    async def test_vault(self, identifier: str, options=None) -> bool:
        self.calls.append(("test_vault", identifier, options or None))
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

    async def list_vault_items(self, identifier: str, options=None):
        self.calls.append(("list_vault_items", identifier, options or None))
        return {"doc.txt": {"cid": "cid-1", "bytes": 3}}

    async def get_vault_item(self, identifier: str, name: str, options=None):
        self.calls.append(("get_vault_item", identifier, name, options or None))
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

    async def list_dmail(self):
        self.calls.append(("list_dmail",))
        return {
            "did:test:dmail": {
                "message": {
                    "to": ["did:test:alice"],
                    "cc": ["did:test:bob"],
                    "subject": "Test Dmail",
                    "body": "Hello from dmail.",
                },
                "to": ["Alice"],
                "cc": ["Bob"],
                "sender": "Bob",
                "date": "2026-04-11T13:00:00.000Z",
                "tags": ["draft"],
                "attachments": {"doc.txt": {"bytes": 3, "type": "text/plain"}},
                "docs": {"didDocument": {"controller": "did:test:bob"}},
            }
        }

    async def create_dmail(self, message, options):
        self.calls.append(("create_dmail", message, options))
        return "did:test:dmail"

    async def import_dmail(self, did: str) -> bool:
        self.calls.append(("import_dmail", did))
        return True

    async def get_dmail_message(self, identifier: str, options=None):
        self.calls.append(("get_dmail_message", identifier, options or {}))
        return {
            "to": ["did:test:alice"],
            "cc": ["did:test:bob"],
            "subject": "Test Dmail",
            "body": "Hello from dmail.",
        }

    async def update_dmail(self, identifier: str, message) -> bool:
        self.calls.append(("update_dmail", identifier, message))
        return True

    async def remove_dmail(self, identifier: str) -> bool:
        self.calls.append(("remove_dmail", identifier))
        return True

    async def send_dmail(self, identifier: str) -> str:
        self.calls.append(("send_dmail", identifier))
        return "did:test:notice"

    async def file_dmail(self, identifier: str, tags) -> bool:
        self.calls.append(("file_dmail", identifier, tags))
        return True

    async def list_dmail_attachments(self, identifier: str, options=None):
        self.calls.append(("list_dmail_attachments", identifier, options or {}))
        return {"doc.txt": {"bytes": 3, "type": "text/plain"}}

    async def add_dmail_attachment(self, identifier: str, name: str, data: bytes) -> bool:
        self.calls.append(("add_dmail_attachment", identifier, name, data))
        return True

    async def remove_dmail_attachment(self, identifier: str, name: str) -> bool:
        self.calls.append(("remove_dmail_attachment", identifier, name))
        return True

    async def get_dmail_attachment(self, identifier: str, name: str):
        self.calls.append(("get_dmail_attachment", identifier, name))
        return b"abc"

    async def export_encrypted_wallet(self):
        self.calls.append(("export_encrypted_wallet",))
        return {"version": 2, "seed": {"mnemonicEnc": {}}, "enc": "wallet"}

    async def update_did(self, identifier: str, doc) -> bool:
        self.calls.append(("update_did", identifier, doc))
        return True

    async def revoke_did(self, identifier: str) -> bool:
        self.calls.append(("revoke_did", identifier))
        return True

    async def test_agent(self, identifier: str) -> bool:
        self.calls.append(("test_agent", identifier))
        return True

    async def encrypt_message(self, msg: str, receiver: str, options):
        self.calls.append(("encrypt_message", msg, receiver, options))
        return "did:test:msg"

    async def decrypt_message(self, did: str) -> str:
        self.calls.append(("decrypt_message", did))
        return "plain text"

    async def encrypt_json(self, payload, receiver: str, options):
        self.calls.append(("encrypt_json", payload, receiver, options))
        return "did:test:json"

    async def decrypt_json(self, did: str):
        self.calls.append(("decrypt_json", did))
        return {"plain": True}

    async def add_proof(self, payload):
        self.calls.append(("add_proof", payload))
        return {**payload, "proof": True}

    async def verify_proof(self, payload) -> bool:
        self.calls.append(("verify_proof", payload))
        return True

    async def rotate_keys(self) -> bool:
        self.calls.append(("rotate_keys",))
        return True

    async def create_schema(self, schema, options):
        self.calls.append(("create_schema", schema, options))
        return "did:test:schema"

    async def list_schemas(self, owner=None):
        self.calls.append(("list_schemas", owner))
        return ["did:test:schema"]

    async def get_schema(self, identifier: str):
        self.calls.append(("get_schema", identifier))
        return {"type": "object"}

    async def set_schema(self, identifier: str, schema) -> bool:
        self.calls.append(("set_schema", identifier, schema))
        return True

    async def test_schema(self, identifier: str) -> bool:
        self.calls.append(("test_schema", identifier))
        return True

    async def create_template(self, identifier: str):
        self.calls.append(("create_template", identifier))
        return {"$schema": identifier, "email": "TBD"}

    async def create_group(self, name: str, options):
        self.calls.append(("create_group", name, options))
        return "did:test:group"

    async def list_groups(self, owner=None):
        self.calls.append(("list_groups", owner))
        return ["did:test:group"]

    async def get_group(self, identifier: str):
        self.calls.append(("get_group", identifier))
        return {"name": "group", "members": ["did:test:alice"]}

    async def add_group_member(self, identifier: str, member: str) -> bool:
        self.calls.append(("add_group_member", identifier, member))
        return True

    async def remove_group_member(self, identifier: str, member: str) -> bool:
        self.calls.append(("remove_group_member", identifier, member))
        return True

    async def test_group(self, identifier: str, member=None) -> bool:
        self.calls.append(("test_group", identifier, member))
        return True

    async def create_challenge(self, challenge, options=None):
        self.calls.append(("create_challenge", challenge, options or {}))
        return "did:test:challenge"

    async def create_response(self, challenge: str, options):
        self.calls.append(("create_response", challenge, options))
        return "did:test:response"

    async def verify_response(self, response: str, options):
        self.calls.append(("verify_response", response, options))
        return {"match": True, "response": response}

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


def test_require_admin_key_accepts_header_and_bearer(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app_module.settings, "admin_api_key", "secret")

    with pytest.raises(app_module.HTTPException, match="Unauthorized"):
        run(app_module.require_admin_key(app_module.Request(headers={})))

    assert run(app_module.require_admin_key(app_module.Request(headers={"x-archon-admin-key": "secret"}))) is None
    assert run(app_module.require_admin_key(app_module.Request(headers={"authorization": "Bearer secret"}))) is None


def test_require_admin_key_is_noop_without_config(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app_module.settings, "admin_api_key", "")

    assert run(app_module.require_admin_key(app_module.Request(headers={}))) is None


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


def test_ipfs_data_handler(stub_service: StubService, monkeypatch: pytest.MonkeyPatch):
    downloaded = run(app_module.get_ipfs_data("cid-1"))

    assert downloaded.content == b"cid-bytes"
    assert downloaded.media_type == "application/octet-stream"
    assert stub_service.calls == [("get_data", "cid-1")]

    async def missing_data(cid: str):
        raise FileNotFoundError(f"missing {cid}")

    monkeypatch.setattr(stub_service, "get_data", missing_data)
    missing = run(app_module.get_ipfs_data("cid-404"))

    assert missing.status_code == 404
    assert missing.content == "missing cid-404"


def test_wallet_identity_alias_key_and_asset_handlers(stub_service: StubService):
    version = run(app_module.version())
    ready = run(app_module.ready())
    registries = run(app_module.registries())
    wallet = run(app_module.wallet())
    saved = run(app_module.save_wallet({"wallet": {"version": 2, "ids": {}}}))
    created_wallet = run(app_module.new_wallet({"mnemonic": "seed words", "overwrite": True}))
    backed_up_wallet = run(app_module.backup_wallet())
    recovered_wallet = run(app_module.recover_wallet())
    checked_wallet = run(app_module.check_wallet())
    fixed_wallet = run(app_module.fix_wallet())
    mnemonic = run(app_module.wallet_mnemonic())
    current_id = run(app_module.ids_current())
    set_current = run(app_module.set_ids_current({"name": "Alice"}))
    ids = run(app_module.list_ids())
    created_id = run(app_module.create_id({"name": "Alice", "options": {"registry": "local"}}))
    fetched_id = run(app_module.get_id("Alice"))
    deleted_id = run(app_module.delete_id("Alice"))
    renamed_id = run(app_module.rename_id("Alice", {"name": "Alice-2"}))
    backed_up_id = run(app_module.backup_id("Alice"))
    recovered_id = run(app_module.recover_id("did:test:alice"))
    aliases = run(app_module.aliases())
    added_alias = run(app_module.add_alias({"alias": "alice", "did": "did:test:alice"}))
    fetched_alias = run(app_module.get_alias("alice"))
    removed_alias = run(app_module.remove_alias("alice"))
    resolved = run(app_module.resolve_did("did:test:alice", app_module.Request(query_params={"confirm": "true"})))
    updated_did = run(app_module.update_did("did:test:alice", {"doc": {"didDocument": {"id": "did:test:alice"}}}))
    revoked_did = run(app_module.revoke_did("did:test:alice"))
    tested_agent = run(app_module.test_agent("did:test:alice"))
    encrypted_message = run(app_module.keys_encrypt_message({"msg": "hello", "receiver": "did:test:alice", "options": {"registry": "local"}}))
    decrypted_message = run(app_module.keys_decrypt_message({"did": "did:test:msg"}))
    encrypted_json = run(app_module.keys_encrypt_json({"json": {"plain": True}, "receiver": "did:test:alice", "options": {"registry": "local"}}))
    decrypted_json = run(app_module.keys_decrypt_json({"did": "did:test:json"}))
    signed = run(app_module.keys_sign({"contents": json.dumps({"hello": "world"})}))
    verified = run(app_module.keys_verify({"json": {"proof": True}}))
    rotated = run(app_module.keys_rotate())
    asset = run(app_module.get_asset("did:test:asset", app_module.Request(query_params={"versionId": "2"})))

    assert version == {"version": app_module.settings.service_version, "commit": app_module.settings.git_commit}
    assert ready == {"ready": True}
    assert registries == {"registries": ["local", "hyperswarm"]}
    assert wallet == {"wallet": {"version": 2, "ids": {"Alice": {"did": "did:test:alice"}}, "current": "Alice"}}
    assert saved == {"ok": True}
    assert created_wallet == {"wallet": {"version": 2, "seed": {}, "current": "Alice"}}
    assert backed_up_wallet == {"ok": True}
    assert recovered_wallet == {"wallet": {"version": 2, "ids": {}, "current": None}}
    assert checked_wallet == {"check": {"checked": 1, "invalid": 0, "deleted": 0}}
    assert fixed_wallet == {"fix": {"idsRemoved": 0, "ownedRemoved": 0, "heldRemoved": 0, "aliasesRemoved": 0}}
    assert mnemonic["mnemonic"].startswith("abandon abandon")
    assert current_id == {"current": "Alice"}
    assert set_current == {"ok": True}
    assert ids == {"ids": ["Alice"]}
    assert created_id == {"did": "did:test:alice"}
    assert fetched_id["docs"]["didDocument"]["id"] == "did:test:alice"
    assert deleted_id == {"ok": True}
    assert renamed_id == {"ok": True}
    assert backed_up_id == {"ok": True}
    assert recovered_id == {"recovered": "did:test:alice"}
    assert aliases == {"aliases": {"alice": "did:test:alice"}}
    assert added_alias == {"ok": True}
    assert fetched_alias == {"did": "did:test:alice"}
    assert removed_alias == {"ok": True}
    assert resolved["docs"]["didDocumentMetadata"]["versionSequence"] == 2
    assert updated_did == {"ok": True}
    assert revoked_did == {"ok": True}
    assert tested_agent == {"test": True}
    assert encrypted_message == {"did": "did:test:msg"}
    assert decrypted_message == {"message": "plain text"}
    assert encrypted_json == {"did": "did:test:json"}
    assert decrypted_json == {"json": {"plain": True}}
    assert signed == {"signed": {"hello": "world", "proof": True}}
    assert verified == {"ok": True}
    assert rotated == {"ok": True}
    assert asset == {"asset": {"name": "asset", "version": 1}}
    assert stub_service.calls == [
        ("list_registries",),
        ("load_wallet",),
        ("save_wallet", {"version": 2, "ids": {}}, True),
        ("new_wallet", "seed words", True),
        ("backup_wallet",),
        ("recover_wallet",),
        ("check_wallet",),
        ("fix_wallet",),
        ("decrypt_mnemonic",),
        ("get_current_id",),
        ("set_current_id", "Alice"),
        ("list_ids",),
        ("create_id", "Alice", {"registry": "local"}),
        ("resolve_did", "Alice", None),
        ("remove_id", "Alice"),
        ("rename_id", "Alice", "Alice-2"),
        ("backup_id", "Alice"),
        ("recover_id", "did:test:alice"),
        ("list_aliases",),
        ("add_alias", "alice", "did:test:alice"),
        ("get_alias", "alice"),
        ("remove_alias", "alice"),
        ("resolve_did", "did:test:alice", {"confirm": "true"}),
        ("update_did", "did:test:alice", {"didDocument": {"id": "did:test:alice"}}),
        ("revoke_did", "did:test:alice"),
        ("test_agent", "did:test:alice"),
        ("encrypt_message", "hello", "did:test:alice", {"registry": "local"}),
        ("decrypt_message", "did:test:msg"),
        ("encrypt_json", {"plain": True}, "did:test:alice", {"registry": "local"}),
        ("decrypt_json", "did:test:json"),
        ("add_proof", {"hello": "world"}),
        ("verify_proof", {"proof": True}),
        ("rotate_keys",),
        ("resolve_asset", "did:test:asset", {"versionId": "2"}),
    ]


def test_schema_group_response_and_vault_option_handlers(stub_service: StubService):
    created_schema = run(app_module.create_schema({"schema": {"type": "object"}, "options": {"registry": "local"}}))
    listed_schemas = run(app_module.list_schemas("did:test:owner"))
    fetched_schema = run(app_module.get_schema("did:test:schema"))
    updated_schema = run(app_module.set_schema("did:test:schema", {"schema": {"type": "string"}}))
    tested_schema = run(app_module.test_schema("did:test:schema"))
    templated = run(app_module.create_template("did:test:schema"))
    created_group = run(app_module.create_group({"name": "group", "options": {"registry": "local"}}))
    listed_groups = run(app_module.list_groups("did:test:owner"))
    fetched_group = run(app_module.get_group("did:test:group"))
    added_group_member = run(app_module.add_group_member("did:test:group", {"member": "did:test:alice"}))
    removed_group_member = run(app_module.remove_group_member("did:test:group", {"member": "did:test:alice"}))
    tested_group = run(app_module.test_group("did:test:group", {"member": "did:test:alice"}))
    challenge = run(app_module.challenge_get())
    posted_challenge = run(app_module.challenge_post({"challenge": {"credentials": []}, "options": {"registry": "local"}}))
    response = run(app_module.response_post({"challenge": "did:test:challenge", "options": {"registry": "local"}}))
    verified = run(app_module.response_verify({"response": "did:test:response", "options": {"retries": 1}}))
    vault = run(app_module.get_vault("did:test:vault", app_module.Request(query_params={"confirm": "true"})))
    tested_vault = run(app_module.test_vault("did:test:vault", {"options": {"confirm": True}}))
    listed_items = run(app_module.list_vault_items("did:test:vault", app_module.Request(query_params={"confirm": "true"})))
    fetched_item = run(app_module.get_vault_item("did:test:vault", "doc.txt", app_module.Request(query_params={"confirm": "true"})))

    assert created_schema == {"did": "did:test:schema"}
    assert listed_schemas == {"schemas": ["did:test:schema"]}
    assert fetched_schema == {"schema": {"type": "object"}}
    assert updated_schema == {"ok": True}
    assert tested_schema == {"test": True}
    assert templated == {"template": {"$schema": "did:test:schema", "email": "TBD"}}
    assert created_group == {"did": "did:test:group"}
    assert listed_groups == {"groups": ["did:test:group"]}
    assert fetched_group == {"group": {"name": "group", "members": ["did:test:alice"]}}
    assert added_group_member == {"ok": True}
    assert removed_group_member == {"ok": True}
    assert tested_group == {"test": True}
    assert challenge == {"did": "did:test:challenge"}
    assert posted_challenge == {"did": "did:test:challenge"}
    assert response == {"did": "did:test:response"}
    assert verified == {"verify": {"match": True, "response": "did:test:response"}}
    assert vault == {"vault": {"version": 1, "keys": {}, "items": "enc", "publicJwk": {"kty": "EC"}}}
    assert tested_vault == {"test": True}
    assert listed_items == {"items": {"doc.txt": {"cid": "cid-1", "bytes": 3}}}
    assert fetched_item.content == b"abc"
    assert fetched_item.media_type == "application/octet-stream"
    assert stub_service.calls == [
        ("create_schema", {"type": "object"}, {"registry": "local"}),
        ("list_schemas", "did:test:owner"),
        ("get_schema", "did:test:schema"),
        ("set_schema", "did:test:schema", {"type": "string"}),
        ("test_schema", "did:test:schema"),
        ("create_template", "did:test:schema"),
        ("create_group", "group", {"registry": "local"}),
        ("list_groups", "did:test:owner"),
        ("get_group", "did:test:group"),
        ("add_group_member", "did:test:group", "did:test:alice"),
        ("remove_group_member", "did:test:group", "did:test:alice"),
        ("test_group", "did:test:group", "did:test:alice"),
        ("create_challenge", {}, {}),
        ("create_challenge", {"credentials": []}, {"registry": "local"}),
        ("create_response", "did:test:challenge", {"registry": "local"}),
        ("verify_response", "did:test:response", {"retries": 1}),
        ("get_vault", "did:test:vault", {"confirm": "true"}),
        ("test_vault", "did:test:vault", {"confirm": True}),
        ("list_vault_items", "did:test:vault", {"confirm": "true"}),
        ("get_vault_item", "did:test:vault", "doc.txt", {"confirm": "true"}),
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


def test_nostr_handlers(stub_service: StubService):
    added = run(app_module.add_nostr({"id": "Alice"}))
    imported = run(app_module.import_nostr({"nsec": "nsec1imported", "id": "Alice"}))
    exported = run(app_module.export_nsec({"id": "Alice"}))
    signed = run(
        app_module.sign_nostr_event(
            {
                "event": {
                    "created_at": 1700000000,
                    "kind": 1,
                    "tags": [["p", "did:test:alice"]],
                    "content": "hello nostr",
                }
            }
        )
    )
    removed = run(app_module.remove_nostr({"id": "Alice"}))

    assert added == {"npub": "npub1test", "pubkey": "11" * 32}
    assert imported == {"npub": "npub1imported", "pubkey": "22" * 32}
    assert exported == {"nsec": "nsec1test"}
    assert signed == {
        "created_at": 1700000000,
        "kind": 1,
        "tags": [["p", "did:test:alice"]],
        "content": "hello nostr",
        "id": "33" * 32,
        "pubkey": "22" * 32,
        "sig": "44" * 64,
    }
    assert removed == {"ok": True}
    assert stub_service.calls == [
        ("add_nostr", "Alice"),
        ("import_nostr", "nsec1imported", "Alice"),
        ("export_nsec", "Alice"),
        (
            "sign_nostr_event",
            {
                "created_at": 1700000000,
                "kind": 1,
                "tags": [["p", "did:test:alice"]],
                "content": "hello nostr",
            },
        ),
        ("remove_nostr", "Alice"),
    ]


def test_lightning_handlers(stub_service: StubService):
    added = run(app_module.add_lightning({"id": "Alice"}))
    removed = run(app_module.remove_lightning({"id": "Alice"}))
    balance = run(app_module.get_lightning_balance({"id": "Alice"}))
    invoice = run(app_module.create_lightning_invoice({"amount": 100, "memo": "coffee", "id": "Alice"}))
    payment = run(app_module.pay_lightning_invoice({"bolt11": "lnbc100...", "id": "Alice"}))
    status = run(app_module.check_lightning_payment({"paymentHash": "hash123", "id": "Alice"}))
    decoded = run(app_module.decode_lightning_invoice({"bolt11": "lnbc100..."}))
    published = run(app_module.publish_lightning({"id": "Alice"}))
    unpublished = run(app_module.unpublish_lightning({"id": "Alice"}))
    zap = run(app_module.zap_lightning({"did": "did:test:bob", "amount": 21, "memo": "thanks", "id": "Alice"}))
    payments = run(app_module.get_lightning_payments({"id": "Alice"}))

    assert added == {"walletId": "wallet-1", "adminKey": "admin-1", "invoiceKey": "invoice-1"}
    assert removed == {"ok": True}
    assert balance == {"balance": 1000}
    assert invoice == {"paymentRequest": "lnbc100...", "paymentHash": "hash123"}
    assert payment == {"paymentHash": "out-hash"}
    assert status == {"paid": True, "status": "complete", "preimage": "preimage123", "paymentHash": "hash123"}
    assert decoded == {"description": "1 cup coffee", "network": "bc"}
    assert published == {"ok": True}
    assert unpublished == {"ok": True}
    assert zap == {"paymentHash": "zap-hash"}
    assert payments == {"payments": [{"paymentHash": "hash1", "amount": 100, "fee": 0, "memo": "received", "pending": False}]}
    assert stub_service.calls == [
        ("add_lightning", "Alice"),
        ("remove_lightning", "Alice"),
        ("get_lightning_balance", "Alice"),
        ("create_lightning_invoice", 100, "coffee", "Alice"),
        ("pay_lightning_invoice", "lnbc100...", "Alice"),
        ("check_lightning_payment", "hash123", "Alice"),
        ("decode_lightning_invoice", "lnbc100..."),
        ("publish_lightning", "Alice"),
        ("unpublish_lightning", "Alice"),
        ("zap_lightning", "did:test:bob", 21, "thanks", "Alice"),
        ("get_lightning_payments", "Alice"),
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


def test_dmail_handlers(stub_service: StubService):
    upload_request = app_module.Request(headers={"x-options": '{"name":"doc.txt"}'}, body=b"abc")
    version_request = app_module.Request(query_params={"confirm": "true"})
    attachment_request = app_module.Request(query_params={"confirm": "true"})

    listed = run(app_module.list_dmail())
    created = run(
        app_module.create_dmail(
            {"message": {"to": ["did:test:alice"], "cc": ["did:test:bob"], "subject": "Test Dmail", "body": "Hello from dmail."}, "options": {"secretMembers": True}}
        )
    )
    imported = run(app_module.import_dmail({"did": "did:test:dmail"}))
    fetched = run(app_module.get_dmail("did:test:dmail", version_request))
    updated = run(app_module.update_dmail("did:test:dmail", {"message": {"to": ["did:test:alice"], "cc": [], "subject": "Updated", "body": "Updated body."}}))
    removed = run(app_module.remove_dmail("did:test:dmail"))
    sent = run(app_module.send_dmail("did:test:dmail"))
    filed = run(app_module.file_dmail("did:test:dmail", {"tags": ["inbox", "unread"]}))
    attachments = run(app_module.list_dmail_attachments("did:test:dmail", attachment_request))
    uploaded = run(app_module.add_dmail_attachment("did:test:dmail", upload_request))
    deleted_attachment = run(app_module.remove_dmail_attachment("did:test:dmail", "doc.txt"))
    attachment = run(app_module.get_dmail_attachment("did:test:dmail", "doc.txt"))

    assert listed["dmail"]["did:test:dmail"]["tags"] == ["draft"]
    assert created == {"did": "did:test:dmail"}
    assert imported == {"ok": True}
    assert fetched == {
        "message": {
            "to": ["did:test:alice"],
            "cc": ["did:test:bob"],
            "subject": "Test Dmail",
            "body": "Hello from dmail.",
        }
    }
    assert updated == {"ok": True}
    assert removed == {"ok": True}
    assert sent == {"did": "did:test:notice"}
    assert filed == {"ok": True}
    assert attachments == {"attachments": {"doc.txt": {"bytes": 3, "type": "text/plain"}}}
    assert uploaded == {"ok": True}
    assert deleted_attachment == {"ok": True}
    assert attachment.content == b"abc"
    assert attachment.media_type == "application/octet-stream"
    assert stub_service.calls == [
        ("list_dmail",),
        ("create_dmail", {"to": ["did:test:alice"], "cc": ["did:test:bob"], "subject": "Test Dmail", "body": "Hello from dmail."}, {"secretMembers": True}),
        ("import_dmail", "did:test:dmail"),
        ("get_dmail_message", "did:test:dmail", {"confirm": "true"}),
        ("update_dmail", "did:test:dmail", {"to": ["did:test:alice"], "cc": [], "subject": "Updated", "body": "Updated body."}),
        ("remove_dmail", "did:test:dmail"),
        ("send_dmail", "did:test:dmail"),
        ("file_dmail", "did:test:dmail", ["inbox", "unread"]),
        ("list_dmail_attachments", "did:test:dmail", {"confirm": "true"}),
        ("add_dmail_attachment", "did:test:dmail", "doc.txt", b"abc"),
        ("remove_dmail_attachment", "did:test:dmail", "doc.txt"),
        ("get_dmail_attachment", "did:test:dmail", "doc.txt"),
    ]


def test_vault_handlers(stub_service: StubService):
    request = app_module.Request(headers={"x-options": '{"name":"doc.txt"}'})
    empty_request = app_module.Request(query_params={})

    created = run(app_module.create_vault({"options": {"secretMembers": True}}))
    fetched = run(app_module.get_vault("did:test:vault", empty_request))
    tested = run(app_module.test_vault("did:test:vault"))
    added_member = run(app_module.add_vault_member("did:test:vault", {"memberId": "did:test:alice"}))
    listed_members = run(app_module.list_vault_members("did:test:vault"))
    removed_member = run(app_module.remove_vault_member("did:test:vault", "did:test:alice"))
    added_item = run(app_module.add_vault_item("did:test:vault", request, b"abc"))
    listed_items = run(app_module.list_vault_items("did:test:vault", empty_request))
    fetched_item = run(app_module.get_vault_item("did:test:vault", "doc.txt", empty_request))
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
        ("get_vault", "did:test:vault", None),
        ("test_vault", "did:test:vault", None),
        ("add_vault_member", "did:test:vault", "did:test:alice"),
        ("list_vault_members", "did:test:vault"),
        ("remove_vault_member", "did:test:vault", "did:test:alice"),
        ("add_vault_item", "did:test:vault", "doc.txt", b"abc"),
        ("list_vault_items", "did:test:vault", None),
        ("get_vault_item", "did:test:vault", "doc.txt", None),
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
