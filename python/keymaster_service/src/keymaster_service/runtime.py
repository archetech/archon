from __future__ import annotations

import asyncio
import logging
from typing import Any

from keymaster import Keymaster, KeymasterError, WalletNotFoundError

from .admin import check_wallet_store
from .config import Settings
from .metrics import wallets_created_total
from keymaster.gatekeeper_client import GatekeeperClient
from keymaster.wallet_store import JsonWalletStore, RedisWalletStore


LOGGER = logging.getLogger(__name__)

KeymasterServiceError = KeymasterError


class KeymasterService:
    def __init__(self, settings: Settings, gatekeeper: GatekeeperClient, wallet_store: JsonWalletStore | RedisWalletStore):
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
        self._node_id_task: asyncio.Task[None] | None = None

    def __getattr__(self, name: str) -> Any:
        return getattr(self.keymaster, name)

    async def get_data(self, cid: str) -> bytes | None:
        return await self.gatekeeper.get_data(cid)

    async def startup(self) -> None:
        if self.settings.keymaster_db not in ("json", "redis"):
            raise KeymasterServiceError(
                f"Unsupported ARCHON_KEYMASTER_DB for Python service: {self.settings.keymaster_db}"
            )

        # Before the blocking gatekeeper connect below: a node told to fail
        # closed on a missing wallet must say so immediately, not wait on an
        # upstream that may never arrive.
        check = check_wallet_store(
            self.wallet_store.load_wallet() is None,
            self.settings.require_wallet,
            self.settings.keymaster_db,
        )
        if check.fatal:
            raise KeymasterServiceError(check.fatal)

        await self.gatekeeper.connect(wait_until_ready=True, interval_seconds=5)

        # The one place this service provisions, so a fresh mnemonic is a
        # startup event with a log line and a counter rather than a side effect
        # of whichever request happened to read the wallet first (#1037). The
        # store is read again rather than trusting the snapshot above: a wallet
        # that arrived during the gatekeeper wait is loaded, not replaced.
        try:
            await self.keymaster.load_wallet()
        except WalletNotFoundError:
            LOGGER.warning(check.warning)
            await self.keymaster.new_wallet()
            wallets_created_total.inc()
        # Resolve the node ID in the background so the ASGI app can start
        # serving /version, /metrics, and /ready immediately. /ready will
        # report ready=False until this task completes.
        self._node_id_task = asyncio.create_task(self._resolve_node_id())

    async def _resolve_node_id(self) -> None:
        try:
            await self.wait_for_node_id()
            self.server_ready = True
        except Exception:
            LOGGER.exception("Failed to wait for node ID")

    async def shutdown(self) -> None:
        if self._node_id_task is not None and not self._node_id_task.done():
            self._node_id_task.cancel()
            try:
                await self._node_id_task
            except (asyncio.CancelledError, Exception):
                pass
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
