"""Prometheus metrics for the Python keymaster service.

Mirrors the metrics contract exposed by the TypeScript keymaster
(``services/keymaster/server/src/keymaster-api.ts``) so dashboards and
alerts work transparently when switching the ``ARCHON_KEYMASTER_FLAVOR``.

Exposed series:
- ``service_version_info{version,commit}`` — gauge, set to 1 at startup.
- ``http_requests_total{method,route,status}`` — counter.
- ``http_request_duration_seconds{method,route,status}`` — histogram with
  the same buckets as the TypeScript service.
- ``wallet_operations_total{operation,status}`` — counter (reserved for
  parity; not yet incremented anywhere in the Python service).
"""

from __future__ import annotations

import re

from prometheus_client import Counter, Gauge, Histogram

HTTP_DURATION_BUCKETS = (0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5)

service_version_info = Gauge(
    "service_version_info",
    "Service version information",
    ["version", "commit"],
)

http_requests_total = Counter(
    "http_requests_total",
    "Total number of HTTP requests",
    ["method", "route", "status"],
)

http_request_duration_seconds = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "route", "status"],
    buckets=HTTP_DURATION_BUCKETS,
)

wallet_operations_total = Counter(
    "wallet_operations_total",
    "Total number of wallet operations",
    ["operation", "status"],
)


# Path normalization mirrors keymaster-api.ts `normalizePath` so that
# Prometheus label cardinality stays bounded across DIDs, hashes, CIDs,
# and other dynamic identifiers.
_PATH_NORMALIZERS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"/did/[^/]+"), "/did/:id"),
    (re.compile(r"/ids/[^/]+"), "/ids/:id"),
    (re.compile(r"/aliases/[^/]+"), "/aliases/:alias"),
    (re.compile(r"/addresses/check/[^/]+"), "/addresses/check/:address"),
    (re.compile(r"/addresses/import"), "/addresses/import"),
    (re.compile(r"/addresses/[^/]+"), "/addresses/:address"),
    (re.compile(r"/groups/[^/]+"), "/groups/:name"),
    (re.compile(r"/schemas/[^/]+"), "/schemas/:id"),
    (re.compile(r"/agents/[^/]+"), "/agents/:id"),
    (re.compile(r"/credentials/held/[^/]+"), "/credentials/held/:did"),
    (re.compile(r"/credentials/issued/[^/]+"), "/credentials/issued/:did"),
    (re.compile(r"/assets/[^/]+"), "/assets/:id"),
    (re.compile(r"/polls/[^/]+/voters/[^/]+"), "/polls/:poll/voters/:voter"),
    (re.compile(r"/polls/ballot/[^/]+"), "/polls/ballot/:did"),
    (re.compile(r"/polls/[^/]+"), "/polls/:poll"),
    (re.compile(r"/images/[^/]+"), "/images/:id"),
    (re.compile(r"/files/[^/]+"), "/files/:id"),
    (re.compile(r"/ipfs/data/[^/]+"), "/ipfs/data/:cid"),
    (re.compile(r"/vaults/[^/]+/members/[^/]+"), "/vaults/:id/members/:member"),
    (re.compile(r"/vaults/[^/]+/items/[^/]+"), "/vaults/:id/items/:name"),
    (re.compile(r"/vaults/[^/]+"), "/vaults/:id"),
    (re.compile(r"/dmail/[^/]+/attachments/[^/]+"), "/dmail/:id/attachments/:name"),
    (re.compile(r"/dmail/[^/]+"), "/dmail/:id"),
    (re.compile(r"/notices/[^/]+"), "/notices/:id"),
)


def normalize_path(path: str) -> str:
    """Replace dynamic path segments with parameter placeholders."""
    base_path = path.split("?", 1)[0]
    for pattern, replacement in _PATH_NORMALIZERS:
        base_path = pattern.sub(replacement, base_path)
    return base_path


def set_service_version_info(version: str, commit: str) -> None:
    """Publish the running service version as a gauge sample."""
    service_version_info.labels(version=version, commit=commit).set(1)
