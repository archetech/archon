from __future__ import annotations

from pathlib import Path
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def test_service_dependency_tracks_repo_keymaster_version() -> None:
    service_project = tomllib.loads((ROOT / "pyproject.toml").read_text())
    keymaster_project = tomllib.loads((ROOT.parent / "keymaster" / "pyproject.toml").read_text())
    expected = f"archon-keymaster=={keymaster_project['project']['version']}"

    assert expected in service_project["project"]["dependencies"]
