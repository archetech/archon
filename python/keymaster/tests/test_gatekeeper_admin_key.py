import asyncio

import httpx
import pytest

from keymaster.gatekeeper_client import GatekeeperClient


@pytest.mark.parametrize("api_key", [None, "", "node-secret"])
def test_upstream_admin_key_on_reads_and_writes(monkeypatch, api_key):
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path.endswith("/registries"):
            return httpx.Response(200, json=["local"])
        return httpx.Response(200, json="did:cid:new")

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    async def exercise():
        client = GatekeeperClient("http://drawbridge:4222", api_key=api_key)
        try:
            assert await client.list_registries() == ["local"]
            assert await client.create_did({"type": "create"}) == "did:cid:new"
        finally:
            await client.close()

    asyncio.run(exercise())
    assert len(requests) == 2
    for request in requests:
        assert request.headers.get("X-Archon-Admin-Key") == (api_key or None)
        assert "Authorization" not in request.headers
