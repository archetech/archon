import asyncio

import httpx
import pytest

from keymaster.gatekeeper_client import GatekeeperClient, _segment

# A value put into a request's path is one segment of it, whatever it holds: a
# string in the place of a DID cannot name another of the Gatekeeper's routes.

TRAVERSAL = "did:cid:x/../../ipfs/stream/bafyother"


def _asked(monkeypatch, call):
    paths = []

    def respond(request):
        paths.append(request.url.raw_path.decode())
        return httpx.Response(404, json={"error": "not found"})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))

    async def run():
        client = GatekeeperClient("http://gatekeeper:4224")
        try:
            await call(client)
        except httpx.HTTPStatusError:
            pass
        finally:
            await client.close()

    asyncio.run(run())
    return paths


def test_segment_leaves_a_did_and_a_registry_as_they_are():
    assert _segment("did:cid:bagaaieraexample") == "did:cid:bagaaieraexample"
    assert _segment("BTC:mainnet") == "BTC:mainnet"
    assert _segment(12) == "12"


@pytest.mark.parametrize("value, encoded", [
    ("a/b", "a%2Fb"),
    ("a?b=c", "a%3Fb%3Dc"),
    ("a#b", "a%23b"),
    ("a b", "a%20b"),
    ("a..b", "a..b"),
])
def test_segment_encodes_what_would_end_or_leave_the_segment(value, encoded):
    assert _segment(value) == encoded


def test_a_string_in_the_place_of_a_did_asks_for_no_other_route(monkeypatch):
    paths = _asked(monkeypatch, lambda client: client.resolve_did(TRAVERSAL))

    assert paths == ["/api/v1/did/did:cid:x%2F..%2F..%2Fipfs%2Fstream%2Fbafyother"]


@pytest.mark.parametrize("call, path", [
    (lambda client: client.get_text("x/../../did/did:cid:y"), "/api/v1/ipfs/text/x%2F..%2F..%2Fdid%2Fdid:cid:y"),
    (lambda client: client.get_block("BTC:mainnet/../x", "a/.."), "/api/v1/block/BTC:mainnet%2F..%2Fx/a%2F.."),
])
def test_a_string_in_the_place_of_a_cid_or_a_registry_asks_for_no_other_route(monkeypatch, call, path):
    assert _asked(monkeypatch, call) == [path]


@pytest.mark.parametrize("call", [
    lambda client: client.resolve_did(".."),
    lambda client: client.get_data("."),
    lambda client: client.get_block("BTC:mainnet", ".."),
])
def test_a_value_of_only_dots_is_refused_and_nothing_is_asked(monkeypatch, call):
    paths = []

    def respond(request):
        paths.append(request.url.raw_path.decode())
        return httpx.Response(404, json={})

    original_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(respond),
    ))

    async def run():
        client = GatekeeperClient("http://gatekeeper:4224")
        try:
            await call(client)
        finally:
            await client.close()

    with pytest.raises(ValueError, match="cannot be part of a request's path"):
        asyncio.run(run())
    assert paths == []


@pytest.mark.parametrize("value", [".", ".."])
def test_segment_refuses_a_value_of_only_dots(value):
    with pytest.raises(ValueError):
        _segment(value)


def test_a_did_is_asked_for_as_it_was(monkeypatch):
    paths = _asked(monkeypatch, lambda client: client.resolve_did("did:cid:bagaaieraexample"))

    assert paths == ["/api/v1/did/did:cid:bagaaieraexample"]
