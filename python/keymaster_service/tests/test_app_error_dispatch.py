"""Real-FastAPI dispatch tests for the keymaster service error handlers.

test_app_partial_parity.py swaps fastapi/starlette/prometheus for stubs to call
handlers directly; this file needs the *real* framework to assert that a raised
exception is dispatched to the right handler (the behaviour a direct call cannot
see -- see #1107, where an alias overwrote a handler and the direct-call tests
stayed green). The parity file restores sys.modules after importing under its
stubs, so this file just imports the real framework normally (#1109).
"""

import sys
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "keymaster" / "src"))

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from keymaster.cashu import CashuStateError, CashuUnavailableError  # noqa: E402
from keymaster.core import Keymaster, KeymasterError, LightningNotConfiguredError, UnknownIDError, WalletNotFoundError  # noqa: E402
from keymaster.gatekeeper_client import (  # noqa: E402
    GatekeeperTimeoutError,
    GatekeeperUnavailableError,
)
import keymaster_service.app as app_module  # noqa: E402


def _client() -> TestClient:
    # A throwaway app carrying the real service's registered exception handlers,
    # so dispatch (most-specific match, and no later overwrite) is exercised
    # without the real app's gatekeeper-connecting lifespan.
    app = FastAPI()
    for exc_type, handler in app_module.app.exception_handlers.items():
        app.add_exception_handler(exc_type, handler)

    @app.get("/cashu-unavailable")
    async def _cashu_unavailable():
        raise CashuUnavailableError("mint down")

    @app.get("/cashu-state")
    async def _cashu_state():
        raise CashuStateError("holds ecash")

    @app.get("/lightning-not-configured")
    async def _lightning_not_configured():
        raise LightningNotConfiguredError("No Lightning wallet configured for did:cid:bob")

    @app.get("/operation-error")
    async def _op():
        raise KeymasterError("bad operation")

    @app.get("/unknown-id")
    async def _unknown():
        raise UnknownIDError("Unknown ID")

    @app.get("/no-wallet")
    async def _no_wallet():
        raise WalletNotFoundError("wallet store is empty")

    @app.get("/gatekeeper-timeout")
    async def _gatekeeper_timeout():
        raise GatekeeperTimeoutError("Gatekeeper did not respond within 30s")

    @app.get("/gatekeeper-unavailable")
    async def _gatekeeper_unavailable():
        raise GatekeeperUnavailableError("Gatekeeper unavailable: ConnectError")

    def _upstream(status: int, **reply):
        request = httpx.Request("POST", "http://drawbridge:4222/api/v1/lightning/pay")
        return httpx.HTTPStatusError("raw", request=request, response=httpx.Response(status, request=request, **reply))

    @app.get("/upstream-error")
    async def _upstream_error():
        raise _upstream(502, json={"error": "Lightning service unavailable"})

    @app.get("/upstream-text")
    async def _upstream_text():
        raise _upstream(502, text="<html>bad gateway</html>")

    return TestClient(app, raise_server_exceptions=False)


def test_upstream_error_reports_what_the_service_said():
    response = _client().get("/upstream-error")

    assert response.status_code == 500
    assert response.json() == {"error": "Lightning service unavailable"}


def test_upstream_error_without_a_reason_names_the_status_only():
    response = _client().get("/upstream-text")

    assert response.status_code == 500
    assert response.json() == {"error": "upstream service returned 502"}


def test_lightning_not_configured_reply_names_its_type():
    # The Lightning panel offers wallet setup when this reply names the type, and
    # shows a dead-end error otherwise.
    response = _client().get("/lightning-not-configured")

    assert response.status_code == 400
    assert response.json() == {"error": "Lightning not configured: No Lightning wallet configured for did:cid:bob"}


def test_operation_error_dispatches_to_400():
    # Would return 500 under the KeymasterServiceError-alias overwrite (#1107).
    assert _client().get("/operation-error").status_code == 400


def test_unknown_id_dispatches_to_404():
    assert _client().get("/unknown-id").status_code == 404


def test_wallet_not_found_dispatches_to_404():
    assert _client().get("/no-wallet").status_code == 404


def test_gatekeeper_timeout_dispatches_to_504_with_its_message():
    # Was an unhandled httpx.ReadTimeout: 500 with {"error": ""} (#1380).
    response = _client().get("/gatekeeper-timeout")
    assert response.status_code == 504
    assert response.json() == {"error": "Gatekeeper did not respond within 30s"}


def test_gatekeeper_unavailable_dispatches_to_503_with_its_message():
    response = _client().get("/gatekeeper-unavailable")
    assert response.status_code == 503
    assert response.json() == {"error": "Gatekeeper unavailable: ConnectError"}


def test_did_repair_routes_accept_encoded_slashes(monkeypatch):
    calls = []
    report = {"did": "did:cid:alice", "issues": [], "canRepair": False}

    async def check(identifier):
        calls.append(("check", identifier))
        return report

    async def repair(identifier):
        calls.append(("repair", identifier))
        return {**report, "submitted": False}

    monkeypatch.setattr(app_module.service, "check_did", check)
    monkeypatch.setattr(app_module.service, "repair_did", repair)
    app = FastAPI()
    app.include_router(app_module.protected_api)
    app.dependency_overrides[app_module.require_admin_key] = lambda: None
    client = TestClient(app)
    for identifier in ["Alice / backup", "Alice/check", "Alice/repair", "did:cid:alice"]:
        path = f"/api/v1/did/{quote(identifier, safe='')}"
        checked = client.get(f"{path}/check")
        repaired = client.post(f"{path}/repair")
        assert checked.status_code == 200
        assert checked.json() == {"report": report}
        assert repaired.status_code == 200
        assert repaired.json() == {"report": {**report, "submitted": False}}
        assert calls[-2:] == [("check", identifier), ("repair", identifier)]


def test_cashu_errors_dispatch_like_the_typescript_service():
    client = _client()
    assert client.get("/cashu-unavailable").status_code == 503
    assert client.get("/cashu-state").status_code == 400


def _cashu_client() -> TestClient:
    app = FastAPI()
    for exc_type, handler in app_module.app.exception_handlers.items():
        app.add_exception_handler(exc_type, handler)
    app.include_router(app_module.protected_api)
    app.dependency_overrides[app_module.require_admin_key] = lambda: None
    return TestClient(app, raise_server_exceptions=False)


def test_cashu_routes_accept_a_request_with_no_body(monkeypatch):
    calls = []

    async def add_cashu(name):
        calls.append(("add", name))
        return {"url": "https://mint.example"}

    async def get_cashu_balance(mint, name):
        calls.append(("balance", mint, name))
        return {"spendable": 0}

    async def remove_cashu(force, name):
        calls.append(("remove", force, name))
        return True

    monkeypatch.setattr(app_module.service, "add_cashu", add_cashu)
    monkeypatch.setattr(app_module.service, "get_cashu_balance", get_cashu_balance)
    monkeypatch.setattr(app_module.service, "remove_cashu", remove_cashu)
    client = _cashu_client()

    assert client.post("/api/v1/cashu").status_code == 200
    assert client.post("/api/v1/cashu/balance").status_code == 200
    assert client.delete("/api/v1/cashu").json() == {"ok": True}
    assert calls == [("add", None), ("balance", None, None), ("remove", None, None)]


def test_cashu_routes_leave_a_missing_field_to_the_wallet(monkeypatch):
    async def send_cashu(amount, mint, name):
        raise KeymasterError(f"Invalid parameter: amount {amount}")

    monkeypatch.setattr(app_module.service, "send_cashu", send_cashu)

    response = _cashu_client().post("/api/v1/cashu/send")

    assert response.status_code == 400
    assert response.json() == {"error": "Invalid parameter: amount None"}


def test_lightning_routes_accept_a_request_with_no_body(monkeypatch):
    routes = [
        ("POST", "/api/v1/lightning", "add_lightning", {"url": "https://drawbridge.example"}),
        ("DELETE", "/api/v1/lightning", "remove_lightning", True),
        ("POST", "/api/v1/lightning/balance", "get_lightning_balance", {"balance": 0}),
        ("POST", "/api/v1/lightning/publish", "publish_lightning", True),
        ("POST", "/api/v1/lightning/unpublish", "unpublish_lightning", True),
        ("POST", "/api/v1/lightning/payments", "get_lightning_payments", []),
    ]
    calls = []

    def stub(name, result):
        async def method(identifier):
            calls.append((name, identifier))
            return result

        return method

    for _, _, name, result in routes:
        monkeypatch.setattr(app_module.service, name, stub(name, result))
    client = _cashu_client()

    for method, path, _, _ in routes:
        assert client.request(method, path).status_code == 200, path

    assert calls == [(name, None) for _, _, name, _ in routes]


# The real Keymaster, whose validation runs before it touches the wallet or
# Gatekeeper, so that this checks the status the service actually gives.
def _lightning_validation_client(monkeypatch) -> TestClient:
    keymaster = Keymaster(gatekeeper=object(), wallet_store=object(), passphrase="passphrase")
    monkeypatch.setattr(app_module.service, "keymaster", keymaster)
    return _cashu_client()


@pytest.mark.parametrize(
    ("path", "body", "field"),
    [
        ("/lightning/invoice", {"memo": "coffee"}, "amount"),
        ("/lightning/pay", {"id": "Bob"}, "bolt11"),
        ("/lightning/payment", {"id": "Bob"}, "paymentHash"),
        ("/lightning/decode", {}, "bolt11"),
        ("/lightning/zap", {"amount": 100}, "did"),
        ("/lightning/zap", {"did": "NotAKnownAlias"}, "amount"),
    ],
)
def test_lightning_routes_answer_400_for_a_missing_field(monkeypatch, path, body, field):
    response = _lightning_validation_client(monkeypatch).post(f"/api/v1{path}", json=body)

    assert response.status_code == 400
    assert response.json() == {"error": f"Invalid parameter: {field}"}


@pytest.mark.parametrize(
    ("path", "field"),
    [
        ("/lightning/invoice", "amount"),
        ("/lightning/pay", "bolt11"),
        ("/lightning/payment", "paymentHash"),
        ("/lightning/decode", "bolt11"),
        ("/lightning/zap", "did"),
    ],
)
def test_lightning_routes_answer_400_with_no_body(monkeypatch, path, field):
    response = _lightning_validation_client(monkeypatch).post(f"/api/v1{path}")

    assert response.status_code == 400
    assert response.json() == {"error": f"Invalid parameter: {field}"}
