"""Guards for fetches to a caller-supplied host.

Remote name lookup takes a domain from the caller and fetches
``https://<domain>/.well-known/names...``, which makes it an SSRF primitive
unless the target is checked: the classic payload is a cloud metadata address
such as ``169.254.169.254``, reachable from inside a container and happy to
hand out credentials (#252).

Mirrors ``packages/common/src/net.ts`` and its Node transport. Both ports served this surface with
no target check at all on the public paths, so they are fixed together.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from typing import Any, Optional

import httpx

MAX_REDIRECTS = 3

# The statuses that are actually redirects. Treating the whole 3xx range as one
# turns a 304 Not Modified -- which carries no Location -- into a "redirect with
# no location" error, where httpx would simply have returned the response.
REDIRECT_STATUSES = frozenset({301, 302, 303, 307, 308})

# Names that resolve inside a host or a private network by convention. This
# cannot catch a public name pointed at a private address -- that is DNS
# rebinding, and it needs resolve-then-pin rather than a string check.
BLOCKED_SUFFIXES = (".localhost", ".local", ".internal", ".home.arpa")


def _parse_ipv4_any(hostname: str) -> Optional[int]:
    """Parse every form ``inet_aton`` accepts, as an integer.

    ``ipaddress`` deliberately rejects these, but the platform resolver does
    not, so ``2130706433``, ``0177.0.0.1``, ``0x7f000001`` and ``127.1`` all
    reach 127.0.0.1 regardless of what ``ipaddress`` thinks of them.
    """
    parts = hostname.split(".")

    if not parts or len(parts) > 4:
        return None

    values: list[int] = []

    for part in parts:
        if not part:
            return None

        try:
            if part.lower().startswith("0x"):
                value = int(part, 16)
            elif part.startswith("0") and len(part) > 1:
                value = int(part, 8)
            else:
                value = int(part, 10)
        except ValueError:
            return None

        if value < 0:
            return None

        values.append(value)

    # With fewer than four parts the last one covers the remaining bytes:
    # 127.1 is 127.0.0.1, and a lone 2130706433 is the whole address.
    last = values.pop()
    remaining = 4 - len(values)

    if last >= 256 ** remaining:
        return None

    if any(value > 255 for value in values):
        return None

    address = last

    for index, value in enumerate(values):
        address += value * (256 ** (3 - index))

    return address if address <= 0xFFFFFFFF else None


# The ranges are written out, and are the ones the TypeScript port lists, so
# that the two agree whatever interpreter runs this. ipaddress's own flags
# (is_private, is_reserved, is_global) are not used: what they cover changes
# between Python releases, and a guard built on them refuses different
# addresses on different versions.
_BLOCKED_IPV4 = tuple(ipaddress.ip_network(network) for network in (
    "0.0.0.0/8",        # "this host"
    "10.0.0.0/8",       # RFC 1918
    "100.64.0.0/10",    # carrier-grade NAT
    "127.0.0.0/8",      # loopback
    "169.254.0.0/16",   # link-local, incl. cloud metadata
    "172.16.0.0/12",    # RFC 1918
    "192.0.0.0/24",     # IETF protocol assignments
    "192.168.0.0/16",   # RFC 1918
    "198.18.0.0/15",    # benchmarking
    "224.0.0.0/4",      # multicast
    "240.0.0.0/4",      # reserved, incl. broadcast
    "192.0.2.0/24",     # TEST-NET-1
    "198.51.100.0/24",  # TEST-NET-2
    "203.0.113.0/24",   # TEST-NET-3
))

# Only 2000::/3 is global unicast. Within it: 2001::/23, IETF protocol
# assignments such as Teredo; 2001:db8::/32 and 3fff::/20, documentation; and
# 2002::/16, 6to4, which carries an IPv4 address this would otherwise not look at.
_GLOBAL_UNICAST_IPV6 = ipaddress.ip_network("2000::/3")
_BLOCKED_IPV6 = tuple(ipaddress.ip_network(network) for network in (
    "2001::/23",
    "2001:db8::/32",
    "2002::/16",
    "3fff::/20",
))


def _is_blocked_address(address: Any) -> bool:
    # An IPv4 address wearing an IPv6 hat is judged on the IPv4 it carries.
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        address = mapped

    if address.version == 4:
        return any(address in network for network in _BLOCKED_IPV4)

    return address not in _GLOBAL_UNICAST_IPV6 or any(address in network for network in _BLOCKED_IPV6)


def is_private_hostname(hostname: str) -> bool:
    if not isinstance(hostname, str):
        return True

    host = hostname.strip().lower().rstrip(".")

    if not host or host == "localhost":
        return True

    # A URL keeps IPv6 literals in brackets; a bare address may arrive without.
    candidate = host[1:-1] if host.startswith("[") and host.endswith("]") else host

    # Zone identifiers (fe80::1%eth0) are not part of the address.
    if "%" in candidate:
        candidate = candidate.split("%", 1)[0]

    if ":" in candidate:
        try:
            return _is_blocked_address(ipaddress.IPv6Address(candidate))
        except ValueError:
            return True  # looks like an IPv6 literal but is not one

    numeric = _parse_ipv4_any(candidate)
    if numeric is not None:
        return _is_blocked_address(ipaddress.IPv4Address(numeric))

    return any(host.endswith(suffix) for suffix in BLOCKED_SUFFIXES)


async def resolve_public_addresses(host: str, port: int, timeout: float) -> list[str]:
    # getaddrinfo follows CNAMEs and returns final IPv4/IPv6 destinations. Reject
    # mixed public/private answers rather than relying on address-selection order.
    answers = await asyncio.wait_for(
        asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM),
        timeout=timeout,
    )
    addresses = list(dict.fromkeys(answer[4][0] for answer in answers))
    if not addresses or any(is_private_hostname(address) for address in addresses):
        raise ValueError(f"refusing DNS resolution to private address for {host}")
    return addresses


async def fetch_public_https(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    json_body: Any | None = None,
    timeout: float = 30.0,
) -> httpx.Response:
    """Validate every hop and connect to a validated IP, retaining Host/TLS identity."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        parsed = httpx.URL(current)
        if parsed.scheme != "https":
            raise ValueError(f"refusing non-https request to {parsed.host}")
        if is_private_hostname(parsed.host):
            raise ValueError(f"refusing request to private address {parsed.host}")

        deadline = asyncio.get_running_loop().time() + timeout
        addresses = await resolve_public_addresses(parsed.host, parsed.port or 443, timeout)
        request_headers = httpx.Headers(headers)
        request_headers["Host"] = httpx.Request(method, parsed).headers["Host"]
        # A fresh client prevents pooling TLS sessions/cookies by the substituted
        # IP across distinct hostnames. Proxies must not re-resolve the hostname.
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, trust_env=False) as client:
            for index, address in enumerate(addresses):
                try:
                    remaining = deadline - asyncio.get_running_loop().time()
                    if remaining <= 0:
                        raise httpx.ConnectTimeout("public HTTPS connection timeout")
                    response = await client.request(
                        method, parsed.copy_with(host=address), headers=request_headers, json=json_body,
                        timeout=remaining,
                        # Public httpcore extension keeps certificate verification
                        # and SNI against the original hostname, not the pinned IP.
                        # https://www.encode.io/httpcore/extensions/#sni_hostname
                        extensions={"sni_hostname": parsed.host},
                    )
                    break
                except (httpx.ConnectError, httpx.ConnectTimeout):
                    if index == len(addresses) - 1:
                        raise
        if response.status_code not in REDIRECT_STATUSES:
            return response
        location = response.headers.get("location")
        if not location:
            raise ValueError(f"redirect with no location from {parsed.host}")
        current = str(parsed.join(location))

    raise ValueError(f"too many redirects ({MAX_REDIRECTS})")
