from __future__ import annotations

from .config import load_settings
from .gatekeeper_client import GatekeeperClient
from .runtime import KeymasterService, KeymasterServiceError
from .wallet_store import JsonWalletStore


settings = load_settings()
service = KeymasterService(
    settings,
    GatekeeperClient(settings.gatekeeper_url),
    JsonWalletStore(data_folder=settings.data_dir),
)


__all__ = ["KeymasterService", "KeymasterServiceError", "service", "settings"]
