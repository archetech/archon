"""CORS behaviour of the keymaster service, as a browser sees it.

The TypeScript service runs `app.use(cors())`, so a web client on another
origin (keymaster-client on :4227 calling Keymaster on :4226) can use it. The
Python service has to answer browsers the same way: preflights on every route,
and `Access-Control-Allow-Origin` on responses (#1550).
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "keymaster" / "src"))

import importlib  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

# Taken from sys.modules rather than `import keymaster_service.app`: that form
# reads the package attribute, which test_app_partial_parity.py leaves pointing
# at the copy it imported under stub frameworks.
app_module = importlib.import_module("keymaster_service.app")


ORIGIN = "http://localhost:4227"


@pytest.fixture
def client() -> TestClient:
    # The ASGI app uvicorn serves. Not entered as a context manager, so the
    # gatekeeper-connecting lifespan does not run; the routes used here do not
    # need it.
    return TestClient(app_module.asgi_app, raise_server_exceptions=False)


def _preflight(client: TestClient, path: str, method: str, headers: str):
    return client.options(
        path,
        headers={
            "Origin": ORIGIN,
            "Access-Control-Request-Method": method,
            "Access-Control-Request-Headers": headers,
        },
    )


def test_preflight_for_json_login_is_allowed(client):
    response = _preflight(client, "/api/v1/login", "POST", "content-type")

    assert response.status_code in (200, 204)
    assert response.headers["access-control-allow-origin"] == "*"
    assert "POST" in response.headers["access-control-allow-methods"]
    assert "content-type" in response.headers["access-control-allow-headers"].lower()


@pytest.mark.parametrize(
    "path,method",
    [
        ("/api/v1/ids", "GET"),
        ("/api/v1/ids/alice", "DELETE"),
        ("/api/v1/wallet", "PUT"),
        ("/api/v1/no-such-route", "PATCH"),
    ],
)
def test_preflight_is_answered_on_every_route(client, path, method):
    # A protected route's preflight carries no admin key -- browsers never send
    # credentials or custom headers on a preflight -- so it must be answered
    # before the admin check, and before routing for any path at all.
    response = _preflight(client, path, method, "content-type,x-archon-admin-key")

    assert response.status_code in (200, 204)
    assert response.headers["access-control-allow-origin"] == "*"
    assert method in response.headers["access-control-allow-methods"]
    assert "x-archon-admin-key" in response.headers["access-control-allow-headers"].lower()


def test_simple_response_allows_any_origin(client):
    response = client.get("/api/v1/version", headers={"Origin": ORIGIN})

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "*"
    assert "access-control-allow-credentials" not in response.headers


def test_error_response_allows_any_origin(client, monkeypatch):
    # A browser hides a cross-origin response without the header, so the client
    # could not read why it was refused.
    monkeypatch.setattr(app_module.settings, "admin_api_key", "a" * 32)
    response = client.get("/api/v1/ids", headers={"Origin": ORIGIN})

    assert response.status_code == 401
    assert response.headers["access-control-allow-origin"] == "*"


def test_unhandled_exception_response_allows_any_origin(client, monkeypatch):
    # A body without "wallet" raises KeyError, which only the generic handler
    # catches. Starlette runs that handler outside all user middleware, so this
    # 500 is the one response CORS added through add_middleware would miss.
    monkeypatch.setattr(app_module.settings, "admin_api_key", "a" * 32)
    response = client.put(
        "/api/v1/wallet",
        json={},
        headers={"Origin": ORIGIN, "X-Archon-Admin-Key": "a" * 32},
    )

    assert response.status_code == 500
    assert response.headers["access-control-allow-origin"] == "*"
