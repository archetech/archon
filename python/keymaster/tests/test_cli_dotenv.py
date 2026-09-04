from __future__ import annotations

import os
from pathlib import Path

from keymaster.cli import _load_dotenv

# The JS CLI reads a .env from the working directory, and the Python one did
# not, while both are installed as `keymaster` and are parity-tested on their
# command surface. Anything documenting .env as the way to supply a passphrase
# was therefore false for Python users, invisibly (#1016).


def _run_in(tmp_path: Path, monkeypatch, contents: str | None = None) -> str | None:
    if contents is not None:
        (tmp_path / ".env").write_text(contents)

    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("ARCHON_PASSPHRASE", raising=False)
    _load_dotenv()

    return os.environ.get("ARCHON_PASSPHRASE")


def test_reads_dotenv_from_the_working_directory(tmp_path, monkeypatch):
    assert _run_in(tmp_path, monkeypatch, "ARCHON_PASSPHRASE=from-dotenv\n") == "from-dotenv"


def test_ignores_a_dotenv_in_a_parent_directory(tmp_path, monkeypatch):
    # load_dotenv() with no argument would walk up and find this one; the JS
    # CLI reads only the working directory, so this one must not.
    (tmp_path / ".env").write_text("ARCHON_PASSPHRASE=from-parent\n")
    nested = tmp_path / "nested"
    nested.mkdir()

    assert _run_in(nested, monkeypatch) is None


def test_leaves_a_variable_already_in_the_environment_alone(tmp_path, monkeypatch):
    (tmp_path / ".env").write_text("ARCHON_PASSPHRASE=from-dotenv\n")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("ARCHON_PASSPHRASE", "from-environment")

    _load_dotenv()

    assert os.environ["ARCHON_PASSPHRASE"] == "from-environment"


def test_is_quiet_when_there_is_no_dotenv(tmp_path, monkeypatch):
    assert _run_in(tmp_path, monkeypatch) is None
