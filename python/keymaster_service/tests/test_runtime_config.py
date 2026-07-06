from __future__ import annotations

from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "keymaster" / "src"))

from keymaster_service.config import Settings  # noqa: E402
from keymaster_service.runtime import KeymasterService  # noqa: E402


class FakeGatekeeper:
    url = "http://gatekeeper:4224"


class FakeWalletStore:
    pass


def test_runtime_passes_didcomm_gateway_override_to_keymaster() -> None:
    settings = Settings(
        passphrase="passphrase",
        didcomm_gateway_url="http://drawbridge:4222/didcomm",
    )

    service = KeymasterService(settings, FakeGatekeeper(), FakeWalletStore())

    assert service.keymaster.didcomm_service_url == "http://drawbridge:4222/didcomm"


def test_runtime_leaves_didcomm_gateway_unset_by_default() -> None:
    settings = Settings(passphrase="passphrase")

    service = KeymasterService(settings, FakeGatekeeper(), FakeWalletStore())

    assert service.keymaster.didcomm_service_url is None
