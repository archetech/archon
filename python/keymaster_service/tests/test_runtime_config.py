from __future__ import annotations

from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT.parent / "keymaster" / "src"))

from keymaster_service.config import Settings  # noqa: E402
from keymaster_service.runtime import KeymasterService  # noqa: E402


class FakeGatekeeper:
    url = "http://gatekeeper:4224"


class FakeWalletStore:
    pass


def test_runtime_passes_node_url_override_to_keymaster() -> None:
    settings = Settings(
        passphrase="passphrase",
        node_url="http://drawbridge:4222",
    )

    service = KeymasterService(settings, FakeGatekeeper(), FakeWalletStore())

    assert service.keymaster.node_url == "http://drawbridge:4222"
    assert service.keymaster._didcomm_gateway_base() == "http://drawbridge:4222/didcomm"


def test_runtime_leaves_node_url_unset_by_default() -> None:
    settings = Settings(passphrase="passphrase")

    service = KeymasterService(settings, FakeGatekeeper(), FakeWalletStore())

    assert service.keymaster.node_url is None


def test_service_dependency_tracks_repo_keymaster_version() -> None:
    service_project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    keymaster_project = tomllib.loads((ROOT.parent / "keymaster" / "pyproject.toml").read_text())
    expected = f"archon-keymaster=={keymaster_project['project']['version']}"

    assert expected in service_project["project"]["dependencies"]
