from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keymaster_service.metrics import (  # noqa: E402
    http_request_duration_seconds,
    http_requests_total,
    normalize_path,
    service_version_info,
    set_service_version_info,
)


def test_normalize_path_replaces_dynamic_segments() -> None:
    assert normalize_path("/api/v1/did/did:cid:abcdef") == "/api/v1/did/:id"
    assert normalize_path("/api/v1/ids/alice") == "/api/v1/ids/:id"
    assert normalize_path("/api/v1/assets/QmHash?x=1") == "/api/v1/assets/:id"
    assert (
        normalize_path("/api/v1/vaults/v1/items/secret")
        == "/api/v1/vaults/:id/items/:name"
    )
    assert (
        normalize_path("/api/v1/polls/p1/voters/v1")
        == "/api/v1/polls/:poll/voters/:voter"
    )


def test_normalize_path_passthrough_for_static_routes() -> None:
    assert normalize_path("/api/v1/ready") == "/api/v1/ready"
    assert normalize_path("/metrics") == "/metrics"


def test_set_service_version_info_publishes_gauge() -> None:
    set_service_version_info("9.9.9", "deadbee")
    sample = service_version_info.labels(version="9.9.9", commit="deadbee")
    # prometheus_client Gauge exposes _value.get() for the current value
    assert sample._value.get() == 1.0  # type: ignore[attr-defined]


def test_http_metrics_are_registered() -> None:
    http_requests_total.labels(method="GET", route="/test", status="200").inc()
    http_request_duration_seconds.labels(
        method="GET", route="/test", status="200"
    ).observe(0.01)
    # Re-fetching the same labels should return the same child without raising.
    http_requests_total.labels(method="GET", route="/test", status="200").inc()
