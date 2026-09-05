"""Startup ordering for ARCHON_KEYMASTER_REQUIRE_WALLET.

The refusal has to land before the blocking gatekeeper connect. A node told to
fail closed on a missing wallet must say so immediately rather than sit waiting
on an upstream that may never arrive.
"""

from __future__ import annotations

import asyncio

import pytest

from keymaster_service.config import Settings
from keymaster_service.runtime import KeymasterService, KeymasterServiceError


class NeverConnects:
    """Stands in for a gatekeeper that is not there yet."""

    def __init__(self) -> None:
        self.connect_attempted = False

    async def connect(self, **_kwargs) -> None:
        self.connect_attempted = True
        await asyncio.sleep(3600)


class EmptyStore:
    def load_wallet(self):
        return None

    def save_wallet(self, *_args, **_kwargs):
        return True


def test_require_wallet_refuses_before_waiting_for_gatekeeper():
    gatekeeper = NeverConnects()
    settings = Settings(keymaster_db="json", passphrase="passphrase", require_wallet=True)
    service = KeymasterService(settings, gatekeeper, EmptyStore())

    with pytest.raises(KeymasterServiceError, match="ARCHON_KEYMASTER_REQUIRE_WALLET"):
        asyncio.run(asyncio.wait_for(service.startup(), timeout=5))

    assert gatekeeper.connect_attempted is False
