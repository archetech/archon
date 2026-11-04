import asyncio

import httpx
import pytest

from keymaster.gatekeeper_client import GatekeeperClient

# Drawbridge's GET /cashu-mint names the node mint's public URL, or null when
# the node runs none or its public host is not https. A gateway without the
# route, such as a plain Gatekeeper, means no node mint either.


def _client(monkeypatch, response):
    def respond(request):
        assert request.url.path.endswith("/cashu-mint")
        return response

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))
    return GatekeeperClient("http://drawbridge:4222")


async def _mint(client):
    try:
        return await client.get_cashu_mint()
    finally:
        await client.close()


@pytest.mark.parametrize("response, expected", [
    (httpx.Response(200, json={"url": "https://node.example/cashu"}), "https://node.example/cashu"),
    (httpx.Response(200, json={"url": None}), None),
    (httpx.Response(404, json={"error": "Not found"}), None),
])
def test_get_cashu_mint(monkeypatch, response, expected):
    assert asyncio.run(_mint(_client(monkeypatch, response))) == expected
