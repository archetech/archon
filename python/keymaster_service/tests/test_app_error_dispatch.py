"""Real-FastAPI dispatch tests for the keymaster service error handlers.

test_app_partial_parity.py swaps fastapi/starlette/prometheus for stubs to call
handlers directly; this file needs the *real* framework to assert that a raised
exception is dispatched to the right handler (the behaviour a direct call cannot
see -- see #1107, where an alias overwrote a handler and the direct-call tests
stayed green). The two coexist by each forcing its own import regime and binding
its own module references, independent of collection order (#1109).
"""

import sys

# Force the real modules for this file, undoing any stubs a sibling installed,
# and drop the cached service modules so they re-import against the real ones.
for _name in (
    "fastapi", "fastapi.responses", "fastapi.testclient", "prometheus_client",
    "starlette", "starlette.middleware", "starlette.middleware.base",
    "keymaster_service.app", "keymaster_service.service",
):
    sys.modules.pop(_name, None)

from pathlib import Path  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "keymaster" / "src"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from keymaster.core import KeymasterError, UnknownIDError, WalletNotFoundError  # noqa: E402
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

    return TestClient(app, raise_server_exceptions=False)


def test_operation_error_dispatches_to_400():
    # Would return 500 under the KeymasterServiceError-alias overwrite (#1107).
    assert _client().get("/operation-error").status_code == 400


def test_unknown_id_dispatches_to_404():
    assert _client().get("/unknown-id").status_code == 404


def test_wallet_not_found_dispatches_to_404():
    assert _client().get("/no-wallet").status_code == 404
