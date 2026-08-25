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

        async def request(self, method, url, headers=None, json=None):
            return httpx.Response(status, request=httpx.Request(method, url))

    monkeypatch.setattr(net.httpx, "AsyncClient", lambda **kwargs: FakeClient())

    response = run(fetch_public_https("GET", "https://example.com/.well-known/names"))

    assert response.status_code == status
