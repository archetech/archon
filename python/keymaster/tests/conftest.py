from __future__ import annotations

import pytest

from .helpers import make_testbed


@pytest.fixture
def testbed(monkeypatch):
    monkeypatch.setenv("PBKDF2_ITERATIONS", "1")
    return make_testbed()