from __future__ import annotations

from .config import load_settings
from .gatekeeper_client import GatekeeperClient
from .runtime import KeymasterService, KeymasterServiceError
from .wallet_store import JsonWalletStore, RedisWalletStore


settings = load_settings()


def _build_wallet_store() -> JsonWalletStore | RedisWalletStore:
    if settings.keymaster_db == "redis":
        redis_url = settings.redis_url
        return RedisWalletStore(redis_url=redis_url)
    return JsonWalletStore(data_folder=settings.data_dir)


service = KeymasterService(
    settings,
    GatekeeperClient(settings.gatekeeper_url),
    _build_wallet_store(),
)


__all__ = ["KeymasterService", "KeymasterServiceError", "service", "settings"]
