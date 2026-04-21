from __future__ import annotations

import asyncio
import logging
from typing import Any

from keymaster import Keymaster, KeymasterError

from .config import Settings
from .gatekeeper_client import GatekeeperClient
from .wallet_store import JsonWalletStore


LOGGER = logging.getLogger(__name__)

KeymasterServiceError = KeymasterError


class KeymasterService:
    def __init__(self, settings: Settings, gatekeeper: GatekeeperClient, wallet_store: JsonWalletStore):
        self.settings = settings
        self.gatekeeper = gatekeeper
        self.wallet_store = wallet_store
        self.keymaster = Keymaster(
            gatekeeper=gatekeeper,
            wallet_store=wallet_store,
            passphrase=settings.passphrase,
            default_registry=settings.default_registry or "hyperswarm",
        )
        self.server_ready = False

    def __getattr__(self, name: str) -> Any:
        return getattr(self.keymaster, name)

    async def get_data(self, cid: str) -> bytes | None:
        return await self.gatekeeper.get_data(cid)

    async def startup(self) -> None:
        if self.settings.keymaster_db != "json":
            raise KeymasterServiceError(
                f"Unsupported ARCHON_KEYMASTER_DB for Python service: {self.settings.keymaster_db}"
            )

        await self.gatekeeper.connect(wait_until_ready=True, interval_seconds=5)
        await self.keymaster.load_wallet()
        try:
            await self.wait_for_node_id()
            self.server_ready = True
        except Exception:
            LOGGER.exception("Failed to wait for node ID")

    async def shutdown(self) -> None:
        await self.gatekeeper.close()

    async def wait_for_node_id(self) -> None:
        if not self.settings.node_id:
            raise KeymasterServiceError("ARCHON_NODE_ID is not set in the configuration.")

        ids = await self.keymaster.list_ids()
        if self.settings.node_id not in ids:
            await self.keymaster.create_id(self.settings.node_id)
            LOGGER.info("Created node ID '%s'", self.settings.node_id)

        while True:
            try:
                await self.keymaster.resolve_did(self.settings.node_id)
                return
            except Exception:
                await asyncio.sleep(10)
