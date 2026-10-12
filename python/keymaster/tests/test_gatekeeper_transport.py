import asyncio

import httpx
import pytest

from keymaster.gatekeeper_client import (
    GatekeeperClient,
    GatekeeperTimeoutError,
    GatekeeperUnavailableError,
)

# A stalled Gatekeeper raised a bare httpx.ReadTimeout whose str() is empty, so
# the service answered an unexplained 500 (#1380). Transport failures now carry
# their cause and a type the service maps to 504 or 503.


def _client_raising(monkeypatch, failure):
    def respond(request):
        if failure is None:
            return httpx.Response(404, json={"error": "DID not found"})
        raise failure("", request=request)

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    return GatekeeperClient("http://gatekeeper:4224")


async def _resolve(client):
    try:
        return await client.resolve_did("did:cid:bagaaieratransport")
    finally:
        await client.close()


@pytest.mark.parametrize("failure", [httpx.ReadTimeout, httpx.ConnectTimeout, httpx.PoolTimeout])
def test_timeout_raises_gatekeeper_timeout(monkeypatch, failure):
    client = _client_raising(monkeypatch, failure)
    with pytest.raises(GatekeeperTimeoutError, match="did not respond within 30s"):
        asyncio.run(_resolve(client))


@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.RemoteProtocolError])
def test_transport_failure_raises_gatekeeper_unavailable(monkeypatch, failure):
    client = _client_raising(monkeypatch, failure)
    with pytest.raises(GatekeeperUnavailableError, match=f"Gatekeeper unavailable: {failure.__name__}"):
        asyncio.run(_resolve(client))


def test_error_responses_are_unchanged(monkeypatch):
    client = _client_raising(monkeypatch, None)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(_resolve(client))


def test_readiness_probe_raises_the_typed_error(monkeypatch):
    client = _client_raising(monkeypatch, httpx.ConnectError)

    async def probe():
        try:
            with pytest.raises(GatekeeperUnavailableError):
                await client.is_ready()
        finally:
            await client.close()

    asyncio.run(probe())
