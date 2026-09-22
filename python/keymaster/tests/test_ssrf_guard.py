"""Target checks for fetches to a caller-supplied host (#252).

Mirrors tests/keymaster/ssrf-guard.test.ts case for case. The two ports served
this surface with different guards -- TypeScript had a prefix regex applied on
one of three paths, Python had nothing at all -- so the cases are kept in step
deliberately: a hostname either port accepts is a hostname the fix has to
account for in both.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

import httpx

import keymaster.core as core
import keymaster.net as net
from keymaster.net import fetch_public_https, is_private_hostname

from .helpers import run


# Cases come from a fixture the TypeScript suite reads too. When each port kept
# its own list they agreed on everything either had thought of and diverged on
# six neither had -- the IPv4 documentation ranges, IPv6 multicast, and
# 2001:db8::/32, which ipaddress rejects and the hand-written TypeScript parser
# did not. A shared list is what makes "the ports agree" checkable.
_FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "private-hostnames.json").read_text()
)

BLOCKED = _FIXTURE["blocked"]
ALLOWED = _FIXTURE["allowed"]


def test_fixture_has_cases() -> None:
    # Guard the guard: an empty fixture would make both checks vacuous.
    assert len(BLOCKED) > 30
    assert len(ALLOWED) > 10


@pytest.mark.parametrize("hostname", BLOCKED)
def test_rejects_private_targets(hostname: str) -> None:
    assert is_private_hostname(hostname) is True


@pytest.mark.parametrize("hostname", ALLOWED)
def test_allows_public_targets(hostname: str) -> None:
    assert is_private_hostname(hostname) is False


@pytest.mark.parametrize("hostname", ["127.0.0.1", "localhost", "169.254.169.254", "2130706433", "[::1]"])
def test_normalize_address_domain_refuses_private_targets(testbed, hostname: str) -> None:
    # The guard sits here so that import_address and check_address, which both
    # normalize through it, are covered by one check rather than none.
    with pytest.raises(Exception, match="Invalid parameter: domain"):
        testbed.keymaster.normalize_address_domain(hostname)


@pytest.mark.parametrize("hostname", ["127.0.0.1", "169.254.169.254", "2130706433"])
def test_public_lookups_refuse_private_targets(testbed, hostname: str) -> None:
    run(testbed.keymaster.create_id("Alice"))

    with pytest.raises(Exception, match="Invalid parameter: domain"):
        run(testbed.keymaster.import_address(hostname))

    with pytest.raises(Exception, match="Invalid parameter"):
        run(testbed.keymaster.check_address(f"alice@{hostname}"))


def test_fetch_public_https_refuses_a_private_first_hop() -> None:
    with pytest.raises(ValueError, match="private address"):
        run(fetch_public_https("GET", "https://127.0.0.1/.well-known/names"))


def test_fetch_public_https_refuses_a_non_https_target() -> None:
    with pytest.raises(ValueError, match="non-https"):
        run(fetch_public_https("GET", "http://example.com/.well-known/names"))


@pytest.mark.parametrize("status", [304, 300, 305])
def test_non_redirect_3xx_is_returned_not_treated_as_a_redirect(status: int, monkeypatch) -> None:
    # 304 sits in the 3xx range but is not a redirect and carries no Location.
    # Treating the whole range as redirects turned it into a "redirect with no
    # location" error, where httpx would have returned the response.
    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, method, url, headers=None, json=None, **kwargs):
            return httpx.Response(status, request=httpx.Request(method, url))

    async def resolve(*args):
        return ["8.8.8.8"]

    monkeypatch.setattr(net, "resolve_public_addresses", resolve)
    monkeypatch.setattr(net.httpx, "AsyncClient", lambda **kwargs: FakeClient())

    response = run(fetch_public_https("GET", "https://example.com/.well-known/names"))

    assert response.status_code == status


@pytest.mark.parametrize("address", ["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1", "fc00::1", "::ffff:127.0.0.1"])
def test_dns_answers_reject_private_and_mixed_destinations(address, monkeypatch):
    import asyncio
    import socket

    async def exercise():
        async def lookup(*args, **kwargs):
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443)),
                    (socket.AF_INET6 if ":" in address else socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]
        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
        await net.resolve_public_addresses("names.example", 443, 2)

    with pytest.raises(ValueError, match="private address"):
        run(exercise())


def test_pins_ip_preserves_host_sni_and_rechecks_redirect(monkeypatch):
    import asyncio
    import socket
    observed = []
    resolutions = []
    original_client = httpx.AsyncClient

    def handle(request):
        observed.append(request)
        return httpx.Response(302, headers={"location": "https://rebound.example/secret"})

    def client(**kwargs):
        assert kwargs["trust_env"] is False
        assert kwargs["follow_redirects"] is False
        return original_client(**kwargs, transport=httpx.MockTransport(handle))

    async def exercise():
        async def lookup(host, *args, **kwargs):
            resolutions.append(host)
            ip = "8.8.8.8" if len(resolutions) == 1 else "127.0.0.1"
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]
        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
        await fetch_public_https("GET", "https://names.example:8443/start")

    monkeypatch.setattr(net.httpx, "AsyncClient", client)
    with pytest.raises(ValueError, match="private address"):
        run(exercise())
    assert resolutions == ["names.example", "rebound.example"]
    assert len(observed) == 1
    assert observed[0].url.host == "8.8.8.8"
    assert observed[0].url.port == 8443
    assert observed[0].headers["Host"] == "names.example:8443"
    assert observed[0].extensions["sni_hostname"] == "names.example"


def test_uses_validated_ipv6_and_ipv4_candidates_without_resolving_again(monkeypatch):
    import asyncio
    import socket
    observed = []
    resolutions = []
    original_client = httpx.AsyncClient

    def handle(request):
        observed.append(request)
        if len(observed) == 1:
            raise httpx.ConnectError("IPv6 unreachable")
        return httpx.Response(200, json={"names": {}})

    monkeypatch.setattr(net.httpx, "AsyncClient", lambda **kwargs: original_client(
        **kwargs, transport=httpx.MockTransport(handle)))

    async def exercise():
        async def lookup(host, *args, **kwargs):
            resolutions.append(host)
            return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("2606:4700:4700::1111", 443)),
                    (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8", 443))]
        monkeypatch.setattr(asyncio.get_running_loop(), "getaddrinfo", lookup)
        return await fetch_public_https("GET", "https://names.example/names")

    assert run(exercise()).status_code == 200
    assert resolutions == ["names.example"]
    assert [r.url.host for r in observed] == ["2606:4700:4700::1111", "8.8.8.8"]
    assert all(r.headers["Host"] == "names.example" for r in observed)
    assert all(r.extensions["sni_hostname"] == "names.example" for r in observed)

    assert 0 < observed[1].extensions["timeout"]["connect"] <= observed[0].extensions["timeout"]["connect"] <= 30
