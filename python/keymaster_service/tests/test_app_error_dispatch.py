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

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from keymaster.core import KeymasterError, UnknownIDError, WalletNotFoundError  # noqa: E402
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

    return TestClient(app, raise_server_exceptions=False)


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
