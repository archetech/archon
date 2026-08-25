"""Target checks for fetches to a caller-supplied host (#252).

Mirrors tests/keymaster/ssrf-guard.test.ts case for case. The two ports served
this surface with different guards -- TypeScript had a prefix regex applied on
one of three paths, Python had nothing at all -- so the cases are kept in step
deliberately: a hostname either port accepts is a hostname the fix has to
account for in both.
"""

from __future__ import annotations

import pytest

import keymaster.core as core
from keymaster.net import fetch_public_https, is_private_hostname

from .helpers import run


# Every one of these walked past the prefix regex the TypeScript port used,
# including 169.254.169.254 -- the cloud metadata address, and the first risk
# the issue named.
BLOCKED = [
    "localhost",
    "localhost.",
    "LOCALHOST",
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "192.0.0.1",
    "198.18.0.1",
    # inet_aton accepts these and the resolver honours them, while Python's
    # ipaddress module rejects all four -- so they have to be parsed by hand
    # or they are simply not seen.
    "2130706433",
    "0177.0.0.1",
    "0x7f000001",
    "127.1",
    "::1",
    "[::1]",
    "::",
    "fc00::1",
    "fe80::1",
    "fe80::1%eth0",
    "[::ffff:127.0.0.1]",
    "::ffff:169.254.169.254",
    "metadata.google.internal",
    "printer.local",
    "api.localhost",
    "",
]

# A guard that also blocks the lookups it exists to permit is not usable. The
# neighbours of the blocked ranges are the easy mistake: 11.x is not 10.x,
# 172.32 is outside the /12, and 169.253 is not link-local.
ALLOWED = [
    "example.com",
    "names.example.org",
    "8.8.8.8",
    "1.1.1.1",
    "2606:2800:220:1:248:1893:25c8:1946",
    "11.0.0.1",
    "9.255.255.255",
    "172.32.0.1",
    "172.15.255.255",
    "169.253.0.1",
    "localhost.example.com",
    "xn--bcher-kva.example",
]


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
